"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { modelName, wib } from "@/components/aip/aipRun";

/* Konfigurasi agen (the user, 2026-10-29: "tombol configure agent disini, jadi saya bisa liat algoritma yang digunakan agen,
   tool yang digunakan agen, prompt yang digunakan agen dan semua konfigurasi dari masing2 agen yang bisa di edit juga"):
   every agent of the AI Agent Swarm — its algorithm, its tools (and how the last engagement used them), the prompt template
   parsed from the runtime's code and the real instruction of the last engagement, and the settings an admin may change
   (api/aip/konfigurasi_agen.py, which checks each in code). A change holds for engagements started after it. */

type Eff = { model: string; langkah_tool: number | null; panggilan_model: number | null; token_jawaban: number | null; penalaran: string;
  tool_nonaktif: string[]; instruksi_tambahan: string; lipatan?: number; faskes_teratas?: number };
type Row = { key: string; name: string; lini: string; jenjang: string; induk: string | null; peran: string; peran_kode: string; jenis: string;
  model_bawaan: string; efektif: Eff; diubah: boolean; diubah_pada?: string | null; teknik?: string | null };
type ModelOpt = { id: string; label: string; keluarga: string; siap: boolean };
type List = { agen: Row[]; mesin: { key: string; name: string; peran: string; algoritma: string }[]; model: ModelOpt[]; penalaran: string[];
  batas: Record<string, { min: number; maks: number }>; riwayat: { t: string; oleh: string; agen: string; nama?: string; ke: Record<string, unknown> }[] };
type Tool = { nama: string; deskripsi: string; wajib: boolean; nonaktif: boolean; dipanggil: number; gagal: number };
type Detail = Row & {
  algoritma: { ringkas: string; teknik?: string; keluarga?: string; rujukan?: string; protokol?: Record<string, string | number>;
    riset?: { penulis: string; tahun: number; judul: string; venue: string; url?: string }[] };
  aturan_firma?: string; tool: Tool[]; tool_lain_dipanggil: { nama: string; dipanggil: number; gagal: number }[];
  penugasan_acuan: { run: string | null; nama?: string | null }; prompt: { judul: string; fungsi: string; teks: string | null }[];
  skill: { key: string; nama: string; untuk?: string; langkah?: string[]; keluaran?: string; versi?: string; pelajaran?: string[] }[];
  instruksi_terakhir: { run: string; t?: string; model?: string; batas?: Record<string, unknown>; tools?: string[]; teks?: string; prompt?: string } | null;
  bawaan: Eff; setelan: Partial<Eff>;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const d = body.detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 400) : `${r.status} ${r.statusText}`);
  }
  return r.json();
}
const api = {
  list: () => req<List>("/api/aip/agen-swarm"),
  get: (key: string) => req<Detail>(`/api/aip/agen-swarm/${encodeURIComponent(key)}`),
  save: (key: string, body: unknown) => req<Detail>(`/api/aip/agen-swarm/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  reset: (key: string) => req<Detail>(`/api/aip/agen-swarm/${encodeURIComponent(key)}`, { method: "DELETE" }),
};

const TABS = [["ringkas", "Ringkasan"], ["algoritma", "Algoritma"], ["tool", "Tool"], ["prompt", "Prompt"], ["setelan", "Setelan"]] as const;
type Tab = (typeof TABS)[number][0];
const JENIS: Record<string, string> = { partner: "Orkestrator", manajer: "Agen domain", analis: "Analis lapangan", ml: "Sub-agen teknik ML", penyidik: "Penyidik (peran)",
  qa: "Reviewer QA", red_team: "Red team (peran)", validator: "Validator", editor: "Editor laporan", analis_exhibit: "Analis exhibit", redaksi: "Meja redaksi (kode)" };
const field = "w-full rounded-sm border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] text-[#e5e8eb] outline-none focus:border-[#5b5fd6]";
const pre = "max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-[#111418] p-3 font-mono text-[11px] leading-relaxed text-[#d3d8de]";

export function KonfigurasiAgen({ lini, onClose }: { lini: Record<string, { label: string; color: string }>; onClose: () => void }) {
  const [list, setList] = useState<List | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const load = () => api.list().then((l) => { setList(l); setSel((s) => s ?? l.agen[0]?.key ?? null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);  // once, when the dialog opens
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const rows = (list?.agen ?? []).filter((a) => !t || `${a.name} ${a.key} ${a.peran} ${a.efektif.model} ${a.teknik ?? ""}`.toLowerCase().includes(t));
    const by: Record<string, Row[]> = {};
    for (const a of rows) (by[a.lini] ??= []).push(a);
    return Object.entries(by).sort(([x], [y]) => Object.keys(lini).indexOf(x) - Object.keys(lini).indexOf(y));
  }, [list, q, lini]);
  const changed = list?.agen.filter((a) => a.diubah).length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="konf-agen"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="flex h-[88vh] w-full max-w-[1240px] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#1c2127] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3">
          <Icon name="sliders" className="mt-0.5 h-4 w-4 text-[#9d8cff]" />
          <div className="min-w-0 flex-1">
            <p id="konf-agen" className="text-[14px] font-semibold text-white">Konfigurasi agen</p>
            <p className="text-[11.5px] text-[#abb3bf]">Algoritma, model, tool, prompt dan setelan tiap agen AI Agent Swarm. Perubahan berlaku untuk penugasan yang
              dimulai sesudahnya; penugasan yang sudah berjalan memakai setelan saat ia dimulai.{changed ? ` ${changed} agen diubah dari bawaan.` : ""}</p>
          </div>
          <button onClick={onClose} aria-label="Tutup" className="rounded p-1 text-[#8f99a8] hover:bg-white/10 hover:text-white"><Icon name="x" className="h-4 w-4" /></button>
        </div>
        {err && !list ? <p className="p-4 text-[12px] text-red-300">Konfigurasi agen tidak terbaca: {err}</p> : !list ? (
          <p className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[#8f99a8]"><Icon name="refresh" className="h-4 w-4 animate-spin" />Membaca agen firma…</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[290px] shrink-0 flex-col border-r border-white/10">
              <div className="p-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari agen, model, teknik…" aria-label="Cari agen" className={field} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {groups.map(([l, rows]) => (
                  <div key={l} className="mt-1">
                    <p className="flex items-center gap-1.5 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">
                      <span className="h-2 w-2 rounded-full" style={{ background: lini[l]?.color ?? "#8f99a8" }} />{lini[l]?.label ?? l} · {rows.length}
                    </p>
                    {rows.map((a) => (
                      <button key={a.key} onClick={() => setSel(a.key)}
                        className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11.5px] ${sel === a.key ? "bg-[#5b5fd6]/25 text-white" : "text-[#d3d8de] hover:bg-white/5"}`}>
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                        {a.diubah && <span className="shrink-0 rounded bg-[#fab219]/15 px-1 text-[9.5px] text-[#fab219]">diubah</span>}
                        <span className="shrink-0 font-mono text-[9.5px] text-[#8f99a8]">{a.efektif.model === "kode" ? "kode" : modelName(a.efektif.model).split("-").slice(0, 2).join("-")}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <p className="mt-3 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">Mesin (kode, tanpa model)</p>
                {list.mesin.map((m) => (
                  <details key={m.key} className="px-3 py-1 text-[11.5px] text-[#d3d8de]">
                    <summary className="cursor-pointer hover:text-white">{m.name}</summary>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#abb3bf]">{m.algoritma}</p>
                  </details>
                ))}
                {list.riwayat.length > 0 && (
                  <details className="mt-3 px-3 text-[11px] text-[#abb3bf]">
                    <summary className="cursor-pointer text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8] hover:text-white">Riwayat perubahan</summary>
                    {list.riwayat.map((r, i) => (
                      <p key={i} className="mt-1 leading-snug">{wib(r.t)} · {r.oleh}: {r.nama ?? r.agen} → {Object.keys(r.ke).length ? Object.keys(r.ke).join(", ") : "bawaan"}</p>
                    ))}
                  </details>
                )}
              </div>
            </div>
            {sel ? <AgentDetail key={sel} id={sel} list={list} lini={lini} onSaved={load} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentDetail({ id, list, lini, onSaved }: { id: string; list: List; lini: Record<string, { label: string; color: string }>; onSaved: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("ringkas");
  const [err, setErr] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one agent per mount (keyed by its id)
  useEffect(() => { api.get(id).then(setD).catch((e) => setErr((e as Error).message)); }, []);
  if (err && !d) return <p className="p-4 text-[12px] text-red-300">{err}</p>;
  if (!d) return <p className="flex flex-1 items-center justify-center gap-2 text-[12px] text-[#8f99a8]"><Icon name="refresh" className="h-4 w-4 animate-spin" />Membaca agen…</p>;
  const color = lini[d.lini]?.color ?? "#8f99a8";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-white/10 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          <p className="text-[14px] font-semibold text-white">{d.name}</p>
          <span className="rounded border border-white/15 px-1.5 text-[10.5px] text-[#abb3bf]">{JENIS[d.jenis] ?? d.jenis}</span>
          <span className="font-mono text-[10.5px] text-[#8f99a8]">{d.key}</span>
          {d.diubah && <span className="rounded bg-[#fab219]/15 px-1.5 text-[10.5px] text-[#fab219]">diubah {wib(d.diubah_pada)}</span>}
        </div>
        <p className="mt-1 text-[11.5px] leading-snug text-[#abb3bf]">{d.peran}</p>
        <div className="mt-2 flex gap-1">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-t px-3 py-1.5 text-[11.5px] ${tab === k ? "bg-[#111418] text-white" : "text-[#abb3bf] hover:text-white"}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#111418]/40 p-4 text-[12px] text-[#d3d8de]">
        {tab === "ringkas" && <Summary d={d} />}
        {tab === "algoritma" && <Algorithm d={d} />}
        {tab === "tool" && <Tools d={d} />}
        {tab === "prompt" && <Prompts d={d} />}
        {tab === "setelan" && <Settings d={d} list={list} onSaved={(x) => { setD(x); onSaved(); }} />}
      </div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex gap-3 border-b border-white/5 py-1.5"><span className="w-44 shrink-0 text-[#8f99a8]">{k}</span><span className="min-w-0 flex-1">{v}</span></div>;
}

function Summary({ d }: { d: Detail }) {
  const e = d.efektif;
  const used = d.tool.filter((t) => t.dipanggil);
  return (
    <div className="max-w-[760px]">
      <Kv k="Jenis" v={JENIS[d.jenis] ?? d.jenis} />
      <Kv k="Dipimpin oleh" v={d.induk ?? "—"} />
      <Kv k="Model" v={<span className="font-mono">{e.model}{e.model !== d.model_bawaan && <span className="ml-2 text-[#fab219]">(bawaan {d.model_bawaan})</span>}</span>} />
      {e.langkah_tool != null && <Kv k="Batas langkah tool" v={e.langkah_tool} />}
      {e.panggilan_model != null && <Kv k="Batas panggilan model" v={e.panggilan_model} />}
      {e.token_jawaban != null && <Kv k="Token jawaban" v={e.token_jawaban.toLocaleString("id-ID")} />}
      <Kv k="Penalaran" v={e.penalaran} />
      {d.teknik && <Kv k="Teknik ML" v={`${d.teknik} · ${e.lipatan} lipatan · ${e.faskes_teratas} faskes teratas`} />}
      <Kv k="Tool" v={`${d.tool.length - e.tool_nonaktif.length} aktif${e.tool_nonaktif.length ? `, ${e.tool_nonaktif.length} dimatikan` : ""}`} />
      {e.instruksi_tambahan && <Kv k="Instruksi tambahan" v={e.instruksi_tambahan} />}
      <Kv k="Penugasan acuan" v={d.penugasan_acuan.run ? `${d.penugasan_acuan.nama ?? ""} (${d.penugasan_acuan.run}): ${used.reduce((n, t) => n + t.dipanggil, 0)} panggilan tool, ${used.reduce((n, t) => n + t.gagal, 0)} gagal` : "—"} />
    </div>
  );
}

function Algorithm({ d }: { d: Detail }) {
  const a = d.algoritma;
  return (
    <div className="max-w-[820px] space-y-3">
      <p className="leading-relaxed">{a.ringkas}</p>
      {a.teknik && (
        <div className="rounded border border-white/10 p-3">
          <p className="text-[12.5px] font-semibold text-white">{a.teknik} <span className="font-normal text-[#abb3bf]">· {a.keluarga} · {a.rujukan}</span></p>
          {a.protokol && Object.entries(a.protokol).map(([k, v]) => <Kv key={k} k={k.replaceAll("_", " ")} v={String(v)} />)}
          {!!a.riset?.length && (
            <div className="mt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">Riset</p>
              {a.riset.map((r, i) => (
                <p key={i} className="mt-1 text-[11.5px] leading-snug">{r.penulis} ({r.tahun}). {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-[#8abbff] hover:underline">{r.judul}</a> : r.judul}. <span className="text-[#8f99a8]">{r.venue}</span></p>
              ))}
            </div>
          )}
        </div>
      )}
      {d.aturan_firma && (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-[#abb3bf] hover:text-white">Aturan firma yang berlaku untuk semua agen</summary>
          <pre className={`${pre} mt-2`}>{d.aturan_firma}</pre>
        </details>
      )}
    </div>
  );
}

function Tools({ d }: { d: Detail }) {
  if (!d.tool.length) return <p className="text-[#abb3bf]">Agen ini tidak memegang tool: ia menulis dari bahan yang diberikan kode.</p>;
  return (
    <div className="max-w-[900px] space-y-2">
      <p className="text-[11.5px] text-[#8f99a8]">Deskripsi dibaca langsung dari kode runtime (adk_runtime). Angka panggilan dari penugasan acuan{d.penugasan_acuan.run ? ` ${d.penugasan_acuan.run}` : ""}.</p>
      {d.tool.map((t) => (
        <div key={t.nama} className={`rounded border p-2.5 ${t.nonaktif ? "border-white/5 opacity-50" : "border-white/10"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-white">{t.nama}</span>
            {t.wajib && <span className="rounded bg-[#29a383]/15 px-1 text-[10px] text-[#7ee2c0]">wajib</span>}
            {t.nonaktif && <span className="rounded bg-white/10 px-1 text-[10px] text-[#abb3bf]">dimatikan</span>}
            {t.dipanggil > 0 && <span className="text-[10.5px] text-[#8f99a8]">{t.dipanggil}× dipanggil{t.gagal ? <span className="text-[#ff9b9b]"> · {t.gagal} gagal ({Math.round(100 * t.gagal / t.dipanggil)}%)</span> : ""}</span>}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[#abb3bf]">{t.deskripsi || "—"}</p>
        </div>
      ))}
      {d.tool_lain_dipanggil.length > 0 && (
        <p className="text-[11px] text-[#8f99a8]">Juga dipanggil di penugasan acuan: {d.tool_lain_dipanggil.map((t) => `${t.nama} (${t.dipanggil}×${t.gagal ? `, ${t.gagal} gagal` : ""})`).join(", ")}</p>
      )}
    </div>
  );
}

function Prompts({ d }: { d: Detail }) {
  const t = d.instruksi_terakhir;
  return (
    <div className="max-w-[960px] space-y-4">
      {t ? (
        <div>
          <p className="text-[12.5px] font-semibold text-white">Instruksi nyata di penugasan {t.run} <span className="font-normal text-[#8f99a8]">{wib(t.t)} · {modelName(t.model)}</span></p>
          {t.tools && <p className="mt-1 text-[11px] text-[#8f99a8]">Tool: {t.tools.join(", ") || "—"}</p>}
          <pre className={`${pre} mt-2`}>{t.teks}</pre>
          {t.prompt && <p className="mt-2 text-[11.5px] text-[#abb3bf]">Tugas: <span className="text-[#d3d8de]">{t.prompt}</span></p>}
        </div>
      ) : (
        <p className="rounded border border-white/10 p-2.5 text-[11.5px] text-[#abb3bf]">Instruksi nyata agen ini tercatat mulai penugasan berikutnya (jejak <span className="font-mono">instruksi</span>). Di bawah: template dari kode runtime.</p>
      )}
      {d.prompt.map((p) => (
        <div key={p.fungsi + p.judul}>
          <p className="text-[12.5px] font-semibold text-white">Template · {p.judul} <span className="font-mono text-[10.5px] font-normal text-[#8f99a8]">firm.py {p.fungsi}</span></p>
          <p className="text-[11px] text-[#8f99a8]">{"{…}"} diisi kode saat penugasan: data, rencana orkestrator, skill, kontrak.</p>
          <pre className={`${pre} mt-1`}>{p.teks ?? "(template tidak ditemukan di kode)"}</pre>
        </div>
      ))}
      {!d.prompt.length && !t && <p className="text-[#abb3bf]">Prompt agen ini dibangun di luar firm.py (mis. fakta exhibit di aip/laporan_konsultan.py) atau agen ini kode.</p>}
      {d.skill.map((s) => (
        <div key={s.key} className="rounded border border-white/10 p-3">
          <p className="text-[12.5px] font-semibold text-white">Skill · {s.nama} <span className="font-normal text-[#8f99a8]">v{s.versi} — {s.untuk}</span></p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[11.5px] leading-snug">{(s.langkah ?? []).map((x, i) => <li key={i}>{x}</li>)}</ol>
          {s.keluaran && <p className="mt-1 text-[11.5px] text-[#abb3bf]">Serahkan: {s.keluaran}</p>}
          {!!s.pelajaran?.length && (
            <div className="mt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">Pelajaran dari penugasan sebelumnya</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[11.5px] leading-snug">{s.pelajaran.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Settings({ d, list, onSaved }: { d: Detail; list: List; onSaved: (d: Detail) => void }) {
  const e = d.efektif;
  const [model, setModel] = useState(e.model);
  const [num, setNum] = useState<Record<string, string>>(() => Object.fromEntries(
    (["langkah_tool", "panggilan_model", "token_jawaban", "lipatan", "faskes_teratas"] as const).map((k) => [k, d.setelan[k] != null ? String(d.setelan[k]) : ""])));
  const [penalaran, setPenalaran] = useState(d.setelan.penalaran ?? "");
  const [off, setOff] = useState<string[]>(e.tool_nonaktif);
  const [extra, setExtra] = useState(e.instruksi_tambahan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const llm = d.jenis !== "redaksi" && d.model_bawaan !== "kode";
  const numbers = ([["langkah_tool", "Batas langkah tool", d.tool.length > 0], ["panggilan_model", "Batas panggilan model", llm && e.panggilan_model != null],
    ["token_jawaban", "Token jawaban", llm && e.token_jawaban != null], ["lipatan", "Lipatan validasi silang", d.jenis === "ml"],
    ["faskes_teratas", "Faskes teratas", d.jenis === "ml"]] as const).filter(([, , show]) => show);
  const body = () => ({
    model: model !== d.model_bawaan ? model : null, penalaran: penalaran || null, tool_nonaktif: off, instruksi_tambahan: extra,
    ...Object.fromEntries(numbers.map(([k]) => [k, num[k] ? Number(num[k]) : null])),
  });
  const run = async (f: () => Promise<Detail>, done: string) => {
    setBusy(true); setMsg(null);
    try { onSaved(await f()); setMsg({ ok: true, text: done }); } catch (x) { setMsg({ ok: false, text: (x as Error).message }); } finally { setBusy(false); }
  };
  if (!llm) return <p className="text-[#abb3bf]">Meja redaksi adalah kode: tidak ada model, tool atau prompt yang bisa diubah.</p>;
  const label = "mt-3 block text-[11.5px] font-medium text-[#d3d8de]";
  return (
    <form className="max-w-[640px]" onSubmit={(ev) => { ev.preventDefault(); run(() => api.save(d.key, body()), "Tersimpan: berlaku untuk penugasan berikutnya."); }}>
      <label htmlFor="ka-model" className={label}>Model</label>
      <select id="ka-model" value={model} onChange={(ev) => setModel(ev.target.value)} className={`${field} mt-1`}>
        {!list.model.some((m) => m.id === model) && <option value={model}>{model}</option>}
        {list.model.map((m) => <option key={m.id} value={m.id} disabled={!m.siap}>{m.label} · {m.keluarga}{m.id === d.model_bawaan ? " (bawaan)" : ""}{m.siap ? "" : " — belum siap"}</option>)}
      </select>
      {["qa", "validator", "red_team"].includes(d.jenis) && <p className="mt-1 text-[11px] text-[#8f99a8]">Harus dari keluarga model lain dari model pimpinan (diperiksa kode).</p>}
      <div className="grid grid-cols-2 gap-x-3">
        {numbers.map(([k, text]) => {
          const b = list.batas[k];
          const dflt = d.bawaan[k as keyof Eff];
          return (
            <div key={k}>
              <label htmlFor={`ka-${k}`} className={label}>{text} <span className="font-normal text-[#8f99a8]">({b.min}–{b.maks})</span></label>
              <input id={`ka-${k}`} type="number" min={b.min} max={b.maks} value={num[k]} placeholder={`bawaan ${dflt ?? "—"}`}
                onChange={(ev) => setNum((n) => ({ ...n, [k]: ev.target.value }))} className={`${field} mt-1`} />
            </div>
          );
        })}
        <div>
          <label htmlFor="ka-penalaran" className={label}>Penalaran</label>
          <select id="ka-penalaran" value={penalaran} onChange={(ev) => setPenalaran(ev.target.value)} className={`${field} mt-1`}>
            <option value="">bawaan ({d.bawaan.penalaran})</option>
            {list.penalaran.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      {d.tool.length > 0 && (
        <>
          <p className={label}>Tool aktif</p>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {d.tool.map((t) => (
              <label key={t.nama} className={`flex items-center gap-1.5 text-[11.5px] ${t.wajib ? "text-[#8f99a8]" : ""}`} title={t.wajib ? "tool penutup kerja agen: tidak bisa dimatikan" : t.deskripsi}>
                <input type="checkbox" disabled={t.wajib} checked={!off.includes(t.nama)}
                  onChange={(ev) => setOff((o) => ev.target.checked ? o.filter((x) => x !== t.nama) : [...o, t.nama])} />
                <span className="font-mono">{t.nama}</span>{t.wajib && " (wajib)"}
              </label>
            ))}
          </div>
        </>
      )}
      <label htmlFor="ka-extra" className={label}>Instruksi tambahan <span className="font-normal text-[#8f99a8]">(ditambahkan di akhir prompt agen ini; tanpa tautan atau perintah mengubah data)</span></label>
      <textarea id="ka-extra" value={extra} onChange={(ev) => setExtra(ev.target.value)} rows={4} maxLength={2000} className={`${field} mt-1 resize-y leading-relaxed`}
        placeholder="mis. Prioritaskan faskes kelas C dan D; sebut pembanding peer di setiap temuan." />
      {msg && <p className={`mt-3 text-[11.5px] ${msg.ok ? "text-[#7ee2c0]" : "text-red-300"}`}>{msg.text}</p>}
      <div className="mt-4 flex items-center gap-2">
        <button type="submit" disabled={busy} className="flex items-center gap-1 rounded bg-[#5b5fd6] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
          <Icon name="save" className="h-3.5 w-3.5" />Simpan
        </button>
        {d.diubah && (
          <button type="button" disabled={busy} onClick={() => run(() => api.reset(d.key), "Dikembalikan ke bawaan.")}
            className="flex items-center gap-1 rounded border border-white/15 px-3 py-1 text-[12px] text-[#d3d8de] hover:bg-white/5 disabled:opacity-40">
            <Icon name="restore" className="h-3.5 w-3.5" />Kembalikan bawaan
          </button>
        )}
        <span className="text-[11px] text-[#8f99a8]">Butuh admin. Setiap nilai diperiksa kode sebelum disimpan.</span>
      </div>
    </form>
  );
}
