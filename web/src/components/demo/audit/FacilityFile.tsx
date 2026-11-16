"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

export type ActionRef = { id: string; name: string; description: string };
export type OpenAction = (
  kind: "faskes" | "kasus" | "dokter",
  action: ActionRef,
  pk: string,
) => void;

type Kasus = {
  id_kasus: string;
  jenis_kasus: string;
  alur: string;
  faskes_asal: string;
  faskes_tujuan: string;
  nama_dokter_perujuk: string;
  nama_dokter_dpjp: string;
  diagnosa: string;
  jumlah_klaim: number;
  nilai_klaim_rp: number;
  status_kasus: string;
  tindak_lanjut?: string;
  temuan?: string;
};
type Dokter = {
  id_dokter: string;
  nama: string;
  spesialisasi: string;
  nama_faskes: string;
  di_faskes_ini: boolean;
  peran?: string;
  jumlah_kasus: number;
  skor_anomali?: number | null;
  suara_model?: number | null;
  status_anomali?: string | null;
  alasan: { fitur: string; label: string; kontribusi: number }[];
  status_klarifikasi?: string | null;
  praktik_lain?: string;
};
type Klaim = {
  no_sep: string;
  tgl_layanan: string;
  subkategori: string;
  aturan: string;
  bobot: number;
  kode_icd: string;
  diagnosa: string;
  kompetensi_fktp: string;
  nama_faskes_asal: string;
  nama_faskes_tujuan: string;
  nama_dokter_perujuk: string;
  nama_dokter_dpjp: string;
  perujuk_sama_dpjp: string;
  nilai_klaim: number;
};
type Tren = {
  bulan: string;
  jumlah_klaim: number;
  klaim_berisiko: number;
  porsi_berisiko_pct: number;
  rasio_rujukan_pct: number;
  nilai_berisiko: number;
};
type Riwayat = {
  at: string;
  user?: string | null;
  op: string;
  changes: Record<string, [unknown, unknown]>;
  objek: string;
  jenis_objek: string;
};
type File = {
  faskes: Record<string, unknown> & {
    kode: string;
    nama: string;
    status_audit: string;
    prioritas: number;
    tingkat_prioritas: string;
  };
  alasan: string | null;
  kasus: Kasus[];
  dokter: Dokter[];
  klaim: Klaim[];
  klaim_total: number;
  tren: Tren[];
  riwayat: Riwayat[];
  iot: {
    alat: {
      id_alat: string;
      nama_alat: string;
      jenis_alat: string;
      id_meter: string | null;
      status_iot: string;
      status_operasi?: string;
      estimasi_tindakan_total: number;
      klaim_total: number;
      tak_didukung_total: number;
      kelengkapan_pct: number;
    }[];
    temuan: {
      id_temuan: string;
      jenis_alat: string;
      tanggal: string;
      jenis_temuan: string;
      tingkat: string;
      klaim_tindakan: number;
      estimasi_tindakan_alat: number;
      tindakan_tak_didukung: number;
      nilai_tak_didukung_rp: number;
      status_temuan?: string;
    }[];
  } | null;
};

export const STATUS_COLOR: Record<string, string> = {
  Sehat: "#22c55e",
  "Perlu Pemantauan": "#eab308",
  "Ada Indikasi Fraud": "#f97316",
  "Dalam Investigasi": "#ef4444",
  "Selesai Diaudit": "#a78bfa",
};
export const TIER_COLOR: Record<string, string> = {
  P1: "#ef4444",
  P2: "#f97316",
  P3: "#eab308",
  Pantau: "#64748b",
  Selesai: "#a78bfa",
};
export const rupiah = (v: number) =>
  `Rp ${Math.round(v || 0).toLocaleString("id-ID")}`;
export const juta = (v: number) =>
  (v || 0) >= 1e9
    ? `Rp ${(v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M`
    : `Rp ${((v || 0) / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`;

export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ background: `${color}22`, color }}
    >
      {text}
    </span>
  );
}

export function Bar({
  value,
  color,
  width = 64,
}: {
  value: number;
  color: string;
  width?: number;
}) {
  return (
    <span
      className="inline-block h-1.5 overflow-hidden rounded bg-line align-middle"
      style={{ width }}
    >
      <span
        className="block h-full"
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          background: color,
        }}
      />
    </span>
  );
}

export function Votes({ n }: { n: number }) {
  return (
    <span
      className="inline-flex gap-0.5 align-middle"
      title={`${n} dari 8 detektor menaruhnya di 10% teratas`}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          className="h-2 w-1.5 rounded-sm"
          style={{ background: i < n ? "#ef4444" : "var(--color-line-2)" }}
        />
      ))}
    </span>
  );
}

const anomTone = (s?: string | null) =>
  !s
    ? null
    : s.includes("pola baru")
      ? { t: "Pola baru (ML)", c: "#a78bfa" }
      : s.startsWith("Anomali")
        ? { t: "Anomali ML", c: "#ef4444" }
        : null;

function Section({
  title,
  sub,
  children,
  right,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div>
          <div className="text-[13px] font-semibold">{title}</div>
          {sub && <div className="text-[10.5px] text-muted">{sub}</div>}
        </div>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** One facility's audit file: the score and why, trend, cases, doctors (with the anomaly models), claims, decisions. */
export function FacilityFile({
  kode,
  version,
  actions,
  apps,
  onAction,
  onIot,
  onClose,
}: {
  kode: string;
  version: number;
  actions: Record<"faskes" | "kasus" | "dokter", ActionRef[]>;
  apps: {
    template?: string;
    map?: string;
    workshop?: string;
    graph_ops?: string;
  };
  onAction: OpenAction;
  onIot?: (temuanId: string) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<{
    key: string;
    data?: File;
    err?: string;
  } | null>(null);
  const [allClaims, setAllClaims] = useState(false);
  const key = `${kode}:${version}`;
  useEffect(() => {
    let stale = false;
    fetch(
      `${API_URL}/api/demo/jkn/workbench/faskes/${encodeURIComponent(kode)}`,
      { credentials: "include", cache: "no-store" },
    )
      .then(async (r) =>
        r.ok
          ? r.json()
          : Promise.reject(
              new Error(
                (await r.json().catch(() => ({}))).detail ?? r.statusText,
              ),
            ),
      )
      .then(
        (data: File) => !stale && setFile({ key, data }),
        (e: Error) => !stale && setFile({ key, err: e.message }),
      );
    return () => {
      stale = true;
    };
  }, [kode, key]);
  const d = file?.data;
  const loading = !file || (file.key !== key && !d);
  const f = d?.faskes;
  const n = (k: string) => Number(f?.[k] ?? 0);
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[920px] flex-col border-l border-line bg-ink shadow-2xl">
      <div className="flex items-start gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">
              {f?.nama ?? kode}
            </h2>
            {f && (
              <Badge
                text={f.status_audit}
                color={STATUS_COLOR[f.status_audit] ?? "#64748b"}
              />
            )}
            {f && (
              <Badge
                text={`${f.tingkat_prioritas} · prioritas ${f.prioritas}`}
                color={TIER_COLOR[f.tingkat_prioritas] ?? "#64748b"}
              />
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {kode} · {String(f?.jenis ?? "")} · {String(f?.wilayah ?? "")} ·{" "}
            {String(f?.kantor_cabang ?? "")}
            {f?.tim_audit
              ? ` · ${String(f.tim_audit)}${f.tanggal_audit ? `, ${String(f.tanggal_audit)}` : ""}`
              : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.faskes.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.description}
                onClick={() => onAction("faskes", a, kode)}
                className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs font-medium text-warn hover:bg-warn/20"
              >
                ⚡ {a.name}
              </button>
            ))}
            {apps.template && (
              <Link
                href={`/vertex?template=${apps.template}&objects=${encodeURIComponent(kode)}`}
                className="rounded-md border border-line-2 px-2.5 py-1 text-xs hover:border-ocean"
              >
                Telusuri di Vertex
              </Link>
            )}
            {apps.map && (
              <Link
                href={`/map/${apps.map}`}
                className="rounded-md border border-line-2 px-2.5 py-1 text-xs hover:border-ocean"
              >
                Peta
              </Link>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line-2 px-2 py-1 text-sm hover:border-ocean"
          aria-label="Tutup"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
        {file?.err && <p className="text-bad">{file.err}</p>}
        {loading && (
          <p className="text-muted">
            Memuat berkas faskes… (penjelasan skor dijalankan langsung oleh
            function)
          </p>
        )}
        {d && f && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              {[
                [
                  "Skor risiko (aturan)",
                  `${n("skor_risiko")}`,
                  STATUS_COLOR[f.status_audit],
                ],
                [
                  "Anomali ML (dokter maks)",
                  f.skor_anomali_maks != null
                    ? n("skor_anomali_maks").toFixed(2)
                    : "—",
                  "#a78bfa",
                ],
                [
                  "Klaim berisiko",
                  `${n("klaim_berisiko").toLocaleString("id-ID")} / ${n("klaim_3_bulan").toLocaleString("id-ID")}`,
                  undefined,
                ],
                [
                  "Rasio rujukan",
                  `${n("rasio_rujukan_pct").toLocaleString("id-ID")}%`,
                  undefined,
                ],
                ["Potensi kerugian", juta(n("potensi_kerugian_rp")), "#ef4444"],
                ["Dikembalikan", juta(n("pengembalian_rp")), "#22c55e"],
              ].map(([l, v, c]) => (
                <div
                  key={l as string}
                  className="rounded-lg border border-line bg-panel px-2.5 py-2"
                >
                  <div className="text-[10px] text-muted">{l}</div>
                  <div
                    className="mt-0.5 text-sm font-semibold tabular-nums"
                    style={c ? { color: c as string } : undefined}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
              <Section
                title="Mengapa berisiko"
                sub="ƒ alasan_risiko — dihitung dari objek Nexus saat ini"
              >
                <div className="space-y-1 whitespace-pre-wrap leading-relaxed text-soft">
                  {d.alasan ?? "—"}
                </div>
                {f.catatan_audit ? (
                  <div className="mt-2 rounded border border-warn/30 bg-warn/5 p-2 text-[11px]">
                    <b>Catatan tim audit:</b> {String(f.catatan_audit)}
                  </div>
                ) : null}
              </Section>
              <Section
                title="Tren klaim bulanan"
                sub="klaim berisiko menurut faskes penanggung jawab"
              >
                {d.tren.length === 0 ? (
                  <p className="text-muted">—</p>
                ) : (
                  <div className="space-y-2">
                    {d.tren.map((t) => {
                      const max = Math.max(
                        ...d.tren.map((x) => x.porsi_berisiko_pct),
                        1,
                      );
                      return (
                        <div key={t.bulan}>
                          <div className="flex justify-between text-[11px]">
                            <span>{t.bulan}</span>
                            <span className="tabular-nums text-muted">
                              {t.klaim_berisiko} / {t.jumlah_klaim} klaim ·
                              rujukan {t.rasio_rujukan_pct}%
                            </span>
                          </div>
                          <div className="mt-0.5 h-2 overflow-hidden rounded bg-line">
                            <div
                              className="h-full"
                              style={{
                                width: `${(t.porsi_berisiko_pct / max) * 100}%`,
                                background: "#f97316",
                              }}
                            />
                          </div>
                          <div className="text-[10px] text-muted">
                            {t.porsi_berisiko_pct}% klaim berisiko ·{" "}
                            {juta(t.nilai_berisiko)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>
            </div>

            {d.iot && (
              <Section
                title={`Alat medis IoT (${d.iot.alat.length}) · ${d.iot.temuan.filter((t) => t.tingkat === "Tinggi").length} hari temuan`}
                sub="pemakaian listrik alat dicocokkan dengan klaim tindakan penunjang (pilot 14–27 Sep 2026)"
              >
                <div className="grid gap-2 md:grid-cols-2">
                  {d.iot.alat.map((a) => (
                    <div key={a.id_alat} className="rounded-lg bg-ink px-2.5 py-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{a.nama_alat}</span>
                        <span className="ml-auto">
                          <Badge
                            text={a.status_iot}
                            color={a.status_iot === "Ada temuan" ? "#ef4444" : a.status_iot === "Sesuai" ? "#22c55e" : "#f59e0b"}
                          />
                        </span>
                      </div>
                      <div className="text-[10.5px] text-muted">
                        {a.id_meter ?? "tanpa meter"} · status {a.status_operasi ?? "—"} · data {a.kelengkapan_pct} %
                      </div>
                      <div className="text-[10.5px] text-soft">
                        alat {a.estimasi_tindakan_total} tindakan · diklaim {a.klaim_total}
                        {a.tak_didukung_total ? <b className="text-bad"> · {a.tak_didukung_total} tak didukung</b> : null}
                      </div>
                    </div>
                  ))}
                </div>
                {d.iot.temuan.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {d.iot.temuan.map((t) => (
                      <button
                        key={t.id_temuan}
                        type="button"
                        onClick={() => onIot?.(t.id_temuan)}
                        title={`${t.jenis_temuan}: klaim ${t.klaim_tindakan}, alat ${t.estimasi_tindakan_alat}${t.status_temuan && t.status_temuan !== "Baru" ? ` · ${t.status_temuan}` : ""}`}
                        className="rounded border px-1.5 py-0.5 text-[10.5px] hover:bg-panel-2"
                        style={{
                          borderColor: t.tingkat === "Tinggi" ? "#ef444488" : t.tingkat === "Sedang" ? "#f59e0b88" : "#64748b88",
                        }}
                      >
                        {t.jenis_alat} {String(t.tanggal).slice(5, 10)} · {t.klaim_tindakan}/{t.estimasi_tindakan_alat}
                        {t.status_temuan && t.status_temuan !== "Baru" ? " ✓" : ""}
                      </button>
                    ))}
                  </div>
                )}
              </Section>
            )}

            <Section
              title={`Kasus rujukan / klaim berisiko (${d.kasus.length})`}
              sub="dari aturan skrining, satu kasus per surat rujukan"
            >
              {d.kasus.length === 0 ? (
                <p className="text-muted">Tidak ada kasus.</p>
              ) : (
                <table className="w-full">
                  <thead className="text-left text-[10.5px] text-muted">
                    <tr>
                      <th className="pb-1">Kasus</th>
                      <th className="pb-1">Alur & dokter</th>
                      <th className="pb-1 text-right">Klaim</th>
                      <th className="pb-1 text-right">Nilai</th>
                      <th className="pb-1">Status / tindak lanjut</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.kasus.map((k) => (
                      <tr
                        key={k.id_kasus}
                        className="border-t border-line/60 align-top"
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-mono">{k.id_kasus}</div>
                          <div className="text-[10.5px] text-muted">
                            {k.jenis_kasus}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2">
                          <div>{k.alur}</div>
                          <div className="text-[10.5px] text-muted">
                            perujuk {k.nama_dokter_perujuk} → DPJP{" "}
                            {k.nama_dokter_dpjp} · {k.diagnosa}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {k.jumlah_klaim}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {juta(k.nilai_klaim_rp)}
                        </td>
                        <td className="py-1.5 pr-2">
                          <Badge
                            text={k.status_kasus}
                            color={STATUS_COLOR[k.status_kasus] ?? "#64748b"}
                          />
                          {k.tindak_lanjut && (
                            <div className="mt-0.5 text-[10.5px] text-soft">
                              {k.tindak_lanjut}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          {actions.kasus.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => onAction("kasus", a, k.id_kasus)}
                              className="whitespace-nowrap rounded border border-warn/40 px-1.5 py-0.5 text-[10.5px] text-warn hover:bg-warn/10"
                            >
                              ⚡ Tindak lanjut
                            </button>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section
              title={`Dokter (${d.dokter.length})`}
              sub="dokter faskes ini dan dokter di kasusnya · skor anomali dari model ML (8 detektor) dengan alasan Shapley"
            >
              <table className="w-full">
                <thead className="text-left text-[10.5px] text-muted">
                  <tr>
                    <th className="pb-1">Dokter</th>
                    <th className="pb-1">Kasus</th>
                    <th className="pb-1">Anomali ML</th>
                    <th className="pb-1">Alasan utama (Shapley)</th>
                    <th className="pb-1">Klarifikasi</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.dokter.map((x) => {
                    const tone = anomTone(x.status_anomali);
                    return (
                      <tr
                        key={x.id_dokter}
                        className="border-t border-line/60 align-top"
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-medium">{x.nama}</div>
                          <div className="text-[10.5px] text-muted">
                            {x.spesialisasi}
                            {x.di_faskes_ini ? "" : ` · ${x.nama_faskes}`}
                            {x.praktik_lain
                              ? ` · praktik lain: ${x.praktik_lain}`
                              : ""}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2">
                          {x.jumlah_kasus ? (
                            <span>
                              {x.jumlah_kasus}{" "}
                              <span className="text-muted">({x.peran})</span>
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2">
                          {x.skor_anomali != null ? (
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                <Bar
                                  value={x.skor_anomali}
                                  color="#ef4444"
                                  width={48}
                                />
                                <span className="tabular-nums">
                                  {x.skor_anomali.toFixed(2)}
                                </span>
                              </div>
                              <Votes n={x.suara_model ?? 0} />
                              {tone && (
                                <div>
                                  <Badge text={tone.t} color={tone.c} />
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-2">
                          <div className="flex flex-wrap gap-1">
                            {x.alasan.slice(0, 3).map((a) => (
                              <span
                                key={a.fitur}
                                className="rounded bg-panel-2 px-1.5 py-0.5 text-[10.5px]"
                              >
                                {a.label}{" "}
                                <span className="text-muted">
                                  +{a.kontribusi.toFixed(2)}
                                </span>
                              </span>
                            ))}
                            {x.alasan.length === 0 && (
                              <span className="text-muted">—</span>
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-[10.5px]">
                          {x.status_klarifikasi ?? (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right">
                          {actions.dokter.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => onAction("dokter", a, x.id_dokter)}
                              className="whitespace-nowrap rounded border border-warn/40 px-1.5 py-0.5 text-[10.5px] text-warn hover:bg-warn/10"
                            >
                              ⚡ Klarifikasi
                            </button>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>

            <Section
              title={`Klaim berisiko (${d.klaim_total.toLocaleString("id-ID")})`}
              sub="per SEP, dengan aturan skrining dan kompetensi FKTP diagnosisnya"
              right={
                d.klaim.length > 15 && (
                  <button
                    type="button"
                    onClick={() => setAllClaims((v) => !v)}
                    className="text-[11px] text-ocean hover:underline"
                  >
                    {allClaims ? "Ringkas" : `Tampilkan ${d.klaim.length}`}
                  </button>
                )
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap">
                  <thead className="text-left text-[10.5px] text-muted">
                    <tr>
                      <th className="pb-1 pr-2">SEP</th>
                      <th className="pb-1 pr-2">Tanggal</th>
                      <th className="pb-1 pr-2">Temuan (aturan)</th>
                      <th className="pb-1 pr-2">Diagnosis</th>
                      <th className="pb-1 pr-2">Alur</th>
                      <th className="pb-1 pr-2">Dokter</th>
                      <th className="pb-1 text-right">Nilai</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(allClaims ? d.klaim : d.klaim.slice(0, 15)).map((c) => (
                      <tr key={c.no_sep} className="border-t border-line/60">
                        <td className="py-1 pr-2 font-mono text-[10.5px]">
                          {c.no_sep}
                        </td>
                        <td className="py-1 pr-2">{c.tgl_layanan}</td>
                        <td className="py-1 pr-2">
                          {c.subkategori}{" "}
                          <span className="text-muted">
                            ({c.aturan}, bobot {c.bobot})
                          </span>
                        </td>
                        <td className="py-1 pr-2">
                          {c.diagnosa}{" "}
                          {c.kompetensi_fktp === "Ya" && (
                            <Badge text="kompetensi FKTP" color="#eab308" />
                          )}
                        </td>
                        <td className="py-1 pr-2">
                          {c.nama_faskes_asal} → {c.nama_faskes_tujuan}
                        </td>
                        <td className="py-1 pr-2">
                          {c.nama_dokter_perujuk}
                          {c.perujuk_sama_dpjp === "Ya" ? (
                            <>
                              {" "}
                              <Badge text="perujuk = DPJP" color="#ef4444" />
                            </>
                          ) : (
                            <> → {c.nama_dokter_dpjp}</>
                          )}
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          {rupiah(Number(c.nilai_klaim))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section
              title="Riwayat keputusan"
              sub="riwayat edit objek faskes dan kasusnya (dari actions tim audit)"
            >
              {d.riwayat.length === 0 ? (
                <p className="text-muted">
                  Belum ada keputusan untuk faskes ini.
                </p>
              ) : (
                <ol className="space-y-2">
                  {d.riwayat.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-warn" />
                      <div>
                        <div className="text-[11px]">
                          <b>
                            {r.jenis_objek} {r.objek}
                          </b>{" "}
                          <span className="text-muted">
                            ·{" "}
                            {r.at ? new Date(r.at).toLocaleString("id-ID") : ""}
                            {r.user ? ` · ${r.user}` : ""}
                          </span>
                        </div>
                        <div className="text-[10.5px] text-soft">
                          {Object.entries(r.changes || {}).map(
                            ([k, [, after]]) => (
                              <div key={k}>
                                <span className="text-muted">
                                  {k.replace(/_/g, " ")}:
                                </span>{" "}
                                {String(after ?? "—")}
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
