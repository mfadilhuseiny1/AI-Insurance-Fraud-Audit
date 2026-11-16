"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* Demo Grid "Skor NTL per jam & deteksi bypass" (api/demo_grid_ntl_stream.py, fase 5 sesi 2): stream ami_bersih ->
   pipeline streaming per jam (agregasi, fitur adaptor, fungsi model NTL live deployment) -> deteksi CUSUM ->
   "AMI Event (demo)" di Nexus + Object Monitor. Latensi diukur terhadap kebenaran di state simulator (evaluasi
   saja, bukan input model). */

type Lat = { kejadian: string; no_meter: string; pola: string; mulai_wib: string; terdeteksi_wib: string | null; latensi_jam: number | null };
type Ntl = {
  built: boolean;
  pipeline_id?: string | null;
  type_id?: string | null;
  monitor?: string | null;
  adaptor: string;
  job?: { id: string; status: string; error?: string | null };
  deteksi?: { bacaan: number; meter_jam: number; dugaan: number; false_positive: number; meter_tanpa_kejadian: number; latensi: Lat[]; pada: string } | null;
  peristiwa?: Record<string, string | number | null>[];
  peristiwa_total?: number;
};

const num = (v?: number | null) => (v === null || v === undefined ? "–" : v.toLocaleString("id-ID"));

export function GridNtlStreamSection() {
  const [d, setD] = useState<Ntl | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [meter, setMeter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch(`${API_URL}/api/demo/grid/ntl`, { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
        return b as Ntl;
      })
      .then((b) => (setD(b), setErr(null)), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const post = async (path: string, body?: unknown) => {
    setBusy(path);
    const r = await fetch(`${API_URL}${path}`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const b = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) setErr(typeof b.detail === "string" ? b.detail : r.statusText);
    load();
  };

  if (err && !d) return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">NTL per jam: {err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat skor NTL per jam…</p>;
  if (!d.built) return <p className="text-xs text-muted">Skor NTL per jam belum dibangun (langkah “ntl_stream” build demo).</p>;
  const det = d.deteksi;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="pipeline" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Pipeline streaming per jam</b>
            <span className={`ml-auto h-2 w-2 rounded-full ${d.job?.status === "running" ? "bg-ok" : "bg-amber-500"}`} /></div>
          <div className="mt-1 text-[11.5px]">{d.job?.status ?? "–"} · agregasi jam → fitur → model → skor</div>
          {d.pipeline_id && <Link href={`/pipeline/${d.pipeline_id}`} className="text-[11px] text-ocean hover:underline">Buka pipeline →</Link>}
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="bell" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Peristiwa dugaan bypass</b></div>
          <div className="mt-1 text-[11.5px]">{num(d.peristiwa_total)} di Nexus (yang terlihat oleh akun Anda)</div>
          {d.type_id && <Link href={`/ontology/${d.type_id}?tab=objects`} className="text-[11px] text-ocean hover:underline">Buka objek →</Link>}
          {d.monitor && <span className="ml-2 text-[11px] text-muted">Object Monitor aktif</span>}
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="clock" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Putaran deteksi terakhir</b></div>
          <div className="mt-1 text-[11.5px]">{det ? `${num(det.bacaan)} bacaan · ${num(det.meter_jam)} meter-jam · ${num(det.dugaan)} dugaan` : "belum jalan"}</div>
          <button onClick={() => post("/api/demo/grid/ntl/deteksi")} disabled={busy !== null}
                  className="mt-1 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium hover:border-ocean disabled:opacity-50">
            {busy === "/api/demo/grid/ntl/deteksi" ? "Mendeteksi…" : "Jalankan deteksi"}
          </button>
        </div>
        <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-2"><Icon name="bolt" className="h-4 w-4 text-ocean" /><b className="text-[12.5px]">Suntik bypass (demo langsung)</b></div>
          <div className="mt-1 flex gap-1.5">
            <input value={meter} onChange={(e) => setMeter(e.target.value)} placeholder="No. meter pilot"
                   className="w-full rounded-lg border border-line bg-transparent px-2 py-1 text-[11.5px]" />
            <button onClick={() => meter && post("/api/demo/grid/ntl/suntik", { no_meter: meter })} disabled={busy !== null || !meter}
                    className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium hover:border-ocean disabled:opacity-50">
              {busy === "/api/demo/grid/ntl/suntik" ? "Menyuntik…" : "Suntik bypass"}
            </button>
          </div>
          <div className="mt-1 text-[10.5px] text-muted">Mulai sekarang; kebenarannya dicatat di state simulator untuk mengukur latensi.</div>
        </div>
      </div>

      {det && det.latensi.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Kejadian (kebenaran, evaluasi saja)</th><th className="px-3 py-2 font-medium">Meter</th>
                <th className="px-3 py-2 font-medium">Mulai (WIB)</th><th className="px-3 py-2 font-medium">Terdeteksi (WIB)</th>
                <th className="px-3 py-2 text-right font-medium">Latensi data</th>
              </tr>
            </thead>
            <tbody>
              {det.latensi.map((l) => (
                <tr key={l.kejadian} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-1.5">{l.kejadian} · {l.pola}</td>
                  <td className="px-3 py-1.5">{l.no_meter}</td>
                  <td className="px-3 py-1.5">{l.mulai_wib}</td>
                  <td className="px-3 py-1.5">{l.terdeteksi_wib ?? "belum"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: l.latensi_jam === null ? "#f97316" : l.latensi_jam < 3 ? "#22c55e" : "#f97316" }}>
                    {l.latensi_jam === null ? "—" : `${l.latensi_jam.toLocaleString("id-ID")} jam`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-muted">
            Target &lt; 3 jam data. False positive: {num(det.false_positive)} dugaan pada {num(det.meter_tanpa_kejadian)} meter tanpa kejadian
            (meter dengan pola tertanam lama tidak dihitung false positive). {d.adaptor}
          </p>
        </div>
      )}

      {d.peristiwa && d.peristiwa.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">AMI Event (demo)</th><th className="px-3 py-2 font-medium">Meter</th>
                <th className="px-3 py-2 font-medium">ULP</th><th className="px-3 py-2 font-medium">Bukti</th>
                <th className="px-3 py-2 text-right font-medium">Skor/jam</th>
              </tr>
            </thead>
            <tbody>
              {d.peristiwa.slice(-10).reverse().map((p) => (
                <tr key={String(p._pk)} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-1.5">{String(p.judul ?? p._pk)}</td>
                  <td className="px-3 py-1.5">{String(p.no_meter ?? "")}</td>
                  <td className="px-3 py-1.5">{String(p.kode_ulp ?? "")}</td>
                  <td className="px-3 py-1.5 text-muted">{String(p.bukti ?? "")}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{p.skor_ntl_jam === null || p.skor_ntl_jam === undefined ? "–" : Number(p.skor_ntl_jam).toLocaleString("id-ID")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {err && <p className="text-xs text-amber-500">{err}</p>}
    </div>
  );
}
