"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

export type MlOverview = {
  repo_id: string;
  model_id: string;
  deployment_id: string;
  function_id: string;
  scoring_pipeline_id: string;
  dokter_type_id: string;
  dokter: number;
  status: Record<string, number>;
  experiment: {
    name?: string;
    params?: Record<string, unknown>;
    created_at?: string;
    auroc: {
      detektor: string;
      auroc_embedding: number;
      auroc_onehot: number;
    }[];
  };
  top: {
    id_dokter: string;
    nama: string;
    spesialisasi: string;
    nama_faskes: string;
    skor: number;
    suara: number;
    peringkat: number;
    status: string;
    jumlah_kasus: number;
    alasan: { fitur: string; label: string; kontribusi: number }[];
  }[];
};
type Dist = {
  variabel: string;
  maks_selisih: number;
  kategori: {
    kategori: string;
    porsi_dokter: number;
    porsi_populasi: number;
    selisih_porsi: number;
    klaim: number;
  }[];
}[];

const pct = (v: number) =>
  `${(v * 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
const NEW = "pola baru";

function statusTone(s: string) {
  if (s.includes(NEW))
    return { bg: "#a78bfa26", fg: "#a78bfa", label: "Pola baru" };
  if (s.startsWith("Anomali"))
    return { bg: "#ef444426", fg: "#ef4444", label: "Anomali + kasus" };
  if (s.startsWith("Ada kasus"))
    return { bg: "#f9731626", fg: "#f97316", label: "Kasus, profil wajar" };
  return { bg: "#22c55e1f", fg: "#22c55e", label: "Wajar" };
}

/**
 * Explainable unsupervised anomaly detection (De Meulemeester et al. 2025, with a GAN): the ML chain through the
 * data pipeline, the experiment's AUROC table (embeddings vs one-hot), and the ranked doctors with their votes,
 * Shapley reasons and category distributions against the population.
 */
export function MlSection({ ml }: { ml: MlOverview }) {
  const [pick, setPick] = useState(ml.top[0]?.id_dokter ?? "");
  const [dist, setDist] = useState<{ id: string; rows: Dist } | null>(null);
  useEffect(() => {
    if (!pick) return;
    fetch(
      `${API_URL}/api/demo/jkn/e2e/ml/distribusi/${encodeURIComponent(pick)}`,
      { credentials: "include", cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then(
        (b: { rows: Dist }) => setDist({ id: pick, rows: b.rows }),
        () => setDist({ id: pick, rows: [] }),
      );
  }, [pick]);
  const doc = ml.top.find((d) => d.id_dokter === pick);
  const maxPhi = Math.max(
    0.0001,
    ...(doc?.alasan ?? []).map((a) => a.kontribusi),
  );
  const chain: { t: string; b: string; href: string; color: string }[] = [
    {
      t: "Pipeline audit",
      b: "klaim_sep_bersih + profil_numerik_dokter (jumlah, rata-rata, median, std, min, maks)",
      href: "",
      color: "#0ea5e9",
    },
    {
      t: "Code Repository · fitur",
      b: "Embedding LSA (SVD k=3) tiap variabel kategorikal, dirata-rata per dokter",
      href: `/code-repositories/${ml.repo_id}`,
      color: "#2f855a",
    },
    {
      t: "Code Repository · latih",
      b: "8 detektor tanpa label + GAN (BiGAN/EGBAD); eksperimen AUROC",
      href: `/code-repositories/${ml.repo_id}`,
      color: "#2f855a",
    },
    {
      t: "Model asset",
      b: "Adapter: skor tiap detektor, ensembel, suara, Shapley",
      href: `/model-assets/${ml.model_id}`,
      color: "#805ad5",
    },
    {
      t: "Live deployment",
      b: "Fungsi model skorAnomaliDokterDemo (per baris)",
      href: `/functions/${encodeURIComponent(ml.function_id)}`,
      color: "#805ad5",
    },
    {
      t: "Pipeline skor",
      b: "Langkah fungsi Python memanggil model → peringkat, pola baru, distribusi",
      href: `/pipeline/${ml.scoring_pipeline_id}`,
      color: "#d53f8c",
    },
    {
      t: "Nexus",
      b: "Properti anomali di Dokter & Faskes (datasource kedua)",
      href: `/ontology/${ml.dokter_type_id}?tab=objects`,
      color: "#f97316",
    },
  ];
  const novel = ml.top.filter((d) => d.status.includes(NEW)).length;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ocean/20 text-[11px] text-ocean">
            6
          </span>
          Deteksi anomali tanpa label (machine learning)
        </h2>
        <p className="max-w-5xl text-xs text-muted">
          Aturan skrining menangkap pola fraud yang{" "}
          <b className="text-soft">sudah dikenal</b>. Lapisan ini menangkap yang{" "}
          <b className="text-soft">belum</b>: setiap dokter diprofilkan dari
          klaim per SEP, lalu delapan detektor tanpa label — termasuk GAN —
          menilai seberapa menyimpang profilnya, dan nilai Shapley menjelaskan
          alasannya. Metode mengikuti De Meulemeester dkk.,{" "}
          <i>
            Explainable unsupervised anomaly detection for healthcare insurance
            data
          </i>
          , BMC Med Inform Decis Mak 25:14 (2025), ditambah detektor GAN.
        </p>
      </div>

      <div className="flex flex-wrap items-stretch gap-1.5">
        {chain.map((c, i) => {
          const body = (
            <div className="h-full w-44 rounded-lg border border-line bg-panel p-2 transition hover:border-ocean/60">
              <div
                className="text-[11px] font-semibold"
                style={{ color: c.color }}
              >
                {i + 1}. {c.t}
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-muted">
                {c.b}
              </div>
            </div>
          );
          return (
            <div key={c.t} className="flex items-center gap-1.5">
              {c.href ? <Link href={c.href}>{body}</Link> : body}
              {i < chain.length - 1 && <span className="text-muted">→</span>}
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-line bg-panel p-3 text-xs">
          <div className="font-semibold">
            AUROC per detektor — embedding vs one-hot
          </div>
          <div className="mb-2 text-[10.5px] text-muted">
            Seberapa baik skor menaruh dokter dengan kasus audit di atas yang
            lain (tanpa label saat pelatihan). Eksperimen: {ml.experiment.name}.
          </div>
          <table className="w-full">
            <thead className="text-left text-[10.5px] text-muted">
              <tr>
                <th className="py-1 font-medium">Detektor</th>
                <th className="py-1 font-medium">Embedding</th>
                <th className="py-1 font-medium">One-hot</th>
              </tr>
            </thead>
            <tbody>
              {ml.experiment.auroc.map((r) => (
                <tr
                  key={r.detektor}
                  className={`border-t border-line/60 ${r.detektor.startsWith("Ensembel") ? "font-semibold" : ""}`}
                  style={
                    r.detektor.startsWith("GAN")
                      ? { color: "#a78bfa" }
                      : undefined
                  }
                >
                  <td className="py-1 pr-2">{r.detektor}</td>
                  {[r.auroc_embedding, r.auroc_onehot].map((v, j) => (
                    <td key={j} className="py-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <div
                          className="h-1.5 rounded"
                          style={{
                            width: `${Math.max(2, (v - 0.4) * 140)}px`,
                            background: j === 0 ? "#38bdf8" : "#64748b",
                          }}
                        />
                        <span className="tabular-nums">{v.toFixed(2)}</span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-[10.5px] text-muted">
            Seperti di jurnal, embedding kategorikal mengalahkan one-hot untuk
            semua detektor. {ml.dokter} dokter dinilai; {novel} pola baru di 30
            teratas.
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border border-line bg-panel text-xs">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="font-semibold">Dokter teranomali</span>
              <span className="text-[10.5px] text-muted">
                klik untuk penjelasan
              </span>
              <span className="ml-auto flex gap-2 text-[10px]">
                {Object.entries(ml.status).map(([s, n]) => {
                  const t = statusTone(s);
                  return (
                    <span
                      key={s}
                      className="rounded px-1.5 py-0.5"
                      style={{ background: t.bg, color: t.fg }}
                    >
                      {t.label} {n}
                    </span>
                  );
                })}
              </span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full">
                <tbody>
                  {ml.top.map((d) => {
                    const t = statusTone(d.status);
                    return (
                      <tr
                        key={d.id_dokter}
                        onClick={() => setPick(d.id_dokter)}
                        className={`cursor-pointer border-b border-line/50 ${pick === d.id_dokter ? "bg-ocean/10" : "hover:bg-panel-2"}`}
                      >
                        <td className="w-8 px-2 py-1.5 text-right tabular-nums text-muted">
                          {d.peringkat}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{d.nama}</div>
                          <div className="text-[10px] text-muted">
                            {d.spesialisasi} · {d.nama_faskes}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-16 overflow-hidden rounded bg-line">
                              <div
                                className="h-full"
                                style={{
                                  width: pct(d.skor),
                                  background: "#ef4444",
                                }}
                              />
                            </div>
                            <span className="tabular-nums">
                              {d.skor.toFixed(2)}
                            </span>
                          </div>
                        </td>
                        <td
                          className="px-2 py-1.5"
                          title={`${d.suara} dari 8 detektor menaruhnya di 10% teratas`}
                        >
                          <div className="flex gap-0.5">
                            {Array.from({ length: 8 }, (_, i) => (
                              <span
                                key={i}
                                className="h-2 w-1.5 rounded-sm"
                                style={{
                                  background:
                                    i < d.suara
                                      ? "#ef4444"
                                      : "var(--color-line-2)",
                                }}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <span
                            className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]"
                            style={{ background: t.bg, color: t.fg }}
                          >
                            {t.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-line bg-panel p-3 text-xs lg:grid-cols-3">
        {doc ? (
          <>
            <div>
              <div className="font-semibold">{doc.nama}</div>
              <div className="text-[10.5px] text-muted">
                {doc.spesialisasi} · {doc.nama_faskes} · {doc.jumlah_kasus}{" "}
                kasus audit · skor {doc.skor.toFixed(3)} · {doc.suara}/8 suara
              </div>
              {doc.status.includes(NEW) && (
                <div
                  className="mt-1 rounded border p-1.5 text-[10.5px]"
                  style={{
                    borderColor: "#a78bfa66",
                    background: "#a78bfa1a",
                    color: "#c4b5fd",
                  }}
                >
                  Belum ada kasus aturan untuk dokter ini: pola baru yang layak
                  ditelusuri tim audit (belum tentu fraud).
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 font-medium">
                Mengapa? — nilai Shapley per fitur asli
              </div>
              {doc.alasan.length === 0 && (
                <div className="text-muted">
                  Skor di bawah ambang penjelasan.
                </div>
              )}
              {doc.alasan.map((a) => (
                <div key={a.fitur} className="mb-1 flex items-center gap-2">
                  <span className="w-36 shrink-0 truncate" title={a.label}>
                    {a.label}
                  </span>
                  <div
                    className="h-2 rounded"
                    style={{
                      width: `${(a.kontribusi / maxPhi) * 120}px`,
                      background: "#ef4444",
                    }}
                  />
                  <span className="tabular-nums text-muted">
                    +{a.kontribusi.toFixed(3)}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium">
                Distribusi kategori vs populasi
              </div>
              {!dist || dist.id !== pick ? (
                <div className="text-muted">Memuat…</div>
              ) : dist.rows.length === 0 ? (
                <div className="text-muted">Tidak ada data distribusi.</div>
              ) : (
                dist.rows.slice(0, 3).map((v) => (
                  <div key={v.variabel} className="mb-2">
                    <div className="text-[10.5px] text-muted">{v.variabel}</div>
                    {v.kategori.slice(0, 3).map((k) => (
                      <div
                        key={k.kategori}
                        className="flex items-center gap-1.5 text-[10.5px]"
                      >
                        <span
                          className="w-20 shrink-0 truncate font-mono"
                          title={k.kategori}
                        >
                          {k.kategori}
                        </span>
                        <div className="flex w-32 flex-col gap-0.5">
                          <div
                            className="h-1.5 rounded"
                            style={{
                              width: pct(k.porsi_dokter),
                              background: "#ef4444",
                            }}
                          />
                          <div
                            className="h-1.5 rounded"
                            style={{
                              width: pct(k.porsi_populasi),
                              background: "#64748b",
                            }}
                          />
                        </div>
                        <span className="tabular-nums">
                          {pct(k.porsi_dokter)} vs {pct(k.porsi_populasi)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
              <div className="text-[10px] text-muted">
                <span style={{ color: "#ef4444" }}>■</span> dokter ·{" "}
                <span style={{ color: "#64748b" }}>■</span> seluruh klaim
              </div>
            </div>
          </>
        ) : (
          <div className="text-muted">Pilih dokter.</div>
        )}
      </div>
    </section>
  );
}
