"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* Demo Grid "Feedback loop P2TL" (api/demo_grid_feedback.py, fase 5 sesi 4): hasil pemeriksaan -> label latih
   berversi (pipeline terjadwal) -> retrain mingguan tercatat; hit-rate agregat per ULP/basis tanpa PII. */

type Agg = { nama: string; diperiksa: number; terbukti: number; hit_rate: number | null };
type Fb = {
  built: boolean;
  pipeline_id?: string | null;
  label: { versi_data?: number | null; baris?: number | null; positif?: number | null };
  hitrate?: { per_ulp: Agg[]; per_basis: Agg[]; total: { diperiksa: number; terbukti: number } } | null;
  retrains?: { pada: string; label_versi_data?: number | null }[];
  jadwal: string;
};

const num = (v?: number | null) => (v === null || v === undefined ? "–" : v.toLocaleString("id-ID"));
const pct = (v?: number | null) => (v === null || v === undefined ? "–" : `${(v * 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`);

function Tabel({ judul, rows }: { judul: string; rows: Agg[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-3 py-2 text-[12px] font-medium">{judul}</div>
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            <th className="px-3 py-2 font-medium">Kelompok</th><th className="px-3 py-2 text-right font-medium">Diperiksa</th>
            <th className="px-3 py-2 text-right font-medium">Terbukti</th><th className="px-3 py-2 text-right font-medium">Hit-rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.nama} className="border-b border-line/60 last:border-0">
              <td className="px-3 py-1.5">{r.nama}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{num(r.diperiksa)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{num(r.terbukti)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.hit_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GridFeedbackSection() {
  const [d, setD] = useState<Fb | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch(`${API_URL}/api/demo/grid/feedback`, { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
        return b as Fb;
      })
      .then((b) => (setD(b), setErr(null)), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const retrain = async () => {
    setBusy(true);
    const r = await fetch(`${API_URL}/api/demo/grid/feedback/retrain`, { method: "POST", credentials: "include" });
    if (!r.ok) setErr(r.statusText);
    setBusy(false);
    load();
  };

  if (err && !d) return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">Feedback P2TL: {err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat feedback P2TL…</p>;
  if (!d.built) return <p className="text-xs text-muted">Feedback P2TL belum dibangun (langkah “feedback” build demo).</p>;
  const hr = d.hitrate;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="database" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Dataset label latih</b></div>
          <div className="mt-1 text-[11.5px]">versi data {num(d.label.versi_data)} · {num(d.label.baris)} pelanggan berlabel · {num(d.label.positif)} positif</div>
          {d.pipeline_id && <Link href={`/pipeline/${d.pipeline_id}`} className="text-[11px] text-ocean hover:underline">Pipeline label →</Link>}
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="clock" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Retrain terjadwal</b></div>
          <div className="mt-1 text-[11.5px]">{d.jadwal}</div>
          <div className="text-[11px] text-muted">{d.retrains && d.retrains.length > 0 ? `terakhir: ${new Date(d.retrains[d.retrains.length - 1].pada).toLocaleString("id-ID")}` : "belum pernah dari tombol ini"}</div>
          <button onClick={retrain} disabled={busy} className="mt-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium hover:border-ocean disabled:opacity-50">
            {busy ? "Melatih…" : "Latih ulang sekarang"}
          </button>
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="check" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Hit-rate keseluruhan</b></div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{hr ? pct(hr.total.diperiksa ? hr.total.terbukti / hr.total.diperiksa : null) : "–"}</div>
          <div className="text-[10.5px] text-muted">{hr ? `${num(hr.total.terbukti)} terbukti dari ${num(hr.total.diperiksa)} pemeriksaan (agregat, tanpa identitas pelanggan)` : ""}</div>
        </div>
      </div>
      {hr && (
        <div className="grid gap-2 lg:grid-cols-2">
          <Tabel judul="Hit-rate per ULP" rows={hr.per_ulp} />
          <Tabel judul="Hit-rate per basis pemilihan target" rows={hr.per_basis} />
        </div>
      )}
      {err && <p className="text-xs text-amber-500">{err}</p>}
    </div>
  );
}
