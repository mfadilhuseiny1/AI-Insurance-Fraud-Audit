"use client";

// API Documentation · shared pieces of the reference pages (2026-11-15, the user: "professional API docs gaya Runpod, OpenAI,
// Palantir", not the visual chip clouds): text first, near-black, white and grey text with one accent (#9d8cff) for links and
// the active item. Small muted method labels (POST blue, GET green, PATCH orange, PUT amber, DELETE red as DEL), a copy button,
// keyboard-accessible tabs, the heading with its anchor, a quiet callout, and a light highlighter for the sample languages
// (cURL, Python, JavaScript, JSON).

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";

// ------------------------------------------------------------------------------------------------ methods

// muted: the hue says the method, the label stays quiet (as OpenAI's reference)
export const METODE: Record<string, { warna: string; label: string }> = {
  GET: { warna: "#7cc4a0", label: "GET" },
  POST: { warna: "#83aee0", label: "POST" },
  PATCH: { warna: "#d6a079", label: "PATCH" },
  PUT: { warna: "#d3b872", label: "PUT" },
  DELETE: { warna: "#dc8a8a", label: "DEL" },
};
const metode = (m: string) => METODE[m] ?? { warna: "#8a94a3", label: m };

/** the method as a small muted label: "sm" in the sidebar, "md" on the method bar */
export function MethodBadge({ m, size = "sm" }: { m: string; size?: "sm" | "md" }) {
  const { warna, label } = metode(m);
  const cls = size === "sm"
    ? "w-[36px] rounded-[4px] py-[1px] text-[9.5px] leading-[14px]"
    : "rounded-[5px] px-1.5 py-[2px] text-[11px] leading-[16px]";
  return (
    <span aria-label={m} className={`inline-flex shrink-0 justify-center font-mono font-semibold tracking-wide ${cls}`}
      style={{ color: warna, background: `${warna}14` }}>{label}</span>
  );
}

/** the path in monospace with its {params} a shade lighter */
export function PathText({ path, className = "" }: { path: string; className?: string }) {
  return (
    <span className={`min-w-0 break-all font-mono ${className}`}>
      {path.split(/(\{[^}]+\})/).map((p, i) =>
        p.startsWith("{") ? <span key={i} className="text-[#b9b0f0]">{p}</span> : <span key={i}>{p}</span>,
      )}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ chips

type Nada = "netral" | "aksen" | "wajib" | "hijau" | "kuning" | "redup";
const NADA: Record<Nada, string> = {
  netral: "bg-white/[.05] text-[#c5ccd6] ring-white/[.07]",
  aksen: "bg-white/[.05] text-[#c9bfff] ring-white/[.07]",
  wajib: "bg-transparent text-[#d9a066] ring-white/[.07]",
  hijau: "bg-transparent text-[#7cc4a0] ring-white/[.07]",
  kuning: "bg-transparent text-[#d9b46a] ring-white/[.07]",
  redup: "bg-transparent text-[#8a94a3] ring-white/[.08]",
};

export function Pil({ children, nada = "netral", mono, ikon, title, putus }: { children: ReactNode; nada?: Nada; mono?: boolean; ikon?: IconName; title?: string; putus?: boolean }) {
  return (
    <span title={title} className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-[1px] text-[11.5px] leading-[18px] ring-1 ring-inset ${NADA[nada]} ${mono ? "font-mono text-[11px]" : ""} ${putus ? "!ring-0 outline-1 outline-dashed outline-white/25" : ""}`}>
      {ikon && <Icon name={ikon} className="h-3 w-3 shrink-0" />}<span className="truncate">{children}</span>
    </span>
  );
}

/** inline code in running text */
export const Kode = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[5px] bg-white/[.07] px-1 py-[1px] font-mono text-[0.88em] text-[#dfe3e8] ring-1 ring-inset ring-white/[.06]">{children}</code>
);

// ------------------------------------------------------------------------------------------------ copy

export async function salin(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http on a LAN address has no Clipboard API: the old way
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** a copy button: an icon alone (label "") or with a label; says "Tersalin" for a moment */
export function SalinTombol({ text, label = "", judul = "Salin ke clipboard", className = "" }: { text: string | (() => string); label?: string; judul?: string; className?: string }) {
  const [state, setState] = useState<"" | "ok" | "gagal">("");
  const go = async () => {
    const ok = await salin(typeof text === "function" ? text() : text);
    setState(ok ? "ok" : "gagal");
    setTimeout(() => setState(""), 1600);
  };
  return (
    <button type="button" onClick={go} title={judul} aria-label={label || judul}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md text-[12px] transition-colors ${label ? "px-2 py-1" : "p-1.5"} ${state === "ok" ? "text-[#6ee7b7]" : "text-[#a3acb9] hover:bg-white/[.07] hover:text-white"} ${className}`}>
      <Icon name={state === "ok" ? "check" : "copy"} className="h-3.5 w-3.5" />
      {label && <span>{state === "ok" ? "Tersalin" : state === "gagal" ? "Gagal menyalin" : label}</span>}
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ tabs

export type TabItem<K extends string> = { key: K; label: ReactNode; title?: string };

/** a tab list with roving focus: ← → Home End move between tabs, as WAI-ARIA tabs do */
export function Tabs<K extends string>({ items, value, onChange, label, variant = "garis", size = "md", idPrefix, penuh }: {
  items: TabItem<K>[]; value: K; onChange: (k: K) => void; label: string; variant?: "garis" | "pil"; size?: "sm" | "md"; idPrefix?: string;
  /** full height: the underline sits on the bar's bottom border (the page's top tabs) */
  penuh?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (ev: KeyboardEvent, i: number) => {
    const n = items.length;
    const j = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i - 1 + n) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    ev.preventDefault();
    onChange(items[j].key);
    refs.current[j]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={`flex min-w-0 items-center ${variant === "pil" ? "gap-0.5" : penuh ? "h-full gap-5" : "gap-1"}`}>
      {items.map((t, i) => {
        const on = t.key === value;
        const cls = variant === "pil"
          ? `rounded-md px-2 ${size === "sm" ? "py-[3px] text-[11.5px]" : "py-1 text-[12.5px]"} ${on ? "bg-white/[.09] text-white" : "text-[#8a94a3] hover:text-[#dfe3e8]"}`
          : `relative px-1 ${penuh ? "flex h-full items-center text-[13px]" : size === "sm" ? "py-2 text-[12px]" : "py-2.5 text-[13px]"} ${on ? "text-white" : "text-[#8a94a3] hover:text-[#dfe3e8]"}`;
        return (
          <button key={t.key} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
            id={idPrefix ? `${idPrefix}-${t.key}` : undefined} title={t.title}
            onClick={() => onChange(t.key)} onKeyDown={(ev) => onKey(ev, i)}
            className={`shrink-0 whitespace-nowrap font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#9d8cff]/60 ${cls}`}>
            {t.label}
            {variant === "garis" && on && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-[#9d8cff]" />}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ headings, callouts

/** a section heading with an anchor that shows on hover; the section id makes the "On this page" link */
export function H2({ id, children, kanan, onAnchor }: { id: string; children: ReactNode; kanan?: ReactNode; onAnchor: (id: string) => void }) {
  return (
    <div className="group/h flex scroll-mt-6 flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[.08] pb-3 pt-12" id={id} data-seksi>
      <h2 className="relative text-[17px] font-semibold tracking-[-0.01em] text-white">
        <a href={`#${id}`} onClick={(ev) => { ev.preventDefault(); onAnchor(id); }} aria-label="Tautan ke bagian ini"
          className="absolute -left-6 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-[#6f7a88] opacity-0 transition-opacity hover:text-[#c9bfff] focus-visible:opacity-100 group-hover/h:opacity-100 md:block">
          <Icon name="link" className="h-3.5 w-3.5" />
        </a>
        {children}
      </h2>
      {kanan && <div className="ml-auto flex min-w-0 items-center gap-2">{kanan}</div>}
    </div>
  );
}

export function Callout({ ikon = "info", judul, children }: { ikon?: IconName; judul?: string; children: ReactNode }) {
  return (
    <div className="mt-6 flex gap-3 rounded-lg border border-white/[.08] bg-white/[.025] px-4 py-3 text-[13.5px] leading-[1.65] text-[#b4bcc7]">
      <span className="mt-[3px] shrink-0 text-[#8a94a3]"><Icon name={ikon} className="h-4 w-4" /></span>
      <div className="min-w-0">
        {judul && <span className="font-medium text-[#e8ebef]">{judul}. </span>}
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the highlighter

export type Bahasa = "sh" | "json" | "py" | "js";
export const WARNA_KODE = { kata: "#c792ea", str: "#a5e3b4", kunci: "#8fb8ff", angka: "#f7b37a", lit: "#ff9cb4", kom: "#6b7685", fungsi: "#8fb8ff", flag: "#c9bfff", env: "#ffcb6b" };

const POLA: Record<Bahasa, RegExp> = {
  json: /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
  sh: /(#[^\n]*)|(\$\{?[A-Z_]+\}?)|("(?:\\.|[^"\\])*"|'(?:[^'\\]|'\\'')*')|(^|\s)(--?[A-Za-z][\w-]*)|\b(curl)\b/gm,
  py: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(\s*:)?|\b(import|from|as|print|def|return|if|else|for|in|with|f)\b|\b(True|False|None)\b|\b(\d+(?:\.\d+)?)\b|\b([a-z_]+)(?=\()/g,
  js: /(\/\/[^\n]*)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")(\s*:)?|\b(const|let|await|async|new|return|then|catch|function)\b|\b(true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\s*:)|\b([a-zA-Z_]+)(?=\()/g,
};

/** a light highlighter: strings, keys, numbers, literals, keywords, flags and $ENV */
export function warnai(code: string, lang: Bahasa): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(POLA[lang]);
  const S = (k: number, color: string, t: string, extra?: object) => <span key={k} style={{ color, ...extra }}>{t}</span>;
  const W = WARNA_KODE;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const k = out.length;
    if (lang === "json") {
      if (m[1]) { out.push(S(k, m[2] ? W.kunci : W.str, m[1])); if (m[2]) out.push(m[2]); }
      else out.push(S(k, m[3] ? W.lit : W.angka, m[0]));
    } else if (lang === "sh") {
      if (m[1]) out.push(S(k, W.kom, m[1], { fontStyle: "italic" }));
      else if (m[2]) out.push(S(k, W.env, m[2]));
      else if (m[3]) out.push(<span key={k} style={{ color: W.str }}>{m[3].split(/(\$\{?[A-Z_]+\}?)/).map((p, j) => (p.startsWith("$") ? <span key={j} style={{ color: W.env }}>{p}</span> : p))}</span>);
      else if (m[5]) out.push(m[4], S(k, W.flag, m[5]));
      else out.push(S(k, W.kata, m[0], { fontWeight: 600 }));
    } else if (lang === "py") {
      if (m[1]) out.push(S(k, W.kom, m[1], { fontStyle: "italic" }));
      else if (m[2]) { out.push(S(k, m[3] ? W.kunci : W.str, m[2])); if (m[3]) out.push(m[3]); }
      else if (m[4]) out.push(S(k, W.kata, m[4]));
      else if (m[5]) out.push(S(k, W.lit, m[5]));
      else if (m[6]) out.push(S(k, W.angka, m[6]));
      else out.push(S(k, W.fungsi, m[0]));
    } else {
      if (m[1]) out.push(S(k, W.kom, m[1], { fontStyle: "italic" }));
      else if (m[2]) { out.push(S(k, m[3] ? W.kunci : W.str, m[2])); if (m[3]) out.push(m[3]); }
      else if (m[4]) out.push(S(k, W.kata, m[4]));
      else if (m[5]) out.push(S(k, W.lit, m[5]));
      else if (m[6]) out.push(S(k, W.angka, m[6]));
      else if (m[7]) out.push(S(k, W.kunci, m[7]));
      else out.push(S(k, W.fungsi, m[0]));
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/** a code block's body: monospace, highlighted, scrolling inside itself (never the page) */
export function BlokKode({ code, lang, maxH = "max-h-[420px]" }: { code: string; lang: Bahasa; maxH?: string }) {
  return (
    <pre className={`overflow-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-[#d7dce2] [scrollbar-width:thin] ${maxH}`}>
      <code>{warnai(code, lang)}</code>
    </pre>
  );
}

// ------------------------------------------------------------------------------------------------ the code panel

export type LangKey = "curl" | "python" | "js";
export const LANG_TABS: TabItem<LangKey>[] = [{ key: "curl", label: "cURL" }, { key: "python", label: "Python" }, { key: "js", label: "JavaScript" }];
const BAHASA: Record<LangKey, Bahasa> = { curl: "sh", python: "py", js: "js" };

/** a titled code panel with the three language tabs and a copy button (request samples, the OpenAPI download) */
export function PanelKode({ judul, kode, lang, onLang, maxH, kiri }: {
  judul: ReactNode; kode: Record<LangKey, string>; lang: LangKey; onLang: (l: LangKey) => void; maxH?: string; kiri?: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-white/[.08] bg-[#111418]">
      <div className="flex min-w-0 items-center gap-2 border-b border-white/[.06] pl-4 pr-1.5">
        {kiri}
        <span className="min-w-0 flex-1 truncate py-2.5 text-[12.5px] font-medium text-[#e8ebef]">{judul}</span>
        <Tabs items={LANG_TABS} value={lang} onChange={onLang} label="Bahasa contoh" size="sm" />
        <SalinTombol text={kode[lang]} judul="Salin kode" />
      </div>
      <BlokKode code={kode[lang]} lang={BAHASA[lang]} maxH={maxH} />
    </div>
  );
}
