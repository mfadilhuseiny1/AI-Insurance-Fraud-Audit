// API Documentation · the slim spec served by /api/api-docs (route.ts builds it from the API's /openapi.json) and read by
// ApiDocsView. Types only, shared by the route handler and the tab.

export type ApiAuth = "token faskes" | "login" | "admin";
export type ApiGroupKey = "faskes" | "realtime" | "rule" | "konsultan" | "fraud";
export type Scalar = string | number | boolean | null;

/** one field of a request or response body; children: the fields of a nested object (one level) */
export type DocField = {
  name: string;
  type: string;
  required: boolean;
  nullable?: boolean;
  description?: string;
  enum?: Scalar[];
  default?: unknown;
  /** a range, a length or a pattern the value must keep ("0 < x ≤ 50", "≤ 120 karakter") */
  batas?: string;
  children?: DocField[];
};

export type DocParam = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  type: string;
  required: boolean;
  description?: string;
  enum?: Scalar[];
  default?: unknown;
  batas?: string;
};

/** a body schema; more than one variant when the endpoint takes either of two schemas (anyOf) */
export type DocVariant = { name: string; description?: string; fields: DocField[]; minimal: unknown; lengkap: unknown };
export type DocBody = { contentType: string; required: boolean; variants: DocVariant[] };

export type DocResponse = {
  /** status codes: the spec's own, plus the ones the auth check answers with (401 / 403 / 503) */
  codes: string[];
  type: string;
  fields: DocField[];
  /** the fields come from the handler's code (the spec only says "object") */
  dariKode?: boolean;
  /** a sample success body built from the schema (or from the handler's fields); absent when the spec says only "object" */
  contoh?: unknown;
};

export type DocEndpoint = {
  id: string;
  method: string;
  path: string;
  summary: string;
  /** the first sentence of the description, or empty */
  line: string;
  auth: ApiAuth;
  params: DocParam[];
  body: DocBody | null;
  response: DocResponse;
};

export type DocGroup = { key: ApiGroupKey; label: string; endpoints: DocEndpoint[] };

export type ApiDocs = {
  openapi: string;
  version: string;
  /** every path of the platform's spec, before the JKN filter */
  pathsTotal: number;
  groups: DocGroup[];
  /** the rule engine endpoints are in the running API (they arrive with an API restart) */
  ruleEngine: boolean;
  diambil: string;
  /** the API could not be reached: the last good copy */
  stale?: boolean;
};

// ------------------------------------------------------------------------------------------------ AI Agent Swarm Branch API v1
// served by /api/api-docs/cabang from docs/openapi_cabang_v1.json (a design spec: most endpoints are planned, x-status says which)

export type CabangStatus = "aktif" | "rencana";
export type CabangAuth = "kunci KC" | "kunci gateway" | "login" | "admin" | "token faskes";
export type CabangTahapKey = "akses" | "audit" | "klaim" | "iot" | "skor" | "indikasi" | "swarm" | "box" | "laporan" | "putusan";

export type CabangEndpoint = {
  id: string;
  method: string;
  path: string;
  tahap: CabangTahapKey;
  summary: string;
  line: string;
  status: CabangStatus;
  auth: CabangAuth[];
  scopes: string[];
  /** one line each: what the caller sends, what it gets back */
  kirim: string;
  dapat: string;
  /** a planned endpoint's stand-in that exists today */
  hariIni?: string;
  params: DocParam[];
  contohKirim?: unknown;
  /** the success code and its example body */
  kodeOk: string;
  contohDapat?: unknown;
  galat: string[];
  /** the request body's fields from its schema (one or two nested levels) */
  body: { contentType: string; required: boolean; description?: string; fields: DocField[] } | null;
  /** every documented status code: its description, fields and example (the spec's own, $refs resolved) */
  respons: CabangRespons[];
};

export type CabangRespons = { kode: string; ket: string; type: string; fields: DocField[]; contoh?: unknown };
/** a security scheme of the spec (components.securitySchemes) */
export type CabangKeamanan = { kunci: string; jenis: string; di: string; nama: string; format?: string; ket: string };

export type CabangTahap = { key: CabangTahapKey; nama: string; ringkas: string; endpoints: CabangEndpoint[] };
export type CabangLangkah = { judul: string; teks: string; endpoint: string[]; hariIni?: string };

export type CabangDocs = {
  judul: string;
  versi: string;
  openapi: string;
  ringkas: string;
  basis: string;
  tahap: CabangTahap[];
  mulaiCepat: CabangLangkah[];
  jumlah: { aktif: number; rencana: number };
  diambil: string;
  /** info.description: the long description of the API */
  deskripsi: string;
  /** x-konvensi: versioning, errors, paging, idempotency, rate limits, IoT, cost */
  konvensi: Record<string, string>;
  keamanan: CabangKeamanan[];
  /** when the spec file last changed (ISO) */
  diperbarui: string;
};
