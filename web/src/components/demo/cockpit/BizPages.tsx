"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/demo/audit/FacilityFile";
import { BarList, MetricWidget, Widget } from "@/components/demo/audit/Workspace";
import { API_URL } from "@/lib/api";
import { AssetButton } from "./AssetDrawer";
import { api, fmt, lineageUrl, post, rp, typeUrl, waktu, type AmiData, type Field, type Integrasi, type PartSide, type LossData, type MlData, type NtlData, type Overview } from "./api";
import { changeText, type Go } from "./OpsPages";
import { DataTable, Loading, NexusLink, Pill, Sources } from "./parts";

/* ------------------------------------------------------------------------------------------------
   Loss Intelligence — TL (fisika) vs NTL (residu + ML)
   ------------------------------------------------------------------------------------------------ */

export function LossPage({ go }: { go: Go }) {
  const [loss, setLoss] = useState<LossData | null>(null);
  const [ml, setMl] = useState<MlData | null>(null);
  const [ntl, setNtl] = useState<NtlData | null>(null);
  const [ami, setAmi] = useState<AmiData | null>(null);
  useEffect(() => {
    api<AmiData>("/ami").then(setAmi).catch(() => {});
    api<LossData>("/loss").then(setLoss).catch(() => {});
    fetch(`${API_URL}/api/demo/grid/e2e/overview`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((r) => r && setMl(r.ml)).catch(() => {});
    fetch(`${API_URL}/api/demo/grid/ntl`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((r) => r && setNtl(r)).catch(() => {});
  }, []);
  const metrik = (k: string) => { const a = ml?.metrics[k]; return a && a.length ? a[a.length - 1].value : null; };
  const s40 = (ml?.strategi ?? []).filter((s) => s.k === 40);
  const best = s40.length ? Math.max(...s40.map((s) => s.presisi_at_k)) : null;
  if (!loss) return <Loading text="Memuat neraca energi…" />;
  return (
    <div className="flex flex-1 flex-col gap-3">
      {loss.tersedia && loss.total ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricWidget label="Susut total (Jul–Sep)" value={`${loss.total.susut_pct}%`} caption={`${fmt(loss.total.mwh_kirim_q3)} MWh dikirim`} color="#38bdf8" />
            <MetricWidget label="Susut teknis (dihitung)" value={`${loss.total.tl_pct}%`} caption="fisika I²R + rugi trafo" color="#2dd4bf" />
            <MetricWidget label="Susut non-teknis" value={`${loss.total.ntl_pct}%`} caption="residu neraca + skor ML — petunjuk, bukan vonis" color="#f97316" />
            <MetricWidget label="Nilai susut 3 bulan" value={rp(loss.total.nilai_susut_rp_q3)} caption={`nilai harapan temuan ${rp(loss.total.nilai_harapan_rp)}`} color="#eab308" />
            <MetricWidget label="Temuan P1" value={loss.total.temuan_p1} caption="temuan → kunjungan P2TL → perintah" color="#dc2626" onClick={() => go("lapangan")} />
          </div>
          <div className="grid gap-3 xl:grid-cols-3">
            <Widget title="Komponen susut teknis (3 bulan)" caption="kWh per komponen — dihitung, bukan diukur SCADA">
              <BarList rows={(loss.komponen_tl ?? []).map((k) => ({ key: k.komponen, value: k.kwh, color: "#2dd4bf" }))} format={(v) => `${fmt(v)} kWh`} />
              <p className="mt-2 text-[11px] text-muted">{loss.metode?.teknis}</p>
            </Widget>
            <Widget title="Tren bulanan: teknis vs non-teknis" caption="% energi dikirim — legenda: hijau toska teknis, oranye non-teknis">
              <div className="space-y-1.5">
                {(loss.tren ?? []).map((t) => (
                  <div key={t.bulan} className="grid grid-cols-[3.4rem_1fr_auto] items-center gap-2 text-xs">
                    <span className="text-muted">{t.bulan}</span>
                    <span className="flex h-4 gap-0.5 overflow-hidden rounded bg-ink" title={`TL ${t.tl_pct}% · NTL ${t.ntl_pct}%`}>
                      <span className="rounded-l" style={{ width: `${Math.min(100, t.tl_pct * 3)}%`, background: "#2dd4bf" }} />
                      <span className="rounded-r" style={{ width: `${Math.min(100, t.ntl_pct * 3)}%`, background: "#f97316" }} />
                    </span>
                    <span className="tabular-nums text-muted">TL {t.tl_pct}% · NTL {t.ntl_pct}%</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted">{loss.metode?.terukur} {loss.metode?.transmisi}</p>
            </Widget>
            <Widget title="Susut per ULP" caption="Jul–Sep — dari objek Penyulang & Temuan sesuai akses akun">
              <div className="space-y-1">
                {(loss.per_ulp ?? []).map((u) => (
                  <div key={u.kode_ulp} className="rounded border border-line px-2 py-1.5 text-xs">
                    <div className="flex justify-between"><b>{u.kode_ulp}</b><span className="text-muted">total {u.susut_pct}%</span></div>
                    <div className="text-muted">teknis {u.susut_teknis_pct}% · non-teknis {u.susut_non_teknis_pct}% · {fmt(u.mwh_kirim_q3)} MWh · P1 {u.temuan_p1} · {rp(u.nilai_harapan_rp)}</div>
                  </div>
                ))}
              </div>
            </Widget>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <Widget title="Hotspot susut teknis per penyulang" caption="3 bulan terakhir" bodyClass="p-3">
              <DataTable name="hotspot-tl-penyulang" rows={loss.hotspot_penyulang ?? []} maxH="max-h-72" cols={[
                { key: "kode", label: "Penyulang", render: (h) => <AssetButton jenis="penyulang" id={h.kode} /> }, { key: "ulp", label: "ULP" },
                { key: "tl_kwh", label: "TL kWh", align: "right", render: (h) => fmt(h.tl_kwh) }, { key: "tl_pct", label: "TL %", align: "right" }, { key: "ntl_pct", label: "NTL %", align: "right" }]} />
            </Widget>
            <Widget title="Hotspot susut teknis per gardu distribusi" caption="TL besar + hari overload → prioritas inspeksi trafo" bodyClass="p-3">
              <DataTable name="hotspot-tl-gardu" rows={loss.hotspot_gardu ?? []} maxH="max-h-72" cols={[
                { key: "kode", label: "Gardu", render: (h) => <AssetButton jenis="gardu_distribusi" id={h.kode} /> }, { key: "penyulang", label: "Penyulang" },
                { key: "tl_kwh", label: "TL kWh", align: "right", render: (h) => fmt(h.tl_kwh) }, { key: "tl_pct", label: "TL %", align: "right" }, { key: "hari_overload", label: "Hari overload", align: "right" }]} />
            </Widget>
          </div>
          <Sources items={loss.sumber} note={loss.metode?.non_teknis} />
        </>
      ) : <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">Susut belum tampil: {loss.alasan}</p>}
      <h3 className="pt-1 text-sm font-semibold">Deteksi NTL berbasis ML <span className="text-xs font-normal text-muted">— skor terjelaskan; status investigasi mengikuti kunjungan P2TL</span></h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricWidget label="AUROC kunci gabungan" value={metrik("auroc/kunci_gabungan")?.toFixed(3) ?? "—"} caption="evaluasi vs kunci jawaban (bukan input model)" color="#a78bfa" />
        <MetricWidget label="AUROC label P2TL (CV5)" value={metrik("auroc/label_p2tl_cv5")?.toFixed(3) ?? "—"} caption="jujur pada label inspeksi" color="#38bdf8" />
        <MetricWidget label="Presisi@40 terbaik" value={best != null ? best.toFixed(3) : "—"} caption="strategi pemilihan target" color="#22c55e" />
        <MetricWidget label="Dugaan bypass streaming" value={ntl?.deteksi.dugaan ?? "—"} caption={`${ntl?.peristiwa_total ?? 0} peristiwa AMI`} color="#f97316" onClick={() => go("alarm", { kategori: "AMI streaming" })} />
        <MetricWidget label="Target prioritas ML" value={ml?.target.length ?? "—"} caption="potensi pemulihan terbesar" color="#eab308" />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Widget title="Strategi pemilihan target inspeksi (k=40)" caption="presisi@k pada kunci gabungan">
          <BarList rows={s40.map((s) => ({ key: s.strategi, value: Math.round(s.presisi_at_k * 1000), note: `pulih ${rp(s.rp_pulih_per_inspeksi_bulan)}/insp/bln`, color: "#22c55e" }))} format={(v) => (v / 1000).toFixed(3)} />
          {!s40.length && <p className="text-xs text-muted">{ml ? "Tidak ada strategi k=40." : "Memuat hasil model…"}</p>}
        </Widget>
        <Widget title="Deteksi bypass per jam (stream AMI)" caption="CUSUM atas skor per jam — target latensi < 3 jam">
          <div className="space-y-1">
            {(ntl?.deteksi.latensi ?? []).map((l) => (
              <div key={l.kejadian} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1.5 text-xs">
                <span>{l.kejadian} · meter {l.no_meter} <span className="text-muted">{l.pola} · mulai {l.mulai_wib} WIB</span></span>
                <Pill text={`${l.latensi_jam} jam`} color={l.latensi_jam < 3 ? "#22c55e" : "#dc2626"} />
              </div>
            ))}
            <p className="pt-1 text-[11px] text-muted">{fmt(ntl?.deteksi.bacaan)} bacaan · {fmt(ntl?.deteksi.meter_jam)} meter-jam · false positive {ntl?.deteksi.false_positive ?? "—"} meter.</p>
          </div>
        </Widget>
      </div>
      {ami?.tersedia && <AmiSection a={ami} />}
      <Widget title="Target prioritas ML (skor NTL per pelanggan)" caption="kunci=1 berarti terbukti pada data evaluasi — bukan input model">
        <div className="grid gap-1 md:grid-cols-2">
          {(ml?.target ?? []).slice(0, 16).map((t) => (
            <div key={t.id_pelanggan} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1.5 text-xs">
              <span>{t.id_pelanggan} <span className="text-muted">{t.segmen}</span></span>
              <span className="flex items-center gap-2 text-muted">skor {t.skor_ntl.toFixed(3)} · {rp(t.potensi_rp_bulan)}/bln {t.kunci ? <Badge text="kunci" color="#22c55e" /> : null}</span>
            </div>
          ))}
        </div>
      </Widget>
    </div>
  );
}

const AMI_STATUS: Record<string, string> = { Healthy: "#22c55e", Check: "#f97316", "Not reporting": "#dc2626", Normal: "#22c55e", Watch: "#eab308", Anomaly: "#dc2626" };

/** AMI streaming → Nexus: meter health (from ami_bersih) and substation hourly balance (from neraca_gardu_jam). */
function AmiSection({ a }: { a: AmiData }) {
  const st = a.status ?? {};
  const maxKwh = Math.max(1, ...(a.tren_jam ?? []).map((t) => t.kwh));
  return (
    <>
      <h3 className="pt-1 text-sm font-semibold">AMI streaming di Nexus <span className="text-xs font-normal text-muted">— stream bersih 15 menit → kesehatan meter; neraca gardu per jam → status jam</span></h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricWidget label="Meter AMI pilot" value={a.meter ?? 0} caption={`PF rata-rata ${a.pf_rata ?? "—"}`} color="#0ea5e9" />
        <MetricWidget label="Sehat" value={st.Healthy ?? 0} caption="semua cek dalam batas" color="#22c55e" />
        <MetricWidget label="Perlu dicek" value={st.Check ?? 0} caption="tegangan, PF, fasa, tamper, kualitas" color="#f97316" />
        <MetricWidget label="Tidak melapor" value={st["Not reporting"] ?? 0} caption="tanpa bacaan > 2 jam" color="#dc2626" />
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Widget title="Meter yang perlu dicek" caption="objek Grid AMI Meter Health" bodyClass="p-3">
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {(a.perlu_dicek ?? []).map((m) => (
              <div key={m.no_meter} className="rounded border border-line px-2 py-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <NexusLink r={m.ref}>{m.no_meter}</NexusLink>
                  <Pill text={m.status} color={AMI_STATUS[m.status] ?? "#94a3b8"} />
                </div>
                <div className="text-muted">{m.kode_dt} · {m.kode_ulp} · {m.alasan}</div>
              </div>
            ))}
            {!(a.perlu_dicek ?? []).length && <p className="text-xs text-muted">Semua meter sehat.</p>}
          </div>
        </Widget>
        <Widget title={`Gardu pada jam ${a.jam_terakhir ?? "—"} WIB`} caption="porsi meter kWh sangat rendah — objek Grid Substation Hourly Balance" bodyClass="p-3">
          <DataTable name="ami-gardu-jam" rows={a.gardu_jam_terakhir ?? []} maxH="max-h-72" cols={[
            { key: "kode_dt", label: "Gardu", render: (h) => <NexusLink r={h.ref}>{h.kode_dt}</NexusLink> },
            { key: "kwh", label: "kWh", align: "right", render: (h) => fmt(h.kwh) },
            { key: "porsi", label: "Rendah %", align: "right", render: (h) => `${h.porsi ?? "—"}% (${h.rendah}/${h.aktif})` },
            { key: "status", label: "Status", render: (h) => <Pill text={h.status} color={AMI_STATUS[h.status] ?? "#94a3b8"} /> }]} />
        </Widget>
        <Widget title="kWh pilot per jam (24 jam terakhir)" caption="batang merah = ada gardu berstatus Anomaly">
          <div className="flex h-40 items-end gap-0.5">
            {(a.tren_jam ?? []).map((t) => (
              <span key={t.jam} title={`${t.jam} · ${fmt(t.kwh)} kWh · ${t.anomali} gardu anomaly`} className="flex-1 rounded-t"
                style={{ height: `${Math.max(2, (t.kwh / maxKwh) * 100)}%`, background: t.anomali ? "#dc2626" : "#0ea5e9" }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted"><span>{a.tren_jam?.[0]?.jam}</span><span>{a.tren_jam?.at(-1)?.jam}</span></div>
        </Widget>
      </div>
      <Sources items={a.sumber} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
   Operasi lapangan — status perintah kerja lewat action Nexus
   ------------------------------------------------------------------------------------------------ */

export function FieldPage() {
  const [f, setF] = useState<Field | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => api<Field>("/field").then(setF).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const ubah = async (id: string, status: string) => {
    setBusy(id + status);
    setErr("");
    try {
      await post(`/work-orders/${encodeURIComponent(id)}/status`, { status });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  if (!f) return <Loading text="Memuat operasi lapangan…" />;
  return (
    <div className="flex flex-1 flex-col gap-3">
      {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Widget title="Perintah kerja teknis" caption="status lewat action Nexus “Ubah status perintah kerja (demo)” — riwayat per objek">
          <div className="space-y-2">
            {f.perintah_kerja.map((r) => (
              <div key={r.id} className="rounded border border-line p-2 text-xs">
                <div className="flex items-start justify-between gap-2"><NexusLink r={r.ref}>{r.id_perintah ?? r.id}</NexusLink><Pill text={r.status_pekerjaan ?? "—"} color={r.status_pekerjaan === "Selesai" ? "#22c55e" : r.status_pekerjaan === "Dikerjakan" ? "#38bdf8" : "#eab308"} /></div>
                <div className="mt-0.5">{r.judul}</div>
                <div className="text-muted">{r.jenis_pekerjaan} · gardu <AssetButton jenis="gardu_distribusi" id={r.kode_dt} /> · target {r.tanggal_target ?? "—"}</div>
                <div className="mt-1 text-muted">{r.uraian}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {["Dikerjakan", "Ditunda", "Selesai", "Terbuka"].filter((s) => s !== r.status_pekerjaan).map((s) => (
                    <button key={s} type="button" disabled={!!busy} onClick={() => ubah(r.id, s)} className="rounded border border-line-2 px-2 py-0.5 hover:border-ocean hover:text-white disabled:opacity-50">{busy === r.id + s ? "…" : s}</button>
                  ))}
                </div>
                {!!r.riwayat.length && (
                  <ol className="mt-1.5 space-y-0.5 border-t border-line/50 pt-1 text-[11px] text-muted">
                    {r.riwayat.map((h, i) => <li key={i}>{waktu(h.at)} · {h.user_name ?? h.user} · {changeText(h.changes)}</li>)}
                  </ol>
                )}
              </div>
            ))}
            {!f.perintah_kerja.length && <p className="text-xs text-muted">Belum ada perintah kerja yang terlihat oleh akun ini.</p>}
          </div>
          <p className="mt-2 text-[11px] text-muted">{f.catatan}</p>
        </Widget>
        <Widget title="Kunjungan P2TL terjadwal" caption={`${f.kunjungan.length} kunjungan — jadwal Dynamic Scheduling`} bodyClass="p-3">
          <DataTable name="kunjungan-p2tl" rows={f.kunjungan} maxH="max-h-96" cols={[
            { key: "id_kunjungan", label: "Kunjungan", render: (r) => <NexusLink r={r.ref}>{r.id_kunjungan}</NexusLink> },
            { key: "mulai", label: "Mulai", render: (r) => <span className="whitespace-nowrap">{waktu(r.mulai)}</span> },
            { key: "kode_tim", label: "Tim" },
            { key: "prioritas", label: "Prioritas", render: (r) => <Pill text={r.prioritas} color={r.prioritas === "P1" ? "#dc2626" : "#f97316"} /> },
            { key: "pola_dugaan", label: "Pola" },
            { key: "nilai_harapan_rp", label: "Nilai harapan", align: "right", render: (r) => rp(r.nilai_harapan_rp) },
            { key: "kode_dt", label: "Gardu", render: (r) => <AssetButton jenis="gardu_distribusi" id={r.kode_dt} /> },
            { key: "status_kunjungan", label: "Status" },
          ]} />
        </Widget>
      </div>
      <Widget title="Berita acara P2TL terbaru" caption="label model NTL (feedback loop)" bodyClass="p-3">
        <DataTable name="inspeksi-p2tl" rows={f.inspeksi} maxH="max-h-80" cols={[
          { key: "no_ba", label: "No. BA", render: (r) => <NexusLink r={r.ref}>{r.no_ba}</NexusLink> },
          { key: "tanggal", label: "Tanggal" }, { key: "id_pelanggan", label: "Pelanggan" }, { key: "dasar_pemilihan", label: "Dasar pemilihan" },
          { key: "golongan", label: "Hasil", render: (r) => <Pill text={r.golongan} color={r.ditemukan_pelanggaran ? "#dc2626" : "#22c55e"} /> },
          { key: "rp_tagihan_susulan", label: "Tagihan susulan", align: "right", render: (r) => rp(r.rp_tagihan_susulan) }, { key: "tim", label: "Tim" },
        ]} />
        <Sources items={f.sumber} />
      </Widget>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
   Integrasi data: pipeline → dataset → Nexus → aplikasi
   ------------------------------------------------------------------------------------------------ */

const STATUS_COLOR: Record<string, string> = { succeeded: "#22c55e", running: "#38bdf8", queued: "#38bdf8", failed: "#dc2626" };
const CARD: Record<string, string> = { one_to_one: "1 : 1", many_to_one: "N : 1", many_to_many: "M : N" };

export function IntegrationPage() {
  const [d, setD] = useState<Integrasi | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<Integrasi>("/integrasi").then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!d) return <Loading text="Memuat peta integrasi…" />;
  const names = Object.fromEntries(d.nexus.map((n) => [n.key, n.nama]));
  const grup: [string, string][] = [["operasi", "Analitik operasi (cockpit)"], ["distribusi", "Jaringan distribusi & susut (demo)"], ["osm", "Transmisi Jawa–Bali (OSM riil)"]];
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Link href={`/lineage?graph=${d.aplikasi.lineage_graph}`} target="_blank" className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 font-medium text-white"><Icon name="split" className="h-3.5 w-3.5" /> Lineage cockpit operasi</Link>
        <Link href={`/lineage?graph=${d.aplikasi.lineage_grid}`} target="_blank" className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"><Icon name="split" className="h-3.5 w-3.5" /> Lineage susut grid</Link>
        {d.aplikasi.peta_gabungan && <Link href={`/map/${d.aplikasi.peta_gabungan}`} target="_blank" className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"><Icon name="globe" className="h-3.5 w-3.5" /> Peta Jawa–Bali</Link>}
        {d.aplikasi.peta_susut && <Link href={`/map/${d.aplikasi.peta_susut}`} target="_blank" className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"><Icon name="globe" className="h-3.5 w-3.5" /> Peta susut & risiko gardu</Link>}
        {d.aplikasi.workshop && <Link href={`/workshop/${d.aplikasi.workshop}`} target="_blank" className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"><Icon name="table" className="h-3.5 w-3.5" /> Kokpit Workshop</Link>}
        <Link href={d.aplikasi.orbis} target="_blank" className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 text-soft hover:text-white"><Icon name="sparkle" className="h-3.5 w-3.5" /> Orbis Grid</Link>
        <span className="ml-auto self-center text-muted">langkah operasi dibangun {waktu(d.dibangun)}</span>
      </div>
      <Widget title="1 · Pipeline & transform" caption="sumber → transformasi → dataset keluaran (versi, baris, kesegaran) — klik untuk Pipeline Builder / lineage">
        <div className="grid gap-2 lg:grid-cols-2">
          {[...d.pipeline].reverse().map((p) => (
            <div key={p.key} className={`rounded-lg border p-2 text-xs ${p.key === "operasi" ? "border-ocean/60 bg-ocean/5" : "border-line"}`}>
              <div className="flex items-center justify-between gap-2">
                {p.pipeline_id ? <Link href={`/pipeline/${p.pipeline_id}`} target="_blank" className="font-medium hover:text-white">{p.nama}</Link> : <span className="font-medium">{p.nama}</span>}
                <span className="flex items-center gap-1.5"><Pill text={p.tipe} color="#64748b" /><Pill text={p.build?.status ?? "belum dibangun"} color={STATUS_COLOR[p.build?.status ?? ""] ?? "#94a3b8"} /></span>
              </div>
              <div className="mt-0.5 text-muted">build terakhir {waktu(p.build?.at)} · {p.build?.trigger ?? "—"}{p.build?.last_success ? ` · sukses ${waktu(p.build.last_success)}` : ""}{p.lineage && <> · <Link href={lineageUrl(p.lineage)!} target="_blank" className="text-ocean">lineage</Link></>}</div>
              {p.build?.error && <div className="mt-0.5 text-bad">{p.build.error}</div>}
              {!!p.sumber.length && <div className="mt-1 text-muted">Sumber: {p.sumber.map((s) => s.nama).join(", ")}</div>}
              {!!p.output.length && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.output.map((o) => (
                    <Link key={o.nama} href={o.dataset_id ? `/datasets/${o.dataset_id}` : "#"} target="_blank" className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-[10px] text-soft hover:text-white" title={`v${o.versi ?? "?"} · ${o.baris ?? "?"} baris · diperbarui ${o.diperbarui ?? "—"}`}>
                      {o.nama} <span className="text-muted">{o.baris != null ? `· ${fmt(o.baris)}` : ""}{o.versi != null ? ` · v${o.versi}` : ""}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="rounded-lg border border-ocean/60 bg-ocean/5 p-2 text-xs">
            <div className="flex items-center justify-between">
              {d.transform.repo_id ? <Link href={`/code-repositories/${d.transform.repo_id}`} target="_blank" className="font-medium hover:text-white">{d.transform.nama} · {d.transform.transform}</Link> : <span>{d.transform.nama}</span>}
              <Pill text={d.transform.build?.status ?? d.transform.status ?? "—"} color={STATUS_COLOR[d.transform.build?.status ?? d.transform.status ?? ""] ?? "#94a3b8"} />
            </div>
            <div className="mt-0.5 text-muted">Transform Python Code Repository · build {waktu(d.transform.build?.at)} · sumber {d.transform.sumber.map((s) => s.nama).join(", ")}</div>
            <div className="mt-1 flex flex-wrap gap-1">{d.transform.output.map((o) => <Link key={o.nama} href={`/datasets/${o.dataset_id}`} target="_blank" className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-[10px] text-soft hover:text-white">{o.nama}</Link>)}</div>
          </div>
        </div>
      </Widget>
      <Widget title="2 · Nexus — object type, relasi, actions, keamanan" caption="objek terlihat = sesuai penanda & kebijakan baris akun Anda">
        <div className="grid gap-3 xl:grid-cols-3">
          {grup.map(([g, label]) => (
            <div key={g}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
              <div className="space-y-1">
                {d.nexus.filter((n) => n.grup === g).map((n) => (
                  <div key={n.key} className="rounded border border-line bg-[#10151f] p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={typeUrl(n.type_id)!} target="_blank" className="flex min-w-0 items-center gap-1.5 font-medium hover:text-white"><Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-violet-300" /><span className="truncate">{n.nama}</span></Link>
                      <span className="shrink-0 tabular-nums text-soft">{fmt(n.objek_terlihat)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted">
                      <span>{n.properti} properti</span><span>{n.tautan} relasi</span>
                      {n.riwayat && <span className="text-emerald-300">riwayat edit</span>}
                      {n.kebijakan_baris && <span className="text-sky-300">baris per ULP</span>}
                      <Link href={lineageUrl(n.lineage)!} target="_blank" className="text-ocean">lineage</Link>
                      {n.dataset_id && <Link href={`/datasets/${n.dataset_id}`} target="_blank" className="text-ocean">dataset</Link>}
                    </div>
                    {!!n.actions.length && <div className="mt-0.5 text-[10px] text-violet-200">⚡ {n.actions.map((a) => a.nama.replace(" (demo)", "")).join(" · ")}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Widget>
      <Widget title="3 · Relasi Nexus antar object type" caption="kardinalitas link type: 1 : 1, N : 1 (dari sisi target: satu-ke-banyak), M : N (join table)" bodyClass="p-3">
        <DataTable name="relasi-nexus-grid" rows={d.relasi} maxH="max-h-80" cols={[
          { key: "dari", label: "Dari", render: (r) => names[r.dari] ?? r.dari },
          { key: "kardinalitas", label: "Kardinalitas", render: (r) => <Pill text={CARD[r.kardinalitas] ?? r.kardinalitas} color={r.kardinalitas === "many_to_many" ? "#a78bfa" : r.kardinalitas === "one_to_one" ? "#38bdf8" : "#94a3b8"} /> },
          { key: "ke", label: "Ke", render: (r) => names[r.ke] ?? r.ke },
          { key: "p_dari", label: "Partisipasi dari", value: (r) => r.partisipasi?.source.pct ?? -1, render: (r) => <Participation s={r.partisipasi?.source} /> },
          { key: "p_ke", label: "Partisipasi ke", value: (r) => r.partisipasi?.target.pct ?? -1, render: (r) => <Participation s={r.partisipasi?.target} /> },
          { key: "nama", label: "Link type" },
          { key: "jenis", label: "Jenis", render: (r) => `${r.jenis?.replace("_", " ") ?? "—"}${r.kunci ? ` · ${r.kunci}` : ""}` },
        ]} />
        <p className="mt-2 text-[11px] text-muted">Partisipasi total = setiap objek di sisi itu punya pasangan (atau kunci asingnya wajib). Di Data Lineage relasi ini digambar gaya ERD: belah ketupat di tengah, kardinalitas 1/N/M di tiap ujung, garis ganda di sisi berpartisipasi total.</p>
      </Widget>
    </div>
  );
}

function Participation({ s }: { s?: PartSide }) {
  if (!s) return <span className="text-muted">—</span>;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Pill text={s.total ? "total" : "parsial"} color={s.total ? "#a78bfa" : "#94a3b8"} />
      <span className="tabular-nums text-muted">{fmt(s.linked)}/{fmt(s.objects)}{s.required ? " · wajib" : ""}</span>
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------
   Keamanan & tata kelola
   ------------------------------------------------------------------------------------------------ */

export function GovernancePage({ ov }: { ov: Overview | null }) {
  return (
    <div className="grid flex-1 gap-3 xl:grid-cols-3">
      <Widget title="Mode & batas keselamatan">
        <div className="space-y-1.5 text-xs">
          <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-amber-200">{ov?.mode ?? "Mode demonstrasi"}</div>
          <div className="rounded border border-line p-2">Read-only ke SCADA: tidak ada switching, isolasi, atau izin kerja yang dieksekusi dari cockpit; rekomendasi bersifat L2 (saran) untuk personel berwenang.</div>
          <div className="rounded border border-line p-2">Semua penulisan lewat actions Nexus (akui/tugaskan/selesaikan alarm, status peristiwa AMI, status perintah kerja): izin & aturan action berlaku, riwayat edit mencatat siapa & kapan.</div>
          <div className="rounded border border-line p-2">Objek dibaca sebagai akun Anda: penanda (PII, CEII, Investigasi), kebijakan baris per ULP, dan kebijakan properti menentukan angka yang tampil — dua akun bisa melihat angka berbeda.</div>
        </div>
      </Widget>
      <Widget title="Kontrol platform terkait">
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          {[["/enterprise-security", "Enterprise Security — peran & akses"], ["/cipher", "Cipher — pseudonim PII pelanggan"], ["/lineage?graph=gridoperasi", "Data Lineage — cockpit operasi"],
            ["/restricted-views", "Restricted Views — data per ULP"], ["/object-monitors", "Object Monitors — peristiwa AMI"], ["/object-edits", "Object Edits — riwayat perubahan"],
            ["/checkpoints", "Checkpoints — alasan akses sensitif"], ["/demo-grid/arsitektur", "Arsitektur demo grid"]].map(([h, l]) => (
            <Link key={h} href={h} target="_blank" className="rounded border border-line p-2 hover:bg-white/5">{l}</Link>
          ))}
        </div>
      </Widget>
      <Widget title="Ketersediaan & provenance">
        <div className="space-y-1">
          {Object.entries(ov?.ketersediaan ?? {}).map(([k, v]) => (
            <div key={k} className="rounded border border-line px-2 py-1.5 text-xs"><div className="capitalize">{k.replace(/_/g, " ")}</div><div className={v.startsWith("Tersedia") ? "text-emerald-300" : "text-amber-300"}>{v}</div></div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted">Aset transmisi: OpenStreetMap (ODbL), tanpa angka listrik karangan. Distribusi & telemetri: simulasi berlabel demo.</p>
      </Widget>
    </div>
  );
}
