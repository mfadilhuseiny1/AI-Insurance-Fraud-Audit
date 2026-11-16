"use client";

// ML Studio · "Metrik AI Agent Swarm" (the user, 2026-11-15: "saya penasaran precision sama recall hasil audit AI Agent Swarm
// Branch ... precision & recall sistem (rule engine + ml7) [dan] keseluruhan (rule engine + ml7 + AIoT verification + AI Agent
// Swarm)", then "bikin reportnya di ML studio bikin tab baru metrik2 nya kayak di Laporan v7 metrik juri ... bandingkan apakah
// multi agent swarm bisa nurunin false positive?"). Every system of one finished branch run on the SAME claims and planted labels;
// 95% CIs and paired differences from resampling hospitals; a plain-language paragraph under every chart for executives, English
// ML terms kept where Indonesian does not fit. No vendor names on screen.
// Data: testing/swarm_cabang_metrik.py -> /api/swarm-cabang-metrik (aggregates only; no model call, thresholds unchanged). Synthetic.

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AXIS, GRID, SERIES, SURFACE, Tooltip, useTip } from "./viz";
import { BarisH, Garis, Kartu, Legenda, Matriks, METRIK, Penjelas, Tabel, Ubin, ciD, ciP, ciPP, dec, fmt, ok, pct, pp, pv, rp, tukar, type CI, type CM } from "./LaporanV7Juri";

// ------------------------------------------------------------------------------------------------ data shape
type Sis = CM & { nama: string; ket: string; rs_jujur_diperiksa: number; rs_terbebani: number;
  rp: { fraud_ditemukan: number; fraud_lolos: number; jujur_diperiksa: number; total_fraud: number } };
type Uji = { selisih: number; ci: CI; p: number };
type Banding = { fp: Uji; tp: Uji; presisi: Uji; recall: Uji; f1: Uji; fpr: Uji; fp_turun_persen: number };
type Rp = { tp: number; fp: number; presisi: number; recall: number };
type Iot = { klaim_dengan_alat: number; fraud_tanam: number; terdeteksi: number; jujur: number; jujur_ditandai: number; terlewat: number; tn: number;
  presisi: number; recall: number; tidak_sesuai_di_antrean_akhir: number; tidak_sesuai_sudah_ditandai_tanpa_iot: number; aturan: Record<string, number>;
  label_gabungan: { fraud: number; swarm: { tp: number; fp: number; fn: number; presisi: number; recall: number; f1: number }; ml_rule: { tp: number; fp: number; fn: number; presisi: number; recall: number; f1: number } } };
type Run = {
  dibuat: string; set: string; label: string; kc: string; kc_nama: string; tema: string[]; replika: number[]; klaim: number; fraud: number; prevalensi: number;
  rs: number; rs_jujur: number; bootstrap: number; model: string; ambang: { periksa: number; tahan: number; tau: number };
  sistem: Record<string, Sis>; banding: Record<string, Banding>;
  ragu: { klaim: number; fraud: number; jujur: number; dibaca: number; periksa_fraud: number; periksa_jujur: number; bersih_fraud: number; bersih_jujur: number;
    belum_dibaca: number; tau: number; auroc: { model: { nilai: number; ci: CI }; gerbang: { nilai: number; ci: CI }; hakim: { nilai: number; ci: CI }; selisih_gerbang_model: Uji } };
  kurva: { model_dari_ragu: [number, number][]; ml_v7_global: [number, number][] };
  fp_sumber: { tahan: number; periksa_ml: number; periksa_aturan: number }; tp_sumber: { tahan: number; periksa_ml: number; periksa_aturan: number };
  jalur_aturan: { periksa: number; fraud: number; jujur: number; dari_lolos_periksa: number; dari_lolos_periksa_fraud: number; dari_lolos_dibersihkan: number };
  hilang: { tidak_pernah_curiga: number; dibersihkan_swarm: number };
  skema: { skema: string; fraud: number; tertangkap: number; dibersihkan_swarm: number; tidak_pernah_curiga: number; tertangkap_tanpa_swarm: number }[];
  per_replika: ({ replika: number; klaim: number; fraud: number } & Record<"ml_rule" | "zona" | "model_sama" | "swarm", Rp>)[];
  iot: Iot | null; biaya: { usd: number; panggilan: number; klaim_dibaca: number }; catatan: string[];
};
type Data = { runs: Record<string, Run>; terbaru: string };
type TipT = { title: string; lines: { key?: string; value: string; label: string }[] };

// ------------------------------------------------------------------------------------------------ vocabulary
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
// one colour per system, the same everywhere on the page (dataviz validator on #1c2127: all checks pass)
const W = { model_sama: SERIES[0], ml_rule: SERIES[1], swarm: SERIES[2], zona: SERIES[3], ml_rule_iot: SERIES[4] } as const;
// a claim's fate inside one system (queued / cleared, which lane) is a state, not a system: neutral steps, so no system colour is reused
const N = ["#d3d8de", "#8f99a8", "#56606d"] as const;
const URUT = ["ml_v7", "ml_rule", "ml_rule_rme", "ml_rule_iot", "zona", "tahan", "model_sama", "swarm"];
const PILIH: [string, string][] = [["ml_rule", "ML v7 + rule engine"], ["ml_rule_iot", "+ rekam medis + IoT (tanpa swarm)"], ["swarm", "Keseluruhan (+ AI Agent Swarm)"],
  ["model_sama", "Model, antrean sama"], ["zona", "Semua zona curiga"], ["ml_v7", "ML v7 saja"]];
const PEMBANDING: [string, string][] = [["zona", "Semua zona curiga, tanpa swarm"], ["ml_rule_iot", "ML v7 + rule engine + rekam medis + IoT"], ["ml_rule", "ML v7 + rule engine"],
  ["ml_v7", "ML v7 saja"], ["model_sama", "Uji adil: model memilih, antrean sama"]];
const nyata = (c?: CI) => !!c && ok(c[0]) && ok(c[1]) && (c[0] > 0 || c[1] < 0);
const ciN = (c?: CI) => (c && ok(c[0]) && ok(c[1]) ? `${fmt(Math.round(c[0]))} s/d ${fmt(Math.round(c[1]))}` : "—");
const tanda = (v: number) => `${v > 0 ? "+" : ""}${fmt(v)}`;
const prev2 = (x: { recall: number; fpr: number }, pi = 0.02) => (x.recall * pi) / Math.max(1e-12, x.recall * pi + x.fpr * (1 - pi));
const nmSkema = (s: string) => s.replace(/_/g, " ");
/** recall of a curve at a given number of honest claims queued (linear between the curve's points) */
const recallPada = (pts: [number, number][], fp: number) => {
  if (!pts.length) return NaN;
  if (fp <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (fp <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return x1 === x0 ? y1 : y0 + ((y1 - y0) * (fp - x0)) / (x1 - x0); }
  return pts[pts.length - 1][1];
};

// ------------------------------------------------------------------------------------------------ charts this page adds
/** Forest plot: a paired difference per row (dot) with its 95% CI (whisker) around a dashed zero line. One series. */
function Hutan({ rows, warna, kiri, kanan }: { rows: { key: string; label: string; sub?: string; v: number; ci: CI; teks: string; tip: TipT }[]; warna: string; kiri: string; kanan: string }) {
  const { box: ref, tip, at, clear } = useTip();
  const lo = Math.min(0, ...rows.map((r) => (ok(r.ci[0]) ? r.ci[0] : r.v))), hi = Math.max(0, ...rows.map((r) => (ok(r.ci[1]) ? r.ci[1] : r.v)));
  const pad = (hi - lo) * 0.06 || 1, a = lo - pad, b = hi + pad;
  const x = (v: number) => `${((v - a) / (b - a)) * 100}%`;
  return (
    <div ref={ref} className="relative space-y-1.5" onPointerLeave={clear}>
      {rows.map((r) => (
        <div key={r.key} tabIndex={0} onPointerMove={(e) => at(e, r.tip)} onFocus={(e) => at(e, r.tip)}
          className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_5.5rem] items-center gap-2 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_7rem]">
          <div className="min-w-0">
            <p className="truncate text-[11.5px] text-[#d3d8de]" title={r.label}>{r.label}</p>
            {r.sub && <p className="truncate text-[10px] text-[#8f99a8]">{r.sub}</p>}
          </div>
          <div className="relative h-6">
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2" style={{ background: GRID }} />
            <span className="absolute inset-y-0 border-l-[1.5px] border-dashed" style={{ left: x(0), borderColor: "#c5cbd3" }} />
            {ok(r.ci[0]) && ok(r.ci[1]) && (
              <div className="absolute top-1/2 h-[1.5px] -translate-y-1/2 bg-[#e5e8eb]/80" style={{ left: x(r.ci[0]), width: `calc(${x(r.ci[1])} - ${x(r.ci[0])})` }}>
                <span className="absolute -left-px -top-[3px] h-[7px] w-[1.5px] bg-[#e5e8eb]/80" /><span className="absolute -right-px -top-[3px] h-[7px] w-[1.5px] bg-[#e5e8eb]/80" />
              </div>
            )}
            <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(r.v), background: warna, boxShadow: `0 0 0 2px ${SURFACE}` }} />
          </div>
          <span className="text-right text-[11.5px] tabular-nums text-[#e5e8eb]">{r.teks}</span>
        </div>
      ))}
      {/* the axis caption under the track column on wide screens, full width on a phone */}
      <div className="flex justify-between gap-3 text-[10.5px] text-[#8f99a8] sm:ml-[16.5rem] sm:mr-[7.5rem]"><span>← {kiri}</span><span className="text-right">{kanan} →</span></div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Horizontal stacked bars (shares of one whole per row), 2px surface gaps, 4px rounded ends, values in the right column. */
function Tumpuk({ rows, seg }: { rows: { key: string; label: string; sub?: string; nilai: number[] }[]; seg: { nama: string; warna: string }[] }) {
  const { box: ref, tip, at, clear } = useTip();
  return (
    <div ref={ref} className="relative space-y-2" onPointerLeave={clear}>
      <Legenda items={seg.map((s) => ({ nama: s.nama, warna: s.warna, jenis: "kotak" as const }))} />
      {rows.map((r) => {
        const tot = r.nilai.reduce((x, y) => x + y, 0) || 1;
        return (
          <div key={r.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7.5rem] items-center gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_10rem]">
            <div className="min-w-0"><p className="truncate text-[11.5px] text-[#d3d8de]">{r.label}</p>{r.sub && <p className="truncate text-[10px] text-[#8f99a8]">{r.sub}</p>}</div>
            <div className="flex h-5 gap-[2px]">
              {r.nilai.map((v, i) => v > 0 && (
                <div key={i} tabIndex={0} className="h-full first:rounded-l-[4px] last:rounded-r-[4px]" style={{ flexGrow: v, flexBasis: 0, background: seg[i].warna }}
                  onPointerMove={(e) => at(e, { title: r.label, lines: [{ key: seg[i].warna, value: `${fmt(v)} (${pct(v / tot)})`, label: seg[i].nama }] })}
                  onFocus={(e) => at(e, { title: r.label, lines: [{ key: seg[i].warna, value: `${fmt(v)} (${pct(v / tot)})`, label: seg[i].nama }] })} />
              ))}
            </div>
            <span className="text-right text-[11.5px] tabular-nums text-[#e5e8eb]">{r.nilai.map((v) => fmt(v)).join(" · ")}</span>
          </div>
        );
      })}
      <Tooltip tip={tip} />
    </div>
  );
}

function Kolom({ judul, sub, x, warna, sorot = false }: { judul: string; sub: string; x: Sis; warna: string; sorot?: boolean }) {
  const baris: [string, string, string][] = [["Precision", pct(x.presisi), `95% CI ${ciP(x.ci.presisi)}`], ["Recall", pct(x.recall), `95% CI ${ciP(x.ci.recall)}`],
    ["F1 score", dec(x.f1, 3), `95% CI ${ciD(x.ci.f1)}`], ["False positive", fmt(x.fp), `dari ${fmt(x.fp + x.tn)} klaim jujur`], ["Antrean periksa", fmt(x.ditandai), `${fmt(x.tp)} fraud benar`]];
  return (
    <div className={`rounded-md border p-3 ${sorot ? "border-[#7ee2c0]/40 bg-[#7ee2c0]/[.05]" : "border-white/[.08] bg-[#151a1f]"}`}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white"><span className="h-2.5 w-2.5 rounded-full" style={{ background: warna }} />{judul}</p>
      <p className="mb-2 text-[10.5px] leading-snug text-[#8f99a8]">{sub}</p>
      <dl className="space-y-1.5">
        {baris.map(([k, v, c]) => (
          <div key={k} className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-[#abb3bf]">{k}</dt>
            <dd className="text-right"><span className="text-[16px] font-semibold tabular-nums text-white">{v}</span><span className="block text-[10px] tabular-nums text-[#8f99a8]">{c}</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the report
export function LaporanSwarmCabang() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [runId, setRunId] = useState("");
  const [sys, setSys] = useState("swarm");
  useEffect(() => {
    fetch("/api/swarm-cabang-metrik", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); setD(j as Data); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <p className="p-4 text-[12px] text-red-300">{err}</p>;
  const r = d ? d.runs[runId] ?? d.runs[d.terbaru] ?? Object.values(d.runs)[0] : null;
  if (!d || !r) return <p className="p-4 text-[12px] text-[#8f99a8]">Memuat metrik AI Agent Swarm…</p>;

  const S = r.sistem, B = r.banding, sw = S.swarm, mr = S.ml_rule, mi = S.ml_rule_iot, rme = S.ml_rule_rme, zn = S.zona, ms = S.model_sama;
  const c = S[sys] ?? sw;
  const nmSys = c.nama;
  const bi = B.ml_rule_iot, bm = B.ml_rule, bz = B.zona, ba = B.model_sama;
  const au = r.ragu.auroc;
  const jujurTotal = sw.fp + sw.tn;
  const fpMax = Math.max(...URUT.map((k) => S[k].ci.fpr?.[1] ?? 0).map((v) => (v ?? 0) * jujurTotal), zn.fp) * 1.05;
  const rModel = recallPada(r.kurva.model_dari_ragu, sw.fp);
  const xMax = Math.ceil(Math.max(zn.fp, ...r.kurva.ml_v7_global.map((p) => p[0])) / 250) * 250;
  const sisaTahan = r.fp_sumber.tahan / Math.max(1, sw.fp);
  const swLebihBaik = r.per_replika.filter((x) => x.swarm.fp < x.ml_rule.fp).length;
  const swVsModel = r.per_replika.filter((x) => x.swarm.fp < x.model_sama.fp).length;
  const skemaRugi = r.skema.filter((x) => x.tertangkap_tanpa_swarm - x.tertangkap >= 3).sort((x, y) => (y.tertangkap_tanpa_swarm - y.tertangkap) - (x.tertangkap_tanpa_swarm - x.tertangkap));
  const usdKlaim = r.biaya.usd / Math.max(1, r.biaya.klaim_dibaca);
  const ul = r.replika.length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4">
      {/* ---------------------------------------------------------------- header */}
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: `${SERIES[2]}33` }}><Icon name="constellation" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">AI Agent Swarm Branch · metrik · dibuat {r.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Apakah AI Agent Swarm menurunkan false positive?</h2>
          <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">{r.label}. Precision, recall, F1 score dan confusion matrix setiap lapisan sistem (ML v7, rule engine, rekam medis, IoT, AI Agent Swarm) pada klaim dan label yang sama, plus uji adil dan selisih berpasangan.</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
          <span className="rounded bg-white/[.06] px-2 py-1 text-[11px] text-[#d3d8de]">model beku · ambang tidak diubah</span>
          <span className="rounded bg-white/[.06] px-2 py-1 text-[11px] text-[#d3d8de]">95% CI: ambil ulang per rumah sakit ({fmt(r.bootstrap)}×)</span>
        </div>
      </section>

      <section className={`${box} flex flex-wrap items-center gap-2 p-3 text-[11.5px] text-[#abb3bf]`}>
        {Object.keys(d.runs).length > 1 && (
          <select value={r.set} onChange={(e) => setRunId(e.target.value)} className="rounded border border-white/15 bg-[#111418] px-2 py-1 text-[11.5px] text-[#e5e8eb]">
            {Object.values(d.runs).map((x) => <option key={x.set} value={x.set}>{x.label}</option>)}
          </select>
        )}
        <span>{r.kc_nama} · {fmt(r.klaim)} klaim dari {fmt(r.rs)} rumah sakit · {ul} ulangan setahun (dunia sintetis {r.replika.join(", ")}) · <b className="text-white">{fmt(r.fraud)} fraud tertanam ({pct(r.prevalensi, 2)})</b> · {fmt(r.rs_jujur)} RS tanpa fraud · model {r.model}</span>
      </section>

      {/* ---------------------------------------------------------------- executive summary + the answer */}
      <section className={`${box} grid gap-4 p-4 xl:grid-cols-[1.15fr_1.6fr]`}>
        <Penjelas judul="Ringkasan untuk eksekutif">
          <p>Di wilayah {r.kc_nama} ada {fmt(r.klaim)} klaim jantung selama {ul} tahun simulasi; {fmt(r.fraud)} di antaranya fraud yang sengaja ditanam ({pct(r.prevalensi, 1)}).</p>
          <p><b className="text-white">Tanpa swarm</b>, ML v7 + rule engine menandai {fmt(mr.ditandai)} klaim: precision {pct(mr.presisi)} dan recall {pct(mr.recall)}. Bila rule rekam medis dan IoT ikut menandai sendiri, recall naik ke {pct(mi.recall)}, tetapi {fmt(mi.fp)} klaim jujur ikut diperiksa.</p>
          <p><b className="text-white">Dengan AI Agent Swarm</b>, antrean tinggal {fmt(sw.ditandai)} klaim: precision <b className="text-white">{pct(sw.presisi)}</b>, recall <b className="text-white">{pct(sw.recall)}</b>, F1 score {dec(sw.f1, 3)}. Klaim jujur yang ikut diperiksa turun dari {fmt(mi.fp)} menjadi <b className="text-white">{fmt(sw.fp)}</b> ({pct(bi.fp_turun_persen, 0)} lebih sedikit){nyata(bi.fp.ci) ? ", dan penurunan ini nyata secara statistik" : ""}. Harganya: recall turun {fmt(Math.abs(bi.recall.selisih) * 100, 1)} poin.</p>
          <p><b className="text-white">Catatan jujur:</b> bila ML v7 sendiri diberi antrean yang sama besar ({fmt(ms.ditandai)} klaim), ia ikut memeriksa {fmt(ms.fp)} klaim jujur, hanya {fmt(Math.abs(ba.fp.selisih))} lebih banyak daripada swarm, dan selisih itu {nyata(ba.fp.ci) ? "nyata" : "belum nyata secara statistik"}. Keunggulan swarm yang terukur nyata ada di dalam zona ragu: ia memilah fraud dari klaim jujur lebih baik daripada skor model (ROC-AUC {dec(au.gerbang.nilai, 3)} vs {dec(au.model.nilai, 3)}), dan setiap keputusannya disertai alasan tertulis.</p>
        </Penjelas>
        <div className="space-y-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">Precision &amp; recall per lapisan sistem</p>
          <div className="grid gap-2 md:grid-cols-3">
            <Kolom judul="ML v7 + rule engine" sub="Sistem tanpa swarm: skor ML v7 di atas ambang ATAU kena rule engine" x={mr} warna={W.ml_rule} />
            <Kolom judul="+ rekam medis + IoT" sub="Masih tanpa swarm: rule rekam medis dan ketidaksesuaian IoT ikut menandai sendiri" x={mi} warna={W.ml_rule_iot} />
            <Kolom judul="Keseluruhan" sub="ML v7 + rule engine + rekam medis + verifikasi AIoT + AI Agent Swarm" x={sw} warna={W.swarm} sorot />
          </div>
          <p className="text-[10.5px] text-[#8f99a8]">Rule rekam medis saja di atas ML v7 + rule engine: precision {pct(rme.presisi)}, recall {pct(rme.recall)}. Semua angka pada {fmt(r.klaim)} klaim yang sama; 95% CI dari pengambilan ulang {fmt(r.rs)} rumah sakit.</p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 1. confusion matrix */}
      <Kartu ikon="grid" judul="1 · Confusion matrix dan metrik ML" sub="Pilih lapisan sistem untuk membandingkan. Ambang setiap sistem dibekukan sebelum audit; 95% CI dari pengambilan ulang rumah sakit."
        penjelas={<>
          <p>Setiap klaim jatuh ke salah satu dari empat kotak. Kotak hijau adalah keputusan yang benar: fraud yang tertangkap (<b className="text-white">true positive</b>) dan klaim jujur yang dibiarkan lewat (<b className="text-white">true negative</b>). Kotak kuning adalah kekeliruan: fraud yang lolos (<b className="text-white">false negative</b>), artinya uang hilang, dan klaim jujur yang ikut ditandai (<b className="text-white">false positive</b>), artinya beban verifikator dan gangguan bagi RS yang jujur.</p>
          <p>Untuk {nmSys}: {tukar(c.tp, c.fp)}. Bandingkan dengan ML v7 + rule engine tanpa swarm: {tukar(mr.tp, mr.fp)}. Pada sistem keseluruhan, {tukar(sw.tp, sw.fp)}.</p>
          <p><b className="text-white">Kenapa accuracy {pct(c.akurasi)} tidak berarti banyak:</b> hanya {pct(r.prevalensi, 1)} klaim yang fraud, jadi sistem yang menyatakan &ldquo;semua klaim jujur&rdquo; pun mendapat accuracy {pct(1 - r.prevalensi)} tanpa menangkap satu fraud pun.</p>
        </>}>
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Pilih sistem">
          {PILIH.map(([k, nm]) => (
            <button key={k} type="button" onClick={() => setSys(k)} className={`rounded px-2 py-1 text-[11.5px] ${sys === k ? "bg-white/10 font-semibold text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{nm}</button>
          ))}
        </div>
        <p className="mb-3 text-[11.5px] text-[#abb3bf]">{c.ket}</p>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <Matriks c={c} nama={nmSys} />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {METRIK.map((m) => (
              <Ubin key={m.k} label={m.label} utama={m.utama} ket={m.ket} nilai={m.persen ? pct(c[m.k] as number, m.k === "fpr" || m.k === "akurasi" || m.k === "spesifisitas" ? 2 : 1) : dec(c[m.k] as number, 3)}
                ci={m.persen ? ciP(c.ci[m.k], m.k === "fpr" ? 2 : 1) : ciD(c.ci[m.k])} />
            ))}
          </div>
        </div>
        <p className="mt-2 text-[10.5px] text-[#8f99a8]">Metrik lain {nmSys}: F2 score {dec(c.f2)} · F0.5 score {dec(c.f05)} · NPV {pct(c.npv, 2)} · false negative rate {pct(c.fnr)} · Cohen&apos;s kappa {dec(c.kappa)} · RS tanpa fraud yang ikut diperiksa {fmt(c.rs_jujur_diperiksa)} dari {fmt(r.rs_jujur)}.</p>
      </Kartu>

      {/* ---------------------------------------------------------------- 2. every system */}
      <Kartu ikon="table" judul="2 · Semua lapisan sistem pada klaim yang sama" sub={`${fmt(r.klaim)} klaim · ${fmt(r.fraud)} fraud (${pct(r.prevalensi, 2)}) · baris hijau = sistem keseluruhan`}
        penjelas={<>
          <p>Baris dibaca dari atas ke bawah seperti lapisan yang ditumpuk. ML v7 saja menangkap {pct(S.ml_v7.recall)} fraud. Menambah rule engine dan rule rekam medis menaikkan recall ke {pct(rme.recall)}, karena aturan melihat hal yang tidak dilihat model (isi rekam medis), tetapi klaim jujur yang ikut diperiksa juga bertambah. Bila semua klaim yang dicurigai penyaringan dibaca manusia tanpa swarm, recall {pct(zn.recall)} tetapi verifikator harus membuka {fmt(zn.ditandai)} klaim, {fmt(zn.fp)} di antaranya jujur.</p>
          <p>Sistem keseluruhan mempertahankan sebagian besar fraud itu ({pct(sw.recall)}) dengan antrean {fmt(sw.ditandai)} klaim. F1 score-nya ({dec(sw.f1, 3)}) tertinggi di tabel ini: keseimbangan precision dan recall paling baik.</p>
          <p><b className="text-white">Precision bergantung pada tingkat fraud.</b> Di sini {pct(r.prevalensi, 1)} klaim fraud. Bila tingkat fraud nyata hanya 2%, dengan recall dan false positive rate yang sama precision sistem keseluruhan menjadi sekitar {pct(prev2(sw))} dan ML v7 + rule engine sekitar {pct(prev2(mr))}.</p>
        </>}>
        <Tabel kepala={["Sistem", "Antrean", "TP", "FP", "FN", "TN", "Precision", "Recall", "F1 score", "MCC", "FPR", "Precision bila fraud 2%", "RS tanpa fraud ikut diperiksa"]} sorot={URUT.indexOf("swarm")}
          baris={URUT.map((k) => { const x = S[k]; return [x.nama, fmt(x.ditandai), fmt(x.tp), fmt(x.fp), fmt(x.fn), fmt(x.tn), pct(x.presisi), pct(x.recall), dec(x.f1), dec(x.mcc), pct(x.fpr, 2), pct(prev2(x)), `${fmt(x.rs_jujur_diperiksa)} / ${fmt(r.rs_jujur)}`]; })} />
        <ul className="grid gap-1 text-[10.5px] text-[#8f99a8] md:grid-cols-2">{URUT.map((k) => <li key={k}><b className="text-[#abb3bf]">{S[k].nama}:</b> {S[k].ket}</li>)}</ul>
      </Kartu>

      {/* ---------------------------------------------------------------- 3. FP per system */}
      <Kartu ikon="alert" judul="3 · Berapa klaim jujur ikut diperiksa (false positive)" sub={`Batang = jumlah false positive dengan 95% CI · dari ${fmt(jujurTotal)} klaim jujur`}
        tabel={<Tabel kepala={["Sistem", "False positive", "95% CI", "False positive rate", "Nilai klaim jujur diperiksa"]}
          baris={URUT.map((k) => { const x = S[k]; return [x.nama, fmt(x.fp), ciN([x.ci.fpr[0] !== null ? x.ci.fpr[0] * jujurTotal : null, x.ci.fpr[1] !== null ? x.ci.fpr[1] * jujurTotal : null]), pct(x.fpr, 2), rp(x.rp.jujur_diperiksa)]; })} />}
        penjelas={<>
          <p>Setiap false positive adalah satu klaim dari RS yang jujur yang harus dibuka verifikator: biaya kerja dan gangguan bagi RS. Tanpa swarm, sistem paling ketat (ML v7 + rule engine) masih menandai {fmt(mr.fp)} klaim jujur, senilai {rp(mr.rp.jujur_diperiksa)}. Sistem keseluruhan menandai {fmt(sw.fp)}, senilai {rp(sw.rp.jujur_diperiksa)}.</p>
          <p>Garis putih tipis di tiap batang adalah 95% CI: rentang yang masih wajar bila rumah sakitnya berbeda. Rentang yang tidak saling tumpang tindih menandakan perbedaan yang tidak mungkin kebetulan.</p>
        </>}>
        <BarisH warna={W.swarm} max={fpMax} rows={URUT.map((k) => {
          const x = S[k], lo = x.ci.fpr[0], hi = x.ci.fpr[1];
          return { key: k, label: x.nama, sub: `antrean ${fmt(x.ditandai)} · recall ${pct(x.recall)}`, v: x.fp, ci: [lo !== null ? lo * jujurTotal : null, hi !== null ? hi * jujurTotal : null] as CI, teks: fmt(x.fp),
            tip: { title: x.nama, lines: [{ key: W.swarm, value: fmt(x.fp), label: `false positive (FPR ${pct(x.fpr, 2)})` }, { value: pct(x.recall), label: "recall" }, { value: rp(x.rp.jujur_diperiksa), label: "nilai klaim jujur diperiksa" }] } };
        })} />
      </Kartu>

      {/* ---------------------------------------------------------------- 4. paired differences */}
      <Kartu ikon="logic" judul="4 · Selisih false positive: swarm dikurangi pembanding" sub="Titik = selisih jumlah klaim jujur di antrean (negatif = swarm lebih sedikit) · garis = 95% CI berpasangan · garis putus = tidak ada beda"
        tabel={<Tabel kepala={["Swarm dibanding", "Selisih FP", "95% CI", "p", "Selisih fraud tertangkap", "95% CI", "Selisih precision", "95% CI", "Selisih recall", "95% CI"]}
          baris={PEMBANDING.map(([k, nm]) => { const b = B[k]; return [nm, tanda(b.fp.selisih), ciN(b.fp.ci), pv(b.fp.p), tanda(b.tp.selisih), ciN(b.tp.ci), pp(b.presisi.selisih), ciPP(b.presisi.ci), pp(b.recall.selisih), ciPP(b.recall.ci)]; })} />}
        penjelas={<>
          <p>Grafik ini menjawab pertanyaan utama. Setiap baris membandingkan sistem keseluruhan dengan satu sistem tanpa swarm pada klaim yang sama dan sampel ulang rumah sakit yang sama (uji berpasangan). Bila garis CI seluruhnya di kiri garis putus-putus, swarm <b className="text-white">nyata</b> memeriksa lebih sedikit klaim jujur.</p>
          <p>Dibanding semua zona curiga, swarm membuang {fmt(Math.abs(bz.fp.selisih))} klaim jujur dari antrean ({pct(bz.fp_turun_persen, 0)}). Dibanding ML v7 + rule engine + rekam medis + IoT, {fmt(Math.abs(bi.fp.selisih))} lebih sedikit ({pct(bi.fp_turun_persen, 0)}, 95% CI {ciN(bi.fp.ci)}, {pv(bi.fp.p)}), dengan recall {pp(bi.recall.selisih)} ({nyata(bi.recall.ci) ? "penurunan recall ini nyata" : "penurunan recall belum nyata"}). Dibanding ML v7 + rule engine, {fmt(Math.abs(bm.fp.selisih))} lebih sedikit, recall {pp(bm.recall.selisih)} ({nyata(bm.recall.ci) ? "nyata" : "belum nyata"}).</p>
          <p><b className="text-white">Uji adil</b> (baris terakhir): ML v7 diberi antrean sama besar dan memilih sendiri klaim ragu berskor tertinggi. Selisihnya {tanda(ba.fp.selisih)} klaim jujur (95% CI {ciN(ba.fp.ci)}) dan {tanda(ba.tp.selisih)} fraud tertangkap (95% CI {ciN(ba.tp.ci)}). Arahnya menguntungkan swarm, tetapi {nyata(ba.fp.ci) || nyata(ba.tp.ci) ? "sebagian sudah nyata" : "belum nyata secara statistik pada audit sebesar ini"}. Jadi sebagian besar penurunan false positive datang dari <i>memangkas</i> antrean; swarm memangkasnya sedikit lebih tepat daripada skor model, dan dengan alasan tertulis untuk setiap klaim.</p>
        </>}>
        <Hutan warna={W.swarm} kiri="swarm memeriksa lebih sedikit klaim jujur" kanan="lebih banyak" rows={PEMBANDING.map(([k, nm]) => {
          const b = B[k];
          return { key: k, label: nm, sub: `${fmt(S[k].fp)} → ${fmt(sw.fp)} klaim jujur`, v: b.fp.selisih, ci: b.fp.ci, teks: `${tanda(b.fp.selisih)} (${pct(-b.fp_turun_persen, 0)})`,
            tip: { title: `Swarm vs ${nm}`, lines: [{ key: W.swarm, value: tanda(b.fp.selisih), label: `selisih false positive (CI ${ciN(b.fp.ci)}, ${pv(b.fp.p)})` },
              { value: tanda(b.tp.selisih), label: `selisih fraud tertangkap (CI ${ciN(b.tp.ci)})` }, { value: pp(b.recall.selisih), label: "selisih recall" }, { value: pp(b.presisi.selisih), label: "selisih precision" }] } };
        })} />
      </Kartu>

      {/* ---------------------------------------------------------------- 5. trade-off curve */}
      <Kartu ikon="graph" judul="5 · Trade-off: fraud tertangkap terhadap klaim jujur yang ikut diperiksa" sub="Garis = model menggeser ambangnya sendiri · titik = sistem pada ambang operasinya"
        tabel={<Tabel kepala={["Klaim jujur diperiksa", "Recall: model memilih dari zona ragu", "Recall: ML v7 saja, ambang digeser"]}
          baris={[100, 200, sw.fp, 300, 400, 600, 800, 1000].sort((a, b) => a - b).map((f) => [fmt(f), pct(recallPada(r.kurva.model_dari_ragu, f)), pct(recallPada(r.kurva.ml_v7_global, f))])} />}
        penjelas={<>
          <p>Sumbu datar adalah jumlah klaim jujur yang ikut diperiksa, sumbu tegak adalah persen fraud yang tertangkap. Makin ke kiri atas, makin baik. Garis biru adalah apa yang bisa dicapai <b className="text-white">tanpa swarm</b>: zona TAHAN, lalu klaim ragu ditambahkan satu per satu menurut skor ML v7. Garis abu-abu putus-putus adalah ML v7 saja dengan ambang digeser.</p>
          <p>Titik hijau (swarm) berada {sw.recall > rModel ? "di atas" : "di bawah"} garis biru. Pada {fmt(sw.fp)} klaim jujur, model sendiri menangkap sekitar {pct(rModel)} fraud; swarm menangkap {pct(sw.recall)}. Titik oranye dan merah muda (tanpa swarm) menangkap lebih banyak fraud, tetapi dengan klaim jujur hampir dua kali lipat; titik kuning (semua zona curiga) menunjukkan beban bila semua klaim ragu dibaca manusia.</p>
        </>}>
        <Garis xd={[0, xMax]} xt={Array.from({ length: xMax / 250 + 1 }, (_, i) => i * 250)} fx={(v) => fmt(Math.round(v))} fy={(v) => pct(v, 0)}
          xl="Klaim jujur ikut diperiksa (false positive)" yl="Fraud tertangkap (recall)"
          seri={[{ key: "ragu", nama: "Tanpa swarm: model memilih dari zona ragu", warna: W.model_sama, pts: r.kurva.model_dari_ragu },
            { key: "global", nama: "ML v7 saja, ambang digeser", warna: AXIS, putus: true, pts: r.kurva.ml_v7_global }]}
          titik={([["ml_rule", W.ml_rule], ["ml_rule_iot", W.ml_rule_iot], ["zona", W.zona], ["swarm", W.swarm]] as [string, string][]).map(([k, w]) => ({
            nama: S[k].nama, warna: w, x: S[k].fp, y: S[k].recall, info: `recall ${pct(S[k].recall)} · ${fmt(S[k].fp)} klaim jujur · precision ${pct(S[k].presisi)}` }))} />
      </Kartu>

      {/* ---------------------------------------------------------------- 6. inside the uncertain zone */}
      <Kartu ikon="layers" judul={`6 · Di dalam zona ragu: apa yang dilakukan swarm pada ${fmt(r.ragu.klaim)} klaim`} sub={`Gerbang swarm τ = ${dec(r.ragu.tau, 2)} · ${fmt(r.ragu.dibaca)} klaim dibaca, ${fmt(r.ragu.belum_dibaca)} belum dibaca`}
        penjelas={<>
          <p>Zona ragu berisi klaim yang tidak cukup jelas untuk langsung ditahan maupun diloloskan. Tanpa swarm, semua {fmt(r.ragu.klaim)} klaim ini harus dibaca verifikator. Agen AI membaca masing-masing: dari {fmt(r.ragu.jujur)} klaim jujur, <b className="text-white">{fmt(r.ragu.bersih_jujur)} dibersihkan</b> ({pct(r.ragu.bersih_jujur / Math.max(1, r.ragu.jujur))}); dari {fmt(r.ragu.fraud)} fraud, {fmt(r.ragu.periksa_fraud)} tetap dikirim ke antrean ({pct(r.ragu.periksa_fraud / Math.max(1, r.ragu.fraud))}) dan {fmt(r.ragu.bersih_fraud)} ikut dibersihkan.</p>
          <p><b className="text-white">ROC-AUC</b> mengukur seberapa baik sebuah skor menaruh fraud di atas klaim jujur (0,5 = tebakan acak, 1 = sempurna). Di zona ini skor ML v7 mencapai {dec(au.model.nilai, 3)}, skor gerbang swarm {dec(au.gerbang.nilai, 3)}. Selisih {au.selisih_gerbang_model.selisih > 0 ? "+" : ""}{dec(au.selisih_gerbang_model.selisih, 3)} (95% CI {ciD(au.selisih_gerbang_model.ci)}, {pv(au.selisih_gerbang_model.p)}) {nyata(au.selisih_gerbang_model.ci) ? "nyata: swarm memang memilah klaim ragu lebih baik daripada model" : "belum nyata"}.</p>
        </>}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Tumpuk seg={[{ nama: "Dikirim ke antrean periksa", warna: N[0] }, { nama: "Dibersihkan swarm", warna: N[2] }]}
            rows={[{ key: "f", label: "Klaim fraud", sub: `${fmt(r.ragu.fraud)} klaim`, nilai: [r.ragu.periksa_fraud, r.ragu.bersih_fraud] },
              { key: "j", label: "Klaim jujur", sub: `${fmt(r.ragu.jujur)} klaim`, nilai: [r.ragu.periksa_jujur, r.ragu.bersih_jujur] }]} />
          <div className="grid grid-cols-2 gap-2">
            <Ubin label="ROC-AUC skor ML v7" nilai={dec(au.model.nilai, 3)} ci={ciD(au.model.ci)} ket="Urutan klaim ragu menurut skor model saja." />
            <Ubin label="ROC-AUC gerbang swarm" utama nilai={dec(au.gerbang.nilai, 3)} ci={ciD(au.gerbang.ci)} ket="Penilaian hakim swarm digabung skor model (rumus gerbang)." />
            <Ubin label="ROC-AUC hakim saja" nilai={dec(au.hakim.nilai, 3)} ci={ciD(au.hakim.ci)} ket="Keyakinan hakim swarm tanpa skor model." />
            <Ubin label="Biaya membaca" nilai={`$${dec(r.biaya.usd, 2)}`} ket={`${fmt(r.biaya.klaim_dibaca)} klaim ragu, ${fmt(r.biaya.panggilan)} panggilan model AI (LLM): sekitar $${dec(usdKlaim, 4)} per klaim.`} />
          </div>
        </div>
      </Kartu>

      {/* ---------------------------------------------------------------- 7. where the remaining FPs come from + 8. lost fraud */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Kartu ikon="filter" judul={`7 · Dari mana ${fmt(sw.fp)} false positive yang tersisa`} sub="Sistem keseluruhan, menurut jalur yang memasukkan klaim ke antrean"
          penjelas={<>
            <p>{fmt(r.fp_sumber.tahan)} klaim jujur ({pct(sisaTahan, 0)}) berasal dari zona TAHAN: skor ML v7 sangat tinggi sehingga langsung ditahan, dan <b className="text-white">swarm tidak pernah membacanya</b>. {fmt(r.fp_sumber.periksa_ml)} lolos gerbang swarm lewat jalur model, dan {fmt(r.fp_sumber.periksa_aturan)} lewat jalur bukti aturan (rekam medis/IoT).</p>
            <p>Artinya ruang terbesar untuk menurunkan false positive lagi ada di zona TAHAN. Memberi swarm kesempatan membaca klaim TAHAN adalah eksperimen berikutnya yang layak diuji; belum diuji di laporan ini.</p>
          </>}>
          <Tumpuk seg={[{ nama: "Zona TAHAN (tidak dibaca swarm)", warna: N[0] }, { nama: "Lolos gerbang · jalur model", warna: N[1] }, { nama: "Lolos gerbang · jalur bukti aturan", warna: N[2] }]}
            rows={[{ key: "fp", label: "Klaim jujur di antrean", sub: "false positive", nilai: [r.fp_sumber.tahan, r.fp_sumber.periksa_ml, r.fp_sumber.periksa_aturan] },
              { key: "tp", label: "Fraud di antrean", sub: "true positive", nilai: [r.tp_sumber.tahan, r.tp_sumber.periksa_ml, r.tp_sumber.periksa_aturan] }]} />
        </Kartu>
        <Kartu ikon="bug" judul={`8 · Fraud yang lolos: ${fmt(sw.fn)} klaim`} sub="Per skema yang ditanam · tanpa swarm = ML v7 + rule engine"
          penjelas={<>
            <p>Fraud bisa lolos di dua tempat: {fmt(r.hilang.tidak_pernah_curiga)} klaim tidak pernah dicurigai model maupun aturan, dan {fmt(r.hilang.dibersihkan_swarm)} dicurigai tetapi dibersihkan swarm. Yang kedua adalah harga dari menurunkan false positive.</p>
            {skemaRugi.length > 0 && <p>Swarm paling sering keliru membersihkan skema {skemaRugi.slice(0, 3).map((x) => `${nmSkema(x.skema)} (${fmt(x.tertangkap_tanpa_swarm)} tertangkap tanpa swarm, ${fmt(x.tertangkap)} dengan swarm)`).join(", ")}. Pada skema ini klaim fraud tampak masuk akal bila dibaca satu per satu; bukti ada pada pola antar-klaim. Ini masukan untuk instruksi agen berikutnya.</p>}
          </>}>
          <Tabel kepala={["Skema", "Fraud", "Tertangkap tanpa swarm", "Tertangkap keseluruhan", "Dibersihkan swarm", "Tidak pernah dicurigai"]}
            baris={r.skema.filter((x) => x.fraud - x.tertangkap > 0).slice(0, 12).map((x) => [nmSkema(x.skema), fmt(x.fraud), fmt(x.tertangkap_tanpa_swarm), fmt(x.tertangkap), fmt(x.dibersihkan_swarm), fmt(x.tidak_pernah_curiga)])} />
        </Kartu>
      </div>

      {/* ---------------------------------------------------------------- 9. per replica */}
      <Kartu ikon="refresh" judul={`9 · Konsisten di ${ul} ulangan?`} sub="Batang = false positive sistem keseluruhan · penanda oranye = ML v7 + rule engine tanpa swarm · uji adil per ulangan di tampilan Tabel"
        tabel={<Tabel kepala={["Ulangan", "Klaim", "Fraud", "FP tanpa swarm", "FP model antrean sama", "FP keseluruhan", "Precision tanpa swarm", "Precision keseluruhan", "Recall tanpa swarm", "Recall keseluruhan"]}
          baris={r.per_replika.map((x) => [`dunia ${x.replika}`, fmt(x.klaim), fmt(x.fraud), fmt(x.ml_rule.fp), fmt(x.model_sama.fp), fmt(x.swarm.fp), pct(x.ml_rule.presisi), pct(x.swarm.presisi), pct(x.ml_rule.recall), pct(x.swarm.recall)])} />}
        penjelas={<>
          <p>Setiap ulangan adalah satu tahun simulasi yang berdiri sendiri. Swarm memeriksa lebih sedikit klaim jujur daripada ML v7 + rule engine di <b className="text-white">{swLebihBaik} dari {ul} ulangan</b>, jadi penurunan false positive bukan kebetulan satu tahun saja. Dibanding uji adil (model dengan antrean sama), swarm lebih baik di {swVsModel} dari {ul} ulangan: sejalan dengan bagian 4, keunggulannya di sana kecil.</p>
        </>}>
        <Legenda items={[{ nama: "False positive keseluruhan (dengan swarm)", warna: W.swarm, jenis: "kotak" }, { nama: "False positive ML v7 + rule engine", warna: W.ml_rule, jenis: "kotak" }]} />
        <div className="mt-2">
          <BarisH warna={W.swarm} tandaWarna={W.ml_rule} max={Math.max(...r.per_replika.map((x) => Math.max(x.ml_rule.fp, x.swarm.fp))) * 1.1} rows={r.per_replika.map((x) => ({
            key: String(x.replika), label: `Dunia ${x.replika}`, sub: `${fmt(x.klaim)} klaim · ${fmt(x.fraud)} fraud`, v: x.swarm.fp, tanda: x.ml_rule.fp, teks: `${fmt(x.ml_rule.fp)} → ${fmt(x.swarm.fp)}`,
            tip: { title: `Dunia ${x.replika}`, lines: [{ key: W.swarm, value: fmt(x.swarm.fp), label: `FP keseluruhan · recall ${pct(x.swarm.recall)}` }, { key: W.ml_rule, value: fmt(x.ml_rule.fp), label: `FP tanpa swarm · recall ${pct(x.ml_rule.recall)}` },
              { key: W.model_sama, value: fmt(x.model_sama.fp), label: `FP model antrean sama · recall ${pct(x.model_sama.recall)}` }] } }))} />
        </div>
      </Kartu>

      {/* ---------------------------------------------------------------- 10. IoT + 11. rule-evidence lane */}
      <div className="grid gap-4 xl:grid-cols-2">
        {r.iot && (
          <Kartu ikon="device" judul="10 · Verifikasi AIoT (pemakaian alat medis)" sub={`${fmt(r.iot.klaim_dengan_alat)} klaim yang menagih pemakaian alat di RS ber-IoT · dinilai dengan kunci jawaban dunia IoT`}
            penjelas={<>
              <p>Sensor arus pada kabel daya alat mencatat kapan alat menyala, berapa lama, dan modenya. Pemeriksa mencocokkannya dengan yang ditagih. Dari {fmt(r.iot.fraud_tanam)} kasus alat yang ditanam (misalnya ventilator menyala lebih singkat dari 96 jam yang ditagih), <b className="text-white">{fmt(r.iot.terdeteksi)} terdeteksi</b> (recall {pct(r.iot.recall, 0)}); {fmt(r.iot.jujur_ditandai)} dari {fmt(r.iot.jujur)} klaim jujur ikut ditandai (precision {pct(r.iot.presisi, 0)}).</p>
              <p>Semua {fmt(r.iot.tidak_sesuai_di_antrean_akhir)} temuan IoT berakhir di antrean periksa. Jumlah kasusnya kecil, jadi angka ini menunjukkan pemeriksa bekerja, bukan seberapa sering ia benar di data nyata. Bila kasus IoT ikut dihitung sebagai fraud, sistem keseluruhan: precision {pct(r.iot.label_gabungan.swarm.presisi)}, recall {pct(r.iot.label_gabungan.swarm.recall)} (dari {fmt(r.iot.label_gabungan.fraud)} fraud).</p>
            </>}>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
              <Matriks c={{ tp: r.iot.terdeteksi, fp: r.iot.jujur_ditandai, fn: r.iot.terlewat, tn: r.iot.tn } as CM} nama="Pemeriksa IoT" />
              <div className="space-y-2">
                <Ubin label="Precision IoT" utama nilai={pct(r.iot.presisi, 0)} ket={`${fmt(r.iot.terdeteksi)} dari ${fmt(r.iot.terdeteksi + r.iot.jujur_ditandai)} temuan benar fraud.`} />
                <Ubin label="Recall IoT" utama nilai={pct(r.iot.recall, 0)} ket={`${fmt(r.iot.terdeteksi)} dari ${fmt(r.iot.fraud_tanam)} kasus alat tertangkap.`} />
                <p className="text-[10.5px] text-[#8f99a8]">Aturan yang menandai: {Object.entries(r.iot.aturan).map(([k, v]) => `${k === "vent_run_96" ? "ventilator < 96 jam" : k === "binding_tumpang" ? "alat terikat dua pasien" : k} (${v})`).join(", ")}.</p>
              </div>
            </div>
          </Kartu>
        )}
        <Kartu ikon="link" judul="11 · Jalur bukti aturan: rekam medis & IoT ke swarm" sub="Temuan aturan yang bisa dicek ulang membuka jalur sendiri di gerbang swarm"
          penjelas={<>
            <p>Rule rekam medis dan IoT tidak langsung menandai klaim di sistem keseluruhan; temuannya diserahkan ke agen AI, dan hakim harus menerima atau menolaknya secara tertulis. {fmt(r.jalur_aturan.periksa)} klaim masuk antrean lewat jalur ini: {fmt(r.jalur_aturan.fraud)} fraud dan {fmt(r.jalur_aturan.jujur)} jujur.</p>
            <p>Aturan juga mengirim klaim yang oleh ML v7 dianggap aman ke swarm: {fmt(r.jalur_aturan.dari_lolos_periksa)} masuk antrean ({fmt(r.jalur_aturan.dari_lolos_periksa_fraud)} fraud) dan {fmt(r.jalur_aturan.dari_lolos_dibersihkan)} dibersihkan swarm. Inilah cara swarm menahan alarm palsu aturan: temuan yang punya penjelasan wajar tidak otomatis jadi tuduhan.</p>
          </>}>
          <div className="grid grid-cols-2 gap-2">
            <Ubin label="Masuk antrean lewat jalur bukti" utama nilai={fmt(r.jalur_aturan.periksa)} ket={`${fmt(r.jalur_aturan.fraud)} fraud · ${fmt(r.jalur_aturan.jujur)} jujur`} />
            <Ubin label="Precision jalur bukti" nilai={pct(r.jalur_aturan.fraud / Math.max(1, r.jalur_aturan.periksa), 0)} ket="Dari klaim yang masuk lewat jalur ini, persen yang benar fraud." />
            <Ubin label="Dari zona aman ML v7, masuk antrean" nilai={fmt(r.jalur_aturan.dari_lolos_periksa)} ket={`${fmt(r.jalur_aturan.dari_lolos_periksa_fraud)} fraud yang tidak akan dilihat tanpa aturan.`} />
            <Ubin label="Dari zona aman, dibersihkan swarm" nilai={fmt(r.jalur_aturan.dari_lolos_dibersihkan)} ket="Alarm aturan yang ditolak setelah dibaca agen AI." />
          </div>
        </Kartu>
      </div>

      {/* ---------------------------------------------------------------- notes */}
      <section className={`${box} p-4`}>
        <Penjelas judul="Batasan dan cara membaca">
          <ul className="list-disc space-y-1 pl-4">
            {r.catatan.map((x) => <li key={x}>{x}</li>)}
            <li>Ambang dibekukan: ML v7 periksa {dec(r.ambang.periksa, 3)}, tahan {dec(r.ambang.tahan, 3)}, gerbang swarm τ {dec(r.ambang.tau, 2)}. Tidak ada ambang yang disetel pada audit ini.</li>
            <li>&ldquo;Nyata secara statistik&rdquo; berarti 95% CI selisihnya tidak memuat nol. Dengan {fmt(r.rs)} rumah sakit, selisih kecil (puluhan klaim) belum bisa dibedakan dari kebetulan.</li>
            <li>Precision dihitung pada tingkat fraud data ini ({pct(r.prevalensi, 1)}); di data nyata dengan tingkat fraud lebih rendah, precision setiap sistem akan lebih rendah (lihat kolom &ldquo;bila fraud 2%&rdquo; di bagian 2).</li>
          </ul>
        </Penjelas>
      </section>
    </div>
  );
}
