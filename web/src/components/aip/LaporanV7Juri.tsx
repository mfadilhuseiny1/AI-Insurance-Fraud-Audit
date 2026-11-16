"use client";

// ML Studio · "Laporan v7 · metrik juri" (the user, 2026-11-15: "bikin report v7 sesuai metrik2 permintaan juri ini di ML Studio,
// report baru di paling atas: F1 score, FP TP FN TN, confusion matrix, metrik2 ml"; then "kasih paragraf penjelas buat grafik2
// hasil metrik v7 buat orang awam · eksekutif yang ga terlalu ngerti teknikal · keep english term kalau ga cocok diterjemahin").
// The Healthkathon 2026 coaching deck (2026-10-23) sets the jury metrics: precision@k at a stated capacity + lift, rupiah
// recall@k, share of honest hospitals audited, conditions one dial at a time, a held-out fraud type, hard negatives, the fraud
// rate next to every precision, intervals by resampling hospitals, rules vs model, what each step does not show.
// Data: testing/ml_v7_metrik_juri.py -> /api/ml-v7-juri (aggregates only; frozen models, thresholds unchanged). Synthetic data.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AXIS, GRID, SERIES, SURFACE, Tooltip, compact, useTip } from "./viz";

// ------------------------------------------------------------------------------------------------ data shape
export type CI = [number | null, number | null];
export type CM = { tp: number; fp: number; fn: number; tn: number; ditandai: number; presisi: number; recall: number; spesifisitas: number; fpr: number; fnr: number;
  npv: number; akurasi: number; akurasi_seimbang: number; f1: number; f2: number; f05: number; mcc: number; kappa: number; ci: Record<string, CI> };
type Auc = { roc_auc: number; pr_auc: number; brier: number | null; ci: Partial<Record<"roc_auc" | "pr_auc", CI>>; catatan?: string };
type AtK = { k: number; presisi: number; recall: number; lift: number; rupiah_recall?: number; rupiah_temuan?: number; rs_jujur_diaudit?: number;
  rs_jujur_diaudit_n?: number; ci?: Record<string, CI> };
type Skema = { skema: string; famili: string; n: number; rs: number; kehalusan: string | null; pelaku: string | null; recall_ml_v7: number; ci: CI;
  recall_k_ml_v7: number; recall_ml_v5: number; recall_aturan: number; recall_gabungan: number };
type HN = { kunci: string; jenis: string; keterangan: string; n: number; rs: number; fpr_ml_v7: number; ci: CI; rasio: number | null; top_k: number;
  fpr_aturan: number; fpr_ml_v5: number };
type Aud = { diaudit: number; porsi: number; ci: CI };
type GrupRow = { grup: string; rs_jujur: number; klaim_jujur: number; fpr_klaim: number; probabilitas: Aud; rupiah?: Aud };
type Kond = { kunci: string; kondisi: string; klaim: number; fraud: number; prevalensi: number; rs_fraud: number; presisi_k: number; ci: CI; recall_k: number;
  ci_recall: CI; lift: number; recall_operasi: number };
type Beda = { selisih: number; ci: CI; p: number; aturan: number; gabungan?: number; ml_v7?: number };
type SetJ = {
  label: string; klaim: number; fraud: number; prevalensi: number; rs: number; rs_jujur: number; rs_dengan_fraud: number; hari: number; rupiah_ada: boolean;
  rupiah_fraud: number | null; k: number; skema_n: number; rs_juga_di_latih: number;
  cm: Record<string, CM>; auc: Record<string, Auc>; kurva: Record<string, { roc: [number, number][]; pr: [number, number][] }>;
  pada_k: Record<string, Record<string, AtK>>; prevalensi_sweep: { prevalensi: number; presisi: number; ci: CI }[];
  objektif?: { probabilitas: AtK; rupiah: AtK; catatan: string };
  ci_klaster: { presisi_k: number; ci_klaim: CI; ci_rs: CI; rasio_lebar: number | null; deff: number | null; k: number; n_efektif: number | null; rs_uji: number; rs_di_top_k: number };
  skema: Skema[]; hard_negatif: { fpr_semua_jujur: number; fpr_aturan_semua: number; jenis: HN[] };
  keadilan: { semua: Record<string, { diaudit: number; porsi: number }> } & Record<string, { baris: GrupRow[]; paling_banyak: string | null }>;
  kondisi: Kond[]; aturan_vs_model: { f1: Beda; recall: Beda; presisi_k: Beda; recall_k: Beda; uji: string };
};
type Laporan = { dibuat: string; benchmark_dibuat: string; pilihan: string; adopsi: { lolos: boolean; ci_recall_g4: CI; selisih_prec2_g4: number };
  kapasitas: { porsi: number; asumsi: string }; bootstrap: number; integritas: string[]; set: Record<string, SetJ> };

// ------------------------------------------------------------------------------------------------ formatting & vocabulary
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
export const fmt = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
export const ok = (v?: number | null): v is number => v !== undefined && v !== null && Number.isFinite(v);
export const pct = (v?: number | null, d = 1) => (ok(v) ? `${fmt(v * 100, d)}%` : "—");
export const dec = (v?: number | null, d = 3) => (ok(v) ? fmt(v, d) : "—");
export const ciP = (c?: CI, d = 1) => (c && ok(c[0]) && ok(c[1]) ? `${fmt(c[0] * 100, d)}–${fmt(c[1] * 100, d)}%` : "—");
export const ciD = (c?: CI, d = 3) => (c && ok(c[0]) && ok(c[1]) ? `${fmt(c[0], d)}–${fmt(c[1], d)}` : "—");
export const pv = (p?: number | null) => (!ok(p) ? "—" : p <= 0.001 ? "p < 0,001" : `p = ${fmt(p, 3)}`);
const kali = (v?: number | null) => (ok(v) ? `${fmt(v, 1)}×` : "—");
export const rp = (v?: number | null) => (ok(v) ? `Rp ${compact(v)}` : "—");
const per100 = (v: number) => `sekitar ${fmt(Math.round(v * 100))} dari 100`;
export const pp = (v?: number | null) => (ok(v) ? `${v > 0 ? "+" : ""}${fmt(v * 100, 1)} poin` : "—");
export const ciPP = (c?: CI) => (c && ok(c[0]) && ok(c[1]) ? `${fmt(c[0] * 100, 1)} s/d ${fmt(c[1] * 100, 1)} poin` : "—");
export const tukar = (tp: number, fp: number) => (tp === 0 ? "belum ada fraud yang tertangkap pada ambang ini"
  : fp >= tp ? `setiap 1 fraud yang tertangkap dibayar dengan sekitar ${fmt(Math.round(fp / tp))} klaim jujur yang ikut diperiksa`
  : `setiap 10 fraud yang tertangkap dibayar dengan sekitar ${fmt(Math.max(1, Math.round((10 * fp) / tp)))} klaim jujur yang ikut diperiksa`);
const nmSkema = (s: string) => s.replace(/_/g, " ");

const C = { ml_v7: SERIES[2], ml_v5: SERIES[0], aturan: SERIES[1], acak: AXIS } as const; // validated on #1c2127 (dataviz validator: all checks pass)
const SISTEM: [string, string][] = [["ml_v7", "ML v7"], ["ml_v5", "ML v5"], ["v4", "v4"], ["aturan", "Rule engine saja"], ["gabungan", "Rule engine + ML v7"]];
const NAMA = Object.fromEntries(SISTEM) as Record<string, string>;
const GEN: { k: string; nama: string; chip: string; ket: string; jenis: "baru" | "setengah" | "dikenal" }[] = [
  { k: "generator4", nama: "Generator 4", chip: "uji utama · ditulis buta", jenis: "baru",
    ket: "Ditulis oleh sesi agen terpisah yang tidak membaca model, fitur, rule engine, atau kriteria. Semua skema fraudnya belum pernah dilihat model. Ini angka paling jujur untuk pola fraud baru." },
  { k: "generator3", nama: "Generator 3", chip: "seed baru · dinilai sekali", jenis: "setengah",
    ket: "Generator yang berbeda dari data latih, dengan seed baru yang dinilai sekali. Mekaniknya sempat dipelajari saat diagnosis, jadi tidak sepenuhnya asing." },
  { k: "generator2", nama: "Generator 2", chip: "dikenal", jenis: "dikenal", ket: "Generator yang juga dipakai untuk melatih model (seed lain). Mengukur pola fraud yang sudah dikenal model." },
  { k: "generator1", nama: "Generator 1", chip: "dikenal · ruang lingkup hackathon", jenis: "dikenal",
    ket: "Data yang distribusinya mendekati data sampel BPJS; skema fraudnya dipakai saat latih. Mengukur pola fraud yang sudah dikenal model." },
];
const KEHALUSAN: Record<string, string> = { halus: "halus", sedang: "sedang", kasar: "kasar" };

// ------------------------------------------------------------------------------------------------ building blocks
export function Penjelas({ children, judul = "Artinya, dalam bahasa sehari-hari" }: { children: ReactNode; judul?: string }) {
  return (
    <div className="rounded-md border-l-2 border-[#7ee2c0]/60 bg-white/[.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#d3d8de]">
      <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#7ee2c0]"><Icon name="info" className="h-3.5 w-3.5" />{judul}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function Kartu({ judul, sub, tabel, penjelas, children, ikon }: { judul: string; sub?: ReactNode; tabel?: ReactNode; penjelas?: ReactNode; children: ReactNode; ikon?: IconName }) {
  const [v, setV] = useState<"grafik" | "tabel">("grafik");
  return (
    <section className={`${box} flex min-w-0 flex-col gap-3 p-4`}>
      <div className="flex items-start gap-2">
        {ikon && <span className="mt-0.5 text-[#7ee2c0]"><Icon name={ikon} className="h-4 w-4" /></span>}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold leading-snug text-white">{judul}</h3>
          {sub && <p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{sub}</p>}
        </div>
        {tabel && (
          <div className="flex shrink-0 rounded border border-white/10 p-0.5 text-[10.5px]" role="group" aria-label="Tampilan">
            {(["grafik", "tabel"] as const).map((x) => (
              <button key={x} type="button" onClick={() => setV(x)} className={`rounded-sm px-1.5 py-0.5 ${v === x ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{x === "grafik" ? "Grafik" : "Tabel"}</button>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0">{v === "grafik" || !tabel ? children : tabel}</div>
      {penjelas && <Penjelas>{penjelas}</Penjelas>}
    </section>
  );
}

export function Legenda({ items }: { items: { nama: string; warna: string; jenis?: "garis" | "titik" | "putus" | "kotak" | "kosong" }[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#abb3bf]">
      {items.map((it) => (
        <span key={it.nama} className="inline-flex items-center gap-1.5">
          {it.jenis === "titik" ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: it.warna, boxShadow: `0 0 0 2px ${SURFACE}` }} />
            : it.jenis === "putus" ? <span className="w-4 border-t-2 border-dashed" style={{ borderColor: it.warna }} />
            : it.jenis === "kotak" ? <span className="h-2.5 w-3 rounded-sm" style={{ background: it.warna }} />
            : it.jenis === "kosong" ? <span className="h-2.5 w-3 rounded-sm border-[1.5px]" style={{ borderColor: it.warna }} />
            : <span className="h-[2px] w-4 rounded" style={{ background: it.warna }} />}
          {it.nama}
        </span>
      ))}
    </div>
  );
}

/** teks: a table of sentences (left-aligned, wrapping) instead of numbers (right-aligned, one line). */
export function Tabel({ kepala, baris, sorot, teks = false }: { kepala: string[]; baris: ReactNode[][]; sorot?: number; teks?: boolean }) {
  const kanan = (j: number) => (j && !teks ? "text-right" : "text-left");
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-[11.5px] ${teks ? "min-w-[640px]" : "min-w-max"}`}>
        <thead><tr className="border-b border-white/10 text-left text-[#8f99a8]">{kepala.map((h, i) => <th key={i} className={`px-2 py-1.5 font-medium ${kanan(i)}`}>{h}</th>)}</tr></thead>
        <tbody>
          {baris.map((r, i) => (
            <tr key={i} className={`border-b border-white/[.04] align-top ${i === sorot ? "bg-white/[.04] text-white" : "text-[#d3d8de]"}`}>
              {r.map((c, j) => <td key={j} className={`px-2 py-1.5 ${teks ? "leading-snug" : "tabular-nums"} ${kanan(j)}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- horizontal rows (bar or dot, with 95% CI whisker, an optional marker and a reference line)
export type Baris = { key: string; label: ReactNode; sub?: string; v: number | null; ci?: CI; tanda?: number | null; v2?: number | null; teks: string;
  tip: { title: string; lines: { key?: string; value: string; label: string }[] } };
export function BarisH({ rows, max = 1, warna, rujukan, mode = "batang", tandaWarna = C.aturan }: { rows: Baris[]; max?: number; warna: string;
  rujukan?: { v: number; nama: string }; mode?: "batang" | "titik"; tandaWarna?: string }) {
  const { box: ref, tip, at, clear } = useTip();
  const x = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div ref={ref} className="relative space-y-1.5" onPointerLeave={clear}>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_4.75rem] items-center gap-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5.5rem]"
          onPointerMove={(e) => at(e, r.tip)} onFocus={(e) => at(e, r.tip)} tabIndex={0}>
          <div className="min-w-0">
            <p className="truncate text-[11.5px] text-[#d3d8de]" title={typeof r.label === "string" ? r.label : undefined}>{r.label}</p>
            {r.sub && <p className="truncate text-[10px] text-[#8f99a8]">{r.sub}</p>}
          </div>
          <div className="relative py-1">
            <div className="relative h-3 rounded-sm" style={{ background: GRID }}>
              {mode === "batang" && ok(r.v) && <div className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: x(r.v), background: warna, minWidth: r.v > 0 ? 2 : 0 }} />}
              {ok(r.v2) && <div className="absolute bottom-0 left-0 h-[5px] rounded-r-[4px] border-[1.5px]" style={{ width: x(r.v2), borderColor: warna, background: SURFACE }} />}
              {r.ci && ok(r.ci[0]) && ok(r.ci[1]) && (
                <div className="absolute top-1/2 h-[1.5px] -translate-y-1/2 bg-[#e5e8eb]/80" style={{ left: x(r.ci[0]), width: `calc(${x(r.ci[1])} - ${x(r.ci[0])})` }}>
                  <span className="absolute -left-px -top-[3px] h-[7px] w-[1.5px] bg-[#e5e8eb]/80" /><span className="absolute -right-px -top-[3px] h-[7px] w-[1.5px] bg-[#e5e8eb]/80" />
                </div>
              )}
              {mode === "titik" && ok(r.v) && <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(r.v), background: warna, boxShadow: `0 0 0 2px ${SURFACE}` }} />}
              {ok(r.tanda) && <span className="absolute -top-0.5 h-4 w-[3px] -translate-x-1/2 rounded-sm" style={{ left: x(r.tanda), background: tandaWarna, boxShadow: `0 0 0 1.5px ${SURFACE}` }} />}
              {rujukan && <span className="absolute -top-1 h-5 border-l-[1.5px] border-dashed" style={{ left: x(rujukan.v), borderColor: "#c5cbd3" }} />}
            </div>
          </div>
          <span className="text-right text-[11.5px] tabular-nums text-[#e5e8eb]">{r.teks}</span>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  );
}

/** The chart's own pixel width, so axis text stays 10px at any card width (a scaled viewBox doubles it on wide screens). */
function useLebar(min = 300) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return { ref, w };
}

// ---- line chart (ROC, PR, prevalence): 2px lines, hairline grid, crosshair + tooltip
type Seri = { key: string; nama: string; warna: string; pts: [number, number][]; putus?: boolean; band?: [number, number, number][] };
export function Garis({ seri, titik = [], log = false, xd, yd = [0, 1], xt, yt = [0, 0.25, 0.5, 0.75, 1], fx, fy, xl, yl }: {
  seri: Seri[]; titik?: { nama: string; warna: string; x: number; y: number; info: string }[]; log?: boolean; xd: [number, number]; yd?: [number, number];
  xt: number[]; yt?: number[]; fx: (v: number) => string; fy: (v: number) => string; xl: string; yl: string }) {
  const { ref: lr, w: W } = useLebar();
  const H = 260, L = 40, R = 14, T = 10, B = 26;
  const lg = (v: number) => Math.log10(Math.max(v, xd[0]));
  const sx = (v: number) => L + (log ? (lg(v) - lg(xd[0])) / (lg(xd[1]) - lg(xd[0])) : (v - xd[0]) / (xd[1] - xd[0])) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - yd[0]) / (yd[1] - yd[0])) * (H - T - B);
  const ix = (px: number) => { const t = Math.max(0, Math.min(1, (px - L) / (W - L - R))); return log ? 10 ** (lg(xd[0]) + t * (lg(xd[1]) - lg(xd[0]))) : xd[0] + t * (xd[1] - xd[0]); };
  const pakai = (pts: [number, number][]) => pts.filter(([a, b]) => ok(a) && ok(b) && (!log || a >= xd[0]) && a <= xd[1]);
  const yAt = (pts: [number, number][], v: number) => {
    const p = pakai(pts);
    if (!p.length) return NaN;
    if (v <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (v <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return x1 === x0 ? y1 : y0 + ((y1 - y0) * (v - x0)) / (x1 - x0); }
    return p[p.length - 1][1];
  };
  const { box: ref, tip, at, clear } = useTip();
  const [hx, setHx] = useState<number | null>(null);
  const jalur = (pts: [number, number][]) => pakai(pts).map(([a, b], i) => `${i ? "L" : "M"}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join("");
  return (
    <div ref={ref} className="relative">
      <div className="mb-1 flex items-end justify-between gap-2 text-[10.5px] text-[#8f99a8]"><span>↑ {yl}</span>
        {seri.length + titik.length > 1 && <Legenda items={[...seri.map((s) => ({ nama: s.nama, warna: s.warna, jenis: s.putus ? "putus" as const : "garis" as const })), ...titik.map((t) => ({ nama: t.nama, warna: t.warna, jenis: "titik" as const }))]} />}
      </div>
      <div ref={lr} className="w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block touch-none" role="img" aria-label={`${yl} terhadap ${xl}`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) * W) / r.width;
          if (px < L || px > W - R) { setHx(null); clear(); return; }
          const v = ix(px);
          setHx(v);
          at(e, { title: `${xl}: ${fx(v)}`, lines: seri.map((s) => ({ key: s.warna, value: fy(yAt(s.pts, v)), label: s.nama })) });
        }}
        onPointerLeave={() => { setHx(null); clear(); }}>
        {yt.map((v) => <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke={GRID} strokeWidth={1} /><text x={L - 6} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={AXIS}>{fy(v)}</text></g>)}
        {xt.map((v) => <text key={v} x={sx(v)} y={H - 8} textAnchor="middle" fontSize={10} fill={AXIS}>{fx(v)}</text>)}
        {seri.map((s) => s.band && (
          <path key={`b${s.key}`} d={`${s.band.map(([a, , hi], i) => `${i ? "L" : "M"}${sx(a)},${sy(hi)}`).join("")}${[...s.band].reverse().map(([a, lo]) => `L${sx(a)},${sy(lo)}`).join("")}Z`} fill={s.warna} opacity={0.16} />
        ))}
        {seri.map((s) => <path key={s.key} d={jalur(s.pts)} fill="none" stroke={s.warna} strokeWidth={2} strokeDasharray={s.putus ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />)}
        {hx !== null && <line x1={sx(hx)} x2={sx(hx)} y1={T} y2={H - B} stroke="#c5cbd3" strokeWidth={1} opacity={0.5} />}
        {hx !== null && seri.filter((s) => !s.putus).map((s) => { const v = yAt(s.pts, hx); return ok(v) ? <circle key={s.key} cx={sx(hx)} cy={sy(v)} r={4} fill={s.warna} stroke={SURFACE} strokeWidth={2} /> : null; })}
        {titik.map((t) => (
          <g key={t.nama} onPointerMove={(e) => { e.stopPropagation(); at(e, { title: t.nama, lines: [{ key: t.warna, value: t.info, label: "" }] }); }}>
            <circle cx={sx(t.x)} cy={sy(t.y)} r={12} fill="transparent" />
            <circle cx={sx(t.x)} cy={sy(t.y)} r={5} fill={t.warna} stroke={SURFACE} strokeWidth={2} />
          </g>
        ))}
      </svg>
      </div>
      <p className="mt-0.5 text-right text-[10.5px] text-[#8f99a8]">{xl} →</p>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---- grouped vertical bars (precision@k per capacity), 4px rounded data ends, 2px gaps, CI whiskers, a reference line
function BatangGrup({ grup, seri, nilai, rujukan, fy = (v) => pct(v, 0) }: { grup: { k: string; label: string }[]; seri: { k: string; nama: string; warna: string }[];
  nilai: (g: string, s: string) => { v: number; ci?: CI; info: string }; rujukan?: { v: number; nama: string }; fy?: (v: number) => string }) {
  const { ref: lr, w: W } = useLebar();
  const H = 230, L = 36, R = 8, T = 10, B = 24;
  const sy = (v: number) => T + (1 - v) * (H - T - B);
  const gw = (W - L - R) / grup.length, inner = gw * 0.66, bw = (inner - (seri.length - 1) * 2) / seri.length;
  const { box: ref, tip, at, clear } = useTip();
  const bar = (x: number, y: number, w: number, h: number) => { const r = Math.min(4, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
  return (
    <div ref={ref} className="relative" onPointerLeave={clear}>
      <div className="mb-1 flex flex-wrap items-end justify-between gap-2"><Legenda items={[...seri.map((s) => ({ nama: s.nama, warna: s.warna, jenis: "kotak" as const })), ...(rujukan ? [{ nama: rujukan.nama, warna: "#c5cbd3", jenis: "putus" as const }] : [])]} /></div>
      <div ref={lr} className="w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Precision@k per kapasitas">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke={GRID} /><text x={L - 6} y={sy(v) + 3.5} textAnchor="end" fontSize={10} fill={AXIS}>{fy(v)}</text></g>)}
        {grup.map((g, gi) => (
          <g key={g.k}>
            <text x={L + gi * gw + gw / 2} y={H - 7} textAnchor="middle" fontSize={10.5} fill="#abb3bf">{g.label}</text>
            {seri.map((s, si) => {
              const d = nilai(g.k, s.k);
              const x = L + gi * gw + (gw - inner) / 2 + si * (bw + 2), y = sy(Math.max(0, d.v)), h = sy(0) - y;
              return (
                <g key={s.k} onPointerMove={(e) => at(e, { title: `${s.nama} · k = ${g.label}`, lines: [{ key: s.warna, value: fy(d.v), label: d.info }] })}>
                  <rect x={x - 1} y={T} width={bw + 2} height={H - T - B} fill="transparent" />
                  {h > 0 && <path d={bar(x, y, bw, h)} fill={s.warna} />}
                  {d.ci && ok(d.ci[0]) && ok(d.ci[1]) && <g stroke="#e5e8eb" strokeOpacity={0.8} strokeWidth={1.5}><line x1={x + bw / 2} x2={x + bw / 2} y1={sy(d.ci[0])} y2={sy(d.ci[1])} /><line x1={x + bw / 2 - 3} x2={x + bw / 2 + 3} y1={sy(d.ci[1])} y2={sy(d.ci[1])} /><line x1={x + bw / 2 - 3} x2={x + bw / 2 + 3} y1={sy(d.ci[0])} y2={sy(d.ci[0])} /></g>}
                </g>
              );
            })}
          </g>
        ))}
        {rujukan && <line x1={L} x2={W - R} y1={sy(rujukan.v)} y2={sy(rujukan.v)} stroke="#c5cbd3" strokeWidth={1.5} strokeDasharray="5 4" />}
      </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---- the confusion matrix and the metric tiles
export function Matriks({ c, nama }: { c: CM; nama: string }) {
  const P = c.tp + c.fn, N = c.fp + c.tn;
  const sel = (n: number, en: string, id: string, ket: string, benar: boolean) => (
    <div className={`rounded-md border p-3 ${benar ? "border-[#7ee2c0]/30 bg-[#7ee2c0]/[.06]" : "border-amber-400/30 bg-amber-400/[.06]"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-white">{en}</p>
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${benar ? "bg-[#7ee2c0]/15 text-[#7ee2c0]" : "bg-amber-400/15 text-amber-200"}`}>
          <Icon name={benar ? "check" : "x"} className="h-3 w-3" />{benar ? "benar" : "keliru"}</span>
      </div>
      <p className="mt-1 text-[24px] font-semibold leading-tight tabular-nums text-white">{fmt(n)}</p>
      <p className="text-[11.5px] text-[#d3d8de]">{id}</p>
      <p className="text-[10.5px] text-[#8f99a8]">{ket}</p>
    </div>
  );
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] content-start gap-2 self-start text-[11px]">
      <span />
      <p className="text-center text-[11px] text-[#abb3bf]">{nama} <b className="text-white">menandai</b><br /><span className="text-[10px] text-[#8f99a8]">{fmt(c.tp + c.fp)} klaim</span></p>
      <p className="text-center text-[11px] text-[#abb3bf]">{nama} <b className="text-white">tidak menandai</b><br /><span className="text-[10px] text-[#8f99a8]">{fmt(c.fn + c.tn)} klaim</span></p>
      <p className="self-center text-right text-[11px] leading-tight text-[#abb3bf]">Kenyataan:<br /><b className="text-white">fraud</b><br /><span className="text-[10px] text-[#8f99a8]">{fmt(P)}</span></p>
      {sel(c.tp, "True positive (TP)", "Fraud tertangkap", `${pct(c.tp / P)} dari semua fraud`, true)}
      {sel(c.fn, "False negative (FN)", "Fraud lolos", `${pct(c.fn / P)} dari semua fraud`, false)}
      <p className="self-center text-right text-[11px] leading-tight text-[#abb3bf]">Kenyataan:<br /><b className="text-white">jujur</b><br /><span className="text-[10px] text-[#8f99a8]">{fmt(N)}</span></p>
      {sel(c.fp, "False positive (FP)", "Klaim jujur ikut ditandai", `${pct(c.fp / N, 2)} dari klaim jujur`, false)}
      {sel(c.tn, "True negative (TN)", "Klaim jujur lolos dengan benar", `${pct(c.tn / N, 2)} dari klaim jujur`, true)}
    </div>
  );
}

export function Ubin({ label, nilai, ci, ket, utama = false }: { label: string; nilai: string; ci?: string; ket: string; utama?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2.5 ${utama ? "border-[#7ee2c0]/40 bg-[#7ee2c0]/[.05]" : "border-white/[.08] bg-[#151a1f]"}`}>
      <p className="text-[11px] font-semibold text-[#abb3bf]">{label}</p>
      <p className="text-[20px] font-semibold leading-tight tabular-nums text-white">{nilai}</p>
      {ci && <p className="text-[10.5px] tabular-nums text-[#8f99a8]">95% CI {ci}</p>}
      <p className="mt-1 text-[11px] leading-snug text-[#abb3bf]">{ket}</p>
    </div>
  );
}

export const METRIK: { k: keyof CM; label: string; persen: boolean; ket: string; utama?: boolean }[] = [
  { k: "presisi", label: "Precision", persen: true, utama: true, ket: "Dari klaim yang ditandai, berapa persen yang benar fraud. Rendah = banyak klaim jujur ikut diperiksa." },
  { k: "recall", label: "Recall (sensitivity)", persen: true, utama: true, ket: "Dari semua fraud, berapa persen yang tertangkap. Rendah = banyak fraud lolos." },
  { k: "f1", label: "F1 score", persen: false, utama: true, ket: "Gabungan precision dan recall, skala 0–1. Hanya tinggi bila keduanya tinggi." },
  { k: "spesifisitas", label: "Specificity", persen: true, ket: "Dari klaim jujur, berapa persen yang dibiarkan lewat dengan benar." },
  { k: "fpr", label: "False positive rate", persen: true, ket: "Dari klaim jujur, berapa persen yang ikut ditandai. Ini beban bagi RS yang jujur." },
  { k: "akurasi", label: "Accuracy", persen: true, ket: "Persen semua keputusan yang benar. Menyesatkan bila fraud jarang (lihat catatan)." },
  { k: "akurasi_seimbang", label: "Balanced accuracy", persen: true, ket: "Rata-rata recall dan specificity; tidak terkecoh oleh fraud yang jarang." },
  { k: "mcc", label: "MCC", persen: false, ket: "Kecocokan keputusan dengan kenyataan, −1 sampai 1. 0 = setara tebakan acak, 1 = sempurna." },
];

// ------------------------------------------------------------------------------------------------ the report
export function LaporanV7Juri() {
  const [d, setD] = useState<Laporan | null>(null);
  const [err, setErr] = useState("");
  const [g, setG] = useState("generator4");
  const [sys, setSys] = useState("ml_v7");
  const [dim, setDim] = useState("kelas");
  useEffect(() => {
    fetch("/api/ml-v7-juri", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); setD(j as Laporan); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const s = d?.set[g];
  const gen = GEN.find((x) => x.k === g) ?? GEN[0];
  const kk = d ? String(d.kapasitas.porsi) : "0.01";
  const urutGen = useMemo(() => GEN.slice().reverse(), []);
  if (err) return <p className="p-4 text-[12px] text-red-300">{err}</p>;
  if (!d || !s) return <p className="p-4 text-[12px] text-[#8f99a8]">Memuat laporan ML v7…</p>;

  const v7 = s.cm.ml_v7, c = s.cm[sys] ?? v7, a7 = s.auc.ml_v7, k7 = s.pada_k.ml_v7[kk], kr = s.pada_k.aturan[kk], ka = s.pada_k.acak[kk];
  const nmSys = NAMA[sys] ?? sys;
  const g1 = d.set.generator1.cm.ml_v7, g4 = d.set.generator4.cm.ml_v7;
  const terbaikF1 = SISTEM.map(([k]) => k).filter((k) => s.cm[k]).sort((a, b) => s.cm[b].f1 - s.cm[a].f1)[0];
  const lemah = s.skema.filter((x) => x.n >= 10 && x.recall_ml_v7 < 0.05);
  const hnMax = s.hard_negatif.jenis.slice().sort((a, b) => (b.rasio ?? 0) - (a.rasio ?? 0))[0];
  const av = s.aturan_vs_model;
  const kond = (k: string) => s.kondisi.find((x) => x.kunci === k);
  const fraudK = Math.round(k7.presisi * k7.k);
  const ciK: [number, number] | null = k7.ci?.presisi && ok(k7.ci.presisi[0]) && ok(k7.ci.presisi[1]) ? [Math.round(k7.ci.presisi[0] * k7.k), Math.round(k7.ci.presisi[1] * k7.k)] : null;
  const adilDim = s.keadilan[dim] as { baris: GrupRow[]; paling_banyak: string | null } | undefined;
  const obj = s.objektif;
  const skemaUrut = s.skema.slice().sort((a, b) => a.recall_ml_v7 - b.recall_ml_v7 || b.n - a.n);
  const kartuAlm = s.skema.find((x) => x.recall_aturan - x.recall_ml_v7 >= 0.3 && x.n >= 10);
  const besar = (s.keadilan.ukuran as { baris: GrupRow[] } | undefined)?.baris.find((r) => r.grup === "Besar");

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      {/* ---------------------------------------------------------------- header */}
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: `${SERIES[2]}33` }}><Icon name="gauge" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">ML v7 · metrik juri · dibuat {d.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Seberapa baik ML v7 menemukan fraud, dan seberapa yakin kita</h2>
          <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">Confusion matrix, F1 score dan metrik ML lain, lalu metrik yang diminta juri Healthkathon: precision@k, lift, rupiah recall@k, RS jujur yang ikut diaudit, kondisi berbeda, skema baru, dan klaim jujur yang mirip fraud.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
          <span className="rounded bg-white/[.06] px-2 py-1 text-[11px] text-[#d3d8de]">model beku · ambang tidak diubah</span>
          <span className="rounded bg-white/[.06] px-2 py-1 text-[11px] text-[#d3d8de]">95% CI: ambil ulang per rumah sakit ({fmt(d.bootstrap)}×)</span>
        </div>
      </section>

      {/* ---------------------------------------------------------------- generator picker */}
      <section className={`${box} space-y-2 p-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-[#abb3bf]">Set uji:</span>
          <div className="inline-flex flex-wrap overflow-hidden rounded-md border border-white/10" role="group" aria-label="Pilih set uji">
            {GEN.map((x) => (
              <button key={x.k} type="button" onClick={() => setG(x.k)} className={`px-3 py-1.5 text-[12px] ${g === x.k ? "bg-white/10 font-semibold text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>
                {x.nama} <span className="text-[10.5px] font-normal text-[#8f99a8]">· {x.chip}</span></button>
            ))}
          </div>
        </div>
        <p className="text-[11.5px] text-[#abb3bf]">{gen.ket} {fmt(s.klaim)} klaim selama {s.hari} hari dari {fmt(s.rs)} rumah sakit; {fmt(s.fraud)} klaim fraud ({pct(s.prevalensi, 2)}) dari {s.skema_n} skema.</p>
      </section>

      {/* ---------------------------------------------------------------- executive summary */}
      <section className={`${box} grid gap-4 p-4 lg:grid-cols-[1.4fr_1fr]`}>
        <Penjelas judul="Ringkasan untuk eksekutif">
          <p>Di {gen.nama} ada {fmt(s.klaim)} klaim, {fmt(s.fraud)} di antaranya fraud yang sengaja ditanam ({pct(s.prevalensi, 1)}). ML v7 menandai {fmt(v7.ditandai)} klaim untuk diperiksa: <b className="text-white">{fmt(v7.tp)} benar fraud</b> dan {fmt(v7.fp)} ternyata klaim jujur. Jadi {per100(v7.presisi)} klaim yang ditandai memang fraud (precision {pct(v7.presisi)}), dan model menangkap {pct(v7.recall)} dari seluruh fraud (recall). <b className="text-white">F1 score {dec(v7.f1, 2)}</b> pada skala 0–1.</p>
          <p>Bila verifikator hanya sanggup memeriksa {fmt(Math.round(k7.k))} klaim (asumsi kapasitas {pct(d.kapasitas.porsi, 0)}), daftar teratas ML v7 berisi sekitar <b className="text-white">{fmt(fraudK)} fraud</b>, {kali(k7.lift)} lebih banyak daripada memilih klaim secara acak (sekitar {fmt(Math.round(ka.presisi * k7.k))} fraud).</p>
          <p>{gen.jenis === "baru" ? <>Pola fraud di sini belum pernah dilihat model, sehingga hasilnya jauh di bawah pola yang sudah dikenal (Generator 1: F1 score {dec(g1.f1, 2)}). Kami melaporkannya apa adanya: model menangkap pola yang kami rancang dengan baik, tetapi banyak pola baru masih lolos.</>
            : gen.jenis === "dikenal" ? <>Pola fraud di sini sudah dikenal model saat latih, jadi angka ini <b className="text-white">batas atas</b>, bukan gambaran klaim nyata. Untuk pola baru, lihat Generator 4 (F1 score {dec(g4.f1, 2)}).</>
            : <>Pola di sini sebagian baru bagi model; hasilnya di antara pola yang dikenal (Generator 1: F1 score {dec(g1.f1, 2)}) dan pola yang benar-benar baru (Generator 4: {dec(g4.f1, 2)}).</>}</p>
        </Penjelas>
        <div className="space-y-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">Kalimat untuk juri</p>
          <div className="rounded-md border border-white/[.08] bg-[#151a1f] p-3">
            <p className="text-[10px] uppercase tracking-wide text-[#8f99a8]">Sebelum</p>
            <p className="text-[18px] font-semibold text-[#8f99a8] line-through decoration-[#d55181]/80">ROC-AUC {dec(a7.roc_auc, 2)}</p>
          </div>
          <div className="rounded-md border border-[#7ee2c0]/30 bg-[#7ee2c0]/[.05] p-3 text-[12px] leading-relaxed text-[#e5e8eb]">
            <p className="text-[10px] uppercase tracking-wide text-[#7ee2c0]">Sesudah</p>
            <p>Dari {fmt(Math.round(k7.k))} kasus yang diaudit pada kapasitas asumsi kami, {fmt(fraudK)}{ciK ? ` (95% CI ${fmt(ciK[0])}–${fmt(ciK[1])})` : ""} adalah fraud pada benchmark sintetis {gen.jenis === "baru" ? "independen kami (generator ditulis buta)" : "kami"}, {kali(k7.lift)} dibanding pemilihan acak. Dari {fmt(s.rs_jujur)} RS jujur, {fmt(k7.rs_jujur_diaudit_n ?? 0)} ikut diaudit.</p>
            <p className="mt-1.5 text-[11px] text-[#abb3bf]">EN · Of {Math.round(k7.k)} cases audited at our assumed capacity, {fraudK}{ciK ? ` (95% CI ${ciK[0]}–${ciK[1]})` : ""} were fraudulent in our {gen.jenis === "baru" ? "independent " : ""}synthetic benchmark, {ok(k7.lift) ? k7.lift.toFixed(1) : "—"}× random targeting. Of {s.rs_jujur} honest hospitals, {k7.rs_jujur_diaudit_n ?? 0} were audited.</p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 1. confusion matrix + metrics */}
      <Kartu ikon="grid" judul="1 · Confusion matrix dan metrik ML"
        sub={<>Keputusan pada ambang operasi yang dibekukan sebelum uji. Pilih sistem untuk membandingkan. 95% CI dari pengambilan ulang rumah sakit.</>}
        penjelas={<>
          <p>Setiap klaim jatuh ke salah satu dari empat kotak. Kotak hijau adalah keputusan yang benar: fraud yang tertangkap (<b className="text-white">true positive</b>) dan klaim jujur yang dibiarkan lewat (<b className="text-white">true negative</b>). Kotak kuning adalah kekeliruan: fraud yang lolos (<b className="text-white">false negative</b>), yang berarti uang hilang, dan klaim jujur yang ikut ditandai (<b className="text-white">false positive</b>), yang berarti beban kerja verifikator dan gangguan bagi RS yang jujur.</p>
          <p>Kedua kekeliruan itu saling tarik. Menurunkan ambang membuat lebih banyak fraud tertangkap, tetapi lebih banyak klaim jujur ikut ditandai. Untuk {nmSys} pada set ini, {tukar(c.tp, c.fp)}.</p>
          <p><b className="text-white">Kenapa accuracy {pct(c.akurasi)} tidak berarti banyak:</b> hanya {pct(s.prevalensi, 1)} klaim yang fraud, jadi sistem yang menyatakan &ldquo;semua klaim jujur&rdquo; pun mendapat accuracy {pct(1 - s.prevalensi)} tanpa menangkap satu fraud pun. Karena itu laporan ini menitikberatkan precision, recall, F1 score dan precision@k.</p>
        </>}>
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Pilih sistem">
          {SISTEM.map(([k, nm]) => (
            <button key={k} type="button" onClick={() => setSys(k)} className={`rounded px-2 py-1 text-[11.5px] ${sys === k ? "bg-white/10 font-semibold text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{nm}</button>
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <Matriks c={c} nama={nmSys} />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {METRIK.map((m) => (
              <Ubin key={m.k} label={m.label} utama={m.utama} ket={m.ket} nilai={m.persen ? pct(c[m.k] as number, m.k === "fpr" || m.k === "akurasi" || m.k === "spesifisitas" ? 2 : 1) : dec(c[m.k] as number, 3)}
                ci={m.persen ? ciP(c.ci[m.k], m.k === "fpr" ? 2 : 1) : ciD(c.ci[m.k])} />
            ))}
            {s.auc[sys] && <Ubin label="ROC-AUC" nilai={dec(s.auc[sys].roc_auc)} ci={ciD(s.auc[sys].ci.roc_auc) !== "—" ? ciD(s.auc[sys].ci.roc_auc) : undefined}
              ket="Peluang klaim fraud acak diberi skor lebih tinggi daripada klaim jujur acak. 0,5 = tebakan acak." />}
            {s.auc[sys] && <Ubin label="PR-AUC" nilai={dec(s.auc[sys].pr_auc)} ci={ciD(s.auc[sys].ci.pr_auc) !== "—" ? ciD(s.auc[sys].ci.pr_auc) : undefined}
              ket={`Kualitas urutan skor saat fraud jarang. Tebakan acak ≈ ${dec(s.prevalensi, 3)} (tingkat fraud).`} />}
          </div>
        </div>
        <p className="mt-2 text-[10.5px] text-[#8f99a8]">Metrik lain {nmSys}: F2 score {dec(c.f2)} (recall lebih berbobot) · F0.5 score {dec(c.f05)} (precision lebih berbobot) · NPV {pct(c.npv, 2)} · false negative rate {pct(c.fnr)} · Cohen&apos;s kappa {dec(c.kappa)}{s.auc[sys]?.brier !== null && s.auc[sys] ? ` · Brier score ${dec(s.auc[sys].brier, 4)}` : ""}. Tingkat fraud set ini {pct(s.prevalensi, 2)}.</p>
      </Kartu>

      {/* ---------------------------------------------------------------- 2. systems side by side */}
      <Kartu ikon="table" judul="2 · Semua sistem pada set yang sama" sub={`${gen.nama} · tingkat fraud ${pct(s.prevalensi, 2)} · ambang masing-masing sistem tidak diubah`}
        penjelas={<>
          <p>Tabel ini menempatkan ML v7 di samping versi sebelumnya (ML v5, v4), rule engine saja, dan gabungan rule engine + ML v7 (klaim ditandai bila salah satunya menandai). Pada set ini F1 score tertinggi dimiliki <b className="text-white">{NAMA[terbaikF1]}</b> ({dec(s.cm[terbaikF1].f1, 3)}).</p>
          {s.cm.aturan.f1 > v7.f1 ? <p>Rule engine saja di sini lebih baik daripada ML v7 saja. Model dan aturan menangkap jenis fraud yang berbeda, jadi keduanya dipakai berdampingan, bukan saling menggantikan (lihat bagian 11).</p>
            : <p>ML v7 saja lebih baik daripada rule engine saja. Menggabungkan keduanya menangkap lebih banyak fraud (recall naik), tetapi juga menandai lebih banyak klaim jujur.</p>}
        </>}>
        <Tabel kepala={["Sistem", "TP", "FP", "FN", "TN", "Precision", "Recall", "F1 score", "MCC", "ROC-AUC", "PR-AUC"]} sorot={0}
          baris={SISTEM.map(([k, nm]) => { const x = s.cm[k], au = s.auc[k]; return [nm, fmt(x.tp), fmt(x.fp), fmt(x.fn), fmt(x.tn), pct(x.presisi), pct(x.recall), dec(x.f1), dec(x.mcc), au ? dec(au.roc_auc) : "—", au ? dec(au.pr_auc) : "—"]; })} />
        <p className="text-[10.5px] text-[#8f99a8]">{s.auc.aturan?.catatan ? `ROC-AUC/PR-AUC rule engine: ${s.auc.aturan.catatan}. ` : ""}Gabungan tidak punya skor tunggal, jadi tanpa AUC.</p>
      </Kartu>

      {/* ---------------------------------------------------------------- 3. across generators */}
      <Kartu ikon="layers" judul="3 · Satu angka tidak cukup: F1 score ML v7 di keempat set uji" sub="Batang = F1 score ML v7 dengan 95% CI · garis oranye = F1 score rule engine saja"
        tabel={<Tabel kepala={["Set uji", "Tingkat fraud", "TP", "FP", "FN", "TN", "Precision", "Recall", "F1 score", "95% CI F1", "ROC-AUC"]}
          baris={urutGen.map((x) => { const st = d.set[x.k], m = st.cm.ml_v7; return [x.nama, pct(st.prevalensi, 2), fmt(m.tp), fmt(m.fp), fmt(m.fn), fmt(m.tn), pct(m.presisi), pct(m.recall), dec(m.f1), ciD(m.ci.f1), dec(st.auc.ml_v7.roc_auc)]; })} />}
        penjelas={<>
          <p>Pada pola fraud yang sudah dikenal model (Generator 1 dan 2), F1 score ML v7 {dec(g1.f1, 2)} dan {dec(d.set.generator2.cm.ml_v7.f1, 2)}. Pada Generator 4, yang ditulis tanpa melihat model, F1 score turun menjadi <b className="text-white">{dec(g4.f1, 2)}</b>. Penurunan ini wajar: model belajar dari pola fraud yang kita tulis sendiri, dan pola baru belum dikenalnya. Istilah teknisnya <i>distribution shift</i>.</p>
          <p>Pesan juri: klaim kita tidak boleh lebih luas daripada uji di belakangnya. Angka Generator 1 menunjukkan model bekerja untuk pola yang dirancang; angka Generator 4 menunjukkan apa yang bisa diharapkan saat pola fraud berubah.</p>
        </>}>
        <Legenda items={[{ nama: "F1 score ML v7", warna: C.ml_v7, jenis: "kotak" }, { nama: "F1 score rule engine saja", warna: C.aturan, jenis: "kotak" }]} />
        <div className="mt-2">
          <BarisH warna={C.ml_v7} rows={urutGen.map((x) => {
            const st = d.set[x.k], m = st.cm.ml_v7;
            return { key: x.k, label: x.nama, sub: x.chip, v: m.f1, ci: m.ci.f1, tanda: st.cm.aturan.f1, teks: dec(m.f1, 2),
              tip: { title: `${x.nama} · tingkat fraud ${pct(st.prevalensi, 2)}`, lines: [{ key: C.ml_v7, value: dec(m.f1), label: `F1 score ML v7 (CI ${ciD(m.ci.f1)})` },
                { value: `${pct(m.presisi)} · ${pct(m.recall)}`, label: "precision · recall" }, { key: C.aturan, value: dec(st.cm.aturan.f1), label: "F1 score rule engine" }] } };
          })} />
        </div>
      </Kartu>

      {/* ---------------------------------------------------------------- 4. ROC + PR */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Kartu ikon="graph" judul="4a · ROC curve" sub={`${gen.nama} · ROC-AUC ML v7 ${dec(a7.roc_auc)} (95% CI ${ciD(a7.ci.roc_auc)})`}
          tabel={<Tabel kepala={["Klaim jujur ikut ditandai (FPR)", "Recall ML v7", "Recall ML v5"]}
            baris={[0.001, 0.005, 0.01, 0.02, 0.05, 0.1].map((f) => {
              const at = (pts: [number, number][]) => { const p = pts.filter(([x]) => x > 0); let i = p.findIndex(([x]) => x >= f); if (i < 0) i = p.length - 1; return p[i][1]; };
              return [pct(f, 1), pct(at(s.kurva.ml_v7.roc)), pct(at(s.kurva.ml_v5.roc))];
            })} />}
          penjelas={<>
            <p>Garis menunjukkan berapa persen fraud tertangkap (sumbu tegak) bila kita rela ikut menandai sekian persen klaim jujur (sumbu datar). Sumbu datar memakai skala logaritmik supaya wilayah yang penting, yaitu menandai kurang dari 5% klaim jujur, terlihat jelas. Makin tinggi garis di sisi kiri, makin baik.</p>
            <p>Titik oranye adalah rule engine: satu titik saja karena aturan hanya punya satu ambang. ROC-AUC ML v7 {dec(a7.roc_auc, 2)} berarti bila diambil satu klaim fraud dan satu klaim jujur secara acak, {pct(a7.roc_auc, 0)} kemungkinan model memberi skor lebih tinggi pada yang fraud. Angka ini terlihat bagus, tetapi tidak menunjukkan berapa banyak klaim jujur yang ikut diperiksa. Karena itu juri meminta precision@k (bagian 5).</p>
          </>}>
          <Garis log xd={[0.0001, 1]} xt={[0.0001, 0.001, 0.01, 0.1, 1]} fx={(v) => pct(v, v < 0.001 ? 2 : v < 0.01 ? 1 : 0)} fy={(v) => pct(v, 0)}
            xl="Klaim jujur ikut ditandai (false positive rate)" yl="Fraud tertangkap (recall)"
            seri={[{ key: "v7", nama: "ML v7", warna: C.ml_v7, pts: s.kurva.ml_v7.roc }, { key: "v5", nama: "ML v5", warna: C.ml_v5, pts: s.kurva.ml_v5.roc },
              { key: "acak", nama: "Tebakan acak", warna: C.acak, putus: true, pts: Array.from({ length: 41 }, (_, i) => { const x = 10 ** (-4 + i / 10); return [x, x] as [number, number]; }) }]}
            titik={[{ nama: "Rule engine saja", warna: C.aturan, x: s.cm.aturan.fpr, y: s.cm.aturan.recall, info: `recall ${pct(s.cm.aturan.recall)} pada FPR ${pct(s.cm.aturan.fpr, 2)}` }]} />
        </Kartu>
        <Kartu ikon="graph" judul="4b · Precision–recall curve" sub={`${gen.nama} · PR-AUC ML v7 ${dec(a7.pr_auc)} (95% CI ${ciD(a7.ci.pr_auc)}) · tebakan acak ${dec(s.prevalensi)}`}
          tabel={<Tabel kepala={["Recall", "Precision ML v7", "Precision ML v5"]}
            baris={[0.1, 0.2, 0.3, 0.5, 0.7, 0.9].map((r) => { const at = (pts: [number, number][]) => (pts.find(([x]) => x >= r - 1e-9) ?? pts[pts.length - 1])[1]; return [pct(r, 0), pct(at(s.kurva.ml_v7.pr)), pct(at(s.kurva.ml_v5.pr))]; })} />}
          penjelas={<>
            <p>Garis menunjukkan precision (berapa persen yang ditandai benar fraud) di setiap tingkat recall (berapa persen fraud tertangkap). Garis putus-putus abu-abu adalah tebakan acak: precision-nya sama dengan tingkat fraud, {pct(s.prevalensi, 1)}.</p>
            <p>Garis biasanya turun ke kanan: makin banyak fraud yang ingin ditangkap, makin banyak klaim jujur yang ikut terbawa, karena kasus tambahan makin mirip klaim biasa. Titik oranye adalah rule engine.</p>
          </>}>
          <Garis xd={[0, 1]} xt={[0, 0.25, 0.5, 0.75, 1]} fx={(v) => pct(v, 0)} fy={(v) => pct(v, 0)} xl="Fraud tertangkap (recall)" yl="Yang ditandai benar fraud (precision)"
            seri={[{ key: "v7", nama: "ML v7", warna: C.ml_v7, pts: s.kurva.ml_v7.pr }, { key: "v5", nama: "ML v5", warna: C.ml_v5, pts: s.kurva.ml_v5.pr },
              { key: "acak", nama: "Tebakan acak", warna: C.acak, putus: true, pts: [[0, s.prevalensi], [1, s.prevalensi]] }]}
            titik={[{ nama: "Rule engine saja", warna: C.aturan, x: s.cm.aturan.recall, y: s.cm.aturan.presisi, info: `precision ${pct(s.cm.aturan.presisi)} · recall ${pct(s.cm.aturan.recall)}` }]} />
        </Kartu>
      </div>

      {/* ---------------------------------------------------------------- 5. jury headline at capacity k */}
      <Kartu ikon="star" judul={`5 · Metrik utama juri pada kapasitas k = ${fmt(Math.round(k7.k))} kasus`} sub={d.kapasitas.asumsi}
        penjelas={<>
          <p><b className="text-white">k</b> adalah jumlah kasus yang benar-benar sanggup diperiksa verifikator dalam satu periode. Juri meminta kinerja diukur di sini, bukan di seluruh data, karena hanya k kasus teratas yang akan diperiksa.</p>
          <p><b className="text-white">Precision@k</b>: dari {fmt(Math.round(k7.k))} kasus teratas, {pct(k7.presisi)} benar fraud. <b className="text-white">Lift</b>: itu {kali(k7.lift)} lebih baik daripada memilih kasus secara acak. {ok(k7.rupiah_recall) ? <><b className="text-white">Rupiah recall@k</b>: kasus-kasus itu mencakup {pct(k7.rupiah_recall)} nilai rupiah seluruh klaim fraud. </> : <>Set ini tidak mencatat nilai klaim, jadi rupiah recall@k tidak tersedia. </>}<b className="text-white">RS jujur yang ikut diaudit</b>: {fmt(k7.rs_jujur_diaudit_n ?? 0)} dari {fmt(s.rs_jujur)} RS tanpa fraud ({pct(k7.rs_jujur_diaudit)}) punya minimal satu klaim di daftar periksa. Ini biaya reputasi bagi RS yang jujur. Pemilihan acak akan menyeret sekitar {pct(ka.rs_jujur_diaudit)}.</p>
        </>}>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Ubin utama label="Precision@k" nilai={pct(k7.presisi)} ci={ciP(k7.ci?.presisi)} ket={`Dari ${fmt(Math.round(k7.k))} kasus teratas, berapa persen fraud. Tingkat fraud set ini ${pct(s.prevalensi, 2)}.`} />
          <Ubin utama label="Lift over random" nilai={kali(k7.lift)} ci={k7.ci?.lift ? `${dec(k7.ci.lift[0], 1)}–${dec(k7.ci.lift[1], 1)}×` : undefined} ket="Berapa kali lebih baik daripada memilih kasus secara acak." />
          <Ubin utama label="Rupiah recall@k" nilai={pct(k7.rupiah_recall)} ci={k7.ci?.rupiah_recall ? ciP(k7.ci.rupiah_recall) : undefined}
            ket={ok(k7.rupiah_recall) ? `Porsi nilai klaim fraud (${rp(s.rupiah_fraud)}) yang masuk daftar periksa.` : "Tidak tersedia: set ini tidak mencatat nilai klaim."} />
          <Ubin utama label="RS jujur yang ikut diaudit" nilai={pct(k7.rs_jujur_diaudit)} ci={ciP(k7.ci?.rs_jujur_diaudit)} ket={`${fmt(k7.rs_jujur_diaudit_n ?? 0)} dari ${fmt(s.rs_jujur)} RS tanpa klaim fraud. Acak: ${pct(ka.rs_jujur_diaudit)}.`} />
        </div>
      </Kartu>

      <Kartu ikon="gauge" judul="5b · Precision@k pada beberapa kapasitas verifikasi" sub={`${gen.nama} · garis putus-putus = memilih klaim secara acak · garis tipis di ujung batang = 95% CI`}
        tabel={<Tabel kepala={["Kapasitas", "k", "ML v7", "ML v5", "Rule engine saja", "Acak", "Lift ML v7", "Recall@k ML v7"]}
          baris={["0.005", "0.01", "0.02", "0.05"].map((x) => [pct(Number(x), 1), fmt(Math.round(s.pada_k.ml_v7[x].k)), pct(s.pada_k.ml_v7[x].presisi), pct(s.pada_k.ml_v5[x].presisi), pct(s.pada_k.aturan[x].presisi), pct(s.prevalensi), kali(s.pada_k.ml_v7[x].lift), pct(s.pada_k.ml_v7[x].recall)])} />}
        penjelas={<>
          <p>Setiap kelompok batang adalah satu ukuran kapasitas: berapa persen klaim yang sanggup diperiksa, dari 0,5% sampai 5%. Garis putus-putus adalah hasil bila klaim dipilih secara acak. Jarak antara batang dan garis itulah nilai tambah sistem.</p>
          <p>Pada kapasitas {pct(d.kapasitas.porsi, 0)}, precision@k ML v7 {pct(k7.presisi)} dan rule engine saja {pct(kr.presisi)}. Bila kapasitas bertambah, precision biasanya turun karena kasus tambahan makin &ldquo;abu-abu&rdquo;, tetapi lebih banyak fraud yang tercakup.</p>
        </>}>
        <BatangGrup grup={["0.005", "0.01", "0.02", "0.05"].map((x) => ({ k: x, label: `${pct(Number(x), 1)} · ${fmt(Math.round(s.pada_k.ml_v7[x].k))} kasus` }))}
          seri={[{ k: "ml_v7", nama: "ML v7", warna: C.ml_v7 }, { k: "ml_v5", nama: "ML v5", warna: C.ml_v5 }, { k: "aturan", nama: "Rule engine saja", warna: C.aturan }]}
          rujukan={{ v: s.prevalensi, nama: `Acak (= tingkat fraud ${pct(s.prevalensi, 1)})` }}
          nilai={(gk, sk) => { const x = s.pada_k[sk][gk]; return { v: x.presisi, ci: x.ci?.presisi, info: `CI ${ciP(x.ci?.presisi)} · lift ${kali(x.lift)} · recall@k ${pct(x.recall)}` }; }} />
      </Kartu>

      {/* ---------------------------------------------------------------- 6. fraud rate */}
      <Kartu ikon="sliders" judul="6 · Precision bergantung pada seberapa sering fraud terjadi" sub="Kemampuan ML v7 tetap (recall dan false positive rate pada ambangnya); hanya tingkat fraud yang diubah. Pita = 95% CI."
        tabel={<Tabel kepala={["Tingkat fraud", "Precision ML v7", "95% CI"]} baris={s.prevalensi_sweep.map((p) => [pct(p.prevalensi, 1), pct(p.presisi), ciP(p.ci)])} />}
        penjelas={<>
          <p>Dengan model yang persis sama, precision ML v7 hanya <b className="text-white">{pct(s.prevalensi_sweep[0].presisi)}</b> bila fraud 0,5% dari klaim, tetapi <b className="text-white">{pct(s.prevalensi_sweep[s.prevalensi_sweep.length - 1].presisi)}</b> bila fraud 20%. Model tidak berubah. Yang berubah hanya berapa banyak klaim jujur di sekitar setiap fraud.</p>
          <p>Tingkat fraud klaim BPJS yang sebenarnya belum diketahui, jadi kami melaporkan beberapa tingkat dan selalu menulis tingkat fraud di samping angka precision. Ini aritmetika, bukan data baru. Klaim seperti &ldquo;precision 99%&rdquo; tanpa menyebut tingkat fraud tidak bisa dibandingkan.</p>
        </>}>
        <Garis log xd={[0.005, 0.2]} xt={[0.005, 0.01, 0.02, 0.05, 0.1, 0.2]} fx={(v) => pct(v, v < 0.01 ? 1 : 0)} fy={(v) => pct(v, 0)} xl="Tingkat fraud di antara semua klaim" yl="Precision ML v7"
          seri={[{ key: "p", nama: "Precision ML v7", warna: C.ml_v7, pts: s.prevalensi_sweep.map((p) => [p.prevalensi, p.presisi]),
            band: s.prevalensi_sweep.filter((p) => ok(p.ci[0]) && ok(p.ci[1])).map((p) => [p.prevalensi, p.ci[0] as number, p.ci[1] as number]) }]}
          titik={[{ nama: `Set ini (${pct(s.prevalensi, 1)})`, warna: "#e5e8eb", x: Math.max(0.005, Math.min(0.2, s.prevalensi)), y: v7.presisi, info: `precision ${pct(v7.presisi)} pada tingkat fraud ${pct(s.prevalensi, 2)}` }]} />
      </Kartu>

      {/* ---------------------------------------------------------------- 7. conditions */}
      <Kartu ikon="filter" judul="7 · Hasil pada kondisi berbeda, satu faktor diubah setiap kali" sub="Precision@k ML v7 (titik) dengan 95% CI (garis) · k = 1% klaim pada setiap kondisi · tingkat fraud kondisi di bawah nama"
        tabel={<Tabel kepala={["Kondisi", "Klaim", "Fraud", "Tingkat fraud", "Precision@k", "95% CI", "Recall@k", "Lift"]}
          baris={s.kondisi.map((x) => [x.kondisi, fmt(x.klaim), fmt(x.fraud), pct(x.prevalensi, 2), pct(x.presisi_k), ciP(x.ci), pct(x.recall_k), kali(x.lift)])} />}
        penjelas={<>
          <p>Juri meminta hasil tidak dilaporkan sebagai satu angka. Dari kondisi dasar (baseline), kami mengubah satu faktor setiap kali: seberapa sering fraud terjadi (0,5% dan 10%), apakah fraud terkumpul di sedikit RS atau tersebar{g === "generator4" ? ", dan seberapa halus skemanya" : ""}. Setiap baris mencantumkan tingkat fraudnya, karena precision ikut naik-turun bersamanya (bagian 6). Garis CI yang panjang berarti sampelnya kecil, jadi jangan dibaca terlalu pasti.</p>
          {kond("langka") && kond("sering") && <p>Saat fraud langka (0,5%), precision@k ML v7 {pct(kond("langka")!.presisi_k)}; saat fraud sering (10%), {pct(kond("sering")!.presisi_k)}. {kond("konsentrasi") && kond("tersebar") ? <>Fraud yang terkumpul di sedikit RS: {pct(kond("konsentrasi")!.presisi_k)}; yang tersebar: {pct(kond("tersebar")!.presisi_k)}.</> : null}</p>}
          {kond("mudah") && <p>Catatan: skema yang <b className="text-white">kasat mata bagi manusia</b> justru hampir tidak tertangkap ML v7 (recall@k {pct(kond("mudah")!.recall_k)}). Model belajar dari pola yang pernah dilihatnya, bukan dari kejanggalan yang jelas bagi manusia. Ini alasan rule engine tetap dipakai berdampingan.</p>}
        </>}>
        <BarisH mode="titik" warna={C.ml_v7} rows={s.kondisi.map((x) => ({ key: x.kunci, label: x.kondisi, sub: `tingkat fraud ${pct(x.prevalensi, 2)} · ${fmt(x.fraud)} fraud`, v: x.presisi_k, ci: x.ci, teks: pct(x.presisi_k),
          tip: { title: x.kondisi, lines: [{ key: C.ml_v7, value: pct(x.presisi_k), label: `precision@k (CI ${ciP(x.ci)})` }, { value: pct(x.recall_k), label: "recall@k" }, { value: kali(x.lift), label: "lift over random" }, { value: pct(x.prevalensi, 2), label: "tingkat fraud" }] } }))} />
      </Kartu>

      {/* ---------------------------------------------------------------- 8. held-out schemes */}
      <Kartu ikon="alert" judul={`8 · Per skema fraud${gen.jenis === "baru" ? ": semua belum pernah dilihat model" : ""}`}
        sub="Batang = recall ML v7 per skema dengan 95% CI (ambil ulang RS) · garis oranye = recall rule engine saja · diurutkan dari yang paling sering lolos"
        tabel={<Tabel kepala={["Skema", "Famili", ...(g === "generator4" ? ["Kehalusan"] : []), "Klaim", "RS", "Recall ML v7", "95% CI", "Recall@k", "Rule engine", "Gabungan"]}
          baris={skemaUrut.map((x) => [nmSkema(x.skema), x.famili, ...(g === "generator4" ? [x.kehalusan ? KEHALUSAN[x.kehalusan] ?? x.kehalusan : "—"] : []), fmt(x.n), fmt(x.rs), pct(x.recall_ml_v7, 0), ciP(x.ci, 0), pct(x.recall_k_ml_v7, 0), pct(x.recall_aturan, 0), pct(x.recall_gabungan, 0)])} />}
        penjelas={<>
          {gen.jenis === "baru"
            ? <p>Generator 4 ditulis tanpa melihat model, jadi ke-{s.skema_n} skemanya adalah &ldquo;jenis fraud yang ditahan&rdquo; yang diminta juri: jenis yang tidak pernah ada di data latih. Batang menunjukkan berapa persen klaim fraud tiap skema yang ditandai ML v7.</p>
            : <p>Batang menunjukkan berapa persen klaim fraud tiap skema yang ditandai ML v7. {gen.jenis === "dikenal" ? "Skema di set ini sudah dikenal model saat latih." : "Sebagian skema di set ini mirip yang dikenal model."}</p>}
          {lemah.length > 0 && <p><b className="text-white">Titik lemah</b> ({lemah.length} skema, recall di bawah 5%): {lemah.slice(0, 6).map((x) => nmSkema(x.skema)).join(", ")}{lemah.length > 6 ? ", dan lainnya" : ""}. Model praktis tidak mengenali pola ini.</p>}
          {kartuAlm && <p>Contoh saling melengkapi: pada skema <b className="text-white">{nmSkema(kartuAlm.skema)}</b>, rule engine menangkap {pct(kartuAlm.recall_aturan, 0)}, sedangkan ML v7 {pct(kartuAlm.recall_ml_v7, 0)}. Aturan yang tegas menangkap pelanggaran yang tidak dipelajari model, dan sebaliknya.</p>}
        </>}>
        <Legenda items={[{ nama: "Recall ML v7", warna: C.ml_v7, jenis: "kotak" }, { nama: "Recall rule engine saja", warna: C.aturan, jenis: "kotak" }]} />
        <div className="mt-2 max-h-[560px] overflow-auto pr-1">
          <BarisH warna={C.ml_v7} rows={skemaUrut.map((x) => ({ key: x.skema, label: nmSkema(x.skema), sub: `${x.famili}${x.kehalusan ? ` · ${KEHALUSAN[x.kehalusan] ?? x.kehalusan}` : ""} · ${fmt(x.n)} klaim · ${fmt(x.rs)} RS`,
            v: x.recall_ml_v7, ci: x.ci, tanda: x.recall_aturan, teks: pct(x.recall_ml_v7, 0),
            tip: { title: nmSkema(x.skema), lines: [{ key: C.ml_v7, value: pct(x.recall_ml_v7, 0), label: `ML v7 (CI ${ciP(x.ci, 0)})` }, { key: C.aturan, value: pct(x.recall_aturan, 0), label: "rule engine saja" },
              { value: pct(x.recall_gabungan, 0), label: "gabungan" }, { value: `${fmt(x.n)} · ${fmt(x.rs)}`, label: "klaim · RS" }] } }))} />
        </div>
      </Kartu>

      {/* ---------------------------------------------------------------- 9. hard negatives */}
      <Kartu ikon="eye" judul="9 · Klaim jujur yang mirip fraud" sub={`Persen klaim jujur jenis ini yang ikut ditandai ML v7 · garis putus-putus = rata-rata semua klaim jujur (${pct(s.hard_negatif.fpr_semua_jujur, 2)})`}
        tabel={<Tabel kepala={["Jenis klaim jujur", "Klaim", "RS", "Ditandai ML v7", "95% CI", "× rata-rata", "Rule engine", "ML v5"]}
          baris={s.hard_negatif.jenis.map((x) => [x.jenis, fmt(x.n), fmt(x.rs), pct(x.fpr_ml_v7, 2), ciP(x.ci, 2), kali(x.rasio), pct(x.fpr_aturan, 2), pct(x.fpr_ml_v5, 2)])} />}
        penjelas={<>
          <p>Juri meminta kami menguji klaim jujur yang &ldquo;mirip fraud&rdquo;, misalnya pasien cuci darah yang memang datang 2–3 kali seminggu, atau RS rujukan dengan pasien yang lebih berat. Tanpa uji ini, angka false positive terlihat lebih baik daripada kenyataannya. Generator kami tidak menanam kasus seperti ini secara khusus, jadi kami mengambil klaim jujur yang memiliki ciri serupa.</p>
          {hnMax && <p>Kelompok yang paling sering kena: <b className="text-white">{hnMax.jenis.toLowerCase()}</b>, {pct(hnMax.fpr_ml_v7, 1)} ikut ditandai, {kali(hnMax.rasio)} rata-rata klaim jujur. Artinya ciri ini sendiri mendorong skor naik. Verifikator perlu diberi tahu bahwa biaya tinggi atau rawat ulang <i>bukan</i> bukti fraud, dan bagian ini menjadi bahan perbaikan model berikutnya.</p>}
        </>}>
        <BarisH warna={C.ml_v7} max={Math.max(0.05, ...s.hard_negatif.jenis.map((x) => (x.ci[1] ?? x.fpr_ml_v7) * 1.1))} rujukan={{ v: s.hard_negatif.fpr_semua_jujur, nama: "rata-rata" }}
          rows={s.hard_negatif.jenis.map((x) => ({ key: x.kunci, label: x.jenis, sub: `${x.keterangan} · ${fmt(x.n)} klaim`, v: x.fpr_ml_v7, ci: x.ci, teks: pct(x.fpr_ml_v7, 1),
            tip: { title: x.jenis, lines: [{ key: C.ml_v7, value: pct(x.fpr_ml_v7, 2), label: `ditandai ML v7 (CI ${ciP(x.ci, 2)})` }, { value: kali(x.rasio), label: "× rata-rata klaim jujur" },
              { key: C.aturan, value: pct(x.fpr_aturan, 2), label: "ditandai rule engine" }] } }))} />
      </Kartu>

      {/* ---------------------------------------------------------------- 10. fairness */}
      <Kartu ikon="globe" judul="10 · RS jujur yang ikut diaudit, per kelompok RS" sub={`RS tanpa satu pun klaim fraud yang minimal satu klaimnya masuk ${fmt(Math.round(k7.k))} kasus teratas · garis = 95% CI`}
        tabel={adilDim && <Tabel kepala={["Kelompok", "RS jujur", "Diaudit (urut peluang)", "Porsi", "95% CI", ...(obj ? ["Diaudit (urut rupiah)", "Porsi"] : []), "Klaim jujur ditandai"]}
          baris={adilDim.baris.map((r) => [r.grup, fmt(r.rs_jujur), fmt(r.probabilitas.diaudit), pct(r.probabilitas.porsi), ciP(r.probabilitas.ci), ...(obj && r.rupiah ? [fmt(r.rupiah.diaudit), pct(r.rupiah.porsi)] : obj ? ["—", "—"] : []), pct(r.fpr_klaim, 2)])} />}
        penjelas={<>
          <p>Model tidak pernah diberi tahu kelas, wilayah, atau pemilik RS, tetapi beban audit tetap bisa jatuh tidak merata. Juri meminta kami melaporkan porsi RS jujur yang ikut diaudit per kelompok, dan menyebut kelompok yang paling sering diaudit.</p>
          {adilDim?.paling_banyak ? <p>Pada pembagian ini, kelompok yang paling sering diaudit adalah <b className="text-white">{adilDim.paling_banyak}</b> ({pct(adilDim.baris.find((r) => r.grup === adilDim.paling_banyak)?.probabilitas.porsi)} RS jujurnya). Sebagian karena RS besar punya lebih banyak klaim, sehingga peluang salah satunya masuk daftar lebih besar. Kolom &ldquo;klaim jujur ditandai&rdquo; di tabel menyetarakan per klaim.</p>
            : <p>Pada set ini tidak ada RS jujur yang masuk daftar periksa: semua kasus teratas berasal dari RS yang memang punya fraud.</p>}
        </>}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-white/10" role="group" aria-label="Pembagian RS">
            {[["kelas", "Kelas RS"], ["regional", "Regional tarif"], ["kepemilikan", "Kepemilikan"], ["ukuran", "Ukuran (volume)"]].map(([k, nm]) => (
              <button key={k} type="button" onClick={() => setDim(k)} className={`px-2.5 py-1 text-[11.5px] ${dim === k ? "bg-white/10 font-semibold text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{nm}</button>
            ))}
          </div>
          <Legenda items={[{ nama: "Urut menurut peluang fraud", warna: C.ml_v7, jenis: "kotak" }, ...(obj ? [{ nama: "Urut menurut rupiah", warna: C.ml_v7, jenis: "kosong" as const }] : [])]} />
        </div>
        {adilDim && <BarisH warna={C.ml_v7} max={Math.max(0.1, ...adilDim.baris.map((r) => Math.max(r.probabilitas.ci[1] ?? 0, r.rupiah?.porsi ?? 0)))}
          rows={adilDim.baris.map((r) => ({ key: r.grup, label: r.grup, sub: `${fmt(r.rs_jujur)} RS jujur`, v: r.probabilitas.porsi, v2: obj ? r.rupiah?.porsi ?? null : null, ci: r.probabilitas.ci, teks: pct(r.probabilitas.porsi),
            tip: { title: r.grup, lines: [{ key: C.ml_v7, value: `${fmt(r.probabilitas.diaudit)} dari ${fmt(r.rs_jujur)}`, label: `diaudit, urut peluang (${pct(r.probabilitas.porsi)})` },
              ...(r.rupiah ? [{ value: `${fmt(r.rupiah.diaudit)} (${pct(r.rupiah.porsi)})`, label: "diaudit, urut rupiah" }] : []), { value: pct(r.fpr_klaim, 2), label: "klaim jujur ditandai" }] } }))} />}
      </Kartu>

      {/* ---------------------------------------------------------------- 11 + 12 */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Kartu ikon="logic" judul="11 · Apakah model layak ada, atau rule engine saja cukup?" sub={`${gen.nama} · ${av.uji}`}
          penjelas={<>
            <p>Pertanyaan juri: apakah AI di sini dipakai dengan tepat, bukan sekadar label? Kami membandingkan rule engine saja dengan rule engine + ML v7 pada klaim dan RS yang sama.</p>
            <p>{av.recall.ci[0] !== null && av.recall.ci[0] > 0 ? <>Menambah ML v7 <b className="text-white">menangkap lebih banyak fraud</b>: recall {pp(av.recall.selisih)} (95% CI {ciPP(av.recall.ci)}, {pv(av.recall.p)}). </> : <>Menambah ML v7 tidak terbukti menambah fraud yang tertangkap ({pv(av.recall.p)}). </>}
              {av.f1.ci[0] !== null && av.f1.ci[0] > 0 ? <>F1 score juga naik secara meyakinkan ({dec(av.f1.aturan)} → {dec(av.f1.gabungan)}, {pv(av.f1.p)}). </> : <>Namun F1 score tidak berubah secara meyakinkan ({dec(av.f1.aturan)} → {dec(av.f1.gabungan)}, {pv(av.f1.p)}), karena klaim jujur yang ikut ditandai juga bertambah. </>}
              {av.presisi_k.ci[0] !== null && av.presisi_k.ci[0] > 0 ? <>Untuk memilih {fmt(Math.round(k7.k))} kasus teratas, urutan ML v7 lebih baik daripada urutan skor aturan (precision@k {pct(av.presisi_k.aturan)} → {pct(av.presisi_k.ml_v7)}, {pv(av.presisi_k.p)}).</> : <>Untuk memilih {fmt(Math.round(k7.k))} kasus teratas, urutan ML v7 tidak terbukti lebih baik daripada urutan skor aturan ({pv(av.presisi_k.p)}).</>}</p>
            <p>p di bawah 0,05 berarti selisih itu kecil kemungkinannya terjadi karena kebetulan.</p>
          </>}>
          <Tabel kepala={["Ukuran", "Rule engine saja", "Dengan ML v7", "Selisih", "95% CI", "p"]}
            baris={[
              ["F1 score (pada ambang)", dec(av.f1.aturan), dec(av.f1.gabungan), dec(av.f1.selisih), ciD(av.f1.ci), pv(av.f1.p)],
              ["Recall (pada ambang)", pct(av.recall.aturan), pct(av.recall.gabungan), pp(av.recall.selisih), ciPP(av.recall.ci), pv(av.recall.p)],
              [`Precision@k (k = ${fmt(Math.round(k7.k))})`, pct(av.presisi_k.aturan), pct(av.presisi_k.ml_v7), pp(av.presisi_k.selisih), ciPP(av.presisi_k.ci), pv(av.presisi_k.p)],
              ["Recall@k", pct(av.recall_k.aturan), pct(av.recall_k.ml_v7), pp(av.recall_k.selisih), ciPP(av.recall_k.ci), pv(av.recall_k.p)],
            ]} />
          <p className="text-[10.5px] text-[#8f99a8]">&ldquo;Dengan ML v7&rdquo;: pada ambang = klaim ditandai bila aturan atau ML v7 menandai; pada k = daftar diurutkan menurut skor ML v7.</p>
        </Kartu>

        <Kartu ikon="database" judul="12 · Urutkan menurut peluang fraud, atau menurut rupiah?" sub={`k = ${fmt(Math.round(k7.k))} kasus · rupiah = peluang × nilai klaim`}
          penjelas={obj ? <>
            <p>Daftar periksa bisa diurutkan dengan dua cara: menurut <b className="text-white">peluang fraud</b>, atau menurut <b className="text-white">perkiraan rupiah</b> yang bisa diselamatkan (peluang × nilai klaim). Pada set ini, urutan rupiah mencakup {pct(obj.rupiah.rupiah_recall)} nilai fraud, dibanding {pct(obj.probabilitas.rupiah_recall)} untuk urutan peluang. Audit tanpa temuan {pct(1 - obj.rupiah.presisi)} dibanding {pct(1 - obj.probabilitas.presisi)}, dan RS jujur yang ikut diaudit {pct(obj.rupiah.rs_jujur_diaudit)} dibanding {pct(obj.probabilitas.rs_jujur_diaudit)}.</p>
            <p>{besar?.rupiah && besar.rupiah.porsi > besar.probabilitas.porsi + 0.005
              ? <>Pada set ini, urutan rupiah memindahkan beban ke RS besar: porsi RS jujur berukuran besar yang ikut diaudit naik dari {pct(besar.probabilitas.porsi)} ke {pct(besar.rupiah.porsi)}. </>
              : besar?.rupiah ? <>Di riset juri, urutan rupiah memindahkan beban ke pihak yang lebih besar. Pada set ini hal itu tidak terlihat: porsi RS jujur berukuran besar yang ikut diaudit {pct(besar.probabilitas.porsi)} (urut peluang) dan {pct(besar.rupiah.porsi)} (urut rupiah). </> : null}
              Memilih di antara keduanya adalah <b className="text-white">keputusan kebijakan, bukan keputusan teknis</b>. Catatan: {obj.catatan}</p>
          </> : <p>Set ini tidak mencatat nilai klaim, jadi perbandingan rupiah tidak tersedia. Pilih Generator 2, 3, atau 4.</p>}>
          {obj ? <Tabel kepala={["Ukuran", "Urut peluang", "Urut rupiah"]} baris={[
            ["Precision@k", pct(obj.probabilitas.presisi), pct(obj.rupiah.presisi)],
            ["Audit tanpa temuan", pct(1 - obj.probabilitas.presisi), pct(1 - obj.rupiah.presisi)],
            ["Rupiah recall@k", pct(obj.probabilitas.rupiah_recall), pct(obj.rupiah.rupiah_recall)],
            ["Rupiah klaim fraud yang tercakup", rp(obj.probabilitas.rupiah_temuan), rp(obj.rupiah.rupiah_temuan)],
            ["RS jujur yang ikut diaudit", pct(obj.probabilitas.rs_jujur_diaudit), pct(obj.rupiah.rs_jujur_diaudit)],
          ]} /> : <p className="text-[11.5px] text-[#8f99a8]">Tidak tersedia untuk set ini.</p>}
        </Kartu>
      </div>

      {/* ---------------------------------------------------------------- 13. clustered intervals */}
      <Kartu ikon="split" judul="13 · Ketidakpastian dihitung per rumah sakit, bukan per klaim" sub={`Precision@k ML v7 = ${pct(s.ci_klaster.presisi_k)} · ${fmt(s.ci_klaster.rs_uji)} RS di set uji · ${fmt(s.ci_klaster.rs_di_top_k)} RS di daftar k teratas`}
        penjelas={<>
          <p>Klaim dari satu RS cenderung mirip satu sama lain, jadi 1.000 klaim dari 20 RS tidak setara dengan 1.000 bukti yang berdiri sendiri. Bila kita keliru menganggap setiap klaim independen, rentang ketidakpastian precision@k adalah {ciP(s.ci_klaster.ci_klaim)}. Bila kita mengambil ulang seluruh RS, cara yang diminta juri, rentangnya {ciP(s.ci_klaster.ci_rs)}{ok(s.ci_klaster.rasio_lebar) ? <>, <b className="text-white">{fmt(s.ci_klaster.rasio_lebar, 1)}× lebih lebar</b>. Artinya {fmt(Math.round(s.ci_klaster.k))} kasus teratas setara kira-kira {fmt(s.ci_klaster.n_efektif ?? 0)} bukti independen.</> : <> (pada set ini semua kasus teratas fraud, jadi kedua rentang menyempit ke satu titik).</>} Semua 95% CI di laporan ini memakai cara per RS.</p>
          <p><b className="text-white">Kelemahan yang belum kami perbaiki:</b> data latih dan uji dipisah per peserta, bukan per RS. {pct(s.rs_juga_di_latih)} RS di set uji juga muncul di data latih, sehingga model sebagian bisa &ldquo;mengenal&rdquo; RS-nya. Juri menyarankan pemisahan per RS; ini masuk rencana perbaikan.</p>
        </>}>
        {ok(s.ci_klaster.ci_klaim[0]) && (() => {
          const lo = Math.max(0, Math.min(s.ci_klaster.ci_klaim[0] ?? 0, s.ci_klaster.ci_rs[0] ?? 0) - 0.05), hi = Math.min(1, Math.max(s.ci_klaster.ci_klaim[1] ?? 0, s.ci_klaster.ci_rs[1] ?? 0) + 0.05);
          const sc = (v: number | null) => (ok(v) ? (v - lo) / Math.max(hi - lo, 1e-6) : null);
          return <BarisH mode="titik" warna={C.ml_v7} max={1} rows={[
            { key: "klaim", label: "Klaim dianggap independen", sub: "cara yang keliru", v: sc(s.ci_klaster.presisi_k), ci: [sc(s.ci_klaster.ci_klaim[0]), sc(s.ci_klaster.ci_klaim[1])] as CI, teks: ciP(s.ci_klaster.ci_klaim),
              tip: { title: "Klaim dianggap independen", lines: [{ value: ciP(s.ci_klaster.ci_klaim), label: "95% CI" }] } },
            { key: "rs", label: "Seluruh RS diambil ulang", sub: "cara yang jujur · dipakai di laporan ini", v: sc(s.ci_klaster.presisi_k), ci: [sc(s.ci_klaster.ci_rs[0]), sc(s.ci_klaster.ci_rs[1])] as CI, teks: ciP(s.ci_klaster.ci_rs),
              tip: { title: "Seluruh RS diambil ulang", lines: [{ value: ciP(s.ci_klaster.ci_rs), label: "95% CI" }, { value: ok(s.ci_klaster.deff) ? fmt(s.ci_klaster.deff, 2) : "—", label: "design effect" }] } },
          ]} />;
        })()}
        <p className="text-[10.5px] text-[#8f99a8]">Sumbu: {pct(Math.max(0, Math.min(s.ci_klaster.ci_klaim[0] ?? 0, s.ci_klaster.ci_rs[0] ?? 0) - 0.05), 0)} sampai {pct(Math.min(1, Math.max(s.ci_klaster.ci_klaim[1] ?? 0, s.ci_klaster.ci_rs[1] ?? 0) + 0.05), 0)} precision@k. Design effect {ok(s.ci_klaster.deff) ? fmt(s.ci_klaster.deff, 2) : "—"}.</p>
      </Kartu>

      {/* ---------------------------------------------------------------- 14. what each step shows */}
      <Kartu ikon="list" judul="14 · Apa yang sudah dibuktikan, dan apa yang belum"
        penjelas={<p>Tidak ada satu langkah pun yang membuktikan semuanya. Laporan ini berada di langkah 1 dan 2: model menangkap pola fraud yang kami rancang, dan bertahan sebagian pada generator yang ditulis terpisah. Laporan ini <b className="text-white">belum</b> membuktikan bahwa model menemukan fraud pada klaim BPJS yang nyata. Untuk itu dibutuhkan review ahli secara buta, label nyata, dan audit terancang saat pilot.</p>}>
        <Tabel teks kepala={["Langkah", "Mendukung klaim", "Belum menunjukkan", "Status"]} baris={[
          ["1 · Data sintetis buatan sendiri (Generator 1–2)", "model menangkap pola yang dirancang untuk ditangkap", "apa pun tentang fraud nyata", <span key="a" className="text-[#7ee2c0]">selesai</span>],
          ["2 · Benchmark independen terkalibrasi (Generator 4, ditulis buta; dikalibrasi ke data sampel BPJS)", "kinerja pada kondisi yang dinyatakan", "kinerja pada klaim nyata", <span key="b" className="text-amber-200">sebagian: penulis terpisah dalam satu tim, bukan tim lain</span>],
          ["3 · Blind expert review (20 kasus teratas + 20 acak, diacak)", "tanda model masuk akal bagi ahli", "tanda model = fraud", <span key="c" className="text-[#8f99a8]">belum dilakukan</span>],
          ["4 · Label nyata parsial (fraud yang pernah terbukti)", "lebih baik dari acak pada fraud yang sudah tertangkap", "fraud yang belum pernah tertangkap", <span key="d" className="text-[#8f99a8]">belum ada data</span>],
          ["5 · Audit terancang saat pilot", "precision dan recall nyata", "bertahan saat data bergeser dan pelaku beradaptasi", <span key="e" className="text-[#8f99a8]">rencana pilot</span>],
        ]} />
      </Kartu>

      {/* ---------------------------------------------------------------- integrity */}
      <section className={`${box} space-y-1.5 p-4`}>
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white"><Icon name="lock" className="h-3.5 w-3.5 text-[#7ee2c0]" />Catatan integritas</p>
        <ul className="list-disc space-y-1 pl-5 text-[11.5px] leading-snug text-[#abb3bf]">
          {d.integritas.map((x) => <li key={x}>{x}</li>)}
          <li>Keputusan adopsi ML v7 (dari benchmark {d.benchmark_dibuat}): {d.adopsi.lolos ? "lolos" : "belum lolos"}. Selisih recall ML v7 − ML v5 di Generator 4: {ciPP(d.adopsi.ci_recall_g4)} (95% CI, batas bawah harus &gt; 0).</li>
          <li>Kapasitas k adalah asumsi: {d.kapasitas.asumsi}</li>
        </ul>
      </section>
    </div>
  );
}
