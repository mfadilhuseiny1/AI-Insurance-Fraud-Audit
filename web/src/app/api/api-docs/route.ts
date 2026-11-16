import { signedIn } from "@/lib/sessionCheck";
import type {
  ApiAuth, ApiDocs, ApiGroupKey, DocBody, DocEndpoint, DocField, DocGroup, DocParam, DocResponse, DocVariant, Scalar,
} from "@/components/aip/ApiDocsTypes";

/*
 * API Documentation (the user, 2026-11-13: "bikin tab baru namanya API Documentation", visual): the JKN part of the API's
 * own OpenAPI spec, slimmed for the tab. The spec is read live from the API (GET /openapi.json, ~2 MB, every path of the
 * platform), so the endpoints never drift from the code; only the JKN groups are kept, their $ref schemas resolved into
 * fields (one nested level) and sample bodies. Cached here for 60 s. Signed-in users only.
 *
 * /openapi.json is outside /api/, so the API's auth middleware does not gate it: the server-side call needs no cookie and
 * goes to BLUESANDAI_API_URL (127.0.0.1:8300 in AI JKN Synthetic) like the other route handlers that call the API.
 *
 * Auth labels: "token faskes" for the ingest-token paths (api/auth.py PUBLIC; aip/realtime/integrasi.check_token reads the
 * X-Ingest-Token header, which the spec also lists), "admin" for the handlers that refuse a non-admin (the list below,
 * read from the route code), "login" for the rest (a signed-in session or a personal API token as Bearer).
 * The reference pages (2026-11-15) also get each field's limits and a sample success body (from the schema, or from the
 * handler's fields where the spec says only "object").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API = (process.env.BLUESANDAI_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const TTL_MS = 60_000;

type J = Record<string, unknown>;
type Spec = { openapi?: string; info?: { version?: string }; paths?: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, J> } };

const RT = "/api/aip/realtime/v1";
const GROUPS: [ApiGroupKey, string][] = [
  ["faskes", "Integrasi faskes"], ["realtime", "Realtime Fraud"], ["rule", "Rule engine"], ["konsultan", "AI Agent Swarm"], ["fraud", "Fraud & ML"],
];
// claims sent by a connected system with a session or a personal API token (routes.py ingest, ingest_fktp, ingest_nonkap):
// shown beside the hospital endpoints, labelled "login"
const INGEST = [`${RT}/fktp`, `${RT}/nonkapitasi`, `${RT}/klaim`];
// a hospital's order of calls: pre-check, submit, status and the auditor's requests, reply; then the other ingest endpoints
const ORDER_FASKES = [`${RT}/faskes/precheck`, `${RT}/faskes/klaim`, `${RT}/faskes/permintaan`, `${RT}/faskes/permintaan/{rid}/balas`, ...INGEST];

// api/auth.py PUBLIC: the paths a hospital system calls with the ingest token instead of a user
const TOKEN_FASKES = [`${RT}/faskes/klaim`, `${RT}/faskes/permintaan`, `${RT}/faskes/precheck`];
// handlers that answer 403 to a non-admin: aip/realtime/routes.py _admin(), aip/konsultan.py _admin(what) and its inline
// checks, aip/ml.py's inline checks (train, bukti, aturan2)
const ADMIN = new Set([
  `POST ${RT}/mesin`, `POST ${RT}/bobot/terapkan`, `POST ${RT}/bobot/bawaan`, `POST ${RT}/al/ssl/latih`, `POST ${RT}/al/label`,
  `POST ${RT}/al/latih`, `POST ${RT}/al/mode`, `POST ${RT}/al/simulasi`, `POST ${RT}/al/simulasi/promosikan`,
  `POST ${RT}/peristiwa/{eid}/permintaan`, `POST ${RT}/kasus/{cid}/keputusan`, `POST ${RT}/simulator`, `POST ${RT}/simulator/tanam`,
  `PUT ${RT}/sumber/{sid}`, `POST ${RT}/token`, `POST ${RT}/box`, `POST ${RT}/reset`,
  "POST /api/aip/konsultan", "POST /api/aip/konsultan/{run_id}/laporan", "DELETE /api/aip/konsultan/{run_id}",
  "POST /api/aip/konsultan/proyek", "PUT /api/aip/konsultan/proyek/{pid}", "DELETE /api/aip/konsultan/proyek/{pid}",
  "POST /api/aip/konsultan/{run_id}/laporan-lengkap/narasi",
  "POST /api/aip/ml/train", "POST /api/aip/ml/bukti", "POST /api/aip/ml/aturan2",
]);
// the rule engine (routes.py, after "user-defined rules"): approve / reject / switch off / roll back are _admin()
const ADMIN_RULE = /^\/api\/aip\/realtime\/v1\/aturan\/(bawaan\/)?\{[^}]+\}\/(setujui|tolak|nonaktifkan|rollback)$/;

// list[dict] bodies the handler validates against a schema the spec has (routes.py ingest: aip/layanan.KlaimIn;
// layanan.py verify/batch: the judges' format among others)
const ITEM_SCHEMA: Record<string, Record<string, string>> = {
  [`POST ${RT}/klaim`]: { klaim: "KlaimIn" },
  "POST /api/aip/fraud/v1/verify/batch": { klaim: "ClaimDataJuri" },
};

const fd = (name: string, type: string, extra: Partial<DocField> = {}): DocField => ({ name, type, required: true, ...extra });
const ACCEPTED = [fd("diterima", "integer"), fd("ditolak", "object[]", { children: [fd("baris", "integer"), fd("galat", "string")] }), fd("id", "string[]")];
// what the handlers return where the spec only says "object" (aip/realtime/routes.py, permintaan.for_hospital,
// precheck.run, layanan._verify): the endpoints a hospital or another system integrates with
const RESPONSE_HINTS: Record<string, DocField[]> = {
  [`POST ${RT}/faskes/klaim`]: [
    fd("tanda_terima", "string"), fd("diterima_pada", "date-time"), fd("status", "string", { enum: ["diterima", "ditolak"] }),
    fd("versi", "integer", { required: false }), fd("alasan", "string", { required: false, description: "bila ditolak" }),
  ],
  [`POST ${RT}/faskes/precheck`]: [
    fd("id", "string"), fd("kunci_draf", "string"), fd("pada", "date-time"),
    fd("dokumen", "object[]", { children: [fd("kode", "string"), fd("dokumen", "string"), fd("alasan", "string"), fd("dasar", "string")] }),
    fd("peringatan", "object[]", { children: [fd("kode", "string"), fd("pesan", "string")] }), fd("catatan", "string"),
  ],
  [`POST ${RT}/faskes/permintaan`]: [
    fd("klaim", "object", {
      description: "per klaim_id",
      children: [fd("status", "string", { enum: ["diterima", "diproses", "ditolak", "tidak dikenal"] }), fd("tanda_terima", "string", { nullable: true }),
        fd("pada", "date-time", { nullable: true }), fd("alasan", "string", { nullable: true }), fd("permintaan", "object[]")],
    }),
  ],
  [`POST ${RT}/faskes/permintaan/{rid}/balas`]: [
    fd("id", "string"), fd("dibuat", "date-time"), fd("status", "string"), fd("pesan", "string"),
    fd("butir", "object[]", { children: [fd("medan", "string"), fd("isi", "string"), fd("dokumen", "string")] }),
    fd("balasan", "string", { nullable: true }), fd("dibalas", "date-time", { nullable: true }),
  ],
  [`POST ${RT}/klaim`]: [
    ...ACCEPTED,
    fd("keputusan", "object[]", {
      required: false, description: "bila tunggu = true",
      children: [fd("id", "string"), fd("skor", "number"), fd("keputusan", "string", { enum: ["LOLOS", "PERIKSA", "TAHAN"] }), fd("sinyal", "object[]"), fd("modus", "string[]")],
    }),
  ],
  [`POST ${RT}/fktp`]: ACCEPTED,
  [`POST ${RT}/nonkapitasi`]: ACCEPTED,
  "POST /api/aip/fraud/v1/verify": [
    fd("status", "string", { enum: ["INDIKASI_KUAT", "PERLU_DIPERIKSA", "WAJAR"] }), fd("fraud_probability", "number"), fd("ai_reasoning", "string"),
    fd("status_label", "string"), fd("klaim_id", "string"), fd("indikasi", "object[]"), fd("peringatan", "string[]"), fd("pipeline", "object[]"),
  ],
};

const METHODS = ["get", "post", "put", "patch", "delete"];
const BRANDS = /\b(openai|chatgpt|gpt-[\w.-]+|gemini|claude|anthropic|deepseek|glm-?[\w.]*|qwen[\w.-]*|llama[\w.-]*|mistral|kimi|grok)\b/gi;

function groupOf(path: string): ApiGroupKey | null {
  if (path.startsWith(`${RT}/faskes/`) || INGEST.includes(path)) return "faskes";
  if (path === `${RT}/aturan` || path.startsWith(`${RT}/aturan/`)) return "rule";
  if (path.startsWith(`${RT}/`)) return "realtime";
  if (path === "/api/aip/konsultan" || path.startsWith("/api/aip/konsultan/")) return "konsultan";
  if (path.startsWith("/api/aip/fraud/") || path.startsWith("/api/aip/ml")) return "fraud";
  return null;
}

/** text from the spec as one line: the user's dated notes in parentheses dropped, no model brand */
function clean(t: unknown): string {
  if (typeof t !== "string") return "";
  return t.replace(/\s*\([^()]*\bthe user\b[^()]*\)/gi, "").replace(BRANDS, "model").replace(/\s+/g, " ").trim();
}

function firstSentence(t: string): string {
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  let s = m ? m[1] : t;
  if (s.length > 170) s = `${s.slice(0, 166).replace(/\s+\S*$/, "")}…`;
  return s;
}

const cleanName = (n: string) => n.replace(/^.*__/, "");

// ------------------------------------------------------------------------------------------------ sample values

// matched against the field's dotted path in the body (e.g. "obat.kode"); illustrative values only, never real data
const NUM_HINTS: [RegExp, number][] = [
  [/ambang_periksa$/i, 15], [/ambang_tahan$/i, 50], [/(_rp|biaya[^.]*|tarif[^.]*|cost)$/i, 2_500_000], [/kabkota[^.]*kode$/i, 3273],
  [/peserta_id$/i, 100234], [/(^|\.)(kelas_rawat|hak_kelas|regional)$/i, 1], [/(los[^.]*|hari|length_of_stay[^.]*)$/i, 3],
  [/(age|umur|usia)[^.]*$/i, 54], [/toleransi$/i, 0.15], [/nilai_klaim$/i, 7.5], [/nilai_alat$/i, 7.2],
  [/(diresepkan|ditagih|diserahkan)$/i, 10], [/batas_usd$/i, 5], [/risiko_pct$/i, 12],
];
const STR_HINTS: [RegExp, string][] = [
  [/peringatan\.pesan$/i, "Klaim serupa sudah dikirim 2 hari lalu"],
  [/(inacbg_kode|ina_cbg_code)$/i, "J-4-16-I"],
  [/(^|\.)(diagnosis_utama|dx_primer_icd3|primary_diagnosis)$/i, "J18"],
  [/(diagnosis_sekunder|dx_sekunder)$/i, "E11"],
  [/(^|\.)tindakan$/i, "96.04"],
  [/(^|\.)(klaim_id|claim_id|kunjungan_fkrtl_id|klaim)$/i, "KLM-2026-000123"],
  [/no_rm$/i, "RM-004512"], [/no_sep$/i, "0301R0011126V000123"],
  [/nama_faskes$/i, "RS Contoh Sehat"], [/nama_pasien$/i, "Pasien Contoh"], [/kelas_rs$/i, "B"], [/(^|\.)milik$/i, "S"],
  [/obat\.kode$/i, "OBT-0001"], [/obat\.nama$/i, "Amoksisilin 500 mg"],
  [/pemeriksaan\.parameter$/i, "Hemoglobin"], [/pemeriksaan\.satuan$/i, "g/dL"],
  [/kepemilikan[^.]*$/i, "Swasta"], [/provinsi[^.]*$/i, "Jawa Barat"], [/(^|\.)kabkota_fkrtl$/i, "Kota Bandung"],
  [/clinical_notes$/i, "Pneumonia komunitas, rawat inap 3 hari, foto toraks terlampir."],
  [/(^|\.)(pesan|balasan)$/i, "Resume medis dan hasil lab terlampir."],
  [/catatan$/i, "Catatan auditor"],
  [/(^|\.)(teks|brief|fokus)$/i, "Tandai klaim dengan biaya tagih di atas dua kali tarif INA-CBG"],
  [/sha256$/i, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
  [/(^|\.)sumber$/i, "rs-contoh"], [/(^|\.)peristiwa$/i, "ev-3f2a9c1d"], [/butir\.medan$/i, "diagnosis_utama"], [/butir\.isi$/i, "J18"],
  [/butir\.dokumen$/i, "Resume medis"], [/(^|\.)kondisi$/i, "biaya_tagih_rp > 2 * tarif_inacbg_rp"], [/(^|\.)kode$/i, "R-BIAYA-01"],
  // response fields (RESPONSE_HINTS): illustrative values for the sample bodies of the reference pages
  [/tanda_terima$/i, "TT-20261102-000123"], [/kunci_draf$/i, "draf-7c2e91"], [/dokumen\.dokumen$/i, "Resume medis"],
  [/dokumen\.alasan$/i, "Diagnosis utama perlu didukung hasil foto toraks"], [/dokumen\.dasar$/i, "Permenkes 26/2021"],
  [/ai_reasoning$/i, "Biaya tagih jauh di atas tarif INA-CBG untuk diagnosis ini."],
  [/status_label$/i, "Perlu diperiksa"], [/(^|\.)alasan$/i, "berkas tidak lengkap"], [/(^|\.)catatan$/i, "Dokumen tambahan diminta verifikator"],
  [/(^|\.)id$/i, "id-000123"], [/(^|\.)modus$/i, "M05"],
];

function numberFor(name: string, s: J, def: unknown): number {
  let v = NUM_HINTS.find(([re]) => re.test(name))?.[1] ?? (typeof def === "number" ? def : 1);
  if (typeof s.minimum === "number" && v < s.minimum) v = s.minimum;
  if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) v = s.exclusiveMinimum + (s.type === "integer" ? 1 : 0.1);
  if (typeof s.maximum === "number" && v > s.maximum) v = s.maximum;
  return s.type === "integer" ? Math.round(v) : v;
}

function stringFor(name: string, s: J, def: unknown): string {
  if (s.format === "date") return /pulang/i.test(name) ? "2026-11-05" : "2026-11-02";
  if (s.format === "date-time") return "2026-11-02T08:30:00+07:00";
  if (s.contentMediaType || s.format === "binary") return "@klaim.csv";
  let v = typeof def === "string" && def ? def : (STR_HINTS.find(([re]) => re.test(name))?.[1] ?? "string");
  if (typeof s.minLength === "number" && v.length < s.minLength) v = v.padEnd(s.minLength, "0");
  if (typeof s.maxLength === "number" && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

// ------------------------------------------------------------------------------------------------ the slim spec

function slim(spec: Spec): ApiDocs {
  const schemas = spec.components?.schemas ?? {};
  const refName = (s: J): string | null => (typeof s.$ref === "string" ? s.$ref.split("/").pop() ?? null : null);
  const deref = (s: unknown): J => {
    let x = (s ?? {}) as J;
    for (let i = 0; i < 8; i++) {
      const n = refName(x);
      if (!n) break;
      x = schemas[n] ?? {};
    }
    return x;
  };
  /** the non-null alternatives of a schema (Optional[X] is anyOf [X, null]) */
  const branches = (s: J): { alts: J[]; nullable: boolean } => {
    const list = (s.anyOf ?? s.oneOf) as J[] | undefined;
    if (Array.isArray(list)) {
      const alts = list.filter((b) => b.type !== "null");
      return { alts, nullable: alts.length < list.length };
    }
    if (Array.isArray(s.allOf) && s.allOf.length === 1) return branches(s.allOf[0] as J);
    if (Array.isArray(s.type)) {
      const t = (s.type as string[]).filter((x) => x !== "null");
      return { alts: [{ ...s, type: t.length === 1 ? t[0] : t }], nullable: t.length < s.type.length };
    }
    return { alts: [s], nullable: false };
  };

  const typeOf = (raw: J, depth = 0): string => {
    if (depth > 4) return "object";
    const { alts } = branches(raw);
    if (alts.length > 1) return [...new Set(alts.map((a) => typeOf(a, depth + 1)))].join(" | ");
    const a = alts[0] ?? {};
    const name = refName(a);
    const s = deref(a);
    if (s.const !== undefined) return typeof s.const;
    if (s.type === "array") return `${typeOf((s.items ?? {}) as J, depth + 1)}[]`;
    if (name && (s.properties || s.type === "object")) return cleanName(name);
    if (s.contentMediaType || s.format === "binary") return "file";
    if (s.format === "date" || s.format === "date-time") return String(s.format);
    if (typeof s.type === "string") return s.type;
    if (s.properties) return "object";
    return "any";
  };

  const enumOf = (raw: J): Scalar[] | undefined => {
    const { alts } = branches(raw);
    if (alts.length !== 1) return undefined;
    let s = deref(alts[0]);
    if (s.type === "array" && s.items) s = deref(branches(s.items as J).alts[0] ?? {});
    if (Array.isArray(s.enum)) return (s.enum as Scalar[]).slice(0, 12);
    if (s.const !== undefined) return [s.const as Scalar];
    return undefined;
  };

  /** the object behind a field: itself, its non-null branch, or the items of its array */
  const objectOf = (raw: J): J | null => {
    const { alts } = branches(raw);
    if (alts.length !== 1) return null;
    let s = deref(alts[0]);
    if (s.type === "array" && s.items) s = deref(branches(s.items as J).alts[0] ?? {});
    return s.properties ? s : null;
  };

  /** a range, a length or a pattern from the schema, for the reference pages */
  const batasOf = (raw: J): string | undefined => {
    const s = deref(branches(raw).alts[0] ?? raw);
    const out: string[] = [];
    const lo = typeof s.exclusiveMinimum === "number" ? `${s.exclusiveMinimum} <` : typeof s.minimum === "number" ? `${s.minimum} ≤` : "";
    const hi = typeof s.exclusiveMaximum === "number" ? `< ${s.exclusiveMaximum}` : typeof s.maximum === "number" ? `≤ ${s.maximum}` : "";
    if (lo || hi) out.push(`${lo} x ${hi}`.trim());
    if (typeof s.maxLength === "number") out.push(`≤ ${s.maxLength} karakter`);
    if (typeof s.pattern === "string") out.push(`pola ${s.pattern}`);
    return out.length ? out.join(" · ") : undefined;
  };

  const fieldsOf = (obj: J, depth: number): DocField[] => {
    const props = (obj.properties ?? {}) as Record<string, J>;
    const req = new Set((obj.required ?? []) as string[]);
    return Object.entries(props).map(([name, p]) => {
      const f: DocField = { name, type: typeOf(p), required: req.has(name) };
      if (branches(p).nullable) f.nullable = true;
      const desc = clean(p.description);
      if (desc) f.description = firstSentence(desc);
      const en = enumOf(p);
      if (en) f.enum = en;
      const def = p.default;
      if (def !== undefined && def !== null && def !== "" && !(Array.isArray(def) && def.length === 0)) f.default = def;
      const b = batasOf(p);
      if (b) f.batas = b;
      if (depth < 1) {
        const o = objectOf(p);
        if (o) {
          const ch = fieldsOf(o, depth + 1);
          if (ch.length) f.children = ch;
        }
      }
      return f;
    });
  };

  /** a sample value from a schema; `at` is the field's dotted path in the body ("" for the body itself) */
  const sample = (raw: J, at: string, mode: "minimal" | "lengkap", depth = 0): unknown => {
    const { alts } = branches(raw);
    const s = deref(alts[0] ?? {});
    const def = raw.default !== undefined ? raw.default : s.default;
    if (s.const !== undefined) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return def !== undefined && s.enum.includes(def) ? def : s.enum[0];
    if (s.type === "array") return depth >= 4 ? [] : [sample((s.items ?? {}) as J, at, mode, depth + 1)];
    if (s.properties) {
      if (depth >= 4) return {};
      const req = new Set((s.required ?? []) as string[]);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties as Record<string, J>)) {
        if (mode === "lengkap" || req.has(k)) out[k] = sample(v, at ? `${at}.${k}` : k, mode, depth + 1);
      }
      return out;
    }
    if (s.type === "object") return {};
    if (s.type === "boolean") return typeof def === "boolean" ? def : false;
    if (s.type === "integer" || s.type === "number") return numberFor(at, s, def);
    if (s.type === "string" || s.format || s.contentMediaType) return stringFor(at, s, def);
    return def ?? null;
  };

  /** list[dict] fields typed by the schema the handler validates them with */
  const withItems = (obj: J, hints?: Record<string, string>): J => {
    if (!hints || !obj.properties) return obj;
    const props = { ...(obj.properties as Record<string, J>) };
    for (const [k, n] of Object.entries(hints)) if (props[k] && schemas[n]) props[k] = { ...props[k], items: { $ref: `#/components/schemas/${n}` } };
    return { ...obj, properties: props };
  };

  const bodyOf = (op: J, key: string): DocBody | null => {
    const rb = op.requestBody as J | undefined;
    const content = (rb?.content ?? {}) as Record<string, J>;
    const first = Object.entries(content)[0];
    if (!rb || !first) return null;
    const [contentType, media] = first;
    const { alts, nullable } = branches((media.schema ?? {}) as J);
    const variants: DocVariant[] = alts.map((a) => {
      const obj = withItems(deref(a), ITEM_SCHEMA[key]);
      const ref = cleanName(refName(a) ?? "");
      const v: DocVariant = {
        // FastAPI names a form body Body_<handler>_<path>: "form" says the same
        name: ref.startsWith("Body_") ? "form" : ref || typeOf(a),
        fields: obj.properties ? fieldsOf(obj, 0) : [],
        minimal: sample(obj, "", "minimal"),
        lengkap: sample(obj, "", "lengkap"),
      };
      const desc = clean(obj.description);
      if (desc) v.description = firstSentence(desc);
      return v;
    });
    return { contentType, required: Boolean(rb.required) && !nullable, variants };
  };

  const responseOf = (op: J, auth: ApiAuth, key: string): DocResponse => {
    const responses = (op.responses ?? {}) as Record<string, J>;
    const codes = new Set(Object.keys(responses));
    if (auth === "token faskes") { codes.add("401"); codes.add("503"); }
    else codes.add("401");
    if (auth === "admin") codes.add("403");
    const ok = responses["200"] ?? responses["201"];
    const schema = ((ok?.content as Record<string, J> | undefined)?.["application/json"]?.schema ?? null) as J | null;
    const obj = schema ? objectOf(schema) : null;
    const hint = RESPONSE_HINTS[key];
    const fields = obj ? fieldsOf(obj, 0) : (hint ?? []);
    const out: DocResponse = { codes: [...codes].sort(), type: schema ? typeOf(schema) : "—", fields };
    if (!obj && hint) out.dariKode = true;
    // a sample body for the reference page: from the schema, or from the handler's fields
    if (obj) out.contoh = sample(schema as J, "", "lengkap");
    else if (hint) out.contoh = sampleFields(hint, "");
    return out;
  };

  /** a sample body from the handler's fields (RESPONSE_HINTS), with the same illustrative values */
  const sampleFields = (fields: DocField[], at: string): Record<string, unknown> => Object.fromEntries(fields.map((f) => {
    const name = at ? `${at}.${f.name}` : f.name;
    const many = f.type.endsWith("[]");
    const base = many ? f.type.slice(0, -2) : f.type;
    let v: unknown;
    if (f.children?.length) v = sampleFields(f.children, name);
    else if (f.enum?.length) v = f.enum[0];
    else if (base === "integer" || base === "number") v = numberFor(name, { type: base }, f.default);
    else if (base === "boolean") v = false;
    else if (base === "date-time" || base === "date") v = stringFor(name, { format: base }, undefined);
    else if (base === "object") v = {};
    else v = stringFor(name, {}, f.default);
    return [f.name, many ? [v] : v];
  }));

  const paramsOf = (op: J): DocParam[] =>
    ((op.parameters ?? []) as J[])
      .filter((p) => String(p.name).toLowerCase() !== "x-ingest-token")
      .map((p) => {
        const s = (p.schema ?? {}) as J;
        const out: DocParam = { name: String(p.name), in: p.in as DocParam["in"], type: typeOf(s), required: Boolean(p.required) };
        const desc = clean(p.description);
        if (desc) out.description = firstSentence(desc);
        const en = enumOf(s);
        if (en) out.enum = en;
        if (s.default !== undefined && s.default !== null && s.default !== "") out.default = s.default;
        const b = batasOf(s);
        if (b) out.batas = b;
        return out;
      });

  const groups = new Map<ApiGroupKey, DocEndpoint[]>(GROUPS.map(([k]) => [k, []]));
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const g = groupOf(path);
    if (!g) continue;
    for (const m of METHODS) {
      const op = (item as Record<string, J>)[m];
      if (!op) continue;
      const method = m.toUpperCase();
      const key = `${method} ${path}`;
      const header = ((op.parameters ?? []) as J[]).some((p) => String(p.name).toLowerCase() === "x-ingest-token");
      const auth: ApiAuth = header || TOKEN_FASKES.some((p) => path.startsWith(p)) ? "token faskes"
        : ADMIN.has(key) || (method === "POST" && ADMIN_RULE.test(path)) ? "admin" : "login";
      groups.get(g)!.push({
        id: key, method, path, summary: clean(op.summary) || path, line: firstSentence(clean(op.description)), auth,
        params: paramsOf(op), body: bodyOf(op, key), response: responseOf(op, auth, key),
      });
    }
  }
  const rank = (e: DocEndpoint) => { const i = ORDER_FASKES.indexOf(e.path); return i < 0 ? ORDER_FASKES.length : i; };
  groups.get("faskes")!.sort((a, b) => rank(a) - rank(b));

  const out: DocGroup[] = GROUPS.map(([key, label]) => ({ key, label, endpoints: groups.get(key)! })).filter((g) => g.endpoints.length > 0);
  return {
    openapi: spec.openapi ?? "", version: spec.info?.version ?? "", pathsTotal: Object.keys(spec.paths ?? {}).length,
    groups: out, ruleEngine: (groups.get("rule") ?? []).length > 0, diambil: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------------------------------------ cache and route

let cache: { at: number; data: ApiDocs } | null = null;
let inflight: Promise<ApiDocs> | null = null;

async function load(): Promise<ApiDocs> {
  const res = await fetch(`${API}/openapi.json`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`API menjawab ${res.status}`);
  return slim((await res.json()) as Spec);
}

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat API Documentation." }, { status: 401 });
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const p = (inflight ??= load().finally(() => { inflight = null; }));
    try {
      cache = { at: Date.now(), data: await p };
    } catch (e) {
      if (!cache) {
        const why = e instanceof Error ? e.message : String(e);
        return Response.json({ error: `Spesifikasi API tidak terbaca (${why}). Pastikan API berjalan, lalu muat ulang.` }, { status: 502 });
      }
      return Response.json({ ...cache.data, stale: true }, { headers: { "cache-control": "no-store" } });
    }
  }
  return Response.json(cache.data, { headers: { "cache-control": "no-store" } });
}
