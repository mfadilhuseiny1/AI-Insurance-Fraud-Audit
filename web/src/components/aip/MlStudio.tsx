"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { aip, wib } from "@/components/aip/aipRun";
import { MlCard } from "@/components/aip/MlCard";
import { MlPerbandingan } from "@/components/aip/MlPerbandingan";
import { MlSistem } from "@/components/aip/MlSistem";
import { LaporanGen2 } from "@/components/aip/LaporanGen2";
import { LaporanHackathon } from "@/components/aip/LaporanHackathon";
import { LaporanV7Juri } from "@/components/aip/LaporanV7Juri";
import { LaporanSwarmCabang } from "@/components/aip/LaporanSwarmCabang";
import { modelStudio } from "@/lib/modelStudio";
import { mlStudio, type CodeSummary, type Manifest, type NotebookItem, type NotebookList, type NotebookTask, type NotebookWorkspace, type Overview, type StudioRun,
  type Verification } from "@/components/aip/mlStudioApi";

/* ML Studio of AIP JKN, as Model Studio reads: the models and their latest versions (tab Model), every training run with
   its inputs, parameters, resources and changelog (Training runs), the experiments of the claim-risk model (Eksperimen),
   and for every run the code that trained it — each source file the training process loaded, its sha256 and git
   state, the environment and the input data — checked against the code as it is now, downloadable as an audit kit and
   runnable in JupyterLab on Docker (Audit kode, opened from a run). A notebook per model trains it step by step with the
   platform's code (Notebook). The no-code trainers are the platform's Model Studio, opened from tab Model. */

type Tab = "juri" | "swarm" | "sistem" | "hackathon" | "gen2" | "beranda" | "runs" | "notebook" | "eksperimen" | "perbandingan";
// the main page is the ML system in use (2026-11-12: Model 1 + Model 2 of the /testing bench, MlSistem.tsx); the
// experiments and evaluation of the earlier claim-risk model follow; "beranda" keeps its key.
// Audit kode lives in Training runs (it audits one run) and Model Studio in Model (it configures the models).
// Perbandingan (2026-11-08): ML vs deep learning vs the LLM screens, on the verifier's corrections (MlPerbandingan.tsx)
// Laporan Generator 2 (2026-11-12, "report generator 2 simpen di ML studio"): v3 on generator 2, node by node (LaporanGen2.tsx)
// Laporan hackathon (2026-11-13, "kasih report lengkap di ML Studio"): the published hackathon reports (LaporanHackathon.tsx)
// Laporan v7 · metrik juri (2026-11-15, "bikin report baru di paling atas: F1 score, FP TP FN TN, confusion matrix"): first tab
// and the default view; the jury deck's metrics with plain-language paragraphs for executives (LaporanV7Juri.tsx)
// Metrik AI Agent Swarm (2026-11-15, "bikin tab baru metrik2 nya kayak di Laporan v7 metrik juri ... apakah multi agent swarm bisa
// nurunin false positive?"): every layer of a branch run (ML v7, rules, medical record, IoT, swarm) on the same claims (LaporanSwarmCabang.tsx)
const TABS: [Tab, string, IconName][] = [["juri", "Laporan v7 · metrik juri", "gauge"], ["swarm", "Metrik AI Agent Swarm", "constellation"], ["sistem", "Sistem ML terbaru", "sparkle"], ["hackathon", "Laporan hackathon", "star"], ["gen2", "Laporan Generator 2", "doc"], ["eksperimen", "Eksperimen & evaluasi", "gauge"],
  ["perbandingan", "Perbandingan ML · DL · LLM", "logic"], ["beranda", "Model", "cpu"], ["runs", "Training runs", "list"], ["notebook", "Notebook", "doc"]];
const STATUS: Record<string, [string, string]> = { succeeded: ["berhasil", "text-[#7ee2c0]"], running: ["berjalan", "text-[#8abbff]"], failed: ["gagal", "text-red-300"] };
const GIT: Record<string, [string, string]> = { committed: ["sama dengan commit", "bg-[#29a383]/15 text-[#7ee2c0]"], modified: ["belum di-commit", "bg-amber-500/15 text-amber-200"],
  untracked: ["file baru, belum di-commit", "bg-amber-500/15 text-amber-200"] };
const STATE: Record<string, [string, string]> = { same: ["sama", "text-[#7ee2c0]"], changed: ["berubah", "text-amber-200"], missing: ["hilang", "text-red-300"],
  unverifiable: ["tak bisa dicek", "text-[#8f99a8]"] };

const short = (s?: string | null, n = 12) => (s ? s.slice(0, n) : "—");
const size = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`);
const card = "rounded-lg border border-white/10 bg-[#1c2127]";

function CodeChip({ code, running }: { code: CodeSummary | null | undefined; running?: boolean }) {
  if (!code && running) return <span className="text-[11px] text-[#8f99a8]" title="Kode yang dijalankan dicatat oleh prosesnya sendiri di akhir job">dicatat saat selesai</span>;
  if (!code) return <span className="text-[11px] text-[#8f99a8]" title="Dilatih sebelum pelacakan kode, atau pencatatan gagal">tidak tercatat</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-[10.5px] text-[#d3d8de]" title={`Sidik kode ${code.fingerprint}`}>
      <Icon name="lock" className="h-3 w-3 text-[#7ee2c0]" />{short(code.fingerprint, 10)} · {code.files} file{code.modified ? ` · ${code.modified} belum di-commit` : ""}
    </span>
  );
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{k}</p>
      <div className="break-words text-[12px] text-[#e5e8eb]">{children}</div>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-48 overflow-auto rounded bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-[#c5cbd3]">{JSON.stringify(value ?? {}, null, 1)}</pre>;
}

// ------------------------------------------------------------------------------------------------ Model (the cards per model)

function Home({ data, onRuns, onNotebooks, onAudit, onStudio, onTrained }: { data: Overview; onRuns: (model: string) => void; onNotebooks: (model: string) => void;
  onAudit: (key: string) => void; onStudio: (id: string) => void; onTrained: () => void }) {
  const [err, setErr] = useState("");
  // every card trains its own model: the AIP one through the ML agent, a studio one with its latest configuration
  const train = async (m: Overview["models"][number]) => {
    if (m.source === "aip" && !confirm("Training penuh model risiko klaim: benchmark 9 teknik + model terpilih, sekitar 30–40 menit. Versi model baru dipublikasikan dan dataset skornya diperbarui. Lanjutkan?")) return;
    setErr("");
    try {
      if (m.source === "aip") await aip.mlTrain({});
      else await modelStudio.run(m.studio_id!);
      onTrained();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <section className={`${card} p-4`}>
        <h3 className="text-[13px] font-semibold text-white">Cara ML Studio membuktikan kode training</h3>
        <ol className="mt-2 grid gap-2 text-[12px] leading-relaxed text-[#c5cbd3] md:grid-cols-4">
          <li><b className="text-white">1 · Dicatat otomatis.</b> Di akhir setiap training, prosesnya sendiri mendaftar semua file sumber yang dimuatnya (dari <code className="font-mono text-[11px]">sys.modules</code>) — bukan daftar tulisan tangan.</li>
          <li><b className="text-white">2 · Dikunci hash.</b> Tiap file: sha256, isi lengkap, status git terhadap commit; plus versi pustaka, hash data masukan, parameter dan seed. Semuanya jadi satu sidik kode.</li>
          <li><b className="text-white">3 · Bisa dicek ulang.</b> Verifikasi membandingkan kode yang dipakai training dengan kode sekarang, file per file, dan menunjukkan diff bila ada yang berubah.</li>
          <li><b className="text-white">4 · Bisa dijalankan sendiri.</b> Paket audit (.zip) dan JupyterLab di Docker dengan lingkungan training yang sama: hash dicek, kode ditampilkan, skor model dihitung ulang.</li>
        </ol>
      </section>
      {err && <p className="text-[12px] text-red-300">{err}</p>}
      <div className="flex items-center gap-2">
        <p className="text-[12px] text-[#8f99a8]">{data.models.length} model</p>
        <button onClick={() => onStudio("")} title="Buat atau ubah model tanpa kode: dataset, target, fitur dan pelatih dipilih lewat formulir"
          className="ml-auto inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[11.5px] text-[#d3d8de] hover:bg-white/10">
          <Icon name="cube" className="h-3.5 w-3.5" />Model Studio (tanpa kode)</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {data.models.map((m) => {
          const runs = data.runs.filter((r) => r.model_id === m.id);
          const tracked = runs.find((r) => r.code);
          // any ML job holds the machine (heavy jobs run one at a time), but only a "train" job is a training
          const active = runs.find((r) => r.status === "running");
          const running = !!active;
          // a studio model has no written description: say what trains it, so every card reads the same
          const trainSet = runs.find((r) => r.inputs.length)?.inputs.find((i) => i.role === "training");
          const about = m.description || (trainSet ? `Dilatih tanpa kode di Model Studio dari ${trainSet.name}.` : "Dilatih tanpa kode di Model Studio; belum ada training run.");
          return (
            <article key={m.id} className={`${card} flex flex-col gap-3 p-4`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#7961db]/20 text-[#b9a8ff]"><Icon name="cpu" className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{m.source === "aip" ? "Agen Machine Learning (AIP)" : `Model Studio · ${m.studio}`}</p>
                  <h3 className="truncate text-[14px] font-semibold text-white" title={m.name}>{m.name}</h3>
                  <p className="text-[11.5px] text-[#abb3bf]">{m.trainer}</p>
                </div>
                {m.out_of_date && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-200" title="Data latih berubah sejak training terakhir">usang</span>}
                {active && <span className="rounded bg-[#2d72d2]/20 px-1.5 py-0.5 text-[10.5px] text-[#8abbff]" title={`${active.key} · mulai ${wib(active.started_at)}`}>
                  {active.kind === "train" ? "training berjalan" : `${active.name.split(" · ")[0]} berjalan`}</span>}
              </div>
              <p className="truncate text-[12px] text-[#c5cbd3]" title={about}>{about}</p>
              <div className="grid grid-cols-3 gap-3">
                <Kv k="Versi terbaru">{m.latest ? `v${m.latest.version}` : "belum ada"}</Kv>
                <Kv k="Dibuat">{m.latest ? wib(m.latest.created_at) : "—"}</Kv>
                <Kv k="Training run">{runs.length}</Kv>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[#8f99a8]">Kode versi terbaru:</span>
                <CodeChip code={m.latest?.code} />
              </div>
              <div className="mt-auto flex flex-wrap gap-2 text-[11.5px]">
                <button onClick={() => onRuns(m.id)} className="rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10">Training runs</button>
                <button onClick={() => onNotebooks(m.id)} className="rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10"
                  title={m.source === "aip" ? "Satu notebook per teknik model ini" : "Notebook yang melatih ulang model ini"}>Notebook</button>
                <button disabled={!tracked} onClick={() => tracked && onAudit(tracked.key)} className="rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10 disabled:opacity-40"
                  title={tracked ? `Run ${tracked.key}` : "Belum ada run dengan kode tercatat"}>Audit kode</button>
                <a href={m.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10"><Icon name="external" className="h-3 w-3" />Model registry</a>
                {m.latest?.pickle ? (
                  <a href={mlStudio.pickleUrl(m.id, m.latest.id)} download className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10"
                    title={`${m.latest.pickle.file} hasil training v${m.latest.version} (${size(m.latest.pickle.bytes)}); versi lain di Training runs`}><Icon name="download" className="h-3 w-3" />Unduh .pkl</a>
                ) : <span className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[#d3d8de] opacity-40" title="Versi ini tidak menyimpan file pickle"><Icon name="download" className="h-3 w-3" />Unduh .pkl</span>}
                <button disabled={!m.studio_id} onClick={() => m.studio_id && onStudio(m.studio_id)} className="rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10 disabled:opacity-40"
                  title={m.studio_id ? undefined : "Model ini dikonfigurasi oleh Agen Machine Learning AIP, bukan Model Studio"}>Edit konfigurasi</button>
                <button disabled={running || (m.source === "studio" && !m.studio_id)} onClick={() => train(m)} className="rounded border border-white/15 px-2 py-1 text-[#d3d8de] hover:bg-white/10 disabled:opacity-40"
                  title={active ? `Menunggu "${active.name}" selesai: ${m.source === "aip" ? "job ML berat berjalan satu per satu" : "satu training run per studio"}`
                    : m.source === "aip" ? "Benchmark 9 teknik + model terpilih, sekitar 30–40 menit" : "Training dengan konfigurasi terbaru"}>Mulai training run</button>
              </div>
            </article>
          );
        })}
        {!data.models.length && <p className="text-[12px] text-[#8f99a8]">Belum ada model yang bisa Anda lihat.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Training runs

function Runs({ runs, model, setModel, sel, onSelect, onAudit, models }: { runs: StudioRun[]; model: string; setModel: (m: string) => void; sel: string | null; onSelect: (k: string) => void;
  onAudit: (k: string) => void; models: Overview["models"] }) {
  const shown = runs.filter((r) => !model || r.model_id === model);
  const r = shown.find((x) => x.key === sel) ?? null;
  return (
    <div className="flex min-h-0 gap-3">
      <div className={`${card} min-w-0 flex-1 overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-[12px]">
          <p className="font-semibold text-white">Run terbaru <span className="font-normal text-[#8f99a8]">· training, benchmark, kartu bukti, aturan 2</span></p>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="ml-auto rounded border border-white/15 bg-[#111418] px-2 py-1 text-[11.5px] text-[#e5e8eb]">
            <option value="">Semua model</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="w-full text-left text-[11.5px]">
            <thead className="sticky top-0 bg-[#1c2127] text-[10.5px] uppercase tracking-wide text-[#8f99a8]">
              <tr>{["Nama", "Mulai (WIB)", "Status", "Konfigurasi", "Versi model", "Kode training"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const [st, tone] = STATUS[x.status] ?? [x.status, "text-[#abb3bf]"];
                return (
                  <tr key={x.key} onClick={() => onSelect(x.key)} className={`cursor-pointer border-t border-white/5 ${sel === x.key ? "bg-[#2d72d2]/15" : "hover:bg-white/[.04]"}`}>
                    <td className="px-3 py-2"><p className="text-[#e5e8eb]">{x.name}</p><p className="text-[10.5px] text-[#8f99a8]">{x.model} · {x.key}</p></td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#c5cbd3]">{wib(x.started_at)}</td>
                    <td className={`px-3 py-2 ${tone}`}>{st}</td>
                    <td className="px-3 py-2 text-[#c5cbd3]">{x.config_version ? `v${x.config_version}` : "—"}</td>
                    <td className="px-3 py-2 text-[#c5cbd3]">{x.version ? `v${x.version}` : "—"}</td>
                    <td className="px-3 py-2"><CodeChip code={x.code} running={x.status === "running"} /></td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-[#8f99a8]">Belum ada training run.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <aside className={`${card} w-[360px] shrink-0 space-y-3 overflow-auto p-3`}>
        {!r ? <p className="text-[12px] text-[#8f99a8]">Pilih sebuah run untuk melihat input, parameter, sumber daya, changelog dan kode training-nya.</p> : (
          <>
            <div>
              <p className="text-[13px] font-semibold text-white">{r.name}</p>
              <p className="text-[11px] text-[#8f99a8]">{wib(r.started_at)}{r.finished_at ? ` → ${wib(r.finished_at)}` : ""} · {r.key}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11.5px]">
              {r.model_id && r.version && <a href={`/model-assets/${r.model_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8abbff] hover:underline"><Icon name="external" className="h-3 w-3" />{r.model} v{r.version}</a>}
              {r.experiment_id && r.model_id && <a href={`/model-assets/${r.model_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8abbff] hover:underline"><Icon name="gauge" className="h-3 w-3" />Lihat eksperimen</a>}
              {r.model_id && r.version_id && <a href={mlStudio.pickleUrl(r.model_id, r.version_id)} download className="inline-flex items-center gap-1 text-[#8abbff] hover:underline"
                title={`Model hasil training run ini (v${r.version}) sebagai pickle`}><Icon name="download" className="h-3 w-3" />Unduh .pkl</a>}
            </div>
            {r.error && <p className="whitespace-pre-wrap rounded bg-red-500/10 p-2 text-[11px] text-red-300">{r.error.slice(0, 800)}</p>}
            <section><p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Input</p>
              <ul className="space-y-0.5 text-[11.5px] text-[#e5e8eb]">{r.inputs.map((i) => <li key={i.item_id}>{i.role ? `${i.role}: ` : ""}{i.name}</li>)}</ul></section>
            <section><p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Parameter</p><Json value={r.params} /></section>
            <section><p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Sumber daya</p><Json value={r.resources} /></section>
            {r.changelog && <section><p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Changelog</p><p className="text-[11.5px] text-[#c5cbd3]">{r.changelog}</p></section>}
            {r.metrics && <section><p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Metrik</p><Json value={r.metrics} /></section>}
            <section className="rounded border border-white/10 p-2">
              <p className="mb-1 text-[11px] font-medium text-[#abb3bf]">Kode training</p>
              <CodeChip code={r.code} running={r.status === "running"} />
              {r.code && (
                <>
                  <p className="mt-1 text-[11px] text-[#8f99a8]">commit {short(r.code.commit, 10)} ({r.code.branch}) · {r.code.lines.toLocaleString("id-ID")} baris</p>
                  <button onClick={() => onAudit(r.key)} className="mt-2 rounded bg-[#2d72d2] px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-[#215db0]">Buka audit kode</button>
                </>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Notebook

const num = (x: number | null | undefined, d = 3) => (x == null ? "—" : x.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d }));

function TaskCell({ t }: { t?: NotebookTask }) {
  if (!t) return <span className="text-[#8f99a8]">—</span>;
  return (
    <span title={t.best ? "Teknik terbaik di tugas ini" : t.p != null ? `Uji vs terbaik: p = ${num(t.p, 3)}${t.berbeda_nyata ? " (berbeda nyata)" : " (setara)"}` : undefined}>
      <span className={t.best ? "font-semibold text-[#7ee2c0]" : "text-[#e5e8eb]"}>#{t.rank}</span>
      <span className="text-[#8f99a8]"> dari {t.of}</span> · AUPRC {num(t.auprc)}{t.best ? " ★" : t.berbeda_nyata ? <span className="text-amber-200"> · lebih rendah nyata</span> : " · setara"}
    </span>
  );
}

function Notebooks({ model, setModel, models }: { model: string; setModel: (m: string) => void; models: Overview["models"] }) {
  const [data, setData] = useState<NotebookList | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ws, setWs] = useState<(NotebookWorkspace & { title?: string }) | null>(null);
  const load = useCallback(() => { mlStudio.notebooks().then(setData).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);
  // the platform runs notebooks one after the other: follow it while it goes
  const going = data?.jalan?.sedang ?? null;
  useEffect(() => {
    if (!going) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [going, load]);
  const run = async (ids: string[] = []) => {
    setBusy(ids.length ? `run:${ids[0]}` : "run");
    setErr("");
    try {
      await mlStudio.notebooksRun(ids);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const shown = (data?.notebooks ?? []).filter((n) => !model || n.model_id === model);
  const aip = shown.filter((n) => n.source === "aip");
  const studio = shown.filter((n) => n.source === "studio");
  const docker = data?.docker;
  const open = async (n?: NotebookItem, segarkan = false) => {
    setBusy(segarkan ? "segarkan" : n?.id ?? "all");
    setErr("");
    try {
      setWs({ ...(await mlStudio.notebooksWorkspace(n?.id, segarkan)), title: n?.file });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const lasted = (s: number) => (s < 90 ? `${s} dtk` : `${Math.round(s / 60)} mnt`);
  // the platform's own notebook editor on the workspace's files: no container, kernels on this machine (Local CPU)
  const labUrl = (file?: string) => data?.workspace && `/code-workspaces?id=${data.workspace.id}${file ? `&open=${encodeURIComponent(file)}` : ""}&editor=lab`;
  const actions = (n: NotebookItem) => {
    const r = data?.jalan?.hasil?.[n.file];
    const queued = going?.antrean.includes(n.file) && !going.selesai.includes(n.file);
    const native = labUrl(n.file);
    return (
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <a href={mlStudio.notebookUrl(n.id)} className="text-[#8abbff] hover:underline" title={n.file}>Unduh .ipynb</a>
        {native ? (
          <a href={native} target="_blank" rel="noreferrer" className="ml-3 font-medium text-[#ffb27a] hover:underline"
            title="Buka di editor notebook platform: output tiap sel dan grafiknya langsung terlihat, kernel di mesin platform (tanpa Docker)">Buka</a>
        ) : (
          <button disabled={!!busy || !docker?.available} onClick={() => open(n)} title="Siapkan workspace notebook (sekali), lalu buka" className="ml-3 font-medium text-[#ffb27a] hover:underline disabled:opacity-40">
            {busy === n.id ? "Menyiapkan…" : "Buka"}</button>
        )}
        <button disabled={!!busy || !docker?.available} onClick={() => open(n)} title={docker?.available ? "Buka notebook ini di JupyterLab (Docker), dengan data dan kodenya" : docker?.error ?? ""}
          className="ml-3 text-[#8f99a8] hover:underline disabled:opacity-40">{busy === n.id ? "Menyiapkan…" : "JupyterLab (Docker)"}</button>
        <button disabled={!!busy || !!going || !data?.workspace || !docker?.available} onClick={() => run([n.id])}
          title={data?.workspace ? "Jalankan semua sel notebook ini di JupyterLab; hasil tiap sel dan grafiknya tersimpan di .ipynb" : "Buka di JupyterLab dulu (workspace belum dibuat)"}
          className="ml-3 text-[#7ee2c0] hover:underline disabled:opacity-40">{busy === `run:${n.id}` ? "Memulai…" : "Jalankan"}</button>
        <p className="mt-0.5 text-[10.5px]">
          {going?.sedang === n.file ? <span className="text-[#8abbff]">sedang dijalankan…</span>
            : queued ? <span className="text-[#8f99a8]">antre</span>
              : r ? <span className={r.status === "berhasil" ? "text-[#7ee2c0]" : "text-red-300"} title={r.galat.join("\n") || undefined}>
                  {r.status === "berhasil" ? "✓ hasil tersimpan" : `✗ ${r.galat.length} sel galat`} · {wib(r.pada)} · {lasted(r.detik)}</span>
                : <span className="text-[#8f99a8]">belum dijalankan</span>}
        </p>
      </td>
    );
  };
  const head = (cols: string[]) => (
    <thead className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]"><tr>{cols.map((h, i) => <th key={i} className="px-3 py-1.5 font-medium">{h}</th>)}</tr></thead>
  );
  return (
    <div className="space-y-3">
      <section className={`${card} flex flex-wrap items-start gap-3 p-4`}>
        <div className="min-w-[280px] flex-1">
          <h3 className="text-[13px] font-semibold text-white">Notebook tiap model</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[#c5cbd3]">
            Satu notebook Jupyter per model, dibuat dari keadaan platform saat ini. Model risiko klaim: satu notebook per teknik benchmark — melatih dan menguji teknik itu
            langkah demi langkah dengan kode mesin ML platform pada data nyata, mengulang ulangan pertama benchmark sehingga tiap lipatan bisa dicocokkan dengan kartu model,
            dan untuk teknik yang dipakai produksi, model akhirnya dibandingkan klaim demi klaim dengan model yang dipublikasikan. Model Studio: konfigurasi run terakhirnya
            dilatih ulang dengan pelatih yang sama, papan peringkatnya dibandingkan dengan run itu.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded border border-white/15 bg-[#111418] px-2 py-1 text-[11.5px] text-[#e5e8eb]">
            <option value="">Semua model</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <a href={mlStudio.notebooksBundleUrl()} className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[#d3d8de] hover:bg-white/10"
            title="Semua notebook, kode yang diimpornya, requirements, Dockerfile (tanpa data)"><Icon name="download" className="h-3.5 w-3.5" />Unduh semua (.zip)</a>
          {labUrl() && (
            <a href={labUrl()!} target="_blank" rel="noreferrer" title="Semua notebook di editor notebook platform: tanpa Docker, kernel di mesin platform"
              className="inline-flex items-center gap-1 rounded border border-[#f37626]/60 px-3 py-1 text-[#ffb27a] hover:bg-[#f37626]/10">
              <Icon name="code" className="h-3.5 w-3.5" />Buka semua (tanpa Docker)</a>
          )}
          <button disabled={!!busy || !docker?.available} onClick={() => open()} title={docker?.available ? "Semua notebook, kode dan data dalam satu workspace JupyterLab (Docker); juga memperbarui notebook-nya" : docker?.error ?? ""}
            className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[#d3d8de] hover:bg-white/10 disabled:opacity-40">
            <Icon name="code" className="h-3.5 w-3.5" />{busy === "all" ? "Menyiapkan…" : "JupyterLab (Docker)"}</button>
          <button disabled={!!busy || !!going || !data?.workspace || !docker?.available} onClick={() => run()}
            title={data?.workspace ? "Jalankan semua notebook satu per satu di JupyterLab; output tiap sel (tabel, grafik) tersimpan di file .ipynb-nya" : "Buka di JupyterLab dulu (workspace belum dibuat)"}
            className="inline-flex items-center gap-1 rounded bg-[#29a383]/80 px-3 py-1 font-medium text-white hover:bg-[#29a383] disabled:opacity-40">
            <Icon name="play" className="h-3.5 w-3.5" />{busy === "run" ? "Memulai…" : "Jalankan semua"}</button>
        </div>
        {going && (
          <p className="w-full text-[11.5px] text-[#8abbff]">
            Menjalankan {going.selesai.length + 1} dari {going.antrean.length}: <span className="font-mono">{going.sedang ?? "…"}</span> (mulai {wib(going.mulai)}) —
            output tiap sel, termasuk grafik, tersimpan di file notebook-nya; tekan Buka untuk melihatnya.
          </p>
        )}
      </section>
      {err && <p className="text-[12px] text-red-300">{err}</p>}
      {ws && (
        <div className={`${card} space-y-1 p-3 text-[12px] text-[#c5cbd3]`}>
          <p>
            Workspace siap: {ws.notebooks} notebook, kode platform{ws.missing.length ? "" : " dan datanya"} (salinan Data Bersih klaim FKRTL, wilayah, model produksi, dataset tiap studio).{" "}
            {ws.image_status === "building" ? "Image Docker dengan pustaka versi platform sedang dibangun (beberapa menit untuk pertama kali). " : ""}
            <a href={`/code-workspaces?id=${ws.workspace_id}${ws.title ? `&open=${encodeURIComponent(ws.title)}` : ""}&editor=lab`} target="_blank" rel="noreferrer"
              className="font-medium text-[#8abbff] hover:underline">{ws.title ? `Buka ${ws.title} ↗` : "Buka workspace ↗"}</a> (editor notebook platform, tanpa Docker) atau{" "}
            <a href={ws.url} target="_blank" rel="noreferrer" className="text-[#8abbff] hover:underline">di JupyterLab (Docker) ↗</a>, lalu tekan Start JupyterLab.
          </p>
          {ws.kept.length > 0 && (
            <p className="text-[11.5px] text-amber-200">
              Tidak ditimpa karena sudah Anda ubah atau jalankan di JupyterLab: {ws.kept.join(", ")}.{" "}
              <button disabled={!!busy} onClick={() => open(undefined, true)} className="text-[#8abbff] hover:underline disabled:opacity-40"
                title="Salinan Anda dipindah ke folder arsip/ (bertanggal), lalu versi terbaru ditulis di tempatnya">
                {busy === "segarkan" ? "Memperbarui…" : "Perbarui juga (salinan Anda disimpan di arsip/)"}
              </button>
            </p>
          )}
          {!!ws.archived?.length && <p className="text-[11.5px] text-[#c5cbd3]">Diperbarui ke versi terbaru; salinan Anda disimpan: {ws.archived.join(", ")}.</p>}
          {ws.missing.length > 0 && <p className="text-[11.5px] text-red-300">Data yang tidak bisa disalin: {ws.missing.join(", ")}</p>}
        </div>
      )}
      {!data && !err && <p className="text-[12px] text-[#8f99a8]">Memuat notebook…</p>}
      {aip.length > 0 && (
        <section className={`${card} overflow-hidden`}>
          <p className="border-b border-white/5 px-3 py-2 text-[12px] font-semibold text-white">Model Risiko Koreksi Klaim BPJS (ML) · satu notebook per teknik</p>
          <table className="w-full text-left text-[11.5px]">
            {head(["Teknik", "Produksi", "Klaim rumah sakit", "Semua klaim FKRTL", ""])}
            <tbody>
              {aip.map((n) => (
                <tr key={n.id} className="border-t border-white/5 hover:bg-white/[.03]">
                  <td className="px-3 py-2"><p className="font-medium text-[#e5e8eb]">{n.title}</p><p className="text-[10.5px] text-[#8f99a8]">{n.family} · {n.reference} · <span className="font-mono">{n.file}</span></p></td>
                  <td className="px-3 py-2">{n.production?.length
                    ? n.production.map((p) => <span key={p.segment} className="mr-1 inline-block rounded bg-[#29a383]/15 px-1.5 py-0.5 text-[10.5px] text-[#7ee2c0]">segmen {p.segment.replace("_", " ")}{p.version ? ` · v${p.version}` : ""}</span>)
                    : <span className="text-[#8f99a8]">—</span>}</td>
                  <td className="px-3 py-2"><TaskCell t={n.tasks?.rumah_sakit} /></td>
                  <td className="px-3 py-2"><TaskCell t={n.tasks?.semua} /></td>
                  {actions(n)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {studio.length > 0 && (
        <section className={`${card} overflow-hidden`}>
          <p className="border-b border-white/5 px-3 py-2 text-[12px] font-semibold text-white">Model Studio · satu notebook per model</p>
          <table className="w-full text-left text-[11.5px]">
            {head(["Model", "Pelatih", "Konfigurasi", "Run pembanding", ""])}
            <tbody>
              {studio.map((n) => (
                <tr key={n.id} className="border-t border-white/5 hover:bg-white/[.03]">
                  <td className="px-3 py-2"><p className="font-medium text-[#e5e8eb]">{n.title}</p><p className="font-mono text-[10.5px] text-[#8f99a8]">{n.file}</p></td>
                  <td className="px-3 py-2 text-[#c5cbd3]">{n.family}</td>
                  <td className="px-3 py-2 text-[#c5cbd3]">{n.config_version ? `v${n.config_version}` : "—"}</td>
                  <td className="px-3 py-2 text-[#c5cbd3]">{n.run
                    ? <>{wib(n.run.started_at)} · terbaik {n.run.best}{Object.entries(n.run.metrics ?? {}).map(([k, v]) => ` · ${k} ${typeof v === "number" ? num(Math.abs(v), 4) : String(v)}`).join("")}</>
                    : <span className="text-[#8f99a8]">belum ada run berhasil</span>}</td>
                  {actions(n)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data && !shown.length && <p className="text-[12px] text-[#8f99a8]">Belum ada notebook untuk model ini.</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ Audit kode

function Viewer({ text, diff }: { text: string; diff?: boolean }) {
  const lines = text.split("\n");
  return (
    <div className="max-h-[560px] overflow-auto rounded border border-white/10 bg-[#111418] font-mono text-[11px] leading-[1.55]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={diff ? (l.startsWith("+") && !l.startsWith("+++") ? "bg-[#29a383]/15" : l.startsWith("-") && !l.startsWith("---") ? "bg-red-500/15" : l.startsWith("@@") ? "text-[#8abbff]" : "") : ""}>
              <td className="select-none border-r border-white/5 px-2 text-right align-top text-[#5f6b7c]">{i + 1}</td>
              <td className="whitespace-pre px-2 text-[#d3d8de]">{l || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit({ runs, sel, onSelect, docker }: { runs: StudioRun[]; sel: string | null; onSelect: (k: string) => void; docker: Overview["docker"] }) {
  const key = sel && runs.some((r) => r.key === sel) ? sel : runs.find((r) => r.code)?.key ?? null;
  // one view per run: its manifest, verification and open file start empty
  return <AuditRun key={key ?? ""} runKey={key} runs={runs} onSelect={onSelect} docker={docker} />;
}

function AuditRun({ runKey: key, runs, onSelect, docker }: { runKey: string | null; runs: StudioRun[]; onSelect: (k: string) => void; docker: Overview["docker"] }) {
  const [m, setM] = useState<Manifest | null>(null);
  const [run, setRun] = useState<StudioRun | null>(null);
  const [err, setErr] = useState("");
  const [ver, setVer] = useState<Verification | null>(null);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<{ root: string; path: string; text: string; diff?: boolean } | null>(null);
  const [ws, setWs] = useState<{ url: string; image_status: string; notebook: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    mlStudio.code(key).then((x) => { setRun(x.run); setM(x.manifest); }).catch((e) => setErr((e as Error).message));
  }, [key]);
  const state = useMemo(() => new Map((ver?.files ?? []).map((f) => [`${f.root}:${f.path}`, f])), [ver]);
  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  const repo = m?.git?.repo;
  const pk = Object.entries(m?.environment.packages ?? {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={key ?? ""} onChange={(e) => onSelect(e.target.value)} className="min-w-[320px] rounded border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] text-[#e5e8eb]">
          {!key && <option value="">Belum ada run dengan kode tercatat</option>}
          {runs.map((r) => <option key={r.key} value={r.key} disabled={!r.code}>{wib(r.started_at)} · {r.name}{r.version ? ` · v${r.version}` : ""}{r.code ? "" : " (kode tidak tercatat)"}</option>)}
        </select>
        {m && (
          <div className="ml-auto flex flex-wrap gap-2 text-[11.5px]">
            <button disabled={!!busy} onClick={() => act("verify", async () => setVer(await mlStudio.verify(m.key)))} className="inline-flex items-center gap-1 rounded bg-[#2d72d2] px-3 py-1 font-medium text-white hover:bg-[#215db0] disabled:opacity-50">
              <Icon name="check" className="h-3.5 w-3.5" />{busy === "verify" ? "Memeriksa…" : "Verifikasi terhadap kode sekarang"}</button>
            <a href={mlStudio.bundleUrl(m.key)} className="inline-flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[#d3d8de] hover:bg-white/10"><Icon name="download" className="h-3.5 w-3.5" />Unduh paket audit (.zip)</a>
            <button disabled={!!busy || !docker.available} title={docker.available ? "Workspace JupyterLab di Docker, dengan lingkungan training yang sama" : docker.error ?? ""}
              onClick={() => act("ws", async () => setWs(await mlStudio.workspace(m.key)))} className="inline-flex items-center gap-1 rounded border border-[#f37626]/60 px-3 py-1 text-[#ffb27a] hover:bg-[#f37626]/10 disabled:opacity-40">
              <Icon name="code" className="h-3.5 w-3.5" />{busy === "ws" ? "Menyiapkan…" : "Buka di JupyterLab (Docker)"}</button>
          </div>
        )}
      </div>
      {err && <p className="text-[12px] text-red-300">{err}</p>}
      {ws && (
        <p className={`${card} p-3 text-[12px] text-[#c5cbd3]`}>
          Workspace siap dengan notebook <code className="font-mono">{ws.notebook}</code>, kode, manifest{run?.source === "aip" ? ", model dan skor klaimnya" : ""}.{" "}
          {ws.image_status === "building" ? "Image Docker lingkungan training sedang dibangun (beberapa menit untuk pertama kali). " : ""}
          <a href={ws.url} target="_blank" rel="noreferrer" className="text-[#8abbff] hover:underline">Buka workspace ↗</a> lalu tekan Start JupyterLab.
        </p>
      )}
      {key && !m && !err && <p className="text-[12px] text-[#8f99a8]">Memuat manifest…</p>}
      {m && (
        <>
          <section className={`${card} grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4`}>
            <Kv k="Sidik kode (sha256)"><span className="break-all font-mono text-[11px]">{m.fingerprint}</span></Kv>
            <Kv k="Commit repositori">{short(repo?.commit, 12)} · {repo?.branch}<br /><span className="text-[11px] text-[#8f99a8]">dicatat {wib(m.captured_at)}</span></Kv>
            <Kv k="File sumber">{m.files.length} file · {m.files.reduce((s, f) => s + f.lines, 0).toLocaleString("id-ID")} baris<br />
              <span className="text-[11px] text-[#8f99a8]">{m.files.filter((f) => f.git === "committed").length} sama dengan commit · {m.files.filter((f) => f.git !== "committed").length} belum di-commit</span>
              {!!m.changed_during_run?.length && <span className="block text-[11px] text-red-200">{m.changed_during_run.length} file berubah saat training berjalan</span>}</Kv>
            <Kv k="Lingkungan">Python {m.environment.python} · {pk.length} pustaka<br /><span className="text-[11px] text-[#8f99a8]">{m.environment.platform}</span></Kv>
            <Kv k="Titik masuk"><code className="font-mono text-[11px]">{m.entrypoint}</code></Kv>
            <Kv k="Seed">{String(m.seed ?? "—")}</Kv>
            <Kv k="Data masukan">{Object.entries(m.data).map(([k, d]) => <span key={k} className="block text-[11px]" title={d.sha256}>{k}: {d.rows?.toLocaleString("id-ID") ?? "?"} baris · sha256 {short(d.sha256, 10)}</span>)}</Kv>
            {ver && (
              <Kv k="Verifikasi">
                <span className={ver.all_same ? "text-[#7ee2c0]" : "text-amber-200"}>{ver.all_same ? "Semua file sama dengan kode sekarang" : `${ver.counts.changed} berubah · ${ver.counts.missing} hilang`}</span>
                <br /><span className="text-[11px] text-[#8f99a8]">{ver.counts.same}/{ver.files.length} sama · salinan tersimpan {ver.files.every((f) => f.stored_intact) ? "utuh" : "TIDAK utuh"} · {wib(ver.checked_at)}</span>
              </Kv>
            )}
          </section>
          <section className={`${card} overflow-hidden`}>
            <p className="border-b border-white/5 px-3 py-2 text-[12px] font-semibold text-white">File yang dimuat proses training</p>
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]"><tr>{["File", "Baris", "Git saat training", "sha256", ver ? "Sekarang" : "", ""].map((h, i) => <th key={i} className="px-3 py-1.5 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {m.files.map((f) => {
                  const v = state.get(`${f.root}:${f.path}`);
                  const [g, gt] = GIT[f.git ?? ""] ?? [f.git ?? "—", "bg-white/[.06] text-[#abb3bf]"];
                  const isOpen = open?.path === f.path && open?.root === f.root;
                  return (
                    <Fragment key={`${f.root}:${f.path}`}>
                      <tr className={`border-t border-white/5 ${isOpen ? "bg-white/[.04]" : ""}`}>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-[#e5e8eb]">{f.root !== "repo" && <span className="text-[#8f99a8]">{f.root}/</span>}{f.path}</td>
                        <td className="px-3 py-1.5 text-[#c5cbd3]">{f.lines.toLocaleString("id-ID")}</td>
                        <td className="px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10.5px] ${gt}`}>{g}</span>
                          {f.changed_during_run && <span className="ml-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10.5px] text-red-200" title="Disimpan setelah proses training mulai; isinya dibaca di akhir proses, jadi bisa berbeda dari kode yang dijalankan">berubah saat training</span>}</td>
                        <td className="px-3 py-1.5 font-mono text-[10.5px] text-[#abb3bf]" title={f.sha256}>{short(f.sha256, 16)}</td>
                        <td className={`px-3 py-1.5 ${v ? STATE[v.state][1] : ""}`}>{v ? STATE[v.state][0] : ""}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right">
                          <button onClick={() => isOpen && !open?.diff ? setOpen(null) : act(`f:${f.path}`, async () => setOpen({ root: f.root, path: f.path, text: (await mlStudio.file(m.key, f.root, f.path)).content }))}
                            className="text-[#8abbff] hover:underline">{isOpen && !open?.diff ? "Tutup" : "Lihat kode"}</button>
                          {v?.state === "changed" && (
                            <button onClick={() => act(`d:${f.path}`, async () => setOpen({ root: f.root, path: f.path, text: (await mlStudio.diff(m.key, f.root, f.path)).diff ?? "", diff: true }))}
                              className="ml-3 text-amber-200 hover:underline">Diff</button>
                          )}
                        </td>
                      </tr>
                      {isOpen && open && (
                        <tr><td colSpan={6} className="px-3 pb-3"><Viewer text={open.text} diff={open.diff} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className={`${card} p-3`}>
              <p className="mb-2 text-[12px] font-semibold text-white">Pustaka dan versinya saat training</p>
              <div className="grid max-h-64 grid-cols-2 gap-x-4 gap-y-0.5 overflow-auto font-mono text-[11px] text-[#c5cbd3]">
                {pk.map(([d, v]) => <span key={d} className="truncate" title={`${d}==${v}`}>{d} <span className="text-[#8f99a8]">{v}</span></span>)}
              </div>
            </section>
            <section className={`${card} p-3`}>
              <p className="mb-2 text-[12px] font-semibold text-white">Parameter run</p>
              <Json value={m.params} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the tab

export function MlStudio({ embed }: { embed: (src: string) => string }) {
  const [tab, setTab] = useState<Tab>("juri");
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [model, setModel] = useState("");
  // the sub-views: Model Studio inside Model ("" = its model list, else a studio id) and a run's code audit inside Training runs
  const [studio, setStudio] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const load = useCallback(() => { mlStudio.overview().then(setData).catch((e) => setErr((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);
  const running = data?.runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [running, load]);
  const audit = (k: string) => { setSel(k); setAuditing(true); setTab("runs"); };
  // a tab button always lands on the tab's main view
  const go = (k: Tab) => { setTab(k); setStudio(null); setAuditing(false); };
  const back = "inline-flex items-center gap-1 text-[11.5px] text-[#8abbff] hover:underline";
  return (
    // min-w-0: a flex item of the page row, so a wide report scrolls inside instead of widening the page on a phone
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[12px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-[#1c2127] px-4 py-2">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="cpu" className="h-4 w-4 text-[#b9a8ff]" />ML Studio</p>
        <span className="text-[#abb3bf]">model, training run, eksperimen dan audit kode training setiap versi model</span>
        <nav className="ml-auto flex flex-wrap gap-1">
          {TABS.map(([k, label, icon]) => (
            <button key={k} onClick={() => go(k)} className={`flex items-center gap-1 rounded px-2 py-1 ${tab === k ? "bg-white/10 text-white" : "text-[#d3d8de] hover:bg-white/5"}`}>
              <Icon name={icon} className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </nav>
      </div>
      {tab === "juri" ? <div className="min-h-0 flex-1 overflow-auto"><LaporanV7Juri /></div>
        : tab === "swarm" ? <div className="min-h-0 flex-1 overflow-auto"><LaporanSwarmCabang /></div>
        : tab === "sistem" ? <div className="min-h-0 flex-1 overflow-auto"><MlSistem /></div>
        : tab === "hackathon" ? <LaporanHackathon />
        : tab === "gen2" ? <div className="min-h-0 flex-1 overflow-auto"><LaporanGen2 /></div>
        : tab === "eksperimen" ? <div className="min-h-0 flex-1"><MlCard /></div>
        : tab === "perbandingan" ? <div className="min-h-0 flex-1 overflow-auto"><MlPerbandingan /></div>
        : tab === "beranda" && studio !== null ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-white/5 px-4 py-1.5">
              {/* a configuration saved or a run started in the studio shows on the cards: read them again */}
              <button onClick={() => { setStudio(null); load(); }} className={back}><Icon name="left" className="h-3.5 w-3.5" />Semua model</button>
              <span className="text-[11.5px] text-[#8f99a8]">Model Studio · pelatih tanpa kode</span>
            </div>
            <iframe key={studio} src={embed(studio ? `/model-studio?id=${studio}` : "/model-studio")} title="Model Studio" className="h-full w-full flex-1 border-0" />
          </div>
        ) : (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {err && <p className="text-red-300">{err}</p>}
              {!data && !err && <p className="text-[#8f99a8]">Memuat ML Studio…</p>}
              {data && tab === "beranda" && <Home data={data} onRuns={(m) => { setModel(m); go("runs"); }} onNotebooks={(m) => { setModel(m); go("notebook"); }}
                onAudit={audit} onStudio={setStudio} onTrained={() => { load(); go("runs"); }} />}
              {data && tab === "runs" && (auditing ? (
                <div className="space-y-3">
                  <button onClick={() => setAuditing(false)} className={back}><Icon name="left" className="h-3.5 w-3.5" />Semua training run</button>
                  <Audit runs={data.runs} sel={sel} onSelect={setSel} docker={data.docker} />
                </div>
              ) : <Runs runs={data.runs} model={model} setModel={setModel} sel={sel} onSelect={setSel} onAudit={audit} models={data.models} />)}
              {data && tab === "notebook" && <Notebooks model={model} setModel={setModel} models={data.models} />}
            </div>
          )}
    </div>
  );
}
