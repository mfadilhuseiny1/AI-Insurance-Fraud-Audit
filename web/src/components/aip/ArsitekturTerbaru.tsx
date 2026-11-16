"use client";

// ML Studio · Sistem ML terbaru · "Arsitektur & sistem terbaru" (2026-11-13): the system in use and the v4 candidate drawn as a flow,
// every v4 architecture compared on validation (LightGBM, hospital layer, GraphSAGE / R-GCN, hybrid, MLP / FT-Transformer; the GNN /
// DL variants trained on a RunPod GPU), the graph variants on generator 3 (a SECOND use of that test set, labelled), and the GPU ->
// CPU load check. Read from arsitektur_graf in /api/ml-sistem (testing/laporan_graf.py). Aggregates of synthetic data only.

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import type { V5 } from "./SistemV5";
import type { MLV5 } from "./BenchmarkMlV5";
import type { MLV6 } from "./BenchmarkMlV6";
import type { ShiftDx } from "./DiagnosaShift";
import type { MLV7 } from "./BenchmarkMlV7";
import { ChartCard, GRID, SERIES } from "./viz";

type MS = { rata: number; min: number; maks: number };
type VarVal = { kunci: string; nama: string; jenis: string; recall_fpr1: MS; presisi_fpr01_prev2: MS; auprc: number; ci_recall?: [number, number];
  selisih_vs_B_ci?: [number, number]; perangkat: string; detik?: number };
type Tier = { recall: number; fpr: number; presisi_mentah: number; presisi_prev2: number; ditandai: number; ci?: { recall: [number, number]; fpr: [number, number] } };
type G3 = { nama: string; bobot?: string; validasi: { periksa: Tier; tahan: Tier };
  gen3: { klaim: number; fraud: number; periksa: Tier; tahan: Tier; auprc: number; auroc: number; fpr_kunjungan_pertama: number; fpr_pasien_lama: number;
    recall_per_skema: Record<string, number> } };
type Uk = { recall: number; fpr: number; presisi_prev2: number; presisi_mentah: number; ditandai: number };
type RSet = { klaim: number; fraud: number; prevalensi: number; penggunaan: string; B_saja: Uk; B_plus_rule_atas: Uk; B_plus_rule_anggaran: Uk; rule_saja: Uk;
  selisih_ci: Record<"atas" | "anggaran", { recall: [number, number]; fpr: [number, number]; presisi_prev2: [number, number] }>;
  fpr_kunjungan_pertama: { B_saja: number; atas: number }; fpr_pasien_lama: { B_saja: number; atas: number };
  per_skema: { B_saja: Record<string, number>; atas: Record<string, number> };
  per_rule: { rule: string; kena: number; fraud_baru: number; normal_baru: number; presisi_mentah: number; sudah_ditangkap_model: number }[] };
type RT = { dibuat: string; rule: { v4: string[]; bawaan_v3: number; jaringan: boolean }; ambang: { laju_rule_normal_validasi: number };
  hasil: Record<string, RSet>; catatan: string[] };
export type AG = {
  dibuat: string;
  rule_tambah?: RT;
  v5?: V5;
  ml_v5?: MLV5;
  ml_v6?: MLV6;
  shift?: ShiftDx;
  ml_v7?: MLV7;
  validasi: { varian: VarVal[]; terpilih: string; seri: string[]; aturan: string; baris: number; fraud: number; latih_baris: number; latih_fraud: number;
    graf?: { simpul: number; tepi_per_relasi: Record<string, number> } };
  gen3?: { varian: Record<string, G3>; catatan: string[]; dibuat: string; graf: { simpul_gen3: number; tetangga_sama_dengan_X1: Record<string, number> };
    n_skema?: Record<string, number> };
  gpu_cpu?: { gpu: string; menit_latih_semua_DEF: number | null; biaya_usd_kira: number; harga_per_jam: number;
    cek: Record<string, { maks_selisih_logit: number; flag_sama: number; detik_cpu_semua_node?: number; detik_cpu_8152_klaim?: number }> };
};

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const JENIS: Record<string, string> = { tabular: SERIES[0], graph: SERIES[4], hybrid: SERIES[2], "deep learning": SERIES[3] };
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}

// ---------------------------------------------------------------- flow of the system

function Kotak({ ikon, judul, sub, warna = "#8f99a8", putus = false }: { ikon: IconName; judul: string; sub: string; warna?: string; putus?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-1 items-start gap-2 rounded-md border bg-[#151a1f] px-2.5 py-2 ${putus ? "border-dashed" : ""}`} style={{ borderColor: `${warna}66` }}>
      <span className="mt-0.5 shrink-0" style={{ color: warna }}><Icon name={ikon} className="h-4 w-4" /></span>
      <div className="min-w-0"><p className="text-[11.5px] font-semibold text-white">{judul}</p><p className="text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p></div>
    </div>
  );
}
const Panah = () => <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />;

function Alur() {
  return (
    <section className={`${box} space-y-3 p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-white">Alur sistem · v4 (kandidat)</h3>
        <Chip warna="#7ee2c0">v4 = B terpilih di validasi</Chip><Chip warna="#c5cbd3" garis>/testing masih v3</Chip>
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <Kotak ikon="upload" judul="Klaim (batch)" sub="INA-CBG · peserta · RS · kode" />
        <Panah />
        <Kotak ikon="graph" judul="Fitur graph tetangga" sub="124 fitur sendiri + rata-rata tetangga di 4 relasi" warna={SERIES[4]} />
        <Panah />
        <Kotak ikon="bolt" judul="Fitur mekanisme X4" sub="22 fitur: klon mirip, kartu ganda, top-up, readmisi" warna={SERIES[3]} />
        <Panah />
        <Kotak ikon="cpu" judul="LightGBM × 3 seed" sub="skor = rata-rata 3 model" warna={SERIES[0]} />
        <Panah />
        <div className="flex min-w-[150px] flex-col gap-1.5">
          {([["TAHAN", "FPR ≤ 0,1%", "#e5484d"], ["PERIKSA", "FPR ≤ 1%", "#c98500"], ["LOLOS", "sisanya", "#5f6b7a"]] as const).map(([k, s, w]) => (
            <div key={k} className="flex items-center justify-between gap-2 rounded border px-2 py-1" style={{ borderColor: `${w}66` }}>
              <span className="text-[11px] font-semibold" style={{ color: w === "#5f6b7a" ? "#c5cbd3" : w }}>{k}</span><span className="text-[10px] text-[#8f99a8]">{s}</span>
            </div>))}
        </div>
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <Kotak ikon="logic" judul="Rule engine (aturan kustom)" sub="bahasa biasa → aturan, diuji lalu disetujui admin; aktif setelah restart API" warna="#8f99a8" putus />
        <Kotak ikon="constellation" judul="AI Agent Swarm" sub="menelaah antrean PERIKSA, bukan skor ke RS" warna="#8f99a8" putus />
        <Kotak ikon="graph" judul="GNN (eksperimen)" sub="GraphSAGE / R-GCN: belum masuk sistem, lihat hasil di bawah" warna={SERIES[4]} putus />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- every architecture on validation

function Validasi({ a }: { a: AG["validasi"] }) {
  const rows = [...a.varian].sort((x, y) => y.recall_fpr1.rata - x.recall_fpr1.rata);
  const lo = 0.4, hi = 0.85;
  const x = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const b = a.varian.find((v) => v.kunci === "B");
  return (
    <ChartCard title="9 arsitektur di data validasi · recall pada FPR 1%"
      insight={`Pemilihan pra-registrasi: tertinggi, selisih < 1 poin = seri → yang lebih sederhana menang. Terpilih: ${a.terpilih}.`}
      source={<span>validasi {id(a.baris)} klaim ({id(a.fraud)} fraud) · latih {id(a.latih_baris)} · data sintetis</span>}
      table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Varian</th><th className="px-2 py-1 text-right">Recall FPR 1%</th>
        <th className="px-2 py-1 text-right">95% CI</th><th className="px-2 py-1 text-right">Prec. FPR 0,1%</th><th className="px-2 py-1 text-right">AUPRC</th></tr></thead>
        <tbody className="text-[#d3d8de]">{rows.map((v) => <tr key={v.kunci} className="border-t border-white/[.05]"><td className="px-2 py-1">{v.kunci} · {v.nama}</td>
          <td className="px-2 py-1 text-right tabular-nums">{pct(v.recall_fpr1.rata)}</td><td className="px-2 py-1 text-right tabular-nums">{v.ci_recall ? `${pct(v.ci_recall[0], 0)}–${pct(v.ci_recall[1], 0)}` : "—"}</td>
          <td className="px-2 py-1 text-right tabular-nums">{pct(v.presisi_fpr01_prev2.rata, 0)}</td><td className="px-2 py-1 text-right tabular-nums">{id(v.auprc, 3)}</td></tr>)}</tbody></table>}>
      <div className="mb-2 flex flex-wrap gap-1.5">{Object.entries(JENIS).map(([k, w]) => <Chip key={k} warna={w}><span className="h-2 w-2 rounded-full" style={{ background: w }} />{k}</Chip>)}</div>
      <div className="space-y-1.5">
        {rows.map((v) => {
          const w = JENIS[v.jenis] ?? "#8f99a8", pilih = v.kunci === a.terpilih, seri = a.seri.includes(v.kunci) && !pilih;
          return (
            <div key={v.kunci} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 190px) minmax(0, 1fr) 118px" }}>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[#d3d8de]">
                <span className="truncate" title={v.nama}>{v.nama}</span>
                {pilih && <Chip warna="#7ee2c0">terpilih</Chip>}{seri && <Chip warna="#c5cbd3" garis>seri</Chip>}
              </span>
              <div className="relative h-5 rounded" style={{ background: GRID }}>
                {b && <span className="absolute inset-y-0 w-px bg-white/30" style={{ left: x(b.recall_fpr1.rata) }} title="B" />}
                {v.ci_recall && <span className="absolute top-1/2 h-px -translate-y-1/2" style={{ left: x(v.ci_recall[0]), width: `calc(${x(v.ci_recall[1])} - ${x(v.ci_recall[0])})`, background: w }} />}
                {v.ci_recall && [0, 1].map((i) => <span key={i} className="absolute top-1/2 h-2 w-px -translate-y-1/2" style={{ left: x(v.ci_recall![i]), background: w }} />)}
                <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1c2127]" style={{ left: x(v.recall_fpr1.rata), background: w }}
                  title={`${v.nama}: ${pct(v.recall_fpr1.rata)} (seed ${pct(v.recall_fpr1.min)}–${pct(v.recall_fpr1.maks)})`} />
              </div>
              <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{pct(v.recall_fpr1.rata)} <span className="text-[#8f99a8]">· prec {pct(v.presisi_fpr01_prev2.rata, 0)}</span></span>
            </div>
          );
        })}
        <div className="grid gap-2 pt-1 text-[10px] text-[#8f99a8]" style={{ gridTemplateColumns: "minmax(0, 190px) minmax(0, 1fr) 118px" }}>
          <span /><span className="flex justify-between"><span>{pct(lo, 0)}</span><span>garis = B · whisker = 95% CI (bootstrap per peserta)</span><span>{pct(hi, 0)}</span></span><span />
        </div>
      </div>
    </ChartCard>
  );
}

// ---------------------------------------------------------------- graph variants on generator 3

const URUT_G3 = ["B", "D_sage", "D_rgcn", "E_sage", "E_rgcn"];
const WARNA_G3: Record<string, string> = { B: SERIES[0], D_sage: SERIES[4], D_rgcn: "#b0698a", E_sage: SERIES[2], E_rgcn: "#5fae8f" };

function Bar({ v, w, label, target }: { v: number; w: string; label: string; target?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, v * 100))}%`, background: w }} />
        {target !== undefined && <span className="absolute inset-y-[-3px] w-px bg-white/70" style={{ left: `${target * 100}%` }} title={`target ${pct(target, 0)}`} />}
      </div>
      <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label}</span>
    </div>
  );
}

function Gen3({ g }: { g: NonNullable<AG["gen3"]> }) {
  const ks = URUT_G3.filter((k) => g.varian[k]);
  const B = g.varian.B;
  // the schemes (>= 20 fraud claims, so a change is not one or two claims) where the graph variants differ most from B
  const n = g.n_skema ?? {};
  const skema = B ? Object.keys(B.gen3.recall_per_skema) : [];
  const beda = skema.filter((s) => (n[s] ?? 0) >= 20)
    .map((s) => ({ s, d: Math.max(...ks.filter((k) => k !== "B").map((k) => Math.abs((g.varian[k].gen3.recall_per_skema[s] ?? 0) - (B.gen3.recall_per_skema[s] ?? 0)))) }))
    .sort((a, b) => b.d - a.d).slice(0, 6).map((x) => x.s);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-amber-400/40 bg-amber-400/[.05] px-3 py-2">
        <Icon name="alert" className="h-4 w-4 text-amber-300" />
        <span className="text-[11.5px] text-amber-100">Pemakaian KEDUA generator 3: eksplorasi, bukan dasar pemilihan. v4 = B tetap.</span>
        <Chip warna="#c5cbd3" garis>ambang dari validasi</Chip><Chip warna="#c5cbd3" garis>pulang dini dipisah (mutu)</Chip>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {ks.map((k) => {
          const v = g.varian[k], p = v.gen3.periksa, t = v.gen3.tahan, w = WARNA_G3[k];
          const dB = B && k !== "B" ? p.recall - B.gen3.periksa.recall : null;
          return (
            <section key={k} className={`${box} space-y-2 p-3`} style={{ borderTop: `2px solid ${w}` }}>
              <div className="flex items-center justify-between gap-1"><p className="truncate text-[12px] font-semibold text-white" title={v.nama}>{v.nama}</p>
                {dB !== null && <Chip warna={dB > 0.005 ? "#7ee2c0" : dB < -0.005 ? "#ff8a8d" : "#c5cbd3"}>{dB >= 0 ? "+" : ""}{id(dB * 100, 1)} poin</Chip>}</div>
              <p className="text-[26px] font-semibold leading-none tabular-nums text-white">{pct(p.recall)}</p>
              <p className="text-[10.5px] text-[#8f99a8]">recall PERIKSA · FPR {pct(p.fpr, 2)}</p>
              {p.ci && <p className="text-[10px] text-[#8f99a8]">95% CI {pct(p.ci.recall[0], 0)}–{pct(p.ci.recall[1], 0)}</p>}
              <Bar v={p.presisi_prev2} w={SERIES[1]} label={`prec ${pct(p.presisi_prev2, 0)}`} />
              <div className="flex flex-wrap gap-1 pt-0.5">
                <Chip>TAHAN {pct(t.recall, 0)} · prec {pct(t.presisi_prev2, 0)}</Chip><Chip>AUPRC {id(v.gen3.auprc, 2)}</Chip>
              </div>
              <p className="text-[10px] text-[#8f99a8]">validasi: {pct(v.validasi.periksa.recall)} pada FPR {pct(v.validasi.periksa.fpr, 2)}</p>
            </section>
          );
        })}
      </div>
      {B && (
        <ChartCard title="Generator 3 · skema yang paling berubah dengan graph (recall PERIKSA)"
          insight="Hanya skema dengan ≥ 20 klaim fraud. Naik di skema tagihan/top-up gelembung; skema jaringan (rujukan semu, dokter tiga RS) hampir tidak berubah."
          table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Skema</th><th className="px-2 py-1 text-right">n</th>{ks.map((k) => <th key={k} className="px-2 py-1 text-right">{k}</th>)}</tr></thead>
            <tbody className="text-[#d3d8de]">{skema.map((s) => <tr key={s} className="border-t border-white/[.05]"><td className="px-2 py-1">{s}</td><td className="px-2 py-1 text-right tabular-nums">{n[s] ?? "—"}</td>
              {ks.map((k) => <td key={k} className="px-2 py-1 text-right tabular-nums">{pct(g.varian[k].gen3.recall_per_skema[s])}</td>)}</tr>)}</tbody></table>}>
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
            {beda.map((s) => (
              <div key={s} className="space-y-1">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#d3d8de]"><span className="truncate" title={s}>{s.replace(/_/g, " ")}</span><Chip>n {n[s] ?? "—"}</Chip></p>
                {ks.map((k) => <Bar key={k} v={g.varian[k].gen3.recall_per_skema[s] ?? 0} w={WARNA_G3[k]} label={`${k.replace("_", " ")} ${pct(g.varian[k].gen3.recall_per_skema[s], 0)}`} />)}
              </div>
            ))}
          </div>
        </ChartCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- v4 + rule engine (exploratory)

const SET_RT: [string, string][] = [["validasi", "Validasi"], ["uji_c2", "Test C2"], ["gen2_seed3", "Gen2 seed 3"], ["generator3", "Generator 3"]];
const W_B = SERIES[0], W_R = SERIES[2];

function Delta({ d, baik, satuan = "poin", digit = 1 }: { d: number; baik: "naik" | "turun"; satuan?: string; digit?: number }) {
  const bagus = baik === "naik" ? d > 0.0005 : d < -0.0005, buruk = baik === "naik" ? d < -0.0005 : d > 0.0005;
  return <Chip warna={bagus ? "#7ee2c0" : buruk ? "#f0c661" : "#c5cbd3"}>{d >= 0 ? "+" : "−"}{id(Math.abs(d) * 100, digit)} {satuan}</Chip>;
}

function KartuSet({ nama, r }: { nama: string; r: RSet }) {
  const b = r.B_saja, a = r.B_plus_rule_atas, g = r.B_plus_rule_anggaran, ci = r.selisih_ci.atas;
  return (
    <section className={`${box} space-y-2.5 p-3`}>
      <div className="flex items-center justify-between gap-1">
        <p className="text-[12px] font-semibold text-white">{nama}</p>
        <Chip warna="#c5cbd3" garis>{r.penggunaan.startsWith("tempat") ? "set pemilihan" : r.penggunaan}</Chip>
      </div>
      {([["Recall", b.recall, a.recall, "naik", ci.recall], ["Precision · fraud 2%", b.presisi_prev2, a.presisi_prev2, "naik", ci.presisi_prev2]] as const).map(([lbl, v0, v1, baik, c]) => (
        <div key={lbl} className="space-y-1">
          <div className="flex items-center justify-between gap-1"><span className="text-[10.5px] text-[#8f99a8]">{lbl}</span><Delta d={v1 - v0} baik={baik} /></div>
          <Bar v={v0} w={W_B} label={`B ${pct(v0)}`} />
          <Bar v={v1} w={W_R} label={`+rule ${pct(v1)}`} />
          <p className="text-[9.5px] text-[#8f99a8]">95% CI selisih {id(c[0] * 100, 1)} s/d {id(c[1] * 100, 1)} poin</p>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[.06] pt-2">
        <span className="text-[10.5px] text-[#8f99a8]">FPR {pct(b.fpr, 2)} → {pct(a.fpr, 2)}</span><Delta d={a.fpr - b.fpr} baik="turun" digit={2} />
      </div>
      <p className="text-[10.5px] text-[#abb3bf]">antrean PERIKSA {id(b.ditandai)} → {id(a.ditandai)} klaim</p>
      <p className="text-[10px] text-[#8f99a8]">FPR dikunci 1%: recall {pct(g.recall)} · prec {pct(g.presisi_prev2, 0)}</p>
    </section>
  );
}

function RuleTambah({ t, nSkema }: { t: RT; nSkema?: Record<string, number> }) {
  const ada = SET_RT.filter(([k]) => t.hasil[k]);
  const [pilih, setPilih] = useState("generator3");
  const r = t.hasil[pilih] ?? t.hasil[ada[0]?.[0]];
  const rows = (r?.per_rule ?? []).slice(0, 10);
  const maks = Math.max(1, ...rows.map((x) => x.fraud_baru + x.normal_baru));
  const skemaNaik = pilih === "generator3" && nSkema && r
    ? Object.keys(r.per_skema.B_saja).filter((s) => (nSkema[s] ?? 0) >= 20).map((s) => ({ s, b: r.per_skema.B_saja[s], a: r.per_skema.atas[s] }))
      .filter((x) => x.a - x.b >= 0.03).sort((x, y) => (y.a - y.b) - (x.a - x.b)).slice(0, 5)
    : [];
  const asal = (nm: string) => { const [k, ...rest] = nm.split(" · "); return { k, n: rest.join(" · ") || nm }; };
  return (
    <div className="space-y-4">
      <section className={`${box} space-y-3 p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#c5cbd3]"><Icon name="logic" className="h-4 w-4" /></span>
          <h3 className="text-[13px] font-semibold text-white">v4 + rule engine · recall & precision</h3>
          <Chip>{t.rule.v4.length} rule v4</Chip><Chip>{t.rule.bawaan_v3} sinyal rule bawaan</Chip>{t.rule.jaringan && <Chip>network rule</Chip>}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-amber-400/40 bg-amber-400/[.05] px-3 py-2">
          <Icon name="alert" className="h-4 w-4 text-amber-300" />
          <span className="text-[11.5px] text-amber-100">Eksplorasi: rule & ambang dari validasi, set uji dipakai ulang. v4 = B tetap.</span>
          <Chip warna="#c5cbd3" garis>rule → PERIKSA saja, TAHAN tetap</Chip>
        </div>
        <div className="flex flex-wrap gap-3 text-[10.5px] text-[#abb3bf]">
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: W_B }} />B saja (beku)</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ background: W_R }} />B + rule (ditambahkan di atas ambang model)</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{ada.map(([k, nm]) => <KartuSet key={k} nama={nm} r={t.hasil[k]} />)}</div>
      </section>
      {r && (
        <ChartCard title="Per rule · fraud yang tidak ditangkap model vs alarm salah baru"
          insight={`Rule normal di validasi menandai ${pct(t.ambang.laju_rule_normal_validasi, 2)} klaim normal: hampir seluruh jatah FPR 1%. Beberapa rule menambah fraud, sisanya hanya alarm salah.`}
          table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Rule</th><th className="px-2 py-1 text-right">Kena</th><th className="px-2 py-1 text-right">Fraud baru</th>
            <th className="px-2 py-1 text-right">Normal baru</th><th className="px-2 py-1 text-right">Sudah ditangkap model</th><th className="px-2 py-1 text-right">Presisi</th></tr></thead>
            <tbody className="text-[#d3d8de]">{r.per_rule.map((x) => <tr key={x.rule} className="border-t border-white/[.05]"><td className="px-2 py-1">{x.rule}</td><td className="px-2 py-1 text-right tabular-nums">{id(x.kena)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{x.fraud_baru}</td><td className="px-2 py-1 text-right tabular-nums">{x.normal_baru}</td><td className="px-2 py-1 text-right tabular-nums">{x.sudah_ditangkap_model}</td>
              <td className="px-2 py-1 text-right tabular-nums">{pct(x.presisi_mentah, 0)}</td></tr>)}</tbody></table>}>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {ada.map(([k, nm]) => (
              <button key={k} type="button" onClick={() => setPilih(k)} className={`rounded px-2 py-0.5 text-[11px] ${k === pilih ? "bg-white/[.12] text-white" : "text-[#8f99a8] hover:text-white"}`}>{nm}</button>
            ))}
          </div>
          <div className="space-y-1.5">
            {rows.map((x) => {
              const { k, n } = asal(x.rule);
              return (
                <div key={x.rule} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 230px) minmax(0, 1fr) 128px" }}>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[#d3d8de]"><Chip garis>{k}</Chip><span className="truncate" title={n}>{n.replace(/_/g, " ")}</span></span>
                  <div className="flex h-3.5 gap-0.5" title={`${x.fraud_baru} fraud baru · ${x.normal_baru} normal baru · ${x.sudah_ditangkap_model} fraud sudah ditangkap model`}>
                    {x.fraud_baru > 0 && <span className="rounded-l" style={{ width: `${(x.fraud_baru / maks) * 100}%`, background: W_R }} />}
                    {x.normal_baru > 0 && <span className="rounded-r" style={{ width: `${(x.normal_baru / maks) * 100}%`, background: "#5f6b7a" }} />}
                  </div>
                  <span className="text-right text-[10.5px] tabular-nums text-[#d3d8de]">+{x.fraud_baru} fraud · <span className="text-[#8f99a8]">+{x.normal_baru} normal</span></span>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-3 pt-1 text-[10px] text-[#8f99a8]">
              <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: W_R }} />fraud yang lolos dari model, ditangkap rule</span>
              <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#5f6b7a]" />klaim normal baru di antrean (alarm salah)</span>
            </div>
          </div>
          {skemaNaik.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-white/[.06] pt-3">
              <p className="text-[11px] font-medium text-[#d3d8de]">Skema yang paling naik dengan rule (≥ 20 klaim fraud)</p>
              <div className="grid gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                {skemaNaik.map((x) => (
                  <div key={x.s} className="space-y-1">
                    <p className="flex items-center gap-1.5 text-[11px] text-[#d3d8de]"><span className="truncate">{x.s.replace(/_/g, " ")}</span><Chip>n {nSkema?.[x.s]}</Chip></p>
                    <Bar v={x.b} w={W_B} label={`B ${pct(x.b, 0)}`} /><Bar v={x.a} w={W_R} label={`+rule ${pct(x.a, 0)}`} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- GPU -> CPU

function GpuCpu({ c }: { c: NonNullable<AG["gpu_cpu"]> }) {
  const d = c.cek.D_rgcn_s0, m = c.cek.F_mlp_s0;
  return (
    <section className={`${box} p-4`}>
      <h3 className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="server" className="h-4 w-4 text-[#9ec5ff]" />Latih di GPU, jalan di CPU</h3>
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        <div className="flex-1 rounded-md border border-white/[.08] bg-[#151a1f] p-3">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Training · {c.gpu}</p>
          <p className="text-[22px] font-semibold tabular-nums text-white">{c.menit_latih_semua_DEF !== null ? `${id(c.menit_latih_semua_DEF, 1)} menit` : "—"}</p>
          <p className="text-[10.5px] text-[#abb3bf]">6 varian × 3 seed · pod ± 12 menit · ≈ ${id(c.biaya_usd_kira, 2)}</p>
        </div>
        <Icon name="right" className="hidden h-5 w-5 text-[#5f6b7a] md:block" />
        <div className="flex-1 rounded-md border border-white/[.08] bg-[#151a1f] p-3">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Bobot (.pt) · state_dict di CPU</p>
          <p className="text-[22px] font-semibold text-white">&lt; 1 MB</p>
          <p className="text-[10.5px] text-[#abb3bf]">torch.load(map_location=&quot;cpu&quot;)</p>
        </div>
        <Icon name="right" className="hidden h-5 w-5 text-[#5f6b7a] md:block" />
        <div className="flex-1 rounded-md border border-[#199e70]/40 bg-[#151a1f] p-3">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Inference · CPU lokal</p>
          <p className="text-[22px] font-semibold tabular-nums text-white">{d?.detik_cpu_semua_node !== undefined ? `${id(d.detik_cpu_semua_node, 2)} dtk` : "—"}</p>
          <p className="text-[10.5px] text-[#abb3bf]">R-GCN, 97 rb node sekaligus</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {d && <Chip warna="#7ee2c0"><Icon name="check" className="h-3 w-3" />R-GCN: skor sama (selisih maks {d.maks_selisih_logit.toExponential(0)}), klaim ditandai {pct(d.flag_sama, 0)} sama</Chip>}
        {m && <Chip warna="#7ee2c0"><Icon name="check" className="h-3 w-3" />MLP: selisih maks {m.maks_selisih_logit.toExponential(0)}, ditandai {pct(m.flag_sama, 0)} sama</Chip>}
        <Chip warna="#c5cbd3" garis>data sintetis saja yang dikirim ke GPU</Chip>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- takeaways

function Kesimpulan({ a }: { a: AG }) {
  const v = Object.fromEntries(a.validasi.varian.map((x) => [x.kunci, x]));
  const g = a.gen3?.varian;
  const items: [IconName, string, string][] = [
    ["check", "#7ee2c0", `Validasi: B tetap terbaik (${pct(v.B?.recall_fpr1.rata)}); hybrid GraphSAGE seri (${pct(v.E_sage?.recall_fpr1.rata)}), aturan pilih yang lebih sederhana.`],
    ["graph", SERIES[4], `GNN murni di validasi lebih rendah (${pct(v.D_sage?.recall_fpr1.rata)} / ${pct(v.D_rgcn?.recall_fpr1.rata)}); DL tabular paling rendah.`],
  ];
  if (g?.B && g.E_rgcn && g.D_sage) {
    items.push(["alert", "#f0c661", `Generator 3: graph naik ±5–6 poin (B ${pct(g.B.gen3.periksa.recall)} → hybrid R-GCN ${pct(g.E_rgcn.gen3.periksa.recall)} pada FPR ${pct(g.E_rgcn.gen3.periksa.fpr, 2)} vs ${pct(g.B.gen3.periksa.fpr, 2)}): membantu di data asing, tapi masih jauh dari 80%.`]);
    items.push(["eye", "#9ec5ff", `GraphSAGE menurunkan alarm salah di pasien baru (${pct(g.B.gen3.fpr_kunjungan_pertama, 1)} → ${pct(g.D_sage.gen3.fpr_kunjungan_pertama, 1)}), tapi naik di pasien lama (${pct(g.B.gen3.fpr_pasien_lama, 1)} → ${pct(g.D_sage.gen3.fpr_pasien_lama, 1)}).`]);
    items.push(["sparkle", "#c5cbd3", "Generator 3 sudah dipakai berulang (graph ke-2, rule ke-3): untuk pindah ke hybrid graph atau rule route, uji sekali di data baru (generator 3 seed lain) dulu."]);
  }
  const rg = a.rule_tambah?.hasil.generator3;
  if (rg) {
    items.push(["logic", "#c5cbd3", `Rule engine di atas B: recall naik (generator 3 ${pct(rg.B_saja.recall)} → ${pct(rg.B_plus_rule_atas.recall)}), tapi FPR ${pct(rg.B_saja.fpr, 2)} → ${pct(rg.B_plus_rule_atas.fpr, 2)} dan precision turun di semua set. FPR dikunci 1% → recall malah turun.`]);
  }
  items.push(["info", "#9ec5ff", "80% recall + 80% precision hanya tercapai di data mirip generator 1; skema baru tetap butuh contoh, rule, atau AI."]);
  return (
    <section className={`${box} space-y-2 p-4`}>
      <h3 className="text-[13px] font-semibold text-white">Kesimpulan jujur</h3>
      {items.map(([ik, w, t]) => (
        <div key={t} className="flex items-start gap-2"><span className="mt-0.5 shrink-0" style={{ color: w }}><Icon name={ik} className="h-4 w-4" /></span><p className="text-[11.5px] leading-snug text-[#d3d8de]">{t}</p></div>
      ))}
    </section>
  );
}

export function ArsitekturTerbaru({ a }: { a: AG }) {
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#3987e5]/20 text-[#9ec5ff]"><Icon name="layers" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Arsitektur & sistem terbaru · {a.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">9 arsitektur dibandingkan: LightGBM, graph (GNN), hybrid, deep learning</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {a.v5?.adopsi.lolos ? <Chip warna="#7ee2c0">sistem terbaru: v5 (v4 {a.validasi.terpilih} + rule + swarm ADK)</Chip>
              : <Chip warna="#7ee2c0">sistem terbaru: v4 = {a.validasi.terpilih}</Chip>}<Chip warna="#c5cbd3" garis>/testing masih v3 (ganti model = keputusan pengguna)</Chip>
            {a.validasi.graf && <Chip>graph {id(a.validasi.graf.simpul)} node · {id(Object.values(a.validasi.graf.tepi_per_relasi).reduce((s, x) => s + x, 0))} edge</Chip>}
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>
      <Alur />
      <Validasi a={a.validasi} />
      {a.gen3 && <Gen3 g={a.gen3} />}
      {a.rule_tambah && <RuleTambah t={a.rule_tambah} nSkema={a.gen3?.n_skema} />}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        {a.gpu_cpu && <GpuCpu c={a.gpu_cpu} />}
        <Kesimpulan a={a} />
      </div>
    </div>
  );
}
