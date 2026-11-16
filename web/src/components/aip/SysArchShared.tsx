"use client";

// System Architecture · shared pieces: number formatting, chips, small bars and tables used by the three sections
// (SysArchMl, SysArchSwarm, SysArchRules). Tokens from viz.tsx; red only for a risk or a bad state.

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { GRID } from "./viz";

export const kartu = "rounded-lg border border-white/[.07] bg-[#1c2127]";
export const idn = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v?: number | null, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? "—" : `${idn(v * 100, d)}%`);
/** a share as a percentage with as many decimals as it needs to be non-zero (0,04% rather than 0%) */
export const pctAuto = (v?: number | null) => (v === undefined || v === null ? "—" : pct(v, v === 0 ? 0 : v < 0.001 ? 2 : v < 0.1 ? 1 : 0));

export type Nada = "netral" | "biru" | "hijau" | "kuning" | "merah" | "ungu" | "redup";
const NADA: Record<Nada, string> = {
  netral: "border-white/15 bg-white/[.06] text-[#d3d8de]",
  biru: "border-[#3987e5]/45 bg-[#3987e5]/15 text-[#a9cdff]",
  hijau: "border-[#199e70]/50 bg-[#199e70]/15 text-[#7ee2c0]",
  kuning: "border-[#fab219]/45 bg-[#fab219]/12 text-[#fbd38d]",
  merah: "border-[#d03b3b]/55 bg-[#d03b3b]/15 text-[#ffb4b4]",
  ungu: "border-[#9d8cff]/45 bg-[#5b5fd6]/20 text-[#c7c9ff]",
  redup: "border-white/10 bg-transparent text-[#8f99a8]",
};

export function Chip({ children, nada = "netral", ikon, title, mono }: { children: ReactNode; nada?: Nada; ikon?: IconName; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-[1px] text-[10.5px] leading-[16px] ${NADA[nada]} ${mono ? "font-mono" : ""}`}>
      {ikon && <Icon name={ikon} className="h-3 w-3" />}{children}
    </span>
  );
}

/** a section's heading: an icon, a title, a line under it, and controls on the right */
export function Judul({ ikon, judul, sub, kanan }: { ikon: IconName; judul: string; sub?: ReactNode; kanan?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[.06] text-[#c5cbd3]"><Icon name={ikon} className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold leading-snug text-white">{judul}</h2>
        {sub && <div className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{sub}</div>}
      </div>
      {kanan && <div className="flex flex-wrap items-center gap-1.5">{kanan}</div>}
    </div>
  );
}

/** a thin bar on a 0..maks scale with its value beside it */
export function Batang({ nilai, maks = 1, warna, label, tinggi = 8, title }: { nilai: number | null | undefined; maks?: number; warna: string; label?: string; tinggi?: number; title?: string }) {
  const w = nilai == null || maks <= 0 ? 0 : Math.max(nilai > 0 ? 1.2 : 0, Math.min(100, (nilai / maks) * 100));
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <div className="relative min-w-0 flex-1 rounded-full" style={{ background: GRID, height: tinggi }}>
        {nilai != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${w}%`, background: warna }} />}
      </div>
      {label !== undefined && <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-[#d3d8de]">{label}</span>}
    </div>
  );
}

/** one number with its label (a stat tile, not a chart) */
export function Angka({ label, nilai, sub, nada }: { label: string; nilai: ReactNode; sub?: ReactNode; nada?: "baik" | "buruk" | "netral" }) {
  const warna = nada === "buruk" ? "text-[#ffb4b4]" : nada === "baik" ? "text-[#7ee2c0]" : "text-white";
  return (
    <div className="min-w-0 rounded-md border border-white/[.06] bg-white/[.02] px-2.5 py-2">
      <p className="truncate text-[10.5px] text-[#8f99a8]" title={label}>{label}</p>
      <p className={`text-[17px] font-semibold leading-tight tabular-nums ${warna}`}>{nilai}</p>
      {sub && <p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p>}
    </div>
  );
}

export function Tabel({ kepala, baris, kanan = [] }: { kepala: string[]; baris: ReactNode[][]; kanan?: number[] }) {
  return (
    <div className="max-h-[420px] overflow-auto rounded border border-white/5">
      <table className="w-full text-left text-[11.5px]">
        <thead className="sticky top-0 bg-[#20262d] text-[#abb3bf]">
          <tr>{kepala.map((k, i) => <th key={k} className={`whitespace-nowrap px-2 py-1.5 font-medium ${kanan.includes(i) ? "text-right" : ""}`}>{k}</th>)}</tr>
        </thead>
        <tbody>
          {baris.map((b, i) => (
            <tr key={i} className="border-t border-white/[.05] text-[#e5e8eb]">
              {b.map((c, j) => <td key={j} className={`px-2 py-1 ${kanan.includes(j) ? "text-right tabular-nums" : ""}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** a legend of series: a colour key and the series name, in text ink */
export function Legenda({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#c5cbd3]">
      {items.map(([w, l]) => <span key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: w }} />{l}</span>)}
    </div>
  );
}

export function Memuat({ teks }: { teks: string }) {
  return <p className="flex items-center gap-2 py-6 text-[12px] text-[#8f99a8]"><Icon name="refresh" className="h-3.5 w-3.5 animate-spin" />{teks}</p>;
}

export function Galat({ teks }: { teks: string }) {
  return <p className="rounded-md border border-[#d03b3b]/40 bg-[#d03b3b]/10 px-3 py-2 text-[11.5px] text-[#ffb4b4]">{teks}</p>;
}

/** a calm notice (not an error): something is not there yet */
export function Catatan({ ikon = "info", children }: { ikon?: IconName; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-white/15 bg-white/[.02] px-3 py-2.5 text-[11.5px] leading-snug text-[#c5cbd3]">
      <Icon name={ikon} className="mt-px h-3.5 w-3.5 shrink-0 text-[#8f99a8]" /><div className="min-w-0">{children}</div>
    </div>
  );
}

export const tombol = "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11.5px] transition disabled:cursor-not-allowed disabled:opacity-45";
export const tombolNetral = `${tombol} border-white/15 text-[#d3d8de] hover:bg-white/[.06]`;
export const tombolUtama = `${tombol} border-[#3987e5]/60 bg-[#3987e5]/20 text-white hover:bg-[#3987e5]/30`;
export const tombolAi = `${tombol} border-[#9d8cff]/55 bg-[#5b5fd6]/25 text-[#e4e2ff] hover:bg-[#5b5fd6]/35`;
export const tombolAdmin = `${tombol} border-[#199e70]/55 bg-[#199e70]/15 text-[#bdf3dc] hover:bg-[#199e70]/25`;
export const tombolBahaya = `${tombol} border-[#d03b3b]/50 text-[#ffb4b4] hover:bg-[#d03b3b]/15`;
export const masukan = "rounded border border-white/10 bg-[#111418] px-2 py-1 text-[12px] text-[#f6f7f9] outline-none placeholder:text-[#5f6b7a] focus:border-[#3987e5]/60";
