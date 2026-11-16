"use client";

// API Documentation · "Coba" (Try it): a panel to fill an endpoint's parameters and body and see the request it makes and a
// response. It never sends anything, for any method (the coordinator, 2026-11-15: "Try it does NOT need to send real
// requests ... No network calls from Try it at all"): "Kirim" plays back the documented example of the chosen status code,
// with its status and a timing, marked as a sample. A data-changing endpoint says so (starting an audit spends model money),
// so the copied request is run on purpose. No fetch in this file.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { DocParam } from "./ApiDocsTypes";
import { permintaanOf, sampel, STATUS_TEKS, tipeTampil, warnaKode, type Basis, type Ep } from "./ApiDocsModel";
import { BlokKode, MethodBadge, PanelKode, PathText, SalinTombol, type LangKey } from "./ApiDocsShared";

/** an endpoint whose real call spends model money (starting an audit, the swarm, AI rule drafting, narration, verification) */
const pakaiBiaya = (ep: Ep) => ep.method !== "GET"
  && /\/(mulai|lanjut)$|\/tahap\/\{|\/laporan-lengkap\/narasi$|^\/api\/aip\/konsultan$|\/aturan\/ai\/|\/fraud\/v1\/verify|\/konsultan\/\{run_id\}\/laporan$/.test(ep.path);

function awal(ep: Ep): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of ep.params) {
    const k = `${p.in}:${p.name}`;
    if (p.in === "path") out[k] = ep.contohParam[p.name] ?? "";
    else if (p.required) out[k] = ep.contohParam[p.name] ?? (p.enum?.length ? String(p.enum[0]) : p.default !== undefined ? String(p.default) : "");
    else out[k] = "";
  }
  return out;
}

function Isian({ p, nilai, ubah, salah }: { p: DocParam; nilai: string; ubah: (v: string) => void; salah: boolean }) {
  const id = useId();
  const cls = `w-full rounded-lg bg-[#0b0d10] px-3 py-2 font-mono text-[13px] text-[#e8ebef] outline-none ring-1 ring-inset placeholder:text-[#4f5966] focus:ring-2 focus:ring-[#9d8cff]/60 ${salah ? "ring-[#f87171]/70" : "ring-white/[.10]"}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2.5">
        <span className="font-mono text-[12.5px] font-semibold text-[#eef0f3]">{p.name}</span>
        <span className="font-mono text-[12px] text-[#8a94a3]">{tipeTampil(p)}</span>
        <span className={`text-[11.5px] ${p.required ? "font-medium text-[#d9a066]" : "text-[#6f7a88]"}`}>{p.required ? "wajib" : "opsional"}</span>
      </label>
      {p.enum && p.enum.length > 1 ? (
        <select id={id} value={nilai} onChange={(e) => ubah(e.target.value)} className={cls}>
          {!p.required && <option value="">(kosong)</option>}
          {p.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
        </select>
      ) : (
        <input id={id} value={nilai} onChange={(e) => ubah(e.target.value)} placeholder={p.description ? p.description.slice(0, 60) : `masukkan ${p.name}`} className={cls} autoComplete="off" spellCheck={false} />
      )}
      {salah && <p className="text-[11.5px] text-[#fca5a5]">Wajib diisi.</p>}
    </div>
  );
}

function Bagian({ judul, kanan, children }: { judul: string; kanan?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-[#8a94a3]">{judul}</h3>
        {kanan && <span className="ml-auto">{kanan}</span>}
      </div>
      {children}
    </section>
  );
}

type Hasil = { kode: string; ms: number; teks: string; catatan?: string };

export function TryIt({ ep, basis, lang, onLang, onClose }: { ep: Ep; basis: Basis; lang: LangKey; onLang: (l: LangKey) => void; onClose: () => void }) {
  const judulId = useId();
  const [nilai, setNilai] = useState<Record<string, string>>(() => awal(ep));
  const [token, setToken] = useState("");
  const contoh0 = ep.body?.varian?.[0]?.contoh ?? ep.body?.contoh;
  const [bodyTeks, setBodyTeks] = useState(() => (ep.body ? JSON.stringify(contoh0 ?? {}, null, 2) : ""));
  const ok = ep.respons.find((r) => r.kode.startsWith("2"))?.kode ?? ep.respons[0]?.kode ?? "200";
  const [kodeSim, setKodeSim] = useState(ok);
  const [hasil, setHasil] = useState<Hasil | null>(null);
  const [mengirim, setMengirim] = useState(false);
  const [cek, setCek] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kotakRespons = useRef<HTMLDivElement>(null);

  // Esc closes; focus moves in, and back to where it was when the panel closes
  useEffect(() => {
    const sebelum = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      if (timer.current) clearTimeout(timer.current);
      sebelum?.focus?.();
    };
  }, [onClose]);

  const json = ep.body?.contentType === "application/json";
  const bodyParse = useMemo((): { ok: true; v: unknown } | { ok: false; why: string } => {
    if (!ep.body) return { ok: true, v: undefined };
    if (!json) return { ok: true, v: contoh0 };
    try { return { ok: true, v: JSON.parse(bodyTeks || "{}") }; } catch (e) { return { ok: false, why: e instanceof Error ? e.message : String(e) }; }
  }, [bodyTeks, contoh0, ep.body, json]);
  const req = permintaanOf(ep, basis, nilai, bodyParse.ok ? bodyParse.v : contoh0);
  const kode = { curl: sampel("curl", req), python: sampel("python", req), js: sampel("js", req) };
  const kurang = ep.params.filter((p) => p.required && p.in !== "header" && !nilai[`${p.in}:${p.name}`]?.trim());
  const ubah = (k: string) => (v: string) => setNilai((x) => ({ ...x, [k]: v }));

  const kirim = () => {
    setCek(true);
    if (kurang.length || !bodyParse.ok || mengirim) return;
    const r = ep.respons.find((x) => x.kode === kodeSim) ?? ep.respons[0];
    // a sample: the documented example after a plausible delay (nothing leaves the browser)
    const ms = Math.round(90 + Math.random() * 260 + (ep.method === "GET" ? 0 : 60));
    setMengirim(true);
    setHasil(null);
    timer.current = setTimeout(() => {
      setMengirim(false);
      setHasil({ kode: r?.kode ?? kodeSim, ms, teks: r?.contoh !== undefined ? JSON.stringify(r.contoh, null, 2) : "", catatan: r?.catatan });
      // on a phone the response sits under the form: bring it into view
      requestAnimationFrame(() => kotakRespons.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }, ms);
  };

  const ubahData = ep.method !== "GET";
  const kel: [string, DocParam[]][] = [["Parameter path", ep.params.filter((p) => p.in === "path")], ["Parameter query", ep.params.filter((p) => p.in === "query")], ["Header", ep.params.filter((p) => p.in === "header")]];
  const a = ep.otorisasi[0];

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/65 backdrop-blur-[3px] sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={judulId}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); kirim(); } }}
        className="flex h-full w-full max-w-[1180px] flex-col overflow-hidden bg-[#0f1216] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] ring-1 ring-inset ring-white/[.10] sm:h-[min(820px,94vh)] sm:rounded-2xl">
        {/* head */}
        <div className="flex min-w-0 items-center gap-3 border-b border-white/[.07] px-4 py-3 sm:px-5">
          <MethodBadge m={ep.method} size="md" />
          <div className="min-w-0 flex-1">
            <h2 id={judulId} className="truncate text-[14.5px] font-semibold text-white">{ep.nama}</h2>
            <PathText path={ep.path} className="block truncate text-[12px] text-[#8a94a3]" />
          </div>
          <span className="hidden shrink-0 text-[12px] text-[#8a94a3] sm:inline" title="Respons diambil dari contoh dokumentasi; tidak ada permintaan yang dikirim">Mode contoh</span>
          <button type="button" onClick={onClose} aria-label="Tutup" className="rounded-lg p-1.5 text-[#a3acb9] hover:bg-white/[.07] hover:text-white">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:overflow-hidden">
          {/* the form */}
          <div className="min-w-0 space-y-7 px-4 py-5 sm:px-5 lg:overflow-y-auto">
            {a && (
              <Bagian judul="Otorisasi">
                <div className="space-y-1.5">
                  <label className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="font-mono text-[12.5px] font-semibold text-[#eef0f3]">{a.nama}</span>
                    <span className="font-mono text-[12px] text-[#8a94a3]">string</span>
                    <span className="text-[12px] text-[#8a94a3]">header</span>
                    <span className="text-[11.5px] font-medium text-[#d9a066]">wajib</span>
                  </label>
                  <div className="flex items-center rounded-lg bg-[#0b0d10] ring-1 ring-inset ring-white/[.10] focus-within:ring-2 focus-within:ring-[#9d8cff]/60">
                    {a.awalan && <span className="pl-3 font-mono text-[13px] text-[#8a94a3]">{a.awalan.trim()}</span>}
                    <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={`$${a.env}`} aria-label={`${a.nama}: ${a.label}`}
                      className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-[13px] text-[#e8ebef] outline-none placeholder:text-[#4f5966]" autoComplete="off" />
                  </div>
                  <p className="text-[11.5px] text-[#6f7a88]">{a.label}. Di mode contoh token tidak dipakai dan tidak dikirim.</p>
                </div>
              </Bagian>
            )}
            {kel.filter(([, ps]) => ps.length > 0).map(([judul, ps]) => (
              <Bagian key={judul} judul={judul}>
                {ps.map((p) => {
                  const k = `${p.in}:${p.name}`;
                  return <Isian key={k} p={p} nilai={nilai[k] ?? ""} ubah={ubah(k)} salah={cek && p.required && p.in !== "header" && !nilai[k]?.trim()} />;
                })}
              </Bagian>
            ))}
            {ep.body && (
              <Bagian judul="Body" kanan={<span className="font-mono text-[11.5px] text-[#6f7a88]">{ep.body.contentType}</span>}>
                {json ? (
                  <>
                    <textarea value={bodyTeks} onChange={(e) => setBodyTeks(e.target.value)} spellCheck={false} aria-label="Body JSON"
                      className={`h-[300px] w-full resize-y rounded-lg bg-[#0b0d10] px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-[#d7dce2] outline-none ring-1 ring-inset focus:ring-2 focus:ring-[#9d8cff]/60 ${!bodyParse.ok ? "ring-[#f87171]/70" : "ring-white/[.10]"}`} />
                    {!bodyParse.ok && <p className="text-[11.5px] text-[#fca5a5]">JSON tidak valid: {bodyParse.why}</p>}
                    <button type="button" onClick={() => setBodyTeks(JSON.stringify(contoh0 ?? {}, null, 2))} className="text-[12px] text-[#b3a6ff] hover:text-white">Kembalikan contoh</button>
                  </>
                ) : (
                  <p className="rounded-lg px-3 py-2.5 text-[12.5px] text-[#8a94a3] ring-1 ring-inset ring-white/[.08]">Body {ep.body.contentType}: lihat contoh permintaan di samping.</p>
                )}
              </Bagian>
            )}
            {ep.params.length === 0 && !ep.body && <p className="text-[13px] text-[#8a94a3]">Endpoint ini tidak punya parameter atau body selain otorisasi.</p>}
          </div>

          {/* the request and the response */}
          <div className="min-w-0 space-y-4 border-t border-white/[.07] bg-[#0b0d10] px-4 py-5 sm:px-5 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <PanelKode judul="Permintaan" kode={kode} lang={lang} onLang={onLang} maxH="max-h-[260px]" />
            <div ref={kotakRespons} className="min-w-0 scroll-mb-4 overflow-hidden rounded-lg border border-white/[.08] bg-[#111418]" aria-live="polite">
              <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-white/[.06] px-4 py-2.5">
                <span className="text-[12.5px] font-medium text-[#e8ebef]">Respons</span>
                {hasil && (
                  <>
                    <span data-coba-status className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-[1px] font-mono text-[11.5px] font-semibold"
                      style={{ color: warnaKode(hasil.kode), background: `${warnaKode(hasil.kode)}1a`, boxShadow: `inset 0 0 0 1px ${warnaKode(hasil.kode)}40` }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: warnaKode(hasil.kode) }} />{hasil.kode} {STATUS_TEKS[hasil.kode] ?? ""}
                    </span>
                    <span className="font-mono text-[11.5px] text-[#8a94a3]">{hasil.ms} ms</span>
                    <span className="text-[11px] italic text-[#6f7a88]" title="Respons diambil dari contoh dokumentasi; tidak ada permintaan yang dikirim">respons contoh</span>
                  </>
                )}
                {hasil?.teks && <span className="ml-auto"><SalinTombol text={hasil.teks} judul="Salin respons" /></span>}
              </div>
              {mengirim ? (
                <div className="flex items-center gap-2.5 px-4 py-8 text-[13px] text-[#a3acb9]">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#9d8cff]/30 border-t-[#9d8cff]" />Mengirim…
                </div>
              ) : hasil ? (
                hasil.teks ? <BlokKode code={hasil.teks} lang="json" maxH="max-h-[360px]" />
                  : <p className="px-4 py-5 text-[12.5px] text-[#8a94a3]">{hasil.catatan ?? "Spesifikasi tidak memuat contoh respons untuk kode ini."}</p>
              ) : (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] text-[#6f7a88]">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[.04] text-[#8a94a3] ring-1 ring-inset ring-white/[.08]"><Icon name="play" className="h-4 w-4" /></span>
                  Tekan <span className="font-medium text-[#c5ccd6]">Kirim</span> untuk melihat contoh respons.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* foot */}
        <div className="flex flex-col gap-3 border-t border-white/[.07] px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-[12px] leading-[1.55] text-[#8a94a3]">
            <Icon name={ubahData ? "alert" : "info"} className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${ubahData ? "text-[#fbbf24]" : "text-[#8a94a3]"}`} />
            <span>
              {ubahData
                ? <>Endpoint ini <span className="text-[#fcd34d]">mengubah data</span>{pakaiBiaya(ep) ? <>; memanggilnya sungguhan <span className="text-[#fcd34d]">memakai biaya Model AI</span></> : null}. Mode contoh tidak mengirim apa pun: salin permintaan di atas untuk menjalankannya sendiri.</>
                : <>Mode contoh: respons diambil dari dokumentasi, tidak ada permintaan yang dikirim ke server.</>}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {ep.respons.length > 1 && (
              <label className="flex items-center gap-1.5 text-[12px] text-[#8a94a3]">
                Contoh
                <select value={kodeSim} onChange={(e) => setKodeSim(e.target.value)} aria-label="Kode status contoh respons"
                  className="rounded-md bg-[#12161b] px-2 py-1.5 font-mono text-[12px] text-[#e8ebef] outline-none ring-1 ring-inset ring-white/[.10] focus:ring-[#9d8cff]/60">
                  {ep.respons.map((r) => <option key={r.kode} value={r.kode}>{r.kode} {STATUS_TEKS[r.kode] ?? ""}</option>)}
                </select>
              </label>
            )}
            <button type="button" onClick={kirim} disabled={mengirim} title="Kirim (Ctrl+Enter)"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#9d8cff] px-4 py-2 text-[13px] font-semibold text-[#0b0d10] transition hover:bg-[#b0a2ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60">
              <Icon name="play" className="h-3.5 w-3.5" />Kirim
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
