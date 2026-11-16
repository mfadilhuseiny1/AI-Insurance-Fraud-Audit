"use client";

import Link from "next/link";
import { OntologyDiagram, type OntAction, type OntLink, type OntNode } from "@/components/demo/OntologyDiagram";

export type IotOverview = {
  object_types: OntNode[];
  link_types: OntLink[];
  action_types: OntAction[];
  kpi: { faskes: number; alat: number; alat_bermeter: number; hari: number; kelengkapan_pct: number; temuan_tinggi: number; tak_didukung: number; nilai_rp: number; diverifikasi: number; terkonfirmasi: number; koreksi_rp: number };
  apps: { pipeline?: string; sync?: string; graph?: string; template?: string; map?: string; machinery?: string; proses_alat?: string; proses_verifikasi?: string; lineage_graph?: string; raw: Record<string, string | null> };
  status: Record<string, number>;
  nodes: { id: string; name: string; kind: string; group: string }[];
  outputs: string[];
  sql: Record<string, string>;
  nasional?: {
    wilayah: { rs_total: number; rs_terhubung: number; cakupan_pct: number; alat_bermeter: number; klaim_terpantau_14h: number; tak_didukung_14h: number; nilai_tak_didukung_rp: number; rasio_tak_didukung_pct: number; rs_prioritas: number; rs_perhatian: number; rs_data_kurang: number; kelengkapan_pct: number | null };
    provinsi: number;
    kabkota: number;
    kedeputian: { id_wilayah: string; nama: string; cakupan_pct: number; rs_prioritas: number; nilai_tak_didukung_rp: number; status_wilayah: string }[];
    hotspot: { id_wilayah: string; nama: string; rs_prioritas: number; rs_terhubung: number; nilai_tak_didukung_rp: number }[];
    skala: { hari: number; baris_edge: number; bacaan_setara: number; faktor: number };
    apps: { peta_nasional?: string; graph_hotspot?: string; pipeline_nasional?: string };
    status_rs: Record<string, number>;
  } | null;
  contoh?: { id_temuan: string; klaim_tindakan: number; estimasi_tindakan_alat: number; siklus?: number; energi_aktif_kwh?: number; tindakan_tak_didukung: number; nilai_tak_didukung_rp: number; dokter_terbanyak?: string; status_temuan?: string; penjelasan: string } | null;
};

const juta = (v: number) => `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`;
const STATUS_COLOR: Record<string, string> = {
  "Klaim melebihi pemakaian alat": "#ef4444",
  "Klaim saat alat mati": "#b91c1c",
  "Klaim tanpa alat terdaftar": "#be185d",
  "Perlu verifikasi (alat tanpa meter)": "#f59e0b",
  "Data meter tidak lengkap": "#64748b",
  Sesuai: "#22c55e",
};

function H({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-semibold">{children}</h3>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

const fmt = (v: number, d = 0) => Number(v ?? 0).toLocaleString("id-ID", { maximumFractionDigits: d });

/** From the pilot to every hospital: two data tiers, the network's numbers, what edge aggregation saves, the hotspots. */
function National({ n }: { n: NonNullable<IotOverview["nasional"]> }) {
  const w = n.wilayah;
  const maxNilai = Math.max(1, ...n.kedeputian.map((k) => k.nilai_tak_didukung_rp));
  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Skala nasional: semua RS mitra JKN, wilayah demi wilayah</h3>
        <Link href="/demo-jkn/audit?tab=nasional" className="ml-auto rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep">
          Buka pantauan nasional →
        </Link>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1.2fr]">
        <div className="space-y-2">
          <div className="rounded-lg bg-ink p-2">
            <div className="font-medium text-teal-300">Tingkat 1 · Telemetri penuh (pilot, RS prioritas)</div>
            <div className="mt-0.5 text-[11px] text-soft">Bacaan 2 menit tiap alat ke Time Series DB; status Mati / Siaga / Tindakan di Device and Machinery. Untuk RS yang sedang diaudit.</div>
          </div>
          <div className="rounded-lg bg-ink p-2">
            <div className="font-medium text-sky-300">Tingkat 2 · Ringkasan edge (seluruh jejaring)</div>
            <div className="mt-0.5 text-[11px] text-soft">
              Gateway tiap RS menghitung sendiri logika pipeline (siklus, energi aktif, menit menyala, menit-mesin, kelengkapan) dan mengirim 1 baris per alat per hari. Bacaan penuh
              disimpan di arsip gateway dan ditarik saat temuan dibuka, jadi rantai bukti tetap sampai data mentah.
            </div>
          </div>
          <div className="rounded-lg bg-ink p-2">
            <div className="font-medium">Volume data, 14 hari</div>
            <div className="mt-0.5 text-[11px] text-soft">
              {fmt(n.skala.baris_edge)} baris ringkasan menggantikan {fmt(n.skala.bacaan_setara)} bacaan ({n.skala.faktor}× lebih kecil). Untuk sekitar 2.800 RS mitra dengan sekitar 15 alat
              masing-masing: sekitar 42 ribu baris per hari, bukan sekitar 30 juta bacaan.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 content-start gap-2">
          {(
            [
              ["RS terhubung", `${fmt(w.rs_terhubung)} / ${fmt(w.rs_total)}`],
              ["Cakupan", `${fmt(w.cakupan_pct, 1)} %`],
              ["Wilayah", `${n.provinsi} provinsi · ${n.kabkota} kab/kota`],
              ["Alat bermeter", fmt(w.alat_bermeter)],
              ["Klaim terpantau", fmt(w.klaim_terpantau_14h)],
              ["Tak didukung", `${fmt(w.tak_didukung_14h)} (${fmt(w.rasio_tak_didukung_pct, 2)} %)`],
              ["Nilai tak didukung", juta(w.nilai_tak_didukung_rp)],
              ["RS prioritas / perhatian", `${w.rs_prioritas} / ${w.rs_perhatian}`],
            ] as [string, string][]
          ).map(([l, v]) => (
            <div key={l} className="rounded-lg border border-line bg-panel px-2 py-1.5">
              <div className="text-[10.5px] text-muted">{l}</div>
              <div className="font-semibold tabular-nums">{v}</div>
            </div>
          ))}
          {n.hotspot.length > 0 && (
            <div className="col-span-2 rounded-lg border border-rose-700/50 bg-rose-950/30 p-2">
              <div className="font-medium text-rose-300">Hotspot</div>
              {n.hotspot.map((h) => (
                <div key={h.id_wilayah} className="flex gap-2 text-[11px]">
                  <span>{h.nama}</span>
                  <span className="text-muted">
                    {h.rs_prioritas}/{h.rs_terhubung} RS prioritas
                  </span>
                  <span className="ml-auto text-rose-300">{juta(h.nilai_tak_didukung_rp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="mb-1 font-medium">Per kedeputian wilayah (pembagian contoh)</div>
          <table className="w-full text-[11px]">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-0.5">Kedeputian</th>
                <th className="text-right">Cakupan</th>
                <th className="text-right">RS prioritas</th>
                <th className="pl-2">Nilai tak didukung</th>
              </tr>
            </thead>
            <tbody>
              {n.kedeputian.map((k) => (
                <tr key={k.id_wilayah} className="border-t border-line/50">
                  <td className="py-0.5">{k.nama.replace("Kedeputian Wilayah", "KW")}</td>
                  <td className="text-right tabular-nums">{fmt(k.cakupan_pct)}%</td>
                  <td className="text-right tabular-nums" style={{ color: k.rs_prioritas ? "#ef4444" : undefined }}>
                    {k.rs_prioritas || "—"}
                  </td>
                  <td className="pl-2">
                    <span className="inline-block h-1.5 overflow-hidden rounded bg-line align-middle" style={{ width: 70 }}>
                      <span className="block h-full bg-rose-500" style={{ width: `${(k.nilai_tak_didukung_rp / maxNilai) * 100}%` }} />
                    </span>{" "}
                    <span className="tabular-nums text-muted">{juta(k.nilai_tak_didukung_rp)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * The IoT layer of the JKN demo for the overview page: why medical devices' electricity is evidence, how it flows
 * through the platform (sensor → pipeline → time series → Ontology → apps), the worked example, the methods, the
 * pilot's results against what was planted, the guardrails against false accusations, and the way to production.
 */
export function IotSection({ n, iot }: { n: number; iot: IotOverview }) {
  const k = iot.kpi;
  const a = iot.apps;
  const c = iot.contoh;
  const chip = (label: string, sub: string, color: string, href?: string) => {
    const body = (
      <div className="h-full rounded-lg border p-2 text-left transition hover:brightness-125" style={{ borderColor: `${color}77`, background: `${color}14` }}>
        <div className="text-xs font-semibold" style={{ color }}>
          {label}
        </div>
        <div className="mt-0.5 text-[10.5px] text-soft">{sub}</div>
      </div>
    );
    return href ? (
      <Link href={href} className="block w-44">
        {body}
      </Link>
    ) : (
      <div className="w-44">{body}</div>
    );
  };
  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ocean/20 text-[11px] text-ocean">{n}</span>
          Integrasi IoT: listrik alat medis sebagai bukti tindakan
        </h2>
        <p className="max-w-5xl text-xs text-muted">
          Klaim tindakan penunjang (Rontgen, CT, USG, hemodialisis) hanya bisa terjadi kalau alatnya benar-benar bekerja. Meter listrik di tiap alat merekam kapan alat
          mati, siaga atau sedang melakukan tindakan. Jika mesin Rontgen hanya 8 kali melakukan eksposur tetapi rumah sakit mengklaim 20 foto Rontgen hari itu, 12 klaim tidak punya
          jejak fisik — bukti objektif yang tidak bergantung pada dokumen klaim itu sendiri.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
        {(
          [
            ["Faskes pilot", `${k.faskes}`],
            ["Alat bermeter", `${k.alat_bermeter} / ${k.alat}`],
            ["Hari × alat dianalisis", `${k.hari} hari`],
            ["Kelengkapan meter", `${k.kelengkapan_pct} %`],
            ["Hari temuan tinggi", `${k.temuan_tinggi}`],
            ["Tindakan tak didukung", `${k.tak_didukung}`],
            ["Nilai tak didukung", juta(k.nilai_rp)],
            ["Diverifikasi", `${k.diverifikasi} (${k.terkonfirmasi} terkonfirmasi)`],
          ] as [string, string][]
        ).map(([l, v]) => (
          <div key={l} className="rounded-xl border border-line bg-panel px-3 py-2">
            <div className="text-[10.5px] text-muted">{l}</div>
            <div className="text-base font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-panel p-3">
        <H sub="Setiap kotak adalah sumber daya nyata di platform — klik untuk membukanya.">Arsitektur end-to-end</H>
        <div className="flex flex-wrap items-stretch gap-1.5 text-muted">
          {chip("1 · Sensor di alat", "Smart plug (USG, Rontgen DR) / CT clamp 3 fase (CT scan, panel unit HD); daya tiap 2 menit", "#0ea5e9")}
          <span className="self-center">→</span>
          {chip("2 · Gateway IoT RS", "MQTT → Data Connection; demo: ekspor batch di raw/iot (dengan kiriman ulang & glitch)", "#0ea5e9", a.raw.daya_listrik_alat_iot ? `/datasets/${a.raw.daya_listrik_alat_iot}` : undefined)}
          <span className="self-center">→</span>
          {chip("3 · Pipeline IoT", `${iot.nodes.filter((x) => x.kind === "sql").length} transform SQL: bersih → status → siklus → pemakaian → rekonsiliasi`, "#38bdf8", a.pipeline ? `/pipeline/${a.pipeline}` : undefined)}
          <span className="self-center">→</span>
          {chip("4 · Time series sync", "Bacaan bersih → Time Series DB; seri = id meter", "#2dd4bf", a.sync ? `/time-series/${a.sync}` : undefined)}
          <span className="self-center">→</span>
          {chip("5 · Nexus", "Alat (objek sensor faskes) · Temuan IoT · Tindakan diklaim · action verifikasi", "#22c55e", "#iot-ontologi")}
          <span className="self-center">→</span>
          {chip("6 · Ruang kerja", "Tab IoT: matriks klaim vs alat, rantai bukti sampai data mentah", "#f59e0b", "/demo-jkn/audit?tab=iot")}
          {chip("Vertex", "Faskes → alat (readout daya) → temuan → dokter", "#a78bfa", a.graph ? `/vertex?graph=${a.graph}` : undefined)}
          {chip("Peta", "Alat medis per status IoT di sekitar RS", "#a78bfa", a.map ? `/map/${a.map}` : undefined)}
          {chip("Device and Machinery", "Status Mati / Siaga / Tindakan per alat; alur verifikasi temuan", "#a78bfa", a.machinery ? `/machinery?id=${a.machinery}&process=${a.proses_alat ?? ""}` : undefined)}
          {chip("Data Lineage", "Mentah → pipeline → sync → objek sensor → aplikasi", "#a78bfa", a.lineage_graph ? `/lineage?graph=${a.lineage_graph}` : undefined)}
        </div>
      </div>

      {iot.nasional && <National n={iot.nasional} />}

      <div className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
        <div id="iot-ontologi" className="rounded-xl border border-line bg-panel p-3">
          <H sub="Alat adalah objek sensor milik faskes (properti daya = time series); temuan menghubungkan alat, faskes, tindakan yang diklaim dan dokter pengajunya.">
            Nexus IoT
          </H>
          <OntologyDiagram nodes={iot.object_types} links={iot.link_types} actions={iot.action_types} functions={[]} />
        </div>
        <div className="space-y-3">
          {c && (
            <div className="rounded-xl border border-bad/40 bg-bad/5 p-3 text-xs">
              <H sub="RSUD Contoh Sejahtera · Rontgen · 15 September 2026">Contoh: dari keputusan sampai data mentah</H>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-ink p-2">
                  <div className="text-[10.5px] text-muted">Siklus mesin Rontgen</div>
                  <div className="text-2xl font-semibold text-teal-300">{c.estimasi_tindakan_alat}</div>
                </div>
                <div className="rounded-md bg-ink p-2">
                  <div className="text-[10.5px] text-muted">Foto Rontgen diklaim</div>
                  <div className="text-2xl font-semibold text-orange-300">{c.klaim_tindakan}</div>
                </div>
                <div className="rounded-md bg-ink p-2">
                  <div className="text-[10.5px] text-muted">Tanpa jejak alat</div>
                  <div className="text-2xl font-semibold text-bad">{c.tindakan_tak_didukung}</div>
                  <div className="text-[10px] text-muted">{juta(c.nilai_tak_didukung_rp)}</div>
                </div>
              </div>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-soft">
                <li>
                  <b className="text-white">Keputusan:</b> {c.status_temuan || "Baru"} — tim audit memeriksa log PACS (7 studi pasien + 1 eksposur QC) lalu mengoreksi klaim; tercatat di riwayat edit
                  dan di Device and Machinery.
                </li>
                <li>
                  <b className="text-white">Temuan:</b> {c.penjelasan}
                </li>
                <li>
                  <b className="text-white">Bukti alat:</b> grafik daya 24 jam dari Time Series DB — 8 lonjakan di atas ambang 1.068 W, sisanya standby.
                </li>
                <li>
                  <b className="text-white">Klaim:</b> 20 baris tindakan, terbanyak diajukan {c.dokter_terbanyak ?? "dokter yang sama"} — dokter yang juga ada di kasus phantom billing.
                </li>
                <li>
                  <b className="text-white">Data mentah:</b> ±720 bacaan meter hari itu (termasuk kiriman ulang gateway) dan baris klaim e-Klaim dengan kode “8744” / “ 87.44 ”.
                </li>
              </ol>
              <Link href={`/demo-jkn/audit?tab=iot&temuan=${encodeURIComponent(c.id_temuan)}`} className="mt-2 inline-block rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep">
                Buka rantai buktinya →
              </Link>
            </div>
          )}
          <div className="rounded-xl border border-line bg-panel p-3 text-xs">
            <H sub="Satu aturan untuk semua alat tidak cukup: pola listriknya berbeda.">Estimasi tindakan dari pola listrik</H>
            <table className="w-full text-[11px]">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1">Alat</th>
                  <th>Metode</th>
                  <th>Estimasi tindakan</th>
                </tr>
              </thead>
              <tbody className="align-top text-soft">
                <tr className="border-t border-line/60">
                  <td className="py-1 font-medium text-white">Rontgen, CT</td>
                  <td>siklus</td>
                  <td>maks(jumlah lonjakan di atas ambang, energi aktif ÷ energi per tindakan — 148 Wh / 3,67 kWh)</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="py-1 font-medium text-white">USG</td>
                  <td>waktu</td>
                  <td>menit menyala ÷ 15 menit (daya saat memindai ≈ idle: listrik hanya membuktikan alat menyala)</td>
                </tr>
                <tr className="border-t border-line/60">
                  <td className="py-1 font-medium text-white">Hemodialisis</td>
                  <td>menit-mesin</td>
                  <td>Σ (daya − beban RO) ÷ 1,3 kW per mesin ÷ 240 menit; kapasitas fisik = mesin × 3 shift</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-panel p-3 text-xs">
          <H sub="Faskes × jenis alat × hari selama 14 hari pilot (data fiktif dengan kasus yang ditanam).">Hasil pilot vs yang ditanam</H>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {Object.entries(iot.status)
              .sort((x, y) => y[1] - x[1])
              .map(([s, v]) => (
                <span key={s} className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: `${STATUS_COLOR[s] ?? "#64748b"}22`, color: STATUS_COLOR[s] ?? "#94a3b8" }}>
                  {s}: {v}
                </span>
              ))}
          </div>
          <table className="w-full text-[11px]">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1">Skenario</th>
                <th>Terdeteksi sebagai</th>
              </tr>
            </thead>
            <tbody className="align-top text-soft">
              {[
                ["RSUD Contoh Sejahtera: Rontgen diklaim 2× lipat eksposur (phantom)", "Klaim melebihi pemakaian alat (merah)"],
                ["RS Sentosa Timur: USG rusak 17–21 Sep, klaim jalan terus", "Klaim saat alat mati (merah tua)"],
                ["RS Sentosa Timur: sesi HD melebihi kapasitas 4 mesin × 3 shift", "Klaim melebihi pemakaian alat"],
                ["Klinik Utama Contoh Medika: klaim Rontgen padahal tidak punya mesin", "Klaim tanpa alat terdaftar (ASPAK)"],
                ["Klinik Utama Contoh Medika: USG diklaim melebihi jam menyala", "Klaim melebihi pemakaian alat"],
                ["RS Permata Raya: gateway CT mati 22–23 Sep", "Data meter tidak lengkap — bukan bukti"],
                ["RS Permata Raya: Rontgen mobile tanpa meter di bangsal", "Perlu verifikasi — bukan langsung fraud"],
                ["RS Bakti Contoh, RS Harapan Contoh: normal", "Sesuai (kontrol, tanpa temuan)"],
              ].map(([s, r]) => (
                <tr key={s} className="border-t border-line/60">
                  <td className="py-1 pr-2">{s}</td>
                  <td className="text-white">{r}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-panel p-3 text-xs">
            <H>Pengaman agar tidak salah tuduh</H>
            <ul className="list-disc space-y-1 pl-5 text-soft">
              <li>Toleransi: klaim harus melebihi estimasi × 1,1 + 1 — eksposur QC, uji pagi dan selisih kecil tidak dihitung.</li>
              <li>Meter mengirim &lt; 90 % bacaan → “Data meter tidak lengkap”: tidak dinilai, tim IT memperbaiki gateway.</li>
              <li>Ada alat sejenis tanpa meter (Rontgen mobile, alat cadangan) → “Perlu verifikasi”, tingkat sedang.</li>
              <li>Temuan = alasan memeriksa log alat (RIS/PACS DICOM, log mesin HD), bukan putusan; keputusan lewat action, tercatat dan bisa diaudit.</li>
              <li>Tidak ada data pasien di aliran IoT — hanya telemetri alat; identitas pasien tetap di e-Klaim.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-line bg-panel p-3 text-xs">
            <H>Yang tidak bisa dibuktikan listrik — dan pelengkapnya</H>
            <ul className="list-disc space-y-1 pl-5 text-soft">
              <li>Pasien mana yang diperiksa → cocokkan dengan worklist RIS / header DICOM (jumlah studi per hari).</li>
              <li>Isi pemeriksaan USG (memindai vs idle tampak sama) → log sesi di mesin USG / PACS.</li>
              <li>Tindakan tanpa listrik khusus (konsultasi, tindakan kecil) → tetap memakai aturan skrining & model anomali.</li>
              <li>Upcoding jenis tindakan (CT tanpa kontras ditagih dengan kontras) → durasi & energi per sesi sebagai sinyal, diverifikasi rekam medis.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel p-3 text-xs">
        <H sub="Dari pilot ke produksi, di platform yang sama.">Rencana produksi</H>
        <ol className="grid gap-2 md:grid-cols-4">
          {[
            ["1 · Perluas pilot", "RS tipe A/B dengan klaim radiologi & HD terbesar; meter di Rontgen, CT, MRI, cath lab, unit HD; register ASPAK sebagai acuan alat."],
            ["2 · Streaming", "Gateway MQTT → Data Connection stream → pipeline streaming; temuan muncul harian (bukan setelah klaim dibayar) dan bisa menahan pembayaran lewat Automate."],
            ["3 · Gabung log alat", "Header DICOM / worklist RIS dan log mesin HD sebagai sumber kedua; temuan IoT + PACS = bukti kuat untuk koreksi klaim."],
            ["4 · Ukur & kelola", "Device and Machinery memantau status alat dan SLA verifikasi; Data Health memantau kelengkapan meter; prioritas audit memakai bobot IoT."],
          ].map(([h, b]) => (
            <li key={h} className="rounded-lg bg-ink p-2">
              <div className="font-medium">{h}</div>
              <div className="mt-0.5 text-[11px] text-soft">{b}</div>
            </li>
          ))}
        </ol>
      </div>

      <details className="rounded-xl border border-line bg-panel p-3 text-xs">
        <summary className="cursor-pointer text-sm font-semibold">Transparansi: SQL pipeline IoT ({Object.keys(iot.sql).length} transform)</summary>
        <div className="mt-2 space-y-2">
          {Object.entries(iot.sql).map(([name, sql]) => (
            <div key={name}>
              <div className="font-mono text-[11px] text-ocean">{name}</div>
              <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-ink p-2 text-[10.5px] leading-snug text-soft">{sql}</pre>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
