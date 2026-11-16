"use client";

// ML Studio · Sistem ML terbaru (the user, 2026-11-12: "update ML Studio to our latest ML System used + its metric chart and
// graph, precision@k", then "complete information", the precision-by-fraud-rate chart with the overfitting check, and
// "visually understandable, not just paragraph and table"): the fraud system the /testing bench runs, read from
// /api/ml-sistem (testing/laporan_ml.py: aggregate numbers, no claim rows). Every chart has a table view.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AXIS, ChartCard, GRID, SERIES, SURFACE, Tooltip, useTip } from "./viz";
import { AlurV3Detail, type NodeV3, type RuteV2, type SkewV3 } from "./AlurV3Detail";
import { GeneratorDua, type G2 } from "./GeneratorDua";
import { PerbaikanV3, type P3 } from "./PerbaikanV3";
import { PerbaikanV4, type V4 } from "./PerbaikanV4";
import { ArsitekturTerbaru, type AG } from "./ArsitekturTerbaru";
import { SistemV5 } from "./SistemV5";
import { BenchmarkMlV5, RingkasanV5, type MLV5 } from "./BenchmarkMlV5";
import { ArsitekturV5Visual } from "./ArsitekturV5Visual";
import { BenchmarkMlV6 } from "./BenchmarkMlV6";
import { DiagnosaShift } from "./DiagnosaShift";
import { BenchmarkMlV7 } from "./BenchmarkMlV7";

type Titik = { nama: string; gaya: string; tpr: number; fpr: number; ditandai: number; tp: number; fp: number; precision: number[] };
type PK = { k: number[]; precision: number[]; recall: number[]; tp: number[] };
type Doc = {
  dibuat: string; dilatih: string;
  sistem: { nama: string; keputusan: string; ambang_peluang: number; ambang_alert: number; komponen: { kunci: string; nama: string; detail: string }[];
    data_latih: { klaim: number; fraud: number; plant_bersih: number; aliran_simulator: number; fraud_aliran: number; normal_salinan: number;
      holdout_plant_bersih: number; holdout_normal_salinan: number } };
  metrik: { auprc: number; auroc: number; auprc_model1: number; auprc_model2: number; brier: number; precision: number; recall: number; fpr_normal: number;
    f1: number; basis: number; recall_plant_bersih: number | null; fpr_normal_salinan: number | null };
  cm: { tp: number; fp: number; fn: number; tn: number };
  pr: { gabungan: [number, number][]; model1: [number, number][]; model2: [number, number][]; basis: number };
  presisi_k: Record<"gabungan" | "model1" | "model2", PK>; presisi_k_tabel: Record<"gabungan" | "model1" | "model2", PK>;
  distribusi: { batas: number[]; normal: number[]; fraud: number[] };
  skema: { skema: string; label: string; modus: { kode: string; nama: string }[]; n_oof: number; recall_oof: number; n_bersih: number | null; recall_bersih: number | null }[];
  varian: { kunci: string; oof_auprc: number; oof_ditandai_precision: number; oof_ditandai_recall: number; oof_fpr_normal: number; holdout_bersih_recall: number | null;
    holdout_normal_bersih_fpr: number | null; holdout_plant_simulator_recall: number | null }[];
  fitur_model1: { fitur: string; gain_pct: number }[]; fitur_model2: { fitur: string; gain_pct: number }[];
  prevalensi: { tingkat: number[]; aliran: number; anggaran_k: number; titik: Record<"keputusan" | "anggaran", { label: string; metode: Titik[] }> };
  overfit: { train_vs_oof: { model: string; train: number; oof: number }[]; per_blok: { blok: number; klaim: number; fraud: number; auprc: number | null; precision: number; recall: number }[] };
  catatan: string[];
  uji_100k?: Uji;
  arsitektur_v2?: V2;
  arsitektur_v3?: V3;
  generator2?: G2;
  perbaikan_v3?: P3;
  v4_final?: V4;
  arsitektur_graf?: AG;
};
type Ringkas = { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; fpr: number; auprc?: number; auroc?: number };
type Uji = {
  dibuat: string; chunk: number; klaim: number; fraud: number; normal: number; sumber: string; sekarang: Ringkas; lama: Ringkas; rule: Ringkas;
  presisi_k: Record<"sekarang" | "lama", { k: number[]; precision: number[]; recall: number[] }>;
  prevalensi: { tingkat: number[]; aliran: number; anggaran_k: number; keputusan: Record<"sekarang" | "lama" | "rule", number[]>; anggaran: Record<"sekarang" | "lama" | "rule", number[]> };
  distribusi: { batas: number[]; normal: number[]; fraud: number[] };
  skema: { skema: string; label: string; modus: { kode: string; nama: string }[]; n: number; recall: number; recall_lama: number; recall_rule: number }[];
  temuan?: { ikon: string; judul: string; isi: string; nada: "baik" | "buruk" | "netral" }[];
  cek_luar_latih?: { lulus: boolean; latih: { klaim: number; peserta: number }; catatan: string } & Record<"fraud" | "normal" | "semua", Cek>;
};
type Cek = { klaim: number; peserta_di_latih: number; asal_di_latih: number; isi_sama_dengan_latih: number; asal_di_luar_sep_nov: number; peserta_di_uji_a?: number };

/** The test claims against the training data: every count must be zero. */
function CekLuar({ c }: { c: NonNullable<Uji["cek_luar_latih"]> }) {
  const baris: [keyof Cek, string][] = [["peserta_di_latih", "peserta yang juga ada di data latih"], ["asal_di_latih", "klaim asal yang dipakai data latih"],
    ["isi_sama_dengan_latih", "klaim sama persis dengan data latih"], ["asal_di_luar_sep_nov", "klaim asal di luar Sep–Nov 2024"],
    ...(c.semua.peserta_di_uji_a !== undefined ? [["peserta_di_uji_a", "peserta yang juga ada di uji A"] as [keyof Cek, string]] : [])];
  return (
    <div className={`${box} p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: c.lulus ? "rgba(25,158,112,.2)" : "rgba(229,72,77,.2)", color: c.lulus ? "#7ee2c0" : "#ff8e93" }}>
          <Icon name={c.lulus ? "lock" : "alert"} className="h-4 w-4" /></span>
        <p className="text-[13px] font-semibold text-white">{c.lulus ? "Benar-benar di luar data latih" : "Ada tumpang tindih dengan data latih"}</p>
        <span className="text-[11px] text-[#8f99a8]">dicek terhadap {id(c.latih.klaim)} klaim latih · {id(c.latih.peserta)} peserta</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {(["fraud", "normal"] as const).map((g) => (
          <div key={g} className="rounded-md border border-white/[.07] p-3">
            <p className="mb-2 text-[11.5px] text-[#abb3bf]"><b className="text-white">{id(c[g].klaim)}</b> klaim {g === "fraud" ? "fraud" : "normal (lolos)"}</p>
            <div className="space-y-1.5">{baris.map(([k, l]) => {
              const n = c[g][k] ?? 0;
              return (
                <div key={k} className="flex items-center gap-2 text-[11.5px]">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full" style={{ background: n ? "#e5484d" : "#199e70" }}><Icon name={n ? "x" : "check"} className="h-3 w-3 text-white" /></span>
                  <b className="w-12 tabular-nums text-white">{id(n)}</b><span className="text-[#c5cbd3]">{l}</span>
                </div>
              );
            })}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] text-[#8f99a8]">{c.catatan}</p>
    </div>
  );
}

const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const n3 = (v?: number | null) => (v === undefined || v === null ? "—" : id(v, 3));
const MODEL: Record<string, { nama: string; warna: string }> = {
  gabungan: { nama: "Model 1 + 2 (gabungan)", warna: SERIES[0] }, model1: { nama: "Model 1 · graph + tetangga", warna: SERIES[1] },
  model2: { nama: "Model 2 · jaringan RS", warna: SERIES[2] },
};
const WARNA_METODE = (m: Titik) => m.gaya === "utama" ? SERIES[0] : m.gaya === "lama" ? SERIES[3] : m.gaya === "garis" ? "#8f99a8" : /Model 1/.test(m.nama) ? SERIES[1] : SERIES[2];
const VARIAN: Record<string, string> = { model_tanpa_aug: "Sistem lama · latih simulator saja", model_tanpa_plant_sim: "Plant bersih, tanpa plant simulator", model: "Sistem sekarang · semua data" };
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";

// ------------------------------------------------------------------------------------------------ a line chart (numeric x)

type Seri = { nama: string; warna: string; titik: [number, number][]; putus?: boolean; tebal?: boolean; dot?: [number, number][] };

/** The chart's own width in pixels, so its text keeps its size on a wide screen instead of growing with the view box. */
function useLebar(ref: React.RefObject<HTMLDivElement | null>, awal = 680) {
  const [w, setW] = useState(awal);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => { const x = Math.round(es[0].contentRect.width); if (x > 0) setW(Math.max(320, x)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Garis({ seri, xLog = false, x0, x1, xTicks, xFmt, yFmt = (v) => pct(v, 0), penanda = [], h = 250, xLabel, garisY }: {
  seri: Seri[]; xLog?: boolean; x0: number; x1: number; xTicks: number[]; xFmt: (v: number) => string; yFmt?: (v: number) => string;
  penanda?: { x: number; label: string }[]; h?: number; xLabel: string; garisY?: { y: number; label: string } }) {
  const { box: ref, tip, at, clear } = useTip();
  const [hx, setHx] = useState<number | null>(null);
  const W = useLebar(ref), L = 40, R = 16, T = 14, B = 38;
  const fx = (v: number) => (xLog ? Math.log10(v) : v);
  const px = (v: number) => L + ((fx(v) - fx(x0)) / (fx(x1) - fx(x0))) * (W - L - R);
  const py = (v: number) => T + (h - T - B) * (1 - Math.max(0, Math.min(1, v)));
  const nilaiDi = (s: Seri, x: number) => {
    const p = s.titik;
    if (!p.length) return null;
    if (x <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (p[i][0] >= x) {
      const [xa, ya] = p[i - 1], [xb, yb] = p[i];
      const t = (fx(x) - fx(xa)) / Math.max(1e-12, fx(xb) - fx(xa));
      return ya + t * (yb - ya);
    }
    return p[p.length - 1][1];
  };
  return (
    <div ref={ref} className="relative" onPointerLeave={() => { clear(); setHx(null); }}>
      <svg viewBox={`0 0 ${W} ${h}`} className="w-full" role="img" aria-label={xLabel}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const sx = ((e.clientX - r.left) / r.width) * W;
          if (sx < L || sx > W - R) return;
          const f = fx(x0) + ((sx - L) / (W - L - R)) * (fx(x1) - fx(x0));
          const x = xLog ? 10 ** f : f;
          setHx(x);
          at(e, { title: `${xLabel}: ${xFmt(x)}`, lines: seri.map((s) => ({ key: s.warna, value: yFmt(nilaiDi(s, x) ?? 0), label: s.nama })) });
        }}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke={t === 0 ? "#383f47" : GRID} />
            <text x={L - 6} y={py(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{yFmt(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => <text key={t} x={px(t)} y={h - B + 15} textAnchor="middle" fontSize="10" fill={AXIS}>{xFmt(t)}</text>)}
        <text x={(L + W - R) / 2} y={h - 4} textAnchor="middle" fontSize="10" fill={AXIS}>{xLabel}</text>
        {garisY && <g><line x1={L} x2={W - R} y1={py(garisY.y)} y2={py(garisY.y)} stroke="#8f99a8" strokeDasharray="4 4" />
          <text x={W - R - 4} y={py(garisY.y) - 4} textAnchor="end" fontSize="10" fill={AXIS}>{garisY.label}</text></g>}
        {penanda.map((m) => (
          <g key={m.label}><line x1={px(m.x)} x2={px(m.x)} y1={T} y2={h - B} stroke="#8f99a8" strokeDasharray="3 4" />
            <text x={px(m.x) + 4} y={h - B - 6} fontSize="10" fill="#c5cbd3">{m.label}</text></g>
        ))}
        {seri.map((s) => (
          <g key={s.nama}>
            <path d={s.titik.map(([x, y], i) => `${i ? "L" : "M"}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(" ")} fill="none" stroke={s.warna}
              strokeWidth={s.tebal ? 2.6 : 1.8} strokeDasharray={s.putus ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
            {(s.dot ?? []).map(([x, y]) => <circle key={x} cx={px(x)} cy={py(y)} r={s.tebal ? 4 : 3.2} fill={s.warna} stroke={SURFACE} strokeWidth={1.6} />)}
          </g>
        ))}
        {hx !== null && <line x1={px(hx)} x2={px(hx)} y1={T} y2={h - B} stroke="#c5cbd3" strokeOpacity={0.5} />}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#c5cbd3]">
        {seri.map((s) => <span key={s.nama} className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={s.warna} strokeWidth={s.tebal ? 3 : 2} strokeDasharray={s.putus ? "4 3" : undefined} /></svg>{s.nama}</span>)}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// v5 · precision across fraud rates per generator (the user, 2026-11-13: "create this graph for v5, maybe with varied
// generator"): precision = r·p / (r·p + FPR·(1 − p)) from each model's recall and FPR on each generator; ML v5 solid, v4
// dashed, one colour per generator; the dot is the set's own fraud rate. "Ambang beku" = the thresholds as frozen;
// "FPR 1%" = every model at the same false-alarm rate (threshold set per set, for comparison only).
const GEN_V5: [string, string, string][] = [["generator1", "Generator 1", SERIES[0]], ["generator2", "Generator 2", SERIES[3]], ["generator3", "Generator 3 · data asing", SERIES[2]]];

function PresisiTingkatFraudV5({ b }: { b: MLV5 }) {
  const [mode, setMode] = useState<"beku" | "fpr1">("beku");
  const xs = Array.from({ length: 49 }, (_, i) => 10 ** (-3 + (i * (Math.log10(0.2) + 3)) / 48));
  const prec = (r: number, f: number, p: number) => (r * p) / Math.max(1e-12, r * p + f * (1 - p));
  const rf = (m: MLV5["set"][string]["model"][string]) => (mode === "beku" ? [m.recall, m.fpr] : [m.fpr1_pembanding.recall, 0.01]) as [number, number];
  const seri: Seri[] = [];
  for (const [g, nm, w] of GEN_V5) {
    const s = b.set[g];
    if (!s?.model.ml_v5 || !s.model.v4) continue;
    for (const mk of ["ml_v5", "v4"] as const) {
      const [r, f] = rf(s.model[mk]);
      seri.push({ nama: `${mk === "ml_v5" ? "ML v5" : "v4"} · ${nm}`, warna: w, titik: xs.map((x) => [x, prec(r, f, x)]), tebal: mk === "ml_v5", putus: mk === "v4",
        dot: mk === "ml_v5" ? [[s.prevalensi, prec(r, f, s.prevalensi)]] : [] });
    }
  }
  const g3 = b.set.generator3?.model;
  const at = (mk: "ml_v5" | "v4", p: number) => (g3 ? prec(...rf(g3[mk]), p) : NaN);
  const fmtP = (v: number) => (v < 0.01 ? `${id(v * 100, 1)}%` : `${id(v * 100, v < 0.1 ? 1 : 0)}%`);
  const tingkat = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
  return (
    <ChartCard title="Precision di berbagai tingkat fraud · ML v5 per generator"
      insight={`Generator 3 (data asing) saat fraud langka: ML v5 ${pct(at("ml_v5", 0.001), 1)} pada 0,1% dan ${pct(at("ml_v5", 0.01), 1)} pada 1% (v4 ${pct(at("v4", 0.001), 1)} dan ${pct(at("v4", 0.01), 1)}).`}
      source={<><span>Garis tegak = fraud 2% (acuan) · titik = tingkat fraud set itu</span><div className="ml-auto flex rounded border border-white/10 p-0.5">
        {(["beku", "fpr1"] as const).map((k) => <button key={k} onClick={() => setMode(k)} className={`rounded-sm px-2 py-0.5 ${mode === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
          {k === "beku" ? "Ambang beku" : "FPR disamakan 1%"}</button>)}</div></>}
      table={<Tabel kepala={["Model · generator", ...tingkat.map(fmtP)]} baris={seri.map((s) => [s.nama, ...tingkat.map((p) => { const t = s.titik.find(([x]) => x >= p) ?? s.titik[s.titik.length - 1]; return pct(t[1]); })])} />}>
      <Garis seri={seri} xLog x0={0.001} x1={0.2} xTicks={tingkat} xFmt={fmtP} penanda={[{ x: 0.02, label: "fraud 2%" }]} xLabel="tingkat fraud (skala log)" h={280} />
    </ChartCard>
  );
}

function Tabel({ kepala, baris }: { kepala: string[]; baris: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto"><table className="w-full text-[11.5px]">
      <thead><tr>{kepala.map((k, i) => <th key={k} className={`border-b border-white/10 px-2 py-1.5 font-medium text-[#8f99a8] ${i ? "text-right" : "text-left"}`}>{k}</th>)}</tr></thead>
      <tbody>{baris.map((b, i) => <tr key={i}>{b.map((c, j) => <td key={j} className={`border-b border-white/[.05] px-2 py-1.5 ${j ? "text-right tabular-nums" : "text-left"} text-[#d3d8de]`}>{c}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

// ------------------------------------------------------------------------------------------------ small visuals

function Kpi({ ikon, label, nilai, isi, warna, ket }: { ikon: IconName; label: string; nilai: string; isi: number; warna: string; ket: string }) {
  return (
    <div className={`${box} flex flex-col gap-2 p-3`}>
      <div className="flex items-center gap-2 text-[11px] text-[#abb3bf]"><span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ background: `${warna}26`, color: warna }}><Icon name={ikon} className="h-3.5 w-3.5" /></span>{label}</div>
      <p className="text-[22px] font-semibold leading-none tabular-nums text-white">{nilai}</p>
      <div className="h-1.5 rounded-full" style={{ background: GRID }}><div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, Math.min(100, isi * 100))}%`, background: warna }} /></div>
      <p className="text-[10.5px] leading-snug text-[#8f99a8]">{ket}</p>
    </div>
  );
}

function Batang({ nilai, warna, label, maks = 1 }: { nilai: number | null; warna: string; label?: string; maks?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3 flex-1 rounded-full" style={{ background: GRID }}>
        {nilai !== null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, (nilai / maks) * 100))}%`, background: warna }} />}
      </div>
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label ?? (nilai === null ? "—" : pct(nilai, 0))}</span>
    </div>
  );
}

function Alur({ d }: { d: Doc }) {
  const k = Object.fromEntries(d.sistem.komponen.map((c) => [c.kunci, c]));
  const kotak = (kunci: string, ikon: IconName, warna: string, badge?: string) => {
    const c = k[kunci];
    return (
      <div className="relative min-w-0 rounded-lg border p-2.5" style={{ borderColor: `${warna}66`, background: `${warna}14` }} title={c?.detail}>
        <div className="flex items-center gap-1.5"><span className="shrink-0" style={{ color: warna }}><Icon name={ikon} className="h-4 w-4" /></span><p className="truncate text-[12px] font-semibold text-white">{c?.nama}</p></div>
        <TeknikTag nama={c?.nama} />
        <p className="mt-1 line-clamp-3 text-[10.5px] leading-snug text-[#abb3bf]">{c?.detail}</p>
        {badge && <span className="mt-1.5 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-white" style={{ background: `${warna}55` }}>{badge}</span>}
      </div>
    );
  };
  const panah = <div className="flex items-center justify-center text-[#8f99a8]"><Icon name="right" className="h-4 w-4" /></div>;
  return (
    <div className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1.1fr) 18px minmax(0,1fr) 18px minmax(0,1fr)" }}>
      {kotak("masukan", "doc", "#8f99a8")}{panah}
      {kotak("engine", "bolt", "#c98500", "124 fitur sistem")}{panah}
      <div className="grid gap-2">{kotak("model1", "graph", SERIES[1], `AUPRC ${n3(d.metrik.auprc_model1)}`)}{kotak("model2", "constellation", SERIES[2], `AUPRC ${n3(d.metrik.auprc_model2)}`)}</div>{panah}
      <div className="grid gap-2">{kotak("stacker", "layers", SERIES[0], `AUPRC ${n3(d.metrik.auprc)}`)}{kotak("alert", "bell", SERIES[4], `ambang ${n3(d.sistem.ambang_alert)}`)}</div>{panah}
      {kotak("keputusan", "sparkle", "#199e70", `≥ ${pct(d.sistem.ambang_peluang, 0)} atau alert`)}
    </div>
  );
}

function Matriks({ cm }: { cm: Doc["cm"] }) {
  const sel = (judul: string, n: number, ket: string, warna: string) => (
    <div className="rounded-md p-3" style={{ background: `${warna}22`, border: `1px solid ${warna}55` }}>
      <p className="text-[10.5px] uppercase tracking-wide text-[#abb3bf]">{judul}</p>
      <p className="text-[20px] font-semibold tabular-nums text-white">{id(n)}</p>
      <p className="text-[10.5px] text-[#abb3bf]">{ket}</p>
    </div>
  );
  return (
    <div className="grid gap-1.5 text-center" style={{ gridTemplateColumns: "88px 1fr 1fr" }}>
      <span />
      <span className="text-[11px] text-[#abb3bf]">Ditandai sistem</span><span className="text-[11px] text-[#abb3bf]">Lolos</span>
      <span className="flex items-center justify-end pr-2 text-[11px] text-[#abb3bf]">Fraud</span>
      {sel("True positive", cm.tp, "fraud tertangkap", "#199e70")}{sel("False negative", cm.fn, "fraud lolos", "#d95926")}
      <span className="flex items-center justify-end pr-2 text-[11px] text-[#abb3bf]">Normal</span>
      {sel("False positive", cm.fp, "normal ikut diperiksa", "#c98500")}{sel("True negative", cm.tn, "normal lolos", "#3987e5")}
    </div>
  );
}

/** 100 squares: of every 100 claims in the group, how many are of each kind */
function Seratus({ isi, warna, label }: { isi: number; warna: string; label: string }) {
  const n = Math.round(isi * 100);
  return (
    <div>
      <div className="grid w-fit gap-[3px]" style={{ gridTemplateColumns: "repeat(20, 9px)" }} aria-label={`${n} dari 100 ${label}`}>
        {Array.from({ length: 100 }, (_, i) => <span key={i} className="h-[9px] w-[9px] rounded-[2px]" style={{ background: i < n ? warna : GRID }} />)}
      </div>
      <p className="mt-1.5 text-[11.5px] text-[#d3d8de]"><b className="text-white">{n}</b> dari 100 {label}</p>
    </div>
  );
}

function Distribusi({ d }: { d: Doc["distribusi"] }) {
  const tn = d.normal.reduce((a, b) => a + b, 0) || 1, tf = d.fraud.reduce((a, b) => a + b, 0) || 1;
  const rows = d.normal.map((v, i) => ({ a: d.batas[i], b: d.batas[i + 1], n: v / tn, f: d.fraud[i] / tf }));
  const { box: ref, tip, at, clear } = useTip();
  const W = useLebar(ref), H = 200, L = 40, B = 34, T = 10, lebar = (W - L - 10) / rows.length;
  const sq = (v: number) => Math.sqrt(v); // a square-root axis: the few normal claims above the threshold stay visible
  const py = (v: number) => T + (H - T - B) * (1 - sq(v));
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Distribusi peluang">
        {[0, 0.01, 0.1, 0.5, 1].map((t) => <g key={t}><line x1={L} x2={W - 10} y1={py(t)} y2={py(t)} stroke={t ? GRID : "#383f47"} />
          <text x={L - 6} y={py(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{pct(t, 0)}</text></g>)}
        {rows.map((r, i) => (
          <g key={i} onPointerMove={(e) => at(e, { title: `peluang ${pct(r.a, 0)}–${pct(r.b, 0)}`, lines: [{ key: SERIES[0], value: pct(r.n, 2), label: "dari klaim normal" }, { key: SERIES[1], value: pct(r.f, 1), label: "dari klaim fraud" }] })}>
            <rect x={L + i * lebar + 2} y={T} width={lebar - 4} height={H - T - B} fill="transparent" />
            <rect x={L + i * lebar + 2} y={py(r.n)} width={(lebar - 6) / 2} height={Math.max(0, H - B - py(r.n))} rx={2} fill={SERIES[0]} />
            <rect x={L + i * lebar + 2 + (lebar - 6) / 2 + 2} y={py(r.f)} width={(lebar - 6) / 2} height={Math.max(0, H - B - py(r.f))} rx={2} fill={SERIES[1]} />
          </g>
        ))}
        <line x1={L + rows.length * lebar * 0.5} x2={L + rows.length * lebar * 0.5} y1={T} y2={H - B} stroke="#e5e8eb" strokeDasharray="4 3" />
        <text x={L + rows.length * lebar * 0.5 + 4} y={T + 10} fontSize="10" fill="#e5e8eb">ambang 50%</text>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={L + t * rows.length * lebar} y={H - B + 14} textAnchor="middle" fontSize="10" fill={AXIS}>{pct(t, 0)}</text>)}
        <text x={(W + L) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill={AXIS}>peluang fraud terkalibrasi (sumbu tegak akar kuadrat)</text>
      </svg>
      <div className="mt-1 flex gap-4 text-[11px] text-[#c5cbd3]"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[0] }} />klaim normal</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[1] }} />klaim fraud</span></div>
      <Tooltip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the test outside the training data

/** One measure, the usual evaluation against the test outside the training data: two dots on one scale, the gap between them. */
function Banding({ label, biasa, uji, lebihBaik = "tinggi", maks = 1 }: { label: string; biasa: number; uji: number; lebihBaik?: "tinggi" | "rendah"; maks?: number }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, v / maks)) * 100}%`;
  const turun = lebihBaik === "tinggi" ? uji < biasa - 0.02 : uji > biasa + 0.002;
  const warnaUji = turun ? "#e5484d" : "#199e70";
  return (
    <div className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(90px, 140px) 1fr 150px" }}>
      <span className="text-[12px] text-white">{label}</span>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ background: GRID }} />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ left: `min(${x(biasa)}, ${x(uji)})`, width: `calc(max(${x(biasa)}, ${x(uji)}) - min(${x(biasa)}, ${x(uji)}))`, background: `${warnaUji}66` }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(biasa), background: SERIES[0], borderColor: SURFACE }} title={`evaluasi biasa ${pct(biasa)}`} />
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(uji), background: warnaUji, borderColor: SURFACE }} title={`100 ribu klaim ${pct(uji)}`} />
      </div>
      <span className="text-right text-[12px] tabular-nums"><span className="text-[#8abbff]">{pct(biasa, maks < 0.1 ? 2 : 1)}</span><span className="text-[#8f99a8]"> → </span>
        <b style={{ color: warnaUji }}>{pct(uji, maks < 0.1 ? 2 : 1)}</b></span>
    </div>
  );
}

const NADA: Record<string, string> = { baik: "#199e70", buruk: "#e5484d", netral: "#c98500" };

function Uji100k({ u, d }: { u: Uji; d: Doc }) {
  const [titik, setTitik] = useState<"anggaran" | "keputusan">("anggaran");
  const s = u.sekarang, l = u.lama, r = u.rule;
  const turunRecall = s.recall < d.metrik.recall - 0.1;
  const urut = [...u.skema].sort((a, b) => a.recall - b.recall);
  const prevSeri: Seri[] = (["sekarang", "lama", "rule"] as const).map((k) => ({
    nama: k === "sekarang" ? "Model 1 + 2 (sistem sekarang)" : k === "lama" ? "Sistem lama (latih simulator saja)" : "Rule saja (tanpa label)",
    warna: k === "sekarang" ? SERIES[0] : k === "lama" ? SERIES[3] : "#8f99a8", tebal: k === "sekarang", putus: k === "rule",
    titik: u.prevalensi.tingkat.map((p, i) => [p, u.prevalensi[titik][k][i]] as [number, number]),
    dot: u.prevalensi.tingkat.map((p, i) => [p, u.prevalensi[titik][k][i]] as [number, number]),
  }));
  const fmtP = (v: number) => `${id(v * 100, v < 0.01 ? 1 : v < 0.1 ? 1 : 0)}%`;
  return (
    <section className="space-y-4">
      {/* verdict */}
      <div className={`${box} overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[.06] p-4" style={{ background: turunRecall ? "rgba(229,72,77,.10)" : "rgba(25,158,112,.10)" }}>
          <span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: turunRecall ? "rgba(229,72,77,.2)" : "rgba(25,158,112,.2)", color: turunRecall ? "#ff8e93" : "#7ee2c0" }}>
            <Icon name={turunRecall ? "alert" : "check"} className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Uji di luar data latih · {id(u.klaim)} klaim · {id(u.fraud)} fraud · {u.chunk} batch</p>
            <h2 className="text-[16px] font-semibold text-white">{turunRecall ? `Hasilnya turun: ${pct(s.recall, 0)} fraud tertangkap (evaluasi biasa ${pct(d.metrik.recall, 0)})` : `Hasilnya bertahan: ${pct(s.recall, 0)} fraud tertangkap`}</h2>
          </div>
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
        </div>
        <div className="grid gap-6 p-4 lg:grid-cols-[1.3fr_1fr]">
          <div className="space-y-3">
            <div className="flex gap-4 text-[11px] text-[#c5cbd3]"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES[0] }} />evaluasi biasa (out-of-fold)</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#e5484d]" />100 ribu klaim di luar data latih</span></div>
            <Banding label="Recall" biasa={d.metrik.recall} uji={s.recall} />
            <Banding label="Precision" biasa={d.metrik.precision} uji={s.precision} />
            <Banding label="AUPRC" biasa={d.metrik.auprc} uji={s.auprc ?? 0} />
            <Banding label="False positive" biasa={d.metrik.fpr_normal} uji={s.fpr} lebihBaik="rendah" maks={0.02} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {([["Sistem sekarang", s, SERIES[0]], ["Sistem lama", l, SERIES[3]], ["Rule saja", r, "#8f99a8"]] as [string, Ringkas, string][]).map(([nama, v, w]) => (
              <div key={nama} className="rounded-md border border-white/[.07] p-2.5">
                <p className="truncate text-[11px] text-[#abb3bf]">{nama}</p>
                <p className="mt-1 text-[20px] font-semibold tabular-nums text-white">{pct(v.recall, 0)}</p>
                <p className="text-[10.5px] text-[#8f99a8]">fraud tertangkap</p>
                <div className="mt-1.5 h-1.5 rounded-full" style={{ background: GRID }}><div className="h-1.5 rounded-full" style={{ width: `${v.recall * 100}%`, background: w }} /></div>
                <p className="mt-2 text-[12px] tabular-nums text-[#d3d8de]">{pct(v.precision, 0)}</p>
                <p className="text-[10.5px] text-[#8f99a8]">precision</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {u.cek_luar_latih && <CekLuar c={u.cek_luar_latih} />}

      {/* what we found */}
      {u.temuan && u.temuan.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {u.temuan.map((t) => (
            <div key={t.judul} className={`${box} flex gap-3 p-3`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${NADA[t.nada]}26`, color: NADA[t.nada] }}><Icon name={t.ikon as IconName} className="h-4 w-4" /></span>
              <div className="min-w-0"><p className="text-[12.5px] font-semibold text-white">{t.judul}</p><p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{t.isi}</p></div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <ChartCard title="Fraud tertangkap per jenis" insight="Diurutkan dari yang paling sering lolos; tiga cara dibandingkan pada klaim yang sama."
          table={<Tabel kepala={["Skema", "Modus", "n", "Sekarang", "Lama", "Rule"]} baris={u.skema.map((x) => [x.label, x.modus.map((m) => m.kode).join(", "), id(x.n), pct(x.recall), pct(x.recall_lama), pct(x.recall_rule)])} />}>
          <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">
            {([["sistem sekarang", SERIES[0]], ["sistem lama", SERIES[3]], ["rule saja", "#8f99a8"]] as const).map(([n, w]) => <span key={n} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: w }} />{n}</span>)}
          </div>
          <div className="space-y-2.5">{urut.map((x) => (
            <div key={x.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)" }}>
              <div className="min-w-0">
                <p className="truncate text-[12px] text-white" title={x.label}>{x.label}</p>
                <div className="flex flex-wrap gap-1">{x.modus.map((m) => <span key={m.kode} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]" title={m.nama}>{m.kode} {m.nama.split(" (")[0]}</span>)}
                  <span className="text-[10px] text-[#8f99a8]">n = {id(x.n)}</span></div>
              </div>
              <div className="space-y-1"><Batang nilai={x.recall} warna={SERIES[0]} /><Batang nilai={x.recall_lama} warna={SERIES[3]} /><Batang nilai={x.recall_rule} warna="#8f99a8" /></div>
            </div>))}</div>
        </ChartCard>
        <div className="space-y-4">
          <ChartCard title="Confusion matrix" insight={`${id(s.tp)} dari ${id(u.fraud)} fraud tertangkap; ${id(s.fp)} dari ${id(u.normal)} klaim normal ikut ditandai.`}>
            <Matriks cm={{ tp: s.tp, fp: s.fp, fn: s.fn, tn: s.tn }} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Seratus isi={s.precision} warna="#199e70" label="klaim yang ditandai memang fraud" />
              <Seratus isi={s.recall} warna={s.recall < 0.7 ? "#e5484d" : SERIES[0]} label="klaim fraud tertangkap" />
            </div>
          </ChartCard>
          <ChartCard title="Sebaran peluang fraud" insight="Bila banyak klaim fraud (oranye) jatuh di bawah ambang 50%, model tidak mengenalinya."
            table={<Tabel kepala={["Peluang", "Normal", "Fraud"]} baris={u.distribusi.normal.map((v, i) => [`${pct(u.distribusi.batas[i], 0)}–${pct(u.distribusi.batas[i + 1], 0)}`, id(v), id(u.distribusi.fraud[i])])} />}>
            <Distribusi d={u.distribusi} />
          </ChartCard>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Precision di berbagai tingkat fraud · 100 ribu klaim" insight={`Saat fraud hanya 0,1%: sistem sekarang ${pct(u.prevalensi[titik].sekarang[0])}, sistem lama ${pct(u.prevalensi[titik].lama[0])}, rule ${pct(u.prevalensi[titik].rule[0])}.`}
          source={<><span>Garis tegak = tingkat fraud uji ini</span><div className="ml-auto flex rounded border border-white/10 p-0.5">
            {(["anggaran", "keputusan"] as const).map((k) => <button key={k} onClick={() => setTitik(k)} className={`rounded-sm px-2 py-0.5 ${titik === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
              {k === "anggaran" ? `Anggaran 2% (${id(u.prevalensi.anggaran_k)} klaim)` : "Aturan keputusan"}</button>)}</div></>}
          table={<Tabel kepala={["Metode", ...u.prevalensi.tingkat.map(fmtP)]} baris={prevSeri.map((x, i) => [x.nama, ...u.prevalensi[titik][(["sekarang", "lama", "rule"] as const)[i]].map((v) => pct(v))])} />}>
          <Garis seri={prevSeri} xLog x0={0.001} x1={0.2} xTicks={[0.001, 0.005, 0.01, u.prevalensi.aliran, 0.05, 0.1, 0.2]} xFmt={fmtP}
            penanda={[{ x: u.prevalensi.aliran, label: "uji ini" }]} xLabel="tingkat fraud (skala log)" />
        </ChartCard>
        <ChartCard title="Precision@k · 100 ribu klaim" insight={`Klaim dengan skor tertinggi: ${pct(u.presisi_k.sekarang.precision[u.presisi_k.sekarang.k.indexOf(500)])} fraud pada k = 500.`}
          table={<Tabel kepala={["k", "Sekarang", "Recall", "Lama"]} baris={u.presisi_k.sekarang.k.map((k, i) => [id(k), pct(u.presisi_k.sekarang.precision[i]), pct(u.presisi_k.sekarang.recall[i]), pct(u.presisi_k.lama.precision[i])])} />}>
          <Garis seri={([["sekarang", "Model 1 + 2 (sistem sekarang)", SERIES[0]], ["lama", "Sistem lama (latih simulator saja)", SERIES[3]]] as const).map(([k, n, w]) => ({
            nama: n, warna: w, tebal: k === "sekarang", titik: u.presisi_k[k].k.map((kk, i) => [kk, u.presisi_k[k].precision[i]] as [number, number]),
            dot: u.presisi_k[k].k.map((kk, i) => [kk, u.presisi_k[k].precision[i]] as [number, number]) }))}
            x0={50} x1={u.presisi_k.sekarang.k[u.presisi_k.sekarang.k.length - 1]} xTicks={u.presisi_k.sekarang.k.filter((k) => [50, 1000, 2000, 3000, 5000].includes(k))} xFmt={(v) => id(Math.round(v))}
            xLabel="k (klaim teratas)" penanda={[{ x: u.fraud, label: "jumlah fraud" }]} />
        </ChartCard>
      </div>
      <p className="text-[10.5px] text-[#8f99a8]">Sumber uji: {u.sumber}. Dijalankan {u.dibuat} oleh testing/uji100k.py.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the technique of each box
// The user, 2026-11-12: "also tell which ML technique used here, like random forest or graph or what?". Every learned model
// is gradient-boosted decision trees (LightGBM), not a random forest; "graph" = graph features (the mean of each claim's
// earlier neighbours over 4 relations) fed into LightGBM, not a graph neural network.
const TEKNIK: Record<string, string> = {
  "Klaim + entity resolution": "Rule + Jaro-Winkler (fuzzy nama)",
  // VIME's embedding and anomaly are not model features (testing/fitur.engine_cols drops them); only its claim-field scaling is.
  "Engine realtime": "Rule engine · 45 rule + feature klaim",
  "Rule layer": "LightGBM (GBDT) · monoton",
  "Spesialis coding": "LightGBM (GBDT) · monoton · fitur graph",
  "Spesialis tagihan": "LightGBM (GBDT) · monoton · fitur graph",
  "Spesialis episode": "LightGBM (GBDT) · monoton · fitur graph",
  "Spesialis identitas": "LightGBM (GBDT) · monoton · fitur graph",
  "Model 1 · graph + tetangga": "LightGBM (GBDT) · fitur graph: agregasi tetangga",
  "Model 2 · jaringan RS": "LightGBM (GBDT) · fitur jaringan",
  "Monotone fusion + calibration": "LightGBM stacker monoton + isotonic regression",
  "Stacker + kalibrasi": "LightGBM stacker + isotonic regression",
  "Alert jaringan RS": "LightGBM monoton · ambang persentil 99,9",
  "Rule route": "Rule (tanpa ML)",
  "Network rule": "Rule graph tanpa label",
  "Keputusan + penjelasan AI": "Ambang peluang · LLM hanya menjelaskan",
};

function TeknikTag({ nama }: { nama?: string }) {
  const t = nama ? TEKNIK[nama] : undefined;
  return t ? (
    <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded bg-white/[.07] px-1.5 py-0.5 text-[10px] text-[#d3d8de]" title={`Teknik: ${t}`}>
      <Icon name="cpu" className="h-3 w-3 shrink-0 text-[#8f99a8]" /><span className="truncate">{t}</span></span>
  ) : null;
}

/** One box of a flow; with `onClick` it is a button that opens the box's detail (the v3 flow). */
function KotakAlur({ ikon, warna, nama, detail, badge, chips, sub, onClick }: { ikon: IconName; warna: string; nama: string; detail: string; badge?: string; chips?: string[]; sub?: string; onClick?: () => void }) {
  const isi = (
    <>
      <div className="flex items-center gap-1.5"><span className="shrink-0" style={{ color: warna }}><Icon name={ikon} className="h-4 w-4" /></span><p className="truncate text-[12px] font-semibold text-white">{nama}</p>
        {onClick && <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-[#8f99a8] group-hover:text-white">detail<Icon name="right" className="h-3 w-3" /></span>}</div>
      <TeknikTag nama={nama} />
      <p className="mt-1 line-clamp-3 text-[10.5px] leading-snug text-[#abb3bf]">{detail}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {badge && <span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-white" style={{ background: `${warna}55` }}>{badge}</span>}
        {(chips ?? []).map((c) => <span key={c} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]">{c}</span>)}
        {sub && <span className="text-[10px] tabular-nums text-[#8f99a8]">{sub}</span>}
      </div>
    </>
  );
  const gaya = { borderColor: `${warna}66`, background: `${warna}14` };
  return onClick ? (
    <button type="button" onClick={onClick} title={`${detail} · klik untuk detail`} style={gaya}
      className="group relative w-full min-w-0 cursor-pointer rounded-lg border p-2.5 text-left transition hover:ring-1 hover:ring-white/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#8abbff]">
      {isi}
    </button>
  ) : (
    <div className="relative min-w-0 rounded-lg border p-2.5" style={gaya} title={detail}>{isi}</div>
  );
}

// ------------------------------------------------------------------------------------------------ architecture v2 (rule-aware)
// The user, 2026-11-12: "create new architecture to repair it, that integrate rule", "i want honest result from non trained
// data, no problem if it's bad", "visual explanation (no table and text only paragraph)", "also create this [Alur sistem] for
// new architecture". Read from arsitektur_v2 in /api/ml-sistem (testing/laporan_v2.py): every test number is from the
// 100.000 claims no model trained on.

type RV = Ringkas & { auprc: number; auroc: number };
type SkemaV2 = { skema: string; label: string; modus: { kode: string; nama: string }[]; famili: string | null; n: number; recall_v2: number; recall_sekarang: number;
  recall_v1_data_baru: number; lapisan: Record<string, number> };
type V2 = {
  dibuat: string; dilatih: string; klaim: number; fraud: number; normal: number;
  ringkas: Record<"sekarang" | "v2" | "v1_data_baru" | "v2_data_lama" | "v2_tanpa_rute", RV>;
  temuan: { ikon: string; judul: string; isi: string; nada: "baik" | "buruk" | "netral" }[];
  rute: { sinyal: { nama: string; contoh: number; laju_normal: number }[]; min_contoh: number; maks_normal: number; tambah_fraud: number; tambah_normal: number };
  skema: SkemaV2[]; lapisan_nama: Record<string, string>; lapisan_normal: Record<string, number>; lapisan_normal_p99: Record<string, number>;
  mutu_lapisan: Record<string, number>; ambang_alert: number; ambang_peluang: number;
  famili: { kunci: string; nama: string; modus: string[]; sinyal: number }[]; jaringan: { nama: string; modus: string[] };
  data_latih: { sim: number; aug: number; v2: number; klaim: number; fraud: number };
  validasi: Record<"v2" | "sekarang", { precision: number; recall: number; fpr: number; auprc: number }>;
  tak_dikenal: { famili: string; nama: string; modus: string[]; n: number; recall_v2: number; recall_v1: number; recall_v2_tanpa_rute: number; recall_v2_dikenal: number; fpr_v2: number;
    per_skema?: { skema: string; label: string; recall_v2: number; recall_v2_tanpa_rute: number | null; recall_v1: number | null }[] }[];
  sumber_uji?: string[];
  dipakai?: { layanan: string; sejak: string; v1_disimpan: string };
  bench?: { e2e?: { lulus: number; gagal: number; gagal_daftar: string[]; dijalankan: string };
    uji15?: { total: number; cocok: number; fraud: number; n_fraud: number; normal: number; n_normal: number; modus: number; bug: number; dijalankan: string } };
  cm: { tp: number; fp: number; fn: number; tn: number };
  presisi_k: Record<"sekarang" | "v2", { k: number[]; precision: number[]; recall: number[] }>;
  prevalensi: { tingkat: number[]; uji: number; anggaran_k: number; keputusan: Record<"sekarang" | "v2", number[]>; anggaran: Record<"sekarang" | "v2", number[]> };
  distribusi: { batas: number[]; normal: number[]; fraud: number[] };
  cek_luar_latih?: Uji["cek_luar_latih"];
};

const LAPISAN_V2 = ["rule", "koding", "tagihan", "episode", "identitas", "model1", "model2"] as const;
const IKON_LAPISAN: Record<string, IconName> = { rule: "logic", koding: "code", tagihan: "doc", episode: "clock", identitas: "lock", model1: "graph", model2: "constellation" };
const SPESIALIS = "#9d7bd8";
const ABU = "#8f99a8";

/** One measure, the system now against architecture v2 on the same claims: two dots on one scale. */
function Geser({ label, a, b, lebihBaik = "tinggi", maks = 1 }: { label: string; a: number; b: number; lebihBaik?: "tinggi" | "rendah"; maks?: number }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, v / maks)) * 100}%`;
  const baik = lebihBaik === "tinggi" ? b >= a - 0.005 : b <= a + 0.0005;
  const w = baik ? "#199e70" : "#e5484d";
  const d = maks < 0.1 ? 2 : 1;
  return (
    <div className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(80px, 120px) 1fr 128px" }}>
      <span className="text-[12px] text-white">{label}</span>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ background: GRID }} />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ left: `min(${x(a)}, ${x(b)})`, width: `calc(max(${x(a)}, ${x(b)}) - min(${x(a)}, ${x(b)}))`, background: `${w}66` }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(a), background: ABU, borderColor: SURFACE }} title={`sistem v1 ${pct(a, d)}`} />
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(b), background: w, borderColor: SURFACE }} title={`arsitektur v2 ${pct(b, d)}`} />
      </div>
      <span className="text-right text-[12px] tabular-nums"><span className="text-[#c5cbd3]">{pct(a, d)}</span><span className="text-[#8f99a8]"> → </span><b style={{ color: w }}>{pct(b, d)}</b></span>
    </div>
  );
}

/** Data or architecture: the four combinations on the same 100.000 claims. */
function DataAtauArsitektur({ r }: { r: V2["ringkas"] }) {
  const sel = (k: keyof V2["ringkas"], tag?: string) => {
    const v = r[k], utama = k === "v2";
    return (
      <div className="rounded-md p-3" style={{ background: `rgba(57,135,229,${(0.06 + 0.42 * v.recall).toFixed(3)})`, border: utama ? `1.5px solid ${SERIES[0]}` : "1px solid rgba(255,255,255,.07)" }}>
        <div className="flex items-center justify-between gap-2"><p className="text-[22px] font-semibold leading-none tabular-nums text-white">{pct(v.recall, 0)}</p>
          {tag && <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-[#d3d8de]">{tag}</span>}</div>
        <p className="mt-1 text-[10.5px] text-[#c5cbd3]">fraud tertangkap</p>
        <p className="mt-1.5 text-[11px] tabular-nums text-[#d3d8de]">precision {pct(v.precision, 0)} · normal ditandai {pct(v.fpr, 2)}</p>
      </div>
    );
  };
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: "92px 1fr 1fr" }}>
      <span /><span className="text-center text-[11px] text-[#abb3bf]">Arsitektur v1</span><span className="text-center text-[11px] text-[#abb3bf]">Arsitektur v2 (rule-aware)</span>
      <span className="flex items-center text-[11px] leading-tight text-[#abb3bf]">Data latih lama</span>{sel("sekarang", "sistem v1")}{sel("v2_data_lama")}
      <span className="flex items-center text-[11px] leading-tight text-[#abb3bf]">Data latih baru</span>{sel("v1_data_baru")}{sel("v2", "v2")}
    </div>
  );
}

function AlurV2({ a }: { a: V2 }) {
  const m = a.mutu_lapisan;
  const kotak = (ikon: IconName, warna: string, nama: string, detail: string, badge?: string, chips?: string[]) => (
    <KotakAlur key={nama} ikon={ikon} warna={warna} nama={nama} detail={detail} badge={badge} chips={chips} />
  );
  const panah = <div className="hidden items-center justify-center text-[#8f99a8] lg:flex"><Icon name="right" className="h-4 w-4" /></div>;
  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,.8fr)_18px_minmax(0,.9fr)_18px_minmax(0,2.2fr)_18px_minmax(0,1fr)_18px_minmax(0,.9fr)] lg:items-center">
      {kotak("doc", ABU, "Klaim + entity resolution", "Pasien dicocokkan lewat no RM, nama, dan SEP; klaim masuk ke engine realtime.")}{panah}
      {kotak("bolt", "#c98500", "Engine realtime", "45 sinyal rule, tiap sinyal terhubung ke modus Permenkes 16/2019; 124 fitur sistem per klaim.", "124 fitur · 45 sinyal")}{panah}
      <div className="grid gap-2">
        {kotak("logic", "#c98500", "Rule layer", "LightGBM monoton pada 45 sinyal + skor rule: bobot tiap rule dipelajari dari label; temuan hanya bisa menaikkan skor.", `AUPRC ${n3(m.rule)}`)}
        <div className="grid gap-2 sm:grid-cols-2">
          {a.famili.map((f) => kotak(IKON_LAPISAN[f.kunci] ?? "layers", SPESIALIS, a.lapisan_nama[f.kunci] ?? f.nama,
            `${f.nama}: ${f.sinyal} sinyal rule (monoton) + klaim + tetangga graph; dilatih pada keluarganya saja.`, `AUPRC ${n3(m[f.kunci])}`, f.modus))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {kotak("graph", SERIES[1], "Model 1 · graph + tetangga", "LightGBM pada 624 fitur: klaim + rata-rata tetangga di 4 relasi graph.", `AUPRC ${n3(m.model1)}`)}
          {kotak("constellation", SERIES[2], "Model 2 · jaringan RS", "Peserta lain yang berbagi RS dalam ±3/7/14 hari.", `AUPRC ${n3(m.model2)}`, a.jaringan.modus)}
        </div>
      </div>{panah}
      <div className="grid gap-2">
        {kotak("layers", SERIES[0], "Monotone fusion + calibration", "Menggabungkan 7 lapisan; tiap lapisan hanya bisa menaikkan risiko; lalu isotonic regression.", `AUPRC ${n3(m.fusi)}`)}
        {kotak("bell", "#e5484d", "Alert jaringan RS", "LightGBM monoton pada peserta berbagi RS ±3–60 hari; ambang persentil 99,9 klaim normal.", `ambang ${n3(a.ambang_alert)}`)}
        {kotak("logic", "#c98500", "Rule route", `Sinyal rule spesifik (≤ ${pct(a.rute.maks_normal, 1)} klaim normal) yang belum punya ${a.rute.min_contoh} contoh berlabel → perlu diperiksa.`,
          `${a.rute.sinyal.length} sinyal FKRTL`)}
      </div>{panah}
      {kotak("sparkle", "#199e70", "Keputusan + penjelasan AI", "Terdeteksi → AI menjelaskan jenis fraud (Permenkes), alasan, graph, dan perbaikan; lolos → \"Klaim aman\".", `≥ ${pct(a.ambang_peluang, 0)} atau alert`)}
    </div>
  );
}

/** Which layer sees each fraud type: the median probability of every layer on the test fraud claims of that type. */
function PetaLapisan({ a }: { a: V2 }) {
  const { box: ref, tip, at, clear } = useTip();
  const urutFam = ["koding", "tagihan", "episode", "identitas", "jaringan"];
  const rows = [...a.skema].sort((x, y) => urutFam.indexOf(x.famili ?? "") - urutFam.indexOf(y.famili ?? "") || y.recall_v2 - x.recall_v2);
  const isi = (v: number) => `rgba(57,135,229,${(0.05 + 0.95 * v).toFixed(3)})`;
  const sel = (judul: string, k: string, v: number, garis: boolean) => (
    <span key={k} onPointerMove={(e) => at(e, { title: judul, lines: [{ key: SERIES[0], value: pct(v, 0), label: `median peluang · ${a.lapisan_nama[k]}` }] })}
      className="flex h-7 items-center justify-center rounded-[3px] text-[10.5px] tabular-nums"
      style={{ background: isi(v), color: v > 0.5 ? "#fff" : "#c5cbd3", boxShadow: garis ? "inset 0 0 0 1.5px #e5e8eb" : undefined }}>{pct(v, 0)}</span>
  );
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <div className="overflow-x-auto">
        <div className="grid min-w-[620px] gap-[3px]" style={{ gridTemplateColumns: `minmax(170px,1.7fr) repeat(${LAPISAN_V2.length}, minmax(52px,1fr))` }}>
          <span />
          {LAPISAN_V2.map((k) => <span key={k} className="flex flex-col items-center gap-0.5 pb-1 text-center text-[10px] leading-tight text-[#abb3bf]">
            <Icon name={IKON_LAPISAN[k]} className="h-3.5 w-3.5" />{a.lapisan_nama[k]}</span>)}
          {rows.map((s) => (
            <Fragment key={s.skema}>
              <span className="flex min-w-0 items-center gap-1.5 pr-2"><span className="truncate text-[11.5px] text-white" title={s.label}>{s.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-[#8f99a8]">{pct(s.recall_v2, 0)}</span></span>
              {LAPISAN_V2.map((k) => sel(s.label, k, s.lapisan[k] ?? 0, s.famili === k))}
            </Fragment>
          ))}
          <span className="flex items-center pr-2 text-[11.5px] italic text-[#abb3bf]">Klaim normal</span>
          {LAPISAN_V2.map((k) => sel("Klaim normal", k, a.lapisan_normal[k] ?? 0, false))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-[#c5cbd3]">
        <span className="flex items-center gap-1.5">0%<span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${isi(0)}, ${isi(1)})` }} />100%</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px]" style={{ boxShadow: "inset 0 0 0 1.5px #e5e8eb" }} />spesialis keluarga skema itu</span>
        <span className="text-[#8f99a8]">angka kecil di kanan nama = fraud tertangkap v2</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function ArsitekturV2({ a }: { a: V2 }) {
  const [titik, setTitik] = useState<"keputusan" | "anggaran">("keputusan");
  const s = a.ringkas.sekarang, v = a.ringkas.v2;
  const urut = [...a.skema].sort((x, y) => x.recall_v2 - y.recall_v2);
  const fmtP = (p: number) => `${id(p * 100, p < 0.1 ? 1 : 0)}%`;
  const prevSeri: Seri[] = (["v2", "sekarang"] as const).map((k) => ({
    nama: k === "v2" ? "Arsitektur v2" : "Sistem v1", warna: k === "v2" ? SERIES[0] : ABU, tebal: k === "v2",
    titik: a.prevalensi.tingkat.map((p, i) => [p, a.prevalensi[titik][k][i]] as [number, number]),
    dot: a.prevalensi.tingkat.map((p, i) => [p, a.prevalensi[titik][k][i]] as [number, number]),
  }));
  const i01 = a.prevalensi.tingkat.indexOf(0.001), i1 = a.prevalensi.tingkat.indexOf(0.01);
  const dl = a.data_latih;
  return (
    <section className="space-y-4">
      {/* verdict */}
      <div className={`${box} overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[.06] p-4" style={{ background: "rgba(25,158,112,.10)" }}>
          <span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: "rgba(25,158,112,.2)", color: "#7ee2c0" }}><Icon name="layers" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Arsitektur v2 · rule-aware · dilatih {a.dilatih} · diuji pada {id(a.klaim)} klaim yang tidak pernah dilatih</p>
            <h2 className="text-[16px] font-semibold text-white">{pct(v.recall, 0)} fraud tertangkap pada 100 ribu klaim baru (sistem v1 {pct(s.recall, 0)})</h2>
          </div>
          {a.dipakai && <span className="flex items-center gap-1 rounded bg-[#199e70]/20 px-2 py-1 text-[11px] text-[#7ee2c0]" title={`v1 disimpan di ${a.dipakai.v1_disimpan}`}>
            <Icon name="check" className="h-3.5 w-3.5" />Dipakai {a.dipakai.layanan}</span>}
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
        </div>
        {a.sumber_uji && (
          <div className="flex flex-wrap gap-2 border-b border-white/[.06] px-4 py-2.5">
            {a.sumber_uji.map((t, i) => (
              <span key={t} className="flex items-center gap-1.5 rounded-full border border-white/[.08] px-2.5 py-1 text-[11px] text-[#c5cbd3]">
                <Icon name={(["database", "doc", "alert", "lock"] as IconName[])[i] ?? "info"} className="h-3.5 w-3.5 text-[#8f99a8]" />{t}</span>
            ))}
          </div>
        )}
        <div className="grid gap-6 p-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-3">
            <div className="flex gap-4 text-[11px] text-[#c5cbd3]"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: ABU }} />sistem v1</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#199e70]" />arsitektur v2 (merah = lebih buruk)</span></div>
            <Geser label="Recall" a={s.recall} b={v.recall} />
            <Geser label="Precision" a={s.precision} b={v.precision} />
            <Geser label="AUPRC" a={s.auprc} b={v.auprc} />
            <Geser label="Normal ditandai" a={s.fpr} b={v.fpr} lebihBaik="rendah" maks={0.01} />
          </div>
          <div>
            <p className="mb-2 text-[11.5px] text-[#abb3bf]">Data atau arsitektur? Empat kombinasi pada 100 ribu klaim yang sama</p>
            <DataAtauArsitektur r={a.ringkas} />
          </div>
        </div>
      </div>

      {/* what the numbers say */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {a.temuan.map((t) => (
          <div key={t.judul} className={`${box} flex gap-3 p-3`}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${NADA[t.nada]}26`, color: NADA[t.nada] }}><Icon name={t.ikon as IconName} className="h-4 w-4" /></span>
            <div className="min-w-0"><p className="text-[12.5px] font-semibold text-white">{t.judul}</p><p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{t.isi}</p></div>
          </div>
        ))}
      </div>

      {a.bench && (a.bench.uji15 || a.bench.e2e) && (
        <div className={`${box} p-3`}>
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-white"><Icon name="play" className="h-4 w-4 text-[#8abbff]" />Uji di /testing dengan arsitektur v2
            <span className="font-normal text-[#8f99a8]">· browser, klaim contoh sintetis{a.bench.uji15 ? ` · ${a.bench.uji15.dijalankan}` : ""}</span></p>
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {([
              a.bench.uji15 && ["Klaim sesuai harapan", a.bench.uji15.cocok, a.bench.uji15.total, "check"],
              a.bench.uji15 && ["Fraud terdeteksi", a.bench.uji15.fraud, a.bench.uji15.n_fraud, "alert"],
              a.bench.uji15 && ["Klaim normal lolos", a.bench.uji15.normal, a.bench.uji15.n_normal, "lock"],
              a.bench.uji15 && ["Modus Permenkes sesuai", a.bench.uji15.modus, a.bench.uji15.n_fraud, "doc"],
              a.bench.e2e && ["Cek end-to-end lulus", a.bench.e2e.lulus, a.bench.e2e.lulus + a.bench.e2e.gagal, "layers"],
            ].filter(Boolean) as [string, number, number, IconName][]).map(([l, n, t, ik]) => {
              const w = n === t ? "#199e70" : "#e5484d";
              return (
                <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${w}26`, color: w }}><Icon name={ik} className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1"><p className="text-[16px] font-semibold tabular-nums text-white">{id(n)}<span className="text-[12px] font-normal text-[#8f99a8]">/{id(t)}</span></p>
                    <div className="mt-1 h-1 rounded-full" style={{ background: GRID }}><div className="h-1 rounded-full" style={{ width: `${(n / Math.max(1, t)) * 100}%`, background: w }} /></div>
                    <p className="mt-1 truncate text-[10.5px] text-[#8f99a8]">{l}</p></div>
                </div>
              );
            })}
          </div>
          {a.bench.e2e && a.bench.e2e.gagal > 0 && <p className="mt-2 text-[11px] text-[#ff8e93]">Gagal: {a.bench.e2e.gagal_daftar.join(" · ")}</p>}
        </div>
      )}

      <ChartCard title="Alur sistem · arsitektur v2" insight="Rule tidak lagi satu fitur di antara 624: punya lapisan sendiri, dan tiap kelompok modus Permenkes punya spesialis yang hanya bisa dinaikkan oleh sinyalnya."
        source={<span>Arahkan kursor ke kotak untuk detail · AUPRC out-of-fold (spesialis: pada keluarganya sendiri vs klaim normal)</span>}>
        <AlurV2 a={a} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.15fr]">
        <ChartCard title="Fraud tertangkap per jenis · 100 ribu klaim" insight="Diurutkan dari yang paling sering lolos di v2.">
          <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">
            {([["arsitektur v2", SERIES[0]], ["sistem v1", ABU]] as const).map(([n, w]) => <span key={n} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: w }} />{n}</span>)}
          </div>
          <div className="space-y-2.5">{urut.map((x) => (
            <div key={x.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)" }}>
              <div className="min-w-0">
                <p className="truncate text-[12px] text-white" title={x.label}>{x.label}</p>
                <div className="flex flex-wrap gap-1">{x.modus.map((m) => <span key={m.kode} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]" title={m.nama}>{m.kode} {m.nama.split(" (")[0]}</span>)}
                  <span className="text-[10px] text-[#8f99a8]">n = {id(x.n)}</span></div>
              </div>
              <div className="space-y-1"><Batang nilai={x.recall_v2} warna={x.recall_v2 < 0.9 ? "#e5484d" : SERIES[0]} /><Batang nilai={x.recall_sekarang} warna={ABU} /></div>
            </div>))}</div>
        </ChartCard>
        <ChartCard title="Lapisan mana yang melihat tiap jenis fraud" insight="Median peluang tiap lapisan pada klaim fraud uji: spesialis menyala untuk keluarganya sendiri, dan tetap gelap pada klaim normal.">
          <PetaLapisan a={a} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Jenis fraud yang belum pernah dilihat" insight="Satu kelompok modus dikeluarkan dari seluruh data latih, lalu fraud keluarga itu di 100 ribu klaim diuji. Tanpa rule route, model (v1 maupun v2) hampir buta terhadap jenis baru.">
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <div className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#c98500]/15 text-[#c98500]"><Icon name="logic" className="h-4 w-4" /></span>
              <div><p className="text-[15px] font-semibold tabular-nums text-white">+{id(a.rute.tambah_fraud)} fraud · +{id(a.rute.tambah_normal)} normal</p>
                <p className="text-[10.5px] text-[#8f99a8]">biaya rule route pada uji 100 ribu (jenis yang sudah dikenal)</p></div>
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#3987e5]/15 text-[#8abbff]"><Icon name="search" className="h-4 w-4" /></span>
              <div><p className="text-[15px] font-semibold tabular-nums text-white">
                {pct(a.tak_dikenal.reduce((t, x) => t + x.recall_v2_tanpa_rute, 0) / Math.max(1, a.tak_dikenal.length), 0)} → {pct(a.tak_dikenal.reduce((t, x) => t + x.recall_v2, 0) / Math.max(1, a.tak_dikenal.length), 0)}</p>
                <p className="text-[10.5px] text-[#8f99a8]">rata-rata jenis baru tertangkap: tanpa → dengan rule route</p></div>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">
            {([["v2, keluarga ini ikut dilatih", "#5f6b7a"], ["v2 + rule route, tidak pernah dilatih", SERIES[0]], ["v2 tanpa rute, tidak pernah dilatih", "#8abbff80"], ["v1, tidak pernah dilatih", SERIES[3]]] as const).map(([n, w]) =>
              <span key={n} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: w }} />{n}</span>)}
          </div>
          {a.tak_dikenal.length ? <div className="space-y-3">{a.tak_dikenal.map((t) => (
            <div key={t.famili} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)" }}>
              <div className="min-w-0"><p className="truncate text-[12px] text-white">{t.nama}</p>
                <div className="flex flex-wrap gap-1">{t.modus.map((m) => <span key={m} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]">{m}</span>)}<span className="text-[10px] text-[#8f99a8]">n = {id(t.n)}</span></div></div>
              <div className="space-y-1"><Batang nilai={t.recall_v2_dikenal} warna="#5f6b7a" /><Batang nilai={t.recall_v2} warna={SERIES[0]} />
                <Batang nilai={t.recall_v2_tanpa_rute} warna="#8abbff80" /><Batang nilai={t.recall_v1} warna={SERIES[3]} /></div>
              {t.per_skema && t.per_skema.length > 1 && (
                <div className="col-span-2 mt-1.5 flex flex-wrap gap-1.5">
                  {t.per_skema.map((x) => {
                    const w = x.recall_v2 < 0.2 ? "#e5484d" : x.recall_v2 < 0.7 ? "#c98500" : "#199e70";
                    return <span key={x.skema} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px]" style={{ borderColor: `${w}66`, background: `${w}14` }}
                      title={`v2 + rute ${pct(x.recall_v2, 1)} · tanpa rute ${pct(x.recall_v2_tanpa_rute, 1)} · v1 ${pct(x.recall_v1, 1)}`}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: w }} /><span className="text-[#d3d8de]">{x.label}</span><b className="tabular-nums text-white">{pct(x.recall_v2, x.recall_v2 < 0.1 ? 1 : 0)}</b></span>;
                  })}
                </div>
              )}
            </div>))}</div> : <p className="text-[11.5px] text-[#8f99a8]">Belum dihitung.</p>}
        </ChartCard>
        <ChartCard title="Confusion matrix · arsitektur v2" insight={`${id(a.cm.tp)} dari ${id(a.fraud)} fraud tertangkap; ${id(a.cm.fp)} dari ${id(a.normal)} klaim normal ikut ditandai (v1 ${id(s.fp)}).`}>
          <Matriks cm={a.cm} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Seratus isi={v.precision} warna="#199e70" label="klaim yang ditandai memang fraud" />
            <Seratus isi={v.recall} warna={SERIES[0]} label="klaim fraud tertangkap" />
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Precision di berbagai tingkat fraud" insight={`Jujur: v2 menandai lebih banyak klaim normal, jadi saat fraud langka precision-nya turun: ${pct(a.prevalensi[titik].v2[i01])} pada fraud 0,1% dan ${pct(a.prevalensi[titik].v2[i1])} pada 1% (v1 ${pct(a.prevalensi[titik].sekarang[i01])} dan ${pct(a.prevalensi[titik].sekarang[i1])}).`}
          source={<><span>Garis tegak = tingkat fraud uji ini</span><div className="ml-auto flex rounded border border-white/10 p-0.5">
            {(["keputusan", "anggaran"] as const).map((k) => <button key={k} onClick={() => setTitik(k)} className={`rounded-sm px-2 py-0.5 ${titik === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
              {k === "anggaran" ? `Anggaran 2% (${id(a.prevalensi.anggaran_k)} klaim)` : "Aturan keputusan"}</button>)}</div></>}>
          <Garis seri={prevSeri} xLog x0={0.001} x1={0.2} xTicks={[0.001, 0.005, 0.01, a.prevalensi.uji, 0.05, 0.1, 0.2]} xFmt={fmtP}
            penanda={[{ x: a.prevalensi.uji, label: "uji ini" }]} xLabel="tingkat fraud (skala log)" />
        </ChartCard>
        <ChartCard title="Precision@k · 100 ribu klaim" insight={`Bila hanya k klaim teratas yang diperiksa: v2 ${pct(a.presisi_k.v2.precision[a.presisi_k.v2.k.indexOf(2500)])} fraud pada k = 2.500, v1 ${pct(a.presisi_k.sekarang.precision[a.presisi_k.sekarang.k.indexOf(2500)])}.`}>
          <Garis seri={(["v2", "sekarang"] as const).map((k) => ({ nama: k === "v2" ? "Arsitektur v2" : "Sistem v1", warna: k === "v2" ? SERIES[0] : ABU, tebal: k === "v2",
            titik: a.presisi_k[k].k.map((kk, i) => [kk, a.presisi_k[k].precision[i]] as [number, number]), dot: a.presisi_k[k].k.map((kk, i) => [kk, a.presisi_k[k].precision[i]] as [number, number]) }))}
            x0={50} x1={5000} xTicks={[50, 1000, 2000, 3000, 4000, 5000]} xFmt={(x) => id(Math.round(x))} xLabel="k (klaim teratas)" penanda={[{ x: a.fraud, label: "jumlah fraud" }]} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
        <ChartCard title="Sebaran peluang fraud · v2" insight="Klaim fraud baru kini kebanyakan jatuh di atas ambang 50%; klaim normal tetap menumpuk di dekat 0%.">
          <Distribusi d={a.distribusi} />
        </ChartCard>
        <ChartCard title="Data latih v2" insight="Klaim Jan–Agu 2024 dengan planted fraud pada klaim asli (bukan salinan), besaran acak; peserta uji tidak ikut.">
          <div className="grid gap-3 sm:grid-cols-2">
            {([["Klaim aliran sintetis", dl.sim, SERIES[0], "doc"], ["Plant bersih + normal salinan", dl.aug, SERIES[4], "sparkle"],
              ["Klaim baru Jan–Agu (fraud realistis)", dl.v2, "#199e70", "layers"], ["Fraud total dalam data latih", dl.fraud, SERIES[1], "alert"]] as [string, number, string, IconName][]).map(([l, n, w, ik]) => (
              <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: `${w}26`, color: w }}><Icon name={ik} className="h-4 w-4" /></span>
                <div><p className="text-[16px] font-semibold tabular-nums text-white">{id(n)}</p><p className="text-[10.5px] text-[#8f99a8]">{l}</p></div>
              </div>))}
          </div>
          <div className="mt-4 space-y-2">
            <p className="text-[11.5px] text-[#abb3bf]">Validasi: peserta yang disisihkan dari data latih baru (dipakai untuk memilih desain, sebelum uji 100 ribu)</p>
            <Geser label="Recall" a={a.validasi.sekarang.recall} b={a.validasi.v2.recall} />
            <Geser label="Precision" a={a.validasi.sekarang.precision} b={a.validasi.v2.precision} />
          </div>
        </ChartCard>
      </div>

      {a.cek_luar_latih && <CekLuar c={a.cek_luar_latih} />}
      <p className="text-[10.5px] text-[#8f99a8]">Laporan dibuat {a.dibuat} oleh testing/laporan_v2.py · model di testing/model_v2 · uji = klaim Sep–Nov 2024 yang sama dengan uji 100 ribu sistem v1.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the overfitting check of v3
// The user, 2026-11-12: "kasih report bahwa ini engga overfitting di ML studio". The same model, step by step from the claims it
// was trained on to claims it never saw; the evidence and its one limit (fraud types never trained on).

type Tahap = { nama: string; ket: string; n: number; fraud?: number; recall: number; precision: number; fpr: number; auprc: number };
type Overfit = { tahap: Tahap[]; lipatan: { lipatan: number; n: number; auprc: number; recall: number }[];
  batch_b: { recall: number; precision: number; fpr: number }[]; selisih_auprc: number; rentang_auprc_tak_dilihat: [number, number]; tak_dikenal_rata: number | null };

/** The metrics from the training claims (seen) to the fresh test B (never seen), on a 70–100% scale. */
function TanggaOverfit({ o }: { o: Overfit }) {
  const { box: ref, tip, at, clear } = useTip();
  const W = useLebar(ref), H = 240, L = 44, R = 118, T = 16, B = 46, lo = 0.7;
  const xs = (i: number) => L + (i + 0.5) * ((W - L - R) / o.tahap.length);
  const py = (v: number) => T + (H - T - B) * (1 - Math.max(0, Math.min(1, (v - lo) / (1 - lo))));
  const seri: [keyof Tahap, string, string][] = [["auprc", "AUPRC", SERIES[0]], ["recall", "Recall", "#199e70"], ["precision", "Precision", SERIES[3]]];
  const lebarKolom = (W - L - R) / o.tahap.length;
  // end labels: at their line's last value, pushed apart so they never overlap
  const akhir = o.tahap[o.tahap.length - 1];
  const yLabel: Record<string, number> = {};
  [...seri].sort((p, q) => py(akhir[p[0]] as number) - py(akhir[q[0]] as number)).forEach(([k], i, arr) => {
    const y0 = py(akhir[k] as number) + 3;
    const prev = i ? yLabel[arr[i - 1][0] as string] : -Infinity;
    yLabel[k as string] = Math.max(y0, prev + 13);
  });
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Metrik dari data latih sampai uji B">
        <rect x={L} y={T} width={lebarKolom} height={H - T - B} fill="rgba(229,72,77,.07)" />
        <rect x={L + lebarKolom} y={T} width={W - L - R - lebarKolom} height={H - T - B} fill="rgba(25,158,112,.06)" />
        <text x={L + 6} y={H - B - 6} fontSize="10" fill="#ff8e93">dilihat saat latih</text>
        <text x={L + lebarKolom + 6} y={H - B - 6} fontSize="10" fill="#7ee2c0">tidak pernah dilihat model</text>
        {[0.7, 0.8, 0.9, 1].map((t) => <g key={t}><line x1={L} x2={W - R} y1={py(t)} y2={py(t)} stroke={t === 0.7 ? "#383f47" : GRID} />
          <text x={L - 6} y={py(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{pct(t, 0)}</text></g>)}
        {o.tahap.map((t, i) => <g key={t.nama}>
          <text x={xs(i)} y={H - B + 15} textAnchor="middle" fontSize="10.5" fill="#e5e8eb">{t.nama}</text>
          <text x={xs(i)} y={H - B + 28} textAnchor="middle" fontSize="9.5" fill={AXIS}>{id(t.n)} klaim</text>
          <rect x={xs(i) - lebarKolom / 2} y={T} width={lebarKolom} height={H - T - B} fill="transparent"
            onPointerMove={(e) => at(e, { title: `${t.nama} · ${t.ket}`, lines: [...seri.map(([k, l, w]) => ({ key: w, value: pct(t[k] as number, 1), label: l })),
              ...(t.fraud ? [{ key: "#8f99a8", value: pct(t.fraud, 1), label: "tingkat fraud" }] : []), { key: "#8f99a8", value: pct(t.fpr, 2), label: "normal ditandai" }] })} />
        </g>)}
        {seri.map(([k, l, w]) => (
          <g key={k} pointerEvents="none">
            <path d={o.tahap.map((t, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${py(t[k] as number).toFixed(1)}`).join(" ")} fill="none" stroke={w} strokeWidth={k === "auprc" ? 2.6 : 1.8} strokeLinejoin="round" />
            {o.tahap.map((t, i) => <circle key={i} cx={xs(i)} cy={py(t[k] as number)} r={k === "auprc" ? 4 : 3.2} fill={w} stroke={SURFACE} strokeWidth={1.6} />)}
            <text x={W - R + 8} y={yLabel[k as string]} fontSize="10.5" fill="#e5e8eb">{l} {pct(akhir[k] as number, 1)}</text>
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">{seri.map(([, l, w]) => <span key={l} className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={w} strokeWidth={2.4} /></svg>{l}</span>)}<span className="text-[#8f99a8]">sumbu 70–100%</span></div>
      <Tooltip tip={tip} />
    </div>
  );
}

function CekOverfitV3({ o }: { o: Overfit }) {
  const [a0, a1] = o.rentang_auprc_tak_dilihat;
  const rb = o.batch_b.map((x) => x.recall);
  const rMin = Math.min(...rb), rMax = Math.max(...rb);
  const sk = (v: number, lo: number) => `${Math.max(0, Math.min(1, (v - lo) / (1 - lo))) * 100}%`;
  return (
    <ChartCard title="Cek overfitting · v3" insight="Model yang sama dinilai dari data yang ia lihat saat latih sampai klaim yang belum pernah dipakai. Overfitting terlihat bila angka jatuh begitu keluar dari data latih; di sini tidak.">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-md bg-[#199e70]/15 px-2.5 py-1.5 text-[12.5px] font-semibold text-[#7ee2c0]"><Icon name="check" className="h-4 w-4" />Tidak overfitting</span>
        {[`AUPRC latih ${n3(o.tahap[0].auprc)} → tak dilihat ${n3(a0)}–${n3(a1)}`, `Selisih ${n3(o.selisih_auprc)}: wajar untuk boosting`,
          `Recall 20 batch uji B: ${pct(rMin, 1)}–${pct(rMax, 1)}`,
          ...(() => { const ua = o.tahap.find((x) => x.nama === "Uji A"), ub = o.tahap.find((x) => x.nama === "Uji B");
            return ua?.fraud && ub?.fraud ? [`Precision uji A lebih rendah karena fraud lebih jarang (${pct(ua.fraud, 1)} vs ${pct(ub.fraud, 1)}); klaim normal ditandai sama, ${pct(ua.fpr, 2)}`] : []; })()].map((t) => (
          <span key={t} className="rounded-full border border-white/[.08] px-2.5 py-1 text-[11px] tabular-nums text-[#c5cbd3]">{t}</span>))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <TanggaOverfit o={o} />
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[11.5px] text-[#abb3bf]">AUPRC per lipatan out-of-fold (5 lipatan, sumbu 90–100%)</p>
            <div className="space-y-1.5">{o.lipatan.map((l) => (
              <div key={l.lipatan} className="grid items-center gap-3" style={{ gridTemplateColumns: "70px 1fr 50px" }}>
                <span className="text-[11.5px] text-[#c5cbd3]">Lipatan {l.lipatan}</span>
                <div className="relative h-3 rounded-full" style={{ background: GRID }}><div className="absolute inset-y-0 left-0 rounded-full" style={{ width: sk(l.auprc, 0.9), background: SERIES[0] }} /></div>
                <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{n3(l.auprc)}</span>
              </div>))}</div>
          </div>
          <div>
            <p className="mb-1.5 text-[11.5px] text-[#abb3bf]">Recall tiap batch uji B (20 batch, sumbu 85–100%)</p>
            <div className="relative h-8 rounded-md" style={{ background: GRID }}>
              <div className="absolute inset-y-2 rounded" style={{ left: sk(rMin, 0.85), width: `calc(${sk(rMax, 0.85)} - ${sk(rMin, 0.85)})`, background: "rgba(25,158,112,.25)" }} />
              {rb.map((v, i) => <span key={i} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#1c2127]" title={`batch ${i + 1}: ${pct(v, 1)}`}
                style={{ left: sk(v, 0.85), background: "#199e70" }} />)}
            </div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[#8f99a8]"><span>85%</span><span>90%</span><span>95%</span><span>100%</span></div>
          </div>
          {o.tak_dikenal_rata !== null && (
            <div className="flex gap-2.5 rounded-md border border-[#c98500]/40 bg-[#c98500]/10 p-2.5">
              <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-[#c98500]" />
              <div><p className="text-[12px] font-semibold text-white">Batasnya: jenis fraud yang belum dikenal</p>
                <p className="text-[11px] leading-snug text-[#c5cbd3]">Angka di atas berlaku untuk 12 jenis fraud yang ada di data latih. Kelompok modus yang tidak pernah dilatih tertangkap rata-rata {pct(o.tak_dikenal_rata, 0)}. Itu bukan overfitting pada data latih, tetapi batas belajar dari contoh.</p></div>
            </div>
          )}
        </div>
      </div>
    </ChartCard>
  );
}

// ------------------------------------------------------------------------------------------------ architecture v3
// The user, 2026-11-12: "ok then create v3 architecture" (after "do you think model2 still needed?"), and "also tell which ML
// technique used here, like random forest or graph or what?". Read from arsitektur_v3 in /api/ml-sistem (testing/laporan_v3.py):
// v1, v2 and v3 compared once on the fresh test B; test A only as a consistency check.

type V3 = {
  dibuat: string; dilatih: string; klaim: number; fraud: number; normal: number;
  ringkas: Record<"v1" | "v2" | "v3", RV>; uji_a: { v3: RV; v2: RV; klaim: number };
  temuan: { ikon: string; judul: string; isi: string; nada: "baik" | "buruk" | "netral" }[];
  skema: { skema: string; label: string; modus: { kode: string; nama: string }[]; famili: string | null; n: number; baru: boolean;
    recall_v1: number; recall_v2: number; recall_v3: number; lapisan: Record<string, number> }[];
  lapisan: string[]; lapisan_nama: Record<string, string>; lapisan_normal: Record<string, number>; mutu_lapisan: Record<string, number>;
  bobot_fusi: Record<string, number>; ambang_peluang: number;
  dibuang: { nama: string; ikon: string; isi: string }[];
  rute: { sinyal: string[]; min_contoh: number; maks_normal: number; tambah_fraud: number; tambah_normal: number };
  rule_jaringan: { hari: number; ambang: number; laju_normal_latih: number; tambah_fraud: number; tambah_normal: number; cincin_baru: number };
  famili: { kunci: string; nama: string; modus: string[]; sinyal: number }[];
  data_latih: { sim: number; aug: number; v2: number; klaim: number; fraud: number };
  validasi: Record<"v3" | "v1", { precision: number; recall: number; fpr: number; auprc: number }>;
  tak_dikenal: { famili: string; nama: string; modus: string[]; n: number; recall_v3: number; recall_v2?: number; recall_v1?: number; recall_v3_dikenal: number;
    per_skema: { skema: string; label: string; recall_v3: number; recall_v2: number | null; recall_v1: number | null }[] }[];
  cm: { tp: number; fp: number; fn: number; tn: number };
  presisi_k: Record<"v1" | "v2" | "v3", { k: number[]; precision: number[]; recall: number[] }>;
  prevalensi: { tingkat: number[]; uji: number; anggaran_k: number; keputusan: Record<"v1" | "v2" | "v3", number[]>; anggaran: Record<"v1" | "v2" | "v3", number[]> };
  distribusi: { batas: number[]; normal: number[]; fraud: number[] };
  cek_luar_latih?: Uji["cek_luar_latih"];
  sumber_uji: string[]; dipakai: { layanan: string; sejak: string; sebelumnya: string };
  bench?: V2["bench"];
  overfit?: Overfit;
};

const VERSI: Record<"v1" | "v2" | "v3", { nama: string; warna: string }> = {
  v1: { nama: "v1", warna: ABU }, v2: { nama: "v2", warna: "#8abbff" }, v3: { nama: "v3", warna: "#199e70" },
};

/** One measure for v1, v2 and v3 on one scale. */
function TigaVersi({ label, r, k, maks = 1, lebihBaik = "tinggi" }: { label: string; r: V3["ringkas"]; k: "recall" | "precision" | "auprc" | "fpr"; maks?: number; lebihBaik?: "tinggi" | "rendah" }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, v / maks)) * 100}%`;
  const d = maks < 0.1 ? 2 : 1;
  const terbaik = (["v1", "v2", "v3"] as const).reduce((b, v) => ((lebihBaik === "tinggi" ? r[v][k] > r[b][k] : r[v][k] < r[b][k]) ? v : b), "v3" as "v1" | "v2" | "v3");
  return (
    <div className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(80px, 120px) 1fr 170px" }}>
      <span className="text-[12px] text-white">{label}</span>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ background: GRID }} />
        {(["v1", "v2", "v3"] as const).map((v) => (
          <span key={v} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" title={`${VERSI[v].nama} ${pct(r[v][k], d)}`}
            style={{ left: x(r[v][k]), width: v === "v3" ? 16 : 12, height: v === "v3" ? 16 : 12, background: VERSI[v].warna, borderColor: SURFACE, zIndex: v === "v3" ? 2 : 1 }} />
        ))}
      </div>
      <span className="text-right text-[11.5px] tabular-nums">
        {(["v1", "v2", "v3"] as const).map((v, i) => <span key={v}>{i ? <span className="text-[#5f6b7a]"> · </span> : null}
          <span style={{ color: VERSI[v].warna, fontWeight: v === terbaik ? 700 : 400 }}>{pct(r[v][k], d)}</span></span>)}
      </span>
    </div>
  );
}

// The user, 2026-11-12: "saya pengen ini clickable buat lihat detail ... rule, logika, algoritma ... masing2 node, yang jelas
// bisa dipahami orang awam": every box opens AlurV3Detail (a drawer, one node at a time, previous/next along the flow).
function AlurV3({ a, v2, g2 }: { a: V3; v2?: V2; g2?: G2 }) {
  const [buka, setBuka] = useState<NodeV3 | null>(null);
  const k = g2?.penyebab?.skew;
  const skew: SkewV3 | undefined = g2 && k && { tanggal: g2.dibuat.slice(0, 10), ujiB: k.uji_b.dijalankan.recall, ujiBTanpa: k.uji_b.tanpa_skew.recall,
    gen2Klaim: g2.klaim, gen2Recall: k.gen2.dijalankan.recall, gen2Fpr: k.gen2.dijalankan.fpr, split: k.split, gainPct: k.gain_pct };
  const m = a.mutu_lapisan;
  const bobot = (k: string) => `bobot fusi ${pct(a.bobot_fusi[k] ?? 0, (a.bobot_fusi[k] ?? 0) < 0.1 ? 1 : 0)}`;
  const panah = <div className="hidden items-center justify-center text-[#8f99a8] lg:flex"><Icon name="right" className="h-4 w-4" /></div>;
  const ruteV2: RuteV2 | undefined = v2?.tak_dikenal.map((t) => ({ famili: t.famili, dengan: t.recall_v2, tanpa: t.recall_v2_tanpa_rute }));
  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,.8fr)_18px_minmax(0,.9fr)_18px_minmax(0,2.2fr)_18px_minmax(0,1fr)_18px_minmax(0,.9fr)] lg:items-center">
      <KotakAlur ikon="doc" warna={ABU} nama="Klaim + entity resolution" detail="Pasien dicocokkan lewat no RM, nama, dan SEP; klaim masuk ke engine realtime." onClick={() => setBuka("klaim")} />{panah}
      <KotakAlur ikon="bolt" warna="#c98500" nama="Engine realtime" detail="45 sinyal rule, tiap sinyal terhubung ke modus Permenkes 16/2019; 124 fitur sistem per klaim." badge="124 fitur · 45 sinyal" onClick={() => setBuka("engine")} />{panah}
      <div className="grid gap-2">
        <div className="grid gap-2 sm:grid-cols-2">
          {a.famili.map((f) => <KotakAlur key={f.kunci} ikon={IKON_LAPISAN[f.kunci] ?? "layers"} warna={SPESIALIS} nama={a.lapisan_nama[f.kunci] ?? f.nama}
            detail={`${f.nama}: ${f.sinyal} sinyal rule (monoton) + klaim + tetangga graph; dilatih pada keluarganya saja.`} badge={`AUPRC ${n3(m[f.kunci])}`} chips={f.modus} sub={bobot(f.kunci)}
            onClick={() => setBuka(f.kunci as NodeV3)} />)}
        </div>
        <KotakAlur ikon="graph" warna={SERIES[1]} nama="Model 1 · graph + tetangga" detail="Klaim + rata-rata tetangga di 4 relasi graph (peserta, RS, RS+kode, kode), termasuk semua sinyal rule."
          badge={`AUPRC ${n3(m.model1)}`} sub={bobot("model1")} onClick={() => setBuka("model1")} />
      </div>{panah}
      <div className="grid gap-2">
        <KotakAlur ikon="layers" warna={SERIES[0]} nama="Monotone fusion + calibration" detail="Menggabungkan 5 lapisan; tiap lapisan hanya bisa menaikkan risiko; lalu kalibrasi peluang." badge={`AUPRC ${n3(m.fusi)}`}
          onClick={() => setBuka("fusi")} />
        <KotakAlur ikon="logic" warna="#c98500" nama="Rule route" detail={`Sinyal rule spesifik (≤ ${pct(a.rute.maks_normal, 1)} klaim normal) yang belum punya ${a.rute.min_contoh} contoh berlabel → perlu diperiksa.`}
          badge={`${a.rute.sinyal.length} sinyal FKRTL`} onClick={() => setBuka("rute")} />
        <KotakAlur ikon="constellation" warna={SERIES[2]} nama="Network rule" detail={`≥ ${a.rule_jaringan.ambang} peserta lain berbagi RS dalam ±${a.rule_jaringan.hari} hari; ambang dari klaim normal latih saja.`}
          badge={`${pct(a.rule_jaringan.laju_normal_latih, 2)} klaim normal latih`} chips={["M10"]} onClick={() => setBuka("jaringan")} />
      </div>{panah}
      <KotakAlur ikon="sparkle" warna="#199e70" nama="Keputusan + penjelasan AI" detail="Terdeteksi → AI menjelaskan jenis fraud (Permenkes), alasan, graph, dan perbaikan; lolos → &quot;Klaim aman&quot;."
        badge={`≥ ${pct(a.ambang_peluang, 0)} atau rule`} onClick={() => setBuka("keputusan")} />
      {buka && <AlurV3Detail a={a} node={buka} onClose={() => setBuka(null)} onPilih={setBuka} ruteV2={ruteV2} skew={skew} />}
    </div>
  );
}

/** Which layer sees each fraud type in v3: the median probability of the models, and how often each rule fires. */
function PetaLapisanV3({ a }: { a: V3 }) {
  const { box: ref, tip, at, clear } = useTip();
  const urutFam = ["koding", "tagihan", "episode", "identitas", "jaringan"];
  const rows = [...a.skema].sort((x, y) => urutFam.indexOf(x.famili ?? "") - urutFam.indexOf(y.famili ?? "") || y.recall_v3 - x.recall_v3);
  const isi = (v: number) => `rgba(57,135,229,${(0.05 + 0.95 * v).toFixed(3)})`;
  const ikon: Record<string, IconName> = { ...IKON_LAPISAN, rute: "logic", jaringan_rule: "constellation" };
  const sel = (judul: string, k: string, v: number, garis: boolean) => (
    <span key={k} onPointerMove={(e) => at(e, { title: judul, lines: [{ key: SERIES[0], value: pct(v, 0), label: (k === "rute" || k === "jaringan_rule" ? "klaim yang memicu · " : "median peluang · ") + a.lapisan_nama[k] }] })}
      className="flex h-7 items-center justify-center rounded-[3px] text-[10.5px] tabular-nums"
      style={{ background: isi(v), color: v > 0.5 ? "#fff" : "#c5cbd3", boxShadow: garis ? "inset 0 0 0 1.5px #e5e8eb" : undefined }}>{pct(v, 0)}</span>
  );
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <div className="overflow-x-auto">
        <div className="grid min-w-[600px] gap-[3px]" style={{ gridTemplateColumns: `minmax(190px,1.8fr) repeat(${a.lapisan.length}, minmax(52px,1fr))` }}>
          <span />
          {a.lapisan.map((k) => <span key={k} className="flex flex-col items-center gap-0.5 pb-1 text-center text-[10px] leading-tight text-[#abb3bf]">
            <Icon name={ikon[k] ?? "layers"} className="h-3.5 w-3.5" />{a.lapisan_nama[k]}</span>)}
          {rows.map((s) => (
            <Fragment key={s.skema}>
              <span className="flex min-w-0 items-center gap-1.5 pr-2"><span className={`truncate text-[11.5px] ${s.baru ? "text-[#7ee2c0]" : "text-white"}`} title={s.label}>{s.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-[#8f99a8]">{pct(s.recall_v3, 0)}</span></span>
              {a.lapisan.map((k) => sel(s.label, k, s.lapisan[k] ?? 0, s.famili === k || (s.famili === "jaringan" && k === "jaringan_rule")))}
            </Fragment>
          ))}
          <span className="flex items-center pr-2 text-[11.5px] italic text-[#abb3bf]">Klaim normal</span>
          {a.lapisan.map((k) => sel("Klaim normal", k, a.lapisan_normal[k] ?? 0, false))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-[#c5cbd3]">
        <span className="flex items-center gap-1.5">0%<span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${isi(0)}, ${isi(1)})` }} />100%</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px]" style={{ boxShadow: "inset 0 0 0 1.5px #e5e8eb" }} />lapisan keluarga skema itu</span>
        <span className="text-[#8f99a8]">model: median peluang · rule: bagian klaim yang memicu · hijau = bentuk baru</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function ArsitekturV3({ a, v2, g2 }: { a: V3; v2?: V2; g2?: G2 }) {
  const [titik, setTitik] = useState<"keputusan" | "anggaran">("keputusan");
  const r = a.ringkas, v = r.v3;
  const urut = [...a.skema].sort((x, y) => x.recall_v3 - y.recall_v3);
  const fmtP = (p: number) => `${id(p * 100, p < 0.1 ? 1 : 0)}%`;
  const seri = (sumber: Record<"v1" | "v2" | "v3", number[]>, xs: number[]): Seri[] => (["v3", "v2", "v1"] as const).map((k) => ({
    nama: `Arsitektur ${VERSI[k].nama}`, warna: VERSI[k].warna, tebal: k === "v3", putus: k === "v1",
    titik: xs.map((p, i) => [p, sumber[k][i]] as [number, number]), dot: xs.map((p, i) => [p, sumber[k][i]] as [number, number]) }));
  const i01 = a.prevalensi.tingkat.indexOf(0.001), i1 = a.prevalensi.tingkat.indexOf(0.01);
  const legenda = (ks: ("v1" | "v2" | "v3")[]) => (
    <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">{ks.map((k) => <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: VERSI[k].warna }} />arsitektur {VERSI[k].nama}</span>)}</div>
  );
  const b = a.bench;
  return (
    <section className="space-y-4">
      {/* verdict */}
      <div className={`${box} overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[.06] p-4" style={{ background: "rgba(25,158,112,.10)" }}>
          <span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: "rgba(25,158,112,.2)", color: "#7ee2c0" }}><Icon name="sparkle" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Arsitektur v3 · dilatih {a.dilatih} · uji B: {id(a.klaim)} klaim yang belum pernah dipakai</p>
            <h2 className="text-[16px] font-semibold text-white">{pct(v.recall, 0)} fraud tertangkap di uji baru (v2 {pct(r.v2.recall, 0)}, v1 {pct(r.v1.recall, 0)}), dengan 3 komponen lebih sedikit</h2>
          </div>
          <span className="flex items-center gap-1 rounded bg-[#199e70]/20 px-2 py-1 text-[11px] text-[#7ee2c0]" title={`sebelumnya: ${a.dipakai.sebelumnya}`}>
            <Icon name="check" className="h-3.5 w-3.5" />Dipakai {a.dipakai.layanan}</span>
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-white/[.06] px-4 py-2.5">
          {a.sumber_uji.map((t, i) => <span key={t} className="flex items-center gap-1.5 rounded-full border border-white/[.08] px-2.5 py-1 text-[11px] text-[#c5cbd3]">
            <Icon name={(["database", "lock", "alert", "check"] as IconName[])[i] ?? "info"} className="h-3.5 w-3.5 text-[#8f99a8]" />{t}</span>)}
        </div>
        {g2?.penyebab?.skew && (
          <div className="flex items-start gap-2 border-b border-white/[.06] bg-[#e5484d]/[.07] px-4 py-2.5 text-[11.5px] leading-snug text-[#ffc9c7]">
            <Icon name="bug" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Catatan {g2.dibuat.slice(0, 10)}: angka uji B ini ikut terdongkrak bug fitur. Model 1 membedakan sumber baris dari pembulatan angka, dan uji B tidak punya klaim normal kunjungan pertama.
              Tanpa selisih pembulatan, recall uji B {pct(g2.penyebab.skew.uji_b.tanpa_skew.recall, 0)}. Di generator 2, v3 menangkap {pct(g2.ringkas.model_v3.recall, 0)} fraud dan menandai {pct(g2.ringkas.model_v3.fpr, 0)} klaim normal: lihat bagian Generator 2 di bawah.</span>
          </div>
        )}
        <div className="grid gap-6 p-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-3">
            <div className="flex gap-4 text-[11px] text-[#c5cbd3]">{(["v1", "v2", "v3"] as const).map((k) => <span key={k} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: VERSI[k].warna }} />{VERSI[k].nama}</span>)}<span className="text-[#8f99a8]">tebal = terbaik</span></div>
            <TigaVersi label="Recall" r={r} k="recall" />
            <TigaVersi label="Precision" r={r} k="precision" />
            <TigaVersi label="AUPRC" r={r} k="auprc" />
            <TigaVersi label="Normal ditandai" r={r} k="fpr" maks={0.01} lebihBaik="rendah" />
          </div>
          <div>
            <p className="mb-2 text-[11.5px] text-[#abb3bf]">Cek konsistensi: v3 pada uji A (100 ribu, sudah dipakai memilih versi) dan uji B (baru)</p>
            <div className="space-y-2">
              {([["Recall", "recall", 1], ["Precision", "precision", 1], ["Normal ditandai", "fpr", 0.01]] as const).map(([l, k, mx]) => (
                <div key={k} className="grid items-center gap-3" style={{ gridTemplateColumns: "110px 1fr 120px" }}>
                  <span className="text-[12px] text-white">{l}</span>
                  <div className="relative h-6"><div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ background: GRID }} />
                    {([["A", a.uji_a.v3[k], "#5f6b7a"], ["B", v[k], "#199e70"]] as const).map(([nm, val, w]) => <span key={nm} title={`uji ${nm} ${pct(val, mx < 0.1 ? 2 : 1)}`}
                      className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${Math.min(1, val / mx) * 100}%`, background: w, borderColor: SURFACE }} />)}</div>
                  <span className="text-right text-[11.5px] tabular-nums text-[#c5cbd3]">A {pct(a.uji_a.v3[k], mx < 0.1 ? 2 : 1)} · <b className="text-[#7ee2c0]">B {pct(v[k], mx < 0.1 ? 2 : 1)}</b></span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {a.dibuang.map((x) => (
                <div key={x.nama} className="rounded-md border border-white/[.07] p-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[#ff8e93]"><Icon name={x.ikon as IconName} className="h-3.5 w-3.5" /><span className="line-through">{x.nama}</span></div>
                  <p className="mt-1 text-[10.5px] leading-snug text-[#abb3bf]">{x.isi}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {a.temuan.map((t) => (
          <div key={t.judul} className={`${box} flex gap-3 p-3`}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${NADA[t.nada]}26`, color: NADA[t.nada] }}><Icon name={t.ikon as IconName} className="h-4 w-4" /></span>
            <div className="min-w-0"><p className="text-[12.5px] font-semibold text-white">{t.judul}</p><p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{t.isi}</p></div>
          </div>
        ))}
      </div>

      {b && (b.uji15 || b.e2e) && (
        <div className={`${box} p-3`}>
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-white"><Icon name="play" className="h-4 w-4 text-[#8abbff]" />Uji di /testing dengan arsitektur v3
            <span className="font-normal text-[#8f99a8]">· browser, klaim contoh sintetis{b.uji15 ? ` · ${b.uji15.dijalankan}` : ""}</span></p>
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {([
              b.uji15 && ["Klaim sesuai harapan", b.uji15.cocok, b.uji15.total, "check"], b.uji15 && ["Fraud terdeteksi", b.uji15.fraud, b.uji15.n_fraud, "alert"],
              b.uji15 && ["Klaim normal lolos", b.uji15.normal, b.uji15.n_normal, "lock"], b.uji15 && ["Modus Permenkes sesuai", b.uji15.modus, b.uji15.n_fraud, "doc"],
              b.e2e && ["Cek end-to-end lulus", b.e2e.lulus, b.e2e.lulus + b.e2e.gagal, "layers"],
            ].filter(Boolean) as [string, number, number, IconName][]).map(([l, n, t, ik]) => {
              const w = n === t ? "#199e70" : "#e5484d";
              return (
                <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${w}26`, color: w }}><Icon name={ik} className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1"><p className="text-[16px] font-semibold tabular-nums text-white">{id(n)}<span className="text-[12px] font-normal text-[#8f99a8]">/{id(t)}</span></p>
                    <div className="mt-1 h-1 rounded-full" style={{ background: GRID }}><div className="h-1 rounded-full" style={{ width: `${(n / Math.max(1, t)) * 100}%`, background: w }} /></div>
                    <p className="mt-1 truncate text-[10.5px] text-[#8f99a8]">{l}</p></div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {a.overfit && <CekOverfitV3 o={a.overfit} />}

      <ChartCard title="Alur sistem · arsitektur v3" insight="Model 1 dan empat spesialis Permenkes memberi peluang; dua rule menangkap yang belum pernah dilihat model. Label kecil di tiap kotak = teknik yang dipakai. Klik kotak mana pun untuk melihat rule, logika dan algoritmanya."
        source={<span>AUPRC out-of-fold (spesialis: pada keluarganya sendiri vs klaim normal) · bobot fusi = bagian gain stacker</span>}>
        <AlurV3 a={a} v2={v2} g2={g2} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.15fr]">
        <ChartCard title="Fraud tertangkap per jenis · uji B" insight="Diurutkan dari yang paling sering lolos di v3; hijau = bentuk cincin yang tidak ada di data latih.">
          {legenda(["v3", "v2", "v1"])}
          <div className="space-y-2.5">{urut.map((x) => (
            <div key={x.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)" }}>
              <div className="min-w-0">
                <p className={`truncate text-[12px] ${x.baru ? "text-[#7ee2c0]" : "text-white"}`} title={x.label}>{x.label}</p>
                <div className="flex flex-wrap gap-1">{x.modus.map((m) => <span key={m.kode} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]" title={m.nama}>{m.kode} {m.nama.split(" (")[0]}</span>)}
                  <span className="text-[10px] text-[#8f99a8]">n = {id(x.n)}</span></div>
              </div>
              <div className="space-y-1"><Batang nilai={x.recall_v3} warna={x.recall_v3 < 0.7 ? "#e5484d" : VERSI.v3.warna} /><Batang nilai={x.recall_v2} warna={VERSI.v2.warna} /><Batang nilai={x.recall_v1} warna={VERSI.v1.warna} /></div>
            </div>))}</div>
        </ChartCard>
        <ChartCard title="Lapisan mana yang melihat tiap jenis fraud · v3" insight="Spesialis menyala untuk keluarganya sendiri; Model 1 melihat hampir semua; rule menangkap pola yang modelnya belum punya contoh.">
          <PetaLapisanV3 a={a} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Jenis fraud yang belum pernah dilihat · uji B" insight="Satu kelompok modus dikeluarkan dari seluruh data latih, lalu fraud keluarga itu di uji B diuji.">
          <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-[#c5cbd3]">
            {([["v3, keluarga ini ikut dilatih", "#5f6b7a"], ["v3, tidak pernah dilatih", VERSI.v3.warna], ["v2, tidak pernah dilatih", VERSI.v2.warna], ["v1, tidak pernah dilatih", VERSI.v1.warna]] as const).map(([n, w]) =>
              <span key={n} className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: w }} />{n}</span>)}
          </div>
          {a.tak_dikenal.length ? <div className="space-y-3">{a.tak_dikenal.map((t) => (
            <div key={t.famili} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)" }}>
              <div className="min-w-0"><p className="truncate text-[12px] text-white">{t.nama}</p>
                <div className="flex flex-wrap gap-1">{t.modus.map((m) => <span key={m} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]">{m}</span>)}<span className="text-[10px] text-[#8f99a8]">n = {id(t.n)}</span></div></div>
              <div className="space-y-1"><Batang nilai={t.recall_v3_dikenal} warna="#5f6b7a" /><Batang nilai={t.recall_v3} warna={VERSI.v3.warna} />
                <Batang nilai={t.recall_v2 ?? null} warna={VERSI.v2.warna} /><Batang nilai={t.recall_v1 ?? null} warna={VERSI.v1.warna} /></div>
              {t.per_skema.length > 1 && (
                <div className="col-span-2 mt-1.5 flex flex-wrap gap-1.5">{t.per_skema.map((x) => {
                  const w = x.recall_v3 < 0.2 ? "#e5484d" : x.recall_v3 < 0.7 ? "#c98500" : "#199e70";
                  return <span key={x.skema} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px]" style={{ borderColor: `${w}66`, background: `${w}14` }}
                    title={`v3 ${pct(x.recall_v3, 1)} · v2 ${pct(x.recall_v2, 1)} · v1 ${pct(x.recall_v1, 1)}`}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: w }} /><span className="text-[#d3d8de]">{x.label}</span><b className="tabular-nums text-white">{pct(x.recall_v3, x.recall_v3 < 0.1 ? 1 : 0)}</b></span>;
                })}</div>
              )}
            </div>))}</div> : <p className="text-[11.5px] text-[#8f99a8]">Belum dihitung.</p>}
        </ChartCard>
        <ChartCard title="Confusion matrix · v3 · uji B" insight={`${id(a.cm.tp)} dari ${id(a.fraud)} fraud tertangkap; ${id(a.cm.fp)} dari ${id(a.normal)} klaim normal ikut ditandai (v2 ${id(r.v2.fp)}, v1 ${id(r.v1.fp)}).`}>
          <Matriks cm={a.cm} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Seratus isi={v.precision} warna="#199e70" label="klaim yang ditandai memang fraud" />
            <Seratus isi={v.recall} warna={SERIES[0]} label="klaim fraud tertangkap" />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {([["Rule route", a.rute.tambah_fraud, a.rute.tambah_normal, "logic"], ["Network rule", a.rule_jaringan.tambah_fraud, a.rule_jaringan.tambah_normal, "constellation"]] as [string, number, number, IconName][]).map(([l, f, n, ik]) => (
              <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#c98500]/15 text-[#c98500]"><Icon name={ik} className="h-4 w-4" /></span>
                <div><p className="text-[14px] font-semibold tabular-nums text-white">+{id(f)} fraud · +{id(n)} normal</p><p className="text-[10.5px] text-[#8f99a8]">{l}: yang hanya ditandai rule ini</p></div>
              </div>))}
          </div>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Precision di berbagai tingkat fraud · uji B" insight={`Saat fraud langka: v3 ${pct(a.prevalensi[titik].v3[i01])} pada 0,1% dan ${pct(a.prevalensi[titik].v3[i1])} pada 1% (v1 ${pct(a.prevalensi[titik].v1[i01])} dan ${pct(a.prevalensi[titik].v1[i1])}).`}
          source={<><span>Garis tegak = tingkat fraud uji B</span><div className="ml-auto flex rounded border border-white/10 p-0.5">
            {(["keputusan", "anggaran"] as const).map((k) => <button key={k} onClick={() => setTitik(k)} className={`rounded-sm px-2 py-0.5 ${titik === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
              {k === "anggaran" ? `Anggaran 2% (${id(a.prevalensi.anggaran_k)} klaim)` : "Aturan keputusan"}</button>)}</div></>}>
          <Garis seri={seri(a.prevalensi[titik], a.prevalensi.tingkat)} xLog x0={0.001} x1={0.2} xTicks={[0.001, 0.005, 0.01, a.prevalensi.uji, 0.1, 0.2]} xFmt={fmtP}
            penanda={[{ x: a.prevalensi.uji, label: "uji B" }]} xLabel="tingkat fraud (skala log)" />
        </ChartCard>
        <ChartCard title="Precision@k · uji B" insight={`Bila hanya k klaim teratas yang diperiksa: v3 ${pct(a.presisi_k.v3.precision[a.presisi_k.v3.k.indexOf(1000)])} fraud pada k = 1.000.`}>
          <Garis seri={(["v3", "v2", "v1"] as const).map((k) => ({ nama: `Arsitektur ${VERSI[k].nama}`, warna: VERSI[k].warna, tebal: k === "v3", putus: k === "v1",
            titik: a.presisi_k[k].k.map((kk, i) => [kk, a.presisi_k[k].precision[i]] as [number, number]), dot: a.presisi_k[k].k.map((kk, i) => [kk, a.presisi_k[k].precision[i]] as [number, number]) }))}
            x0={25} x1={a.presisi_k.v3.k[a.presisi_k.v3.k.length - 1]} xTicks={[25, 1000, 2000, 3000]} xFmt={(x) => id(Math.round(x))} xLabel="k (klaim teratas)" penanda={[{ x: a.fraud, label: "jumlah fraud" }]} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.1fr]">
        <ChartCard title="Sebaran peluang fraud · v3 · uji B" insight="Klaim normal menumpuk di dekat 0%, klaim fraud di dekat 100%.">
          <Distribusi d={a.distribusi} />
        </ChartCard>
        <ChartCard title="Data latih v3" insight="Sama dengan v2: klaim aliran, plant bersih, dan klaim baru Jan–Agu 2024 dengan planted fraud pada klaim asli.">
          <div className="grid gap-3 sm:grid-cols-2">
            {([["Klaim aliran sintetis", a.data_latih.sim, SERIES[0], "doc"], ["Plant bersih + normal salinan", a.data_latih.aug, SERIES[4], "sparkle"],
              ["Klaim baru Jan–Agu (fraud realistis)", a.data_latih.v2, "#199e70", "layers"], ["Fraud total dalam data latih", a.data_latih.fraud, SERIES[1], "alert"]] as [string, number, string, IconName][]).map(([l, n, w, ik]) => (
              <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: `${w}26`, color: w }}><Icon name={ik} className="h-4 w-4" /></span>
                <div><p className="text-[16px] font-semibold tabular-nums text-white">{id(n)}</p><p className="text-[10.5px] text-[#8f99a8]">{l}</p></div>
              </div>))}
          </div>
          <div className="mt-4 space-y-2">
            <p className="text-[11.5px] text-[#abb3bf]">Validasi (peserta yang disisihkan; dipakai memilih desain v3): v1 → v3</p>
            <Geser label="Recall" a={a.validasi.v1.recall} b={a.validasi.v3.recall} />
            <Geser label="Precision" a={a.validasi.v1.precision} b={a.validasi.v3.precision} />
          </div>
        </ChartCard>
      </div>

      {a.cek_luar_latih && <CekLuar c={a.cek_luar_latih} />}
      <p className="text-[10.5px] text-[#8f99a8]">Laporan dibuat {a.dibuat} oleh testing/laporan_v3.py · model di testing/model_v3 · uji B = testing/uji100k.py (UJI100K_SET=B).</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the page

export function MlSistem() {
  const [d, setD] = useState<Doc | null>(null);
  const [err, setErr] = useState("");
  const [titik, setTitik] = useState<"anggaran" | "keputusan">("anggaran");
  useEffect(() => {
    fetch("/api/ml-sistem", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setD(j as Doc); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const prev = useMemo(() => {
    if (!d) return null;
    const t = d.prevalensi.titik[titik];
    const halus = Array.from({ length: 60 }, (_, i) => 10 ** (-3 + (i / 59) * Math.log10(200)));
    const seri: Seri[] = t.metode.map((m) => ({
      nama: `${m.nama} · ${id(m.ditandai)} ditandai`, warna: WARNA_METODE(m), putus: m.gaya === "garis", tebal: m.gaya === "utama",
      titik: halus.map((p) => [p, (m.tpr * p) / Math.max(1e-12, m.tpr * p + m.fpr * (1 - p))] as [number, number]),
      dot: d.prevalensi.tingkat.map((p, i) => [p, m.precision[i]] as [number, number]),
    }));
    return { t, seri };
  }, [d, titik]);

  if (err) return <p className="p-4 text-[12px] text-red-300">{err}</p>;
  if (!d || !prev) return <p className="p-4 text-[12px] text-[#8f99a8]">Memuat sistem ML…</p>;
  const m = d.metrik, dl = d.sistem.data_latih;
  const pk0 = d.presisi_k_tabel.gabungan;
  const at = (k: number) => pk0.precision[pk0.k.indexOf(k)] ?? null;
  const utama = prev.t.metode.find((x) => x.gaya === "utama");
  const p01 = utama ? utama.precision[d.prevalensi.tingkat.indexOf(0.001)] : null;
  const precisionDitandai = d.cm.tp / Math.max(1, d.cm.tp + d.cm.fp);
  const fmtP = (v: number) => (v < 0.01 ? `${id(v * 100, 1)}%` : `${id(v * 100, v < 0.1 ? 1 : 0)}%`);

  return (
    <div className="space-y-4 p-4 text-[12px]">
      {/* ML v7 on top (the user, 2026-11-13: "show v7 on top of ML Studio") */}
      {d.arsitektur_graf?.ml_v7 && (
        <>
          <div id="ml-v7" className="flex scroll-mt-4 items-center gap-3"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="layers" className="h-4 w-4 text-[#199e70]" />ML v7 · perbaikan distribution shift (generator 1-4)</p><span className="h-px flex-1 bg-white/10" /></div>
          <BenchmarkMlV7 b={d.arsitektur_graf.ml_v7} />
        </>
      )}
      {/* v5 first (the user, 2026-11-13: "tambah report di bagian atas buat V5 di ML studio") */}
      {(d.arsitektur_graf?.ml_v5 || d.arsitektur_graf?.v5) && <RingkasanV5 b={d.arsitektur_graf?.ml_v5} v={d.arsitektur_graf?.v5} />}
      {(d.arsitektur_graf?.ml_v5 || d.arsitektur_graf?.v5) && <ArsitekturV5Visual b={d.arsitektur_graf?.ml_v5} v={d.arsitektur_graf?.v5} />}
      {d.arsitektur_graf?.ml_v5 && (
        <>
          <div id="ml-v5" className="flex scroll-mt-4 items-center gap-3 pt-2"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="cpu" className="h-4 w-4 text-[#7ee2c0]" />ML v5 · benchmark generator 1, 2, 3 vs v3 &amp; v4</p><span className="h-px flex-1 bg-white/10" /></div>
          <PresisiTingkatFraudV5 b={d.arsitektur_graf.ml_v5} />
          <BenchmarkMlV5 b={d.arsitektur_graf.ml_v5} />
        </>
      )}
      {d.arsitektur_graf?.ml_v6 && (
        <>
          <div id="ml-v6" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="graph" className="h-4 w-4 text-[#d55181]" />ML v6 · fitur jaringan ala Quantexa (tanpa biaya LLM)</p><span className="h-px flex-1 bg-white/10" /></div>
          <BenchmarkMlV6 b={d.arsitektur_graf.ml_v6} />
        </>
      )}
      {d.arsitektur_graf?.shift && (
        <>
          <div id="diagnosa-shift" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="search" className="h-4 w-4 text-[#199e70]" />Diagnosis distribution shift · generator 1, 2, 3</p><span className="h-px flex-1 bg-white/10" /></div>
          <DiagnosaShift d={d.arsitektur_graf.shift} />
        </>
      )}
      {d.arsitektur_graf?.v5 && (
        <>
          <div id="v5" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="constellation" className="h-4 w-4 text-[#7ee2c0]" />v5 · rule engine + AI Agent Swarm (Google ADK) untuk klaim ragu</p><span className="h-px flex-1 bg-white/10" /></div>
          <SistemV5 v={d.arsitektur_graf.v5} />
        </>
      )}
      {d.arsitektur_v3 && (
        <>
          <ArsitekturV3 a={d.arsitektur_v3} v2={d.arsitektur_v2} g2={d.generator2} />
          {d.generator2 && (
            <>
              <div id="generator-2" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
                <Icon name="sparkle" className="h-4 w-4 text-[#8abbff]" />Generator 2 · apakah v3 konsisten di data sintetis lain?</p><span className="h-px flex-1 bg-white/10" /></div>
              <GeneratorDua g={d.generator2} />
            </>
          )}
          {d.arsitektur_graf && (
            <>
              <div id="arsitektur-terbaru" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
                <Icon name="graph" className="h-4 w-4 text-[#9ec5ff]" />Arsitektur & sistem terbaru · LightGBM vs graph vs deep learning</p><span className="h-px flex-1 bg-white/10" /></div>
              <ArsitekturTerbaru a={d.arsitektur_graf} />
            </>
          )}
          {d.v4_final && (
            <>
              <div id="v4" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
                <Icon name="layers" className="h-4 w-4 text-[#7ee2c0]" />v4 · kandidat, dinilai sekali di generator 3, uji C2, generator 2 seed 3</p><span className="h-px flex-1 bg-white/10" /></div>
              <PerbaikanV4 v={d.v4_final} />
            </>
          )}
          {d.perbaikan_v3 && (
            <>
              <div id="perbaikan-v3" className="flex scroll-mt-4 items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
                <Icon name="restore" className="h-4 w-4 text-[#7ee2c0]" />Perbaikan v3 · kandidat, belum dipakai /testing</p><span className="h-px flex-1 bg-white/10" /></div>
              <PerbaikanV3 p={d.perbaikan_v3} />
            </>
          )}
          <div className="flex items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="restore" className="h-4 w-4 text-[#8f99a8]" />Arsitektur v2 · sebelumnya</p><span className="h-px flex-1 bg-white/10" /></div>
        </>
      )}
      {d.arsitektur_v2 && (
        <>
          <ArsitekturV2 a={d.arsitektur_v2} />
          <div className="flex items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="restore" className="h-4 w-4 text-[#8f99a8]" />Arsitektur v1 · sebelumnya</p><span className="h-px flex-1 bg-white/10" /></div>
        </>
      )}
      {/* header */}
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3987e5]/20 text-[#8abbff]"><Icon name="cpu" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{d.arsitektur_v2 ? "Arsitektur v1 (sebelum v2)" : "Sistem ML yang dipakai sekarang"} · dilatih {d.dilatih}</p>
          <h2 className="text-[16px] font-semibold text-white">{d.sistem.nama}</h2>
          <p className="text-[11.5px] text-[#abb3bf]">{d.sistem.keputusan}. Dievaluasi out-of-fold pada {id(dl.aliran_simulator)} klaim aliran sintetis ({id(dl.fraud_aliran)} fraud, {pct(m.basis)}).</p>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      {/* KPI */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Kpi ikon="gauge" label="AUPRC" nilai={n3(m.auprc)} isi={m.auprc} warna={SERIES[0]} ket={`AUROC ${n3(m.auroc)}`} />
        <Kpi ikon="check" label="Precision" nilai={pct(m.precision)} isi={m.precision} warna={SERIES[0]} ket="yang ditandai, benar fraud" />
        <Kpi ikon="search" label="Recall" nilai={pct(m.recall)} isi={m.recall} warna={SERIES[2]} ket="fraud yang tertangkap" />
        <Kpi ikon="alert" label="False positive" nilai={pct(m.fpr_normal, 2)} isi={m.fpr_normal * 20} warna={SERIES[3]} ket="klaim normal yang ikut ditandai" />
        <Kpi ikon="star" label="Precision@500" nilai={pct(at(500))} isi={at(500) ?? 0} warna={SERIES[0]} ket={`@1.000: ${pct(at(1000))}`} />
        <Kpi ikon="sliders" label="Precision · fraud 0,1%" nilai={pct(p01)} isi={p01 ?? 0} warna={SERIES[4]} ket={titik === "anggaran" ? "anggaran review 2% teratas" : "aturan keputusan"} />
        <Kpi ikon="sparkle" label="Plant bersih tertangkap" nilai={pct(m.recall_plant_bersih)} isi={m.recall_plant_bersih ?? 0} warna={SERIES[2]} ket={`holdout ${id(dl.holdout_plant_bersih - dl.holdout_normal_salinan)} skema fraud`} />
        <Kpi ikon="restore" label="Normal salinan ditandai" nilai={pct(m.fpr_normal_salinan)} isi={m.fpr_normal_salinan ?? 0} warna={SERIES[3]} ket={`holdout ${id(dl.holdout_normal_salinan)} klaim wajar`} />
      </div>

      {/* the system */}
      <ChartCard title="Alur sistem" insight="Dari klaim masuk sampai keputusan: dua model membaca klaim dari dua sisi, lalu digabung dan dikalibrasi menjadi satu peluang."
        source={<span>Arahkan kursor ke kotak untuk detail · angka AUPRC out-of-fold</span>}>
        <Alur d={d} />
      </ChartCard>

      {/* precision by fraud rate */}
      <ChartCard title="Precision di berbagai tingkat fraud"
        insight={`Model 1 + 2 tetap di atas cara lain pada tingkat fraud rendah: ${pct(p01)} precision saat fraud hanya 0,1% (${prev.t.label.toLowerCase()}).`}
        source={<><span>Precision = TPR·π / (TPR·π + FPR·(1−π)) pada titik kerja tiap metode · titik = tingkat yang dihitung · garis tegak = tingkat fraud aliran sintetis</span>
          <div className="ml-auto flex rounded border border-white/10 p-0.5">
            {(["anggaran", "keputusan"] as const).map((k) => <button key={k} onClick={() => setTitik(k)} className={`rounded-sm px-2 py-0.5 ${titik === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{d.prevalensi.titik[k].label}</button>)}
          </div></>}
        table={<Tabel kepala={["Metode", "Ditandai", "Recall", ...d.prevalensi.tingkat.map((p) => fmtP(p))]}
          baris={prev.t.metode.map((x) => [x.nama, id(x.ditandai), pct(x.tpr), ...x.precision.map((v) => pct(v))])} />}>
        <Garis seri={prev.seri} xLog x0={0.001} x1={0.2} xTicks={[0.001, 0.005, 0.01, d.prevalensi.aliran, 0.05, 0.1, 0.2]} xFmt={fmtP}
          penanda={[{ x: d.prevalensi.aliran, label: "aliran sintetis" }]} xLabel="tingkat fraud (skala log)" h={290} />
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Precision@k" insight={`Klaim dengan skor tertinggi hampir semuanya fraud: ${pct(at(500), 0)} sampai k = 500, ${pct(at(1000))} pada k = 1.000.`}
          source={<span>k = jumlah klaim teratas yang diperiksa · garis tegak = jumlah yang ditandai aturan keputusan ({id(d.cm.tp + d.cm.fp)})</span>}
          table={<Tabel kepala={["k", "Gabungan", "Recall", "Model 1", "Model 2"]} baris={pk0.k.map((k, i) => [id(k), pct(pk0.precision[i]), pct(pk0.recall[i]),
            pct(d.presisi_k_tabel.model1.precision[i]), pct(d.presisi_k_tabel.model2.precision[i])])} />}>
          <Garis seri={(["gabungan", "model1", "model2"] as const).map((key) => ({ nama: MODEL[key].nama, warna: MODEL[key].warna, tebal: key === "gabungan",
            titik: d.presisi_k[key].k.map((k, i) => [k, d.presisi_k[key].precision[i]] as [number, number]) }))}
            x0={10} x1={3000} xTicks={[10, 500, 1000, 1500, 2000, 2500, 3000]} xFmt={(v) => id(Math.round(v))} xLabel="k (klaim teratas)"
            penanda={[{ x: d.cm.tp + d.cm.fp, label: "ditandai" }]} />
        </ChartCard>
        <ChartCard title="Kurva precision–recall" insight={`Gabungan (AUPRC ${n3(m.auprc)}) di atas Model 1 (${n3(m.auprc_model1)}) dan Model 2 (${n3(m.auprc_model2)}); garis putus = tebakan acak.`}
          table={<Tabel kepala={["Model", "AUPRC"]} baris={[[MODEL.gabungan.nama, n3(m.auprc)], [MODEL.model1.nama, n3(m.auprc_model1)], [MODEL.model2.nama, n3(m.auprc_model2)], ["Acak", n3(d.pr.basis)]]} />}>
          <Garis seri={(["gabungan", "model1", "model2"] as const).map((key) => ({ nama: MODEL[key].nama, warna: MODEL[key].warna, tebal: key === "gabungan", titik: d.pr[key] }))}
            x0={0} x1={1} xTicks={[0, 0.25, 0.5, 0.75, 1]} xFmt={(v) => pct(v, 0)} xLabel="recall" garisY={{ y: d.pr.basis, label: `acak ${pct(d.pr.basis)}` }} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Confusion matrix" insight={`Dari ${id(d.cm.tp + d.cm.fn)} fraud, ${id(d.cm.tp)} tertangkap; ${id(d.cm.fp)} dari ${id(d.cm.fp + d.cm.tn)} klaim normal ikut diperiksa.`}
          source={<span>Aturan keputusan pada aliran sintetis, out-of-fold</span>}>
          <div className="grid items-center gap-5 md:grid-cols-[1.3fr_1fr]">
            <Matriks cm={d.cm} />
            <div className="space-y-4">
              <Seratus isi={precisionDitandai} warna="#199e70" label="klaim yang ditandai memang fraud" />
              <Seratus isi={m.recall} warna={SERIES[0]} label="klaim fraud tertangkap" />
            </div>
          </div>
        </ChartCard>
        <ChartCard title="Sebaran peluang fraud" insight="Klaim normal menumpuk di dekat 0%, klaim fraud di dekat 100%: dua kelompok terpisah jelas oleh ambang 50%."
          table={<Tabel kepala={["Peluang", "Normal", "Fraud"]} baris={d.distribusi.normal.map((v, i) => [`${pct(d.distribusi.batas[i], 0)}–${pct(d.distribusi.batas[i + 1], 0)}`, id(v), id(d.distribusi.fraud[i])])} />}>
          <Distribusi d={d.distribusi} />
        </ChartCard>
      </div>

      {/* per scheme */}
      <ChartCard title="Recall per jenis fraud (Permenkes 16/2019)"
        insight="Hampir semua skema tertangkap; garis biru = out-of-fold pada aliran, garis hijau = plant bersih yang tidak pernah dilatih."
        table={<Tabel kepala={["Skema", "Modus", "n", "Recall OOF", "Recall plant bersih"]} baris={d.skema.map((s) => [s.label, s.modus.map((x) => x.kode).join(", "), id(s.n_oof), pct(s.recall_oof), pct(s.recall_bersih)])} />}>
        <div className="mb-3 flex gap-4 text-[11px] text-[#c5cbd3]"><span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: SERIES[0] }} />out-of-fold pada aliran (plant simulator)</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full" style={{ background: SERIES[2] }} />plant bersih, tidak pernah dilatih (holdout)</span></div>
        <div className="grid gap-x-6 gap-y-2.5 lg:grid-cols-2">
          {d.skema.map((s) => (
            <div key={s.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)" }}>
              <div className="min-w-0">
                <p className="truncate text-[12px] text-white" title={s.label}>{s.label}</p>
                <div className="flex flex-wrap gap-1">{s.modus.map((x) => <span key={x.kode} className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]" title={x.nama}>{x.kode} {x.nama.split(" (")[0]}</span>)}
                  <span className="text-[10px] text-[#8f99a8]">n = {id(s.n_oof)}</span></div>
              </div>
              <div className="space-y-1"><Batang nilai={s.recall_oof} warna={SERIES[0]} />{s.recall_bersih !== null && <Batang nilai={s.recall_bersih} warna={SERIES[2]} />}</div>
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* variants */}
        <ChartCard title="Kenapa sistem dilatih ulang: tiga varian" insight="Di aliran sintetis ketiganya mirip; bedanya muncul pada plant bersih dan klaim normal buatan formulir, tempat sistem lama tertipu sidik jari simulator."
          table={<Tabel kepala={["Varian", "AUPRC OOF", "Precision", "Recall", "Plant bersih", "Normal salinan ditandai"]}
            baris={d.varian.map((v) => [VARIAN[v.kunci] ?? v.kunci, n3(v.oof_auprc), pct(v.oof_ditandai_precision), pct(v.oof_ditandai_recall), pct(v.holdout_bersih_recall), pct(v.holdout_normal_bersih_fpr)])} />}>
          <div className="space-y-4">
            {([["Plant bersih tertangkap (lebih tinggi lebih baik)", "holdout_bersih_recall", 1], ["Normal salinan ikut ditandai (lebih rendah lebih baik)", "holdout_normal_bersih_fpr", 0.1],
              ["Recall pada aliran sintetis", "oof_ditandai_recall", 1]] as const).map(([judul, key, maks]) => (
              <div key={key}>
                <p className="mb-1.5 text-[11.5px] text-[#abb3bf]">{judul}</p>
                <div className="space-y-1.5">{d.varian.map((v) => (
                  <div key={v.kunci} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 210px) 1fr" }}>
                    <span className={`truncate text-[11.5px] ${v.kunci === "model" ? "font-semibold text-white" : "text-[#c5cbd3]"}`}>{VARIAN[v.kunci] ?? v.kunci}</span>
                    <Batang nilai={(v[key] as number | null) ?? null} maks={maks} warna={v.kunci === "model" ? SERIES[0] : v.kunci === "model_tanpa_aug" ? SERIES[3] : "#8f99a8"} label={pct(v[key] as number | null)} />
                  </div>))}</div>
              </div>
            ))}
          </div>
        </ChartCard>
        {/* overfitting */}
        <ChartCard title="Cek overfitting" insight={`Skor latih lebih tinggi dari out-of-fold (wajar untuk boosting), tetapi stabil di 5 blok waktu: AUPRC ${n3(Math.min(...d.overfit.per_blok.map((b) => b.auprc ?? 1)))}–${n3(Math.max(...d.overfit.per_blok.map((b) => b.auprc ?? 0)))}.`}
          table={<Tabel kepala={["Blok waktu", "Klaim", "Fraud", "AUPRC", "Precision", "Recall"]} baris={d.overfit.per_blok.map((b) => [`Blok ${b.blok}`, id(b.klaim), id(b.fraud), n3(b.auprc), pct(b.precision), pct(b.recall)])} />}>
          <p className="mb-2 text-[11.5px] text-[#abb3bf]">AUPRC latih (in-sample) dan out-of-fold</p>
          <div className="space-y-3">
            {d.overfit.train_vs_oof.map((r) => {
              const lo = 0.6, x = (v: number) => `${Math.max(0, Math.min(1, (v - lo) / (1 - lo))) * 100}%`;
              return (
                <div key={r.model} className="grid items-center gap-3" style={{ gridTemplateColumns: "100px 1fr 120px" }}>
                  <span className="text-[12px] text-white">{r.model}</span>
                  <div className="relative h-4">
                    <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: GRID }} />
                    <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded" style={{ left: x(r.oof), width: `calc(${x(r.train)} - ${x(r.oof)})`, background: "#5f6b7a" }} />
                    <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(r.oof), background: SERIES[0], borderColor: SURFACE }} title={`out-of-fold ${n3(r.oof)}`} />
                    <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(r.train), background: "#e5e8eb", borderColor: SURFACE }} title={`latih ${n3(r.train)}`} />
                  </div>
                  <span className="text-right text-[11px] tabular-nums text-[#c5cbd3]">{n3(r.oof)} · latih {n3(r.train)}</span>
                </div>
              );
            })}
            <div className="flex gap-4 text-[11px] text-[#c5cbd3]"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES[0] }} />out-of-fold</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#e5e8eb]" />latih</span><span className="text-[#8f99a8]">sumbu 0,6–1,0</span></div>
          </div>
          <p className="mb-1 mt-4 text-[11.5px] text-[#abb3bf]">Per blok waktu (klaim diurutkan menurut waktu masuk)</p>
          <Garis seri={[{ nama: "AUPRC", warna: SERIES[0], tebal: true, titik: d.overfit.per_blok.map((b) => [b.blok, b.auprc ?? 0] as [number, number]), dot: d.overfit.per_blok.map((b) => [b.blok, b.auprc ?? 0] as [number, number]) },
            { nama: "Precision", warna: SERIES[3], titik: d.overfit.per_blok.map((b) => [b.blok, b.precision] as [number, number]), dot: d.overfit.per_blok.map((b) => [b.blok, b.precision] as [number, number]) },
            { nama: "Recall", warna: SERIES[2], titik: d.overfit.per_blok.map((b) => [b.blok, b.recall] as [number, number]), dot: d.overfit.per_blok.map((b) => [b.blok, b.recall] as [number, number]) }]}
            x0={1} x1={5} xTicks={[1, 2, 3, 4, 5]} xFmt={(v) => `blok ${Math.round(v)}`} xLabel="blok waktu" h={200} />
        </ChartCard>
      </div>

      {/* features */}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <ChartCard title="Yang paling dipakai Model 1" insight="Temuan pemeriksaan otomatis dan perbandingan dengan klaim tetangga di graph paling menentukan skor."
          table={<Tabel kepala={["Fitur", "Bagian gain"]} baris={d.fitur_model1.map((f) => [f.fitur, `${id(f.gain_pct, 1)}%`])} />}>
          <div className="space-y-1.5">{d.fitur_model1.slice(0, 12).map((f) => (
            <div key={f.fitur} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)" }}>
              <span className="truncate text-[11.5px] text-[#d3d8de]" title={f.fitur}>{f.fitur}</span>
              <Batang nilai={f.gain_pct} maks={d.fitur_model1[0].gain_pct} warna={SERIES[1]} label={`${id(f.gain_pct, 1)}%`} />
            </div>))}</div>
        </ChartCard>
        <ChartCard title="Yang paling dipakai Model 2" insight="Berapa banyak peserta lain yang berbagi RS dalam beberapa hari: inti deteksi jaringan RS (rujukan semu)."
          table={<Tabel kepala={["Fitur", "Bagian gain"]} baris={d.fitur_model2.map((f) => [f.fitur, `${id(f.gain_pct, 1)}%`])} />}>
          <div className="space-y-1.5">{d.fitur_model2.map((f) => (
            <div key={f.fitur} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)" }}>
              <span className="truncate text-[11.5px] text-[#d3d8de]" title={f.fitur}>{f.fitur}</span>
              <Batang nilai={f.gain_pct} maks={d.fitur_model2[0].gain_pct} warna={SERIES[2]} label={`${id(f.gain_pct, 1)}%`} />
            </div>))}</div>
        </ChartCard>
      </div>

      {/* training data */}
      <ChartCard title="Data latih" insight="Aliran sintetis ditambah plant bersih dan klaim normal salinan, supaya model belajar skema fraud, bukan sidik jari simulator.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {([["Klaim normal aliran", dl.aliran_simulator - dl.fraud_aliran, SERIES[0], "doc"], ["Fraud aliran (simulator)", dl.fraud_aliran, SERIES[1], "alert"],
            ["Plant fraud bersih", dl.plant_bersih - dl.normal_salinan, SERIES[4], "sparkle"], ["Klaim normal salinan", dl.normal_salinan, "#8f99a8", "copy"],
            ["Holdout (tidak dilatih)", dl.holdout_plant_bersih, SERIES[2], "lock"]] as [string, number, string, IconName][]).map(([l, v, w, ik]) => (
            <div key={l} className="flex items-center gap-2.5 rounded-md border border-white/[.07] p-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: `${w}26`, color: w }}><Icon name={ik} className="h-4 w-4" /></span>
              <div><p className="text-[16px] font-semibold tabular-nums text-white">{id(v)}</p><p className="text-[10.5px] text-[#8f99a8]">{l}</p></div>
            </div>
          ))}
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-4 text-[11px] text-[#abb3bf]">{d.catatan.map((c) => <li key={c}>{c}</li>)}</ul>
      </ChartCard>
      {d.uji_100k && (
        <>
          <div className="flex items-center gap-3 pt-4"><span className="h-px flex-1 bg-white/10" /><p className="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <Icon name="search" className="h-4 w-4 text-[#8abbff]" />Uji 100 ribu klaim di luar data latih</p><span className="h-px flex-1 bg-white/10" /></div>
          <Uji100k u={d.uji_100k} d={d} />
        </>
      )}
      <p className="text-[10.5px] text-[#8f99a8]">Laporan dibuat {d.dibuat} oleh testing/laporan_ml.py dari model di testing/model.</p>
    </div>
  );
}
