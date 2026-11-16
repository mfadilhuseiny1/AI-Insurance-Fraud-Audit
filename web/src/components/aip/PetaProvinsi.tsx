"use client";
import { useEffect, useMemo, useState } from "react";
import type { Rec } from "@/components/aip/aipRun";
import type { CaseFile, Exhibit } from "@/components/aip/fraudApi";
import { compact, SERIES, Tooltip, useTip } from "@/components/aip/viz";

/* The province map of the long report's "where" exhibit (the user, 2026-10-28: a geospatial map of how it spreads over the
   provinces, interactive, easy on an executive's eye — beside the ranked bars, which stay). The 38 provinces
   (public/geo/provinsi.json: geoBoundaries IDN ADM2 from BPS, WFP and OCHA ROAP, CC BY 3.0 IGO, merged into the 38
   provinces by BPJS's own kab/kota table, Papua split as of 2022) shaded by the estimated loss or by the risky claims per
   1.000 FKRTL claims, in five classes; the three largest named on the map; a province's figures and its case files on
   a click. */

type Shape = { provinsi: string; kode: number; titik: [number, number]; rings: [number, number][][] };
type Row = { provinsi: string; loss: number | null; share: number | null; rate: number | null; fac: number | null; fk: number | null; kb: number | null };
type Measure = "kerugian" | "rasio";

let shapes: Promise<Shape[]> | null = null;
const loadShapes = () => (shapes ??= fetch("/geo/provinsi.json").then((r) => (r.ok ? r.json() : { provinsi: [] })).then((d) => d.provinsi ?? []).catch(() => []));

// Indonesia's extent, drawn plate carrée (near the equator the distortion is small)
const W0 = 94.8, E0 = 141.2, N0 = 6.3, S0 = -11.2, K = 20;
const VW = (E0 - W0) * K, VH = (N0 - S0) * K;
const px = (lon: number) => (lon - W0) * K;
const py = (lat: number) => (N0 - lat) * K;
// five classes, darkest the least: the loss in the bars' blue, the rate in their green
const RAMP: Record<Measure, string[]> = {
  kerugian: ["#1b324f", "#21507f", "#2c6db5", "#4b92e3", "#9cc7ff"],
  rasio: ["#163a30", "#1b5745", "#20795d", "#2fa679", "#86e3c1"],
};
const NONE = "#262c34";
// on paper (the report's print page, .laporan-cetak): the same classes light to dark, white borders, dark labels
const PAPER: Record<Measure, string[]> = {
  kerugian: ["#dbe9fb", "#b3d1f5", "#7fb0ea", "#4a86d4", "#1f5aa6"],
  rasio: ["#d9f3e9", "#ace4cf", "#72cba9", "#38a57d", "#17734f"],
};
const PRINT_CSS = [
  ...(["kerugian", "rasio"] as const).flatMap((m) => PAPER[m].map((c, i) => `.laporan-cetak [data-m="${m}"][data-k="${i}"] { fill: ${c}; background: ${c} !important; }`)),
  `.laporan-cetak [data-k="none"] { fill: #eef0f3; background: #eef0f3 !important; }`,
  `.laporan-cetak [data-provinsi] { stroke: #ffffff; }`,
  `.laporan-cetak .lp-peta-label { fill: #111418; stroke: #ffffff; }`,
].join(" ");
const idn = (n: number, d = 0) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (n: number) => `Rp ${compact(n)}`;
const nameOf = (s: string) => s.toLowerCase().replace(/(^|[\s/(-])\p{L}/gu, (c) => c.toUpperCase()).replace(/\bDki\b/g, "DKI");

function rowsOf(x: Exhibit): { rows: Row[]; partial: boolean } {
  const peta = (x as Exhibit & { peta?: Rec[]; peta_basis?: string }).peta;
  const src = peta?.length ? peta : x.baris;
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const rows = src.map((r) => ({ provinsi: String(r.provinsi ?? "").toUpperCase(), loss: num(r.estimasi_kerugian_rp), share: num(r.porsi_pct), rate: num(r.klaim_berisiko_per_1000),
    fac: num(r.faskes_box), fk: num(r.klaim_fkrtl), kb: num(r.klaim_berisiko) }));
  return { rows, partial: !peta?.length || (x as Exhibit & { peta_basis?: string }).peta_basis === "teratas" };
}

/** class breaks: the quintiles of the positive values */
function breaksOf(values: number[]): number[] {
  const v = values.filter((n) => n > 0).sort((a, b) => a - b);
  if (!v.length) return [];
  return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
}
const classOf = (n: number, br: number[]) => br.filter((b) => n > b).length;

export function PetaProvinsi({ x, berkas, onFile }: { x: Exhibit; berkas?: CaseFile[]; onFile?: (faskesProfilId: string) => void }) {
  const [geo, setGeo] = useState<Shape[] | null>(null);
  const [measure, setMeasure] = useState<Measure>("kerugian");
  const [pick, setPick] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const { box, tip, at, clear } = useTip();
  useEffect(() => {
    let live = true;
    loadShapes().then((s) => live && setGeo(s));
    return () => {
      live = false;
    };
  }, []);
  const { rows, partial } = useMemo(() => rowsOf(x), [x]);
  const byName = useMemo(() => new Map(rows.map((r) => [r.provinsi, r])), [rows]);
  const valueOf = (r?: Row) => (r ? (measure === "kerugian" ? r.loss : r.rate) : null);
  const br = useMemo(() => breaksOf(rows.map((r) => (measure === "kerugian" ? r.loss : r.rate) ?? 0)), [rows, measure]);
  const ranked = useMemo(() => [...rows].filter((r) => (valueOf(r) ?? 0) > 0).sort((a, b) => (valueOf(b) ?? 0) - (valueOf(a) ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, measure]);
  const rank = (name: string) => ranked.findIndex((r) => r.provinsi === name) + 1;
  const paths = useMemo(() => (geo ?? []).map((s) => ({ ...s, d: s.rings.map((ring) => `M${ring.map(([lo, la]) => `${px(lo).toFixed(1)},${py(la).toFixed(1)}`).join("L")}Z`).join("") })), [geo]);
  const fmt = (v: number) => (measure === "kerugian" ? rp(v) : idn(v, 2));
  // labels of the top three: right of the badge, else left, else the badge alone (neighbours like the Papua provinces)
  const callouts = useMemo(() => {
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const hit = (b: (typeof placed)[number]) => placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
    const out = [];
    for (const [i, r] of ranked.slice(0, 3).entries()) {
      const s = paths.find((p) => p.provinsi === r.provinsi);
      if (!s) continue;
      const cx = px(s.titik[0]), cy = py(s.titik[1]);
      placed.push({ x0: cx - 10, x1: cx + 10, y0: cy - 10, y1: cy + 10 });
      out.push({ provinsi: r.provinsi, n: i + 1, cx, cy, text: `${nameOf(r.provinsi)} · ${fmt(valueOf(r) ?? 0)}`, side: null as "right" | "left" | null });
    }
    for (const k of out) {
      const w = k.text.length * 8.6 + 6;
      const right = { x0: k.cx + 12, x1: k.cx + 12 + w, y0: k.cy - 11, y1: k.cy + 11 };
      const left = { x0: k.cx - 12 - w, x1: k.cx - 12, y0: k.cy - 11, y1: k.cy + 11 };
      const box = !hit(right) && right.x1 <= VW ? right : !hit(left) && left.x0 >= 0 ? left : null;
      if (box) {
        k.side = box === right ? "right" : "left";
        placed.push(box);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, paths, measure]);
  const totalLoss = rows.reduce((s, r) => s + (r.loss ?? 0), 0);
  const fkAll = rows.reduce((s, r) => s + (r.fk ?? 0), 0);
  const national = fkAll ? (1000 * rows.reduce((s, r) => s + (r.kb ?? 0), 0)) / fkAll : null;
  const sel = pick ? byName.get(pick) : undefined;
  const files = pick ? (berkas ?? []).filter((f) => f.provinsi.toUpperCase() === pick).sort((a, b) => b.kerugian.estimasi_rp - a.kerugian.estimasi_rp) : [];
  const ramp = RAMP[measure];
  const label = measure === "kerugian" ? "Estimasi kerugian" : "Klaim berisiko per 1.000 klaim FKRTL";
  const legend = br.length ? [0, ...br].map((lo, i) => ({ k: i, c: ramp[i], t: i === 0 ? `≤ ${fmt(br[0])}` : i === br.length ? `> ${fmt(br[br.length - 1])}` : `${fmt(lo)} – ${fmt(br[i])}` })) : [];

  return (
    <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]" data-lp-peta>
      <style>{PRINT_CSS}</style>
      <div ref={box} className="relative min-w-0 rounded-md border border-white/[.06] bg-black/20 p-3" onPointerLeave={() => (clear(), setHover(null))}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#abb3bf]">Peta sebaran · 38 provinsi</p>
          <div className="lp-no-print ml-auto flex rounded border border-white/10 p-0.5 text-[10.5px]">
            {(["kerugian", "rasio"] as const).map((m) => (
              <button key={m} onClick={() => (setMeasure(m), clear())} className={`rounded-sm px-2 py-0.5 ${measure === m ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`} data-lp-peta-ukuran={m}>
                {m === "kerugian" ? "Estimasi kerugian" : "Klaim berisiko / 1.000"}
              </button>
            ))}
          </div>
        </div>
        {!geo ? (
          <div className="h-[300px] animate-pulse rounded bg-white/[.03]" />
        ) : (
          <svg viewBox={`0 0 ${VW} ${VH}`} className="block h-auto w-full" role="img" aria-label={`Peta ${label} per provinsi`}>
            {paths.map((s) => {
              const r = byName.get(s.provinsi);
              const v = valueOf(r);
              const k = v && v > 0 ? classOf(v, br) : null;
              const on = pick === s.provinsi;
              return (
                <path key={s.provinsi} d={s.d} fill={k === null ? NONE : ramp[k]} data-m={measure} data-k={k ?? "none"} stroke={on ? "#fbbf24" : hover === s.provinsi ? "#ffffff" : "#0f1318"} strokeWidth={on ? 2.2 : hover === s.provinsi ? 1.6 : 0.6}
                  strokeLinejoin="round" className="cursor-pointer transition-[fill] duration-300" data-provinsi={s.provinsi}
                  onPointerMove={(e) => {
                    setHover(s.provinsi);
                    at(e, { title: nameOf(s.provinsi), lines: [
                      ...(r?.loss != null ? [{ key: SERIES[0], value: rp(r.loss), label: `estimasi kerugian${r.share != null ? ` · ${idn(r.share, 1)}%` : ""}` }] : [{ value: "—", label: partial ? "di luar 12 provinsi teratas" : "tidak ada di Box" }]),
                      ...(r?.rate != null ? [{ key: SERIES[2], value: idn(r.rate, 2), label: "klaim berisiko / 1.000 klaim FKRTL" }] : []),
                      ...(r?.fac ? [{ value: idn(r.fac), label: "faskes di Box Karantina" }] : []),
                      ...(rank(s.provinsi) ? [{ value: `#${rank(s.provinsi)}`, label: `dari ${ranked.length} provinsi menurut ${measure === "kerugian" ? "kerugian" : "rasio"}` }] : []),
                    ] });
                  }}
                  onClick={() => setPick(on ? null : s.provinsi)} />
              );
            })}
            {/* the three largest, numbered as in the list beside the map; named where the name has room */}
            {callouts.map((k) => (
              <g key={k.provinsi} className="pointer-events-none">
                <circle cx={k.cx} cy={k.cy} r={9} fill="#fbbf24" stroke="#0f1318" strokeWidth={2} />
                <text x={k.cx} y={k.cy + 4.5} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#111418">{k.n}</text>
                {k.side && (
                  <text x={k.cx + (k.side === "right" ? 14 : -14)} y={k.cy + 5.5} textAnchor={k.side === "right" ? "start" : "end"} fontSize={16} fontWeight={600}
                    fill="#ffffff" stroke="#0f1318" strokeWidth={4} paintOrder="stroke" className="lp-peta-label">{k.text}</text>
                )}
              </g>
            ))}
          </svg>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[#abb3bf]">
          <span className="text-[#8f99a8]">{label}:</span>
          {legend.map((l) => (
            <span key={l.t} className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm" data-m={measure} data-k={l.k} style={{ background: l.c }} />{l.t}</span>
          ))}
          <span className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm" data-k="none" style={{ background: NONE }} />{measure === "kerugian" && partial ? "di luar 12 teratas" : "tidak ada"}</span>
        </div>
        {partial && measure === "kerugian" && (
          <p className="mt-1 text-[10.5px] text-[#8f99a8]">Laporan beku ini menyimpan estimasi kerugian 12 provinsi teratas; rasio klaim berisiko tersedia untuk semua provinsi.</p>
        )}
        <Tooltip tip={tip} />
      </div>

      <aside className="rounded-md border border-white/[.06] bg-black/20 p-3 text-[11.5px]" data-lp-peta-panel>
        {!sel ? (
          <>
            <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">Nasional</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div><p className="text-[16px] font-semibold tabular-nums text-white">{rp(totalLoss)}</p><p className="text-[10px] text-[#8f99a8]">estimasi kerugian{partial ? " (12 teratas)" : ""}</p></div>
              <div><p className="text-[16px] font-semibold tabular-nums text-white">{national != null ? idn(national, 2) : "—"}</p><p className="text-[10px] text-[#8f99a8]">klaim berisiko / 1.000</p></div>
            </div>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">Teratas · {measure === "kerugian" ? "kerugian" : "rasio"}</p>
            <div className="mt-1 space-y-1">
              {ranked.slice(0, 6).map((r, i) => {
                const v = valueOf(r) ?? 0;
                return (
                  <button key={r.provinsi} onClick={() => setPick(r.provinsi)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-white/[.05]">
                    <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[#e5e8eb]">{i + 1}. {nameOf(r.provinsi)}</span><span className="shrink-0 tabular-nums text-white">{fmt(v)}</span></span>
                    <span className="mt-0.5 block h-[4px] rounded-full" style={{ width: `${Math.max(3, (100 * v) / (valueOf(ranked[0]) || 1))}%`, background: measure === "kerugian" ? SERIES[0] : SERIES[2] }} />
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-[10.5px] text-[#8f99a8]">Arahkan ke provinsi untuk angkanya; klik untuk rincian dan berkas kasusnya.</p>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-white">{nameOf(sel.provinsi)}</p>
              <button onClick={() => setPick(null)} className="lp-no-print rounded px-1.5 text-[10.5px] text-[#8f99a8] ring-1 ring-white/10 hover:text-white">Nasional</button>
            </div>
            <dl className="mt-2 space-y-2">
              <div>
                <dt className="text-[10px] text-[#8f99a8]">Estimasi kerugian</dt>
                <dd className="text-[16px] font-semibold tabular-nums text-white">{sel.loss != null ? rp(sel.loss) : "—"}
                  <span className="ml-1 text-[11px] font-normal text-[#abb3bf]">{sel.share != null ? `${idn(sel.share, 1)}% nasional` : partial ? "di luar 12 teratas" : ""}{sel.loss && rank(sel.provinsi) && measure === "kerugian" ? ` · #${rank(sel.provinsi)}` : ""}</span></dd>
              </div>
              <div>
                <dt className="text-[10px] text-[#8f99a8]">Klaim berisiko per 1.000 klaim FKRTL</dt>
                <dd className="text-[16px] font-semibold tabular-nums text-white">{sel.rate != null ? idn(sel.rate, 2) : "—"}
                  {sel.rate != null && national ? <span className="ml-1 text-[11px] font-normal text-[#abb3bf]">{idn(sel.rate / national, 1)}× rata-rata nasional</span> : null}</dd>
              </div>
              <div className="grid grid-cols-3 gap-2 border-t border-white/[.06] pt-2">
                <div><dd className="tabular-nums text-white">{sel.fac != null ? idn(sel.fac) : "—"}</dd><dt className="text-[10px] text-[#8f99a8]">faskes di Box</dt></div>
                <div><dd className="tabular-nums text-white">{sel.fk != null ? compact(sel.fk) : "—"}</dd><dt className="text-[10px] text-[#8f99a8]">klaim FKRTL</dt></div>
                <div><dd className="tabular-nums text-white">{sel.kb != null ? idn(sel.kb) : "—"}</dd><dt className="text-[10px] text-[#8f99a8]">klaim berisiko</dt></div>
              </div>
            </dl>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">Berkas kasus di provinsi ini</p>
            {files.length ? (
              <div className="mt-1 space-y-0.5">
                {files.slice(0, 8).map((f) => (
                  <button key={f.faskes_profil_id} onClick={() => onFile?.(f.faskes_profil_id)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-white/[.05]" title="buka berkas kasus faskes ini">
                    <span className="block truncate text-[#e5e8eb]">{f.nama.split(" · ").slice(-2).join(" · ")}</span>
                    <span className="text-[10px] tabular-nums text-[#8f99a8]">kelompok {f.kelompok} · {rp(f.kerugian.estimasi_rp)} · {f.kabkota}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[10.5px] text-[#8f99a8]">Tidak ada faskes provinsi ini di berkas kasus laporan.</p>
            )}
          </>
        )}
        <p className="mt-3 border-t border-white/[.06] pt-2 text-[9.5px] leading-snug text-[#6b7480]">Batas provinsi: geoBoundaries (BPS, WFP, OCHA ROAP; CC BY 3.0 IGO), digabung ke 38 provinsi menurut tabel kab/kota BPJS.</p>
      </aside>
    </div>
  );
}
