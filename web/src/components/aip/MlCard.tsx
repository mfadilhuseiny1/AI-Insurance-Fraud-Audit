"use client";

// The Machine Learning agent's model card (api/aip/ml.py): what the model predicts and from which label, how every
// technique did on the same grouped cross-validation (with 95 % intervals), the research behind each technique and each
// protocol choice, how the explanation methods compare, and the benchmark jobs a person (or the agent) starts.

import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { aip, type MlBoardRow, type MlCard as Card, type MlEvidence, type MlEvidenceCard, type MlInterval, type MlJob, type MlLeak, type MlRef, type MlRule2, type MlTask } from "./aipRun";
import { AXIS, ChartCard, GRID, Leaderboard, SERIES, SURFACE, Tooltip, useTip } from "./viz";

const MODELS = ["Regresi logistik", "Random Forest", "Extra Trees", "HistGradientBoosting", "XGBoost", "LightGBM", "CatBoost", "MLP", "EBM"];
const COLS: [string, string][] = [["auprc", "AUPRC"], ["auroc", "AUROC"], ["f1", "F1"], ["presisi", "Presisi"], ["recall", "Recall"],
  ["akurasi_seimbang", "Akurasi seimbang"], ["akurasi", "Akurasi"], ["presisi_top_0_1pct", "Presisi top 0,1%"], ["lift_top_0_1pct", "Lift 0,1%"], ["detik_latih", "Detik"]];
const n3 = (v?: number | null) => (v === undefined || v === null || Number.isNaN(v) ? "—" : v.toLocaleString("id-ID", { maximumFractionDigits: 3, minimumFractionDigits: 3 }));
const n0 = (v?: number | null) => (v === undefined || v === null ? "—" : v.toLocaleString("id-ID", { maximumFractionDigits: 0 }));
const SRC: Record<string, [string, string]> = { consensus: ["Consensus", "#199e70"], web: ["web", "#c98500"], metode: ["makalah metode", "#5f6b7c"] };

function Ref({ r }: { r: MlRef }) {
  const [label, color] = SRC[r.sumber] ?? ["", "#5f6b7c"];
  return (
    <li className="text-[11.5px] leading-snug text-[#d3d8de]">
      <span className="mr-1.5 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-white" style={{ background: color }}>{label}</span>
      {r.penulis} ({r.tahun}). {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-[#8abbff] hover:underline">{r.judul}</a> : <span className="italic">{r.judul}</span>}. <span className="text-[#8f99a8]">{r.venue}{r.sitasi ? ` · ${r.sitasi} sitasi` : ""}</span>
      {r.temuan && <span className="block text-[11px] text-[#abb3bf]">{r.temuan}</span>}
    </li>
  );
}

function Board({ task, onlyBest }: { task: MlTask; onlyBest?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = task.papan.map((r) => ({
    model: r.model, pembanding: r.pembanding, auprc: r.rata.auprc?.mean, auprc_ci95: r.gabungan_oof.ci95?.auprc ?? null,
    auroc: r.rata.auroc?.mean, f1: r.rata.f1?.mean, presisi: r.rata.presisi?.mean, recall: r.rata.recall?.mean,
    akurasi_seimbang: r.rata.akurasi_seimbang?.mean, akurasi: r.rata.akurasi?.mean,
    presisi_top_0_1pct: r.rata.presisi_top_0_1pct?.mean, lift_top_0_1pct: r.rata.lift_top_0_1pct?.mean,
  }));
  return (
    <div className="space-y-4">
      <div className="max-w-[920px]">
        <p className="mb-2 text-[11px] text-[#8f99a8]">{n0(task.evaluasi.klaim)} klaim evaluasi (semua {n0(task.evaluasi.positif)} terkoreksi + 1/{task.evaluasi.bobot_negatif} lainnya, dibobot balik) · validasi silang {task.ulangan && task.ulangan > 1 ? `${task.ulangan} × ` : ""}{task.lipatan ?? 5} lipatan, bertingkat dan dikelompokkan per profil faskes</p>
        <Leaderboard rows={rows} label="model" value="auprc" highlight={[task.terbaik]} />
      </div>
      <div className="space-y-3">
        <MetricHeatmap rows={task.papan} />
        <div className="grid gap-3 xl:grid-cols-2">
          <PrecisionRecallPlot rows={task.papan} prevalence={task.evaluasi.klaim ? task.evaluasi.positif / task.evaluasi.klaim : 0} highlight={task.terbaik} />
          <PrioritizationChart rows={task.papan} claims={task.evaluasi.klaim} prevalence={task.evaluasi.klaim ? task.evaluasi.positif / task.evaluasi.klaim : 0} />
        </div>
        <ImbalanceScorecard rows={task.papan} />
      </div>
      {!onlyBest && (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase tracking-wide text-[#8f99a8]">
              <th className="py-1.5 pr-2 font-medium">Teknik</th>{COLS.map(([, l]) => <th key={l} className="px-1.5 py-1.5 text-right font-medium">{l}</th>)}<th className="px-1.5 py-1.5 text-right font-medium">Menang</th><th className="px-1.5 py-1.5 text-right font-medium">p vs teratas</th><th className="px-1.5 py-1.5 font-medium">Riset</th>
            </tr></thead>
            <tbody>
              {task.papan.map((r: MlBoardRow) => (
                <Fragment key={r.model}>
                  <tr className={`border-b border-white/[.05] ${r.model === task.terbaik ? "bg-[#3987e5]/10" : ""}`}>
                    <td className={`py-1.5 pr-2 ${r.pembanding ? "italic text-[#8f99a8]" : "text-[#e5e8eb]"}`}>{r.model}{r.model === task.terbaik && <span className="ml-1.5 rounded bg-[#3987e5] px-1 text-[9.5px] font-semibold text-white">TERBAIK</span>}<span className="block text-[10px] not-italic text-[#8f99a8]">{r.keluarga}</span></td>
                    {COLS.map(([k]) => {
                      const s = r.rata[k];
                      return <td key={k} className="px-1.5 py-1.5 text-right tabular-nums text-[#d3d8de]">{k === "detik_latih" ? n0(r.detik_latih) : k.startsWith("lift") ? (s ? `${n0(s.mean)}×` : "—") : n3(s?.mean)}{s && k === "auprc" && <span className="block text-[10px] text-[#8f99a8]">± {n3(s.sd)}</span>}</td>;
                    })}
                    <td className="px-1.5 py-1.5 text-right tabular-nums text-[#d3d8de]">{r.dari ? `${r.menang ?? 0}/${r.dari}` : "—"}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{r.uji_vs_terbaik ? (r.uji_vs_terbaik.berbeda_nyata
                      ? <span className="text-[#d3d8de]">{r.uji_vs_terbaik.p < 0.001 ? "<0,001" : n3(r.uji_vs_terbaik.p)}</span>
                      : <span className="rounded bg-[#c98500]/20 px-1 text-[10.5px] text-[#fab219]" title={`p = ${n3(r.uji_vs_terbaik.p)}: tidak berbeda nyata dari teknik teratas`}>setara</span>) : <span className="text-[#8f99a8]">—</span>}</td>
                    <td className="px-1.5 py-1.5">{r.riset?.length ? <button onClick={() => setOpen(open === r.model ? null : r.model)} className="whitespace-nowrap rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] text-[#d3d8de] hover:bg-white/10">{r.riset.length} rujukan</button> : <span className="text-[10.5px] text-[#8f99a8]">aturan</span>}</td>
                  </tr>
                  {open === r.model && r.riset && (
                    <tr><td colSpan={COLS.length + 4} className="bg-black/20 px-3 py-2"><ul className="space-y-1.5">{r.riset.map((x, i) => <Ref key={i} r={x} />)}</ul></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Nilai = rata-rata semua lipatan (± simpangan baku); ambang tiap lipatan dipilih di validasi lalu diterapkan apa adanya. &quot;Setara&quot; = AUPRC tidak berbeda nyata dari teknik teratas menurut t-test resampel terkoreksi (Nadeau &amp; Bengio 2003, p ≥ 0,05). Akurasi dicantumkan tetapi tidak bermakna pada data setimpang ini.</p>
        </div>
      )}
    </div>
  );
}

const VISUAL_METRICS: { key: string; label: string; hint: string; lift?: boolean }[] = [
  { key: "auprc", label: "AUPRC", hint: "Area under the precision–recall curve" },
  { key: "f1", label: "F1", hint: "Balance between precision and recall" },
  { key: "presisi", label: "Presisi", hint: "Of flagged claims, how many were corrected" },
  { key: "recall", label: "Recall", hint: "Of corrected claims, how many were found" },
  { key: "akurasi_seimbang", label: "Akurasi seimbang", hint: "Average recall across both classes" },
  { key: "lift_top_0_1pct", label: "Lift top 0,1%", hint: "Precision in the top 0,1% divided by prevalence", lift: true },
];
const score = (row: MlBoardRow, key: string): number | null => {
  const v = row.rata[key]?.mean;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const pct1 = (v: number) => `${(100 * v).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;

/** Scores on a common 0–1 scale; lift is scaled within its own column. */
function MetricHeatmap({ rows }: { rows: MlBoardRow[] }) {
  const available = VISUAL_METRICS.filter((m) => rows.some((r) => score(r, m.key) !== null));
  if (!available.length) return null;
  const best = Object.fromEntries(available.map((m) => [m.key, Math.max(...rows.map((r) => score(r, m.key) ?? -Infinity))]));
  const maxLift = Math.max(1, ...rows.map((r) => score(r, "lift_top_0_1pct") ?? 0));
  return (
    <section className="rounded-lg border border-white/10 bg-[#1f242b] p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-semibold text-white">A · Peta performa model</h4>
          <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">Semakin hijau nilainya semakin tinggi pada metrik itu. Tiap kolom memakai skala metriknya sendiri.</p>
        </div>
        <span className="text-[10px] text-[#8f99a8]">Rata-rata lipatan</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-white/[.06]">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[10.5px]">
          <thead className="bg-black/20 text-[#8f99a8]">
            <tr><th scope="col" className="sticky left-0 z-10 bg-[#1b2026] px-2.5 py-2 text-left font-medium">Algoritma</th>
              {available.map((m) => <th key={m.key} scope="col" title={m.hint} className="px-2 py-2 text-center font-medium">{m.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-t border-white/[.05]">
                <th scope="row" className={`sticky left-0 z-10 border-t border-white/[.05] bg-[#1f242b] px-2.5 py-2 text-left font-medium ${r.pembanding ? "italic text-[#8f99a8]" : "text-[#d3d8de]"}`}>
                  {r.model}{r.pembanding && <span className="ml-1 text-[9px] not-italic text-[#8f99a8]">pembanding</span>}
                </th>
                {available.map((m) => {
                  const v = score(r, m.key);
                  const ratio = v === null ? 0 : m.lift ? v / maxLift : Math.max(0, Math.min(1, v));
                  const isBest = v !== null && v === best[m.key];
                  return <td key={m.key} title={`${r.model} · ${m.label}: ${v === null ? "tidak tersedia" : m.lift ? `${n0(v)}×` : pct1(v)}`}
                    className={`border-t border-white/[.05] px-2 py-2 text-center font-mono tabular-nums ${isBest ? "text-white ring-1 ring-inset ring-emerald-300/30" : "text-[#d3d8de]"}`}
                    style={v === null ? undefined : { background: `rgba(25,158,112,${0.08 + 0.55 * ratio})` }}>
                    {v === null ? "—" : m.lift ? `${n0(v)}×` : pct1(v)}
                  </td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Each point is an algorithm; the dashed line is the positive-class prevalence baseline. */
function PrecisionRecallPlot({ rows, prevalence, highlight }: { rows: MlBoardRow[]; prevalence: number; highlight: string }) {
  const data = rows.map((row, i) => ({ row, i, precision: score(row, "presisi"), recall: score(row, "recall") }))
    .filter((d): d is { row: MlBoardRow; i: number; precision: number; recall: number } => d.precision !== null && d.recall !== null);
  if (!data.length) return null;
  const W = 480, H = 280, p = { l: 48, r: 14, t: 18, b: 38 };
  const sx = (v: number) => p.l + Math.max(0, Math.min(1, v)) * (W - p.l - p.r);
  const sy = (v: number) => p.t + (1 - Math.max(0, Math.min(1, v))) * (H - p.t - p.b);
  return (
    <section className="min-w-0 rounded-lg border border-white/10 bg-[#1f242b] p-3 sm:p-4">
      <h4 className="text-[12px] font-semibold text-white">B · Trade-off presisi dan recall</h4>
      <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">Setiap titik adalah teknik; pembanding berwarna abu-abu. Kanan = lebih banyak klaim koreksi ditemukan; atas = lebih sedikit false positive.</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="Scatter plot presisi terhadap recall untuk tiap algoritma">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <g key={v}>
          <line x1={sx(0)} x2={sx(1)} y1={sy(v)} y2={sy(v)} stroke="#38414b" strokeWidth={0.8} />
          <line x1={sx(v)} x2={sx(v)} y1={sy(0)} y2={sy(1)} stroke="#38414b" strokeWidth={0.8} />
          <text x={p.l - 7} y={sy(v) + 3} textAnchor="end" fontSize={9} fill="#8f99a8">{pct1(v)}</text>
          <text x={sx(v)} y={H - 20} textAnchor="middle" fontSize={9} fill="#8f99a8">{pct1(v)}</text>
        </g>)}
        <line x1={sx(0)} x2={sx(1)} y1={sy(prevalence)} y2={sy(prevalence)} stroke="#fab219" strokeWidth={1.2} strokeDasharray="5 4" />
        <text x={W - p.r} y={sy(prevalence) - 4} textAnchor="end" fontSize={8} fill="#fab219">prevalensi {pct1(prevalence)}</text>
        <text x={(sx(0) + sx(1)) / 2} y={H - 3} textAnchor="middle" fontSize={10} fill="#abb3bf">Recall →</text>
        <text x={8} y={p.t + 2} fontSize={10} fill="#abb3bf">Presisi ↑</text>
        {data.map(({ row, i, precision, recall }) => {
          const color = row.pembanding ? "#667085" : SERIES[i % SERIES.length];
          return <circle key={row.model} cx={sx(recall)} cy={sy(precision)} r={row.model === highlight ? 6 : 4.5}
            fill={color} fillOpacity={row.pembanding ? 0.65 : 0.9} stroke="#f5f7fa" strokeOpacity={0.7} strokeWidth={0.8}>
            <title>{`${row.model}${row.pembanding ? " (pembanding)" : ""} · presisi ${pct1(precision)} · recall ${pct1(recall)}`}</title>
          </circle>;
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#abb3bf]">
        {data.map(({ row, i }) => <span key={row.model} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: row.pembanding ? "#667085" : SERIES[i % SERIES.length] }} />{row.model}</span>)}
      </div>
    </section>
  );
}

function MetricTrack({ label, value, max, display }: { label: string; value: number | null; max: number; display: string }) {
  const width = value === null ? 0 : Math.max(1, Math.min(100, (100 * value) / (max || 1)));
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 text-[9.5px] text-[#8f99a8]"><span>{label}</span><span className="font-mono tabular-nums text-[#d3d8de]">{value === null ? "—" : display}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/30"><div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${width}%` }} /></div>
    </div>
  );
}

/** Ranking metrics for the small fraction of claims a human team can review first. */
function PrioritizationChart({ rows, claims, prevalence }: { rows: MlBoardRow[]; claims: number; prevalence: number }) {
  const data = rows.map((row) => ({ row, precision: score(row, "presisi_top_0_1pct"), lift: score(row, "lift_top_0_1pct") }))
    .filter((d) => d.precision !== null || d.lift !== null)
    .sort((a, b) => (b.lift ?? -Infinity) - (a.lift ?? -Infinity));
  if (!data.length) return null;
  const maxPrecision = Math.max(1e-9, ...data.map((d) => d.precision ?? 0));
  const maxLift = Math.max(1, ...data.map((d) => d.lift ?? 0));
  const capacity = Math.max(1, Math.round(claims * 0.001));
  return (
    <section className="min-w-0 rounded-lg border border-white/10 bg-[#1f242b] p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-semibold text-white">C · Prioritas audit 0,1% teratas</h4>
          <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">Presisi = bagian yang benar-benar dikoreksi; lift = dibanding tingkat koreksi dasar.</p>
        </div>
        <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-[#c5cbd3]">≈ {n0(capacity)} klaim ditinjau</span>
      </div>
      <div className="mt-2 space-y-2">
        {data.map(({ row, precision, lift }) => (
          <div key={row.model} className="grid min-w-0 grid-cols-[minmax(5rem,.8fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 rounded px-1 py-1 hover:bg-white/[.03]">
            <span className={`truncate text-[10.5px] ${row.pembanding ? "italic text-[#8f99a8]" : "text-[#d3d8de]"}`} title={row.model}>{row.model}</span>
            <MetricTrack label="Presisi top 0,1%" value={precision} max={maxPrecision} display={precision === null ? "—" : pct1(precision)} />
            <MetricTrack label="Lift top 0,1%" value={lift} max={maxLift} display={lift === null ? "—" : `${n0(lift)}×`} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[#8f99a8]">Prevalensi evaluasi: {pct1(prevalence)}. Lift 1× berarti setara memilih klaim secara acak.</p>
    </section>
  );
}

const IMBALANCE_METRICS = [["akurasi", "Accuracy"], ["akurasi_seimbang", "Balanced accuracy"], ["presisi", "Precision"], ["recall", "Recall"], ["f1", "F1"]] as const;

/** Compact scorecard makes high accuracy / low minority-class performance gaps visible. */
function ImbalanceScorecard({ rows }: { rows: MlBoardRow[] }) {
  const data = rows.filter((row) => IMBALANCE_METRICS.some(([key]) => score(row, key) !== null));
  if (!data.length) return null;
  return (
    <section className="rounded-lg border border-white/10 bg-[#1f242b] p-3 sm:p-4">
      <div className="mb-3">
        <h4 className="text-[12px] font-semibold text-white">D · Scorecard untuk kelas timpang</h4>
        <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">Bandingkan accuracy dengan balanced accuracy, precision, recall, dan F1. Accuracy tinggi saja bisa menutupi kelas positif yang terlewat.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {data.map((row) => {
          const accuracy = score(row, "akurasi"), balanced = score(row, "akurasi_seimbang");
          const gap = accuracy !== null && balanced !== null ? accuracy - balanced : null;
          return (
            <article key={row.model} className="min-w-0 rounded-md border border-white/[.07] bg-black/15 p-2.5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <h5 className={`truncate text-[11px] font-medium ${row.pembanding ? "italic text-[#8f99a8]" : "text-white"}`} title={row.model}>{row.model}</h5>
                {gap !== null && <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9.5px] tabular-nums ${Math.abs(gap) >= 0.1 ? "bg-amber-500/15 text-amber-200" : "bg-white/[.05] text-[#abb3bf]"}`} title="Accuracy minus balanced accuracy">gap {gap >= 0 ? "+" : ""}{pct1(gap)}</span>}
              </div>
              <div className="space-y-1.5">
                {IMBALANCE_METRICS.map(([key, label]) => {
                  const value = score(row, key);
                  return <div key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.8rem] items-center gap-1.5 text-[9.5px]">
                    <span className="truncate text-[#8f99a8]">{label}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-white/[.07]"><span className={`block h-full rounded-full ${key === "akurasi" ? "bg-[#8b95a7]" : "bg-[#199e70]"}`} style={{ width: `${value === null ? 0 : Math.max(0, Math.min(1, value)) * 100}%` }} /></span>
                    <span className="text-right font-mono tabular-nums text-[#d3d8de]">{value === null ? "—" : pct1(value)}</span>
                  </div>;
                })}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Explainers({ task }: { task: MlTask }) {
  if (!task.penjelas) return null;
  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-[11px] text-[#8f99a8]">Model {task.penjelas.model}, {task.penjelas.metode[0]?.klaim ?? 0} klaim terkoreksi berisiko tertinggi di faskes yang tidak dipakai melatih. Deletion AUC: risiko tersisa saat fitur teratas versi metode itu direset satu per satu — makin kecil makin setia (Petsiuk dkk. 2018).</p>
      <table className="w-full text-[11.5px]">
        <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase tracking-wide text-[#8f99a8]"><th className="py-1.5 pr-2 font-medium">Metode</th><th className="px-1.5 text-right font-medium">Deletion AUC</th><th className="px-1.5 text-right font-medium">Stabilitas</th><th className="px-1.5 text-right font-medium">Sepakat TreeSHAP</th><th className="px-1.5 text-right font-medium">Detik/klaim</th><th className="px-1.5 font-medium">Rujukan</th></tr></thead>
        <tbody>
          {task.penjelas.metode.map((m) => (
            <tr key={m.metode} className="border-b border-white/[.05] align-top">
              <td className="py-1.5 pr-2 text-[#e5e8eb]">{m.metode}<span className="block text-[10px] text-[#8f99a8]">{m.keterangan}</span></td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{n3(m.deletion_auc)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{m.stabilitas === null && ["treeshap", "oklusi", "ebm"].includes(m.metode) ? <span className="text-[10.5px] text-[#8f99a8]">deterministik</span> : n3(m.stabilitas)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{n3(m.kesepakatan_treeshap)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{n3(m.detik_per_klaim)}</td>
              <td className="px-1.5 py-1.5 text-[10.5px] text-[#abb3bf]">{(m.riset ?? []).map((r) => `${r.penulis.split(/[ ,&]/)[0]} ${r.tahun}`).join("; ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRunner({ onDone }: { onDone: () => void }) {
  const [tugas, setTugas] = useState("rumah_sakit");
  const [models, setModels] = useState<string[]>(["Regresi logistik", "Random Forest", "XGBoost", "LightGBM", "CatBoost"]);
  const [lipatan, setLipatan] = useState(3);
  const [prov, setProv] = useState("");
  const [job, setJob] = useState<MlJob | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => aip.mlJob(job.id).then((j) => { setJob(j); if (j.status !== "running") onDone(); }).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [job, onDone]);
  const start = () => {
    setErr("");
    aip.mlBenchmark({ tugas, model: models, lipatan, provinsi_kode: prov ? Number(prov) : null }).then(setJob).catch((e) => setErr((e as Error).message));
  };
  const res = job?.result as { papan?: MlBoardRow[]; tugas_label?: string; evaluasi?: MlTask["evaluasi"]; detik?: number } | null;
  return (
    <div className="rounded-lg border border-white/10 bg-[#252a31] p-3">
      <p className="text-[12px] font-semibold text-white">Benchmark baru</p>
      <p className="mb-2 text-[11px] text-[#8f99a8]">Pilih teknik dan cakupan; job berjalan di server (beberapa menit). Agen Machine Learning bisa menjalankan hal yang sama lewat benchmark_ml.</p>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <select value={tugas} onChange={(e) => setTugas(e.target.value)} className="rounded border border-white/15 bg-[#1c2127] px-2 py-1 text-[#e5e8eb]">
          <option value="rumah_sakit">Klaim rumah sakit (sulit)</option><option value="semua">Semua klaim</option>
        </select>
        <label className="flex items-center gap-1 text-[#abb3bf]">Lipatan<input type="number" min={2} max={5} value={lipatan} onChange={(e) => setLipatan(Number(e.target.value))} className="w-12 rounded border border-white/15 bg-[#1c2127] px-1.5 py-1 text-[#e5e8eb]" /></label>
        <label className="flex items-center gap-1 text-[#abb3bf]">Kode provinsi<input value={prov} onChange={(e) => setProv(e.target.value.replace(/\D/g, ""))} placeholder="semua" className="w-16 rounded border border-white/15 bg-[#1c2127] px-1.5 py-1 text-[#e5e8eb]" /></label>
        <button disabled={job?.status === "running" || !models.length} onClick={start} className="ml-auto rounded bg-[#2d72d2] px-3 py-1 font-medium text-white hover:bg-[#215db0] disabled:opacity-50">{job?.status === "running" ? "Berjalan…" : "Jalankan"}</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {MODELS.map((m) => (
          <button key={m} onClick={() => setModels((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${models.includes(m) ? "border-[#3987e5] bg-[#3987e5]/15 text-white" : "border-white/15 text-[#abb3bf]"}`}>{m}</button>
        ))}
      </div>
      {err && <p className="mt-2 text-[11.5px] text-red-300">{err}</p>}
      {job && (
        <div className="mt-3">
          <p className="text-[11px] text-[#8f99a8]">Job {job.id} · {job.status}{res?.detik ? ` · ${n0(res.detik)} s` : ""}</p>
          {job.status === "running" && <pre className="mt-1 max-h-28 overflow-auto rounded bg-black/30 p-2 text-[10.5px] text-[#abb3bf]">{job.log.slice(-6).join("\n") || "menyiapkan fitur…"}</pre>}
          {job.error && <p className="mt-1 text-[11.5px] text-red-300">{job.error}</p>}
          {res?.papan && <div className="mt-2"><Board task={{ label: res.tugas_label ?? "", papan: res.papan, evaluasi: res.evaluasi!, terbaik: res.papan.find((r) => !r.pembanding)?.model ?? "" }} /></div>}
        </div>
      )}
    </div>
  );
}

const pct = (v?: number | null, d = 1) => (v === undefined || v === null ? "—" : `${(100 * v).toLocaleString("id-ID", { maximumFractionDigits: d })}%`);
const EVIDENCE_LABEL: Record<string, string> = { semua: "Semua klaim FKRTL", rumah_sakit: "Klaim rumah sakit" };
const ci = (x: MlInterval | null | undefined, f: (v: number) => string) => (x ? `IK 95% ${f(x.bawah)}–${f(x.atas)}` : "");
const times = (v: number) => `${n0(v)}×`;
const STRATUM: Record<string, string> = { kelas: "Kelas faskes", size_bucket: "Ukuran faskes", wilayah: "Provinsi" };
const SIZE: Record<string, string> = { small: "kecil", medium: "sedang", large: "besar" };
type Target = NonNullable<MlEvidence["praregistrasi"]>["target"][number];

function targetValue(t: Target): string {
  const v = t.nilai;
  if (v === null || v === undefined) return "—";
  if (t.metrik.includes("lift")) return times(v);
  if (t.metrik.includes("rupiah") || t.metrik.startsWith("profil faskes")) return pct(v);
  if (t.metrik.startsWith("strata") || t.metrik.startsWith("kebocoran")) return n0(v);
  if (t.metrik.startsWith("ablasi")) return `${v >= 0 ? "+" : ""}${n3(v)}`;
  return n3(v);
}

/** The preregistered targets against this card, as the code checked them; a missed one stays missed. */
function Prereg({ p }: { p: NonNullable<MlEvidence["praregistrasi"]> }) {
  const met = p.target.filter((t) => t.lulus === true).length;
  const miss = p.target.filter((t) => t.lulus === false).length;
  return (
    <div className="overflow-x-auto">
      <p className="mb-0.5 text-[11.5px] font-semibold text-white">Target pra-registrasi vs hasil <span className="font-normal text-[#8f99a8]">· {met} tercapai, {miss} meleset, {p.target.length - met - miss} menunggu atau tidak berlaku</span></p>
      <p className="mb-1.5 text-[10.5px] text-[#8f99a8]">Ditetapkan di {p.berkas} (commit {p.commit}) sebelum kit dijalankan pada data penuh, untuk detektor {p.detektor_saat_itu}. Versi ini dinilai dengan ambang yang sama, tanpa diubah, dan diperiksa oleh kode; yang meleset dilaporkan apa adanya.</p>
      <table className="w-full text-[11.5px]">
        <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]"><th className="py-1">Metrik</th><th>Kartu</th><th>Ambang</th><th className="text-right">Hasil</th><th className="pl-3">Status</th><th>Catatan</th></tr></thead>
        <tbody>
          {p.target.map((t, i) => (
            <tr key={i} className="border-b border-white/[.05] align-top">
              <td className="py-1 pr-2 text-[#d3d8de]">{t.metrik}</td>
              <td className="whitespace-nowrap pr-2 text-[#abb3bf]">{t.kartu === "-" ? "—" : EVIDENCE_LABEL[t.kartu] ?? t.kartu}</td>
              <td className="pr-2 text-[#abb3bf]">{t.ambang}</td>
              <td className="whitespace-nowrap text-right tabular-nums text-white">{targetValue(t)}</td>
              <td className="whitespace-nowrap pl-3 pr-2">{t.lulus === true ? <span className="text-[#7ee2c0]">✓ tercapai</span> : t.lulus === false ? <span className="text-[#ec835a]">✗ meleset</span> : <span className="text-[#8f99a8]">· {t.ambang === "tidak berlaku" ? "tidak berlaku" : "menunggu"}</span>}</td>
              <td className="text-[10.5px] text-[#8f99a8]">{t.catatan}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Where the audits of honest facility profiles fall, per stratum (the kit's group-level burden), highest share first. */
function Strata({ rows, overall }: { rows: NonNullable<MlEvidenceCard["kartu"]["strata"]>; overall: number }) {
  const groups = Object.keys(STRATUM).map((s) => [s, rows.filter((r) => r.stratum === s).sort((a, b) => b.rate - a.rate || b.honest_groups - a.honest_groups)] as const).filter(([, r]) => r.length);
  return (
    <div>
      <p className="mb-1 text-[11.5px] font-semibold text-white">Beban audit per strata <span className="font-normal text-[#8f99a8]">· profil faskes tanpa koreksi yang ikut diaudit; rata-rata {pct(overall)}, jingga = lebih dari 3× rata-rata</span></p>
      <div className="grid items-start gap-4 md:grid-cols-3">
        {groups.map(([s, r]) => (
          <table key={s} className="w-full text-[11px]">
            <thead><tr className="border-b border-white/10 text-left text-[10px] uppercase text-[#8f99a8]"><th className="py-1">{STRATUM[s]}</th><th className="pl-2 text-right">Diaudit</th><th className="pl-2 text-right">Porsi</th></tr></thead>
            <tbody>
              {r.slice(0, 8).map((x) => (
                <tr key={x.value} className="border-b border-white/[.05]">
                  <td className="py-0.5 pr-1 text-[#d3d8de]">{s === "size_bucket" ? SIZE[x.value] ?? x.value : x.value}</td>
                  <td className="text-right tabular-nums text-[#abb3bf]">{n0(x.flagged)}/{n0(x.honest_groups)}</td>
                  <td className={`pl-2 text-right tabular-nums ${x.rate > 3 * overall ? "text-[#ec835a]" : "text-white"}`}>{pct(x.rate, 0)}</td>
                </tr>
              ))}
              {r.length > 8 && <tr><td colSpan={3} className="pt-0.5 text-[10px] text-[#8f99a8]">+{r.length - 8} lainnya di kartu lengkap</td></tr>}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}

// explained: the code's verdict; an older card without it counts an explanation that is not "belum dijelaskan"
const leakOk = (x: MlLeak) => x.dijelaskan ?? (!!x.penjelasan && !x.penjelasan.includes("belum dijelaskan"));
// numbers far below 0,001 (a permutation's null PR-AUC) with two significant digits instead of 0,000
const small = (v?: number | null) => (v && Math.abs(v) < 0.001 ? v.toLocaleString("id-ID", { maximumSignificantDigits: 2 }) : n3(v));

/** The kit's leakage scan: every column above a single-feature AUC of 0,80, with the explanation the code computed. */
function Leakage({ ev }: { ev: MlEvidence }) {
  const lists: [string, MlLeak[]][] = [["Semua klaim", ev.kebocoran_di_atas_0_8]];
  if (ev.kebocoran_rumah_sakit) lists.push(["Klaim rumah sakit", ev.kebocoran_rumah_sakit.filter((x) => x.flagged)]);
  return (
    <div className="text-[11.5px]">
      <p className="mb-1 font-semibold text-white">Pemindaian kebocoran <span className="font-normal text-[#8f99a8]">· AUC satu fitur &gt; 0,80 harus dijelaskan; jingga = belum dijelaskan</span></p>
      {lists.map(([label, xs]) => (
        <div key={label} className="mb-2">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{label}: {xs.length ? `${xs.length} fitur, ${xs.filter(leakOk).length} dijelaskan` : "tidak ada"}</p>
          <ul className="space-y-0.5">
            {xs.map((x) => (
              <li key={x.feature} className="leading-snug">
                <span className={`font-mono text-[11px] ${leakOk(x) ? "text-[#d3d8de]" : "text-[#ec835a]"}`}>{x.feature} {n3(x.auc)}</span>{" "}
                <span className="text-[#8f99a8]">{x.penjelasan || "belum dijelaskan"}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The model evidence card from the external evaluation kit, in the kit's own measures, with our honest wording. */
function Evidence({ ev, onStart }: { ev: MlEvidence | null | undefined; onStart: () => void }) {
  const [key, setKey] = useState("rumah_sakit");
  const [job, setJob] = useState<MlJob | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => aip.mlJob(job.id).then((j) => { setJob(j); if (j.status !== "running") onStart(); }).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [job, onStart]);
  const start = () => { setErr(""); aip.mlEvidence({ kapasitas: 0.001 }).then(setJob).catch((e) => setErr((e as Error).message)); };
  const c = ev?.kartu[key];
  const h = c?.kartu.headline;
  const k = c?.kartu.conditions;
  const files: [string, string][] = [["Kartu lengkap (HTML)", `bukti_${key}.html`], ["Kartu (Markdown)", `bukti_${key}.md`], ["Lembar tinjauan ahli (buta)", "review/review_sheet.csv"]];
  if (c?.daftar_audit) files.push([`Daftar audit: ${n0(c.daftar_audit.klaim)} klaim, ${n0(c.daftar_audit.dikoreksi)} dikoreksi (CSV)`, c.daftar_audit.file]);
  const iv = c?.interval;
  // every headline number with its interval (resampling whole facility profiles), as the kit's evidence slide asks
  const tiles: [string, string, string][] = h && k && c ? [
    // the kit's rule 4: the rate of positives next to every precision number
    ["precision@k", n3(h.precision), `IK 95% ${n3(h.precision_low)}–${n3(h.precision_high)} · prevalensi ${pct(k.prevalence, 3)}`],
    ["Lift vs acak", times(h.lift), [ci(iv?.lift, times), `prevalensi ${pct(k.prevalence, 3)}`].filter(Boolean).join(" · ")],
    ["Recall@k (klaim terkoreksi)", pct(iv?.recall_at_k?.nilai), ci(iv?.recall_at_k, pct1)],
    ["Recall rupiah@k", pct(h.rupiah_recall), ci(iv?.rupiah_recall, pct1) || "koreksi bernilai besar"],
    ["Faskes tanpa koreksi diaudit", pct(h.honest_audit.rate), [`${n0(h.honest_audit.flagged)} / ${n0(h.honest_audit.honest)} profil`, ci(iv?.honest_audit, pct1)].filter(Boolean).join(" · ")],
    ["Audit tanpa koreksi", n0(k.k - h.caught), `${pct(1 - h.precision)} dari ${n0(k.k)} audit; tanpa koreksi belum tentu benar`],
    ["ROC-AUC · PR-AUC", c.auc ? `${n3(c.auc.roc_auc)} · ${n3(c.auc.pr_auc)}` : "—", "seluruh populasi, skor out-of-fold"],
    ["Uji permutasi", c.kartu.permutation ? `p = ${n3(c.kartu.permutation.p_value)}` : "—",
      c.kartu.permutation ? `PR-AUC ${n3(c.kartu.permutation.observed)} vs acak ${small(c.kartu.permutation.null_mean)}` : ""],
  ] : [];
  return (
    <section className="rounded-lg border border-[#199e70]/40 bg-[#1f242b] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-white">Kartu bukti model</h3>
        <span className="text-[10.5px] text-[#8f99a8]">kit evaluasi eksternal {ev?.hkeval_commit?.slice(0, 7) ?? ""} · skor out-of-fold, prevalensi nyata, kapasitas k = {ev ? pct(ev.kapasitas) : "0,1%"}</span>
        {ev && (
          <div className="ml-auto flex gap-1 rounded bg-black/20 p-0.5 text-[11.5px]">
            {Object.keys(ev.kartu).map((x) => <button key={x} onClick={() => setKey(x)} className={`rounded px-2 py-0.5 ${key === x ? "bg-white/10 text-white" : "text-[#abb3bf]"}`}>{EVIDENCE_LABEL[x] ?? x}</button>)}
          </div>
        )}
      </div>
      {!ev || !c || !h || !k ? (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#c5cbd3]">
          <p>Belum ada kartu bukti untuk versi model ini.</p>
          <button onClick={start} disabled={job?.status === "running"} className="rounded bg-[#199e70] px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-50">{job?.status === "running" ? "Membuat…" : "Buat kartu bukti (admin)"}</button>
          {job?.status === "running" && <span className="text-[11px] text-[#8f99a8]">{job.log.slice(-1)[0] ?? "menyiapkan…"}</span>}
          {(err || job?.error) && <span className="text-[11.5px] text-red-300">{err || job?.error}</span>}
        </div>
      ) : (
        <div className="space-y-3">
          {/* where this evidence sits on the jury's map of ground truth (synthetic · expert judgement · partial real labels · designed audits) */}
          <div className="grid gap-2 text-[11.5px] leading-relaxed md:grid-cols-2">
            <div className="rounded border border-[#199e70]/40 bg-[#199e70]/10 px-3 py-2">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[#7ee2c0]">Sumber kebenaran: label nyata parsial — bukan data sintetis</p>
              <p className="text-[#d3d8de]">Klaim nyata Data Sampel BPJS; labelnya koreksi verifikator BPJS (flag_selisih_verifikasi). Nyata, tetapi tidak lengkap dan bias: hanya koreksi yang tertangkap verifikator yang berlabel. Tanpa generator.</p>
              <p className="mt-1 text-[10.5px] text-[#8f99a8]">Kondisi uji: uji internal · label nyata parsial · prevalensi {pct(k.prevalence, 3)} · kapasitas k = {pct(k.capacity)} ({n0(k.k)} klaim, asumsi) · skor out-of-fold per faskes</p>
            </div>
            <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
              <p className="text-[#d3d8de]"><b className="text-white">Membuktikan:</b> peringkat model mengalahkan pemilihan acak pada koreksi yang sudah tertangkap.</p>
              <p className="text-[#d3d8de]"><b className="text-white">Tidak membuktikan:</b> berapa banyak kecurangan yang tidak tertangkap terlewat. Itu butuh audit terancang di pilot: sebagian besar skor tinggi plus sebagian skor rendah, tiap kasus dibobot peluang terpilihnya.</p>
            </div>
          </div>
          <p className="rounded border-l-2 border-[#199e70] bg-black/20 px-3 py-2 text-[12.5px] leading-relaxed text-[#e5e8eb]">
            Dari <b>{n0(k.k)}</b> klaim yang diaudit (kapasitas asumsi {pct(k.capacity)}), <b>{n0(h.caught)}</b> (IK 95% {n0(h.caught_low)}–{n0(h.caught_high)}) memang <b>dikoreksi verifikator BPJS</b>, sedangkan pemilihan acak hanya ±{(k.k * k.prevalence).toLocaleString("id-ID", { maximumFractionDigits: k.k * k.prevalence < 10 ? 1 : 0 })}: {n0(h.lift)}× lebih baik; {pct(h.rupiah_recall)} rupiah koreksi tertangkap; {n0(h.honest_audit.flagged)} dari {n0(h.honest_audit.honest)} profil faskes tanpa klaim terkoreksi ikut diaudit.
            Angka ini <b>batas bawah</b>: klaim yang tidak dikoreksi belum tentu benar.
            <span className="mt-1 block text-[10.5px] text-[#8f99a8]">Kalimat kit untuk juri menyebut kasus positif &quot;fraud&quot; dan faskes tanpa koreksi &quot;jujur&quot;; di data ini positif berarti dikoreksi verifikator (bukan fraud terbukti), dan tanpa koreksi belum tentu jujur.</span>
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map(([l, v, s]) => (
              <div key={l} className="rounded border border-white/[.07] p-2.5"><p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{l}</p><p className="text-[16px] font-semibold tabular-nums text-white">{v}</p><p className="text-[10.5px] text-[#8f99a8]">{s}</p></div>
            ))}
          </div>
          {ev.praregistrasi && <Prereg p={ev.praregistrasi} />}
          <div className="overflow-x-auto">
            <p className="mb-1 text-[11.5px] font-semibold text-white">Ablasi (uji berpasangan, resampling per faskes) <span className="font-normal text-[#8f99a8]">· apakah model layak dipakai dibanding aturan saja, dan apa yang diurutkan antrean: peluang atau nilai · semua pada prevalensi nyata {pct(k.prevalence, 3)}, k = {n0(k.k)}</span></p>
            <table className="w-full text-[11.5px]">
              <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]"><th className="py-1">Varian</th><th className="text-right">precision@k (IK 95%)</th><th className="text-right">Recall rupiah</th><th className="text-right">Faskes tanpa koreksi diaudit</th><th className="text-right">PR-AUC</th><th className="text-right">Δ vs sebelumnya</th><th className="text-right">p</th></tr></thead>
              <tbody>
                {c.ablasi.map((a) => (
                  <tr key={a.variant} className="border-b border-white/[.05]">
                    <td className="py-1 text-[#d3d8de]">{a.variant}</td>
                    <td className="text-right tabular-nums">{n3(a.precision_at_k)} <span className="text-[#8f99a8]">({n3(a.ci_low)}–{n3(a.ci_high)})</span></td>
                    <td className="text-right tabular-nums">{pct(a.rupiah_recall)}</td><td className="text-right tabular-nums">{pct(a.honest_group_audit_rate)}</td>
                    <td className="text-right tabular-nums">{n3(a.pr_auc)}</td>
                    <td className="text-right tabular-nums">{a.diff === null || Number.isNaN(a.diff) ? "—" : `${a.diff >= 0 ? "+" : ""}${n3(a.diff)}`}</td>
                    <td className="text-right tabular-nums">{a.p_value === null || Number.isNaN(a.p_value) ? "—" : n3(a.p_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!c.kartu.strata?.length && <Strata rows={c.kartu.strata} overall={h.honest_audit.rate} />}
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <div className="overflow-x-auto">
              <p className="mb-1 text-[11.5px] font-semibold text-white">Negatif sulit (klaim tanpa koreksi yang tampak mencurigakan)</p>
              <table className="w-full text-[11.5px]">
                <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]"><th className="py-1">Kelompok</th><th className="text-right">Klaim tanpa koreksi</th><th className="text-right">Ikut ditandai</th><th className="text-right">vs rata-rata</th></tr></thead>
                <tbody>
                  {c.negatif_sulit.map((n) => (
                    <tr key={n.kelompok} className="border-b border-white/[.05]">
                      <td className="py-1 text-[#d3d8de]">{n.kelompok}</td><td className="text-right tabular-nums">{n0(n.jujur)}</td>
                      <td className="text-right tabular-nums">{n0(n.jujur_ditandai)} ({pct(n.porsi_jujur_ditandai, 3)})</td>
                      <td className="text-right tabular-nums">{n.porsi_ditandai_keseluruhan ? `${(n.porsi_jujur_ditandai / n.porsi_ditandai_keseluruhan).toLocaleString("id-ID", { maximumFractionDigits: 1 })}×` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[11.5px] text-[#c5cbd3]"><b className="text-white">Tidak berlaku di data nyata:</b> {Object.entries(ev.tidak_berlaku).map(([k2, v]) => `${k2.replace(/_/g, " ")}: ${v}`).join("; ")}. <span className="text-[#8f99a8]">Kapasitas: {ev.catatan_kapasitas}.</span></p>
            </div>
            <Leakage ev={ev} />
          </div>
          <div className="flex flex-wrap gap-2 text-[11.5px]">
            {files.map(([l, f]) => (
              <a key={f} href={`${API_URL}/api/aip/ml/bukti/${f}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10"><Icon name="external" className="h-3 w-3" />{l}</a>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const CONDITION: Record<string, string> = { baseline: "Dasar", sulit: "Sulit", jarang: "Jarang", sering: "Sering", terpusat: "Terpusat" };

/** The kit's benchmark rule 2 (api/ml_sintetis.py): known fraud types planted in the real hospital claims, the three
    dials varied one at a time, each type held out of training once, and the placebo with the fraud switched off. */
function Rule2({ r2, onDone }: { r2: MlRule2 | null | undefined; onDone: () => void }) {
  const [job, setJob] = useState<MlJob | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => aip.mlJob(job.id).then((j) => { setJob(j); if (j.status !== "running") onDone(); }).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [job, onDone]);
  const start = () => { setErr(""); aip.mlRule2().then(setJob).catch((e) => setErr((e as Error).message)); };
  const base = r2?.kondisi.baseline;
  const pl = r2?.plasebo;
  return (
    <section className="rounded-lg border border-white/10 bg-[#1f242b] p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-white">Benchmark aturan 2: fraud ditanam di klaim rumah sakit nyata</h3>
        <span className="text-[10.5px] text-[#8f99a8]">sumber kebenaran sekunder: label sintetis (lengkap, buatan) · generator ml_sintetis.py, spesifikasinya di-commit sebelum output detektor dilihat{r2 ? ` · detektor ${r2.spesifikasi.detektor}, ${r2.spesifikasi.lipatan} lipatan faskes, kapasitas ${pct(r2.spesifikasi.kapasitas)}` : ""}</span>
      </div>
      {!r2 || !base ? (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#c5cbd3]">
          <p>Belum dijalankan: 7 modus ditanam; kesulitan, frekuensi dan klaster diubah satu per satu; tiap modus sekali ditahan dari pelatihan; plasebo di klaim yang sama tanpa fraud.</p>
          <button onClick={start} disabled={job?.status === "running"} className="rounded bg-[#199e70] px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-50">{job?.status === "running" ? "Berjalan…" : "Jalankan (admin, ±1 jam)"}</button>
          {job?.status === "running" && <span className="text-[11px] text-[#8f99a8]">{job.log.slice(-1)[0] ?? "menyiapkan…"}</span>}
          {(err || job?.error) && <span className="text-[11.5px] text-red-300">{err || job?.error}</span>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <p className="mb-1 text-[11.5px] font-semibold text-white">Satu angka per kondisi <span className="font-normal text-[#8f99a8]">· tiap kondisi mengubah satu dial dari dasar; prevalensi = porsi fraud yang ditanam</span></p>
            <table className="w-full text-[11.5px]">
              <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]"><th className="py-1">Kondisi</th><th>Kesulitan · frekuensi · klaster</th><th className="text-right">Fraud ditanam (prevalensi)</th><th className="text-right">precision@k (IK 95%)</th><th className="text-right">Lift</th><th className="text-right">Recall rupiah</th><th className="text-right">PR-AUC</th><th className="text-right">ROC-AUC</th><th /></tr></thead>
              <tbody>
                {Object.entries(r2.kondisi).map(([name, v]) => {
                  const hh = v.kartu.headline;
                  return (
                    <tr key={name} className="border-b border-white/[.05]">
                      <td className="py-1 text-[#d3d8de]">{CONDITION[name] ?? name}</td>
                      <td className="text-[#abb3bf]">{v.kesulitan} · {pct(v.frekuensi)} · {v.klaster} ({n0(v.profil_pelaku)} profil pelaku)</td>
                      <td className="text-right tabular-nums">{n0(v.fraud)} <span className="text-[#8f99a8]">/ {n0(v.klaim)} ({pct(v.fraud / v.klaim, 2)})</span></td>
                      <td className="text-right tabular-nums">{n3(hh.precision)} <span className="text-[#8f99a8]">({n3(hh.precision_low)}–{n3(hh.precision_high)})</span></td>
                      <td className="text-right tabular-nums">{times(hh.lift)}</td><td className="text-right tabular-nums">{pct(hh.rupiah_recall)}</td>
                      <td className="text-right tabular-nums">{n3(v.pr_auc)}</td><td className="text-right tabular-nums">{n3(v.roc_auc)}</td>
                      <td className="pl-2 text-right"><a href={`${API_URL}/api/aip/ml/aturan2/aturan2_${name}.html`} target="_blank" rel="noreferrer" className="text-[#8abbff] hover:underline">kartu</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <p className="mb-1 text-[11.5px] font-semibold text-white">Titik lemah: recall@k per modus, dilatih vs ditahan <span className="font-normal text-[#8f99a8]">· kondisi dasar; ditahan = modus itu dikeluarkan dari pelatihan, tetap ada di data uji</span></p>
            <table className="w-full text-[11.5px]">
              <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]"><th className="py-1">Modus</th><th className="text-right">Kasus</th><th className="text-right">Bila dilatih</th><th className="text-right">Bila ditahan</th><th className="text-right">Acak (k/n)</th></tr></thead>
              <tbody>
                {Object.entries(r2.tahan).map(([m, v]) => (
                  <tr key={m} className="border-b border-white/[.05]">
                    <td className="py-1 text-[#d3d8de]">{v.label}</td><td className="text-right tabular-nums">{n0(v.kasus)}</td>
                    <td className="text-right tabular-nums">{pct(v.recall_bila_dilatih)}</td>
                    <td className={`text-right tabular-nums ${v.recall_at_k <= v.acak_k_per_n ? "text-[#ec835a]" : "text-white"}`}>{pct(v.recall_at_k)}</td>
                    <td className="text-right tabular-nums text-[#8f99a8]">{pct(v.acak_k_per_n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pl && (
            <p className="text-[11.5px] text-[#c5cbd3]"><b className="text-white">Plasebo</b> (fraud dimatikan: klaim yang sama sebelum penanaman, ambang kapasitas tetap): {n0(pl.flagged)} dari {n0(pl.n)} klaim ({pct(pl.porsi, 2)}) di {n0(pl.flagged_groups)} dari {n0(pl.groups)} profil faskes tetap melewati ambang, semuanya alarm palsu; dengan fraud ditanam, ambang yang sama memilih {n0(pl.k_tanam)} klaim.</p>
          )}
          <p className="text-[10.5px] text-[#8f99a8]">Membuktikan: detektor menangkap modus yang ditanam, dan seberapa jauh ia menangkap modus yang tidak pernah dilatih. Tidak membuktikan: kinerja pada fraud nyata (generatornya buatan tim sendiri).</p>
        </div>
      )}
    </section>
  );
}

// The kit's rule 4 (deck slide 19): precision is arithmetic on one operating point, TPR·π / (TPR·π + FPR·(1 − π)), so the
// same model reads very differently at another rate of positives. Each technique's point is its pooled out-of-fold top
// 0,1% of the benchmark: TPR = recall@k, FPR = (1 − precision@k) × 0,1% / (1 − π) at the evaluation's real rate π.
const CAP = 0.001;
const PI_LO = 1e-5, PI_HI = 0.5;
const XS = Array.from({ length: 141 }, (_, i) => 10 ** (Math.log10(PI_LO) + (i * (Math.log10(PI_HI) - Math.log10(PI_LO))) / 140));
const X_TICKS = [1e-5, 1e-4, 1e-3, 1e-2, 0.1, 0.5];
const CONTEXT = "#5f6b7a"; // the other techniques: ΔE 16 from SERIES[0] (dataviz validator); relief for its 3:1 contrast = legend values + table
type OpPoint = { model: string; p: number; tpr: number; fpr: number };
const precisionAt = (o: OpPoint, pi: number) => { const tp = o.tpr * pi, fp = o.fpr * (1 - pi); return tp + fp > 0 ? tp / (tp + fp) : 0; };
const rate = (pi: number) => `${(100 * pi).toLocaleString("id-ID", { maximumSignificantDigits: 2 })}%`;

/** Precision against the rate of positives, one line per technique; the production one leads, a legend row hovered leads instead. */
function PrevalenceChart({ task, prod }: { task: MlTask; prod: string }) {
  const { box, tip, at, clear } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const rows = task.papan.filter((r) => !r.pembanding && typeof r.gabungan_oof?.presisi_top_0_1pct === "number");
  const pi0 = rows[0]?.gabungan_oof.prevalensi ?? 0;
  if (!rows.length || !pi0) return null;
  const ops: OpPoint[] = rows.map((r) => {
    const p = r.gabungan_oof.presisi_top_0_1pct;
    return { model: r.model, p, tpr: r.gabungan_oof.recall_top_0_1pct ?? (p * CAP) / pi0, fpr: ((1 - p) * CAP) / (1 - pi0) };
  });
  const main = ops.find((o) => o.model === prod) ?? ops[0];
  const lead = ops.find((o) => o.model === focus) ?? main;
  const order = [main, ...ops.filter((o) => o !== main).sort((a, b) => precisionAt(b, pi0) - precisionAt(a, pi0))];
  const W = 1000, H = 300, L = 44, R = 24, T = 26, B = 30; // (a wide canvas: the card is ±1,200 px, so its text renders near the UI's size)
  const lx = (pi: number) => L + ((Math.log10(pi) - Math.log10(PI_LO)) / (Math.log10(PI_HI) - Math.log10(PI_LO))) * (W - L - R);
  const ly = (v: number) => T + (H - T - B) * (1 - v);
  const path = (o: OpPoint) => XS.map((pi, i) => `${i ? "L" : "M"}${lx(pi).toFixed(1)},${ly(precisionAt(o, pi)).toFixed(1)}`).join(" ");
  const marks: [number, string][] = [[pi0, "nyata"], [0.01, "1%"], [0.5, "seimbang 50:50"]];
  const table = (
    <div className="overflow-x-auto">
      <table className="w-full text-[11.5px]">
        <thead><tr className="border-b border-white/10 text-left text-[10.5px] uppercase text-[#8f99a8]">
          {["Teknik", "precision@k", "TPR (recall@k)", "FPR", `pada ${rate(pi0)} (nyata)`, "1%", "5%", "20%", "50%"].map((h, i) => <th key={h} className={`py-1 ${i ? "text-right" : ""}`}>{h}</th>)}
        </tr></thead>
        <tbody>
          {order.map((o) => (
            <tr key={o.model} className="border-b border-white/[.05] tabular-nums">
              <td className="py-1 text-[#d3d8de]">{o.model}{o === main ? " (produksi)" : ""}</td>
              <td className="text-right">{n3(o.p)}</td><td className="text-right">{n3(o.tpr)}</td><td className="text-right">{small(o.fpr)}</td>
              {[pi0, 0.01, 0.05, 0.2, 0.5].map((pi) => <td key={pi} className="text-right">{n3(precisionAt(o, pi))}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartCard title="Presisi menurut tingkat fraud (aturan 4 kit evaluasi)" table={table}
      insight={`${main.model} di kapasitas 0,1%: presisi ${n3(precisionAt(main, pi0))} pada prevalensi nyata ${rate(pi0)}. Titik operasi yang sama memberi ${n3(precisionAt(main, 0.01))} bila fraud 1%, dan ${n3(precisionAt(main, 0.5))} bila data uji dibuat seimbang 50:50: angka setinggi itu menyesatkan.`}
      source={<span>Aritmetika, bukan data: presisi = TPR·π / (TPR·π + FPR·(1 − π)). TPR dan FPR tiap teknik dari skor out-of-fold benchmark di kapasitas 0,1% (prevalensi nyata, bobot sampel). Hover garis legenda untuk menyorot teknik lain.</span>}>
      <div ref={box} className="relative" onPointerLeave={() => { clear(); setHover(null); }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Presisi tiap teknik menurut prevalensi; ${main.model} ${n3(precisionAt(main, pi0))} pada prevalensi nyata ${rate(pi0)}`}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.max(0, Math.min(XS.length - 1, Math.round(((((e.clientX - r.left) / r.width) * W - L) / (W - L - R)) * (XS.length - 1))));
            setHover(i);
            at(e, { title: `prevalensi ${rate(XS[i])}`, lines: [...ops].sort((a, b) => precisionAt(b, XS[i]) - precisionAt(a, XS[i]))
              .map((o) => ({ key: o === lead ? SERIES[0] : CONTEXT, value: n3(precisionAt(o, XS[i])), label: o.model })) });
          }}>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={ly(v)} y2={ly(v)} stroke={v === 0 ? "#383f47" : GRID} strokeWidth={1} />
              <text x={L - 6} y={ly(v) + 3} textAnchor="end" fontSize="9.5" fill={AXIS}>{v.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}</text>
            </g>
          ))}
          {X_TICKS.map((pi) => <text key={pi} x={lx(pi)} y={H - 10} textAnchor={pi === PI_HI ? "end" : pi === PI_LO ? "start" : "middle"} fontSize="9.5" fill={AXIS}>{rate(pi)}</text>)}
          <line x1={lx(pi0)} x2={lx(pi0)} y1={T - 4} y2={H - B} stroke={AXIS} strokeWidth={1} />
          <text x={lx(pi0) + 4} y={T - 8} fontSize="9.5" fill={AXIS}>prevalensi nyata {rate(pi0)}</text>
          {[...ops.filter((o) => o !== lead), lead].map((o) => (
            <path key={o.model} d={path(o)} fill="none" stroke={o === lead ? SERIES[0] : CONTEXT} strokeWidth={o === lead ? 2 : 1.25} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {marks.map(([pi, label]) => {
            const v = precisionAt(lead, pi);
            return (
              <g key={label}>
                <circle cx={lx(pi)} cy={ly(v)} r={4} fill={SERIES[0]} stroke={SURFACE} strokeWidth={2} />
                <text x={lx(pi) + (pi === PI_HI ? -8 : 8)} y={ly(v) + (v > 0.85 ? 14 : -8)} textAnchor={pi === PI_HI ? "end" : "start"} fontSize="10" fill="#e5e8eb">{label}: {n3(v)}</text>
              </g>
            );
          })}
          {hover !== null && <line x1={lx(XS[hover])} x2={lx(XS[hover])} y1={T} y2={H - B} stroke="#8f99a8" strokeWidth={1} />}
        </svg>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#c5cbd3]">
          {order.map((o) => (
            <button key={o.model} onPointerEnter={() => setFocus(o.model)} onPointerLeave={() => setFocus(null)} onFocus={() => setFocus(o.model)} onBlur={() => setFocus(null)}
              className="flex items-center gap-1.5 rounded px-1 hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30">
              <span className="h-[2px] w-3 rounded" style={{ background: o === lead ? SERIES[0] : CONTEXT }} />
              {o.model}{o === main ? " (produksi)" : ""} <span className="tabular-nums text-white">{n3(precisionAt(o, pi0))}</span>
            </button>
          ))}
        </div>
        <Tooltip tip={tip} />
      </div>
    </ChartCard>
  );
}

export function MlCard() {
  const [card, setCard] = useState<Card | null>(null);
  const [err, setErr] = useState("");
  const [task, setTask] = useState("rumah_sakit");
  const load = useCallback(() => { aip.ml().then(setCard).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <p className="p-6 text-[12px] text-red-300">{err}</p>;
  if (!card) return <p className="p-6 text-[12px] text-[#8f99a8]">Memuat kartu model…</p>;
  const lap = card.laporan;
  const t = lap?.tugas[task];
  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto max-w-[1280px] space-y-5">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">Agen Machine Learning · kartu model</p>
            <h2 className="text-[19px] font-semibold text-white">Risiko klaim dikoreksi verifikator BPJS</h2>
            <p className="mt-1 max-w-[860px] text-[12.5px] leading-relaxed text-[#c5cbd3]">
              Model supervised dilatih dengan label nyata dari data: klaim FKRTL yang dibayar kurang dari tagihannya oleh verifikator. Ini <b>risiko koreksi</b>, bukan fraud terbukti. Sembilan teknik diuji pada validasi silang yang sama (per faskes), masing-masing didukung riset deteksi fraud asuransi kesehatan; model tanpa label hanya pembanding.
            </p>
          </div>
          {card.status === "siap" && (
            <div className="text-right text-[11px] text-[#8f99a8]">
              <p>Versi {card.version} · {card.trained_at?.replace("T", " ").slice(0, 16)}</p>
              {card.model?.link && <a href={card.model.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8abbff] hover:underline"><Icon name="external" className="h-3 w-3" />Model registry v{card.model.version} (MLflow)</a>}
            </div>
          )}
        </header>

        {card.status !== "siap" || !lap ? (
          <p className="rounded-lg border border-white/10 bg-[#252a31] p-4 text-[12.5px] text-[#c5cbd3]">Model belum dilatih. Admin menjalankan pelatihan (POST /api/aip/ml/train); benchmark di bawah bisa dijalankan sekarang.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {Object.entries(lap.segmen).map(([seg, s]) => {
                const row = lap.tugas[s.tugas]?.papan.find((r) => r.model === s.model);
                return (
                  <div key={seg} className="rounded-lg border border-white/10 bg-[#252a31] p-3">
                    <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Segmen {seg === "rumah_sakit" ? "rumah sakit" : "klinik utama"}</p>
                    <p className="text-[14px] font-semibold text-white">{s.model}</p>
                    <p className="mt-1 text-[11.5px] text-[#c5cbd3]">AUPRC <b className="text-white">{n3(row?.rata.auprc?.mean)}</b> · F1 {n3(row?.rata.f1?.mean)} · recall {n3(row?.rata.recall?.mean)}</p>
                    <p className="text-[11px] text-[#8f99a8]">Ditandai {(s.porsi_ditandai * 100).toLocaleString("id-ID", { maximumFractionDigits: 3 })}% klaim · dilatih {n0(s.baris_latih)} baris ({n0(s.positif_latih)} terkoreksi)</p>
                  </div>
                );
              })}
              <div className="rounded-lg border border-white/10 bg-[#252a31] p-3">
                <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Keluaran</p>
                <p className="text-[14px] font-semibold text-white">{n0(lap.keluaran.ditandai)} klaim ditandai</p>
                <p className="mt-1 text-[11.5px] text-[#c5cbd3]"><b className="text-[#ec835a]">{n0(lap.keluaran.lolos_verifikasi_berisiko)}</b> berisiko tinggi tetapi lolos verifikasi — kandidat audit ulang</p>
                <p className="text-[11px] text-[#8f99a8]">{n0(lap.keluaran.faskes)} profil faskes dinilai</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-[#252a31] p-3">
                <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Label</p>
                <p className="text-[12px] text-[#c5cbd3]">{lap.label.keterangan}</p>
                <p className="mt-1 text-[11px] text-[#8f99a8]">92% koreksi = rawat inap klinik utama (satu aturan sudah menangkapnya); di rumah sakit hanya 0,006% klaim.</p>
              </div>
            </div>

            <section className="rounded-lg border border-white/10 bg-[#1f242b] p-4">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-white">Benchmark teknik</h3>
                <div className="ml-auto flex gap-1 rounded bg-black/20 p-0.5 text-[11.5px]">
                  {Object.entries(lap.tugas).map(([k, v]) => <button key={k} onClick={() => setTask(k)} className={`rounded px-2 py-0.5 ${task === k ? "bg-white/10 text-white" : "text-[#abb3bf]"}`}>{v.label}</button>)}
                </div>
              </div>
              {t && <Board task={t} />}
              {t && <div className="mt-4"><PrevalenceChart task={t} prod={Object.values(lap.segmen).find((s) => s.tugas === task)?.model ?? t.terbaik} /></div>}
            </section>

            {t && (
              <div className="grid gap-4 xl:grid-cols-2">
                <section className="rounded-lg border border-white/10 bg-[#1f242b] p-4">
                  <h3 className="mb-2 text-[13px] font-semibold text-white">Metode penjelasan: bukan SHAP saja</h3>
                  <Explainers task={t} />
                </section>
                <section className="space-y-4 rounded-lg border border-white/10 bg-[#1f242b] p-4">
                  {!!t.ablasi_undersampling?.length && (
                    <div>
                      <h3 className="mb-1 text-[13px] font-semibold text-white">Ablasi undersampling ({t.terbaik})</h3>
                      <p className="mb-1.5 text-[11px] text-[#8f99a8]">Hancock dkk. (2023): RUS bisa merugikan AUPRC pada data Medicare yang timpang — diuji, bukan diasumsikan.</p>
                      <table className="w-full text-[11.5px]"><tbody>{t.ablasi_undersampling.map((a) => (
                        <tr key={a.porsi_negatif_latih} className="border-b border-white/[.05]"><td className="py-1 text-[#d3d8de]">Negatif latih {(a.porsi_semua_negatif * 100).toLocaleString("id-ID")}% dari semua</td><td className="text-right tabular-nums">AUPRC {n3(a.auprc)}</td><td className="text-right tabular-nums">F1 {n3(a.f1)}</td><td className="text-right tabular-nums text-[#8f99a8]">{n0(a.baris_latih)} baris · {n0(a.detik)} s</td></tr>
                      ))}</tbody></table>
                    </div>
                  )}
                  {t.temporal && (
                    <div>
                      <h3 className="mb-1 text-[13px] font-semibold text-white">Validasi temporal (uji ≥ {t.temporal.batas_uji}, {t.temporal.positif_uji} terkoreksi)</h3>
                      <table className="w-full text-[11.5px]"><tbody>{Object.entries(t.temporal.model).map(([m, v]) => (
                        <tr key={m} className="border-b border-white/[.05]"><td className="py-1 text-[#d3d8de]">{m}</td><td className="text-right tabular-nums">AUPRC {n3(v.auprc)}</td><td className="text-right tabular-nums">AUROC {n3(v.auroc)}</td><td className="text-right tabular-nums">F1 {n3(v.f1)}</td></tr>
                      ))}</tbody></table>
                    </div>
                  )}
                  {!!t.kepentingan_global?.length && (
                    <div>
                      <h3 className="mb-1 text-[13px] font-semibold text-white">Fitur terpenting (permutation importance)</h3>
                      <ol className="space-y-0.5 text-[11.5px] text-[#d3d8de]">{t.kepentingan_global.slice(0, 8).map((g, i) => <li key={g.fitur}>{i + 1}. {g.label} <span className="text-[#8f99a8]">AUPRC −{n3(g.penurunan_auprc)}</span></li>)}</ol>
                    </div>
                  )}
                </section>
              </div>
            )}

            <Evidence ev={card.bukti} onStart={load} />
            <Rule2 r2={card.aturan2} onDone={load} />

            <section className="rounded-lg border border-white/10 bg-[#1f242b] p-4">
              <h3 className="mb-2 text-[13px] font-semibold text-white">Protokol, dan riset di baliknya</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {lap.riset_protokol.map((p) => (
                  <div key={p.keputusan} className="rounded border border-white/[.07] p-2.5">
                    <p className="text-[12px] font-medium text-white">{p.keputusan}</p>
                    <ul className="mt-1.5 space-y-1">{p.rujukan.map((r, i) => <Ref key={i} r={r} />)}</ul>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] text-[#8f99a8]">Rujukan berlabel Consensus ditemukan lewat pencarian makalah peer-review Consensus; kuota bulan ini habis setelah dua pencarian, sisanya dari pencarian web dan makalah metode aslinya.</p>
            </section>
          </>
        )}
        <JobRunner onDone={load} />
      </div>
    </div>
  );
}
