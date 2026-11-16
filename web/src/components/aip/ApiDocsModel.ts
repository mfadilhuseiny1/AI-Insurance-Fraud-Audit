// API Documentation · one model for the reference pages, built from the two specs: the national API (the running API's
// /openapi.json through /api/api-docs) and the AI Agent Swarm Branch API v1 (docs/openapi_cabang_v1.json through
// /api/api-docs/cabang). Tabs, resources and pages in reading order (for the sidebar and Previous / Next), the auth of each
// endpoint as an "Authorization" parameter, every status code with its example, and the request samples in cURL, Python and
// JavaScript. The tokens in the samples are environment variables ($KUNCI_KC, ...), never a real secret.

import type { IconName } from "@/components/Icon";
import type { ApiAuth, ApiDocs, CabangAuth, CabangDocs, CabangEndpoint, CabangTahapKey, DocEndpoint, DocField, DocParam } from "./ApiDocsTypes";
import { NAMA_NASIONAL, RES_NASIONAL, resNasional } from "./ApiDocsNama";

export type TabKey = "ringkasan" | "cabang" | "iot" | "nasional";
export const TAB_URUT: TabKey[] = ["ringkasan", "cabang", "iot", "nasional"];
export const TAB_LABEL: Record<TabKey, string> = { ringkasan: "Ringkasan", cabang: "Branch API v1", iot: "IoT", nasional: "API Nasional" };

export type Otorisasi = {
  label: string;
  /** the header's name: Authorization or X-Ingest-Token */
  nama: string;
  /** the value in the samples, e.g. "Bearer $KUNCI_KC" (the environment variable in env) */
  awalan: string;
  env: string;
  ket: string;
  rencana?: boolean;
};

export const OTORISASI: Record<CabangAuth | ApiAuth, Otorisasi> = {
  "kunci KC": {
    label: "Kunci API KC", nama: "Authorization", awalan: "Bearer ", env: "KUNCI_KC", rencana: true,
    ket: "Header Bearer berisi kunci API KC: `Bearer <kunci>`. Satu kunci per Kantor Cabang, hanya untuk data KC itu (format `bsai_kc_<kc>_…`), dengan scope cabang:baca, cabang:klaim, cabang:jalankan, cabang:putusan, cabang:webhook.",
  },
  "kunci gateway": {
    label: "Kunci gateway RS", nama: "Authorization", awalan: "Bearer ", env: "KUNCI_GATEWAY", rencana: true,
    ket: "Header Bearer berisi kunci gateway AIoT rumah sakit (format `bsai_gw_<faskes>_…`), terpisah dari kunci KC; scope iot:alat, iot:sesi, iot:kirim. Gateway tidak pernah membaca hasil cek.",
  },
  login: {
    label: "Token pribadi", nama: "Authorization", awalan: "Bearer ", env: "BLUESANDAI_TOKEN",
    ket: "Header Bearer berisi token API pribadi pengguna (`bsai_pat_…`), atau sesi login browser (cookie) dari aplikasi web.",
  },
  admin: {
    label: "Token pribadi (admin)", nama: "Authorization", awalan: "Bearer ", env: "BLUESANDAI_TOKEN",
    ket: "Header Bearer berisi token API pribadi pengguna dengan role admin. Selain admin dijawab 403.",
  },
  "token faskes": {
    label: "Token faskes", nama: "X-Ingest-Token", awalan: "", env: "TOKEN_FASKES",
    ket: "Token ingest yang dibuat admin (POST /api/aip/realtime/v1/token) dan dipakai SIMRS rumah sakit. Bukan untuk KC.",
  },
};

export type Respons = { kode: string; ket: string; tipe: string; fields: DocField[]; contoh?: unknown; catatan?: string };
export type Body = {
  contentType: string; required: boolean; ket?: string; fields: DocField[]; contoh?: unknown;
  /** a body that takes either of two schemas */
  varian?: { nama: string; ket?: string; fields: DocField[]; contoh: unknown }[];
};

export type Ep = {
  /** the page id (also the URL hash) */
  id: string;
  /** "POST /api/..." */
  kunci: string;
  tab: TabKey;
  resource: string;
  method: string;
  path: string;
  nama: string;
  ket: string;
  status?: "aktif" | "rencana";
  hariIni?: string;
  scopes: string[];
  otorisasi: Otorisasi[];
  params: DocParam[];
  body: Body | null;
  respons: Respons[];
  /** "ui": served by the web app (/api/swarm-cabang, ...), "api": by the API */
  basis: "api" | "ui";
  /** example values of the path and query parameters */
  contohParam: Record<string, string>;
};

export type Resource = { key: string; tab: TabKey; nama: string; ket: string; ikon: IconName; eps: Ep[] };
export type Panduan = "mulai" | "auth" | "konvensi";
export type Halaman =
  | { id: string; tab: TabKey; jenis: "ringkasan"; judul: string }
  | { id: string; tab: TabKey; jenis: "panduan"; judul: string; panduan: Panduan }
  | { id: string; tab: TabKey; jenis: "endpoint"; judul: string; ep: Ep };

export type Model = {
  resources: Resource[];
  halaman: Halaman[];
  byId: Map<string, Halaman>;
  /** "POST /api/..." → its page in the branch tabs (the quick start names endpoints this way) */
  byKunci: Map<string, Ep>;
};

// ------------------------------------------------------------------------------------------------ the branch API

const B = "/api/aip/cabang/v1";

export const TAHAP_IKON: Record<CabangTahapKey, IconName> = {
  akses: "plug", audit: "pipeline", klaim: "upload", iot: "signal", skor: "cpu", indikasi: "filter", swarm: "graph", box: "lock", laporan: "doc", putusan: "check",
};

// path parameters filled with the example run's values (gen3_kc2, KC Makassar), as the spec's examples use
const CONTOH_PARAM: Record<string, string> = {
  audit_id: "gen3_kc2", run: "gen3_kc2", klaim_id: "KLM-2BDA4A57", faskes_id: "faa82ee4834efbe8a3541990cd5e07b0", unggahan_id: "upl_4c1d0e9a7b2f",
  no: "1", bab_id: "ringkasan", tahap: "laporan", proyek_id: "p_ujicoba_ml_v7_makassar", kunci_id: "kck_7f3a91c2", webhook_id: "whk_2b7c", kc: "sul-7371",
  // the IoT examples: the synthetic IoMT world (synthetic-iomt), claim KLM-000734, its ventilator and episode
  alat_id: "DV-029-VNT-02", sesi_id: "ses_e06d6b23ff9a", episode_id: "EP-729309",
};

const RES_IOT: { key: string; nama: string; ket: string; ikon: IconName; cocok: RegExp }[] = [
  { key: "iot-alat", nama: "Gateway & alat", ket: "kunci gateway RS dan registri alat medis", ikon: "device", cocok: /\/iot\/(gateway|alat)/ },
  { key: "iot-sesi", nama: "Binding sesi", ket: "alat ↔ pasien ↔ kunjungan: mulai, tutup, pindahkan", ikon: "link", cocok: /\/iot\/sesi/ },
  { key: "iot-bacaan", nama: "Bacaan & pemakaian", ket: "bacaan bertanda tangan dan sesi pemakaian dari gateway", ikon: "signal", cocok: /\/iot\/(bacaan|pemakaian)/ },
  { key: "iot-episode", nama: "Episode & bukti", ket: "jangkar Merkle, tautan episode ↔ klaim, verifikasi bukti", ikon: "lock", cocok: /\/iot\/episode/ },
  { key: "iot-cek", nama: "Cek & utilisasi", ket: "aturan IoT, cek tagihan vs pemakaian, ringkasan per audit, utilisasi alat", ikon: "filter", cocok: /\/iot\/(aturan|cek|utilisasi)|\/iot$/ },
  { key: "iot-hari-ini", nama: "Tersedia hari ini", ket: "endpoint aktif: klaim RS + bukti perangkat, verifikasi paket bukti, laporan IoMT", ikon: "check", cocok: /.*/ },
];

const DI_UI = /^\/api\/(swarm-cabang|faskes-verify|iomt-audit)(\/|$)/;

function slug(tab: TabKey, method: string, path: string): string {
  const p = path.replace(/^\/api\/aip\/cabang\/v1\//, "").replace(/^\/api\/aip\//, "").replace(/^\/api\//, "")
    .replace(/[{}]/g, "").replace(/[^a-zA-Z0-9_]+/g, "-").replace(/^-|-$/g, "");
  return `${tab}/${method.toLowerCase()}-${p || "root"}`;
}

function dariCabang(e: CabangEndpoint): Ep {
  const tab: TabKey = e.tahap === "iot" ? "iot" : "cabang";
  const resource = tab === "iot" ? RES_IOT.find((r) => r.cocok.test(e.path.replace(/\{[^}]+\}/g, "x")) && (r.key !== "iot-hari-ini" ? e.path.startsWith(B) : true))!.key : e.tahap;
  const otorisasi = (e.auth.length ? e.auth : ["login" as const]).map((a) => OTORISASI[a] ?? OTORISASI.login);
  return {
    id: slug(tab, e.method, e.path), kunci: e.id, tab, resource, method: e.method, path: e.path, nama: e.summary, ket: e.line,
    status: e.status, hariIni: e.hariIni, scopes: e.scopes, otorisasi,
    params: e.params.filter((p) => p.in !== "cookie"),
    body: e.body ? { contentType: e.body.contentType, required: e.body.required, ket: e.body.description, fields: e.body.fields, contoh: e.contohKirim } : null,
    respons: e.respons.map((r) => ({ kode: r.kode, ket: r.ket, tipe: r.type, fields: r.fields, contoh: r.contoh })),
    basis: DI_UI.test(e.path) ? "ui" : "api", contohParam: CONTOH_PARAM,
  };
}

// ------------------------------------------------------------------------------------------------ the national API

const KET_KODE: Record<string, string> = {
  "200": "Berhasil", "201": "Dibuat", "202": "Diterima", "401": "Belum masuk atau token tidak sah", "403": "Butuh role admin",
  "404": "Tidak ditemukan", "422": "Isian tidak valid", "503": "Token ingest belum dibuat",
};

function galatNasional(kode: string, auth: ApiAuth, e: DocEndpoint): unknown {
  if (kode === "401") return auth === "token faskes" ? { detail: "token ingest tidak sah" } : { detail: "Sign in to use BluesandAI", code: "unauthenticated" };
  if (kode === "403") return { detail: "butuh admin" };
  if (kode === "503") return { detail: "token ingest realtime belum dibuat (admin: POST /api/aip/realtime/v1/token)" };
  if (kode === "422") {
    const f = e.body?.variants[0]?.fields.find((x) => x.required);
    const p = e.params.find((x) => x.required && x.in !== "header");
    const loc = f ? ["body", f.name] : p ? [p.in, p.name] : ["body"];
    return { detail: [{ type: "missing", loc, msg: "Field required", input: null }] };
  }
  return { detail: "tidak ditemukan" };
}

const FIELD_GALAT: DocField[] = [{ name: "detail", type: "string", required: true, description: "Pesan galat (atau daftar galat validasi untuk 422)." }];

function dariNasional(e: DocEndpoint, grup: string): Ep {
  const short = e.path.replace(/^\/api\/aip\//, "");
  const [nama, ket] = NAMA_NASIONAL[`${e.method} ${short}`] ?? [e.summary, e.line];
  const vs = e.body?.variants ?? [];
  const v0 = vs[0];
  const body: Body | null = e.body ? {
    contentType: e.body.contentType, required: e.body.required, ket: v0?.description, fields: v0?.fields ?? [], contoh: v0?.lengkap,
    varian: vs.length > 1 ? vs.map((v) => ({ nama: v.name, ket: v.description, fields: v.fields, contoh: v.lengkap })) : undefined,
  } : null;
  const respons: Respons[] = e.response.codes.map((kode) => kode.startsWith("2")
    ? {
      kode, ket: KET_KODE[kode] ?? "Berhasil", tipe: e.response.type, fields: e.response.fields, contoh: e.response.contoh,
      catatan: e.response.contoh === undefined ? (e.response.type === "any" ? "Respons berupa berkas atau teks." : "Spesifikasi hanya menyebut objek JSON; isinya tidak dideklarasikan.") : e.response.dariKode ? "Isi respons diambil dari kode handler (spesifikasi hanya menyebut objek)." : undefined,
    }
    : { kode, ket: KET_KODE[kode] ?? "Galat", tipe: "object", fields: FIELD_GALAT, contoh: galatNasional(kode, e.auth, e) });
  return {
    id: slug("nasional", e.method, e.path), kunci: e.id, tab: "nasional", resource: resNasional(grup, e.path), method: e.method, path: e.path,
    nama, ket: ket || e.line, scopes: [], otorisasi: [OTORISASI[e.auth]],
    params: e.params.filter((p) => p.in !== "cookie"), body, respons, basis: "api", contohParam: {},
  };
}

// ------------------------------------------------------------------------------------------------ the model

export const PANDUAN: { id: string; judul: string; panduan: Panduan }[] = [
  { id: "ringkasan/mulai-cepat", judul: "Mulai cepat", panduan: "mulai" },
  { id: "ringkasan/autentikasi", judul: "Autentikasi", panduan: "auth" },
  { id: "ringkasan/konvensi", judul: "Galat & konvensi", panduan: "konvensi" },
];

export function bangunModel(nasional: ApiDocs | null, cabang: CabangDocs | null): Model {
  const resources: Resource[] = [];
  if (cabang) {
    const eps = cabang.tahap.flatMap((t) => t.endpoints).map(dariCabang);
    for (const t of cabang.tahap) {
      if (t.key === "iot") continue;
      resources.push({ key: t.key, tab: "cabang", nama: t.nama, ket: t.ringkas, ikon: TAHAP_IKON[t.key], eps: eps.filter((e) => e.tab === "cabang" && e.resource === t.key) });
    }
    for (const r of RES_IOT) resources.push({ key: r.key, tab: "iot", nama: r.nama, ket: r.ket, ikon: r.ikon, eps: eps.filter((e) => e.resource === r.key) });
  }
  if (nasional) {
    const eps = nasional.groups.flatMap((g) => g.endpoints.map((e) => dariNasional(e, g.key)));
    for (const r of RES_NASIONAL) resources.push({ key: r.key, tab: "nasional", nama: r.nama, ket: r.ket, ikon: r.ikon, eps: eps.filter((e) => e.resource === r.key) });
  }
  const isi = resources.filter((r) => r.eps.length > 0);
  const halaman: Halaman[] = [{ id: "ringkasan", tab: "ringkasan", jenis: "ringkasan", judul: "Ringkasan" }];
  if (cabang) halaman.push(...PANDUAN.map((p) => ({ ...p, tab: "ringkasan" as const, jenis: "panduan" as const })));
  for (const tab of ["cabang", "iot", "nasional"] as TabKey[]) {
    halaman.push({ id: tab, tab, jenis: "ringkasan", judul: "Ringkasan" });
    for (const r of isi.filter((x) => x.tab === tab)) for (const ep of r.eps) halaman.push({ id: ep.id, tab, jenis: "endpoint", judul: ep.nama, ep });
  }
  const byKunci = new Map<string, Ep>();
  for (const r of isi) if (r.tab !== "nasional") for (const ep of r.eps) byKunci.set(ep.kunci, ep);
  return { resources: isi, halaman, byId: new Map(halaman.map((h) => [h.id, h])), byKunci };
}

// ------------------------------------------------------------------------------------------------ display helpers

/** a field's type as the reference shows it: enum<string>, enum<string>[], string<date-time> */
export function tipeTampil(f: { type: string; enum?: unknown[] }): string {
  let t = f.type;
  if (t === "date-time" || t === "date") t = `string<${t}>`;
  if (f.enum?.length && !t.includes("enum<") && !t.includes("|")) {
    const many = t.endsWith("[]");
    const base = many ? t.slice(0, -2) : t;
    t = `enum<${base === "string" || base === "integer" || base === "number" || base === "boolean" ? base : "string"}>${many ? "[]" : ""}`;
  }
  return t;
}

export const STATUS_TEKS: Record<string, string> = {
  "200": "OK", "201": "Created", "202": "Accepted", "204": "No Content", "400": "Bad Request", "401": "Unauthorized", "403": "Forbidden",
  "404": "Not Found", "409": "Conflict", "412": "Precondition Failed", "413": "Payload Too Large", "422": "Unprocessable Entity",
  "429": "Too Many Requests", "500": "Internal Server Error", "503": "Service Unavailable",
};

export const warnaKode = (k: string) => (k.startsWith("2") ? "#7cc4a0" : k.startsWith("4") ? "#d9b46a" : "#dc8a8a");

export type Basis = { api: string; ui: string };

// ------------------------------------------------------------------------------------------------ request samples

export type Lang = "curl" | "python" | "js";
export const LANG_LABEL: Record<Lang, string> = { curl: "cURL", python: "Python", js: "JavaScript" };

/** the request's URL: path parameters from `nilai` (Try it), then the examples, else {name}; the required query parameters */
export function urlOf(ep: Ep, basis: Basis, nilai: Record<string, string> = {}): string {
  const base = ep.basis === "ui" ? basis.ui : basis.api;
  const path = ep.path.replace(/\{([^}]+)\}/g, (_, n: string) => encodeURIComponent(nilai[`path:${n}`] || ep.contohParam[n] || "") || `{${n}}`);
  const q = ep.params.filter((p) => p.in === "query").flatMap((p) => {
    const v = nilai[`query:${p.name}`] ?? (p.required ? ep.contohParam[p.name] ?? (p.enum?.length ? String(p.enum[0]) : p.default !== undefined ? String(p.default) : `<${p.name}>`) : "");
    return v ? [`${p.name}=${v.startsWith("<") ? v : encodeURIComponent(v)}`] : [];
  });
  return `${base}${path}${q.length ? `?${q.join("&")}` : ""}`;
}

type Permintaan = { method: string; url: string; headers: [string, string, "env" | "lit"][]; body?: unknown; contentType?: string };

export function permintaanOf(ep: Ep, basis: Basis, nilai: Record<string, string> = {}, body?: unknown): Permintaan {
  const a = ep.otorisasi[0];
  const headers: Permintaan["headers"] = [];
  if (a) headers.push([a.nama, `${a.awalan}$${a.env}`, "env"]);
  for (const p of ep.params.filter((x) => x.in === "header" && (x.required || nilai[`header:${x.name}`]))) headers.push([p.name, nilai[`header:${p.name}`] || `<${p.name}>`, "lit"]);
  const b = body !== undefined ? body : ep.body?.contoh;
  const ct = ep.body?.contentType;
  if (ep.body && ct === "application/json") headers.push(["Content-Type", "application/json", "lit"]);
  return { method: ep.method, url: urlOf(ep, basis, nilai), headers, body: ep.body ? (b ?? {}) : undefined, contentType: ct };
}

const kutip1 = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** a JSON value as a Python literal (True / False / None), indented by four */
function py(v: unknown, d = 0): string {
  const pad = "    ".repeat(d + 1);
  const end = "    ".repeat(d);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + py(x, d + 1)).join(",\n")}\n${end}]` : "[]";
  const ent = Object.entries(v as Record<string, unknown>);
  return ent.length ? `{\n${ent.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${py(x, d + 1)}`).join(",\n")}\n${end}}` : "{}";
}

const indent = (s: string, n: number) => s.split("\n").map((l, i) => (i === 0 ? l : " ".repeat(n) + l)).join("\n");

export function sampel(lang: Lang, r: Permintaan): string {
  const form = r.contentType === "multipart/form-data" && r.body && typeof r.body === "object" ? Object.entries(r.body as Record<string, unknown>) : null;
  if (lang === "curl") {
    const l = [`curl --request ${r.method}`, `--url ${r.url.includes("{") || r.url.includes("<") ? `"${r.url}"` : r.url}`];
    for (const [k, v, jenis] of r.headers) l.push(jenis === "env" ? `--header "${k}: ${v}"` : `--header ${kutip1(`${k}: ${v}`)}`);
    if (form) for (const [k, v] of form) l.push(`--form ${kutip1(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)}`);
    else if (r.body !== undefined) l.push(`--data ${indent(kutip1(JSON.stringify(r.body, null, 2)), 2)}`);
    return l.join(" \\\n  ");
  }
  if (lang === "python") {
    const auth = r.headers.find(([, , j]) => j === "env");
    const lines = ["import requests"];
    if (auth) lines.unshift("import os");
    lines.push("", `url = ${JSON.stringify(r.url)}`, "");
    const h = r.headers.filter(([k]) => !(form && k === "Content-Type")).map(([k, v, j]) => {
      if (j !== "env") return `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
      const m = /^(.*)\$([A-Z_]+)$/.exec(v);
      return m && m[1] ? `    ${JSON.stringify(k)}: f"${m[1]}{os.environ['${m[2]}']}"` : `    ${JSON.stringify(k)}: os.environ[${JSON.stringify(m?.[2] ?? v)}]`;
    });
    const call = r.method.toLowerCase();
    const args = ["url"];
    if (form) {
      lines.push(`files = {\n${form.map(([k, v]) => typeof v === "string" && v.startsWith("@") ? `    ${JSON.stringify(k)}: open(${JSON.stringify(v.slice(1))}, "rb")` : `    ${JSON.stringify(k)}: (None, ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))})`).join(",\n")}\n}`);
      args.push("files=files");
    } else if (r.body !== undefined) {
      lines.push(`payload = ${py(r.body)}`);
      args.push("json=payload");
    }
    lines.push(`headers = {\n${h.join(",\n")}\n}`, "", `response = requests.${call}(${[...args, "headers=headers"].join(", ")})`, "", "print(response.json())");
    return lines.join("\n");
  }
  const h = r.headers.filter(([k]) => !(form && k === "Content-Type")).map(([k, v, j]) => {
    const key = /^[A-Za-z_]\w*$/.test(k) ? k : `'${k}'`;
    if (j !== "env") return `    ${key}: '${v}'`;
    const m = /^(.*)\$([A-Z_]+)$/.exec(v);
    return `    ${key}: \`${m?.[1] ?? ""}\${process.env.${m?.[2] ?? "TOKEN"}}\``;
  });
  const lines = [`const url = '${r.url}';`];
  if (form) {
    lines.push("const form = new FormData();");
    for (const [k, v] of form) lines.push(typeof v === "string" && v.startsWith("@") ? `form.append('${k}', berkas); // ${v.slice(1)}` : `form.append('${k}', ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))});`);
  }
  const opsi = [`  method: '${r.method}'`, `  headers: {\n${h.join(",\n")}\n  }`];
  if (form) opsi.push("  body: form");
  else if (r.body !== undefined) opsi.push(`  body: JSON.stringify(${indent(JSON.stringify(r.body, null, 2), 2)})`);
  lines.push("", `const options = {\n${opsi.join(",\n")}\n};`, "", "fetch(url, options)", "  .then((res) => res.json())", "  .then((json) => console.log(json))", "  .catch((err) => console.error(err));");
  return lines.join("\n");
}

export const bahasaOf = (l: Lang) => (l === "curl" ? "sh" : l === "python" ? "py" : "js") as "sh" | "py" | "js";

// ------------------------------------------------------------------------------------------------ "Salin halaman": markdown

function mdFields(fs: DocField[], d = 0): string[] {
  const pad = "  ".repeat(d);
  return fs.flatMap((f) => [
    `${pad}- \`${f.name}\` (${tipeTampil(f)}${f.required ? ", wajib" : ""})${f.description ? `: ${f.description}` : ""}${f.enum?.length ? ` Opsi: ${f.enum.map((v) => `\`${String(v)}\``).join(", ")}.` : ""}${f.batas ? ` Batas: ${f.batas}.` : ""}`,
    ...(f.children ? mdFields(f.children, d + 1) : []),
  ]);
}

export function markdownEndpoint(ep: Ep, basis: Basis, kicker: string): string {
  const out = [`_${kicker}_`, "", `# ${ep.nama}`, "", ep.ket, "", `\`${ep.method} ${ep.path}\``];
  if (ep.status) out.push("", `Status: ${ep.status}${ep.hariIni ? ` · pakai dulu hari ini: ${ep.hariIni}` : ""}`);
  out.push("", "## Otorisasi", ...ep.otorisasi.map((a) => `- \`${a.nama}\` (string, header, wajib): ${a.label}. ${a.ket}`));
  for (const [di, judul] of [["header", "Header"], ["path", "Parameter path"], ["query", "Parameter query"]] as const) {
    const ps = ep.params.filter((p) => p.in === di);
    if (ps.length) out.push("", `## ${judul}`, ...mdFields(ps.map((p) => ({ ...p }))));
  }
  if (ep.body) out.push("", `## Body (${ep.body.contentType})`, ...(ep.body.ket ? [ep.body.ket] : []), ...mdFields(ep.body.fields));
  out.push("", "## Respons");
  for (const r of ep.respons) out.push("", `### ${r.kode} ${STATUS_TEKS[r.kode] ?? ""}${r.ket ? ` · ${r.ket}` : ""}`, ...mdFields(r.fields));
  out.push("", "## Contoh permintaan", "", "```bash", sampel("curl", permintaanOf(ep, basis)), "```");
  const ok = ep.respons.find((r) => r.kode.startsWith("2"));
  if (ok?.contoh !== undefined) out.push("", `## Contoh respons (${ok.kode})`, "", "```json", JSON.stringify(ok.contoh, null, 2), "```");
  return out.join("\n");
}
