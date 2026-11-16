"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* Demo Grid "Sensor gardu distribusi" (api/demo_grid_sensor_gardu.py, fase 5 sesi 3): meter trafo per fasa + suhu
   minyak lewat MQTT streaming -> seri kVA gardu; TL per jam dan risiko overload/penuaan (IEC 60076-7 sederhana)
   mendekati real-time; overload menjadi rekomendasi L2 (Perintah Kerja usulan, tanpa kendali SCADA). */

type Risiko = { kode_dt: string; kode_ulp: string; beban_pct: number; suhu_hotspot: number; laju_penuaan: number; tingkat: string };
type Sen = {
  built: boolean;
  pipeline_id?: string | null;
  type_id?: string | null;
  topik: string;
  simulator: { enabled: boolean; running: boolean; gardu: number; published: number; last_interval: string | null; error: string | null; sync_status: string | null };
  stream?: { id: string; name: string; records: number | null; last_at: string | null };
  job?: { id: string; status: string; error?: string | null };
  series?: { sync_id: string; points: number | null };
  deteksi?: { gardu_terbaca: number; tl_kwh_jam_terakhir: number; tl_teratas: { kode_dt: string; tl_kwh: number }[]; risiko: Risiko[]; rekomendasi_baru: string[] } | null;
};

const num = (v?: number | null) => (v === null || v === undefined ? "–" : v.toLocaleString("id-ID"));

export function GridSensorGarduSection() {
  const [d, setD] = useState<Sen | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch(`${API_URL}/api/demo/grid/sensor-gardu`, { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
        return b as Sen;
      })
      .then((b) => (setD(b), setErr(null)), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  const deteksi = async () => {
    setBusy(true);
    const r = await fetch(`${API_URL}/api/demo/grid/sensor-gardu/deteksi`, { method: "POST", credentials: "include" });
    if (!r.ok) setErr(r.statusText);
    setBusy(false);
    load();
  };

  if (err && !d) return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">Sensor gardu: {err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat sensor gardu…</p>;
  if (!d.built) return <p className="text-xs text-muted">Sensor gardu belum dibangun (langkah “sensor_gardu” build demo).</p>;
  const s = d.simulator;
  const det = d.deteksi;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="device" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Sensor gardu (fiktif)</b>
            <span className={`ml-auto h-2 w-2 rounded-full ${s.running && !s.error ? "bg-ok" : "bg-amber-500"}`} /></div>
          <div className="mt-1 text-[11.5px]">{num(s.gardu)} gardu · {num(s.published)} bacaan terkirim · sync {s.sync_status ?? "–"}</div>
          <div className="text-[10.5px] text-muted">Topik <code>{d.topik}</code></div>
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="pipeline" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Pipeline streaming</b>
            <span className={`ml-auto h-2 w-2 rounded-full ${d.job?.status === "running" ? "bg-ok" : "bg-amber-500"}`} /></div>
          <div className="mt-1 text-[11.5px]">{d.job?.status ?? "–"} · stream {num(d.stream?.records)} record · seri {num(d.series?.points)} titik kVA</div>
          {d.pipeline_id && <Link href={`/pipeline/${d.pipeline_id}`} className="text-[11px] text-ocean hover:underline">Buka pipeline →</Link>}
          {d.type_id && <Link href={`/ontology/${d.type_id}?tab=objects`} className="ml-2 text-[11px] text-ocean hover:underline">Objek sensor →</Link>}
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="wave" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Susut teknis (TL) jam terakhir</b></div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{det ? `${num(Math.round(det.tl_kwh_jam_terakhir))} kWh` : "–"}</div>
          <div className="text-[10.5px] text-muted">rugi trafo (besi + tembaga K²) + I²R JTR, dari bacaan sensor terakhir tiap gardu</div>
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="bolt" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Risiko overload / penuaan</b></div>
          <div className="mt-1 text-lg font-semibold tabular-nums" style={{ color: det && det.risiko.some((r) => r.tingkat === "Overload") ? "#dc2626" : undefined }}>
            {det ? `${det.risiko.filter((r) => r.tingkat === "Overload").length} overload · ${det.risiko.filter((r) => r.tingkat === "Waspada").length} waspada` : "–"}
          </div>
          <button onClick={deteksi} disabled={busy} className="mt-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium hover:border-ocean disabled:opacity-50">
            {busy ? "Menilai…" : "Nilai ulang TL & risiko"}
          </button>
        </div>
      </div>

      {det && det.risiko.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Gardu berisiko</th><th className="px-3 py-2 font-medium">ULP</th>
                <th className="px-3 py-2 text-right font-medium">Beban</th><th className="px-3 py-2 text-right font-medium">Hotspot</th>
                <th className="px-3 py-2 text-right font-medium">Laju penuaan</th><th className="px-3 py-2 font-medium">Tingkat</th>
              </tr>
            </thead>
            <tbody>
              {det.risiko.slice(0, 12).map((r) => (
                <tr key={r.kode_dt} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-1.5">{r.kode_dt}</td>
                  <td className="px-3 py-1.5">{r.kode_ulp}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.beban_pct.toLocaleString("id-ID")}%</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.suhu_hotspot.toLocaleString("id-ID")} °C</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.laju_penuaan.toLocaleString("id-ID")}×</td>
                  <td className="px-3 py-1.5" style={{ color: r.tingkat === "Overload" ? "#dc2626" : "#facc15" }}>{r.tingkat}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-muted">
            Gardu Overload otomatis menjadi Perintah Kerja berstatus “Usulan sensor (demo)” (rekomendasi L2: penyeimbangan beban bila arus netral
            tinggi, selain itu sisip/uprating trafo) — operator memutuskan, tidak ada kendali ke SCADA. Status beban live juga terbaca sebagai seri
            kVA di objek Sensor Gardu (Device and Machinery gardu mengikuti changelog pipeline beban per jam).
          </p>
        </div>
      )}
      {(err || s.error) && <p className="text-xs text-amber-500">{err || s.error}</p>}
    </div>
  );
}
