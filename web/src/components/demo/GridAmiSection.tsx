"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* Demo Grid "AMI streaming" (api/demo_grid_ami.py, phase 5 session 1): fictional meters publish over MQTT (Sparkplug B
   topic namespace) → the platform's MQTT Broker → a streaming sync → an ingest stream → a streaming pipeline → a time
   series per meter on the Nexus type "Grid AMI Meter (demo)". Live counts, refreshed every 30 s. */

type Ami = {
  built: boolean;
  pipeline_id?: string | null;
  type_id?: string | null;
  topik: string;
  head_end: string[];
  pilot: { meter: number; gardu: string[]; tm: number };
  simulator: { enabled: boolean; running: boolean; meters: number; published: number; last_interval: string | null; started: string | null; error: string | null; sync_status: string | null };
  broker?: { running: boolean; clients?: number; messages_per_min?: number; address?: string; error?: string };
  sync?: { id: string; name: string; status: string; error?: string | null; records: number | null };
  stream?: { id: string; name: string; records: number | null; last_at: string | null };
  job?: { id: string; status: string; started_at: string | null; records?: string };
  series?: { sync_id: string; points: number | null; last_write_at: string | null };
  beban_pilot?: { t: string; tr: number; tm: number }[];
  kejadian_tertanam: number;
};

const num = (v?: number | null) => (v === null || v === undefined ? "–" : v.toLocaleString("id-ID"));
const wib = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB" : "–";

function Step({ icon, title, app, ok, lines, href }: { icon: IconName; title: string; app: string; ok: boolean | null; lines: string[]; href?: string | null }) {
  const body = (
    <div className={`h-full rounded-xl border bg-panel px-3 py-2.5 ${href ? "hover:border-ocean" : ""} ${ok === false ? "border-amber-500/60" : "border-line"}`}>
      <div className="flex items-center gap-2">
        <Icon name={icon} className="h-4 w-4 text-ocean" />
        <b className="text-[12.5px]">{title}</b>
        <span className={`ml-auto h-2 w-2 rounded-full ${ok === null ? "bg-line" : ok ? "bg-ok" : "bg-amber-500"}`} />
      </div>
      <div className="mt-0.5 text-[10.5px] text-muted">{app}</div>
      {lines.map((l) => (
        <div key={l} className="mt-1 text-[11.5px]">{l}</div>
      ))}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

function Spark({ rows, k, label, color }: { rows: { t: string; tr: number; tm: number }[]; k: "tr" | "tm"; label: string; color: string }) {
  const W = 460, H = 90;
  const vals = rows.map((r) => r[k]);
  const max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * W},${H - (v / max) * (H - 6)}`).join(" ");
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2">
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <b>{label}</b>
        <span className="text-muted">puncak {num(Math.round(max))} kW · terakhir {num(Math.round(vals[vals.length - 1] ?? 0))} kW</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-[90px] w-full" preserveAspectRatio="none" role="img" aria-label={label}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{rows[0] ? wib(rows[0].t + ":00Z") : ""}</span>
        <span>{rows.length ? wib(rows[rows.length - 1].t + ":00Z") : ""}</span>
      </div>
    </div>
  );
}

export function GridAmiSection() {
  const [d, setD] = useState<Ami | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch(`${API_URL}/api/demo/grid/ami`, { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
        return b as Ami;
      })
      .then((b) => (setD(b), setErr(null)), (e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    if (!d) return;
    setBusy(true);
    const r = await fetch(`${API_URL}/api/demo/grid/ami/simulator`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !d.simulator.enabled }),
    });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) setErr(typeof b.detail === "string" ? b.detail : r.statusText);
    load();
  };

  if (err && !d) return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">AMI streaming: {err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat AMI streaming…</p>;
  if (!d.built) return <p className="text-xs text-muted">AMI streaming belum dibangun (langkah “ami” build demo).</p>;
  const s = d.simulator;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Step icon="device" title="Meter AMI/AMR (fiktif)" app="Simulator di API" ok={s.running && !s.error}
              lines={[`${num(s.meters)} meter · ${d.pilot.tm} TM`, `${num(s.published)} bacaan terkirim`, `interval terakhir ${wib(s.last_interval)}`]} />
        <Step icon="signal" title="MQTT Broker" app="Mosquitto · Sparkplug B (namespace)" ok={d.broker?.running ?? null} href="/mqtt-broker"
              lines={[`${num(d.broker?.clients)} klien`, `${num(d.broker?.messages_per_min)} pesan/menit`, d.head_end.join(" · ")]} />
        <Step icon="plug" title="Streaming sync" app="Data Connection · MQTT" ok={d.sync ? d.sync.status === "running" : null}
              href={d.sync ? `/streaming/syncs/${d.sync.id}` : null} lines={[d.sync?.status ?? "–", `${num(d.sync?.records)} record`]} />
        <Step icon="database" title="Ingest stream" app="Streaming" ok={d.stream ? (d.stream.records ?? 0) > 0 : null}
              href={d.stream ? `/streaming/streams/${d.stream.id}` : null} lines={[`${num(d.stream?.records)} record`, `terakhir ${wib(d.stream?.last_at)}`]} />
        <Step icon="pipeline" title="Pipeline streaming" app="Pipeline Builder (job streaming)" ok={d.job ? d.job.status === "running" : null}
              href={d.pipeline_id ? `/pipeline/${d.pipeline_id}` : null} lines={[d.job?.status ?? "–", d.job?.records ?? "validasi → seri, peristiwa"]} />
        <Step icon="wave" title="Time series" app="Time Series Catalog" ok={d.series ? (d.series.points ?? 0) > 0 : null}
              href={d.series ? `/time-series/${d.series.sync_id}` : null} lines={[`${num(d.series?.points)} titik kW`, `tulis terakhir ${wib(d.series?.last_write_at)}`]} />
        <Step icon="cube" title="Meter AMI (Nexus)" app="Objek sensor → Pelanggan" ok={d.type_id ? true : null}
              href={d.type_id ? `/ontology/${d.type_id}?tab=objects` : null} lines={["seri_ami per meter", "baris per ULP (kebijakan)"]} />
      </div>
      {d.beban_pilot && d.beban_pilot.length > 1 && (
        <div className="grid gap-2 lg:grid-cols-2">
          <Spark rows={d.beban_pilot} k="tr" label={`Beban pelanggan TR ber-AMI (${d.pilot.gardu.join(", ")})`} color="#0ea5e9" />
          <Spark rows={d.beban_pilot} k="tm" label="Beban pelanggan TM (AMR, 3 fasa)" color="#a855f7" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 text-xs">
        <span className="text-muted">
          Topik <code>{d.topik}</code> · payload JSON per interval 15 menit · backfill 48 jam lalu real-time; setelah API restart, bacaan yang tertunda
          dikirim ulang (store and forward). {d.kejadian_tertanam} kejadian baru (bypass, magnet, shunt CT) tertanam untuk deteksi per jam (sesi berikutnya). Hanya membaca —
          tidak ada jalur kendali ke SCADA.
        </span>
        <button onClick={toggle} disabled={busy} className="ml-auto rounded-lg border border-line px-3 py-1.5 font-medium hover:border-ocean disabled:opacity-50">
          {s.enabled ? "Hentikan simulator" : "Jalankan simulator"}
        </button>
      </div>
      {(err || s.error || d.sync?.error) && <p className="text-xs text-amber-500">{err || s.error || d.sync?.error}</p>}
    </div>
  );
}
