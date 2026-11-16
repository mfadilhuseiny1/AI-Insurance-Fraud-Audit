"use client";

// ML Studio · Laporan Generator 2 (the user, 2026-11-12: "bikin report lengkap uji generator 2, gpp jelek tapi jujur",
// "report generator 2 simpen di ML studio", "node mana yg menyumbang hasil precision & recall bagus, node mana yg jelek di
// arsitektur, biar tau mana yg harus diperbaiki"). Read from /api/ml-sistem:
//   generator2       v3 on generator 2's claims vs test B (testing/laporan_gen2.py), its charts are the appendix (GeneratorDua);
//   generator2_node  every v3 node on generator 2 and test B, as run and with the rounding-skew diagnostic (testing/node_gen2.py);
//   arsitektur_v3    test A, for the overview of every v3 test.
// Aggregates only, synthetic data only. The node verdicts below were judged on the run of generator2_node.dibuat; the numbers
// in them are read from the data, so a re-run updates the numbers, not the judgement.

import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ChartCard, SERIES } from "./viz";
import { GeneratorDua, type G2 } from "./GeneratorDua";
import { PerbaikanV3, type P3 } from "./PerbaikanV3";

type M = { tp: number; fp: number; recall: number; precision: number; fpr: number };
type Jalur = M & { unik_tp: number; unik_fp: number; fp_kunjungan_pertama: number; tanpa: { recall: number; precision: number; fpr: number } };
type Lap = { auprc: number | null; auroc: number | null; n_famili?: number; auprc_famili?: number | null; auprc_famili_model1?: number | null };
type Fam = { famili: string; n: number; recall: number; model: number; rute: number; jaringan: number; engine: number };
type Mode = { keputusan: M; engine: M; lapisan: Record<string, Lap>; fusi: { auprc: number | null; auroc: number | null };
  jalur: Record<"model" | "rute" | "jaringan", Jalur>; famili: Fam[] };
type Kumpulan = { klaim: number; fraud: number; normal: number; normal_kunjungan_pertama: number; raw: Mode; snap: Mode };
export type G2Node = {
  dibuat: string; model: string; ambang_peluang: number; bobot_fusi: Record<string, number>;
  split_bulat: Record<string, { split: number; split_total: number; gain_pct: number; bising: number; bising_gain_pct: number }>;
  kolom_bulat: number; data: Record<"gen2" | "uji_b", Kumpulan>; cek: Record<string, [number, number]>; cek_beda: Record<string, [number, number]>;
};
type Doc = { generator2?: G2; generator2_node?: G2Node; perbaikan_v3?: P3; arsitektur_v3?: { uji_a: { v3: { recall: number; precision: number; fpr: number; auprc: number } } } };

const G1 = SERIES[3];          // generator 1: test A, test B
const GEN2 = SERIES[0];        // generator 2
const M1 = SERIES[1];          // Model 1 (as in the v3 flow)
const SPES = "#9d7bd8";        // the four specialists (as in the v3 flow)
const HIJAU = "#199e70", MERAH = "#e5484d", AMBER = "#c98500", ABU = "#8f99a8";
const box = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const SPESIALIS = ["koding", "tagihan", "episode", "identitas"] as const;
const NAMA_FAM: Record<string, string> = { koding: "Coding", tagihan: "Tagihan", episode: "Episode", identitas: "Identitas", jaringan: "Jaringan" };

const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const n3 = (v?: number | null) => (v === undefined || v === null ? "—" : id(v, 3));
const garis = (w: string) => `repeating-linear-gradient(135deg, ${w} 0 3px, ${w}40 3px 6px)`;

// ------------------------------------------------------------------------------------------------------------ small parts

function Tabel({ kepala, baris }: { kepala: string[]; baris: (string | number)[][] }) {
  return (
    <div className="max-h-[440px] overflow-auto">
      <table className="w-full text-left text-[11.5px]">
        <thead className="sticky top-0 bg-[#1c2127] text-[#8f99a8]"><tr>{kepala.map((k) => <th key={k} className="px-2 py-1.5 font-medium">{k}</th>)}</tr></thead>
        <tbody>{baris.map((b, i) => <tr key={i} className="border-t border-white/[.05] text-[#d3d8de]">{b.map((c, j) => <td key={j} className="px-2 py-1 tabular-nums">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Legenda({ items }: { items: { w: string; l: string; gaya?: "garis" | "cincin" }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#c5cbd3]">
      {items.map(({ w, l, gaya }) => (
        <span key={l} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={gaya === "cincin" ? { border: `2px solid ${w}` } : { background: gaya === "garis" ? garis(w) : w }} />{l}
        </span>
      ))}
    </div>
  );
}

/** One bar on a 0..maks track, value on the right; striped for a diagnostic (not the running system). */
function Batang({ v, maks = 1, warna, label, kanan, diagnostik }: { v: number; maks?: number; warna: string; label: string; kanan?: string; diagnostik?: boolean }) {
  return (
    <div className="grid items-center gap-2 text-[11px]" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) 58px" }} title={`${label}: ${kanan ?? pct(v)}`}>
      <span className="truncate text-[#dfe3e8]">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-white/[.06]">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(0.8, Math.min(1, v / maks) * 100)}%`, background: diagnostik ? garis(warna) : warna }} /></span>
      <span className="text-right tabular-nums text-white">{kanan ?? pct(v)}</span>
    </div>
  );
}

/** Generator 2 and test B for one measure, two thin bars. */
function Dua({ label, g, b, maks = 1, fmt = (v: number) => pct(v) }: { label: string; g: number | null; b: number | null; maks?: number; fmt?: (v: number) => string }) {
  const bar = (v: number | null, w: string, nm: string) => (
    <div className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0,1fr) 52px" }} title={`${label} · ${nm}: ${v === null ? "—" : fmt(v)}`}>
      <span className="h-2 overflow-hidden rounded-full bg-white/[.06]"><span className="block h-full rounded-full" style={{ width: `${v === null ? 0 : Math.max(0.8, Math.min(1, v / maks) * 100)}%`, background: w }} /></span>
      <span className="text-right text-[10.5px] tabular-nums text-[#dfe3e8]">{v === null ? "—" : fmt(v)}</span>
    </div>
  );
  return (
    <div>
      <p className="mb-0.5 text-[10.5px] text-[#abb3bf]">{label}</p>
      <div className="space-y-0.5">{bar(g, GEN2, "generator 2")}{bar(b, G1, "test B")}</div>
    </div>
  );
}

type Vonis = "membantu" | "terbuang" | "bermasalah" | "campuran" | "lemah" | "belum";
const VONIS: Record<Vonis, { w: string; ikon: IconName; teks: string }> = {
  membantu: { w: HIJAU, ikon: "check", teks: "Membantu" },
  terbuang: { w: "#3987e5", ikon: "info", teks: "Bagus, tak terpakai" },
  bermasalah: { w: MERAH, ikon: "alert", teks: "Bermasalah" },
  campuran: { w: AMBER, ikon: "split", teks: "Campuran" },
  lemah: { w: AMBER, ikon: "minus", teks: "Hampir tak menambah" },
  belum: { w: ABU, ikon: "info", teks: "Belum diuji" },
};

function KartuNode({ ikon, warna, nama, teknik, vonis, children, kenapa, perbaiki }: { ikon: IconName; warna: string; nama: string; teknik: string; vonis: Vonis;
  children?: ReactNode; kenapa: string; perbaiki: string }) {
  const v = VONIS[vonis];
  return (
    <div className="flex min-w-0 flex-col rounded-lg border bg-[#1c2127] p-3" style={{ borderColor: vonis === "belum" ? "rgba(255,255,255,.07)" : `${v.w}55` }}>
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: `${warna}26`, color: warna }}><Icon name={ikon} className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold leading-tight text-white">{nama}</p>
          <p className="truncate text-[10.5px] text-[#8f99a8]">{teknik}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]" style={{ borderColor: `${v.w}66`, color: v.w }}>
          <Icon name={v.ikon} className="h-3 w-3" />{v.teks}</span>
      </div>
      {children && <div className="mt-2.5 space-y-2">{children}</div>}
      <p className="mt-2.5 text-[11px] leading-snug text-[#c5cbd3]">{kenapa}</p>
      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-white"><Icon name="right" className="mt-px h-3.5 w-3.5 shrink-0 text-[#8abbff]" />{perbaiki}</p>
    </div>
  );
}

function Pilih<T extends string>({ nilai, set, opsi }: { nilai: T; set: (v: T) => void; opsi: [T, string][] }) {
  return (
    <div className="flex rounded border border-white/10 p-0.5 text-[11px]">
      {opsi.map(([k, l]) => <button key={k} type="button" onClick={() => set(k)} aria-pressed={nilai === k}
        className={`rounded-sm px-2 py-0.5 ${nilai === k ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{l}</button>)}
    </div>
  );
}

function Judul({ ikon, children, sub }: { ikon: IconName; children: ReactNode; sub?: string }) {
  return (
    <div className="flex items-center gap-3 pt-3">
      <span className="h-px flex-1 bg-white/10" />
      <p className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center text-[13px] font-semibold text-white"><Icon name={ikon} className="h-4 w-4 text-[#8abbff]" />{children}
        {sub && <span className="font-normal text-[#8f99a8]">· {sub}</span>}</p>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------ sections

function SemuaUji({ g, n, ujiA }: { g: G2; n: G2Node; ujiA?: { recall: number; precision: number; fpr: number } }) {
  const G = n.data.gen2, B = n.data.uji_b;
  const baris: { nama: string; ket: string; w: string; diag?: boolean; m: { recall: number; precision: number; fpr: number } }[] = [
    ...(ujiA ? [{ nama: "Test A", ket: "generator 1, sudah dipakai memilih versi", w: G1, m: ujiA }] : []),
    { nama: "Test B", ket: "generator 1, angka resmi v3", w: G1, m: B.raw.keputusan },
    { nama: "Test B tanpa bug", ket: "diagnosis", w: G1, diag: true, m: B.snap.keputusan },
    { nama: "Generator 2", ket: `${id(g.klaim)} klaim baru`, w: GEN2, m: G.raw.keputusan },
    { nama: "Generator 2 tanpa bug", ket: "diagnosis", w: GEN2, diag: true, m: G.snap.keputusan },
  ];
  const panel = (judul: string, k: "recall" | "precision" | "fpr", maks: number, d: number) => (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11.5px] font-medium text-white">{judul}</p>
      <div className="space-y-1.5">{baris.map((x) => <Batang key={x.nama} v={x.m[k]} maks={maks} warna={x.w} label={x.nama} kanan={pct(x.m[k], d)} diagnostik={x.diag} />)}</div>
    </div>
  );
  return (
    <ChartCard title="Semua uji v3: angka bagus hanya muncul di data generator 1"
      insight="Test A dan test B dibuat generator yang sama dengan data latih. Generator 2 dibuat dengan cara lain, dan di situ v3 jatuh. Garis miring = diagnosis tanpa bug pembulatan (nilai feature disamakan), bukan sistem yang berjalan."
      table={<Tabel kepala={["Uji", "Keterangan", "Recall", "Precision", "Normal ditandai"]} baris={baris.map((x) => [x.nama, x.ket, pct(x.m.recall), pct(x.m.precision), pct(x.m.fpr, 2)])} />}
      source={<span>test A: arsitektur_v3.json · test B & generator 2: generator2_node.json (cocok dengan generator2.json)</span>}>
      <Legenda items={[{ w: G1, l: "Generator 1 (test A, test B)" }, { w: GEN2, l: "Generator 2" }, { w: ABU, l: "tanpa bug pembulatan (diagnosis)", gaya: "garis" }]} />
      <div className="mt-3 grid gap-4 md:grid-cols-3">{panel("Recall", "recall", 1, 1)}{panel("Precision", "precision", 1, 1)}{panel("Klaim normal ditandai", "fpr", 0.2, 2)}</div>
    </ChartCard>
  );
}

function NodeNode({ g, n }: { g: G2; n: G2Node }) {
  const gr = n.data.gen2.raw, gs = n.data.gen2.snap, br = n.data.uji_b.raw;
  const sp = n.split_bulat;
  const mdl = gr.jalur.model, fpTot = Math.max(1, gr.keputusan.fp);
  const ringG = gr.famili.find((f) => f.famili === "jaringan"), ringGs = gs.famili.find((f) => f.famili === "jaringan");
  const ringB = br.famili.find((f) => f.famili === "jaringan");
  const kal = g.kalibrasi.gen2.length ? g.kalibrasi.gen2[g.kalibrasi.gen2.length - 1] : null;
  const famTerbaik = SPESIALIS.map((k) => ({ k, s: gr.lapisan[k]?.auprc_famili ?? 0, m: gr.lapisan[k]?.auprc_famili_model1 ?? 0 })).sort((a, b) => b.s - a.s)[0];
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <KartuNode ikon="doc" warna={ABU} nama="Klaim + entity resolution" teknik="Rule + Jaro-Winkler (fuzzy nama)" vonis="belum"
        kenapa="Kedua generator memakai nomor peserta yang persis sama, jadi fuzzy matching nama, no RM dan SEP tidak pernah diuji di sini."
        perbaiki="Buat data uji dengan nama dan no RM yang sengaja berbeda tipis, lalu ukur salah gabung dan salah pisah." />

      <KartuNode ikon="bolt" warna={AMBER} nama="Engine realtime" teknik="Rule engine · 45 rule + feature klaim" vonis="membantu"
        kenapa={`Paling tahan: precision rule saja ${pct(gr.engine.precision)} di generator 2 dan ${pct(br.engine.precision)} di test B. Keputusan PERIKSA/TAHAN-nya tidak dipakai langsung oleh v3, hanya jadi feature (skor rule adalah feature terbesar Model 1).`}
        perbaiki="Uji keputusan rule sebagai jalur sendiri di keputusan akhir, di data uji baru.">
        <Dua label="Recall, rule saja" g={gr.engine.recall} b={br.engine.recall} />
        <Dua label="Precision, rule saja" g={gr.engine.precision} b={br.engine.precision} />
      </KartuNode>

      <KartuNode ikon="layers" warna={SPES} nama="4 spesialis Permenkes" teknik="LightGBM monoton · per keluarga" vonis="terbuang"
        kenapa={`Di generator 2 spesialis jauh lebih baik dari Model 1 di keluarganya sendiri (${NAMA_FAM[famTerbaik.k]}: AUPRC ${n3(famTerbaik.s)} vs ${n3(famTerbaik.m)}), dan hampir tidak terpengaruh bug. Tapi fusion hanya memberi mereka ${pct(SPESIALIS.reduce((s, k) => s + (n.bobot_fusi[k] ?? 0), 0))} bobot, jadi kekuatannya terbuang.`}
        perbaiki="Masalahnya ada di fusion, bukan di spesialis: beri mereka bobot lewat fusion yang dilatih ulang.">
        {SPESIALIS.map((k) => (
          <div key={k}>
            <p className="mb-0.5 text-[10.5px] text-[#abb3bf]">{NAMA_FAM[k]} · AUPRC di keluarganya, generator 2</p>
            <Batang v={gr.lapisan[k]?.auprc_famili ?? 0} warna={SPES} label="spesialis" kanan={n3(gr.lapisan[k]?.auprc_famili)} />
            <Batang v={gr.lapisan[k]?.auprc_famili_model1 ?? 0} warna={M1} label="Model 1, klaim sama" kanan={n3(gr.lapisan[k]?.auprc_famili_model1)} />
          </div>
        ))}
      </KartuNode>

      <KartuNode ikon="graph" warna={M1} nama="Model 1 · graph + tetangga" teknik="LightGBM · neighbour aggregation feature" vonis="bermasalah"
        kenapa={`Sumber utama masalah. ${pct(mdl.fp / fpTot)} klaim normal yang ditandai datang dari jalur model, dan ${pct(mdl.fp_kunjungan_pertama / Math.max(1, mdl.fp))} di antaranya kunjungan pertama. Model 1 juga punya ${id(sp.model1.bising)} split di dalam selisih pembulatan (${id(sp.model1.bising_gain_pct, 1)}% gain).`}
        perbaiki="Satu jalur feature untuk training dan serving, klaim normal kunjungan pertama di data latih, lalu latih ulang.">
        <Dua label="AUPRC, dijalankan" g={gr.lapisan.model1.auprc} b={br.lapisan.model1.auprc} fmt={n3} />
        <Dua label="AUPRC, tanpa bug pembulatan" g={gs.lapisan.model1.auprc} b={n.data.uji_b.snap.lapisan.model1.auprc} fmt={n3} />
      </KartuNode>

      <KartuNode ikon="layers" warna={SERIES[0]} nama="Monotone fusion + calibration" teknik="LightGBM stacker monoton + isotonic" vonis="bermasalah"
        kenapa={`Model 1 memegang ${pct(n.bobot_fusi.model1)} bobot, jadi fusion praktis sama dengan Model 1 (AUPRC ${n3(gr.fusi.auprc)} vs ${n3(gr.lapisan.model1.auprc)} di generator 2).${kal ? ` Calibration rusak: klaim dengan peluang rata-rata ${pct(kal.prediksi, 0)} ternyata hanya ${pct(kal.teramati, 1)} fraud (${id(kal.n)} klaim).` : ""}`}
        perbaiki="Latih ulang fusion dan calibration pada held-out data yang dihitung per klaim dan punya kunjungan pertama.">
        <Dua label="AUPRC peluang akhir" g={gr.fusi.auprc} b={br.fusi.auprc} fmt={n3} />
      </KartuNode>

      <KartuNode ikon="logic" warna={AMBER} nama="Rule route" teknik="Rule (tanpa ML)" vonis="campuran"
        kenapa={`Di generator 2 tepat sasaran: ${id(gr.jalur.rute.tp)} fraud vs ${id(gr.jalur.rute.fp)} normal (precision ${pct(gr.jalur.rute.precision, 0)}), ${id(gr.jalur.rute.unik_tp)} fraud hanya tertangkap di sini. Di test B sebaliknya: ${id(br.jalur.rute.tp)} fraud vs ${id(br.jalur.rute.fp)} normal.`}
        perbaiki={`Tinjau sinyal yang menyala di ${id(br.jalur.rute.fp)} klaim normal test B; jangan disetel di generator 2.`}>
        <Dua label="Precision saat menyala" g={gr.jalur.rute.precision} b={br.jalur.rute.precision} />
      </KartuNode>

      <KartuNode ikon="constellation" warna={HIJAU} nama="Network rule" teknik="Rule graph tanpa label" vonis="lemah"
        kenapa={`Hampir tidak menambah: ${id(gr.jalur.jaringan.unik_tp)} fraud unik di generator 2, ${id(br.jalur.jaringan.unik_tp)} di test B. Rule ini hanya menyala di ${pct(ringG?.jaringan)} fraud ring. Model 1 menangkap ${pct(ringG?.model)} ring, tapi tanpa bug hanya ${pct(ringGs?.model)}.`}
        perbaiki="Perkuat deteksi ring yang tidak bergantung pada Model 1 (berbagi RS, tanggal dan kode), lalu cek ambangnya di data latih.">
        <Dua label="Recall di fraud ring, rule ini saja" g={ringG?.jaringan ?? null} b={ringB?.jaringan ?? null} />
      </KartuNode>

      <KartuNode ikon="sparkle" warna={HIJAU} nama="Keputusan + penjelasan AI" teknik="Ambang peluang · LLM hanya menjelaskan" vonis="bermasalah"
        kenapa={`Keputusan = peluang ≥ ${pct(n.ambang_peluang, 0)} ATAU rule route ATAU network rule, jadi semua false positive Model 1 ikut lolos ke sini. Penjelasan AI tidak diukur di laporan ini.`}
        perbaiki="Membaik sendiri bila Model 1 dan fusion diperbaiki. Pertimbangkan rule engine sebagai syarat atau jalur tambahan.">
        <Dua label="Recall akhir" g={gr.keputusan.recall} b={br.keputusan.recall} />
        <Dua label="Precision akhir" g={gr.keputusan.precision} b={br.keputusan.precision} />
      </KartuNode>
    </div>
  );
}

function JalurKeputusan({ n }: { n: G2Node }) {
  const [data, setData] = useState<"gen2" | "uji_b">("gen2");
  const [mode, setMode] = useState<"raw" | "snap">("raw");
  const o = n.data[data][mode], tot = n.data[data];
  const jalur: { k: "model" | "rute" | "jaringan"; nama: string; w: string }[] = [
    { k: "model", nama: "Model (Model 1 + spesialis + fusion)", w: M1 }, { k: "rute", nama: "Rule route", w: AMBER }, { k: "jaringan", nama: "Network rule", w: HIJAU }];
  const fpTot = Math.max(1, o.keputusan.fp);
  return (
    <ChartCard title="Siapa yang menangkap fraud, siapa yang menandai klaim normal"
      insight="Keputusan akhir = jalur model ATAU rule route ATAU network rule. Warna penuh = hanya lewat jalur ini, warna pudar = juga lewat jalur lain. Kolom kanan: keputusan bila jalur ini dibuang."
      table={<Tabel kepala={["Jalur", "Fraud tertangkap", "Hanya jalur ini", "Normal ditandai", "Hanya jalur ini", "Normal: kunjungan pertama", "Tanpa jalur: recall", "Tanpa jalur: precision"]}
        baris={jalur.map((j) => { const x = o.jalur[j.k]; return [j.nama, id(x.tp), id(x.unik_tp), id(x.fp), id(x.unik_fp), id(x.fp_kunjungan_pertama), pct(x.tanpa.recall), pct(x.tanpa.precision)]; })} />}
      source={<span>{data === "gen2" ? "generator 2" : "test B"} · {id(tot.fraud)} fraud, {id(tot.normal)} normal · {mode === "raw" ? "dijalankan" : "tanpa bug pembulatan (diagnosis)"}</span>}>
      <div className="flex flex-wrap items-center gap-2">
        <Pilih nilai={data} set={setData} opsi={[["gen2", "Generator 2"], ["uji_b", "Test B"]]} />
        <Pilih nilai={mode} set={setMode} opsi={[["raw", "Dijalankan"], ["snap", "Tanpa bug"]]} />
        <span className="text-[11px] text-[#8f99a8]">keputusan akhir: recall {pct(o.keputusan.recall)} · precision {pct(o.keputusan.precision)} · normal ditandai {pct(o.keputusan.fpr, 2)}</span>
      </div>
      <div className="mt-3 space-y-3">
        {jalur.map((j) => {
          const x = o.jalur[j.k];
          const seg = (a: number, b: number, total: number) => (
            <span className="flex h-2.5 overflow-hidden rounded-full bg-white/[.06]">
              <span style={{ width: `${(a / Math.max(1, total)) * 100}%`, background: j.w }} />
              <span style={{ width: `${(Math.max(0, b - a) / Math.max(1, total)) * 100}%`, background: `${j.w}59`, marginLeft: a > 0 && b > a ? 2 : 0 }} />
            </span>
          );
          return (
            <div key={j.k} className="grid gap-x-4 gap-y-1.5 rounded-md border border-white/[.06] p-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-white"><span className="h-2.5 w-2.5 rounded-full" style={{ background: j.w }} />{j.nama}</p>
              <div title={`${id(x.tp)} dari ${id(tot.fraud)} fraud; ${id(x.unik_tp)} hanya lewat jalur ini`}>
                <p className="mb-1 text-[10.5px] text-[#abb3bf]">Fraud tertangkap <b className="font-medium text-white">{id(x.tp)}</b> dari {id(tot.fraud)} · hanya di sini {id(x.unik_tp)}</p>
                {seg(x.unik_tp, x.tp, tot.fraud)}
              </div>
              <div title={`${id(x.fp)} klaim normal ditandai (${pct(x.fp / fpTot)} dari semua yang salah ditandai); ${id(x.unik_fp)} hanya lewat jalur ini`}>
                <p className="mb-1 text-[10.5px] text-[#abb3bf]">Normal ditandai <b className="font-medium text-white">{id(x.fp)}</b> · {pct(x.fp / fpTot, x.fp / fpTot < 0.1 ? 1 : 0)} dari semua false positive</p>
                {seg(x.unik_fp, x.fp, fpTot)}
              </div>
              <p className="text-[10.5px] leading-snug text-[#abb3bf]">Tanpa jalur ini: recall <b className="text-white">{pct(x.tanpa.recall)}</b>, precision <b className="text-white">{pct(x.tanpa.precision)}</b></p>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

function KualitasLapisan({ n }: { n: G2Node }) {
  const G = n.data.gen2, B = n.data.uji_b;
  const baris: { nama: string; ket: string; v: [number | null, number | null, number | null, number | null] }[] = [
    { nama: "Model 1", ket: "semua fraud vs normal", v: [B.raw.lapisan.model1.auprc, B.snap.lapisan.model1.auprc, G.raw.lapisan.model1.auprc, G.snap.lapisan.model1.auprc] },
    { nama: "Fusion + calibration", ket: "peluang akhir", v: [B.raw.fusi.auprc, B.snap.fusi.auprc, G.raw.fusi.auprc, G.snap.fusi.auprc] },
    ...SPESIALIS.map((k) => ({ nama: `Spesialis ${NAMA_FAM[k].toLowerCase()}`, ket: "keluarganya vs normal",
      v: [B.raw.lapisan[k]?.auprc_famili ?? null, B.snap.lapisan[k]?.auprc_famili ?? null, G.raw.lapisan[k]?.auprc_famili ?? null, G.snap.lapisan[k]?.auprc_famili ?? null] as [number | null, number | null, number | null, number | null] })),
  ];
  const titik: { w: string; isi: boolean; nm: string }[] = [{ w: G1, isi: true, nm: "test B" }, { w: G1, isi: false, nm: "test B tanpa bug" }, { w: GEN2, isi: true, nm: "generator 2" }, { w: GEN2, isi: false, nm: "generator 2 tanpa bug" }];
  return (
    <ChartCard title="Kualitas tiap lapisan model (AUPRC)"
      insight="Semakin ke kanan semakin baik. Spesialis hampir tidak bergeser antara dijalankan dan tanpa bug; Model 1 dan fusion bergeser jauh, dan di generator 2 jatuh ke bawah spesialis."
      table={<Tabel kepala={["Lapisan", "Diukur pada", "Test B", "Test B tanpa bug", "Generator 2", "Generator 2 tanpa bug"]} baris={baris.map((b) => [b.nama, b.ket, ...b.v.map(n3)])} />}
      source={<span>AUPRC = luas di bawah kurva precision-recall; 1 = sempurna · spesialis dinilai pada fraud keluarganya + semua klaim normal</span>}>
      <Legenda items={[{ w: G1, l: "test B" }, { w: G1, l: "test B tanpa bug", gaya: "cincin" }, { w: GEN2, l: "generator 2" }, { w: GEN2, l: "generator 2 tanpa bug", gaya: "cincin" }]} />
      <div className="mt-3 space-y-2.5">
        {baris.map((b) => (
          <div key={b.nama} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0,150px) minmax(0,1fr)" }}>
            <div className="min-w-0"><p className="truncate text-[12px] text-white">{b.nama}</p><p className="truncate text-[10px] text-[#8f99a8]">{b.ket}</p></div>
            <div className="relative h-6">
              <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/[.07]" />
              {[0.25, 0.5, 0.75].map((t) => <div key={t} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/10" style={{ left: `${t * 100}%` }} />)}
              {b.v.map((v, i) => v === null ? null : (
                <span key={i} title={`${b.nama} · ${titik[i].nm}: ${n3(v)}`} className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${v * 100}%`, background: titik[i].isi ? titik[i].w : "#1c2127", border: `2px solid ${titik[i].w}`, boxShadow: "0 0 0 2px #1c2127", zIndex: titik[i].isi ? 2 : 1 }} />
              ))}
            </div>
          </div>
        ))}
        <div className="grid gap-3 text-[10px] text-[#8f99a8]" style={{ gridTemplateColumns: "minmax(0,150px) minmax(0,1fr)" }}>
          <span />
          <div className="flex justify-between tabular-nums"><span>0</span><span>0,25</span><span>0,5</span><span>0,75</span><span>1</span></div>
        </div>
      </div>
    </ChartCard>
  );
}

function BugPerLapisan({ n }: { n: G2Node }) {
  const nama: Record<string, string> = { model1: "Model 1", koding: "Spesialis coding", tagihan: "Spesialis tagihan", episode: "Spesialis episode", identitas: "Spesialis identitas" };
  const k = Object.keys(nama).filter((x) => n.split_bulat[x]);
  const maks = Math.max(5, ...k.map((x) => n.split_bulat[x].bising_gain_pct));
  const m1 = n.split_bulat.model1;
  return (
    <ChartCard title="Seberapa banyak tiap lapisan bersandar pada bug pembulatan"
      insight={`Split di dalam selisih pembulatan: data training punya nilai di kedua sisi threshold dengan jarak sebatas noise. Bagian gain-nya kecil, tapi efeknya besar karena jatuh di feature yang ikut membawa fingerprint kunjungan pertama.${m1 ? ` Hitungan awal (${id(m1.split)} split, ${id(m1.gain_pct, 1)}% gain di Model 1) ikut menghitung split normal di nilai 0, jadi terlalu besar.` : ""}`}
      table={<Tabel kepala={["Lapisan", "Split di dalam noise", "Gain", "Tes longgar: split", "Tes longgar: gain", "Total split"]}
        baris={k.map((x) => { const s = n.split_bulat[x]; return [nama[x], id(s.bising), `${id(s.bising_gain_pct, 1)}%`, id(s.split), `${id(s.gain_pct, 1)}%`, id(s.split_total)]; })} />}
      source={<span>{id(n.kolom_bulat)} kolom dengan ≤ 60 nilai berbeda di aliran latih · data training yang dicek: aliran replay (batch) + data latih v2 (per klaim)</span>}>
      <div className="space-y-1.5">{k.map((x) => <Batang key={x} v={n.split_bulat[x].bising_gain_pct} maks={maks} warna={x === "model1" ? M1 : SPES} label={nama[x]}
        kanan={`${id(n.split_bulat[x].bising_gain_pct, 1)}%`} />)}</div>
      <p className="mt-2 text-[10.5px] text-[#8f99a8]">Persen = bagian gain lapisan itu yang jatuh di split dalam noise. Identitas tinggi di sini, tapi AUPRC-nya hampir tidak berubah tanpa bug; di Model 1 kebalikannya.</p>
    </ChartCard>
  );
}

function Prioritas({ g, n, selesai = 0 }: { g: G2; n: G2Node; selesai?: number }) {
  const gr = n.data.gen2.raw, gs = n.data.gen2.snap, br = n.data.uji_b.raw, bs = n.data.uji_b.snap;
  const kp = g.penyebab.kelompok.find((x) => x.kelompok.startsWith("Kunjungan pertama"));
  const ringG = gr.famili.find((f) => f.famili === "jaringan"), ringGs = gs.famili.find((f) => f.famili === "jaringan");
  const kal = g.kalibrasi.gen2.length ? g.kalibrasi.gen2[g.kalibrasi.gen2.length - 1] : null;
  const item: { node: string; w: string; apa: string; kenapa: string; cara: string }[] = [
    { node: "Model 1 · feature", w: M1, apa: "Samakan jalur feature training dan serving",
      kenapa: `Model 1 membedakan baris training (dihitung batch) dari klaim yang dihitung per klaim. Tanpa selisih itu recall test B ${pct(bs.keputusan.recall)}, bukan ${pct(br.keputusan.recall)}.`,
      cara: "Hitung feature data latih lewat jalur per klaim yang sama dengan /testing, atau bulatkan dengan cara yang sama di keduanya. Latih ulang." },
    { node: "Data latih", w: M1, apa: "Masukkan klaim normal kunjungan pertama",
      kenapa: `Data latih v2 dan test A/B tidak punya satu pun. Di generator 2, ${kp ? pct(kp.fpr) : "—"} klaim normal kunjungan pertama ditandai fraud.`,
      cara: "Tambah klaim normal dari peserta yang baru pertama ke RS itu, seperti di data nyata (generator 2: 27% klaim normal)." },
    { node: "Fusion + calibration", w: SERIES[0], apa: "Latih ulang fusion pada data yang mirip serving",
      kenapa: `Model 1 memegang ${pct(n.bobot_fusi.model1)} bobot, padahal di generator 2 spesialis jauh lebih baik di keluarganya.${kal ? ` Peluang ${pct(kal.prediksi, 0)} ternyata hanya ${pct(kal.teramati, 1)} fraud.` : ""}`,
      cara: "Held-out set yang dihitung per klaim dan punya kunjungan pertama; cek calibration per generator, bukan hanya di data latih." },
    { node: "Engine realtime", w: AMBER, apa: "Uji keputusan rule sebagai jalur sendiri",
      kenapa: `Di generator 2, rule saja menangkap ${pct(gr.engine.recall)} dengan precision ${pct(gr.engine.precision)}. Itu lebih baik dari v3 bahkan tanpa bug (${pct(gs.keputusan.recall)} / ${pct(gs.keputusan.precision)}).`,
      cara: "Uji sebagai jalur ATAU, atau sebagai syarat bagi model, di data uji baru. Jangan disetel di 200 ribu klaim ini." },
    { node: "Network rule", w: HIJAU, apa: "Perkuat deteksi ring yang tidak bergantung pada Model 1",
      kenapa: `Rule ini hanya menyala di ${pct(ringG?.jaringan)} fraud ring. Model 1 menangkap ${pct(ringG?.model)} ring, tapi tanpa bug hanya ${pct(ringGs?.model)}.`,
      cara: "Tambah sinyal ring (berbagi RS, tanggal, kode, dokter) dan tetapkan ambang dari data latih." },
    { node: "Rule route", w: AMBER, apa: "Tinjau sinyalnya",
      kenapa: `Generator 2: ${id(gr.jalur.rute.tp)} fraud vs ${id(gr.jalur.rute.fp)} normal. Test B: ${id(br.jalur.rute.tp)} fraud vs ${id(br.jalur.rute.fp)} normal.`,
      cara: `Lihat sinyal mana yang menyala di ${id(br.jalur.rute.fp)} klaim normal test B itu.` },
    { node: "Entity resolution", w: ABU, apa: "Uji tersendiri",
      kenapa: "Kedua generator memakai nomor peserta yang persis sama, jadi fuzzy matching belum pernah diuji.",
      cara: "Data uji dengan nama, no RM dan SEP yang sengaja berbeda tipis." },
  ];
  return (
    <section className={`${box} p-4`}>
      <p className="text-[13px] font-semibold text-white">Yang harus diperbaiki, urut prioritas</p>
      <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">Urutan dari dampaknya pada false positive dan recall di generator 2. Nomor 1 dan 2 dikerjakan bersama, karena keduanya ada di data latih yang sama.</p>
      <ol className="mt-3 space-y-2">
        {item.map((x, i) => (
          <li key={x.apa} className="grid gap-x-3 gap-y-1 rounded-md border border-white/[.06] p-2.5 md:grid-cols-[28px_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)]">
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/15 text-[11px] tabular-nums text-white">{i + 1}</span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-white">{x.apa}</p>
              <span className="mt-0.5 inline-flex flex-wrap items-center gap-1 text-[10.5px] text-[#abb3bf]"><span className="h-2 w-2 rounded-full" style={{ background: x.w }} />{x.node}
                {i < selesai && <span className="ml-1 inline-flex items-center gap-0.5 rounded-full border border-[#199e70]/50 px-1.5 text-[#7ee2c0]"><Icon name="check" className="h-3 w-3" />Selesai, lihat Status perbaikan</span>}</span>
            </div>
            <p className="text-[11px] leading-snug text-[#c5cbd3]"><b className="font-medium text-[#8f99a8]">Kenapa · </b>{x.kenapa}</p>
            <p className="text-[11px] leading-snug text-[#dfe3e8]"><b className="font-medium text-[#8f99a8]">Cara · </b>{x.cara}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 flex items-start gap-2 rounded-md bg-[#c98500]/10 px-2.5 py-2 text-[11px] leading-snug text-[#f2d49b]">
        <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0 text-[#f5c46b]" />
        200 ribu klaim generator 2 ini sudah dipakai untuk memilih perbaikan di atas, jadi tidak jujur lagi untuk menilai hasilnya. Setelah diperbaiki, uji di batch generator 2 baru (seed baru) dan test yang belum pernah dipakai.</p>
    </section>
  );
}

/** The repair of v3 (2026-11-12, "oke kerjakan, nanti update report"): steps 1–3 and the one scoring on test C and generator 2
 *  with a new seed (perbaikan_v3 in /api/ml-sistem, testing/laporan_perbaikan.py), against the criteria written before. */
function StatusPerbaikan({ p }: { p: P3 }) {
  const W: Record<string, string> = { konsisten: HIJAU, sebagian: AMBER, "tidak konsisten": MERAH };
  const cek = p.model_bersih.cek_satu_jalur;
  const c = p.hasil.uji_c.model_v3_bersih, g = p.hasil.gen2_baru.model_v3_bersih, gl = p.hasil.gen2_baru.model_v3;
  const langkah: { t: string; w: string; ket: string }[] = [
    { t: "1 · Satu jalur feature", w: HIJAU, ket: "training dan serving identik bit-per-bit" },
    { t: "2 · Data generator 1 tanpa echo", w: HIJAU, ket: `test C: ${pct(c.porsi_kunjungan_pertama_normal, 0)} klaim normal kunjungan pertama (dulu 0%)` },
    { t: "3 · Retrain v3, arsitektur sama", w: cek?.lulus ? HIJAU : MERAH, ket: cek?.lulus ? "cek lulus: snap mengubah 0 keputusan validasi" : "cek belum lulus" },
    { t: "4 · Uji sekali", w: W[p.vonis.antar_generator] && W[p.vonis.jalan_pintas] ? ([p.vonis.jalan_pintas, p.vonis.antar_generator].includes("tidak konsisten") ? MERAH : [p.vonis.jalan_pintas, p.vonis.antar_generator].includes("sebagian") ? AMBER : HIJAU) : ABU,
      ket: `jalan pintas: ${p.vonis.jalan_pintas} · antar generator: ${p.vonis.antar_generator}` },
  ];
  const baris: { nama: string; ket: string; w: string; m: { recall: number; precision: number; fpr: number }; rasio?: number; lama?: boolean }[] = [
    { nama: "v3 lama · generator 2 run 1", ket: "yang membuka bug ini (dijalankan apa adanya)", w: GEN2, m: p.sebelum.gen2_run1_v3_lama, lama: true },
    { nama: "v3 bersih · test C", ket: `generator 1 tanpa echo · ${id(p.ukuran.uji_c.klaim)} klaim`, w: G1, m: c, rasio: c.rasio_kunjungan_pertama },
    { nama: "Rule engine saja · test C", ket: "keputusan PERIKSA/TAHAN, tanpa ML", w: ABU, m: p.rule.uji_c, lama: true },
    { nama: "v3 bersih · generator 2 baru", ket: `seed baru · ${id(p.ukuran.gen2_baru.klaim)} klaim`, w: GEN2, m: g, rasio: g.rasio_kunjungan_pertama },
    { nama: "Rule engine saja · generator 2 baru", ket: "keputusan PERIKSA/TAHAN, tanpa ML", w: ABU, m: p.rule.gen2_baru, lama: true },
    { nama: "v3 lama · generator 2 baru", ket: "dilatih jalur lama, dinilai dengan feature jalur baru", w: ABU, m: gl, rasio: gl.rasio_kunjungan_pertama, lama: true },
  ];
  return (
    <section className={`${box} p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-semibold text-white">Status perbaikan</p>
        <span className="rounded-full border border-white/[.1] px-2 py-0.5 text-[10.5px] text-[#c5cbd3]">model_v3_bersih: kandidat, belum dipakai /testing</span>
        <span className="text-[10.5px] text-[#8f99a8]">kriteria ditulis sebelum hasil · {p.dibuat}</span>
      </div>
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {langkah.map((l) => (
          <div key={l.t} className="rounded-md border p-2.5" style={{ borderColor: `${l.w}55` }}>
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-white">
              <span className="shrink-0" style={{ color: l.w }}><Icon name={l.w === HIJAU ? "check" : l.w === ABU ? "info" : "alert"} className="h-3.5 w-3.5" /></span>{l.t}</p>
            <p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{l.ket}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[560px] space-y-1.5">
          <div className="grid gap-3 text-[10.5px] text-[#8f99a8]" style={{ gridTemplateColumns: "minmax(0,1.5fr) repeat(3,minmax(0,1fr)) 92px" }}>
            <span /><span>Recall</span><span>Precision</span><span>Normal ditandai</span><span className="text-right">Kunj. pertama ÷ lama</span>
          </div>
          {baris.map((x) => (
            <div key={x.nama} className="grid items-center gap-3" style={{ gridTemplateColumns: "minmax(0,1.5fr) repeat(3,minmax(0,1fr)) 92px" }}>
              <div className="min-w-0"><p className={`truncate text-[11.5px] ${x.lama ? "text-[#abb3bf]" : "text-white"}`}>{x.nama}</p><p className="truncate text-[10px] text-[#8f99a8]">{x.ket}</p></div>
              {(["recall", "precision", "fpr"] as const).map((k) => (
                <div key={k} className="grid items-center gap-1.5" style={{ gridTemplateColumns: "minmax(0,1fr) 46px" }} title={`${x.nama} · ${k}: ${pct(x.m[k], k === "fpr" ? 2 : 1)}`}>
                  <span className="h-2 overflow-hidden rounded-full bg-white/[.06]"><span className="block h-full rounded-full" style={{ width: `${Math.max(0.8, Math.min(1, x.m[k] / (k === "fpr" ? 0.2 : 1)) * 100)}%`, background: x.w }} /></span>
                  <span className="text-right text-[10.5px] tabular-nums text-[#dfe3e8]">{pct(x.m[k], k === "fpr" ? 2 : 1)}</span>
                </div>
              ))}
              <span className="text-right text-[11px] tabular-nums" style={{ color: x.rasio === undefined ? ABU : x.rasio <= 2 ? "#7ee2c0" : x.rasio <= 3 ? "#f2d49b" : "#ffc9c7" }}>{x.rasio === undefined ? "—" : `${id(x.rasio, 1)}×`}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[10.5px] leading-snug text-[#8f99a8]">Semua angka dari klaim yang tidak pernah dilatih, dinilai sekali. Kunj. pertama ÷ lama = klaim normal kunjungan pertama yang ditandai dibagi klaim normal pasien lama yang ditandai; ≤ 2× berarti jalan pintas hilang (K1). Di generator 2 baru, v3 bersih setara dengan rule engine saja: lapisan ML belum menambah di generator lain. Rincian, kriteria, dan build test C yang tidak sah ada di bagian &quot;Setelah perbaikan&quot;.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------ the page

function Isi({ g, n, ujiA, p }: { g: G2; n: G2Node; ujiA?: { recall: number; precision: number; fpr: number; auprc: number }; p?: P3 }) {
  const gr = n.data.gen2.raw, br = n.data.uji_b.raw, gs = n.data.gen2.snap, bs = n.data.uji_b.snap;
  const mdl = gr.jalur.model;
  const kp = g.penyebab.kelompok.find((x) => x.kelompok.startsWith("Kunjungan pertama"));
  const kr = g.penyebab.kelompok.find((x) => x.kelompok.startsWith("Pernah"));
  const tidak = g.vonis !== "konsisten";
  const kpi: { label: string; a: number; b: number; ci?: [number, number]; d: number; ket: string; fmt?: (v: number) => string }[] = [
    { label: "Recall", a: gr.keputusan.recall, b: br.keputusan.recall, ci: g.ci.gen2.recall, d: 1, ket: "fraud yang tertangkap" },
    { label: "Precision", a: gr.keputusan.precision, b: br.keputusan.precision, ci: g.ci.gen2.precision, d: 1, ket: `yang ditandai memang fraud · fraud ${pct(g.ringkas.model_v3.prevalensi)} vs ${pct(g.uji_b.prevalensi)}` },
    { label: "Normal ditandai", a: gr.keputusan.fpr, b: br.keputusan.fpr, ci: g.ci.gen2.fpr, d: 2, ket: "false positive rate" },
    { label: "AUPRC", a: g.ringkas.model_v3.auprc, b: g.uji_b.auprc, ci: g.ci.gen2.auprc, d: 3, ket: "kualitas urutan skor", fmt: (v) => id(v, 3) },
  ];
  const ringkas: { ikon: IconName; w: string; t: ReactNode }[] = [
    { ikon: "alert", w: MERAH, t: <>Pada {id(g.klaim)} klaim generator 2, v3 menangkap <b className="text-white">{pct(gr.keputusan.recall)}</b> fraud dan ikut menandai <b className="text-white">{pct(gr.keputusan.fpr)}</b> klaim normal. Di test B: {pct(br.keputusan.recall)} dan {pct(br.keputusan.fpr, 2)}. Dari 100 klaim yang ditandai, hanya {id(gr.keputusan.precision * 100, 0)} yang benar fraud.</> },
    { ikon: "eye", w: MERAH, t: <>Hampir semua false positive adalah klaim normal pasien yang baru pertama ke RS itu: <b className="text-white">{kp ? pct(kp.fpr) : "—"}</b> dari klaim seperti itu ditandai, sedangkan pasien yang pernah ke RS itu {kr ? pct(kr.fpr, 2) : "—"}.</> },
    { ikon: "bug", w: MERAH, t: <>Angka resmi test B ikut terdongkrak bug train/serve skew: Model 1 membedakan baris training dari klaim yang dihitung per klaim lewat selisih pembulatan. Tanpa selisih itu recall test B <b className="text-white">{pct(bs.keputusan.recall)}</b>, bukan {pct(br.keputusan.recall)}; generator 2 {pct(gs.keputusan.recall)}.</> },
    { ikon: "graph", w: AMBER, t: <>Masalah utama ada di <b className="text-white">Model 1</b> ({pct(mdl.fp / Math.max(1, gr.keputusan.fp))} false positive) dan <b className="text-white">fusion</b> yang memberinya {pct(n.bobot_fusi.model1)} bobot. Rule engine dan 4 spesialis jauh lebih tahan, tapi kekuatannya tidak terpakai di keputusan.</> },
    { ikon: "check", w: HIJAU, t: <>Semua angka di sini dari klaim yang tidak pernah dilihat model. Kriteria konsisten ditetapkan sebelum hasil dilihat; {g.kriteria.filter((k) => k.hasil !== "konsisten").length} dari {g.kriteria.length} gagal.</> },
  ];
  return (
    <div className="space-y-4 p-4 text-[12px]">
      <section className={`${box} p-4`}>
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#3987e5]/20 text-[#8abbff]"><Icon name="doc" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Laporan uji · generator 2 · {g.dibuat}</p>
            <h2 className="text-[17px] font-semibold leading-snug text-white" style={{ textWrap: "balance" }}>Arsitektur v3 pada {id(g.klaim)} klaim generator 2: {tidak ? "tidak konsisten dengan test B" : "konsisten dengan test B"}</h2>
            <p className="mt-1 max-w-[860px] text-[12px] leading-relaxed text-[#abb3bf]">Generator 2 adalah generator klaim sintetis kedua yang dibuat dengan cara lain dari data latih. Laporan ini menilai workflow v3 yang sama dengan /testing, lalu mengurai node mana yang membantu dan mana yang membuat hasilnya jatuh.</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px]" style={{ borderColor: `${tidak ? MERAH : HIJAU}66`, color: tidak ? "#ffc9c7" : "#7ee2c0" }}>
            <Icon name={tidak ? "alert" : "check"} className="h-3.5 w-3.5" />Vonis: {g.vonis}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[10.5px]">
          {["Data sintetis", `Model ${n.model} (dipakai /testing)`, `${id(g.fraud)} fraud + ${id(g.normal)} normal`, `${id(g.anggota)} peserta · ${g.chunk} chunk`, "Kriteria ditetapkan sebelum hasil dilihat"].map((c) =>
            <span key={c} className="rounded-full border border-white/[.08] px-2 py-0.5 text-[#c5cbd3]">{c}</span>)}
        </div>
      </section>

      {p && <StatusPerbaikan p={p} />}
      {p && <p className="pt-1 text-[11.5px] text-[#abb3bf]">Mulai dari sini: <b className="font-medium text-white">model_v3</b> lama (yang dipakai /testing sekarang) pada generator 2 run 1, sebelum perbaikan.</p>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpi.map((k) => {
          const f = k.fmt ?? ((v: number) => pct(v, k.d));
          return (
            <div key={k.label} className={`${box} p-3`}>
              <p className="text-[11px] text-[#abb3bf]">{k.label}</p>
              <p className="mt-1 text-[24px] font-semibold leading-none tabular-nums text-white">{f(k.a)}</p>
              <p className="mt-1 text-[11px] tabular-nums text-[#8f99a8]">test B <span className="text-[#f2d49b]">{f(k.b)}</span>{k.ci ? ` · 95% CI ${f(k.ci[0])}–${f(k.ci[1])}` : ""}</p>
              <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">{k.ket}</p>
            </div>
          );
        })}
      </div>

      <section className={`${box} p-4`}>
        <p className="text-[13px] font-semibold text-white">Ringkasan</p>
        <ul className="mt-2 space-y-2">
          {ringkas.map((r, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[12px] leading-relaxed text-[#c5cbd3]">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded" style={{ background: `${r.w}26`, color: r.w }}><Icon name={r.ikon} className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 max-w-[900px]">{r.t}</span>
            </li>
          ))}
        </ul>
      </section>

      <SemuaUji g={g} n={n} ujiA={ujiA} />

      <Judul ikon="pipeline" sub="biar tahu mana yang harus diperbaiki">Node mana yang membantu, mana yang merusak</Judul>
      <p className="text-[11.5px] text-[#abb3bf]">Urutan sama dengan alur v3. Bar biru = generator 2, kuning = test B. Penilaian untuk model_v3 lama, dari hasil {n.dibuat}.</p>
      <NodeNode g={g} n={n} />
      <JalurKeputusan n={n} />
      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <KualitasLapisan n={n} />
        <BugPerLapisan n={n} />
      </div>
      <Prioritas g={g} n={n} selesai={p ? 2 : 0} />

      <section className={`${box} p-4`}>
        <p className="text-[13px] font-semibold text-white">Batasan laporan ini</p>
        <ul className="mt-2 grid gap-1.5 md:grid-cols-2">
          {[...g.batas,
            "Penilaian node dibuat dari satu run; spesialis dinilai pada fraud keluarganya sendiri ditambah semua klaim normal.",
            "Split di dalam noise memakai tes ketat (nilai data training di kedua sisi threshold). Data training yang dicek: aliran replay dan data latih v2.",
            "Penjelasan AI dan entity resolution tidak diukur di laporan ini.",
          ].map((t) => (
            <li key={t} className="flex items-start gap-2 rounded-md bg-[#c98500]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[#f2d49b]">
              <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0 text-[#f5c46b]" />{t}</li>
          ))}
        </ul>
      </section>

      {p && (
        <>
          <Judul ikon="check" sub="kandidat, belum dipakai /testing">Setelah perbaikan: v3 bersih di test C dan generator 2 baru</Judul>
          <PerbaikanV3 p={p} />
        </>
      )}

      <Judul ikon="table" sub="dari laporan generator 2">Lampiran: grafik rinci</Judul>
      <GeneratorDua g={g} />

      <section className={`${box} p-4`}>
        <p className="text-[13px] font-semibold text-white">Metode dan cara mengulang</p>
        <dl className="mt-2 grid gap-x-6 gap-y-2 text-[11.5px] md:grid-cols-2">
          {([
            ["Generator 2", "testing/generator2.py: model parametrik dari agregat klaim 1 Jan–17 Des 2024 generator 1; fraud dari definisi Permenkes 16/2019 dengan parameter sendiri."],
            ["Penilaian", `testing/uji_gen2.py: ${g.chunk} chunk, engine realtime seperti /testing (tanpa VIME), feature dihitung per klaim; ${n.model} dengan ambang ${pct(n.ambang_peluang, 0)}.`],
            ["Laporan generator 2", "testing/laporan_gen2.py → generator2.json; kriteria konsisten (KRITERIA) ditetapkan sebelum hasil dilihat."],
            ["Per node", `testing/node_gen2.py → generator2_node.json; mereproduksi recall ${Object.values(n.cek).slice(0, 4).map((c) => pct(c[0], 2)).join(" · ")} persis${Object.keys(n.cek_beda).length ? " (ada selisih: lihat cek_beda)" : ""}.`],
            ["Diagnosis tanpa bug", "Nilai feature yang hanya beda pembulatan disamakan dengan nilai batch, lalu dinilai ulang. Model dan ambang tidak diubah. Ini bukan sistem yang berjalan."],
            ["Menyegarkan tab ini", "Jalankan laporan_gen2.py dan node_gen2.py, lalu laporan_ml.py dan build-web.ps1."],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="min-w-0"><dt className="text-[#8f99a8]">{k}</dt><dd className="text-[#dfe3e8]">{v}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}

export function LaporanGen2() {
  const [d, setD] = useState<Doc | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/ml-sistem", { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setD(j as Doc); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <p className="p-4 text-[12px] text-red-300">{err}</p>;
  if (!d) return <p className="p-4 text-[12px] text-[#8f99a8]">Memuat laporan generator 2…</p>;
  if (!d.generator2 || !d.generator2_node) return <p className="p-4 text-[12px] text-[#8f99a8]">Belum ada laporan generator 2. Jalankan testing/uji_gen2.py, laporan_gen2.py dan node_gen2.py, lalu laporan_ml.py.</p>;
  return <Isi g={d.generator2} n={d.generator2_node} ujiA={d.arsitektur_v3?.uji_a.v3} p={d.perbaikan_v3} />;
}
