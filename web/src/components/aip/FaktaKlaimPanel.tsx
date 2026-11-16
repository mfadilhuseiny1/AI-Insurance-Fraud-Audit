"use client";
import { Fragment, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { fraud } from "@/components/aip/fraudApi";

/* Above the canvas of pipeline 2 (Fakta Klaim) in AIP JKN: what the pipeline computes on every claim — each fact, its
   condition, the Permenkes mode it points to, how many claims have it and the output column — read from the rules
   catalogue (GET /api/aip/aturan, layer "fakta"), whose conditions and counts are the code's own. */

type Fakta = { id: string; nama: string; tag: string | null; tag_label: string | null; modus: string | null; kondisi: string; kenapa: string; data: string;
  keterbatasan: string; kolom: string | null; catatan: string; temuan?: number | null; temuan_satuan?: string; lapisan: string };

const KEY = "aip.faktaKlaim.tutup";
const idn = (n: number) => n.toLocaleString("id-ID");

export function FaktaKlaimPanel({ onRules }: { onRules: () => void }) {
  const [rows, setRows] = useState<Fakta[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [shut, setShut] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    fraud.aturan().then((k) => setRows(((k as unknown as { aturan?: Fakta[] }).aturan ?? []).filter((a) => a.lapisan === "fakta")))
      .catch((e) => setErr((e as Error).message));
  }, []);
  const toggle = () => {
    setShut((s) => {
      try { localStorage.setItem(KEY, s ? "0" : "1"); } catch { /* the panel works without it */ }
      return !s;
    });
  };
  return (
    <section className="shrink-0 border-b border-black/40 bg-[#1c2127] text-[12px]">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[.03]">
        <Icon name={shut ? "right" : "down"} className="h-3.5 w-3.5 text-[#8f99a8]" />
        <span className="font-semibold text-white">Pipeline 2 · Fakta Klaim</span>
        <span className="truncate text-[#abb3bf]">
          fakta di setiap klaim FKRTL: <code className="font-mono text-[11px]">klaim_fkrtl</code> + <code className="font-mono text-[11px]">peserta</code> →{" "}
          <code className="font-mono text-[11px]">klaim_fkrtl_fakta</code> (Siap Analisis)
        </span>
        {rows && <span className="ml-auto shrink-0 text-[11px] text-[#8f99a8]">{rows.length} fakta</span>}
      </button>
      {!shut && (
        <div className="max-h-[42vh] overflow-auto px-3 pb-2">
          <p className="mb-1.5 text-[11.5px] leading-relaxed text-[#c5cbd3]">
            Pipeline ini <b className="text-white">tidak menuduh</b>: ia menandai fakta yang bisa dihitung pasti dari data (tanggal, kelas, tarif) pada semua klaim.
            Fakta menjadi bahan <b className="text-white">penanda otomatis</b> (tag indikasi di Nexus) dan <b className="text-white">AI Agent Swarm</b>; putusan tetap di auditor.
          </p>
          {err && <p className="text-[11.5px] text-red-300">Daftar fakta tidak terbaca: {err}</p>}
          {!rows && !err && <p className="text-[11.5px] text-[#8f99a8]">Memuat…</p>}
          {rows && (
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">
                <tr>{["Fakta", "Kondisi", "Mengarah ke", "Klaim", "Kolom keluaran", ""].map((h, i) => <th key={i} className="px-2 py-1 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="cursor-pointer border-t border-white/5 hover:bg-white/[.03]" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="px-2 py-1 font-medium text-[#e5e8eb]">{r.nama}</td>
                      <td className="px-2 py-1 text-[#c5cbd3]">{r.kondisi}</td>
                      <td className="px-2 py-1" title={r.modus ?? undefined}>
                        {r.tag_label ? <span className="rounded bg-[#fab219]/10 px-1.5 py-0.5 text-[10.5px] text-[#fbd38d]">{r.tag_label}</span>
                          : <span className="text-[10.5px] text-[#8f99a8]">pembeda, bukan indikasi</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-white">{r.temuan != null ? idn(r.temuan) : "—"}</td>
                      <td className="px-2 py-1 font-mono text-[10.5px] text-[#abb3bf]">{r.kolom ?? "—"}</td>
                      <td className="px-2 py-1 text-[#8abbff]"><Icon name={open === r.id ? "down" : "right"} className="h-3 w-3" /></td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} className="px-2 pb-2">
                          <div className="grid gap-2 rounded bg-black/20 p-2 text-[11px] leading-relaxed text-[#c5cbd3] md:grid-cols-3">
                            <p><b className="text-white">Kenapa:</b> {r.kenapa}</p>
                            <p><b className="text-white">Data:</b> {r.data}{r.modus ? <><br /><b className="text-white">Modus Permenkes 16/2019:</b> {r.modus}</> : null}</p>
                            <p><b className="text-white">Keterbatasan:</b> {r.keterbatasan || "—"}{r.catatan ? <><br />{r.catatan}</> : null}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          <button onClick={onRules} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-[#8abbff] hover:underline">
            <Icon name="list" className="h-3 w-3" />Semua aturan, ambang dan lapisan berikutnya (skrining, penanda, kerugian) di Box Karantina → Aturan Indikasi
          </button>
        </div>
      )}
    </section>
  );
}
