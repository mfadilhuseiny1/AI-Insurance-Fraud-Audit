"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { Alasan } from "../_lib/match";

export const C = "#0f766e";

const I = (d: string, cls = "h-6 w-6") => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cls}><path d={d} /></svg>
);
export const Ikon = {
  qr: I("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1M16.5 6.5h1M6.5 16.5h1"),
  link: I("M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"),
  user: I("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"),
  chip: I("M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"),
  bell: I("M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"),
  alarm: I("M12 3.5l9 16H3zM12 10v4.5M12 17.5v.5"),
  key: I("M4 8h16M4 12h16M4 16h10", "h-4 w-4"),
  x: I("M6 6l12 12M18 6L6 18", "h-4 w-4"),
  ok: I("M5 12.5l4.5 4.5L19 7.5", "h-4 w-4"),
  warn: I("M12 4l9 16H3zM12 10v4M12 17.5v.5", "h-4 w-4"),
  no: I("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8", "h-4 w-4"),
  unlink: I("M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66M4 4l16 16", "h-4 w-4"),
};

export function Saklar({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className="relative h-7 w-12 shrink-0 rounded-full transition-colors" style={{ background: on ? C : "#cfd6de" }}>
      <span className="absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left]" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}

/** Confidence bar, 0-100 with the auto (80) and proposal (50) thresholds marked. */
export function Skor({ nilai }: { nilai: number }) {
  const warna = nilai >= 80 ? "#15803d" : nilai >= 50 ? "#b45309" : "#738091";
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[#e8ecf0]">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${nilai}%`, background: warna }} />
        <span className="absolute inset-y-0 left-[50%] w-px bg-white" /><span className="absolute inset-y-0 left-[80%] w-px bg-white" />
      </div>
      <span className="w-11 text-right text-[13px] font-semibold tabular-nums" style={{ color: warna }}>{nilai}%</span>
    </div>
  );
}

const WARNA = { ok: "text-[#15803d]", warn: "text-[#b45309]", no: "text-[#b42318]" } as const;
/** The reasons behind a pair, each with its points; `sampai` reveals them one by one (matching animation). */
export function DaftarAlasan({ alasan, sampai }: { alasan: Alasan[]; sampai?: number }) {
  return (
    <ul className="space-y-1.5">
      {alasan.map((a, i) => {
        const tampil = sampai === undefined || i < sampai;
        return (
          <li key={i} className={`flex items-start gap-2 text-[13px] leading-snug transition-opacity duration-300 ${tampil ? "opacity-100" : "opacity-25"}`}>
            <span className={`mt-px shrink-0 ${tampil ? WARNA[a.status] : "text-[#a3adb8]"}`}>{tampil ? Ikon[a.status] : <span className="block h-4 w-4 animate-pulse rounded-full border-2 border-current" />}</span>
            <span className="min-w-0 flex-1 text-[#2f3a46]">{a.teks}</span>
            {a.poin !== undefined && <span className={`shrink-0 tabular-nums text-[12px] font-semibold ${a.poin > 0 ? "text-[#15803d]" : "text-[#8a95a3]"}`}>+{a.poin}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** A chip with an ID and its subtitle (device or patient). */
export function Tanda({ jenis, id, sub, gelap }: { jenis: "pasien" | "device"; id: string; sub: string; gelap?: boolean }) {
  return (
    <div className={`min-w-0 flex-1 rounded-xl px-2.5 py-2 ${gelap ? "bg-[#0b4f4a] text-white" : "bg-[#eef6f5] text-[#0b3d39]"}`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide opacity-75">{jenis === "pasien" ? "Patient ID" : "Device ID"}</div>
      <div className="truncate font-mono text-[13.5px] font-semibold">{id}</div>
      <div className="truncate text-[11.5px] opacity-80">{sub}</div>
    </div>
  );
}

/** Text whose IDs (P-87345, IOT-DEV-001, S-261116-001) never break at their hyphens. */
export function Teks({ children }: { children: string }) {
  return <>{children.split(/((?:IOT-DEV|P|S)-[\dA-Z-]*\d)/).map((s, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{s}</span> : s))}</>;
}

export type Notif = { id: string; waktu: string; jenis: "sukses" | "info" | "warn"; judul: string; isi: string; device?: string; baca?: boolean };

/** Phone-style push notification sliding down from the top; disappears after 4 s or on tap. */
export function Banner({ n, onTap, onTutup }: { n: Notif; onTap: () => void; onTutup: () => void }) {
  useEffect(() => {
    const t = setTimeout(onTutup, 4200);
    return () => clearTimeout(t);
  }, [n.id, onTutup]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-3 pt-[max(10px,env(safe-area-inset-top))]">
      <style>{`@keyframes bannerTurun{from{transform:translateY(-120%);opacity:0}to{transform:none;opacity:1}}`}</style>
      <button key={n.id} onClick={onTap}
        className="pointer-events-auto flex w-full max-w-[540px] items-start gap-3 rounded-2xl bg-white/95 p-3 text-left shadow-[0_10px_30px_rgba(16,22,26,.25)] ring-1 ring-black/5 backdrop-blur [animation:bannerTurun_.35s_cubic-bezier(.2,.9,.3,1.2)]">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white ${n.jenis === "sukses" ? "bg-[#15803d]" : n.jenis === "warn" ? "bg-[#b45309]" : "bg-[#0f766e]"}`}>
          {n.jenis === "sukses" ? <span className="[&_svg]:h-6 [&_svg]:w-6">{Ikon.ok}</span> : Ikon.link}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-[11.5px] text-[#738091]"><b className="font-semibold text-[#4a5563]">Binding IoT</b><span className="ml-auto">sekarang</span></span>
          <span className="block text-[14.5px] font-semibold text-[#1c2127]">{n.judul}</span>
          <span className="line-clamp-3 block text-[13px] text-[#4a5563]"><Teks>{n.isi}</Teks></span>
        </span>
      </button>
    </div>
  );
}

export function Bagian({ judul, kanan, children }: { judul: string; kanan?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-2 px-0.5"><h2 className="flex-1 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">{judul}</h2>{kanan}</div>
      {children}
    </section>
  );
}

/** Re-renders every `ms` so running durations stay current. */
export function useSekarang(ms = 30_000) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const tick = () => setT(Date.now());
    const first = setTimeout(tick, 0);
    const iv = setInterval(tick, ms);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, [ms]);
  return t;
}

export const jam = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
export const tglJam = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const lama = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 1 ? "baru saja" : m < 60 ? `${m} mnt` : `${Math.floor(m / 60)} j ${m % 60} mnt`;
};
/** ISO 8601 with the device's own zone offset, as the IoT contract wants it. */
export const isoLokal = (iso: string) => {
  const d = new Date(iso);
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
};
export const kodeTanggal = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
