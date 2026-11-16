"use client";

// API Documentation · one endpoint's reference page (2026-11-15, "professional API docs gaya Runpod, OpenAI, Palantir"): text
// first. The resource line, the name, a short description and "Salin halaman"; the method and path with "Coba"; Otorisasi
// (the auth header as a parameter), header / path / query parameters and the body as vertical rows (name in mono, type in
// muted text, required / optional, the description below, thin dividers, nested attributes collapsed); the response per status
// code. On the right, sticky from 1280 px: the request in cURL / Python / JavaScript and the response example per status
// code. Previous / Next and "Terakhir diperbarui" close the page. KepalaHalaman, NavBawah and Medan are shared with the
// overview and guide pages.

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { DocField, DocParam } from "./ApiDocsTypes";
import { markdownEndpoint, permintaanOf, sampel, STATUS_TEKS, tipeTampil, warnaKode, type Basis, type Ep, type Halaman, type Respons } from "./ApiDocsModel";
import { BlokKode, Callout, H2, Kode, MethodBadge, PanelKode, PathText, SalinTombol, Tabs, type LangKey } from "./ApiDocsShared";

// ------------------------------------------------------------------------------------------------ text

/** `code` in a description as inline code */
export function TeksKaya({ s }: { s: string }) {
  return <>{s.split(/(`[^`]+`)/).map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <Kode key={i}>{p.slice(1, -1)}</Kode> : p))}</>;
}

// ------------------------------------------------------------------------------------------------ page head and foot

export function KepalaHalaman({ kicker, judul, deskripsi, md, meta }: { kicker: ReactNode; judul: string; deskripsi?: ReactNode; md: () => string; meta?: ReactNode }) {
  return (
    <header>
      <div className="text-[12.5px] font-medium text-[#8a94a3]">{kicker}</div>
      <div className="mt-1.5 flex flex-wrap items-start gap-x-4 gap-y-3">
        <h1 className="min-w-0 flex-1 text-[26px] font-semibold leading-[1.25] tracking-[-0.02em] text-white sm:text-[30px]">{judul}</h1>
        <SalinTombol text={md} label="Salin halaman" judul="Salin halaman ini sebagai Markdown"
          className="mt-1 border border-white/[.10] !px-2.5 !py-1.5 hover:border-white/20" />
      </div>
      {deskripsi && <p className="mt-3 max-w-[70ch] text-[15px] leading-[1.7] text-[#a3acb9]">{deskripsi}</p>}
      {meta && <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[#8a94a3]">{meta}</div>}
    </header>
  );
}

const NAMA_TAB: Record<string, string> = { ringkasan: "Dokumentasi API", cabang: "Branch API v1", iot: "IoT", nasional: "API Nasional" };

function KartuNav({ h, arah, onNav }: { h: Halaman; arah: "prev" | "next"; onNav: (id: string) => void }) {
  const kanan = arah === "next";
  return (
    <a href={`#api/${h.id}`} onClick={(ev) => { ev.preventDefault(); onNav(h.id); }}
      className={`group flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-white/[.08] px-4 py-3 transition-colors hover:border-white/20 ${kanan ? "items-end text-right" : ""}`}>
      <span className="flex items-center gap-1 text-[12px] text-[#8a94a3]">
        {!kanan && <Icon name="left" className="h-3 w-3" />}{kanan ? "Berikutnya" : "Sebelumnya"}{kanan && <Icon name="right" className="h-3 w-3" />}
      </span>
      <span className={`flex min-w-0 max-w-full items-center gap-2 text-[14px] font-medium text-[#dfe3e8] group-hover:text-white ${kanan ? "flex-row-reverse" : ""}`}>
        {h.jenis === "endpoint" && <MethodBadge m={h.ep.method} />}
        <span className="truncate">{h.jenis === "ringkasan" ? `Ringkasan · ${NAMA_TAB[h.tab]}` : h.judul}</span>
      </span>
    </a>
  );
}

export function NavBawah({ prev, next, onNav, diperbarui }: { prev?: Halaman; next?: Halaman; onNav: (id: string) => void; diperbarui: string }) {
  return (
    <footer className="mt-16">
      <div className="flex flex-col gap-3 sm:flex-row">
        {prev ? <KartuNav h={prev} arah="prev" onNav={onNav} /> : <span className="hidden flex-1 sm:block" />}
        {next ? <KartuNav h={next} arah="next" onNav={onNav} /> : <span className="hidden flex-1 sm:block" />}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[.06] pt-5 text-[12.5px] text-[#6f7a88]">
        <span>{diperbarui}</span>
        <span className="ml-auto">Dokumentasi API · AI JKN</span>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------------------------------------------ fields

type MedanLike = Pick<DocField, "name" | "type" | "required" | "description" | "enum" | "default" | "batas" | "children" | "nullable">;

/** one parameter as a row: name, type, required / optional, then the description, limits and enum values below */
export function Medan({ f, lokasi, namaKelas }: { f: MedanLike; lokasi?: string; namaKelas?: string }) {
  const [buka, setBuka] = useState(false);
  const anak = f.children ?? [];
  return (
    <div className={`border-t border-white/[.06] py-4 first:border-t-0 ${namaKelas ?? ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="break-all font-mono text-[13px] font-semibold text-[#eef0f3]">{f.name}</span>
        <span className="font-mono text-[12px] text-[#8a94a3]">{tipeTampil(f)}{f.nullable ? " | null" : ""}</span>
        {lokasi && <span className="text-[12px] text-[#8a94a3]">{lokasi}</span>}
        <span className={`text-[11.5px] ${f.required ? "font-medium text-[#d9a066]" : "text-[#6f7a88]"}`}>{f.required ? "wajib" : "opsional"}</span>
      </div>
      {f.description && <p className="mt-1.5 text-[13.5px] leading-[1.65] text-[#a3acb9]"><TeksKaya s={f.description} /></p>}
      {(f.default !== undefined || f.batas) && (
        <p className="mt-1.5 break-all text-[12.5px] text-[#8a94a3]">
          {f.default !== undefined && <>Bawaan: <Kode>{JSON.stringify(f.default)}</Kode></>}
          {f.default !== undefined && f.batas && <span className="mx-2 text-[#4f5966]">·</span>}
          {f.batas && <>Batas: <Kode>{f.batas}</Kode></>}
        </p>
      )}
      {f.enum && f.enum.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-[#8a94a3]">
          <span className="mr-0.5">{f.enum.length === 1 ? "Nilai:" : "Opsi:"}</span>
          {f.enum.map((v) => <Kode key={String(v)}>{String(v)}</Kode>)}
        </div>
      )}
      {anak.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setBuka((x) => !x)} aria-expanded={buka}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[.10] px-2.5 py-1 text-[12px] text-[#b4bcc7] hover:border-white/20 hover:text-white">
            <Icon name={buka ? "minus" : "plus"} className="h-3 w-3" />{buka ? "Sembunyikan" : "Tampilkan"} atribut anak ({anak.length})
          </button>
          {buka && (
            <div className="ml-1 mt-2 border-l border-white/[.10] pl-4">
              {anak.map((c) => <Medan key={c.name} f={c} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const wajibDulu = <X extends { required: boolean }>(xs: X[]) => [...xs.filter((x) => x.required), ...xs.filter((x) => !x.required)];

function Kosong({ children }: { children: ReactNode }) {
  return <p className="py-4 text-[13.5px] text-[#8a94a3]">{children}</p>;
}

// ------------------------------------------------------------------------------------------------ the right column

function PanelRespons({ ep, kode, onKode }: { ep: Ep; kode: string; onKode: (k: string) => void }) {
  const r = ep.respons.find((x) => x.kode === kode) ?? ep.respons[0];
  const teks = r?.contoh !== undefined ? JSON.stringify(r.contoh, null, 2) : "";
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-white/[.08] bg-[#111418]">
      <div className="flex min-w-0 items-center gap-2 border-b border-white/[.06] py-1.5 pl-3 pr-1.5">
        <span className="shrink-0 text-[12.5px] font-medium text-[#e8ebef]">Respons</span>
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          <Tabs items={ep.respons.map((x) => ({ key: x.kode, label: x.kode, title: `${x.kode} ${STATUS_TEKS[x.kode] ?? ""}` }))}
            value={r?.kode ?? ""} onChange={onKode} label="Contoh respons per kode status" variant="pil" size="sm" />
        </div>
        {teks && <SalinTombol text={teks} judul="Salin contoh respons" />}
      </div>
      {teks ? <BlokKode code={teks} lang="json" maxH="max-h-[min(360px,36vh)]" />
        : <p className="px-4 py-4 text-[12.5px] leading-relaxed text-[#8a94a3]">{r?.catatan ?? "Tidak ada contoh untuk kode ini."}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the page

export function HalamanEndpoint({ ep, kicker, basis, lang, onLang, onNav, onAnchor, onTry, prev, next, diperbarui }: {
  ep: Ep; kicker: string; basis: Basis; lang: LangKey; onLang: (l: LangKey) => void; onNav: (id: string) => void;
  onAnchor: (seksi: string) => void; onTry: (ep: Ep) => void; prev?: Halaman; next?: Halaman; diperbarui: string;
}) {
  const ok = ep.respons.find((r) => r.kode.startsWith("2"))?.kode ?? ep.respons[0]?.kode ?? "200";
  const [kode, setKode] = useState(ok);
  const [vi, setVi] = useState(0);
  const varian = ep.body?.varian;
  const v = varian?.[Math.min(vi, varian.length - 1)];
  const bodyFields = v ? v.fields : ep.body?.fields ?? [];
  const bodyContoh = v ? v.contoh : ep.body?.contoh;
  const req = permintaanOf(ep, basis, {}, bodyContoh);
  const kodeSampel = { curl: sampel("curl", req), python: sampel("python", req), js: sampel("js", req) };
  const r: Respons | undefined = ep.respons.find((x) => x.kode === kode) ?? ep.respons[0];
  const per = (di: DocParam["in"]) => wajibDulu(ep.params.filter((p) => p.in === di));
  const kelompok: [string, string, DocParam[]][] = [["header", "Header", per("header")], ["path", "Parameter path", per("path")], ["query", "Parameter query", per("query")]];
  const admin = ep.otorisasi.some((a) => a.label.includes("admin"));
  const meta: ReactNode[] = [];
  if (ep.status) meta.push(<span key="s">{ep.status === "aktif" ? <span className="text-[#7cc4a0]">Aktif</span> : <span>Rencana · belum dibangun</span>}</span>);
  if (admin) meta.push(<span key="a">Khusus admin</span>);
  if (ep.scopes.length) meta.push(<span key="sc">Scope {ep.scopes.map((s) => <Kode key={s}>{s}</Kode>)}</span>);

  return (
    <div className="mx-auto grid w-full max-w-[1360px] gap-x-12 px-5 pb-10 pt-8 sm:px-8 lg:px-10 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] xl:pt-10">
      <article className="min-w-0 xl:col-start-1 xl:row-start-1">
        <KepalaHalaman kicker={kicker} judul={ep.nama} deskripsi={ep.ket ? <TeksKaya s={ep.ket} /> : undefined}
          md={() => markdownEndpoint(ep, basis, kicker)}
          meta={meta.length > 0 && meta.flatMap((m, i) => (i ? [<span key={`d${i}`} className="text-[#4f5966]">·</span>, m] : [m]))} />

        {/* the method bar */}
        <div className="mt-6 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/[.08] bg-[#111418] py-2 pl-3 pr-2">
          <MethodBadge m={ep.method} size="md" />
          <PathText path={ep.path} className="min-w-0 flex-1 text-[13px] leading-[20px] text-[#dfe3e8]" />
          <button type="button" onClick={() => onTry(ep)}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/[.14] bg-white/[.04] px-3 py-1.5 text-[12.5px] font-medium text-[#e8ebef] transition hover:border-[#9d8cff]/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9d8cff]/60">
            <Icon name="play" className="h-3 w-3 text-[#b9b0f0]" />Coba
          </button>
        </div>

        {ep.status === "rencana" && ep.hariIni && (
          <Callout ikon="info" judul="Pakai dulu hari ini">
            Endpoint ini masih rencana. Penggantinya yang sudah ada: <TeksKaya s={ep.hariIni.replace(/((?:GET|POST|PUT|PATCH|DELETE) \/[^\s,;)]+)/g, "`$1`")} />
          </Callout>
        )}

        {/* Otorisasi */}
        <H2 id="s-otorisasi" onAnchor={onAnchor}>Otorisasi</H2>
        <div>
          {ep.otorisasi.map((a, i) => (
            <div key={`${a.label}-${i}`}>
              {i > 0 && <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.12em] text-[#6f7a88]"><span className="h-px flex-1 bg-white/[.06]" />atau<span className="h-px flex-1 bg-white/[.06]" /></div>}
              <Medan f={{ name: a.nama, type: "string", required: true, description: `${a.label}${a.rencana ? " (rencana)" : ""}. ${a.ket}` }} lokasi="header" namaKelas="!border-t-0" />
            </div>
          ))}
        </div>

        {kelompok.filter(([, , ps]) => ps.length > 0).map(([id, judul, ps]) => (
          <section key={id}>
            <H2 id={`s-${id}`} onAnchor={onAnchor}>{judul}</H2>
            <div>{ps.map((p) => <Medan key={p.name} f={p} />)}</div>
          </section>
        ))}

        {ep.body && (
          <section>
            <H2 id="s-body" onAnchor={onAnchor} kanan={<span className="font-mono text-[12px] text-[#8a94a3]">{ep.body.contentType}</span>}>Body</H2>
            {varian && varian.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-[#8a94a3]">
                Skema
                <Tabs items={varian.map((x, i) => ({ key: String(i), label: x.nama }))} value={String(Math.min(vi, varian.length - 1))} onChange={(k) => setVi(Number(k))} label="Skema body" variant="pil" size="sm" />
              </div>
            )}
            {(v?.ket ?? ep.body.ket) && <p className="mt-3 text-[13.5px] leading-[1.65] text-[#a3acb9]"><TeksKaya s={(v?.ket ?? ep.body.ket)!} /></p>}
            {bodyFields.length > 0
              ? <div className={varian || ep.body.ket ? "mt-1" : ""}>{wajibDulu(bodyFields).map((f) => <Medan key={f.name} f={f} />)}</div>
              : <Kosong>Objek bebas: spesifikasi tidak merinci isiannya.</Kosong>}
          </section>
        )}

        <section>
          <H2 id="s-respons" onAnchor={onAnchor} kanan={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 overflow-x-auto [scrollbar-width:none]">
                <Tabs items={ep.respons.map((x) => ({ key: x.kode, label: x.kode, title: `${x.kode} ${STATUS_TEKS[x.kode] ?? ""}` }))} value={r?.kode ?? ""} onChange={setKode} label="Kode status respons" variant="pil" size="sm" />
              </span>
              <span className="hidden shrink-0 font-mono text-[12px] text-[#8a94a3] sm:inline">application/json</span>
            </span>
          }>Respons</H2>
          {r && (
            <>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-[13.5px] text-[#a3acb9]">
                <span className="font-mono text-[12.5px] font-semibold" style={{ color: warnaKode(r.kode) }}>{r.kode} {STATUS_TEKS[r.kode] ?? ""}</span>
                {r.ket && <span>· {r.ket}</span>}
                {r.tipe && r.tipe !== "—" && r.tipe !== "object" && <span className="font-mono text-[12px] text-[#8a94a3]">· {r.tipe}</span>}
              </p>
              {r.fields.length > 0
                ? <div className="mt-1">{wajibDulu(r.fields).map((f) => <Medan key={f.name} f={f} />)}</div>
                : <Kosong>{r.catatan ?? "Respons tanpa isian yang dideklarasikan."}</Kosong>}
            </>
          )}
        </section>
      </article>

      {/* the samples: sticky beside the content from 1280 px, under it below */}
      <aside className="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1" aria-label="Contoh permintaan dan respons">
        <div className="mt-12 space-y-4 xl:sticky xl:top-8 xl:mt-0">
          <PanelKode judul={ep.nama} kode={kodeSampel} lang={lang} onLang={onLang} maxH="max-h-[min(380px,38vh)]" kiri={<MethodBadge m={ep.method} />} />
          <PanelRespons ep={ep} kode={r?.kode ?? ok} onKode={setKode} />
        </div>
      </aside>

      <div className="min-w-0 xl:col-start-1 xl:row-start-2">
        <NavBawah prev={prev} next={next} onNav={onNav} diperbarui={diperbarui} />
      </div>
    </div>
  );
}
