"use client";

// System Architecture · Arsitektur ML v7 (the user, 2026-11-15: "ganti jadi arsitektur v7 + rule engine di depan, rule engine nya bisa
// dipencet, bisa diliat rule nya apa aja yg udah ada, rule nya bisa di edit, delete atau add new rule"): the system the AI Agent Swarm
// Branch runs, drawn left to right. The rule engine comes first and its node opens the rule manager (SysArchRuleKelola); then the
// claim graph, the 646 features, ML v7 (LightGBM, 3 seeds averaged), the zones and the swarm. Below: what the model leans on (the two
// rule engine scores are its strongest inputs) and its results per generator, in plain words. Data: /api/ml-sistem?bagian=v7 (the ML
// v7 benchmark + testing/model_ml_v7/zona_v5.json) and the rule list from the rule engine API. Synthetic data only; ML Studio has the
// full report and the earlier architectures (v3 and before).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import type { MLV7 } from "./BenchmarkMlV7";
import { SERIES } from "./viz";
import { Batang, Catatan, Chip, Galat, Judul, Memuat, idn, kartu, pct, tombolNetral } from "./SysArchShared";
import { aturanApi, type Daftar } from "./SysArchRuleApi";
import { KelolaRule } from "./SysArchRuleKelola";

type Zona = { ambang: { tahan: number; periksa: number; lebar: number }; dev: { klaim: number; normal: number; fraud: number };
  cek: { fpr_tahan: number; fpr_periksa: number; fpr_lebar: number; recall_periksa: number; recall_lebar: number }; tau?: string };
type Overfit = MLV7["kartu"]["cek_overfit"] & { porsi_gain_blok?: Record<string, number>; fitur_teratas?: { fitur: string; porsi: number }[] };
type Doc = { ml_v7: MLV7 | null; zona: Zona | null };

// the architecture's fixed shape (testing/varian_graf_dl.py, testing/ml_v7.py): 124 own features + 4 relations x 124 neighbour means
// + 4 log-degrees = 500 graph features + 22 mechanism features = the 646 the model reads; 3 LightGBM seeds averaged
const FITUR = { sendiri: 124, graf: 500, mekanisme: 22 };
const N_FITUR = FITUR.sendiri + FITUR.graf + FITUR.mekanisme;
const RELASI = ["Peserta sama", "RS sama", "RS + kode INA-CBG sama", "Kode INA-CBG sama"];
const WARNA = { rule: SERIES[0], tahan: "#e5484d", ragu: "#e0a526", lolos: "#5f9c86" };

const NAMA_FITUR: Record<string, string> = {
  skor_tanpa_mitigasi: "Skor rule engine sebelum mitigasi", skor_aturan: "Skor rule engine", log_biaya: "Besar biaya klaim",
  "klaim: hari_sejak_sebelumnya": "Jarak hari dari klaim sebelumnya", "v4: domisili_fktp_jarak": "Jarak domisili peserta ke faskes",
  "klaim: rasio_tagih_tarif": "Rasio tagihan terhadap tarif INA-CBG", "klaim: kunjungan_peserta_faskes": "Kunjungan peserta ke RS yang sama",
  "v4: dx_sekunder_di_atas_p90": "Diagnosis sekunder di atas kelaziman", "klaim: biaya_tagih": "Biaya yang ditagih",
  "v4: topup_rasio_median_kode": "Top-up dibanding kelaziman kode", "v4: los_rasio_median_kode": "Lama rawat dibanding kelaziman kode",
  "klaim: kunjungan_peserta": "Jumlah kunjungan peserta",
};
const dariRule = (f: string) => f === "skor_aturan" || f === "skor_tanpa_mitigasi" || f.startsWith("s:");
const BLOK: [string, string][] = [["X1 klaim sendiri", "Data klaim itu sendiri"], ["X1 tetangga graph", "Klaim tetangga di graph"], ["X4 mekanisme", "Fitur mekanisme fraud"]];
const GEN: [string, string, string][] = [
  ["generator1", "Generator 1", "pola mirip data latih"], ["generator2", "Generator 2", "pola mirip data latih"],
  ["generator3", "Generator 3", "seed baru, dinilai sekali"], ["generator4", "Generator 4", "ditulis buta: pola belum pernah dilihat"],
];

function Panah() {
  return <div aria-hidden className="flex items-center justify-center py-0.5 text-[#5f6b7a] xl:py-0"><Icon name="right" className="h-4 w-4 rotate-90 xl:rotate-0" /></div>;
}

function Simpul({ no, ikon, judul, angka, children, warna = "#8f99a8", sorot }: { no: number; ikon: IconName; judul: string; angka: ReactNode; children: ReactNode; warna?: string; sorot?: boolean }) {
  return (
    <div className={`flex h-full min-w-0 flex-col gap-1.5 rounded-lg border p-3 ${sorot ? "border-[#3987e5]/60 bg-[#3987e5]/[.08]" : "border-white/[.08] bg-[#151a1f]"}`}>
      <div className="flex items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[.07] text-[9.5px] tabular-nums text-[#abb3bf]">{no}</span>
        <span className="shrink-0" style={{ color: warna }}><Icon name={ikon} className="h-3.5 w-3.5" /></span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-[#abb3bf]">{judul}</span>
      </div>
      <p className="text-[15px] font-semibold leading-tight text-white">{angka}</p>
      <div className="flex-1 space-y-1 text-[11px] leading-snug text-[#abb3bf]">{children}</div>
    </div>
  );
}

function BarisZona({ nama, syarat, ke, warna, ket }: { nama: string; syarat: string; ke: string; warna: string; ket?: string }) {
  return (
    <div className="rounded border-l-2 bg-white/[.03] px-2 py-1" style={{ borderColor: warna }}>
      <p className="flex items-baseline gap-1.5"><span className="text-[10.5px] font-semibold" style={{ color: warna }}>{nama}</span><span className="font-mono text-[10.5px] text-[#d3d8de]">{syarat}</span></p>
      <p className="text-[10.5px] text-[#abb3bf]">→ {ke}{ket ? <span className="text-[#8f99a8]"> · {ket}</span> : null}</p>
    </div>
  );
}

const koma = (v: number, d = 2) => idn(v, d);

/** the flow: rule engine (clickable) → claim graph → features → ML v7 → zones → AI Agent Swarm */
function Alur({ b, z, rule, ruleGalat, onRule, onSwarm }: { b: MLV7; z: Zona | null; rule: Daftar | null; ruleGalat: boolean; onRule: () => void; onSwarm?: () => void }) {
  const tahan = z?.ambang.tahan ?? 0.78, lebar = z?.ambang.lebar ?? 0.12;
  const tau = Number((/(\d+[.,]\d+)/.exec(z?.tau ?? "")?.[1] ?? "0.72").replace(",", "."));
  const latih = Object.values(b.kartu.latih ?? {}).reduce((s, x) => s + x, 0);
  const bawaan = rule?.bawaan ?? [], kustom = rule?.kustom ?? [];
  const model = bawaan.filter((x) => x.masuk_model).length;
  const jalan = kustom.filter((x) => x.versi_aktif != null).length;
  const mati = bawaan.filter((x) => !x.aktif).length;
  return (
    <div className="grid gap-1 xl:grid-cols-[minmax(0,1.2fr)_18px_minmax(0,1fr)_18px_minmax(0,1fr)_18px_minmax(0,1fr)_18px_minmax(0,1.3fr)_18px_minmax(0,1.1fr)] xl:items-stretch">
      <button type="button" onClick={onRule} aria-haspopup="dialog" aria-label="Buka rule engine: lihat, edit, hapus, atau tambah rule"
        className="group h-full rounded-lg text-left outline-none ring-[#3987e5]/70 transition hover:-translate-y-px focus-visible:ring-2">
        <Simpul no={1} ikon="logic" judul="Rule engine" warna={WARNA.rule} sorot
          angka={rule ? <>{idn(bawaan.length + kustom.length)} rule</> : ruleGalat ? "Rule engine" : "…"}>
          {rule ? (
            <>
              <p>{idn(bawaan.length)} bawaan · <span className="text-[#a9cdff]">{model} dibaca model</span>{mati ? ` · ${mati} dimatikan` : ""}</p>
              <p>{idn(kustom.length)} kustom · {jalan} berjalan</p>
            </>
          ) : <p>{ruleGalat ? "Daftar rule belum terbaca (API rule engine)." : "Membaca daftar rule…"}</p>}
          <p>Setiap klaim dicek rule dulu; skor rule menjadi masukan terkuat model.</p>
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-[#3987e5]/60 bg-[#3987e5]/20 px-2 py-1 text-[11px] font-medium text-white group-hover:bg-[#3987e5]/35">
            <Icon name="pencil" className="h-3 w-3" />Lihat & kelola rule<Icon name="right" className="h-3 w-3" />
          </span>
        </Simpul>
      </button>
      <Panah />
      <Simpul no={2} ikon="graph" judul="Graph klaim" angka="4 relasi" warna={SERIES[2]}>
        <ul className="space-y-0.5">{RELASI.map((r) => <li key={r} className="flex items-center gap-1.5"><span className="h-1 w-1 shrink-0 rounded-full bg-[#5f9c86]" />{r}</li>)}</ul>
        <p className="text-[#8f99a8]">Hanya klaim yang lebih dulu masuk: model tidak melihat masa depan.</p>
      </Simpul>
      <Panah />
      <Simpul no={3} ikon="layers" judul="Fitur per klaim" angka={<>{N_FITUR} fitur</>} warna={SERIES[3]}>
        {([["Klaim sendiri", FITUR.sendiri], ["Tetangga di graph", FITUR.graf], ["Mekanisme fraud", FITUR.mekanisme]] as [string, number][]).map(([t, v]) => (
          <div key={t}>
            <p className="flex justify-between"><span>{t}</span><span className="tabular-nums text-[#d3d8de]">{v}</span></p>
            <Batang nilai={v} maks={N_FITUR} warna={SERIES[3]} tinggi={4} />
          </div>
        ))}
      </Simpul>
      <Panah />
      <Simpul no={4} ikon="cpu" judul="Model ML v7" angka="LightGBM × 3" warna={SERIES[1]}>
        <p>Rata-rata 3 model (seed berbeda) supaya skornya stabil.</p>
        {latih > 0 && <p>Dilatih {idn(latih)} klaim dari 3 sumber data sintetis.</p>}
        <p className="text-[#8f99a8]">Keluaran: skor risiko s, 0 sampai 1.</p>
      </Simpul>
      <Panah />
      <Simpul no={5} ikon="split" judul="Zona keputusan" angka="3 zona" warna={WARNA.ragu}>
        <div className="space-y-1">
          <BarisZona nama="TAHAN" syarat={`s ≥ ${koma(tahan)}`} ke="Box Karantina" warna={WARNA.tahan} ket={z ? `klaim normal ikut tertahan ${pct(z.cek.fpr_tahan, 1)}` : undefined} />
          <BarisZona nama="RAGU" syarat={`${koma(lebar)} ≤ s < ${koma(tahan)}`} ke="dibaca AI Agent Swarm" warna={WARNA.ragu} />
          <BarisZona nama="LOLOS" syarat={`s < ${koma(lebar)}`} ke="diproses normal" warna={WARNA.lolos} />
        </div>
        {z && <p className="text-[#8f99a8]">Ambang dihitung pada {idn(z.dev.klaim)} klaim dev, bukan data uji.</p>}
      </Simpul>
      <Panah />
      <Simpul no={6} ikon="constellation" judul="AI Agent Swarm" angka={<>τ {koma(tau)}</>} warna="#9d8cff">
        <p>Membaca klaim zona RAGU dan klaim yang dirutekan rule.</p>
        <p>Diteruskan ke Box Karantina bila <span className="font-mono text-[#d3d8de]">(p + q(s)) / 2 ≥ {koma(tau)}</span>; selain itu lolos.</p>
        {onSwarm && <button type="button" onClick={onSwarm} className="mt-1 inline-flex items-center gap-1 text-[11px] text-[#8abbff] hover:underline">Konfigurasi agen<Icon name="right" className="h-3 w-3" /></button>}
      </Simpul>
    </div>
  );
}

/** what the model leans on: the share of its decisions per feature block, and the strongest features (rule engine ones marked) */
function Penentu({ o, rule }: { o: Overfit; rule: Daftar | null }) {
  const blok = o.porsi_gain_blok ?? {};
  const top = (o.fitur_teratas ?? []).slice(0, 8);
  const label = new Map((rule?.bawaan ?? []).map((x) => [x.kode, x.label]));
  const nama = (f: string) => NAMA_FITUR[f] ?? (f.startsWith("s:") ? `Rule: ${label.get(f.slice(2)) ?? f.slice(2)}` : f.replace(/^(klaim|v4): /, "").replace(/_/g, " "));
  const porsiRule = (o.fitur_teratas ?? []).filter((x) => dariRule(x.fitur)).reduce((s, x) => s + x.porsi, 0);
  const maks = Math.max(...top.map((x) => x.porsi), 0.01);
  return (
    <section className={`${kartu} space-y-3 p-3.5`}>
      <Judul ikon="bolt" judul="Apa yang paling menentukan skor ML v7" sub="Porsi keputusan model (gain LightGBM) per kelompok fitur dan per fitur." />
      {porsiRule > 0 && (
        <p className="rounded border border-[#3987e5]/30 bg-[#3987e5]/10 px-2.5 py-1.5 text-justify text-[11.5px] leading-relaxed text-[#cfe2ff]">
          Dua fitur terkuat model berasal dari rule engine. Fitur rule engine di daftar teratas ini menyumbang <b className="text-white">{pct(porsiRule, 0)}</b> keputusan model:
          karena itu rule engine diletakkan di depan, dan mengubah rule berarti ikut mengubah apa yang dibaca model.
        </p>
      )}
      <div className="space-y-1.5">
        {BLOK.filter(([k]) => blok[k] !== undefined).map(([k, t]) => (
          <div key={k} className="grid grid-cols-[150px_minmax(0,1fr)_44px] items-center gap-2 text-[11.5px]">
            <span className="text-[#d3d8de]">{t}</span><Batang nilai={blok[k]} warna={SERIES[3]} tinggi={7} /><span className="text-right tabular-nums text-[#d3d8de]">{pct(blok[k], 0)}</span>
          </div>
        ))}
      </div>
      {!!top.length && (
        <div className="space-y-1 border-t border-white/[.06] pt-2.5">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Fitur teratas</p>
          {top.map((x) => (
            <div key={x.fitur} className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_40px] items-center gap-2 text-[11.5px]" title={x.fitur}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[#d3d8de]">{nama(x.fitur)}</span>
                {dariRule(x.fitur) && <Chip nada="biru">rule engine</Chip>}
              </span>
              <Batang nilai={x.porsi} maks={maks} warna={dariRule(x.fitur) ? WARNA.rule : "#8f99a8"} tinggi={6} />
              <span className="text-right tabular-nums text-[#abb3bf]">{pct(x.porsi, 1)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** ML v7 against ML v5 per generator: fraud caught when 1 % of normal claims may be flagged, in plain words */
function Hasil({ b }: { b: MLV7 }) {
  const P = b.pilihan;
  return (
    <section className={`${kartu} space-y-3 p-3.5`}>
      <Judul ikon="gauge" judul="Hasil uji ML v7 · data sintetis" sub="Fraud yang tertangkap model sendiri bila 1% klaim normal boleh ikut ditandai, dibanding ML v5 (versi sebelumnya)."
        kanan={<Chip nada={b.adopsi.lolos ? "hijau" : "kuning"} ikon={b.adopsi.lolos ? "check" : "alert"}>{b.adopsi.lolos ? "lolos aturan adopsi" : "belum lolos adopsi"}</Chip>} />
      <div className="space-y-2">
        {GEN.filter(([k]) => b.set[k]?.model?.[P]).map(([k, t, ket]) => {
          const s = b.set[k], v7 = s.model[P], v5 = s.model.A0;
          const r7 = (v7 as { recall_fpr1?: number }).recall_fpr1 ?? v7.recall, r5 = v5 ? ((v5 as { recall_fpr1?: number }).recall_fpr1 ?? v5.recall) : undefined;
          return (
            <div key={k} className="space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]"><span className="font-medium text-white">{t}</span><span className="text-[#8f99a8]">{ket} · {idn(s.klaim)} klaim, {idn(s.fraud)} fraud</span></p>
              <div className="grid grid-cols-[52px_minmax(0,1fr)_44px] items-center gap-2 text-[11px]">
                <span className="text-[#d3d8de]">ML v7</span><Batang nilai={r7} warna={SERIES[1]} tinggi={7} /><span className="text-right tabular-nums text-white">{pct(r7, 0)}</span>
              </div>
              {r5 !== undefined && (
                <div className="grid grid-cols-[52px_minmax(0,1fr)_44px] items-center gap-2 text-[11px]">
                  <span className="text-[#8f99a8]">ML v5</span><Batang nilai={r5} warna="#5f6b7a" tinggi={5} /><span className="text-right tabular-nums text-[#8f99a8]">{pct(r5, 0)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-justify text-[11px] leading-relaxed text-[#abb3bf]">
        Makin asing pola fraud-nya, makin sedikit yang ditangkap model sendiri (generator 4 ditulis tanpa melihat model). Itulah alasan arsitektur ini tidak
        mengandalkan model saja: rule engine di depan menangkap pola yang sudah diketahui, dan AI Agent Swarm membaca zona ragu untuk menilai bukti tiap klaim.
      </p>
    </section>
  );
}

export function SysArchMl({ onBuka, onRuleBerubah }: { onBuka?: (b: "swarm" | "rule") => void; onRuleBerubah?: () => void }) {
  const { me, enabled } = useAuth();
  const admin = !enabled || me?.role === "admin";
  const [d, setD] = useState<Doc | null>(null);
  const [err, setErr] = useState("");
  const [rule, setRule] = useState<Daftar | null>(null);
  const [ruleGalat, setRuleGalat] = useState(false);
  const [kelola, setKelola] = useState(false);
  useEffect(() => {
    fetch("/api/ml-sistem?bagian=v7", { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); setD(j as Doc); })
      .catch((e) => setErr((e as Error).message));
    aturanApi.daftar().then(setRule, () => setRuleGalat(true));
  }, []);
  // the drawer's list is the same rule list: a change there updates the node's counts (and the full Rule engine page reloads)
  const berubah = useCallback((x: Daftar) => { setRule(x); setRuleGalat(false); }, []);
  const tutup = useCallback(() => setKelola(false), []);

  if (err) return <Galat teks={`Sistem ML tidak terbaca: ${err}`} />;
  if (!d) return <Memuat teks="Memuat arsitektur ML v7…" />;
  const b = d.ml_v7;
  if (!b) return <Catatan>Belum ada hasil ML v7 di laporan sistem ML (testing/ml_v7.py).</Catatan>;
  const o = b.kartu.cek_overfit as Overfit;
  return (
    <div className="space-y-4">
      <section className={`${kartu} space-y-3 p-3.5`}>
        <Judul ikon="cpu" judul="Arsitektur sistem yang dipakai · ML v7 + rule engine"
          sub={<>Rule engine → graph klaim → {N_FITUR} fitur per klaim → ML v7 (LightGBM × 3) → zona keputusan → AI Agent Swarm. Klik Rule engine untuk melihat, mengedit, menghapus, atau menambah rule.</>}
          kanan={<>
            <Chip nada="hijau" ikon="check">dipakai AI Agent Swarm Branch</Chip>
            <Chip nada="redup">model dibekukan {b.dibuat.slice(0, 10)}</Chip>
            <Chip nada="kuning">Data sintetis</Chip>
            <a href="?tab=ml" className={tombolNetral}><Icon name="external" className="h-3.5 w-3.5" />ML Studio</a>
          </>} />
        <Alur b={b} z={d.zona} rule={rule} ruleGalat={ruleGalat} onRule={() => setKelola(true)} onSwarm={onBuka ? () => onBuka("swarm") : undefined} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[.06] pt-2.5 text-[11px] text-[#8f99a8]">
          <span>45 rule bawaan yang dibaca model dibekukan: rule baru masuk sebagai rule kustom, tanpa melatih ulang model.</span>
          {d.zona && <span>Zona RAGU menangkap {pct(d.zona.cek.recall_lebar, 0)} fraud di data dev dengan {pct(d.zona.cek.fpr_lebar, 0)} klaim normal ikut dibaca.</span>}
        </div>
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Penentu o={o} rule={rule} />
        <Hasil b={b} />
      </div>
      <KelolaRule buka={kelola} onTutup={tutup} admin={admin} onBerubah={berubah} onDiubah={onRuleBerubah} onHalamanLengkap={onBuka ? () => { setKelola(false); onBuka("rule"); } : undefined} />
    </div>
  );
}
