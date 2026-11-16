"use client";
import { useState } from "react";
import { txt, type AipEvent, type Rec } from "@/components/aip/aipRun";

/* The orchestration concept as a run shows it (adk_runtime/orkestrasi.py): the validation contract the orchestrator
   wrote before any worker started, and how the validator judged it; each worker's structured handoff; the scrutiny
   validator (code); the lessons the run encoded into skills. Shared by the question flow and the consultancy. */

export type Contract = { id: string; teks: string; ok?: boolean | null; bukti?: string }[];

export function ContractCard({ contract, judged }: { contract: Contract; judged?: Contract }) {
  if (!contract?.length) return null;
  const by = new Map((judged ?? []).map((c) => [c.id, c]));
  const done = (judged ?? []).filter((c) => c.ok === true).length;
  // a statement the validator left unjudged (ok: null) is not a failed one: "0/12 terpenuhi" read as twelve failures
  const rated = (judged ?? []).filter((c) => typeof c.ok === "boolean").length;
  const open = (judged?.length ?? 0) - rated;
  return (
    <div className="mt-2 rounded border border-[#9d8cff]/25 bg-black/20 p-2">
      <p className="flex items-center text-[11px] font-semibold text-[#c9c0ff]">Kontrak validasi
        <span className="ml-auto font-normal text-[#8f99a8]">
          {!judged?.length ? "ditulis sebelum agen bekerja" : !rated ? "belum dinilai validator"
            : `${done}/${rated} terpenuhi${open ? ` · ${open} belum dinilai` : ""}`}
        </span></p>
      <ul className="mt-1 space-y-1">
        {contract.map((c) => {
          const j = by.get(c.id);
          return (
            <li key={c.id} className="flex gap-1.5 text-[11px] leading-snug" title={txt(j?.bukti) || undefined}>
              <span className={j?.ok === true ? "text-emerald-400" : j?.ok === false ? "text-red-400" : "text-[#6b7480]"}>{j?.ok === true ? "✓" : j?.ok === false ? "✗" : "○"}</span>
              <span className="text-[#d3d8de]"><span className="font-mono text-[10px] text-[#8f99a8]">{c.id}</span> {txt(c.teks)}
                {!!txt(j?.bukti) && <span className="block text-[10.5px] text-[#8f99a8]">{txt(j?.bukti)}</span>}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HandoffBlock({ h }: { h?: Rec }) {
  const [open, setOpen] = useState(false);
  if (!h) return null;
  const qs = (h.queries_run ?? []) as Rec[];
  const ok = qs.filter((q) => q.ok).length;
  const proc = (h.procedures_followed ?? {}) as Rec;
  const procs = Array.isArray(proc) ? [] : ((proc.cek ?? []) as Rec[]);
  const list = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []) as string[];
  return (
    <div className="border-t border-white/5 px-2 py-1 text-[11px]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left">
        <span className="font-medium text-[#8abbff]">Serah-terima</span>
        {h.skill && <span className="rounded bg-white/[.06] px-1 text-[10px] text-[#c5cbd3]">skill {h.skill}</span>}
        <span className="text-[10.5px] text-[#8f99a8]">{ok}/{qs.length} panggilan berhasil</span>
        <span className={`ml-auto text-[10.5px] ${proc.ok === false ? "text-[#f6c86b]" : "text-emerald-300"}`}>{proc.ok === false ? "prosedur tidak lengkap" : "prosedur diikuti"} {open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pb-1">
          {list(h.implemented).length > 0 && <div><p className="text-[10.5px] text-[#8f99a8]">Dikerjakan</p><ul className="list-disc pl-4 text-[#d3d8de]">{list(h.implemented).slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {list(h.left_undone).length > 0 && <p className="text-[#f6c86b]">Belum: {list(h.left_undone).join("; ")}</p>}
          {list(h.issues_found).length > 0 && <p className="text-red-300">Masalah: {list(h.issues_found).slice(0, 4).join("; ")}</p>}
          {procs.length > 0 && <ul className="text-[10.5px]">{procs.map((c, i) => <li key={i} className={c.ok ? "text-[#8f99a8]" : "text-[#f6c86b]"}>{c.ok ? "✓" : "✗"} {c.prosedur}</li>)}</ul>}
          {!h.dinyatakan_agen && <p className="text-[10.5px] text-[#6b7480]">Agen tidak menulis baris serah-terima; isi di atas dari catatan tool.</p>}
        </div>
      )}
    </div>
  );
}

export function ScrutinyCard({ ev }: { ev: AipEvent }) {
  const [open, setOpen] = useState(false);
  const checks = (ev.checks ?? []) as Rec[];
  const blocked = checks.filter((c) => !c.ok && c.blok);
  return (
    <div className="rounded-md border border-[#e5689b]/30 bg-black/20">
      <button onClick={() => setOpen(!open)} className={`m-2 flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${blocked.length ? "border-red-400/60 bg-red-500/10 text-red-200" : "border-[#e5689b]/50 bg-[#e5689b]/10 text-[#f9c4d8]"}`}>
        Scrutiny (kode){ev.milestone ? ` · ${ev.milestone}` : ""}: {ev.passed}/{ev.total} cek {blocked.length ? `· ${blocked.length} memblok` : ""} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="px-2 pb-2 text-[11px]">
          <p className="mb-1 text-[10.5px] text-[#8f99a8]">Validator kode, sebelum validator model: tanpa penilaian, hanya aturan. Cek yang memblok mengembalikan jawaban untuk direvisi.</p>
          {checks.map((c, i) => (
            <p key={i} className="flex gap-1.5 border-b border-white/5 py-0.5 last:border-0">
              <span className={c.ok ? "text-emerald-400" : c.blok ? "text-red-400" : "text-[#f6c86b]"}>{c.ok ? "✓" : "✗"}</span>
              <span className="min-w-0 flex-1 text-[#e5e8eb]">{txt(c.klaim)}<span className="block text-[10.5px] text-[#8f99a8]">{txt(c.bukti)}</span></span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Lessons({ events }: { events: AipEvent[] }) {
  const kept = events.filter((e) => e.type === "pelajaran");
  const refused = events.filter((e) => e.type === "pelajaran_ditolak");
  if (!kept.length && !refused.length) return null;
  return (
    <div className="rounded-md border border-[#9d8cff]/25 bg-[#9d8cff]/5 p-2 text-[11px]">
      <p className="font-semibold text-[#c9c0ff]">Pelajaran yang di-encode ke skill</p>
      <p className="text-[10.5px] text-[#8f99a8]">Dari temuan validator run ini: tugas baru → kerjakan → amati → pelajari → encode skill.</p>
      {kept.map((e) => <p key={e.seq} className="mt-1 text-[#d3d8de]"><span className="rounded bg-white/[.06] px-1 text-[10px]">{e.skill}</span> {e.teks} <span className="text-[10.5px] text-[#8f99a8]">({e.status})</span></p>)}
      {refused.map((e) => <p key={e.seq} className="mt-1 text-[#8f99a8]">Ditolak gerbang: {e.teks} — {e.alasan}</p>)}
    </div>
  );
}
