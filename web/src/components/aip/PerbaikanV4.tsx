"use client";

// ML Studio · Sistem ML terbaru · v4 (2026-11-13): the frozen v4 candidate (variant B: v3 features + mechanism features X4, LightGBM,
// two-tier decision set on validation) scored ONCE on generator 3 (independent, headline), test C2 and generator 2 seed 3. Read from
// v4_final in /api/ml-sistem (testing/v4_final.py). Aggregates only. A candidate: /testing still serves model_v3.

import { Icon, type IconName } from "@/components/Icon";
import { ChartCard, GRID, SERIES } from "./viz";

type Tier = { recall: number; fpr: number; presisi_mentah: number; presisi_prev: Record<string, number>; ditandai: number; ci?: { recall: [number, number]; fpr: [number, number] } };
type Hasil = { klaim: number; fraud: number; prevalensi: number; mutu_terpisah: { klaim: number; ditandai_periksa: number } | null;
  periksa: Tier & { fpr_kunjungan_pertama: number; fpr_pasien_lama: number; recall_per_skema: Record<string, number> }; tahan: Tier;
  tanpa_ambang: { auprc: number; auroc: number }; v3_bersih: Tier; v3_lama: Tier };
export type V4 = {
  dibuat: string; model: { varian: string; dibekukan: string; latih: { baris: number; fraud: number }; aturan_v4: { aturan: string }[];
    validasi: { periksa: { recall: number; fpr: number }; tahan: { recall: number; fpr: number } } };
  hasil: Record<string, Hasil>; kriteria_antar_generator: { kunci: string; nilai: number | null; batas: [number, number]; hasil: string }[] | null; catatan: string[];
};

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const SET: [string, string, string, string][] = [["generator3", "Generator 3", "independen · angka utama", SERIES[4]], ["uji_c2", "Uji C2", "generator 1 · pendukung", SERIES[3]],
  ["gen2_seed3", "Generator 2 seed 3", "pendukung", SERIES[0]]];
const VONIS: Record<string, string> = { konsisten: "#199e70", sebagian: "#c98500", "tidak konsisten": "#e5484d" };
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);

function Bar({ v, w, label, target }: { v: number; w: string; label: string; target?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, v * 100))}%`, background: w }} />
        {target !== undefined && <span className="absolute inset-y-[-3px] w-px bg-white/70" style={{ left: `${target * 100}%` }} title={`target ${pct(target, 0)}`} />}
      </div>
      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label}</span>
    </div>
  );
}

export function PerbaikanV4({ v }: { v: V4 }) {
  const m = v.model;
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="layers" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">v4 · kandidat, belum dipakai /testing · dibekukan {m.dibekukan} · dinilai {v.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">v4 (varian {m.varian}: fitur v3 + fitur mekanisme X4), dinilai sekali di tiga set baru</h2>
          <p className="text-[11.5px] text-[#abb3bf]">Dilatih pada {id(m.latih.baris)} klaim ({id(m.latih.fraud)} fraud). Ambang dua tingkat dari klaim normal validasi: periksa recall {pct(m.validasi.periksa.recall)} pada FPR {pct(m.validasi.periksa.fpr, 2)}, tahan recall {pct(m.validasi.tahan.recall)} pada FPR {pct(m.validasi.tahan.fpr, 2)}.</p>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        {SET.map(([k, nama, ket, w]) => {
          const h = v.hasil[k];
          if (!h) return null;
          const p = h.periksa, t = h.tahan;
          return (
            <ChartCard key={k} title={`${nama} · ${ket}`} insight={`${id(h.klaim)} klaim, ${id(h.fraud)} fraud (${pct(h.prevalensi)}). Garis putih = target.`}
              table={<table className="w-full text-[11.5px]"><tbody className="text-[#d3d8de]">
                {[["Periksa recall", pct(p.recall)], ["Periksa FPR", pct(p.fpr, 2)], ["Periksa precision (fraud 2%)", pct(p.presisi_prev["0.02"])], ["Tahan recall", pct(t.recall)],
                  ["Tahan precision (fraud 2%)", pct(t.presisi_prev["0.02"])], ["AUPRC", id(h.tanpa_ambang.auprc, 3)], ["v3 bersih recall", pct(h.v3_bersih.recall)], ["v3 lama recall", pct(h.v3_lama.recall)]]
                  .map(([a, b]) => <tr key={a} className="border-t border-white/[.05]"><td className="px-2 py-1">{a}</td><td className="px-2 py-1 text-right tabular-nums">{b}</td></tr>)}</tbody></table>}>
              <div className="space-y-2">
                <p className="text-[11px] text-[#abb3bf]">Periksa (antrean verifikator)</p>
                <Bar v={p.recall} w={w} label={`recall ${pct(p.recall, 0)}`} target={0.8} />
                <Bar v={p.presisi_prev["0.02"]} w={SERIES[1]} label={`prec ${pct(p.presisi_prev["0.02"], 0)}`} target={0.8} />
                <p className="text-[10.5px] text-[#8f99a8]">FPR {pct(p.fpr, 2)} (target ≤ 1%) · 95% recall {pct(p.ci?.recall[0], 0)}–{pct(p.ci?.recall[1], 0)}</p>
                <p className="pt-1 text-[11px] text-[#abb3bf]">Tahan otomatis</p>
                <Bar v={t.recall} w={w} label={`recall ${pct(t.recall, 0)}`} />
                <Bar v={t.presisi_prev["0.02"]} w={SERIES[1]} label={`prec ${pct(t.presisi_prev["0.02"], 0)}`} target={0.9} />
                <p className="text-[10.5px] text-[#8f99a8]">FPR {pct(t.fpr, 2)} (target ≤ 0,1%) · AUPRC {id(h.tanpa_ambang.auprc, 3)}</p>
                <p className="pt-1 text-[11px] text-[#abb3bf]">Dibanding v3 (recall pada ambang masing-masing)</p>
                <Bar v={h.v3_bersih.recall} w="#5f6b7a" label={`v3 bersih ${pct(h.v3_bersih.recall, 0)}`} />
                <Bar v={h.v3_lama.recall} w="#3b434d" label={`v3 lama ${pct(h.v3_lama.recall, 0)}`} />
                <p className="pt-1 text-[10.5px] text-[#8f99a8]">Normal ditandai: pasien baru {pct(p.fpr_kunjungan_pertama, 2)} vs pasien lama {pct(p.fpr_pasien_lama, 2)}
                  {h.mutu_terpisah ? ` · ${id(h.mutu_terpisah.klaim)} klaim mutu (pulang dini) dipisah, ${pct(h.mutu_terpisah.ditandai_periksa, 0)} ditandai` : ""}</p>
              </div>
            </ChartCard>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        {v.hasil.generator3 && (
          <ChartCard title="Generator 3: recall per skema (periksa)" insight="Skema yang tidak pernah ada di data latih paling sering lolos; mekanisme baru butuh contoh, rule, atau AI."
            table={<table className="w-full text-[11.5px]"><tbody className="text-[#d3d8de]">{Object.entries(v.hasil.generator3.periksa.recall_per_skema).sort((a, b) => a[1] - b[1])
              .map(([s, r]) => <tr key={s} className="border-t border-white/[.05]"><td className="px-2 py-1">{s}</td><td className="px-2 py-1 text-right tabular-nums">{pct(r)}</td></tr>)}</tbody></table>}>
            <div className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">{Object.entries(v.hasil.generator3.periksa.recall_per_skema).sort((a, b) => a[1] - b[1]).map(([s, r]) => (
              <div key={s} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)" }}>
                <span className="truncate text-[11px] text-[#d3d8de]" title={s}>{s.replace(/_/g, " ")}</span><Bar v={r} w={SERIES[4]} label={pct(r, 0)} />
              </div>))}</div>
          </ChartCard>
        )}
        <section className={`${box} space-y-2 p-3.5`}>
          <h3 className="text-[13px] font-semibold text-white">Konsisten antar generator? (generator 3 vs uji C2)</h3>
          {(v.kriteria_antar_generator ?? []).map((k) => (
            <div key={k.kunci} className="flex items-center justify-between gap-2 text-[11.5px]">
              <span className="text-[#d3d8de]">{k.kunci.replace(/_/g, " ")}</span>
              <span className="tabular-nums text-[#abb3bf]">{k.nilai === null ? "—" : id(k.nilai, 2)}</span>
              <span className="rounded px-2 py-0.5 text-[11px]" style={{ background: `${VONIS[k.hasil] ?? "#8f99a8"}26`, color: VONIS[k.hasil] ?? "#c5cbd3" }}>{k.hasil}</span>
            </div>))}
          <h3 className="flex items-center gap-1.5 pt-2 text-[13px] font-semibold text-white"><Icon name={"info" as IconName} className="h-4 w-4 text-[#f0c661]" />Catatan</h3>
          <ul className="space-y-1">{v.catatan.map((c) => <li key={c} className="text-[11px] leading-snug text-[#c5cbd3]">{c}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
