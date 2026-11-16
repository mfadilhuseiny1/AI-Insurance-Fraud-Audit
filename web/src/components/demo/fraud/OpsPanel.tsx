"use client";
import { useEffect, useState } from "react";
import { Widget } from "@/components/demo/audit/Workspace";
import { fraudApi } from "./api";
import type { AnyRec } from "./types";
import { DataTable, StateMsg } from "./ui";

/** Panel operasional Tahap 3–4: job async, benchmark, metrik FP aktual, decision log. */
export function OpsPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [job, setJob] = useState<AnyRec | null>(null);
  const [bench, setBench] = useState<AnyRec | null>(null);
  const [metrics, setMetrics] = useState<AnyRec | null>(null);
  const [decisions, setDecisions] = useState<AnyRec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    fraudApi.metrics().then(setMetrics, () => {});
    fraudApi.decisions().then((x) => setDecisions(x.decisions), () => setDecisions([]));
    fraudApi.materialized().then((m) => { if (m.status === "ada") setJob({ id: "terakhir", jenis: "batch-scoring & deteksi ring", status: "selesai", hasil: { klaim_diskor: m.jumlah_klaim, ring_terdeteksi: m.ring?.length } }); }, () => {});
  };
  useEffect(load, []);
  const runJob = async () => {
    setBusy(true);
    try {
      const j = await fraudApi.startJob();
      setJob(j);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const s = await fraudApi.job(j.id);
        setJob(s);
        if (s.status === "selesai" || s.status === "gagal") break;
      }
      onMsg("Batch scoring & deteksi ring selesai — skor ter-materialisasi untuk jalur pre-payment.");
      load();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };
  const runBench = async () => { try { setBench(await fraudApi.benchmark()); } catch (e) { onMsg((e as Error).message); } };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <Widget title="Batch scoring async" caption="Job latar: skor semua klaim + deteksi ring, hasil ter-materialisasi">
          <button type="button" disabled={busy} onClick={runJob} className="rounded-md bg-ocean px-3 py-2 text-xs font-semibold text-white hover:bg-ocean-deep disabled:opacity-50">{busy ? "Job berjalan…" : "Jalankan batch scoring"}</button>
          {job && <div className="mt-3 text-xs"><div className="flex justify-between"><span className="text-muted">Status</span><b>{job.status}</b></div>
            {job.hasil && <><div className="flex justify-between"><span className="text-muted">Klaim diskor</span><b className="tabular-nums">{job.hasil.klaim_diskor}</b></div><div className="flex justify-between"><span className="text-muted">Ring terdeteksi</span><b className="tabular-nums">{job.hasil.ring_terdeteksi}</b></div></>}
            {job.error && <p className="text-bad">{job.error}</p>}</div>}
        </Widget>
        <Widget title="Benchmark skrining" caption="Target plan Tahap 3: p95 < 300 ms per klaim">
          <button type="button" onClick={runBench} className="rounded-md bg-panel-2 px-3 py-2 text-xs font-semibold text-soft ring-1 ring-line-2 hover:ring-ocean/60">Ukur latency (200 klaim)</button>
          {bench && <div className="mt-3 space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted">p50</span><b className="tabular-nums">{bench.p50_ms} ms</b></div>
            <div className="flex justify-between"><span className="text-muted">p95</span><b className="tabular-nums">{bench.p95_ms} ms</b></div>
            <div className="flex justify-between"><span className="text-muted">Maks</span><b className="tabular-nums">{bench.maks_ms} ms</b></div>
            <p className={`font-semibold ${bench.lolos_target ? "text-ok" : "text-bad"}`}>{bench.lolos_target ? "Lolos target p95" : "Di atas target p95"}</p></div>}
        </Widget>
        <Widget title="Feedback loop investigator" caption="FP rate dihitung dari verdict nyata, bukan angka statis">
          {metrics ? <div className="space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted">Total feedback</span><b className="tabular-nums">{metrics.feedback_total}</b></div>
            <div className="flex justify-between"><span className="text-muted">Terkonfirmasi fraud</span><b className="tabular-nums text-bad">{metrics.terkonfirmasi_fraud}</b></div>
            <div className="flex justify-between"><span className="text-muted">False positive</span><b className="tabular-nums text-ok">{metrics.false_positive}</b></div>
            <div className="flex justify-between"><span className="text-muted">FP rate aktual</span><b className="tabular-nums">{metrics.false_positive_rate_aktual ?? "—"}</b></div>
            <p className="pt-1 text-muted">Beri verdict di panel Validasi Billing untuk mengisi metrik ini.</p></div>
            : <StateMsg kind="loading" text="Memuat metrik…" />}
        </Widget>
      </div>
      <Widget title="Decision log pre-payment" caption="Setiap keputusan skrining tercatat (Tahap 4) — terbaru dulu" bodyClass="p-0">
        {!decisions ? <div className="p-3"><StateMsg kind="loading" text="Memuat decision log…" /></div> : decisions.length ? (
          <DataTable head={["Waktu", "Peserta", "Faskes", "Keputusan", "Skor", "Latency"]}>
            {decisions.map((d, i) => <tr key={i} className="border-b border-line/60 last:border-0"><td className="px-3 py-2 tabular-nums text-muted">{d.waktu}</td><td className="px-3 py-2 font-mono">{d.peserta}</td><td className="px-3 py-2">{d.faskes}</td><td className="px-3 py-2 font-semibold">{d.keputusan}</td><td className="px-3 py-2 tabular-nums">{d.skor}</td><td className="px-3 py-2 tabular-nums">{d.latensi_ms} ms</td></tr>)}
          </DataTable>
        ) : <div className="p-3"><StateMsg kind="empty" text="Belum ada keputusan — jalankan skrining di panel Pre-Payment." /></div>}
      </Widget>
    </div>
  );
}
