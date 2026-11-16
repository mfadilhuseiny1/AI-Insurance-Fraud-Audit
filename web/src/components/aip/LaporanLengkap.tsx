"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { CaseFiles } from "@/components/aip/BerkasKasus";
import { Markdown } from "@/components/aip/Briefing";
import { modelName, wib, type Rec } from "@/components/aip/aipRun";
import { fraud, GROUP_COLOR, JALUR, STRENGTH, TSM_COLOR, TSM_DIM, TSM_MARK, type CaseFile, type Exhibit, type FullReport, type IomtClaim } from "@/components/aip/fraudApi";
import { PetaCabang } from "@/components/aip/PetaCabang";
import { PetaProvinsi } from "@/components/aip/PetaProvinsi";
import { compact, DataTable, SERIES, Tooltip, TrendLine, useTip } from "@/components/aip/viz";

/* The long report of an engagement, as a consultancy hands one over (the user, 2026-10-24: "McKinsey style long report +
   its graph rich explanation"; api/aip/laporan_konsultan.py): a cover with the headline numbers, chapters that each answer
   one question — the firm's own prose, checked by its validator — and numbered exhibits under each: the action title that
   says the finding, the chart, what it shows (written by code from the same rows), why it matters and the implication
   (the writer model's, every sentence's numbers checked by code), and where every number comes from. Charts are drawn
   natively on the app's dark surface, each with a hover and a table view. */

const idn = (n: number, d = 0) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const val = (n: number, satuan?: string) => (satuan === "rp" ? `Rp ${compact(n)}` : satuan === "usd" ? `$${idn(n, 2)}` : compact(n));
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/(-])\p{L}/gu, (c) => c.toUpperCase()).replace(/\bDki\b/g, "DKI");
// The print page (the user, 2026-10-24: "tambahkan Ekspor PDF"): the report drawn light on A4, by headless Chrome for the
// PDF download (api/report_render.py) or by the browser's own print. The components are drawn for the dark app; in
// this mode their colours are mapped to paper here, in one place, rather than in every component.
const PRINT_CSS = String.raw`
html, body { background: #fff !important; }
/* the page's margins are painted in the canvas colour of the root's colour scheme: dark (#121212) unless light here, as
   globals.css gives the dark theme's :root:not([data-theme=light]) a scheme of its own */
:root { color-scheme: light !important; }
@media print {
  /* the app's print rules show only notepad and report pages (globals.css: body > * hidden); this one shows the report,
     and the shell's screen-high, scrolling boxes around it open up so every page of it is printed */
  html, body { height: auto !important; overflow: visible !important; }
  :is(.h-screen, .h-full, .min-h-0, .min-h-screen, .overflow-hidden, .overflow-y-auto, .overflow-auto):not(.laporan-cetak):not(.laporan-cetak *) {
    height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
  .laporan-cetak, .laporan-cetak * { visibility: visible !important; }
}
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@page { size: A4; }
.laporan-cetak { background: #fff; color: #1f2429; }
.laporan-cetak .lp-no-print { display: none !important; }
.laporan-cetak .lp-sampul { background: #f5f3ff !important; border-color: #ddd8fb !important; }
.laporan-cetak .lp-kartu, .laporan-cetak .lp-berkas { background: #fff !important; border-color: #dde1e6 !important; }
.laporan-cetak .lp-kartu, .laporan-cetak figure { break-inside: avoid; }
.laporan-cetak .lp-berkas section, .laporan-cetak .lp-berkas tr, .laporan-cetak .lp-berkas summary { break-inside: avoid; }
.laporan-cetak .lp-berkas { break-before: page; }
.laporan-cetak .lp-implikasi { background: #f3f0ff !important; }
.laporan-cetak .lp-pimpinan { background: #eefaf5 !important; border-color: #bfe8d7 !important; }
.laporan-cetak .lp-info { background: #eef5ff !important; border-color: #c7dcf7 !important; }
.laporan-cetak .lp-bab { break-before: page; }
.laporan-cetak h2, .laporan-cetak h3 { break-after: avoid; }
.laporan-cetak [class*="max-h-"] { max-height: none !important; overflow: visible !important; }
.laporan-cetak .overflow-x-auto, .laporan-cetak .overflow-auto, .laporan-cetak .overflow-y-auto { overflow: visible !important; }
.laporan-cetak table { min-width: 0 !important; }
.laporan-cetak .sticky { position: static !important; }
.laporan-cetak .text-white { color: #111418 !important; }
.laporan-cetak .text-\[\#e5e8eb\] { color: #1f2429 !important; }
.laporan-cetak .text-\[\#d3d8de\] { color: #2b3138 !important; }
.laporan-cetak .text-\[\#c5cbd3\] { color: #39414a !important; }
.laporan-cetak .text-\[\#abb3bf\] { color: #4b5563 !important; }
.laporan-cetak .text-\[\#8f99a8\] { color: #5f6b7a !important; }
.laporan-cetak .text-\[\#ffb4b4\], .laporan-cetak .text-\[\#ffd0d0\] { color: #b42318 !important; }
.laporan-cetak .text-\[\#c9c0ff\], .laporan-cetak .text-\[\#9d8cff\], .laporan-cetak .text-\[\#b8a9ff\] { color: #5b4fd6 !important; }
.laporan-cetak .text-\[\#fbd38d\] { color: #8a5a00 !important; }
.laporan-cetak .text-\[\#8abbff\] { color: #1d5fb8 !important; }
.laporan-cetak .text-\[\#7ee2c0\] { color: #0f7a55 !important; }
.laporan-cetak .bg-\[\#1c2127\], .laporan-cetak .bg-\[\#12161b\] { background: #fff !important; }
.laporan-cetak .bg-\[\#20262d\] { background: #f2f4f7 !important; }
.laporan-cetak .bg-black\/20, .laporan-cetak .bg-white\/5, .laporan-cetak .bg-white\/10, .laporan-cetak .bg-white\/\[\.03\], .laporan-cetak .bg-white\/\[\.04\] { background: #f4f5f7 !important; }
.laporan-cetak [class*="border-white"] { border-color: #dde1e6 !important; }
.laporan-cetak svg [fill="#e5e8eb"] { fill: #1f2429; }
.laporan-cetak svg [fill="#8f99a8"] { fill: #5f6b7a; }
.laporan-cetak svg [stroke="#2c333b"], .laporan-cetak svg [stroke="#383f47"] { stroke: #dfe3e8; }
.laporan-cetak svg [stroke="#1c2127"] { stroke: #fff; }
.laporan-cetak svg [stroke="#8f99a8"], .laporan-cetak svg [stroke="#5b6573"] { stroke: #9aa3af; }
.laporan-cetak [style*="rgb(44, 51, 59)"] { background: #e5e8ec !important; }
.laporan-cetak [style*="color: rgb(229, 232, 235)"] { color: #1f2429 !important; }
`;

const MUTED = "#8f99a8";
// a Pareto mark's label: "10 faskes · 52,2%", "90% kerugian · 47 faskes", "kelompok A–B · 30 faskes · 80,1%"
const mark = (m: { faskes: number; label: string }, p: number) =>
  /^\d+ faskes$/.test(m.label) ? `${m.label} · ${idn(p, 1)}%` : /^\d+%$/.test(m.label) ? `${m.label} kerugian · ${idn(m.faskes)} faskes` : `${m.label} · ${idn(m.faskes)} faskes · ${idn(p, 1)}%`;
const TRACK = "#2c333b";

// ------------------------------------------------------------------------------------------------ the charts

/** Ranked horizontal bars of one measure (a single series: the title names it, no legend). */
function Bars({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const rows = x.baris.map((r) => ({ label: String(r.label ?? ""), v: Number(r.nilai) || 0, r }));
  const top = Math.max(1e-9, ...rows.map((d) => d.v));
  return (
    <div ref={box} className="relative space-y-2" onPointerLeave={clear}>
      {rows.map((d, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,40%)_1fr] items-center gap-3"
          onPointerMove={(e) => at(e, { title: d.label, lines: [{ value: val(d.v, x.satuan), label: x.ukuran },
            ...Object.entries(d.r).filter(([k, v]) => !["label", "nilai"].includes(k) && typeof v === "number").map(([k, v]) => ({ value: compact(Number(v)), label: k.replace(/_/g, " ") }))] })}>
          <span className="text-[11.5px] leading-snug text-[#d3d8de]">{d.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-[16px] shrink-0 rounded-r-[4px]" style={{ width: `${Math.max(0.8, (82 * d.v) / top)}%`, background: SERIES[0] }} />
            <span className="shrink-0 text-[11.5px] tabular-nums text-white">{val(d.v, x.satuan)}</span>
          </span>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  );
}

/** The cumulative share of the loss over the facilities ranked by it, on a log scale (the head is where it is decided),
 *  with the marks the exhibit names; a crosshair reads any rank. */
function Pareto({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const pts = x.baris.map((r) => ({ n: Number(r.faskes), p: Number(r.kumulatif_pct) })).filter((d) => d.n > 0);
  const N = Math.max(10, ...pts.map((d) => d.n));
  const W = 640, H = 230, L = 42, R = 16, T = 14, B = 30;
  const px = (n: number) => L + ((W - L - R) * Math.log10(n)) / Math.log10(N);
  const py = (p: number) => T + (H - T - B) * (1 - p / 100);
  const ticks = [1, 10, 100, 1000, 10000].filter((t) => t <= N);
  const near = hover === null ? null : pts.reduce((a, b) => (Math.abs(Math.log10(b.n) - Math.log10(hover)) < Math.abs(Math.log10(a.n) - Math.log10(hover)) ? b : a), pts[0]);
  return (
    <div ref={box} className="relative" onPointerLeave={() => { clear(); setHover(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={x.judul}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const sx = ((e.clientX - r.left) / r.width) * W;
          const n = Math.max(1, Math.min(N, Math.round(10 ** (((sx - L) / (W - L - R)) * Math.log10(N)))));
          setHover(n);
          const near = pts.reduce((a, b) => (Math.abs(b.n - n) < Math.abs(a.n - n) ? b : a), pts[0]);
          at(e, { title: `${idn(near.n)} faskes teratas`, lines: [{ key: SERIES[0], value: `${idn(near.p, 1)}%`, label: "dari estimasi kerugian" }] });
        }}>
        {[0, 50, 90, 100].map((p) => (
          <g key={p}>
            <line x1={L} x2={W - R} y1={py(p)} y2={py(p)} stroke={p === 0 ? "#383f47" : TRACK} strokeWidth={1} strokeDasharray={p === 90 ? "3 3" : undefined} />
            <text x={L - 6} y={py(p) + 3} textAnchor="end" fontSize="9.5" fill={MUTED}>{p}%</text>
          </g>
        ))}
        {ticks.map((t) => <text key={t} x={px(t)} y={H - 12} textAnchor="middle" fontSize="9.5" fill={MUTED}>{idn(t)}</text>)}
        <text x={W - R} y={H - 1} textAnchor="end" fontSize="9" fill={MUTED}>faskes, urut estimasi kerugian (skala log)</text>
        {(x.tanda ?? []).filter((m) => m.faskes >= 1).map((m, i) => {
          const p = pts.find((d) => d.n >= m.faskes)?.p ?? 100;
          return (
            <g key={i}>
              <line x1={px(m.faskes)} x2={px(m.faskes)} y1={py(p)} y2={H - B} stroke="#5b6573" strokeWidth={1} strokeDasharray="2 3" />
              <circle cx={px(m.faskes)} cy={py(p)} r={4} fill={SERIES[0]} stroke="#1c2127" strokeWidth={2} />
              <text x={px(m.faskes) + 6} y={py(p) + (i % 2 ? 14 : -6)} fontSize="10" fill="#e5e8eb">{mark(m, p)}</text>
            </g>
          );
        })}
        <path d={pts.map((d, i) => `${i ? "L" : "M"}${px(d.n)},${py(d.p)}`).join(" ")} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" />
        {near && <><line x1={px(near.n)} x2={px(near.n)} y1={T} y2={H - B} stroke={MUTED} strokeWidth={1} /><circle cx={px(near.n)} cy={py(near.p)} r={4} fill={SERIES[0]} stroke="#1c2127" strokeWidth={2} /></>}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** The Box's groups: facilities and their loss side by side (two measures, two scales, never one dual axis). */
function Groups({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const rows = x.baris;
  const maxF = Math.max(1, ...rows.map((r) => Number(r.faskes) || 0));
  const maxL = Math.max(1, ...rows.map((r) => Number(r.estimasi_kerugian_rp) || 0));
  const cell = (v: number, max: number, color: string, text: string) => (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-[14px] shrink-0 rounded-r-[4px]" style={{ width: `${Math.max(1, (78 * v) / max)}%`, background: color }} />
      <span className="shrink-0 text-[11px] tabular-nums text-[#e5e8eb]">{text}</span>
    </span>
  );
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="grid grid-cols-[110px_1fr_1fr] gap-x-4 gap-y-2 text-[11px]">
        <span /><span className="text-[#8f99a8]">Faskes</span><span className="text-[#8f99a8]">Estimasi kerugian</span>
        {rows.map((r) => {
          const c = GROUP_COLOR[String(r.kelompok)] ?? MUTED;
          return (
            <div key={String(r.kelompok)} className="contents" onPointerMove={(e) => at(e, { title: `Kelompok ${r.kelompok}`, lines: [
              { key: c, value: idn(Number(r.faskes)), label: "faskes" }, { key: c, value: val(Number(r.estimasi_kerugian_rp), "rp"), label: "estimasi kerugian" },
              { value: idn(Number(r.diaudit)), label: r.label_diaudit ? String(r.label_diaudit) : "sedang diaudit" }, { value: String(r.arti || ""), label: "" }] })}>
              <span className="flex items-center gap-1.5 text-[#e5e8eb]"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />Kelompok {String(r.kelompok)}</span>
              {cell(Number(r.faskes) || 0, maxF, c, idn(Number(r.faskes) || 0))}
              {cell(Number(r.estimasi_kerugian_rp) || 0, maxL, c, val(Number(r.estimasi_kerugian_rp) || 0, "rp"))}
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Parts of one whole: a single bar split with a 2px surface gap, each part labelled below with its value and share. */
function Stacked({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const rows = x.baris.map((r, i) => ({ label: String(r.komponen ?? r.kunci), v: Number(r.nilai) || 0, r, c: SERIES[i % SERIES.length] }));
  const total = rows.reduce((s, d) => s + d.v, 0);
  const extra = (r: Rec) => [r.token ? `${idn(Number(r.token) / 1e6, 2)} jt token` : "", r.agen ? `${idn(Number(r.agen))} agen` : ""].filter(Boolean).join(" · ");
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      {total > 0 ? (
        <div className="flex h-[22px] w-full gap-[2px] overflow-hidden rounded-[4px]">
          {rows.filter((d) => d.v > 0).map((d) => (
            <span key={d.label} className="h-full hover:brightness-125" style={{ width: `${(100 * d.v) / total}%`, background: d.c }}
              onPointerMove={(e) => at(e, { title: d.label, lines: [{ key: d.c, value: val(d.v, x.satuan), label: `${idn((100 * d.v) / total, 1)}% dari total` }] })} />
          ))}
        </div>
      ) : <p className="text-[11.5px] text-[#8f99a8]">Belum ada nilai.</p>}
      <div className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {rows.map((d) => (
          <div key={d.label} className="flex items-start gap-2 text-[11.5px]">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.c }} />
            <span className="min-w-0">
              <span className="text-[#e5e8eb]">{d.label}</span>
              <span className="block tabular-nums text-[#abb3bf]">{val(d.v, x.satuan)} · {total ? idn((100 * d.v) / total, 1) : "0"}%{extra(d.r) ? ` · ${extra(d.r)}` : ""}</span>
            </span>
          </div>
        ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// the two measures a paired exhibit shows, each with its own column and scale
const PAIRS: Record<string, { label: string; a: [string, string, string?]; b: [string, string, string]; sub?: string }> = {
  wilayah: { label: "provinsi", a: ["estimasi_kerugian_rp", "Estimasi kerugian", "rp"], b: ["klaim_berisiko_per_1000", "Klaim berisiko per 1.000 klaim FKRTL", "rate"] },
  kode: { label: "label", a: ["nilai", "Klaim berisiko"], b: ["rasio_koreksi_pct", "Koreksi verifikator, % tagihan", "pct"], sub: "diagnosis" },
  // the branch report (testing/laporan_cabang.py)
  "wilayah-kc": { label: "kabkota", a: ["estimasi_kerugian_rp", "Estimasi kerugian", "rp"], b: ["rekomendasi_per_1000", "Klaim direkomendasikan per 1.000 klaim", "rate"] },
  "tipe-rs": { label: "label", a: ["rekomendasi_per_1000", "Klaim direkomendasikan per 1.000 klaim"], b: ["estimasi_kerugian_rp", "Estimasi kerugian", "rp"] },
  "kode-cabang": { label: "label", a: ["nilai", "Klaim direkomendasikan"], b: ["estimasi_kerugian_rp", "Estimasi kerugian", "rp"], sub: "deskripsi" },
};

/** Two measures of the same rows in two aligned columns (the ranked one first). */
function Paired({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const spec = PAIRS[x.id] ?? { label: "label", a: ["nilai", x.ukuran], b: ["", "", ""] };
  const rows = x.baris;
  const maxA = Math.max(1e-9, ...rows.map((r) => Number(r[spec.a[0]]) || 0));
  const maxB = Math.max(1e-9, ...rows.map((r) => Number(r[spec.b[0]]) || 0));
  const fb = (v: number) => (spec.b[2] === "pct" ? `${idn(v, 1)}%` : spec.b[2] === "rp" ? val(v, "rp") : idn(v, 2));
  const fa = (v: number) => (spec.a[2] ? val(v, spec.a[2]) : Number.isInteger(v) ? idn(v) : idn(v, 2));
  const name = (r: Rec) => (x.id === "wilayah" ? titleCase(String(r[spec.label] ?? "")) : String(r[spec.label] ?? ""));
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="grid grid-cols-[minmax(0,30%)_1fr_minmax(0,28%)] items-center gap-x-4 gap-y-1.5 text-[11px]">
        <span /><span className="text-[#8f99a8]">{spec.a[1]}</span><span className="text-[#8f99a8]">{spec.b[1]}</span>
        {rows.map((r, i) => {
          const a = Number(r[spec.a[0]]) || 0, b = r[spec.b[0]] == null ? null : Number(r[spec.b[0]]);
          return (
            <div key={i} className="contents" onPointerMove={(e) => at(e, { title: name(r), lines: [
              { key: SERIES[0], value: fa(a), label: spec.a[1] }, ...(b == null ? [] : [{ key: SERIES[2], value: fb(b), label: spec.b[1] }]),
              ...(spec.sub && r[spec.sub] ? [{ value: String(r[spec.sub]), label: "" }] : [])] })}>
              <span className="min-w-0 leading-snug">
                <span className="block truncate text-[11.5px] text-[#e5e8eb]">{name(r)}</span>
                {spec.sub && r[spec.sub] ? <span className="block truncate text-[10px] text-[#8f99a8]">{String(r[spec.sub])}</span> : null}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-[14px] shrink-0 rounded-r-[4px]" style={{ width: `${Math.max(0.8, (80 * a) / maxA)}%`, background: SERIES[0] }} />
                <span className="shrink-0 tabular-nums text-[#e5e8eb]">{fa(a)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2">
                {b == null ? <span className="text-[#8f99a8]">—</span> : <>
                  <span className="h-[8px] shrink-0 rounded-r-[4px]" style={{ width: `${Math.max(0.8, (70 * b) / maxB)}%`, background: SERIES[2] }} />
                  <span className="shrink-0 tabular-nums text-[#c5cbd3]">{fb(b)}</span></>}
              </span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Indications per mode, split by strength (the ledger's own severity colours, with their names in the legend). */
function Strength({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const top = Math.max(1, ...x.baris.map((r) => Number(r.total) || 0));
  const levels = ["kuat", "sedang", "lemah"] as const;
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-[#c5cbd3]">
        {levels.map((k) => <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: STRENGTH[k] }} />{k}</span>)}
      </div>
      <div className="space-y-1.5">
        {x.baris.map((r, i) => {
          const t = Number(r.total) || 0;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,34%)_1fr] items-center gap-3"
              onPointerMove={(e) => at(e, { title: String(r.modus), lines: [...levels.map((k) => ({ key: STRENGTH[k], value: idn(Number(r[k]) || 0), label: k })), { value: idn(t), label: "total tag" }] })}>
              <span className="truncate text-[11.5px] text-[#d3d8de]" title={String(r.modus)}>{String(r.modus)}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-[14px] shrink-0 gap-[2px] overflow-hidden rounded-r-[4px]" style={{ width: `${Math.max(1, (80 * t) / top)}%` }}>
                  {levels.filter((k) => Number(r[k]) > 0).map((k) => <span key={k} className="h-full" style={{ width: `${(100 * Number(r[k])) / t}%`, background: STRENGTH[k] }} />)}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[#e5e8eb]">{idn(t)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** A facility's case file, opened and in view (Exhibit 10 → its file in the chapter that follows). */
const openFile = (fid: string) => {
  const el = document.getElementById(`berkas-${fid}`) as HTMLDetailsElement | null;
  if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  // not in the page (the branch report's theme view): its case-file list shows it
  else window.dispatchEvent(new CustomEvent<string>("buka-berkas-faskes", { detail: fid }));
};

/** The facilities to audit first; the parts every name shares ("FKRTL · Rumah sakit") said once above, not on each row. */
function Facilities({ x }: { x: Exhibit }) {
  if (x.kolom?.length) return <TabelKolom x={x} />;
  const parts = x.baris.map((r) => String(r.faskes ?? "").split(" · "));
  let k = 0;
  while (parts.length > 1 && parts.every((p) => p.length > k + 1 && p[k] === parts[0][k])) k++;
  const shared = k ? parts[0].slice(0, k).join(" · ") : "";
  return (
    <div>
    {shared && <p className="mb-1.5 text-[10.5px] text-[#8f99a8]">Semua: {shared}</p>}
    <div className="max-h-[420px] overflow-auto rounded border border-white/5">
      <table className="w-full text-[11.5px]">
        <thead className="sticky top-0 bg-[#20262d] text-left text-[#abb3bf]">
          <tr>{["Faskes", "Kelompok", "Estimasi kerugian", "Sudah dikoreksi", "TSM", "Rekomendasi", "Status"].map((h, i) => (
            <th key={h} className={`whitespace-nowrap px-2 py-1.5 font-medium ${i === 2 || i === 3 ? "text-right" : ""}`}>{h}</th>))}</tr>
        </thead>
        <tbody>
          {x.baris.map((r, i) => (
            <tr key={i} onClick={() => openFile(String(r.faskes_profil_id))} title="buka berkas kasus faskes ini" className="cursor-pointer border-t border-white/[.04] hover:bg-white/[.03]">
              <td className="max-w-[300px] px-2 py-1"><span className="block truncate text-[#e5e8eb]" title={String(r.faskes)}>{parts[i].slice(k).join(" · ")}</span><span className="text-[10px] text-[#8f99a8]">{String(r.provinsi)}</span></td>
              <td className="px-2"><span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-[#111418]" style={{ background: GROUP_COLOR[String(r.kelompok)] ?? MUTED }}>{String(r.kelompok)}</span></td>
              <td className="px-2 text-right tabular-nums text-white">{val(Number(r.estimasi_kerugian_rp) || 0, "rp")}</td>
              <td className="px-2 text-right tabular-nums text-[#c5cbd3]">{val(Number(r.sudah_dikoreksi_rp) || 0, "rp")}</td>
              <td className="whitespace-nowrap px-2 text-[#c5cbd3]" title="T terstruktur · S sistematis · M masif">{String(r.tsm)}</td>
              <td className="px-2 text-[#e5e8eb]">{String(r.rekomendasi)}</td>
              <td className="px-2 text-[#abb3bf]">{String(r.status ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

/** A hospital's TSM as three compact chips, as in the national Box table: ✓ terpenuhi · ◐ sebagian · – tidak, with the
 *  dimension's initial ("✓ T", "◐ S", "– M"); the tooltip spells out all three. */
function TsmRingkas({ v }: { v: unknown }) {
  if (!v || typeof v !== "object") return <span className="text-[#8f99a8]">{v == null ? "—" : String(v)}</span>;
  const t = v as Record<string, unknown>;
  const lvl = (d: string) => { const x = t[d]; return String(x && typeof x === "object" ? (x as Rec).nilai ?? "" : x ?? ""); };
  return (
    <span className="inline-flex gap-1" title={`${TSM_DIM.map(([d, n]) => `${n}: ${lvl(d) || "—"}`).join(" · ")}  (✓ terpenuhi · ◐ sebagian · – tidak)`}>
      {TSM_DIM.map(([d, n]) => {
        const c = TSM_COLOR[lvl(d)] ?? "#4b5563";
        return <span key={d} className="whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold text-[#e5e8eb]"
          style={{ background: `${c}2e`, boxShadow: `inset 0 0 0 1px ${c}80` }}>{TSM_MARK[lvl(d)] ?? "·"} {n[0]}</span>;
      })}
    </span>
  );
}

/** A hospital's path (ditindak / dibina / dibebaskan) as a coloured chip. */
function JalurChip({ v }: { v: unknown }) {
  const j = JALUR[String(v ?? "")];
  if (!j) return <span className="text-[#8f99a8]">{v ? String(v) : "—"}</span>;
  return <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ background: `${j.color}26`, color: j.color, boxShadow: `inset 0 0 0 1px ${j.color}66` }}>{j.label}</span>;
}

/** A table with the exhibit's own columns (the branch report's hospitals); a row opens that hospital's case file. */
function TabelKolom({ x }: { x: Exhibit }) {
  const kol = x.kolom ?? [];
  return (
    <div className="max-h-[460px] overflow-auto rounded border border-white/5">
      <table className="w-full text-[11.5px]">
        <thead className="sticky top-0 bg-[#20262d] text-left text-[#abb3bf]">
          <tr>{kol.map((c) => <th key={c.key} className={`whitespace-nowrap px-2 py-1.5 font-medium ${c.jenis === "rp" ? "text-right" : ""}`}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {x.baris.map((r, i) => (
            <tr key={i} onClick={() => openFile(String(r.faskes_profil_id))} title="buka berkas kasus RS ini" className="cursor-pointer border-t border-white/[.04] align-top hover:bg-white/[.03]">
              {kol.map((c) => {
                const v = r[c.key];
                if (c.jenis === "rs") return <td key={c.key} className="max-w-[280px] px-2 py-1"><span className="block text-[#e5e8eb]">{String(v)}</span><span className="text-[10px] text-[#8f99a8]">{String(r.provinsi ?? "")}</span></td>;
                if (c.jenis === "kelompok") return <td key={c.key} className="px-2 py-1"><span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-[#111418]" style={{ background: GROUP_COLOR[String(v)] ?? MUTED }}>{String(v)}</span></td>;
                if (c.jenis === "rp") return <td key={c.key} className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-white">{val(Number(v) || 0, "rp")}</td>;
                if (c.jenis === "tsm") return <td key={c.key} className="whitespace-nowrap px-2 py-1"><TsmRingkas v={v} /></td>;
                if (c.jenis === "jalur") return <td key={c.key} className="px-2 py-1"><JalurChip v={v} /></td>;
                return <td key={c.key} className="px-2 py-1 text-[#d3d8de]">{String(v ?? "")}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What survived each check: a meter per check, and the ML model card under it. */
function Checks({ x }: { x: Exhibit }) {
  const card = Object.entries((x.model ?? {}) as Rec).filter(([, v]) => v && typeof v === "object") as [string, Rec][];
  return (
    <div>
      <div className="space-y-2">
        {x.baris.map((r, i) => {
          const ok = Number(r.lolos) || 0, n = Number(r.total) || 0;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,40%)_1fr] items-center gap-3 text-[11.5px]">
              <span className="leading-snug text-[#d3d8de]">{String(r.uji)}</span>
              <span className="flex items-center gap-2">
                <span className="relative h-[10px] flex-1 rounded-[4px]" style={{ background: TRACK }}>
                  <span className="absolute inset-y-0 left-0 rounded-[4px]" style={{ width: `${n ? (100 * ok) / n : 0}%`, background: SERIES[2] }} />
                </span>
                <span className="w-24 shrink-0 tabular-nums text-[#e5e8eb]">{idn(ok)} dari {idn(n)}{n ? ` · ${idn((100 * ok) / n, 0)}%` : ""}</span>
              </span>
            </div>
          );
        })}
      </div>
      {card.length > 0 && (
        <table className="mt-3 w-full text-[11px]">
          <thead className="text-left text-[#8f99a8]"><tr><th className="py-0.5 font-normal">Model ML per segmen</th><th className="font-normal">Teknik</th><th className="text-right font-normal">AUPRC</th><th className="text-right font-normal">Presisi</th><th className="text-right font-normal">Recall</th></tr></thead>
          <tbody>
            {card.map(([k, v]) => (
              <tr key={k} className="border-t border-white/5 text-[#d3d8de]">
                <td className="py-0.5">{k.replace(/_/g, " ")}</td><td>{String(v.terbaik ?? "—")}</td>
                <td className="text-right tabular-nums">{v.auprc != null ? idn(Number(v.auprc), 3) : "—"}</td>
                <td className="text-right tabular-nums">{v.presisi != null ? `${idn(100 * Number(v.presisi), 1)}%` : "—"}</td>
                <td className="text-right tabular-nums">{v.recall != null ? `${idn(100 * Number(v.recall), 1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the IoMT chapter
// (api/aip/laporan_iomt.py: a synthetic world of fictional hospitals, kept with the engagement; the chapter says so first)

const DISPUTE = SERIES[1], CLARIFY = SERIES[3];

/** The audit's steps in order, each with its count and what it was made of. */
function Alur({ x }: { x: Exhibit }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {x.baris.map((r, i) => (
        <li key={i} className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">{i + 1}. {String(r.tahap)}</p>
          <p className="mt-1 text-[20px] font-semibold tabular-nums leading-tight text-white">{idn(Number(r.nilai) || 0)}</p>
          <p className="text-[11px] text-[#abb3bf]">{String(r.satuan)}</p>
          {r.rincian ? <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">{String(r.rincian)}</p> : null}
        </li>
      ))}
    </ol>
  );
}

/** Claims per row split into the two outcomes (disputed, to clarify), with the estimated overbilling beside them. */
function Hasil({ x }: { x: Exhibit }) {
  const { box, tip, at, clear } = useTip();
  const top = Math.max(1, ...x.baris.map((r) => (Number(r.disanggah) || 0) + (Number(r.klarifikasi) || 0)));
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-[#c5cbd3]">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: DISPUTE }} />disanggah</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: CLARIFY }} />perlu klarifikasi</span>
      </div>
      <div className="grid grid-cols-[minmax(0,34%)_1fr_auto] items-center gap-x-3 gap-y-1.5">
        {x.baris.map((r, i) => {
          const d = Number(r.disanggah) || 0, k = Number(r.klarifikasi) || 0, rp = Number(r.estimasi_rp) || 0;
          return (
            <div key={i} className="contents" onPointerMove={(e) => at(e, { title: String(r.label), lines: [
              { key: DISPUTE, value: idn(d), label: "disanggah" }, { key: CLARIFY, value: idn(k), label: "perlu klarifikasi" },
              ...(rp ? [{ value: val(rp, "rp"), label: "estimasi kelebihan tagihan" }] : []), ...(r.cakupan ? [{ value: String(r.cakupan), label: "" }] : [])] })}>
              <span className="truncate text-[11.5px] text-[#d3d8de]" title={String(r.label)}>{String(r.label)}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-[14px] shrink-0 gap-[2px] overflow-hidden rounded-r-[4px]" style={{ width: `${Math.max(1, (80 * (d + k)) / top)}%` }}>
                  {d > 0 && <span className="h-full" style={{ width: `${(100 * d) / (d + k)}%`, background: DISPUTE }} />}
                  {k > 0 && <span className="h-full" style={{ width: `${(100 * k) / (d + k)}%`, background: CLARIFY }} />}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[#e5e8eb]">{idn(d + k)}</span>
              </span>
              <span className="text-right text-[11px] tabular-nums text-[#abb3bf]">{rp ? val(rp, "rp") : "—"}</span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// the billed bar's hatch and the colours of the per-claim IoT tab's "Waktu dipakai vs waktu ditagih" (IotKlaim), so both read alike
const TAGIH_IOT = "#8e9cad", GARIS_TAGIH = "repeating-linear-gradient(135deg, rgba(255,255,255,.22) 0 2px, transparent 2px 6px)";
const UKUR_IOT = "#3987e5", MERAH_IOT = "#ff7d9c", HIJAU_IOT = "#7ee2c0";
// standby hours are not drawn: the chart says how long the device ran (the user, 2026-11-15: "gausah ada jam standby")
const SIAGA_RE = /siaga|standby|idle/i;
const angkaIot = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 1 });
const tglIot = (s: string) => { const d = new Date(`${s.slice(0, 10)}T00:00:00`); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }); };
// a measure's label in plain words, after "Terukur · "
const LABEL_UKUR: Record<string, string> = {
  "Ventilator jalan berturut-turut terpanjang": "jalan tanpa putus terpanjang", "Ventilator jalan total": "total jalan",
  "Hari ICU": "hari ICU (monitor menyala)", "Sesi dialisis berjalan": "mesin dialisis berjalan",
};
const labelUkur = (l: string) => LABEL_UKUR[l] ?? l.charAt(0).toLowerCase() + l.slice(1);

function BatangIot({ label, nilai, children }: { label: string; nilai: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]"><span className="text-[#c3ccd7]">{label}</span><b className="whitespace-nowrap tabular-nums text-white">{nilai}</b></div>
      {children}
    </div>
  );
}

/** Each example claim the way a layperson reads it (the user, 2026-11-15: "orang bakal lebih paham kalau grafik nya se simpel ini"):
 *  what happened in one sentence; then the time billed against the time the device measured, on one scale with the rule's threshold
 *  through every bar; one verdict sentence and the verifier's step. The device's hour-by-hour record and the separate checks stay
 *  behind a toggle. */
function IomtKlaim({ x }: { x: Exhibit }) {
  return <div className="grid gap-3 lg:grid-cols-2">{(x.klaim ?? []).map((c) => <KartuIomt key={c.id} c={c} />)}</div>;
}

function KartuIomt({ c }: { c: IomtClaim }) {
  const [rinci, setRinci] = useState(false);
  const u0 = c.ukuran[0];
  const sat = u0?.satuan ?? "jam";
  // the measures on the first one's unit: the billed amount once, then each measured running time; the total is left out when it is
  // the longest run itself (one bar says it)
  const ukur = c.ukuran.filter((u, i) => u.satuan === sat && !u.siaga && !SIAGA_RE.test(u.label)
    && !(i > 0 && u0?.berturut && /total/i.test(u.label) && Math.abs(u.terukur - (u0?.terukur ?? 0)) < 0.5));
  const ambang = u0?.ambang ?? null, t0 = u0?.terukur ?? 0;
  // what the bill claims: a code with a threshold (96.72: >= 96 h) claims at least that, whatever hours the claim records; a claim
  // recording fewer hours than its code implies is said to be inconsistent under the bar (the user, 2026-11-15: "ditagih >96 jam
  // tapi kenapa bar chart abu nya 35 jam")
  const jamKlaim = u0?.ditagih ?? 0, tak_konsisten = ambang != null && jamKlaim < ambang, tagih = tak_konsisten ? ambang : jamKlaim;
  const maks = Math.max(1, ambang ?? 0, tagih, ...ukur.map((u) => u.terukur)) * 1.08;
  const xp = (v: number) => Math.min(100, (100 * Math.max(0, v)) / maks);
  const xa = ambang != null ? xp(ambang) : null;
  const tanpaPutus = u0?.berturut ? " tanpa putus" : "";
  const [kalimat, warna] = !u0 ? ["", TAGIH_IOT]
    : ambang != null ? (t0 < ambang
      ? [`Alat ${u0.berturut ? "jalan paling lama " : "tercatat "}${angkaIot(t0)} ${sat}${tanpaPutus}: kurang ${angkaIot(ambang - t0)} ${sat} dari syarat ≥ ${angkaIot(ambang)} ${sat}${u0.berturut ? " berturut-turut" : ""}.`, MERAH_IOT]
      : [`Alat ${angkaIot(t0)} ${sat}${tanpaPutus}: memenuhi syarat ≥ ${angkaIot(ambang)} ${sat}.`, HIJAU_IOT])
    : tagih > t0 * 1.15 + 1 ? [`Alat tercatat ${angkaIot(t0)} ${sat}, ${angkaIot(tagih - t0)} ${sat} lebih sedikit dari yang ditagih (${angkaIot(tagih)} ${sat}).`, MERAH_IOT]
    : ["Pemakaian alat cocok dengan yang ditagih.", HIJAU_IOT];
  const trek = (isi: ReactNode) => (
    <div className="relative h-3.5 rounded-[3px] bg-[#202b38]">
      {isi}
      {xa != null && <span className="absolute -bottom-1 -top-1 border-l border-dashed border-white/80" style={{ left: `${xa}%` }} />}
    </div>
  );
  const warnaHasil = c.hasil === "disanggah" ? DISPUTE : CLARIFY;
  const tl = c.garis_waktu;
  const adaRinci = !!(tl && tl.series.length > 0) || c.temuan.length > 1 || !!c.dx;
  return (
    <section className="rounded-lg border border-white/[.08] bg-black/20 p-3.5 text-[12px]">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono font-semibold text-white">{c.id}</span>
        <span className="rounded px-1 text-[10px] font-medium" style={{ color: warnaHasil, border: `1px solid ${warnaHasil}` }}>{c.hasil}</span>
        {/* a mismatch can leave the INA-CBG package unchanged (the code is wrong, the tariff the same): said, not hidden */}
        {c.estimasi_rp > 0
          ? <span className="ml-auto text-right"><b className="tabular-nums text-[#ffb59a]">{val(c.estimasi_rp, "rp")}</b><span className="ml-1 text-[10.5px] text-[#8f99a8]">selisih tarif</span></span>
          : <span className="ml-auto text-[10.5px] text-[#8f99a8]" title="Kode yang ditagih tidak sesuai alat, tetapi paket INA-CBG-nya sama, jadi tarifnya tidak berubah">tanpa selisih tarif</span>}
      </p>
      <p className="mt-0.5 text-[11px] text-[#8f99a8]">{c.faskes} · {c.jenis.toLowerCase()} {tglIot(c.masuk)}{c.pulang && c.pulang !== c.masuk ? ` s.d. ${tglIot(c.pulang)}` : ""}</p>
      <p className="mt-2 text-[13px] font-medium leading-snug text-white">{c.judul}</p>
      {u0 && (
        <div className="mt-3 space-y-2.5 rounded-md border border-white/[.06] bg-[#151a1f] p-3" aria-label="Waktu dipakai dibanding waktu ditagih">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]">Waktu dipakai vs waktu ditagih</p>
            <span className="ml-auto flex gap-2.5 text-[10.5px] text-[#8e9cad]">
              <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px]" style={{ background: TAGIH_IOT, backgroundImage: GARIS_TAGIH }} />ditagih</span>
              <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px]" style={{ background: UKUR_IOT }} />terukur alat</span>
            </span>
          </div>
          {xa != null && ambang != null && (
            <div className="relative h-3.5 text-[10px] text-[#e6ecf2]">
              <span className="absolute whitespace-nowrap" style={{ left: `${xa}%`, transform: xa > 70 ? "translateX(-100%)" : "translateX(-50%)" }}>ambang {angkaIot(ambang)} {sat}</span>
            </div>
          )}
          <BatangIot label={`Ditagih${u0.kode ? ` · kode ${u0.kode}` : ""}${ambang != null ? ` (syarat ≥ ${angkaIot(ambang)} ${sat})` : ""}`}
            nilai={tak_konsisten ? `≥ ${angkaIot(tagih)} ${sat}${u0.berturut ? " berturut-turut" : ""}` : `${angkaIot(tagih)} ${sat}${u0.berturut ? " berturut-turut" : ""}`}>
            {trek(<div className="h-3.5 rounded-[3px]" style={{ width: `${xp(tagih)}%`, background: TAGIH_IOT, backgroundImage: GARIS_TAGIH, opacity: 0.85 }} />)}
            {tak_konsisten && <p className="text-[10.5px] leading-snug text-[#f2b35a]">Klaim hanya mencatat {angkaIot(jamKlaim)} {sat}: kode dan jamnya tidak konsisten.</p>}
          </BatangIot>
          {ukur.map((u) => (
            <BatangIot key={u.label} label={`Terukur · ${labelUkur(u.label)}`} nilai={`${angkaIot(u.terukur)} ${sat}`}>
              {trek(<div className="h-3.5 rounded-[3px]" style={{ width: `${u.terukur > 0 ? Math.max(0.8, xp(u.terukur)) : 0}%`, background: UKUR_IOT }} />)}
            </BatangIot>
          ))}
          <p className="text-[12px] font-medium leading-snug" style={{ color: warna }}>{kalimat}</p>
        </div>
      )}
      {c.langkah && <p className="mt-2.5 text-[11.5px] leading-snug text-[#d3d8de]"><b className="font-semibold text-white">Yang perlu dilakukan: </b>{c.langkah}</p>}
      {adaRinci && (
        <div className="mt-2">
          <button onClick={() => setRinci((v) => !v)} className="lp-no-print text-[11px] text-[#9d8cff] hover:text-[#c9c0ff]">
            {rinci ? "Sembunyikan catatan alat" : "Lihat catatan alat per jam"}
          </button>
          {rinci && (
            <div className="mt-2 space-y-2 border-t border-white/[.06] pt-2">
              {c.dx && <p className="text-[10.5px] text-[#8f99a8]">Diagnosis {c.dx}{c.keparahan ? ` · keparahan ${c.keparahan}` : ""}</p>}
              {tl && tl.series.length > 0 && (
                <div className="space-y-1">
                  {tl.series.filter((sr) => !SIAGA_RE.test(`${sr.metric} ${sr.label}`)).map((sr) => (
                    <div key={sr.metric}>
                      <p className="text-[10.5px] text-[#abb3bf]">{sr.label}{sr.note && <span className="ml-1 font-mono text-[10px] text-[#fbd38d]">{sr.note}</span>}</p>
                      <div className="flex gap-[2px]">
                        {sr.cells.map((v, i) => <span key={i} className="h-3 flex-1 rounded-[2px]" title={v === null ? "tidak ada pembacaan" : `${Math.round(v * 100)}% menyala`}
                          style={{ background: v === null ? "rgba(143,153,168,.15)" : `rgba(45,212,191,${0.12 + 0.88 * v})` }} />)}
                      </div>
                    </div>
                  ))}
                  <div className="relative h-2.5">
                    <span className="absolute top-0 h-2 rounded-sm border border-[#fbd38d]/70 bg-[#fbd38d]/20" title="masa rawat seperti ditagih"
                      style={{ left: `${(100 * (tl.claimedFrom - tl.from)) / (tl.to - tl.from)}%`, width: `${Math.max(1, (100 * (tl.claimedTo - tl.claimedFrom)) / (tl.to - tl.from))}%` }} />
                  </div>
                  <p className="text-[10px] text-[#8f99a8]">Kotak terang = jam alat menyala; garis kuning = masa yang ditagih.</p>
                </div>
              )}
              {c.temuan.length > 1 && (
                <ul className="space-y-0.5 text-[10.5px] text-[#c5cbd3]">
                  {c.temuan.map((f, i) => <li key={i}><span style={{ color: f.hasil === "disanggah" ? DISPUTE : CLARIFY }}>{f.hasil}</span> · {f.judul}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Chart({ x }: { x: Exhibit }) {
  switch (x.jenis) {
    case "alur": return <Alur x={x} />;
    case "hasil": return <Hasil x={x} />;
    case "iomt_klaim": return <IomtKlaim x={x} />;
    case "bar": return <Bars x={x} />;
    case "pareto": return <Pareto x={x} />;
    case "groups": return <Groups x={x} />;
    case "stacked": return <Stacked x={x} />;
    case "bar_rate": return <Paired x={x} />;
    case "strength": return <Strength x={x} />;
    case "line": return <TrendLine rows={x.baris} x="bulan" value="nilai" />;
    case "table": return <Facilities x={x} />;
    case "checks": return <Checks x={x} />;
    default: return <DataTable rows={x.baris} fields={Object.keys(x.baris[0] ?? {})} />;
  }
}

// ------------------------------------------------------------------------------------------------ the report

/** One exhibit: its number and measure, the action title, the chart (or its table), what it shows, why it matters, the
 *  implication, the source. */
export function ExhibitCard({ x, note, berkas }: { x: Exhibit; note?: { makna?: string; implikasi?: string }; berkas?: CaseFile[] }) {
  const [table, setTable] = useState(false);
  return (
    <figure id={`exhibit-${x.id}`} className="lp-kartu scroll-mt-4 rounded-lg border border-white/[.08] bg-[#1c2127] p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#9d8cff]">Exhibit {x.nomor}</p>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug text-white">{x.judul}</h3>
          <p className="mt-0.5 text-[11.5px] text-[#8f99a8]">{x.ukuran}</p>
        </div>
        {x.jenis !== "table" && (
          <div className="lp-no-print flex shrink-0 rounded border border-white/10 p-0.5 text-[10.5px]">
            {[false, true].map((t) => (
              <button key={String(t)} onClick={() => setTable(t)} className={`rounded-sm px-1.5 py-0.5 ${table === t ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{t ? "Tabel" : "Grafik"}</button>
            ))}
          </div>
        )}
      </div>
      {/* where: the provinces on a map above their ranked bars (the user, 2026-10-28: "geospatial mapping … ga ngehilangin ini") */}
      {x.id === "wilayah" && <div className="mt-4"><PetaProvinsi x={x} berkas={berkas} onFile={openFile} /></div>}
      {/* a branch report's map: its kab/kota and hospitals (synthetic coordinates); a hospital opens its case file */}
      {x.peta && <div className="mt-4"><PetaCabang peta={x.peta} onFile={openFile} /></div>}
      <div className="mt-4 min-w-0">{table ? <DataTable rows={x.baris} fields={Object.keys(x.baris[0] ?? {})} /> : <Chart x={x} />}</div>
      <div className={`mt-4 grid gap-4 border-t border-white/[.06] pt-3 ${note ? "md:grid-cols-[1.2fr_1fr]" : ""}`}>
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">Yang terlihat</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-justify [text-justify:inter-word] text-[12px] leading-relaxed text-[#d3d8de]">{x.fakta.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
        {note && (
          <div className="space-y-2">
            {note.makna && <div><p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">Mengapa penting</p><p className="mt-1 text-justify [text-justify:inter-word] text-[12px] leading-relaxed text-[#e5e8eb]">{note.makna}</p></div>}
            {note.implikasi && <div className="lp-implikasi rounded border-l-2 border-[#9d8cff] bg-[#9d8cff]/[.07] px-2.5 py-1.5"><p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#c9c0ff]">Implikasi</p><p className="mt-0.5 text-justify [text-justify:inter-word] text-[12px] leading-relaxed text-white">{note.implikasi}</p></div>}
          </div>
        )}
      </div>
      {/* each measure in a sentence a leader reads without the method (written by code, with the measured numbers) */}
      {!!x.pimpinan?.length && (
        <div className="lp-pimpinan mt-3 rounded border border-[#29a383]/30 bg-[#29a383]/[.06] px-3 py-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#7ee2c0]">Executive summary</p>
          <dl className="mt-1.5 grid gap-x-4 gap-y-1.5 text-[12px] leading-relaxed md:grid-cols-2">
            {x.pimpinan.map((m) => (
              <div key={m.metrik}>
                <dt className="font-medium text-white">{m.metrik} <span className="tabular-nums text-[#7ee2c0]">{m.nilai}</span></dt>
                <dd className="text-[#d3d8de]">{m.arti}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <figcaption className="mt-3 text-[10.5px] text-[#8f99a8]">Sumber: {x.sumber}</figcaption>
    </figure>
  );
}

/** The long report of an engagement. `fallback` is shown when it cannot be built (an engagement from before the report).
 *  `print`: the print page — light on A4, every case file open, no controls; it says when it is drawn. */
export function LaporanLengkap({ run, verdict, full = false, fallback, print = false }: { run: string; verdict?: Rec | null; full?: boolean;
  fallback?: ReactNode; print?: boolean }) {
  const [rep, setRep] = useState<FullReport | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  // the print page tells the renderer (api/report_render.py `ready`) when the report is in the page, or that it is not
  useEffect(() => {
    if (!print) return;
    // the case file with the largest loss draws its data lineage after a read of its own: the PDF waits for it too
    const top = (rep?.berkas ?? []).reduce<NonNullable<FullReport["berkas"]>[number] | null>((b, f) => (!b || f.kerugian.estimasi_rp > b.kerugian.estimasi_rp ? f : b), null);
    if (top?.klaim.length && !document.documentElement.dataset.jejak) document.documentElement.setAttribute("data-jejak", "memuat");
    if (rep) requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.setAttribute("data-laporan", "siap")));
    else if (err) document.documentElement.setAttribute("data-laporan", "gagal");
  }, [print, rep, err]);
  // the PDF, drawn by the API as this user (a minute at most), saved under the report's name
  const downloadPdf = async () => {
    setPdfBusy(true); setErr("");
    try {
      const url = URL.createObjectURL(await fraud.reportPdf(run));
      const a = document.createElement("a");
      a.href = url; a.download = `Laporan AI Agent Swarm - ${run}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setErr((e as Error).message); } finally { setPdfBusy(false); }
  };
  useEffect(() => {
    let live = true;
    fraud.fullReport(run).then((r) => { if (live) setRep(r); }).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [run]);
  // while the commentary is written (about a minute), the report is read again until it has it
  useEffect(() => {
    if (rep?.narasi_status !== "menulis") return;
    const t = setTimeout(() => { fraud.fullReport(run).then(setRep).catch(() => {}); }, 6000);
    return () => clearTimeout(t);
  }, [rep, run]);
  const byId = useMemo(() => Object.fromEntries((rep?.exhibit ?? []).map((x) => [x.id, x])), [rep]);
  const write = async () => {
    setBusy(true); setErr("");
    try {
      await fraud.writeNotes(run);
      setRep((r) => (r ? { ...r, narasi_status: "menulis" } : r));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (err && !rep) return fallback ? <>{fallback}</> : <p className="p-4 text-[12px] text-[#ffb4b4]">Laporan lengkap tidak terbaca: {err}</p>;
  if (!rep) return <p className="p-6 text-center text-[12px] text-[#8f99a8]">Menyusun laporan lengkap: exhibit dihitung dari Box Karantina, buku besar indikasi dan klaim berisiko…</p>;
  const skala = byId.skala;
  const chapters = rep.bab.filter((b) => b.bagian.length || b.exhibit.length || (b.id === "kasus" && rep.berkas?.length));
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    // one width for the cover, the contents and the chapters, so text and exhibits share their edges (the user, 2026-10-24:
    // "kenapa report nya ga rata ya paragraf sama diagram nya")
    <div className={`mx-auto w-full ${print ? "laporan-cetak max-w-[1000px]" : full ? "max-w-[1280px] px-4 py-8" : "max-w-[1280px]"}`}>
      {print && <style>{PRINT_CSS}</style>}
      {/* the cover */}
      <header className="lp-sampul rounded-lg border border-white/[.08] bg-[radial-gradient(ellipse_at_20%_0%,#2a2f45_0%,#1c2127_60%)] p-6">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.2em] text-[#9d8cff]">Laporan penugasan · AI Agent Swarm</p>
        <h1 className="mt-2 max-w-[860px] text-[24px] font-semibold leading-tight text-white">{rep.judul}</h1>
        <p className="mt-2 text-[12px] text-[#abb3bf]">
          {rep.selesai ? `Selesai ${wib(rep.selesai)}` : `Dimulai ${wib(rep.mulai)}`} · {idn(rep.agen)} agen dan instans · biaya model ${idn(rep.biaya_usd ?? 0, 2)} · penugasan {rep.run}
          {verdict?.total ? ` · validator laporan ${String(verdict.passed)}/${String(verdict.total)}` : ""}
        </p>
        {print && <p className="mt-1 text-[11px] text-[#8f99a8]">Dicetak {wib(new Date().toISOString())} · angka dihitung kode dari hasil penugasan; indikasi, bukan putusan fraud.</p>}
        {rep.beku_pada && (
          <p className="mt-2 text-[11.5px] text-[#8f99a8]">Exhibit dan berkas kasus dibekukan saat penugasan selesai ({wib(rep.beku_pada)}): penugasan berikutnya tidak mengubah laporan ini.</p>
        )}
        {rep.salinan_dari && <p className="mt-1 text-[11.5px] text-[#8f99a8]">Salinan hasil penugasan {rep.salinan_dari}: angka, bab dan berkas kasusnya sama persis.</p>}
        {rep.iomt && (() => {
          const n = rep.bab.filter((b) => b.bagian.length || b.exhibit.length || (b.id === "kasus" && rep.berkas?.length)).findIndex((b) => b.id === rep.iomt?.bab) + 1;
          return (
            <p className="mt-2 rounded border-l-2 border-[#2dd4bf] bg-[#2dd4bf]/[.07] px-2 py-1 text-[11.5px] text-[#d3d8de]">
              Bab {n} menambahkan bukti perangkat medis (IoMT). Datanya <b className="text-white">sintetis</b>, dari rumah sakit fiktif. Angkanya terpisah dari temuan Data Sampel BPJS dan tidak masuk estimasi kerugian di atas.
            </p>
          );
        })()}
        {!rep.beku_pada && rep.basis && rep.basis !== rep.run && (
          <p className="mt-2 rounded bg-[#fab219]/10 px-2 py-1 text-[11.5px] text-[#fbd38d]">Exhibit dihitung dari Box Karantina dan buku besar terkini, milik penugasan {rep.basis}; teks bab adalah tulisan penugasan ini.</p>
        )}
        {skala && (
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {skala.baris.map((r, i) => (
              <div key={i} className="rounded-md border border-white/[.08] bg-black/20 px-3 py-2.5">
                <p className="text-[22px] font-semibold tabular-nums text-white">{val(Number(r.nilai) || 0, "rp")}</p>
                <p className="text-[11px] leading-snug text-[#abb3bf]">{String(r.label)}</p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
          {rep.narasi_status === "ada" ? (
            <span className="text-[#8f99a8]">Penjelasan exhibit ditulis {rep.narasi_oleh === "analis_exhibit" ? "analis exhibit swarm" : "model penulis"} ({modelName(rep.narasi_model ?? "")}) {wib(rep.narasi_pada)}; angka setiap kalimat dicek kode
              {rep.narasi_dibuang ? ` (${rep.narasi_dibuang} kalimat dibuang: angkanya tidak ada di fakta exhibit)` : ""}.</span>
          ) : rep.narasi_status === "menulis" ? (
            <span className="flex items-center gap-1.5 text-[#c9c0ff]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#b8a9ff]" />Menulis penjelasan tiap exhibit (sekitar satu menit)…</span>
          ) : (
            <>
              {rep.narasi_status === "gagal" && <span className="max-w-[640px] text-[#ffb4b4]">Penjelasan exhibit gagal ditulis: {rep.narasi_galat}</span>}
              <button disabled={busy} onClick={write} title="model penulis menjelaskan makna dan implikasi tiap exhibit; kalimat yang angkanya tidak ada di fakta exhibit dibuang kode (admin)"
                className="lp-no-print flex items-center gap-1 rounded border border-[#9d8cff]/50 px-2 py-0.5 text-[#c9c0ff] hover:bg-[#9d8cff]/10 disabled:opacity-40">
                <Icon name="sparkle" className="h-3 w-3" />{rep.narasi_status === "gagal" ? "Coba lagi" : "Tulis penjelasan exhibit"}
              </button>
            </>
          )}
          {!print && (
            <button disabled={pdfBusy} onClick={downloadPdf} title="laporan lengkap sebagai PDF A4 (terang), semua berkas kasus terbuka; dibuat server sebagai Anda"
              className="lp-no-print ml-auto flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/5 disabled:opacity-50">
              <Icon name="download" className="h-3 w-3" />{pdfBusy ? "Menyiapkan PDF… (±30 detik)" : "Unduh PDF"}
            </button>
          )}
          {!full && !print && (
            <a href={`/aip-jkn/laporan?run=${rep.run}`} target="_blank" rel="noreferrer" className="lp-no-print flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/5">
              <Icon name="external" className="h-3 w-3" />Buka halaman penuh
            </a>
          )}
          {err && <span className="text-[#ffb4b4]">{err}</span>}
        </div>
      </header>

      <div className={print ? "mt-5" : "mt-5 grid gap-6 xl:grid-cols-[220px_1fr]"}>
        {/* the contents: beside the report on screen, its own block under the cover on paper */}
        <nav className={print ? "mb-2 max-w-[520px]" : "max-xl:hidden"}>
          <div className={print ? "space-y-0.5 text-[11.5px]" : "sticky top-3 space-y-0.5 text-[11.5px]"}>
            <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[#8f99a8]">Isi</p>
            {chapters.map((b, i) => (
              <div key={b.id}>
                <button onClick={() => go(`bab-${b.id}`)} className="w-full rounded px-1.5 py-1 text-left text-[#d3d8de] hover:bg-white/5 hover:text-white">
                  <span className="mr-1.5 tabular-nums text-[#8f99a8]">{i + 1}</span>{b.judul}
                </button>
                {b.exhibit.length > 0 && (
                  <p className="pl-6 text-[10.5px] text-[#8f99a8]">Exhibit {b.exhibit.map((e) => byId[e]?.nomor).filter(Boolean).join(", ")}</p>
                )}
                {b.id === "kasus" && rep.berkas?.length ? <p className="pl-6 text-[10.5px] text-[#8f99a8]">{rep.berkas.length} berkas faskes</p> : null}
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-10">
          {chapters.map((b, i) => (
            <section key={b.id} id={`bab-${b.id}`} className="lp-bab scroll-mt-4">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#8f99a8]">Bab {i + 1}</p>
              <h2 className="mt-1 border-b border-white/10 pb-2 text-[19px] font-semibold text-white">{b.judul}</h2>
              {b.bagian.map((s) => (
                <div key={s.id} className="mt-3 text-justify [text-justify:inter-word] text-[12.5px] leading-relaxed text-[#d3d8de]">
                  {b.bagian.length > 1 && s.judul.toLowerCase() !== b.judul.toLowerCase() && <p className="mb-1 text-[12px] font-semibold text-[#e5e8eb]">{s.judul}</p>}
                  <Markdown text={s.teks} />
                </div>
              ))}
              <div className="mt-4 space-y-4">
                {b.exhibit.map((e) => byId[e] && <ExhibitCard key={e} x={byId[e]} note={rep.narasi?.[e]} berkas={rep.berkas} />)}
              </div>
              {b.id === "kasus" && rep.berkas?.length ? <CaseFiles files={rep.berkas} note={rep.catatan_dpjp} print={print} run={rep.run} /> : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
