"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, iconPath, type IconName } from "@/components/Icon";
import { wib, type Rec } from "@/components/aip/aipRun";
import { fraud, STRENGTH, type ClaimTrace } from "@/components/aip/fraudApi";

/* A claim of a case file traced to its raw transaction (api/aip/jejak_data.py; the user, 2026-10-24: "visualisasi data
   lineage dari Berkas kasus per faskes sampai data mentah transaksinya … node file pickle buat nunjukin data mentah ini
   udh lewat node ML inference"), drawn as a flow like Data Lineage, left to right ("kayak flow gitu … bisa di zoom in
   zoom out di pan"): the raw file, bronze and silver; from silver, on top, the second pipeline's chain (every claim,
   its facts, the live object the swarm reads — 2026-10-28, "sesuai new lineage data pipeline"), the gold dataset and
   its Nexus object below it, the feature row, model.pkl and its inference at the bottom; they meet in the indications
   and the Box rule, which gives the case file's figure. Each node opens the claim's own values at that layer, read as
   the viewer. Folded by default; the case file with the largest loss opens it. */

// the families of Data Lineage (lib/lineage.ts FAMILIES): data, Nexus, models, apps; transforms ride on the edges
const FAM = { data: "#3987e5", nexus: "#199e70", ml: "#9b5de5", app: "#c88a12" } as const;
const XF = { screen: "#f0a27a", paper: "#b4461a" };  // the transform family (#d95926), as edge text
const DARK = { bg: "#12161b", dot: "#262d36", node: "#1a1f25", line: "#3a424d", edge: "#4f5967", lit: "#8abbff", text: "#e5e8eb",
  muted: "#8f99a8", label: "#c5cbd3", sel: "#ffffff", bad: "#ff8a8a" };
const PAPER = { bg: "#ffffff", dot: "", node: "#ffffff", line: "#c9ced6", edge: "#9aa3ae", lit: "#1d5fb8", text: "#1f2429",
  muted: "#5f6b7a", label: "#39414a", sel: "#1f2429", bad: "#b42318" };
// an icon tile per node, its kind above, its name and figure below: eight columns stay readable at the report's width
const PX = 156, PY = 124, T = 46;
const GB = { x: -58, y: -22, w: 7 * PX + T + 116, h: 3 * PY + T + 92 };  // the drawing's bounds, labels included (four lanes)
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type FlowNode = { id: string; layer: string; col: number; lane: number; fam: keyof typeof FAM; icon: IconName; kind: string; name: string; sub: string;
  off?: boolean; alert?: boolean; x: number; y: number };
type FlowEdge = { from: string; to: string; label: string; title: string; off?: boolean; xf?: boolean };

const idn = (n: number, d = 0) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (n: number) => (n >= 1e9 ? `Rp ${idn(n / 1e9, 1)} M` : n >= 1e6 ? `Rp ${idn(n / 1e6, 1)} jt` : `Rp ${idn(n)}`);
const pct = (p: number) => `${idn(100 * p, p < 0.001 ? 3 : 2)}%`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Up to `lines` lines of at most `max` characters, broken after spaces, _ - / and ·; the rest clipped. */
function wrap(s: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of s.split(/(?<=[ _\-/·])/)) {
    for (let p = part; p; ) {
      if ((cur + p).length <= max) { cur += p; p = ""; continue; }
      if (cur) { out.push(cur.trimEnd()); cur = ""; continue; }
      out.push(p.slice(0, max)); p = p.slice(max);
    }
  }
  if (cur) out.push(cur.trimEnd());
  return out.length > lines ? [...out.slice(0, lines - 1), clip(out.slice(lines - 1).join(""), max)] : out;
}
const last = (s: unknown) => String(s ?? "").split(" → ")[0].split(" / ").pop()!.replace(/^Files · /, "");
function value(v: unknown, money?: boolean): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Ya" : "Tidak";
  if (typeof v === "number") return money ? `Rp ${idn(v)}` : Number.isInteger(v) ? String(v) : idn(v, Math.abs(v) < 1 ? 4 : 2);
  return String(v);
}
const cell = (l: Rec | undefined, key: string) => (l?.kolom as Rec[] | undefined)?.find((c) => c.kode === key || c.nama === key)?.nilai;

/** The trace's layers as nodes on four lanes (the facts chain of the second pipeline on top, the screened claim and
 *  its Nexus object, the data path, ML at the bottom) and their edges. */
function flow(t: ClaimTrace): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const L = (id: string) => t.lapis.find((l) => l.id === id);
  const raw = L("mentah"), br = L("bronze"), sv = L("silver"), gd = L("gold"), mlL = L("ml"), ind = L("indikasi"), bx = L("box"), bk = L("berkas");
  const sm = L("semua"), fk = L("fakta");
  const ml = (mlL?.ml ?? {}) as Rec;
  const gold = !!(gd?.kolom as Rec[] | undefined)?.length;
  const all = !!(sm?.kolom as Rec[] | undefined)?.length, facts = !!(fk?.kolom as Rec[] | undefined)?.length;
  const held = (fk?.fakta_benar as string[] | undefined) ?? [];
  const ran = !!ml.segmen;
  const bukti = (ind?.bukti as Rec[] | undefined) ?? [];
  const byAgent = bukti.some((b) => b.oleh && b.oleh !== "penanda otomatis");
  const rivals = ((ml.benchmark as Rec[] | undefined) ?? []).filter((r) => !r.pembanding).length;
  const chosen = (bx?.aturan as Rec[] | undefined)?.find((r) => Number(r.nilai) > 0 && Number(r.nilai) === Number(bx?.dipilih));
  // the step that made a layer: a Code Repository transform, or a Pipeline Builder pipeline (the "silver" label read as the
  // old Code Repository transform that the pipeline replaced on 2026-10-26)
  const xf = (p: unknown, dflt: string) => /transform (\S+?):/.exec(String(p ?? ""))?.[1] ?? (String(p ?? "").includes("Pipeline Builder") ? "Pipeline Builder" : dflt);
  const n = (o: Omit<FlowNode, "x" | "y">): FlowNode => ({ ...o, x: o.col * PX, y: o.lane * PY });
  const fac = String(bk?.wadah ?? "").split(" · ");
  const nodes: FlowNode[] = [
    n({ id: "mentah", layer: "mentah", col: 0, lane: 2, fam: "data", icon: "doc", kind: "Arsip Sumber · berkas", name: last(raw?.wadah),
      sub: String(raw?.catatan ?? "").split(" · ").filter((s) => !s.startsWith("sha256")).join(" · "), off: !!raw?.tertutup }),
    n({ id: "bronze", layer: "bronze", col: 1, lane: 2, fam: "data", icon: "table", kind: "Data Mentah · dataset", name: last(br?.wadah),
      sub: `FKL02 ${value(cell(br, "FKL02"))}`, off: !!br?.tertutup }),
    n({ id: "silver", layer: "silver", col: 2, lane: 2, fam: "data", icon: "table", kind: "Data Bersih · dataset", name: last(sv?.wadah),
      sub: `LOS ${value(cell(sv, "Lama rawat (hari)"))} hari · ${rp(Number(cell(sv, "Biaya tagih") ?? 0))}`, off: !!sv?.tertutup }),
    n({ id: "semua", layer: "semua", col: 3, lane: 0, fam: "data", icon: "table", kind: "Siap Analisis · semua klaim", name: last(sm?.wadah) || "klaim_fkrtl.parquet",
      sub: all ? `bobot ${value(cell(sm, "Bobot sampel"))} · ${cell(sm, "Klaim kanonik") ? "kanonik" : "salinan edisi"}` : "baris tidak ada", off: !all }),
    n({ id: "fakta", layer: "fakta", col: 4, lane: 0, fam: "data", icon: "table", kind: "Fakta Klaim · dataset", name: last(fk?.wadah) || "klaim_fkrtl_fakta.parquet",
      sub: facts ? (held.length ? `${held.length} fakta: ${held[0]}` : "tanpa fakta") : "baris tidak ada", off: !facts, alert: held.length > 0 }),
    n({ id: "nexus_fakta", layer: "fakta", col: 5, lane: 0, fam: "nexus", icon: "cube", kind: "Objek Nexus · live",
      name: (String(fk?.wadah ?? "").split(" → ")[1] ?? "Klaim FKRTL (BPJS)").replace(/^(objek )?Nexus /, ""), sub: "setiap klaim · dibaca agen", off: !facts }),
    n({ id: "gold", layer: "gold", col: 3, lane: 1, fam: "data", icon: "table", kind: "Siap Analisis · dataset", name: last(gd?.wadah),
      sub: gold ? `${value(cell(gd, "Rasio biaya / peer"))}× peer · skor ${value(cell(gd, "Skor risiko aturan"))}` : "tidak lolos skrining Siap Analisis", off: !gold }),
    n({ id: "nexus", layer: "gold", col: 4, lane: 1, fam: "nexus", icon: "cube", kind: "Objek Nexus",
      name: (String(gd?.wadah ?? "").split(" → ")[1] ?? "Klaim Berisiko (BPJS)").replace(/^(objek )?Nexus /, ""),
      sub: gold ? String(cell(gd, "Indikasi utama") ?? "objek klaim") : "tanpa objek untuk klaim ini", off: !gold }),
    n({ id: "fitur", layer: "ml", col: 3, lane: 3, fam: "data", icon: "table", kind: "Tabel fitur ML", name: String(ml.fitur_tabel ?? "fitur.parquet"),
      sub: ran ? `${(ml.fitur as Rec[] | undefined)?.length ?? 0} fitur · baris klaim ini` : "baris fitur tidak ada", off: !ran }),
    n({ id: "model", layer: "ml", col: 4, lane: 3, fam: "ml", icon: "cpu", kind: `Model · ${String(ml.versi ?? "—")}`, name: String(ml.pickle ?? "model.pkl").split("/").pop()!,
      // no-break spaces: "1 dari 9 teknik" stays one line under the technique's name
      sub: [ml.teknik, rivals ? `1 dari ${rivals} teknik` : ml.segmen].filter(Boolean).join(" · ") }),
    n({ id: "inferensi", layer: "ml", col: 5, lane: 3, fam: "ml", icon: "sparkle", kind: "Inferensi ML", name: ran ? `risiko ${pct(Number(ml.risiko ?? 0))}` : "tidak dijalankan",
      sub: ran ? `ambang ${pct(Number(ml.ambang ?? 0))} → ${ml.ditandai ? "ditandai" : "tidak ditandai"}` : "", off: !ran, alert: !!ml.ditandai }),
    n({ id: "indikasi", layer: "indikasi", col: 5, lane: 2, fam: "nexus", icon: "alert", kind: "Indikasi · Nexus", name: `${bukti.length} indikasi`,
      sub: String(bukti[0]?.indikasi ?? "—"), off: !bukti.length }),
    n({ id: "box", layer: "box", col: 6, lane: 2, fam: "nexus", icon: "lock", kind: "Box Karantina", name: `Rp ${idn(Number(bx?.dipilih ?? 0))}`,
      sub: bx?.dikoreksi ? "sudah dikoreksi verifikator" : chosen ? String(chosen.komponen) : "tidak ada komponen > 0", alert: Number(bx?.dipilih ?? 0) > 0 }),
    n({ id: "berkas", layer: "berkas", col: 7, lane: 2, fam: "app", icon: "project", kind: "Berkas kasus", name: [fac[2], fac[fac.length - 1]].filter(Boolean).join(" · "),
      sub: `${rp(Number(bk?.klaim_ini ?? 0))}${bk?.porsi_pct != null ? ` · ${idn(Number(bk.porsi_pct), 1)}%` : ""} dari ${rp(Number(bk?.estimasi_faskes ?? 0))}` }),
  ];
  const edges: FlowEdge[] = [
    { from: "mentah", to: "bronze", label: xf(br?.proses, "bronze"), title: String(br?.proses ?? ""), xf: true },
    { from: "bronze", to: "silver", label: xf(sv?.proses, "Pipeline Builder"), title: String(sv?.proses ?? ""), xf: true },
    { from: "silver", to: "semua", label: "Pipeline Builder", title: String(sm?.proses ?? ""), xf: true, off: !all },
    { from: "semua", to: "fakta", label: "pipeline Fakta Klaim", title: String(fk?.proses ?? ""), xf: true, off: !facts },
    { from: "fakta", to: "nexus_fakta", label: "dataset dasar objek", title: "tipe live Nexus Klaim FKRTL (BPJS) membaca dataset Fakta Klaim langsung dari Parquet (setiap klaim)", off: !facts },
    { from: "nexus_fakta", to: "indikasi", label: "dibaca agen swarm",
      title: "agen AI Agent Swarm membaca fakta klaim lewat tipe live ini; fakta bukan putusan — tag ditulis agen (garis putus: tidak ada tag dari agen pada klaim ini)", off: !facts || !byAgent },
    { from: "silver", to: "gold", label: "Pipeline Builder", title: String(gd?.proses ?? ""), xf: true, off: !gold },
    { from: "gold", to: "nexus", label: "dataset dasar objek", title: "tipe objek Nexus Klaim Berisiko (BPJS) dibangun dari dataset Siap Analisis ini", off: !gold },
    { from: "silver", to: "fitur", label: "rekayasa fitur", title: String(ml.sumber ?? ""), xf: true, off: !ran },
    { from: "fitur", to: "model", label: "baris klaim ini", title: `baris fitur klaim ${t.klaim} di ${String(ml.fitur_tabel ?? "")}`, off: !ran },
    { from: "model", to: "inferensi", label: "predict + TreeSHAP", title: `${String(ml.teknik ?? "model")} segmen ${String(ml.segmen ?? "—")}: risiko koreksi dan alasan (TreeSHAP)`, off: !ran },
    gold
      ? { from: "nexus", to: "indikasi", label: "penanda otomatis · agen", title: String(ind?.proses ?? "") }
      : { from: "silver", to: "indikasi", label: "ditemukan dari Data Bersih", title: String(ind?.proses ?? "") },
    { from: "nexus", to: "box", label: "median peer", title: "dibayar dan median biaya peer dari objek Klaim Berisiko", off: !gold },
    { from: "indikasi", to: "box", label: "tag klaim", title: "tag indikasi klaim ini (KLAIM_GANDA, KLONING_KLAIM, …)", off: !bukti.length },
    { from: "inferensi", to: "box", label: ml.dipublikasikan ? "skor terpublikasi" : "skor tak dipublikasi → 0",
      title: ml.dipublikasikan ? "Box memakai skor ML terpublikasi klaim ini" : "skor terpublikasi hanya memuat klaim teratas, ditandai dan dikoreksi: Box tidak memakai skor ini", off: !ml.dipublikasikan },
    { from: "box", to: "berkas", label: "claim_loss", title: String(bx?.proses ?? ""), xf: true },
  ];
  return { nodes, edges };
}

/** A node and everything upstream of it: the path its figure comes from. */
function upstream(edges: FlowEdge[], id: string): Set<string> {
  const seen = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of edges) if (seen.has(e.to) && !seen.has(e.from)) { seen.add(e.from); grew = true; }
  }
  return seen;
}

/** The SVG of the flow; `port` spreads several edges into or out of one node so their arrows stay apart. */
function Graph({ nodes, edges, sel, print, uid, onSel }: { nodes: FlowNode[]; edges: FlowEdge[]; sel: string | null; print: boolean; uid: string;
  onSel?: (id: string) => void }) {
  const P = print ? PAPER : DARK;
  const halo = { paintOrder: "stroke", stroke: P.bg, strokeWidth: 3, strokeLinejoin: "round" } as const;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lit = sel ? upstream(edges, sel) : new Set<string>();
  const port = (id: string, side: "in" | "out", e: FlowEdge) => {
    const mine = edges.filter((x) => (side === "in" ? x.to : x.from) === id);
    const sorted = [...mine].sort((a, b) => byId.get(side === "in" ? a.from : a.to)!.y - byId.get(side === "in" ? b.from : b.to)!.y);
    return (sorted.indexOf(e) - (sorted.length - 1) / 2) * 9;
  };
  return (
    <>
      <defs>
        {[["a", P.edge], ["l", P.lit]].map(([k, c]) => (
          <marker key={k} id={`${uid}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => {
        const a = byId.get(e.from)!, b = byId.get(e.to)!;
        const x1 = a.x + T + 1, y1 = a.y + T / 2 + port(e.from, "out", e), x2 = b.x - 3, y2 = b.y + T / 2 + port(e.to, "in", e);
        const dx = x2 - x1;
        const d = `M${x1},${y1} C${x1 + dx / 2},${y1} ${x2 - dx / 2},${y2} ${x2},${y2}`;
        const on = lit.has(e.from) && lit.has(e.to);
        const flat = Math.abs(y2 - y1) < 20;
        return (
          <g key={i}>
            <title>{e.title || e.label}</title>
            <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
            <path d={d} fill="none" stroke={on ? P.lit : P.edge} strokeWidth={on ? 1.9 : 1.3} markerEnd={`url(#${uid}-${on ? "l" : "a"})`}
              strokeDasharray={e.off ? "3 4" : on && !print ? "6 6" : undefined} className={on && !e.off && !print ? "lineage-flow" : undefined} opacity={e.off ? 0.7 : 1} />
            <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - (flat ? 6 : 3)} textAnchor="middle" fontSize={e.xf ? 8.5 : 9} fill={e.xf ? (print ? XF.paper : XF.screen) : P.label}
              fillOpacity={e.off ? 0.75 : 1} fontFamily={e.xf ? MONO : undefined} style={{ ...halo, strokeWidth: 3.5 }}>
              {clip(e.label, flat ? 21 : 26)}
            </text>
          </g>
        );
      })}
      {nodes.map((n) => {
        const c = FAM[n.fam];
        const on = sel === n.id;
        const ext = /\.(dta|parquet|pkl)$/.exec(n.name)?.[1];
        // Keep labels comfortably inside their column. Character counts alone can still
        // overflow SVG text when a claim contains long uppercase identifiers.
        const name = wrap(n.name, 17, 2), sub = wrap(n.sub, 19, 2);
        return (
          <g key={n.id} data-node={n.id} transform={`translate(${n.x},${n.y})`} opacity={n.off ? 0.62 : sel && !lit.has(n.id) ? 0.5 : 1}
            style={{ cursor: print ? undefined : "pointer", outline: "none" }} role={onSel ? "button" : undefined} tabIndex={onSel ? 0 : undefined} aria-label={`${n.kind}: ${n.name}`}
            onKeyDown={onSel ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSel(n.id); } } : undefined}>
            <title>{`${n.kind}: ${n.name}${n.sub ? `\n${n.sub}` : ""}`}</title>
            {/* the hit area takes the labels too */}
            <rect x={T / 2 - PX / 2 + 5} y={-20} width={PX - 10} height={T + 84} fill="transparent" />
            <text x={T / 2} y={-8} textAnchor="middle" fontSize={9} fill={P.muted} style={{ ...halo, textTransform: "uppercase", letterSpacing: 0.5 }}>{clip(n.kind, 24)}</text>
            {on && !print && <rect x={-5} y={-5} width={T + 10} height={T + 10} rx={16} fill="none" stroke={c} strokeOpacity={0.55} />}
            <rect width={T} height={T} rx={12} fill={c} fillOpacity={print ? 0.1 : 0.16} stroke={on ? P.sel : c} strokeWidth={on ? 2.4 : 1.4} strokeDasharray={n.off ? "4 3" : undefined} />
            <g transform={`translate(${T / 2 - 11},${T / 2 - 11}) scale(0.92)`} stroke={c} fill="none" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d={iconPath(n.icon)} />
            </g>
            {ext && (
              <g transform={`translate(${T - 17},${T - 8})`}>
                <rect width={32} height={14} rx={3} fill={P.node} stroke={c} />
                <text x={16} y={10.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill={c} fontFamily={MONO}>.{ext}</text>
              </g>
            )}
            {n.alert && <circle cx={T - 1} cy={1} r={4.5} fill={P.bad} stroke={P.bg} strokeWidth={1.5} />}
            {name.map((l, i) => (
              <text key={`n${i}`} x={T / 2} y={T + 17 + i * 13} textAnchor="middle" fontSize={11} fontWeight={600} fill={P.text} style={halo}>{l}</text>
            ))}
            {sub.map((l, i) => (
              <text key={`s${i}`} x={T / 2} y={T + 18 + name.length * 13 + i * 12} textAnchor="middle" fontSize={9.5} fill={n.alert ? P.bad : P.label} style={halo}>{l}</text>
            ))}
          </g>
        );
      })}
    </>
  );
}

/** The interactive canvas: drag to pan, Ctrl + scroll (or click, then scroll) to zoom, the toolbar, click a node. */
function Canvas({ nodes, edges, sel, onSel, full, onFull, className }: { nodes: FlowNode[]; edges: FlowEdge[]; sel: string | null;
  onSel: (id: string) => void; full: boolean; onFull: (on: boolean) => void; className: string }) {
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.8 });
  const [hint, setHint] = useState(false);
  const [panning, setPanning] = useState(false);
  const active = useRef(full);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean; node?: string } | null>(null);
  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !el.clientWidth) return;
    const k = Math.min(1.25, Math.max(0.2, Math.min((el.clientWidth - 32) / GB.w, (el.clientHeight - 28) / GB.h)));
    setView({ k, x: (el.clientWidth - GB.w * k) / 2 - GB.x * k, y: (el.clientHeight - GB.h * k) / 2 - GB.y * k });
  }, []);
  const zoom = useCallback((f: number, px?: number, py?: number) => {
    const el = box.current;
    if (!el) return;
    const cx = px ?? el.clientWidth / 2, cy = py ?? el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(3, Math.max(0.2, v.k * f));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    let t = 0;
    // React's wheel handler is passive: zooming must keep the page from scrolling, so a listener of our own; a plain
    // scroll over the canvas still scrolls the report until the canvas was clicked (or Ctrl is held, or a pinch)
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || active.current)) {
        setHint(true);
        clearTimeout(t);
        t = window.setTimeout(() => setHint(false), 1400);
        return;
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(Math.max(-0.4, Math.min(0.4, -e.deltaY * 0.0022))), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("wheel", wheel); clearTimeout(t); };
  }, [fit, zoom]);
  const btn = "flex h-6 min-w-6 items-center justify-center gap-1 rounded border border-white/10 bg-[#1a1f25] px-1.5 text-[10.5px] text-[#c5cbd3] hover:border-[#9d8cff]/60 hover:text-white";
  return (
    <div className={full ? "flex min-h-0 flex-1 flex-col gap-1.5" : "space-y-1.5"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#8f99a8]">
        {([["data", "Data"], ["nexus", "Nexus"], ["ml", "Model ML"], ["app", "Laporan"]] as const).map(([k, l]) => (
          <span key={k} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FAM[k] }} />{l}</span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="font-mono" style={{ color: XF.screen }}>abc</span>transform</span>
        <span className="inline-flex items-center gap-1"><span className="w-4 border-t border-dashed border-[#8f99a8]" />tidak ada baris / tidak dipakai</span>
        <span className="ml-auto hidden text-[#6b7586] lg:inline">seret = geser · Ctrl + scroll = zoom</span>
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => zoom(1 / 1.2)} title="Perkecil" aria-label="Perkecil"><Icon name="minus" className="h-3 w-3" /></button>
          <span className="w-9 text-center text-[10.5px] tabular-nums">{Math.round(view.k * 100)}%</span>
          <button className={btn} onClick={() => zoom(1.2)} title="Perbesar" aria-label="Perbesar"><Icon name="plus" className="h-3 w-3" /></button>
          <button className={btn} onClick={fit} title="Muat semua node"><Icon name="fit" className="h-3 w-3" />Pas</button>
          <button className={btn} onClick={() => onFull(!full)} title={full ? "Tutup layar penuh (Esc)" : "Layar penuh"}>
            <Icon name={full ? "x" : "external"} className="h-3 w-3" />{full ? "Tutup" : "Layar penuh"}
          </button>
        </div>
      </div>
      <div ref={box} className={`relative select-none overflow-hidden rounded border border-white/[.06] ${className}`}
        style={{ background: DARK.bg, backgroundImage: `radial-gradient(${DARK.dot} 1px, transparent 1px)`, backgroundSize: `${18 * view.k}px ${18 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`, cursor: panning ? "grabbing" : "grab", touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          active.current = true;
          drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false, node: (e.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? undefined };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          if (!d.moved) setPanning(true);
          d.moved = true;
          setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          setPanning(false);
          if (d && !d.moved && d.node) onSel(d.node);
        }}
        onPointerLeave={() => { if (!full && !drag.current) active.current = false; }}
      >
        <svg className="absolute inset-0 h-full w-full" aria-label="Jejak data klaim: dari berkas mentah sampai berkas kasus">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            <Graph nodes={nodes} edges={edges} sel={sel} print={false} uid={uid} onSel={onSel} />
          </g>
        </svg>
        {hint && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded bg-[#0d1014]/90 px-3 py-1.5 text-[11px] text-white shadow">
            Tahan Ctrl lalu scroll untuk zoom, atau klik kanvas dulu
          </p>
        )}
      </div>
    </div>
  );
}

function Values({ rows }: { rows: Rec[] }) {
  return (
    <dl className="mt-1.5 grid gap-x-5 gap-y-0 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((k, i) => {
        const v = value(k.nilai, !!k.uang);
        const long = v.length > 40;  // a sentence (the gold row's reasons): the whole row, label above it
        return (
          <div key={i} className={`border-t border-white/[.04] py-0.5 text-[11px] ${long ? "sm:col-span-2 xl:col-span-3" : "flex items-baseline justify-between gap-2"}`}
            title={k.turunan ? `dihitung: ${k.turunan}` : k.label ? "dari tabel label nilai" : undefined}>
            <dt className="min-w-0 text-[#8f99a8]">{k.kode ? <code className="mr-1 font-mono text-[10px] text-[#c9c0ff]">{String(k.kode)}</code> : null}<span className="break-words">{String(k.nama)}</span></dt>
            <dd className={long ? "text-[#e5e8eb]" : "shrink-0 text-right tabular-nums text-[#e5e8eb]"}>{v}{k.turunan ? <span className="ml-1 text-[#c9c0ff]">ƒ</span> : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function MlModel({ ml }: { ml: Rec }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="inline-flex items-center gap-1.5 rounded border border-[#9b5de5]/50 bg-[#9b5de5]/10 px-2 py-1 font-mono text-[10.5px] text-[#c9c0ff]" title={String(ml.pickle)}>
        <Icon name="cpu" className="h-3 w-3" />{String(ml.pickle ?? "model.pkl").split("/").pop()!}
      </span>
      <span className="text-[#c5cbd3]">versi {String(ml.versi)} · {ml.ukuran ? `${idn(Number(ml.ukuran) / 1e6, 1)} MB` : "—"} · sha256 {String(ml.sha256 ?? "—")}</span>
      {ml.tautan ? <a href={String(ml.tautan)} target="_blank" rel="noreferrer" className="lp-no-print text-[#8abbff] hover:underline">{String(ml.registri)}</a> : <span className="text-[#8f99a8]">{String(ml.registri ?? "")}</span>}
      {ml.segmen ? <p className="w-full text-[#c5cbd3]">Satu model per segmen faskes; klaim ini masuk segmen <b className="text-[#e5e8eb]">{String(ml.segmen)}</b>, teknik <b className="text-[#e5e8eb]">{String(ml.teknik)}</b>.</p> : null}
    </div>
  );
}

/** The benchmark that chose this segment's model: one model scores a claim; the other techniques lost the cross-validated
 *  comparison and keep no score of their own (the user, 2026-10-28: "kenapa cuman di show 1 model ml … ada 8"). */
function MlBoard({ ml }: { ml: Rec }) {
  const rows = (ml.benchmark as Rec[] | undefined) ?? [];
  if (!rows.length) return null;
  const top = Math.max(...rows.map((r) => Number(r.auprc ?? 0)), 1e-9);
  const models = rows.filter((r) => !r.pembanding);
  const tied = models.filter((r) => !r.dipakai && !r.lebih_buruk_nyata).length;
  return (
    <div className="mt-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#8f99a8]">Dipilih dari {models.length} teknik · validasi silang, AUPRC rata-rata ± sd</p>
      <p className="mt-0.5 text-[11px] text-[#c5cbd3]">
        Produksi memakai satu model per segmen: klaim ini dinilai {String(ml.teknik)} saja. Teknik lain kalah di benchmark dan tidak menilai klaim
        {tied ? `; ${tied} di antaranya setara secara statistik (beda AUPRC tidak nyata)` : ""}.
      </p>
      <table className="mt-1 w-full text-[11px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-t border-white/[.04] ${r.dipakai ? "text-white" : r.pembanding ? "text-[#8f99a8]" : "text-[#c5cbd3]"}`}>
              <td className="py-0.5 pr-2">{r.dipakai ? "▶ " : ""}{String(r.teknik)}</td>
              <td className="w-40 pr-2">
                <span className="relative block h-[8px] rounded-[4px] bg-[#2c333b]">
                  <span className="absolute inset-y-0 left-0 rounded-[4px]" style={{ width: `${Math.max(1, (100 * Number(r.auprc ?? 0)) / top)}%`, background: r.dipakai ? "#9b5de5" : r.pembanding ? "#5f6b7a" : "#4f5967" }} />
                </span>
              </td>
              <td className="whitespace-nowrap pr-2 text-right tabular-nums">{idn(Number(r.auprc ?? 0), 3)} ± {idn(Number(r.sd ?? 0), 3)}</td>
              <td className="whitespace-nowrap text-[10.5px] text-[#8f99a8]">{r.dipakai ? "dipakai produksi" : r.pembanding ? "pembanding" : r.lebih_buruk_nyata ? "lebih buruk nyata" : "setara"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MlInference({ ml }: { ml: Rec }) {
  const risk = Number(ml.risiko ?? 0), thr = Number(ml.ambang ?? 0);
  const scale = Math.max(thr * 2, risk * 1.2, 1e-9);
  if (!ml.segmen) return <p className="mt-1 text-[11px] text-[#8f99a8]">Model tidak dijalankan: baris fitur klaim ini tidak ada.</p>;
  return (
    <div className="mt-1.5 space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <span className="relative h-[10px] w-56 shrink-0 rounded-[4px] bg-[#2c333b]" title={`risiko ${idn(100 * risk, 3)}% · ambang ${idn(100 * thr, 2)}%`}>
          <span className="absolute inset-y-0 left-0 rounded-[4px]" style={{ width: `${Math.max(1, (100 * risk) / scale)}%`, background: ml.ditandai ? "#e5484d" : "#3987e5" }} />
          <span className="absolute -top-1 bottom-[-4px] w-[2px] bg-[#fab219]" style={{ left: `${(100 * thr) / scale}%` }} />
        </span>
        <span className="text-[#e5e8eb]">risiko koreksi {idn(100 * risk, 3)}% · ambang {idn(100 * thr, 2)}% → <b>{ml.ditandai ? "ditandai" : "tidak ditandai"}</b></span>
      </div>
      <p className="text-[10.5px] text-[#8f99a8]">
        Label nyata: {ml.label_nyata == null ? "—" : ml.label_nyata ? "dikoreksi verifikator" : "tidak dikoreksi"} ·{" "}
        {ml.dipublikasikan ? `ada di skor terpublikasi (${idn(100 * Number(ml.risiko_publikasi), 3)}%)` : "tidak termasuk skor terpublikasi (hanya yang teratas, ditandai dan dikoreksi): Box tidak memakai skornya"}
      </p>
      {Array.isArray(ml.alasan) && ml.alasan.length > 0 && (
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#8f99a8]">Yang menaikkan risiko (TreeSHAP)</p>
          <ul className="mt-0.5 space-y-0.5 text-[11px]">
            {(ml.alasan as Rec[]).map((r, i) => (
              <li key={i} className="flex flex-wrap gap-x-2"><span className="text-[#e5e8eb]">{String(r.label)}: {String(r.nilai)}</span>
                {r.umumnya ? <span className="text-[#8f99a8]">umumnya {String(r.umumnya)}</span> : null}
                <span className="tabular-nums text-[#c9c0ff]">+{idn(Number(r.kontribusi), 3)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One node's rincian: where it lives, the step that made it, and the claim's own values there. */
function Detail({ n, t, nodes, edges }: { n: FlowNode; t: ClaimTrace; nodes: FlowNode[]; edges: FlowEdge[] }) {
  const l = t.lapis.find((x) => x.id === n.layer) ?? {};
  const ml = (l.ml ?? {}) as Rec;
  const into = edges.filter((e) => e.to === n.id);
  const obj = n.id === "nexus" || n.id === "nexus_fakta";
  const where = n.id === "fitur" ? `aip/ml/cache/${String(ml.fitur_tabel ?? "")}` : n.id === "model" ? String(ml.pickle ?? "") : n.id === "inferensi" ? `${String(ml.teknik ?? "")} · segmen ${String(ml.segmen ?? "—")}` : obj ? `Nexus · ${n.name}` : String(l.wadah ?? "");
  const path = [...upstream(edges, n.id)].map((id) => nodes.find((x) => x.id === id)!).sort((a, b) => b.col - a.col || a.lane - b.lane);
  return (
    <div className="rounded border border-white/[.06] bg-black/20 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: FAM[n.fam] }}><Icon name={n.icon} className="h-3.5 w-3.5" />{n.kind}</span>
        <span className="break-all font-mono text-[10.5px] text-[#d3d8de]">{where}</span>
      </div>
      {into.length > 0 && <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">← {into.map((e) => `${nodes.find((x) => x.id === e.from)!.name} (${e.label})`).join(" · ")}</p>}
      {n.layer !== "ml" && !obj && l.proses ? <p className="text-[10.5px] text-[#8f99a8]">{String(l.proses)}</p> : null}
      {n.id === "nexus" && <p className="mt-1 text-[11px] text-[#c5cbd3]">Objek Nexus klaim ini; propertinya adalah baris Siap Analisis di bawah. Tag indikasi dan Box membacanya dari sini.</p>}
      {n.id === "nexus_fakta" && <p className="mt-1 text-[11px] text-[#c5cbd3]">Objek klaim ini di tipe live Klaim FKRTL (BPJS): setiap klaim dibaca langsung dari Parquet Fakta Klaim, propertinya baris di bawah. Agen AI Agent Swarm membaca fakta ini; fakta bukan putusan — tag ditulis agen atau penanda otomatis.</p>}
      {l.tertutup ? <p className="mt-1 text-[11px] text-[#ffb4b4]">{String(l.tertutup)}</p> : null}
      {l.catatan && n.layer !== "ml" ? <p className="mt-0.5 text-[11px] text-[#c5cbd3]">{String(l.catatan)}</p> : null}
      {n.layer !== "ml" && Array.isArray(l.kolom) && l.kolom.length > 0 && <Values rows={l.kolom as Rec[]} />}
      {n.id === "fitur" && (
        <>
          <p className="mt-1 text-[11px] text-[#c5cbd3]">Fitur dihitung dari {String(ml.sumber ?? "Data Bersih")}; model membaca baris klaim ini persis seperti di bawah.</p>
          {Array.isArray(ml.fitur) && <Values rows={ml.fitur as Rec[]} />}
        </>
      )}
      {n.id === "model" && <MlModel ml={ml} />}
      {n.id === "model" && <MlBoard ml={ml} />}
      {n.id === "inferensi" && <MlInference ml={ml} />}
      {Array.isArray(l.bukti) && l.bukti.length > 0 && (
        <ul className="mt-1 space-y-1">
          {(l.bukti as Rec[]).map((b, i) => (
            <li key={i} className="text-[11px] leading-snug">
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: STRENGTH[String(b.kekuatan)] ?? "#8f99a8" }} />
              <span className="text-[#e5e8eb]">{String(b.indikasi)}</span> <span className="text-[#8f99a8]">({String(b.kekuatan)} · {String(b.oleh)}{b.pada ? ` · ${wib(String(b.pada))}` : ""})</span>
              <span className="block pl-3.5 text-justify text-[#c5cbd3]">{String(b.teks)}</span>
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(l.aturan) && (
        <table className="mt-1.5 w-full text-[11px]">
          <tbody>
            {(l.aturan as Rec[]).map((r, i) => {
              const chosen = !l.dikoreksi && Number(r.nilai) > 0 && Number(r.nilai) === Number(l.dipilih);
              return (
                <tr key={i} className={`border-t border-white/[.04] ${chosen ? "text-white" : "text-[#abb3bf]"}`}>
                  <td className="py-0.5 pr-2">{chosen ? "▶ " : ""}{String(r.komponen)}</td>
                  <td className="pr-2 text-[10.5px] text-[#8f99a8]">{String(r.rumus)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">Rp {idn(Number(r.nilai))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {l.dikoreksi ? <p className="mt-1 text-[11px] text-[#7ee2c0]">Sudah dikoreksi verifikator (selisih Rp {idn(Number(l.selisih))}): dihitung sebagai terpulihkan, bukan kerugian.</p> : null}
      {n.id === "berkas" && (
        <>
          <p className="mt-1 text-[11.5px] text-[#e5e8eb]">Klaim ini Rp {idn(Number(l.klaim_ini ?? 0))} dari estimasi kerugian faskes Rp {idn(Number(l.estimasi_faskes ?? 0))}
            {l.porsi_pct != null ? ` (${idn(Number(l.porsi_pct), 1)}%)` : ""}.</p>
          <p className="mt-1 text-[10.5px] text-[#8f99a8]">Jalurnya: {path.map((x) => x.name).join(" ← ")}</p>
        </>
      )}
    </div>
  );
}

/** The lineage panel of one case file: which claim, the flow, then the chosen node's rincian. */
export function JejakData({ run, fid, claims, open = false, print = false }: { run: string; fid: string;
  claims: { id: string; label: string }[]; open?: boolean; print?: boolean }) {
  const [shown, setShown] = useState(open);
  const [sel, setSel] = useState(claims[0]?.id ?? "");
  const [traces, setTraces] = useState<Record<string, ClaimTrace | string>>({});
  const [node, setNode] = useState("berkas");
  const [full, setFull] = useState(false);
  const [all, setAll] = useState(false);
  const uid = useId().replace(/:/g, "");
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!shown || !sel || asked.current.has(sel)) return;
    asked.current.add(sel);
    fraud.claimTrace(run, sel, fid)
      .then((t) => setTraces((m) => ({ ...m, [sel]: t })))
      .catch((e) => setTraces((m) => ({ ...m, [sel]: (e as Error).message })));
  }, [shown, sel, run, fid]);
  const t = traces[sel];
  // the PDF waits for the drawn flow, not just the answer
  useEffect(() => { if (print && t !== undefined) document.documentElement.setAttribute("data-jejak", "siap"); }, [print, t]);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [full]);
  const g = useMemo(() => (typeof t === "object" ? flow(t) : null), [t]);
  const cur = g?.nodes.find((n) => n.id === node) ?? g?.nodes[g.nodes.length - 1];
  const chips = claims.length > 1 && (
    <div className="lp-no-print flex flex-wrap gap-x-2 gap-y-1.5">
      {claims.map((c) => (
        <button key={c.id} onClick={() => setSel(c.id)} className={`max-w-full break-words rounded border px-2 py-1 text-left font-mono text-[10.5px] leading-snug ${sel === c.id ? "border-[#9d8cff] bg-[#9d8cff]/15 text-white" : "border-white/10 text-[#abb3bf] hover:text-white"}`}>{c.label}</button>
      ))}
    </div>
  );
  return (
    <details open={shown} onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)} className="rounded border border-[#9d8cff]/25 bg-[#9d8cff]/[.04]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[11.5px] [&::-webkit-details-marker]:hidden">
        <Icon name="graph" className="h-3.5 w-3.5 text-[#c9c0ff]" />
        <span className="shrink-0 font-semibold text-[#e5e8eb]">Jejak data</span>
        <span className="min-w-0 flex-1 basis-56 leading-snug text-[#8f99a8]">dari transaksi mentah BPJS, lewat pipeline dan inferensi ML, sampai angka di berkas ini</span>
        <Icon name="down" className={`lp-no-print ml-auto h-3.5 w-3.5 text-[#8f99a8] transition-transform ${shown ? "rotate-180" : ""}`} />
      </summary>
      {shown && (
        <div className="space-y-2.5 border-t border-[#9d8cff]/20 px-3 pb-3 pt-2">
          {chips}
          {t === undefined && <p className="text-[11px] text-[#8f99a8]">Menelusuri klaim {sel} di Files dan menjalankan model pada baris fiturnya (±10 detik pertama kali)…</p>}
          {typeof t === "string" && <p className="text-[11px] text-[#ffb4b4]">Jejak tidak terbaca: {t}</p>}
          {typeof t === "object" && g && cur && (print ? (
            <>
              {/* paper: the whole flow fitted to the page's width, then every node's rincian in the flow's order */}
              <svg viewBox={`${GB.x} ${GB.y} ${GB.w} ${GB.h}`} className="w-full rounded border border-[#dde1e6]" role="img" aria-label="Jejak data klaim">
                <Graph nodes={g.nodes} edges={g.edges} sel={null} print uid={uid} />
              </svg>
              <div className="space-y-2">{g.nodes.filter((n) => n.id !== "nexus" && n.id !== "nexus_fakta").map((n) => <Detail key={n.id} n={n} t={t} nodes={g.nodes} edges={g.edges} />)}</div>
            </>
          ) : (
            <>
              <Canvas nodes={g.nodes} edges={g.edges} sel={cur.id} onSel={setNode} full={false} onFull={setFull} className="h-[380px]" />
              <div className="flex items-center gap-2 text-[10.5px] text-[#8f99a8]">
                <span>Rincian node <b className="text-[#e5e8eb]">{cur.name}</b> · klik node lain untuk rinciannya; garis menyala = jalur asal angkanya</span>
                <button onClick={() => setAll(!all)} className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[#abb3bf] hover:text-white">{all ? "Hanya node terpilih" : "Semua node"}</button>
              </div>
              {all ? (
                <div className="space-y-2">{g.nodes.filter((n) => n.id !== "nexus" && n.id !== "nexus_fakta").map((n) => <Detail key={n.id} n={n} t={t} nodes={g.nodes} edges={g.edges} />)}</div>
              ) : (
                <Detail n={cur} t={t} nodes={g.nodes} edges={g.edges} />
              )}
              {full && createPortal(
                <div className="fixed inset-0 z-[80] flex flex-col gap-2 bg-[#0d1014]/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Jejak data, layar penuh">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <Icon name="graph" className="h-4 w-4 text-[#c9c0ff]" />
                    <span className="font-semibold text-[#e5e8eb]">Jejak data · klaim {t.kunjungan}</span>
                    <span className="text-[#8f99a8]">{String(g.nodes[g.nodes.length - 1].name)}</span>
                    <div className="ml-4">{chips}</div>
                  </div>
                  <div className="flex min-h-0 flex-1 gap-3">
                    <Canvas nodes={g.nodes} edges={g.edges} sel={cur.id} onSel={setNode} full onFull={setFull} className="min-h-0 flex-1" />
                    <aside className="w-[440px] shrink-0 overflow-y-auto"><Detail n={cur} t={t} nodes={g.nodes} edges={g.edges} /></aside>
                  </div>
                </div>,
                document.body,
              )}
            </>
          ))}
          {typeof t === "object" && <p className="text-[10px] text-[#8f99a8]">Dibaca {wib(t.dibaca_pada)} sebagai Anda; model {t.ml_versi ?? "—"}. ƒ = dihitung di lapis itu; kolom FKL = nama dan kode asli berkas BPJS.</p>}
        </div>
      )}
    </details>
  );
}
