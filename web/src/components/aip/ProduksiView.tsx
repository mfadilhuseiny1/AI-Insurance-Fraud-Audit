"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { wib, type Rec } from "@/components/aip/aipRun";
import { GlosariumDialog } from "@/components/aip/GlosariumView";
import { ReviewCard } from "@/components/aip/KarantinaView";
import { fraud, rp, VERDICT, type BatchRow, type Production, type ProdRun, type Stage, type Verify, type VerifyBatch } from "@/components/aip/fraudApi";

/* Pipeline Produksi (api/aip/produksi.py) and the online inference service (layanan.py): data in → contract → features
   and drift → scoring → performance → packaging (.pkl, .onnx with parity) → feature store (training-serving parity) →
   publish → tags and box → deploy; then POST /verify, the judges' six-stage inference pipeline, tried live — one claim,
   or many from a CSV. */

const STAGE_LABEL: Record<string, string> = {
  data_masuk: "Data masuk", validasi: "Kontrak data", fitur: "Fitur & drift", skor: "Skoring", kinerja: "Kinerja", paket: "Paket .pkl/.onnx",
  toko_fitur: "Penyimpanan fitur & paritas", publikasi: "Publikasi", indikasi: "Tag & karantina", deploy: "Deploy",
};
const COLOR: Record<string, string> = { lulus: "#29a383", peringatan: "#fab219", gagal: "#e5484d", berjalan: "#b8a9ff" };
const JURI = {
  legitimate: { claim_id: "CLM-2026-8801", patient_age: 58, ina_cbg_code: "I-4-10-II", primary_diagnosis: "I21.0", claimed_cost: 15100000, real_cost: 14200000,
    length_of_stay_days: 6, clinical_notes: "Pasien serangan jantung. Dirawat di ICU 3 hari, observasi 3 hari. Terapi trombolitik dan insulin berjalan lancar. Kondisi stabil dan diizinkan pulang." },
  upcoding: { claim_id: "CLM-2026-9942", patient_age: 29, ina_cbg_code: "A-4-13-III", primary_diagnosis: "A41.9", claimed_cost: 18450000, real_cost: 3150000,
    length_of_stay_days: 2, clinical_notes: "Pasien datang dengan keluhan demam tifoid dan mual. Diberikan infus RL dan obat oral. Hari kedua demam turun dan pasien meminta pulang paksa. Tidak ada tindakan pemasangan ventilator atau observasi ICU." },
};

export function ProduksiView() {
  const [p, setP] = useState<Production | null>(null);
  const [run, setRun] = useState<ProdRun | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Rec | null>(null);
  const [glosarium, setGlosarium] = useState(false);
  const load = async () => {
    try {
      const s = await fraud.production();
      setP(s);
      const last = s.runs[0];
      if (last) setRun(await fraud.productionRun(last.id));
    } catch (e) { setErr((e as Error).message); }
    fraud.health().then(setHealth).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the pipeline's state on entry
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (run?.status !== "berjalan") return;
    const t = setInterval(async () => { const r = await fraud.productionRun(run.id).catch(() => null); if (r) setRun(r); if (r && r.status !== "berjalan") load(); }, 4000);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);
  const start = async () => {
    setBusy(true); setErr("");
    try { const r = await fraud.runPipeline(); setRun(r); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const toggle = async () => {
    if (!p) return;
    try { await fraud.schedule({ aktif: !p.jadwal.aktif, jam: Number(p.jadwal.jam ?? 24), saat_data_baru: p.jadwal.saat_data_baru !== false }); load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const stages: Stage[] = run?.laporan?.tahap ?? [];
  const sel = stages.find((s) => s.id === stage) ?? stages.find((s) => s.status === "gagal") ?? null;
  const drift = (stages.find((s) => s.id === "fitur")?.drift as { fitur: string; psi: number }[] | undefined) ?? [];
  const perf = stages.find((s) => s.id === "kinerja")?.kinerja as Rec | undefined;
  const parity = stages.find((s) => s.id === "toko_fitur")?.paritas as Rec | undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-[12px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-[#1c2127] px-4 py-2">
        <p className="text-[13px] font-semibold text-white">Pipeline Produksi Deteksi Fraud</p>
        <span className="text-[#abb3bf]">otomatis end-to-end: data masuk → proses → keluaran, dengan gerbang validasi di setiap tahap</span>
        <div className="ml-auto flex items-center gap-2">
          {p && <button onClick={toggle} className={`rounded border px-2 py-0.5 ${p.jadwal.aktif ? "border-[#29a383] text-[#7ee2c0]" : "border-white/15 text-[#d3d8de]"}`}
            title="Jadwal: berjalan tiap N jam dan saat versi baru data klaim (Data Bersih) muncul (pemantau tiap 10 menit)">Jadwal {p.jadwal.aktif ? `aktif · tiap ${p.jadwal.jam} jam${p.jadwal.saat_data_baru !== false ? " + data baru" : ""}` : "mati"}</button>}
          <button onClick={() => setGlosarium(true)} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10" title="Arti istilah dataset: kapitasi, non-kapitasi, FKRTL, INA-CBG, LOS, tag indikasi, kolom Data Bersih / Siap Analisis">Glosarium</button>
          <a href="/lineage" className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10">Data Lineage ↗</a>
          <button disabled={busy || run?.status === "berjalan"} onClick={start} className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1 font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="play" className="h-3 w-3" />{run?.status === "berjalan" ? "Berjalan…" : "Jalankan pipeline"}
          </button>
        </div>
      </div>
      {err && <p className="px-4 pt-2 text-red-300">{err}</p>}
      {glosarium && <GlosariumDialog onClose={() => setGlosarium(false)} />}

      <div className="space-y-3 p-3">
        <section className="rounded border border-white/10 bg-[#1c2127] p-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4">
            <p className="font-semibold text-white">Run {run?.id ?? "—"}</p>
            {run && <span style={{ color: COLOR[run.status] }}>{run.status}</span>}
            {run && <span className="text-[#8f99a8]">pemicu {run.pemicu} · {wib(run.mulai)} · model {run.model_versi}</span>}
            {run?.error && <span className="text-[#ffb4b4]">{run.error.slice(0, 300)}</span>}
          </div>
          <div className="flex flex-wrap items-stretch gap-1">
            {(stages.length ? stages : Object.keys(STAGE_LABEL).map((id) => ({ id, label: STAGE_LABEL[id], status: "", cek: [] }) as Stage)).map((s, i) => {
              const bad = s.cek.filter((c) => c.status === "gagal").length, warn = s.cek.filter((c) => c.status === "peringatan").length;
              return (
                <div key={s.id} className="flex items-center">
                  {i > 0 && <span className="px-0.5 text-[#4b5563]">→</span>}
                  <button onClick={() => setStage(s.id)} className={`min-w-[104px] rounded border px-2 py-1 text-left ${sel?.id === s.id ? "bg-white/[.06]" : ""}`}
                    style={{ borderColor: `${COLOR[s.status] ?? "#4b5563"}99` }}>
                    <p className="text-[11px] font-medium text-[#e5e8eb]">{STAGE_LABEL[s.id] ?? s.label}</p>
                    <p className="text-[10px]" style={{ color: COLOR[s.status] ?? "#8f99a8" }}>{s.status || "—"}{s.detik != null ? ` · ${s.detik} s` : ""}</p>
                    <p className="text-[10px] text-[#8f99a8]">{s.cek.length} cek{bad ? ` · ${bad} gagal` : ""}{warn ? ` · ${warn} peringatan` : ""}</p>
                  </button>
                </div>
              );
            })}
          </div>
          {run?.status === "berjalan" && run.log && <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10.5px] text-[#abb3bf]">{run.log.slice(-8).join("\n")}</pre>}
          {sel && (
            <div className="mt-2 overflow-x-auto">
              <p className="mb-1 font-semibold text-[#e5e8eb]">{STAGE_LABEL[sel.id] ?? sel.label}: cek</p>
              <table className="w-full text-left text-[11px]">
                <thead className="text-[#8f99a8]"><tr><th className="py-0.5 pr-2">cek</th><th className="pr-2">nilai</th><th className="pr-2">ambang</th><th>status</th></tr></thead>
                <tbody>{sel.cek.map((c) => (
                  <tr key={c.id} className="border-t border-white/5">
                    <td className="py-0.5 pr-2 text-[#d3d8de]">{c.cek}{c.blok ? <span className="ml-1 text-[9.5px] text-[#8f99a8]">(gerbang)</span> : null}</td>
                    <td className="pr-2 font-mono text-[10.5px] text-[#c5cbd3]">{typeof c.nilai === "object" ? JSON.stringify(c.nilai).slice(0, 80) : String(c.nilai).slice(0, 40)}</td>
                    <td className="pr-2 text-[#8f99a8]">{c.ambang}</td>
                    <td style={{ color: COLOR[c.status] }}>{c.status}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid gap-3 xl:grid-cols-3">
          <section className="rounded border border-white/10 bg-[#1c2127] p-3">
            <p className="mb-1 font-semibold text-white">Drift fitur (PSI vs referensi model)</p>
            <p className="mb-2 text-[10.5px] text-[#8f99a8]">&lt; {String(p?.ambang?.psi_peringatan ?? 0.1)} stabil · ≥ {String(p?.ambang?.psi_blok ?? 0.25)} pada fitur teratas model menghentikan pipeline</p>
            {drift.slice(0, 12).map((d) => (
              <div key={d.fitur} className="mb-0.5 flex items-center gap-2 text-[11px]">
                <span className="w-[150px] truncate text-[#d3d8de]">{d.fitur}</span>
                <span className="h-2 flex-1 rounded bg-white/5"><span className="block h-2 rounded" style={{ width: `${Math.min(100, (d.psi / 0.3) * 100)}%`, background: d.psi >= 0.25 ? "#e5484d" : d.psi >= 0.1 ? "#fab219" : "#29a383" }} /></span>
                <span className="w-12 text-right tabular-nums text-[#abb3bf]">{d.psi.toFixed(3)}</span>
              </div>
            ))}
            {!drift.length && <p className="text-[#8f99a8]">Belum ada run.</p>}
          </section>
          <section className="rounded border border-white/10 bg-[#1c2127] p-3">
            <p className="mb-1 font-semibold text-white">Format deployment</p>
            {Object.entries(p?.signature ?? {}).map(([seg, i]) => (
              <div key={seg} className="mb-1.5 text-[11px]">
                <p className="text-[#e5e8eb]">{seg}: <b>{String(i.model)}</b> · disajikan dari {String(i.disajikan_dari)}</p>
                <p className="text-[#8f99a8]">.onnx {i.onnx ? `${(Number(i.onnx_bytes) / 1e6).toFixed(1)} MB · ${String(i.onnx_konverter)} · paritas max |Δp| ${Number(i.paritas_max_abs).toExponential(1)} (${String(i.paritas_n)} klaim)` : `tidak dibuat: ${String(i.onnx_error ?? "")}`}</p>
                <p className="text-[#8f99a8]">ambang {Number(i.ambang).toFixed(4)} · beta {Number(i.beta).toFixed(3)}</p>
              </div>
            ))}
            {p?.format && Object.entries(p.format).map(([k, v]) => <p key={k} className="text-[10.5px] text-[#abb3bf]"><b className="text-[#d3d8de]">.{k}</b> {v}</p>)}
            {parity && <p className="mt-1 text-[10.5px] text-[#abb3bf]"><b className="text-[#d3d8de]">Paritas online/batch:</b> {String(parity.dibandingkan)} klaim nyata, {String(parity.fitur_cocok_semua)}/{String(parity.fitur)} fitur cocok 100%, selisih skor {String(parity.skor_max_abs)}; kontrak menolak {String(parity.jumlah_ditolak)}.</p>}
          </section>
          <section className="rounded border border-white/10 bg-[#1c2127] p-3">
            <p className="mb-1 font-semibold text-white">Layanan online</p>
            {health ? (
              <div className="space-y-0.5 text-[11px] text-[#abb3bf]">
                <p>Status <b className="text-[#7ee2c0]">{String(health.status)}</b> · deploy {String(health.deploy?.run ?? "—")}</p>
                <p>24 jam: {String(health.lalu_lintas_24j?.permintaan ?? 0)} permintaan, {String(health.lalu_lintas_24j?.klaim ?? 0)} klaim, p50 {health.lalu_lintas_24j?.ms_per_klaim_p50 ? `${Math.round(health.lalu_lintas_24j.ms_per_klaim_p50)} ms` : "—"}/klaim</p>
                <p>Penyimpanan fitur: {Object.entries(health.toko_fitur ?? {}).map(([k, v]) => `${k} ${(Number(v) / 1e6).toFixed(1)} MB`).join(" · ")}</p>
              </div>
            ) : <p className="text-[#8f99a8]">Belum ada deploy.</p>}
            {perf && <p className="mt-2 text-[10.5px] text-[#8f99a8]">Kinerja: {perf.klaim_baru ? `${String(perf.klaim_baru)} klaim berlabel baru setelah ${String(perf.batas_latih)}` : `belum ada klaim berlabel setelah ${String(perf.batas_latih)}: uji out-of-time menunggu data baru`}.</p>}
          </section>
        </div>

        <VerifyConsole />

        <section className="rounded border border-white/10 bg-[#1c2127] p-3">
          <p className="mb-1 font-semibold text-white">Riwayat run</p>
          <table className="w-full text-left text-[11px]">
            <thead className="text-[#8f99a8]"><tr><th className="py-0.5">run</th><th>status</th><th>pemicu</th><th>mulai</th><th>baris</th><th>ditandai</th><th>peringatan</th></tr></thead>
            <tbody>{(p?.runs ?? []).map((r) => (
              <tr key={r.id} onClick={async () => setRun(await fraud.productionRun(r.id))} className="cursor-pointer border-t border-white/5 hover:bg-white/[.03]">
                <td className="py-0.5 font-mono text-[10.5px] text-[#d3d8de]">{r.id}</td><td style={{ color: COLOR[r.status] }}>{r.status}</td><td>{r.pemicu}</td>
                <td>{wib(r.mulai)}</td><td className="tabular-nums">{Number(r.ringkasan?.baris ?? 0).toLocaleString("id-ID")}</td>
                <td className="tabular-nums">{String(r.ringkasan?.ditandai ?? "—")}</td><td>{String(r.ringkasan?.peringatan ?? "—")}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/** POST /verify, live: one claim (the judges' columns as a form, any JSON, or a claim of the data by id) or many (a
    CSV, one claim per row, verified in the background); each stage's time drawn. */
function VerifyConsole() {
  const [tab, setTab] = useState<"satu" | "banyak">("satu");
  return (
    <section className="rounded border border-[#b8a9ff]/30 bg-[#1c2127] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-semibold text-white">Inference Pipeline · POST /verify</p>
        <div className="flex overflow-hidden rounded border border-white/15 text-[11px]">
          {([["satu", "Satu klaim"], ["banyak", "Banyak klaim · CSV"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-2.5 py-0.5 ${tab === k ? "bg-[#5b5fd6] text-white" : "text-[#d3d8de] hover:bg-white/10"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="mb-2 mt-1 text-[10.5px] text-[#8f99a8]">Client Request → Schema Validation (Pydantic) → Feature Engineering → ML Inference (model.pkl) → LLM Service (httpx AsyncClient, gerbang angka, circuit breaker) → JSON Response {"{status, fraud_probability, ai_reasoning}"}</p>
      {/* both stay mounted: a batch keeps its progress while one claim is tried */}
      <div className={tab === "satu" ? "" : "hidden"}><SingleVerify /></div>
      <div className={tab === "banyak" ? "" : "hidden"}><BatchVerify /></div>
    </section>
  );
}

const FIELDS: { k: string; hint: string; num?: boolean }[] = [
  { k: "claim_id", hint: "CLM-2026-0001" }, { k: "patient_age", hint: "tahun", num: true }, { k: "ina_cbg_code", hint: "A-4-13-III" },
  { k: "primary_diagnosis", hint: "ICD-10, A41.9" }, { k: "claimed_cost", hint: "Rp ditagihkan", num: true }, { k: "real_cost", hint: "Rp tarif acuan", num: true },
  { k: "length_of_stay_days", hint: "hari", num: true },
];
const NUMERIC = new Set(FIELDS.filter((f) => f.num).map((f) => f.k));

/** A number as people type it (Rp 18.450.000, 18,450,000, 3,5), read as the CSV reader reads it; text when it is not one. */
function toNum(v: string): number | string {
  const t = v.replace(/^rp\.?/i, "").replace(/\s/g, "");
  const s = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  const n = Number(s);
  return t !== "" && Number.isFinite(n) ? n : v;
}
const toForm = (o: Rec) => Object.fromEntries([...FIELDS.map((f) => f.k), "clinical_notes"].map((k) => [k, o[k] == null ? "" : String(o[k])]));
const fromForm = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, NUMERIC.has(k) ? toNum(v) : v]));

function SingleVerify() {
  const [mode, setMode] = useState<"isian" | "json">("isian");
  const [form, setForm] = useState<Record<string, string>>(toForm(JURI.upcoding));
  const [body, setBody] = useState(JSON.stringify(JURI.upcoding, null, 1));
  const [kid, setKid] = useState("");
  const [second, setSecond] = useState(false);
  const [res, setRes] = useState<Verify | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const example = (o: Rec) => { setForm(toForm(o)); setBody(JSON.stringify(o, null, 1)); };
  const switchTo = (m: "isian" | "json") => {
    setErr("");
    if (m === "json") { setBody(JSON.stringify(fromForm(form), null, 1)); setMode(m); return; }
    try {
      const o = JSON.parse(body);
      if (!o || typeof o !== "object" || !("claim_id" in o)) { setErr("Isian hanya untuk format juri; kontrak klaim lengkap (kolom Data Bersih) lewat JSON."); return; }
      setForm(toForm(o)); setMode(m);
    } catch { setErr("JSON tidak valid: perbaiki dulu."); }
  };
  const send = async (byId = false) => {
    setBusy(true); setErr(""); setRes(null);
    try {
      const payload = mode === "isian" ? fromForm(form) : JSON.parse(body);
      setRes(byId ? await fraud.verifyClaim(kid.trim(), second) : await fraud.verify({ ...payload, ...(second ? { pendapat_kedua: true } : {}) }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const bill = toNum(form.claimed_cost ?? ""), tariff = toNum(form.real_cost ?? "");
  const input = "w-full rounded-sm border border-white/15 bg-[#111418] px-2 py-1 font-mono text-[11px] text-[#d3d8de] outline-none focus:border-[#b8a9ff]/60";
  return (
    <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <button onClick={() => example(JURI.legitimate)} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10">Juri: wajar</button>
          <button onClick={() => example(JURI.upcoding)} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10">Juri: upcoding</button>
          <div className="ml-auto flex overflow-hidden rounded border border-white/15 text-[10.5px]">
            {(["isian", "json"] as const).map((m) => (
              <button key={m} onClick={() => switchTo(m)} className={`px-2 py-0.5 ${mode === m ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{m === "isian" ? "Isian" : "JSON"}</button>
            ))}
          </div>
        </div>
        {mode === "isian" ? (
          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-x-1.5 gap-y-1">
              {FIELDS.map((f) => (
                <label key={f.k} className="block min-w-0">
                  <span className="block truncate text-[10px] text-[#8f99a8]">{f.k} <span className="text-[#6b7480]">· {f.hint}</span></span>
                  <input value={form[f.k] ?? ""} onChange={(e) => setForm({ ...form, [f.k]: e.target.value })} inputMode={f.num ? "decimal" : undefined} className={input} />
                </label>
              ))}
            </div>
            <label className="block">
              <span className="text-[10px] text-[#8f99a8]">clinical_notes <span className="text-[#6b7480]">· dibaca telaah klinis LLM, tidak oleh model</span></span>
              <textarea value={form.clinical_notes ?? ""} onChange={(e) => setForm({ ...form, clinical_notes: e.target.value })} rows={5} className={`${input} resize-y`} />
            </label>
            {typeof bill === "number" && typeof tariff === "number" && tariff > 0 && (
              <p className="text-[10.5px] text-[#8f99a8]">tagihan {rp(bill)} = <b className="text-[#d3d8de]">{(bill / tariff).toFixed(2).replace(".", ",")}×</b> tarif acuan {rp(tariff)}</p>
            )}
          </div>
        ) : (
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} spellCheck={false} className="w-full resize-y rounded-sm border border-white/15 bg-[#111418] p-2 font-mono text-[10.5px] text-[#d3d8de] outline-none" />
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-[#abb3bf]"><input type="checkbox" checked={second} onChange={(e) => setSecond(e.target.checked)} />pendapat kedua (keluarga model lain)</label>
        <button disabled={busy} onClick={() => send(false)} className="w-full rounded-sm bg-[#5b5fd6] py-1 font-medium text-white disabled:opacity-40">{busy ? "Menilai…" : "Verifikasi klaim"}</button>
        <div className="flex gap-1">
          <input value={kid} onChange={(e) => setKid(e.target.value)} placeholder="klaim nyata: edisi:kunjungan_fkrtl_id" className="min-w-0 flex-1 rounded-sm border border-white/15 bg-[#111418] px-2 py-1 font-mono text-[10.5px] outline-none" />
          <button disabled={busy || !kid.trim()} onClick={() => send(true)} className="rounded-sm border border-white/15 px-2 text-[11px] text-[#d3d8de] disabled:opacity-40">Verifikasi</button>
        </div>
        {err && <p className="text-[11px] text-red-300">{err}</p>}
      </div>
      <div className="min-w-0">
        {res ? <VerifyResult res={res} /> : <p className="pt-6 text-center text-[#8f99a8]">Isi klaim (atau pakai payload juri), atau sebut sebuah klaim nyata, untuk melihat keenam tahapnya.</p>}
      </div>
    </div>
  );
}

/** One /verify answer: each stage's time, the verdict, the clinical review, the model's reasons. */
function VerifyResult({ res }: { res: Verify }) {
  const total = res.pipeline.reduce((n, s) => n + s.ms, 0);
  const v = VERDICT[res.status];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {res.pipeline.map((s) => (
          <div key={s.tahap} className="min-w-[110px] flex-1 rounded border border-white/10 bg-black/20 px-2 py-1" title={s.keterangan}>
            <p className="text-[10px] text-[#8f99a8]">{s.tahap.replace(/^\d+_/, "").replace(/_/g, " ")}</p>
            <p className="text-[12px] font-semibold tabular-nums text-white">{s.ms.toFixed(0)} ms</p>
            <div className="mt-0.5 h-1 rounded bg-white/5"><div className="h-1 rounded bg-[#b8a9ff]" style={{ width: `${total ? Math.max(2, (100 * s.ms) / total) : 2}%` }} /></div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded px-2 py-0.5 text-[12px] font-bold text-black" style={{ background: v?.color }}>{res.status}</span>
        <span className="text-[#d3d8de]">fraud_probability <b className="tabular-nums text-white">{res.fraud_probability.toFixed(6)}</b></span>
        <span className="text-[11px] text-[#8f99a8]">{String(res.ml?.model)} · {String(res.ml?.mesin)}</span>
      </div>
      <p className="text-[11px] text-[#abb3bf]">{res.status_label} · {res.arti_probabilitas}</p>
      <p className="rounded bg-white/[.04] p-2 text-[12px] text-[#e5e8eb]"><b className="text-[#b8a9ff]">ai_reasoning</b> {res.ai_reasoning}</p>
      {res.analisis_medis?.telaah && <ReviewCard r={res.analisis_medis.telaah} second={res.analisis_medis.pendapat_kedua} agree={res.analisis_medis.sepakat} aside={res.di_luar_prompt} />}
      {res.indikasi.length > 0 && <p className="text-[11px] text-[#abb3bf]"><b>Tag aturan:</b> {res.indikasi.map((t) => `${t.label} (${t.bukti})`).join("; ")}</p>}
      {res.ml?.alasan_teks && <p className="text-[11px] text-[#abb3bf]"><b>Alasan model (TreeSHAP):</b> {String(res.ml.alasan_teks)}</p>}
      {res.peringatan.length > 0 && <p className="text-[10.5px] text-[#fbd38d]">{res.peringatan.join(" · ")}</p>}
      <details><summary className="cursor-pointer text-[11px] text-[#8f99a8]">JSON respons</summary><pre className="mt-1 max-h-64 overflow-auto rounded bg-black/30 p-2 text-[10px] text-[#c5cbd3]">{JSON.stringify(res, null, 1)}</pre></details>
    </div>
  );
}

const BUCKET: Record<string, { label: string; color: string }> = {
  INDIKASI_KUAT: VERDICT.INDIKASI_KUAT, PERLU_DIPERIKSA: VERDICT.PERLU_DIPERIKSA, WAJAR: VERDICT.WAJAR,
  DITOLAK: { label: "Ditolak kontrak", color: "#8f99a8" }, GALAT: { label: "Galat", color: "#c084fc" },
};
const JOB_COLOR: Record<string, string> = { berjalan: "#b8a9ff", selesai: "#29a383", gagal: "#e5484d", dibatalkan: "#8f99a8", terhenti: "#fab219" };
const PAGE = 100;
const bucketOf = (r: BatchRow) => (r.ditolak ? "DITOLAK" : r.galat || !r.ringkas ? "GALAT" : r.ringkas.status);

/** Many claims: a CSV, one claim per row, through the same six stages in the background; progress, the claims by
    verdict, each claim's whole answer, the results as a CSV (the input's columns, then the answer's). */
function BatchVerify() {
  const [file, setFile] = useState<File | null>(null);
  const [second, setSecond] = useState(false);
  const [job, setJob] = useState<VerifyBatch | null>(null);
  const [list, setList] = useState<VerifyBatch[]>([]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<(BatchRow & { masukan: Rec; hasil: Verify | null }) | null>(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const history = () => fraud.verifyBatches().then(setList).catch(() => {});
  const load = async (id: string, f: string, p: number) => setJob(await fraud.verifyBatch(id, { status: f, offset: p * PAGE, limit: PAGE }));
  useEffect(() => { history(); }, []);
  useEffect(() => {
    if (!job || job.status !== "berjalan") return;
    const t = setInterval(async () => {
      const j = await fraud.verifyBatch(job.id, { status: filter, offset: page * PAGE, limit: PAGE }).catch(() => null);
      if (j) { setJob(j); if (j.status !== "berjalan") history(); }
    }, 2500);
    return () => clearInterval(t);
  }, [job?.id, job?.status, filter, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (f: () => Promise<unknown>) => { setErr(""); try { await f(); } catch (e) { setErr((e as Error).message); } };
  const start = () => run(async () => {
    if (!file) return;
    setBusy(true); setOpen(null); setDetail(null); setFilter(""); setPage(0);
    try { setJob(await fraud.verifyCsv(file, second)); history(); } finally { setBusy(false); }
  });
  const choose = (id: string) => run(async () => { setOpen(null); setDetail(null); setFilter(""); setPage(0); await load(id, "", 0); });
  const refilter = (k: string) => run(async () => { if (!job) return; const f = filter === k ? "" : k; setFilter(f); setPage(0); setOpen(null); await load(job.id, f, 0); });
  const turn = (p: number) => run(async () => { if (!job) return; setPage(p); setOpen(null); await load(job.id, filter, p); });
  const toggle = (no: number) => run(async () => {
    if (!job) return;
    if (open === no) { setOpen(null); setDetail(null); return; }
    setOpen(no); setDetail(null);
    setDetail(await fraud.verifyBatchRow(job.id, no));
  });
  const cancel = () => run(async () => { if (job) setJob({ ...job, ...(await fraud.cancelVerifyBatch(job.id)) }); });
  const save = () => run(async () => {
    if (job) await fraud.download(`/api/aip/fraud/v1/verify/batch/${job.id}/unduh`, `hasil-${(job.berkas ?? job.id).replace(/\.csv$/i, "")}.csv`);
  });
  const template = (examples = false) => run(() => fraud.download(`/api/aip/fraud/v1/verify/csv/templat${examples ? "?contoh=true" : ""}`,
    examples ? "contoh-klaim.csv" : "templat-verifikasi-klaim.csv"));
  const pick = (f?: File | null) => { if (f) { setFile(f); setErr(""); } };
  const pages = job ? Math.ceil((job.total_baris ?? 0) / PAGE) : 0;
  const retrying = !!job && job.status === "berjalan" && job.selesai >= job.jumlah && job.llm_fallback > 0;
  return (
    <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
      <div className="space-y-2">
        <div role="button" tabIndex={0} onClick={() => picker.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") picker.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded border border-dashed px-3 py-5 text-center ${drag ? "border-[#b8a9ff] bg-[#b8a9ff]/10" : "border-white/20 hover:bg-white/[.03]"}`}>
          <Icon name="upload" className="h-5 w-5 text-[#b8a9ff]" />
          <p className="text-[12px] text-[#e5e8eb]">{file ? file.name : "Tarik berkas CSV ke sini, atau klik untuk memilih"}</p>
          <p className="text-[10.5px] text-[#8f99a8]">{file ? `${(file.size / 1024).toFixed(1).replace(".", ",")} KB` : "satu klaim per baris · maks. 2.000 klaim"}</p>
          <input ref={picker} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div className="space-y-0.5 text-[10.5px] leading-relaxed text-[#8f99a8]">
          <p><b className="text-[#d3d8de]">Kolom format juri:</b> claim_id, patient_age, ina_cbg_code, primary_diagnosis, claimed_cost, real_cost, length_of_stay_days, clinical_notes.</p>
          <p>Atau kontrak klaim lengkap (kunjungan_fkrtl_id, …), atau satu kolom <span className="font-mono">klaim_id</span> untuk klaim nyata (edisi:kunjungan_fkrtl_id).</p>
          <p>Pemisah , atau ; dari Excel — angka seperti Rp 18.450.000 dibaca benar. Kolom lain (mis. label Anda) ikut ke hasil, tidak dikirim ke model.</p>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[#abb3bf]"><input type="checkbox" checked={second} onChange={(e) => setSecond(e.target.checked)} />pendapat kedua (keluarga model lain, 2× panggilan LLM)</label>
        <button disabled={!file || busy} onClick={start} className="w-full rounded-sm bg-[#5b5fd6] py-1 font-medium text-white disabled:opacity-40">{busy ? "Mengunggah…" : "Verifikasi CSV"}</button>
        <div className="flex gap-1">
          <button onClick={() => template()} title="kolom format juri dengan dua payload juri"
            className="flex flex-1 items-center justify-center gap-1 rounded-sm border border-white/15 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10"><Icon name="download" className="h-3 w-3" />Templat</button>
          <button onClick={() => template(true)} title="dua payload juri + lima klaim buatan (bukan data BPJS) gaya Excel Indonesia, dengan kolom label"
            className="flex flex-1 items-center justify-center gap-1 rounded-sm border border-white/15 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10"><Icon name="download" className="h-3 w-3" />Contoh 7 klaim</button>
        </div>
        {err && <p className="text-[11px] text-red-300">{err}</p>}
        {list.length > 0 && (
          <div>
            <p className="mb-0.5 text-[10.5px] font-semibold text-[#abb3bf]">Riwayat batch</p>
            <div className="max-h-44 space-y-px overflow-y-auto">
              {list.map((b) => (
                <button key={b.id} onClick={() => choose(b.id)} className={`flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[10.5px] hover:bg-white/[.05] ${job?.id === b.id ? "bg-white/[.07]" : ""}`}>
                  <span className="min-w-0 flex-1 truncate text-[#d3d8de]">{b.berkas ?? "daftar JSON"}</span>
                  <span className="tabular-nums text-[#8f99a8]">{b.jumlah} klaim</span>
                  <span style={{ color: JOB_COLOR[b.status] }}>{b.status}</span>
                  <span className="tabular-nums text-[#6b7480]">{b.dibuat?.slice(5, 16).replace("T", " ")}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="min-w-0">
        {job ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="font-semibold text-white">{job.berkas ?? "Daftar JSON"}</p>
              <span style={{ color: JOB_COLOR[job.status] }}>{job.status}{retrying ? " · mengulang telaah yang jatuh ke fallback" : ""}</span>
              <span className="text-[#8f99a8]">format {job.format} · {job.jumlah} klaim{job.ditolak ? ` · ${job.ditolak} ditolak kontrak` : ""}{job.detik != null ? ` · ${Math.round(job.detik)} dtk` : ""}</span>
              <div className="ml-auto flex gap-1">
                {job.status === "berjalan" && <button onClick={cancel} disabled={job.batal} className="rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10 disabled:opacity-40">{job.batal ? "Membatalkan…" : "Batalkan"}</button>}
                <button onClick={save} disabled={!job.selesai} className="flex items-center gap-1 rounded bg-[#29a383] px-2 py-0.5 text-[11px] font-medium text-black disabled:opacity-40"><Icon name="download" className="h-3 w-3" />Unduh hasil CSV</button>
              </div>
            </div>
            <div className="h-1.5 rounded bg-white/5"><div className="h-1.5 rounded bg-[#b8a9ff] transition-all" style={{ width: `${job.jumlah ? (100 * job.selesai) / job.jumlah : 0}%` }} /></div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] tabular-nums text-[#abb3bf]">{job.selesai}/{job.jumlah} selesai</span>
              {Object.entries(BUCKET).map(([k, b]) => job.per_status?.[k] ? (
                <button key={k} onClick={() => refilter(k)} title={filter === k ? "tampilkan semua" : `hanya ${b.label}`}
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] ${filter === k ? "bg-white/10" : "hover:bg-white/[.05]"}`} style={{ borderColor: `${b.color}80` }}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: b.color }} /><span className="text-[#d3d8de]">{b.label}</span><b className="tabular-nums text-white">{job.per_status[k]}</b>
                </button>
              ) : null)}
              {filter && <button onClick={() => refilter(filter)} className="text-[10.5px] text-[#8f99a8] underline">semua</button>}
              {job.llm_fallback > 0 && <span className="text-[10.5px] text-[#fbd38d]">{job.llm_fallback} telaah fallback deterministik</span>}
              {job.dicoba_ulang > 0 && <span className="text-[10.5px] text-[#8f99a8]">{job.dicoba_ulang} dicoba ulang</span>}
            </div>
            {(job.kolom_tambahan.length > 0 || job.peringatan.length > 0 || job.error) && (
              <p className="text-[10.5px] text-[#fbd38d]">{[job.kolom_tambahan.length ? `kolom ${job.kolom_tambahan.join(", ")} ikut ke hasil, tidak dikirim ke model` : "", ...job.peringatan, job.error ?? ""].filter(Boolean).join(" · ")}</p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[#8f99a8]">
                  <tr><th className="py-0.5 pr-2 font-normal">baris</th><th className="pr-2 font-normal">klaim</th><th className="pr-2 font-normal">status</th>
                    <th className="pr-2 text-right font-normal">fraud_probability</th><th className="pr-2 font-normal">telaah klinis</th><th className="font-normal">ai_reasoning · alasan</th></tr>
                </thead>
                <tbody>
                  {(job.baris ?? []).map((r) => {
                    const b = BUCKET[bucketOf(r)];
                    return (
                      <Fragment key={r.no}>
                        <tr onClick={() => toggle(r.no)} className={`cursor-pointer border-t border-white/5 align-top hover:bg-white/[.03] ${open === r.no ? "bg-white/[.05]" : ""}`}>
                          <td className="py-1 pr-2 tabular-nums text-[#8f99a8]">{r.no}</td>
                          <td className="max-w-[160px] truncate pr-2 font-mono text-[10.5px] text-[#d3d8de]">{r.id || "—"}</td>
                          <td className="pr-2"><span className="whitespace-nowrap rounded px-1.5 py-px text-[10px] font-bold text-black" style={{ background: b.color }}>{bucketOf(r)}</span></td>
                          <td className="pr-2 text-right tabular-nums text-white">{r.ringkas ? r.ringkas.fraud_probability.toFixed(6) : "—"}</td>
                          <td className="whitespace-nowrap pr-2 text-[#abb3bf]">{r.ringkas?.kesimpulan_klinis ? (VERDICT[r.ringkas.kesimpulan_klinis]?.label ?? r.ringkas.kesimpulan_klinis) : "—"}
                            {r.ringkas?.llm_fallback ? <span className="ml-1 text-[#fbd38d]">fallback</span> : null}</td>
                          <td className={r.ringkas ? "text-[#c5cbd3]" : "text-[#d3a8ff]"}><span className="line-clamp-2">{r.ringkas?.ai_reasoning ?? r.galat}</span></td>
                        </tr>
                        {open === r.no && (
                          <tr><td colSpan={6} className="bg-black/20 p-2">
                            {!detail ? <p className="text-[#8f99a8]">Memuat…</p> : detail.hasil ? <VerifyResult res={detail.hasil} /> : (
                              <div className="space-y-1">
                                <p className="text-[11px] text-[#d3a8ff]">{detail.ditolak ? "Ditolak kontrak (tidak dikirim ke pipeline)" : "Gagal di pipeline"}: {detail.galat}</p>
                                <pre className="max-h-48 overflow-auto rounded bg-black/30 p-2 text-[10px] text-[#c5cbd3]">{JSON.stringify(detail.masukan, null, 1)}</pre>
                              </div>
                            )}
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {!job.baris?.length && <p className="py-4 text-center text-[#8f99a8]">{job.status === "berjalan" ? "Menunggu klaim pertama selesai…" : "Tidak ada baris."}</p>}
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 text-[11px] text-[#abb3bf]">
                <button disabled={page === 0} onClick={() => turn(page - 1)} className="rounded border border-white/15 px-2 disabled:opacity-30">‹</button>
                <span className="tabular-nums">halaman {page + 1}/{pages} · {job.total_baris} baris</span>
                <button disabled={page + 1 >= pages} onClick={() => turn(page + 1)} className="rounded border border-white/15 px-2 disabled:opacity-30">›</button>
              </div>
            )}
          </div>
        ) : <p className="pt-6 text-center text-[#8f99a8]">Unggah CSV klaim (unduh templat untuk kolomnya): setiap baris melewati enam tahap yang sama; hasilnya bisa diunduh sebagai CSV.</p>}
      </div>
    </div>
  );
}
