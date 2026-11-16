"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { Badge, juta } from "./FacilityFile";
import { VERDICT_COLOR } from "./IotEvidence";

type Wilayah = {
  id_wilayah: string;
  nama: string;
  tingkat: string;
  induk?: string | null;
  lokasi?: string;
  rs_total: number;
  rs_terhubung: number;
  cakupan_pct: number;
  alat_bermeter: number;
  klaim_14h: number;
  klaim_terpantau_14h: number;
  tak_didukung_14h: number;
  nilai_tak_didukung_rp: number;
  rasio_tak_didukung_pct: number;
  rs_prioritas: number;
  rs_perhatian: number;
  rs_data_kurang: number;
  kelengkapan_pct: number | null;
  status_wilayah: string;
};
type Rs = {
  kode: string;
  nama: string;
  kelas: string;
  kabkota: string;
  provinsi: string;
  id_kabkota: string;
  id_provinsi: string;
  id_kedeputian: string;
  lokasi?: string;
  tier: string;
  alat_terpasang: number;
  alat_bermeter: number;
  kelengkapan_pct: number | null;
  klaim_terpantau_14h: number;
  estimasi_alat_14h: number;
  tak_didukung_14h: number;
  nilai_tak_didukung_rp: number;
  rasio_tak_didukung_pct: number;
  rasio_jenis_maks_pct: number;
  hari_temuan: number;
  hari_verifikasi: number;
  alat_bermasalah: string;
  skor_risiko_iot: number;
  status_pemantauan: string;
  catatan_pemantauan?: string | null;
  tim_pemeriksa?: string | null;
};
type Nas = {
  wilayah: Wilayah;
  path: { id_wilayah: string; nama: string; tingkat: string }[];
  anak: Wilayah[];
  rs: Rs[];
  perhatian: Rs[];
  perhatian_total: number;
  tren: { tanggal: string; klaim_terpantau: number; estimasi_alat: number; tak_didukung: number; temuan: number }[];
  status_rs: Record<string, number>;
  peta: {
    kabkota: { id_wilayah: string; nama: string; induk: string; lokasi: string; status_wilayah: string; rs_total: number; rs_terhubung: number; rs_prioritas: number; nilai_tak_didukung_rp: number }[];
    rs: { kode: string; nama: string; lokasi: string; status_pemantauan: string; skor_risiko_iot: number; id_kabkota: string; id_provinsi: string; id_kedeputian: string; tier: string }[];
  };
  hotspot: Wilayah[];
  types: { wilayah: string; rs: string };
  actions: { id: string; name: string; description: string }[];
  apps: { peta_nasional?: string; graph_hotspot?: string; pipeline_nasional?: string; sync_nasional?: string; machinery?: string; proses_rs?: string; lineage_graph?: string; raw_edge?: string };
  skala: { hari: number; baris_edge: number; bacaan_setara: number; faktor: number };
};
type Cell = { id: string; klaim: number; est: number; status: string; tingkat: string; keputusan: string | null } | null;
type RsFile = {
  rs: Rs & { terhubung_sejak?: string };
  alat: { id_alat: string; nama_alat: string; jenis_alat: string; id_meter: string | null; status_iot: string; kelengkapan_pct: number; estimasi_tindakan_total: number; klaim_total: number; tak_didukung_total: number }[];
  days: string[];
  matrix: { jenis_alat: string; cells: Cell[]; alat: { nama_alat: string; id_meter: string | null }[]; tak_didukung: number }[];
  temuan: { id_temuan: string; jenis_alat: string; tanggal: string; jenis_temuan: string; tingkat: string; klaim_tindakan: number; estimasi_tindakan_alat: number; status_temuan?: string }[];
  riwayat: { at?: string; user?: string | null; changes?: Record<string, [unknown, unknown]> }[];
  types: { rs: string };
  actions: { id: string; name: string }[];
};

export const RS_COLOR: Record<string, string> = { "Prioritas audit": "#ef4444", Perhatian: "#f59e0b", "Data kurang": "#94a3b8", Normal: "#22c55e", "Belum terhubung": "#475569" };
const WIL_COLOR: Record<string, string> = { Hotspot: "#be123c", "Ada RS prioritas": "#f97316", Perhatian: "#f59e0b", Normal: "#22c55e", "Belum terhubung": "#475569" };
const CELL: Record<string, string> = {
  "Klaim melebihi pemakaian alat": "#ef4444",
  "Klaim saat alat mati": "#b91c1c",
  "Klaim tanpa alat terdaftar": "#be185d",
  "Perlu verifikasi (alat tanpa meter)": "#f59e0b",
  "Data meter tidak lengkap": "#64748b",
  "Tanpa meter (tidak dinilai)": "#1e293b",
  Sesuai: "#14532d",
};
const num = (v: unknown, d = 0) => Number(v ?? 0).toLocaleString("id-ID", { maximumFractionDigits: d });
const ll = (s?: string) => (s ? (s.split(",").map(Number) as [number, number]) : null);

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
  return r.json();
}

/** Web Mercator at zoom 0 (a 256-unit world), so the dots sit on real map tiles. */
const wx = (lon: number) => ((lon + 180) / 360) * 256;
const wy = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256;
};
const INDONESIA: [number, number, number, number] = [94.5, -11.5, 141.5, 6.5]; // min lon, min lat, max lon, max lat
// Esri World Dark Gray Canvas (no API key): the base and its place-name layer
const TILES = (layer: "Base" | "Reference", z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_${layer}/MapServer/tile/${z}/${y}/${x}`;

/** Inverse Web Mercator (zoom-0 world units → degrees), for the bounds handed to the Map app. */
const unwx = (x: number) => (x / 256) * 360 - 180;
const unwy = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 256))) * 180) / Math.PI;

type MapView = { k: number; ox: number; oy: number };

/** Indonesia on a basemap: cities/regencies sized by hospitals and coloured by status, the current region's hospitals on top.
    The view frames the selected region; drag to pan, scroll or +/− to zoom, ⤢ opens the area in the Map app. */
function DotMap({ d, onKab, onRs, mapHref }: { d: Nas; onKab: (id: string) => void; onRs: (kode: string) => void; mapHref?: string | null }) {
  const W = 1000;
  const H = 420;
  const level = d.wilayah.tingkat;
  const key = level === "Kedeputian Wilayah" ? "id_kedeputian" : level === "Provinsi" ? "id_provinsi" : level === "Kabupaten/Kota" ? "id_kabkota" : null;
  const inside = (r: Nas["peta"]["rs"][number]) => !key || r[key as "id_kabkota"] === d.wilayah.id_wilayah;
  const here = d.peta.rs.filter(inside);
  const inKab = new Set(here.map((r) => r.id_kabkota));

  // the region's frame: Indonesia, or the selected region's hospitals with a margin
  const home = useMemo<MapView>(() => {
    let [x0, y0, x1, y1] = INDONESIA;
    if (key) {
      const pts = here.map((r) => ll(r.lokasi)).filter((p): p is [number, number] => !!p);
      if (pts.length) {
        const la = pts.map((p) => p[0]);
        const lo = pts.map((p) => p[1]);
        const pad = Math.max(0.6, (Math.max(...lo) - Math.min(...lo)) * 0.15);
        [x0, y0, x1, y1] = [Math.min(...lo) - pad, Math.min(...la) - pad, Math.max(...lo) + pad, Math.max(...la) + pad];
      }
    }
    const bw = wx(x1) - wx(x0);
    const bh = wy(y0) - wy(y1);
    const k = Math.min(W / bw, H / bh);
    return { k, ox: (W - bw * k) / 2 - wx(x0) * k, oy: (H - bh * k) / 2 - wy(y1) * k };
    // the frame changes with the region only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.wilayah.id_wilayah]);
  const [view, setView] = useState<MapView>(home);
  const [lastHome, setLastHome] = useState(home);
  if (lastHome !== home) {
    // a new region: back to its frame
    setLastHome(home);
    setView(home);
  }
  const { k, ox, oy } = view;
  const x = (lon: number) => wx(lon) * k + ox;
  const y = (lat: number) => wy(lat) * k + oy;

  // zoom about a point of the viewBox, within world zoom 3 … 15
  const kMin = W / (wx(INDONESIA[2]) - wx(INDONESIA[0])) / 2;
  const zoomAt = (f: number, px = W / 2, py = H / 2) =>
    setView((v) => {
      const nk = Math.max(kMin, Math.min(2 ** 15, v.k * f));
      const r = nk / v.k;
      return { k: nk, ox: px - (px - v.ox) * r, oy: py - (py - v.oy) * r };
    });

  const svgRef = useRef<SVGSVGElement>(null);
  const toBox = (cx: number, cy: number) => {
    const b = svgRef.current!.getBoundingClientRect();
    return [((cx - b.left) / b.width) * W, ((cy - b.top) / b.height) * H] as const;
  };
  // scroll zooms the map, not the page (React's wheel listener is passive, so it is attached here)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), ((e.clientX - b.left) / b.width) * W, ((e.clientY - b.top) / b.height) * H);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomAt only uses the state setter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [bx, by] = toBox(e.clientX, e.clientY);
    drag.current = { x: bx, y: by, ox: view.ox, oy: view.oy, moved: false };
    moved.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const [bx, by] = toBox(e.clientX, e.clientY);
    if (!g.moved && Math.hypot(bx - g.x, by - g.y) < 4) return;
    if (!g.moved) {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragging(true);
    }
    g.moved = true;
    moved.current = true;
    setView((v) => ({ ...v, ox: g.ox + bx - g.x, oy: g.oy + by - g.y }));
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };
  // a click that ended a drag is not a click on a dot
  const click = (fn: () => void) => () => {
    if (!moved.current) fn();
  };

  // tiles a little sharper than the view needs
  const z = Math.max(3, Math.min(16, Math.ceil(Math.log2(k * 1.5))));
  const n = 2 ** z;
  const ts = (256 / n) * k;
  const tiles: { tx: number; ty: number }[] = [];
  for (let tx = Math.floor(((-ox / k) * n) / 256); tx <= Math.floor((((W - ox) / k) * n) / 256); tx++)
    for (let ty = Math.max(0, Math.floor(((-oy / k) * n) / 256)); ty <= Math.min(n - 1, Math.floor((((H - oy) / k) * n) / 256)); ty++) tiles.push({ tx, ty });
  const zoomed = k / (W / (wx(INDONESIA[2]) - wx(INDONESIA[0])));
  const dot = Math.min(2.4, Math.max(1, Math.sqrt(zoomed) * 0.8));
  const ring = Math.min(2.2, Math.max(1, Math.sqrt(zoomed) * 0.7));
  // what is in view, in degrees: the Map app opens on the same area
  const bbox = [unwx(-ox / k), unwy((H - oy) / k), unwx((W - ox) / k), unwy(-oy / k)].map((v) => v.toFixed(4)).join(",");
  const btn = "flex h-7 w-7 items-center justify-center rounded-md border border-line-2 bg-[#0b0f17]/85 text-sm text-soft hover:border-ocean hover:text-white";
  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`w-full touch-none select-none overflow-hidden rounded-xl border border-line bg-[#0b0f17] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        role="img" aria-label="Peta titik RS jejaring IoT" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
        onDoubleClick={(e) => {
          const [bx, by] = toBox(e.clientX, e.clientY);
          zoomAt(2, bx, by);
        }}>
        <defs>
          <clipPath id="dotmap-clip">
            <rect width={W} height={H} rx={12} />
          </clipPath>
        </defs>
        <g clipPath="url(#dotmap-clip)">
          {tiles.map(({ tx, ty }) => (
            <image key={`b${z}/${tx}/${ty}`} href={TILES("Base", z, ((tx % n) + n) % n, ty)} x={((tx * 256) / n) * k + ox} y={((ty * 256) / n) * k + oy} width={ts + 0.5} height={ts + 0.5}
              preserveAspectRatio="none" />
          ))}
          {tiles.map(({ tx, ty }) => (
            <image key={`r${z}/${tx}/${ty}`} href={TILES("Reference", z, ((tx % n) + n) % n, ty)} x={((tx * 256) / n) * k + ox} y={((ty * 256) / n) * k + oy} width={ts + 0.5} height={ts + 0.5}
              preserveAspectRatio="none" opacity={0.75} pointerEvents="none" />
          ))}
          {d.peta.kabkota.map((kab) => {
            const p = ll(kab.lokasi);
            if (!p) return null;
            const cx = x(p[1]);
            const cy = y(p[0]);
            if (cx < -60 || cx > W + 60 || cy < -60 || cy > H + 60) return null;
            const active = !key || inKab.has(kab.id_wilayah);
            const r = (3 + Math.sqrt(kab.rs_total) * 2.2) * ring;
            const c = WIL_COLOR[kab.status_wilayah] ?? "#64748b";
            return (
              <g key={kab.id_wilayah} onClick={click(() => onKab(kab.id_wilayah))} className="cursor-pointer" opacity={active ? 1 : 0.3}>
                <title>{`${kab.nama}: ${kab.rs_terhubung}/${kab.rs_total} RS terhubung · ${kab.rs_prioritas} prioritas · ${juta(kab.nilai_tak_didukung_rp)} tak didukung · ${kab.status_wilayah}`}</title>
                <circle cx={cx} cy={cy} r={r} fill={c} fillOpacity={key ? 0.18 : 0.35} stroke={c} strokeWidth={1.2} />
                {kab.status_wilayah === "Hotspot" && <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke="#be123c" strokeWidth={1.5} strokeDasharray="3 3" />}
                {(key ? active : zoomed > 3) && (
                  <text x={cx} y={cy - r - 4} fontSize={11} textAnchor="middle" fill="#e2e8f0" stroke="#0b0f17" strokeWidth={3} paintOrder="stroke" pointerEvents="none">
                    {kab.nama}
                  </text>
                )}
              </g>
            );
          })}
          {(key || zoomed > 3) &&
            (key ? here : d.peta.rs).map((r) => {
              const p = ll(r.lokasi);
              if (!p) return null;
              const cx = x(p[1]);
              const cy = y(p[0]);
              if (cx < -10 || cx > W + 10 || cy < -10 || cy > H + 10) return null;
              return (
                <circle key={r.kode} cx={cx} cy={cy} r={(level === "Kabupaten/Kota" ? 4.5 : 3) * dot} fill={RS_COLOR[r.status_pemantauan] ?? "#64748b"} stroke="#020617" strokeWidth={0.8}
                  className="cursor-pointer" onClick={click(() => onRs(r.kode))}>
                  <title>{`${r.nama} · ${r.status_pemantauan} · skor ${r.skor_risiko_iot}`}</title>
                </circle>
              );
            })}
        </g>
        <g transform={`translate(12, ${H - 92})`} fontSize={10.5} fill="#cbd5e1" pointerEvents="none">
          <rect x={-6} y={-14} width={128} height={86} rx={6} fill="#0b0f17" fillOpacity={0.75} />
          {Object.entries(WIL_COLOR).map(([s, c], i) => (
            <g key={s} transform={`translate(0, ${i * 16})`}>
              <circle cx={5} cy={-3} r={4.5} fill={c} fillOpacity={0.5} stroke={c} />
              <text x={14}>{s}</text>
            </g>
          ))}
        </g>
        <text x={W - 10} y={H - 10} fontSize={10} textAnchor="end" fill="#94a3b8" stroke="#0b0f17" strokeWidth={3} paintOrder="stroke" pointerEvents="none">
          seret untuk geser · gulir / klik ganda untuk zoom · lingkaran = kabupaten/kota · titik = RS · data fiktif · peta dasar © Esri, © OpenStreetMap
        </text>
      </svg>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {mapHref && (
          <Link href={`${mapHref}?bbox=${bbox}`} className={btn} title="Layar penuh: buka area ini di aplikasi Map" aria-label="Layar penuh di aplikasi Map">
            ⤢
          </Link>
        )}
        <button type="button" className={btn} onClick={() => zoomAt(1.6)} title="Perbesar" aria-label="Perbesar">
          +
        </button>
        <button type="button" className={btn} onClick={() => zoomAt(1 / 1.6)} title="Perkecil" aria-label="Perkecil">
          −
        </button>
        <button type="button" className={btn} onClick={() => setView(home)} title="Kembali ke bingkai wilayah" aria-label="Kembali ke bingkai wilayah">
          ⌂
        </button>
      </div>
    </div>
  );
}

function Trend({ tren }: { tren: Nas["tren"] }) {
  const W = 600;
  const H = 150;
  const max = Math.max(1, ...tren.map((t) => t.tak_didukung));
  const bw = W / Math.max(1, tren.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tren tindakan tak didukung">
      {tren.map((t, i) => {
        const h = (t.tak_didukung / max) * (H - 40);
        const rasio = t.klaim_terpantau ? (t.tak_didukung / t.klaim_terpantau) * 100 : 0;
        return (
          <g key={t.tanggal}>
            <rect x={i * bw + 4} y={H - 22 - h} width={bw - 8} height={h} rx={2} fill="#ef4444" fillOpacity={0.75}>
              <title>{`${t.tanggal}: ${t.tak_didukung} tindakan tak didukung dari ${t.klaim_terpantau} klaim terpantau (${rasio.toFixed(2)} %) · ${t.temuan} temuan`}</title>
            </rect>
            <text x={i * bw + bw / 2} y={H - 8} fontSize={10} textAnchor="middle" fill="#64748b">
              {t.tanggal.slice(8)}
            </text>
            <text x={i * bw + bw / 2} y={H - 26 - h} fontSize={9.5} textAnchor="middle" fill="#fca5a5">
              {t.tak_didukung}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function RsDrawer({ kode, version, onClose, onEvidence, onAction }: { kode: string; version: number; onClose: () => void; onEvidence: (id: string) => void; onAction: (tid: string, actionId: string, pk: string) => void }) {
  const [f, setF] = useState<RsFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    get<RsFile>(`/api/demo/jkn/workbench/nasional/rs/${encodeURIComponent(kode)}`).then((x) => !stale && (setF(x), setErr(null)), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [kode, version]);
  const r = f?.rs;
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[1100px] flex-col border-l border-line bg-ink shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line bg-panel px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span>RS jejaring IoT</span>
              {r && <Badge text={r.status_pemantauan} color={RS_COLOR[r.status_pemantauan] ?? "#64748b"} />}
              {r && <Badge text={r.tier} color={r.tier === "Telemetri penuh" ? "#14b8a6" : "#0ea5e9"} />}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold">{r?.nama ?? kode}</h2>
            {r && (
              <p className="text-xs text-soft">
                {r.kode} · kelas {r.kelas} · {r.kabkota}, {r.provinsi}
              </p>
            )}
          </div>
          {f?.actions.map((a) => (
            <button key={a.id} type="button" onClick={() => onAction(f.types.rs, a.id, kode)} className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn hover:bg-warn/10">
              ⚡ {a.name}
            </button>
          ))}
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-muted hover:text-white" aria-label="Tutup">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-bad">{err}</p>}
          {!f && !err && <p className="text-muted">Memuat…</p>}
          {f && r && (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
                {(
                  [
                    ["Skor risiko IoT", num(r.skor_risiko_iot), RS_COLOR[r.status_pemantauan]],
                    ["Alat bermeter", `${r.alat_bermeter} / ${r.alat_terpasang}`, undefined],
                    ["Kelengkapan", r.kelengkapan_pct == null ? "—" : `${num(r.kelengkapan_pct, 1)} %`, undefined],
                    ["Klaim terpantau", num(r.klaim_terpantau_14h), undefined],
                    ["Estimasi dari alat", num(r.estimasi_alat_14h), "#2dd4bf"],
                    ["Tak didukung", num(r.tak_didukung_14h), "#ef4444"],
                    ["Rasio jenis terburuk", `${num(r.rasio_jenis_maks_pct, 1)} %`, "#ef4444"],
                    ["Nilai tak didukung", juta(r.nilai_tak_didukung_rp), "#ef4444"],
                  ] as [string, string, string | undefined][]
                ).map(([l, v, c]) => (
                  <div key={l} className="rounded-lg border border-line bg-panel px-2.5 py-1.5">
                    <div className="text-[10.5px] text-muted">{l}</div>
                    <div className="text-base font-semibold tabular-nums" style={c ? { color: c } : undefined}>
                      {v}
                    </div>
                  </div>
                ))}
              </div>
              {(r.catatan_pemantauan || r.tim_pemeriksa) && (
                <p className="rounded-lg border border-warn/40 bg-warn/5 p-2 text-soft">
                  Keputusan pemantauan: <b className="text-white">{r.status_pemantauan}</b>
                  {r.tim_pemeriksa ? ` · ${r.tim_pemeriksa}` : ""} — {r.catatan_pemantauan}
                </p>
              )}
              <div className="rounded-xl border border-line bg-panel p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold">Klaim vs pemakaian alat, per hari</span>
                  <span className="text-muted">sel = klaim / estimasi alat · klik untuk rantai bukti</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-separate border-spacing-[3px] text-[10.5px]">
                    <thead>
                      <tr className="text-muted">
                        <th className="min-w-40 text-left font-normal">Jenis alat</th>
                        {f.days.map((d) => (
                          <th key={d} className="min-w-11 font-normal">
                            {d.slice(8)}
                          </th>
                        ))}
                        <th className="font-normal">Tak didukung</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.matrix.map((m) => (
                        <tr key={m.jenis_alat}>
                          <td className="pr-2">
                            <div className="font-medium">{m.jenis_alat}</div>
                            <div className="text-muted">{m.alat.length ? m.alat.map((a) => `${a.nama_alat}${a.id_meter ? "" : " (tanpa meter)"}`).join(", ") : "tidak ada alat terdaftar"}</div>
                          </td>
                          {m.cells.map((c, i) =>
                            c ? (
                              <td key={i} className="p-0">
                                <button type="button" disabled={c.status === "Sesuai" || c.status.startsWith("Tanpa meter")} onClick={() => onEvidence(c.id)}
                                  title={`${c.status}: klaim ${c.klaim}, estimasi alat ${c.est}${c.keputusan ? ` · ${c.keputusan}` : ""}`}
                                  className="relative h-8 w-full rounded font-mono tabular-nums text-white disabled:cursor-default"
                                  style={{ background: CELL[c.status] ?? "#334155", opacity: c.status === "Sesuai" ? 0.65 : 1 }}>
                                  {c.klaim}/{c.est}
                                  {c.keputusan && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full" style={{ background: VERDICT_COLOR(c.keputusan) }} />}
                                </button>
                              </td>
                            ) : (
                              <td key={i} className="rounded bg-ink text-center text-muted">
                                —
                              </td>
                            ),
                          )}
                          <td className="text-right font-semibold tabular-nums" style={{ color: m.tak_didukung ? "#ef4444" : undefined }}>
                            {m.tak_didukung || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-line bg-panel p-3">
                  <div className="mb-1 text-sm font-semibold">Alat ({f.alat.length})</div>
                  <ul className="divide-y divide-line/50">
                    {f.alat.map((a) => (
                      <li key={a.id_alat} className="flex items-center gap-2 py-1">
                        <span className="min-w-0 flex-1 truncate">
                          {a.nama_alat} <span className="text-muted">· {a.id_meter ?? "tanpa meter"}</span>
                        </span>
                        <span className="text-[10.5px] text-muted">
                          alat {a.estimasi_tindakan_total} · klaim {a.klaim_total}
                        </span>
                        <Badge text={a.status_iot} color={a.status_iot === "Ada temuan" ? "#ef4444" : a.status_iot === "Sesuai" ? "#22c55e" : "#94a3b8"} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-line bg-panel p-3">
                  <div className="mb-1 text-sm font-semibold">Riwayat keputusan</div>
                  {f.riwayat.length === 0 && <p className="text-muted">Belum ada keputusan pemantauan untuk RS ini.</p>}
                  <ul className="space-y-1">
                    {f.riwayat.map((h, i) => (
                      <li key={i} className="text-[11px] text-soft">
                        <span className="text-muted">{h.at ? new Date(h.at).toLocaleString("id-ID") : "—"}</span> ·{" "}
                        {Object.entries(h.changes ?? {})
                          .map(([k, [, b]]) => `${k} → ${String(b)}`)
                          .join("; ")}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * National IoT monitoring for JKN: every hospital in the network, region by region (national → regional office →
 * province → city/regency → hospital → device-day → evidence), from the gateways' daily edge summaries.
 */
export function IotNationalTab({ version, onEvidence, onAction }: { version: number; onEvidence: (id: string) => void; onAction: (tid: string, actionId: string, pk: string) => void }) {
  const [wilayah, setWilayah] = useState("ID");
  const [d, setD] = useState<Nas | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rs, setRs] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    get<Nas>(`/api/demo/jkn/workbench/nasional?wilayah=${encodeURIComponent(wilayah)}`).then((x) => !stale && (setD(x), setErr(null)), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [wilayah, version]);
  const w = d?.wilayah;
  const childLabel = useMemo(() => ({ Nasional: "Kedeputian wilayah", "Kedeputian Wilayah": "Provinsi", Provinsi: "Kabupaten/kota" })[w?.tingkat ?? "Nasional"] ?? "", [w]);
  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!d || !w) return <p className="text-xs text-muted">Memuat pantauan nasional…</p>;
  const a = d.apps;
  const link = "rounded-md border border-line-2 px-2.5 py-1 text-[11px] hover:border-ocean";
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs">
        <b className="text-sky-300">Skala nasional</b>
        <span className="text-soft">
          {num(d.skala.baris_edge)} ringkasan harian dari gateway RS menggantikan {num(d.skala.bacaan_setara)} bacaan 2 menit ({d.skala.faktor}× lebih kecil); bacaan penuh tetap di arsip gateway
          dan ditarik saat temuan dibuka.
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {a.peta_nasional && (
            <Link href={`/map/${a.peta_nasional}`} className={link}>
              Peta nasional
            </Link>
          )}
          {a.graph_hotspot && (
            <Link href={`/vertex?graph=${a.graph_hotspot}`} className={link}>
              Vertex: hotspot
            </Link>
          )}
          {a.pipeline_nasional && (
            <Link href={`/pipeline/${a.pipeline_nasional}`} className={link}>
              Pipeline nasional
            </Link>
          )}
          {a.machinery && (
            <Link href={`/machinery?id=${a.machinery}&process=${a.proses_rs ?? ""}`} className={link}>
              Device and Machinery
            </Link>
          )}
          {a.lineage_graph && (
            <Link href={`/lineage?graph=${a.lineage_graph}`} className={link}>
              Data lineage
            </Link>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-sm">
        {d.path.map((p, i) => (
          <span key={p.id_wilayah} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted">›</span>}
            <button type="button" onClick={() => setWilayah(p.id_wilayah)} className={i === d.path.length - 1 ? "font-semibold text-white" : "text-ocean hover:underline"}>
              {p.nama}
            </button>
          </span>
        ))}
        <Badge text={w.status_wilayah} color={WIL_COLOR[w.status_wilayah] ?? "#64748b"} />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5 xl:grid-cols-10">
        {(
          [
            ["RS terhubung", `${num(w.rs_terhubung)} / ${num(w.rs_total)}`, undefined],
            ["Cakupan", `${num(w.cakupan_pct, 1)} %`, "#38bdf8"],
            ["Alat bermeter", num(w.alat_bermeter), "#2dd4bf"],
            ["Kelengkapan", w.kelengkapan_pct == null ? "—" : `${num(w.kelengkapan_pct, 1)} %`, "#2dd4bf"],
            ["Klaim terpantau", num(w.klaim_terpantau_14h), undefined],
            ["Tak didukung", num(w.tak_didukung_14h), "#ef4444"],
            ["Rasio", `${num(w.rasio_tak_didukung_pct, 2)} %`, "#ef4444"],
            ["Nilai tak didukung", juta(w.nilai_tak_didukung_rp), "#ef4444"],
            ["RS prioritas", num(w.rs_prioritas), "#ef4444"],
            ["RS perhatian / data kurang", `${num(w.rs_perhatian)} / ${num(w.rs_data_kurang)}`, "#f59e0b"],
          ] as [string, string, string | undefined][]
        ).map(([l, v, c]) => (
          <div key={l} className="rounded-xl border border-line bg-panel px-3 py-2">
            <div className="text-[10.5px] text-muted">{l}</div>
            <div className="mt-0.5 text-base font-semibold tabular-nums" style={c ? { color: c } : undefined}>
              {v}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
        <DotMap d={d} onKab={setWilayah} onRs={setRs} mapHref={a.peta_nasional ? `/map/${a.peta_nasional}` : null} />
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-panel p-3">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <span className="text-sm font-semibold">Tindakan tak didukung per hari</span>
              <span className="text-muted">{w.nama} · 14 hari</span>
            </div>
            <Trend tren={d.tren} />
          </div>
          {d.hotspot.length > 0 && (
            <div className="rounded-xl border border-rose-700/50 bg-rose-950/30 p-3 text-xs">
              <div className="mb-1 text-sm font-semibold text-rose-300">Hotspot kabupaten/kota</div>
              <p className="mb-2 text-[11px] text-muted">≥ 3 RS prioritas audit dan ≥ 40 % RS terhubung di satu kabupaten/kota — pola yang sama di banyak RS: periksa vendor, rujukan dan dokter bersama.</p>
              {d.hotspot.map((h) => (
                <button key={h.id_wilayah} type="button" onClick={() => setWilayah(h.id_wilayah)} className="mb-1 flex w-full items-center gap-2 rounded bg-ink px-2 py-1.5 text-left hover:bg-panel-2">
                  <span className="font-medium">{h.nama}</span>
                  <span className="text-muted">
                    {h.rs_prioritas}/{h.rs_terhubung} RS prioritas
                  </span>
                  <span className="ml-auto tabular-nums text-rose-300">{juta(h.nilai_tak_didukung_rp)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-3 py-2 text-sm font-semibold">
            {w.tingkat === "Kabupaten/Kota" ? `RS di ${w.nama} (${d.rs.length})` : `${childLabel} (${d.anak.length})`}
          </div>
          <div className="max-h-[460px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left text-[10.5px] text-muted">
                {w.tingkat === "Kabupaten/Kota" ? (
                  <tr className="border-b border-line">
                    <th className="px-3 py-1.5">RS</th>
                    <th className="px-2 py-1.5">Status</th>
                    <th className="px-2 py-1.5 text-right">Skor</th>
                    <th className="px-2 py-1.5 text-right">Alat</th>
                    <th className="px-2 py-1.5 text-right">Tak didukung</th>
                    <th className="px-2 py-1.5 text-right">Nilai</th>
                  </tr>
                ) : (
                  <tr className="border-b border-line">
                    <th className="px-3 py-1.5">Wilayah</th>
                    <th className="px-2 py-1.5 text-right">Cakupan</th>
                    <th className="px-2 py-1.5 text-right">RS prioritas</th>
                    <th className="px-2 py-1.5 text-right">Klaim terpantau</th>
                    <th className="px-2 py-1.5 text-right">Tak didukung</th>
                    <th className="px-2 py-1.5 text-right">Nilai</th>
                    <th className="px-2 py-1.5">Status</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {w.tingkat === "Kabupaten/Kota"
                  ? d.rs.map((r) => (
                      <tr key={r.kode} onClick={() => setRs(r.kode)} className="cursor-pointer border-b border-line/50 hover:bg-panel-2">
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{r.nama}</div>
                          <div className="text-[10.5px] text-muted">
                            {r.kode} · kelas {r.kelas} · {r.tier}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge text={r.status_pemantauan} color={RS_COLOR[r.status_pemantauan] ?? "#64748b"} />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{num(r.skor_risiko_iot)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {r.alat_bermeter}/{r.alat_terpasang}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.tak_didukung_14h || "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.nilai_tak_didukung_rp ? juta(r.nilai_tak_didukung_rp) : "—"}</td>
                      </tr>
                    ))
                  : d.anak.map((c) => (
                      <tr key={c.id_wilayah} onClick={() => setWilayah(c.id_wilayah)} className="cursor-pointer border-b border-line/50 hover:bg-panel-2">
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{c.nama}</div>
                          <div className="text-[10.5px] text-muted">
                            {c.rs_terhubung}/{c.rs_total} RS terhubung · {num(c.alat_bermeter)} alat bermeter
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <span className="inline-block h-1.5 w-12 overflow-hidden rounded bg-line align-middle">
                            <span className="block h-full bg-sky-400" style={{ width: `${c.cakupan_pct}%` }} />
                          </span>{" "}
                          {num(c.cakupan_pct)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: c.rs_prioritas ? "#ef4444" : undefined }}>
                          {c.rs_prioritas || "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{num(c.klaim_terpantau_14h)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.tak_didukung_14h || "—"}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.nilai_tak_didukung_rp ? juta(c.nilai_tak_didukung_rp) : "—"}</td>
                        <td className="px-2 py-1.5">
                          <Badge text={c.status_wilayah} color={WIL_COLOR[c.status_wilayah] ?? "#64748b"} />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-sm font-semibold">RS perlu ditindaklanjuti</span>
            <span className="text-xs text-muted">
              {d.perhatian_total} di {w.nama}
            </span>
          </div>
          <ul className="max-h-[460px] divide-y divide-line/50 overflow-y-auto text-xs">
            {d.perhatian.map((r) => (
              <li key={r.kode}>
                <button type="button" onClick={() => setRs(r.kode)} className="w-full px-3 py-2 text-left hover:bg-panel-2">
                  <div className="flex items-center gap-1.5">
                    <Badge text={r.status_pemantauan} color={RS_COLOR[r.status_pemantauan] ?? "#64748b"} />
                    <span className="font-medium">{r.nama}</span>
                    <span className="ml-auto font-semibold tabular-nums" style={{ color: RS_COLOR[r.status_pemantauan] }}>
                      {num(r.skor_risiko_iot)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-muted">
                    {r.kabkota}, {r.provinsi} · {r.alat_bermasalah || (r.hari_verifikasi ? `${r.hari_verifikasi} hari perlu verifikasi` : "—")} · {r.tak_didukung_14h} tak didukung ·{" "}
                    {juta(r.nilai_tak_didukung_rp)} · jenis terburuk {num(r.rasio_jenis_maks_pct, 1)} %
                  </div>
                </button>
              </li>
            ))}
            {d.perhatian.length === 0 && <li className="px-3 py-4 text-center text-muted">Tidak ada RS prioritas / perhatian di wilayah ini.</li>}
          </ul>
        </div>
      </div>
      {rs && <RsDrawer kode={rs} version={version} onClose={() => setRs(null)} onEvidence={onEvidence} onAction={onAction} />}
    </section>
  );
}
