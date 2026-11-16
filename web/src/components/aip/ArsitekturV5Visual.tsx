"use client";

// ML Studio · the v5 architecture, drawn (the user, 2026-11-13: "show the architecture on the UI, visual, not a lot of table
// and text, easily understandable, with complete information, especially in ML Studio"). Five layers as lanes of nodes with
// a key number each; claims flow down (animated, none when the viewer asks for reduced motion); a click on a node opens its
// complete details below. Live numbers come from the ML v5 benchmark and the v5 swarm run; the rest is the system as built.

import { useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import type { MLV5 } from "./BenchmarkMlV5";
import type { V5 } from "./SistemV5";
import { SERIES } from "./viz";

type Status = "jalan" | "eksperimen" | "rencana";
type Node = { id: string; ikon: IconName; judul: string; angka: string; status: Status; apa: string; poin: [string, string][]; batas?: string };
type Lapis = { id: string; nama: string; sub: string; warna: string; nodes: Node[] };

const id = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v?: number, d = 1) => (v === undefined || Number.isNaN(v) ? "—" : `${id(v * 100, d)}%`);
const STATUS: Record<Status, [string, string]> = { jalan: ["berjalan", "#7ee2c0"], eksperimen: ["eksperimen", "#f0c661"], rencana: ["rencana", "#8f99a8"] };

function bangun(b?: MLV5, v?: V5): Lapis[] {
  const g3 = b?.set.generator3?.model, g2 = b?.set.generator2?.model, g1 = b?.set.generator1?.model;
  const k = b?.kartu, c = k?.cek_overfit;
  const h = v?.hasil;
  const nRagu = h?.ragu ?? 0, nKlaim = h?.klaim ?? 0, nTahan = h?.tahan?.ditandai ?? 0;
  return [
    { id: "data", nama: "0 · Data & fitur", sub: "lokal · batch per KC", warna: "#8f99a8", nodes: [
      { id: "klaim", ikon: "upload", judul: "Klaim RS", angka: "batch", status: "jalan", apa: "Klaim FKRTL satu kantor cabang per periode, diproses berurutan menurut tanggal.",
        poin: [["Isi", "peserta · RS · kode INA-CBG · tanggal · tagihan · LOS · top-up"], ["Kausal", "setiap fitur hanya memakai klaim yang datang lebih dulu"], ["Privasi", "data real diproses lokal saja"]] },
      { id: "x1", ikon: "graph", judul: "Graph tetangga", angka: "624 fitur", status: "jalan", apa: "Setiap klaim dihubungkan ke klaim lain lewat 4 relasi; rata-rata tetangganya jadi fitur.",
        poin: [["Relasi", "peserta sama · RS sama · RS + kode sama · kode sama"], ["Isi", "124 fitur klaim + 4 × 124 rata-rata tetangga + 4 jumlah tetangga"], ["Porsi di ML v5", c ? pct(c.porsi_gain_blok["X1 klaim sendiri"] + c.porsi_gain_blok["X1 tetangga graph"], 0) : "—"]] },
      { id: "xr", ikon: "split", judul: "Jaringan", angka: "±3 hari", status: "jalan", apa: "Peserta lain yang berbagi RS dalam beberapa hari: pola rujukan semu dan kolusi.",
        poin: [["Dipakai", "fitur model + network rule"]] },
      { id: "x4", ikon: "bolt", judul: "Mekanisme", angka: "22 fitur", status: "jalan", apa: "Jejak cara fraud dilakukan, dihitung dari klaim sebelumnya.",
        poin: [["Contoh", "klaim mirip · kartu di RS lain hari sama · top-up/LOS/biaya vs median kode · readmisi · pergeseran pola RS"], ["Porsi di ML v5", c ? pct(c.porsi_gain_blok["X4 mekanisme"], 0) : "—"]] },
      { id: "x5", ikon: "sparkle", judul: "Modus Permenkes", angka: "11 fitur", status: "eksperimen", apa: "Fitur baru dari definisi modus: demografi, sesi rutin, lonjakan RS, jaringan RS.",
        poin: [["Hasil di dev", "tidak menambah recall → tidak dipakai ML v5 (kandidat lebih sederhana menang)"]], batas: "Disimpan sebagai kandidat untuk ML v6." },
    ] },
    { id: "lapis1", nama: "1 · Penyaring", sub: "semua klaim · lokal · murah", warna: SERIES[0], nodes: [
      { id: "ml", ikon: "cpu", judul: "ML v5", angka: g3 ? `recall ${pct(g3.ml_v5.recall)}` : "LightGBM", status: "jalan", apa: "LightGBM × 3 seed, dilatih dengan generator 1 + 2, ambang beku dari data dev.",
        poin: [["Latih", k ? `${id(k.latih.gen1 + k.latih.gen2)} klaim (${id(k.latih.fraud)} fraud)` : "—"], ["Fitur", k ? `${k.kolom}` : "—"],
          ["Generator 3 (data asing)", g3 ? `recall ${pct(g3.v4.recall)} → ${pct(g3.ml_v5.recall)} · precision ${pct(g3.v4.presisi_prev2, 0)} → ${pct(g3.ml_v5.presisi_prev2, 0)}` : "—"],
          ["Generator 2", g2 ? `recall ${pct(g2.v4.recall)} → ${pct(g2.ml_v5.recall)}` : "—"], ["Generator 1", g1 ? `recall ${pct(g1.v4.recall)} → ${pct(g1.ml_v5.recall)}` : "—"],
          ["Cek overfit", c ? `latih ${id(c.auprc_latih_insample, 2)} · CV ${id(c.auprc_latih_oof_per_peserta, 2)} · ${c.peringatan.length ? "ada peringatan" : "lolos"}` : "—"]],
        batas: "Generator 1 sedikit turun (−3,7 poin). Semua angka dari data sintetis." },
      { id: "rule", ikon: "logic", judul: "Rule engine", angka: "bawaan + kustom", status: "jalan", apa: "Aturan modus Permenkes ditambah aturan yang ditulis auditor dalam bahasa biasa.",
        poin: [["Rule kustom", "bahasa biasa → AI → backtest → disetujui admin"], ["Peran", "sinyal ke model + kirim klaim ke zona ragu"], ["Ke Box Karantina", "klaim TAHAN/PERIKSA jadi tag di ledger"]] },
      { id: "zona", ikon: "filter", judul: "Zona", angka: nKlaim ? `ragu ${pct(nRagu / nKlaim)}` : "3 zona", status: "jalan", apa: "Setiap klaim masuk satu zona.",
        poin: [["TAHAN", nKlaim ? `${pct(nTahan / nKlaim, 2)} · skor sangat tinggi (FPR 0,1%)` : "skor sangat tinggi"], ["RAGU", nKlaim ? `${pct(nRagu / nKlaim)} · skor menengah atau rule menyala → swarm` : "→ swarm"],
          ["LOLOS", nKlaim ? `${pct(1 - (nRagu + nTahan) / nKlaim)} · dibayar tanpa antrean` : "sisanya"]] },
    ] },
    { id: "lapis2", nama: "2 · AI Agent Swarm", sub: "hanya klaim ragu · Google ADK · Vertex AI", warna: SERIES[2], nodes: [
      { id: "sp", ikon: "constellation", judul: "3 spesialis", angka: "paralel", status: "jalan", apa: "Koding & klinis · tagihan · episode & jaringan membaca berkas fakta klaim yang sama.",
        poin: [["Model", "DeepSeek V4.1 Flash (Vertex AI)"], ["Berkas", "fakta dari fitur, tanpa skor model atau label"], ["Keluaran", "skor risiko + bukti + alasan per klaim"]] },
      { id: "hakim", ikon: "check", judul: "Hakim", angka: h ? `+${id((h.v5.recall - h.v4_B.recall) * 100, 1)} recall` : "keputusan", status: "jalan", apa: "Menimbang pendapat tiga spesialis; skornya digabung dengan skor ML.",
        poin: [["Generator 3", h ? `recall ${pct(h.v4_B.recall)} → ${pct(h.v5.recall)} · precision ${pct(h.v4_B.presisi_prev2, 0)} → ${pct(h.v5.presisi_prev2, 0)}` : "—"],
          ["Uji adil", "antrean sama besar: swarm +2,3 s/d +6,6 poin recall dibanding filter model"], ["Biaya", "≈ $1,4 per 1.000 klaim ragu"]] },
      { id: "orc", ikon: "layers", judul: "Orchestrator", angka: "GLM 5.2", status: "rencana", apa: "Merencanakan audit per tema, menulis kontrak validasi, meninjau tiap milestone.",
        poin: [["Tool agen", "riwayat peserta · profil RS · pembanding kode · jaringan"], ["Validator", "cek kode + gpt-oss-120b (independen)"]], batas: "Desain v6 Audit Mission; belum dijalankan." },
    ] },
    { id: "lapis3", nama: "3 · Keluaran", sub: "untuk kantor cabang & pusat", warna: SERIES[3], nodes: [
      { id: "lap", ikon: "doc", judul: "Laporan KC", angka: "per tema", status: "jalan", apa: "Laporan audit per kantor cabang, dikelompokkan per tema klinis (ICD-10).",
        poin: [["Per klaim", "indikasi modus · bukti · pendapat 4 agen · rekomendasi tindakan"], ["Prioritas", "skor risiko × nilai tagihan (P1/P2/P3)"], ["Narasi", "agen penulis; angka dicek kode"]] },
      { id: "box", ikon: "lock", judul: "Box Karantina", angka: "ledger tag", status: "jalan", apa: "Temuan swarm cabang dan rule engine masuk ledger yang sama dengan audit nasional.",
        poin: [["Isi", "tag per klaim → peringkat RS + estimasi kerugian"], ["Sumber", "deteksi realtime · penanda otomatis · swarm cabang · agen nasional"]] },
      { id: "rugi", ikon: "gauge", judul: "Estimasi kerugian", angka: "Rp per modus", status: "rencana", apa: "Akuntan kerugian (kode) per klaim, per modus, per RS, per tema.",
        poin: [["Komponen", "di luar paket · di atas pembanding · selisih keparahan · klaim ganda · tarif klaim kedua"]], batas: "Dirancang, belum dibangun." },
    ] },
    { id: "lapis4", nama: "4 · Verifikator", sub: "manusia memutuskan", warna: "#c5cbd3", nodes: [
      { id: "ver", ikon: "eye", judul: "Keputusan", angka: "3 status", status: "jalan", apa: "Verifikator kantor cabang memutuskan setiap klaim di antrean.",
        poin: [["Status", "terbukti bermasalah · sesuai · perlu investigasi"], ["Tersimpan", "laporan KC + ledger (Box Karantina)"]] },
      { id: "fb", ikon: "refresh", judul: "Umpan balik", angka: "belajar", status: "rencana", apa: "Keputusan verifikator menjadi usulan rule baru dan data latih ulang.",
        poin: [["Ke", "rule engine (disetujui admin) · ML · prompt agen"]] },
    ] },
  ];
}

function Kotak({ n, w, aktif, onClick }: { n: Node; w: string; aktif: boolean; onClick: () => void }) {
  const [sl, sw] = STATUS[n.status];
  return (
    <button type="button" onClick={onClick} aria-pressed={aktif}
      className={`group relative flex min-w-[148px] flex-1 flex-col items-start gap-1 rounded-lg border bg-[#151a1f] px-3 py-2.5 text-left transition hover:-translate-y-0.5 ${n.status === "rencana" ? "border-dashed" : ""}`}
      style={{ borderColor: aktif ? w : `${w}55`, boxShadow: aktif ? `0 0 0 1px ${w}, 0 0 18px ${w}33` : undefined }}>
      <span className="flex w-full items-center gap-1.5">
        <span style={{ color: w }}><Icon name={n.ikon} className="h-4 w-4" /></span>
        <span className="truncate text-[12px] font-semibold text-white">{n.judul}</span>
        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" title={sl} style={{ background: sw }} />
      </span>
      <span className="text-[15px] font-semibold tabular-nums leading-tight" style={{ color: n.status === "rencana" ? "#8f99a8" : "#ffffff" }}>{n.angka}</span>
    </button>
  );
}

export function ArsitekturV5Visual({ b, v }: { b?: MLV5; v?: V5 }) {
  const lapis = useMemo(() => bangun(b, v), [b, v]);
  const [pilih, setPilih] = useState("ml");
  const semua = lapis.flatMap((l) => l.nodes.map((n) => ({ n, l })));
  const cur = semua.find((x) => x.n.id === pilih) ?? semua[0];
  return (
    <section className="rounded-xl border border-white/[.08] bg-[#151a1f] p-4">
      <style>{`
        @keyframes v5-alir { from { transform: translateY(-6px); opacity: 0; } 30% { opacity: 1; } to { transform: translateY(22px); opacity: 0; } }
        .v5-titik { animation: v5-alir 1.6s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .v5-titik { animation: none; opacity: .6; transform: translateY(8px); } }
      `}</style>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-white">Arsitektur v5</h3>
        <span className="text-[11px] text-[#8f99a8]">klik kotak untuk detail</span>
        <span className="ml-auto flex flex-wrap gap-3 text-[10.5px] text-[#abb3bf]">
          {(Object.keys(STATUS) as Status[]).map((s) => <span key={s} className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[s][1] }} />{STATUS[s][0]}</span>)}
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div>
          {lapis.map((l, i) => (
            <div key={l.id}>
              <div className="grid items-stretch gap-3 md:grid-cols-[150px_1fr]">
                <div className="flex flex-col justify-center border-l-2 pl-2.5" style={{ borderColor: l.warna }}>
                  <p className="text-[12px] font-semibold text-white">{l.nama}</p>
                  <p className="text-[10px] leading-snug text-[#8f99a8]">{l.sub}</p>
                </div>
                <div className="flex flex-wrap gap-2">{l.nodes.map((n) => <Kotak key={n.id} n={n} w={l.warna} aktif={n.id === pilih} onClick={() => setPilih(n.id)} />)}</div>
              </div>
              {i < lapis.length - 1 && (
                <div className="relative ml-[150px] flex h-6 justify-center max-md:ml-0" aria-hidden>
                  <span className="h-full w-px bg-gradient-to-b from-white/25 to-white/5" />
                  <span className="v5-titik absolute top-0 h-1.5 w-1.5 rounded-full" style={{ background: lapis[i + 1].warna, animationDelay: `${i * 0.3}s` }} />
                </div>
              )}
            </div>
          ))}
        </div>
        <aside className="rounded-lg border p-3" style={{ borderColor: `${cur.l.warna}66`, background: `${cur.l.warna}0d` }}>
          <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: cur.l.warna }}>{cur.l.nama}</p>
          <div className="mt-1 flex items-center gap-2">
            <span style={{ color: cur.l.warna }}><Icon name={cur.n.ikon} className="h-5 w-5" /></span>
            <p className="text-[15px] font-semibold text-white">{cur.n.judul}</p>
            <span className="ml-auto rounded px-1.5 py-0.5 text-[10px]" style={{ background: `${STATUS[cur.n.status][1]}22`, color: STATUS[cur.n.status][1] }}>{STATUS[cur.n.status][0]}</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-snug text-[#d3d8de]">{cur.n.apa}</p>
          <dl className="mt-3 space-y-2">
            {cur.n.poin.map(([a, c]) => (
              <div key={a} className="rounded-md border border-white/[.07] bg-[#151a1f] px-2.5 py-1.5">
                <dt className="text-[10px] uppercase tracking-wide text-[#8f99a8]">{a}</dt>
                <dd className="text-[12px] leading-snug text-white">{c}</dd>
              </div>
            ))}
          </dl>
          {cur.n.batas && <p className="mt-2 text-[11px] leading-snug text-[#f0c661]">{cur.n.batas}</p>}
        </aside>
      </div>
    </section>
  );
}
