"use client";
// AI Agent Swarm Branch, "Jejak kerja" tab: the run's steps in order (fitur → zona → iot → aturan → swarm → laporan → narasi), each
// with when it ran, how long, what it produced and what it cost, and every attempt of it (a step run again, stopped, resumed).
// Data: GET /api/swarm-cabang?run=<id>&jejak=1 (src/lib/cabangJejak.ts), from the runner's own status and logs.
import type { Jejak, Tahap } from "@/lib/cabangJejak";
import { Kpi, NAMA_TAHAP, STATUS_TAHAP, TakTercatat, fmt, jam, lama, usd } from "./CabangTabBersama";

function ChipStatus({ status }: { status: string }) {
  const [label, warna] = STATUS_TAHAP[status] ?? [status, "#8f99a8"];
  const garis = status === "tidak_tercatat" || status === "dilewati" || status === "belum";
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${garis ? "border border-dashed" : ""}`}
      style={{ color: warna, background: garis ? "transparent" : `${warna}1f`, borderColor: garis ? `${warna}66` : undefined }}>
      {status === "berjalan" && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: warna }} />}{label}
    </span>
  );
}

function Nilai({ v }: { v: number | string }) {
  return <>{typeof v === "number" ? fmt(v) : v}</>;
}

function KartuTahap({ t, i }: { t: Tahap; i: number }) {
  const [nama, arti] = NAMA_TAHAP[t.kode];
  const dipakai = t.percobaan.filter((p) => p.dipakai).length;
  return (
    <section id={`jejak-${t.kode}`} className="scroll-mt-4 rounded border border-white/10 bg-[#1c2127] p-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-[11px] font-semibold tabular-nums text-[#d3d8de]">{i + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold text-white">{nama}</p>
            <ChipStatus status={t.status} />
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${t.ai ? "bg-[#9d8cff]/15 text-[#c9c0ff]" : "bg-white/5 text-[#8f99a8]"}`}>{t.ai ? "memanggil model AI" : "tanpa model AI · $0"}</span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{arti}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] tabular-nums">
          <p className="text-[#e5e8eb]">{t.mulai ? jam(t.mulai) : t.selesai ? `selesai ${jam(t.selesai)}` : "waktu tidak tercatat"}{t.mulai && t.selesai ? ` → ${jam(t.selesai, t.selesai.slice(0, 10) !== t.mulai.slice(0, 10))}` : ""}</p>
          <p className="text-[#8f99a8]">{t.detik != null ? `lama ${lama(t.detik)}` : "lama tidak tercatat"}</p>
        </div>
      </div>
      {t.hasil.length > 0 && (
        <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {t.hasil.map(([label, v]) => (
            <div key={label} className="min-w-0 border-l border-white/10 pl-2">
              <p className="text-[13.5px] font-semibold tabular-nums text-white"><Nilai v={v} /></p>
              <p className="text-[10.5px] leading-tight text-[#8f99a8]">{label}</p>
            </div>
          ))}
        </div>
      )}
      {t.ai && (
        <p className="mt-2.5 rounded bg-black/20 px-2 py-1.5 text-[11.5px] text-[#d3d8de]">
          {t.biaya ? <>Biaya model <b className="tabular-nums text-white">{usd(t.biaya.usd)}</b> · {fmt(t.biaya.panggilan)} panggilan · {fmt(t.biaya.token_masuk)} token masuk · {fmt(t.biaya.token_keluar)} token keluar</>
            : <>Biaya: <TakTercatat>tidak tercatat untuk tahap ini</TakTercatat></>}
        </p>
      )}
      {t.catatan.length > 0 && <ul className="mt-2 space-y-0.5 text-[10.5px] text-[#8f99a8]">{t.catatan.map((c) => <li key={c}>· {c}</li>)}</ul>}
      {t.percobaan.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-[#b8a9ff] hover:text-white">
            Riwayat percobaan ({t.percobaan.length}){dipakai ? ` · ${dipakai} dipakai laporan ini` : ""}
          </summary>
          <div className="mt-1.5 overflow-x-auto rounded border border-white/5">
            <table className="w-full whitespace-nowrap text-[11px]">
              <thead className="bg-[#20262d] text-[#8f99a8]"><tr>
                <th className="px-2 py-1 text-left font-medium">Waktu</th><th className="px-2 text-left font-medium">Kegiatan</th><th className="px-2 text-right font-medium">Lama</th>
                <th className="px-2 text-left font-medium">Hasil</th><th className="px-2 text-right font-medium">Biaya</th><th className="px-2 text-left font-medium">Status</th></tr></thead>
              <tbody>{t.percobaan.map((p, k) => (
                <tr key={`${p.mulai}-${k}`} className={`border-t border-white/[.04] tabular-nums ${p.dipakai ? "text-[#e5e8eb]" : "text-[#8f99a8]"}`}>
                  <td className="px-2 py-1">{jam(p.mulai)}</td><td className="px-2">{p.jenis}</td><td className="px-2 text-right">{p.detik != null ? lama(p.detik) : "–"}</td>
                  <td className="max-w-[420px] truncate px-2" title={p.ringkas}>{p.ringkas}</td>
                  <td className="px-2 text-right">{p.biaya ? usd(p.biaya.usd) : p.usd_log != null ? <span title="percobaan ini berhenti sebelum mencatat biayanya; angka = biaya terakhir di log-nya">≥ {usd(p.usd_log)}</span> : t.ai ? "–" : "$0"}</td>
                  <td className="px-2">{p.dipakai ? <span className="rounded bg-[#29a383]/15 px-1.5 py-0.5 text-[10px] text-[#7ee2c0]">dipakai laporan ini</span>
                    : p.status === "selesai" ? <span className="text-[10.5px]">selesai, diganti yang lebih baru</span> : <span className="text-[10.5px] text-[#f0c661]">{p.status === "terhenti" ? "terhenti" : "gagal"}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export function CabangTabJejak({ jejak, err }: { jejak: Jejak | null; err?: string }) {
  if (err) return <p className="rounded border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{err}</p>;
  if (!jejak) return <p className="py-10 text-center text-[12px] text-[#8f99a8]">Memuat jejak kerja run…</p>;
  const tahap = jejak.tahap;
  const tercatat = tahap.filter((t) => t.status === "selesai" || t.status === "berjalan" || t.status === "gagal");
  const totalDetik = tahap.reduce((s, t) => s + (t.detik ?? 0), 0);
  const tanpaWaktu = tahap.filter((t) => (t.status === "selesai" || t.status === "berjalan") && t.detik == null).length;
  const biayaAi = tahap.reduce((s, t) => s + (t.biaya?.usd ?? 0), 0);
  const st = jejak.status;
  const maks = Math.max(1, ...tahap.map((t) => t.detik ?? 0));
  return (
    <div className="space-y-3">
      <section className="rounded border border-white/10 bg-[#1c2127] px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">Jejak kerja run ini</p>
            <p className="mt-0.5 text-[22px] font-semibold tabular-nums text-white">{tercatat.length} dari {tahap.length} tahap tercatat</p>
          </div>
          <Kpi label="waktu kerja tahap yang tercatat" value={totalDetik ? lama(totalDetik) : "–"} hint={tanpaWaktu ? `${tanpaWaktu} tahap tanpa catatan lama` : undefined} />
          <Kpi label="biaya model laporan ini" value={usd(jejak.laporan_usd ?? biayaAi)} hint="tim agen AI + agen penulis" />
          {st?.status && <Kpi label="status runner" value={st.status === "selesai" ? "selesai" : st.status === "berjalan" ? `berjalan · ${fmt(st.persen ?? 0)}%` : st.status} hint={st.diperbarui ? `diperbarui ${jam(st.diperbarui)}` : undefined} />}
        </div>
        <p className="mt-2 max-w-[920px] text-[12px] leading-relaxed text-[#d3d8de]">
          Setiap run berjalan dalam tujuh tahap berurutan. Hanya dua tahap yang memanggil model AI (tim agen dan agen penulis); tahap lain dikerjakan kode dan mesin aturan.
          Tahap yang dijalankan ulang (dilanjutkan setelah terhenti, atau ditulis ulang) tercatat di riwayat percobaannya; angka di kartu adalah percobaan yang dipakai laporan ini.
        </p>
        {jejak.catatan.map((c) => <p key={c} className="mt-1.5 text-[11.5px] text-[#f0c661]">{c}</p>)}
        <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Sumber: {jejak.sumber.join(" · ") || "tidak ada catatan"}. Waktu = jam lokal mesin yang menjalankan run.</p>
      </section>

      {/* the steps at a glance: one box each, in order, with its time and cost */}
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-7" aria-label="Tahap run">
        {tahap.map((t, i) => {
          const [nama] = NAMA_TAHAP[t.kode];
          const [, warna] = STATUS_TAHAP[t.status] ?? ["", "#8f99a8"];
          return (
            <li key={t.kode}>
              <a href={`#jejak-${t.kode}`} onClick={(e) => { e.preventDefault(); document.getElementById(`jejak-${t.kode}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                className="block h-full rounded border border-white/10 bg-[#1c2127] px-2.5 py-2 hover:border-white/25">
                <p className="flex items-center gap-1.5 text-[10.5px] text-[#8f99a8]"><span className="h-2 w-2 rounded-full" style={{ background: warna }} />{i + 1} · {t.kode}</p>
                <p className="mt-0.5 text-[12px] font-medium leading-tight text-white">{nama}</p>
                <div className="mt-1.5 h-[5px] rounded-[3px] bg-white/[.05]">
                  {t.detik != null && <div className="h-full rounded-[3px]" style={{ width: `${Math.max(2, (100 * t.detik) / maks)}%`, background: t.ai ? "#9d8cff" : "#3987e5" }} />}
                </div>
                <p className="mt-1 text-[10.5px] tabular-nums text-[#abb3bf]">{t.detik != null ? lama(t.detik) : "lama –"}{t.ai ? ` · ${t.biaya ? usd(t.biaya.usd) : "biaya –"}` : ""}</p>
              </a>
            </li>
          );
        })}
      </ol>
      <p className="-mt-1 text-[10px] text-[#8f99a8]">Panjang batang = lama tahap dibanding tahap terlama; ungu = tahap yang memanggil model AI.</p>

      {tahap.map((t, i) => <KartuTahap key={t.kode} t={t} i={i} />)}
    </div>
  );
}
