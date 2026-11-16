"use client";

// API Documentation (the user, 2026-11-13: "bikin tab baru namanya API Documentation"; 2026-11-15: "bikin professional api docs
// gaya Runpod, OpenAI, Palantir", not the visual chip clouds). A reference site inside the tab: top tabs for the API groups
// (Ringkasan, Branch API v1, IoT, API Nasional), a left sidebar with a search (Ctrl K) and the endpoints grouped by resource,
// one page per endpoint or overview, Previous / Next. The national endpoints come from the running API's own OpenAPI spec
// (/api/api-docs, never a hand-written list); the branch and IoT endpoints from the design spec docs/openapi_cabang_v1.json
// (/api/api-docs/cabang, aktif / rencana per endpoint). Pages are addressable as #api/<page>~<section>. Three columns from
// 1280 px (sidebar, content, sticky code), the code under the content below that, the sidebar a drawer under 1024 px.
// "Coba" (Try it) never sends a request (ApiDocsTryIt).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import type { ApiDocs, CabangDocs } from "./ApiDocsTypes";
import { bangunModel, PANDUAN, TAB_LABEL, TAB_URUT, type Basis, type Ep, type Halaman, type Model, type TabKey } from "./ApiDocsModel";
import { HalamanEndpoint } from "./ApiDocsEndpoint";
import { PanduanAuth, PanduanKonvensi, PanduanMulai, RingkasanCabang, RingkasanIot, RingkasanNasional, RingkasanUmum, type Umum } from "./ApiDocsRingkasan";
import { TryIt } from "./ApiDocsTryIt";
import { MethodBadge, Tabs, type LangKey } from "./ApiDocsShared";

const IKON_PANDUAN: Record<string, IconName> = { "ringkasan/mulai-cepat": "play", "ringkasan/autentikasi": "lock", "ringkasan/konvensi": "alert" };
const IKON_TAB: Record<TabKey, IconName> = { ringkasan: "home", cabang: "pipeline", iot: "signal", nasional: "globe" };
const LANG_KEY = "apidocs.lang";

const tabDari = (id: string): TabKey => {
  const t = id.split("/")[0] as TabKey;
  return TAB_URUT.includes(t) ? t : "ringkasan";
};
const fmtWaktu = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("id-ID", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// ------------------------------------------------------------------------------------------------ the sidebar

function ItemNav({ id, aktif, onNav, children }: { id: string; aktif: boolean; onNav: (id: string) => void; children: ReactNode }) {
  return (
    <a href={`#api/${id}`} onClick={(ev) => { ev.preventDefault(); onNav(id); }} aria-current={aktif ? "page" : undefined}
      className={`flex min-w-0 items-center gap-2.5 rounded-md px-2.5 py-[6px] text-[13px] leading-[18px] transition-colors ${aktif ? "bg-white/[.07] font-medium text-white" : "text-[#a3acb9] hover:bg-white/[.035] hover:text-[#e8ebef]"}`}>
      {children}
    </a>
  );
}

function Sidebar({ tab, model, aktifId, q, setQ, onNav, inputRef, autoFokus, memuat }: {
  tab: TabKey; model: Model; aktifId: string; q: string; setQ: (q: string) => void; onNav: (id: string) => void;
  inputRef: RefObject<HTMLInputElement | null>; autoFokus?: boolean; memuat: boolean;
}) {
  const ql = q.trim().toLowerCase();
  const cocok = (e: Ep, resNama: string) => !ql || e.nama.toLowerCase().includes(ql) || e.path.toLowerCase().includes(ql) || resNama.toLowerCase().includes(ql) || e.method.toLowerCase() === ql;
  const grup = model.resources.filter((r) => r.tab === tab).map((r) => ({ r, eps: r.eps.filter((e) => cocok(e, r.nama)) })).filter((g) => g.eps.length > 0);
  const lain = ql ? TAB_URUT.filter((t) => t !== tab && t !== "ringkasan").map((t) => ({
    t, n: model.resources.filter((r) => r.tab === t).reduce((s, r) => s + r.eps.filter((e) => cocok(e, r.nama)).length, 0),
  })).filter((x) => x.n > 0) : [];
  const nav = useRef<HTMLElement>(null);
  // the active item stays in view when Previous / Next moves on
  useEffect(() => { nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" }); }, [aktifId]);
  const atas = tab === "ringkasan"
    ? [{ id: "ringkasan", judul: "Ringkasan", ikon: "home" as IconName }, ...PANDUAN.filter((p) => model.byId.has(p.id)).map((p) => ({ id: p.id, judul: p.judul, ikon: IKON_PANDUAN[p.id] }))]
    : [{ id: tab, judul: "Ringkasan", ikon: "doc" as IconName }];
  const atasCocok = atas.filter((x) => !ql || x.judul.toLowerCase().includes(ql));
  const kosong = !memuat && ql && grup.length === 0 && atasCocok.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2 pt-3">
        <label className="flex items-center gap-2 rounded-md border border-white/[.09] bg-white/[.025] px-2.5 py-[7px] text-[13px] focus-within:border-[#9d8cff]/50">
          <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-[#6f7a88]" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFokus} placeholder="Cari endpoint…" aria-label="Cari endpoint"
            onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }}
            className="min-w-0 flex-1 bg-transparent text-[#e8ebef] outline-none placeholder:text-[#6f7a88]" />
          {q
            ? <button type="button" onClick={() => setQ("")} aria-label="Hapus pencarian" className="text-[#6f7a88] hover:text-white"><Icon name="x" className="h-3 w-3" /></button>
            : <kbd className="hidden shrink-0 rounded border border-white/[.10] px-1 font-sans text-[10.5px] text-[#6f7a88] lg:inline">Ctrl K</kbd>}
        </label>
      </div>
      <nav ref={nav} aria-label="Navigasi dokumentasi" className="min-h-0 flex-1 overflow-y-auto px-3 pb-8 [scrollbar-width:thin]">
        {atasCocok.length > 0 && (
          <div className="space-y-px pt-1">
            {atasCocok.map((x) => (
              <ItemNav key={x.id} id={x.id} aktif={aktifId === x.id} onNav={onNav}>
                <Icon name={x.ikon} className="h-3.5 w-3.5 shrink-0 text-[#8a94a3]" /><span className="truncate">{x.judul}</span>
              </ItemNav>
            ))}
          </div>
        )}
        {tab === "ringkasan" && !ql && (
          <div className="mt-6">
            <p className="px-2.5 pb-1.5 text-[12px] font-semibold text-[#e8ebef]">Referensi API</p>
            <div className="space-y-px">
              {(["cabang", "iot", "nasional"] as TabKey[]).map((t) => {
                const n = model.resources.filter((r) => r.tab === t).reduce((s, r) => s + r.eps.length, 0);
                return (
                  <ItemNav key={t} id={t} aktif={false} onNav={onNav}>
                    <Icon name={IKON_TAB[t]} className="h-3.5 w-3.5 shrink-0 text-[#8a94a3]" /><span className="min-w-0 flex-1 truncate">{TAB_LABEL[t]}</span>
                    {n > 0 && <span className="text-[11.5px] tabular-nums text-[#6f7a88]">{n}</span>}
                  </ItemNav>
                );
              })}
            </div>
          </div>
        )}
        {grup.map(({ r, eps }) => (
          <div key={r.key} className="mt-6">
            <p className="px-2.5 pb-1.5 text-[12px] font-semibold text-[#e8ebef]">{r.nama}</p>
            <div className="space-y-px">
              {eps.map((e) => (
                <ItemNav key={e.id} id={e.id} aktif={aktifId === e.id} onNav={onNav}>
                  <MethodBadge m={e.method} /><span className="truncate" title={`${e.nama} · ${e.path}`}>{e.nama}</span>
                </ItemNav>
              ))}
            </div>
          </div>
        ))}
        {memuat && grup.length === 0 && tab !== "ringkasan" && (
          <div className="mt-6 space-y-2 px-2.5" aria-busy="true">
            {[70, 55, 80, 60, 75, 50].map((w, i) => <div key={i} className="h-3.5 animate-pulse rounded bg-white/[.05]" style={{ width: `${w}%` }} />)}
          </div>
        )}
        {kosong && <p className="px-2.5 pt-4 text-[13px] text-[#8a94a3]">Tidak ada yang cocok dengan “{q.trim()}”.</p>}
        {lain.length > 0 && (
          <div className="mt-6 px-2.5 text-[12.5px] text-[#8a94a3]">
            Juga cocok di
            <div className="mt-1.5 space-y-1">
              {lain.map((x) => (
                <button key={x.t} type="button" onClick={() => onNav(x.t)} className="flex w-full items-center justify-between text-left text-[#c9bfff] hover:text-white">
                  <span>{TAB_LABEL[x.t]}</span><span className="tabular-nums text-[#6f7a88]">{x.n}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ loading and errors

function Kerangka() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pt-10 sm:px-8 lg:px-10" aria-busy="true" aria-label="Memuat dokumentasi">
      <div className="h-3 w-32 animate-pulse rounded bg-white/[.05]" />
      <div className="mt-4 h-8 w-80 max-w-full animate-pulse rounded bg-white/[.06]" />
      <div className="mt-5 space-y-2.5">{[95, 88, 70].map((w) => <div key={w} className="h-3.5 animate-pulse rounded bg-white/[.04]" style={{ width: `${w}%` }} />)}</div>
      <div className="mt-12 space-y-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-white/[.03]" />)}</div>
    </div>
  );
}

function GagalMuat({ teks, onUlang }: { teks: string; onUlang: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[800px] px-5 pt-12 sm:px-8">
      <div role="alert" className="flex gap-3 rounded-lg border border-white/[.08] bg-white/[.025] px-4 py-3 text-[13.5px] text-[#b4bcc7]">
        <Icon name="alert" className="mt-[3px] h-4 w-4 shrink-0 text-[#d9b46a]" />
        <div className="min-w-0">{teks} <button type="button" onClick={onUlang} className="ml-1 font-medium text-[#c9bfff] underline underline-offset-4">Coba lagi</button></div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the view

async function ambil<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `${r.status} ${r.statusText}`);
  return body as T;
}

export function ApiDocsView() {
  const [nasional, setNasional] = useState<ApiDocs | null>(null);
  const [nasionalErr, setNasionalErr] = useState<string | null>(null);
  const [cabang, setCabang] = useState<CabangDocs | null>(null);
  const [cabangErr, setCabangErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [halamanId, setHalamanId] = useState("ringkasan");
  const [q, setQ] = useState("");
  const [laci, setLaci] = useState<false | "buka" | "cari">(false);
  const [coba, setCoba] = useState<Ep | null>(null);
  const [lang, setLang] = useState<LangKey>(() => {
    try {
      const v = typeof window !== "undefined" ? window.localStorage.getItem(LANG_KEY) : null;
      return v === "python" || v === "js" ? v : "curl";
    } catch { return "curl"; }
  });
  const gulir = useRef<HTMLDivElement>(null);
  const cariRef = useRef<HTMLInputElement>(null);
  const cariLaciRef = useRef<HTMLInputElement>(null);
  const seksiMinta = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    ambil<ApiDocs>("/api/api-docs").then((d) => { if (alive) { setNasional(d); setNasionalErr(null); } })
      .catch((e) => { if (alive) setNasionalErr(e instanceof Error ? e.message : String(e)); });
    ambil<CabangDocs>("/api/api-docs/cabang").then((d) => { if (alive) { setCabang(d); setCabangErr(null); } })
      .catch((e) => { if (alive) setCabangErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [nonce]);
  const muatUlang = useCallback(() => { setNasionalErr(null); setCabangErr(null); setNonce((n) => n + 1); }, []);

  // #api/<page>~<section>: on entry and on back / forward
  useEffect(() => {
    const baca = () => {
      const m = /^#api\/([^~]+)(?:~(.+))?$/.exec(window.location.hash);
      if (!m) return;
      seksiMinta.current = m[2] ?? null;
      setHalamanId(decodeURIComponent(m[1]));
    };
    const raf = requestAnimationFrame(baca);
    window.addEventListener("hashchange", baca);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("hashchange", baca); };
  }, []);

  // Ctrl K: the search (in the drawer on a narrow screen)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (window.matchMedia("(min-width: 1024px)").matches) { cariRef.current?.focus(); cariRef.current?.select(); }
        else if (cariLaciRef.current) cariLaciRef.current.focus();
        else setLaci("cari");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const model = useMemo(() => bangunModel(nasional, cabang), [nasional, cabang]);
  const memuat = (!nasional && !nasionalErr) || (!cabang && !cabangErr);
  const sumberTab = (t: TabKey) => (t === "nasional" ? { ada: !!nasional, galat: nasionalErr } : t === "ringkasan" ? { ada: !!(nasional || cabang), galat: nasionalErr && cabangErr } : { ada: !!cabang, galat: cabangErr });
  const tabMinta = tabDari(halamanId);
  // the page asked for, else (once its spec is in) the overview of its tab
  const tampil: Halaman | undefined = model.byId.get(halamanId)
    ?? (sumberTab(tabMinta).ada || sumberTab(tabMinta).galat ? model.byId.get(tabMinta) ?? model.byId.get("ringkasan") : undefined);
  const tab = tampil?.tab ?? tabMinta;

  const basis: Basis = useMemo(() => {
    const ui = typeof window === "undefined" ? "" : window.location.origin;
    return { api: API_URL || ui, ui };
  }, []);

  const nav = useCallback((id: string, seksi?: string) => {
    setHalamanId(id);
    setLaci(false);
    seksiMinta.current = seksi ?? null;
    try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#api/${id}${seksi ? `~${seksi}` : ""}`); } catch { /* ignore */ }
  }, []);

  // a new page starts at its top, or at the section the link named
  const tampilId = tampil?.id;
  useEffect(() => {
    if (!tampilId) return;
    const s = seksiMinta.current;
    seksiMinta.current = null;
    if (s) requestAnimationFrame(() => document.getElementById(s)?.scrollIntoView({ block: "start" }));
    else gulir.current?.scrollTo({ top: 0 });
  }, [tampilId]);

  const onAnchor = useCallback((seksi: string) => {
    document.getElementById(seksi)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (tampilId) try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#api/${tampilId}~${seksi}`); } catch { /* ignore */ }
  }, [tampilId]);

  const ubahLang = useCallback((l: LangKey) => {
    setLang(l);
    try { window.localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
  }, []);
  const tutupCoba = useCallback(() => setCoba(null), []);

  const idx = tampil ? model.halaman.findIndex((h) => h.id === tampil.id) : -1;
  const prev = idx > 0 ? model.halaman[idx - 1] : undefined;
  const next = idx >= 0 && idx < model.halaman.length - 1 ? model.halaman[idx + 1] : undefined;
  const diperbarui = tab === "nasional"
    ? (nasional ? `Spesifikasi dibaca dari API ${fmtWaktu(nasional.diambil)}` : "")
    : cabang ? `Terakhir diperbarui ${fmtWaktu(cabang.diperbarui)}` : "";

  let isi: ReactNode;
  const u: Umum = { model, cabang, nasional, basis, lang, onLang: ubahLang, onNav: nav, onAnchor, prev, next, diperbarui, gulir, nasionalGalat: nasionalErr, onMuatUlang: muatUlang };
  if (!tampil) isi = <Kerangka />;
  else if (tampil.jenis === "endpoint") {
    const res = model.resources.find((r) => r.tab === tampil.tab && r.key === tampil.ep.resource);
    isi = <HalamanEndpoint key={tampil.id} ep={tampil.ep} kicker={`${TAB_LABEL[tampil.tab]} · ${res?.nama ?? ""}`} basis={basis} lang={lang} onLang={ubahLang}
      onNav={nav} onAnchor={onAnchor} onTry={setCoba} prev={prev} next={next} diperbarui={diperbarui} />;
  } else if (tampil.jenis === "panduan") {
    isi = tampil.panduan === "mulai" ? <PanduanMulai key={tampil.id} u={u} /> : tampil.panduan === "auth" ? <PanduanAuth key={tampil.id} u={u} /> : <PanduanKonvensi key={tampil.id} u={u} />;
  } else if ((tampil.tab === "cabang" || tampil.tab === "iot") && !cabang) {
    isi = cabangErr ? <GagalMuat teks={cabangErr} onUlang={muatUlang} /> : <Kerangka />;
  } else {
    isi = tampil.tab === "ringkasan" ? <RingkasanUmum key="r" u={u} /> : tampil.tab === "cabang" ? <RingkasanCabang key="c" u={u} />
      : tampil.tab === "iot" ? <RingkasanIot key="i" u={u} /> : <RingkasanNasional key="n" u={u} />;
  }

  const sidebar = (ref: RefObject<HTMLInputElement | null>, autoFokus?: boolean) => (
    <Sidebar tab={tab} model={model} aktifId={tampil?.id ?? ""} q={q} setQ={setQ} onNav={nav} inputRef={ref} autoFokus={autoFokus} memuat={memuat} />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0d10] text-[#e8ebef]" data-apidocs>
      {/* the top bar: title and the API groups */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[.07] px-3 sm:px-5">
        <button type="button" onClick={() => setLaci("buka")} aria-label="Buka navigasi" className="-ml-1 rounded-md p-1.5 text-[#a3acb9] hover:bg-white/[.06] hover:text-white lg:hidden">
          <Icon name="list" className="h-4 w-4" />
        </button>
        <span className="hidden shrink-0 items-center gap-2 text-[13.5px] font-semibold text-white sm:flex">
          <Icon name="code" className="h-4 w-4 text-[#9d8cff]" />Dokumentasi API
        </span>
        <span className="hidden h-5 w-px shrink-0 bg-white/[.10] sm:block" />
        <div className="h-full min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          <Tabs items={TAB_URUT.map((t) => ({ key: t, label: TAB_LABEL[t] }))} value={tab} onChange={(t) => nav(t)} label="Kelompok API" penuh />
        </div>
        <button type="button" onClick={muatUlang} title="Muat ulang spesifikasi" aria-label="Muat ulang spesifikasi"
          className="hidden shrink-0 rounded-md p-1.5 text-[#8a94a3] hover:bg-white/[.06] hover:text-white sm:block">
          <Icon name="refresh" className={`h-3.5 w-3.5 ${memuat ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[272px] shrink-0 flex-col border-r border-white/[.07] lg:flex">{sidebar(cariRef)}</aside>
        <main ref={gulir} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin]">{isi}</main>
      </div>

      {/* the sidebar as a drawer under 1024 px */}
      {laci && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigasi dokumentasi"
          onKeyDown={(e) => { if (e.key === "Escape") setLaci(false); }}>
          <div className="absolute inset-0 bg-black/60" onClick={() => setLaci(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[300px] max-w-[86vw] flex-col border-r border-white/[.08] bg-[#0b0d10]">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[.07] px-4">
              <Icon name="code" className="h-4 w-4 text-[#9d8cff]" /><span className="text-[13.5px] font-semibold text-white">Dokumentasi API</span>
              <button type="button" onClick={() => setLaci(false)} aria-label="Tutup navigasi" className="ml-auto rounded-md p-1.5 text-[#a3acb9] hover:bg-white/[.06] hover:text-white">
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
            {sidebar(cariLaciRef, laci === "cari")}
          </div>
        </div>
      )}

      {coba && <TryIt key={coba.id} ep={coba} basis={basis} lang={lang} onLang={ubahLang} onClose={tutupCoba} />}
    </div>
  );
}
