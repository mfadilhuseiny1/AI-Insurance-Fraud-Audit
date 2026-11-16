"use client";

// ML Studio · Perbandingan (the user, 2026-11-08: "di tab ML studio kasih perbandingan semuanya ML DL OpenAI Decision"):
// who finds the claims the BPJS verifier corrected — Random Forest (ML), an FT-Transformer (deep learning), OpenAI
// Decisions (Blu 1.3), DeepSeek (Blu 1.1) and JEv (OpenRouter). Read from /api/ml-perbandingan: aggregate numbers written
// by api/ml_perbandingan, no claim rows. Every chart has a table view; the chance line is what a random order scores.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ChartCard, GRID, SERIES, Tooltip, useTip } from "./viz";

type Interval = [number, number];
type ScreenMethod = { n: number; corrected: number; auroc: number; auprc: number; auprc_ci95: Interval; [k: string]: number | Interval };
type ScreenBoard = {
  label: string; n: number; corrected: number; methods: Record<string, ScreenMethod>;
  flag_budget: Record<string, Record<string, number>>; pairs: Record<string, { diff: number; ci95: Interval; clear: boolean }>;
};
type JevMethod = { auroc: number; auroc_ci95: Interval; auprc_weighted: number; flagged?: number; recall?: number; false_alarm_rate?: number; precision_weighted?: number;
  [k: string]: number | Interval | undefined };
type Bench = {
  task: string; task_label: string; folds: number; repeats: number; evaluasi: { klaim: number; positif: number };
  board: { model: string; rata: Record<string, { mean: number; sd: number }>; menang: number; dari: number; detik_latih: number;
    uji_vs_terbaik?: { selisih_auprc: number | null; p: number; berbeda_nyata: boolean } | null }[];
  dl_fits?: { epochs: number; seconds: number }[];
};
type Doc = {
  dibuat: string;
  screened: { screened_total: number; boards: ScreenBoard[] };
  jev: { sample: number; corrected: number; jev_usd: number; jev_routed_to: Record<string, number>; jev_levels: Record<string, number>;
    jev_vs_decisions_same_level: number; methods: Record<string, JevMethod>;
    prompt_v2?: { claims: number; usd: number; routed_to: Record<string, number>; levels: Record<string, number>; auroc_v2_minus_v1: number; ci95: Interval; note: string } } | null;
  benchmark: Bench[];
  catatan: { label: string; folds: string; llm: string; skrip: string };
};

const n3 = (v?: number | null) => (v === undefined || v === null || Number.isNaN(v) ? "—" : v.toLocaleString("id-ID", { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
const n0 = (v?: number | null) => (v === undefined || v === null ? "—" : v.toLocaleString("id-ID", { maximumFractionDigits: 0 }));
const pct = (v?: number | null) => (v === undefined || v === null ? "—" : `${(v * 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`);
const FAMILY: [RegExp, string][] = [[/Random Forest|MLP|LightGBM|XGBoost/i, "ML"], [/FT-Transformer/i, "Deep learning"], [/Decisions|DeepSeek|JEv/i, "LLM"]];
const family = (name: string) => FAMILY.find(([re]) => re.test(name))?.[1] ?? "";
const short = (name: string) => name.replace(/ \((ML|deep learning)\)$/, "");
const BAR = SERIES[0];

/** One value per method with its 95 % interval, against what a random order scores (the chance line). */
function IntervalBars({ rows, chance, max = 1, metric }: { rows: { name: string; value: number; ci?: Interval; note?: string }[]; chance?: number; max?: number; metric: string }) {
  const { box, tip, at, clear } = useTip();
  const x = (v: number) => `${Math.max(0, Math.min(1, v / max)) * 100}%`;
  return (
    <div ref={box} className="relative space-y-2 pt-1" onPointerLeave={clear}>
      {rows.map((r) => (
        <div key={r.name} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(120px, 200px) 1fr 52px" }}>
          <div className="min-w-0">
            <p className="truncate text-[12px] text-white">{short(r.name)}</p>
            <p className="text-[10.5px] text-[#8f99a8]">{family(r.name)}</p>
          </div>
          <div className="relative h-5" onPointerMove={(e) => at(e, { title: r.name, lines: [{ value: n3(r.value), label: metric, key: BAR },
            ...(r.ci ? [{ value: `${n3(r.ci[0])} – ${n3(r.ci[1])}`, label: "interval 95%" }] : []), ...(r.note ? [{ value: "", label: r.note }] : [])] })}>
            <div className="absolute inset-y-[7px] left-0 right-0 rounded-full" style={{ background: GRID }} />
            <div className="absolute inset-y-[5px] left-0 rounded-r" style={{ width: x(r.value), background: BAR, minWidth: 2 }} />
            {r.ci && (
              <div className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-white/80" style={{ left: x(r.ci[0]), width: `calc(${x(r.ci[1])} - ${x(r.ci[0])})` }}>
                <span className="absolute -left-px -top-[4px] h-[10px] w-[2px] bg-white/80" />
                <span className="absolute -right-px -top-[4px] h-[10px] w-[2px] bg-white/80" />
              </div>
            )}
            {chance !== undefined && <div className="absolute inset-y-0 w-px border-l border-dashed border-amber-300/80" style={{ left: x(chance) }} title="tebakan acak" />}
          </div>
          <p className="text-right text-[12px] font-semibold tabular-nums text-white">{n3(r.value)}</p>
        </div>
      ))}
      {chance !== undefined && (
        <p className="flex items-center gap-1.5 pl-[calc(min(200px,30%)+12px)] text-[10.5px] text-[#8f99a8]">
          <span className="inline-block h-3 w-px border-l border-dashed border-amber-300/80" />tebakan acak: {n3(chance)} · garis putih: interval 95%
        </p>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11.5px]">
        <thead><tr className="text-left text-[#8f99a8]">{head.map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5 text-[#d3d8de]">
              {r.map((c, j) => <td key={j} className={`px-2 py-1 ${j === 0 ? "text-white" : "tabular-nums"}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hero({ board }: { board: ScreenBoard }) {
  const dec = Object.entries(board.flag_budget).find(([k]) => /Decisions/.test(k));
  if (!dec) return null;
  const [, b] = dec;
  const others = Object.entries(b).filter(([k]) => k.includes(" top "));
  return (
    <section className="rounded-lg border border-white/[.07] bg-[#1c2127] p-4">
      <p className="text-[11px] uppercase tracking-wide text-[#8f99a8]">Dengan jumlah tanda yang sama</p>
      <p className="mt-1 text-[13px] leading-relaxed text-[#d3d8de]">
        OpenAI Decisions menandai <b className="text-white">{n0(b.flagged)}</b> klaim sebagai <i>mencurigakan</i>; <b className="text-white">{n0(b.corrected_among_flagged)}</b> di
        antaranya dikoreksi verifikator BPJS. Bila masing-masing model mengambil {n0(b.flagged)} klaim teratasnya sendiri:
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[["OpenAI Decisions (LLM)", b.corrected_among_flagged], ...others.map(([k, v]) => [k.split(" top ")[0], v] as [string, number])].map(([k, v]) => (
          <div key={k} className="rounded-md bg-white/[.04] px-3 py-2">
            <p className="text-[22px] font-semibold tabular-nums text-white">{n0(v as number)}</p>
            <p className="text-[11px] text-[#abb3bf]">{k} · {pct((v as number) / Math.max(1, b.flagged))} tepat</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MlPerbandingan() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState("");
  const [bi, setBi] = useState(0);
  useEffect(() => {
    fetch("/api/ml-perbandingan", { cache: "no-store" })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); setDoc(d as Doc); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const board = doc?.screened.boards[bi];
  const screenRows = useMemo(() => (board ? Object.entries(board.methods).map(([name, m]) => ({ name, value: m.auprc, ci: m.auprc_ci95 })).sort((a, b) => b.value - a.value) : []), [board]);
  if (err) return <p className="p-4 text-red-300">{err}</p>;
  if (!doc || !board) return <p className="p-4 text-[#8f99a8]">Memuat perbandingan…</p>;
  const jev = doc.jev;
  const jevRows = jev ? Object.entries(jev.methods).map(([name, m]) => ({ name, value: m.auroc, ci: m.auroc_ci95 })).sort((a, b) => b.value - a.value) : [];
  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-[260px] flex-1">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-white"><Icon name="gauge" className="h-4 w-4 text-[#b9a8ff]" />ML vs Deep learning vs LLM</h2>
          <p className="mt-0.5 max-w-[900px] text-[12px] leading-relaxed text-[#abb3bf]">
            Siapa yang paling tepat menemukan klaim yang <b className="text-white">dikoreksi verifikator BPJS</b> (dibayar lebih rendah dari tagihan): Random Forest,
            FT-Transformer, OpenAI Decisions, DeepSeek dan JEv. ML dan deep learning dinilai <i>out-of-fold</i> per faskes: model tidak pernah menilai klaim dari faskes
            yang ikut melatihnya. Vonis LLM dibaca dari cache (tanpa panggilan baru), kecuali JEv.
          </p>
        </div>
        <span className="rounded bg-white/5 px-2 py-1 text-[11px] text-[#abb3bf]">dihitung {new Date(doc.dibuat).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</span>
      </header>

      <Hero board={doc.screened.boards[0]} />

      <ChartCard
        title={`Peringkat klaim di ${n0(board.n)} klaim yang di-screen`}
        insight={`AUPRC: seberapa tinggi klaim yang dikoreksi berada di urutan setiap metode (${n0(board.corrected)} dikoreksi, ${pct(board.corrected / board.n)}). Tebakan acak = porsi klaim dikoreksi.`}
        source={<span>Set screen Blu: Klaim Berisiko (aturan) + Skor Risiko Klaim ML · interval: bootstrap per faskes</span>}
        table={<Table head={["Metode", "AUPRC", "Interval 95%", "AUROC", "Presisi top 1.000", "Recall top 5.000"]}
          rows={Object.entries(board.methods).sort((a, b) => b[1].auprc - a[1].auprc).map(([k, m]) => [k, n3(m.auprc), `${n3(m.auprc_ci95[0])} – ${n3(m.auprc_ci95[1])}`, n3(m.auroc),
            pct(m.precision_top_1000 as number), pct(m.recall_top_5000 as number)])} />}
      >
        <div className="mb-2 mt-2 flex flex-wrap gap-1">
          {doc.screened.boards.map((b, i) => (
            <button key={b.label} onClick={() => setBi(i)} className={`rounded px-2 py-0.5 text-[11px] ${i === bi ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>
              {b.label} ({n0(b.n)})
            </button>
          ))}
        </div>
        <IntervalBars rows={screenRows} chance={board.corrected / board.n} metric="AUPRC" />
        <ul className="mt-3 space-y-1 text-[11.5px] text-[#abb3bf]">
          {Object.entries(board.pairs).map(([k, p]) => (
            <li key={k}>{k}: selisih AUPRC <b className="tabular-nums text-white">{p.diff >= 0 ? "+" : ""}{n3(p.diff)}</b> (95%: {n3(p.ci95[0])} sampai {n3(p.ci95[1])}) —{" "}
              {p.clear ? <span className="text-[#7ee2c0]">berbeda nyata</span> : <span className="text-amber-200">tidak berbeda nyata</span>}</li>
          ))}
        </ul>
      </ChartCard>

      {jev && (
        <ChartCard
          title={`JEv vs yang lain di ${jev.sample} klaim yang sama (${jev.corrected} dikoreksi, ${jev.sample - jev.corrected} tidak)`}
          insight={`AUROC: peluang sebuah klaim dikoreksi diurutkan di atas klaim yang tidak (0,5 = acak). Sampel kecil: intervalnya lebar. Biaya JEv $${jev.jev_usd.toFixed(2)}.`}
          source={<span>JEv = typesafe/jev-router (OpenRouter), router memilih model: {Object.entries(jev.jev_routed_to).map(([k, v]) => `${k} ${v}`).join(", ")} · fakta & rubrik sama dengan OpenAI Decisions</span>}
          table={<Table head={["Metode", "AUROC", "Interval 95%", "Ditandai mencurigakan", "Recall", "Alarm palsu", "Presisi (pada prevalensi set)"]}
            rows={Object.entries(jev.methods).sort((a, b) => b[1].auroc - a[1].auroc).map(([k, m]) => [k, n3(m.auroc), `${n3(m.auroc_ci95[0])} – ${n3(m.auroc_ci95[1])}`,
              m.flagged === undefined ? "—" : n0(m.flagged), m.recall === undefined ? "—" : pct(m.recall), m.false_alarm_rate === undefined ? "—" : pct(m.false_alarm_rate),
              m.precision_weighted === undefined ? "—" : pct(m.precision_weighted)])} />}
        >
          <IntervalBars rows={jevRows} chance={0.5} metric="AUROC" />
          <p className="mt-3 text-[11.5px] text-[#abb3bf]">
            Tingkat JEv (prompt Decisions): {Object.entries(jev.jev_levels).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(", ")} · tingkatnya sama dengan OpenAI Decisions pada {pct(jev.jev_vs_decisions_same_level)} klaim.
          </p>
          {jev.prompt_v2 && (
            <div className="mt-2 rounded-md border border-white/10 bg-white/[.03] px-3 py-2 text-[11.5px] leading-relaxed text-[#abb3bf]">
              <p className="font-semibold text-white">Prompt v2: nilai klaim vs tarif INA-CBG vs median kode, aturan indikasi, konteks ontologi</p>
              <p>
                AUROC berubah <b className="tabular-nums text-white">{jev.prompt_v2.auroc_v2_minus_v1 >= 0 ? "+" : ""}{n3(jev.prompt_v2.auroc_v2_minus_v1)}</b> (95%: {n3(jev.prompt_v2.ci95[0])} sampai {n3(jev.prompt_v2.ci95[1])})
                {" "}terhadap prompt Decisions, pada {jev.prompt_v2.claims} klaim yang sama, biaya ${jev.prompt_v2.usd.toFixed(2)}. Tingkat: {Object.entries(jev.prompt_v2.levels).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(", ")}.
                Router memilih {Object.entries(jev.prompt_v2.routed_to).map(([k, v]) => `${k} ${v}`).join(", ")}.
              </p>
              <p className="mt-1">Dengan lebih banyak konteks, model menandai klaim dengan anomali paling menonjol (tagihan di atas tarif, top-up, LOS panjang), sedangkan klaim yang dikoreksi verifikator kebanyakan pola administratif yang hanya terlihat dari riwayat koreksi. OpenAI Decisions sendiri tidak dijalankan ulang dengan v2: aturan tetap pengguna, kunci OpenAI tidak dipakai lagi.</p>
            </div>
          )}
        </ChartCard>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {doc.benchmark.map((b) => {
          const rows = b.board.map((r) => ({ name: r.model, value: r.rata.auprc.mean, ci: [Math.max(0, r.rata.auprc.mean - r.rata.auprc.sd), r.rata.auprc.mean + r.rata.auprc.sd] as Interval }));
          const max = Math.min(1, Math.max(...rows.map((r) => r.ci[1])) * 1.1);
          const fits = b.dl_fits ?? [];
          return (
            <ChartCard key={b.task}
              title={`Protokol ML Studio · ${b.task_label}`}
              insight={`${b.folds} lipatan per faskes × ${b.repeats} ulangan, ${n0(b.evaluasi.klaim)} klaim (${n0(b.evaluasi.positif)} dikoreksi). Garis putih: ± 1 simpangan baku antar lipatan.`}
              source={<span>ml_klaim.benchmark · FT-Transformer: {fits.length ? `rata-rata ${Math.round(fits.reduce((s, f) => s + f.epochs, 0) / fits.length)} epoch, ${Math.round(fits.reduce((s, f) => s + f.seconds, 0) / fits.length)} detik per lipatan (CPU)` : "—"}</span>}
              table={<Table head={["Model", "AUPRC", "AUROC", "F1", "Presisi top 0,1%", "Menang", "p vs terbaik", "Detik latih"]}
                rows={b.board.map((r) => [r.model, `${n3(r.rata.auprc.mean)} ± ${n3(r.rata.auprc.sd)}`, n3(r.rata.auroc?.mean), n3(r.rata.f1?.mean), pct(r.rata.presisi_top_0_1pct?.mean),
                  `${r.menang}/${r.dari}`, r.uji_vs_terbaik ? n3(r.uji_vs_terbaik.p) : "terbaik", n0(r.detik_latih)])} />}
            >
              <IntervalBars rows={rows} max={max} metric="AUPRC rata-rata" />
              <ul className="mt-3 space-y-1 text-[11.5px] text-[#abb3bf]">
                {b.board.filter((r) => r.uji_vs_terbaik).map((r) => (
                  <li key={r.model}>{r.model} vs {b.board[0].model}: selisih {n3(-(r.uji_vs_terbaik?.selisih_auprc ?? 0))}, p = {n3(r.uji_vs_terbaik?.p)} —{" "}
                    {r.uji_vs_terbaik?.berbeda_nyata ? <span className="text-[#7ee2c0]">berbeda nyata</span> : <span className="text-amber-200">tidak berbeda nyata</span>}</li>
                ))}
              </ul>
            </ChartCard>
          );
        })}
      </div>

      <section className="rounded-lg border border-white/[.07] bg-[#1c2127]/60 p-3.5 text-[11.5px] leading-relaxed text-[#abb3bf]">
        <p className="mb-1 font-semibold text-white">Cara membaca, dan batasnya</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>{doc.catatan.label}</li>
          <li>{doc.catatan.llm}</li>
          <li>{doc.catatan.folds}</li>
          <li>{doc.catatan.skrip}</li>
        </ul>
      </section>
    </div>
  );
}
