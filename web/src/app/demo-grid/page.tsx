"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { LineageDiagram, type PipeGraph } from "@/components/demo/LineageDiagram";
import { GridAksesSection } from "@/components/demo/GridAksesSection";
import { GridAmiSection } from "@/components/demo/GridAmiSection";
import { GridNtlStreamSection } from "@/components/demo/GridNtlStreamSection";
import { GridSensorGarduSection } from "@/components/demo/GridSensorGarduSection";
import { GridFeedbackSection } from "@/components/demo/GridFeedbackSection";
import { API_URL } from "@/lib/api";

/* Grid Management System Intelligence (demo): technical (TL) and non-technical (NTL) losses of a distribution network,
   end to end on the platform — NUSAGRID SCADA, AMR/AMI, AP2T billing and P2TL results through two pipelines into the
   Nexus, rules + ML + hourly time series on top, and the apps the loss team decides in (api/demo_grid_e2e.py). */

type Ulp = { kode_ulp: string; nama: string; mwh_kirim: number; susut_mwh: number; susut_pct: number; tl_pct: number; ntl_pct: number; penyulang: number };
type Pny = {
  kode_penyulang: string; nama: string; kode_ulp: string; jenis: string; mwh_kirim_q3: number; susut_pct: number; susut_teknis_pct: number;
  susut_non_teknis_pct: number; saidi_menit: number | null; saifi_kali: number | null; tingkat_susut: string; jumlah_temuan: number; nilai_harapan_rp: number;
};
type Temuan = {
  id_temuan: string; kode_objek: string; jenis_objek: string; kelompok_susut: string; kode_pola_dugaan: string; judul: string; skor: number; bukti: string;
  nilai_harapan_rp: number; prioritas: string; status_temuan: string; segmen: string; tegangan: string; kode_penyulang: string;
};
type Pipe = PipeGraph & { id: string | null; name: string; sql: Record<string, string>; rows: Record<string, number>; backs: Record<string, string> };
type NexusType = { id: string; name: string; api_name: string; color?: string | null; description: string; objects: number; properties: number; dataset?: string | null;
  extra_datasources: number; time_series: string[] };
type Overview = {
  project: string; project_id?: string | null; built_at?: string | null; steps: { step: string; ok: boolean; error?: string }[];
  ulp: Ulp[]; penyulang: Pny[]; gardu: { total: number; per_status: Record<string, number> };
  temuan: { total: number; per_prioritas: Record<string, number>; per_status: Record<string, number>; nilai_harapan_rp: number;
    per_pola: { pola: string; judul: string; kelompok: string; temuan: number; nilai_harapan_rp: number }[]; top: Temuan[] };
  p2tl: { dasar: string; pemeriksaan: number; temuan: number; rp: number }[];
  ml: { strategi: { strategi: string; k: number; presisi_at_k: number; rp_pulih_per_inspeksi_bulan: number; auroc_kunci: number }[];
    bias: { segmen: string; pelanggan: number; diinspeksi: number; temuan: number }[]; params?: Record<string, unknown> | null };
  pipelines: Record<string, Pipe>;
  nexus: { object_types: NexusType[]; link_types: { id: string; name: string; source: string; target: string }[];
    action_types: { id: string; name: string; object_type_id: string; kind: string; description: string }[]; functions: { id: string; name: string; doc: string; output: string }[] };
  object_counts: Record<string, number>;
  apps: { map?: string | null; workshop?: string | null; lineage_graph: string; vertex: { topologi?: string; kawasan?: string; template?: string };
    functions_repo?: string | null; ml_pipeline?: string | null; iot_pipeline?: string | null; syncs?: Record<string, string> | null; board?: string | null;
    machinery?: string | null; governance?: Record<string, string> | null;
    analitik?: { rules_workflow?: string; scenarios?: Record<string, string>; quiver?: { gardu?: string | null; tm?: string | null }; contour?: string | null } | null };
};

const rp = (v: number) => (Math.abs(v) >= 1e9 ? `Rp ${(v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M` : Math.abs(v) >= 1e6 ? `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : `Rp ${Math.round(v).toLocaleString("id-ID")}`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`);
const short = (s: string) => s.replace(/\s*\(demo\)\s*$/, "").replace(/ Grid$/, "");
const TINGKAT: Record<string, string> = { Kritis: "#dc2626", Tinggi: "#f97316", Sedang: "#facc15", Rendah: "#22c55e" };
const PRIO: Record<string, string> = { P1: "#dc2626", P2: "#f97316", P3: "#facc15" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", credentials: "include", ...init });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

function Kpi({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums" style={color ? { color } : undefined}>{value}</div>
      {hint && <div className="text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

function Title({ n, title, sub }: { n: number; title: string; sub?: string }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-ocean/20 text-xs text-ocean">{n}</span>{title}</h2>
      {sub && <p className="mt-0.5 max-w-4xl text-xs text-muted">{sub}</p>}
    </div>
  );
}

type Step = { icon: IconName; layer: string; title: string; plain: string; app: string; href?: string | null; color: string };

/** The chain from the source systems to the decision, each block opening the resource that does it. */
function Chain({ d }: { d: Overview }) {
  const a = d.apps;
  const p = d.pipelines;
  const cols: { layer: string; color: string; steps: Step[] }[] = [
    { layer: "Sumber", color: "#64748b", steps: [
      { icon: "server", layer: "Sumber", title: "NUSAGRID SCADA", plain: "Model CIM-lite, titik ukur, historian kWh/daya penyulang, SOE gangguan (IEC 104).", app: "Data Connection · Files", href: d.project_id ? `/files/${d.project_id}` : null, color: "#c05621" },
      { icon: "signal", layer: "Sumber", title: "AMR & AMI", plain: "Gardu distribusi & pelanggan TM (tiga fasa), AMI harian & event meter TR.", app: "Files · MQTT", href: d.project_id ? `/files/${d.project_id}` : null, color: "#2c9c9c" },
      { icon: "doc", layer: "Sumber", title: "AP2T & P2TL", plain: "Master pelanggan, identitas (PII), 6 file tagihan, berita acara P2TL.", app: "Files", href: d.project_id ? `/files/${d.project_id}` : null, color: "#805ad5" },
      { icon: "globe", layer: "Sumber", title: "Transmisi Jabar (OSM)", plain: "SUTET/SUTT, GITET/GI, kawasan industri nyata — konteks tanpa angka demo.", app: "Files", href: d.project_id ? `/files/${d.project_id}` : null, color: "#718096" },
    ] },
    { layer: "Pipeline", color: "#38bdf8", steps: [
      { icon: "pipeline", layer: "Pipeline", title: "Aset & topologi", plain: "GIS + NUSAGRID + AP2T → GI, penyulang, gardu, pelanggan, titik ukur, konektivitas.", app: "Pipeline Builder", href: p.aset?.id ? `/pipeline/${p.aset.id}` : null, color: "#38bdf8" },
      { icon: "pipeline", layer: "Pipeline", title: "Neraca energi & susut", plain: "Kirim SCADA vs Σ tagihan; TL fisika (I²R, trafo), NTL sisa; 20 aturan; temuan bernilai.", app: "Pipeline Builder", href: p.susut?.id ? `/pipeline/${p.susut.id}` : null, color: "#38bdf8" },
      { icon: "wave", layer: "Pipeline", title: "Beban per jam", plain: "Daya penyulang, kVA gardu, kW TM per jam → time series, status beban gardu.", app: "Pipeline Builder", href: a.iot_pipeline ? `/pipeline/${a.iot_pipeline}` : null, color: "#0ea5e9" },
      { icon: "sparkle", layer: "Pipeline", title: "Skor NTL (model)", plain: "Fungsi model dari live deployment di langkah Python-function → peringkat nilai.", app: "Pipeline Builder", href: a.ml_pipeline ? `/pipeline/${a.ml_pipeline}` : null, color: "#a855f7" },
    ] },
    { layer: "Nexus", color: "#f59e0b", steps: [
      { icon: "cube", layer: "Nexus", title: `${d.nexus.object_types.length} object type`, plain: "GI → penyulang → gardu → pelanggan, neraca, temuan, P2TL, gangguan, kunjungan, konteks OSM.", app: "Nexus Manager", href: "/ontology", color: "#f59e0b" },
      { icon: "bolt", layer: "Nexus", title: `${d.nexus.action_types.length} action`, plain: "Status temuan, target P2TL, eskalasi, hasil P2TL (label), perintah kerja, ganti meter, jadwal.", app: "Actions", href: "/ontology", color: "#f59e0b" },
      { icon: "logic", layer: "Nexus", title: `${d.nexus.functions.length} function`, plain: "Penjelasan susut & temuan, pelanggan di balik gardu, tetangga segolongan, what-if teknis.", app: "Functions", href: "/functions", color: "#f59e0b" },
      { icon: "device", layer: "Nexus", title: "Device and Machinery", plain: "Gardu: Normal / Beban tinggi / Overload per jam; alur keputusan temuan dari action.", app: "Device and Machinery", href: a.machinery ? `/machinery?id=${a.machinery}` : "/machinery", color: "#f59e0b" },
    ] },
    { layer: "Kecerdasan", color: "#a855f7", steps: [
      { icon: "filter", layer: "Kecerdasan", title: "Skrining aturan", plain: "13 aturan pelanggan + 7 aturan jaringan menandai pola NTL-xx / TL-xx.", app: "Pipeline Builder (SQL)", href: p.susut?.id ? `/pipeline/${p.susut.id}` : null, color: "#a855f7" },
      { icon: "sparkle", layer: "Kecerdasan", title: "Model NTL", plain: "Isolation Forest + gradient boosting berlabel P2TL; prioritas = peluang × nilai.", app: "Code Repositories · Models", href: "/model-assets", color: "#a855f7" },
      { icon: "graph", layer: "Kecerdasan", title: "Time series", plain: "Beban per jam sebagai sensor objek penyulang, gardu, pelanggan TM.", app: "Time Series Catalog", href: a.syncs?.gardu ? `/time-series/${a.syncs.gardu}` : "/time-series", color: "#a855f7" },
      { icon: "bell", layer: "Kecerdasan", title: "Monitor & automasi", plain: "Temuan P1 baru, gardu NTL tinggi, nilai > Rp 3 M; notifikasi eskalasi.", app: "Object Monitors · Automate", href: "/object-monitors", color: "#a855f7" },
    ] },
    { layer: "Aplikasi", color: "#10b981", steps: [
      { icon: "globe", layer: "Aplikasi", title: "Peta susut Jabar", plain: "Transmisi nyata + penyulang demo diwarnai susut, gardu per status, pelanggan P1/P2.", app: "Map", href: a.map ? `/map/${a.map}` : null, color: "#10b981" },
      { icon: "graph", layer: "Aplikasi", title: "Vertex", plain: "Topologi GI → penyulang → gardu → pelanggan → temuan; template telusuri gardu.", app: "Vertex", href: a.vertex.topologi ? `/vertex?graph=${a.vertex.topologi}` : "/vertex", color: "#10b981" },
      { icon: "gauge", layer: "Aplikasi", title: "Kokpit Workshop", plain: "Temuan berprioritas nilai, penjelasan (function), keputusan (action).", app: "Workshop", href: a.workshop ? `/workshop/${a.workshop}` : null, color: "#10b981" },
      { icon: "clock", layer: "Aplikasi", title: "Jadwal P2TL", plain: "Kunjungan per tim lapangan: jam kerja, tanpa tumpang tindih, keahlian TR/TM.", app: "Dynamic Scheduling", href: "/dynamic-scheduling", color: "#10b981" },
    ] },
  ];
  return (
    <section className="space-y-2">
      <Title n={1} title="Alur end-to-end" sub="Dari sistem sumber sampai keputusan, setiap kotak adalah sumber daya nyata di platform — klik untuk membukanya. Lineage dan tata kelola berlaku di semua lapis." />
      <div className="grid gap-3 lg:grid-cols-5">
        {cols.map((c) => (
          <div key={c.layer} className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: c.color }}>{c.layer}</div>
            {c.steps.map((s) => {
              const body = (
                <div className="h-full rounded-xl border border-line bg-panel p-3 transition hover:border-ocean/60">
                  <div className="flex items-center gap-1.5 font-semibold"><span style={{ color: s.color }}><Icon name={s.icon} className="h-3.5 w-3.5" /></span>{s.title}</div>
                  <p className="mt-1 text-[11px] leading-snug text-muted">{s.plain}</p>
                  <div className="mt-1.5 text-[10px] text-ocean">{s.app}</div>
                </div>
              );
              return s.href ? <Link key={s.title} href={s.href} className="block">{body}</Link> : <div key={s.title}>{body}</div>;
            })}
          </div>
        ))}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Link href={`/lineage?graph=${a.lineage_graph}`} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs hover:border-ocean/60">
          <Icon name="layers" className="h-4 w-4 text-ocean" /><b>Data lineage</b><span className="text-muted">raw → pipeline → dataset → Nexus → action/function → aplikasi, satu graf tersimpan</span>
        </Link>
        <Link href={d.project_id ? `/security-governance/center?project=${d.project_id}` : "/security-governance/center"} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs hover:border-ocean/60">
          <Icon name="lock" className="h-4 w-4 text-bad" /><b>Keamanan & tata kelola</b><span className="text-muted">PII pelanggan (Cipher), infrastruktur kritis SCADA, checkpoint, retensi</span>
        </Link>
      </div>
    </section>
  );
}

export default function DemoGridPage() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pipe, setPipe] = useState<string>("susut");
  const load = useCallback(() => api<Overview>("/api/demo/grid/e2e/overview").then((x) => (setD(x), setErr(null)), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const build = async () => {
    setBusy(true);
    try {
      await api("/api/demo/grid/e2e", { method: "POST" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = !!d && d.nexus.object_types.length > 0;
  const totalSusut = d ? d.ulp.reduce((a, u) => a + u.susut_mwh, 0) : 0;
  const totalKirim = d ? d.ulp.reduce((a, u) => a + u.mwh_kirim, 0) : 0;
  const tm = d?.nexus.object_types.find((t) => t.name.startsWith("Temuan Susut"));
  const pl = d?.nexus.object_types.find((t) => t.name.startsWith("Pelanggan Grid"));
  const nl = d?.ml.strategi.filter((r) => r.k === 40) ?? [];
  const maxRp = Math.max(1, ...nl.map((r) => r.rp_pulih_per_inspeksi_bulan));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 p-6 text-sm">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">Demo · jaringan distribusi fiktif · transmisi Jabar nyata (OSM)</span>
            {d?.apps.map && <Link href={`/map/${d.apps.map}`} className="text-xs text-teal-300 hover:underline">Peta susut →</Link>}
            {d?.apps.workshop && <Link href={`/workshop/${d.apps.workshop}`} className="text-xs text-warn hover:underline">Kokpit Workshop →</Link>}
            <Link href={`/lineage?graph=${d?.apps.lineage_graph ?? "gridsusut"}`} className="text-xs text-ocean hover:underline">Data lineage →</Link>
            <button type="button" onClick={build} disabled={busy} className={`${buttonClass.secondary} ml-auto`}>
              <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Membangun… (beberapa menit)" : ready ? "Perbarui demo" : "Bangun demo end-to-end"}
            </button>
          </div>
          <h1 className="mt-2 text-2xl font-semibold">Grid Management System Intelligence</h1>
          <p className="mt-1 max-w-4xl text-muted">
            Ke mana energi hilang, berapa nilainya, teknis atau non-teknis, dan tindakan apa yang paling menguntungkan minggu ini. Data SCADA (model{" "}
            <b className="text-soft">NUSAGRID</b>), AMR/AMI, tagihan dan hasil P2TL diolah pipeline menjadi <b className="text-soft">Nexus</b> jaringan; aturan,{" "}
            <b className="text-soft">model ML</b> dan <b className="text-soft">time series</b> menandai susut; tim susut memutuskan lewat action — semuanya tercatat dan
            bisa ditelusuri sampai baris mentah.
          </p>
          {err && <p className="mt-2 text-xs text-bad">{err}</p>}
          {d && d.steps.some((s) => !s.ok) && (
            <p className="mt-2 text-xs text-warn">Langkah build yang belum berhasil: {d.steps.filter((s) => !s.ok).map((s) => `${s.step} (${s.error ?? "?"})`).join(" · ")}</p>
          )}
        </header>

        {d && d.ulp.length > 0 && (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {d.ulp.map((u) => (
              <Kpi key={u.kode_ulp} label={`Susut ${u.nama.replace("ULP Demo ", "")} (Jul–Sep)`} value={pct(u.susut_pct)} hint={`TL ${pct(u.tl_pct)} · NTL ${pct(u.ntl_pct)} · ${Math.round(u.mwh_kirim).toLocaleString("id-ID")} MWh`}
                   color={u.susut_pct > 8 ? "#f97316" : u.susut_pct > 5 ? "#facc15" : "#22c55e"} />
            ))}
            <Kpi label="Energi hilang Jul–Sep" value={`${Math.round(totalSusut).toLocaleString("id-ID")} MWh`} hint={`${pct((100 * totalSusut) / Math.max(1, totalKirim))} dari kWh kirim`} />
            <Kpi label="Temuan P1 / P2 / P3" value={`${d.temuan.per_prioritas.P1 ?? 0} / ${d.temuan.per_prioritas.P2 ?? 0} / ${d.temuan.per_prioritas.P3 ?? 0}`} hint={`${d.temuan.total} temuan`} color="#dc2626" />
            <Kpi label="Nilai harapan temuan" value={rp(d.temuan.nilai_harapan_rp)} hint="skor × nilai/bln × 3 bulan" color="#f97316" />
          </section>
        )}

        {d && <Chain d={d} />}

        {d && d.penyulang.length > 0 && (
          <section className="space-y-2">
            <Title n={2} title="Neraca energi per penyulang (Jul–Sep 2026)" sub="kWh kirim SCADA dibanding Σ tagihan pelanggannya; susut teknis dihitung dari fisika (I²R dengan faktor rugi, rugi trafo, ketidakseimbangan fasa), non-teknis = sisanya. Keandalan dari SOE SCADA (Apr–Sep)." />
            <div className="overflow-x-auto rounded-xl border border-line bg-panel">
              <table className="w-full text-xs">
                <thead className="text-left text-muted">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-medium">Penyulang</th><th className="px-3 py-2 font-medium">ULP</th>
                    <th className="px-3 py-2 text-right font-medium">MWh kirim</th><th className="px-3 py-2 font-medium">Susut (teknis ▮ non-teknis ▮)</th>
                    <th className="px-3 py-2 text-right font-medium">SAIDI</th><th className="px-3 py-2 text-right font-medium">SAIFI</th>
                    <th className="px-3 py-2 text-right font-medium">Temuan</th><th className="px-3 py-2 text-right font-medium">Nilai harapan</th>
                  </tr>
                </thead>
                <tbody>
                  {d.penyulang.map((p) => (
                    <tr key={p.kode_penyulang} className="border-b border-line/60 last:border-0">
                      <td className="px-3 py-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: TINGKAT[p.tingkat_susut] ?? "#64748b" }} />{p.kode_penyulang} <span className="text-muted">{p.jenis}</span></td>
                      <td className="px-3 py-1.5 text-muted">{p.kode_ulp}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{Math.round(p.mwh_kirim_q3 ?? 0).toLocaleString("id-ID")}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex h-2.5 w-48 overflow-hidden rounded bg-white/5">
                            <div className="h-full bg-sky-400/80" style={{ width: `${Math.max(0, p.susut_teknis_pct) * 3.5}%` }} />
                            <div className="h-full bg-rose-500/80" style={{ width: `${Math.max(0, p.susut_non_teknis_pct) * 3.5}%` }} />
                          </div>
                          <span className="tabular-nums">{pct(p.susut_pct)}</span>
                          <span className="tabular-nums text-muted">({pct(p.susut_teknis_pct)} + {pct(p.susut_non_teknis_pct)})</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.saidi_menit ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.saifi_kali ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{p.jumlah_temuan}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{rp(p.nilai_harapan_rp ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {d && d.temuan.top.length > 0 && (
          <section className="space-y-2">
            <Title n={3} title="Antrean temuan — urut nilai harapan" sub="Bukan urut skor: sedikit kasus pelanggan TM dan lembaga bernilai jauh lebih besar dari banyak kasus rumah tangga (lihat benchmark: Massaferro 2020, Enel/C3). Klik untuk membuka objek." />
            <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
              <div className="overflow-x-auto rounded-xl border border-line bg-panel">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr className="border-b border-line">
                      <th className="px-3 py-2 font-medium">Temuan</th><th className="px-3 py-2 font-medium">Objek</th><th className="px-3 py-2 font-medium">Pola</th>
                      <th className="px-3 py-2 font-medium">Bukti</th><th className="px-3 py-2 text-right font-medium">Nilai harapan</th><th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.temuan.top.map((t) => (
                      <tr key={t.id_temuan} className="border-b border-line/60 align-top last:border-0">
                        <td className="px-3 py-1.5">
                          <span className="mr-1 rounded px-1 text-[10px] font-semibold" style={{ background: `${PRIO[t.prioritas] ?? "#64748b"}33`, color: PRIO[t.prioritas] }}>{t.prioritas}</span>
                          {tm ? <Link href={`/ontology/${tm.id}?tab=objects`} className="hover:underline">{t.id_temuan}</Link> : t.id_temuan}
                        </td>
                        <td className="px-3 py-1.5">{t.kode_objek}<div className="text-[10px] text-muted">{t.jenis_objek} · {t.segmen !== "-" ? t.segmen : ""} {t.tegangan}</div></td>
                        <td className="px-3 py-1.5"><b>{t.kode_pola_dugaan}</b><div className="text-[10px] text-muted">{t.judul}</div></td>
                        <td className="max-w-xs px-3 py-1.5 text-[11px] text-soft">{t.bukti}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{rp(t.nilai_harapan_rp)}</td>
                        <td className="px-3 py-1.5 text-muted">{t.status_temuan}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 rounded-xl border border-line bg-panel p-3">
                <div className="text-xs font-semibold">Nilai harapan per pola dugaan</div>
                {d.temuan.per_pola.slice(0, 14).map((r) => {
                  const max = d.temuan.per_pola[0]?.nilai_harapan_rp || 1;
                  const c = r.kelompok?.startsWith("Teknis") ? "#38bdf8" : r.kelompok?.startsWith("Perlu") ? "#a3a3a3" : "#f43f5e";
                  return (
                    <div key={r.pola} className="text-[11px]">
                      <div className="flex justify-between"><span><b>{r.pola}</b> <span className="text-muted">· {r.temuan}</span></span><span className="tabular-nums text-muted">{rp(r.nilai_harapan_rp)}</span></div>
                      <div className="mt-0.5 h-1.5 rounded" style={{ width: `${Math.max(2, (100 * r.nilai_harapan_rp) / max)}%`, background: c }} />
                    </div>
                  );
                })}
                <p className="text-[10px] text-muted">Merah = non-teknis (pencurian, salah tagih), biru = teknis, abu-abu = cek meter.</p>
              </div>
            </div>
          </section>
        )}

        {d && nl.length > 0 && (
          <section className="space-y-2">
            <Title n={4} title="Memilih target P2TL: aturan, model, atau nilai?" sub="Eksperimen model NTL (Code Repository → Models): lima cara memilih 40 target per minggu, dinilai terhadap kunci pola yang ditanam di demo (tidak dipakai untuk melatih). Label P2TL bias: pelanggan TM hampir tidak pernah diperiksa." />
            <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
              <div className="overflow-x-auto rounded-xl border border-line bg-panel">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr className="border-b border-line">
                      <th className="px-3 py-2 font-medium">Strategi (k = 40)</th><th className="px-3 py-2 text-right font-medium">Presisi@40</th>
                      <th className="px-3 py-2 text-right font-medium">AUROC</th><th className="px-3 py-2 font-medium">Rp pulih per inspeksi per bulan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nl.map((r) => (
                      <tr key={r.strategi} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-1.5">{r.strategi}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{(r.presisi_at_k * 100).toFixed(0)}%</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.auroc_kunci?.toFixed(3)}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-2">
                            <div className="h-2 rounded bg-emerald-400/80" style={{ width: `${Math.max(2, (r.rp_pulih_per_inspeksi_bulan / maxRp) * 220)}px` }} />
                            <span className="tabular-nums">{rp(r.rp_pulih_per_inspeksi_bulan)}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-3 rounded-xl border border-line bg-panel p-3 text-xs">
                <div className="font-semibold">Bias label P2TL</div>
                {d.ml.bias.map((b) => (
                  <div key={b.segmen} className="flex justify-between"><span>{b.segmen}</span><span className="tabular-nums text-muted">{b.diinspeksi} diperiksa dari {b.pelanggan.toLocaleString("id-ID")} · {b.temuan} temuan</span></div>
                ))}
                <div className="font-semibold">Efektivitas P2TL Okt 2025 – Sep 2026</div>
                {d.p2tl.map((r) => (
                  <div key={r.dasar} className="flex justify-between gap-2"><span className="truncate">{r.dasar}</span><span className="shrink-0 tabular-nums text-muted">{r.temuan}/{r.pemeriksaan} ({Math.round((100 * r.temuan) / Math.max(1, r.pemeriksaan))}%)</span></div>
                ))}
                {pl && <Link href={`/ontology/${pl.id}?tab=objects`} className="block text-ocean hover:underline">Skor NTL per pelanggan di Nexus →</Link>}
              </div>
            </div>
          </section>
        )}

        {d && Object.keys(d.pipelines).length > 0 && (
          <section className="space-y-2">
            <Title n={5} title="Pipeline" sub="Setiap sumber, pembersihan, gabungan dan transform SQL seperti di Pipeline Builder, lalu output, object type yang didukung dan aplikasinya. Klik kotak untuk SQL-nya." />
            <div className="flex gap-2">
              {Object.entries(d.pipelines).map(([k, p]) => (
                <button key={k} type="button" onClick={() => setPipe(k)} className={`rounded-lg border px-3 py-1 text-xs ${pipe === k ? "border-ocean bg-ocean/15 text-ocean" : "border-line text-muted hover:text-white"}`}>{short(p.name)}</button>
              ))}
              {d.pipelines[pipe]?.id && <Link href={`/pipeline/${d.pipelines[pipe].id}`} className="ml-auto text-xs text-ocean hover:underline">Buka di Pipeline Builder →</Link>}
            </div>
            {d.pipelines[pipe] && (
              <LineageDiagram graph={d.pipelines[pipe]} rows={d.pipelines[pipe].rows} backs={d.pipelines[pipe].backs} sql={d.pipelines[pipe].sql} objectCounts={d.object_counts} />
            )}
          </section>
        )}

        {d && d.nexus.object_types.length > 0 && (
          <section className="space-y-2">
            <Title n={6} title="Nexus jaringan" sub="Object type (benda di dunia nyata), relasinya, action (keputusan) dan function (logika bersama). Klik untuk membuka di Nexus Manager." />
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
              {d.nexus.object_types.map((t) => {
                const acts = d.nexus.action_types.filter((a) => a.object_type_id === t.id);
                const out = d.nexus.link_types.filter((l) => l.source === t.id).length;
                return (
                  <Link key={t.id} href={`/ontology/${t.id}`} className="rounded-xl border border-line bg-panel p-3 text-xs hover:border-ocean/60">
                    <div className="flex items-center gap-1.5 font-semibold"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: t.color ?? "#64748b" }} />{short(t.name)}</div>
                    <div className="mt-1 text-[10px] text-muted">{t.objects.toLocaleString("id-ID")} objek · {t.properties} properti · {out} relasi keluar{t.extra_datasources ? ` · +${t.extra_datasources} datasource` : ""}</div>
                    {t.dataset && <div className="text-[10px] text-ocean">▤ {t.dataset}</div>}
                    {t.time_series.length > 0 && <div className="text-[10px] text-teal-300">∿ time series: {t.time_series.join(", ")}</div>}
                    {acts.map((a) => <div key={a.id} className="mt-0.5 text-[10px] text-warn">⚡ {short(a.name)}</div>)}
                  </Link>
                );
              })}
            </div>
            <div className="rounded-xl border border-line bg-panel p-3 text-xs">
              <div className="font-semibold">Function (Fungsi Susut Jaringan Grid demo 1.0.0)</div>
              <ul className="mt-1 grid gap-1 md:grid-cols-2">
                {d.nexus.functions.map((f) => (
                  <li key={f.id}><Link href={`/functions/${encodeURIComponent(f.id)}`} className="text-ocean hover:underline">ƒ {f.name}</Link> <span className="text-muted">— {f.doc.split("\n")[0]}</span></li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={7} title="Aplikasi" sub="Tempat tim susut, tim P2TL dan tim teknik bekerja di atas Nexus yang sama." />
            <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-4">
              {([
                ["globe", "Peta susut jaringan Jabar", d.apps.map ? `/map/${d.apps.map}` : null],
                ["graph", "Vertex: topologi & susut GI Kota", d.apps.vertex.topologi ? `/vertex?graph=${d.apps.vertex.topologi}` : null],
                ["graph", "Vertex: pelanggan TM kawasan", d.apps.vertex.kawasan ? `/vertex?graph=${d.apps.vertex.kawasan}` : null],
                ["graph", "Vertex: telusuri gardu (template)", d.apps.vertex.template ? `/vertex?graph=${d.apps.vertex.template}` : null],
                ["gauge", "Kokpit susut & keandalan (Workshop)", d.apps.workshop ? `/workshop/${d.apps.workshop}` : null],
                ["clock", "Jadwal kunjungan P2TL", "/dynamic-scheduling"],
                ["device", "Device and Machinery: gardu & alur temuan", d.apps.machinery ? `/machinery?id=${d.apps.machinery}` : "/machinery"],
                ["wave", "Time series beban gardu", d.apps.syncs?.gardu ? `/time-series/${d.apps.syncs.gardu}` : "/time-series"],
                ["bell", "Object Monitors", "/object-monitors"],
                ["code", "Functions & model (Code Repositories)", "/code-repositories"],
                ["layers", "Data lineage", `/lineage?graph=${d.apps.lineage_graph}`],
                ["lock", "Tata kelola (Governance Center)", d.project_id ? `/security-governance/center?project=${d.project_id}` : "/security-governance/center"],
                ["sliders", "Foundry Rules: aturan susut analis", d.apps.analitik?.rules_workflow ? "/foundry-rules" : null],
                ["split", "Nexus Scenarios: perbaikan teknis gardu", d.apps.analitik?.scenarios ? "/ontology/scenarios" : null],
                ["wave", "Quiver: beban gardu NTL tertinggi", d.apps.analitik?.quiver?.gardu ? `/quiver/${d.apps.analitik.quiver.gardu}` : null],
                ["wave", "Quiver: pelanggan TM, CT dimanipulasi", d.apps.analitik?.quiver?.tm ? `/quiver/${d.apps.analitik.quiver.tm}` : null],
                ["filter", "Contour: susut per ULP & efektivitas P2TL", d.apps.analitik?.contour ? `/analytics/${d.apps.analitik.contour}` : null],
                ["graph", "Bluesand Orbis — Grid (tanya-jawab)", "/orbis/grid"],
                ["layers", "Arsitektur sistem end to end", "/demo-grid/arsitektur"],
              ] as [IconName, string, string | null][]).map(([icon, label, href]) => (
                href ? (
                  <Link key={label} href={href} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs hover:border-ocean/60"><Icon name={icon} className="h-4 w-4 text-ocean" />{label}</Link>
                ) : (
                  <div key={label} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-xs text-muted"><Icon name={icon} className="h-4 w-4" />{label} (belum dibangun)</div>
                )
              ))}
            </div>
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={8} title="Akses per ULP" sub="Akun demo per peran: tim P2TL hanya melihat baris ULP-nya (restricted view, kebijakan objek), analis dan operasi jaringan hanya aset, tamu meminta akses lewat Approvals." />
            <GridAksesSection />
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={9} title="AMI streaming" sub="Meter pintar (fiktif) mengirim bacaan 15 menit lewat MQTT ke broker platform; streaming sync, pipeline streaming dan time series membuatnya terbaca per meter di Nexus dalam hitungan detik." />
            <GridAmiSection />
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={10} title="Skor NTL per jam & deteksi bypass" sub="Agregasi per jam dari stream bersih dinilai model NTL (adaptor per jam atas model siklus tagihan) dan CUSUM; perubahan mendadak menjadi peristiwa dugaan bypass di Nexus dalam hitungan jam, bukan menunggu siklus tagihan." />
            <GridNtlStreamSection />
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={11} title="Sensor gardu distribusi" sub="Meter trafo per fasa dan suhu minyak semua gardu demo mengalir lewat MQTT streaming; susut teknis per jam dan risiko overload/penuaan dinilai mendekati real-time, overload menjadi rekomendasi L2 tanpa kendali SCADA." />
            <GridSensorGarduSection />
          </section>
        )}

        {d && (
          <section className="space-y-2">
            <Title n={12} title="Feedback loop P2TL" sub="Hasil pemeriksaan menjadi label latih versi berikutnya; model dilatih ulang terjadwal dan tercatat, dan hit-rate per ULP serta basis pemilihan diawasi tanpa identitas pelanggan." />
            <GridFeedbackSection />
          </section>
        )}

        {!d && !err && <p className="text-muted">Memuat…</p>}
      </div>
    </div>
  );
}
