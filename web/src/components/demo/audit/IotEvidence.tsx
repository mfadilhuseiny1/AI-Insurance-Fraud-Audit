"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActionForm } from "@/components/ontology/ActionForm";
import { API_URL } from "@/lib/api";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { Badge, juta, rupiah } from "./FacilityFile";

export const TINGKAT_COLOR: Record<string, string> = { Tinggi: "#ef4444", Sedang: "#f59e0b", Info: "#64748b", Sesuai: "#22c55e" };
export const VERDICT_COLOR = (v?: string | null) =>
  !v || v === "Baru" ? "#94a3b8" : v.startsWith("Terkonfirmasi") || v.startsWith("Klaim dikoreksi") ? "#ef4444" : v.startsWith("Bukan fraud") ? "#22c55e" : "#f59e0b";
export const VERDICTS = ["Klarifikasi ke faskes", "Terkonfirmasi — klaim tidak didukung", "Klaim dikoreksi", "Bukan fraud — alat cadangan / tanpa meter", "Bukan fraud — gangguan meter"];

type Sesi = { id_sesi: string; mulai: string; bacaan_terakhir: string; mulai_ts: number; selesai_ts: number; menit: number; energi_wh: number; puncak_w: number };
type Device = {
  id_alat: string;
  nama_alat?: string;
  jenis_alat?: string;
  merek_model?: string;
  id_meter?: string | null;
  id_gateway?: string | null;
  metode_estimasi?: string;
  daya_standby_w?: number;
  daya_aktif_w?: number;
  ambang_aktif_w?: number;
  jumlah_mesin?: number;
  status_operasi?: string;
  series: [number, number][];
  pemakaian?: { bacaan: number; kelengkapan: number; siklus: number; menit_menyala: number; menit_aktif: number; energi_aktif_wh: number; mesin_menit: number; kwh: number; estimasi_tindakan: number; jam_nyala_pertama: number | null; jam_nyala_terakhir: number | null } | null;
  sesi: Sesi[];
};
type Tindakan = { id_baris: string; no_sep: string; kode_icd9: string; nama_tindakan: string; nama_dokter?: string; id_dokter?: string; jenis_rawat?: string; kelas_rawat?: string; tarif_rs: number };
type History = { at?: string; user?: string | null; op?: string; changes?: Record<string, [unknown, unknown]> };
type Evidence = {
  temuan: Record<string, unknown> & { id_temuan: string; judul: string; tingkat: string; jenis_temuan: string; penjelasan: string; status_temuan?: string; kode_faskes: string; tanggal: string; jenis_alat: string };
  riwayat: History[];
  rekon: Record<string, number | string | null> | null;
  alat: Device[];
  referensi: { kode_icd9: string; nama_tindakan: string; metode: string; durasi_min_menit: number; energi_per_tindakan_wh: number | null; sesi_per_mesin_per_hari: number; tarif_estimasi_rp: number }[];
  tindakan: Tindakan[];
  per_dokter: { id_dokter: string; nama: string; jumlah: number; nilai_rp: number }[];
  mentah: {
    bacaan: { id_gateway: string; id_meter: string; ts: number; waktu_lokal: string; daya_watt: number | null; tegangan_v: number }[];
    bacaan_total: number;
    bacaan_duplikat: number;
    bacaan_glitch: number;
    id_huruf_kecil: number;
    klaim: Record<string, unknown>[];
    klaim_total: number;
    /** national findings: the gateway's daily summary as the pipeline received it */
    ringkasan_edge?: Record<string, unknown>[];
  };
  /** where the readings and claim lines come from (pilot: Time Series DB and claim objects; network: pulled on open) */
  sumber?: { tier: string; bacaan: string; klaim: string };
  types: Record<string, string>;
  actions: { id: string; name: string }[];
  apps: { pipeline?: string; sync?: string; template?: string; graph?: string; map?: string; machinery?: string; proses_alat?: string; proses_verifikasi?: string; lineage_graph?: string; raw: Record<string, string | null>; clean: Record<string, string | null>;
    raw_edge?: string; raw_klaim?: string; pipeline_nasional?: string; sync_nasional?: string };
};

const num = (v: unknown) => Number(v ?? 0);
const fmt = (v: unknown, d = 0) => num(v).toLocaleString("id-ID", { maximumFractionDigits: d });

/** A day of one device's power (Time Series DB), its procedure cycles shaded, the "in procedure" threshold dashed. */
export function PowerChart({ d, day, height = 170 }: { d: Device; day: string; height?: number }) {
  const W = 960;
  const H = height;
  const start = new Date(`${day}T00:00:00+07:00`).getTime();
  const max = Math.max(50, ...d.series.map((p) => p[1]), (d.ambang_aktif_w ?? 0) * 1.2);
  const x = (ms: number) => ((ms - start) / 86_400_000) * W;
  const y = (v: number) => H - 18 - (v / max) * (H - 30);
  const pts = d.series.map(([ms, v]) => `${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-ink" preserveAspectRatio="none" role="img" aria-label={`Daya ${d.nama_alat} ${day}`}>
      {d.sesi.map((s) => (
        <rect key={s.id_sesi} x={x(s.mulai_ts * 1000)} y={8} width={Math.max(1.5, x(s.selesai_ts * 1000) - x(s.mulai_ts * 1000))} height={H - 26} fill="#f43f5e" opacity={0.16} />
      ))}
      {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
        <g key={h}>
          <line x1={(h / 24) * W} x2={(h / 24) * W} y1={8} y2={H - 18} stroke="currentColor" className="text-line" strokeWidth={0.6} />
          <text x={Math.min(W - 18, (h / 24) * W + 2)} y={H - 5} fontSize={10} className="fill-muted">
            {String(h).padStart(2, "0")}:00
          </text>
        </g>
      ))}
      {d.ambang_aktif_w ? (
        <>
          <line x1={0} x2={W} y1={y(d.ambang_aktif_w)} y2={y(d.ambang_aktif_w)} stroke="#f59e0b" strokeDasharray="5 4" strokeWidth={1} />
          <text x={W - 4} y={y(d.ambang_aktif_w) - 3} fontSize={10} textAnchor="end" fill="#f59e0b">
            ambang tindakan {fmt(d.ambang_aktif_w)} W
          </text>
        </>
      ) : null}
      {pts && <polyline points={pts} fill="none" stroke="#2dd4bf" strokeWidth={1.3} />}
      <text x={4} y={16} fontSize={10} className="fill-muted">
        {fmt(max)} W
      </text>
      {!d.series.length && (
        <text x={W / 2} y={H / 2} fontSize={13} textAnchor="middle" fill="#f59e0b">
          {d.id_meter ? "Tidak ada bacaan dari meter hari ini (meter / gateway offline)" : "Alat tanpa meter IoT"}
        </text>
      )}
    </svg>
  );
}

function Step({ n, title, children, color = "#38bdf8" }: { n: number; title: string; children: React.ReactNode; color?: string }) {
  return (
    <section className="relative pl-9">
      <span className="absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-ink" style={{ background: color }}>
        {n}
      </span>
      <span className="absolute bottom-[-18px] left-[11px] top-7 w-px bg-line" />
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Formula({ ev }: { ev: Evidence }) {
  const r = ev.rekon ?? {};
  const t = ev.temuan;
  const ref = ev.referensi[0];
  const est = num(r.estimasi_tindakan_alat);
  const klaim = num(r.klaim_tindakan);
  const batas = num(r.batas_toleransi);
  let estText = "";
  if (ref?.metode === "siklus") {
    const e = num(ref.energi_per_tindakan_wh) / 1000;
    estText = `maks(${fmt(r.siklus)} siklus, ${fmt(r.energi_aktif_kwh, 2)} kWh aktif ÷ ${fmt(e, 3)} kWh/tindakan ≈ ${fmt(Math.round(num(r.energi_aktif_kwh) / (e || 1)))}) = ${fmt(est)}`;
  } else if (ref?.metode === "waktu") {
    estText = `${fmt(r.menit_menyala)} menit menyala ÷ ${ref.durasi_min_menit} menit per pemeriksaan = ${fmt(est)}`;
  } else if (ref) {
    estText = `${fmt(r.mesin_menit)} menit-mesin ÷ ${ref.durasi_min_menit} menit per sesi = ${fmt(est)} (kapasitas fisik ${fmt(r.kapasitas_maks)} sesi/hari)`;
  }
  return (
    <div className="rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="mb-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-ink p-2">
          <div className="text-[10.5px] text-muted">Estimasi tindakan dari alat</div>
          <div className="text-2xl font-semibold tabular-nums text-teal-300">{fmt(est)}</div>
        </div>
        <div className="rounded-md bg-ink p-2">
          <div className="text-[10.5px] text-muted">Tindakan diklaim</div>
          <div className="text-2xl font-semibold tabular-nums text-orange-300">{fmt(klaim)}</div>
        </div>
        <div className="rounded-md bg-ink p-2">
          <div className="text-[10.5px] text-muted">Tidak didukung alat</div>
          <div className="text-2xl font-semibold tabular-nums" style={{ color: TINGKAT_COLOR[t.tingkat] }}>
            {fmt(t.tindakan_tak_didukung)}
          </div>
          <div className="text-[10.5px] text-muted">{rupiah(num(t.nilai_tak_didukung_rp))}</div>
        </div>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-soft">
        {estText && (
          <li>
            Estimasi ({ref?.metode}) = <span className="font-mono text-white">{estText}</span>
          </li>
        )}
        <li>
          Batas toleransi = ⌊estimasi × 1,1⌋ + 1 = <span className="font-mono text-white">{fmt(batas)}</span> · kelengkapan meter{" "}
          <span className="font-mono text-white">{fmt(num(r.kelengkapan) * 100, 1)} %</span> (minimal 90 %)
          {num(r.tanpa_meter) > 0 && <> · ada {fmt(r.tanpa_meter)} alat sejenis tanpa meter</>}
        </li>
        <li>
          Aturan: <b className="text-white">{t.jenis_temuan}</b> — {t.penjelasan}
        </li>
      </ol>
    </div>
  );
}

/**
 * One IoT finding as a chain of evidence, from the audit team's decision down to the raw rows: the decision (and the
 * form to take it), the reconciliation with the rule applied, each device's power that day with its cycles, the claim
 * lines and who filed them, and the meter readings and claim lines as they arrived.
 */
export function IotEvidence({ id, onClose, onFacility, onDecided }: { id: string; onClose: () => void; onFacility: (kode: string) => void; onDecided: () => void }) {
  const [ev, setEv] = useState<Evidence | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ action: ActionType; type: ObjectType; object: OntologyObject; verdict: string } | null>(null);
  const [v, setV] = useState(0);
  const [allRaw, setAllRaw] = useState(false);
  useEffect(() => {
    let stale = false;
    fetch(`${API_URL}/api/demo/jkn/workbench/iot/temuan/${encodeURIComponent(id)}`, { credentials: "include", cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail ?? r.statusText))))
      .then((x: Evidence) => !stale && (setEv(x), setErr(null)), (e: Error) => !stale && setErr(e.message));
    return () => {
      stale = true;
    };
  }, [id, v]);
  const decide = useCallback(
    async (verdict: string) => {
      if (!ev?.actions[0]) return;
      const tid = ev.types.temuan;
      try {
        const [acts, type, object] = await Promise.all([ontology.actionTypes(tid), ontology.objectType(tid), ontology.object(tid, ev.temuan.id_temuan)]);
        const action = acts.find((a) => a.id === ev.actions[0].id);
        if (action) setForm({ action, type, object, verdict });
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [ev],
  );
  const t = ev?.temuan;
  const apps = ev?.apps;
  const link = "rounded-md border border-line-2 px-2 py-1 text-[11px] hover:border-ocean";
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[1000px] flex-col border-l border-line bg-ink shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line bg-panel px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span>Rantai bukti IoT</span>
              {t && <Badge text={t.tingkat} color={TINGKAT_COLOR[t.tingkat] ?? "#64748b"} />}
              {t && <Badge text={t.status_temuan || "Baru"} color={VERDICT_COLOR(t.status_temuan)} />}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold">{t?.judul ?? id}</h2>
            {t && <p className="text-xs text-soft">{t.jenis_temuan}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {t && (
              <button type="button" onClick={() => onFacility(t.kode_faskes)} className={link}>
                Berkas faskes
              </button>
            )}
            {apps?.template && (
              <Link href={`/vertex?template=${apps.template}&objects=${encodeURIComponent(id)}`} className={link}>
                Vertex
              </Link>
            )}
            {apps?.machinery && (
              <Link href={`/machinery?id=${apps.machinery}&process=${apps.proses_verifikasi ?? ""}`} className={link}>
                Device and Machinery
              </Link>
            )}
            {apps?.lineage_graph && (
              <Link href={`/lineage?graph=${apps.lineage_graph}`} className={link}>
                Lineage
              </Link>
            )}
            <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-muted hover:text-white" aria-label="Tutup">
              ✕
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 text-sm">
          {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>}
          {!ev && !err && <p className="text-muted">Memuat rantai bukti…</p>}
          {ev && t && (
            <>
              <Step n={1} title="Keputusan tim audit" color={VERDICT_COLOR(t.status_temuan)}>
                <div className="rounded-lg border border-line bg-panel p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">Status verifikasi:</span>
                    <Badge text={t.status_temuan || "Baru"} color={VERDICT_COLOR(t.status_temuan)} />
                    {num(t.nilai_koreksi_rp) > 0 && <span className="text-soft">koreksi klaim {rupiah(num(t.nilai_koreksi_rp))}</span>}
                  </div>
                  {typeof t.catatan_verifikasi === "string" && t.catatan_verifikasi && <p className="mt-1 text-soft">“{t.catatan_verifikasi}”</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {VERDICTS.map((x) => (
                      <button key={x} type="button" onClick={() => decide(x)} className="rounded border px-2 py-0.5 text-[11px] hover:bg-panel-2" style={{ borderColor: `${VERDICT_COLOR(x)}88`, color: VERDICT_COLOR(x) }}>
                        ⚡ {x}
                      </button>
                    ))}
                  </div>
                  {form && (
                    <div className="mt-3 rounded-lg border border-line-2 bg-ink p-2">
                      <ActionForm
                        key={form.verdict}
                        inline
                        action={form.action}
                        objectType={form.type}
                        object={form.object}
                        defaults={{ status_temuan: form.verdict }}
                        onClose={() => setForm(null)}
                        onDone={() => {
                          setForm(null);
                          setV((x) => x + 1);
                          onDecided();
                        }}
                      />
                    </div>
                  )}
                  {ev.riwayat.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-line pt-2">
                      {ev.riwayat.map((h, i) => (
                        <li key={i} className="text-[11px] text-soft">
                          <span className="text-muted">{h.at ? new Date(h.at).toLocaleString("id-ID") : "—"}</span> · {h.user ?? "tim audit"} ·{" "}
                          {Object.entries(h.changes ?? {})
                            .map(([k, [, b]]) => `${k} → ${String(b)}`)
                            .join("; ")}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Step>

              <Step n={2} title="Rekonsiliasi: klaim vs pemakaian alat (pipeline IoT)" color={TINGKAT_COLOR[t.tingkat]}>
                <Formula ev={ev} />
              </Step>

              <Step n={3} title={`Bukti alat: daya listrik ${t.tanggal} — ${ev.sumber?.bacaan ?? "Time Series, tiap 2 menit"}`} color="#2dd4bf">
                {ev.sumber?.tier === "Ringkasan edge" && (
                  <p className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2 text-[11px] text-soft">
                    RS ini mengirim satu ringkasan per alat per hari (dihitung gateway-nya). Untuk temuan ini, bacaan 2 menit hari itu ditarik dari arsip gateway RS;
                    siklus yang terlihat harus sama dengan ringkasan yang diterima pipeline (lihat langkah 5).
                  </p>
                )}
                {ev.alat.map((d) => (
                  <div key={d.id_alat} className="rounded-lg border border-line bg-panel p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{d.nama_alat}</span>
                      <span className="text-muted">
                        {d.id_alat} · meter {d.id_meter ?? "—"} · gateway {d.id_gateway ?? "—"} · {d.merek_model}
                      </span>
                      {d.status_operasi && <Badge text={`sekarang: ${d.status_operasi}`} color="#2dd4bf" />}
                    </div>
                    <PowerChart d={d} day={t.tanggal} />
                    {d.pemakaian && (
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-6">
                        {[
                          ["Siklus tindakan", fmt(d.pemakaian.siklus)],
                          ["Menit menyala", fmt(d.pemakaian.menit_menyala)],
                          ["Energi aktif", `${fmt(d.pemakaian.energi_aktif_wh / 1000, 2)} kWh`],
                          ["Menit-mesin", fmt(d.pemakaian.mesin_menit)],
                          ["Kelengkapan", `${fmt(d.pemakaian.kelengkapan * 100, 1)} %`],
                          ["Jam nyala", d.pemakaian.jam_nyala_pertama != null ? `${d.pemakaian.jam_nyala_pertama}:00–${d.pemakaian.jam_nyala_terakhir}:59` : "—"],
                        ].map(([l, val]) => (
                          <div key={l} className="rounded bg-ink px-2 py-1">
                            <div className="text-muted">{l}</div>
                            <div className="font-semibold tabular-nums">{val}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {d.sesi.length > 0 && (
                      <details className="mt-2 text-[11px]">
                        <summary className="cursor-pointer text-muted">{d.sesi.length} siklus (sesi_alat) — mulai, durasi, daya puncak, energi</summary>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {d.sesi.map((s) => (
                            <span key={s.id_sesi} className="rounded bg-ink px-1.5 py-0.5 font-mono" title={s.id_sesi}>
                              {s.mulai.slice(11)} · {s.menit} mnt · {fmt(s.puncak_w)} W{s.energi_wh ? ` · ${fmt(s.energi_wh)} Wh` : ""}
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                ))}
                {ev.alat.length === 0 && <p className="rounded-lg border border-bad/40 bg-bad/5 p-3 text-xs text-bad">Faskes tidak punya {t.jenis_alat} di register ASPAK — tidak ada alat yang bisa menghasilkan tindakan ini.</p>}
              </Step>

              <Step n={4} title={`Klaim yang diajukan: ${ev.tindakan.length} baris tindakan — ${ev.sumber?.klaim ?? "e-Klaim, sudah dibersihkan"}`} color="#fb923c">
                <div className="grid gap-2 md:grid-cols-[260px_1fr]">
                  <div className="space-y-1 rounded-lg border border-line bg-panel p-2 text-xs">
                    <div className="text-[10.5px] text-muted">Per dokter pengaju</div>
                    {ev.per_dokter.map((d) => (
                      <div key={d.id_dokter} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate" title={d.id_dokter}>
                          {d.nama ?? d.id_dokter}
                        </span>
                        <span className="tabular-nums">{d.jumlah}×</span>
                        <span className="w-16 text-right tabular-nums text-muted">{juta(d.nilai_rp)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-line bg-panel">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-panel text-left text-muted">
                        <tr>
                          <th className="px-2 py-1">No. SEP</th>
                          <th className="px-2 py-1">ICD-9-CM</th>
                          <th className="px-2 py-1">Tindakan</th>
                          <th className="px-2 py-1">Dokter</th>
                          <th className="px-2 py-1 text-right">Tarif</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ev.tindakan.map((x) => (
                          <tr key={x.id_baris} className="border-t border-line/50">
                            <td className="px-2 py-1 font-mono">{x.no_sep}</td>
                            <td className="px-2 py-1 font-mono">{x.kode_icd9}</td>
                            <td className="px-2 py-1">{x.nama_tindakan}</td>
                            <td className="px-2 py-1">{x.nama_dokter ?? x.id_dokter}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{fmt(x.tarif_rs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Step>

              <Step n={5} title="Data mentah: seperti yang diterima dari gateway IoT dan e-Klaim" color="#94a3b8">
                {ev.sumber?.tier === "Ringkasan edge" ? (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {apps?.raw_edge && (
                      <Link href={`/datasets/${apps.raw_edge}`} className={link}>
                        raw/iot_nasional/ringkasan_edge_harian
                      </Link>
                    )}
                    {apps?.raw_klaim && (
                      <Link href={`/datasets/${apps.raw_klaim}`} className={link}>
                        raw/iot_nasional/klaim_harian_eklaim
                      </Link>
                    )}
                    {apps?.pipeline_nasional && (
                      <Link href={`/pipeline/${apps.pipeline_nasional}`} className={link}>
                        Pipeline IoT jejaring nasional
                      </Link>
                    )}
                    {apps?.sync_nasional && (
                      <Link href={`/time-series/${apps.sync_nasional}`} className={link}>
                        Time series pemakaian harian
                      </Link>
                    )}
                    {apps?.raw_edge && (
                      <Link href={`/lineage?node=${encodeURIComponent(`dataset:${apps.raw_edge}`)}`} className={link}>
                        Lineage dari data mentah
                      </Link>
                    )}
                  </div>
                ) : (
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {apps?.raw.daya_listrik_alat_iot && (
                    <Link href={`/datasets/${apps.raw.daya_listrik_alat_iot}`} className={link}>
                      raw/iot/daya_listrik_alat_iot
                    </Link>
                  )}
                  {apps?.raw.klaim_tindakan_penunjang && (
                    <Link href={`/datasets/${apps.raw.klaim_tindakan_penunjang}`} className={link}>
                      raw/iot/klaim_tindakan_penunjang
                    </Link>
                  )}
                  {apps?.pipeline && (
                    <Link href={`/pipeline/${apps.pipeline}`} className={link}>
                      Pipeline IoT (logika pembersihan & rekonsiliasi)
                    </Link>
                  )}
                  {apps?.sync && (
                    <Link href={`/time-series/${apps.sync}`} className={link}>
                      Time series sync
                    </Link>
                  )}
                  {apps?.raw.daya_listrik_alat_iot && (
                    <Link href={`/lineage?node=${encodeURIComponent(`dataset:${apps.raw.daya_listrik_alat_iot}`)}`} className={link}>
                      Lineage dari data mentah
                    </Link>
                  )}
                </div>
                )}
                {ev.mentah.ringkasan_edge && ev.mentah.ringkasan_edge.length > 0 && (
                  <div className="rounded-lg border border-sky-500/30 bg-panel p-2">
                    <div className="mb-1 text-[11px] font-medium">Ringkasan edge seperti diterima pipeline (raw/iot_nasional/ringkasan_edge_harian)</div>
                    <div className="overflow-x-auto">
                      <table className="w-full font-mono text-[10.5px]">
                        <thead className="text-left text-muted">
                          <tr>
                            {Object.keys(ev.mentah.ringkasan_edge[0]).map((k) => (
                              <th key={k} className="px-1">
                                {k}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ev.mentah.ringkasan_edge.map((r, i) => (
                            <tr key={i}>
                              {Object.values(r).map((v, j) => (
                                <td key={j} className="px-1">
                                  {JSON.stringify(v)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <div className="grid gap-2 lg:grid-cols-2">
                  <div className="rounded-lg border border-line bg-panel p-2">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="font-medium">{ev.sumber?.tier === "Ringkasan edge" ? "Bacaan meter (arsip gateway)" : "Bacaan meter"}</span>
                      <span className="text-muted">{fmt(ev.mentah.bacaan_total)} baris hari itu</span>
                      {ev.mentah.bacaan_duplikat > 0 && <Badge text={`${ev.mentah.bacaan_duplikat} dikirim ulang`} color="#f59e0b" />}
                      {ev.mentah.bacaan_glitch > 0 && <Badge text={`${ev.mentah.bacaan_glitch} glitch`} color="#ef4444" />}
                      {ev.mentah.id_huruf_kecil > 0 && <Badge text={`${ev.mentah.id_huruf_kecil} id huruf kecil`} color="#a78bfa" />}
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      <table className="w-full font-mono text-[10.5px]">
                        <thead className="sticky top-0 bg-panel text-left text-muted">
                          <tr>
                            <th className="px-1">waktu_lokal</th>
                            <th className="px-1">id_meter</th>
                            <th className="px-1 text-right">daya_watt</th>
                            <th className="px-1 text-right">ts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(allRaw ? ev.mentah.bacaan : ev.mentah.bacaan.slice(0, 24)).map((r, i) => (
                            <tr key={i} className={r.daya_watt == null || r.daya_watt < 0 ? "text-bad" : r.id_meter !== r.id_meter.toUpperCase() ? "text-violet-300" : ""}>
                              <td className="px-1">{r.waktu_lokal}</td>
                              <td className="px-1">{JSON.stringify(r.id_meter)}</td>
                              <td className="px-1 text-right">{r.daya_watt == null ? "null" : r.daya_watt}</td>
                              <td className="px-1 text-right text-muted">{r.ts}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {ev.mentah.bacaan.length > 24 && (
                      <button type="button" onClick={() => setAllRaw((x) => !x)} className="mt-1 text-[11px] text-ocean hover:underline">
                        {allRaw ? "Lebih sedikit" : `Tampilkan ${ev.mentah.bacaan.length} baris pertama`}
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg border border-line bg-panel p-2">
                    <div className="mb-1 flex items-center gap-2 text-[11px]">
                      <span className="font-medium">Baris klaim mentah</span>
                      <span className="text-muted">{ev.mentah.klaim_total} baris (kode apa adanya)</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      <table className="w-full font-mono text-[10.5px]">
                        <thead className="sticky top-0 bg-panel text-left text-muted">
                          <tr>
                            <th className="px-1">no_sep</th>
                            <th className="px-1">kode_faskes</th>
                            <th className="px-1">kode_icd9</th>
                            <th className="px-1">id_dokter</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ev.mentah.klaim.map((r, i) => (
                            <tr key={i}>
                              <td className="px-1">{String(r.no_sep)}</td>
                              <td className="px-1">{JSON.stringify(r.kode_faskes)}</td>
                              <td className={`px-1 ${String(r.kode_icd9).includes(".") && String(r.kode_icd9).trim() === r.kode_icd9 ? "" : "text-violet-300"}`}>{JSON.stringify(r.kode_icd9)}</td>
                              <td className="px-1">{String(r.id_dokter)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-muted">
                  Ungu = format yang dirapikan pipeline (id huruf kecil, kode “8744” / spasi); merah = glitch sensor yang dibuang; baris kembar = kiriman ulang gateway yang digabung.
                </p>
              </Step>
            </>
          )}
        </div>
      </div>
    </>
  );
}
