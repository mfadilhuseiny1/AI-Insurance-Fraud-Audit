"use client";

// ML Studio · Sistem ML terbaru · "v5": v4 (variant B, frozen) + the rule engine + an AI Agent Swarm on Google ADK (three specialists
// in parallel and a judge, DeepSeek V4.1 Flash on Vertex AI) for the uncertain claims. Thresholds chosen on validation, then a fresh
// generator 3 seed (GEN3_GARAM=gen3-v5) scored ONCE (testing/v5.py, testing/kriteria_v5.json). Aggregates of synthetic data only.

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ChartCard, GRID, SERIES } from "./viz";

type Uk = { recall: number; fpr: number; presisi_prev2: number; presisi_mentah: number; ditandai: number };
type CI = { recall: [number, number]; fpr: [number, number]; presisi_prev2: [number, number] };
type Mutu = { n: number; fraud: number; auroc_koding?: number; auroc_tagihan?: number; auroc_episode?: number; auroc_hakim?: number; auroc_model_B?: number;
  hist_p: { batas: number[]; fraud: number[]; normal: number[] } };
type Biaya = { usd_perkiraan: number; panggilan: number; token_masuk: number; token_keluar: number; throttle?: number };
export type V5 = {
  dibuat: string; set: string;
  model: { pilihan: string; tau: number; ambang: { tahan: number; periksa_v4: number; lebar: number }; kandidat: Record<string, Uk & { tau: number }>;
    validasi: { v4_B: Uk; v5: Uk; v5_lebar_p05: Uk; ragu: { klaim: number; fraud: number }; swarm: Mutu } };
  hasil: { klaim: number; fraud: number; prevalensi: number; ragu: number; ragu_fraud: number; ragu_tanpa_jawaban_swarm: number;
    v4_B: Uk; v4_plus_rule: Uk; v5: Uk; v5_lebar_p05: Uk; tahan: Uk; selisih_v5_vs_v4_ci: CI; selisih_lebar_vs_v4_ci: CI;
    fpr_kunjungan_pertama: Record<string, number>; fpr_pasien_lama: Record<string, number>;
    per_skema: Record<string, Record<string, number>>; n_skema: Record<string, number>;
    swarm_di_zona_ragu: Mutu & { fraud_dipertahankan_p05: number; normal_dibuang_p05: number } };
  adopsi: { aturan: string; lolos: boolean };
  biaya_swarm: Record<string, Biaya>;
};

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const W = { v4: SERIES[0], rule: "#8f99a8", v5: SERIES[2], lebar: SERIES[3] };

function Chip({ children, warna = "#8f99a8", garis = false }: { children: ReactNode; warna?: string; garis?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
    style={{ background: garis ? "transparent" : `${warna}22`, color: warna, borderColor: garis ? `${warna}88` : undefined }}>{children}</span>;
}
function Bar({ v, w, label }: { v: number; w: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, v * 100))}%`, background: w }} />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label}</span>
    </div>
  );
}
function Delta({ d, baik, digit = 1 }: { d: number; baik: "naik" | "turun"; digit?: number }) {
  const bagus = baik === "naik" ? d > 0.0005 : d < -0.0005, buruk = baik === "naik" ? d < -0.0005 : d > 0.0005;
  return <Chip warna={bagus ? "#7ee2c0" : buruk ? "#f0c661" : "#c5cbd3"}>{d >= 0 ? "+" : "−"}{id(Math.abs(d) * 100, digit)} poin</Chip>;
}

// ---------------------------------------------------------------- flow
function Kotak({ ikon, judul, sub, warna = "#8f99a8", putus = false }: { ikon: IconName; judul: string; sub: string; warna?: string; putus?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-1 items-start gap-2 rounded-md border bg-[#151a1f] px-2.5 py-2 ${putus ? "border-dashed" : ""}`} style={{ borderColor: `${warna}66` }}>
      <span className="mt-0.5 shrink-0" style={{ color: warna }}><Icon name={ikon} className="h-4 w-4" /></span>
      <div className="min-w-0"><p className="text-[11.5px] font-semibold text-white">{judul}</p><p className="text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p></div>
    </div>
  );
}
const Panah = () => <Icon name="right" className="hidden h-4 w-4 shrink-0 self-center text-[#5f6b7a] md:block" />;

function Alur({ m }: { m: V5["model"] }) {
  return (
    <section className={`${box} space-y-3 p-4`}>
      <h3 className="text-[13px] font-semibold text-white">Alur v5</h3>
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <Kotak ikon="upload" judul="Klaim (batch)" sub="fitur graph + mekanisme X4" />
        <Panah />
        <Kotak ikon="cpu" judul="Model v4 (B)" sub="LightGBM × 3 seed, beku" warna={SERIES[0]} />
        <Panah />
        <div className="flex min-w-[170px] flex-col gap-1.5">
          <div className="rounded border border-[#e5484d66] px-2 py-1"><p className="text-[11px] font-semibold text-[#ff8a8d]">TAHAN</p><p className="text-[10px] text-[#8f99a8]">skor sangat tinggi · tanpa swarm</p></div>
          <div className="rounded border border-[#c9850066] px-2 py-1"><p className="text-[11px] font-semibold text-[#f0c661]">RAGU → swarm</p><p className="text-[10px] text-[#8f99a8]">skor ≥ ambang lebar (FPR 3%) atau rule menyala</p></div>
          <div className="rounded border border-[#5f6b7a66] px-2 py-1"><p className="text-[11px] font-semibold text-[#c5cbd3]">LOLOS</p><p className="text-[10px] text-[#8f99a8]">sisanya</p></div>
        </div>
        <Panah />
        <div className="flex min-w-0 flex-[2] flex-col gap-1.5 rounded-md border border-dashed p-2" style={{ borderColor: `${SERIES[2]}88` }}>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white"><span style={{ color: SERIES[2] }}><Icon name="constellation" className="h-4 w-4" /></span>AI Agent Swarm · Google ADK
            <Chip warna="#c5cbd3" garis>Vertex AI</Chip></p>
          <div className="grid grid-cols-3 gap-1.5">
            {([["Koding & klinis", "upcoding, dx sekunder, LOS"], ["Tagihan", "top-up, tagihan > paket"], ["Episode & jaringan", "readmisi, kloning, kartu"]] as const).map(([j, s]) => (
              <div key={j} className="rounded border border-white/[.08] bg-[#1c2127] px-1.5 py-1"><p className="text-[10.5px] font-medium text-white">{j}</p><p className="text-[9.5px] text-[#8f99a8]">{s}</p></div>))}
          </div>
          <p className="text-center text-[10px] text-[#8f99a8]">paralel ↓</p>
          <div className="rounded border border-white/[.12] bg-[#1c2127] px-2 py-1 text-center"><p className="text-[10.5px] font-medium text-white">Hakim → peluang fraud p</p>
            <p className="text-[9.5px] text-[#8f99a8]">{m.pilihan === "V5b" ? "(p + persentil skor) / 2" : "p"} ≥ {id(m.tau, 2)} → PERIKSA, selain itu LOLOS</p></div>
        </div>
      </div>
      <p className="text-[10.5px] text-[#8f99a8]">Agen hanya membaca berkas fakta dari fitur (tanpa skor model, label, atau nama skema). Ambang dipilih di validasi dengan FPR total ≤ 1%.</p>
    </section>
  );
}

// ---------------------------------------------------------------- results on the fresh set
function Kartu({ nama, u, w, dasar, ci, catatan }: { nama: string; u: Uk; w: string; dasar?: Uk; ci?: CI; catatan?: string }) {
  return (
    <section className={`${box} space-y-2 p-3`} style={{ borderTop: `2px solid ${w}` }}>
      <div className="flex items-center justify-between gap-1"><p className="truncate text-[12px] font-semibold text-white">{nama}</p>
        {dasar && <Delta d={u.recall - dasar.recall} baik="naik" />}</div>
      <p className="text-[26px] font-semibold leading-none tabular-nums text-white">{pct(u.recall)}</p>
      <p className="text-[10.5px] text-[#8f99a8]">recall · FPR {pct(u.fpr, 2)}</p>
      {ci && <p className="text-[10px] text-[#8f99a8]">95% CI selisih recall {id(ci.recall[0] * 100, 1)} s/d {id(ci.recall[1] * 100, 1)} poin</p>}
      <Bar v={u.presisi_prev2} w={SERIES[1]} label={`prec ${pct(u.presisi_prev2, 0)}`} />
      {dasar && <div className="flex flex-wrap items-center gap-1"><span className="text-[10px] text-[#8f99a8]">precision</span><Delta d={u.presisi_prev2 - dasar.presisi_prev2} baik="naik" />
        <span className="text-[10px] text-[#8f99a8]">FPR</span><Delta d={u.fpr - dasar.fpr} baik="turun" digit={2} /></div>}
      <p className="text-[10px] text-[#8f99a8]">ditandai {id(u.ditandai)} klaim{catatan ? ` · ${catatan}` : ""}</p>
    </section>
  );
}

function Hasil({ v }: { v: V5 }) {
  const h = v.hasil;
  return (
    <div className="space-y-3">
      <div className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${v.adopsi.lolos ? "border-[#199e70]/50 bg-[#199e70]/[.08]" : "border-white/[.12] bg-white/[.03]"}`}>
        <Icon name={v.adopsi.lolos ? "check" : "info"} className={`h-4 w-4 ${v.adopsi.lolos ? "text-[#7ee2c0]" : "text-[#c5cbd3]"}`} />
        <span className="text-[11.5px] text-white">{v.adopsi.lolos ? "v5 lolos aturan adopsi pra-registrasi: v5 menjadi sistem terbaru" : "v5 tidak lolos aturan adopsi pra-registrasi: v4 tetap sistem terbaru"}</span>
        <Chip warna="#c5cbd3" garis>{h.klaim.toLocaleString("id-ID")} klaim · {h.fraud} fraud · dinilai sekali</Chip>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Kartu nama="v4 (B)" u={h.v4_B} w={W.v4} />
        <Kartu nama="v4 + rule engine" u={h.v4_plus_rule} w={W.rule} dasar={h.v4_B} />
        <Kartu nama="v5 · + swarm (FPR ≤ 1%)" u={h.v5} w={W.v5} dasar={h.v4_B} ci={h.selisih_v5_vs_v4_ci} catatan="titik terpilih" />
        <Kartu nama="v5 lebar · swarm p ≥ 0,5" u={h.v5_lebar_p05} w={W.lebar} dasar={h.v4_B} ci={h.selisih_lebar_vs_v4_ci} catatan="tanpa anggaran FPR" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the swarm inside the uncertain zone
function MutuSwarm({ val, baru }: { val: Mutu; baru: Mutu & { fraud_dipertahankan_p05: number; normal_dibuang_p05: number } }) {
  const agen: [string, keyof Mutu][] = [["Spesialis koding", "auroc_koding"], ["Spesialis tagihan", "auroc_tagihan"], ["Spesialis episode", "auroc_episode"], ["Hakim (keputusan swarm)", "auroc_hakim"], ["Model B (pembanding)", "auroc_model_B"]];
  const mx = Math.max(1, ...baru.hist_p.fraud.map((f, i) => f + baru.hist_p.normal[i]));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title="Di zona RAGU: seberapa baik tiap agen membedakan fraud vs normal (AUROC)"
        insight="0,5 = menebak; 1,0 = sempurna. Dihitung hanya pada klaim RAGU, tempat swarm bekerja."
        table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Agen</th><th className="px-2 py-1 text-right">Validasi</th><th className="px-2 py-1 text-right">Set baru</th></tr></thead>
          <tbody className="text-[#d3d8de]">{agen.map(([n, k]) => <tr key={n} className="border-t border-white/[.05]"><td className="px-2 py-1">{n}</td><td className="px-2 py-1 text-right tabular-nums">{val[k] !== undefined ? id(val[k] as number, 3) : "—"}</td>
            <td className="px-2 py-1 text-right tabular-nums">{baru[k] !== undefined ? id(baru[k] as number, 3) : "—"}</td></tr>)}</tbody></table>}>
        <div className="space-y-2">
          {agen.map(([n, k]) => {
            const a = baru[k] as number | undefined, b = val[k] as number | undefined;
            const x = (z: number) => `${Math.max(0, Math.min(1, (z - 0.4) / 0.6)) * 100}%`;
            return (
              <div key={n} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 170px) minmax(0, 1fr) 92px" }}>
                <span className="truncate text-[11px] text-[#d3d8de]">{n}</span>
                <div className="relative h-4 rounded" style={{ background: GRID }}>
                  <span className="absolute inset-y-0 w-px bg-white/30" style={{ left: x(0.5) }} title="0,5 = menebak" />
                  {b !== undefined && <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#8f99a8]" style={{ left: x(b) }} title={`validasi ${id(b, 3)}`} />}
                  {a !== undefined && <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1c2127]" style={{ left: x(a), background: k === "auroc_model_B" ? SERIES[0] : SERIES[2] }} title={`set baru ${id(a, 3)}`} />}
                </div>
                <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{a !== undefined ? id(a, 3) : "—"}</span>
              </div>
            );
          })}
          <p className="flex flex-wrap gap-3 text-[10px] text-[#8f99a8]"><span>● set baru</span><span>○ validasi</span><span>skala 0,4–1,0 · garis = 0,5</span></p>
        </div>
      </ChartCard>
      <ChartCard title="Peluang fraud dari hakim · klaim RAGU di set baru"
        insight={`Dengan p ≥ 0,5: ${pct(baru.fraud_dipertahankan_p05, 0)} fraud dipertahankan, ${pct(baru.normal_dibuang_p05, 0)} klaim normal dibuang dari antrean.`}
        table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">p</th><th className="px-2 py-1 text-right">Fraud</th><th className="px-2 py-1 text-right">Normal</th></tr></thead>
          <tbody className="text-[#d3d8de]">{baru.hist_p.fraud.map((f, i) => <tr key={i} className="border-t border-white/[.05]"><td className="px-2 py-1">{id(baru.hist_p.batas[i], 1)}–{id(baru.hist_p.batas[i + 1], 1)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{f}</td><td className="px-2 py-1 text-right tabular-nums">{baru.hist_p.normal[i]}</td></tr>)}</tbody></table>}>
        <div className="flex h-40 items-end gap-1.5">
          {baru.hist_p.fraud.map((f, i) => {
            const n = baru.hist_p.normal[i];
            return (
              <div key={i} className="flex h-full flex-1 flex-col justify-end" title={`p ${id(baru.hist_p.batas[i], 1)}–${id(baru.hist_p.batas[i + 1], 1)}: ${f} fraud, ${n} normal`}>
                {f > 0 && <div className="rounded-t-sm" style={{ height: `${(f / mx) * 100}%`, background: SERIES[1] }} />}
                {n > 0 && <div className={`${f > 0 ? "mt-0.5" : "rounded-t-sm"}`} style={{ height: `${(n / mx) * 100}%`, background: "#5f6b7a" }} />}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-[#8f99a8]"><span>p 0</span><span>0,5</span><span>1</span></div>
        <p className="mt-1 flex flex-wrap gap-3 text-[10px] text-[#8f99a8]"><span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: SERIES[1] }} />fraud</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#5f6b7a]" />normal</span></p>
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------- per scheme
function PerSkema({ h }: { h: V5["hasil"] }) {
  const s = Object.keys(h.per_skema.v4_B).filter((k) => (h.n_skema[k] ?? 0) >= 20)
    .map((k) => ({ k, d: (h.per_skema.v5[k] ?? 0) - (h.per_skema.v4_B[k] ?? 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
  if (!s.length) return null;
  return (
    <ChartCard title="Set baru · skema yang paling berubah (recall), ≥ 20 klaim fraud" insight="v4 (B) vs v4 + rule vs v5."
      table={<table className="w-full text-[11.5px]"><thead className="text-[#8f99a8]"><tr><th className="px-2 py-1 text-left">Skema</th><th className="px-2 py-1 text-right">n</th><th className="px-2 py-1 text-right">v4</th><th className="px-2 py-1 text-right">+rule</th><th className="px-2 py-1 text-right">v5</th></tr></thead>
        <tbody className="text-[#d3d8de]">{Object.keys(h.per_skema.v4_B).map((k) => <tr key={k} className="border-t border-white/[.05]"><td className="px-2 py-1">{k}</td><td className="px-2 py-1 text-right tabular-nums">{h.n_skema[k] ?? "—"}</td>
          {(["v4_B", "v4_plus_rule", "v5"] as const).map((x) => <td key={x} className="px-2 py-1 text-right tabular-nums">{pct(h.per_skema[x][k])}</td>)}</tr>)}</tbody></table>}>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
        {s.map(({ k }) => (
          <div key={k} className="space-y-1">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#d3d8de]"><span className="truncate">{k.replace(/_/g, " ")}</span><Chip>n {h.n_skema[k]}</Chip></p>
            <Bar v={h.per_skema.v4_B[k] ?? 0} w={W.v4} label={`v4 ${pct(h.per_skema.v4_B[k], 0)}`} />
            <Bar v={h.per_skema.v4_plus_rule[k] ?? 0} w={W.rule} label={`+rule ${pct(h.per_skema.v4_plus_rule[k], 0)}`} />
            <Bar v={h.per_skema.v5[k] ?? 0} w={W.v5} label={`v5 ${pct(h.per_skema.v5[k], 0)}`} />
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

// ---------------------------------------------------------------- cost + takeaways
function BiayaKartu({ v }: { v: V5 }) {
  const b = v.biaya_swarm, tot = Object.values(b).reduce((s, x) => s + (x.usd_perkiraan || 0), 0);
  const call = Object.values(b).reduce((s, x) => s + (x.panggilan || 0), 0);
  return (
    <section className={`${box} space-y-2 p-4`}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="server" className="h-4 w-4 text-[#9ec5ff]" />Biaya swarm (Vertex AI)</h3>
      <p className="text-[26px] font-semibold tabular-nums text-white">${id(tot, 2)}</p>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(b).map(([k, x]) => <Chip key={k}>{k === "validasi" ? "validasi" : "set baru"} ${id(x.usd_perkiraan, 2)} · {id(x.panggilan)} panggilan</Chip>)}
        <Chip warna="#c5cbd3" garis>{id(call)} panggilan model · 4 per batch 8 klaim</Chip>
      </div>
      <p className="text-[10.5px] text-[#8f99a8]">Dihitung dari token × harga daftar Vertex (DeepSeek V4.1 Flash). Hanya klaim RAGU yang dibaca swarm: {pct(v.hasil.ragu / v.hasil.klaim, 1)} dari semua klaim.</p>
    </section>
  );
}

function Kesimpulan({ v }: { v: V5 }) {
  const h = v.hasil, sw = h.swarm_di_zona_ragu;
  const items: [IconName, string, string][] = [
    [v.adopsi.lolos ? "check" : "info", v.adopsi.lolos ? "#7ee2c0" : "#c5cbd3",
      `Set baru (dinilai sekali): v4 ${pct(h.v4_B.recall)} / prec ${pct(h.v4_B.presisi_prev2, 0)} → v5 ${pct(h.v5.recall)} / prec ${pct(h.v5.presisi_prev2, 0)} pada FPR ${pct(h.v5.fpr, 2)}.`],
    ["logic", "#c5cbd3", `Rule engine saja: recall ${pct(h.v4_plus_rule.recall)} tapi FPR ${pct(h.v4_plus_rule.fpr, 2)}. Swarm menyaring antrean RAGU (${id(h.ragu)} klaim).`],
  ];
  if (sw.auroc_hakim !== undefined && sw.auroc_model_B !== undefined) {
    items.push(["constellation", SERIES[2], `Di zona RAGU, hakim AUROC ${id(sw.auroc_hakim, 3)} vs model B ${id(sw.auroc_model_B, 3)}: ${sw.auroc_hakim > sw.auroc_model_B + 0.01 ? "swarm menambah informasi di klaim yang ragu" : "swarm belum lebih tajam dari model di klaim yang ragu"}.`]);
  }
  const vv = v.model.validasi, vs = vv.swarm;
  items.push(["alert", "#f0c661", `Tapi di validasi (mirip data latih) v5 LEBIH BURUK: recall ${pct(vv.v5.recall)} vs v4 ${pct(vv.v4_B.recall)}; hakim AUROC ${vs.auroc_hakim !== undefined ? id(vs.auroc_hakim, 2) : "—"} vs model ${vs.auroc_model_B !== undefined ? id(vs.auroc_model_B, 2) : "—"}. Swarm membantu saat data bergeser dari data latih, bukan di data yang mirip.`]);
  const up = Object.keys(h.per_skema.v4_B).filter((k) => (h.n_skema[k] ?? 0) >= 20 && (h.per_skema.v5[k] ?? 0) < (h.per_skema.v4_B[k] ?? 0) - 0.05);
  if (up.length) items.push(["eye", "#9ec5ff", `Turun di: ${up.map((k) => `${k.replace(/_/g, " ")} (${pct(h.per_skema.v4_B[k], 0)} → ${pct(h.per_skema.v5[k], 0)})`).join(", ")}. FPR pasien baru ${pct(h.fpr_kunjungan_pertama.v4_B, 1)} → ${pct(h.fpr_kunjungan_pertama.v5, 1)}.`]);
  items.push(["info", "#9ec5ff", "Data sintetis. Swarm membaca fakta dari fitur, bukan dokumen klinis asli; di data nyata ia bisa membaca rekam medis, tapi itu belum diuji."]);
  return (
    <section className={`${box} space-y-2 p-4`}>
      <h3 className="text-[13px] font-semibold text-white">Kesimpulan jujur</h3>
      {items.map(([ik, w, t]) => <div key={t} className="flex items-start gap-2"><span className="mt-0.5 shrink-0" style={{ color: w }}><Icon name={ik} className="h-4 w-4" /></span><p className="text-[11.5px] leading-snug text-[#d3d8de]">{t}</p></div>)}
    </section>
  );
}

export function SistemV5({ v }: { v: V5 }) {
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#199e70]/20 text-[#7ee2c0]"><Icon name="constellation" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">v5 · {v.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">v4 + rule engine + AI Agent Swarm untuk klaim ragu</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip warna="#7ee2c0">Google ADK · 3 spesialis + hakim</Chip><Chip>Vertex AI · DeepSeek V4.1 Flash</Chip>
            <Chip warna="#c5cbd3" garis>dinilai sekali di generator 3 seed baru</Chip>
          </div>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>
      <Alur m={v.model} />
      <Hasil v={v} />
      <MutuSwarm val={v.model.validasi.swarm} baru={v.hasil.swarm_di_zona_ragu} />
      <PerSkema h={v.hasil} />
      <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]"><BiayaKartu v={v} /><Kesimpulan v={v} /></div>
    </div>
  );
}
