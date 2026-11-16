"use client";

// API Documentation · the overview and guide pages (2026-11-15, "professional API docs gaya Runpod, OpenAI, Palantir"): plain
// prose like OpenAI's Introduction. A resource line, the title, one paragraph, "Salin halaman", a quiet callout, then sections
// with anchors (Sumber daya tersedia, URL dasar, Autentikasi, Contoh permintaan, Skema OpenAPI, ...) and "Di halaman ini" on
// the right, the section in view highlighted. One overview per tab (Ringkasan, Branch API v1, IoT, API Nasional) and three
// guides (Mulai cepat, Autentikasi, Galat & konvensi), all from the two specs. No coloured cards.

import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/Icon";
import type { ApiDocs, CabangDocs } from "./ApiDocsTypes";
import { STATUS_TEKS, TAB_LABEL, permintaanOf, sampel, warnaKode, type Basis, type Ep, type Halaman, type Model, type Resource, type TabKey } from "./ApiDocsModel";
import { AlurIot, SiklusAudit } from "./ApiDocsCabang";
import { KepalaHalaman, Medan, NavBawah, TeksKaya } from "./ApiDocsEndpoint";
import { BlokKode, Callout, H2, Kode, MethodBadge, PanelKode, type LangKey } from "./ApiDocsShared";

export type Seksi = { id: string; judul: string; isi: ReactNode; md: string };

export type Umum = {
  model: Model; cabang: CabangDocs | null; nasional: ApiDocs | null; basis: Basis; lang: LangKey; onLang: (l: LangKey) => void;
  onNav: (id: string) => void; onAnchor: (seksi: string) => void; prev?: Halaman; next?: Halaman; diperbarui: string;
  gulir: RefObject<HTMLDivElement | null>; nasionalGalat?: string | null; onMuatUlang?: () => void;
};

// ------------------------------------------------------------------------------------------------ the page frame

/** the section in view: the last one whose heading has passed the top of the scroll area */
function useSeksiAktif(kunci: string, gulir: RefObject<HTMLDivElement | null>) {
  const [aktif, setAktif] = useState("");
  useEffect(() => {
    const el = gulir.current;
    const ids = kunci.split("|");
    if (!el) return;
    const f = () => {
      const top = el.getBoundingClientRect().top;
      let cur = ids[0];
      for (const id of ids) {
        const s = document.getElementById(id);
        if (s && s.getBoundingClientRect().top - top <= 140) cur = id;
      }
      if (el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = ids[ids.length - 1];
      setAktif(cur);
    };
    const raf = requestAnimationFrame(f);
    el.addEventListener("scroll", f, { passive: true });
    return () => { cancelAnimationFrame(raf); el.removeEventListener("scroll", f); };
  }, [kunci, gulir]);
  return aktif;
}

const P = ({ children }: { children: ReactNode }) => <p className="mt-3 text-[14.5px] leading-[1.75] text-[#a3acb9]">{children}</p>;

/** facts under the title as one muted line: "v1.0.0 · OpenAPI 3.1 · 7 aktif" */
const Meta = ({ items }: { items: ReactNode[] }) => <>{items.filter(Boolean).flatMap((m, i) => (i ? [<span key={`d${i}`} className="text-[#4f5966]">·</span>, <span key={i}>{m}</span>] : [<span key={i}>{m}</span>]))}</>;

function HalamanDok({ u, kicker, judul, deskripsi, meta, callout, seksi, mdKepala }: {
  u: Umum; kicker: string; judul: string; deskripsi: ReactNode; meta?: ReactNode; callout?: ReactNode; seksi: Seksi[]; mdKepala: string;
}) {
  const aktif = useSeksiAktif(seksi.map((s) => s.id).join("|"), u.gulir);
  const md = () => [`_${kicker}_`, "", `# ${judul}`, "", mdKepala, ...seksi.flatMap((s) => ["", `## ${s.judul}`, "", s.md])].join("\n");
  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-x-14 px-5 pb-10 pt-8 sm:px-8 lg:px-10 xl:grid-cols-[minmax(0,1fr)_210px] xl:pt-10">
      <article className="min-w-0 max-w-[800px] xl:col-start-1 xl:row-start-1">
        <KepalaHalaman kicker={kicker} judul={judul} deskripsi={deskripsi} md={md} meta={meta} />
        {callout}
        {seksi.map((s) => (
          <section key={s.id}>
            <H2 id={s.id} onAnchor={u.onAnchor}>{s.judul}</H2>
            {s.isi}
          </section>
        ))}
      </article>
      <nav aria-label="Di halaman ini" className="hidden min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:block">
        <div className="sticky top-10">
          <p className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-white"><Icon name="list" className="h-3.5 w-3.5 text-[#8a94a3]" />Di halaman ini</p>
          <ul className="border-l border-white/[.08]">
            {seksi.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={(ev) => { ev.preventDefault(); u.onAnchor(s.id); }} aria-current={aktif === s.id ? "location" : undefined}
                  className={`-ml-px block border-l py-1.5 pl-3.5 text-[12.5px] leading-snug transition-colors ${aktif === s.id ? "border-[#9d8cff] font-medium text-[#c9bfff]" : "border-transparent text-[#8a94a3] hover:border-white/25 hover:text-[#dfe3e8]"}`}>
                  {s.judul}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="min-w-0 max-w-[800px] xl:col-start-1 xl:row-start-2">
        <NavBawah prev={u.prev} next={u.next} onNav={u.onNav} diperbarui={u.diperbarui} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ small pieces

function Tautan({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-semibold text-white underline decoration-white/25 underline-offset-[5px] transition hover:text-[#c9bfff] hover:decoration-[#9d8cff]">
      {children}
    </button>
  );
}

function Butir({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[14.5px] leading-[1.7] text-[#a3acb9]">
      <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#9d8cff]/70" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function DaftarResource({ resources, onNav }: { resources: Resource[]; onNav: (id: string) => void }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {resources.map((r) => (
        <Butir key={r.key}>
          <Tautan onClick={() => onNav(r.eps[0].id)}>{r.nama}</Tautan>: {r.ket} <span className="whitespace-nowrap text-[#6f7a88]">· {r.eps.length} endpoint</span>
        </Butir>
      ))}
    </ul>
  );
}
const mdResource = (rs: Resource[]) => rs.map((r) => `- **${r.nama}**: ${r.ket} (${r.eps.length} endpoint)`).join("\n");

/** an endpoint as a row: badge, name, path; opens its page */
function BarisEp({ ep, onNav }: { ep: Ep; onNav: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onNav(ep.id)}
      className="group flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[.06] py-2.5 text-left first:border-t-0">
      <MethodBadge m={ep.method} />
      <span className="text-[13.5px] font-medium text-[#e8ebef] underline decoration-transparent underline-offset-[5px] group-hover:text-white group-hover:decoration-[#9d8cff]">{ep.nama}</span>
      <span className="min-w-0 break-all font-mono text-[12px] text-[#8a94a3]">{ep.path}</span>
      {ep.status === "rencana" && <span className="ml-auto text-[12px] text-[#6f7a88]">rencana</span>}
    </button>
  );
}

/** one way to authenticate as a parameter row plus its header line */
function AuthBlok({ nama, lokasi, label, ket, status, contoh }: { nama: string; lokasi: string; label: string; ket: string; status?: "aktif" | "rencana"; contoh: string }) {
  return (
    <div className="border-t border-white/[.06] first:border-t-0">
      <Medan f={{ name: nama, type: "string", required: true, description: `${label}${status === "rencana" ? " (rencana)" : ""}. ${ket}` }} lokasi={lokasi} namaKelas="!border-t-0 !pb-2" />
      <p className="flex flex-wrap items-center gap-2 pb-4 text-[12.5px] text-[#8a94a3]">
        Contoh <Kode>{contoh}</Kode>{status && <span className={status === "aktif" ? "text-[#7cc4a0]" : ""}>· {status}</span>}
      </p>
    </div>
  );
}

/** an endpoint's request in the three languages and its success example below it */
function ContohPermintaan({ ep, u, teks }: { ep: Ep; u: Umum; teks: ReactNode }) {
  const req = permintaanOf(ep, u.basis);
  const ok = ep.respons.find((r) => r.kode.startsWith("2"));
  return (
    <>
      <P>{teks}</P>
      <div className="mt-4 space-y-3">
        <PanelKode judul={ep.nama} kiri={<MethodBadge m={ep.method} />} lang={u.lang} onLang={u.onLang} maxH="max-h-[300px]"
          kode={{ curl: sampel("curl", req), python: sampel("python", req), js: sampel("js", req) }} />
        {ok?.contoh !== undefined && (
          <div className="overflow-hidden rounded-lg border border-white/[.08] bg-[#111418]">
            <div className="border-b border-white/[.06] px-4 py-2 text-[12.5px] text-[#e8ebef]">Respons <span className="ml-1 font-mono text-[12px]" style={{ color: warnaKode(ok.kode) }}>{ok.kode} {STATUS_TEKS[ok.kode] ?? ""}</span></div>
            <BlokKode code={JSON.stringify(ok.contoh, null, 2)} lang="json" maxH="max-h-[280px]" />
          </div>
        )}
      </div>
      <p className="mt-4 text-[14px]"><Tautan onClick={() => u.onNav(ep.id)}>Referensi lengkap: {ep.nama} →</Tautan></p>
    </>
  );
}
const mdContoh = (ep: Ep, u: Umum) => ["```bash", sampel("curl", permintaanOf(ep, u.basis)), "```"].join("\n");

function unduhOpenApi(basis: Basis, nasional: boolean, cabang: boolean): Record<LangKey, string> {
  const c = `${basis.ui}/api/api-docs/cabang?format=openapi`;
  const n = `${basis.api}/openapi.json`;
  const curl: string[] = [];
  const py: string[] = ["import requests"];
  const js: string[] = [];
  if (cabang) {
    py.unshift("import os");
    curl.push("# Branch API v1 + IoT (rancangan; perlu login)", `curl --request GET \\\n  --url "${c}" \\\n  --header "Authorization: Bearer $BLUESANDAI_TOKEN" \\\n  --output openapi_cabang_v1.json`);
    py.push("", "# Branch API v1 + IoT (rancangan; perlu login)", `url = ${JSON.stringify(c)}`, `headers = {"Authorization": f"Bearer {os.environ['BLUESANDAI_TOKEN']}"}`,
      "spec = requests.get(url, headers=headers).json()", "print(spec[\"info\"][\"title\"], len(spec[\"paths\"]))");
    js.push("// Branch API v1 + IoT (rancangan; perlu login)", `const res = await fetch('${c}', {\n  headers: { Authorization: \`Bearer \${process.env.BLUESANDAI_TOKEN}\` }\n});`,
      "const spec = await res.json();", "console.log(spec.info.title, Object.keys(spec.paths).length);");
  }
  if (nasional) {
    if (curl.length) { curl.push(""); js.push(""); }
    curl.push("# API Nasional (dari API yang berjalan)", `curl --request GET \\\n  --url ${n} \\\n  --output openapi.json`);
    py.push("", "# API Nasional (dari API yang berjalan)", `nasional = requests.get(${JSON.stringify(n)}).json()`, "print(len(nasional[\"paths\"]))");
    js.push("// API Nasional (dari API yang berjalan)", `const nasional = await (await fetch('${n}')).json();`, "console.log(Object.keys(nasional.paths).length);");
  }
  return { curl: curl.join("\n"), python: py.join("\n"), js: js.join("\n") };
}

const kalimat = (s: string, n = 1) => (s.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [s]).slice(0, n).join("").trim();
const tanpaStatus = (s: string) => s.replace(/^(AKTIF|RENCANA)\.\s*/, "");

// ------------------------------------------------------------------------------------------------ Ringkasan (general)

function seksiOpenApi({ u, nasional, cabang }: { u: Umum; nasional: boolean; cabang: boolean }): Seksi {
  const kode = unduhOpenApi(u.basis, nasional, cabang);
  return {
    id: "s-openapi", judul: "Skema OpenAPI",
    md: ["Skema lengkap dalam OpenAPI 3.1, untuk generator klien atau koleksi Postman.", "", "```bash", kode.curl, "```"].join("\n"),
    isi: (
      <>
        <P>Skema lengkap dalam format OpenAPI, untuk membuat klien otomatis atau mengimpor ke alat uji API.{cabang && " Spesifikasi Branch API v1 dan IoT adalah satu berkas rancangan; API Nasional dibaca dari API yang sedang berjalan."}</P>
        <div className="mt-4"><PanelKode judul="Unduh skema OpenAPI" kode={kode} lang={u.lang} onLang={u.onLang} maxH="max-h-[320px]" /></div>
        {cabang && (
          <a href="/api/api-docs/cabang?format=openapi" download
            className="mt-4 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[#c9bfff] underline decoration-[#9d8cff]/40 underline-offset-[5px] hover:text-white">
            <Icon name="download" className="h-3.5 w-3.5" />Unduh openapi_cabang_v1.json
          </a>
        )}
      </>
    ),
  };
}

export function RingkasanUmum({ u }: { u: Umum }) {
  const { model, cabang, nasional } = u;
  const n = (t: TabKey) => model.resources.filter((r) => r.tab === t).reduce((s, r) => s + r.eps.length, 0);
  const daftar: { tab: TabKey; ket: string }[] = [
    { tab: "cabang", ket: "audit modular per Kantor Cabang: kirim klaim, skoring ML v7, indikasi, AI Agent Swarm, Box Karantina, laporan dan putusan" },
    { tab: "iot", ket: "binding alat ↔ pasien ↔ kunjungan, bacaan bertanda tangan, jangkar Merkle, tagihan dibanding pemakaian alat" },
    { tab: "nasional", ket: "integrasi faskes, engine realtime, rule engine, AI Agent Swarm, skor dan ML dari API yang berjalan" },
  ];
  const total = n("cabang") + n("iot") + n("nasional");
  const contohUmum = model.byKunci.get("GET /api/aip/cabang/v1/audit/{audit_id}/status");
  const seksi: Seksi[] = [
    {
      id: "s-sumber", judul: "Sumber daya tersedia", md: daftar.map((d) => `- **${TAB_LABEL[d.tab]}**: ${d.ket} (${n(d.tab)} endpoint)`).join("\n"),
      isi: (
        <ul className="mt-4 space-y-2.5">
          {daftar.map((d) => (
            <Butir key={d.tab}>
              <Tautan onClick={() => u.onNav(d.tab)}>{TAB_LABEL[d.tab]}</Tautan>: {d.ket}{" "}
              <span className="whitespace-nowrap text-[#6f7a88]">· {n(d.tab) ? `${n(d.tab)} endpoint` : "belum termuat"}</span>
            </Butir>
          ))}
        </ul>
      ),
    },
    {
      id: "s-url", judul: "URL dasar", md: `- API: \`${u.basis.api}\`\n- Aplikasi web: \`${u.basis.ui}\` (/api/swarm-cabang, /api/faskes-verify, /api/iomt-audit)`,
      isi: (
        <>
          <P>Semua endpoint menerima dan mengembalikan JSON. Sebagian kecil endpoint yang sudah aktif dilayani aplikasi web, bukan API.</P>
          <div className="mt-4 divide-y divide-white/[.06] rounded-lg border border-white/[.08]">
            {([["API", u.basis.api, "/api/aip/…"], ["Aplikasi web", u.basis.ui, "/api/swarm-cabang · /api/faskes-verify · /api/iomt-audit"]] as const).map(([k, v, cak]) => (
              <div key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <span className="w-28 shrink-0 text-[13px] font-medium text-white">{k}</span>
                <span className="min-w-0 break-all font-mono text-[13px] text-[#c9bfff]">{v}</span>
                <span className="min-w-0 font-mono text-[11.5px] text-[#6f7a88] sm:ml-auto">{cak}</span>
              </div>
            ))}
          </div>
        </>
      ),
    },
    {
      id: "s-auth", judul: "Autentikasi",
      md: "Setiap permintaan membawa token di header: kunci API KC, token pribadi, kunci gateway RS, atau token faskes.",
      isi: (
        <>
          <P>Setiap permintaan membawa token di header. Jenisnya bergantung pada siapa yang memanggil:</P>
          <ul className="mt-4 space-y-2.5">
            <Butir><span className="font-semibold text-white">Kantor Cabang</span>: kunci API KC (rencana) sebagai <Kode>Authorization: Bearer $KUNCI_KC</Kode></Butir>
            <Butir><span className="font-semibold text-white">Pengguna</span>: token pribadi sebagai <Kode>Authorization: Bearer $BLUESANDAI_TOKEN</Kode>, atau sesi login</Butir>
            <Butir><span className="font-semibold text-white">Gateway rumah sakit</span>: kunci gateway RS (rencana) untuk data IoT</Butir>
            <Butir><span className="font-semibold text-white">SIMRS</span>: token faskes di header <Kode>X-Ingest-Token</Kode></Butir>
          </ul>
          {cabang && <p className="mt-4 text-[14px]"><Tautan onClick={() => u.onNav("ringkasan/autentikasi")}>Selengkapnya di Autentikasi →</Tautan></p>}
        </>
      ),
    },
    ...(contohUmum ? [{
      id: "s-contoh", judul: "Contoh permintaan", md: mdContoh(contohUmum, u),
      isi: <ContohPermintaan ep={contohUmum} u={u} teks={<>Permintaan pertama yang umum: status audit KC. Ganti <Kode>gen3_kc2</Kode> dengan id audit Anda dan isi token dari variabel lingkungan.</>} />,
    }] : []),
    seksiOpenApi({ u, nasional: Boolean(nasional), cabang: Boolean(cabang) }),
  ];
  return (
    <HalamanDok u={u} kicker="Dokumentasi API" judul="Ringkasan"
      deskripsi="API untuk audit klaim JKN. Kantor Cabang menjalankan audit AI Agent Swarm lewat Branch API v1, rumah sakit mengirim bukti pemakaian alat lewat IoT, dan sistem nasional (SIMRS, engine realtime, rule engine, ML) terhubung lewat API Nasional."
      mdKepala="API untuk audit klaim JKN: Branch API v1, IoT, dan API Nasional."
      meta={<Meta items={[`${total} endpoint`, "JSON", "token Bearer di header", cabang ? `${cabang.jumlah.aktif} endpoint Branch API dan IoT sudah aktif` : null]} />}
      callout={<Callout ikon="info" judul="Data sintetis">Semua contoh di dokumentasi ini diambil dari data sintetis (run <Kode>gen3_kc2</Kode>, KC Makassar <Kode>sul-7371</Kode>), bukan data peserta asli.</Callout>}
      seksi={seksi} />
  );
}

// ------------------------------------------------------------------------------------------------ guides

export function PanduanMulai({ u }: { u: Umum }) {
  const langkah = u.cabang?.mulaiCepat ?? [];
  const seksi: Seksi[] = langkah.map((l, i) => {
    const eps = l.endpoint.map((k) => u.model.byKunci.get(k)).filter((e): e is Ep => Boolean(e));
    const utama = eps[0];
    const req = utama ? permintaanOf(utama, u.basis) : null;
    return {
      id: `s-langkah-${i + 1}`, judul: `${i + 1}. ${l.judul}`,
      md: [l.teks, ...eps.map((e) => `- \`${e.method} ${e.path}\`: ${e.nama}`), l.hariIni ? `\nHari ini: ${l.hariIni}` : ""].join("\n"),
      isi: (
        <>
          <P>{l.teks}</P>
          <div className="mt-3">{eps.map((e) => <BarisEp key={e.id} ep={e} onNav={u.onNav} />)}</div>
          {l.hariIni && <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-[#8a94a3]">Hari ini <Kode>{l.hariIni}</Kode></p>}
          {utama && req && (
            <div className="mt-4">
              <PanelKode judul={utama.nama} kiri={<MethodBadge m={utama.method} />} lang={u.lang} onLang={u.onLang} maxH="max-h-[280px]"
                kode={{ curl: sampel("curl", req), python: sampel("python", req), js: sampel("js", req) }} />
            </div>
          )}
        </>
      ),
    };
  });
  return (
    <HalamanDok u={u} kicker="Dokumentasi API" judul="Mulai cepat"
      deskripsi="Tiga langkah dari kunci API sampai laporan KC. Setiap langkah menunjuk endpoint-nya; yang masih rencana punya pengganti yang sudah bisa dipakai hari ini."
      mdKepala="Tiga langkah dari kunci API sampai laporan KC."
      callout={<Callout ikon="info">Contoh memakai kunci KC dari variabel lingkungan <Kode>KUNCI_KC</Kode>. Sebelum kunci KC tersedia, pakai token pribadi (<Kode>BLUESANDAI_TOKEN</Kode>).</Callout>}
      seksi={seksi} />
  );
}

export function PanduanAuth({ u }: { u: Umum }) {
  const ks = u.cabang?.keamanan ?? [];
  const JUDUL: Record<string, string> = { kunciKC: "Kunci API KC", tokenPribadi: "Token pribadi", sesi: "Sesi login browser", kunciGateway: "Kunci gateway RS", tokenFaskes: "Token faskes" };
  const CONTOH: Record<string, string> = {
    kunciKC: "Authorization: Bearer $KUNCI_KC", tokenPribadi: "Authorization: Bearer $BLUESANDAI_TOKEN", sesi: "Cookie: BSAI_SESSION=…",
    kunciGateway: "Authorization: Bearer $KUNCI_GATEWAY", tokenFaskes: "X-Ingest-Token: $TOKEN_FASKES",
  };
  // the scopes of the KC key, from the endpoints that ask for them
  const scope = useMemo(() => {
    const m = new Map<string, Ep[]>();
    for (const r of u.model.resources) for (const e of r.eps) for (const s of e.scopes) m.set(s, [...(m.get(s) ?? []), e]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [u.model]);
  const saya = u.model.byKunci.get("GET /api/aip/cabang/v1/saya");
  const req = saya ? permintaanOf(saya, u.basis) : null;
  const seksi: Seksi[] = ks.map((k) => {
    const status = /^AKTIF/.test(k.ket) ? "aktif" as const : /^RENCANA/.test(k.ket) ? "rencana" as const : undefined;
    const lokasi = k.di === "cookie" ? "cookie" : "header";
    return {
      id: `s-${k.kunci.toLowerCase()}`, judul: JUDUL[k.kunci] ?? k.kunci,
      md: `- \`${k.nama}\` (${lokasi}${k.format ? `, ${k.format}` : ""}): ${tanpaStatus(k.ket)}`,
      isi: <div className="mt-1"><AuthBlok nama={k.nama} lokasi={lokasi} label={k.format ? `Format ${k.format}` : JUDUL[k.kunci] ?? k.kunci} ket={tanpaStatus(k.ket)} status={status} contoh={CONTOH[k.kunci] ?? `${k.nama}: …`} /></div>,
    };
  });
  if (scope.length) seksi.push({
    id: "s-scope", judul: "Scope kunci",
    md: scope.map(([s, eps]) => `- \`${s}\`: ${eps.length} endpoint`).join("\n"),
    isi: (
      <>
        <P>Setiap kunci KC atau gateway membawa scope. Endpoint menyebut scope yang dibutuhkannya; tanpa scope itu jawabannya 403.</P>
        <div className="mt-4 divide-y divide-white/[.06] rounded-lg border border-white/[.08]">
          {scope.map(([s, eps]) => (
            <div key={s} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
              <span className="w-36 shrink-0 font-mono text-[13px] font-semibold text-[#c9bfff]">{s}</span>
              <span className="min-w-0 flex-1 text-[13px] text-[#a3acb9]">{eps.slice(0, 3).map((e) => e.nama).join(" · ")}{eps.length > 3 ? ` · +${eps.length - 3}` : ""}</span>
              <span className="text-[12px] text-[#6f7a88]">{eps.length} endpoint</span>
            </div>
          ))}
        </div>
      </>
    ),
  });
  if (saya && req) seksi.push({
    id: "s-contoh", judul: "Contoh permintaan", md: ["```bash", sampel("curl", req), "```"].join("\n"),
    isi: (
      <>
        <P>Periksa kunci yang dipakai: endpoint <Kode>{saya.path}</Kode> menjawab KC, scope dan batas kunci itu.</P>
        <div className="mt-4"><PanelKode judul={saya.nama} kiri={<MethodBadge m={saya.method} />} lang={u.lang} onLang={u.onLang}
          kode={{ curl: sampel("curl", req), python: sampel("python", req), js: sampel("js", req) }} /></div>
      </>
    ),
  });
  return (
    <HalamanDok u={u} kicker="Dokumentasi API" judul="Autentikasi"
      deskripsi="Semua endpoint dibuka dengan token di header. Pilih jenisnya menurut pemanggil: Kantor Cabang, pengguna, gateway rumah sakit, atau SIMRS. Token tidak pernah ditaruh di URL."
      mdKepala="Semua endpoint dibuka dengan token di header."
      callout={<Callout ikon="lock" judul="Simpan kunci di server">Kunci KC dan kunci gateway hanya untuk server ke server. Jangan taruh di aplikasi browser atau di repositori kode; kunci yang bocor dicabut lewat <Kode>DELETE /kunci/{"{kunci_id}"}</Kode>.</Callout>}
      seksi={seksi} />
  );
}

export function PanduanKonvensi({ u }: { u: Umum }) {
  const kv = u.cabang?.konvensi ?? {};
  const eps = u.model.resources.filter((r) => r.tab !== "nasional").flatMap((r) => r.eps);
  const kode = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of eps) for (const r of e.respons) if (!r.kode.startsWith("2") && !m.has(r.kode)) m.set(r.kode, r.ket);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [eps]);
  const galat = eps.flatMap((e) => e.respons).find((r) => r.kode === "401" && r.contoh !== undefined);
  const galatFields = eps.flatMap((e) => e.respons).find((r) => !r.kode.startsWith("2") && r.fields.length > 0)?.fields ?? [];
  const butir = (s: string) => s.split(/;\s+/).filter(Boolean);
  const Daftar = ({ s }: { s: string }) => <ul className="mt-4 space-y-2">{butir(s).map((b) => <Butir key={b}><TeksKaya s={b} /></Butir>)}</ul>;
  const lain: [string, string, string][] = [
    ["s-versi", "Versi", kv.versi], ["s-halaman", "Halaman", kv.halaman], ["s-idempotensi", "Idempotensi", kv.idempotensi],
    ["s-batas", "Batas laju", kv.batas_laju], ["s-biaya", "Biaya", kv.biaya], ["s-iot", "Data IoT", kv.iot],
  ];
  const seksi: Seksi[] = [
    {
      id: "s-galat", judul: "Format galat", md: kv.galat ?? "",
      isi: (
        <>
          <P>Semua galat v1 berbentuk sama: pesan untuk manusia di <Kode>detail</Kode> dan kode mesin yang stabil di <Kode>code</Kode>. Kode inilah yang dipakai klien untuk bercabang, bukan teks pesannya.</P>
          {galatFields.length > 0 && <div className="mt-2">{galatFields.map((f) => <Medan key={f.name} f={f} />)}</div>}
          {galat && (
            <div className="mt-4 overflow-hidden rounded-lg border border-white/[.08] bg-[#111418]">
              <div className="border-b border-white/[.06] px-4 py-2.5 font-mono text-[12px]" style={{ color: warnaKode("401") }}>401 {STATUS_TEKS["401"]}</div>
              <BlokKode code={JSON.stringify(galat.contoh, null, 2)} lang="json" />
            </div>
          )}
        </>
      ),
    },
    {
      id: "s-kode", judul: "Kode status", md: kode.map(([k, ket]) => `- ${k} ${STATUS_TEKS[k] ?? ""}: ${ket}`).join("\n"),
      isi: (
        <div className="mt-4 divide-y divide-white/[.06] rounded-lg border border-white/[.08]">
          {kode.map(([k, ket]) => (
            <div key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="w-12 shrink-0 font-mono text-[13px] font-semibold" style={{ color: warnaKode(k) }}>{k}</span>
              <span className="w-44 shrink-0 text-[13px] text-white">{STATUS_TEKS[k] ?? ""}</span>
              <span className="min-w-0 flex-1 font-mono text-[12px] text-[#a3acb9]">{ket}</span>
            </div>
          ))}
        </div>
      ),
    },
    ...lain.filter(([, , s]) => Boolean(s)).map(([id, judul, s]): Seksi => ({ id, judul, md: butir(s).map((b) => `- ${b}`).join("\n"), isi: <Daftar s={s} /> })),
  ];
  return (
    <HalamanDok u={u} kicker="Dokumentasi API" judul="Galat & konvensi"
      deskripsi="Aturan yang sama untuk semua endpoint v1: format galat, versi, halaman, idempotensi, batas laju, biaya dan data IoT."
      mdKepala="Aturan yang sama untuk semua endpoint v1." seksi={seksi} />
  );
}

// ------------------------------------------------------------------------------------------------ the API overviews

function seksiAuth(u: Umum, kunci: string[], pengantar: string): Seksi {
  const contoh: Record<string, [string, string, string, string, "aktif" | "rencana"]> = {
    kc: ["Authorization", "header", "Kunci API KC", "Satu kunci per Kantor Cabang, hanya untuk data KC itu; scope cabang:*.", "rencana"],
    pribadi: ["Authorization", "header", "Token pribadi", "Token API pribadi pengguna (bsai_pat_…), atau sesi login browser.", "aktif"],
    admin: ["Authorization", "header", "Token pribadi (admin)", "Untuk endpoint admin: token pengguna dengan role admin; selain admin dijawab 403.", "aktif"],
    gateway: ["Authorization", "header", "Kunci gateway RS", "Satu kunci per gateway AIoT rumah sakit; scope iot:alat, iot:sesi, iot:kirim; tidak pernah membaca hasil cek.", "rencana"],
    faskes: ["X-Ingest-Token", "header", "Token faskes", "Token ingest yang dibuat admin, dipakai SIMRS rumah sakit untuk mengirim klaim.", "aktif"],
  };
  const baris: Record<string, string> = { kc: "Bearer $KUNCI_KC", pribadi: "Bearer $BLUESANDAI_TOKEN", admin: "Bearer $BLUESANDAI_TOKEN", gateway: "Bearer $KUNCI_GATEWAY", faskes: "$TOKEN_FASKES" };
  return {
    id: "s-auth", judul: "Autentikasi",
    md: [pengantar, ...kunci.map((k) => `- ${contoh[k][2]}: \`${contoh[k][0]}: ${baris[k]}\` — ${contoh[k][3]}`)].join("\n"),
    isi: (
      <>
        <P>{pengantar}</P>
        <div className="mt-2">{kunci.map((k) => <AuthBlok key={k} nama={contoh[k][0]} lokasi={contoh[k][1]} label={contoh[k][2]} ket={contoh[k][3]} status={contoh[k][4]} contoh={`${contoh[k][0]}: ${baris[k]}`} />)}</div>
        {u.cabang && <p className="mt-4 text-[14px]"><Tautan onClick={() => u.onNav("ringkasan/autentikasi")}>Selengkapnya di Autentikasi →</Tautan></p>}
      </>
    ),
  };
}

export function RingkasanCabang({ u }: { u: Umum }) {
  const c = u.cabang;
  if (!c) return null;
  const rs = u.model.resources.filter((r) => r.tab === "cabang");
  const buat = u.model.byKunci.get("POST /api/aip/cabang/v1/audit");
  // this tab's own endpoints (the spec's totals include the IoT stage, which has its own tab)
  const semuaEp = rs.flatMap((r) => r.eps);
  const nAktif = semuaEp.filter((e) => e.status === "aktif").length;
  const nRencana = semuaEp.length - nAktif;
  const seksi: Seksi[] = [
    {
      id: "s-siklus", judul: "Siklus audit", md: "Orkestrator audit menjalankan tahap demi tahap: KC → kirim klaim → skoring ML v7 → indikasi → Box Karantina → AI Agent Swarm → laporan KC → putusan verifikator.",
      isi: (
        <>
          <P>Panggil hanya tahap yang dibutuhkan: output satu tahap adalah input tahap berikutnya, dengan id klaim yang sama di setiap tahap.</P>
          <SiklusAudit resources={rs} onNav={u.onNav} />
        </>
      ),
    },
    { id: "s-sumber", judul: "Sumber daya tersedia", md: mdResource(rs), isi: <DaftarResource resources={rs} onNav={u.onNav} /> },
    {
      id: "s-status", judul: "Aktif dan rencana", md: `${nAktif} endpoint aktif, ${nRencana} rencana.`,
      isi: (
        <>
          <P>Ini rancangan yang sebagian sudah berjalan: {nAktif} endpoint aktif dan {nRencana} rencana. Integrasi bisa dimulai sekarang lewat pengganti yang sudah ada.</P>
          <ul className="mt-3 space-y-1.5 text-[14px] leading-[1.65] text-[#a3acb9]">
            <li><span className="font-medium text-[#7cc4a0]">Aktif</span>: sudah ada dan bisa dipanggil hari ini.</li>
            <li><span className="font-medium text-[#eef0f3]">Rencana</span>: dirancang, belum dibangun; halamannya menunjuk pengganti yang sudah ada.</li>
          </ul>
        </>
      ),
    },
    {
      id: "s-url", judul: "URL dasar", md: `\`${u.basis.api}${c.basis}\``,
      isi: (
        <>
          <P>Semua endpoint v1 berada di bawah satu awalan. Perubahan yang menambah tetap di v1; perubahan yang memutus menjadi v2.</P>
          <div className="mt-4 flex min-w-0 items-center gap-3 rounded-lg border border-white/[.08] bg-[#111418] px-4 py-3">
            <Icon name="globe" className="h-4 w-4 shrink-0 text-[#8a94a3]" />
            <span className="min-w-0 break-all font-mono text-[13px] text-[#dfe3e8]">{u.basis.api}<span className="text-[#c9bfff]">{c.basis}</span></span>
          </div>
        </>
      ),
    },
    seksiAuth(u, ["kc", "pribadi"], "Kantor Cabang memanggil dengan kunci API KC-nya. Sampai kunci KC tersedia, token pribadi pengguna membuka endpoint yang sama."),
    ...(buat ? [{
      id: "s-contoh", judul: "Contoh permintaan", md: mdContoh(buat, u),
      isi: <ContohPermintaan ep={buat} u={u} teks={<>Buat audit dari unggahan klaim. Audit belum berjalan sampai <Kode>/mulai</Kode>; balasannya memuat estimasi biaya.</>} />,
    }] : []),
    seksiOpenApi({ u, nasional: false, cabang: true }),
  ];
  return (
    <HalamanDok u={u} kicker="Branch API v1" judul={c.judul || "AI Agent Swarm Branch API"}
      deskripsi={kalimat(c.deskripsi, 2) || c.ringkas}
      mdKepala={kalimat(c.deskripsi, 2) || c.ringkas}
      meta={<Meta items={[`v${c.versi}`, `OpenAPI ${c.openapi}`, `${semuaEp.length} endpoint`, `${nAktif} aktif`, `${nRencana} rencana`]} />}
      callout={<Callout ikon="info" judul="Data sintetis">Contoh di halaman ini diambil dari data sintetis run <Kode>gen3_kc2</Kode>, KC Makassar (<Kode>sul-7371</Kode>). Model AI dipakai hanya di tahap AI Agent Swarm dan narasi laporan, di bawah batas biaya per audit.</Callout>}
      seksi={seksi} />
  );
}

export function RingkasanIot({ u }: { u: Umum }) {
  const c = u.cabang;
  if (!c) return null;
  const rs = u.model.resources.filter((r) => r.tab === "iot");
  const eps = rs.flatMap((r) => r.eps);
  const nAktif = eps.filter((e) => e.status === "aktif").length;
  const sesi = u.model.byKunci.get("POST /api/aip/cabang/v1/iot/sesi");
  const cek = u.model.byKunci.get("POST /api/aip/cabang/v1/iot/cek");
  const nas = (k: string) => u.model.halaman.find((h) => h.jenis === "endpoint" && h.tab === "nasional" && h.ep.kunci === k);
  const skema = nas("GET /api/aip/realtime/v1/iot/skema");
  const validasi = nas("POST /api/aip/realtime/v1/faskes/iot/validasi");
  const seksi: Seksi[] = [
    {
      id: "s-alur", judul: "Alur & binding", md: "Alat medis → gateway RS (AIoT) → Branch API · IoT → Indikasi. Binding: alat ↔ sesi ↔ pasien · kunjungan ↔ klaim.",
      isi: (
        <>
          <P>Gateway rumah sakit mengikat setiap alat ke satu pasien dan satu kunjungan, lalu mengirim bacaan yang ditandatangani alat. Pemakaian terukur dibanding yang ditagih.</P>
          <AlurIot onSesi={sesi ? () => u.onNav(sesi.id) : undefined} onCek={cek ? () => u.onNav(cek.id) : undefined} />
        </>
      ),
    },
    { id: "s-sumber", judul: "Sumber daya tersedia", md: mdResource(rs), isi: <DaftarResource resources={rs} onNav={u.onNav} /> },
    seksiAuth(u, ["gateway", "kc"], "Gateway rumah sakit menulis data IoT dengan kunci gateway-nya; Kantor Cabang membaca hasil cek dengan kunci KC. Keduanya terpisah: gateway tidak pernah membaca hasil cek."),
    {
      id: "s-kontrak", judul: "Kontrak bukti alat", md: "GET /api/aip/realtime/v1/iot/skema · POST /api/aip/realtime/v1/faskes/iot/validasi",
      isi: (
        <>
          <P>Kontrak payload alat (jenis dan mode alat, ambang, daun Merkle, sinyal <Kode>IOT_*</Kode>) sudah aktif di API Nasional; rumah sakit dapat memvalidasi payload sebelum mengirim klaim.</P>
          <div className="mt-3">
            {[skema, validasi].map((h) => h && h.jenis === "endpoint" ? <BarisEp key={h.id} ep={h.ep} onNav={u.onNav} /> : null)}
            {!skema && !validasi && <p className="text-[13px] text-[#8a94a3]"><Kode>GET /api/aip/realtime/v1/iot/skema</Kode> · <Kode>POST /api/aip/realtime/v1/faskes/iot/validasi</Kode></p>}
          </div>
        </>
      ),
    },
    ...(sesi ? [{
      id: "s-contoh", judul: "Contoh permintaan", md: mdContoh(sesi, u),
      isi: <ContohPermintaan ep={sesi} u={u} teks="Gateway membuka binding saat alat dipasang ke pasien. Pasien dikirim sebagai token HMAC, bukan identitas asli." />,
    }] : []),
    seksiOpenApi({ u, nasional: false, cabang: true }),
  ];
  return (
    <HalamanDok u={u} kicker="IoT" judul="IoT alat medis"
      deskripsi="Jalur masuk kedua untuk audit: pemakaian alat medis yang terukur dibanding yang ditagih. Gateway AIoT rumah sakit mengikat alat ke pasien dan kunjungan, mengirim bacaan bertanda tangan, dan menjangkarkan episode ke akar Merkle."
      mdKepala="Pemakaian alat medis yang terukur dibanding yang ditagih."
      meta={<Meta items={[`${eps.length} endpoint`, `${nAktif} aktif`, `${eps.length - nAktif} rencana`]} />}
      callout={<Callout ikon="lock" judul="Tanpa tanda vital">{c.konvensi.iot ? <TeksKaya s={`${c.konvensi.iot.charAt(0).toUpperCase()}${c.konvensi.iot.slice(1)}.`} /> : "Bacaan hanya pola daya alat; identitas pasien hanya sebagai token."}</Callout>}
      seksi={seksi} />
  );
}

export function RingkasanNasional({ u }: { u: Umum }) {
  const d = u.nasional;
  const rs = u.model.resources.filter((r) => r.tab === "nasional");
  const n = rs.reduce((s, r) => s + r.eps.length, 0);
  if (!d) {
    return (
      <HalamanDok u={u} kicker="API Nasional" judul="API audit nasional" deskripsi="Endpoint JKN dari API yang sedang berjalan, dibaca langsung dari spesifikasi OpenAPI-nya." mdKepala=""
        callout={(
          <Callout ikon="alert" judul="Spesifikasi belum terbaca">
            {u.nasionalGalat ?? "Memuat spesifikasi dari API…"}
            {u.onMuatUlang && u.nasionalGalat && <button type="button" onClick={u.onMuatUlang} className="ml-2 font-medium text-[#c9bfff] underline underline-offset-4">Coba lagi</button>}
          </Callout>
        )} seksi={[]} />
    );
  }
  const alur: [string, string, string, string][] = [
    ["1", "Integrasi faskes", "SIMRS mengirim klaim dengan header X-Ingest-Token dan mendapat tanda terima; skor dan keputusan tetap di BPJS.", "faskes"],
    ["2", "Engine realtime", "Rule engine dan model ML menilai setiap klaim yang masuk.", "engine"],
    ["3", "Kasus & peristiwa", "Keputusan LOLOS / PERIKSA / TAHAN; klaim yang ditahan menjadi kasus untuk auditor.", "kasus"],
    ["4", "Rule engine", "Aturan baru diuji pada klaim yang ada, diajukan, lalu disetujui admin sebelum aktif.", "aturan"],
  ];
  const kirim = rs.find((r) => r.key === "faskes")?.eps.find((e) => e.kunci === "POST /api/aip/realtime/v1/faskes/klaim");
  const seksi: Seksi[] = [
    {
      id: "s-alur", judul: "Alur integrasi", md: "Faskes (SIMRS) → realtime engine (rule engine + ML) → keputusan LOLOS / PERIKSA / TAHAN → auditor.",
      isi: (
        <>
          <P>SIMRS rumah sakit mengirim klaim dengan token faskes. Engine realtime menilainya dengan rule engine dan model ML, lalu memutus LOLOS, PERIKSA atau TAHAN. Klaim yang ditahan menjadi kasus yang ditangani auditor; auditor dan Model AI menulis aturan baru untuk rule engine.</P>
          <ol className="mt-4">
            {alur.map(([no, judul, ket, key]) => {
              const r = rs.find((x) => x.key === key);
              return (
                <li key={no} className="flex min-w-0 gap-4 border-t border-white/[.06] py-3 first:border-t-0">
                  <span className="w-5 shrink-0 pt-[1px] text-right font-mono text-[12px] text-[#6f7a88]">{no}</span>
                  <span className="min-w-0 flex-1">
                    {r ? <Tautan onClick={() => u.onNav(r.eps[0].id)}>{judul}</Tautan> : <span className="text-[14px] font-medium text-[#eef0f3]">{judul}</span>}
                    <span className="mt-0.5 block text-[13.5px] leading-[1.6] text-[#a3acb9]">{ket}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ),
    },
    {
      id: "s-sumber", judul: "Sumber daya tersedia", md: `${mdResource(rs)}\n- **Batch audit**: direncanakan`,
      isi: (
        <>
          <DaftarResource resources={rs} onNav={u.onNav} />
          <ul className="mt-2.5"><Butir><span className="font-semibold text-[#8a94a3]">Batch audit</span>: audit massal data klaim BPJS pusat <span className="text-[#6f7a88]">· direncanakan</span></Butir></ul>
        </>
      ),
    },
    seksiAuth(u, ["faskes", "pribadi", "admin"], "SIMRS rumah sakit memanggil endpoint integrasi faskes dengan token faskes. Endpoint lain dibuka dengan sesi login atau token pribadi; sebagian khusus admin."),
    ...(kirim ? [{
      id: "s-contoh", judul: "Contoh permintaan", md: mdContoh(kirim, u),
      isi: <ContohPermintaan ep={kirim} u={u} teks="SIMRS mengirim satu klaim dan mendapat tanda terima. Nilai di contoh bersifat ilustratif." />,
    }] : []),
    seksiOpenApi({ u, nasional: true, cabang: false }),
  ];
  return (
    <HalamanDok u={u} kicker="API Nasional" judul="API audit nasional"
      deskripsi="Endpoint JKN dari API yang sedang berjalan, dibaca langsung dari spesifikasi OpenAPI-nya, jadi halaman ini selalu sama dengan kodenya: integrasi faskes, engine realtime, rule engine, AI Agent Swarm, skor dan ML."
      mdKepala="Endpoint JKN dari API yang sedang berjalan."
      meta={<Meta items={[`${n} endpoint`, `OpenAPI ${d.openapi}`, d.version ? `v${d.version}` : null, d.stale ? <span className="text-[#d9b46a]">salinan terakhir (API tidak terjangkau)</span> : null]} />}
      callout={<Callout ikon="info">Dibaca dari <Kode>{u.basis.api}/openapi.json</Kode>: {d.pathsTotal.toLocaleString("id-ID")} path seluruh platform, {n} endpoint JKN ditampilkan di sini.{!d.ruleEngine && " Rule engine aktif setelah API dimulai ulang."}</Callout>}
      seksi={seksi} />
  );
}
