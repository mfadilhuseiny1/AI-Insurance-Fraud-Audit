"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* Mobile UI kit for the JKN PWAs: app shell (header, bottom tabs, install prompt, service worker), bottom sheet,
   status badge, polling. Light, large touch targets, one column — phone first. */

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function Shell<T extends string>({ app, color, title, subtitle, tabs, tab, setTab, right, children }: {
  app: string; color: string; title: string; subtitle?: ReactNode; tabs: { key: T; label: string; icon: ReactNode; badge?: number }[];
  tab: T; setTab: (t: T) => void; right?: ReactNode; children: ReactNode;
}) {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/jkn-mobile/sw.js", { scope: "/jkn-mobile/" }).catch(() => {});
    const onPrompt = (e: Event) => { e.preventDefault(); setInstall(e as InstallEvent); };
    const onInstalled = () => { setInstalled(true); setInstall(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);
  useEffect(() => { document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color); }, [color]);
  return (
    <div className="flex h-[100dvh] w-full flex-col bg-[#f4f6f8] text-[#1c2127]" data-app={app}>
      <header className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] text-white" style={{ background: color }}>
        <div className="mx-auto flex max-w-[560px] items-center gap-3">
          <div className="min-w-0 flex-1"><h1 className="truncate text-[18px] font-semibold leading-tight">{title}</h1>{subtitle && <div className="mt-0.5 truncate text-[12.5px] text-white/85">{subtitle}</div>}</div>
          {install && !installed && <button onClick={async () => { await install.prompt(); setInstall(null); }} className="shrink-0 rounded-full bg-white/20 px-3 py-1.5 text-[12.5px] font-medium">Install</button>}
          {right}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-[560px] px-3 py-3">{children}</div></main>
      <nav className="shrink-0 border-t border-[#dfe3e8] bg-white pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-[560px]">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className="relative flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium" style={{ color: tab === t.key ? color : "#738091" }}>
              <span className="h-6 w-6">{t.icon}</span>{t.label}
              {!!t.badge && <span className="absolute right-[calc(50%-20px)] top-1.5 min-w-[18px] rounded-full bg-[#d33d17] px-1 text-[10px] leading-[18px] text-white">{t.badge}</span>}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function Card({ children, onClick, className = "" }: { children: ReactNode; onClick?: () => void; className?: string }) {
  const cls = `block w-full rounded-xl border border-[#e3e7ec] bg-white p-3.5 text-left shadow-[0_1px_2px_rgba(16,22,26,.05)] ${onClick ? "active:bg-[#f0f3f6]" : ""} ${className}`;
  return onClick ? <button onClick={onClick} className={cls}>{children}</button> : <div className={cls}>{children}</div>;
}

const TONE: Record<string, string> = {
  red: "bg-[#fde8e4] text-[#a82a12]", amber: "bg-[#fdf1d8] text-[#8a5a00]", green: "bg-[#e1f4e8] text-[#1c6e42]", blue: "bg-[#e3ecfb] text-[#1f4fa8]", gray: "bg-[#eceff2] text-[#4a5563]",
};
export const toneFor = (status: string) =>
  /tahan|ditahan|hold|kritis|baru/i.test(status) ? "red" : /review|menunggu|terbuka|sedang|tinggi/i.test(status) ? "amber" : /setuju|otomatis|dibayar|dipenuhi|ditindaklanjuti|sesuai|rendah|aktif/i.test(status) ? "green" : "gray";
export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ${TONE[tone] ?? TONE.gray}`}>{children}</span>;
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} className="flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] [animation:sheetUp_.2s_ease-out]">
        <style>{`@keyframes sheetUp{from{transform:translateY(40px);opacity:.5}to{transform:none;opacity:1}}`}</style>
        <div className="flex items-center gap-2 border-b border-[#eceff2] px-4 py-3"><span className="mx-auto h-1 w-10 rounded-full bg-[#d5dae0]" /></div>
        <div className="flex items-start gap-2 px-4 pt-1"><h2 className="flex-1 text-[16px] font-semibold">{title}</h2><button onClick={onClose} className="rounded-full px-2 py-1 text-[22px] leading-none text-[#738091]" aria-label="Tutup">×</button></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">{children}</div>
      </div>
    </div>
  );
}

export function Btn({ children, onClick, color = "#0f766e", variant = "solid", disabled, type = "button", className = "" }: {
  children: ReactNode; onClick?: () => void; color?: string; variant?: "solid" | "outline"; disabled?: boolean; type?: "button" | "submit"; className?: string;
}) {
  return <button type={type} disabled={disabled} onClick={onClick} className={`min-h-[46px] rounded-xl px-4 text-[14.5px] font-semibold disabled:opacity-50 ${className}`}
    style={variant === "solid" ? { background: color, color: "#fff" } : { border: `1.5px solid ${color}`, color }}>{children}</button>;
}

export const field = "w-full rounded-xl border border-[#cfd6de] bg-white px-3 py-2.5 text-[15px] outline-none focus:border-[#2d72d2]";

/** Load + refresh: on mount, every 10 s while visible, and when the app comes back to the front. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(load);
  useEffect(() => { ref.current = load; });
  const reload = useCallback(() => ref.current().then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    reload();
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, 10_000);
    const v = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", v);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", v); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the persona changes
  }, deps);
  return { data, error, reload };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3000); return () => clearTimeout(t); }, [msg]);
  const node = msg ? <div className="fixed inset-x-0 bottom-[80px] z-[60] flex justify-center px-4"><p className="rounded-full bg-[#1c2127] px-4 py-2.5 text-[13.5px] text-white shadow-lg">{msg}</p></div> : null;
  return [node, setMsg] as const;
}

/** A persona kept per device (which participant / which hospital this demo phone is). */
export function useLocal(key: string, initial: string) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the device's persona, read after hydration
    try { const s = localStorage.getItem(key); if (s) setV(s); } catch {}
  }, [key]);
  const set = (x: string) => { setV(x); try { localStorage.setItem(key, x); } catch {} };
  return [v, set] as const;
}

export function Loading({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return error ? (
    <div className="mt-10 text-center text-[14px] text-[#5f6b7c]"><p>Gagal memuat: {error}</p>{onRetry && <button onClick={onRetry} className="mt-3 rounded-xl border border-[#cfd6de] px-4 py-2">Coba lagi</button>}</div>
  ) : <div className="mt-16 flex justify-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-[#cfd6de] border-t-[#2d72d2]" /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-[#cfd6de] px-4 py-8 text-center text-[13.5px] text-[#5f6b7c]">{children}</p>;
}

export const DemoNote = () => <p className="mt-6 pb-2 text-center text-[11px] text-[#8a95a3]">Data demo fiktif · BluesandAI</p>;

// line icons (24px, stroke = currentColor)
const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6"><path d={d} /></svg>;
export const ICONS = {
  inbox: I("M4 13h4l1.5 3h5L16 13h4M4 13l2-7h12l2 7v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"),
  flag: I("M5 21V4m0 0h11l-2 4 2 4H5"),
  folder: I("M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"),
  pin: I("M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"),
  spark: I("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"),
  doc: I("M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6"),
  upload: I("M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"),
  check: I("M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"),
  building: I("M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3"),
  card: I("M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM7 10h4M7 14h7"),
  history: I("M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2"),
};
