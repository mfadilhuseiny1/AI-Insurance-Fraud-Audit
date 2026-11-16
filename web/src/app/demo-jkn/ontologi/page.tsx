"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { LineageDiagram, type PipeGraph } from "@/components/demo/LineageDiagram";
import { IotSection, type IotOverview } from "@/components/demo/IotSection";
import { MlSection, type MlOverview } from "@/components/demo/MlSection";
import { OntologyDiagram, type OntAction, type OntFunction, type OntLink, type OntNode } from "@/components/demo/OntologyDiagram";
import { API_URL } from "@/lib/api";

type Summary = {
  faskes: number;
  per_status: Record<string, number>;
  potensi_kerugian_rp: number;
  pengembalian_rp: number;
  kasus: number;
  klaim_berisiko: number;
  dokter_terlibat: number;
  self_referral_dokter: number;
  kasus_per_jenis: { jenis: string; kasus: number; klaim: number; nilai: number }[];
  top_faskes: { kode: string; nama: string; jenis: string; status_audit: string; skor_risiko: number; indikasi_utama: string; potensi_kerugian_rp: number }[];
  subkategori: string[];
};
type Build = { id: string; status: string; created_at?: string; finished_at?: string; error?: string | null } | null;
type Decision = { type: string; type_id: string; pk: string; title: string; properties: Record<string, unknown>; at: string };
type Data = {
  summary: Summary;
  decisions?: Decision[];
  ml?: MlOverview | null;
  object_types: OntNode[];
  link_types: OntLink[];
  action_types: OntAction[];
  functions: OntFunction[];
  pipeline: { id: string | null; name: string; raw: string[]; outputs: string[]; rows: Record<string, number>; sql: Record<string, string>; build: Build; graph?: PipeGraph; backs?: Record<string, string> };
  project_id?: string | null;
  functions_repo_id?: string | null;
  apps: { map?: string; graph_alur?: string; graph_aliran?: string; template?: string; graph_ops?: string; workshop?: string };
  iot?: IotOverview | null;
};

const STATUS_COLOR: Record<string, string> = {
  Sehat: "#22c55e",
  "Perlu Pemantauan": "#facc15",
  "Ada Indikasi Fraud": "#f97316",
  "Dalam Investigasi": "#ef4444",
  "Selesai Diaudit": "#a78bfa",
};
const juta = (v: number) => (v >= 1e9 ? `Rp ${(v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M` : `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", credentials: "include", ...init });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

/**
 * Demo for the JKN judges: the facility audit as an operational ontology, end to end — raw BPJS data, the pipeline
 * that cleans and scores it, the Ontology it backs (nodes, relations, actions, functions) and the apps on top
 * (api/demo_jkn_e2e.py). Everything links to the real resource.
 */
export default function OntologiJknPage() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Data>("/api/demo/jkn/e2e/ontology").then((x) => (setD(x), setErr(null)), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const build = async () => {
    setBusy(true);
    try {
      await api("/api/demo/jkn/e2e", { method: "POST" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = !!d && d.object_types.some((t) => t.dataset) && !!d.pipeline.id;
  const s = d?.summary;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 p-6 text-sm">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/demo-jkn" className="text-xs text-muted hover:text-white">← Demo JKN</Link>
            <Link href="/demo-jkn/audit" className="text-xs text-warn hover:underline">Ruang kerja audit →</Link>
            <Link href="/lineage?graph=jknaudit" className="text-xs text-ocean hover:underline">Data lineage →</Link>
            <Link href="/demo-jkn/audit?tab=iot" className="text-xs text-teal-300 hover:underline">IoT alat medis →</Link>
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">Demo · data fiktif</span>
            <button type="button" onClick={build} disabled={busy} className={`${buttonClass.secondary} ml-auto`}>
              <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Membangun…" : ready ? "Perbarui demo" : "Bangun demo end-to-end"}
            </button>
          </div>
          <h1 className="mt-2 text-2xl font-semibold">Nexus Operasional Audit Faskes JKN</h1>
          <p className="mt-1 max-w-4xl text-muted">
            Dari data mentah BPJS sampai keputusan tim audit, dalam satu model: <b className="text-soft">node</b> (faskes, kasus, dokter, klaim),{" "}
            <b className="text-soft">relasi</b> di antaranya, <b className="text-soft">function</b> yang menghitung dan menjelaskan risiko, dan{" "}
            <b className="text-soft">action</b> yang mencatat keputusan. Setiap angka di halaman ini berasal dari objek Nexus yang diisi pipeline — klik untuk membuka
            sumbernya.
          </p>
          {err && <p className="mt-2 text-xs text-bad">{err}</p>}
        </header>

        {s && s.faskes > 0 && (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Faskes dipantau" value={s.faskes.toLocaleString("id-ID")} />
            <Kpi label="Ada indikasi fraud" value={String(s.per_status["Ada Indikasi Fraud"] ?? 0)} color={STATUS_COLOR["Ada Indikasi Fraud"]} />
            <Kpi label="Dalam investigasi" value={String(s.per_status["Dalam Investigasi"] ?? 0)} color={STATUS_COLOR["Dalam Investigasi"]} />
            <Kpi label="Kasus rujukan berisiko" value={`${s.kasus} · ${s.klaim_berisiko.toLocaleString("id-ID")} klaim`} />
            <Kpi label="Dokter terlibat" value={`${s.dokter_terlibat} · ${s.self_referral_dokter} self-referral`} />
            <Kpi label="Potensi kerugian" value={juta(s.potensi_kerugian_rp)} color="#ef4444" hint={`dikembalikan ${juta(s.pengembalian_rp)}`} />
          </section>
        )}

        {d && <Flow d={d} />}

        <section className="space-y-2">
          <SectionTitle n={2} title="Peta Nexus" sub="Model operasional yang dipakai semua aplikasi. Klik sebuah node untuk melihat properti, data pendukung, action dan function-nya." />
          {d ? <OntologyDiagram nodes={d.object_types} links={d.link_types} actions={d.action_types} functions={d.functions} /> : <p className="text-muted">Memuat…</p>}
        </section>

        {d && s && s.faskes > 0 && <Walkthrough d={d} />}

        {d?.decisions && d.decisions.length > 0 && (
          <section className="space-y-2">
            <SectionTitle n={4} title="Keputusan tim audit (action log)" sub="Diambil lewat action; tercatat di riwayat edit objek dan tetap berlaku walau pipeline membangun ulang data." />
            <ul className="grid gap-2 md:grid-cols-3">
              {d.decisions.map((x) => (
                <li key={`${x.type_id}:${x.pk}`} className="rounded-xl border border-warn/30 bg-panel p-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-warn/15 px-1 text-warn">⚡</span>
                    <Link href={`/ontology/${x.type_id}?tab=objects`} className="truncate font-semibold hover:underline">{x.title}</Link>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted">{x.type.replace(/\s*\(demo\)\s*$/, "")} · {x.at ? new Date(x.at).toLocaleString("id-ID") : ""}</div>
                  <dl className="mt-1.5 space-y-1">
                    {Object.entries(x.properties).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-[10px] text-muted">{k.replace(/_/g, " ")}</dt>
                        <dd className="break-words">{String(v ?? "—")}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        )}

        {s && s.kasus_per_jenis.length > 0 && (
          <section className="space-y-2">
            <SectionTitle n={5} title="Cakupan 20 subkategori Efisiensi Risiko" sub="Kasus yang ditemukan aturan skrining per subkategori (dari objek Kasus Rujukan Berisiko)." />
            <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
              <div className="overflow-x-auto rounded-xl border border-line bg-panel">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr className="border-b border-line">
                      <th className="px-3 py-2 font-medium">Subkategori</th>
                      <th className="px-3 py-2 text-right font-medium">Kasus</th>
                      <th className="px-3 py-2 text-right font-medium">Klaim</th>
                      <th className="px-3 py-2 font-medium">Nilai klaim</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.kasus_per_jenis.map((r) => {
                      const max = s.kasus_per_jenis[0]?.nilai || 1;
                      return (
                        <tr key={r.jenis} className="border-b border-line/60 last:border-0">
                          <td className="px-3 py-1.5">{r.jenis}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.kasus}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.klaim.toLocaleString("id-ID")}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <div className="h-2 rounded bg-ocean/70" style={{ width: `${Math.max(2, (r.nilai / max) * 140)}px` }} />
                              <span className="tabular-nums text-muted">{juta(r.nilai)}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(() => {
                  const found = new Set(s.kasus_per_jenis.map((r) => r.jenis.toLowerCase()));
                  const missing = s.subkategori.filter((x) => !found.has(x.toLowerCase()));
                  return missing.length > 0 ? (
                    <div className="border-t border-line px-3 py-2 text-[11px] text-muted">
                      <span className="font-medium text-soft">{s.subkategori.length - missing.length} dari {s.subkategori.length} subkategori punya kasus.</span>{" "}
                      Belum muncul di data demo ini (aturan skrining semua 20 subkategori ada di repositori &quot;Deteksi Risiko JKN (demo)&quot;): {missing.join(" · ")}.
                    </div>
                  ) : null;
                })()}
              </div>
              <div className="rounded-xl border border-line bg-panel p-3 text-xs">
                <div className="mb-1 font-semibold">Faskes dengan skor tertinggi</div>
                <ul className="space-y-1.5">
                  {s.top_faskes.map((f) => (
                    <li key={f.kode} className="flex items-center gap-2">
                      <span className="w-7 shrink-0 rounded text-center font-semibold tabular-nums" style={{ background: `${STATUS_COLOR[f.status_audit]}26`, color: STATUS_COLOR[f.status_audit] }}>
                        {f.skor_risiko}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{f.nama}</span>
                        <span className="block truncate text-[10px] text-muted">{f.status_audit} · {f.indikasi_utama || "-"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {d?.ml && d.ml.top.length > 0 && <MlSection ml={d.ml} />}
        {d?.iot && <IotSection n={7} iot={d.iot} />}

        {d?.pipeline.id && (
          <section className="space-y-2">
            <SectionTitle n={8} title="Transparansi: SQL pipeline" sub="Logika skrining tidak tersembunyi — ini query yang dijalankan Pipeline Builder setiap build." />
            {Object.entries(d.pipeline.sql).map(([name, sql]) => (
              <details key={name} className="rounded-xl border border-line bg-panel">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                  {name} {d.pipeline.rows[name] ? <span className="text-muted">· {d.pipeline.rows[name].toLocaleString("id-ID")} baris</span> : null}
                </summary>
                <pre className="max-h-96 overflow-auto border-t border-line bg-ink p-3 text-[11px] leading-relaxed text-soft">{sql}</pre>
              </details>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ocean/20 text-[11px] text-ocean">{n}</span>
        {title}
      </h2>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}

function Kpi({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums" style={color ? { color } : undefined}>{value}</div>
      {hint && <div className="text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

/** The end-to-end chain as six stages, each opening the resource it stands for. */
function Flow({ d }: { d: Data }) {
  const raw = d.pipeline.raw.reduce((a, k) => a + (d.pipeline.rows[k] ?? 0), 0);
  const clean = d.pipeline.outputs.reduce((a, k) => a + (d.pipeline.rows[k] ?? 0), 0);
  const b = d.pipeline.build;
  const stages: { icon: Parameters<typeof Icon>[0]["name"]; title: string; body: string; foot: string; href?: string; color: string }[] = [
    { icon: "database", title: "Data mentah", body: "14 ekspor BPJS: Aplicares, geocoding, HFIS, SIP, klaim bulanan, skrining e-Klaim / P-Care / susulan, keputusan audit, aturan, ICD-10.", foot: `${d.pipeline.raw.length} tabel · ${raw.toLocaleString("id-ID")} baris`, href: d.project_id ? `/files/${d.project_id}` : undefined, color: "#38bdf8" },
    { icon: "pipeline", title: "Pipeline", body: "Pembersihan, union backfill, join referensi, dedup SEP, skor risiko, kasus per surat rujukan, 5 cabang analitik. Cek kualitas; jalan otomatis saat data berubah.", foot: `${d.pipeline.graph?.nodes.length ?? 0} node · build: ${b?.status ?? "-"}`, href: d.pipeline.id ? `/pipeline/${d.pipeline.id}` : undefined, color: "#0ea5e9" },
    { icon: "table", title: "Dataset output", body: "3 dataset inti (faskes, kasus, dokter) untuk Nexus + 5 dataset analitik (detail klaim, tren, kantor cabang, jejaring, peringkat).", foot: `${d.pipeline.outputs.length} dataset · ${clean.toLocaleString("id-ID")} baris`, href: d.project_id ? `/files/${d.project_id}` : undefined, color: "#22c55e" },
    { icon: "cube", title: "Nexus", body: "Node & relasi: faskes ↔ kasus ↔ dokter, tersambung ke klaim & peringatan JKN. Re-index otomatis tiap build.", foot: `${d.object_types.length} object type · ${d.link_types.length} relasi`, href: "/ontology", color: "#f97316" },
    { icon: "logic", title: "Logika", body: "Functions menjelaskan skor & menelusuri jejaring dokter; actions mencatat keputusan audit (menang atas data).", foot: `${d.functions.length} function · ${d.action_types.length} action`, href: d.functions_repo_id ? `/code-repositories/${d.functions_repo_id}` : "/functions", color: "#a78bfa" },
    { icon: "graph", title: "Aplikasi", body: "Kokpit audit (Workshop), peta faskes + alur rujukan, graph alur kasus di Vertex, template telusur per faskes.", foot: "Kokpit · Peta · Vertex", href: d.apps.workshop ? `/workshop/${d.apps.workshop}` : d.apps.map ? `/map/${d.apps.map}` : undefined, color: "#ef4444" },
  ];
  return (
    <section className="space-y-2">
      <SectionTitle n={1} title="Alur end-to-end" sub="Setiap tahap adalah sumber daya nyata di platform — klik untuk membukanya." />
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
        {stages.map((st, i) => {
          const inner = (
            <div className="relative h-full rounded-xl border border-line bg-panel p-3 transition hover:border-ocean/60">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `${st.color}22`, color: st.color }}>
                  <Icon name={st.icon} className="h-4 w-4" />
                </span>
                <span className="text-[10px] text-muted">{i + 1}</span>
                <span className="font-semibold">{st.title}</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-muted">{st.body}</p>
              <div className="mt-2 text-[11px] font-medium" style={{ color: st.color }}>{st.foot}</div>
              {i < stages.length - 1 && <span className="absolute -right-2 top-1/2 z-10 hidden -translate-y-1/2 text-muted xl:block">›</span>}
            </div>
          );
          return st.href ? <Link key={st.title} href={st.href}>{inner}</Link> : <div key={st.title}>{inner}</div>;
        })}
      </div>
      {d.pipeline.graph && d.pipeline.backs && (
        <div className="space-y-1 pt-2">
          <div className="text-xs font-medium">
            Graph pipeline &amp; lineage — dari 14 sumber data sampai Nexus dan aplikasi{" "}
            <span className="font-normal text-muted">(arahkan kursor untuk menyorot asal-usul dan pemakaian; klik sebuah kotak untuk melihat SQL-nya; geser untuk melihat semuanya)</span>
          </div>
          <LineageDiagram graph={d.pipeline.graph} rows={d.pipeline.rows} backs={d.pipeline.backs} sql={d.pipeline.sql}
            objectCounts={Object.fromEntries(d.object_types.map((t) => [t.name, t.objects]))} />
        </div>
      )}
    </section>
  );
}

/** One facility from detection to decision, with the live explanation function. */
function Walkthrough({ d }: { d: Data }) {
  const fn = d.functions.find((f) => f.name === "alasan_risiko");
  const faskesType = d.object_types.find((t) => /^Faskes Audit/.test(t.name));
  const [kode, setKode] = useState(d.summary.top_faskes.find((f) => f.kode === "RS-01")?.kode ?? d.summary.top_faskes[0]?.kode ?? "RS-01");
  // the explanation of the facility it was run for (a stale answer for another facility is not shown)
  const [out, setOut] = useState<{ kode: string; text?: string; err?: string } | null>(null);
  useEffect(() => {
    if (!fn) return;
    api<{ ok?: boolean; value?: unknown; error?: string }>(`/api/functions/${encodeURIComponent(fn.id)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { faskes: kode } }),
    }).then((r) => setOut(r.ok === false ? { kode, err: r.error ?? "gagal" } : { kode, text: String(r.value ?? "") }), (e: Error) => setOut({ kode, err: e.message }));
  }, [fn, kode]);
  const text = out?.kode === kode ? out.text : undefined;
  const err = out?.kode === kode ? out.err : undefined;
  const f = d.summary.top_faskes.find((x) => x.kode === kode);
  const steps = [
    { t: "Deteksi", b: `Pipeline memberi ${f?.nama ?? kode} skor ${f?.skor_risiko ?? "-"} → status "${f?.status_audit ?? "-"}". Tidak ada yang dihitung manual.` },
    { t: "Jelaskan", b: "Function alasan_risiko menguraikan skor: komponen, jenis kasus, kasus, dokter dan potensi kerugian (di kanan, dijalankan langsung)." },
    { t: "Telusuri", b: "Di Vertex, template menelusuri kasus masuk & keluar, faskes lawan, dokter perujuk dan DPJP — pola self-referral langsung terlihat." },
    { t: "Putuskan", b: "Tim audit memakai action (eskalasi, tetapkan status, tutup audit + pengembalian). Keputusan tercatat dan menang atas data berikutnya." },
    { t: "Ulangi", b: "Data klaim baru masuk → jadwal pipeline membangun ulang → Nexus ter-index ulang → peta & graph ikut berubah." },
  ];
  return (
    <section className="space-y-2">
      <SectionTitle n={3} title="Dari data ke keputusan" sub="Satu faskes ditelusuri lewat ontologi. Pilih faskes lain di daftar." />
      <div className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
        <ol className="space-y-2">
          {steps.map((st, i) => (
            <li key={st.t} className="flex gap-3 rounded-xl border border-line bg-panel p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ocean/20 text-xs font-semibold text-ocean">{i + 1}</span>
              <div>
                <div className="font-semibold">{st.t}</div>
                <div className="text-xs text-muted">{st.b}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-col rounded-xl border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={kode} onChange={(e) => setKode(e.target.value)} className="rounded border border-line-2 bg-ink px-2 py-1 text-xs">
              {d.summary.top_faskes.map((x) => (
                <option key={x.kode} value={x.kode}>{x.nama} ({x.skor_risiko})</option>
              ))}
            </select>
            <span className="text-[11px] text-muted">ƒ alasan_risiko(faskes)</span>
          </div>
          <pre className="mt-2 min-h-40 flex-1 whitespace-pre-wrap rounded border border-line bg-ink p-3 text-xs leading-relaxed text-soft">
            {err ? <span className="text-bad">{err}</span> : text ?? "Menjalankan function…"}
          </pre>
          <div className="mt-2 flex flex-wrap gap-2">
            {d.apps.template && (
              <Link href={`/vertex?template=${d.apps.template}&objects=${encodeURIComponent(kode)}`} className={`${buttonClass.primary} text-xs`}>
                <Icon name="graph" className="h-3.5 w-3.5" /> Telusuri {kode} di Vertex
              </Link>
            )}
            {d.apps.graph_ops && <Link href={`/vertex?graph=${d.apps.graph_ops}`} className={`${buttonClass.secondary} text-xs`}>Semua lapisan (klaim + peringatan)</Link>}
            {d.apps.graph_alur && <Link href={`/vertex?graph=${d.apps.graph_alur}`} className={`${buttonClass.secondary} text-xs`}>Graph alur kasus</Link>}
            {d.apps.graph_aliran && <Link href={`/vertex?graph=${d.apps.graph_aliran}`} className={`${buttonClass.secondary} text-xs`}>Aliran rujukan antar faskes</Link>}
            {d.apps.workshop && <Link href={`/workshop/${d.apps.workshop}`} className={`${buttonClass.secondary} text-xs`}>Kokpit audit (Workshop)</Link>}
            {d.apps.map && <Link href={`/map/${d.apps.map}`} className={`${buttonClass.secondary} text-xs`}>Peta audit</Link>}
            {faskesType && <Link href={`/ontology/${faskesType.id}?tab=objects`} className={`${buttonClass.secondary} text-xs`}>Objek & actions</Link>}
          </div>
        </div>
      </div>
    </section>
  );
}

