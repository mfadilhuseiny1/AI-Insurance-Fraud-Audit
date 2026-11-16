import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { signedIn } from "@/lib/sessionCheck";
import type {
  CabangAuth, CabangDocs, CabangEndpoint, CabangKeamanan, CabangLangkah, CabangRespons, CabangStatus, CabangTahap, CabangTahapKey,
  DocField, DocParam, Scalar,
} from "@/components/aip/ApiDocsTypes";

/*
 * API Documentation · AI Agent Swarm Branch API v1 (the user, 2026-11-14: "rancang skema API-nya biar modular ... masukin ke API
 * documentation kita, jadi tiap KC bisa pakai API kita buat running audit"). Unlike the other groups (read live from the API's
 * /openapi.json), this one is a design spec: docs/openapi_cabang_v1.json, where most endpoints are still planned. Each operation
 * says so itself (x-status aktif | rencana, x-hari-ini = today's stand-in), so the tab never claims what does not exist.
 *   GET /api/api-docs/cabang                  the slim spec for the tab: stages, endpoints, fields, every status with its example
 *   GET /api/api-docs/cabang?format=openapi   the OpenAPI 3.1 file itself (a download for a KC developer)
 * Re-read when the file changes. Signed-in users only. Narrative: docs/API_CABANG_V1.md.
 * The reference pages (2026-11-15, "like Runpod's API reference") show each field of a body or a response with its type, its
 * enum and its limits, so the schemas are read here too: $refs resolved, oneOf objects merged, two nested levels.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = path.join(process.env.BLUESANDAI_DOCS_DIR ?? path.join(process.cwd(), "..", "docs"), "openapi_cabang_v1.json");
const METHODS = ["get", "post", "put", "patch", "delete"];
// a safety net: no model or framework brand in the tab (the spec is written without them)
const BRANDS = /\b(openai|chatgpt|gemini|claude|anthropic|deepseek|vertex(?: ai)?|google adk|adk|openrouter|qwen|llama|mistral)\b/gi;

type J = Record<string, unknown>;

function bersih<T>(v: T): T {
  if (typeof v === "string") return v.replace(BRANDS, "Model AI (LLM)") as T;
  if (Array.isArray(v)) return v.map(bersih) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as J).map(([k, x]) => [k, bersih(x)])) as T;
  return v;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const exampleOf = (content: unknown): unknown => ((content as J | undefined)?.["application/json"] as J | undefined)?.example;

// ------------------------------------------------------------------------------------------------ schemas → fields

function skema(spec: J) {
  const comp = (spec.components ?? {}) as Record<string, Record<string, J>>;
  /** "#/components/<kind>/<name>" → the object; anything else as it is */
  const deref = (s: unknown): J => {
    let x = (s ?? {}) as J;
    for (let i = 0; i < 8 && typeof x.$ref === "string"; i++) {
      const [, , kind, name] = x.$ref.split("/");
      x = comp[kind]?.[name] ?? {};
    }
    return x;
  };
  const alts = (s: J): J[] => ((s.oneOf ?? s.anyOf) as J[] | undefined)?.map(deref).filter((a) => a.type !== "null") ?? [];

  const typeOf = (raw: unknown, d = 0): string => {
    const s = deref(raw);
    if (d > 4) return "object";
    const al = alts(s);
    if (al.length) {
      if (al.every((a) => a.properties)) return "object";
      return [...new Set(al.map((a) => typeOf(a, d + 1)))].join(" | ");
    }
    if (Array.isArray(s.enum)) return `enum<${typeof s.type === "string" ? s.type : typeof s.enum[0]}>`;
    if (s.const !== undefined) return `enum<${typeof s.const}>`;
    if (s.type === "array") return `${typeOf(s.items ?? {}, d + 1)}[]`;
    if (Array.isArray(s.type)) return (s.type as string[]).filter((t) => t !== "null").join(" | ");
    if (typeof s.type === "string") return s.format && s.type === "string" ? `string<${String(s.format)}>` : s.type;
    if (s.properties) return "object";
    return "any";
  };

  const enumOf = (raw: unknown): Scalar[] | undefined => {
    const s = deref(raw);
    if (Array.isArray(s.enum)) return s.enum as Scalar[];
    if (s.const !== undefined) return [s.const as Scalar];
    if (s.type === "array") return enumOf(s.items);
    const al = alts(s);
    if (al.length && !al.every((a) => a.properties)) {
      const all = al.flatMap((a) => enumOf(a) ?? []);
      return all.length ? [...new Set(all)] : undefined;
    }
    return undefined;
  };

  const batasOf = (raw: unknown): string | undefined => {
    const s = deref(raw);
    const out: string[] = [];
    const lo = typeof s.exclusiveMinimum === "number" ? `${s.exclusiveMinimum} <` : typeof s.minimum === "number" ? `${s.minimum} ≤` : "";
    const hi = typeof s.exclusiveMaximum === "number" ? `< ${s.exclusiveMaximum}` : typeof s.maximum === "number" ? `≤ ${s.maximum}` : "";
    if (lo || hi) out.push(`${lo} x ${hi}`.trim());
    if (typeof s.maxLength === "number") out.push(`≤ ${s.maxLength} karakter`);
    if (typeof s.minItems === "number" && s.minItems > 0) out.push(`≥ ${s.minItems} butir`);
    if (typeof s.maxItems === "number") out.push(`≤ ${s.maxItems} butir`);
    if (typeof s.pattern === "string") out.push(`pola ${s.pattern}`);
    return out.length ? out.join(" · ") : undefined;
  };

  /** the object behind a field: itself, its array's items, or its oneOf objects merged (required = required in each) */
  const objectOf = (raw: unknown): J | null => {
    let s = deref(raw);
    if (s.type === "array") s = deref(s.items);
    if (s.properties) return s;
    const al = alts(s).map((a) => (a.type === "array" ? deref(a.items) : a)).filter((a) => a.properties);
    if (!al.length) return null;
    const props: Record<string, J> = {};
    for (const a of al) Object.assign(props, a.properties as Record<string, J>);
    const req = Object.keys(props).filter((k) => al.every((a) => ((a.required ?? []) as string[]).includes(k)));
    return { type: "object", properties: props, required: req };
  };

  const fieldsOf = (obj: J, d = 0): DocField[] => {
    const props = (obj.properties ?? {}) as Record<string, J>;
    const req = new Set((obj.required ?? []) as string[]);
    return Object.entries(props).map(([name, raw]) => {
      const s = deref(raw);
      const f: DocField = { name, type: typeOf(raw), required: req.has(name) };
      const desc = str(raw.description) || str(s.description);
      if (desc) f.description = desc;
      const en = enumOf(raw);
      if (en && en.length) f.enum = en.slice(0, 24);
      const def = raw.default ?? s.default;
      if (def !== undefined && def !== null && def !== "") f.default = def;
      const b = batasOf(raw);
      if (b) f.batas = b;
      if (Array.isArray(s.type) && s.type.includes("null")) f.nullable = true;
      const al = alts(s);
      if (al.length && al.every((a) => a.properties)) {
        const jenis = al.map((a) => (a.properties as Record<string, J>).jenis?.const).filter((x) => typeof x === "string");
        if (jenis.length === al.length) f.description = [f.description, `Salah satu bentuk, dibedakan oleh jenis: ${jenis.join(" · ")}.`].filter(Boolean).join(" ");
      }
      if (d < 2) {
        const o = objectOf(raw);
        if (o) {
          const ch = fieldsOf(o, d + 1);
          if (ch.length) f.children = ch;
        }
      }
      return f;
    });
  };

  const paramOf = (raw: unknown): DocParam | null => {
    const p = deref(raw);
    if (typeof p.name !== "string") return null;
    const s = (p.schema ?? {}) as J;
    const out: DocParam = { name: p.name, in: String(p.in) as DocParam["in"], type: typeOf(s), required: Boolean(p.required) };
    if (str(p.description)) out.description = str(p.description);
    const en = enumOf(s);
    if (en && en.length) out.enum = en.slice(0, 24);
    const def = deref(s).default;
    if (def !== undefined && def !== null && def !== "") out.default = def;
    const b = batasOf(s);
    if (b) out.batas = b;
    return out;
  };

  const bodyOf = (op: J): CabangEndpoint["body"] => {
    const rb = deref(op.requestBody);
    const first = Object.entries((rb.content ?? {}) as Record<string, J>)[0];
    if (!first) return null;
    const [contentType, media] = first;
    const sch = deref(media.schema);
    const obj = objectOf(media.schema);
    return { contentType, required: Boolean(rb.required), description: str(sch.description) || undefined, fields: obj ? fieldsOf(obj) : [] };
  };

  const responsOf = (op: J): CabangRespons[] => Object.entries((op.responses ?? {}) as Record<string, J>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kode, raw]) => {
      const r = deref(raw);
      const media = ((r.content ?? {}) as Record<string, J>)["application/json"];
      const obj = media ? objectOf(media.schema) : null;
      return { kode, ket: str(r.description), type: media ? typeOf(media.schema) : "—", fields: obj ? fieldsOf(obj) : [], contoh: media?.example };
    });

  return { paramOf, bodyOf, responsOf };
}

// ------------------------------------------------------------------------------------------------ the slim spec

function slim(spec: J, mtime: number): CabangDocs {
  const info = (spec.info ?? {}) as J;
  const { paramOf, bodyOf, responsOf } = skema(spec);
  const tahapDef = (spec["x-tahap"] ?? []) as { key: CabangTahapKey; nama: string; ringkas: string }[];
  const tahap: CabangTahap[] = tahapDef.map((t) => ({ ...t, endpoints: [] }));
  const byKey = new Map(tahap.map((t) => [t.key, t]));
  let aktif = 0, rencana = 0;
  for (const [p, item] of Object.entries((spec.paths ?? {}) as Record<string, J>)) {
    for (const m of METHODS) {
      const op = item[m] as J | undefined;
      if (!op) continue;
      const status: CabangStatus = op["x-status"] === "aktif" ? "aktif" : "rencana";
      if (status === "aktif") aktif++; else rencana++;
      const respons = responsOf(op);
      const kodeOk = respons.find((r) => r.kode.startsWith("2"))?.kode ?? "200";
      const method = m.toUpperCase();
      const e: CabangEndpoint = {
        id: `${method} ${p}`, method, path: p, tahap: op["x-tahap"] as CabangTahapKey, summary: str(op.summary), line: str(op.description),
        status, auth: (op["x-auth"] ?? []) as CabangAuth[], scopes: (op["x-scopes"] ?? []) as string[],
        kirim: str(op["x-kirim"]), dapat: str(op["x-dapat"]), hariIni: str(op["x-hari-ini"]) || undefined,
        params: ((op.parameters ?? []) as J[]).map(paramOf).filter((x): x is DocParam => x !== null),
        contohKirim: exampleOf((op.requestBody as J | undefined)?.content),
        kodeOk, contohDapat: respons.find((r) => r.kode === kodeOk)?.contoh,
        galat: respons.map((r) => r.kode).filter((c) => !c.startsWith("2")),
        body: bodyOf(op), respons,
      };
      byKey.get(e.tahap)?.endpoints.push(e);
    }
  }
  const schemes = ((spec.components as J | undefined)?.securitySchemes ?? {}) as Record<string, J>;
  const keamanan: CabangKeamanan[] = Object.entries(schemes).map(([kunci, s]) => ({
    kunci, jenis: str(s.type), di: str(s.in) || "header", nama: str(s.name) || "Authorization",
    format: str(s.bearerFormat) || undefined, ket: str(s.description),
  }));
  return bersih({
    judul: str(info.title), versi: str(info.version), openapi: str(spec.openapi), ringkas: str(info.summary), basis: "/api/aip/cabang/v1",
    tahap, mulaiCepat: ((spec["x-mulai-cepat"] ?? []) as J[]).map((l): CabangLangkah => ({
      judul: str(l.judul), teks: str(l.teks), endpoint: (l.endpoint ?? []) as string[], hariIni: str(l.hari_ini) || undefined,
    })),
    jumlah: { aktif, rencana }, diambil: new Date().toISOString(),
    deskripsi: str(info.description), konvensi: (spec["x-konvensi"] ?? {}) as Record<string, string>, keamanan,
    diperbarui: new Date(mtime).toISOString(),
  });
}

let cache: { mtime: number; raw: string; data: CabangDocs } | null = null;

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Masuk dulu untuk melihat API Documentation." }, { status: 401 });
  try {
    const mtime = (await stat(FILE)).mtimeMs;
    if (!cache || cache.mtime !== mtime) {
      const raw = await readFile(FILE, "utf-8");
      cache = { mtime, raw, data: slim(JSON.parse(raw) as J, mtime) };
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `Spesifikasi AI Agent Swarm Branch API tidak terbaca (${why}).` }, { status: 500 });
  }
  if (new URL(request.url).searchParams.get("format") === "openapi") {
    return new Response(cache.raw, {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="openapi_cabang_v1.json"', "cache-control": "no-store" },
    });
  }
  return Response.json(cache.data, { headers: { "cache-control": "no-store" } });
}
