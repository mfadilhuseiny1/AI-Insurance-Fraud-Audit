"use client";

// ML Studio · Sistem ML terbaru · Perbaikan v3 (the user, 2026-11-12: "oke kerjakan, nanti update report", then "kasih report jujur
// yak angka2 nya"): the retrained model_v3_bersih (one feature path, training data without the echo) and model_v3 as served, each
// scored once on test C (generator 1, no echo) and on generator 2 with a new seed, against criteria written before the results
// (testing/kriteria_langkah4.json). Read from perbaikan_v3 in /api/ml-sistem (testing/laporan_perbaikan.py). Aggregates only.
// A candidate: /testing still serves model_v3.

import { Icon, type IconName } from "@/components/Icon";
import { ChartCard, GRID, SERIES } from "./viz";

type Hasil = { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; fpr: number; f1: number; akurasi: number; mcc: number;
  auprc: number; auroc: number; prevalensi: number; brier?: number; ece?: number; fpr_kunjungan_pertama: number; fpr_pasien_lama: number;
  rasio_kunjungan_pertama: number; recall_kunjungan_pertama: number | null; recall_pasien_lama: number | null; fpr_campuran20: number;
  porsi_kunjungan_pertama_normal: number; porsi_kunjungan_pertama_fraud: number };
type SetKey = "uji_c" | "gen2_baru" | "validasi";
type ModelKey = "model_v3_bersih" | "model_v3";
type Krit = { kunci: string; ukuran: string; nilai: number; batas: [number, number]; hasil: string; detail: Record<string, unknown> };
export type P3 = {
  dibuat: string; kriteria_ditulis: string; model: Record<ModelKey, string>;
  model_bersih: { cek_satu_jalur: { lulus?: boolean; [k: string]: unknown } | null; kartu: Record<string, unknown>;
    validasi_kunjungan_pertama: Record<string, number | null> };
  hasil: Record<SetKey, Record<ModelKey, Hasil>>; rule: Record<SetKey, { recall: number; precision: number; fpr: number }>;
  ci: Record<"uji_c" | "gen2_baru", Record<"recall" | "precision" | "fpr" | "auprc", [number, number]>>;
  chunks: Record<"uji_c" | "gen2_baru", { chunk: number; klaim: number; fraud: number; recall: number; precision: number; fpr: number }[]>;
  skema: ({ skema: string; label: string; famili: string | null } & Record<string, number | string | null>)[]; skema_bersama: string[];
  kriteria: Krit[]; vonis: { jalan_pintas: string; antar_generator: string };
  sebelum: { uji_b_dipublikasikan: { recall: number; precision: number; fpr: number }; uji_b_tanpa_skew: { recall: number; precision: number; fpr: number };
    gen2_run1_v3_lama: { recall: number; precision: number; fpr: number } };
  temuan: { ikon: string; judul: string; isi: string; nada: "baik" | "buruk" | "netral" }[];
  ukuran: Record<SetKey, { klaim: number; fraud: number; chunk: number }>; campuran_kunjungan_pertama: number;
  set_uji: Record<string, string>; aturan: string[]; batas: string[];
  per_jumlah_klaim?: Record<SetKey, Jumlah[]>;
  uji_c_tidak_valid?: { alasan: string; aturan_build_ulang: string[]; ditulis: string; klaim: number; fraud: number; porsi_normal_peserta_2plus: number;
    hasil: Record<ModelKey, { recall: number; precision: number; fpr: number; auprc: number; rasio_kunjungan_pertama: number }>; per_jumlah_klaim: Jumlah[] } | null;
};
type Jumlah = { kelompok: string; normal: number; fraud: number; fpr_model_v3_bersih: number | null; fpr_model_v3: number | null;
  recall_model_v3_bersih: number | null; recall_model_v3: number | null };

const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const BERSIH = "#199e70", LAMA = "#8f99a8";
const SET: Record<SetKey, { nama: string; warna: string }> = {
  uji_c: { nama: "Uji C (generator 1, tanpa echo)", warna: SERIES[3] },
  gen2_baru: { nama: "Generator 2, seed baru", warna: SERIES[0] },
  validasi: { nama: "Validasi (konteks)", warna: "#8f99a8" },
};
const NADA: Record<string, string> = { baik: "#199e70", buruk: "#e5484d", netral: "#c98500" };
const VONIS: Record<string, { warna: string; ikon: IconName }> = {
  konsisten: { warna: "#199e70", ikon: "check" }, sebagian: { warna: "#c98500", ikon: "alert" }, "tidak konsisten": { warna: "#e5484d", ikon: "alert" },
};
const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);

function Tabel({ kepala, baris }: { kepala: string[]; baris: (string | number)[][] }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-left text-[11.5px]">
        <thead className="sticky top-0 bg-[#1c2127] text-[#8f99a8]"><tr>{kepala.map((k) => <th key={k} className="px-2 py-1.5 font-medium">{k}</th>)}</tr></thead>
        <tbody>{baris.map((b, i) => <tr key={i} className="border-t border-white/[.05] text-[#d3d8de]">{b.map((c, j) => <td key={j} className="px-2 py-1 tabular-nums">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Legenda({ items }: { items: [string, string][] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#c5cbd3]">{items.map(([w, l]) => <span key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: w }} />{l}</span>)}</div>;
}

function Batang({ nilai, warna, label, maks = 1 }: { nilai: number | null | undefined; warna: string; label?: string; maks?: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full" style={{ background: GRID }}>
        {nilai != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1, Math.min(100, (nilai / maks) * 100))}%`, background: warna }} />}
      </div>
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label ?? (nilai == null ? "—" : pct(nilai, 0))}</span>
    </div>
  );
}

function Chip({ hasil }: { hasil: string }) {
  const v = VONIS[hasil] ?? VONIS.sebagian;
  return <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium" style={{ background: `${v.warna}26`, color: v.warna }}><Icon name={v.ikon} className="h-3 w-3" />{hasil}</span>;
}

export function PerbaikanV3({ p }: { p: P3 }) {
  const sets: SetKey[] = ["uji_c", "gen2_baru", "validasi"];
  const ukuranKpi: [string, keyof Hasil, number, number][] = [["Recall", "recall", 1, 1], ["Precision", "precision", 1, 1], ["AUPRC", "auprc", 1, 3],
    ["Klaim normal ditandai", "fpr", 0, 2]];
  const cek = p.model_bersih.cek_satu_jalur;
  const s = p.sebelum, gb = p.hasil.gen2_baru.model_v3_bersih, uc = p.hasil.uji_c.model_v3_bersih;
  return (
    <div className="space-y-4">
      <section className={`${box} flex flex-wrap items-center gap-3 p-4`}>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: `${BERSIH}33`, color: "#7ee2c0" }}><Icon name="restore" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">v3 bersih · kandidat, belum dipakai /testing · {p.dibuat}</p>
          <h2 className="text-[16px] font-semibold text-white">Setelah perbaikan: satu jalur fitur, data latih tanpa echo, v3 dilatih ulang</h2>
          <p className="text-[11.5px] text-[#abb3bf]">Dinilai sekali pada uji C ({id(p.ukuran.uji_c.klaim)} klaim, {id(p.ukuran.uji_c.fraud)} fraud) dan generator 2 seed baru ({id(p.ukuran.gen2_baru.klaim)} klaim, {id(p.ukuran.gen2_baru.fraud)} fraud). Kriteria ditulis sebelum hasil ada.</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-[#abb3bf]">
          <span className="flex items-center gap-1.5">Jalan pintas pasien baru <Chip hasil={p.vonis.jalan_pintas} /></span>
          <span className="flex items-center gap-1.5">Antar generator <Chip hasil={p.vonis.antar_generator} /></span>
        </div>
        <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">Data sintetis</span>
      </section>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {p.temuan.map((t) => (
          <div key={t.judul} className={`${box} flex gap-2.5 p-3`}>
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: `${NADA[t.nada]}26`, color: NADA[t.nada] }}><Icon name={(t.ikon as IconName) || "info"} className="h-4 w-4" /></span>
            <div className="min-w-0"><p className="text-[12px] font-semibold leading-snug text-white">{t.judul}</p><p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{t.isi}</p></div>
          </div>
        ))}
      </div>

      <ChartCard title="Metrik: v3 bersih vs v3 lama di tiap set" insight="Hijau = v3 bersih (dilatih ulang), abu = v3 lama seperti dilayani sekarang (dilatih pada fitur jalur lama). Ambang masing-masing seperti saat dilatih."
        table={<Tabel kepala={["Set", "Model", "Recall", "Precision", "FPR", "FPR ditimbang 20%", "AUPRC", "F1", "MCC"]} baris={sets.flatMap((k) => (["model_v3_bersih", "model_v3"] as ModelKey[]).map((m) => {
          const h = p.hasil[k][m]; return [SET[k].nama, p.model[m], pct(h.recall), pct(h.precision), pct(h.fpr, 2), pct(h.fpr_campuran20, 2), id(h.auprc, 3), id(h.f1, 3), id(h.mcc, 3)]; }))} />}>
        <div className="grid gap-4 lg:grid-cols-3">
          {sets.map((k) => (
            <div key={k} className="rounded-md border border-white/[.07] p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-white"><span className="h-2.5 w-2.5 rounded-full" style={{ background: SET[k].warna }} />{SET[k].nama}</p>
              <p className="mb-2 text-[10.5px] text-[#8f99a8]">{id(p.ukuran[k].klaim)} klaim · fraud {pct(p.hasil[k].model_v3_bersih.prevalensi)}</p>
              <div className="space-y-2">
                {ukuranKpi.map(([lab, key, , d]) => {
                  const a = p.hasil[k].model_v3_bersih[key] as number, b = p.hasil[k].model_v3[key] as number;
                  const maks = key === "fpr" ? Math.max(0.01, a, b) * 1.2 : 1;
                  const fmt = (v: number) => (key === "auprc" ? id(v, 3) : pct(v, d));
                  return (
                    <div key={key}>
                      <p className="text-[11px] text-[#abb3bf]">{lab}</p>
                      <Batang nilai={a} warna={BERSIH} maks={maks} label={fmt(a)} />
                      <Batang nilai={b} warna={LAMA} maks={maks} label={fmt(b)} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3"><Legenda items={[[BERSIH, p.model.model_v3_bersih], [LAMA, p.model.model_v3]]} /></div>
      </ChartCard>

      <ChartCard title="Kriteria yang ditulis sebelum hasil" insight={`${p.kriteria_ditulis}. Vonis = hasil terburuk.`}
        table={<Tabel kepala={["Kriteria", "Ukuran", "Nilai", "Batas konsisten / sebagian", "Hasil"]} baris={p.kriteria.map((k) => [k.kunci, k.ukuran, id(k.nilai, 2), `${id(k.batas[0], 1)} / ${id(k.batas[1], 1)}`, k.hasil])} />}>
        <div className="space-y-2.5">
          {p.kriteria.map((k) => (
            <div key={k.kunci} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1.2fr) 80px 130px" }}>
              <div className="min-w-0"><p className="truncate text-[12px] text-white" title={k.ukuran}>{k.ukuran}</p>
                <p className="truncate text-[10.5px] text-[#8f99a8]">{Object.entries(k.detail).filter(([, v]) => typeof v === "number").map(([n, v]) => `${n.replace("_", " ")} ${(v as number) < 1.5 && k.kunci !== "K1_jalan_pintas" ? pct(v as number, 2) : id(v as number, 2)}`).join(" · ")}</p></div>
              <div className="relative h-3 rounded-full" style={{ background: GRID }}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (k.nilai / (k.batas[1] * 1.5)) * 100)}%`, background: (VONIS[k.hasil] ?? VONIS.sebagian).warna }} />
                <span className="absolute inset-y-0 w-px bg-white/50" style={{ left: `${(k.batas[0] / (k.batas[1] * 1.5)) * 100}%` }} title={`batas konsisten ${k.batas[0]}`} />
                <span className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${(k.batas[1] / (k.batas[1] * 1.5)) * 100}%` }} title={`batas sebagian ${k.batas[1]}`} />
              </div>
              <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">{id(k.nilai, 2)}</span>
              <Chip hasil={k.hasil} />
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Pasien baru vs pasien lama: klaim normal yang ditandai" insight="Sebelum perbaikan, v3 menandai ~72% klaim normal pasien baru di generator 2. Garis tipis = v3 lama pada set yang sama."
          table={<Tabel kepala={["Set", "Model", "FPR kunjungan pertama", "FPR pasien lama", "Rasio", "Porsi kunjungan pertama (normal)"]} baris={sets.flatMap((k) => (["model_v3_bersih", "model_v3"] as ModelKey[]).map((m) => {
            const h = p.hasil[k][m]; return [SET[k].nama, p.model[m], pct(h.fpr_kunjungan_pertama, 2), pct(h.fpr_pasien_lama, 2), `${id(h.rasio_kunjungan_pertama, 1)}×`, pct(h.porsi_kunjungan_pertama_normal)]; }))} />}>
          <div className="space-y-3">
            {sets.map((k) => {
              const a = p.hasil[k].model_v3_bersih, b = p.hasil[k].model_v3;
              const maks = Math.max(0.02, a.fpr_kunjungan_pertama, a.fpr_pasien_lama) * 1.25;
              return (
                <div key={k}>
                  <p className="mb-1 flex items-center gap-1.5 text-[11.5px] text-white"><span className="h-2 w-2 rounded-full" style={{ background: SET[k].warna }} />{SET[k].nama}
                    <span className="ml-auto text-[10.5px] text-[#8f99a8]">rasio {id(a.rasio_kunjungan_pertama, 1)}× · v3 lama {id(b.rasio_kunjungan_pertama, 1)}×</span></p>
                  <div className="grid items-center gap-2" style={{ gridTemplateColumns: "120px 1fr" }}>
                    <span className="text-[11px] text-[#abb3bf]">kunjungan pertama</span><Batang nilai={a.fpr_kunjungan_pertama} warna={BERSIH} maks={maks} label={pct(a.fpr_kunjungan_pertama, 2)} />
                    <span className="text-[11px] text-[#abb3bf]">pasien lama</span><Batang nilai={a.fpr_pasien_lama} warna={BERSIH} maks={maks} label={pct(a.fpr_pasien_lama, 2)} />
                  </div>
                  <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">v3 lama: {pct(b.fpr_kunjungan_pertama, 1)} vs {pct(b.fpr_pasien_lama, 2)} · recall fraud kunjungan pertama {pct(a.recall_kunjungan_pertama, 0)}, pasien lama {pct(a.recall_pasien_lama, 0)}</p>
                </div>
              );
            })}
          </div>
        </ChartCard>
        <ChartCard title="Sebelum dan sesudah" insight="Angka v3 lama yang dulu dipublikasikan, angka yang sama tanpa bug pembulatan, dan v3 bersih pada set baru."
          table={<Tabel kepala={["Ukuran", "Recall", "Precision", "FPR"]} baris={[
            ["Uji B, v3 lama (dipublikasikan)", pct(s.uji_b_dipublikasikan.recall), pct(s.uji_b_dipublikasikan.precision), pct(s.uji_b_dipublikasikan.fpr, 2)],
            ["Uji B, v3 lama tanpa bug pembulatan", pct(s.uji_b_tanpa_skew.recall), pct(s.uji_b_tanpa_skew.precision), pct(s.uji_b_tanpa_skew.fpr, 2)],
            ["Generator 2 run 1, v3 lama", pct(s.gen2_run1_v3_lama.recall), pct(s.gen2_run1_v3_lama.precision), pct(s.gen2_run1_v3_lama.fpr, 2)],
            ["Uji C, v3 bersih", pct(uc.recall), pct(uc.precision), pct(uc.fpr, 2)], ["Generator 2 seed baru, v3 bersih", pct(gb.recall), pct(gb.precision), pct(gb.fpr, 2)]]} />}>
          <div className="space-y-2.5">
            {([["Uji B · v3 lama (dipublikasikan)", s.uji_b_dipublikasikan, LAMA], ["Uji B · v3 lama tanpa bug", s.uji_b_tanpa_skew, LAMA], ["Gen 2 run 1 · v3 lama", s.gen2_run1_v3_lama, LAMA],
              ["Uji C · v3 bersih", uc, BERSIH], ["Gen 2 seed baru · v3 bersih", gb, BERSIH]] as [string, { recall: number; precision: number; fpr: number }, string][]).map(([n, v, w]) => (
              <div key={n} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0, 190px) 1fr 1fr 70px" }}>
                <span className={`truncate text-[11.5px] ${w === BERSIH ? "font-semibold text-white" : "text-[#c5cbd3]"}`}>{n}</span>
                <Batang nilai={v.recall} warna={w === BERSIH ? SERIES[2] : "#5f6b7a"} label={`R ${pct(v.recall, 0)}`} />
                <Batang nilai={v.precision} warna={w === BERSIH ? SERIES[1] : "#5f6b7a"} label={`P ${pct(v.precision, 0)}`} />
                <span className="text-right text-[11px] tabular-nums text-[#d3d8de]">FPR {pct(v.fpr, 2)}</span>
              </div>
            ))}
            <Legenda items={[[SERIES[2], "Recall"], [SERIES[1], "Precision"], ["#5f6b7a", "v3 lama"]]} />
          </div>
        </ChartCard>
      </div>

      {p.per_jumlah_klaim && (
        <ChartCard title="Klaim normal ditandai menurut jumlah klaim peserta di jendela" insight="Bila FPR naik seiring kunjungan berulang di generator 2 (perjalanan pasien alami), kunjungan berulang adalah kelemahan model, bukan artefak uji."
          table={<Tabel kepala={["Set", "Kelompok", "Klaim normal", "FPR v3 bersih", "FPR v3 lama", "Fraud", "Recall v3 bersih"]} baris={sets.flatMap((k) => (p.per_jumlah_klaim?.[k] ?? []).map((j) =>
            [SET[k].nama, j.kelompok, id(j.normal), pct(j.fpr_model_v3_bersih, 2), pct(j.fpr_model_v3, 2), id(j.fraud), pct(j.recall_model_v3_bersih)]))} />}>
          <div className="grid gap-4 lg:grid-cols-3">
            {sets.map((k) => {
              const rows = p.per_jumlah_klaim?.[k] ?? [];
              const maks = Math.max(0.01, ...rows.map((j) => j.fpr_model_v3_bersih ?? 0)) * 1.2;
              return (
                <div key={k}>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-white"><span className="h-2 w-2 rounded-full" style={{ background: SET[k].warna }} />{SET[k].nama}</p>
                  <div className="space-y-1.5">{rows.map((j) => (
                    <div key={j.kelompok} className="grid items-center gap-2" style={{ gridTemplateColumns: "70px 1fr" }}>
                      <span className="text-[11px] text-[#abb3bf]">{j.kelompok}</span>
                      <div><Batang nilai={j.fpr_model_v3_bersih} warna={BERSIH} maks={maks} label={pct(j.fpr_model_v3_bersih, 2)} />
                        <p className="text-[10px] text-[#8f99a8]">{id(j.normal)} normal</p></div>
                    </div>))}</div>
                </div>
              );
            })}
          </div>
        </ChartCard>
      )}

      {p.uji_c_tidak_valid && (
        <section className="rounded-lg border border-[#e5484d]/30 bg-[#e5484d]/[.06] p-3.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="bug" className="h-4 w-4 text-[#ff9592]" />Build uji C yang tidak valid (dilaporkan, tidak dipakai untuk kriteria)</h3>
          <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">{p.uji_c_tidak_valid.alasan}</p>
          <div className="mt-2.5 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[11.5px] text-[#abb3bf]">Angka build itu ({id(p.uji_c_tidak_valid.klaim)} klaim, {id(p.uji_c_tidak_valid.fraud)} fraud; {pct(p.uji_c_tidak_valid.porsi_normal_peserta_2plus, 0)} klaim normal dari peserta dengan 2+ klaim)</p>
              <Tabel kepala={["Model", "Recall", "Precision", "FPR", "Rasio pasien baru"]} baris={(["model_v3_bersih", "model_v3"] as ModelKey[]).map((m) => {
                const h = p.uji_c_tidak_valid!.hasil[m]; return [p.model[m], pct(h.recall), pct(h.precision), pct(h.fpr, 2), `${id(h.rasio_kunjungan_pertama, 1)}×`]; })} />
              <p className="mt-2 text-[11px] text-[#abb3bf]">FPR v3 bersih menurut jumlah klaim peserta di jendela</p>
              <div className="mt-1 space-y-1">{p.uji_c_tidak_valid.per_jumlah_klaim.map((j) => (
                <div key={j.kelompok} className="grid items-center gap-2" style={{ gridTemplateColumns: "70px 1fr" }}>
                  <span className="text-[11px] text-[#abb3bf]">{j.kelompok}</span>
                  <Batang nilai={j.fpr_model_v3_bersih} warna="#e5484d" maks={Math.max(0.05, ...p.uji_c_tidak_valid!.per_jumlah_klaim.map((x) => x.fpr_model_v3_bersih ?? 0)) * 1.1} label={pct(j.fpr_model_v3_bersih, 1)} />
                </div>))}</div>
            </div>
            <div>
              <p className="mb-1.5 text-[11.5px] text-[#abb3bf]">Aturan build ulang, ditulis {p.uji_c_tidak_valid.ditulis}</p>
              <ul className="space-y-1">{p.uji_c_tidak_valid.aturan_build_ulang.map((x) => <li key={x} className="flex gap-1.5 text-[11px] leading-snug text-[#c5cbd3]"><Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-[#7ee2c0]" />{x}</li>)}</ul>
            </div>
          </div>
        </section>
      )}

      <ChartCard title="Recall per skema, v3 bersih" insight="Kuning = uji C, biru = generator 2 seed baru. Skema yang ada di kedua set dipakai untuk kriteria K5."
        table={<Tabel kepala={["Skema", "n uji C", "Uji C bersih", "Uji C lama", "n gen 2", "Gen 2 bersih", "Gen 2 lama"]} baris={p.skema.map((r) => [r.label, id((r.n_uji_c as number) || 0), pct(r.recall_uji_c_model_v3_bersih as number | null),
          pct(r.recall_uji_c_model_v3 as number | null), id((r.n_gen2_baru as number) || 0), pct(r.recall_gen2_baru_model_v3_bersih as number | null), pct(r.recall_gen2_baru_model_v3 as number | null)])} />}>
        <div className="grid gap-x-6 gap-y-2.5 lg:grid-cols-2">
          {[...p.skema].sort((a, b) => ((a.recall_gen2_baru_model_v3_bersih as number) ?? (a.recall_uji_c_model_v3_bersih as number) ?? 0) - ((b.recall_gen2_baru_model_v3_bersih as number) ?? (b.recall_uji_c_model_v3_bersih as number) ?? 0)).map((r) => (
            <div key={r.skema} className="grid items-center gap-x-3" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)" }}>
              <div className="min-w-0"><p className="truncate text-[12px] text-white" title={r.label}>{r.label}</p>
                <p className="text-[10px] text-[#8f99a8]">{p.skema_bersama.includes(r.skema) ? "ada di kedua set · " : ""}n {id((r.n_uji_c as number) || 0)} / {id((r.n_gen2_baru as number) || 0)}</p></div>
              <div className="space-y-1">
                {(r.n_uji_c as number) > 0 && <Batang nilai={r.recall_uji_c_model_v3_bersih as number} warna={SET.uji_c.warna} />}
                {(r.n_gen2_baru as number) > 0 && <Batang nilai={r.recall_gen2_baru_model_v3_bersih as number} warna={SET.gen2_baru.warna} />}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3"><Legenda items={[[SET.uji_c.warna, SET.uji_c.nama], [SET.gen2_baru.warna, SET.gen2_baru.nama]]} /></div>
      </ChartCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={`${box} space-y-2 p-3.5`}>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="check" className="h-4 w-4 text-[#7ee2c0]" />Cek perbaikan</h3>
          <ul className="space-y-1 text-[11px] leading-snug text-[#c5cbd3]">
            <li>Satu jalur fitur: hitungan batch dan per klaim identik bit per bit (testing/test_fitur_satu_jalur.py).</li>
            <li>Cek model v3 bersih: {cek ? (cek.lulus ? "lulus" : "tidak lulus") : "—"} (split di dalam derau pembulatan dan snap pada keputusan validasi; testing/model_v3_bersih/cek_satu_jalur.json).</li>
            <li>Data latih tanpa echo: klaim asli dihapus dari riwayat di setiap chunk; peserta latih, validasi, uji C dan generator 2 baru dipisah dengan peran tetap.</li>
            <li>Validasi: FPR kunjungan pertama {pct(p.model_bersih.validasi_kunjungan_pertama.fpr_kunjungan_pertama as number, 2)} vs pasien lama {pct(p.model_bersih.validasi_kunjungan_pertama.fpr_pasien_lama as number, 2)}.</li>
          </ul>
          <h3 className="flex items-center gap-1.5 pt-1 text-[13px] font-semibold text-white"><Icon name="sliders" className="h-4 w-4 text-[#8abbff]" />Aturan</h3>
          <ul className="space-y-1 text-[11px] leading-snug text-[#c5cbd3]">{p.aturan.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
        <section className={`${box} space-y-2 p-3.5`}>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="info" className="h-4 w-4 text-[#f0c661]" />Batas</h3>
          <ul className="space-y-1">{p.batas.map((x) => <li key={x} className="flex gap-1.5 text-[11px] leading-snug text-[#c5cbd3]"><Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0 text-[#f0c661]" />{x}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
