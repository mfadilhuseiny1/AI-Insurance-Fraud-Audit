"use client";
// AI Agent Swarm Branch, "Biaya & token" tab, drawn as the national audit's (AnatomiPenugasan): the run's total against its cost cap,
// time per step, tokens by kind / role / model, cost by model / role / token kind, cost per claim, the agents at work over time and
// the cost per agent. Everything from the run's own records (GET /api/swarm-cabang?run=<id>&biaya=1, src/lib/cabangJejak.ts): the
// runner prices model calls per step, not per agent, so a breakdown it does not record is marked as such, never estimated.
import { useEffect, useState } from "react";
import type { BiayaRun, Jejak, Kolom } from "@/lib/cabangJejak";
import { SERIES, Tooltip, useTip } from "./viz";
import { AGEN_CABANG, KepalaBagian, Kpi, MODEL_CABANG, NAMA_TAHAP, SubJudul, TakTercatat, fmt, jam, lama, persen, tok, usd } from "./CabangTabBersama";

type Part = { label: string; value: number; color: string; note?: string };
const PERAN = [{ key: "spesialis", label: "Spesialis", color: SERIES[0] }, { key: "hakim", label: "Hakim", color: SERIES[1] }, { key: "penulis", label: "Agen penulis", color: SERIES[2] }] as const;
const TIM = "Tim agen AI (3 spesialis + hakim)";

/** A whole split into parts: one bar with 2px gaps, the legend under it with each part's value (as AnatomiPenugasan's) */
function Split({ parts, fmt: f, total }: { parts: Part[]; fmt: (n: number) => string; total?: number }) {
  const { box, tip, at, clear } = useTip();
  const sum = total ?? parts.reduce((s, p) => s + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="flex h-[10px] gap-[2px] overflow-hidden rounded-[4px] bg-white/[.04]">
        {shown.map((p) => (
          <span key={p.label} className="h-full min-w-[3px] transition-[filter] hover:brightness-125" style={{ width: `${(100 * p.value) / (sum || 1)}%`, background: p.color }}
            onPointerMove={(e) => at(e, { title: p.label, lines: [{ key: p.color, value: f(p.value), label: persen(p.value, sum) }, ...(p.note ? [{ value: "", label: p.note }] : [])] })} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {shown.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span className="text-[#abb3bf]">{p.label}</span>
            <span className="font-semibold tabular-nums text-white">{f(p.value)}</span>
            {p.note && <span className="text-[#8f99a8]">{p.note}</span>}
          </span>
        ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** The agents' answers per time step: stacked columns by role (a finished swarm batch = 3 specialists + the judge answering 8 claims) */
function Aktivitas({ a }: { a: NonNullable<BiayaRun["aktivitas"]> }) {
  const { box, tip, at, clear } = useTip();
  const jumlah = (k: Kolom) => k.spesialis + k.hakim + k.penulis;
  const top = Math.max(1, ...a.kolom.map(jumlah));
  const total = Object.fromEntries(PERAN.map((p) => [p.key, a.kolom.reduce((s, k) => s + k[p.key], 0)])) as Record<keyof Kolom, number>;
  const m = (i: number) => Math.round((i * a.langkah) / 60);
  const mulaiMs = new Date(a.mulai.replace(" ", "T")).getTime();
  const pukul = (i: number) => { const d = new Date(mulaiMs + i * a.langkah * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="flex items-end gap-[2px]" style={{ height: 96 }} role="img" aria-label={`Jawaban agen per ${a.langkah / 60} menit: spesialis ${total.spesialis}, hakim ${total.hakim}, agen penulis ${total.penulis}`}>
        {a.kolom.map((k, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px]"
            onPointerMove={(e) => at(e, { title: `menit ${m(i)}–${m(i + 1)} (${pukul(i)})`,
              lines: PERAN.map((p) => ({ key: p.color, value: String(k[p.key]), label: `jawaban ${p.label.toLowerCase()}` })) })}>
            {[...PERAN].reverse().map((p) => k[p.key] > 0 && (
              <span key={p.key} className="w-full rounded-t-[2px]" style={{ height: `${(100 * k[p.key]) / top}%`, background: p.color }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between border-t border-[#2c333b] pt-1 text-[10px] tabular-nums text-[#8f99a8]">
        <span>0 ({jam(a.mulai, false)})</span><span>{m(a.kolom.length / 2)} mnt</span><span>{m(a.kolom.length)} mnt</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {PERAN.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span className="text-[#abb3bf]">{p.label}</span><span className="font-semibold tabular-nums text-white">{fmt(total[p.key])}</span><span className="text-[#8f99a8]">jawaban</span></span>
        ))}
      </div>
      <p className="mt-0.5 text-[10px] text-[#8f99a8]">
        tinggi kolom: jawaban agen yang selesai per {a.langkah / 60} menit (puncak {top}); dari waktu tiap batch disimpan
        {a.dari_simpanan ? ` · ${fmt(a.dari_simpanan)} batch dari simpanan tidak digambar (dijawab di percobaan sebelumnya)` : ""}
        {a.penulis_terpisah ? " · agen penulis bekerja jauh setelahnya, tidak digambar" : ""}
      </p>
      <Tooltip tip={tip} />
    </div>
  );
}

export function CabangTabBiaya({ run, jejak }: { run: string; jejak: Jejak | null }) {
  const [d, setD] = useState<{ run: string; data?: BiayaRun; err?: string } | null>(null);
  const [semuaBuku, setSemuaBuku] = useState(false);
  useEffect(() => {
    let batal = false;
    fetch(`/api/swarm-cabang?run=${encodeURIComponent(run)}&biaya=1`, { cache: "no-store" })
      .then(async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`); return x as BiayaRun; })
      .then((x) => { if (!batal) setD({ run, data: x }); }, (e) => { if (!batal) setD({ run, err: String(e.message || e) }); });
    return () => { batal = true; };
  }, [run]);
  const ini = d?.run === run ? d : null;
  if (ini?.err) return <p className="rounded border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{ini.err}</p>;
  const B = ini?.data;
  if (!B) return <p className="py-10 text-center text-[12px] text-[#8f99a8]">Memuat biaya dan token run…</p>;

  const sw = B.laporan.swarm, na = B.laporan.narasi;
  if (!sw && !na) return <p className="py-10 text-center text-[12px] text-[#8f99a8]">Biaya model run ini tidak tercatat (run belum selesai, atau uji kering tanpa model).</p>;
  const masuk = (sw?.token_masuk ?? 0) + (na?.token_masuk ?? 0), keluar = (sw?.token_keluar ?? 0) + (na?.token_keluar ?? 0);
  const token = masuk + keluar, panggilan = (sw?.panggilan ?? 0) + (na?.panggilan ?? 0);
  const totalUsd = B.laporan.usd ?? (sw?.usd ?? 0) + (na?.usd ?? 0);
  const totalModel = (sw?.usd ?? 0) + (na?.usd ?? 0);  // the two recorded steps (runs.json biaya_usd is their sum, rounded)
  const dibaca = B.klaim.dibaca;
  const batchSwarm = B.batch?.total ?? sw?.selesai ?? null;
  const batchNarasi = B.progres.narasi.at(-1)?.dari ?? null;
  const cache = B.batch?.dari_simpanan ?? sw?.cache ?? 0;
  const tahap = jejak?.tahap ?? [];
  const detikTotal = tahap.reduce((s, t) => s + (t.detik ?? 0), 0);
  const tanpaLama = tahap.filter((t) => t.status === "selesai" && t.detik == null).length;
  const exhibit = Number(tahap.find((t) => t.kode === "narasi")?.hasil.find(([l]) => l === "Exhibit dinarasikan")?.[1] ?? 0);
  const banyakKc = (B.kc ?? 1) > 1;
  const h = B.harga?.cocok ? B.harga : null;
  const usdMasuk = h ? (masuk * h.masuk) / 1e6 : 0, usdKeluar = h ? (keluar * h.keluar) / 1e6 : 0;
  const buku = B.buku ?? [];
  const bukuTotal = buku.reduce((s, x) => s + x.biaya.usd, 0);
  const bukuLain = Math.max(0, (B.batas?.terpakai ?? bukuTotal) - totalModel);
  const LANGKAH: Record<string, string> = { smoke: "Uji coba 1 batch", swarm: "Tim agen AI", narasi: "Agen penulis" };
  const peranUsd: Part[] = [{ label: TIM, value: sw?.usd ?? 0, color: SERIES[0] }, { label: "Agen penulis", value: na?.usd ?? 0, color: SERIES[2] }];
  const peranTok: Part[] = [{ label: TIM, value: (sw?.token_masuk ?? 0) + (sw?.token_keluar ?? 0), color: SERIES[0] }, { label: "Agen penulis", value: (na?.token_masuk ?? 0) + (na?.token_keluar ?? 0), color: SERIES[2] }];
  const th = "px-1.5 text-right font-medium";

  return (
    <div className="space-y-3" data-run-biaya>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2 rounded border border-white/10 bg-[#1c2127] px-4 py-3">
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">Total biaya laporan ini</p>
          <p className="mt-0.5 text-[22px] font-semibold tabular-nums text-white">{usd(totalUsd)}</p>
        </div>
        {B.batas?.usd ? <Kpi label="batas biaya run" value={usd(B.batas.usd)} hint={`${persen(B.batas.terpakai ?? 0, B.batas.usd)} terpakai (${usd(B.batas.terpakai ?? 0)}, termasuk percobaan sebelumnya)`} />
          : <div><p className="text-[16px] font-semibold text-[#8f99a8]">–</p><p className="text-[10.5px] text-[#8f99a8]">batas biaya: tidak tercatat untuk run ini</p></div>}
        <Kpi label="token" value={tok(token)} />
        <Kpi label="panggilan model" value={fmt(panggilan)} />
        {sw && dibaca ? <Kpi label="per klaim dibaca tim agen" value={usd(sw.usd / dibaca)} hint={`${fmt(dibaca)} klaim`} /> : null}
        {banyakKc && <p className="text-[11px] text-[#f0c661]">Biaya ini untuk seluruh run ({fmt(B.kc ?? 0)} KC), bukan hanya KC yang dibuka.</p>}
      </div>

      <section className="rounded border border-white/10 bg-[#1c2127] p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <p className="text-[13px] font-semibold text-white">Anatomi biaya run</p>
          <p className="text-[11px] text-[#8f99a8]">{usd(totalUsd)} · {tok(token)} token · {fmt(panggilan)} panggilan model · 5 agen{detikTotal ? ` · ${lama(detikTotal)} kerja tercatat` : ""} — dari catatan biaya runner per tahap</p>
        </div>
        <p className="mb-4 max-w-[920px] text-[12.5px] leading-relaxed text-[#d3d8de]">
          Laporan ini memakai {tok(token)} token dalam {fmt(panggilan)} panggilan model oleh 5 agen (3 spesialis, hakim, dan agen penulis), dengan biaya {usd(totalUsd)}.
          {sw && <> Tim agen AI membaca {dibaca ? `${fmt(dibaca)} klaim ragu` : "klaim ragu"} dengan biaya {usd(sw.usd)}{dibaca ? `, sekitar ${usd(sw.usd / dibaca)} per klaim` : ""}{cache && batchSwarm ? `; ${fmt(cache)} dari ${fmt(batchSwarm)} batch dijawab dari simpanan jawaban percobaan sebelumnya, tanpa biaya baru` : ""}.</>}
          {na && <> Agen penulis menulis {exhibit ? `${fmt(exhibit)} narasi exhibit` : "narasi exhibit"} dengan biaya {usd(na.usd)}.</>}
          {B.batas?.terpakai != null && B.batas.usd ? <> Seluruh percobaan run ini, termasuk yang diulang, memakai {usd(B.batas.terpakai)} dari batas {usd(B.batas.usd)}.</> : null}
          {" "}Biaya per agen tidak dicatat terpisah: pencatat biaya menjumlah semua panggilan dalam satu tahap.
        </p>
        <div className="grid gap-x-8 gap-y-5 xl:grid-cols-2">
          <div className="min-w-0">
            <KepalaBagian judul="Waktu" nilai={detikTotal ? `Total ${lama(detikTotal)}` : "Lama tidak tercatat"} />
            {tahap.length ? (
              <div className="space-y-2">
                {tahap.map((t) => (
                  <div key={t.kode}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11.5px]">
                      <span className="text-[#e5e8eb]">{NAMA_TAHAP[t.kode][0]}</span>
                      <span className="tabular-nums text-[#abb3bf]">
                        {t.detik != null ? `${lama(t.detik)} · ${persen(t.detik, detikTotal)}` : t.status === "selesai" ? "lama tidak tercatat" : t.status === "dilewati" ? "dilewati" : "tidak tercatat"}
                        {" · "}{t.ai ? (t.biaya ? `${usd(t.biaya.usd)} · ${tok(t.biaya.token_masuk + t.biaya.token_keluar)} token` : "biaya –") : "$0 · tanpa model"}
                      </span>
                    </div>
                    <div className="mt-1 h-[6px] rounded-[3px] bg-white/[.05]">
                      {t.detik != null && <div className="h-full rounded-[3px]" style={{ width: `${Math.max(1, (100 * t.detik) / (detikTotal || 1))}%`, background: t.ai ? SERIES[0] : "#5f6b7a" }} />}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-[11.5px] text-[#8f99a8]">Memuat jejak tahap…</p>}
            <p className="mt-1 text-[10px] text-[#8f99a8]">lama: percobaan yang dipakai laporan ini; batang biru = tahap yang memanggil model AI{tanpaLama ? `; ${tanpaLama} tahap tanpa catatan lama tidak ikut dijumlah` : ""}</p>
            <SubJudul>Agen bekerja sepanjang waktu · 5 agen</SubJudul>
            {B.aktivitas ? <Aktivitas a={B.aktivitas} /> : <p className="text-[11.5px] text-[#abb3bf]"><TakTercatat>tidak tercatat di run ini</TakTercatat> Waktu tiap batch jawaban agen tidak disimpan untuk run ini.</p>}
            <div className="mt-2"><Split parts={[{ label: "Spesialis", value: 3, color: SERIES[0], note: "koding & klinis, tagihan, episode & jaringan" }, { label: "Hakim", value: 1, color: SERIES[1] }, { label: "Agen penulis", value: 1, color: SERIES[2] }]} fmt={(v) => `${v} agen`} /></div>
          </div>
          <div className="min-w-0">
            <KepalaBagian judul="Token" nilai={`${tok(token)} token`} />
            <SubJudul>Menurut jenis</SubJudul>
            <Split parts={[{ label: "Input", value: masuk, color: SERIES[0] }, { label: "Output (termasuk penalaran)", value: keluar, color: SERIES[1] }]} fmt={tok} />
            <p className="mt-1 text-[10.5px] text-[#8f99a8]">Input dari cache: <TakTercatat>tidak dipisahkan di run ini</TakTercatat> Pencatat biaya menghitung semua token masuk sebagai input.{cache ? ` "Simpanan" di run ini berarti ${fmt(cache)} batch yang jawabannya dipakai ulang tanpa panggilan model.` : ""}</p>
            <SubJudul>Menurut peran</SubJudul>
            <Split parts={peranTok} fmt={tok} />
            <p className="mt-1 text-[10.5px] text-[#8f99a8]">Pembagian antara 3 spesialis dan hakim: <TakTercatat /></p>
            <SubJudul>Menurut model</SubJudul>
            <Split parts={[{ label: MODEL_CABANG, value: token, color: SERIES[0], note: "semua agen" }]} fmt={tok} />
            <div className="mt-5"><KepalaBagian judul="Biaya" nilai={`${usd(totalUsd)} total`} /></div>
            <SubJudul>Menurut model</SubJudul>
            <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-[11px]">
              <thead><tr className="text-[#8f99a8]"><th className="py-1 text-left font-medium">Model</th><th className={th}>Agen</th><th className={th}>Panggilan</th>
                <th className={th}>Input</th><th className={th}>Cache</th><th className={th}>Output</th><th className={th}>$ / 1 jt token</th><th className={th}>Biaya</th></tr></thead>
              <tbody><tr className="border-t border-white/[.05] tabular-nums text-[#e5e8eb]">
                <td className="py-1"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SERIES[0] }} />{MODEL_CABANG}</td>
                <td className="px-1.5 text-right">5</td><td className="px-1.5 text-right">{fmt(panggilan)}</td><td className="px-1.5 text-right">{tok(masuk)}</td>
                <td className="px-1.5 text-right text-[#8f99a8]" title="tidak dipisahkan pencatat biaya">–</td><td className="px-1.5 text-right">{tok(keluar)}</td>
                <td className="px-1.5 text-right">{usd(token ? (1e6 * totalModel) / token : 0)}</td><td className="px-1.5 text-right font-semibold text-white">{usd(totalModel)}</td>
              </tr></tbody>
            </table></div>
            <p className="mt-1 text-[10.5px] text-[#8f99a8]">Spesialis, hakim dan agen penulis memakai model AI yang sama.{h ? ` Tarif pencatat: ${usd(h.masuk)} per 1 jt token input, ${usd(h.keluar)} per 1 jt token output.` : ""}</p>
            <SubJudul>Menurut peran</SubJudul>
            <Split parts={peranUsd} fmt={usd} />
            <SubJudul>Menurut jenis token</SubJudul>
            {h ? <>
              <Split parts={[{ label: "Input", value: usdMasuk, color: SERIES[0] }, { label: "Output", value: usdKeluar, color: SERIES[1] }]} fmt={usd} />
              <p className="mt-1 text-[10.5px] text-[#8f99a8]">token × tarif pencatat; jumlahnya cocok dengan biaya yang tercatat ({usd(usdMasuk + usdKeluar)}).</p>
            </> : <p className="text-[11px]"><TakTercatat>tidak dapat dipisah: tarif pencatat tidak cocok dengan total tercatat</TakTercatat></p>}
            <SubJudul>Per klaim</SubJudul>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {([[sw && dibaca ? usd(sw.usd / dibaca) : "–", "per klaim dibaca tim agen", dibaca ? `${fmt(dibaca)} klaim` : "jumlah klaim tidak tercatat"],
                [B.klaim.antrean ? usd(totalUsd / B.klaim.antrean) : "–", "per klaim di antrean verifikator", B.klaim.antrean ? `${fmt(B.klaim.antrean)} klaim` : ""],
                [B.klaim.dianalisis ? usd((1000 * totalUsd) / B.klaim.dianalisis) : "–", "per 1.000 klaim dianalisis", B.klaim.dianalisis ? `${fmt(B.klaim.dianalisis)} klaim` : ""],
                [sw && batchSwarm && batchSwarm - cache > 0 ? usd(sw.usd / (batchSwarm - cache)) : "–", "per batch ke model", batchSwarm ? `${fmt(batchSwarm - cache)} batch × 8 klaim` : ""]] as const).map(([v, l, s]) => (
                <div key={l} className="border-l border-white/10 pl-2"><p className="text-[14px] font-semibold tabular-nums text-white">{v}</p><p className="text-[10.5px] leading-tight text-[#abb3bf]">{l}</p>{s && <p className="text-[10px] text-[#8f99a8]">{s}</p>}</div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded border border-white/10 bg-[#1c2127] p-4">
        <KepalaBagian judul="Buku biaya run" nilai={B.batas?.terpakai != null ? `${usd(B.batas.terpakai)} terpakai${B.batas.usd ? ` dari batas ${usd(B.batas.usd)}` : ""}` : undefined} />
        {buku.length ? (
          <>
            {B.batas?.usd ? (
              <div className="mb-3">
                <Split total={B.batas.usd} parts={[{ label: "Laporan ini", value: totalModel, color: SERIES[0] }, { label: "Percobaan lain (diulang, diganti)", value: bukuLain, color: SERIES[3] },
                  { label: "Sisa batas", value: Math.max(0, B.batas.usd - (B.batas.terpakai ?? 0)), color: "#3a424c" }]} fmt={usd} />
              </div>
            ) : null}
            <p className="mb-2 max-w-[920px] text-[11px] text-[#abb3bf]">Setiap pemanggilan model di run ini dicatat runner (uji coba, tim agen, agen penulis), termasuk tahap yang diulang. Laporan memakai satu percobaan per tahap; sisanya biaya percobaan yang diganti hasil lebih baru. Batas biaya berlaku untuk seluruh buku ini.</p>
            <div className="overflow-x-auto rounded border border-white/5">
              <table className="w-full whitespace-nowrap text-[11px]">
                <thead className="bg-[#20262d] text-[#8f99a8]"><tr>
                  <th className="px-2 py-1.5 text-left font-medium">Dicatat</th><th className="px-1.5 text-left font-medium">Langkah</th><th className={th}>Panggilan</th>
                  <th className={th}>Token masuk</th><th className={th}>Token keluar</th><th className={th}>Batch dari simpanan</th><th className={th}>Biaya</th><th className="px-2 text-left font-medium">Keterangan</th></tr></thead>
                <tbody>
                  {(semuaBuku ? buku : buku.filter((x) => x.dipakai)).map((x, i) => (
                    <tr key={`${x.waktu}-${i}`} className={`border-t border-white/[.04] tabular-nums ${x.dipakai ? "text-[#e5e8eb]" : "text-[#8f99a8]"}`}>
                      <td className="px-2 py-1">{jam(x.waktu)}</td><td className="px-1.5">{LANGKAH[x.langkah] ?? x.langkah}</td><td className="px-1.5 text-right">{fmt(x.biaya.panggilan)}</td>
                      <td className="px-1.5 text-right">{tok(x.biaya.token_masuk)}</td><td className="px-1.5 text-right">{tok(x.biaya.token_keluar)}</td><td className="px-1.5 text-right">{x.biaya.cache != null ? fmt(x.biaya.cache) : "–"}</td>
                      <td className="px-1.5 text-right font-semibold">{usd(x.biaya.usd)}</td>
                      <td className="px-2">{x.dipakai ? <span className="rounded bg-[#29a383]/15 px-1.5 py-0.5 text-[10px] text-[#7ee2c0]">dipakai laporan ini</span> : "percobaan lain"}</td>
                    </tr>
                  ))}
                  {semuaBuku && B.terhenti.map((x) => (
                    <tr key={`t-${x.mulai}`} className="border-t border-white/[.04] tabular-nums text-[#f0c661]">
                      <td className="px-2 py-1">{jam(x.mulai)}</td><td className="px-1.5">{LANGKAH[x.langkah] ?? NAMA_TAHAP[x.langkah as keyof typeof NAMA_TAHAP]?.[0] ?? x.langkah}</td>
                      <td className="px-1.5 text-right">{x.panggilan != null ? `≥ ${fmt(x.panggilan)}` : "–"}</td><td className="px-1.5 text-right">–</td><td className="px-1.5 text-right">–</td><td className="px-1.5 text-right">–</td>
                      <td className="px-1.5 text-right font-semibold">≥ {usd(x.usd)}</td>
                      <td className="px-2">terhenti sebelum mencatat biaya: tidak masuk buku ({x.batch}); angka terakhir di log-nya</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t border-white/10 tabular-nums text-white">
                  <td className="px-2 py-1" colSpan={6}>{semuaBuku ? `Jumlah buku biaya (${buku.length} catatan)` : "Jumlah yang dipakai laporan ini"}</td>
                  <td className="px-1.5 text-right font-semibold">{usd(semuaBuku ? bukuTotal : buku.filter((x) => x.dipakai).reduce((s, x) => s + x.biaya.usd, 0))}</td><td />
                </tr></tfoot>
              </table>
            </div>
            <button onClick={() => setSemuaBuku((x) => !x)} className="mt-1.5 text-[10.5px] text-[#8abbff] hover:underline">
              {semuaBuku ? "Hanya yang dipakai laporan ini" : `Lihat seluruh buku biaya (${buku.length} catatan${B.terhenti.length ? ` + ${B.terhenti.length} percobaan terhenti` : ""})`}</button>
          </>
        ) : <p className="text-[11.5px] text-[#abb3bf]"><TakTercatat>tidak tercatat di run ini</TakTercatat> Run ini tidak menyimpan buku biaya per percobaan; yang tercatat hanya biaya tim agen ({sw ? usd(sw.usd) : "–"}) dan agen penulis ({na ? usd(na.usd) : "–"}) untuk laporan ini.</p>}
      </section>

      <section className="rounded border border-white/10 bg-[#1c2127] p-4">
        <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">Biaya per agen</p>
        <p className="mb-2 text-[10.5px] text-[#8f99a8]">Setiap agen dengan model, batch yang dijawabnya, panggilan dan tokennya; batang = porsinya dari {usd(totalModel)}. Tim agen AI dicatat bersama: biaya tiap spesialis dan hakim tidak dipisah.</p>
        <div className="overflow-x-auto rounded border border-white/5">
          <table className="w-full whitespace-nowrap text-[11px]">
            <thead className="bg-[#20262d] text-[#8f99a8]"><tr>
              <th className="px-2 py-1.5 text-left font-medium">Agen</th><th className="px-1.5 text-left font-medium">Lini</th><th className="px-1.5 text-left font-medium">Model</th>
              <th className={th}>Batch dijawab</th><th className={th}>Panggilan</th><th className={th}>Input</th><th className={th}>Cache</th><th className={th}>Output</th><th className="px-2 text-right font-medium">Biaya</th>
              <th className="w-[22%] px-2 text-left font-medium">Porsi</th></tr></thead>
            <tbody>
              {AGEN_CABANG.filter((a) => a.lini !== "penulis").map((a) => (
                <tr key={a.key} className="border-t border-white/[.04] tabular-nums text-[#e5e8eb]">
                  <td className="px-2 py-1">{a.nama}</td><td className="px-1.5 text-[#abb3bf]">{a.peran}</td>
                  <td className="px-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SERIES[0] }} />{MODEL_CABANG}</td>
                  <td className="px-1.5 text-right">{batchSwarm != null ? fmt(batchSwarm) : "–"}</td>
                  <td className="px-1.5 text-right text-[#8f99a8]">–</td><td className="px-1.5 text-right text-[#8f99a8]">–</td><td className="px-1.5 text-right text-[#8f99a8]">–</td><td className="px-1.5 text-right text-[#8f99a8]">–</td>
                  <td className="px-2 text-right text-[#8f99a8]">–</td><td className="px-2"><TakTercatat /></td>
                </tr>
              ))}
              {sw && (
                <tr className="border-t border-white/[.08] bg-white/[.02] tabular-nums text-white">
                  <td className="px-2 py-1 font-medium">{TIM}, bersama</td><td className="px-1.5 text-[#abb3bf]">Tim agen AI</td>
                  <td className="px-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SERIES[0] }} />{MODEL_CABANG}</td>
                  <td className="px-1.5 text-right">{batchSwarm != null ? fmt(batchSwarm) : "–"}</td><td className="px-1.5 text-right">{fmt(sw.panggilan)}</td>
                  <td className="px-1.5 text-right">{tok(sw.token_masuk)}</td><td className="px-1.5 text-right text-[#8f99a8]">–</td><td className="px-1.5 text-right">{tok(sw.token_keluar)}</td>
                  <td className="px-2 text-right font-semibold">{usd(sw.usd)}</td>
                  <td className="px-2"><div className="flex items-center gap-1.5"><span className="h-[6px] rounded-r-[3px]" style={{ width: `${Math.max(1, (100 * sw.usd) / (totalModel || 1))}%`, background: SERIES[0] }} />
                    <span className="shrink-0 text-[10px] text-[#8f99a8]">{persen(sw.usd, totalModel)}</span></div></td>
                </tr>
              )}
              {na && (
                <tr className="border-t border-white/[.08] tabular-nums text-[#e5e8eb]">
                  <td className="px-2 py-1">Agen penulis</td><td className="px-1.5 text-[#abb3bf]">Narasi laporan</td>
                  <td className="px-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SERIES[0] }} />{MODEL_CABANG}</td>
                  <td className="px-1.5 text-right">{batchNarasi != null ? fmt(batchNarasi) : "–"}</td><td className="px-1.5 text-right">{fmt(na.panggilan)}</td>
                  <td className="px-1.5 text-right">{tok(na.token_masuk)}</td><td className="px-1.5 text-right text-[#8f99a8]">–</td><td className="px-1.5 text-right">{tok(na.token_keluar)}</td>
                  <td className="px-2 text-right font-semibold text-white">{usd(na.usd)}</td>
                  <td className="px-2"><div className="flex items-center gap-1.5"><span className="h-[6px] rounded-r-[3px]" style={{ width: `${Math.max(1, (100 * na.usd) / (totalModel || 1))}%`, background: SERIES[2] }} />
                    <span className="shrink-0 text-[10px] text-[#8f99a8]">{persen(na.usd, totalModel)}</span></div></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">
          Batch dijawab: tiap batch tim agen = 8 klaim dibaca ketiga spesialis lalu hakim{cache ? ` (termasuk ${fmt(cache)} batch dari simpanan)` : ""}; tiap batch agen penulis = beberapa exhibit.
          Agen penulis adalah satu-satunya agen di tahapnya, jadi angkanya memang miliknya sendiri.
        </p>
        <p className="mt-1 text-[10px] text-[#6f7a87]">Sumber: {B.sumber.join(" · ")}.</p>
      </section>
    </div>
  );
}
