"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GROUP_COLOR, JALUR, type PetaKC } from "@/components/aip/fraudApi";
import { compact, SERIES, Tooltip, useTip } from "@/components/aip/viz";

/* The branch report's map (the user, 2026-11-14: "can you make audit report like this" — the national report's province map —
   "so we can add synthetic data for hospital coordinate"). The branch area's kab/kota (public/geo/kabkota/<province>.json:
   geoBoundaries IDN ADM2, CC BY 3.0 IGO, matched to BPJS's kab/kota codes by testing/geo_rs.py) shaded by the estimated loss
   or by the recommended claims per 1.000 claims, the rest of the province drawn dim for context, and every hospital as a
   point at a SYNTHETIC coordinate (a fixed-seed point inside its own kab/kota: the claims carry no address), coloured by its
   priority group and sized by its claim volume. A hospital with recommended claims opens its case file on a click.
   Since 2026-11-14 the group is the branch's Box Karantina's (A–D, Z: every hospital with at least one indication tag) with
   its TSM path; kelompok null = outside the box (no tag), drawn small and faded. Older reports (no `jalur`): kelompok null
   = no recommended claim.
   Since 2026-11-15 (the user: "bisa ga map indonesia aja, tp yg non wilayah KC kayak agak warna nya beda") the frame is the whole
   of Indonesia: the other provinces dim (public/geo/provinsi.json), the rest of the KC's province a lighter grey, the KC's
   kab/kota shaded and outlined; drag to pan, Ctrl + scroll or the buttons to zoom, "Wilayah KC" fits the branch area. */

type Shape = { kode: number; nama: string; provinsi: number; titik: [number, number]; rings: [number, number][][] };
type RS = PetaKC["rs"][number];
const KELOMPOK = ["A", "B", "C", "D", "Z"];
type Measure = "kerugian" | "rasio";

type Prov = { provinsi: string; kode: number; titik: [number, number]; rings: [number, number][][] };
let provinsi: Promise<Prov[]> | null = null;
const loadIndonesia = () => (provinsi ??= fetch("/geo/provinsi.json").then((r) => (r.ok ? r.json() : { provinsi: [] })).then((d) => d.provinsi ?? []).catch(() => []));
// Indonesia's extent, plate carree as the national province map draws it (near the equator the distortion is small)
const W0 = 94.8, E0 = 141.2, N0 = 6.3, S0 = -11.2, K = 20;
// the frame is taller than Indonesia (85 units above and below) so a tall branch area such as KC Makassar zooms in further
const VW = (E0 - W0) * K, VH = (N0 - S0) * K + 170;
const px = (lon: number) => (lon - W0) * K;
const py = (lat: number) => (N0 - lat) * K + 85;
const LAIN = "#2a313b", PROV = "#3a4452";  // other provinces; the rest of the KC's province
const cache = new Map<number, Promise<Shape[]>>();
const loadProv = (p: number) => {
  if (!cache.has(p)) cache.set(p, fetch(`/geo/kabkota/${p}.json`).then((r) => (r.ok ? r.json() : { kabkota: [] })).then((d) => d.kabkota ?? []).catch(() => []));
  return cache.get(p) as Promise<Shape[]>;
};

const RAMP: Record<Measure, string[]> = {
  kerugian: ["#1b324f", "#21507f", "#2c6db5", "#4b92e3", "#9cc7ff"],
  rasio: ["#163a30", "#1b5745", "#20795d", "#2fa679", "#86e3c1"],
};
const NONE = "#262c34", TANPA = "#8f99a8";
const idn = (n: number, d = 0) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (n: number) => `Rp ${compact(n)}`;

function breaksOf(values: number[]): number[] {
  const v = values.filter((n) => n > 0).sort((a, b) => a - b);
  if (!v.length) return [];
  return Array.from(new Set([0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))])));
}
const classOf = (n: number, br: number[]) => br.filter((b) => n > b).length;
// a hospital's path in its colour (ditindak red, dibina amber, dibebaskan green)
const JalurTeks = ({ j }: { j: string }) => <span style={{ color: JALUR[j]?.color }}>{j}</span>;
const extent = (xs: number[]) => xs.reduce(([lo, hi], x) => [Math.min(lo, x), Math.max(hi, x)], [Infinity, -Infinity]);

export function PetaCabang({ peta, onFile }: { peta: PetaKC; onFile?: (faskesProfilId: string) => void }) {
  const [geo, setGeo] = useState<Shape[] | null>(null);
  const [indo, setIndo] = useState<Prov[] | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });  // translate(x, y) scale(k) on the Indonesia frame
  const [lebar, setLebar] = useState(900);
  const [menyeret, setMenyeret] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const seret = useRef<{ x: number; y: number; vx: number; vy: number; jalan: boolean } | null>(null);
  const baruSeret = useRef(false);
  const [measure, setMeasure] = useState<Measure>("kerugian");
  const [pick, setPick] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const { box, tip, at, clear } = useTip();
  const provs = useMemo(() => Array.from(new Set(peta.kab.map((k) => Math.floor(k.kode / 100)))), [peta]);
  useEffect(() => {
    let live = true;
    Promise.all(provs.map(loadProv)).then((a) => live && setGeo(a.flat()));
    loadIndonesia().then((p) => live && setIndo(p));
    return () => { live = false; };
  }, [provs]);
  const byKab = useMemo(() => new Map(peta.kab.map((k) => [k.kode, k])), [peta]);
  const jalur = (rings: [number, number][][]) => rings.map((ring) => `M${ring.map(([lo, la]) => `${px(lo).toFixed(2)},${py(la).toFixed(2)}`).join("L")}Z`).join("");
  const paths = useMemo(() => (geo ?? []).map((s) => ({ ...s, d: jalur(s.rings) })), [geo]);
  const provPaths = useMemo(() => (indo ?? []).filter((p) => !provs.includes(p.kode)).map((p) => ({ kode: p.kode, nama: p.provinsi, d: jalur(p.rings) })), [indo, provs]);
  // the branch area's box on the frame (its kab/kota and hospitals): what "Wilayah KC" fits
  const kotak = useMemo(() => {
    const pts: [number, number][] = [...(geo ?? []).filter((s) => byKab.has(s.kode)).flatMap((s) => s.rings.flat()), ...peta.rs.map((r) => [r.lon, r.lat] as [number, number])];
    if (!pts.length) return null;
    const [x0, x1] = extent(pts.map((p) => px(p[0]))), [y0, y1] = extent(pts.map((p) => py(p[1])));
    return { x0, x1, y0, y1 };
  }, [geo, peta, byKab]);
  const fitKC = useCallback(() => {
    if (!kotak) return;
    const bw = Math.max(1, kotak.x1 - kotak.x0), bh = Math.max(1, kotak.y1 - kotak.y0);
    const k = Math.min(60, 0.88 * Math.min(VW / bw, VH / bh));
    setView({ k, x: VW / 2 - ((kotak.x0 + kotak.x1) / 2) * k, y: VH / 2 - ((kotak.y0 + kotak.y1) / 2) * k });
  }, [kotak]);
  // the map opens on the branch area (the user, 2026-11-15: "default zoom on the kantor cabang area, not whole Indonesia");
  // "Indonesia" shows the whole country
  const awalFit = useRef(false);
  useEffect(() => {
    if (!kotak || awalFit.current) return;
    const r = requestAnimationFrame(() => { awalFit.current = true; fitKC(); });
    return () => cancelAnimationFrame(r);
  }, [kotak, fitKC]);
  const zoomDi = useCallback((f: number, sx: number, sy: number) => setView((v) => {
    const k = Math.max(1, Math.min(60, v.k * f));
    const ux = (sx - v.x) / v.k, uy = (sy - v.y) / v.k;
    return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: sx - ux * k, y: sy - uy * k };
  }), []);
  // the scroll wheel zooms at the cursor (the user, 2026-11-15: "pengen bisa di zoom pake scroll"), smoothly by how far the wheel
  // turned; fully zoomed out, scrolling down lets the report scroll on, so the map never traps the page. The width keeps marks
  // a constant size.
  const kRef = useRef(1);
  useEffect(() => { kRef.current = view.k; }, [view.k]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const roda = (e: WheelEvent) => {
      if (e.deltaY > 0 && kRef.current <= 1.001) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.002));
      zoomDi(Math.max(0.5, Math.min(2, f)), ((e.clientX - r.left) / r.width) * VW, ((e.clientY - r.top) / r.height) * VH);
    };
    el.addEventListener("wheel", roda, { passive: false });
    const ro = new ResizeObserver(([x]) => setLebar(x.contentRect.width || 900));
    ro.observe(el);
    return () => { el.removeEventListener("wheel", roda); ro.disconnect(); };
  }, [indo, geo, zoomDi]);
  const upp = VW / Math.max(1, lebar) / view.k;  // frame units per screen pixel at this zoom
  const negara = view.k < 1.6;  // country scale: the branch area is small, a click zooms into it
  const valueOf = (kode: number) => { const k = byKab.get(kode); return k ? (measure === "kerugian" ? k.estimasi_kerugian_rp : k.rekomendasi_per_1000) : null; };
  const br = useMemo(() => breaksOf(peta.kab.map((k) => (measure === "kerugian" ? k.estimasi_kerugian_rp : k.rekomendasi_per_1000))), [peta, measure]);
  const fmt = (v: number) => (measure === "kerugian" ? rp(v) : idn(v, 1));
  const ramp = RAMP[measure];
  const maxKlaim = Math.max(1, ...peta.rs.map((r) => r.klaim));
  const prioritas = useMemo(() => peta.rs.filter((r) => r.rekomendasi > 0).sort((a, b) => b.estimasi_kerugian_rp - a.estimasi_kerugian_rp), [peta]);
  const nomor = new Map(prioritas.slice(0, 3).map((r, i) => [r.id, i + 1]));
  // the branch's Box Karantina on the map (reports with a path per hospital): a member is any hospital with a group
  const boxMode = useMemo(() => peta.rs.some((r) => r.jalur != null), [peta]);
  const anggota = (r: RS) => (boxMode ? r.kelompok != null : r.rekomendasi > 0);
  // outside the box under, members without recommended claims over them, the priority ones on top (largest loss last)
  const lapis = (r: RS) => (r.rekomendasi > 0 ? 2 : anggota(r) ? 1 : 0);
  const titik = [...peta.rs].sort((a, b) => lapis(a) - lapis(b) || a.estimasi_kerugian_rp - b.estimasi_kerugian_rp);
  const grupJalur = (r: RS) => (r.kelompok ? `kelompok ${r.kelompok}${r.jalur ? ` · jalur ${r.jalur}` : ""}` : "");
  const totalRugi = peta.kab.reduce((s, k) => s + k.estimasi_kerugian_rp, 0);
  const sel = pick !== null ? byKab.get(pick) : undefined;
  const rsSel = pick !== null ? peta.rs.filter((r) => r.kab === pick).sort((a, b) => b.estimasi_kerugian_rp - a.estimasi_kerugian_rp || b.klaim - a.klaim) : [];
  const legend = br.length ? [0, ...br].map((lo, i) => ({ k: i, c: ramp[i], t: i === 0 ? `≤ ${fmt(br[0])}` : i === br.length ? `> ${fmt(br[br.length - 1])}` : `${fmt(lo)} – ${fmt(br[i])}` })) : [];
  const warnaRs = (k: string | null) => (k ? GROUP_COLOR[k] ?? TANPA : TANPA);
  const label = measure === "kerugian" ? "Estimasi kerugian" : "Klaim direkomendasikan per 1.000 klaim";

  return (
    <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]" data-lp-peta-cabang>
      <div ref={box} className="relative min-w-0 rounded-md border border-white/[.06] bg-black/20 p-3" onPointerLeave={() => (clear(), setHover(null))}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#abb3bf]">Peta Indonesia · wilayah KC {peta.kab.length} kab/kota · {peta.rs.length} RS</p>
          <div className="lp-no-print ml-auto flex rounded border border-white/10 p-0.5 text-[10.5px]">
            {(["kerugian", "rasio"] as const).map((m) => (
              <button key={m} onClick={() => (setMeasure(m), clear())} className={`rounded-sm px-2 py-0.5 ${measure === m ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
                {m === "kerugian" ? "Estimasi kerugian" : "Rekomendasi / 1.000 klaim"}
              </button>
            ))}
          </div>
        </div>
        <div className="lp-no-print mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <button onClick={() => setView({ k: 1, x: 0, y: 0 })} className={`rounded border px-2 py-0.5 ${view.k === 1 ? "border-white/30 bg-white/10 text-white" : "border-white/10 text-[#c5cbd3] hover:bg-white/5"}`}>Indonesia</button>
          <button onClick={fitKC} className="rounded border border-[#fbbf24]/50 px-2 py-0.5 text-[#fbd38d] hover:bg-[#fbbf24]/10">Wilayah KC</button>
          <button onClick={() => zoomDi(1.4, VW / 2, VH / 2)} aria-label="Perbesar" className="rounded border border-white/10 px-2 py-0.5 text-white hover:bg-white/5">+</button>
          <button onClick={() => zoomDi(1 / 1.4, VW / 2, VH / 2)} aria-label="Perkecil" className="rounded border border-white/10 px-2 py-0.5 text-white hover:bg-white/5">−</button>
          <span className="text-[#8f99a8]">scroll = zoom · seret = geser · klik dua kali = perbesar · {idn(view.k, 1)}×</span>
        </div>
        {!geo || !indo ? (
          <div className="h-[360px] animate-pulse rounded bg-white/[.03]" />
        ) : (
          <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} className={`block h-auto w-full touch-none select-none ${menyeret ? "cursor-grabbing" : "cursor-grab"}`} role="img"
            aria-label={`Peta Indonesia: wilayah KC, ${label} per kab/kota dan RS`}
            onPointerDown={(e) => { seret.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, jalan: false }; baruSeret.current = false; }}
            onPointerMove={(e) => {
              const g = seret.current;
              if (!g || e.buttons !== 1) return;
              const dx = e.clientX - g.x, dy = e.clientY - g.y;
              if (!g.jalan && Math.hypot(dx, dy) < 4) return;
              if (!g.jalan) setMenyeret(true);
              g.jalan = true; baruSeret.current = true;
              const r = svgRef.current?.getBoundingClientRect();
              const f = r ? VW / r.width : 1;
              setView((v) => ({ ...v, x: g.vx + dx * f, y: g.vy + dy * f }));
            }}
            onPointerUp={() => { seret.current = null; setMenyeret(false); }}
            onClickCapture={(e) => { if (baruSeret.current) { e.stopPropagation(); e.preventDefault(); baruSeret.current = false; } }}
            onDoubleClick={(e) => {
              const r = svgRef.current?.getBoundingClientRect();
              if (r) zoomDi(1.8, ((e.clientX - r.left) / r.width) * VW, ((e.clientY - r.top) / r.height) * VH);
            }}>
            <rect width={VW} height={VH} fill="#0b0e12" />
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {/* the rest of Indonesia dim; the rest of the KC's province a lighter grey; then the branch area */}
              {provPaths.map((p) => <path key={`p-${p.kode}`} d={p.d} fill={LAIN} stroke="#0b0e12" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />)}
              {paths.filter((s) => !byKab.has(s.kode)).map((s, i) => <path key={`luar-${s.kode}-${i}`} d={s.d} fill={PROV} stroke="#151a20" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />)}
              {paths.filter((s) => byKab.has(s.kode)).map((s) => {
                const k = byKab.get(s.kode);
                const v = valueOf(s.kode);
                const cls = v && v > 0 ? classOf(v, br) : null;
                const on = pick === s.kode, hv = hover === `kab-${s.kode}`;
                return (
                  <path key={s.kode} d={s.d} fill={cls === null ? NONE : ramp[cls]} stroke={on ? "#fbbf24" : hv ? "#ffffff" : "#0f1318"} strokeWidth={on ? 2.4 : hv ? 1.8 : 0.8}
                    vectorEffect="non-scaling-stroke" strokeLinejoin="round" className="cursor-pointer transition-[fill] duration-300" data-kab={s.kode}
                    onPointerMove={(e) => {
                      setHover(`kab-${s.kode}`);
                      at(e, { title: k?.kabkota ?? s.nama, lines: [
                        { key: SERIES[0], value: rp(k?.estimasi_kerugian_rp ?? 0), label: `estimasi kerugian${totalRugi && k?.estimasi_kerugian_rp ? ` · ${idn((100 * k.estimasi_kerugian_rp) / totalRugi, 1)}% KC` : ""}` },
                        { key: SERIES[2], value: idn(k?.rekomendasi_per_1000 ?? 0, 1), label: "klaim direkomendasikan / 1.000 klaim" },
                        { value: `${idn(k?.rekomendasi ?? 0)} dari ${idn(k?.klaim ?? 0)}`, label: "klaim direkomendasikan" },
                        { value: idn(k?.rs ?? 0), label: "RS" },
                        ...(negara ? [{ value: "klik", label: "perbesar ke wilayah KC" }] : [])] });
                    }}
                    onClick={() => { if (negara) { fitKC(); return; } setPick(on ? null : s.kode); }} />
                );
              })}
              {/* the branch area's outline */}
              {paths.filter((s) => byKab.has(s.kode)).map((s) => <path key={`o-${s.kode}`} d={s.d} fill="none" stroke="#fbbf24" strokeOpacity={0.5} strokeWidth={negara ? 1.2 : 0.8} vectorEffect="non-scaling-stroke" className="pointer-events-none" />)}
              {titik.map((r) => {
                const aktif = r.rekomendasi > 0, member = anggota(r), hv = hover === r.id;
                // outside the box (no tag): small and faded; a member without recommended claims: its group's colour, not clickable
                const kecil = boxMode && !member;
                const radPx = (kecil ? 2 + 2.5 * Math.sqrt(r.klaim / maxKlaim) : 3 + 6 * Math.sqrt(r.klaim / maxKlaim)) * (negara ? 0.55 : 1);
                return (
                  <g key={r.id} className={aktif ? "cursor-pointer" : ""} data-rs={r.id}
                    onPointerMove={(e) => {
                      setHover(r.id);
                      at(e, { title: r.nama, lines: [
                        { value: r.kabkota, label: "koordinat sintetis" },
                        { value: idn(r.klaim), label: "klaim dianalisis" },
                        { key: warnaRs(member ? r.kelompok : null), value: idn(r.rekomendasi), label: "klaim direkomendasikan" },
                        ...(r.kelompok && member ? [{ key: warnaRs(r.kelompok), value: grupJalur(r), label: boxMode ? "Box KC" : "" }] : []),
                        ...(boxMode && !member ? [{ value: "di luar Box Karantina", label: "tanpa tag indikasi" }] : []),
                        ...(member && r.estimasi_kerugian_rp > 0 ? [{ key: SERIES[0], value: rp(r.estimasi_kerugian_rp), label: "estimasi kerugian" }] : []),
                        ...(negara ? [{ value: "klik", label: "perbesar ke wilayah KC" }]
                          : aktif ? [{ value: "klik", label: "buka berkas kasus RS" }]
                          : member ? [{ value: "tanpa klaim direkomendasikan", label: "tidak ada berkas kasus" }] : []),
                      ] });
                    }}
                    onClick={(e) => { e.stopPropagation(); if (negara) { fitKC(); return; } if (aktif) onFile?.(r.id); }}>
                    <circle cx={px(r.lon)} cy={py(r.lat)} r={(hv ? radPx + 1.5 : radPx) * upp} fill={warnaRs(member ? r.kelompok : null)}
                      fillOpacity={aktif ? 0.95 : member && boxMode ? 0.75 : kecil ? 0.35 : 0.45}
                      stroke={hv ? "#ffffff" : "#0f1318"} strokeWidth={aktif ? 1.4 : kecil ? 0.6 : 0.9} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
              {!negara && prioritas.slice(0, 3).map((r) => (
                <g key={`n-${r.id}`} className="pointer-events-none">
                  <circle cx={px(r.lon) + 8 * upp} cy={py(r.lat) - 8 * upp} r={7 * upp} fill="#fbbf24" stroke="#0f1318" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <text x={px(r.lon) + 8 * upp} y={py(r.lat) - 4.6 * upp} textAnchor="middle" fontSize={9.5 * upp} fontWeight={700} fill="#111418">{nomor.get(r.id)}</text>
                </g>
              ))}
              {/* at country scale: the branch area boxed and named, with a hint to zoom in */}
              {negara && kotak && (
                <g className="pointer-events-none">
                  <rect x={kotak.x0 - 4 * upp} y={kotak.y0 - 4 * upp} width={kotak.x1 - kotak.x0 + 8 * upp} height={kotak.y1 - kotak.y0 + 8 * upp} fill="none"
                    stroke="#fbbf24" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" rx={4 * upp} />
                  <text x={kotak.x1 + 8 * upp} y={kotak.y0 + 12 * upp} fontSize={12 * upp} fontWeight={600} fill="#ffffff" stroke="#0f1318" strokeWidth={3 * upp} paintOrder="stroke">Wilayah KC</text>
                  <text x={kotak.x1 + 8 * upp} y={kotak.y0 + 26 * upp} fontSize={10 * upp} fill="#c5cbd3" stroke="#0f1318" strokeWidth={3 * upp} paintOrder="stroke">{peta.kab.length} kab/kota · {peta.rs.length} RS · klik untuk perbesar</text>
                </g>
              )}
            </g>
          </svg>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[#abb3bf]">
          <span className="text-[#8f99a8]">{label}:</span>
          {legend.map((l) => <span key={l.t} className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm" style={{ background: l.c }} />{l.t}</span>)}
          <span className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm" style={{ background: NONE }} />tidak ada</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm border border-[#fbbf24]/60" style={{ background: PROV }} />provinsi KC, di luar wilayah KC</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-4 rounded-sm" style={{ background: LAIN }} />provinsi lain</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[#abb3bf]">
          <span className="text-[#8f99a8]">RS (koordinat sintetis):</span>
          {(boxMode ? KELOMPOK : ["A", "B", "C"]).map((k) => <span key={k} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: GROUP_COLOR[k] }} />kelompok {k}</span>)}
          {boxMode
            ? <span className="flex items-center gap-1" title="RS tanpa satu pun tag indikasi: tidak masuk Box Karantina KC"><span className="h-1.5 w-1.5 rounded-full opacity-40" style={{ background: TANPA }} />di luar Box (tanpa tag)</span>
            : <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full opacity-50" style={{ background: TANPA }} />tanpa rekomendasi</span>}
          <span>besar titik = volume klaim{boxMode ? " · titik tanpa klaim direkomendasikan tidak bisa diklik" : ""}</span>
        </div>
        <Tooltip tip={tip} />
      </div>

      <aside className="rounded-md border border-white/[.06] bg-black/20 p-3 text-[11.5px]">
        {!sel ? (
          <>
            <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">Wilayah KC</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div><p className="text-[16px] font-semibold tabular-nums text-white">{rp(totalRugi)}</p><p className="text-[10px] text-[#8f99a8]">estimasi kerugian</p></div>
              <div><p className="text-[16px] font-semibold tabular-nums text-white">{idn(peta.rata_per_1000, 1)}</p><p className="text-[10px] text-[#8f99a8]">rekomendasi / 1.000 klaim</p></div>
            </div>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">RS dengan kerugian terbesar</p>
            <div className="mt-1 space-y-0.5">
              {prioritas.slice(0, 6).map((r, i) => (
                <button key={r.id} onClick={() => onFile?.(r.id)} className="block w-full rounded px-1 py-0.5 text-left hover:bg-white/[.05]" title="buka berkas kasus RS ini">
                  <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[#e5e8eb]">{i + 1}. {r.nama}</span><span className="shrink-0 tabular-nums text-white">{rp(r.estimasi_kerugian_rp)}</span></span>
                  <span className="text-[10px] text-[#8f99a8]">kelompok {r.kelompok}{r.jalur ? <> · jalur <JalurTeks j={r.jalur} /></> : null} · {r.rekomendasi} klaim · {r.kabkota}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] text-[#8f99a8]">Arahkan ke kab/kota atau titik RS untuk angkanya; klik kab/kota untuk RS-nya, klik titik RS untuk berkas kasusnya.</p>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-white">{sel.kabkota}</p>
              <button onClick={() => setPick(null)} className="lp-no-print rounded px-1.5 text-[10.5px] text-[#8f99a8] ring-1 ring-white/10 hover:text-white">Wilayah KC</button>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div><dd className="text-[15px] font-semibold tabular-nums text-white">{rp(sel.estimasi_kerugian_rp)}</dd><dt className="text-[10px] text-[#8f99a8]">estimasi kerugian{totalRugi ? ` · ${idn((100 * sel.estimasi_kerugian_rp) / totalRugi, 1)}% KC` : ""}</dt></div>
              <div><dd className="text-[15px] font-semibold tabular-nums text-white">{idn(sel.rekomendasi_per_1000, 1)}</dd><dt className="text-[10px] text-[#8f99a8]">per 1.000 klaim{peta.rata_per_1000 ? ` · ${idn(sel.rekomendasi_per_1000 / peta.rata_per_1000, 1)}× rata-rata KC` : ""}</dt></div>
              <div><dd className="tabular-nums text-white">{idn(sel.rekomendasi)} dari {idn(sel.klaim)}</dd><dt className="text-[10px] text-[#8f99a8]">klaim direkomendasikan</dt></div>
              <div><dd className="tabular-nums text-white">{idn(sel.rs)}</dd><dt className="text-[10px] text-[#8f99a8]">RS</dt></div>
            </dl>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#8f99a8]">RS di kab/kota ini</p>
            <div className="mt-1 max-h-[260px] space-y-0.5 overflow-auto">
              {rsSel.map((r) => {
                const member = anggota(r);
                return (
                  <button key={r.id} disabled={!r.rekomendasi} onClick={() => onFile?.(r.id)} className="block w-full rounded px-1 py-0.5 text-left enabled:hover:bg-white/[.05] disabled:cursor-default"
                    title={r.rekomendasi ? "buka berkas kasus RS ini" : boxMode && !member ? "di luar Box Karantina: tanpa tag indikasi" : "tidak ada klaim yang direkomendasikan"}>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: warnaRs(member ? r.kelompok : null), opacity: r.rekomendasi ? 1 : member ? 0.75 : 0.4 }} />
                      <span className={`truncate ${r.rekomendasi ? "text-[#e5e8eb]" : "text-[#8f99a8]"}`}>{r.nama}</span></span>
                    <span className="pl-3.5 text-[10px] tabular-nums text-[#8f99a8]">{idn(r.klaim)} klaim{r.rekomendasi ? ` · ${r.rekomendasi} direkomendasikan · ${rp(r.estimasi_kerugian_rp)}` : ""}
                      {boxMode && member ? <> · kelompok {r.kelompok}{r.jalur ? <> · jalur <JalurTeks j={r.jalur} /></> : null}</> : boxMode ? " · di luar Box" : ""}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <p className="mt-3 border-t border-white/[.06] pt-2 text-[9.5px] leading-snug text-[#6b7480]">{peta.keterangan} Batas kab/kota: geoBoundaries (BPS, WFP, OCHA ROAP; CC BY 3.0 IGO).</p>
      </aside>
    </div>
  );
}
