"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TsChart } from "@/components/timeseries/TsChart";
import { BarList, MetricWidget, Widget } from "@/components/demo/audit/Workspace";
import { AssetButton, useOpenAsset } from "./AssetDrawer";
import { api, fmt, waktu, type AssetRow, type Beban, type BebanPenyulang, type Keandalan, type Kontingensi, type Koridor, type Outage, type OutageDetail, type Risiko } from "./api";
import { Bars, DataTable, Loading, Meter, NexusLink, Pill, RISK_COLOR, Sources, Unavailable } from "./parts";

const KV_COLOR: Record<string, string> = { "500": "#b4123a", "150": "#d97706", "70": "#0f766e" };

/* ------------------------------------------------------------------------------------------------
   Jaringan & topologi: peta, N-1 struktural transmisi (OSM riil), pencarian aset
   ------------------------------------------------------------------------------------------------ */

export function NetworkPage({ mapId }: { mapId: string }) {
  const [k, setK] = useState<Kontingensi | null>(null);
  const [kor, setKor] = useState<{ total: number; rows: Koridor[] } | null>(null);
  const [kf, setKf] = useState({ kelas: "", q: "", semua: false });
  const [jenis, setJenis] = useState("gardu");
  const [q, setQ] = useState("");
  const [aset, setAset] = useState<{ total: number; rows: AssetRow[] } | null>(null);
  const open = useOpenAsset();
  useEffect(() => { api<Kontingensi>("/kontingensi").then(setK).catch(() => {}); }, []);
  useEffect(() => {
    const qs = new URLSearchParams({ kritis: String(!kf.semua), limit: "200", ...(kf.kelas && { kelas: kf.kelas }), ...(kf.q && { q: kf.q }) });
    api<{ total: number; rows: Koridor[] }>(`/topologi?${qs}`).then(setKor).catch(() => {});
  }, [kf]);
  useEffect(() => {
    const t = setTimeout(() => api<{ total: number; rows: AssetRow[] }>(`/assets?jenis=${jenis}&q=${encodeURIComponent(q)}&limit=40`).then(setAset).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [jenis, q]);
  const s = k?.struktural;
  const ctl = "rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs";
  return (
    <div className="flex flex-1 flex-col gap-3">
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <MetricWidget label="Koridor transmisi" value={fmt(s.ringkas.koridor)} caption={`${fmt(s.ringkas.simpul)} gardu/pembangkit terhubung`} />
          <MetricWidget label="Koridor kritis N-1" value={fmt(s.ringkas.kritis)} caption="jembatan graf: lepas = jaringan terpisah" color="#dc2626" />
          <MetricWidget label="MW terisolasi bila lepas" value={fmt(s.ringkas.mw_berisiko)} caption="Σ kapasitas pembangkit (tag OSM) di sisi terpisah" color="#f97316" />
          <MetricWidget label="Gardu terisolasi bila lepas" value={fmt(s.ringkas.gardu_berisiko)} caption="Σ gardu di sisi terpisah koridor kritis" color="#f97316" />
          <MetricWidget label="Titik artikulasi" value={fmt(s.ringkas.artikulasi)} caption="gardu yang bila lepas memisahkan jaringan" color="#a855f7" />
          <MetricWidget label="Gardu radial" value={fmt(s.ringkas.radial)} caption="hanya 1 koridor ke jaringan" color="#eab308" />
        </div>
      )}
      <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="relative min-h-[460px] overflow-hidden rounded-lg border border-line bg-panel">
          <iframe title="Peta jaringan Jawa–Bali" src={`/map/${mapId}?embed=1`} className="absolute inset-0 h-full w-full border-0" />
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-ink/85 px-2 py-1 text-[10px] text-soft">Layer “Koridor kritis N-1 (struktural, OSM)”: merah = MW terisolasi besar</div>
        </div>
        <Widget title="Koridor kritis N-1 (struktural)" caption={kor ? `${fmt(kor.total)} koridor${kf.semua ? "" : " kritis"} — urut MW terisolasi` : "memuat…"} bodyClass="flex min-h-0 flex-1 flex-col p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            <select value={kf.kelas} onChange={(e) => setKf({ ...kf, kelas: e.target.value })} className={ctl} aria-label="Kelas tegangan">
              <option value="">Semua kelas</option><option value="500">500 kV</option><option value="150">150 kV</option><option value="70">70 kV</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-soft"><input type="checkbox" checked={kf.semua} onChange={(e) => setKf({ ...kf, semua: e.target.checked })} /> termasuk redundan</label>
            <input value={kf.q} onChange={(e) => setKf({ ...kf, q: e.target.value })} placeholder="nama gardu / koridor…" className={`${ctl} min-w-32 flex-1`} />
          </div>
          {!kor ? <Loading /> : (
            <DataTable
              name="koridor-kritis-n1"
              maxH="max-h-[380px]"
              rows={kor.rows}
              onRow={(r) => open({ jenis: "koridor", id: r.id })}
              cols={[
                { key: "kelas_kv", label: "kV", render: (r) => <Pill text={String(r.kelas_kv)} color={KV_COLOR[String(r.kelas_kv)] ?? "#64748b"} />, value: (r) => r.kelas_kv },
                { key: "nama", label: "Koridor", render: (r) => <div><div>{r.nama}</div><div className="text-muted">{r.panjang_km} km</div></div> },
                { key: "mw_terisolasi", label: "MW", align: "right", render: (r) => fmt(r.mw_terisolasi) },
                { key: "gardu_terisolasi", label: "Gardu", align: "right" },
                { key: "dampak", label: "Dampak bila lepas", render: (r) => <span className="text-muted">{r.dampak}</span> },
              ]}
            />
          )}
          {s && <p className="mt-2 text-[10px] text-muted">{s.metode} <span className="text-amber-300">{s.batasan}</span></p>}
          <Sources items={k?.sumber.filter((x) => x.key !== "n1_gi")} />
        </Widget>
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Widget title="Koridor per kelas tegangan" caption="jumlah koridor & yang kritis N-1">
          <BarList rows={Object.entries(s?.per_kelas ?? {}).filter(([kv]) => Number(kv) >= 70).map(([kv, v]) => ({ key: `${kv} kV`, value: v.koridor, color: KV_COLOR[kv], note: `${v.kritis} kritis · ${fmt(v.km)} km` }))} />
        </Widget>
        <Widget title="Titik artikulasi teratas" caption="gardu yang bila keluar memisahkan jaringan">
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {(s?.artikulasi_teratas ?? []).map((a) => (
              <div key={a.nama + a.koridor} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1 text-xs">
                <span>{a.jenis === "Gardu" && a.gardu_ref ? <AssetButton jenis="gardu" id={a.gardu_ref.pk}>{a.nama}</AssetButton> : <NexusLink r={a.ref}>{a.nama}</NexusLink>}</span>
                <span className="text-muted">{a.koridor} koridor · {a.koridor_kritis} kritis</span>
              </div>
            ))}
          </div>
        </Widget>
        <Widget title="Cari aset & buka 360°" caption={aset ? `${fmt(aset.total)} cocok` : "…"}>
          <div className="flex gap-2">
            <select value={jenis} onChange={(e) => setJenis(e.target.value)} className={ctl} aria-label="Jenis aset">
              <option value="gardu">Gardu transmisi (OSM)</option><option value="saluran">Saluran transmisi (OSM)</option><option value="pembangkit">Pembangkit (OSM)</option>
              <option value="gi">Gardu induk (demo)</option><option value="penyulang">Penyulang (demo)</option><option value="gardu_distribusi">Gardu distribusi (demo)</option>
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nama / id…" className={`${ctl} min-w-0 flex-1`} />
          </div>
          <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
            {(aset?.rows ?? []).map((a) => (
              <button key={a.id} type="button" onClick={() => open({ jenis, id: a.id })} className="flex w-full items-center justify-between gap-2 rounded border border-line px-2 py-1 text-left text-xs hover:bg-white/5">
                <span className="min-w-0 truncate">{a.nama} <span className="text-muted">{a.id}</span></span>
                <span className="shrink-0 text-muted">{a.kelas_kv ? `${a.kelas_kv} kV` : ""} {a.status ?? ""}</span>
              </button>
            ))}
          </div>
        </Widget>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
   Beban & kontingensi
   ------------------------------------------------------------------------------------------------ */

export function LoadPage() {
  const [b, setB] = useState<Beban | null>(null);
  const [pny, setPny] = useState<string>("");
  const [fp, setFp] = useState<BebanPenyulang | null>(null);
  const [range, setRange] = useState<"jam" | "harian">("harian");
  const [err, setErr] = useState("");
  useEffect(() => { api<Beban>("/beban?hari=7").then((r) => { setB(r); setPny(r.penyulang[0]?.kode_penyulang ?? ""); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { if (pny) api<BebanPenyulang>(`/beban/penyulang/${encodeURIComponent(pny)}?hari=14`).then(setFp).catch(() => setFp(null)); }, [pny]);
  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!b) return <Loading text="Memuat beban & kontingensi…" />;
  const GI_COLOR = ["#38bdf8", "#a78bfa"];
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Widget title="Beban gardu induk (MVA) vs kapasitas firm N-1" caption={`${range === "harian" ? "puncak harian Jul–Sep" : "per jam, 7 hari terakhir data"} · Σ penyulang per jam (SCADA) · garis abu-abu = kapasitas firm (satu trafo keluar)`}
          right={<div className="flex overflow-hidden rounded border border-line-2 text-[11px]">{(["harian", "jam"] as const).map((r) => <button key={r} type="button" onClick={() => setRange(r)} className={`px-2 py-0.5 ${range === r ? "bg-ocean text-white" : "text-soft"}`}>{r === "harian" ? "Puncak harian" : "Per jam"}</button>)}</div>}>
          <TsChart height={260} series={[
            ...b.gi.map((g, i) => ({ key: g.kode_gi, label: g.nama_gi, unit: "MVA", color: GI_COLOR[i % 2], points: range === "harian" ? g.harian_puncak_mva : g.per_jam_mva })),
            ...(b.gi.length ? [(() => {
              const pts = range === "harian" ? b.gi[0].harian_puncak_mva : b.gi[0].per_jam_mva;
              return { key: "firm", label: `Kapasitas firm N-1 (${b.gi[0].kapasitas_firm_mva} MVA)`, unit: "MVA", color: "#94a3b8",
                points: pts.length ? [{ t: pts[0].t, value: b.gi[0].kapasitas_firm_mva }, { t: pts[pts.length - 1].t, value: b.gi[0].kapasitas_firm_mva }] : [] };
            })()] : []),
          ]} />
        </Widget>
        <Widget title="Kontingensi N-1 trafo GI" caption="satu trafo daya keluar: sisa kapasitas menanggung puncak?">
          <div className="space-y-2 text-xs">
            {b.n1_gi.map((g) => (
              <div key={g.kode_gi} className="rounded border border-line p-2">
                <div className="flex items-center justify-between"><AssetButton jenis="gi" id={g.kode_gi}>{g.nama_gi}</AssetButton><NexusLink r={g.ref}><Pill text={g.status_n1} color={g.status_n1 === "Aman N-1" ? "#22c55e" : "#dc2626"} /></NexusLink></div>
                <div className="mt-1.5"><Meter pct={g.beban_firm_puncak_pct} warn={90} crit={100} /></div>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-2 text-muted">
                  <dt>Puncak koinsiden</dt><dd className="text-right text-soft">{fmt(g.puncak_mva, 2)} MVA</dd>
                  <dt>Kapasitas firm</dt><dd className="text-right text-soft">{fmt(g.kapasitas_firm_mva, 1)} MVA ({g.n_trafo} trafo)</dd>
                  <dt>Margin N-1</dt><dd className="text-right text-soft">{fmt(g.margin_n1_mva, 1)} MVA</dd>
                  <dt>Jam melanggar / waspada</dt><dd className="text-right text-soft">{g.jam_melanggar_n1} / {g.jam_waspada_n1}</dd>
                  <dt>Faktor beban · diversitas</dt><dd className="text-right text-soft">{g.faktor_beban} · {g.faktor_diversitas}</dd>
                </dl>
                <p className="mt-1 text-muted">{g.rekomendasi}</p>
              </div>
            ))}
          </div>
        </Widget>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Widget title="Pembebanan termal penyulang" caption="arus puncak vs min(KHA penghantar GIS, PMT 630 A) — klik untuk profil" bodyClass="p-3">
          <DataTable
            name="pembebanan-penyulang"
            maxH="max-h-80"
            rows={b.penyulang}
            onRow={(r) => setPny(r.kode_penyulang)}
            initialSort={{ key: "beban_termal_pct", desc: true }}
            cols={[
              { key: "kode_penyulang", label: "Penyulang", render: (r) => <span className={r.kode_penyulang === pny ? "font-semibold text-white" : ""}><AssetButton jenis="penyulang" id={r.kode_penyulang} /> <span className="text-muted">{r.jenis}</span></span> },
              { key: "beban_termal_pct", label: "Termal", render: (r) => <Meter pct={r.beban_termal_pct} /> },
              { key: "arus_puncak_a", label: "I puncak (A)", align: "right", render: (r) => `${fmt(r.arus_puncak_a, 1)} / ${r.batas_termal_a}` },
              { key: "puncak_kw", label: "Puncak kW", align: "right", render: (r) => fmt(r.puncak_kw) },
              { key: "faktor_beban", label: "LF", align: "right" },
              { key: "rugi_i2r_puncak_kw", label: "Rugi I²R (kW)", align: "right", render: (r) => fmt(r.rugi_i2r_puncak_kw, 1) },
              { key: "ruang_tambah_kw", label: "Ruang (kW)", align: "right", render: (r) => fmt(r.ruang_tambah_kw) },
            ]}
          />
        </Widget>
        <Widget title={`Profil penyulang ${pny}`} caption="daya per jam 14 hari terakhir data (SCADA) dan kurva beban harian rata-rata" bodyClass="p-3">
          {!fp ? <Loading /> : (
            <>
              <TsChart height={170} series={[{ key: "kw", label: `Daya ${pny}`, unit: "kW", color: "#38bdf8", points: fp.kw }]} />
              <div className="mt-2 text-[11px] text-muted">Kurva beban harian (rata-rata kW per jam WIB, Jul–Sep): hari kerja vs akhir pekan</div>
              <ProfileChart rows={fp.profil} />
              <Sources items={fp.sumber} />
            </>
          )}
        </Widget>
      </div>
      <Widget title="Gardu distribusi — beban tertinggi (AMR per jam)" caption="beban maks % kVA terpasang, jam overload, suhu minyak, tegangan ujung — dari Risiko Aset Operasi" bodyClass="p-3">
        <DataTable
          name="beban-gardu-distribusi"
          maxH="max-h-80"
          rows={b.gardu}
          cols={[
            { key: "kode_dt", label: "Gardu", render: (r) => <AssetButton jenis="gardu_distribusi" id={r.kode_dt} /> },
            { key: "kode_penyulang", label: "Penyulang" },
            { key: "beban_pct", label: "Beban maks", render: (r) => <Meter pct={r.beban_pct} /> },
            { key: "jam_overload", label: "Jam overload", align: "right" },
            { key: "suhu_minyak_maks_c", label: "Suhu minyak (°C)", align: "right", render: (r) => fmt(r.suhu_minyak_maks_c, 1) },
            { key: "tegangan_ujung_min_v", label: "V ujung min", align: "right", render: (r) => <span className={(r.tegangan_ujung_min_v ?? 999) < 198 ? "text-amber-300" : ""}>{fmt(r.tegangan_ujung_min_v, 1)}</span> },
            { key: "kelas_risiko", label: "Risiko", render: (r) => <NexusLink r={r.risiko_ref}><Pill text={`${r.kelas_risiko} ${r.skor}`} color={RISK_COLOR[r.kelas_risiko] ?? "#94a3b8"} /></NexusLink> },
            { key: "rekomendasi", label: "Rekomendasi", render: (r) => <span className="text-muted">{r.rekomendasi}</span> },
          ]}
        />
        <Sources items={b.sumber} />
      </Widget>
      <Unavailable title="Loading saluran transmisi — tidak tersedia">{b.transmisi.alasan}</Unavailable>
    </div>
  );
}

function ProfileChart({ rows }: { rows: { jam: string; rata_hari_kerja_kw: number; rata_akhir_pekan_kw: number; maks_kw: number }[] }) {
  // one day's 24 hours on a fixed date so the shared time axis reads as hours
  const pt = (k: "rata_hari_kerja_kw" | "rata_akhir_pekan_kw" | "maks_kw") => rows.map((r) => ({ t: `2026-01-05T${r.jam}:00:00+07:00`, value: r[k] }));
  return (
    <TsChart height={150} series={[
      { key: "hk", label: "Hari kerja (rata-rata)", unit: "kW", color: "#38bdf8", points: pt("rata_hari_kerja_kw") },
      { key: "ap", label: "Akhir pekan (rata-rata)", unit: "kW", color: "#a78bfa", points: pt("rata_akhir_pekan_kw") },
      { key: "mx", label: "Maksimum", unit: "kW", color: "#94a3b8", points: pt("maks_kw") },
    ]} />
  );
}

/* ------------------------------------------------------------------------------------------------
   Keandalan & gangguan
   ------------------------------------------------------------------------------------------------ */

export function ReliabilityPage() {
  const [k, setK] = useState<Keandalan | null>(null);
  const [out, setOut] = useState<{ padam_distribusi_demo: Outage[]; per_penyebab: { penyebab: string; gangguan: number; pelanggan_menit: number }[]; padam_transmisi: { alasan: string } } | null>(null);
  const [metric, setMetric] = useState<"saidi" | "saifi" | "maifi" | "ens_kwh">("saidi");
  const [od, setOd] = useState<OutageDetail | null>(null);
  const [jenis, setJenis] = useState("");
  useEffect(() => {
    api<Keandalan>("/keandalan").then(setK).catch(() => {});
    api<typeof out>("/outages").then(setOut).catch(() => {});
  }, []);
  if (!k) return <Loading text="Memuat keandalan…" />;
  const t = k.sistem.total;
  const unit = { saidi: "menit", saifi: "kali", maifi: "kali", ens_kwh: "kWh" }[metric];
  const outs = (out?.padam_distribusi_demo ?? []).filter((o) => !jenis || o.jenis === jenis);
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricWidget label="SAIDI sistem" value={`${fmt(t.saidi, 1)} mnt`} caption={k.sistem.periode} />
        <MetricWidget label="SAIFI sistem" value={fmt(t.saifi, 2)} caption="kali padam per pelanggan" />
        <MetricWidget label="MAIFI" value={fmt(t.maifi, 2)} caption="gangguan temporer per pelanggan" color="#a78bfa" />
        <MetricWidget label="CAIDI" value={`${fmt(t.caidi, 1)} mnt`} caption="rata-rata lama pemulihan" color="#eab308" />
        <MetricWidget label="ENS" value={`${fmt(t.ens_kwh)} kWh`} caption="energi tidak tersalur" color="#f97316" />
        <MetricWidget label="Gangguan (SOE)" value={t.gangguan} caption={`${k.penyulang.length} penyulang dipantau`} color="#64748b" />
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Widget title="Indeks keandalan sistem per bulan" caption="tertimbang jumlah pelanggan penyulang (IEEE 1366)"
          right={<select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} className="rounded-md border border-line-2 bg-ink px-2 py-1 text-xs" aria-label="Indeks">
            <option value="saidi">SAIDI</option><option value="saifi">SAIFI</option><option value="maifi">MAIFI</option><option value="ens_kwh">ENS</option></select>}>
          <Bars unit={unit} data={k.sistem.per_bulan.map((m) => ({ label: m.bulan, value: m[metric], note: `${m.gangguan} gangguan (${m.permanen} permanen)` }))} height={150} />
          <dl className="mt-3 grid gap-1 text-[11px] text-muted sm:grid-cols-2">{Object.entries(k.definisi).map(([a, b]) => <div key={a}><dt className="inline font-medium text-soft">{a}: </dt><dd className="inline">{b}</dd></div>)}</dl>
        </Widget>
        <Widget title="Penyebab gangguan" caption="pelanggan-menit padam per penyebab (SOE)">
          <BarList rows={(out?.per_penyebab ?? []).map((p) => ({ key: p.penyebab, value: Math.round(p.pelanggan_menit), color: "#64748b", note: `${p.gangguan} kejadian` }))} format={(v) => fmt(v)} />
        </Widget>
      </div>
      <Widget title="Keandalan per penyulang (Apr–Sep)" caption="urut SAIDI; klik kode untuk 360° penyulang" bodyClass="p-3">
        <DataTable
          name="keandalan-penyulang"
          maxH="max-h-80"
          rows={k.penyulang}
          cols={[
            { key: "kode_penyulang", label: "Penyulang", render: (r) => <AssetButton jenis="penyulang" id={r.kode_penyulang} /> },
            { key: "kode_ulp", label: "ULP" },
            { key: "pelanggan", label: "Pelanggan", align: "right", render: (r) => fmt(r.pelanggan) },
            { key: "saidi", label: "SAIDI (mnt)", align: "right", render: (r) => fmt(r.saidi, 1) },
            { key: "saifi", label: "SAIFI", align: "right", render: (r) => fmt(r.saifi, 2) },
            { key: "maifi", label: "MAIFI", align: "right", render: (r) => fmt(r.maifi, 2) },
            { key: "caidi", label: "CAIDI", align: "right", render: (r) => fmt(r.caidi, 1) },
            { key: "permanen", label: "Permanen", align: "right" },
            { key: "ens_kwh", label: "ENS (kWh)", align: "right", render: (r) => fmt(r.ens_kwh) },
            { key: "bulan", label: "SAIDI per bulan", value: (r) => r.saidi, render: (r) => <Spark values={Object.entries(r.bulan).sort().map(([, v]) => v)} /> },
          ]}
          initialSort={{ key: "saidi", desc: true }}
        />
        <Sources items={k.sumber} />
      </Widget>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Widget title="Gangguan & pemulihan (distribusi demo)" caption="SOE SCADA — klik untuk linimasa & dampak topologi"
          right={<select value={jenis} onChange={(e) => setJenis(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1 text-xs" aria-label="Jenis"><option value="">Semua</option><option value="Permanen">Permanen</option><option value="Temporer">Temporer</option></select>} bodyClass="p-3">
          <DataTable
            name="gangguan-penyulang"
            maxH="max-h-80"
            rows={outs}
            onRow={(o) => api<OutageDetail>(`/outages/${encodeURIComponent(o.id)}`).then(setOd)}
            cols={[
              { key: "id", label: "ID", render: (r) => <NexusLink r={r.ref}>{r.id}</NexusLink> },
              { key: "mulai", label: "Trip", render: (r) => <span className="whitespace-nowrap">{waktu(r.mulai)}</span> },
              { key: "kode_penyulang", label: "Penyulang" },
              { key: "jenis", label: "Jenis", render: (r) => <Pill text={r.jenis} color={r.jenis === "Permanen" ? "#f97316" : "#94a3b8"} /> },
              { key: "penyebab", label: "Penyebab" },
              { key: "durasi_menit", label: "Durasi (mnt)", align: "right" },
              { key: "pelanggan_padam", label: "Pelanggan", align: "right", render: (r) => fmt(r.pelanggan_padam) },
            ]}
          />
        </Widget>
        <Widget title={od ? `Linimasa ${od.id}` : "Linimasa gangguan"} caption="SOE → pemulihan; dampak dari relasi Nexus penyulang → gardu → pelanggan">
          {!od ? <p className="text-xs text-muted">Pilih gangguan di tabel.</p> : (
            <div className="space-y-2 text-xs">
              <ol className="border-l border-line-2 pl-3">
                {od.timeline.map((t, i) => <li key={i} className="mb-1.5"><span className="text-muted">{waktu(t.waktu)}</span> · {t.kejadian}</li>)}
              </ol>
              <div className="rounded border border-line p-2">
                <div>Penyulang <NexusLink r={od.dampak_topologi.penyulang_ref}>{od.dampak_topologi.penyulang}</NexusLink>: {od.dampak_topologi.gardu.length} gardu, {fmt(od.dampak_topologi.pelanggan_total)} pelanggan terhubung · SOE {fmt(od.dampak_topologi.pelanggan_padam_soe)} pelanggan padam · ENS {fmt(od.dampak_topologi.ens_kwh, 1)} kWh</div>
                <div className="mt-1 text-muted">{od.dampak_topologi.catatan}</div>
              </div>
              <div className="max-h-40 overflow-y-auto">
                {od.dampak_topologi.gardu.map((g) => <div key={g.id} className="flex justify-between border-t border-line/50 py-0.5"><AssetButton jenis="gardu_distribusi" id={g.id} /><span className="text-muted">{g.pelanggan} pelanggan · {g.status}</span></div>)}
              </div>
            </div>
          )}
          <p className="mt-2 text-[10px] text-amber-300">{out?.padam_transmisi.alasan}</p>
        </Widget>
      </div>
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1e-9, ...values);
  return (
    <span className="flex h-5 items-end gap-0.5" aria-label={values.map((v) => v.toFixed(1)).join(", ")}>
      {values.map((v, i) => <span key={i} title={`${v.toFixed(1)} mnt`} className="w-1.5 rounded-t bg-sky-400" style={{ height: `${Math.max(6, (v / max) * 100)}%`, opacity: v ? 1 : 0.3 }} />)}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------
   Risiko aset
   ------------------------------------------------------------------------------------------------ */

export function RiskPage() {
  const [r, setR] = useState<Risiko | null>(null);
  const [f, setF] = useState({ jenis: "", kelas: "" });
  useEffect(() => {
    const qs = new URLSearchParams({ ...(f.jenis && { jenis: f.jenis }), ...(f.kelas && { kelas: f.kelas }) });
    api<Risiko>(`/risiko?${qs}`).then(setR).catch(() => {});
  }, [f]);
  if (!r) return <Loading text="Memuat risiko aset…" />;
  const ctl = "rounded-md border border-line-2 bg-ink px-2 py-1 text-xs";
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,2fr)]">
        {(["Tinggi", "Sedang", "Rendah"] as const).map((k) => (
          <MetricWidget key={k} label={`Risiko ${k.toLowerCase()}`} value={r.per_kelas[k] ?? 0} color={RISK_COLOR[k]} caption={k === "Tinggi" ? "skor ≥ 50" : k === "Sedang" ? "skor 25–49" : "skor < 25"} onClick={() => setF({ ...f, kelas: f.kelas === k ? "" : k })} />
        ))}
        <Widget title="Faktor utama (risiko sedang & tinggi)" caption="yang paling menyumbang skor per aset">
          <BarList rows={Object.entries(r.per_faktor).map(([k, v]) => ({ key: k, value: v, color: "#f97316" }))} />
        </Widget>
      </div>
      <Widget title="Register risiko aset operasi" caption={r.metode}
        right={<div className="flex gap-2">
          <select value={f.jenis} onChange={(e) => setF({ ...f, jenis: e.target.value })} className={ctl} aria-label="Jenis aset"><option value="">Semua aset</option><option value="Gardu distribusi">Gardu distribusi</option><option value="Penyulang">Penyulang</option></select>
          <select value={f.kelas} onChange={(e) => setF({ ...f, kelas: e.target.value })} className={ctl} aria-label="Kelas"><option value="">Semua kelas</option><option>Tinggi</option><option>Sedang</option><option>Rendah</option></select>
        </div>} bodyClass="p-3">
        <DataTable
          name="risiko-aset-operasi"
          maxH="max-h-[60vh]"
          rows={r.rows}
          cols={[
            { key: "skor", label: "Skor", align: "right", render: (x) => <NexusLink r={x.ref}><Pill text={`${x.skor}`} color={RISK_COLOR[x.kelas_risiko] ?? "#94a3b8"} /></NexusLink> },
            { key: "kode_aset", label: "Aset", render: (x) => <div><AssetButton jenis={x.aset_jenis} id={x.kode_aset} /><div className="text-muted">{x.jenis_aset} · {x.kode_ulp}</div></div> },
            { key: "faktor_utama", label: "Faktor utama" },
            { key: "bukti", label: "Bukti", render: (x) => <span className="text-muted">{x.bukti}</span> },
            { key: "rekomendasi", label: "Rekomendasi" },
            { key: "jumlah_pelanggan", label: "Pelanggan", align: "right", render: (x) => fmt(x.jumlah_pelanggan) },
          ]}
        />
        <Sources items={r.sumber} />
      </Widget>
      <p className="text-[11px] text-muted">Rencana kerja dari risiko dibuat lewat action Nexus <Link className="text-ocean" href="/ontology/action-types" target="_blank">“Buat perintah kerja teknis (demo)”</Link> agar peran & audit tercatat.</p>
    </div>
  );
}
