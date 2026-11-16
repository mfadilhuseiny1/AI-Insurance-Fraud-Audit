"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { API_URL } from "@/lib/api";
import { Badge, juta } from "./FacilityFile";
import { TINGKAT_COLOR, VERDICT_COLOR } from "./IotEvidence";

type Cell = { id: string; klaim: number; est: number; status: string; tingkat: string; keputusan: string | null } | null;
type Alat = {
  id_alat: string;
  nama_alat: string;
  jenis_alat: string;
  kode_faskes: string;
  nama_faskes: string;
  id_meter: string | null;
  metode_estimasi: string;
  status_iot: string;
  status_operasi: string | null;
  kelengkapan_pct: number;
  estimasi_tindakan_total: number;
  klaim_total: number;
  tak_didukung_total: number;
  kwh_total: number;
  hari_temuan: number;
};
type Temuan = {
  id_temuan: string;
  judul: string;
  kode_faskes: string;
  nama_faskes: string;
  jenis_alat: string;
  tanggal: string;
  jenis_temuan: string;
  tingkat: string;
  klaim_tindakan: number;
  estimasi_tindakan_alat: number;
  tindakan_tak_didukung: number;
  nilai_tak_didukung_rp: number;
  dokter_terbanyak?: string;
  status_temuan?: string;
  penjelasan: string;
};
type Iot = {
  days: string[];
  matrix: { kode_faskes: string; nama_faskes: string; jenis_alat: string; cells: Cell[]; alat: Alat[]; tak_didukung: number }[];
  temuan: Temuan[];
  alat: Alat[];
  kpi: { faskes: number; alat: number; alat_bermeter: number; hari: number; kelengkapan_pct: number; temuan_tinggi: number; tak_didukung: number; nilai_rp: number; diverifikasi: number; terkonfirmasi: number; koreksi_rp: number };
  apps: { pipeline?: string; sync?: string; graph?: string; template?: string; map?: string; machinery?: string; proses_alat?: string; proses_verifikasi?: string; lineage_graph?: string; raw: Record<string, string | null> };
};

const CELL: Record<string, string> = {
  "Klaim melebihi pemakaian alat": "#ef4444",
  "Klaim saat alat mati": "#b91c1c",
  "Klaim tanpa alat terdaftar": "#be185d",
  "Perlu verifikasi (alat tanpa meter)": "#f59e0b",
  "Data meter tidak lengkap": "#64748b",
  Sesuai: "#14532d",
};
const STATUS_OP: Record<string, string> = { Tindakan: "#f43f5e", Siaga: "#f59e0b", Mati: "#64748b", "Tanpa meter": "#475569" };

function HowItWorks() {
  const steps: [string, string, string][] = [
    ["Sensor", "Smart meter / CT clamp di tiap alat (Rontgen, CT, USG, unit HD) → gateway IoT RS → daya (W) tiap 2 menit", "#0ea5e9"],
    ["Pipeline", "Bersihkan (dedup, glitch) → status per bacaan → siklus → pemakaian harian & estimasi tindakan", "#0ea5e9"],
    ["Time series", "Bacaan bersih jadi time series sync; alat = objek sensor faskes dengan properti daya", "#2dd4bf"],
    ["Rekonsiliasi", "Klaim e-Klaim per faskes × jenis alat × hari vs estimasi dari alat; toleransi 10 % + 1", "#ef4444"],
    ["Nexus", "Temuan IoT, tindakan diklaim, alat → faskes & dokter; action verifikasi tercatat di riwayat", "#22c55e"],
    ["Aplikasi", "Ruang kerja ini, Vertex, peta, Device and Machinery (status alat), Data Lineage", "#a78bfa"],
  ];
  return (
    <details className="rounded-xl border border-line bg-panel p-3 text-xs" open>
      <summary className="cursor-pointer text-sm font-semibold">Cara kerja: listrik alat medis sebagai bukti tindakan</summary>
      <div className="mt-3 flex flex-wrap items-stretch gap-1.5">
        {steps.map(([h, b, c], i) => (
          <div key={h} className="flex items-center gap-1.5">
            <div className="w-44 rounded-lg border p-2" style={{ borderColor: `${c}66`, background: `${c}12` }}>
              <div className="font-semibold" style={{ color: c }}>
                {i + 1}. {h}
              </div>
              <div className="mt-0.5 text-[11px] text-soft">{b}</div>
            </div>
            {i < steps.length - 1 && <span className="text-muted">→</span>}
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {[
          ["Rontgen, CT (siklus)", "Tiap eksposur menaikkan daya jauh di atas standby. Estimasi = maks(jumlah siklus, energi aktif ÷ energi per tindakan) — eksposur berdempetan tidak menurunkan hitungan."],
          ["USG (waktu)", "Daya saat memindai hampir sama dengan idle, jadi listrik hanya membuktikan alat menyala. Estimasi = menit menyala ÷ durasi minimum pemeriksaan (15 menit)."],
          ["Hemodialisis (menit-mesin)", "Satu meter panel unit HD: (daya − beban RO) ÷ daya per mesin = mesin yang berjalan. Estimasi = menit-mesin ÷ 240 menit per sesi; kapasitas fisik = mesin × 3 shift."],
        ].map(([h, b]) => (
          <div key={h} className="rounded-lg bg-ink p-2">
            <div className="font-medium">{h}</div>
            <div className="mt-0.5 text-[11px] text-soft">{b}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Pengaman agar tidak salah tuduh: hari dengan bacaan meter &lt; 90 % → <b className="text-soft">Data meter tidak lengkap</b> (bukan bukti); faskes yang punya alat sejenis tanpa meter (mis. Rontgen mobile di bangsal) →{" "}
        <b className="text-soft">Perlu verifikasi</b>; selisih kecil di bawah toleransi diabaikan. Temuan adalah alasan untuk memeriksa log alat (RIS/PACS, catatan HD), bukan kesimpulan.
      </p>
    </details>
  );
}

/** The IoT tab of the audit workspace: the pilot's devices, the device × day reconciliation and the findings. */
export function IotTab({ version, onEvidence, onFacility }: { version: number; onEvidence: (id: string) => void; onFacility: (kode: string) => void }) {
  const [d, setD] = useState<Iot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tingkat, setTingkat] = useState("Tinggi");
  const [verif, setVerif] = useState("");
  useEffect(() => {
    let stale = false;
    fetch(`${API_URL}/api/demo/jkn/workbench/iot`, { credentials: "include", cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail ?? r.statusText))))
      .then((x: Iot) => !stale && (setD(x), setErr(null)), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [version]);
  const findings = useMemo(
    () => (d?.temuan ?? []).filter((t) => (!tingkat || t.tingkat === tingkat) && (!verif || (verif === "Baru" ? !t.status_temuan || t.status_temuan === "Baru" : (t.status_temuan ?? "").startsWith(verif)))),
    [d, tingkat, verif],
  );
  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat data IoT…</p>;
  const k = d.kpi;
  const a = d.apps;
  const link = "rounded-md border border-line-2 px-2.5 py-1 text-[11px] hover:border-ocean";
  const select = "rounded-md border border-line-2 bg-ink px-2 py-1 text-xs";
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {(
          [
            ["Faskes pilot", k.faskes, undefined],
            ["Alat bermeter", `${k.alat_bermeter} / ${k.alat}`, "#2dd4bf"],
            ["Hari dianalisis", k.hari, undefined],
            ["Kelengkapan data", `${k.kelengkapan_pct} %`, "#2dd4bf"],
            ["Hari temuan (tinggi)", k.temuan_tinggi, "#ef4444"],
            ["Tindakan tak didukung", k.tak_didukung, "#ef4444"],
            ["Nilai tak didukung", juta(k.nilai_rp), "#ef4444"],
            ["Diverifikasi / terkonfirmasi", `${k.diverifikasi} / ${k.terkonfirmasi}`, "#22c55e"],
          ] as [string, string | number, string | undefined][]
        ).map(([l, v, c]) => (
          <div key={l} className="rounded-xl border border-line bg-panel px-3 py-2">
            <div className="text-[10.5px] text-muted">{l}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums" style={c ? { color: c } : undefined}>
              {v}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {a.graph && (
          <Link href={`/vertex?graph=${a.graph}`} className={link}>
            Vertex: bukti IoT
          </Link>
        )}
        {a.map && (
          <Link href={`/map/${a.map}`} className={link}>
            Peta alat IoT
          </Link>
        )}
        {a.machinery && (
          <Link href={`/machinery?id=${a.machinery}&process=${a.proses_alat ?? ""}`} className={link}>
            Device and Machinery: status alat
          </Link>
        )}
        {a.pipeline && (
          <Link href={`/pipeline/${a.pipeline}`} className={link}>
            Pipeline IoT
          </Link>
        )}
        {a.sync && (
          <Link href={`/time-series/${a.sync}`} className={link}>
            Time series daya
          </Link>
        )}
        {a.lineage_graph && (
          <Link href={`/lineage?graph=${a.lineage_graph}`} className={link}>
            Data lineage
          </Link>
        )}
      </div>
      <HowItWorks />

      <div className="rounded-xl border border-line bg-panel p-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-sm font-semibold">Klaim vs pemakaian alat, per hari</span>
          <span className="text-muted">sel = klaim / estimasi dari alat · klik sel untuk rantai buktinya</span>
          <span className="ml-auto flex flex-wrap gap-2 text-[10.5px]">
            {Object.entries(CELL).map(([s, c]) => (
              <span key={s} className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
                {s}
              </span>
            ))}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[3px] text-[10.5px]">
            <thead>
              <tr className="text-muted">
                <th className="min-w-56 text-left font-normal">Faskes · jenis alat</th>
                {d.days.map((day) => {
                  const dt = new Date(`${day}T00:00:00+07:00`);
                  return (
                    <th key={day} className={`min-w-12 font-normal ${dt.getDay() === 0 ? "text-bad/80" : ""}`}>
                      {day.slice(8)}
                      <div className="text-[9px]">{dt.toLocaleDateString("id-ID", { weekday: "short" })}</div>
                    </th>
                  );
                })}
                <th className="font-normal">Tak didukung</th>
              </tr>
            </thead>
            <tbody>
              {d.matrix.map((m) => (
                <tr key={`${m.kode_faskes}-${m.jenis_alat}`}>
                  <td className="pr-2">
                    <button type="button" onClick={() => onFacility(m.kode_faskes)} className="text-left hover:text-ocean">
                      <span className="font-medium">{m.nama_faskes}</span> · {m.jenis_alat}
                    </button>
                    <div className="text-muted">{m.alat.length ? m.alat.map((x) => `${x.nama_alat}${x.id_meter ? "" : " (tanpa meter)"}`).join(", ") : "tidak ada alat terdaftar"}</div>
                  </td>
                  {m.cells.map((c, i) =>
                    c ? (
                      <td key={i} className="p-0">
                        <button
                          type="button"
                          disabled={c.status === "Sesuai"}
                          onClick={() => onEvidence(c.id)}
                          title={`${c.status}: klaim ${c.klaim}, estimasi alat ${c.est}${c.keputusan ? ` · ${c.keputusan}` : ""}`}
                          className="relative h-9 w-full rounded text-center font-mono tabular-nums text-white disabled:cursor-default"
                          style={{ background: CELL[c.status] ?? "#334155", opacity: c.status === "Sesuai" ? 0.65 : 1 }}
                        >
                          {c.klaim}/{c.est}
                          {c.keputusan && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full" style={{ background: VERDICT_COLOR(c.keputusan) === "#22c55e" ? "#86efac" : "#fde047" }} />}
                        </button>
                      </td>
                    ) : (
                      <td key={i} className="rounded bg-ink text-center text-muted">
                        —
                      </td>
                    ),
                  )}
                  <td className="text-right font-semibold tabular-nums" style={{ color: m.tak_didukung ? "#ef4444" : undefined }}>
                    {m.tak_didukung || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[10.5px] text-muted">Titik kecil di sel = sudah diverifikasi tim audit (hijau: bukan fraud, kuning: terkonfirmasi / klarifikasi).</p>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
        <div className="rounded-xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
            <span className="text-sm font-semibold">Temuan IoT</span>
            <select value={tingkat} onChange={(e) => setTingkat(e.target.value)} className={select}>
              <option value="">Semua tingkat</option>
              {["Tinggi", "Sedang", "Info"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <select value={verif} onChange={(e) => setVerif(e.target.value)} className={select}>
              <option value="">Semua status</option>
              {["Baru", "Klarifikasi", "Terkonfirmasi", "Klaim dikoreksi", "Bukan fraud"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <span className="text-muted">{findings.length} temuan</span>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left text-[10.5px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-1.5">Temuan</th>
                  <th className="px-2 py-1.5 text-right">Klaim / alat</th>
                  <th className="px-2 py-1.5 text-right">Tak didukung</th>
                  <th className="px-2 py-1.5">Dokter terbanyak</th>
                  <th className="px-2 py-1.5">Verifikasi</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((t) => (
                  <tr key={t.id_temuan} onClick={() => onEvidence(t.id_temuan)} className="cursor-pointer border-b border-line/50 hover:bg-panel-2">
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Badge text={t.tingkat} color={TINGKAT_COLOR[t.tingkat] ?? "#64748b"} />
                        <span className="font-medium">{t.nama_faskes}</span>
                        <span className="text-muted">
                          {t.jenis_alat} · {String(t.tanggal).slice(0, 10)}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-[10.5px] text-muted" title={t.penjelasan}>
                        {t.jenis_temuan}: {t.penjelasan}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {t.klaim_tindakan} / {t.estimasi_tindakan_alat}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {t.tindakan_tak_didukung || "—"}
                      {t.nilai_tak_didukung_rp ? <div className="text-[10px] text-muted">{juta(t.nilai_tak_didukung_rp)}</div> : null}
                    </td>
                    <td className="px-2 py-1.5 text-[10.5px]">{t.dokter_terbanyak ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <Badge text={t.status_temuan || "Baru"} color={VERDICT_COLOR(t.status_temuan)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-3 py-2 text-sm font-semibold">Alat medis IoT ({d.alat.length})</div>
          <ul className="max-h-[520px] divide-y divide-line/50 overflow-y-auto text-xs">
            {d.alat.map((x) => (
              <li key={x.id_alat} className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_OP[x.status_operasi ?? "Tanpa meter"] ?? "#64748b" }} title={`Status operasi: ${x.status_operasi ?? "tidak ada (alat tanpa meter)"}`} />
                  <span className="font-medium">{x.nama_alat}</span>
                  <span className="ml-auto">
                    <Badge
                      text={x.status_iot}
                      color={x.status_iot === "Ada temuan" ? "#ef4444" : x.status_iot === "Sesuai" ? "#22c55e" : x.status_iot === "Tanpa meter" ? "#64748b" : "#f59e0b"}
                    />
                  </span>
                </div>
                <div className="text-[10.5px] text-muted">
                  {x.nama_faskes} · {x.id_meter ?? "tanpa meter"} · {x.metode_estimasi} · data {x.kelengkapan_pct} %
                </div>
                <div className="mt-0.5 text-[10.5px] text-soft">
                  14 hari: alat {x.estimasi_tindakan_total} tindakan · diklaim {x.klaim_total} · {x.kwh_total} kWh
                  {x.tak_didukung_total ? <b className="text-bad"> · {x.tak_didukung_total} tak didukung</b> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
