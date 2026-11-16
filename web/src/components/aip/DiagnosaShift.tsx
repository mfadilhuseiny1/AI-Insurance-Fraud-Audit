"use client";

// ML Studio · "Diagnosis distribution shift" (reviewer note, 2026-11-13: before changing the algorithm, look at the data generating
// process: feature distributions, median, variance, and whether fraud vs non-fraud patterns hold across generators).
// Data: testing/diagnosa_shift.py -> shift_diagnosis.json (ML v5 frozen; generator 3 = the two seeds already scored once).

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { GRID, SERIES } from "./viz";

type R = { med: number | null; q25: number | null; q75: number | null; sd: number | null; na: number };
type G = "g1" | "g2" | "g3";
type Fam = { n: number; porsi: number; recall: number };
export type ShiftDx = {
  dibuat: string; ambang: number; catatan: string[];
  profil: Record<G, { label: string; klaim: number; fraud: number; prevalensi: number; pertama_normal: number; pertama_fraud: number; skema: number }>;
  pandangan_model: Record<G, { recall: number; fpr: number; presisi_prev2: number; auroc: number; auprc: number; fpr_pertama: number; fpr_lama: number;
    skor_normal: R; skor_fraud: R; hist_normal: number[]; hist_fraud: number[] }>;
  domain: { pasangan: string; kelas: string; auc: number; top: { fitur: string; porsi: number }[] }[];
  pola: { korelasi_spearman_auroc: Record<string, number>; informatif_di_g1_dan_g2: number; di_g3: Record<string, number>; porsi_gain_ml_v5: Record<string, number>;
    sinyal_baru_g3: number; contoh_hilang: string[] };
  fitur: { fitur: string; porsi_gain: number; arah: string; per_gen: Record<G, { normal: R; fraud: R; auroc: number }>;
    shift_normal: { ks_g3_vs_g12: number; ks_g1_vs_g2: number }; shift_fraud: { ks_g3_vs_g12: number; ks_g1_vs_g2: number } }[];
  famili: Record<G, Record<string, Fam>>;
  dekomposisi: Record<string, number>;
};

const GS: [G, string, string][] = [["g1", "Generator 1", SERIES[0]], ["g2", "Generator 2", SERIES[3]], ["g3", "Generator 3", SERIES[2]]];
const FAM_NAMA: Record<string, string> = { koding: "Koding & klinis", tagihan: "Tagihan", episode: "Episode", identitas: "Identitas", jaringan: "Jaringan" };
const ARAH: Record<string, [string, string]> = { tetap: ["tetap di G3", "#7ee2c0"], melemah: ["melemah di G3", "#f0c661"], hilang: ["hilang di G3", "#f0c661"],
  terbalik: ["terbalik di G3", "#ec835a"] };
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
function Legenda() {
  return <div className="flex flex-wrap gap-3">{GS.map(([g, nm, w]) => <span key={g} className="flex items-center gap-1.5 text-[10.5px] text-[#abb3bf]">
    <span className="h-2 w-2 rounded-full" style={{ background: w }} />{nm}</span>)}</div>;
}

function Vonis({ ikon, judul, angka, sub, warna }: { ikon: IconName; judul: string; angka: ReactNode; sub: string; warna: string }) {
  return (
    <div className={`${box} flex flex-col gap-1.5 p-4`}>
      <div className="flex items-center gap-2"><span style={{ color: warna }}><Icon name={ikon} className="h-4 w-4" /></span>
        <p className="text-[12px] font-semibold text-white">{judul}</p></div>
      <div className="text-[19px] font-semibold tabular-nums text-white">{angka}</div>
      <p className="text-[11px] leading-snug text-[#abb3bf]">{sub}</p>
    </div>
  );
}

/** Fraud-score histogram of one generator (20 bins on 0-1), frozen threshold dashed. */
function Histo({ h, w, ambang, nm, med, fprNormal, recall }: { h: number[]; w: string; ambang: number; nm: string; med: number | null; fprNormal: number; recall: number }) {
  const W = 260, H = 80, bw = W / h.length, mx = Math.max(...h, 0.001);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between"><p className="text-[12px] font-semibold text-white">{nm}</p>
        <p className="text-[10.5px] tabular-nums text-[#abb3bf]">median fraud {med === null ? "—" : id(med, 2)}</p></div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label={`Sebaran skor klaim fraud ${nm}`}>
        <line x1={0} x2={W} y1={H} y2={H} stroke={GRID} />
        {h.map((v, i) => {
          const bh = (v / mx) * (H - 4);
          return <rect key={i} x={i * bw + 1} y={H - bh} width={bw - 2} height={Math.max(bh, 0)} rx={2} fill={w} opacity={(i + 0.5) / h.length > ambang ? 1 : 0.45}>
            <title>{`skor ${id(i / h.length, 2)}–${id((i + 1) / h.length, 2)}: ${pct(v)} klaim fraud`}</title></rect>;
        })}
        <line x1={ambang * W} x2={ambang * W} y1={0} y2={H} stroke="#c5cbd3" strokeDasharray="3 3" />
        <text x={ambang * W + 3} y={7} fontSize={6.5} fill="#c5cbd3">ambang</text>
        <text x={0} y={H + 10} fontSize={6.5} fill="#8f99a8">skor 0</text><text x={W} y={H + 10} fontSize={6.5} fill="#8f99a8" textAnchor="end">1</text>
      </svg>
      <div className="flex flex-wrap gap-1.5"><Chip warna="#c5cbd3">{pct(1 - recall, 0)} fraud lolos (di bawah ambang)</Chip><Chip warna="#c5cbd3" garis>normal di atas ambang {pct(fprNormal, 2)}</Chip></div>
    </div>
  );
}

function DotRow({ label, sub, vals, max = 1, fmt, tag }: { label: string; sub?: string; vals: [string, number, string][]; max?: number; fmt: (v: number) => string; tag?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,180px)_1fr] items-center gap-3">
      <div className="min-w-0"><p className="truncate text-[11.5px] text-[#d3d8de]" title={label}>{label}</p>
        {(sub || tag) && <div className="flex flex-wrap items-center gap-1 text-[10px] text-[#8f99a8]">{sub}{tag}</div>}</div>
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: GRID }} />
        {vals.map(([k, v, w]) => <span key={k} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#1c2127]"
          style={{ left: `${Math.max(0, Math.min(100, (v / max) * 100))}%`, background: w }} title={`${k}: ${fmt(v)}`} />)}
      </div>
    </div>
  );
}

export function DiagnosaShift({ d }: { d: ShiftDx }) {
  const pm = d.pandangan_model, dk = d.dekomposisi, pola = d.pola;
  const gain = pola.porsi_gain_ml_v5;
  const fitur = d.fitur.filter((f) => f.arah !== "tidak informatif di latih").slice(0, 9);
  const domRow = (p: string, k: string) => d.domain.find((x) => x.pasangan === p && x.kelas === k)?.auc ?? NaN;
  const fam = Object.keys(FAM_NAMA);
  const mixG3 = dk.recall_g3_dengan_campuran_g2, recG3 = dk.recall_g3;
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: `${SERIES[2]}33` }}><Icon name="search" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Diagnosis distribution shift · {d.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Kenapa recall dan precision turun di generator 3?</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip warna="#c5cbd3">masukan reviewer: cek data dulu, algoritma belakangan</Chip>
            <Chip warna="#c5cbd3">ML v5 beku · tanpa melatih model baru</Chip>
            <Chip warna="#c5cbd3" garis>G3 = seed yang sudah dinilai (ml5 + ml6)</Chip>
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Vonis ikon="check" warna="#7ee2c0" judul="Klaim normal: shift kecil" angka={<span>{GS.map(([g], i) => <span key={g}>{i > 0 && <span className="text-[#5f6b7a]"> · </span>}{pct(pm[g].fpr, 1)}</span>)}</span>}
          sub="FPR di ambang beku (G1 · G2 · G3). Normal G3 tidak lebih sulit dari G2; median skor normal ≈ 0 di ketiganya." />
        <Vonis ikon="alert" warna="#f0c661" judul="Klaim fraud: shift besar" angka={<span>{GS.map(([g], i) => <span key={g}>{i > 0 && <span className="text-[#5f6b7a]"> → </span>}{id(pm[g].skor_fraud.med ?? 0, 2)}</span>)}</span>}
          sub="Median skor klaim fraud. Fraud G3 terlihat jauh lebih mirip klaim normal: ini sumber turunnya recall." />
        <Vonis ikon="refresh" warna="#7ee2c0" judul="Pola tidak terbalik" angka={<span>{pola.di_g3.terbalik} <span className="text-[13px] font-normal text-[#abb3bf]">dari {pola.informatif_di_g1_dan_g2} sinyal</span></span>}
          sub={`Arah fraud vs normal konsisten (korelasi G2–G3 ${id(pola.korelasi_spearman_auroc.g2_g3, 2)}). Tapi ${pola.di_g3.hilang} sinyal hilang, memegang ${pct(gain.hilang, 0)} keputusan model.`} />
        <Vonis ikon="split" warna="#7ee2c0" judul="Campuran skema bukan penyebab" angka={<span>{pct(mixG3, 1)} <span className="text-[13px] font-normal text-[#abb3bf]">vs {pct(recG3, 1)}</span></span>}
          sub="Recall G3 bila campuran famili skemanya disamakan dengan G2, vs recall sebenarnya. Hampir sama: turunnya terjadi di dalam tiap famili." />
      </div>

      <section className={`${box} space-y-3 p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-white">Sebaran skor ML v5 untuk klaim fraud</h3>
          <p className="text-[10.5px] text-[#8f99a8]">batang pudar = di bawah ambang (lolos) · arahkan kursor ke batang</p>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {GS.map(([g, nm, w]) => <Histo key={g} h={pm[g].hist_fraud} w={w} ambang={d.ambang} nm={nm} med={pm[g].skor_fraud.med} fprNormal={pm[g].fpr} recall={pm[g].recall} />)}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={`${box} space-y-3 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-semibold text-white">Recall per famili skema</h3><Legenda /></div>
          {fam.map((f) => (
            <DotRow key={f} label={FAM_NAMA[f]} sub={`porsi G3 ${pct(d.famili.g3[f]?.porsi, 0)}`}
              vals={GS.filter(([g]) => d.famili[g][f]).map(([g, nm, w]) => [nm, d.famili[g][f].recall, w])} fmt={(v) => pct(v, 0)} />
          ))}
          <div className="flex justify-between pl-[192px] text-[9.5px] text-[#8f99a8]"><span>0%</span><span>50%</span><span>100%</span></div>
          <p className="text-[11px] text-[#abb3bf]">Famili sama, cara pelaksanaannya beda: G3 punya {d.profil.g3.skema} skema dengan nama dan mekanik sendiri (mis. jaringan = dokter di tiga RS, rujukan semu, bukan cincin RS).</p>
        </section>
        <section className={`${box} space-y-3 p-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-semibold text-white">Kekuatan sinyal fitur utama (|AUROC − 0,5| × 2)</h3><Legenda /></div>
          {fitur.map((f) => {
            const [t, w] = ARAH[f.arah] ?? [f.arah, "#8f99a8"];
            return <DotRow key={f.fitur} label={f.fitur.replace(/^v4: |^klaim: /, "").replace(/_/g, " ")}
              tag={<><span>{pct(f.porsi_gain, 1)} gain</span><Chip warna={w} garis={f.arah !== "tetap"}>{t}</Chip></>}
              vals={GS.map(([g, nm, c]) => [nm, Math.abs(f.per_gen[g].auroc - 0.5) * 2, c])} max={0.7} fmt={(v) => id(v, 2)} />;
          })}
          <div className="flex justify-between pl-[192px] text-[9.5px] text-[#8f99a8]"><span>0 = acak</span><span>0,7</span></div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <section className={`${box} space-y-3 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Ke mana keputusan model bersandar (porsi gain ML v5)</h3>
          <div className="flex h-7 w-full overflow-hidden rounded-md">
            {([["tetap", "#199e70"], ["melemah", "#c98500"], ["hilang", "#ec835a"], ["terbalik", "#d03b3b"], ["lain", "#3a434e"]] as const).filter(([k]) => gain[k] > 0).map(([k, w]) => (
              <div key={k} className="flex items-center justify-center border-r-2 border-[#1c2127] text-[10px] font-semibold text-white last:border-r-0" style={{ width: `${gain[k] * 100}%`, background: w }}
                title={`${k}: ${pct(gain[k])}`}>{gain[k] > 0.06 ? pct(gain[k], 0) : ""}</div>))}
          </div>
          <div className="flex flex-wrap gap-3 text-[10.5px] text-[#abb3bf]">
            {([["tetap", "sinyal tetap di G3", "#199e70"], ["melemah", "melemah", "#c98500"], ["hilang", "hilang di G3", "#ec835a"], ["lain", "fitur lain (lemah sendiri-sendiri)", "#3a434e"]] as const).map(([k, nm, w]) => (
              <span key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: w }} />{nm} {pct(gain[k], 0)}</span>))}
          </div>
          <div className="rounded-md border border-dashed border-[#ec835a66] p-3">
            <p className="text-[11.5px] font-semibold text-white">Sidik jari generator 1 &amp; 2 (sinyal yang hilang di G3)</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">{pola.contoh_hilang.map((f) => <Chip key={f} warna="#ec835a">{f.replace(/^v4: |^klaim: /, "").replace(/_/g, " ")}</Chip>)}</div>
            <p className="mt-1.5 text-[11px] leading-snug text-[#abb3bf]">Di G1 dan G2, fraud ditanam pada peserta yang jauh dari domisili dan dengan jeda kunjungan tak wajar. Di G3 fraud dilakukan peserta lokal dengan jadwal biasa, jadi sinyal ini kosong. Skor rule juga: median fraud G1 tinggi, di G2 dan G3 nol.</p>
          </div>
        </section>
        <section className={`${box} space-y-3 p-4`}>
          <h3 className="text-[13px] font-semibold text-white">Seberapa beda generator satu sama lain (domain classifier)</h3>
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2 text-[11px]">
            <span className="text-[10px] text-[#8f99a8]">pasangan</span><span className="w-24 text-[10px] text-[#8f99a8]">klaim normal</span><span className="w-24 text-[10px] text-[#8f99a8]">klaim fraud</span>
            {([["g1_g2", "G1 ↔ G2"], ["g1_g3", "G1 ↔ G3"], ["g2_g3", "G2 ↔ G3"], ["g12_g3", "G1+G2 ↔ G3"]] as const).map(([p, nm]) => (
              <div key={p} className="contents">
                <span className="text-[#d3d8de]">{nm}</span>
                {(["normal", "fraud"] as const).map((k) => { const v = domRow(p, k); return (
                  <div key={k} className="flex w-24 items-center gap-1.5" title={`AUC ${id(v, 3)}`}>
                    <div className="relative h-2 flex-1 rounded-full" style={{ background: GRID }}><div className="absolute inset-y-0 left-0 rounded-full bg-[#8f99a8]" style={{ width: `${Math.max(0, (v - 0.5) * 2) * 100}%` }} /></div>
                    <span className="w-8 text-right tabular-nums text-[#d3d8de]">{id(v, 2)}</span></div>); })}
              </div>))}
          </div>
          <p className="text-[11px] leading-snug text-[#abb3bf]">0,5 = tak bisa dibedakan, 1 = beda total. Generator memang sangat beda satu sama lain (G1 ↔ G2 pun {id(domRow("g1_g2", "normal"), 2)}), tapi model tetap bekerja di G1 dan G2 karena dilatih dengan keduanya. Menggabung G1+G2 sudah membuat normal G3 kurang asing ({id(domRow("g12_g3", "normal"), 2)}).</p>
        </section>
      </div>

      <section className={`${box} space-y-3 p-4`}>
        <h3 className="text-[13px] font-semibold text-white">Langkah berikutnya (urutan reviewer)</h3>
        <div className="grid gap-3 md:grid-cols-3">
          {([["sliders", "1 · Data generating process", "Hapus sidik jari di G1/G2: sebagian fraud oleh peserta lokal, jadwal wajar, skor rule rendah; tingkat kehalusan bervariasi per skema."],
            ["layers", "2 · Validasi lintas generator", "Leave-one-generator-out (latih G1 → uji G2, latih G2 → uji G1). Pilih model dari generator terburuknya, bukan rata-rata."],
            ["filter", "3 · Domain generalization / DRO", "Redam fitur yang tidak stabil antar generator, group DRO per generator × famili, augmentasi \"fraud halus\" (ubah satu kolom saja)."]] as const).map(([ik, j, s]) => (
            <div key={j} className="rounded-md border border-white/[.08] bg-[#151a1f] p-3">
              <div className="flex items-center gap-2"><Icon name={ik} className="h-4 w-4 text-[#7ee2c0]" /><p className="text-[12px] font-semibold text-white">{j}</p></div>
              <p className="mt-1 text-[11px] leading-snug text-[#abb3bf]">{s}</p>
            </div>))}
        </div>
        <div className="flex items-start gap-2 rounded-md border border-dashed border-white/15 p-3 text-[11px] leading-snug text-[#abb3bf]">
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-[#c5cbd3]" />
          <span>{d.catatan[1]}</span>
        </div>
      </section>
    </div>
  );
}
