/*
 * The TypeScript functions runtime behind the SDK shims: Ontology reads through the platform API with the run's job
 * token, object sets, edit batches, staged writes and the JSON wire format shared with the Python runtime
 * ({"__object__": …}, {"__object_set__": …}, edits as {op, object_type_id, primary_key, properties}).
 */
"use strict";

const API = (process.env.BLUESANDAI_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const TOKEN = process.env.BLUESANDAI_API_TOKEN || "";
// nested staged writes: the transaction of the run that called this one (functions_ts passes it, so a run without a
// signed-in user — no job token — still joins the caller's transaction)
const STAGED_PARENT = process.env.BLUESANDAI_STAGED_PARENT || "";
let STAGED_SID = null;
// the running staged-write transaction ({sid, batch}) and the first failure of a call made inside it
let STAGED = null;
let STAGED_FAILED = null;

async function call(p, body, method) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (STAGED_SID && !p.startsWith("/api/ontology/staged-writes")) headers["x-bluesandai-scenario"] = STAGED_SID;
  // called inside an Ontology scenario: reads and writes stay in it
  else if (process.env.BLUESANDAI_SCENARIO && !p.startsWith("/api/ontology/staged-writes")) headers["x-bluesandai-scenario"] = process.env.BLUESANDAI_SCENARIO;
  if (process.env.BLUESANDAI_SNAPSHOT) headers["x-bluesandai-snapshot"] = process.env.BLUESANDAI_SNAPSHOT;
  const r = await fetch(API + p, { method: method || (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).detail || text;
    } catch {}
    throw new Error(`Ontology request failed (${r.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return text ? JSON.parse(text) : null;
}

let TYPES = null;
let LINKS = null;
/**
 * The object types the caller can see. functions_ts writes them next to the run (BLUESANDAI_TS_TYPES, the listing
 * without its per-type counts, which take seconds on a large Ontology); without that file, the API's listing.
 */
async function types() {
  if (!TYPES && process.env.BLUESANDAI_TS_TYPES) {
    try {
      TYPES = JSON.parse(require("fs").readFileSync(process.env.BLUESANDAI_TS_TYPES, "utf8"));
    } catch {
      TYPES = null;
    }
  }
  TYPES = TYPES || (await call("/api/ontology/object-types"));
  return TYPES;
}
async function links() {
  LINKS = LINKS || (await call("/api/ontology/link-types"));
  return LINKS;
}
const apiOf = (t) => (t && typeof t === "object" ? t.apiName : String(t));
/** The object type of a name or descriptor among the loaded types (null when unknown or not loaded yet). */
function typeSync(ref) {
  const name = apiOf(ref);
  return (TYPES || []).find((x) => x.api_name === name || x.id === name || x.api_name.toLowerCase() === String(name).toLowerCase()) || null;
}
async function typeOf(ref) {
  await types();
  const t = typeSync(ref);
  if (!t) throw new Error(`no object type ${apiOf(ref)}`);
  return t;
}

// ------------------------------------------------------------------ interfaces
//
// TypeScript v2 interfaces: Osdk.Instance<Interface> inputs (the interface's properties read through the implementing
// type's mapping, $objectType the concrete type, $as(Type) the object) and edits through an interface
// (Edits.Interface<I>): update / create / delete set the properties (or struct fields) the implementing type maps the
// interface's properties to; the property its primary key implements cannot be updated.

let IFACES = null;
async function interfaces() {
  IFACES = IFACES || (await call("/api/ontology/interfaces"));
  return IFACES;
}
const norm = (s) => String(s).replace(/[_\s-]/g, "").toLowerCase();
function ifaceSync(ref) {
  const name = apiOf(ref);
  return (IFACES || []).find((i) => i.api_name === name || i.id === name || norm(i.api_name) === norm(name)) || null;
}
async function ifaceOf(ref) {
  await interfaces();
  return ifaceSync(ref);
}
/** An interface and every interface it extends (transitively). */
function lineage(id) {
  const out = new Set();
  const todo = [id];
  while (todo.length) {
    const x = todo.pop();
    if (!x || out.has(x)) continue;
    out.add(x);
    const rec = (IFACES || []).find((i) => i.id === x);
    todo.push(...((rec && rec.extends) || []));
  }
  return out;
}
/** How object type t implements interface i (directly, or through an interface extending it); null when it does not. */
function implementationOf(t, i) {
  return (t.implements || []).find((imp) => lineage(imp.interface_id).has(i.id)) || null;
}
function ifaceProp(i, name) {
  const p = (i.all_properties || i.properties || []).find((x) => x.api_name === name || norm(x.api_name) === norm(name));
  if (!p) throw new TypeError(`${i.api_name} has no property ${name}`);
  return p.api_name;
}
/** A property value under an implementation's mapping: a property, or a struct field ("prop.field"). */
function mappedValue(t, props, local) {
  if (local in props) return props[local];
  const dot = local.indexOf(".");
  if (dot > 0 && !(t.properties || []).some((p) => p.api_name === local)) {
    const s = props[local.slice(0, dot)];
    return s && typeof s === "object" ? s[local.slice(dot + 1)] : undefined;
  }
  return undefined;
}

/** An object seen through an interface: the interface's properties, $objectType its type, $as(Type) the object. */
function ifaceInstance(t, i, pub) {
  const imp = implementationOf(t, i) || {};
  const props = pub.properties || {};
  const o = { $apiName: i.api_name, $objectType: t.api_name, $primaryKey: pub.primary_key, $title: pub.title };
  for (const [ip, local] of Object.entries(imp.mapping || {})) o[ip] = mappedValue(t, props, local);
  Object.defineProperty(o, "__pub", { value: { object_type_id: pub.object_type_id || t.id, primary_key: pub.primary_key, title: pub.title }, enumerable: false });
  Object.defineProperty(o, "__iface", { value: i.api_name, enumerable: false });
  Object.defineProperty(o, "$as", {
    value: (type) => {
      const want = apiOf(type);
      if (want !== t.api_name && want !== t.id) throw new TypeError(`this ${i.api_name} is a ${t.api_name}, not a ${want}`);
      return instance(t, pub);
    },
    enumerable: false,
  });
  return o;
}

/**
 * An edit through an interface as an edit of the implementing object type: {t, props, structs} (structs: struct
 * fields to merge into the struct's current value). Synchronous: the types and interfaces must be loaded.
 */
function viaInterface(i, typeName, props, op) {
  if (!typeName)
    throw new TypeError(op === "create" ? `creating through the interface ${i.api_name} needs $objectType: <an implementing object type>` : `${i.api_name}: pass an object of the interface, or { $apiName, $objectType, $primaryKey }`);
  const t = typeSync(typeName);
  if (!t) throw new TypeError(`no object type ${typeName}`);
  const imp = implementationOf(t, i);
  if (!imp) throw new TypeError(`${t.api_name} does not implement the interface ${i.api_name}`);
  const mapping = imp.mapping || {};
  const out = {};
  const structs = {};
  for (const [k, raw] of Object.entries(props || {})) {
    if (k.startsWith("$") || raw === undefined) continue;
    const ip = ifaceProp(i, k);
    const local = mapping[ip];
    if (!local) throw new TypeError(`${t.api_name} does not map the interface property ${i.api_name}.${ip}`);
    if (local === t.primary_key && op !== "create") throw new TypeError(`${i.api_name}.${ip} is implemented by the primary key of ${t.api_name}: it cannot be updated`);
    const v = raw instanceof Date ? raw.toISOString() : raw instanceof CipherText ? raw.value : raw;
    const dot = local.indexOf(".");
    if (dot > 0 && !(t.properties || []).some((p) => p.api_name === local)) {
      const sp = local.slice(0, dot);
      structs[sp] = { ...(structs[sp] || {}), [local.slice(dot + 1)]: v };
    } else out[local] = v;
  }
  if (op === "create") {
    const pkProp = Object.keys(mapping).find((ip) => mapping[ip] === t.primary_key);
    if (!pkProp || out[t.primary_key] === undefined || out[t.primary_key] === null)
      throw new TypeError(`creating a ${t.api_name} through ${i.api_name} needs ` + (pkProp ? `${pkProp} (implemented by its primary key ${t.primary_key})` : `an interface property implemented by its primary key ${t.primary_key} (none is mapped)`));
  }
  return { t, props: out, structs };
}

// OSDK v2 time series properties: relative ranges ({ $before / $after: n, $unit }) or absolute ({ $startTime, $endTime })
const UNIT_MS = { ms: 1, milliseconds: 1, sec: 1e3, seconds: 1e3, second: 1e3, min: 6e4, minute: 6e4, minutes: 6e4, hr: 36e5, hour: 36e5, hours: 36e5,
  day: 864e5, days: 864e5, week: 6048e5, weeks: 6048e5, month: 2592e6, months: 2592e6, year: 31536e6, years: 31536e6 };
function rangeOf(q) {
  if (!q) return {};
  if (q.$startTime || q.$endTime) return { start: q.$startTime, end: q.$endTime };
  const n = q.$before ?? q.$after;
  if (n === undefined) return {};
  const ms = n * (UNIT_MS[String(q.$unit || "day").toLowerCase()] ?? 864e5);
  const now = Date.now();
  return q.$before !== undefined ? { start: new Date(now - ms).toISOString(), end: new Date(now).toISOString() } : { start: new Date(now).toISOString(), end: new Date(now + ms).toISOString() };
}
class TimeSeriesProperty {
  constructor(t, pk, property) {
    Object.defineProperty(this, "_ref", { value: { t, pk, property }, enumerable: false });
  }
  async _points(q) {
    const { t, pk, property } = this._ref;
    const r = rangeOf(q);
    const qs = new URLSearchParams({ property, raw: "true", resource: "function", ...(r.start ? { start: r.start } : {}), ...(r.end ? { end: r.end } : {}) });
    const res = await call(`/api/timeseries/objects/${t.id}/${encodeURIComponent(String(pk))}/series?${qs}`);
    return (res.points || []).map((p) => ({ time: p.t, value: p.value }));
  }
  async getFirstPoint() {
    return (await this._points())[0];
  }
  async getLastPoint() {
    const pts = await this._points();
    return pts[pts.length - 1];
  }
  async getAllPoints(query) {
    return this._points(query);
  }
  async *asyncIterPoints(query) {
    for (const p of await this._points(query)) yield p;
  }
}

// ------------------------------------------------------------------ Cipher

const CIPHER_VALUE = /^CIPHER::(ri\.bellaso\.main\.cipher-channel\.[A-Za-z0-9-]+)::[A-Za-z0-9_\-=]+::CIPHER$/;
// edits made by CipherText.updateAsync: returned with the function's edits
const IMPLICIT = [];

/** The caller's Operational User license for an operation on a channel (the first usable one). */
async function cipherLicense(channelRid, operation) {
  const qs = new URLSearchParams({ usable_for: operation, channel: channelRid, kind: "operational" });
  const list = await call(`/api/cipher/licenses?${qs}`);
  if (!list || !list.length) throw new Error(`no Operational User license allows ${operation} on ${channelRid}`);
  return list[0];
}

async function cipherOperate(channelRid, operation, value, context) {
  const lic = await cipherLicense(channelRid, operation);
  const lid = String(lic.rid || lic.id).split(".").pop();
  return (await call(`/api/cipher/licenses/${encodeURIComponent(lid)}/operate`, { operation, value, context })).value;
}

/** A CipherText property value: the encrypted text, decrypted or replaced with the caller's Operational license. */
class CipherText {
  constructor(value, ref) {
    this.value = value;
    Object.defineProperty(this, "_ref", { value: ref, enumerable: false, writable: true });
  }
  get channelRid() {
    const m = CIPHER_VALUE.exec(this.value || "");
    return m ? m[1] : null;
  }
  async decryptAsync() {
    if (this.value === null || this.value === undefined) return undefined;
    if (!this.channelRid) return this.value; // not encrypted
    const r = this._ref || {};
    return cipherOperate(this.channelRid, "decrypt", this.value, r.t ? `function: ${r.t.api_name} ${r.pk} ${r.property}` : "function");
  }
  /** Encrypt plaintext on the same channel and edit the object's property (an Ontology edit function's edit). */
  async updateAsync(plaintext) {
    const r = this._ref;
    if (!r || !r.t) throw new Error("updateAsync needs a CipherText property of an object");
    if (!this.channelRid) throw new Error(`${r.t.api_name}.${r.property} holds no encrypted value: its channel is unknown`);
    this.value = await cipherOperate(this.channelRid, "encrypt", plaintext === undefined || plaintext === null ? null : String(plaintext), `function: ${r.t.api_name} ${r.pk} ${r.property}`);
    const e = { type: "updateObject", obj: r.t.api_name, pk: r.pk, properties: { [r.property]: this.value } };
    Object.defineProperty(e, "__bsaiEdit", { value: true, enumerable: false });
    IMPLICIT.push(e);
  }
  toString() {
    return String(this.value);
  }
  toJSON() {
    return this.value;
  }
}

const takeImplicit = () => IMPLICIT.splice(0, IMPLICIT.length);

function instance(t, pub) {
  const tsp = Object.keys((t.time_series && t.time_series.properties) || {});
  const props = { ...(pub.properties || {}) };
  for (const p of tsp) props[p] = new TimeSeriesProperty(t, pub.primary_key, p);
  // CipherText properties (and encrypted values in string properties)
  const kinds = Object.fromEntries((t.properties || []).map((p) => [p.api_name, p.type]));
  for (const [k, v] of Object.entries(props))
    if (kinds[k] === "cipher" || (typeof v === "string" && CIPHER_VALUE.test(v))) props[k] = new CipherText(v, { t, pk: pub.primary_key, property: k });
  const o = { $apiName: t.api_name, $objectType: t.api_name, $primaryKey: pub.primary_key, $title: pub.title, ...props };
  Object.defineProperty(o, "__pub", { value: { object_type_id: pub.object_type_id || t.id, primary_key: pub.primary_key, title: pub.title }, enumerable: false });
  return o;
}

// ------------------------------------------------------------------ where clauses
//
// OSDK v2 where clauses: { prop: value | null | { $op: x } }, $and / $or / $not at any depth. A clause runs as one
// Object Explorer search: its filters AND, an $or / $not goes as the search's and / or / not filter tree, so only the
// matching objects load and each condition keeps the search's own matching (exact equality, case-insensitive
// $contains / $startsWith / terms, arrays matching on any element, geo, interval rules). A part the search cannot take
// (a prefix form, an interval rule over its limit, BLUESANDAI_TS_INTERVAL_LOCAL=1) is checked here: at the top after a
// narrowing search, inside an $or / $not as sets of primary keys (one search per branch, $not against every object of
// the type) — as is every $or / $not with BLUESANDAI_TS_TREE_LOCAL=1.

const OPS = { $eq: "eq", $ne: "neq", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte", $in: "in", $startsWith: "starts_with" };
const UNIT_KM = { km: 1, kilometer: 1, kilometers: 1, kilometres: 1, m: 0.001, meter: 0.001, meters: 0.001, metres: 0.001,
  mi: 1.609344, mile: 1.609344, miles: 1.609344, ft: 0.0003048, foot: 0.0003048, feet: 0.0003048, nmi: 1.852, "nautical miles": 1.852 };

const whereError = (msg) => {
  const e = new TypeError(`where(): ${msg}`);
  e.invalidInput = true;
  return e;
};

/** [lon, lat] (GeoJSON order) of a point: [lon, lat], {type: "Point", coordinates}, {latitude, longitude} or "lat,lon". */
function lonLat(p) {
  if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
  if (p && p.type === "Point" && Array.isArray(p.coordinates)) return lonLat(p.coordinates);
  if (p && typeof p === "object" && p.latitude !== undefined) return [Number(p.longitude), Number(p.latitude)];
  if (typeof p === "string" && p.includes(",")) {
    const [lat, lon] = p.split(",").map(Number);
    return [lon, lat];
  }
  throw whereError(`not a point: ${JSON.stringify(p)}`);
}

/** The Object Explorer geo region of an OSDK $within / $intersects value. */
function geoRegion(v, op) {
  if (v && v.$distance && v.$of !== undefined) {
    const [n, unit] = Array.isArray(v.$distance) ? v.$distance : [v.$distance, "km"];
    const [lon, lat] = lonLat(v.$of);
    const k = UNIT_KM[String(unit || "km").toLowerCase()];
    if (!k) throw whereError(`unknown distance unit ${unit}`);
    return { kind: "distance", lat, lon, km: Number(n) * k };
  }
  const bbox = v && (v.$bbox || (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number") ? v : null));
  if (bbox) return { kind: "bbox", min_lon: bbox[0], min_lat: bbox[1], max_lon: bbox[2], max_lat: bbox[3] };
  const poly = v && (v.$polygon || (v.type === "Polygon" ? v.coordinates : null));
  if (poly) {
    // [[lon, lat], …] or GeoJSON rings [[[lon, lat], …]] (the outer ring)
    const ring = Array.isArray(poly[0]) && Array.isArray(poly[0][0]) ? poly[0] : poly;
    return { kind: "polygon", points: ring.map((p) => lonLat(p)).map(([lon, lat]) => [lat, lon]) };
  }
  throw whereError(`${op} takes { $distance: [n, unit], $of: point }, { $bbox: [minLon, minLat, maxLon, maxLat] } or { $polygon: [...] }`);
}

const termsOf = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x.term ?? x.$term ?? "" : Array.isArray(x) ? x.join(" ") : x);

// the Object Explorer's standard analyzer (ontology_explorer._tokens): lower case, underscores and periods inside a word
const WORD = /[\p{L}\p{N}_.]+/gu;
const wordsOf = (s) => (String(s === null || s === undefined ? "" : s).toLowerCase().match(WORD) || []).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);

/**
 * Terms whose last one also matches words starting with it — in order with nothing between (phrase prefix), or in any
 * order: a node checked on the rows ({check}) after a search that narrows them (the other terms, the last as a
 * substring).
 */
function prefixNode(k, text, inOrder) {
  const q = wordsOf(text);
  if (!q.length) throw whereError(`${k}: the search text has no words`);
  const head = q.slice(0, -1);
  const last = q[q.length - 1];
  const filters = [{ property: k, op: "contains", value: last }];
  if (head.length && inOrder) filters.push({ property: k, op: "phrase", value: head.join(" ") });
  else for (const w of head) filters.push({ property: k, op: "any_word", value: w });
  const one = (v) => {
    const words = wordsOf(v && typeof v === "object" ? Object.values(v).join(" ") : v);
    if (!inOrder) return head.every((w) => words.includes(w)) && words.some((w) => w.startsWith(last));
    for (let i = 0; i + q.length <= words.length; i++) if (head.every((w, j) => words[i + j] === w) && words[i + head.length].startsWith(last)) return true;
    return false;
  };
  const test = (row) => {
    const v = (row.properties || {})[k];
    return Array.isArray(v) ? v.some(one) : v !== null && v !== undefined && one(v);
  };
  return { check: { filters, test } };
}

// $interval rules (the shape of Elasticsearch interval queries, the OSDK's $interval):
//   { $match: text | { $query: text }, $ordered?, $maxGaps?, $prefixOnLastTerm?, $fuzzy?, $fuzziness? }
//     the words of the text, each at its own word of the value; $ordered (default true) in the text's order;
//     $maxGaps: at most that many other words inside the match (default 0 when ordered — a phrase —, no limit otherwise;
//     -1 no limit); $prefixOnLastTerm: the last word also matches words starting with it; $fuzzy / $fuzziness: each word
//     also matches words within an edit distance (0, 1, 2 or "AUTO" — 0 for 1-2 letters, 1 for 3-5, 2 longer; a swap of
//     two neighbouring letters is one edit, as Elasticsearch's fuzzy transpositions); with $prefixOnLastTerm the last word
//     is a prefix, the others fuzzy
//   { $anyOf: [rule, …] }  one of the rules matches
//   { $allOf: [rule, …], $ordered?, $maxGaps? }  every rule matches, their matches not overlapping; $ordered (default
//     false): one after the other in the rules' order; $maxGaps (default no limit): words inside the whole match that no
//     rule's match covers
// $anyOf / $allOf also take { $rules: [rule, …] }. A rule matches when some choice of words satisfies it (every match
// of each nested rule is considered, not only the shortest). These are the Object Explorer search's interval rules
// (ontology_explorer._interval_spans: match / any_of / all_of) with the OSDK defaults made explicit, and they are sent
// to it as its `interval` filter (intervalNode); the evaluation below runs only when the search cannot take a rule.

const INTERVAL_OPTIONS = {
  $match: ["$match", "$prefixOnLastTerm", "$ordered", "$maxGaps", "$fuzzy", "$fuzziness"],
  $anyOf: ["$anyOf"],
  $allOf: ["$allOf", "$ordered", "$maxGaps"],
};
const LEVENSHTEIN = { LEVENSHTEIN_ZERO: 0, LEVENSHTEIN_ONE: 1, LEVENSHTEIN_TWO: 2 };
const INTERVAL_BUDGET = 2000000;
const MAX_UNORDERED = 12;

function maxGapsOf(k, x, dflt) {
  if (x.$maxGaps === undefined) return dflt;
  const g = x.$maxGaps;
  if (!Number.isInteger(g) || g < -1) throw whereError(`${k}: $maxGaps takes a whole number of words (-1 for no limit), got ${JSON.stringify(g)}`);
  return g < 0 ? Infinity : g;
}

/** The edit distance of a $match rule: null (exact words), 0, 1, 2 or "AUTO". */
function fuzzinessOf(k, x) {
  if (x.$fuzzy === undefined && x.$fuzziness === undefined) return null;
  if (x.$fuzzy !== undefined && typeof x.$fuzzy !== "boolean") throw whereError(`${k}: $fuzzy takes true or false`);
  if (x.$fuzzy === false) {
    if (x.$fuzziness !== undefined) throw whereError(`${k}: $fuzziness needs $fuzzy: true (or no $fuzzy)`);
    return null;
  }
  const f = x.$fuzziness === undefined ? "AUTO" : x.$fuzziness;
  if (typeof f === "string" && f.toUpperCase() === "AUTO") return "AUTO";
  if (typeof f === "string" && LEVENSHTEIN[f.toUpperCase()] !== undefined) return LEVENSHTEIN[f.toUpperCase()];
  if (f === 0 || f === 1 || f === 2) return f;
  throw whereError(`${k}: $fuzziness takes 0, 1, 2 or "AUTO", got ${JSON.stringify(f)}`);
}

/**
 * Edit distance of a and b (code points) at most n: insertions, deletions, substitutions and swaps of two neighbouring
 * letters (optimal string alignment, the search's ontology_explorer._edit_distance).
 */
function withinEdits(a, b, n) {
  if (a === b) return true;
  if (!n) return false;
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > n) return false;
  let before = [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
    }
    if (Math.min(...cur) > n) return false;
    before = prev;
    prev = cur;
  }
  return prev[y.length] <= n;
}

/** Can terms `rest` take distinct positions among `free` (term i matching at position p: ok(i, p))? */
function assignable(rest, free, ok) {
  const owner = new Map();
  const place = (i, seen) => {
    for (const p of free) {
      if (seen.has(p) || !ok(i, p)) continue;
      seen.add(p);
      if (!owner.has(p) || place(owner.get(p), seen)) {
        owner.set(p, i);
        return true;
      }
    }
    return false;
  };
  return rest.every((i) => place(i, new Set()));
}

/** The rules of an $anyOf / $allOf: an array, or { $rules: [...] }. */
function rulesOf(k, key, v) {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray(v.$rules) ? v.$rules : null;
  if (!list || !list.length) throw whereError(`${k}: ${key} takes a non-empty array of interval rules`);
  return list;
}

/**
 * One interval rule compiled: { spans(words, budget) → every [start, end] word span it matches, filters: search filters
 * every matching value passes (to narrow the rows checked), plain: the old phrase / terms forms the search runs itself }.
 */
function intervalRule(k, x) {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw whereError(`${k}: $interval takes { $match: "text", … }, { $anyOf: [rules] } or { $allOf: [rules], … }`);
  const kinds = Object.keys(INTERVAL_OPTIONS).filter((key) => x[key] !== undefined);
  if (kinds.length !== 1)
    throw whereError(`${k}: $interval takes { $match: "text", … }, { $anyOf: [rules] } or { $allOf: [rules], … }${kinds.length ? ` (one of them, got ${kinds.join(", ")})` : ""}`);
  const kind = kinds[0];
  for (const key of Object.keys(x)) if (!INTERVAL_OPTIONS[kind].includes(key)) throw whereError(`${k}: unsupported $interval option ${key}${kind !== "$match" ? ` with ${kind}` : ""}`);
  if (x.$ordered !== undefined && typeof x.$ordered !== "boolean") throw whereError(`${k}: $ordered takes true or false`);

  if (kind === "$match") {
    const m = x.$match;
    const query = m && typeof m === "object" && !Array.isArray(m) ? m.$query ?? m.query : m;
    if (query === null || !["string", "number", "object"].includes(typeof query) || (typeof query === "object" && !Array.isArray(query)))
      throw whereError(`${k}: $match takes the search text (a string or { $query: string }), got ${JSON.stringify(m)}`);
    const text = String(m && typeof m === "object" && !Array.isArray(m) ? m.$query ?? m.query ?? "" : termsOf(m));
    const q = wordsOf(text);
    if (!q.length) throw whereError(`${k}: the search text has no words`);
    const ordered = x.$ordered !== false;
    const gaps = maxGapsOf(k, x, ordered ? 0 : Infinity);
    const fuzz = fuzzinessOf(k, x);
    if (x.$prefixOnLastTerm !== undefined && typeof x.$prefixOnLastTerm !== "boolean") throw whereError(`${k}: $prefixOnLastTerm takes true or false`);
    // with $fuzzy the other words are fuzzy and the last one a prefix (as the search's prefix_last with fuzziness)
    const prefix = !!x.$prefixOnLastTerm;
    const edits = q.map((t) => (fuzz === null ? 0 : fuzz === "AUTO" ? (Array.from(t).length <= 2 ? 0 : Array.from(t).length <= 5 ? 1 : 2) : fuzz));
    const last = q.length - 1;
    const hit = (i, w) => (prefix && i === last ? w.startsWith(q[i]) : withinEdits(w, q[i], edits[i]));
    const n = q.length;
    const spans = (words, budget) => {
      const ok = q.map((_, i) => words.map((w) => hit(i, w)));
      if (ok.some((row) => !row.includes(true))) return [];
      const cand = words.map((_, p) => p).filter((p) => ok.some((row) => row[p]));
      const out = [];
      for (const s of cand)
        for (const e of cand) {
          if (e < s || e - s + 1 < n || e - s + 1 - n > gaps) continue;
          if ((budget.left -= n * n) < 0) throw whereError(`${k}: the $interval rule is too broad to check on these values`);
          if (n === 1) {
            if (s === e && ok[0][s]) out.push([s, e]);
            continue;
          }
          if (s === e) continue;
          let found = false;
          if (ordered) {
            if (ok[0][s] && ok[last][e]) {
              let pos = s;
              found = true;
              for (let i = 1; i < last && found; i++) {
                let p = pos + 1;
                while (p < e && !ok[i][p]) p++;
                if (p >= e) found = false;
                else pos = p;
              }
            }
          } else {
            const inner = [];
            for (let p = s + 1; p < e; p++) inner.push(p);
            for (let i = 0; i < n && !found; i++)
              for (let j = 0; j < n && !found; j++)
                if (i !== j && ok[i][s] && ok[j][e])
                  found = assignable(q.map((_, t) => t).filter((t) => t !== i && t !== j), inner, (t, p) => ok[t][p]);
          }
          if (found) out.push([s, e]);
        }
      return out;
    };
    const filters = q.map((t, i) => (prefix && i === last ? { property: k, op: "contains", value: t } : edits[i] ? null : { property: k, op: "any_word", value: t })).filter(Boolean);
    // (terms in any order run as one word filter each, so only when no word repeats: "jam jam" needs two words)
    const plain = gaps === (ordered ? 0 : Infinity) && fuzz === null && !prefix && (ordered || new Set(q).size === q.length) ? { words: q, ordered } : null;
    // the search's own interval filter, with the OSDK defaults made explicit; the search takes at most MAX_UNORDERED
    // terms in any order (its matching tries every subset), so a longer text in any order is checked here
    const server = !ordered && n > MAX_UNORDERED ? null : {
      match: { query: text, ordered, max_gaps: gaps === Infinity ? -1 : gaps, fuzziness: fuzz === null ? 0 : fuzz === "AUTO" ? "auto" : fuzz, prefix_last: prefix },
    };
    // phrase prefix runs through prefixNode as before; any order is checked here (each term at its own word)
    return { spans, filters, plain, server, prefix: prefix && fuzz === null && ordered && gaps === 0 ? { text, ordered } : null };
  }

  const kids = rulesOf(k, kind, x[kind]).map((r) => intervalRule(k, r));
  const serverKids = kids.every((r) => r.server) ? kids.map((r) => r.server) : null;
  if (kind === "$anyOf") {
    const spans = (words, budget) => {
      const seen = new Map();
      for (const r of kids) for (const sp of r.spans(words, budget)) seen.set(sp.join(","), sp);
      return [...seen.values()];
    };
    return { spans, filters: [], server: serverKids && { any_of: { intervals: serverKids } } };
  }
  const ordered = x.$ordered === true;
  const gaps = maxGapsOf(k, x, Infinity);
  if (!ordered && kids.length > MAX_UNORDERED) throw whereError(`${k}: $allOf takes at most ${MAX_UNORDERED} rules in any order`);
  const spans = (words, budget) => {
    const lists = [];
    for (const r of kids) {
      const l = r.spans(words, budget);
      if (!l.length) return [];
      lists.push(l);
    }
    if (lists.length === 1) return lists[0];
    // the search's _combine_spans: partial matches by (rules taken — a count in order, a bit mask in any order —, first
    // word, last word) → the most words covered (fewest gaps); the rules' matches taken by their first word, each after
    // the last one taken (so none overlap)
    const full = ordered ? lists.length : (1 << lists.length) - 1;
    const all = [];
    lists.forEach((l, r) => l.forEach(([s, e]) => all.push([s, e, r])));
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const states = new Map();
    const done = new Map();
    for (const [s, e, r] of all) {
      const add = new Map();
      const put = (key, cov) => {
        const at = add.get(key);
        if (!at || at[3] < cov) add.set(key, [...key.split(",").map(Number), cov]);
      };
      if (!ordered || r === 0) put(`${ordered ? 1 : 1 << r},${s},${e}`, e - s + 1);
      for (const [took, s0, e0, cov] of states.values()) {
        if ((budget.left -= 1) < 0) throw whereError(`${k}: the $interval rule is too broad to check on these values`);
        if (e0 >= s || (ordered ? took !== r : (took >> r) & 1)) continue;
        const cov2 = cov + e - s + 1;
        if (e - s0 + 1 - cov2 > gaps) continue;
        put(`${ordered ? took + 1 : took | (1 << r)},${s0},${e}`, cov2);
      }
      for (const [key, v] of add) {
        if (v[0] === full) done.set(`${v[1]},${v[2]}`, [v[1], v[2]]);
        else if (!states.has(key) || states.get(key)[3] < v[3]) states.set(key, v);
      }
    }
    return [...done.values()];
  };
  return {
    spans, filters: kids.flatMap((r) => r.filters),
    server: serverKids && { all_of: { intervals: serverKids, ordered, max_gaps: gaps === Infinity ? -1 : gaps } },
  };
}

/** { $interval: rule } on property k (rules above). */
function intervalNode(k, x, arrays) {
  const rule = intervalRule(k, x);
  // the forms the search runs as before: a phrase, terms in any order. A match lies within one value: on an array
  // property the words of a match are all in one element (as the interval filter checks them)
  if (rule.plain && !(arrays && arrays.has(k)))
    return { filters: rule.plain.ordered ? [{ property: k, op: "phrase", value: rule.plain.words.join(" ") }] : rule.plain.words.map((w) => ({ property: k, op: "any_word", value: w })) };
  // every other rule: the search's interval filter, so only matching objects are loaded (it ANDs with the other
  // conditions in one search). Checked here instead after a narrowing search: more than MAX_UNORDERED terms in any
  // order, or BLUESANDAI_TS_INTERVAL_LOCAL=1 (to compare both)
  if (rule.server && process.env.BLUESANDAI_TS_INTERVAL_LOCAL !== "1") return { filters: [{ property: k, op: "interval", value: rule.server }] };
  if (rule.prefix) return prefixNode(k, rule.prefix.text, rule.prefix.ordered);
  const one = (v) => rule.spans(wordsOf(v && typeof v === "object" ? Object.values(v).join(" ") : v), { left: INTERVAL_BUDGET }).length > 0;
  const test = (row) => {
    const v = (row.properties || {})[k];
    return Array.isArray(v) ? v.some(one) : v !== null && v !== undefined && one(v);
  };
  return { check: { filters: rule.filters, test } };
}

/** The search filters for one property condition (several when they AND), or an $or / $not node. */
function propertyNode(k, v, arrays) {
  if (v === null) return { filters: [{ property: k, op: "is_null" }] };
  if (typeof v !== "object" || Array.isArray(v) || v instanceof Date) return { filters: [{ property: k, op: "eq", value: v instanceof Date ? v.toISOString() : v }] };
  const filters = [];
  const nodes = [];
  if (!Object.keys(v).length) throw whereError(`${k}: a condition needs an operator ({ $eq: … }, { $in: […] }, …)`);
  for (const [op, raw] of Object.entries(v)) {
    const x = raw instanceof Date ? raw.toISOString() : raw;
    if (!op.startsWith("$")) throw whereError(`${k}: ${op} is not an operator (operators start with $)`);
    if (x === undefined && op !== "$isNull") throw whereError(`${k}: ${op} needs a value`);
    if (op === "$isNull") {
      if (typeof x !== "boolean") throw whereError(`${k}: $isNull takes true or false`);
      filters.push({ property: k, op: x ? "is_null" : "not_null" });
    } else if (op === "$not") nodes.push({ not: propertyNode(k, x, arrays) });
    else if (op === "$in") {
      if (!Array.isArray(x)) throw whereError(`${k}: $in takes an array`);
      // an empty $in matches nothing
      filters.push(x.length ? { property: k, op: "in", value: x } : { property: k, op: "in", value: ["\u0000no value\u0000"] });
    } else if (op === "$contains") {
      // arrays: an element equal to the value; strings: a substring
      filters.push({ property: k, op: arrays.has(k) ? "eq" : "contains", value: x });
    } else if (op === "$containsAnyTerm") filters.push({ property: k, op: "any_word", value: String(termsOf(x)) });
    else if (op === "$containsAllTerms") {
      const terms = String(termsOf(x)).split(/\s+/).filter(Boolean);
      for (const term of terms) filters.push({ property: k, op: "any_word", value: term });
    } else if (op === "$containsAllTermsInOrder") filters.push({ property: k, op: "phrase", value: String(termsOf(x)) });
    // the last term also matches words starting with it: in order (OSDK; v1 phrasePrefix), or in any order (v1
    // prefixOnLastToken)
    else if (op === "$containsAllTermsInOrderPrefixLastTerm" || op === "$bsaiPrefixOnLastToken") nodes.push(prefixNode(k, String(termsOf(x)), op !== "$bsaiPrefixOnLastToken"));
    // the migration guide's form of v1 phrasePrefix / prefixOnLastToken: { $interval: { $match, $prefixOnLastTerm } }
    // ($ordered: false for terms in any order; without $prefixOnLastTerm every term matches whole words)
    else if (op === "$interval") nodes.push(intervalNode(k, x, arrays));
    else if (op === "$within" || op === "$intersects") filters.push({ property: k, op: "geo", value: geoRegion(x, op) });
    else if (OPS[op]) filters.push({ property: k, op: OPS[op], value: x });
    else throw whereError(`unsupported operator ${op} on ${k}`);
  }
  return nodes.length ? { and: [{ filters }, ...nodes] } : { filters };
}

/** A where clause as a tree: {filters} (one search), {and: [...]}, {or: [...]}, {not: node}. */
function compileWhere(clause, arrays, inside) {
  // where() / where(undefined) filters nothing; a clause inside $and / $or / $not must be there
  if ((clause === undefined || clause === null) && !inside) return { filters: [] };
  if (clause === null || typeof clause !== "object" || Array.isArray(clause) || clause instanceof Date)
    throw whereError(`${inside ? `a clause of ${inside}` : "a where clause"} is an object, got ${clause === undefined ? "undefined" : JSON.stringify(clause)}`);
  const parts = [];
  for (const [k, v] of Object.entries(clause)) {
    if (k === "$and" || k === "$or") {
      if (!Array.isArray(v)) throw whereError(`${k} takes an array of clauses`);
      const kids = v.map((c) => compileWhere(c, arrays, k));
      parts.push(k === "$and" ? { and: kids } : { or: kids });
    } else if (k === "$not") parts.push({ not: compileWhere(v, arrays, k) });
    // link presence (TypeScript v1 `.isPresent()` on a link): objects with at least one linked object
    else if (k === "$bsaiLinkPresent") {
      if (!v || typeof v !== "object" || !v.link_type_id) throw whereError("$bsaiLinkPresent takes { link_type_id, direction }");
      parts.push({ filters: [{ property: "__link", op: "linked", value: { link_type_id: v.link_type_id, direction: v.direction === "reverse" ? "reverse" : "forward", filters: [], negate: false } }] });
    } else if (k.startsWith("$")) throw whereError(`unsupported clause ${k}`);
    // a property left undefined is no condition (as in the OSDK)
    else if (v !== undefined) parts.push(propertyNode(k, v, arrays));
  }
  return parts.length === 1 ? parts[0] : { and: parts };
}

/**
 * A tree as the search's own filters (its and / or / not filter tree, ontology_explorer._tree_filter), or null when
 * a part of it is checked here ({check}: a prefix form, an interval rule the search cannot take).
 */
function serverFilters(node) {
  if (node.filters) return node.filters;
  if (node.check) return null;
  if (node.and) {
    const out = [];
    for (const n of node.and) {
      const f = serverFilters(n);
      if (!f) return null;
      out.push(...f);
    }
    return out;
  }
  const kids = node.or ? node.or : [node.not];
  const parts = [];
  for (const n of kids) {
    const f = serverFilters(n);
    if (!f) return null;
    parts.push(f.length === 1 ? f[0] : { property: "__tree", op: "and", value: f });
  }
  return [{ property: "__tree", op: node.or ? "or" : "not", value: node.or ? parts : parts[0].op === "and" ? parts[0].value : [parts[0]] }];
}

// the search's limit on nested filter trees (ontology_explorer.TREE_DEPTH)
const TREE_DEPTH = 32;
const treeDepth = (filters) =>
  filters.reduce((d, f) => Math.max(d, f.op === "and" || f.op === "or" || f.op === "not" ? 1 + treeDepth(f.value) : 0), 0);

// BLUESANDAI_TS_TREE_LOCAL=1: $or / $not evaluated here as sets of keys (one search per branch) as before, to compare
const treeLocal = () => process.env.BLUESANDAI_TS_TREE_LOCAL === "1";

/**
 * A tree flattened: every filter that ANDs at the top (an $or / $not the search takes as a filter tree among them),
 * the rows checks ({check} nodes at the top: their narrowing filters join the search, their test runs on its rows),
 * and the $or / $not nodes left over (evaluated as sets of keys).
 */
function flatten(node, out = { filters: [], checks: [], rest: [] }) {
  if (node.filters) out.filters.push(...node.filters);
  else if (node.and) node.and.forEach((n) => flatten(n, out));
  else if (node.or && node.or.length === 1) flatten(node.or[0], out);
  else if (node.check && !treeLocal()) {
    out.filters.push(...node.check.filters);
    out.checks.push(node.check);
  } else {
    const f = treeLocal() ? null : serverFilters(node);
    // a tree nested deeper than the search takes is evaluated as sets of keys (its branches still go as trees)
    if (f && treeDepth(f) <= TREE_DEPTH) out.filters.push(...f);
    else out.rest.push(node);
  }
  return out;
}

/** The rows of a search that pass the flattened tree's checks. */
const passing = (rows, checks) => (checks.length ? rows.filter((r) => checks.every((c) => c.test(r))) : rows);

const PAGE = 1000;
const MAX_ROWS = 100000;

/** Every object of a search (paged), in the search's order. */
async function searchAll(t, filters, sort, limit = MAX_ROWS) {
  const out = [];
  for (let offset = 0; out.length < limit; ) {
    const res = await call("/api/ontology/explorer/search", {
      object_type_id: t.id, filters, offset, limit: Math.min(PAGE, limit - out.length), histograms: false, resource: "function",
      ...(sort ? { sort: sort[0], order: sort[1] === "desc" ? "desc" : "asc" } : {}),
    });
    out.push(...res.objects);
    offset += res.objects.length;
    if (!res.objects.length || offset >= res.total) break;
  }
  return out;
}

/** The primary keys a tree matches. */
async function keysOf(t, node) {
  const { filters, checks, rest } = flatten(node);
  let keys = null;
  // a check with no narrowing filter still runs (on every object of the type)
  if (filters.length || checks.length || !rest.length) keys = new Set(passing(await searchAll(t, filters), checks).map((r) => String(r.primary_key)));
  for (const n of rest) {
    let k;
    if (n.or) {
      k = new Set();
      for (const kid of n.or) for (const x of await keysOf(t, kid)) k.add(x);
    } else if (n.check) {
      // rows checked here after a narrowing search (prefixNode)
      k = new Set((await searchAll(t, n.check.filters)).filter(n.check.test).map((r) => String(r.primary_key)));
    } else {
      const all = new Set((await searchAll(t, [])).map((r) => String(r.primary_key)));
      const not = await keysOf(t, n.not);
      k = new Set([...all].filter((x) => !not.has(x)));
    }
    keys = keys === null ? k : new Set([...keys].filter((x) => k.has(x)));
    if (!keys.size) break;
  }
  return keys;
}

async function arrayProps(t) {
  return new Set((t.properties || []).filter((p) => p.array || p.type === "string_array").map((p) => p.api_name));
}

class ObjectSet {
  constructor(apiName, clauses = [], pks = null) {
    this.apiName = apiName;
    this.clauses = clauses;
    this.pks = pks;
  }
  where(clause) {
    // checked now (unknown operators fail at the call), compiled against the type when the set is read
    compileWhere(clause, new Set());
    return new ObjectSet(this.apiName, [...this.clauses, clause], this.pks);
  }
  /** The set's objects as the search returns them ({t, rows}), in order. */
  async _pubRows(limit = 1000, orderBy) {
    const t = await typeOf(this.apiName);
    const sort = orderBy ? Object.entries(orderBy)[0] : null;
    const arrays = await arrayProps(t);
    const { filters, checks, rest } = flatten({ and: this.clauses.map((c) => compileWhere(c, arrays)) });
    let rows;
    // one search ($or / $not as its filter tree): only the matching objects load, the first `limit` when nothing is
    // checked here
    if (!rest.length && !this.pks) rows = passing(await searchAll(t, filters, sort, checks.length ? MAX_ROWS : Math.min(limit, MAX_ROWS)), checks);
    else {
      let keep = this.pks ? new Set(this.pks.map(String)) : null;
      for (const n of rest) {
        const k = await keysOf(t, n);
        keep = keep === null ? k : new Set([...keep].filter((x) => k.has(x)));
      }
      rows = keep.size ? passing(await searchAll(t, filters, sort), checks).filter((r) => keep.has(String(r.primary_key))) : [];
    }
    return { t, rows: rows.slice(0, limit) };
  }
  async _rows(limit = 1000, orderBy) {
    const { t, rows } = await this._pubRows(limit, orderBy);
    return rows.map((r) => instance(t, r));
  }
  async fetchPage(opts = {}) {
    const size = opts.$pageSize || 1000;
    // $nextPageToken: the offset of the next page
    const offset = Number(opts.$nextPageToken || 0) || 0;
    const rows = await this._rows(offset + size + 1, opts.$orderBy);
    const data = rows.slice(offset, offset + size);
    return { data, nextPageToken: rows.length > offset + size ? String(offset + size) : undefined, totalCount: undefined };
  }
  async fetchOne(pk) {
    const t = await typeOf(this.apiName);
    return instance(t, await call(`/api/ontology/object-types/${t.id}/objects/${encodeURIComponent(String(pk))}`));
  }
  /** How many objects the set holds: the search's total when the set is one search, else its keys counted. */
  async _count() {
    const t = await typeOf(this.apiName);
    const arrays = await arrayProps(t);
    const { filters, checks, rest } = flatten({ and: this.clauses.map((c) => compileWhere(c, arrays)) });
    if (rest.length || checks.length || this.pks) return (await this._pubRows(MAX_ROWS)).rows.length;
    return (await call("/api/ontology/explorer/search", { object_type_id: t.id, filters, limit: 1, histograms: false, resource: "function" })).total;
  }
  async aggregate(spec = {}) {
    const selected = Object.keys(spec.$select || {});
    // a count alone does not load the objects
    if (!spec.$groupBy && selected.length && selected.every((k) => k === "$count")) return { $count: await this._count() };
    const rows = await this._rows(100000);
    // $select: { $count, "prop:metric": "unordered" | "asc" | "desc" } (also the older { prop: "metric" })
    const metrics = (list) => {
      const out = {};
      for (const [k, v] of Object.entries(spec.$select || {})) {
        if (k === "$count") {
          out.$count = list.length;
          continue;
        }
        const [prop, metric] = k.includes(":") ? k.split(":") : [k, v];
        const vals = list.map((r) => r[prop]).filter((x) => x !== undefined && x !== null);
        const nums = vals.filter((x) => typeof x === "number");
        const cmp = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
        const sorted = vals.slice().sort(cmp);
        const agg = {
          sum: nums.reduce((a, b) => a + b, 0),
          avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          approximateDistinct: new Set(vals.map(String)).size,
          exactDistinct: new Set(vals.map(String)).size,
        };
        if (!(metric in agg)) throw whereError(`unknown aggregation metric ${metric}`);
        out[prop] = { ...(out[prop] || {}), [metric]: agg[metric] };
      }
      return out;
    };
    if (!spec.$groupBy) return metrics(rows);
    // $groupBy: { prop: "exact" | { $exactWithLimit: n } | { $fixedWidth: w } } — a flat list of {$group, …metrics}
    const keys = Object.entries(spec.$groupBy);
    const groups = new Map();
    for (const r of rows) {
      const g = {};
      for (const [prop, how] of keys) {
        const v = r[prop];
        g[prop] = how && how.$fixedWidth && typeof v === "number" ? Math.floor(v / how.$fixedWidth) * how.$fixedWidth : v;
      }
      const key = JSON.stringify(g);
      if (!groups.has(key)) groups.set(key, { g, list: [] });
      groups.get(key).list.push(r);
    }
    let out = [...groups.values()].map(({ g, list }) => ({ $group: g, ...metrics(list) }));
    const limit = Math.min(...keys.map(([, how]) => (how && how.$exactWithLimit) || 10000));
    if (out.length > limit) out = out.sort((a, b) => (b.$count ?? 0) - (a.$count ?? 0)).slice(0, limit);
    return out;
  }
  async *asyncIter() {
    for (const o of await this._rows(100000)) yield o;
  }
}

// ------------------------------------------------------------------ queries

// API-named queries (published functions of any repository, model functions): client(query).executeFunction(params)
let QUERIES = null;
async function querySig(apiName) {
  QUERIES = QUERIES || (await call("/api/functions/queries"));
  return QUERIES.find((q) => q.api_name === apiName) || null;
}

const TYPE_LABEL = { string: "a string", integer: "an Integer", double: "a number", boolean: "a boolean", timestamp: "a Timestamp", date: "a LocalDate" };
const describeValue = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : v instanceof ObjectSet ? "an object set" : v && v.$apiName ? `a ${v.$apiName} object` : typeof v);

/**
 * One argument checked against a parameter type and put on the wire. strict (a query called from a function): the
 * value must have the type, as TypeScript would require; otherwise (inputs of a run) unambiguous strings are converted.
 */
async function argOf(v, type, where, strict) {
  type = String(type || "any");
  const bad = () => {
    const label = TYPE_LABEL[type] || (type.startsWith("array<") ? "an array" : type.startsWith("object:") ? `a ${type.slice(7)} object` : type.startsWith("object_set:") ? `an ObjectSet<${type.slice(11)}>` : type);
    const e = new TypeError(`${where} must be ${label}, got ${describeValue(v)}`);
    e.invalidInput = true;
    return e;
  };
  if (type.startsWith("optional<")) return v === undefined || v === null ? null : argOf(v, type.slice(9, -1), where, strict);
  if (v === undefined || v === null) return null;
  if (type === "string") {
    if (typeof v === "string") return v;
    if (!strict && (typeof v === "number" || typeof v === "boolean")) return String(v);
    throw bad();
  }
  if (type === "integer" || type === "double") {
    let n = v;
    if (!strict && typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) n = Number(v);
    if (typeof n !== "number" || !isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw bad();
    return n;
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return v;
    if (!strict && (v === "true" || v === "false")) return v === "true";
    throw bad();
  }
  if (type === "timestamp" || type === "date") {
    const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) throw bad();
    return v instanceof Date ? (type === "date" ? d.toISOString().slice(0, 10) : d.toISOString()) : v;
  }
  if (type.startsWith("array<")) {
    const list = v instanceof Set ? [...v] : v;
    if (!Array.isArray(list)) throw bad();
    const inner = type.slice(6, -1);
    return Promise.all(list.map((x, i) => argOf(x, inner, `${where}[${i}]`, strict)));
  }
  if (type.startsWith("object:")) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      let tid, pk;
      if (v.__pub) [tid, pk] = [v.__pub.object_type_id, v.__pub.primary_key];
      else if (v.$apiName !== undefined && v.$primaryKey !== undefined) [tid, pk] = [(await typeOf(v.$apiName)).id, v.$primaryKey];
      else if (v.object_type_id && v.primary_key !== undefined) [tid, pk] = [v.object_type_id, v.primary_key];
      else throw bad();
      const want = await typeOf(type.slice(7)).catch(() => null);
      if (want && tid !== want.id) throw bad();
      return { object_type_id: tid, primary_key: String(pk) };
    }
    if (typeof v === "string" || typeof v === "number") return v; // a primary key
    throw bad();
  }
  if (type.startsWith("interface:")) {
    // an object of any implementing type (the platform checks that its type implements the interface)
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.__pub) return { object_type_id: v.__pub.object_type_id, primary_key: String(v.__pub.primary_key) };
      const concrete = v.$objectType || v.$apiName;
      if (concrete && v.$primaryKey !== undefined) return { object_type_id: (await typeOf(concrete)).id, primary_key: String(v.$primaryKey) };
      if (v.object_type_id && v.primary_key !== undefined) return { object_type_id: v.object_type_id, primary_key: String(v.primary_key) };
    }
    const e = new TypeError(`${where} must be an object implementing ${type.slice(10)}, got ${describeValue(v)}`);
    e.invalidInput = true;
    throw e;
  }
  if (type.startsWith("object_set:")) {
    if (!(v instanceof ObjectSet)) throw bad();
    const t = await typeOf(v.apiName);
    const want = await typeOf(type.slice(11)).catch(() => null);
    if (want && t.id !== want.id) throw bad();
    return { object_type_id: t.id, primary_keys: (await v._rows(10000)).map((o) => String(o.$primaryKey)) };
  }
  if ((type === "map" || type.startsWith("struct:")) && (typeof v !== "object" || Array.isArray(v))) throw bad();
  return toWire(v);
}

const snake = (s) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, m) => m.toUpperCase());

/** A query's arguments checked against its signature: unknown and missing parameters, wrong types. */
async function queryArgs(apiName, sig, params) {
  const byName = Object.fromEntries(sig.inputs.map((i) => [i.name, i]));
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    // the parameter as declared (a Python query's snake_case name may be given in camelCase)
    const name = byName[k] ? k : byName[snake(k)] ? snake(k) : byName[camel(k)] ? camel(k) : null;
    if (!name) {
      const e = new TypeError(`query ${apiName} has no parameter ${k} (parameters: ${sig.inputs.map((i) => i.name).join(", ") || "none"})`);
      e.invalidInput = true;
      throw e;
    }
    out[name] = await argOf(v, byName[name].type, `query ${apiName}: parameter ${k}`, true);
  }
  const missing = sig.inputs.filter((i) => i.required && (out[i.name] === undefined || out[i.name] === null));
  if (missing.length) {
    const e = new TypeError(`query ${apiName}: parameter ${missing[0].name} is required`);
    e.invalidInput = true;
    throw e;
  }
  return out;
}

class QueryError extends Error {
  constructor(message, userFacing) {
    super(message);
    this.name = userFacing ? "UserFacingError" : "QueryError";
  }
}

/**
 * Run an API-named query with the caller's identity. Inside a staged-write run it runs in the run's transaction: it
 * reads the staged edits, a staged-write query's edits join this run's, and any failure (even a caught one) discards
 * every staged edit when the run ends — as Foundry's nested staged-write calls.
 */
async function executeQuery(apiName, params) {
  const fail = (e) => {
    if (STAGED) STAGED_FAILED = STAGED_FAILED || e.message;
    return e;
  };
  let sig, inputs;
  try {
    sig = await querySig(apiName);
    inputs = sig ? await queryArgs(apiName, sig, params) : Object.fromEntries(await Promise.all(Object.entries(params || {}).map(async ([k, v]) => [k, await toWire(v)])));
  } catch (e) {
    throw fail(e);
  }
  let res;
  try {
    res = await call(`/api/functions/queries/${encodeURIComponent(apiName)}/execute`, { inputs });
  } catch (e) {
    throw fail(new QueryError(`query ${apiName} failed: ${e.message.replace(/^Ontology request failed /, "")}`));
  }
  // a model function answers {output}
  if (res && res.ok === undefined && "output" in res) return fromWire(res.output);
  if (!res || !res.ok) throw fail(new QueryError(`query ${apiName} failed: ${(res && res.error) || "unknown error"}`, res && res.user_facing));
  if (STAGED) {
    if (res.staged_writes && res.edits) await STAGED.batch.merge(res.edits);
    // what the call wrote without staging (an action it applied) joins this run's edits right away, so the run's next
    // sync keeps it and the function-backed action commits it (later edits of the run win)
    await takeDirect(STAGED);
  } else if (STAGED_PARENT && process.env.BLUESANDAI_SCENARIO && res.staged_writes && res.edits && res.edits.length) {
    // a plain query running inside a staged-write run called a staged-write function: this query has no staged edits
    // of its own to hold them, so they join the transaction as writes made with its caller's header — read from now on,
    // taken by the caller after the call, committed or discarded with the outer run (as the Python runtime)
    await call(`/api/ontology/staged-writes/${process.env.BLUESANDAI_SCENARIO}/direct/add`, { edits: res.edits });
  }
  return fromWire(res.value, sig ? sig.output : undefined);
}

function query(apiName) {
  return { apiName, type: "query", executeFunction: (params) => executeQuery(apiName, params) };
}

function client() {
  const c = (type) => (type && typeof type === "object" && type.type === "query" ? query(type.apiName) : new ObjectSet(apiOf(type)));
  c.fetchOne = (type, pk) => new ObjectSet(apiOf(type)).fetchOne(pk);
  return c;
}

// ------------------------------------------------------------------ edits

const pkOf = (x) => (x && typeof x === "object" ? (x.$primaryKey !== undefined ? x.$primaryKey : x.__pub && x.__pub.primary_key) : x);
const typeNameOf = (x, fallback) => (x && typeof x === "object" && x.$apiName ? x.$apiName : fallback);
// the concrete type of an object (an object seen through an interface: its $objectType)
const concreteNameOf = (x) => (x && typeof x === "object" && x.__iface ? x.$objectType : typeNameOf(x));
const objectTypeOf = (x) => (x && typeof x === "object" && typeof x.$objectType === "string" ? x.$objectType : undefined);
const OPS_OF = { createObject: "create", updateObject: "modify", deleteObject: "delete" };

/** An object edit through an interface checked when it is made (when the types and interfaces are loaded). */
function checkInterfaceEdit(e) {
  if (!TYPES || !IFACES || typeSync(e.obj)) return;
  const i = ifaceSync(e.obj);
  if (i) viaInterface(i, e.objectType, e.properties, OPS_OF[e.type]);
}

class EditBatch {
  constructor(onChange) {
    this.edits = [];
    this.onChange = onChange;
  }
  _push(e) {
    // edits through an interface are refused at the call (a property it does not have, the primary key's property, …)
    checkInterfaceEdit(e);
    Object.defineProperty(e, "__bsaiEdit", { value: true, enumerable: false });
    this.edits.push(e);
    return this.onChange ? this.onChange(this) : undefined;
  }
  create(type, props) {
    // through an interface: create(Person, { $objectType: "Employee", …interface properties })
    return this._push({ type: "createObject", obj: apiOf(type), objectType: props && props.$objectType, properties: { ...props } });
  }
  update(obj, props) {
    if (obj && obj.$apiName === undefined && obj.apiName && props && props.$primaryKey !== undefined)
      return this._push({ type: "updateObject", obj: obj.apiName, objectType: props.$objectType, pk: props.$primaryKey, properties: { ...props } });
    return this._push({ type: "updateObject", obj: typeNameOf(obj), objectType: objectTypeOf(obj), pk: pkOf(obj), properties: { ...props } });
  }
  delete(obj) {
    return this._push({ type: "deleteObject", obj: typeNameOf(obj), objectType: objectTypeOf(obj), pk: pkOf(obj) });
  }
  link(source, linkApiName, target) {
    return this._push({ type: "addLink", obj: concreteNameOf(source), pk: pkOf(source), link: linkApiName, target: pkOf(target) });
  }
  unlink(source, linkApiName, target) {
    return this._push({ type: "removeLink", obj: concreteNameOf(source), pk: pkOf(source), link: linkApiName, target: pkOf(target) });
  }
  getEdits() {
    return this.edits.slice();
  }
  /** Stage the edits (wire format) a nested staged-write call returned, after this batch's own (later edits win). */
  merge(wire) {
    for (const edit of wire || []) {
      const e = { type: "wire", edit };
      Object.defineProperty(e, "__bsaiEdit", { value: true, enumerable: false });
      this.edits.push(e);
    }
    return this.onChange ? this.onChange(this) : undefined;
  }
}

/** Object edits folded per object, as the Python runtime's edits container: later edits win, create + delete cancel. */
function squash(list) {
  const byKey = new Map();
  const links = [];
  for (const e of list) {
    if (e.kind === "link") {
      links.push(e);
      continue;
    }
    const key = `${e.object_type_id}\u0000${e.primary_key}`;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { ...e, properties: { ...(e.properties || {}) } });
    else if (e.op === "delete") {
      if (cur.op === "create") byKey.delete(key);
      else Object.assign(cur, { op: "delete", properties: {} });
    } else if (cur.op === "delete") Object.assign(cur, { op: e.op === "modify" ? "modify" : "create", properties: { ...(e.properties || {}) } });
    else Object.assign(cur.properties, e.properties || {});
  }
  return [...byKey.values(), ...links];
}

const isEdits = (v) => Array.isArray(v) && v.length > 0 && v.every((e) => e && e.__bsaiEdit);

async function editsOf(list) {
  const out = [];
  // objects' current properties, for struct fields set through an interface (merged into the struct's value)
  const current = new Map();
  const currentOf = async (t, pk, created) => {
    const key = `${t.id}\u0000${pk}`;
    if (!current.has(key)) {
      let props = {};
      if (!created) {
        try {
          props = (await call(`/api/ontology/object-types/${t.id}/objects/${encodeURIComponent(String(pk))}`)).properties || {};
        } catch {}
      }
      current.set(key, { ...props });
    }
    return current.get(key);
  };
  for (const e of list || []) {
    if (e.type === "wire") {
      // edits of a nested staged-write call, already in the wire format
      out.push(e.edit);
      continue;
    }
    await types();
    const i = e.type in OPS_OF && !typeSync(e.obj) ? await ifaceOf(e.obj) : null;
    if (i) {
      // an edit through an interface: the implementing type's properties
      const op = OPS_OF[e.type];
      const { t, props, structs } = viaInterface(i, e.objectType, e.properties, op);
      const pk = op === "create" ? props[t.primary_key] : e.pk;
      if (pk === undefined || pk === null) throw new TypeError(`${i.api_name}: the object's primary key is missing`);
      if (op === "delete") {
        current.delete(`${t.id}\u0000${pk}`);
        out.push({ op: "delete", object_type_id: t.id, primary_key: String(pk), properties: {} });
        continue;
      }
      const cur = Object.keys(structs).length || current.has(`${t.id}\u0000${pk}`) ? await currentOf(t, pk, op === "create") : null;
      for (const [sp, fields] of Object.entries(structs)) {
        const base = props[sp] && typeof props[sp] === "object" ? props[sp] : cur[sp] && typeof cur[sp] === "object" ? cur[sp] : {};
        props[sp] = { ...base, ...fields };
      }
      if (cur) Object.assign(cur, props);
      out.push({ op, object_type_id: t.id, primary_key: String(pk), properties: props });
      continue;
    }
    const t = await typeOf(e.obj);
    if (e.type === "deleteObject") current.delete(`${t.id}\u0000${e.pk}`);
    else if (current.has(`${t.id}\u0000${e.type === "createObject" ? e.properties[t.primary_key] : e.pk}`))
      Object.assign(current.get(`${t.id}\u0000${e.type === "createObject" ? e.properties[t.primary_key] : e.pk}`), e.properties);
    if (e.type === "createObject") {
      const pk = e.properties[t.primary_key];
      out.push({ op: "create", object_type_id: t.id, primary_key: String(pk), properties: e.properties });
    } else if (e.type === "updateObject") {
      const { $primaryKey, ...props } = e.properties;
      for (const [k, v] of Object.entries(props)) if (v instanceof CipherText) props[k] = v.value;
      out.push({ op: "modify", object_type_id: t.id, primary_key: String(e.pk), properties: props });
    } else if (e.type === "deleteObject") {
      out.push({ op: "delete", object_type_id: t.id, primary_key: String(e.pk), properties: {} });
    } else {
      // a many-to-many link (join table): the link name is the API name of the side reached from this object
      const lt = (await links()).find(
        (l) => (l.source.object_type_id === t.id && l.target.api_name === e.link) || (l.target.object_type_id === t.id && l.source.api_name === e.link),
      );
      if (!lt) throw new Error(`${t.api_name} has no link ${e.link}`);
      const forward = lt.source.object_type_id === t.id && lt.target.api_name === e.link;
      out.push({ kind: "link", op: e.type === "addLink" ? "add" : "remove", link_type_id: lt.id, source: String(forward ? e.pk : e.target), target: String(forward ? e.target : e.pk) });
    }
  }
  return out;
}

/** The object types an edit function declares: object types, and every implementing type of a declared interface. */
async function typeIds(names) {
  const out = [];
  for (const n of names) {
    if (String(n).startsWith("link:")) continue;
    await types();
    const t = typeSync(n);
    if (t) {
      out.push(t.id);
      continue;
    }
    const i = await ifaceOf(n);
    if (!i) throw new Error(`no object type ${n}`);
    for (const x of TYPES) if (implementationOf(x, i)) out.push(x.id);
  }
  return [...new Set(out)];
}

/** Load the object types and interfaces now, so edits through an interface are checked when they are made. */
async function preload() {
  await types();
  await interfaces();
}

// ------------------------------------------------------------------ staged writes

async function beginStaged() {
  // called inside another staged-write run (nested): this run is a layer of the caller's transaction
  const sid = (await call("/api/ontology/staged-writes", STAGED_PARENT ? { parent: STAGED_PARENT } : {})).id;
  const staged = { sid, batch: null };
  staged.batch = new EditBatch(async (b) => {
    await call(`/api/ontology/staged-writes/${sid}`, { edits: squash(await editsOf(b.edits)) }, "PUT");
  });
  STAGED_SID = sid;
  STAGED = staged;
  STAGED_FAILED = null;
  return staged;
}

/**
 * Writes made inside the transaction without staging since this run last asked (an action applied by a function it
 * called): staged as this run's own edits, after what it staged so far (POST /staged-writes/<id>/direct).
 */
async function takeDirect(staged) {
  if (!staged) return;
  const res = await call(`/api/ontology/staged-writes/${staged.sid}/direct`, {});
  // a call inside the transaction failed (one a called plain query caught, say): the run discards every edit
  if (res && res.failed) STAGED_FAILED = STAGED_FAILED || String(res.failed);
  const taken = (res && res.edits) || [];
  if (taken.length) await staged.batch.merge(taken);
}

async function endStaged(staged, keep) {
  if (keep) {
    // anything written without staging that the run has not taken yet
    try {
      await takeDirect(staged);
    } catch {}
  }
  const edits = keep ? squash(await editsOf(staged.batch.edits)) : [];
  STAGED_SID = null;
  STAGED = null;
  let ended = null;
  try {
    ended = await call(`/api/ontology/staged-writes/${staged.sid}`, undefined, "DELETE");
  } catch {}
  // the transaction learnt of a failed call (the run discards every edit: the runner checks stagedFailure() after this)
  if (ended && ended.failed) STAGED_FAILED = STAGED_FAILED || String(ended.failed);
  if (keep && STAGED_FAILED) return [];
  // direct writes nobody took (the transaction returns them when it ends): still this run's edits
  if (keep && ended && Array.isArray(ended.direct) && ended.direct.length) return squash([...edits, ...ended.direct]);
  return edits;
}

/** Why the staged-write transaction must be discarded: a call made inside it failed (null when none did). */
const stagedFailure = () => STAGED_FAILED;

function writeableClient(staged) {
  const c = client();
  // writes are awaited so the next read sees them (read-after-write)
  c.create = (type, props) => staged.batch.create(type, props);
  c.update = (obj, props) => staged.batch.update(obj, props);
  c.delete = (obj) => staged.batch.delete(obj);
  c.link = (s, l, t) => staged.batch.link(s, l, t);
  c.unlink = (s, l, t) => staged.batch.unlink(s, l, t);
  return c;
}

// ------------------------------------------------------------------ wire format

async function fromWire(v, type) {
  if (v === undefined || v === null) return v;
  type = String(type || "").replace(/^optional<(.*)>$/, "$1");
  if (v && typeof v === "object" && v.__object__) {
    let pub = v.__object__;
    const t = (await types()).find((x) => x.id === pub.object_type_id);
    if (t && pub.properties === undefined) {
      // a reference only (a query's object result): the object as this run sees it
      pub = { ...(await call(`/api/ontology/object-types/${t.id}/objects/${encodeURIComponent(String(pub.primary_key))}`)), object_type_id: t.id };
    }
    // Osdk.Instance<Interface>: the object seen through the interface
    const named = /^(?:object|interface):(.+)$/.exec(type);
    if (t && named && named[1] !== t.api_name && named[1] !== t.id) {
      const i = await ifaceOf(named[1]);
      if (i && !typeSync(named[1])) return ifaceInstance(t, i, pub);
    }
    return instance(t || { api_name: "Object", id: pub.object_type_id }, pub);
  }
  if (v && typeof v === "object" && v.__object_set__) {
    const s = v.__object_set__;
    const t = (await types()).find((x) => x.id === s.object_type_id);
    return new ObjectSet(t ? t.api_name : s.object_type_id, [], s.primary_keys || null);
  }
  if (Array.isArray(v)) {
    const inner = String(type || "").replace(/^array<(.*)>$/, "$1");
    return Promise.all(v.map((x) => fromWire(x, inner)));
  }
  return v;
}

async function toWire(v) {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return typeof v === "number" && !isFinite(v) ? null : v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof CipherText) return v.value;
  if (v.__pub) return { __object__: v.__pub };
  // a TypeScript v1 object set wraps a v2 one
  if (v.__objectSet instanceof ObjectSet) v = v.__objectSet;
  if (v instanceof ObjectSet) {
    const t = await typeOf(v.apiName);
    return { __object_set__: { object_type_id: t.id, primary_keys: (await v._rows(10000)).map((o) => String(o.$primaryKey)) } };
  }
  if (Array.isArray(v)) return Promise.all(v.map(toWire));
  if (v instanceof Set) return Promise.all([...v].map(toWire));
  if (v instanceof Map) {
    // FunctionsMap / Map: object keys by primary key
    const out = {};
    for (const [k, x] of v) out[k && typeof k === "object" && k.__pub ? String(k.__pub.primary_key) : String(k)] = await toWire(x);
    return out;
  }
  if (typeof v.toJSON === "function") return v.toJSON();
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = await toWire(x);
  return out;
}

// ------------------------------------------------------------------ synchronous reads (TypeScript v1)

// TypeScript v1 reads are synchronous (objectSet.all(), link.get()): the request runs in a worker thread while this
// thread waits on a shared flag, and the reply is taken from the worker's port without the event loop.
let SYNC = null;
function syncCall(op, args) {
  const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");
  if (!SYNC) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(require("path").join(__dirname, "sync_worker.js"), { workerData: { signal, port: port2 }, transferList: [port2] });
    worker.unref();
    SYNC = { signal, port: port1, worker };
  }
  Atomics.store(SYNC.signal, 0, 0);
  SYNC.worker.postMessage({ op, args, staged: STAGED_SID });
  while (Atomics.load(SYNC.signal, 0) === 0) Atomics.wait(SYNC.signal, 0, 0, 1000);
  const msg = receiveMessageOnPort(SYNC.port);
  const reply = msg && msg.message;
  if (!reply) throw new Error("the synchronous Ontology read returned nothing");
  if (!reply.ok) {
    const e = new Error(reply.error);
    e.name = reply.name || "Error";
    throw e;
  }
  return reply.value;
}

/** The objects reached from objects of a type along a link type ({t, rows} of the reached type). */
async function linkedRows(apiName, pks, linkTypeId, direction) {
  const t = await typeOf(apiName);
  const filters = [{ property: t.primary_key, op: "in", value: pks.map(String) }];
  const out = [];
  let reached = null;
  for (let offset = 0; out.length < MAX_ROWS; ) {
    const res = await call("/api/ontology/explorer/search", { object_type_id: t.id, filters, search_around: [{ link_type_id: linkTypeId, direction }], offset, limit: PAGE, histograms: false, resource: "function" });
    reached = reached || res.result_type;
    out.push(...res.objects);
    offset += res.objects.length;
    if (!res.objects.length || offset >= res.total) break;
  }
  const rt = (await types()).find((x) => x.id === (reached && reached.id)) || reached;
  return { type: rt, rows: out };
}

// what the worker runs (plain JSON in and out)
const SYNC_OPS = {
  call: (p, body, method) => call(p, body, method),
  types: () => types(),
  links: () => links(),
  rows: async (apiName, clauses, pks, limit, orderBy) => {
    const { t, rows } = await new ObjectSet(apiName, clauses, pks)._pubRows(limit, orderBy);
    return { type: t, rows };
  },
  linked: (apiName, pks, linkTypeId, direction) => linkedRows(apiName, pks, linkTypeId, direction),
};
const setStagedSid = (sid) => {
  STAGED_SID = sid || null;
};

module.exports = { syncCall, SYNC_OPS, setStagedSid, linkedRows, instance, typeOf, types, links, interfaces, ifaceInstance, preload, takeDirect, compileWhere, MAX_ROWS, call, client, query, executeQuery, argOf, TYPE_LABEL, stagedFailure, squash, writeableClient, ObjectSet, EditBatch, CipherText, takeImplicit, isEdits, editsOf, typeIds, beginStaged, endStaged, fromWire, toWire };
