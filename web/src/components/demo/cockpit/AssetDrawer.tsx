"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, fmt, lineageUrl, objUrl, waktu, type Detail, type Koridor } from "./api";
import { NexusLink, Pill, RISK_COLOR, SevBadge, Sources, StatusPill } from "./parts";

/* One 360° panel for any asset the cockpit shows: its Nexus object, connections (topology, not map distance), risk with
   evidence, structural N-1 role, related analytics records and active alarms — every row opens its own Nexus object. */

export type AssetKey = { jenis: string; id: string };
export const AssetContext = createContext<(a: AssetKey) => void>(() => {});
export const useOpenAsset = () => useContext(AssetContext);

/** an asset code that opens the 360° panel */
export function AssetButton({ jenis, id, children }: { jenis: string; id: string | null | undefined; children?: React.ReactNode }) {
  const open = useOpenAsset();
  if (!id) return <span className="text-muted">—</span>;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); open({ jenis, id }); }} className="font-medium text-soft underline decoration-dotted underline-offset-2 hover:text-white">
      {children ?? id}
    </button>
  );
}

const LABEL: Record<string, string> = { saluran: "Saluran transmisi (OSM)", gardu: "Gardu transmisi (OSM)", pembangkit: "Pembangkit (OSM)", koridor: "Koridor transmisi",
  gi: "Gardu induk (demo)", penyulang: "Penyulang (demo)", gardu_distribusi: "Gardu distribusi (demo)" };
const HIDE = new Set(["geometri", "judul", "latitude", "longitude", "lat", "lon", "ruas_osm"]);

export function AssetDrawer({ asset, onClose }: { asset: AssetKey | null; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const open = useOpenAsset();
  useEffect(() => {
    if (!asset) return;
    setD(null);
    setErr("");
    api<Detail>(`/assets/${asset.jenis}/${encodeURIComponent(asset.id)}`).then(setD).catch((e) => setErr(e.message));
  }, [asset]);
  if (!asset) return null;
  const pembebanan = d?.terkait.pembebanan as Record<string, unknown> | undefined;
  const n1 = d?.terkait.n1 as Record<string, unknown> | undefined;
  const keandalan = (d?.terkait.keandalan as Record<string, unknown>[] | undefined) ?? [];
  const gangguan = (d?.terkait.gangguan as Record<string, unknown>[] | undefined) ?? [];
  const temuan = (d?.terkait.temuan as Record<string, unknown>[] | undefined) ?? [];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-line-2 bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()} aria-label="Detail aset">
        <header className="flex items-start gap-3 border-b border-line p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-muted">{LABEL[asset.jenis] ?? asset.jenis}</div>
            <h2 className="truncate text-base font-semibold">{d?.nama ?? asset.id}</h2>
            <div className="text-xs text-muted">{asset.id}</div>
          </div>
          {d?.ref && (
            <Link href={objUrl(d.ref)!} target="_blank" className="flex items-center gap-1 rounded-md border border-violet-400/50 bg-violet-500/10 px-2 py-1 text-xs text-violet-200 hover:text-white">
              <Icon name="cube" className="h-3.5 w-3.5" /> Objek Nexus
            </Link>
          )}
          {d?.ref && (
            <Link href={lineageUrl(`object_type:${d.ref.type_id}`)!} target="_blank" className="flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-xs text-soft hover:text-white">
              <Icon name="split" className="h-3.5 w-3.5" /> Lineage
            </Link>
          )}
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:text-white" aria-label="Tutup">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-bad">{err}</p>}
          {!d && !err && <p className="text-muted">Memuat detail aset…</p>}
          {d && (
            <>
              {d.risiko && (
                <section className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Risiko aset (aturan berbukti)</h3>
                    <NexusLink r={d.risiko.ref}>
                      <Pill text={`${String(d.risiko.kelas_risiko)} · skor ${String(d.risiko.skor)}`} color={RISK_COLOR[String(d.risiko.kelas_risiko)] ?? "#94a3b8"} />
                    </NexusLink>
                  </div>
                  <p className="mt-1 text-muted">Faktor utama: {String(d.risiko.faktor_utama)}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {String(d.risiko.bukti).split("; ").map((b) => <li key={b}>{b}</li>)}
                  </ul>
                  <p className="mt-1.5 rounded bg-ink px-2 py-1"><span className="text-muted">Rekomendasi: </span>{String(d.risiko.rekomendasi)}</p>
                </section>
              )}
              {n1 && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="font-semibold">Kontingensi N-1 trafo daya</h3>
                  <p className="mt-1">{String(n1.status_n1)} — puncak {fmt(Number(n1.puncak_mva), 2)} MVA ({String(n1.waktu_puncak)}) vs kapasitas firm {fmt(Number(n1.kapasitas_firm_mva), 1)} MVA,
                    margin {fmt(Number(n1.margin_n1_mva), 1)} MVA, {String(n1.jam_melanggar_n1)} jam melanggar.</p>
                  <p className="mt-1 text-muted">{String(n1.rekomendasi)}</p>
                </section>
              )}
              {pembebanan && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="font-semibold">Pembebanan termal</h3>
                  <p className="mt-1">Arus puncak {fmt(Number(pembebanan.arus_puncak_a), 1)} A dari batas {String(pembebanan.batas_termal_a)} A ({fmt(Number(pembebanan.beban_termal_pct), 1)}%),
                    puncak {fmt(Number(pembebanan.puncak_kw))} kW pada {String(pembebanan.waktu_puncak)}, faktor beban {String(pembebanan.faktor_beban)}, ruang tambah {fmt(Number(pembebanan.ruang_tambah_kw))} kW.</p>
                </section>
              )}
              {d.struktural && (
                <section className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Peran struktural (N-1 topologi)</h3>
                    <NexusLink r={d.struktural.ref}>{String(d.struktural.redundansi)}</NexusLink>
                  </div>
                  <p className="mt-1 text-muted">{String(d.struktural.koridor)} koridor · {String(d.struktural.tetangga)} tetangga · {String(d.struktural.koridor_kritis)} koridor kritis
                    {d.struktural.titik_artikulasi ? " · titik artikulasi (lepasnya memisahkan jaringan)" : ""}</p>
                </section>
              )}
              {!!d.koridor.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Koridor transmisi ({d.koridor.length})</h3>
                  <div className="space-y-1">
                    {d.koridor.slice(0, 12).map((k: Koridor) => (
                      <div key={k.id} className="flex items-start justify-between gap-2 rounded border border-line px-2 py-1">
                        <span>
                          <button type="button" className="text-left hover:text-white" onClick={() => open({ jenis: "koridor", id: k.id })}>{k.kelas_kv} kV · {k.nama}</button>
                          <div className="text-muted">{k.dampak}</div>
                        </span>
                        {k.kritis_n1 ? <Pill text="Kritis N-1" color="#dc2626" /> : <Pill text="Redundan" color="#22c55e" />}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {!!d.terhubung.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Terhubung (topologi Nexus)</h3>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {d.terhubung.slice(0, 40).map((t) => (
                      <div key={t.peran + t.id} className="rounded border border-line px-2 py-1">
                        <div className="text-muted">{t.peran}</div>
                        {["gi", "penyulang", "gardu_distribusi", "gardu", "pembangkit", "saluran"].includes(t.jenis) ? (
                          <button type="button" className="text-left hover:text-white" onClick={() => open({ jenis: t.jenis, id: t.id })}>{t.nama ?? t.id}</button>
                        ) : (
                          <NexusLink r={t.ref}>{t.nama ?? t.id}</NexusLink>
                        )}
                        {t.nilai && <div className="text-muted">{t.nilai}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {!!keandalan.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Keandalan bulanan (IEEE 1366)</h3>
                  <table className="w-full">
                    <thead className="text-left text-muted"><tr><th>Bulan</th><th className="text-right">SAIDI</th><th className="text-right">SAIFI</th><th className="text-right">Gangguan</th><th>Penyebab</th></tr></thead>
                    <tbody>{keandalan.map((k) => (
                      <tr key={String(k.bulan)} className="border-t border-line/50"><td><NexusLink r={k.ref as never}>{String(k.bulan)}</NexusLink></td><td className="text-right tabular-nums">{fmt(Number(k.saidi_menit), 1)}</td>
                        <td className="text-right tabular-nums">{fmt(Number(k.saifi_kali), 3)}</td><td className="text-right">{String(k.gangguan)}</td><td className="text-muted">{String(k.penyebab_dominan)}</td></tr>
                    ))}</tbody>
                  </table>
                </section>
              )}
              {!!gangguan.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Gangguan (SOE)</h3>
                  {gangguan.slice(0, 8).map((g) => (
                    <div key={String(g.id_gangguan)} className="flex justify-between border-t border-line/50 py-1"><NexusLink r={g.ref as never}>{String(g.id_gangguan)}</NexusLink>
                      <span className="text-muted">{waktu(String(g.waktu_trip))} · {String(g.jenis)} · {String(g.penyebab)} · {String(g.durasi_menit)} mnt</span></div>
                  ))}
                </section>
              )}
              {!!temuan.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Temuan susut di aset ini</h3>
                  {temuan.map((t) => (
                    <div key={String(t.id_temuan)} className="flex justify-between gap-2 border-t border-line/50 py-1"><NexusLink r={t.ref as never}>{String(t.id_temuan)} · {String(t.kode_pola_dugaan)}</NexusLink>
                      <span className="text-right text-muted">{String(t.prioritas)} · {String(t.status_temuan)}</span></div>
                  ))}
                </section>
              )}
              {!!d.alarm.length && (
                <section className="rounded-lg border border-line p-3">
                  <h3 className="mb-1 font-semibold">Alarm terkait</h3>
                  {d.alarm.slice(0, 10).map((a) => (
                    <div key={a.id} className="flex items-start justify-between gap-2 border-t border-line/50 py-1">
                      <span><SevBadge sev={a.severity} /> {a.judul}</span>
                      <StatusPill status={a.status} />
                    </div>
                  ))}
                </section>
              )}
              <section className="rounded-lg border border-line p-3">
                <h3 className="mb-1 font-semibold">Properti (dari objek Nexus, sesuai akses akun)</h3>
                <dl className="grid grid-cols-[minmax(0,11rem)_1fr] gap-x-3 gap-y-0.5">
                  {Object.entries(d.properti).filter(([k, v]) => !HIDE.has(k) && v !== null && v !== "").map(([k, v]) => (
                    <div key={k} className="contents"><dt className="truncate text-muted">{k.replace(/_/g, " ")}</dt><dd className="break-words">{String(v)}</dd></div>
                  ))}
                </dl>
              </section>
              <Sources items={d.sumber} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
