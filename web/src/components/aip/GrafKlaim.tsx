"use client";

// Jaringan klaim in the AI Agent Swarm Branch case file, drawn the way /testing draws its investigation network (the user,
// 2026-11-14: "i want it show something like this"): documents (claims) and the entities they name (member, hospital, INA-CBG
// code) joined by edges, in a force layout. Data: graf_<kc>.json from testing/graf_cabang.py, rebuilt from the stream the model
// scored and checked against the saved features. The comparison claims are the earlier claims the screening model averaged
// (same member / hospital / hospital + code / code); the "Jaringan RS" claims are the hospitals the member visited within +-14
// days and the members they share (the network rule's basis). A tie a verifier checks by hand (the same claim filed twice, an
// overlapping stay, a readmission, the card at another hospital, a clone-like bill) is a document ringed red with a red dashed
// link to this claim, as the case explanation says. Synthetic data.

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Jejak } from "./JejakKlaim";
import type { IotKasus } from "./IotKlaim";

type Rel ="peserta" | "faskes" | "faskes_kode" | "kode";
export type GKlaim = {
  id: string; tgl: string; pulang: string; kode: string; tingkat: string; los: number; biaya: number; rs: string; peserta: string; dx: string;
  peserta_id: string; faskes_id: string; asal: "batch" | "riwayat"; keputusan: string | null; keputusan_mesin: string | null; sinyal: string[];
  relasi: (Rel | "cincin")[]; tanda: string[]; kasus?: { id: string; kc: string; keputusan: string };
};
type GRelasi = { kunci: Rel; nama: string; maks: number; klaim: string[]; sebelumnya: number };
type RsLain = { id: string; label: string; kunjungan_peserta: number; peserta_bersama: number; contoh_peserta: string[] };
export type Penjelasan = {
  paragraf: string; modus: { kode: string; nama: string }; jenis_fraud: { kode: string; nama: string; keyakinan: string; bukti: string }[];
  bukti: string[]; langkah: string[]; catatan: string; alur: { label: string; nilai: string; nyala?: boolean }[];
  dorongan: { klaim: number; graph: number; mekanisme: number }; pemeriksaan: string[];
  skor: { model: number; di_atas_normal: number; ambang_ragu: number; ambang_tahan: number };
  jejak: { tahap: string; hasil: string; nyala: boolean; rinci: string[] }[];
};
export type GrafKasus = {
  fokus: GKlaim; klaim: Record<string, GKlaim>; relasi: GRelasi[]; sinyal: { kode: string; label: string }[]; cocok: boolean;
  cincin: { hari: number; rs_dikunjungi: number; peserta_bersama: number; maks_bersama_satu_rs: number; rs_lain: RsLain[] };
  entitas: Record<"peserta" | "rs" | "rs_kode" | "kode", { label: string; sebelumnya: number; deskripsi?: string }>;
  penjelasan: Penjelasan;
  jejak?: Jejak;  // the claim's data lineage (testing/graf_cabang.py jejak_klaim, JejakKlaim); missing in runs built before 2026-11-14
  iot?: IotKasus;  // the claim's medical-device evidence (testing/iot_cabang.py, IotKlaim); only claims with a monitored device, runs since 2026-11-15
};
export type GrafKC = { dibuat: string; run: string; kc: string; hari_cincin: number; kasus: Record<string, GrafKasus>; cek: { klaim: number; tidak_cocok: number } };

const nf = (v: number) => v.toLocaleString("id-ID");
export const rpId = (v: number) => `Rp${Math.round(v).toLocaleString("id-ID")}`;
// the /testing palette (dark)
const W_ = { canvas: "#0f151d", dot: "#1d2733", line: "#2b3847", muted: "#8e9cad", ink2: "#c3ccd7", accent: "#7ea3ff", bad: "#ff7d9c",
  peserta: "#8fb0d8", rs: "#7ea3ff", kode: "#b99be8", klaim: "#6f7d8d", tahan: "#ff7d9c", periksa: "#f2b35a" };
const REL_NAMA: Record<string, string> = { peserta: "peserta sama", faskes: "RS sama", faskes_kode: "RS + kode INA-CBG sama", kode: "kode INA-CBG sama", cincin: "jaringan RS ±14 hari" };
const KEP_NAMA: Record<string, string> = { TAHAN: "ditahan", PERIKSA: "perlu diperiksa", DIBERSIHKAN: "dibersihkan swarm", LOLOS: "lolos" };
export const TANDA: Record<string, [string, string]> = {
  sama_persis: ["klaim ganda?", "Peserta, RS, kode INA-CBG dan tanggal masuk sama dengan klaim ini: calon klaim ganda."],
  tumpang_tindih: ["tumpang tindih", "Rawat inap di RS lain yang tanggalnya beririsan dengan klaim ini: satu orang tidak bisa dirawat di dua RS."],
  readmisi_dekat: ["readmisi ≤3 hari", "Pulang dari RS yang sama 0–3 hari sebelum klaim ini masuk: cek pemecahan episode."],
  beda_rs_dekat: ["RS lain ±3 hari", "Kartu yang sama dipakai di RS lain dalam ±3 hari: cek kartu dipinjam."],
  mirip_kloning: ["mirip kloning", "Peserta lain, RS dan kode sama, lama rawat dan tagihan hampir sama (±5%) dalam ±3 hari: cek klaim jiplakan."],
};

type Tipe = "klaim" | "peserta" | "rs" | "kode";
type Grup = "fokus" | "pembanding" | "cincin";
type Simpul = SimulationNodeDatum & { id: string; tipe: Tipe; label: string; fokus?: boolean; formulir?: boolean; k?: GKlaim; grup: Set<Grup>; n: number };
type Garis = { source: string | Simpul; target: string | Simpul; rel: "peserta" | "rs" | "kode" };
const kepKlaim = (k: GKlaim) => (k.asal === "batch" ? k.keputusan : k.keputusan_mesin) ?? "";
const warnaKlaim = (k: GKlaim) => (kepKlaim(k) === "TAHAN" ? W_.tahan : kepKlaim(k) === "PERIKSA" ? W_.periksa : W_.klaim);

/** Documents and entities with their groups (this claim, the model's comparison claims, the hospital network). */
function bangun(g: GrafKasus): { nodes: Simpul[]; links: Garis[] } {
  const nodes = new Map<string, Simpul>();
  const links: Garis[] = [];
  const kunci = new Set<string>();
  const f = g.fokus;
  const tambah = (id: string, tipe: Tipe, label: string, grup: Grup[], extra: Partial<Simpul> = {}) => {
    const ada = nodes.get(id);
    if (ada) { grup.forEach((x) => ada.grup.add(x)); ada.n += 1; return; }
    nodes.set(id, { id, tipe, label, grup: new Set(grup), n: 1, ...extra });
  };
  const garis = (a: string, b: string, rel: Garis["rel"]) => { const k = `${a}|${b}`; if (!kunci.has(k)) { kunci.add(k); links.push({ source: a, target: b, rel }); } };
  const dokumen = (k: GKlaim, grup: Grup[], fokus = false) => {
    tambah(k.id, "klaim", fokus ? "klaim ini" : `${k.tgl} · ${k.kode}`, grup, { fokus, k });
    tambah(k.peserta_id, "peserta", k.peserta, grup, { formulir: fokus || nodes.get(k.peserta_id)?.formulir });
    tambah(k.faskes_id, "rs", k.rs, grup, { formulir: fokus || nodes.get(k.faskes_id)?.formulir });
    garis(k.id, k.peserta_id, "peserta");
    garis(k.id, k.faskes_id, "rs");
    if (k.kode === f.kode) { tambah(`c:${f.kode}`, "kode", `INA-CBG ${f.kode}`, grup, { formulir: true }); garis(k.id, `c:${f.kode}`, "kode"); }
  };
  dokumen(f, ["fokus"], true);
  for (const k of Object.values(g.klaim)) {
    const grup: Grup[] = [];
    if (k.relasi.some((r) => r !== "cincin")) grup.push("pembanding");
    if (k.relasi.includes("cincin")) grup.push("cincin");
    dokumen(k, grup);
  }
  for (const id of [f.peserta_id, f.faskes_id, `c:${f.kode}`]) { const n = nodes.get(id); if (n) { n.formulir = true; n.grup.add("fokus"); } }
  return { nodes: [...nodes.values()], links };
}

/** A force layout as /testing runs it (link lengths by relation, charge, gentle centering, collision), run to rest. */
function tata(nodes: Simpul[], links: Garis[], benih: number) {
  let s = benih * 9301 + 49297;
  const acak = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  nodes.forEach((n, i) => {
    if (n.fokus) { n.fx = 0; n.fy = 0; n.x = 0; n.y = 0; return; }
    n.fx = null; n.fy = null;
    const a = (i / Math.max(1, nodes.length)) * 2 * Math.PI + (benih ? acak() : 0);
    const r = 60 + 140 * (benih ? acak() : (i % 7) / 7);
    n.x = r * Math.cos(a); n.y = r * Math.sin(a); n.vx = 0; n.vy = 0;
  });
  const sim = forceSimulation<Simpul>(nodes)
    .force("link", forceLink<Simpul, Garis>(links).id((d) => d.id).distance((l) => (l.rel === "peserta" ? 38 : l.rel === "rs" ? 58 : 75)).strength(0.7))
    .force("charge", forceManyBody<Simpul>().strength(-190)).force("center", forceCenter(0, 0).strength(0.05))
    .force("x", forceX<Simpul>(0).strength(0.04)).force("y", forceY<Simpul>(0).strength(0.06))
    .force("collide", forceCollide<Simpul>((d) => (d.fokus ? 30 : d.k?.tanda.length ? 24 : d.tipe === "rs" ? 30 : d.tipe === "kode" ? 22 : 18)))
    .stop();
  for (let i = 0; i < 320; i++) sim.tick();
}

function batas(nodes: Simpul[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x ?? 0); y0 = Math.min(y0, n.y ?? 0); x1 = Math.max(x1, n.x ?? 0); y1 = Math.max(y1, n.y ?? 0); }
  // labels sit to the right of the shapes
  return { x: x0 - 40, y: y0 - 34, w: x1 - x0 + 40 + 190, h: y1 - y0 + 68 };
}

function Bentuk({ n, warna }: { n: Simpul; warna: string }) {
  if (n.tipe === "klaim") {
    const r = n.fokus ? 1.35 : 1;
    return (
      <>
        <path d={`M${-8 * r},${-10 * r} h${11 * r} l${5 * r},${5 * r} v${15 * r} h${-16 * r} z`} fill={warna} stroke={n.fokus ? W_.bad : W_.canvas} strokeWidth={n.fokus ? 3 : 1.5} strokeLinejoin="round" />
        <path d={`M${-4 * r},${-2 * r} h${8 * r} M${-4 * r},${2 * r} h${8 * r} M${-4 * r},${6 * r} h${5 * r}`} stroke="#fff" strokeWidth={1.2} />
      </>
    );
  }
  if (n.tipe === "peserta") return (<><circle r={11} fill={W_.peserta} stroke={W_.canvas} strokeWidth={2} /><path d="M0,-6 a3,3 0 1,0 0.01,0 M-6,7 a6,5.5 0 0,1 12,0" fill="#fff" /></>);
  if (n.tipe === "rs") return (<><rect x={-12} y={-12} width={24} height={24} rx={6} fill={W_.rs} stroke={W_.canvas} strokeWidth={2} /><path d="M-2,-7 h4 v5 h5 v4 h-5 v5 h-4 v-5 h-5 v-4 h5 z" fill="#fff" /></>);
  return <rect x={-9} y={-9} width={18} height={18} rx={2} transform="rotate(45)" fill={W_.kode} stroke={W_.canvas} strokeWidth={2} />;
}

function Rinci({ n, g, kc, onBuka, tutup }: { n: Simpul; g: GrafKasus; kc: string; onBuka: (id: string) => void; tutup: () => void }) {
  const k = n.k;
  return (
    <div className="absolute right-2 top-2 z-10 w-[280px] max-w-[calc(100%-1rem)] space-y-1.5 rounded-lg border border-white/15 bg-[#151c26]/95 p-3 text-[11.5px] shadow-xl backdrop-blur">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 font-semibold text-white">{k ? (n.fokus ? "Klaim ini" : "Klaim pembanding") : n.tipe === "peserta" ? `Peserta ${n.label}` : n.tipe === "rs" ? n.label : n.label}</p>
        <button onClick={tutup} className="rounded px-1 text-[#8e9cad] hover:text-white" aria-label="Tutup">✕</button>
      </div>
      {k ? (
        <>
          <dl className="grid grid-cols-[66px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <dt className="text-[#8e9cad]">Tanggal</dt><dd className="text-[#e6ecf2]">{k.tgl}{k.pulang !== k.tgl ? ` s/d ${k.pulang}` : ""}</dd>
            <dt className="text-[#8e9cad]">Layanan</dt><dd className="text-[#e6ecf2]">{k.tingkat === "RITL" ? `rawat inap · ${k.los} hari` : "rawat jalan"}</dd>
            <dt className="text-[#8e9cad]">RS</dt><dd className="text-[#e6ecf2]">{k.rs}</dd>
            <dt className="text-[#8e9cad]">Kode</dt><dd className="text-[#e6ecf2]">{k.kode}{k.dx ? ` · dx ${k.dx}` : ""}</dd>
            <dt className="text-[#8e9cad]">Tagihan</dt><dd className="tabular-nums text-[#e6ecf2]">{rpId(k.biaya)}</dd>
            <dt className="text-[#8e9cad]">Peserta</dt><dd className="text-[#e6ecf2]">{k.peserta}</dd>
            <dt className="text-[#8e9cad]">Status</dt><dd className="text-[#e6ecf2]">{k.asal === "batch" ? `batch ini · ${KEP_NAMA[k.keputusan ?? ""] ?? k.keputusan}` : `diterima lebih dulu · pemeriksaan otomatis: ${KEP_NAMA[k.keputusan_mesin ?? ""] ?? k.keputusan_mesin}`}</dd>
          </dl>
          {!n.fokus && <p className="text-[10.5px] text-[#8e9cad]">Terhubung karena: {k.relasi.map((r) => REL_NAMA[r]).join(", ")}</p>}
          {k.tanda.map((t) => TANDA[t] && <p key={t} className="rounded border border-[#ff7d9c]/40 bg-[#ff7d9c]/10 px-2 py-1 text-[11px] leading-snug text-[#ffc2cf]">{TANDA[t][1]}</p>)}
          {!n.fokus && k.kasus && (k.kasus.kc === kc
            ? <button onClick={() => onBuka(k.kasus!.id)} className="rounded border border-white/15 px-2 py-1 text-[11px] text-white hover:bg-white/5">Buka berkas {k.kasus.id}</button>
            : <p className="text-[10.5px] text-[#8e9cad]">Berkasnya ada di laporan KC {k.kasus.kc}.</p>)}
        </>
      ) : (
        <p className="text-[11px] leading-snug text-[#c3ccd7]">
          {n.n} dokumen di graph terhubung ke {n.tipe === "peserta" ? "peserta" : n.tipe === "rs" ? "RS" : "kode"} ini.
          {n.formulir && n.tipe === "peserta" && ` Peserta klaim ini; ${nf(g.entitas.peserta.sebelumnya)} klaim sebelumnya di aliran.`}
          {n.formulir && n.tipe === "rs" && ` RS klaim ini; ${nf(g.entitas.rs.sebelumnya)} klaim sebelumnya di aliran.`}
          {n.tipe === "kode" && ` ${g.entitas.kode.deskripsi ?? ""}; ${nf(g.entitas.kode.sebelumnya)} klaim sebelumnya dengan kode ini di semua RS.`}
          {(() => { const r = g.cincin.rs_lain.find((x) => x.id === n.id); return r ? ` Peserta klaim ini berobat di sini ${r.kunjungan_peserta}x dalam ±${g.cincin.hari} hari; RS ini berbagi ${r.peserta_bersama} peserta dengan RS klaim.` : null; })()}
        </p>
      )}
    </div>
  );
}

export function GrafKlaim({ g, model, kc, onBuka }: { g: GrafKasus; model: string; kc: string; onBuka: (id: string) => void }) {
  const [benih, setBenih] = useState(0);
  const data = useMemo(() => { const d = bangun(g); tata(d.nodes, d.links, benih); return d; }, [g, benih]);
  const awal = useMemo(() => batas(data.nodes), [data]);
  // the view box and the dragged positions belong to one layout: a new layout starts from its own fit, with nothing dragged
  type Kotak = { x: number; y: number; w: number; h: number };
  const [vs, setVs] = useState<{ d: typeof data; v: Kotak; pos: Record<string, { x: number; y: number }> }>({ d: data, v: awal, pos: {} });
  const view = vs.d === data ? vs.v : awal;
  const pos = vs.d === data ? vs.pos : {};
  const setView = (fn: (v: Kotak) => Kotak) => setVs((x) => ({ d: data, v: fn(x.d === data ? x.v : awal), pos: x.d === data ? x.pos : {} }));
  const pindah = (id: string, x: number, y: number) => setVs((o) => ({ d: data, v: o.d === data ? o.v : awal, pos: { ...(o.d === data ? o.pos : {}), [id]: { x, y } } }));
  const xy = (n: Simpul) => pos[n.id] ?? { x: n.x ?? 0, y: n.y ?? 0 };
  const [sorot, setSorot] = useState<"semua" | Grup>("semua");
  const [labelKlaim, setLabelKlaim] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [pilih, setPilih] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const seret = useRef<{ id?: string; x: number; y: number; vx: number; vy: number; gerak: boolean } | null>(null);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const tetangga = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const a = (l.source as Simpul).id, b = (l.target as Simpul).id;
      (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b); (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a);
    }
    return m;
  }, [data]);
  const f = g.fokus;
  const ties = Object.values(g.klaim).filter((k) => k.tanda.length);
  const nCincin = data.nodes.filter((n) => n.tipe === "klaim" && n.grup.has("cincin")).length;
  const nPembanding = Object.values(g.klaim).filter((k) => k.relasi.some((r) => r !== "cincin")).length;
  const aktif = hover ?? pilih;
  const dekat = aktif ? new Set([aktif, ...(tetangga.get(aktif) ?? [])]) : null;
  const redup = (n: Simpul) => (dekat ? !dekat.has(n.id) : sorot !== "semua" && !n.grup.has(sorot));
  const titik = (ev: { clientX: number; clientY: number }) => {
    const svg = svgRef.current; const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const mulai = (ev: React.PointerEvent, id?: string) => {
    const p = titik(ev);
    seret.current = { id, x: p.x, y: p.y, vx: view.x, vy: view.y, gerak: false };
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    ev.stopPropagation();
  };
  const geser = (ev: React.PointerEvent) => {
    const s = seret.current;
    if (!s) return;
    const p = titik(ev);
    if (Math.hypot(p.x - s.x, p.y - s.y) > 3) s.gerak = true;
    if (s.id) { const n = byId.get(s.id); if (n && !n.fokus && s.gerak) pindah(n.id, p.x, p.y); }
    else if (s.gerak) setView((v) => ({ ...v, x: v.x - (p.x - s.x), y: v.y - (p.y - s.y) }));
  };
  const lepas = (id?: string) => {
    const s = seret.current;
    seret.current = null;
    if (s && !s.gerak) setPilih(id ?? null);
  };
  const skala = (k: number, p?: { x: number; y: number }) =>
    setView((v) => { const c = p ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 }; return { x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k, w: v.w * k, h: v.h * k }; });
  // Ctrl/Cmd + scroll zooms (a plain scroll keeps scrolling the report); a native listener, so the page does not scroll as well
  const skalaRef = useRef(skala);
  useEffect(() => { skalaRef.current = skala; });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const h = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const m = el.getScreenCTM();
      const p = m ? new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()) : undefined;
      skalaRef.current(ev.deltaY > 0 ? 1.12 : 1 / 1.12, p ? { x: p.x, y: p.y } : undefined);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  const nSel = pilih ? byId.get(pilih) : null;
  const tombol = (on: boolean) => `rounded px-2 py-1 text-[11px] ${on ? "bg-[#1b2741] font-semibold text-[#7ea3ff]" : "text-[#c3ccd7] hover:bg-white/5"}`;
  return (
    <div className="space-y-2">
      <div className="lp-no-print flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-white/10 bg-[#0f151d] p-0.5">
          {([["semua", "Semua"], ["fokus", "Klaim ini"], ["pembanding", `Pembanding (${nPembanding})`], ["cincin", `Jaringan RS (${nCincin})`]] as const).map(([v, t]) => (
            <button key={v} onClick={() => setSorot(v)} disabled={v === "cincin" && !nCincin} className={`${tombol(sorot === v)} disabled:opacity-40`}>{t}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[#c3ccd7]"><input type="checkbox" checked={labelKlaim} onChange={(e) => setLabelKlaim(e.target.checked)} />label klaim</label>
        <span className="ml-auto flex gap-1.5">
          <button onClick={() => skala(1 / 1.25)} aria-label="Perbesar" className="rounded border border-white/15 px-2 py-1 text-[11px] text-white hover:bg-white/5">+</button>
          <button onClick={() => skala(1.25)} aria-label="Perkecil" className="rounded border border-white/15 px-2 py-1 text-[11px] text-white hover:bg-white/5">−</button>
          <button onClick={() => setView(() => awal)} className="rounded border border-white/15 px-2 py-1 text-[11px] text-white hover:bg-white/5">Pas layar</button>
          <button onClick={() => { setBenih((b) => b + 1); setPilih(null); }} className="rounded border border-white/15 px-2 py-1 text-[11px] text-white hover:bg-white/5">Tata ulang</button>
        </span>
      </div>
      <p className="text-[11px] text-[#c3ccd7]">
        <b className="text-white">{f.kasus?.id ?? "Klaim ini"}</b> · {f.rs} · {f.kode} · {f.tgl} · {data.nodes.length} simpul · {data.links.length} garis
        <br /><span className="text-[#8e9cad]">Pembanding: {nPembanding} klaim tetangga graph yang dibaca {model} (peserta sama, RS sama, RS + kode, kode sama){nCincin ? ` · jaringan RS: ${nCincin} klaim` : ""}{!g.cocok ? " · perkiraan: tidak cocok dengan fitur tersimpan" : ""}.</span>
      </p>
      <div className="relative overflow-hidden rounded-lg border border-[#202b38]" style={{ backgroundColor: W_.canvas, backgroundImage: `radial-gradient(${W_.dot} 1px, transparent 1px)`, backgroundSize: "18px 18px" }}>
        <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} className="block h-[360px] w-full touch-none select-none sm:h-[480px]" role="img"
          aria-label={`Graph klaim: ${data.nodes.length} simpul, klaim ini dan ${nPembanding} klaim pembanding`}
          onPointerDown={(e) => mulai(e)} onPointerMove={geser} onPointerUp={() => lepas()} style={{ cursor: "grab" }}>
          {data.links.map((l, i) => {
            const a = l.source as Simpul, b = l.target as Simpul;
            const keFokus = a.fokus && b.formulir;
            const terang = aktif && (a.id === aktif || b.id === aktif);
            const pa = xy(a), pb = xy(b);
            return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={terang ? W_.accent : keFokus ? W_.muted : W_.line} strokeWidth={keFokus ? 1.8 : 1.4}
              opacity={redup(a) || redup(b) ? 0.1 : 1} />;
          })}
          {ties.map((k) => { const n = byId.get(k.id); const fo = byId.get(f.id); return n && fo && (
            <line key={`t-${k.id}`} x1={xy(fo).x} y1={xy(fo).y} x2={xy(n).x} y2={xy(n).y} stroke={W_.bad} strokeWidth={1.8} strokeDasharray="6 4" opacity={redup(n) ? 0.15 : 0.95} />); })}
          {data.nodes.map((n) => {
            const k = n.k;
            const warna = k ? (n.fokus ? warnaKlaim(f) : warnaKlaim(k)) : "";
            const tie = k && k.tanda.length > 0;
            const teks = n.tipe === "klaim" ? (n.fokus ? "klaim ini" : tie ? TANDA[k!.tanda[0]]?.[0] ?? "" : labelKlaim ? n.label : "")
              : n.tipe === "peserta" && n.formulir ? `${n.label} · klaim ini` : n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label;
            return (
              <g key={n.id} transform={`translate(${xy(n).x},${xy(n).y})`} opacity={redup(n) ? 0.12 : 1} className="cursor-pointer" role="button" tabIndex={0}
                aria-label={`${n.tipe} ${n.label}`} onKeyDown={(e) => { if (e.key === "Enter") setPilih(n.id); }}
                onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onPointerDown={(e) => mulai(e, n.id)} onPointerUp={(e) => { e.stopPropagation(); lepas(n.id); }}>
                <circle r={20} fill="transparent" />
                {n.formulir && <circle r={n.tipe === "rs" ? 19 : 15.5} fill="none" stroke={W_.ink2} strokeWidth={1.2} strokeDasharray="3 3" strokeOpacity={0.7} />}
                {tie && <circle r={15} fill="none" stroke={W_.bad} strokeWidth={2} />}
                <Bentuk n={n} warna={warna} />
                {k?.kasus && !n.fokus && <circle cx={9} cy={-11} r={2.6} fill="#ffffff" stroke={W_.canvas} strokeWidth={1} />}
                {pilih === n.id && <circle r={n.tipe === "rs" ? 17 : 14} fill="none" stroke={W_.accent} strokeWidth={2.5} />}
                {teks && <text x={tie ? 19 : n.fokus ? 17 : 15} dy="0.35em" fontSize={11} fill={tie ? "#ffb4c4" : n.formulir || n.fokus ? "#e6ecf2" : W_.ink2} fontWeight={tie || n.fokus ? 600 : 400}
                  paintOrder="stroke" stroke={W_.canvas} strokeWidth={3.5} style={{ pointerEvents: "none" }}>{teks}</text>}
                <title>{k ? `${k.tgl} · ${k.kode} · ${k.rs} · ${rpId(k.biaya)} · ${k.peserta}` : n.label}</title>
              </g>
            );
          })}
        </svg>
        {nSel && <Rinci n={nSel} g={g} kc={kc} onBuka={onBuka} tutup={() => setPilih(null)} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[#c3ccd7]">
        {([["klaim ini", <path key="a" d="M-8,-10 h11 l5,5 v15 h-16 z" fill="none" stroke={W_.bad} strokeWidth={3} />],
          ["putus-putus = peserta, RS, kode klaim ini", <circle key="b" r={10} fill="none" stroke={W_.ink2} strokeWidth={1.6} strokeDasharray="3 3" />],
          ["klaim lolos", <path key="c" d="M-8,-10 h11 l5,5 v15 h-16 z" fill={W_.klaim} />], ["perlu diperiksa", <path key="d" d="M-8,-10 h11 l5,5 v15 h-16 z" fill={W_.periksa} />],
          ["ditahan", <path key="e" d="M-8,-10 h11 l5,5 v15 h-16 z" fill={W_.tahan} />], ["peserta", <circle key="f" r={11} fill={W_.peserta} />],
          ["rumah sakit", <rect key="g" x={-11} y={-11} width={22} height={22} rx={5} fill={W_.rs} />], ["kode INA-CBG", <rect key="h" x={-8} y={-8} width={16} height={16} transform="rotate(45)" fill={W_.kode} />],
          ["cincin merah = pola yang perlu dicek", <circle key="i" r={10} fill="none" stroke={W_.bad} strokeWidth={2.5} />],
          ["titik putih = punya berkas di laporan ini", <circle key="j" r={5} fill="#fff" />]] as const).map(([t, s]) => (
          <span key={t} className="flex items-center gap-1"><svg viewBox="-13 -13 26 26" className="h-3.5 w-3.5" aria-hidden="true">{s}</svg>{t}</span>
        ))}
        <span className="text-[#8e9cad]">· klik = detail · seret simpul = pindah · seret latar = geser · Ctrl + scroll atau +/− = zoom</span>
      </div>
    </div>
  );
}
