"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { BarList, MetricWidget, Widget } from "@/components/demo/audit/Workspace";
import { AssetButton } from "./AssetDrawer";
import { api, fmt, objUrl, post, waktu, type Alarm, type AlarmList, type HistoryEntry, type Overview } from "./api";
import { DataTable, Loading, NexusLink, Pill, RISK_COLOR, SEV, SevBadge, Sources, StatusPill } from "./parts";

export type Go = (tab: string, extra?: Record<string, string>) => void;

const ASSET_KEY: Record<string, string> = { "Gardu distribusi": "gardu_distribusi", Penyulang: "penyulang", "Gardu induk": "gi" };

/* ------------------------------------------------------------------------------------------------
   Ringkasan operasi
   ------------------------------------------------------------------------------------------------ */

export function OverviewPage({ ov, alarms, go }: { ov: Overview; alarms: Alarm[]; go: Go }) {
  const s = ov.transmisi.struktural;
  const perKelas = Object.entries(ov.transmisi.per_kelas_kv).filter(([k]) => Number(k) >= 70)
    .sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => ({ key: `${k} kV`, value: v.km, note: `${fmt(v.ruas)} ruas` }));
  const statusColor: Record<string, string> = { Normal: "#22c55e", "Perlu perhatian": "#eab308", "Susut tinggi": "#f97316", "Susut NTL tinggi": "#dc2626", Overload: "#a855f7" };
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricWidget label="Alarm aktif" value={ov.alarm.aktif} caption={`${ov.alarm.per_severity.critical ?? 0} kritis · ${ov.alarm.belum_ditangani} belum ditangani`} color={ov.alarm.per_severity.critical ? "#dc2626" : "#38bdf8"} onClick={() => go("alarm")} />
        <MetricWidget label="N-1 gardu induk" value={ov.n1_gi.every((g) => g.status_n1 === "Aman N-1") ? "Aman" : "Perlu tindakan"} caption={ov.n1_gi.map((g) => `${g.kode_gi} ${fmt(g.beban_firm_puncak_pct, 0)}% firm`).join(" · ")} color={ov.n1_gi.every((g) => g.status_n1 === "Aman N-1") ? "#22c55e" : "#dc2626"} onClick={() => go("beban")} />
        <MetricWidget label="Trafo distribusi overload" value={ov.termal.dt_overload} caption={`maks ${fmt(ov.termal.dt_maks_pct, 1)}% kVA (${ov.termal.dt ?? "—"})`} color={ov.termal.dt_overload ? "#f97316" : "#22c55e"} onClick={() => go("beban")} />
        <MetricWidget label="SAIDI sistem (6 bln)" value={`${fmt(ov.keandalan.saidi, 1)} mnt`} caption={`SAIFI ${fmt(ov.keandalan.saifi, 2)} · MAIFI ${fmt(ov.keandalan.maifi, 2)} · ${ov.keandalan.periode}`} color="#38bdf8" onClick={() => go("keandalan")} />
        <MetricWidget label="Susut jaringan (Jul–Sep)" value={`${fmt(ov.susut.susut_pct, 2)}%`} caption={`teknis ${fmt(ov.susut.tl_pct, 2)}% · non-teknis ${fmt(ov.susut.ntl_pct, 2)}%`} color="#eab308" onClick={() => go("ml")} />
        <MetricWidget label="Aset risiko tinggi" value={ov.risiko.Tinggi} caption={`${ov.risiko.Sedang} sedang · ${ov.risiko.Rendah} rendah`} color="#f97316" onClick={() => go("risiko")} />
        <MetricWidget label="Koridor kritis N-1 (OSM)" value={fmt(s.kritis)} caption={`dari ${fmt(s.koridor)} koridor · ${fmt(s.mw_berisiko)} MW terisolasi bila lepas`} color="#b4123a" onClick={() => go("jaringan")} />
        <MetricWidget label="Pekerjaan lapangan" value={ov.pekerjaan.kunjungan_terjadwal} caption={`kunjungan P2TL terjadwal · ${ov.pekerjaan.perintah_terbuka} perintah terbuka`} color="#a78bfa" onClick={() => go("lapangan")} />
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Widget title="Alarm aktif teratas" caption="kritis dulu, lalu terbaru — klik untuk pusat alarm" className="xl:col-span-2" right={<button type="button" className="text-xs text-ocean" onClick={() => go("alarm")}>Pusat alarm</button>}>
          <div className="space-y-1.5">
            {alarms.slice(0, 7).map((a) => (
              <div key={a.kind + a.id} className="flex items-start gap-2 rounded border border-line px-2 py-1.5 text-xs">
                <SevBadge sev={a.severity} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{a.judul}</div>
                  <div className="truncate text-muted">{a.kategori} · {a.kode_ulp ?? "—"} · {a.waktu ? waktu(a.waktu) : "periode data"}</div>
                </div>
                <StatusPill status={a.status} />
              </div>
            ))}
            {!alarms.length && <div className="text-xs text-muted">Tidak ada alarm aktif.</div>}
          </div>
        </Widget>
        <Widget title="Alarm aktif per kategori" caption="kondisi dari pipeline + deteksi streaming AMI">
          <BarList rows={Object.entries(ov.alarm.per_kategori).map(([k, v]) => ({ key: k, value: v, color: "#64748b" }))} onPick={(k) => go("alarm", { kategori: k })} />
        </Widget>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Widget title="Kontingensi N-1 gardu induk (demo)" caption="puncak koinsiden per jam vs kapasitas firm satu trafo keluar">
          <div className="space-y-2 text-xs">
            {ov.n1_gi.map((g) => (
              <div key={g.kode_gi} className="rounded border border-line p-2">
                <div className="flex items-center justify-between"><AssetButton jenis="gi" id={g.kode_gi}>{g.nama_gi}</AssetButton><Pill text={g.status_n1} color={g.status_n1 === "Aman N-1" ? "#22c55e" : "#dc2626"} /></div>
                <div className="mt-1 h-2 overflow-hidden rounded bg-ink"><div className="h-full rounded bg-sky-500" style={{ width: `${Math.min(100, g.beban_firm_puncak_pct)}%` }} /></div>
                <div className="mt-1 text-muted">Puncak {fmt(g.puncak_mva, 1)} / firm {fmt(g.kapasitas_firm_mva)} MVA ({fmt(g.beban_firm_puncak_pct, 1)}%) · margin {fmt(g.margin_n1_mva, 1)} MVA · {g.waktu_puncak}</div>
              </div>
            ))}
          </div>
        </Widget>
        <Widget title="Status gardu distribusi (demo)" caption={`${ov.distribusi.gardu} gardu · ${fmt(ov.distribusi.pelanggan)} pelanggan · ${ov.distribusi.penyulang} penyulang`}>
          <BarList rows={Object.entries(ov.distribusi.per_status).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, value: v, color: statusColor[k] ?? "#64748b" }))} />
        </Widget>
        <Widget title="Jaringan transmisi Jawa–Bali (OSM riil)" caption={`${fmt(ov.transmisi.saluran)} ruas · ${fmt(ov.transmisi.gardu)} gardu · ${fmt(ov.transmisi.pembangkit)} pembangkit`}>
          <BarList rows={perKelas} format={(v) => `${fmt(v)} km`} />
          <p className="mt-2 text-[11px] text-muted">{fmt(s.artikulasi)} gardu titik artikulasi · {fmt(s.radial)} gardu radial (1 koridor) · {fmt(s.kritis_berdampak)} koridor kritis memutus gardu/pembangkit.</p>
        </Widget>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Widget title="Kesegaran pipeline data" caption="build terakhir tiap pipeline yang memasok cockpit" right={<button type="button" className="text-xs text-ocean" onClick={() => go("integrasi")}>Integrasi data</button>}>
          <div className="space-y-1">
            {ov.kesegaran.map((f) => (
              <div key={f.nama} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1.5 text-xs">
                {f.pipeline_id ? <Link href={`/pipeline/${f.pipeline_id}`} target="_blank" className="hover:text-white">{f.nama}</Link> : <span>{f.nama}</span>}
                <span className="flex items-center gap-2 text-muted">
                  {f.sukses_terakhir ? `sukses ${waktu(f.sukses_terakhir)}` : "—"}
                  <Pill text={f.status} color={f.status === "succeeded" ? "#22c55e" : f.status === "running" || f.status === "queued" ? "#38bdf8" : f.status === "failed" ? "#dc2626" : "#94a3b8"} />
                </span>
              </div>
            ))}
            <div className="flex justify-between rounded border border-line px-2 py-1.5 text-xs">
              <span>Simulator AMI / sensor gardu (demo)</span>
              <span className="text-muted">{fmt(ov.stream.ami.published)} / {fmt(ov.stream.sensor_gardu.published)} pesan · {ov.stream.ami.running ? "berjalan" : "berhenti"}</span>
            </div>
          </div>
        </Widget>
        <Widget title="Ketersediaan analitik" caption="jujur per domain — tidak ada angka listrik karangan untuk aset riil">
          <div className="space-y-1">
            {Object.entries(ov.ketersediaan).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 rounded border border-line px-2 py-1.5 text-xs">
                <span className="shrink-0 capitalize">{k.replace(/_/g, " ")}</span>
                <span className={`text-right ${v.startsWith("Tersedia") ? "text-emerald-300" : "text-amber-300"}`}>{v}</span>
              </div>
            ))}
          </div>
        </Widget>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
   Pusat alarm — actions Nexus
   ------------------------------------------------------------------------------------------------ */

const AKSI: { aksi: string; label: string; when: (s: string) => boolean }[] = [
  { aksi: "acknowledge", label: "Akui", when: (s) => s === "Baru" },
  { aksi: "assign", label: "Tugaskan", when: (s) => s === "Baru" || s === "Diakui" || s === "Ditugaskan" },
  { aksi: "resolve", label: "Selesaikan", when: (s) => s !== "Selesai" && s !== "Pulih" },
  { aksi: "reopen", label: "Buka ulang", when: (s) => s === "Selesai" || s === "Diakui" || s === "Pulih" },
];

export function AlarmPage({ initial, onChanged }: { initial?: { kategori?: string }; onChanged: () => void }) {
  const [data, setData] = useState<AlarmList | null>(null);
  const [f, setF] = useState({ severity: "", status: "", kategori: initial?.kategori ?? "", q: "", aktif: true });
  const [sel, setSel] = useState<Alarm | null>(null);
  const [hist, setHist] = useState<HistoryEntry[] | null>(null);
  const [form, setForm] = useState({ penugasan: "", catatan: "" });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const qs = new URLSearchParams({ ...(f.severity && { severity: f.severity }), ...(f.status && { status: f.status }), ...(f.kategori && { kategori: f.kategori }), ...(f.q && { q: f.q }), aktif: String(f.aktif) });
    setData(await api<AlarmList>(`/alarms?${qs}`));
  }, [f]);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);
  useEffect(() => {
    if (!sel) return;
    setHist(null);
    api<{ entries: HistoryEntry[] }>(`/alarms/${sel.kind}/${encodeURIComponent(sel.id)}/riwayat`).then((r) => setHist(r.entries)).catch(() => setHist([]));
  }, [sel]);
  const act = async (aksi: string) => {
    if (!sel) return;
    setBusy(aksi);
    setErr("");
    try {
      const r = await post<{ alarm: Alarm | null; riwayat: HistoryEntry[] }>(`/alarms/${sel.kind}/${encodeURIComponent(sel.id)}/aksi`, { aksi, ...form });
      if (r.alarm) setSel(r.alarm);
      setHist(r.riwayat);
      setForm({ penugasan: "", catatan: "" });
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const sel_ = "rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs";
  return (
    <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Widget title="Pusat alarm operasi" caption="alarm pipeline analitik operasi + dugaan bypass AMI streaming; status lewat actions Nexus (berriwayat)" bodyClass="flex min-h-0 flex-1 flex-col p-3" className="min-h-[520px]">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} className={sel_} aria-label="Severity">
            <option value="">Semua severity</option>{Object.entries(SEV).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={f.kategori} onChange={(e) => setF({ ...f, kategori: e.target.value })} className={sel_} aria-label="Kategori">
            <option value="">Semua kategori</option>{Object.keys(data?.counts.kategori ?? {}).map((k) => <option key={k} value={k}>{k} ({data?.counts.kategori[k]})</option>)}
          </select>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={sel_} aria-label="Status">
            <option value="">Semua status</option>{Object.keys(data?.counts.status ?? {}).map((k) => <option key={k} value={k}>{k} ({data?.counts.status[k]})</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-soft"><input type="checkbox" checked={f.aktif} onChange={(e) => setF({ ...f, aktif: e.target.checked })} /> hanya aktif</label>
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="cari aset / judul…" className={`${sel_} min-w-40 flex-1`} />
        </div>
        {!data ? <Loading text="Memuat alarm…" /> : (
          <DataTable
            name="alarm-operasi-grid"
            maxH="max-h-[60vh]"
            rows={data.events}
            onRow={(r) => setSel(r)}
            cols={[
              { key: "severity", label: "Severity", render: (r) => <SevBadge sev={r.severity} />, value: (r) => ({ critical: 0, warning: 1, info: 2 } as Record<string, number>)[r.severity] ?? 3 },
              { key: "judul", label: "Alarm", render: (r) => <div className={sel?.id === r.id ? "text-white" : ""}><div>{r.judul}</div><div className="text-muted">{r.kategori} · {r.kode_ulp ?? "—"}</div></div> },
              { key: "aset", label: "Aset", render: (r) => ASSET_KEY[r.jenis_aset] ? <AssetButton jenis={ASSET_KEY[r.jenis_aset]} id={r.aset} /> : <NexusLink r={r.aset_ref}>{r.aset}</NexusLink> },
              { key: "waktu", label: "Waktu", render: (r) => <span className="whitespace-nowrap text-muted">{r.waktu ? waktu(r.waktu) : "periode data"}</span> },
              { key: "status", label: "Status", render: (r) => <div><StatusPill status={r.status} />{r.penugasan && <div className="mt-0.5 text-muted">→ {r.penugasan}</div>}</div> },
            ]}
          />
        )}
        <Sources items={data?.sumber} note="Alarm = kondisi di keluaran pipeline (beban, tegangan, N-1, termal, gangguan besar, temuan P1/P2) + peristiwa AMI streaming. Cockpit tidak mengeksekusi switching." />
      </Widget>
      <Widget title={sel ? "Tindak lanjut alarm" : "Pilih alarm"} caption={sel ? `${sel.kind === "alarm" ? "Alarm Operasi Grid" : "Peristiwa AMI"} · ${sel.id}` : "klik baris di kiri"} bodyClass="p-3 text-xs">
        {!sel ? <p className="text-muted">Pilih alarm untuk melihat bukti, rekomendasi, dan riwayat; akui, tugaskan, atau selesaikan lewat action Nexus.</p> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2"><SevBadge sev={sel.severity} /><StatusPill status={sel.status} />{sel.type_id && <Link href={objUrl({ type_id: sel.type_id, pk: sel.id })!} target="_blank" className="ml-auto inline-flex items-center gap-1 text-ocean hover:underline"><Icon name="cube" className="h-3.5 w-3.5" /> Objek Nexus</Link>}</div>
            <div className="text-sm font-medium">{sel.judul}</div>
            <div className="rounded bg-ink p-2"><div className="text-muted">Bukti</div>{sel.detail || "—"}</div>
            {sel.nilai != null && <div className="text-muted">Nilai {fmt(sel.nilai, 2)} {sel.satuan}{sel.ambang != null ? ` · ambang ${fmt(sel.ambang, 1)}` : ""}</div>}
            <div className="rounded border border-line p-2"><span className="text-muted">Rekomendasi: </span>{sel.rekomendasi}</div>
            <div className="text-muted">Sumber: {sel.sumber}</div>
            {sel.catatan && <div className="text-muted">Catatan terakhir: {sel.catatan}</div>}
            <div className="space-y-1.5 rounded-lg border border-line p-2">
              <input value={form.penugasan} onChange={(e) => setForm({ ...form, penugasan: e.target.value })} placeholder="ditugaskan ke (tim/petugas)…" className="w-full rounded border border-line bg-transparent px-2 py-1" />
              <input value={form.catatan} onChange={(e) => setForm({ ...form, catatan: e.target.value })} placeholder="catatan operator…" className="w-full rounded border border-line bg-transparent px-2 py-1" />
              <div className="flex flex-wrap gap-1">
                {AKSI.filter((a) => a.when(sel.status)).map((a) => (
                  <button key={a.aksi} type="button" disabled={!!busy} onClick={() => act(a.aksi)} className="rounded border border-line-2 px-2.5 py-1 hover:border-ocean hover:text-white disabled:opacity-50">
                    {busy === a.aksi ? "…" : a.label}
                  </button>
                ))}
              </div>
              {err && <p className="text-bad">{err}</p>}
              <p className="text-[10px] text-muted">Tiap tombol menjalankan action Nexus pada objek alarm (izin & aturan action berlaku); siapa dan kapan tercatat di riwayat edit objek.</p>
            </div>
            <div>
              <div className="mb-1 font-medium">Riwayat edit (Nexus)</div>
              {hist == null ? <span className="text-muted">Memuat…</span> : !hist.length ? <span className="text-muted">Belum ada perubahan.</span> : (
                <ol className="space-y-1">
                  {hist.map((h, i) => (
                    <li key={i} className="rounded border border-line px-2 py-1">
                      <div className="text-muted">{waktu(h.at)} · {h.user_name ?? h.user ?? "pengguna"} · {h.op ?? "edit"}</div>
                      <div>{changeText(h.changes)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Widget>
    </div>
  );
}

/** {prop: [before, after]} → "status_alarm: Baru → Diakui · …" */
export function changeText(changes?: Record<string, unknown>) {
  return Object.entries(changes ?? {})
    .map(([k, v]) => (Array.isArray(v) && v.length === 2 ? `${k.replace(/_/g, " ")}: ${String(v[0] ?? "—")} → ${String(v[1] ?? "—")}` : `${k}: ${String(v)}`))
    .join(" · ");
}

export { RISK_COLOR };
