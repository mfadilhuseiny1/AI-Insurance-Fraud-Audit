"use client";
// AI Agent Swarm Branch, "Indikasi & rekomendasi" tab: every claim the run recommends to the branch's verifiers (ditahan or perlu
// diperiksa) in one table to search, filter and sort: the claim, its hospital, its fraud type (the Permenkes 16/2019 mode its
// explanation names, graf_<kc>/index.json), the decision, the estimated loss, the checking priority and the verifier's result
// so far. A row opens that claim's file in the report (the Laporan tab).
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { fmt } from "./CabangTabBersama";

export type BarisIndikasi = { id: string; tgl: string; rs: string; kabkota?: string; tema: string;
  modus: { kode: string; nama: string; singkat: string; warna: string };
  keputusan: "TAHAN" | "PERIKSA"; rugi: number | null; dasar?: string; tagihan: number; prioritas: "P1" | "P2" | "P3" | null; indeks: number;
  status: "terbukti" | "sesuai" | "investigasi" | null };

const rp = (v: number) => (v >= 1e9 ? `Rp ${fmt(v / 1e9, 2)} M` : v >= 1e6 ? `Rp ${fmt(v / 1e6, 1)} jt` : `Rp ${fmt(v)}`);
const KEP: Record<string, [string, string, string]> = {
  TAHAN: ["Ditahan", "#ff8a8d", "skor model sangat tinggi; pembayaran ditahan sampai diverifikasi"],
  PERIKSA: ["Perlu diperiksa", "#f0c661", "tim agen AI menilai buktinya cukup untuk dicek verifikator"] };
const PRIO: Record<string, [string, string]> = { P1: ["P1 · segera", "#ff8a8d"], P2: ["P2", "#f0c661"], P3: ["P3", "#c5cbd3"] };
const STATUS: Record<string, [string, string]> = { terbukti: ["Terbukti bermasalah", "#ff8a8d"], sesuai: ["Sesuai", "#7ee2c0"], investigasi: ["Perlu investigasi", "#f0c661"] };
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const tgl = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return y && m && d ? `${d} ${BULAN[m - 1]} ${y}` : s; };
const PER_HALAMAN = 50;
type Urut = "prioritas" | "rugi" | "klaim" | "rs";

function Saring<T extends string>({ label, nilai, pilih, opsi }: { label: string; nilai: T; pilih: (v: T) => void; opsi: [T, string, number?][] }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="mr-0.5 text-[10.5px] text-[#8f99a8]">{label}</span>
      <div className="flex flex-wrap rounded border border-white/10 p-0.5 text-[11px]">
        {opsi.map(([v, t, n]) => (
          <button key={v} onClick={() => pilih(v)} aria-pressed={nilai === v}
            className={`rounded-sm px-2 py-0.5 ${nilai === v ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
            {t}{n != null && <span className="ml-1 tabular-nums text-[#8f99a8]">{fmt(n)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CabangTabIndikasi({ baris, onBuka, jenisMemuat = false }: { baris: BarisIndikasi[]; onBuka: (id: string) => void; jenisMemuat?: boolean }) {
  const [cari, setCari] = useState("");
  const [kep, setKep] = useState<"semua" | "TAHAN" | "PERIKSA">("semua");
  const [prio, setPrio] = useState<"semua" | "P1" | "P2" | "P3">("semua");
  const [ver, setVer] = useState<"semua" | "belum" | "terbukti" | "sesuai" | "investigasi">("semua");
  const [jenis, setJenis] = useState<string | null>(null);
  const [urut, setUrut] = useState<{ k: Urut; turun: boolean }>({ k: "prioritas", turun: true });
  const [n, setN] = useState(PER_HALAMAN);

  const hitung = useMemo(() => {
    const h = { TAHAN: 0, PERIKSA: 0, P1: 0, P2: 0, P3: 0, belum: 0, terbukti: 0, sesuai: 0, investigasi: 0, rugi: 0 } as Record<string, number>;
    for (const b of baris) {
      h[b.keputusan] += 1;
      if (b.prioritas) h[b.prioritas] += 1;
      h[b.status ?? "belum"] += 1;
      h.rugi += b.rugi ?? 0;
    }
    return h;
  }, [baris]);
  const jenisDaftar = useMemo(() => {
    const m = new Map<string, { m: BarisIndikasi["modus"]; n: number; rugi: number }>();
    for (const b of baris) {
      const k = `${b.modus.kode}|${b.modus.nama}`;
      const x = m.get(k) ?? { m: b.modus, n: 0, rugi: 0 };
      x.n += 1; x.rugi += b.rugi ?? 0;
      m.set(k, x);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n || b[1].rugi - a[1].rugi);
  }, [baris]);

  const q = cari.trim().toLowerCase();
  const lolos = useMemo(() => {
    const out = baris.filter((b) => (kep === "semua" || b.keputusan === kep) && (prio === "semua" || b.prioritas === prio)
      && (ver === "semua" || (b.status ?? "belum") === ver) && (!jenis || `${b.modus.kode}|${b.modus.nama}` === jenis)
      && (!q || `${b.id} ${b.rs} ${b.kabkota ?? ""} ${b.modus.kode} ${b.modus.nama} ${b.modus.singkat} ${b.tema}`.toLowerCase().includes(q)));
    const arah = urut.turun ? -1 : 1;
    const f: Record<Urut, (a: BarisIndikasi, b: BarisIndikasi) => number> = {
      prioritas: (a, b) => a.indeks - b.indeks, rugi: (a, b) => (a.rugi ?? -1) - (b.rugi ?? -1),
      klaim: (a, b) => a.id.localeCompare(b.id), rs: (a, b) => a.rs.localeCompare(b.rs, "id") };
    return out.sort((a, b) => arah * f[urut.k](a, b));
  }, [baris, kep, prio, ver, jenis, q, urut]);
  const tampil = lolos.slice(0, n);
  const adaSaring = kep !== "semua" || prio !== "semua" || ver !== "semua" || !!jenis || !!q;
  const ulang = () => { setKep("semua"); setPrio("semua"); setVer("semua"); setJenis(null); setCari(""); setN(PER_HALAMAN); };
  const atur = <T,>(f: (v: T) => void) => (v: T) => { f(v); setN(PER_HALAMAN); };
  const kepala = (k: Urut, label: string, kanan = false) => (
    <th className={`px-2 py-1.5 font-medium ${kanan ? "text-right" : "text-left"}`} aria-sort={urut.k === k ? (urut.turun ? "descending" : "ascending") : undefined}>
      <button onClick={() => setUrut((u) => ({ k, turun: u.k === k ? !u.turun : k === "prioritas" || k === "rugi" }))}
        className={`inline-flex items-center gap-1 hover:text-white ${urut.k === k ? "text-white" : ""}`}>
        {label}{urut.k === k && <Icon name="down" className={`h-3 w-3 ${urut.turun ? "" : "rotate-180"}`} />}
      </button>
    </th>
  );

  if (!baris.length) return <p className="py-10 text-center text-[12px] text-[#8f99a8]">Tidak ada klaim yang direkomendasikan untuk diperiksa di KC ini.</p>;
  const verDone = hitung.terbukti + hitung.sesuai + hitung.investigasi;
  return (
    <div className="space-y-3">
      <section className="rounded border border-white/10 bg-[#1c2127] px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">Indikasi & rekomendasi</p>
            <p className="mt-0.5 text-[22px] font-semibold tabular-nums text-white">{fmt(baris.length)} klaim direkomendasikan</p>
          </div>
          <div><p className="text-[16px] font-semibold tabular-nums text-white">{fmt(hitung.TAHAN)} <span className="text-[12px] font-normal text-[#8f99a8]">/</span> {fmt(hitung.PERIKSA)}</p>
            <p className="text-[10.5px] text-[#8f99a8]">ditahan / perlu diperiksa</p></div>
          <div><p className="text-[16px] font-semibold tabular-nums text-white">{rp(hitung.rugi)}</p><p className="text-[10.5px] text-[#8f99a8]">estimasi kerugian (menunggu verifikasi)</p></div>
          <div><p className="text-[16px] font-semibold tabular-nums text-white">{fmt(hitung.P1)}</p><p className="text-[10.5px] text-[#8f99a8]">prioritas P1 · cek lebih dulu</p></div>
          <div><p className="text-[16px] font-semibold tabular-nums text-white">{fmt(verDone)} <span className="text-[12px] font-normal text-[#8f99a8]">dari {fmt(baris.length)}</span></p>
            <p className="text-[10.5px] text-[#8f99a8]">sudah diverifikasi</p></div>
        </div>
        <p className="mt-2 max-w-[920px] text-[12px] leading-relaxed text-[#d3d8de]">
          Daftar ini adalah klaim yang perlu dicek verifikator kantor cabang: <b className="font-medium text-white">ditahan</b> karena skor model sangat tinggi, atau <b className="font-medium text-white">perlu diperiksa</b> karena tim agen AI menilai buktinya cukup.
          Sistem hanya menandai; keputusan fraud ada di verifikator. Klik baris untuk membuka berkas klaimnya di laporan.
        </p>
      </section>

      {/* the fraud types, as chips that filter the table (the national audit's tags, here per claim) */}
      <section className="rounded border border-white/10 bg-[#1c2127] p-3">
        <p className="mb-1.5 text-[11.5px] font-semibold text-white">Jenis fraud <span className="font-normal text-[#8f99a8]">· modus Permenkes 16/2019 yang disebut penjelasan tiap klaim; klik untuk menyaring</span></p>
        <div className="flex flex-wrap gap-1.5">
          {jenisDaftar.map(([k, x]) => (
            <button key={k} onClick={() => atur(setJenis)(jenis === k ? null : k)} aria-pressed={jenis === k} title={`${x.m.kode ? `${x.m.kode} · ` : ""}${x.m.nama} · ${rp(x.rugi)}`}
              className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${jenis === k ? "border-white/40 bg-white/10 text-white" : "border-white/10 text-[#d3d8de] hover:border-white/25"}`}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: x.m.warna }} />
              {x.m.kode && <span className="font-mono text-[10px] text-[#abb3bf]">{x.m.kode}</span>}
              <span>{x.m.singkat}</span><span className="tabular-nums text-[#8f99a8]">{fmt(x.n)}</span>
            </button>
          ))}
        </div>
        {jenisMemuat && <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Memuat jenis fraud dari jaringan klaim… sementara itu tampil kelompok indikasi tim agen AI.</p>}
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8f99a8]" />
          <input value={cari} onChange={(e) => atur(setCari)(e.target.value)} placeholder="Cari ID klaim, RS, kab/kota, jenis fraud" aria-label="Cari klaim"
            className="w-72 rounded border border-white/10 bg-black/20 py-1 pl-7 pr-2 text-[11.5px] text-white placeholder:text-[#6f7a87] focus:border-[#9d8cff]/60 focus:outline-none" />
        </label>
        <Saring label="Keputusan" nilai={kep} pilih={atur(setKep)} opsi={[["semua", "Semua"], ["TAHAN", "Ditahan", hitung.TAHAN], ["PERIKSA", "Perlu diperiksa", hitung.PERIKSA]]} />
        <Saring label="Prioritas" nilai={prio} pilih={atur(setPrio)} opsi={[["semua", "Semua"], ["P1", "P1", hitung.P1], ["P2", "P2", hitung.P2], ["P3", "P3", hitung.P3]]} />
        <Saring label="Verifikasi" nilai={ver} pilih={atur(setVer)} opsi={[["semua", "Semua"], ["belum", "Belum", hitung.belum], ["terbukti", "Terbukti", hitung.terbukti],
          ["sesuai", "Sesuai", hitung.sesuai], ["investigasi", "Investigasi", hitung.investigasi]]} />
        {adaSaring && <button onClick={ulang} className="text-[11px] text-[#b8a9ff] hover:text-white">Hapus saringan</button>}
      </div>

      <div className="overflow-x-auto rounded border border-white/10 bg-[#1c2127]">
        <table className="w-full text-[11.5px]">
          <thead className="bg-[#20262d] text-[11px] text-[#8f99a8]">
            <tr>
              {kepala("klaim", "Klaim")}{kepala("rs", "Rumah sakit")}
              <th className="px-2 py-1.5 text-left font-medium">Jenis fraud</th><th className="px-2 py-1.5 text-left font-medium">Keputusan</th>
              {kepala("rugi", "Estimasi rugi", true)}{kepala("prioritas", "Prioritas")}
              <th className="px-2 py-1.5 text-left font-medium">Verifikasi</th><th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {tampil.map((b) => {
              const [kn, kw, kt] = KEP[b.keputusan];
              const st = b.status ? STATUS[b.status] : null;
              return (
                <tr key={b.id} tabIndex={0} role="link" aria-label={`Buka berkas klaim ${b.id}`} onClick={() => onBuka(b.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBuka(b.id); } }}
                  className="cursor-pointer border-t border-white/[.05] text-[#e5e8eb] hover:bg-white/[.04] focus:bg-white/[.05] focus:outline-none">
                  <td className="whitespace-nowrap px-2 py-1.5"><span className="font-mono text-[11px] text-white">{b.id}</span><span className="block text-[10.5px] text-[#8f99a8]">{tgl(b.tgl)}</span></td>
                  <td className="max-w-[260px] px-2 py-1.5"><span className="block truncate" title={b.rs}>{b.rs}</span>{b.kabkota && <span className="block truncate text-[10.5px] text-[#8f99a8]">{b.kabkota}</span>}</td>
                  <td className="max-w-[240px] px-2 py-1.5">
                    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={`${b.modus.kode ? `${b.modus.kode} · ` : ""}${b.modus.nama}`}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: b.modus.warna }} />
                      {b.modus.kode && <span className="shrink-0 font-mono text-[10px] text-[#abb3bf]">{b.modus.kode}</span>}
                      <span className="truncate">{b.modus.singkat}</span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5"><span title={kt} className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: `${kw}22`, color: kw }}>{kn}</span></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums" title={b.dasar ? `Dasar estimasi: ${b.dasar}` : undefined}>{b.rugi ? rp(b.rugi) : "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{b.prioritas ? <span style={{ color: PRIO[b.prioritas][1] }}>{PRIO[b.prioritas][0]}</span> : <span className="text-[#8f99a8]">–</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{st ? <span style={{ color: st[1] }}>{st[0]}</span> : <span className="text-[#8f99a8]">belum</span>}</td>
                  <td className="px-1 text-[#8f99a8]"><Icon name="right" className="h-3.5 w-3.5" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!lolos.length && <p className="px-3 py-6 text-center text-[11.5px] text-[#8f99a8]">Tidak ada klaim yang cocok dengan saringan ini.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-[#8f99a8]">{fmt(tampil.length)} dari {fmt(lolos.length)} klaim{adaSaring ? ` (tersaring dari ${fmt(baris.length)})` : ""} · urutan prioritas = skor risiko × nilai tagihan</span>
        {lolos.length > tampil.length && (
          <>
            <button onClick={() => setN((x) => x + PER_HALAMAN)} className="rounded border border-white/10 px-2.5 py-1 text-[#d3d8de] hover:bg-white/5">Tampilkan {fmt(Math.min(PER_HALAMAN, lolos.length - tampil.length))} lagi</button>
            <button onClick={() => setN(lolos.length)} className="rounded px-2 py-1 text-[#9d8cff] hover:text-white">Tampilkan semua ({fmt(lolos.length)})</button>
          </>
        )}
      </div>
    </div>
  );
}
