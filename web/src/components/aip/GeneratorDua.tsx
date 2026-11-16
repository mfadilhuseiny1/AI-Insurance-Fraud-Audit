"use client";

// ML Studio · Sistem ML terbaru · Generator 2 (the user, 2026-11-12: "coba bikin generator 2 data sintesis, bikin 200rb data klaim
// campur fraud dan normal, coba workflow v3, akurasi sama metric2 nya hasilnya gimana, konsisten ga, give honest answer, integrate
// it with report"). Read from generator2 in /api/ml-sistem (testing/laporan_gen2.py): the same v3 workflow on claims of a second,
// parametric generator, against test B of the first generator, with the verdict by criteria fixed before the results.
// Aggregates only; every chart has a table view.

import { useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AXIS, ChartCard, GRID, SERIES, SURFACE, Tooltip, useTip } from "./viz";

type R = { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; fpr: number; f1: number; akurasi: number; akurasi_seimbang: number;
  mcc: number; auprc: number; auroc: number; prevalensi: number; brier?: number; ece?: number };
type Chunk = { chunk: number; klaim: number; fraud: number; recall: number; precision: number; fpr: number };
type Skema = { skema: string; label: string; modus: string; famili: string | null; baru: boolean; di_uji_b: boolean; di_gen2: boolean; n_gen2: number; n_uji_b: number;
  recall_gen2?: number; recall_gen2_tanpa_vime?: number; recall_gen2_tanpa_skew?: number; recall_uji_b_tanpa_skew?: number; recall_gen2_v1?: number; recall_rule_gen2?: number; recall_uji_b?: number; recall_rule_uji_b?: number;
  lewat?: { model: number; rute: number; jaringan: number }; median_peluang?: number; varian?: { varian: string; n: number; recall: number }[] };
type Nilai = { recall: number; precision: number; fpr: number; fpr_kunjungan_pertama?: number; fpr_pernah?: number };
type Kriteria = { ukuran: string; gen2: number; uji_b: number; selisih: number; satuan: "poin" | "x"; batas: [number, number]; hasil: string };
export type G2 = {
  dibuat: string; chunk: number; klaim: number; fraud: number; normal: number; anggota: number; riwayat: number;
  ringkas: Record<"model_v3" | "model_v3_tanpa_vime" | "model_v2" | "model" | "rule", R>; uji_b: R;
  ci: Record<"gen2" | "uji_b", Record<"recall" | "precision" | "fpr" | "auprc", [number, number]>>;
  chunks: Record<"gen2" | "uji_b", Chunk[]>; model_nama: Record<string, string>;
  skema: Skema[]; famili: { famili: string; nama: string; n_gen2: number; recall_gen2: number | null; n_uji_b: number; recall_uji_b: number | null }[];
  recall_bersama: { gen2: number; uji_b: number; n_gen2: number; n_uji_b: number }; recall_baru: number | null;
  normal_ditandai: { n: number; lewat: { model: number; rute: number; jaringan: number }; sinyal: { kode: string; n: number; laju_semua_normal: number }[]; tanpa_sinyal: number };
  fidelitas: { ukuran: string; gen2: number; gen1: number; jenis: "pct" | "angka" | "rp" }[];
  c2st: Record<"klaim" | "lengkap", { auc: number; fitur: { fitur: string; gain_pct: number }[] }>;
  kalibrasi: Record<"gen2" | "uji_b", { bin: number; n: number; prediksi: number; teramati: number }[]>;
  prevalensi: { tingkat: number[]; gen2: number[]; uji_b: number[]; p_gen2: number; p_uji_b: number };
  penyebab: { sumber: { sumber: string; normal: number; fraud: number; n_normal: number }[];
    kelompok: { kelompok: string; normal: number; fraud: number; fpr: number; recall: number | null; precision: number | null }[];
    kontribusi: { fitur: string; selisih: number }[];
    skew?: { gen2: Record<"dijalankan" | "tanpa_skew", Nilai>; uji_b: Record<"dijalankan" | "tanpa_skew", Nilai>; split: number; gain_pct: number; kolom: number;
      contoh: { fitur: string; batch: number; per_klaim: number } } };
  kriteria: Kriteria[]; vonis: string; temuan: { ikon: string; judul: string; isi: string; nada: "baik" | "buruk" | "netral" }[];
  beda: string[]; batas: string[];
};

const G2C = SERIES[0];   // generator 2
const UBC = SERIES[3];   // test B (generator 1)
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const NADA: Record<string, string> = { baik: "#199e70", buruk: "#e5484d", netral: "#c98500" };
const VONIS: Record<string, { warna: string; ikon: IconName; teks: string }> = {
  konsisten: { warna: "#199e70", ikon: "check", teks: "Konsisten" },
  sebagian: { warna: "#c98500", ikon: "alert", teks: "Sebagian konsisten" },
  "tidak konsisten": { warna: "#e5484d", ikon: "alert", teks: "Tidak konsisten" },
};
const FAMILI: Record<string, string> = { koding: "Coding", tagihan: "Tagihan", episode: "Episode", identitas: "Identitas", jaringan: "Jaringan" };
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const rp = (v: number) => (v >= 1e6 ? `Rp ${id(v / 1e6, 1)} jt` : `Rp ${id(v / 1e3, 0)} rb`);

function Tabel({ kepala, baris }: { kepala: string[]; baris: (string | number)[][] }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-left text-[11.5px]">
        <thead className="sticky top-0 bg-[#1c2127] text-[#8f99a8]"><tr>{kepala.map((k) => <th key={k} className="px-2 py-1.5 font-medium">{k}</th>)}</tr></thead>
        <tbody>{baris.map((b, i) => <tr key={i} className="border-t border-white/[.05] text-[#d3d8de]">{b.map((c, j) => <td key={j} className="px-2 py-1 tabular-nums">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Legenda({ items }: { items: [string, string][] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#c5cbd3]">{items.map(([w, l]) => <span key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: w }} />{l}</span>)}</div>;
}

/** Two values on one 0..maks track: generator 2 and test B, with a hover title. */
function Pasangan({ a, b, maks = 1, fmt = (v: number) => pct(v) }: { a?: number | null; b?: number | null; maks?: number; fmt?: (v: number) => string }) {
  const x = (v: number) => `${Math.max(0, Math.min(1, v / maks)) * 100}%`;
  return (
    <div className="relative h-4">
      <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: GRID }} />
      {a != null && b != null && <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded" style={{ left: x(Math.min(a, b)), width: `calc(${x(Math.max(a, b))} - ${x(Math.min(a, b))})`, background: "#5f6b7a" }} />}
      {b != null && <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(b), background: UBC, borderColor: SURFACE }} title={`uji B ${fmt(b)}`} />}
      {a != null && <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: x(a), background: G2C, borderColor: SURFACE }} title={`generator 2 ${fmt(a)}`} />}
    </div>
  );
}

function Batang({ nilai, warna, label, maks = 1 }: { nilai: number | null | undefined; warna: string; label?: string; maks?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        {nilai != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, (nilai / maks) * 100))}%`, background: warna }} />}
      </div>
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label ?? (nilai == null ? "—" : pct(nilai, 0))}</span>
    </div>
  );
}

/** One measure per chunk as dots (generator 2 above, test B below), with the chunk-bootstrap 95 % interval. */
function Titik({ judul, g, b, ciG, ciB, maks, fmt }: { judul: string; g: number[]; b: number[]; ciG: [number, number]; ciB: [number, number]; maks: number; fmt: (v: number) => string }) {
  const { box: ref, tip, at, clear } = useTip();
  const x = (v: number) => 14 + (Math.max(0, Math.min(maks, v)) / maks) * 652;
  const baris = (vals: number[], ci: [number, number], y: number, w: string, nama: string) => (
    <g>
      <line x1={x(ci[0])} x2={x(ci[1])} y1={y} y2={y} stroke={w} strokeOpacity={0.35} strokeWidth={8} strokeLinecap="round" />
      {vals.map((v, i) => <circle key={i} cx={x(v)} cy={y + ((i % 5) - 2) * 1.6} r={4} fill={w} stroke={SURFACE} strokeWidth={1}
        onPointerMove={(e) => at(e, { title: `${nama} · chunk ${i + 1}`, lines: [{ key: w, label: judul, value: fmt(v) }] })} onPointerLeave={clear} />)}
    </g>
  );
  return (
    <div ref={ref} className="relative">
      <p className="mb-0.5 text-[11.5px] text-[#abb3bf]">{judul}</p>
      <svg viewBox="0 0 680 64" className="w-full" role="img" aria-label={judul}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line x1={x(t * maks)} x2={x(t * maks)} y1={4} y2={46} stroke={GRID} />
          <text x={x(t * maks)} y={60} textAnchor="middle" fontSize="10" fill={AXIS}>{fmt(t * maks)}</text></g>)}
        {baris(g, ciG, 15, G2C, "Generator 2")}
        {baris(b, ciB, 36, UBC, "Uji B")}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Precision against the fraud rate (log x), from each test's recall and FPR. */
function KurvaPrevalensi({ p }: { p: G2["prevalensi"] }) {
  const { box: ref, tip, at, clear } = useTip();
  const W = 680, H = 250, L = 40, Rr = 14, T = 18, B = 36;
  const TICK = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
  const lx = (v: number) => Math.log10(v);
  const x0 = lx(p.tingkat[0]), x1 = lx(p.tingkat[p.tingkat.length - 1]);
  const px = (v: number) => L + ((lx(v) - x0) / (x1 - x0)) * (W - L - Rr);
  const py = (v: number) => T + (H - T - B) * (1 - v);
  const garis = (vals: number[], w: string) => <path d={vals.map((v, i) => `${i ? "L" : "M"}${px(p.tingkat[i]).toFixed(1)},${py(v).toFixed(1)}`).join(" ")} fill="none" stroke={w} strokeWidth={2} strokeLinejoin="round" />;
  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="precision menurut tingkat fraud">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <g key={t}><line x1={L} x2={W - Rr} y1={py(t)} y2={py(t)} stroke={t === 0 ? "#383f47" : GRID} />
          <text x={L - 5} y={py(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{pct(t, 0)}</text></g>)}
        {TICK.map((t) => <text key={t} x={px(t)} y={H - B + 15} textAnchor="middle" fontSize="10" fill={AXIS}>{pct(t, t < 0.01 ? 1 : 0)}</text>)}
        <text x={(L + W) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill={AXIS}>proporsi fraud di klaim masuk</text>
        {([[p.p_uji_b, "uji B", "start"], [p.p_gen2, "gen 2", "end"]] as const).map(([v, l, a]) => <g key={l}><line x1={px(v)} x2={px(v)} y1={T} y2={H - B} stroke="#8f99a8" strokeDasharray="3 4" />
          <text x={px(v) + (a === "start" ? 4 : -4)} y={T - 5} textAnchor={a} fontSize="10" fill="#c5cbd3">{l} {pct(v, 1)}</text></g>)}
        {garis(p.uji_b, UBC)}{garis(p.gen2, G2C)}
        {p.tingkat.map((t, i) => (
          <g key={t} onPointerMove={(e) => at(e, { title: `fraud ${pct(t, 2)}`, lines: [{ key: G2C, label: "Generator 2", value: pct(p.gen2[i]) }, { key: UBC, label: "Uji B", value: pct(p.uji_b[i]) }] })} onPointerLeave={clear}>
            <rect x={px(t) - 10} y={T} width={20} height={H - T - B} fill="transparent" />
            <circle cx={px(t)} cy={py(p.uji_b[i])} r={3.5} fill={UBC} stroke={SURFACE} strokeWidth={1.5} />
            <circle cx={px(t)} cy={py(p.gen2[i])} r={3.5} fill={G2C} stroke={SURFACE} strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      <Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B (generator 1)"]]} />
      <Tooltip tip={tip} />
    </div>
  );
}

/** Reliability: mean probability against the observed fraud share per bin (diagonal = calibrated). */
function Kalibrasi({ k }: { k: G2["kalibrasi"] }) {
  const { box: ref, tip, at, clear } = useTip();
  const W = 680, H = 260, L = 40, Rr = 14, T = 12, B = 34;
  const px = (v: number) => L + v * (W - L - Rr), py = (v: number) => T + (H - T - B) * (1 - v);
  const seri = (rows: G2["kalibrasi"]["gen2"], w: string, nama: string) => (
    <g>
      <path d={rows.map((r, i) => `${i ? "L" : "M"}${px(r.prediksi).toFixed(1)},${py(r.teramati).toFixed(1)}`).join(" ")} fill="none" stroke={w} strokeWidth={1.8} />
      {rows.map((r) => <circle key={r.bin} cx={px(r.prediksi)} cy={py(r.teramati)} r={Math.min(7, 2.5 + Math.log10(r.n))} fill={w} stroke={SURFACE} strokeWidth={1.5}
        onPointerMove={(e) => at(e, { title: `${nama} · peluang ${pct(r.bin, 0)}–${pct(r.bin + 0.1, 0)}`, lines: [{ key: w, label: "rata-rata peluang", value: pct(r.prediksi) }, { key: w, label: "fraud teramati", value: pct(r.teramati) }, { key: w, label: "klaim", value: id(r.n) }] })}
        onPointerLeave={clear} />)}
    </g>
  );
  return (
    <div ref={ref} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="kalibrasi peluang">
        {[0, 0.5, 1].map((t) => <g key={t}><line x1={L} x2={W - Rr} y1={py(t)} y2={py(t)} stroke={GRID} /><text x={L - 5} y={py(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{pct(t, 0)}</text>
          <text x={px(t)} y={H - B + 14} textAnchor="middle" fontSize="10" fill={AXIS}>{pct(t, 0)}</text></g>)}
        <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} stroke="#8f99a8" strokeDasharray="4 4" />
        <text x={(L + W) / 2} y={H - 3} textAnchor="middle" fontSize="10" fill={AXIS}>peluang dari model</text>
        {seri(k.uji_b, UBC, "Uji B")}{seri(k.gen2, G2C, "Generator 2")}
      </svg>
      <Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B"]]} />
      <Tooltip tip={tip} />
    </div>
  );
}

export function GeneratorDua({ g }: { g: G2 }) {
  const [tampil, setTampil] = useState<"semua" | "bersama">("semua");
  const r = g.ringkas.model_v3, b = g.uji_b;
  const v = VONIS[g.vonis] ?? VONIS.sebagian;
  const skema = g.skema.filter((s) => s.di_gen2 && (tampil === "semua" || s.di_uji_b));
  const kpi: { label: string; ikon: IconName; a: number; bb: number; ci?: [number, number]; d?: number; ket: string; rendah?: boolean }[] = [
    { label: "Recall", ikon: "search", a: r.recall, bb: b.recall, ci: g.ci.gen2.recall, ket: "fraud yang tertangkap" },
    { label: "Precision", ikon: "check", a: r.precision, bb: b.precision, ci: g.ci.gen2.precision, ket: `yang ditandai memang fraud (fraud ${pct(r.prevalensi)} vs ${pct(b.prevalensi)})` },
    { label: "FPR", ikon: "alert", a: r.fpr, bb: b.fpr, ci: g.ci.gen2.fpr, d: 2, ket: "klaim normal ikut ditandai", rendah: true },
    { label: "AUPRC", ikon: "graph", a: r.auprc, bb: b.auprc, ci: g.ci.gen2.auprc, ket: "kualitas urutan skor (bergantung prevalensi)" },
    { label: "F1", ikon: "layers", a: r.f1, bb: b.f1, ket: "rata-rata harmonik precision dan recall" },
    { label: "Akurasi", ikon: "gauge", a: r.akurasi, bb: b.akurasi, d: 2, ket: `menyesatkan bila fraud jarang: tanpa model pun ${pct(1 - r.prevalensi, 1)}` },
  ];
  const fmtAngka = (x: number, j: string) => (j === "pct" ? pct(x) : j === "rp" ? rp(x) : id(x, 2));
  const lapis = g.normal_ditandai.lewat, nTot = Math.max(1, g.normal_ditandai.n);
  return (
    <div className="space-y-4">
      {/* header */}
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3987e5]/20 text-[#8abbff]"><Icon name="sparkle" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Uji konsistensi · generator sintetis kedua · {g.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Workflow v3 pada {id(g.klaim)} klaim generator 2</h2>
          <p className="text-[11.5px] text-[#abb3bf]">{id(g.fraud)} fraud + {id(g.normal)} normal dari {id(g.anggota)} peserta di {g.chunk} chunk; dinilai rule engine, fitur dan model v3 yang sama dengan /testing, lalu dibandingkan dengan uji B (generator 1).</p>
        </div>
        <span className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-semibold" style={{ background: `${v.warna}26`, color: v.warna }}><Icon name={v.ikon} className="h-4 w-4" />{v.teks}</span>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      {/* findings */}
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {g.temuan.map((t) => (
          <div key={t.judul} className={`${box} flex gap-2.5 p-3`}>
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: `${NADA[t.nada]}26`, color: NADA[t.nada] }}><Icon name={(t.ikon as IconName) || "info"} className="h-4 w-4" /></span>
            <div className="min-w-0"><p className="text-[12px] font-semibold leading-snug text-white">{t.judul}</p><p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{t.isi}</p></div>
          </div>
        ))}
      </div>

      {/* metrics against test B */}
      <ChartCard title="Metrik v3: generator 2 vs uji B" insight="Titik biru generator 2, kuning uji B. Rentang di bawah angka = interval 95% dari bootstrap per chunk."
        table={<Tabel kepala={["Ukuran", "Generator 2", "Interval 95%", "Uji B", "Interval 95% uji B"]} baris={kpi.map((k) => [k.label, pct(k.a, k.d ?? 1), k.ci ? `${pct(k.ci[0], k.d ?? 1)}–${pct(k.ci[1], k.d ?? 1)}` : "—", pct(k.bb, k.d ?? 1),
          k.label in { Recall: 1, Precision: 1, FPR: 1, AUPRC: 1 } ? (() => { const c = g.ci.uji_b[k.label.toLowerCase() as "recall"]; return `${pct(c[0], k.d ?? 1)}–${pct(c[1], k.d ?? 1)}`; })() : "—"])} />}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {kpi.map((k) => {
            const lebih = k.rendah ? k.a <= k.bb : k.a >= k.bb;
            const maks = k.rendah ? Math.max(0.01, k.a, k.bb) * 1.3 : 1;
            return (
              <div key={k.label} className="rounded-md border border-white/[.07] p-3">
                <div className="flex items-center gap-2 text-[11px] text-[#abb3bf]"><Icon name={k.ikon} className="h-3.5 w-3.5" />{k.label}
                  <span className="ml-auto rounded px-1.5 text-[10.5px]" style={{ background: lebih ? "#199e7026" : "#c9850026", color: lebih ? "#7ee2c0" : "#f0c661" }}>
                    {k.a >= k.bb ? "+" : "−"}{id(Math.abs(k.a - k.bb) * 100, k.d ?? 1)} poin</span></div>
                <p className="mt-1.5 text-[22px] font-semibold leading-none tabular-nums text-white">{pct(k.a, k.d ?? 1)}</p>
                <p className="mt-1 text-[10.5px] tabular-nums text-[#8f99a8]">{k.ci ? `95%: ${pct(k.ci[0], k.d ?? 1)}–${pct(k.ci[1], k.d ?? 1)} · ` : ""}uji B {pct(k.bb, k.d ?? 1)}</p>
                <div className="mt-2"><Pasangan a={k.a} b={k.bb} maks={maks} fmt={(x) => pct(x, k.d ?? 1)} /></div>
                <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">{k.ket}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-3"><Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B (generator 1)"]]} /></div>
      </ChartCard>

      {/* the verdict */}
      <ChartCard title="Konsisten? Kriteria yang ditetapkan sebelum hasil dilihat"
        insight={`Recall dan precision: selisih ≤ ${id(g.kriteria[0].batas[0])} poin konsisten, ≤ ${id(g.kriteria[0].batas[1])} sebagian. FPR: rasio ≤ ${id(g.kriteria[2].batas[0], 1)}× konsisten, ≤ ${id(g.kriteria[2].batas[1], 1)}× sebagian. Vonis = hasil terburuk.`}
        table={<Tabel kepala={["Ukuran", "Generator 2", "Uji B", "Selisih", "Hasil"]} baris={g.kriteria.map((k) => [k.ukuran, pct(k.gen2, k.satuan === "x" ? 2 : 1), pct(k.uji_b, k.satuan === "x" ? 2 : 1), k.satuan === "x" ? `${id(k.selisih, 2)}×` : `${id(k.selisih, 1)} poin`, k.hasil])} />}>
        <div className="space-y-2.5">
          {g.kriteria.map((k) => {
            const w = (VONIS[k.hasil] ?? VONIS.sebagian).warna;
            const maks = k.satuan === "x" ? Math.max(k.gen2, k.uji_b) * 1.4 : 1;
            return (
              <div key={k.ukuran} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1.4fr) 92px 128px" }}>
                <span className="truncate text-[12px] text-white" title={k.ukuran}>{k.ukuran}</span>
                <Pasangan a={k.gen2} b={k.uji_b} maks={maks} fmt={(x) => pct(x, k.satuan === "x" ? 2 : 1)} />
                <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{k.satuan === "x" ? `${id(k.selisih, 2)}×` : `${id(k.selisih, 1)} poin`}</span>
                <span className="flex items-center justify-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium" style={{ background: `${w}26`, color: w }}>
                  <Icon name={(VONIS[k.hasil] ?? VONIS.sebagian).ikon} className="h-3 w-3" />{k.hasil}</span>
              </div>
            );
          })}
        </div>
      </ChartCard>

      {/* why */}
      {g.penyebab && (
        <ChartCard title="Kenapa: kunjungan pertama ke RS, ditambah bug pembulatan fitur"
          insight="Data latih v2 dan uji B dibuat dengan memindah klaim lama ke jendela uji, dan klaim aslinya tetap tercatat di riwayat RS yang sama. Jadi tidak satu pun klaim normalnya kunjungan pertama. Model 1 juga bisa membedakan baris data latih v2 dari aliran latih lewat pembulatan angka. Akibatnya, klaim yang dihitung per klaim (uji, generator 2, layanan /testing) dinilai seperti data latih v2, tempat kunjungan pertama hampir selalu fraud."
          table={<Tabel kepala={["Kelompok", "Klaim normal", "Fraud", "Normal ditandai", "Recall", "Precision"]} baris={g.penyebab.kelompok.map((k) => [k.kelompok, id(k.normal), id(k.fraud), pct(k.fpr, 2), pct(k.recall), pct(k.precision)])} />}>
          <div className="grid gap-5 lg:grid-cols-3">
            <div>
              <p className="mb-2 text-[11.5px] text-[#abb3bf]">Klaim normal yang ditandai v3</p>
              <div className="space-y-2.5">{g.penyebab.kelompok.map((k, i) => (
                <div key={k.kelompok}>
                  <p className="text-[11.5px] text-white">{k.kelompok}</p>
                  <Batang nilai={k.fpr} warna={i === 0 ? "#e5484d" : i === 1 ? G2C : UBC} label={pct(k.fpr, k.fpr < 0.1 ? 1 : 0)} />
                  <p className="text-[10px] text-[#8f99a8]">{id(k.normal)} normal · recall fraud {pct(k.recall, 0)}</p>
                </div>))}</div>
            </div>
            <div>
              <p className="mb-2 text-[11.5px] text-[#abb3bf]">Porsi kunjungan pertama ke RS itu</p>
              <div className="space-y-2.5">{g.penyebab.sumber.map((x) => (
                <div key={x.sumber}>
                  <p className="text-[11.5px] text-white">{x.sumber}</p>
                  <Batang nilai={x.normal} warna={SERIES[2]} label={`N ${pct(x.normal, 0)}`} />
                  <Batang nilai={x.fraud} warna={SERIES[1]} label={`F ${pct(x.fraud, 0)}`} />
                </div>))}</div>
              <div className="mt-2"><Legenda items={[[SERIES[2], "di klaim normal"], [SERIES[1], "di klaim fraud"]]} /></div>
            </div>
            <div>
              <p className="mb-2 text-[11.5px] text-[#abb3bf]">Yang menaikkan skor klaim normal yang ditandai (Model 1, selisih kontribusi logit)</p>
              <div className="space-y-1.5">{g.penyebab.kontribusi.map((k) => (
                <div key={k.fitur} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
                  <span className="truncate text-[10.5px] text-[#d3d8de]" title={k.fitur}>{k.fitur}</span>
                  <Batang nilai={Math.max(0, k.selisih)} maks={Math.max(0.1, g.penyebab.kontribusi[0]?.selisih ?? 1)} warna={SERIES[4]} label={`+${id(k.selisih, 2)}`} />
                </div>))}</div>
            </div>
          </div>
          {g.penyebab.skew && (() => {
            const k = g.penyebab.skew;
            const baris: [string, Nilai, Nilai, string][] = [["Generator 2", k.gen2.dijalankan, k.gen2.tanpa_skew, G2C], ["Uji B", k.uji_b.dijalankan, k.uji_b.tanpa_skew, UBC]];
            return (
              <div className="mt-4 rounded-md border border-[#e5484d]/30 bg-[#e5484d]/[.06] p-3">
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white"><Icon name="bug" className="h-4 w-4 text-[#ff9592]" />Bug fitur: sumber baris terbaca dari pembulatan angka</p>
                <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">Fitur aliran latih dihitung sekaligus, sedangkan data latih v2, uji, dan layanan /testing menghitungnya per klaim. Hasilnya beda di digit terakhir
                  ({k.contoh.fitur}: <span className="tabular-nums">{k.contoh.batch.toFixed(9)}</span> vs <span className="tabular-nums">{k.contoh.per_klaim.toFixed(9)}</span>), dan Model 1 punya {id(k.split)} split tepat di antaranya
                  ({id(k.gain_pct, 1)}% gain). Diagnosis: nilai disamakan dengan versi batch lalu dinilai ulang; model dan ambang tidak diubah.</p>
                <div className="mt-2.5 grid gap-3 md:grid-cols-2">
                  {baris.map(([nm, a, t, w]) => (
                    <div key={nm} className="space-y-1.5">
                      <p className="text-[11.5px] font-medium" style={{ color: w }}>{nm}</p>
                      {([["Recall", "recall", 1], ["Precision", "precision", 1], ["Normal ditandai", "fpr", Math.max(0.02, a.fpr, t.fpr) * 1.2]] as const).map(([lab, key, maks]) => (
                        <div key={key} className="grid items-center gap-2" style={{ gridTemplateColumns: "92px 1fr 128px" }}>
                          <span className="text-[11px] text-[#abb3bf]">{lab}</span>
                          <div className="relative h-4">
                            <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: GRID }} />
                            <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${Math.min(1, a[key] / maks) * 100}%`, background: w, borderColor: SURFACE }} title={`dijalankan ${pct(a[key])}`} />
                            <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${Math.min(1, t[key] / maks) * 100}%`, background: "transparent", borderColor: w }} title={`tanpa selisih pembulatan ${pct(t[key])}`} />
                          </div>
                          <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{pct(a[key], key === "fpr" ? 2 : 1)} → {pct(t[key], key === "fpr" ? 2 : 1)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Titik penuh = seperti dijalankan sekarang · lingkaran = tanpa selisih pembulatan (diagnosis)</p>
              </div>
            );
          })()}
        </ChartCard>
      )}

      {/* per scheme */}
      <ChartCard title="Recall per skema fraud" insight={`Biru = v3 di generator 2, kuning = v3 di uji B (bila skemanya ada di sana). ${g.recall_baru !== null ? `Skema yang tidak pernah ditulis generator 1: ${pct(g.recall_baru)}.` : ""}`}
        table={<Tabel kepala={["Skema", "Modus", "Kelompok", "n gen 2", "Recall gen 2", "Gen 2 tanpa bug pembulatan", "Rule engine gen 2", "Recall uji B", "Uji B tanpa bug pembulatan", "n uji B"]}
          baris={g.skema.filter((s) => s.di_gen2 || s.di_uji_b).map((s) => [s.label + (s.baru ? " (baru)" : ""), s.modus, FAMILI[s.famili ?? ""] ?? "—", id(s.n_gen2), pct(s.recall_gen2),
            pct(s.recall_gen2_tanpa_skew), pct(s.recall_rule_gen2), pct(s.recall_uji_b), pct(s.recall_uji_b_tanpa_skew), id(s.n_uji_b)])} />}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B"]]} />
          <div className="ml-auto flex rounded border border-white/10 p-0.5 text-[10.5px]">
            {(["semua", "bersama"] as const).map((k) => <button key={k} onClick={() => setTampil(k)} className={`rounded-sm px-1.5 py-0.5 ${tampil === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{k === "semua" ? "Semua skema" : "Ada di keduanya"}</button>)}
          </div>
        </div>
        <div className="grid gap-x-6 gap-y-2.5 lg:grid-cols-2">
          {skema.map((s) => (
            <div key={s.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)" }}>
              <div className="min-w-0">
                <p className="truncate text-[12px] text-white" title={s.label}>{s.label}</p>
                <div className="flex flex-wrap gap-1">
                  {s.modus && <span className="rounded bg-[#d55181]/15 px-1 text-[10px] text-[#f29ab9]">{s.modus}</span>}
                  {s.famili && <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#c5cbd3]">{FAMILI[s.famili] ?? s.famili}</span>}
                  {s.baru && <span className="rounded bg-[#3987e5]/20 px-1 text-[10px] text-[#8abbff]">baru, tak ada di generator 1</span>}
                  {!s.baru && !s.di_uji_b && <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#8f99a8]">tidak ada di uji B</span>}
                  <span className="text-[10px] text-[#8f99a8]">n = {id(s.n_gen2)}</span>
                </div>
                {s.recall_gen2_tanpa_skew !== undefined && <p className="mt-0.5 text-[10px] text-[#8f99a8]">tanpa bug pembulatan: {pct(s.recall_gen2_tanpa_skew, 0)}{s.recall_uji_b_tanpa_skew !== undefined ? ` · uji B ${pct(s.recall_uji_b_tanpa_skew, 0)}` : ""} · rule engine {pct(s.recall_rule_gen2, 0)}</p>}
                {s.varian && <p className="mt-0.5 text-[10px] text-[#8f99a8]">{s.varian.map((x) => `${x.varian.replace("_", " ")} ${pct(x.recall, 0)} (n ${id(x.n)})`).join(" · ")}</p>}
              </div>
              <div className="space-y-1"><Batang nilai={s.recall_gen2} warna={G2C} />{s.di_uji_b && <Batang nilai={s.recall_uji_b} warna={UBC} />}</div>
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Stabil antar chunk?" insight={`Tiap titik satu chunk (generator 2: ${g.chunks.gen2.length} × ±5.000 klaim; uji B: ${g.chunks.uji_b.length} batch). Pita = interval 95%.`}
          table={<Tabel kepala={["Sumber", "Chunk", "Klaim", "Fraud", "Recall", "Precision", "FPR"]} baris={[...g.chunks.gen2.map((c) => ["Generator 2", c.chunk + 1, id(c.klaim), id(c.fraud), pct(c.recall), pct(c.precision), pct(c.fpr, 2)]),
            ...g.chunks.uji_b.map((c) => ["Uji B", c.chunk + 1, id(c.klaim), id(c.fraud), pct(c.recall), pct(c.precision), pct(c.fpr, 2)])]} />}>
          <div className="space-y-2">
            <Titik judul="Recall" g={g.chunks.gen2.map((c) => c.recall)} b={g.chunks.uji_b.map((c) => c.recall)} ciG={g.ci.gen2.recall} ciB={g.ci.uji_b.recall} maks={1} fmt={(x) => pct(x, 0)} />
            <Titik judul="Precision" g={g.chunks.gen2.map((c) => c.precision)} b={g.chunks.uji_b.map((c) => c.precision)} ciG={g.ci.gen2.precision} ciB={g.ci.uji_b.precision} maks={1} fmt={(x) => pct(x, 0)} />
            {(() => { const m = Math.max(0.005, ...g.chunks.gen2.map((c) => c.fpr), ...g.chunks.uji_b.map((c) => c.fpr)) * 1.1;
              return <Titik judul="Klaim normal ditandai (FPR)" g={g.chunks.gen2.map((c) => c.fpr)} b={g.chunks.uji_b.map((c) => c.fpr)} ciG={g.ci.gen2.fpr} ciB={g.ci.uji_b.fpr} maks={m} fmt={(x) => pct(x, 2)} />; })()}
            <Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B"]]} />
          </div>
        </ChartCard>
        <ChartCard title="Precision bila fraud makin jarang" insight="Dihitung dari recall dan FPR tiap uji: membandingkan kedua generator pada proporsi fraud yang sama."
          table={<Tabel kepala={["Fraud di klaim masuk", "Generator 2", "Uji B"]} baris={g.prevalensi.tingkat.map((t, i) => [pct(t, 2), pct(g.prevalensi.gen2[i]), pct(g.prevalensi.uji_b[i])])} />}>
          <KurvaPrevalensi p={g.prevalensi} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Per kelompok modus" insight="Recall v3 per kelompok modus Permenkes 16/2019 di kedua generator."
          table={<Tabel kepala={["Kelompok", "n gen 2", "Recall gen 2", "n uji B", "Recall uji B"]} baris={g.famili.map((f) => [f.nama, id(f.n_gen2), pct(f.recall_gen2), id(f.n_uji_b), pct(f.recall_uji_b)])} />}>
          <div className="space-y-2.5">
            {g.famili.map((f) => (
              <div key={f.famili} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 190px) 1fr" }}>
                <div className="min-w-0"><p className="truncate text-[12px] text-white">{f.nama}</p><p className="text-[10px] text-[#8f99a8]">n {id(f.n_gen2)} · uji B {id(f.n_uji_b)}</p></div>
                <div className="space-y-1"><Batang nilai={f.recall_gen2} warna={G2C} /><Batang nilai={f.recall_uji_b} warna={UBC} /></div>
              </div>
            ))}
            <Legenda items={[[G2C, "Generator 2"], [UBC, "Uji B"]]} />
          </div>
        </ChartCard>
        <ChartCard title="Kalibrasi: apakah peluang 80% tetap berarti 80%?" insight={`Titik di garis putus = terkalibrasi. Brier ${id(r.brier ?? 0, 4)} (uji B ${id(b.brier ?? 0, 4)}), ECE ${id(r.ece ?? 0, 4)} (uji B ${id(b.ece ?? 0, 4)}).`}
          table={<Tabel kepala={["Sumber", "Peluang", "Klaim", "Rata-rata peluang", "Fraud teramati"]} baris={[...g.kalibrasi.gen2.map((k) => ["Generator 2", `${pct(k.bin, 0)}–${pct(k.bin + 0.1, 0)}`, id(k.n), pct(k.prediksi), pct(k.teramati)]),
            ...g.kalibrasi.uji_b.map((k) => ["Uji B", `${pct(k.bin, 0)}–${pct(k.bin + 0.1, 0)}`, id(k.n), pct(k.prediksi), pct(k.teramati)])]} />}>
          <Kalibrasi k={g.kalibrasi} />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Model lain pada generator 2" insight="Ambang masing-masing model seperti saat dilatih; tidak ada yang disetel pada generator 2."
          table={<Tabel kepala={["Model", "Recall", "Precision", "FPR", "AUPRC", "F1", "MCC"]} baris={(["model_v3", "model_v3_tanpa_vime", "model_v2", "model", "rule"] as const).map((m) => {
            const x = g.ringkas[m]; return [m === "rule" ? "Rule engine (perlu diperiksa/ditahan)" : g.model_nama[m] ?? m, pct(x.recall), pct(x.precision), pct(x.fpr, 2), id(x.auprc, 3), id(x.f1, 3), id(x.mcc, 3)]; })} />}>
          <div className="space-y-3">
            {(["model_v3", "model_v3_tanpa_vime", "model_v2", "model", "rule"] as const).map((m) => {
              const x = g.ringkas[m];
              return (
                <div key={m} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 170px) 1fr 1fr" }}>
                  <span className={`truncate text-[11.5px] ${m === "model_v3" ? "font-semibold text-white" : "text-[#c5cbd3]"}`}>{m === "rule" ? "Rule engine saja" : g.model_nama[m] ?? m}</span>
                  <Batang nilai={x.recall} warna={SERIES[2]} label={`R ${pct(x.recall, 0)}`} />
                  <Batang nilai={x.precision} warna={SERIES[1]} label={`P ${pct(x.precision, 0)}`} />
                </div>
              );
            })}
            <Legenda items={[[SERIES[2], "Recall"], [SERIES[1], "Precision"]]} />
          </div>
        </ChartCard>
        <ChartCard title="Klaim normal yang ikut ditandai" insight={`${id(g.normal_ditandai.n)} klaim normal ditandai v3. Lapisan yang menandai dan temuan rule yang paling sering ada pada klaim itu.`}
          table={<Tabel kepala={["Temuan rule", "Pada normal yang ditandai", "Laju di semua normal"]} baris={g.normal_ditandai.sinyal.map((s) => [s.kode, id(s.n), pct(s.laju_semua_normal, 2)])} />}>
          <div className="flex h-4 overflow-hidden rounded-full" style={{ background: GRID }}>
            {([["model", SERIES[0]], ["rute", SERIES[4]], ["jaringan", SERIES[3]]] as const).map(([k, w]) => <div key={k} style={{ width: `${(lapis[k] / nTot) * 100}%`, background: w }} title={`${k}: ${id(lapis[k])}`} />)}
          </div>
          <div className="mt-1.5"><Legenda items={[[SERIES[0], `Model (peluang ≥ ambang) ${id(lapis.model)}`], [SERIES[4], `Rule route ${id(lapis.rute)}`], [SERIES[3], `Network rule ${id(lapis.jaringan)}`]]} /></div>
          <p className="mb-1.5 mt-3 text-[11.5px] text-[#abb3bf]">Temuan rule pada klaim normal yang ditandai ({id(g.normal_ditandai.tanpa_sinyal)} tanpa temuan rule)</p>
          <div className="space-y-1.5">{g.normal_ditandai.sinyal.map((s) => (
            <div key={s.kode} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
              <span className="truncate text-[11px] text-[#d3d8de]" title={s.kode}>{s.kode}</span>
              <Batang nilai={s.n} maks={Math.max(1, g.normal_ditandai.sinyal[0]?.n ?? 1)} warna={SERIES[0]} label={id(s.n)} />
            </div>))}</div>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <ChartCard title="Seberapa beda klaim normal kedua generator?" insight={`Pembeda (LightGBM, 5 lipatan) pada klaim normal: AUC ${id(g.c2st.klaim.auc, 3)} dari 124 fitur klaim sendiri, ${id(g.c2st.lengkap.auc, 3)} dengan fitur tetangga. 0,5 = tak bisa dibedakan.`}
          table={<Tabel kepala={["Ukuran (klaim normal)", "Generator 2", "Generator 1 (uji B)"]} baris={g.fidelitas.map((f) => [f.ukuran, fmtAngka(f.gen2, f.jenis), fmtAngka(f.gen1, f.jenis)])} />}>
          <div className="space-y-2">
            {g.fidelitas.map((f) => {
              const maks = Math.max(f.gen2, f.gen1) * 1.25 || 1;
              return (
                <div key={f.ukuran} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr) 150px" }}>
                  <span className="truncate text-[11.5px] text-[#d3d8de]" title={f.ukuran}>{f.ukuran}</span>
                  <Pasangan a={f.gen2} b={f.gen1} maks={maks} fmt={(x) => fmtAngka(x, f.jenis)} />
                  <span className="text-right text-[11px] tabular-nums text-[#c5cbd3]">{fmtAngka(f.gen2, f.jenis)} · {fmtAngka(f.gen1, f.jenis)}</span>
                </div>
              );
            })}
            <Legenda items={[[G2C, "Generator 2"], [UBC, "Generator 1 (uji B)"]]} />
            <p className="pt-2 text-[11.5px] text-[#abb3bf]">Fitur yang paling membedakan (klaim sendiri)</p>
            <div className="flex flex-wrap gap-1.5">{g.c2st.klaim.fitur.map((f) => <span key={f.fitur} className="rounded bg-white/[.06] px-1.5 py-0.5 text-[10.5px] text-[#c5cbd3]">{f.fitur} · {id(f.gain_pct, 1)}%</span>)}</div>
          </div>
        </ChartCard>
        <section className={`${box} space-y-3 p-3.5`}>
          <div>
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="sparkle" className="h-4 w-4 text-[#8abbff]" />Apa yang beda di generator 2</h3>
            <ul className="mt-1.5 space-y-1">{g.beda.map((x) => <li key={x} className="flex gap-1.5 text-[11px] leading-snug text-[#c5cbd3]"><Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-[#7ee2c0]" />{x}</li>)}</ul>
          </div>
          <div>
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="info" className="h-4 w-4 text-[#f0c661]" />Batas perbandingan ini</h3>
            <ul className="mt-1.5 space-y-1">{g.batas.map((x) => <li key={x} className="flex gap-1.5 text-[11px] leading-snug text-[#c5cbd3]"><Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0 text-[#f0c661]" />{x}</li>)}</ul>
          </div>
        </section>
      </div>
    </div>
  );
}
