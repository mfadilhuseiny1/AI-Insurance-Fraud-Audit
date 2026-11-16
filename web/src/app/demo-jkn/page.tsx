"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { JknOntologyDemo } from "@/components/demo/JknOntologyDemo";

type Finding = { kategori_no: number; kategori: string; referensi: string; faskes: string; nilai_risiko: number; alasan: string };
type Demo = {
  status: "none" | "creating" | "ready" | "failed";
  error?: string | null;
  project_id?: string;
  repo_id?: string;
  findings_dataset_id?: string | null;
  tables?: Record<string, number>;
  builds?: { transform: string; status: string; error: string | null }[];
  created_at?: string;
  categories: { no: number; kategori: string; temuan: number; nilai_risiko: number; planted: number }[];
  findings: Finding[];
};

const rupiah = (v: number) => `Rp${Math.round(v).toLocaleString("id-ID")}`;

async function call(method = "GET"): Promise<Demo> {
  const res = await fetch(`${API_URL}/api/demo/jkn`, { method, cache: "no-store" });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Demo: JKN facility risk audit (api/demo_jkn.py) — synthetic hospital records screened for the 20 risk categories. */
export default function DemoJknPage() {
  const [demo, setDemo] = useState<Demo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cat, setCat] = useState<number | null>(null);
  const load = useCallback(() => call().then((d) => (setDemo(d), setErr(null)), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (demo?.status !== "creating") return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [demo?.status, load]);
  const create = async () => {
    if (demo?.status === "ready" && !(await confirmDialog({ title: "Recreate the demo?", message: "The demo records are generated again and the rules rebuilt.", confirmLabel: "Recreate" }))) return;
    call("POST").then(setDemo, (e: Error) => setErr(e.message));
  };
  const total = useMemo(() => (demo?.findings ?? []).reduce((a, f) => a + f.nilai_risiko, 0), [demo]);
  const shown = (demo?.findings ?? []).filter((f) => cat === null || f.kategori_no === cat);
  const built = demo?.builds?.filter((b) => b.status === "succeeded").length ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6 text-sm">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-xl font-semibold">Audit Risiko Fasilitas Kesehatan JKN</h1>
          <span className="rounded bg-warn/15 px-1.5 py-0.5 text-xs text-warn">Demo · data fiktif</span>
          <button type="button" disabled={demo?.status === "creating"} onClick={create} className={`${buttonClass.primary} ml-auto`}>
            <Icon name={demo?.status === "creating" ? "refresh" : "play"} className={`h-3.5 w-3.5 ${demo?.status === "creating" ? "animate-spin" : ""}`} />
            {demo?.status === "creating" ? "Membuat demo…" : demo?.status === "ready" ? "Buat ulang demo" : "Buat demo"}
          </button>
        </div>
        <p className="mb-4 max-w-4xl text-xs text-muted">
          Catatan sintetis RSUD Contoh Sejahtera, sebuah RS swasta, klinik utama dan tiga FKTP (September 2026): SEP / klaim INA-CBG, rujukan, kehadiran, log kamar dan
          tindakan, resep dan penyerahan obat, harga e-katalog, hasil lab dengan log perubahan, dana kapitasi dan klaim nonkapitasi. Aturan skrining untuk 20 subkategori
          Efisiensi Risiko pada Fasilitas Kesehatan berjalan sebagai Python transforms di Code Repository, sehingga setiap temuan dapat ditelusuri ke data sumber dan
          riwayat build-nya. Temuan adalah kasus untuk diverifikasi (telaah rekam medis), bukan kesimpulan.
        </p>
        <Link href="/demo-jkn/fraud" className="mb-3 flex items-center gap-3 rounded-xl border border-bad/40 bg-bad/10 p-4 hover:border-bad">
          <Icon name="alert" className="h-5 w-5 shrink-0 text-bad" />
          <span className="min-w-0">
            <span className="block font-semibold">Fraud Intelligence — menutup 6 pain point investigasi</span>
            <span className="block text-xs text-muted">Alert menjadi kasus investigasi, graf kolusi banyak pihak, validasi billing, skor explainable + peer benchmark, skrining pre-payment, dan aturan berversi.</span>
          </span>
          <span className="ml-auto text-bad">→</span>
        </Link>
        <Link href="/demo-jkn/audit" className="mb-3 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4 hover:border-warn">
          <Icon name="table" className="h-5 w-5 shrink-0 text-warn" />
          <span className="min-w-0">
            <span className="block font-semibold">Ruang kerja audit faskes — untuk tim audit JKN</span>
            <span className="block text-xs text-muted">Antrian prioritas (aturan skrining + model anomali), berkas lengkap per faskes, dokter dengan pola baru, kasus, dan keputusan lewat action.</span>
          </span>
          <span className="ml-auto text-warn">→</span>
        </Link>
        <Link href="/demo-jkn/ontologi" className="mb-5 flex items-center gap-3 rounded-xl border border-ocean/40 bg-ocean/10 p-4 hover:border-ocean">
          <Icon name="graph" className="h-5 w-5 shrink-0 text-ocean" />
          <span className="min-w-0">
            <span className="block font-semibold">Nexus operasional audit faskes — end to end</span>
            <span className="block text-xs text-muted">Data mentah → pipeline → Nexus (node, relasi, action, function) → peta & Vertex, dengan diagram Nexus dan penjelasan risiko per faskes.</span>
          </span>
          <span className="ml-auto text-ocean">→</span>
        </Link>
        <Link href="/demo-jkn/arsitektur" className="mb-3 flex items-center gap-3 rounded-xl border border-violet-500/40 bg-violet-500/10 p-4 hover:border-violet-400">
          <Icon name="layers" className="h-5 w-5 shrink-0 text-violet-300" />
          <span className="min-w-0">
            <span className="block font-semibold">Arsitektur sistem — JKN Healthcare System Intelligence end to end</span>
            <span className="block text-xs text-muted">Sumber data → penyimpanan → pipeline → dataset bersih → Nexus → kecerdasan (aturan, ML, IoT, Orbis) → aplikasi, dengan lineage dan tata kelola di setiap lapisan — angka langsung dari platform.</span>
          </span>
          <span className="ml-auto text-violet-300">→</span>
        </Link>
        <Link href="/lineage?graph=jknaudit" className="mb-5 flex items-center gap-3 rounded-xl border border-line-2 bg-panel p-4 hover:border-ocean">
          <Icon name="split" className="h-5 w-5 shrink-0 text-ocean" />
          <span className="min-w-0">
            <span className="block font-semibold">Data lineage audit faskes — dari file mentah sampai aplikasi</span>
            <span className="block text-xs text-muted">File mentah BPJS → pipeline → dataset bersih → object type → action, function, model ML → Workshop, Vertex, peta dan aplikasi OSDK, di Data Lineage.</span>
          </span>
          <span className="ml-auto text-ocean">→</span>
        </Link>
        <JknOntologyDemo />
        {err && <p className="mb-2 text-xs text-bad">{err}</p>}
        {demo?.status === "failed" && <p className="mb-3 whitespace-pre-wrap rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{demo.error}</p>}
        {demo?.status === "creating" && (
          <p className="mb-3 text-xs text-muted">
            Membuat data dan membangun aturan… {built}/21 transform selesai.
          </p>
        )}
        {demo?.status === "none" && <p className="text-xs text-muted">Belum ada demo. Klik Buat demo.</p>}
        {demo?.project_id && (
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            <Link href={`/files/${demo.project_id}`} className={buttonClass.secondary}>
              <Icon name="folder" className="h-3.5 w-3.5" /> Proyek &amp; data
            </Link>
            {demo.repo_id && (
              <Link href={`/code-repositories?repo=${demo.repo_id}`} className={buttonClass.secondary}>
                <Icon name="code" className="h-3.5 w-3.5" /> Aturan deteksi (Code Repository)
              </Link>
            )}
            {demo.findings_dataset_id && (
              <>
                <Link href={`/datasets/${demo.findings_dataset_id}`} className={buttonClass.secondary}>
                  <Icon name="layers" className="h-3.5 w-3.5" /> Dataset temuan_semua
                </Link>
                <Link href={`/lineage?item=${demo.findings_dataset_id}`} className={buttonClass.secondary}>
                  <Icon name="split" className="h-3.5 w-3.5" /> Lineage
                </Link>
              </>
            )}
          </div>
        )}
        {demo?.status === "ready" && (
          <>
            <div className="mb-4 grid grid-cols-3 gap-3">
              <Stat label="Temuan" value={String(demo.findings.length)} />
              <Stat label="Kategori dengan temuan" value={`${demo.categories.filter((c) => c.temuan).length} / 20`} />
              <Stat label="Estimasi nilai berisiko" value={rupiah(total)} />
            </div>
            <div className="mb-4 overflow-auto rounded-lg border border-line bg-panel">
              <table className="w-full text-xs">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="border-b border-line px-3 py-2 font-medium">No</th>
                    <th className="border-b border-line px-3 py-2 font-medium">Kategori risiko</th>
                    <th className="border-b border-line px-3 py-2 text-right font-medium">Temuan</th>
                    <th className="border-b border-line px-3 py-2 text-right font-medium">Nilai berisiko</th>
                  </tr>
                </thead>
                <tbody>
                  {demo.categories.map((c) => (
                    <tr key={c.no} onClick={() => setCat(cat === c.no ? null : c.no)} className={`cursor-pointer ${cat === c.no ? "bg-ocean/10" : "hover:bg-line/30"}`}>
                      <td className="border-b border-line-2 px-3 py-1.5 text-muted">{c.no}</td>
                      <td className="border-b border-line-2 px-3 py-1.5">{c.kategori}</td>
                      <td className="border-b border-line-2 px-3 py-1.5 text-right tabular-nums">{c.temuan}</td>
                      <td className="border-b border-line-2 px-3 py-1.5 text-right tabular-nums">{c.nilai_risiko ? rupiah(c.nilai_risiko) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-semibold">Temuan {cat !== null && `· kategori ${cat}`}</h2>
              {cat !== null && (
                <button type="button" onClick={() => setCat(null)} className="text-xs text-ocean hover:underline">
                  Tampilkan semua
                </button>
              )}
            </div>
            <div className="overflow-auto rounded-lg border border-line bg-panel">
              <table className="w-full text-xs">
                <thead className="text-left text-muted">
                  <tr>
                    {["No", "Referensi", "Faskes", "Nilai berisiko", "Alasan"].map((h) => (
                      <th key={h} className="border-b border-line px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((f, i) => (
                    <tr key={`${f.kategori_no}-${f.referensi}-${i}`}>
                      <td className="border-b border-line-2 px-3 py-1.5 text-muted">{f.kategori_no}</td>
                      <td className="border-b border-line-2 px-3 py-1.5 font-mono">{f.referensi}</td>
                      <td className="border-b border-line-2 px-3 py-1.5">{f.faskes}</td>
                      <td className="border-b border-line-2 px-3 py-1.5 text-right tabular-nums">{f.nilai_risiko ? rupiah(f.nilai_risiko) : "—"}</td>
                      <td className="border-b border-line-2 px-3 py-1.5">{f.alasan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
