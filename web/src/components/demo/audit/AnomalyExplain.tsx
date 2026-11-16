"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { Badge } from "./FacilityFile";

/* The anomaly model of the JKN demo, explained for people: how to read a doctor's card, every doctor on one map (who
   sits far from the crowd), and per doctor why — each reason as the doctor's real number against all doctors and
   against the same specialty, the eight detectors' verdicts, what they bill most, and the demo's answer key. */

type MapDoc = {
  id: string;
  nama: string;
  spesialisasi: string;
  skor: number;
  suara: number;
  peringkat: number;
  pola_baru: boolean;
  x: number;
  y: number;
  klaim: number;
  inap_pct: number;
  tarif_rs: number;
  selisih_tarif: number;
  lama_rawat: number;
  jumlah_obat: number;
  jam_masuk: number;
  disiplin_utama: string;
  disiplin_utama_pct: number;
  tertanam: string | null;
};
type MapData = { dokter: MapDoc[]; pca_explained: number[]; detektor: { kolom: string; nama: string; intuisi: string }[]; tertanam: Record<string, string> };
type Reason = {
  fitur: string;
  label: string;
  kontribusi: number;
  jenis?: "numerik" | "kategori";
  satuan?: "rp" | "num" | "int" | "jam";
  nilai?: number;
  median_semua?: number;
  median_sejawat?: number;
  persentil_semua?: number;
  persentil_sejawat?: number;
  sejawat?: number;
  hist?: { min: number; max: number; counts: number[] };
  kategori?: { kategori: string; dokter: number; semua: number; sejawat: number }[];
};
type Explained = {
  dokter: { id: string; nama: string; spesialisasi: string; faskes: string; skor: number; suara: number; peringkat: number; status: string; pola_baru: boolean; klaim: number; inap_pct: number; disiplin_utama: string; disiplin_utama_pct: number };
  populasi: { dokter: number; sejawat: number; median_skor: number; ambang_10pct: number | null };
  detektor: { kolom: string; nama: string; intuisi: string; persentil: number; suara: boolean }[];
  alasan: Reason[];
  prosedur: { kode: string; dokter: number; semua: number }[];
  tertanam: { jenis: string | null; keterangan: string | null };
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
  return r.json();
}

/** ICD-9-CM procedures the demo's claims use, in words. */
export const PROSEDUR: Record<string, string> = {
  none: "tanpa tindakan",
  "81.54": "penggantian sendi lutut total",
  "81.51": "penggantian sendi panggul total",
  "80.6": "meniskektomi lutut",
  "79.35": "reposisi terbuka + fiksasi fraktur femur",
  "88.91": "MRI otak",
  "36.06": "pemasangan stent koroner",
  "88.56": "angiografi koroner",
  "87.44": "foto thorax",
  "39.95": "hemodialisis",
  "47.09": "apendektomi",
  "53.00": "repair hernia inguinal",
  "51.23": "kolesistektomi laparoskopik",
  "74.1": "seksio sesarea",
  "73.59": "persalinan dibantu",
  "99.04": "transfusi PRC",
  "99.18": "injeksi elektrolit",
  "13.41": "fakoemulsifikasi katarak",
  "28.2": "tonsilektomi",
};

export const rp = (v: number) =>
  Math.abs(v) >= 1e9 ? `Rp ${(v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M` : Math.abs(v) >= 1e6 ? `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : Math.abs(v) >= 1e3 ? `Rp ${Math.round(v / 1e3).toLocaleString("id-ID")} rb` : `Rp ${Math.round(v).toLocaleString("id-ID")}`;
const fmt = (v: number | undefined, unit?: string) =>
  v == null ? "—" : unit === "rp" ? rp(v) : unit === "jam" ? `pukul ${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}` : v.toLocaleString("id-ID", { maximumFractionDigits: 1 });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ratio = (a?: number, b?: number) => (a != null && b ? a / b : null);
const timesText = (r: number | null) => (r == null ? "" : r >= 1.5 ? `${r.toLocaleString("id-ID", { maximumFractionDigits: r >= 10 ? 0 : 1 })}× median` : r <= 0.67 ? `${(1 / r).toLocaleString("id-ID", { maximumFractionDigits: 1 })}× lebih rendah dari median` : "dekat median");

/* ------------------------------------------------------------------------------------------- guide */

/** How to read a card: the pipeline in five steps, and the card's numbers labelled. */
export function AnomalyGuide({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const steps: [string, string, string][] = [
    ["1", "Klaim per SEP", "19.141 klaim 3 bulan: tarif, lama rawat, obat, diagnosis, prosedur, kelas, hari & jam, rujukan."],
    ["2", "Profil per dokter", "Klaim tiap dokter diringkas: rata-rata, median, min, maks, simpangan tiap angka; kategori dijadikan embedding LSA (73 fitur)."],
    ["3", "8 detektor menilai", "Tiap detektor menilai seberapa tidak lazim profil dokter dengan caranya sendiri, lalu nilainya diubah ke persentil: 0,95 berarti lebih tidak lazim dibanding 95% dokter."],
    ["4", "Skor & suara", "Skor = rata-rata 8 persentil. Suara (●) = jumlah detektor yang menempatkan dokter di 10% teratas; ditandai anomali bila ≥ 5 dari 8."],
    ["5", "Alasan (Shapley)", "Fitur mana yang menaikkan skor: +0,19 = tanpa fitur ini (diganti nilai dokter median), skor turun ±0,19."],
  ];
  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="text-[13px] font-semibold text-violet-200">Cara membaca deteksi anomali</span>
        <span className="text-[11px] text-muted">tanpa label: model tidak diberi tahu siapa yang curang — ia mencari dokter yang pola tagihannya berbeda dari dokter lain</span>
        <span className="ml-auto text-xs text-muted">{open ? "▲ tutup" : "▼ buka"}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-violet-500/20 p-3 2xl:grid-cols-[1fr_360px]">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2">
            {steps.map(([n, h, d]) => (
              <div key={n} className="relative rounded-md border border-line bg-ink p-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-200">{n}</span>
                  <span className="text-xs font-medium">{h}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-soft">{d}</p>
                
              </div>
            ))}
            <p className="col-span-full text-[11px] leading-relaxed text-muted">
              Anomali ≠ fraud. Profil dokter bisa tampak tidak lazim karena pekerjaannya memang berbeda (mis. bedah ortopedi yang mahal). Karena itu setiap alasan dibandingkan dua kali:
              dengan <b className="text-soft">semua dokter</b> dan dengan <b className="text-soft">sesama spesialisasi</b>. Yang menonjol terhadap keduanya patut diklarifikasi. Rancangan
              mengikuti De Meulemeester dkk. (2025), BMC Med Inform Decis Mak 25:14.
            </p>
          </div>
          <div className="rounded-md border border-line bg-ink p-2.5 text-[11px]">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Kartu dokter, dibaca</div>
            <div className="rounded border border-violet-500/40 p-2">
              <div className="flex items-center gap-2">
                <span className="text-muted">#1</span>
                <b>dr. Andi Wijaya</b>
                <span className="ml-auto font-semibold text-bad">1.00</span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span className="text-bad">●●●●●●●●</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="w-28 truncate">Selisih tarif RS − INA-CBG</span>
                <span className="h-1.5 w-16 rounded bg-bad" />
                <span className="text-muted">+0.187</span>
              </div>
            </div>
            <ul className="mt-2 space-y-1 text-soft">
              <li>
                <b className="text-white">#1</b> peringkat dari 263 dokter
              </li>
              <li>
                <b className="text-bad">1.00</b> skor: rata-rata persentil 8 detektor (median semua dokter ±0,5)
              </li>
              <li>
                <b className="text-bad">●●●●●●●●</b> 8 dari 8 detektor menempatkannya di 10% teratas (ditandai bila ≥ 5)
              </li>
              <li>
                <b className="text-white">+0.187</b> kontribusi fitur itu pada skor (Shapley)
              </li>
              <li>
                <b className="text-violet-300">Pola baru</b> = anomali tanpa kasus dari aturan skrining: hal yang aturan belum tangkap
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- map */

const AXES: Record<string, { label: string; get: (d: MapDoc) => number; log?: boolean; fmt: (v: number) => string }> = {
  pca1: { label: "Arah utama 1 (PCA dari 73 fitur)", get: (d) => d.x, fmt: (v) => v.toFixed(1) },
  pca2: { label: "Arah utama 2 (PCA)", get: (d) => d.y, fmt: (v) => v.toFixed(1) },
  tarif_rs: { label: "Tarif RS rata-rata per klaim", get: (d) => d.tarif_rs, log: true, fmt: rp },
  selisih_tarif: { label: "Selisih tarif RS − INA-CBG per klaim", get: (d) => d.selisih_tarif, log: true, fmt: rp },
  lama_rawat: { label: "Lama rawat rata-rata (hari)", get: (d) => d.lama_rawat, fmt: (v) => v.toFixed(1) },
  jumlah_obat: { label: "Jumlah obat per klaim", get: (d) => d.jumlah_obat, fmt: (v) => v.toFixed(1) },
  inap_pct: { label: "Porsi rawat inap (%)", get: (d) => d.inap_pct, fmt: (v) => `${v.toFixed(0)}%` },
};
const VIEWS: Record<string, [string, string, string]> = {
  pca: ["pca1", "pca2", "Ruang fitur model (PCA)"],
  tarif: ["tarif_rs", "selisih_tarif", "Tarif vs selisih tarif"],
  rawat: ["lama_rawat", "jumlah_obat", "Lama rawat vs obat"],
  inap: ["inap_pct", "tarif_rs", "Rawat inap vs tarif"],
};
const KIND_COLOR: Record<string, string> = {
  novel: "#a78bfa", upcoding: "#f97316", phantom: "#ef4444", los: "#eab308", obat: "#f59e0b", repeat: "#fb7185", kelas: "#fdba74", indikasi: "#dc2626",
  rujukan: "#38bdf8", selfref: "#22d3ee",
};
const MAP_W = 640;
const MAP_H = 270;
const MAP_PAD = { l: 64, r: 16, t: 14, b: 40 };
const LABEL_SIZE = 11;
const scoreColor = (s: number) => (s >= 0.9 ? "#ef4444" : s >= 0.75 ? "#f97316" : s >= 0.6 ? "#eab308" : "#475569");

export function AnomalyMap({ selected, onPick }: { selected: string | null; onPick: (id: string) => void }) {
  const [d, setD] = useState<MapData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState("pca");
  const [color, setColor] = useState<"skor" | "spesialis" | "kunci">("skor");
  const [hover, setHover] = useState<MapDoc | null>(null);
  // the window of data in view; null, or set for another view, = everything (a new view starts unzoomed)
  const [zoom, setZoom] = useState<{ view: string; x: [number, number]; y: [number, number] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; x: [number, number]; y: [number, number]; moved: boolean } | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    get<MapData>("/api/demo/jkn/workbench/anomali/peta").then(setD, (e: Error) => setErr(e.message));
  }, []);
  // the whole cloud with a 4 % margin, in the axes' (log) units
  const full = useMemo(() => {
    if (!d) return null;
    const [vx, vy] = VIEWS[view];
    const fx = (p: MapDoc) => (AXES[vx].log ? Math.log10(Math.max(1, AXES[vx].get(p))) : AXES[vx].get(p));
    const fy = (p: MapDoc) => (AXES[vy].log ? Math.log10(Math.max(1, AXES[vy].get(p))) : AXES[vy].get(p));
    const xs = d.dokter.map(fx);
    const ys = d.dokter.map(fy);
    const [a, b] = [Math.min(...xs), Math.max(...xs)];
    const [c, e] = [Math.min(...ys), Math.max(...ys)];
    const mx = (b - a || 1) * 0.04;
    const my = (e - c || 1) * 0.04;
    return { x: [a - mx, b + mx] as [number, number], y: [c - my, e + my] as [number, number] };
  }, [d, view]);
  // scroll zooms about the cursor (React's wheel listener is passive, so it is attached here)
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !full) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const b = el.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, ((ev.clientX - b.left) / b.width * MAP_W - MAP_PAD.l) / (MAP_W - MAP_PAD.l - MAP_PAD.r)));
      const fy = Math.min(1, Math.max(0, 1 - ((ev.clientY - b.top) / b.height * MAP_H - MAP_PAD.t) / (MAP_H - MAP_PAD.t - MAP_PAD.b)));
      const f = Math.exp(ev.deltaY * 0.0015);
      setZoom((z) => {
        const base = z && z.view === view ? z : { view, ...full };
        const scale = (lo: number, hi: number, at: number, all: [number, number]): [number, number] => {
          const span = Math.min(all[1] - all[0], Math.max((all[1] - all[0]) / 60, (hi - lo) * f));
          const pivot = lo + (hi - lo) * at;
          return [pivot - span * at, pivot + span * (1 - at)];
        };
        return { view, x: scale(base.x[0], base.x[1], fx, full.x), y: scale(base.y[0], base.y[1], fy, full.y) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [full, view]);
  const specs = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of d?.dokter ?? []) c[x.spesialisasi] = (c[x.spesialisasi] ?? 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [d]);
  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!d) return <p className="py-8 text-center text-xs text-muted">Memuat peta dokter…</p>;
  const [ax, ay] = VIEWS[view];
  const X = AXES[ax];
  const Y = AXES[ay];
  const W = MAP_W;
  const H = MAP_H;
  const pad = MAP_PAD;
  const tx = (v: number) => (X.log ? Math.log10(Math.max(1, v)) : v);
  const ty = (v: number) => (Y.log ? Math.log10(Math.max(1, v)) : v);
  const win = zoom && zoom.view === view ? zoom : full!;
  const [x0, x1] = win.x;
  const [y0, y1] = win.y;
  const zoomed = win !== full;
  const sx = (v: number) => pad.l + ((tx(v) - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((ty(v) - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const toBox = (cx: number, cy: number) => {
    const b = svgRef.current!.getBoundingClientRect();
    return [((cx - b.left) / b.width) * W, ((cy - b.top) / b.height) * H] as const;
  };
  const zoomBy = (f: number) =>
    setZoom(() => {
      const shrink = (lo: number, hi: number, all: [number, number]): [number, number] => {
        const mid = (lo + hi) / 2;
        const span = Math.min(all[1] - all[0], Math.max((all[1] - all[0]) / 60, (hi - lo) * f));
        return [mid - span / 2, mid + span / 2];
      };
      return { view, x: shrink(x0, x1, full!.x), y: shrink(y0, y1, full!.y) };
    });
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [px, py] = toBox(e.clientX, e.clientY);
    drag.current = { px, py, x: [x0, x1], y: [y0, y1], moved: false };
    moved.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g) return;
    const [px, py] = toBox(e.clientX, e.clientY);
    if (!g.moved && Math.hypot(px - g.px, py - g.py) < 4) return;
    if (!g.moved) {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragging(true);
    }
    g.moved = true;
    moved.current = true;
    const dx = ((px - g.px) / (W - pad.l - pad.r)) * (g.x[1] - g.x[0]);
    const dy = ((py - g.py) / (H - pad.t - pad.b)) * (g.y[1] - g.y[0]);
    setZoom({ view, x: [g.x[0] - dx, g.x[1] - dx], y: [g.y[0] + dy, g.y[1] + dy] });
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const ticks = (lo: number, hi: number, log?: boolean) => Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5).map((t) => (log ? 10 ** t : t));
  const specColor = (s: string) => {
    const pal = ["#60a5fa", "#a78bfa", "#34d399", "#f472b6", "#fbbf24", "#22d3ee", "#fb923c", "#a3e635", "#e879f9", "#94a3b8"];
    return s === "Dokter umum" ? "#e2e8f0" : pal[specs.indexOf(s) % pal.length];
  };
  const fill = (p: MapDoc) => (color === "skor" ? scoreColor(p.skor) : color === "spesialis" ? specColor(p.spesialisasi) : p.tertanam ? KIND_COLOR[p.tertanam] ?? "#f87171" : "#334155");
  // draw the quiet points first so the unusual ones stay on top
  const order = [...d.dokter].sort((a, b) => a.skor - b.skor);
  // labels for the top three and the selected doctor: right, above, below or left of the point, whichever is free
  const labels: { id: string; text: string; x: number; y: number; anchor: "start" | "end" }[] = [];
  const boxes: [number, number, number, number][] = [];
  for (const p of [...d.dokter].filter((p) => p.peringkat <= 3 || p.id === selected).sort((a, b) => a.peringkat - b.peringkat)) {
    const cx = sx(X.get(p));
    const cy = sy(Y.get(p));
    if (cx < pad.l || cx > W - pad.r || cy < pad.t || cy > H - pad.b) continue;
    const r = 2.5 + p.suara * 0.55;
    const text = `#${p.peringkat} ${p.nama.replace(/^dr\. /, "")}`;
    const w = text.length * LABEL_SIZE * 0.56;
    const h = LABEL_SIZE + 2;
    const spots: [number, number, "start" | "end"][] = [
      [cx + r + 3, cy + LABEL_SIZE / 3, "start"],
      [cx + r + 2, cy - r - 4, "start"],
      [cx + r + 2, cy + r + LABEL_SIZE + 1, "start"],
      [cx - r - 3, cy + LABEL_SIZE / 3, "end"],
      [cx + r + 3, cy - r - LABEL_SIZE - 6, "start"],
      [cx + r + 3, cy + r + 2 * LABEL_SIZE + 4, "start"],
    ];
    const box = ([x, y, a]: [number, number, "start" | "end"]): [number, number, number, number] => (a === "start" ? [x, y - LABEL_SIZE, x + w, y - LABEL_SIZE + h] : [x - w, y - LABEL_SIZE, x, y - LABEL_SIZE + h]);
    const free = (b: [number, number, number, number]) =>
      b[0] >= pad.l && b[2] <= W - pad.r && b[1] >= pad.t && b[3] <= H - pad.b && !boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    const pick = spots.find((sp) => free(box(sp))) ?? spots[0];
    boxes.push(box(pick));
    labels.push({ id: p.id, text, x: pick[0], y: pick[1], anchor: pick[2] });
  }
  return (
    <div className="grid gap-3 2xl:grid-cols-[1fr_240px]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} type="button" onClick={() => setView(k)}
              className={`rounded-md border px-2 py-1 text-[11px] ${view === k ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft hover:border-ocean"}`}>
              {v[2]}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-muted">warna</span>
          <select value={color} onChange={(e) => setColor(e.target.value as typeof color)} className="rounded-md border border-line-2 bg-ink px-2 py-1 text-[11px]">
            <option value="skor">skor anomali</option>
            <option value="spesialis">spesialisasi</option>
            <option value="kunci">kunci demo (pola tertanam)</option>
          </select>
        </div>
        <div className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`w-full touch-none select-none rounded-md border border-line bg-ink ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          <defs>
            <clipPath id="anom-plot">
              <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} />
            </clipPath>
          </defs>
          {ticks(x0, x1, X.log).map((t, i) => (
            <g key={`x${i}`}>
              <line x1={sx(t)} x2={sx(t)} y1={pad.t} y2={H - pad.b} stroke="#1e293b" />
              <text x={sx(t)} y={H - pad.b + 14} fontSize={10} textAnchor="middle" fill="#64748b">{X.fmt(t)}</text>
            </g>
          ))}
          {ticks(y0, y1, Y.log).map((t, i) => (
            <g key={`y${i}`}>
              <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="#1e293b" />
              <text x={pad.l - 6} y={sy(t) + 3} fontSize={10} textAnchor="end" fill="#64748b">{Y.fmt(t)}</text>
            </g>
          ))}
          <text x={(W + pad.l) / 2} y={H - 6} fontSize={11} textAnchor="middle" fill="#94a3b8">{X.label}{X.log ? " (skala log)" : ""}</text>
          <text x={12} y={(H - pad.b) / 2} fontSize={11} textAnchor="middle" fill="#94a3b8" transform={`rotate(-90 12 ${(H - pad.b) / 2})`}>{Y.label}{Y.log ? " (log)" : ""}</text>
          <g clipPath="url(#anom-plot)">
          {order.map((p) => {
            const isSel = p.id === selected;
            const r = 2.5 + p.suara * 0.55;
            return (
              <g key={p.id} className="cursor-pointer" onClick={() => !moved.current && onPick(p.id)} onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}>
                <circle cx={sx(X.get(p))} cy={sy(Y.get(p))} r={r} fill={fill(p)} fillOpacity={p.skor >= 0.75 || color !== "skor" ? 0.9 : 0.45}
                  stroke={isSel ? "#fff" : p.pola_baru ? "#a78bfa" : "#020617"} strokeWidth={isSel ? 2.2 : p.pola_baru ? 1.4 : 0.6} />
              </g>
            );
          })}
          {labels.map((l) => (
            <text key={l.id} x={l.x} y={l.y} fontSize={LABEL_SIZE} textAnchor={l.anchor} fill="#e2e8f0" stroke="#020617" strokeWidth={3} paintOrder="stroke" pointerEvents="none">
              {l.text}
            </text>
          ))}
          </g>
        </svg>
        <div className="absolute right-2 top-2 flex gap-1">
          {([["+", "Perbesar", () => zoomBy(1 / 1.6)], ["−", "Perkecil", () => zoomBy(1.6)], ["⌂", "Tampilkan semua", () => setZoom(null)]] as const).map(([t, l, fn]) => (
            <button key={l} type="button" onClick={fn} title={l} aria-label={l} disabled={t === "⌂" && !zoomed}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-line-2 bg-ink/90 text-sm text-soft hover:border-ocean hover:text-white disabled:opacity-40">
              {t}
            </button>
          ))}
        </div>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Tiap titik = satu dokter ({d.dokter.length}). Besar titik = jumlah suara detektor; cincin ungu = pola baru. {view === "pca"
            ? `PCA meringkas 73 fitur model ke 2 arah yang paling banyak menjelaskan perbedaan antar dokter (${Math.round((d.pca_explained[0] + d.pca_explained[1]) * 100)}% variasi): dokter yang jauh dari populasi = profil yang jarang.`
            : "Sumbu memakai angka per klaim yang bisa diperiksa langsung di klaimnya."}{" "}
          Gulir untuk zoom, seret untuk geser, klik titik untuk penjelasannya.
        </p>
      </div>
      <div className="space-y-2 text-[11px]">
        <div className="rounded-md border border-line bg-ink p-2.5">
          {hover ? (
            <>
              <div className="font-medium">#{hover.peringkat} {hover.nama}</div>
              <div className="text-muted">{hover.spesialisasi} · {hover.klaim} klaim</div>
              <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5">
                <dt className="text-muted">Skor · suara</dt>
                <dd>{hover.skor.toFixed(2)} · {hover.suara}/8</dd>
                <dt className="text-muted">Tarif RS / klaim</dt>
                <dd>{rp(hover.tarif_rs)}</dd>
                <dt className="text-muted">Selisih / klaim</dt>
                <dd>{rp(hover.selisih_tarif)}</dd>
                <dt className="text-muted">Lama rawat</dt>
                <dd>{hover.lama_rawat.toFixed(1)} hari</dd>
                <dt className="text-muted">Disiplin utama</dt>
                <dd>{hover.disiplin_utama} ({hover.disiplin_utama_pct}%)</dd>
              </dl>
              {color === "kunci" && hover.tertanam && <div className="mt-1.5 text-[10.5px]" style={{ color: KIND_COLOR[hover.tertanam] }}>{d.tertanam[hover.tertanam]}</div>}
            </>
          ) : (
            <span className="text-muted">Arahkan kursor ke titik untuk melihat angkanya.</span>
          )}
        </div>
        <div className="rounded-md border border-line bg-ink p-2.5">
          <div className="mb-1 font-medium">Legenda</div>
          {color === "skor" &&
            ([["≥ 0,90", "#ef4444"], ["0,75–0,90", "#f97316"], ["0,60–0,75", "#eab308"], ["< 0,60 (biasa)", "#475569"]] as const).map(([l, c]) => (
              <div key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{l}</div>
            ))}
          {color === "spesialis" &&
            specs.slice(0, 11).map((s) => (
              <div key={s} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: specColor(s) }} /><span className="truncate">{s}</span></div>
            ))}
          {color === "kunci" && (
            <>
              <p className="mb-1 text-muted">Kunci jawaban data sintetis — tidak dilihat model. Bandingkan dengan skor.</p>
              {Object.entries(d.tertanam).map(([k, v]) => (
                <div key={k} className="flex items-start gap-1.5" title={v}>
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[k] }} />
                  <span className="line-clamp-2">{v}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#334155]" />tanpa pola tertanam</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ drawer */

/** A population histogram with the doctor (red), the median of all doctors (grey) and of peers (blue). */
function Strip({ r }: { r: Reason }) {
  if (!r.hist || r.nilai == null) return null;
  const W = 300;
  const H = 46;
  const { min, max, counts } = r.hist;
  const peak = Math.max(1, ...counts);
  const x = (v: number) => ((v - min) / (max - min || 1)) * W;
  const bw = W / counts.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full">
      {counts.map((c, i) => (
        <rect key={i} x={i * bw + 0.5} y={H - (c / peak) * (H - 4)} width={bw - 1} height={(c / peak) * (H - 4)} fill="#334155" />
      ))}
      {r.median_semua != null && <line x1={x(r.median_semua)} x2={x(r.median_semua)} y1={0} y2={H} stroke="#94a3b8" strokeDasharray="3 2" />}
      {r.median_sejawat != null && <line x1={x(r.median_sejawat)} x2={x(r.median_sejawat)} y1={0} y2={H} stroke="#60a5fa" strokeDasharray="3 2" />}
      <line x1={x(r.nilai)} x2={x(r.nilai)} y1={0} y2={H} stroke="#ef4444" strokeWidth={2.5} />
      <text x={0} y={H + 10} fontSize={9} fill="#64748b">{fmt(min, r.satuan)}</text>
      <text x={W} y={H + 10} fontSize={9} fill="#64748b" textAnchor="end">{fmt(max, r.satuan)}</text>
    </svg>
  );
}

/** The model flags a doctor when at least 5 of the 8 detectors put them in their top 10 % (the scoring pipeline's rule). */
const FLAG_VOTES = 5;
const nf = (v: number, d = 2) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const higherThan = (p?: number) => (p == null ? "" : p >= 99 ? "termasuk yang tertinggi" : p <= 1 ? "termasuk yang terendah" : p >= 50 ? `lebih tinggi dari ${p}%` : `lebih rendah dari ${100 - p}%`);
const peerName = (spes: string) => (spes === "Dokter umum" ? "dokter umum" : spes);

function narrative(e: Explained): string[] {
  const d = e.dokter;
  const out: string[] = [];
  const flagged = d.suara >= FLAG_VOTES;
  const rank = `peringkat ${d.peringkat} dari ${e.populasi.dokter} dokter`;
  if (flagged)
    out.push(`Profil tagihan ${d.nama} termasuk yang paling tidak lazim: ${rank}, dengan skor ${nf(d.skor)}. ${d.suara} dari 8 detektor menempatkannya di kelompok 10% teratas, melewati ambang ${FLAG_VOTES} detektor yang dipakai untuk menandai anomali.`);
  else if (d.suara > 0)
    out.push(`Profil tagihan ${d.nama} cukup menonjol (${rank}, skor ${nf(d.skor)}), tetapi baru ${d.suara} dari 8 detektor yang menempatkannya di kelompok 10% teratas. Ambang penandaan adalah ${FLAG_VOTES} detektor, sehingga dokter ini tidak ditandai sebagai anomali.`);
  else
    out.push(`Profil tagihan ${d.nama} tergolong wajar: ${rank}, dengan skor ${nf(d.skor)} (median seluruh dokter ${nf(e.populasi.median_skor)}). Tidak ada detektor yang menempatkannya di kelompok 10% teratas, sehingga dokter ini tidak ditandai sebagai anomali.`);
  for (const r of e.alasan.filter((x) => x.jenis === "numerik").slice(0, 2)) {
    const t = ratio(r.nilai, r.median_semua);
    const times = t == null ? "" : t >= 1.5 ? `, sekitar ${t.toLocaleString("id-ID", { maximumFractionDigits: t >= 10 ? 0 : 1 })}× median seluruh dokter (${fmt(r.median_semua, r.satuan)})` : `; median seluruh dokter ${fmt(r.median_semua, r.satuan)}`;
    const peerOk = (r.persentil_sejawat ?? 0) < 80 && (r.persentil_semua ?? 0) >= 90;
    out.push(
      `${r.label} rata-rata ${fmt(r.nilai, r.satuan)}${times}, ${(r.persentil_semua ?? 0) >= 99 || (r.persentil_semua ?? 100) <= 1 ? `${higherThan(r.persentil_semua)} di antara seluruh dokter` : `${higherThan(r.persentil_semua)} dokter`}. ` +
        `Dibandingkan ${r.sejawat} ${peerName(d.spesialisasi)} lainnya, nilainya ${(r.persentil_sejawat ?? 0) >= 99 || (r.persentil_sejawat ?? 100) <= 1 ? higherThan(r.persentil_sejawat) : `${higherThan(r.persentil_sejawat)} di antaranya`} (median ${fmt(r.median_sejawat, r.satuan)}).` +
        (peerOk ? ` Di antara sesama ${peerName(d.spesialisasi)}, nilai ini masih lazim; ia menonjol terutama karena dibandingkan dengan seluruh dokter.` : ""),
    );
  }
  const cat = e.alasan.find((x) => x.jenis === "kategori" && x.kategori?.length);
  if (cat?.kategori) {
    const top = [...cat.kategori].sort((a, b) => b.dokter - b.semua - (a.dokter - a.semua))[0];
    if (top)
      out.push(`${cat.label}: ${pct(top.dokter)} klaimnya tergolong "${PROSEDUR[top.kategori] ? `${top.kategori} ${PROSEDUR[top.kategori]}` : top.kategori}", dibandingkan ${pct(top.semua)} pada seluruh dokter dan ${pct(top.sejawat)} pada sesama ${peerName(d.spesialisasi)}.`);
  }
  const p = e.prosedur.find((x) => x.kode !== "none");
  if (p)
    out.push(`Tindakan yang paling sering ditagih adalah ${p.kode}${PROSEDUR[p.kode] ? ` (${PROSEDUR[p.kode]})` : ""}, yaitu ${pct(p.dokter)} dari klaimnya, sementara porsinya pada seluruh klaim ${pct(p.semua)}. Sebagian besar klaimnya pada disiplin ${d.disiplin_utama} (${nf(d.disiplin_utama_pct, 0)}%), dengan ${nf(d.inap_pct, 0)}% rawat inap.`);
  if (flagged)
    out.push(d.pola_baru
      ? "Dokter ini belum memiliki kasus dari aturan skrining, sehingga temuan ini merupakan kandidat pola baru yang perlu diklarifikasi — bukan bukti kecurangan."
      : "Dokter ini sudah memiliki kasus dari aturan skrining; hasil model anomali menguatkan temuan tersebut.");
  else out.push("Berdasarkan model anomali, tidak diperlukan tindak lanjut untuk dokter ini. Kasus dari aturan skrining, bila ada, tetap ditangani secara terpisah.");
  return out;
}

export function AnomalyDrawer({ id, onClose, actions }: { id: string; onClose: () => void; actions?: React.ReactNode }) {
  const [e, setE] = useState<Explained | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [loadedId, setLoadedId] = useState(id);
  if (loadedId !== id) {
    setLoadedId(id);
    setE(null);
    setShowKey(false);
  }
  useEffect(() => {
    let alive = true;
    get<Explained>(`/api/demo/jkn/workbench/anomali/${encodeURIComponent(id)}`).then(
      (x) => alive && setE(x),
      (x: Error) => alive && setErr(x.message),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <>
      <aside className="flex h-full w-[600px] max-w-[50vw] shrink-0 flex-col border-l border-line bg-panel">
        <header className="flex items-start gap-3 border-b border-line p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted">{e && e.dokter.suara < FLAG_VOTES ? "Penjelasan skor anomali" : "Mengapa dokter ini ditandai?"}</div>
            <h2 className="text-lg font-semibold">{e?.dokter.nama ?? "…"}</h2>
            {e && (
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>{e.dokter.spesialisasi}</span>·<span>{e.dokter.faskes}</span>·<span>{e.dokter.klaim} klaim</span>
                {e.dokter.suara >= FLAG_VOTES ? (
                  <Badge text={e.dokter.pola_baru ? "Anomali · pola baru, belum ada kasus aturan" : "Anomali · sudah ada kasus aturan"} color={e.dokter.pola_baru ? "#a78bfa" : "#ef4444"} />
                ) : (
                  <Badge text="Tidak ditandai sebagai anomali" color="#64748b" />
                )}
              </div>
            )}
          </div>
          {e && (
            <div className="text-right">
              <div className={`text-2xl font-semibold tabular-nums ${e.dokter.suara >= FLAG_VOTES ? "text-bad" : "text-soft"}`}>{nf(e.dokter.skor)}</div>
              <div className="text-[11px] text-muted">#{e.dokter.peringkat} · {e.dokter.suara}/8 suara</div>
            </div>
          )}
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-muted hover:text-white" aria-label="Tutup">✕</button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>}
          {!e && !err && <p className="py-10 text-center text-xs text-muted">Menghitung penjelasan…</p>}
          {e && (
            <>
              <section className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-200">Ringkasnya</div>
                <ul className="list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-soft">
                  {narrative(e).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                {actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
              </section>

              <section>
                <h3 className="mb-1 text-[13px] font-semibold">Alasan, dengan angkanya</h3>
                <p className="mb-2 text-[11px] text-muted">
                  Urut kontribusi Shapley. Garis <span className="text-bad">merah</span> = dokter ini, <span className="text-soft">abu putus-putus</span> = median semua dokter,{" "}
                  <span className="text-sky-400">biru putus-putus</span> = median sesama {e.dokter.spesialisasi}. Batang abu = sebaran semua dokter.
                </p>
                {!e.alasan.length && (
                  <p className="rounded-md border border-line bg-ink p-2.5 text-xs text-muted">
                    Alasan per fitur (nilai Shapley) hanya dihitung untuk dokter dengan skor 0,80 ke atas. Skor dokter ini {nf(e.dokter.skor)}, sehingga
                    tidak ada fitur yang perlu dijelaskan; tindakan dan putusan detektor di bawah tetap ditampilkan.
                  </p>
                )}
                <div className="grid gap-2">
                  {e.alasan.map((r) => (
                    <div key={r.fitur} className="rounded-md border border-line bg-ink p-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.label}</span>
                        <span className="text-[11px] tabular-nums text-bad" title="kenaikan skor anomali karena fitur ini (Shapley)">+{Number(r.kontribusi).toFixed(3)}</span>
                      </div>
                      {r.jenis === "numerik" && (
                        <>
                          <div className="mt-0.5 text-[11px] text-soft">
                            <b className="text-white">{fmt(r.nilai, r.satuan)}</b> · {timesText(ratio(r.nilai, r.median_semua))} semua · persentil {r.persentil_semua} (semua) / {r.persentil_sejawat} (sejawat)
                          </div>
                          <Strip r={r} />
                        </>
                      )}
                      {r.jenis === "kategori" && (
                        <div className="mt-1 space-y-1">
                          {(r.kategori ?? []).slice(0, 4).map((k) => (
                            <div key={k.kategori} className="grid grid-cols-[80px_1fr] items-center gap-2 text-[10.5px]">
                              <span className="truncate font-mono" title={PROSEDUR[k.kategori] ?? k.kategori}>{k.kategori}</span>
                              <span className="space-y-0.5">
                                {([["dokter", k.dokter, "#ef4444"], ["semua", k.semua, "#64748b"], ["sejawat", k.sejawat, "#60a5fa"]] as const).map(([l, v, c]) => (
                                  <span key={l} className="flex items-center gap-1">
                                    <span className="h-1.5 rounded" style={{ width: `${Math.max(2, v * 100)}%`, background: c }} />
                                    <span className="tabular-nums text-muted">{pct(v)}</span>
                                  </span>
                                ))}
                              </span>
                            </div>
                          ))}
                          <div className="text-[10px] text-muted"><span className="text-bad">■</span> dokter <span className="text-slate-500">■</span> semua <span className="text-sky-400">■</span> sejawat</div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="mb-1 text-[13px] font-semibold">Tindakan yang paling sering ditagih</h3>
                <div className="space-y-1">
                  {e.prosedur.map((p) => (
                    <div key={p.kode} className="grid grid-cols-[minmax(0,220px)_1fr_auto] items-center gap-2 text-xs">
                      <span className="truncate"><span className="font-mono">{p.kode}</span> <span className="text-muted">{PROSEDUR[p.kode] ?? ""}</span></span>
                      <span className="relative h-3 rounded bg-line/40">
                        <span className="absolute inset-y-0 left-0 rounded bg-bad/80" style={{ width: `${p.dokter * 100}%` }} />
                        <span className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `${p.semua * 100}%` }} title="porsi pada semua klaim" />
                      </span>
                      <span className="tabular-nums text-muted">{pct(p.dokter)} vs {pct(p.semua)}</span>
                    </div>
                  ))}
                  <div className="text-[10.5px] text-muted">batang = porsi klaim dokter ini · garis putih = porsi pada semua klaim</div>
                </div>
              </section>

              <section>
                <h3 className="mb-1 text-[13px] font-semibold">Putusan 8 detektor</h3>
                <p className="mb-2 text-[11px] text-muted">Persentil dokter ini menurut tiap detektor. Melewati garis 0,9 = satu suara (10% teratas).</p>
                <div className="space-y-1.5">
                  {e.detektor.map((x) => (
                    <div key={x.kolom} className="grid grid-cols-[150px_1fr_44px] items-center gap-2 text-xs" title={x.intuisi}>
                      <span className="truncate">{x.nama}</span>
                      <span className="relative h-3 rounded bg-line/40">
                        <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${x.persentil * 100}%`, background: x.suara ? "#ef4444" : "#64748b" }} />
                        <span className="absolute inset-y-[-2px] w-px bg-white/70" style={{ left: "90%" }} />
                      </span>
                      <span className="text-right tabular-nums">{x.persentil.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <details className="mt-2 text-[11px] text-muted">
                  <summary className="cursor-pointer">Cara tiap detektor menilai</summary>
                  <ul className="mt-1 space-y-0.5">
                    {e.detektor.map((x) => (
                      <li key={x.kolom}><b className="text-soft">{x.nama}</b> — {x.intuisi}</li>
                    ))}
                  </ul>
                </details>
              </section>

              <section className="rounded-lg border border-dashed border-line-2 p-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold">Kunci jawaban demo</h3>
                  <span className="text-[11px] text-muted">data sintetis menyisipkan pola pada sebagian dokter — model tidak melihatnya</span>
                  <button type="button" onClick={() => setShowKey((v) => !v)} className="ml-auto rounded border border-line-2 px-2 py-0.5 text-[11px] hover:border-ocean">
                    {showKey ? "Sembunyikan" : "Tampilkan"}
                  </button>
                </div>
                {showKey && (
                  <p className="mt-2 text-[13px]" style={{ color: e.tertanam.jenis ? KIND_COLOR[e.tertanam.jenis] ?? "#f87171" : "#94a3b8" }}>
                    {e.tertanam.keterangan ?? "Tidak ada pola yang disisipkan pada dokter ini: skornya tinggi karena profil tagihannya memang jarang (mis. tindakan mahal) — contoh mengapa anomali perlu diklarifikasi, bukan langsung dianggap fraud."}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
