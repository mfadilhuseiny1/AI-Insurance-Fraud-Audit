/*
 * TypeScript v1 functions (@foundry/functions-api, @foundry/ontology-api) on the v2 runtime (../@osdk/functions/runtime.js).
 *
 * Functions are decorated methods of exported classes (@Function(), @OntologyEditFunction() with @Edits(...),
 * @Query({ apiName })); runner.cjs reads the decorators. Objects are live: assigning a property, Objects.create(),
 * object.delete() and link set / clear / add / remove record edits, returned by an Ontology edit function. Reads
 * are synchronous as in Foundry (Objects.search().x().filter(...).all(), link.get()): they run through
 * runtime.syncCall. Filters (exactMatch, range, hasProperty, token matches, phrasePrefix / prefixOnLastToken, link
 * presence with isPresent(), Filters.and / or / not) become OSDK v2 where clauses, so they match like TypeScript v2
 * functions' where().
 */
"use strict";
const rt = require("../@osdk/functions/runtime.js");

// ------------------------------------------------------------------ edits

const EDITS = [];
function record(e) {
  Object.defineProperty(e, "__bsaiEdit", { value: true, enumerable: false });
  EDITS.push(e);
}
const takeEdits = () => EDITS.splice(0, EDITS.length);

// ------------------------------------------------------------------ types and links (read once, synchronously)

let TYPES = null;
let LINKS = null;
const allTypes = () => TYPES || (TYPES = rt.syncCall("types", []));
const allLinks = () => LINKS || (LINKS = rt.syncCall("links", []));
const apiOf = (t) => (t && typeof t === "object" ? t.apiName || t.api_name : String(t));

function typeSync(ref) {
  const name = apiOf(ref);
  const t = allTypes().find((x) => x.api_name === name || x.id === name || x.api_name.toLowerCase() === String(name).toLowerCase());
  if (!t) throw new Error(`no object type ${name}`);
  return t;
}

/** The links of a type, named as Foundry names them from this side (the other side's API name). */
function linksOf(t) {
  const out = [];
  for (const lt of allLinks()) {
    if (lt.source.object_type_id === t.id) out.push({ name: lt.target.api_name, lt, forward: true, other: lt.target.object_type_id });
    if (lt.target.object_type_id === t.id) out.push({ name: lt.source.api_name, lt, forward: false, other: lt.source.object_type_id });
  }
  return out.filter((l) => l.name);
}
const findLink = (t, name) => linksOf(t).find((l) => l.name === name) || linksOf(t).find((l) => l.name.toLowerCase() === String(name).toLowerCase());

// ------------------------------------------------------------------ objects

const pkOf = (o) => (o && typeof o === "object" ? (o.__pub ? o.__pub.primary_key : o.$primaryKey) : o);

/** A live v1 object: property reads, recorded property writes, links, delete(). */
function v1Object(t, pub) {
  const inst = rt.instance(t, pub);
  const props = {};
  for (const k of Object.keys(inst)) if (!k.startsWith("$")) props[k] = inst[k];
  const names = new Set((t.properties || []).map((p) => p.api_name));
  const pk = pub.primary_key;
  const meta = { object_type_id: t.id, primary_key: pk, title: pub.title };
  const linkCache = {};
  const self = new Proxy(Object.create(null), {
    get(_, k) {
      if (k === "__pub") return meta;
      if (k === "__v1") return true;
      if (k === "$apiName" || k === "$objectType") return t.api_name;
      if (k === "$primaryKey") return pk;
      if (k === "$title") return pub.title;
      if (k === "delete") return () => record({ type: "deleteObject", obj: t.api_name, pk });
      if (k === "toJSON") return () => ({ $apiName: t.api_name, $primaryKey: pk, ...props });
      if (typeof k !== "string") return undefined;
      if (k in props) return props[k];
      if (names.has(k)) return undefined;
      const link = findLink(t, k);
      if (link) return (linkCache[k] = linkCache[k] || linkAccessor(t, self, link));
      return undefined;
    },
    set(_, k, v) {
      if (typeof k !== "string" || !names.has(k)) throw new TypeError(`${t.api_name} has no property ${String(k)}`);
      if (k === t.primary_key && String(v) !== String(pk)) throw new TypeError(`the primary key ${k} of ${t.api_name} cannot change`);
      props[k] = v;
      record({ type: "updateObject", obj: t.api_name, pk, properties: { [k]: v instanceof Date ? v.toISOString() : v && typeof v.toJSON === "function" ? v.toJSON() : v } });
      return true;
    },
    has: (_, k) => k in props,
    ownKeys: () => Object.keys(props),
    getOwnPropertyDescriptor: (_, k) => (k in props ? { value: props[k], enumerable: true, configurable: true, writable: true } : undefined),
  });
  return self;
}

/** A v2 instance (an input) as a v1 object. */
function fromInstance(o) {
  if (!o || typeof o !== "object" || !o.__pub || o.__v1) return o;
  const t = typeSync(o.$apiName || o.__pub.object_type_id);
  const properties = {};
  for (const k of Object.keys(o)) if (!k.startsWith("$")) properties[k] = o[k] && o[k].constructor && o[k].constructor.name === "CipherText" ? o[k].value : o[k];
  return v1Object(t, { primary_key: o.__pub.primary_key, title: o.__pub.title, properties });
}

function linkAccessor(t, obj, link) {
  const other = () => typeSync(link.other);
  const reached = () => {
    const r = rt.syncCall("linked", [t.api_name, [pkOf(obj)], link.lt.id, link.forward ? "forward" : "reverse"]);
    return r.rows.map((row) => v1Object(r.type, row));
  };
  const reachedAsync = async () => {
    const r = await rt.linkedRows(t.api_name, [pkOf(obj)], link.lt.id, link.forward ? "forward" : "reverse");
    return r.rows.map((row) => v1Object(r.type, row));
  };
  const fk = link.lt.kind === "foreign_key" ? link.lt.foreign_key : null;
  const setFk = (o, value) => {
    if (o && o.__v1) o[fk] = value;
    else record({ type: "updateObject", obj: other().api_name, pk: pkOf(o), properties: { [fk]: value } });
  };
  const linkEdit = (type, target) => record({ type, obj: t.api_name, pk: pkOf(obj), link: link.name, target: pkOf(target) });
  return {
    get: () => reached()[0],
    getAsync: async () => (await reachedAsync())[0],
    all: () => reached(),
    allAsync: () => reachedAsync(),
    /** a single link from the side that holds the foreign key */
    set(target) {
      if (fk && link.forward) obj[fk] = pkOf(target);
      else throw new TypeError(`${t.api_name}.${link.name} is not a single link: use add / remove`);
    },
    clear() {
      if (fk && link.forward) obj[fk] = null;
      else throw new TypeError(`${t.api_name}.${link.name} is not a single link: use remove`);
    },
    add(target) {
      if (fk && !link.forward) setFk(target, pkOf(obj));
      else if (!fk) linkEdit("addLink", target);
      else throw new TypeError(`${t.api_name}.${link.name} is a single link: use set`);
    },
    remove(target) {
      if (fk && !link.forward) setFk(target, null);
      else if (!fk) linkEdit("removeLink", target);
      else throw new TypeError(`${t.api_name}.${link.name} is a single link: use clear`);
    },
  };
}

// ------------------------------------------------------------------ filters (as v2 where clauses)

class RangeFilter {
  constructor(prop, bounds = {}) {
    this.prop = prop;
    this.bounds = bounds;
  }
  _with(op, v) {
    return new RangeFilter(this.prop, { ...this.bounds, [op]: v instanceof Date ? v.toISOString() : v && typeof v.toJSON === "function" ? v.toJSON() : v });
  }
  lt(v) {
    return this._with("$lt", v);
  }
  lte(v) {
    return this._with("$lte", v);
  }
  gt(v) {
    return this._with("$gt", v);
  }
  gte(v) {
    return this._with("$gte", v);
  }
  toClause() {
    const parts = Object.entries(this.bounds).map(([op, v]) => ({ [this.prop]: { [op]: v } }));
    return parts.length === 1 ? parts[0] : { $and: parts };
  }
}

const plain = (v) => (v instanceof Date ? v.toISOString() : v && typeof v === "object" && v.__pub ? v.__pub.primary_key : v && typeof v.toJSON === "function" ? v.toJSON() : v);
const tokens = (args) => args.map(String).join(" ");

/** Link presence filters ({__linkPresent: link}) of a clause as where clauses on the type's link ($bsaiLinkPresent). */
function linkClauses(t, x) {
  if (Array.isArray(x)) return x.map((y) => linkClauses(t, y));
  if (!x || typeof x !== "object" || x instanceof Date) return x;
  if (x.__linkPresent !== undefined) {
    const link = findLink(t, x.__linkPresent);
    if (!link) throw new TypeError(`${t.api_name} has no link ${x.__linkPresent}: isPresent() filters on a link`);
    return { $bsaiLinkPresent: { link_type_id: link.lt.id, direction: link.forward ? "forward" : "reverse" } };
  }
  const out = {};
  for (const [k, v] of Object.entries(x)) out[k] = k === "$and" || k === "$or" || k === "$not" ? linkClauses(t, v) : v;
  return out;
}

function propertyFilter(prop) {
  return {
    exactMatch: (...vals) => (vals.length === 1 ? (vals[0] === null || vals[0] === undefined ? { [prop]: { $isNull: true } } : { [prop]: { $eq: plain(vals[0]) } }) : { [prop]: { $in: vals.map(plain) } }),
    hasProperty: () => ({ [prop]: { $isNull: false } }),
    isTrue: () => ({ [prop]: { $eq: true } }),
    isFalse: () => ({ [prop]: { $eq: false } }),
    range: () => new RangeFilter(prop),
    lt: (v) => new RangeFilter(prop).lt(v),
    lte: (v) => new RangeFilter(prop).lte(v),
    gt: (v) => new RangeFilter(prop).gt(v),
    gte: (v) => new RangeFilter(prop).gte(v),
    matchAnyToken: (...t) => ({ [prop]: { $containsAnyTerm: tokens(t) } }),
    matchAllTokens: (...t) => ({ [prop]: { $containsAllTerms: tokens(t) } }),
    phrase: (...t) => ({ [prop]: { $containsAllTermsInOrder: tokens(t) } }),
    // arrays: any of the values
    contains: (...vals) => (vals.length === 1 ? { [prop]: { $contains: plain(vals[0]) } } : { $or: vals.map((v) => ({ [prop]: { $contains: plain(v) } })) }),
    startsWith: (v) => ({ [prop]: { $startsWith: String(v) } }),
    phrasePrefix: (...t) => ({ [prop]: { $containsAllTermsInOrderPrefixLastTerm: tokens(t) } }),
    prefixOnLastToken: (...t) => ({ [prop]: { $bsaiPrefixOnLastToken: tokens(t) } }),
    // a link (o.manager.isPresent()): resolved against the object set's type by linkClauses
    isPresent: () => ({ __linkPresent: prop }),
    // ordering and grouping selectors
    asc: () => ({ __order: [prop, "asc"] }),
    desc: () => ({ __order: [prop, "desc"] }),
    topValues: () => ({ __group: { prop, kind: "exact" } }),
    exactValues: (opts) => ({ __group: { prop, kind: "exact", max: opts && opts.maxBuckets } }),
    byFixedWidth: (w) => ({ __group: { prop, kind: "width", width: w } }),
    byFixedWidths: (w) => ({ __group: { prop, kind: "width", width: w } }),
    byRanges: (...ranges) => ({ __group: { prop, kind: "ranges", ranges: ranges.flat() } }),
    __prop: prop,
  };
}

/** The object passed to filter / orderBy / groupBy / sum callbacks: each property is a filter builder. */
const selector = () => new Proxy({}, { get: (_, k) => (typeof k === "string" ? propertyFilter(k) : undefined) });

function clauseOf(x) {
  if (x instanceof RangeFilter) return x.toClause();
  if (x && typeof x === "object" && x.__prop) throw new TypeError(`filter on ${x.__prop} needs a condition (exactMatch, range, …)`);
  return x;
}

const Filters = {
  and: (...f) => ({ $and: f.map(clauseOf) }),
  or: (...f) => ({ $or: f.map(clauseOf) }),
  not: (f) => ({ $not: clauseOf(f) }),
};

// ------------------------------------------------------------------ object sets

const propOf = (fn) => {
  const r = fn(selector());
  return r && (r.__prop || (r.__order && r.__order[0]));
};

class V1ObjectSet {
  constructor(apiName, clauses = [], pks = null, order = null) {
    this.apiName = apiName;
    this.clauses = clauses;
    this.pks = pks;
    this.order = order;
    // searchAround<Link>() methods
    return new Proxy(this, {
      get: (target, k, recv) => {
        if (typeof k === "string" && !(k in target) && /^searchAround/.test(k)) return () => target._around(k.replace(/^searchAround/, ""));
        return Reflect.get(target, k, recv);
      },
    });
  }
  get __objectSet() {
    return new rt.ObjectSet(this.apiName, this.clauses, this.pks);
  }
  filter(fn) {
    let clause = clauseOf(typeof fn === "function" ? fn(selector()) : fn);
    if (JSON.stringify(clause || {}).includes('"__linkPresent"')) clause = linkClauses(typeSync(this.apiName), clause);
    rt.compileWhere(clause, new Set());
    return new V1ObjectSet(this.apiName, [...this.clauses, clause], this.pks, this.order);
  }
  orderBy(fn) {
    const r = fn(selector());
    if (!r || !r.__order) throw new TypeError("orderBy takes o => o.property.asc() or .desc()");
    return new V1ObjectSet(this.apiName, this.clauses, this.pks, this.order || { [r.__order[0]]: r.__order[1] });
  }
  orderByRelevance() {
    return this;
  }
  _load(limit) {
    const r = rt.syncCall("rows", [this.apiName, this.clauses, this.pks, limit, this.order]);
    return r.rows.map((row) => v1Object(r.type, row));
  }
  async _loadAsync(limit) {
    const { t, rows } = await this.__objectSet._pubRows(limit, this.order);
    return rows.map((row) => v1Object(t, row));
  }
  all() {
    return this._load(rt.MAX_ROWS);
  }
  allAsync() {
    return this._loadAsync(rt.MAX_ROWS);
  }
  take(n) {
    return this._load(n);
  }
  takeAsync(n) {
    return this._loadAsync(n);
  }
  _around(name) {
    const t = typeSync(this.apiName);
    const link = findLink(t, name);
    if (!link) throw new TypeError(`${t.api_name} has no link ${name}`);
    const pks = this.all().map((o) => String(o.$primaryKey));
    const r = pks.length ? rt.syncCall("linked", [t.api_name, pks, link.lt.id, link.forward ? "forward" : "reverse"]) : { type: typeSync(link.other), rows: [] };
    return new V1ObjectSet(r.type.api_name, [], [...new Set(r.rows.map((x) => String(x.primary_key)))]);
  }
  pivotTo(name) {
    return this._around(name);
  }
  async _values(fn) {
    const prop = propOf(fn);
    return (await this.allAsync()).map((o) => o[prop]).filter((v) => typeof v === "number");
  }
  async count() {
    return (await this.allAsync()).length;
  }
  async sum(fn) {
    const v = await this._values(fn);
    return v.reduce((a, b) => a + b, 0);
  }
  async average(fn) {
    const v = await this._values(fn);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
  }
  async max(fn) {
    const v = await this._values(fn);
    return v.length ? Math.max(...v) : undefined;
  }
  async min(fn) {
    const v = await this._values(fn);
    return v.length ? Math.min(...v) : undefined;
  }
  async cardinality(fn) {
    const prop = propOf(fn);
    return new Set((await this.allAsync()).map((o) => o[prop]).filter((v) => v !== undefined && v !== null).map(String)).size;
  }
  groupBy(fn) {
    const r = fn(selector());
    if (!r || !r.__group) throw new TypeError("groupBy takes o => o.property.topValues() / exactValues() / byFixedWidth(n) / byRanges(...)");
    return new GroupedSet(this, r.__group);
  }
}

class GroupedSet {
  constructor(set, group) {
    this.set = set;
    this.group = group;
  }
  async _buckets(metric) {
    const g = this.group;
    const buckets = new Map();
    for (const o of await this.set.allAsync()) {
      const v = o[g.prop];
      if (v === undefined || v === null) continue;
      let key;
      if (g.kind === "width") {
        if (typeof v !== "number") continue;
        const min = Math.floor(v / g.width) * g.width;
        key = { min, max: min + g.width };
      } else if (g.kind === "ranges") {
        const r = g.ranges.find((x) => (x.min === undefined || v >= x.min) && (x.max === undefined || v < x.max));
        if (!r) continue;
        key = { min: r.min, max: r.max };
      } else key = v;
      const id = JSON.stringify(key);
      if (!buckets.has(id)) buckets.set(id, { key, list: [] });
      buckets.get(id).list.push(o);
    }
    let out = [...buckets.values()].map(({ key, list }) => ({ key, value: metric(list) }));
    if (g.kind === "exact") out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (g.max) out = out.slice(0, g.max);
    return { buckets: out };
  }
  count() {
    return this._buckets((l) => l.length);
  }
  _num(fn, f) {
    const prop = propOf(fn);
    return this._buckets((l) => {
      const v = l.map((o) => o[prop]).filter((x) => typeof x === "number");
      return v.length ? f(v) : undefined;
    });
  }
  sum(fn) {
    return this._num(fn, (v) => v.reduce((a, b) => a + b, 0));
  }
  average(fn) {
    return this._num(fn, (v) => v.reduce((a, b) => a + b, 0) / v.length);
  }
  max(fn) {
    return this._num(fn, (v) => Math.max(...v));
  }
  min(fn) {
    return this._num(fn, (v) => Math.min(...v));
  }
}

/** A v2 object set (an input) as a v1 one. */
const fromObjectSet = (s) => (s instanceof rt.ObjectSet ? new V1ObjectSet(s.apiName, s.clauses, s.pks) : s);

// ------------------------------------------------------------------ Objects

const searchApi = new Proxy({}, {
  get: (_, name) => {
    if (typeof name !== "string" || name === "then") return undefined;
    // Objects.search().employee() — every object; .employee([objects]) — those objects
    return (objects) => {
      const t = typeSync(name);
      if (objects === undefined) return new V1ObjectSet(t.api_name);
      const list = Array.isArray(objects) ? objects : [objects];
      return new V1ObjectSet(t.api_name, [], list.map((o) => String(pkOf(o))));
    };
  },
});

const createApi = new Proxy({}, {
  get: (_, name) => {
    if (typeof name !== "string" || name === "then") return undefined;
    return (pk) => {
      const t = typeSync(name);
      if (pk === undefined || pk === null || pk === "") throw new TypeError(`Objects.create().${name}() needs a primary key`);
      record({ type: "createObject", obj: t.api_name, properties: { [t.primary_key]: pk } });
      return v1Object(t, { primary_key: String(pk), title: String(pk), properties: { [t.primary_key]: pk } });
    };
  },
});

const Objects = {
  search: () => searchApi,
  create: () => createApi,
  delete: (o) => (o && o.__v1 ? o.delete() : record({ type: "deleteObject", obj: o.$apiName, pk: pkOf(o) })),
};

// ------------------------------------------------------------------ @foundry/functions-api values

const decorator = () => () => undefined;
const Function_ = decorator;
const OntologyEditFunction = decorator;
const Query = decorator;
const Edits = () => () => undefined;

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
  }
}

class FunctionsMap extends Map {}

class Timestamp extends Date {
  static now() {
    return new Timestamp();
  }
  static fromISOString(s) {
    return new Timestamp(s);
  }
  static fromJsDate(d) {
    return new Timestamp(d.getTime());
  }
}

class LocalDate {
  constructor(iso) {
    this.iso = String(iso).slice(0, 10);
  }
  static now() {
    return new LocalDate(new Date().toISOString());
  }
  static fromISOString(s) {
    return new LocalDate(s);
  }
  static fromJsDate(d) {
    return new LocalDate(d.toISOString());
  }
  toISOString() {
    return this.iso;
  }
  toJsDate() {
    return new Date(this.iso + "T00:00:00Z");
  }
  toString() {
    return this.iso;
  }
  toJSON() {
    return this.iso;
  }
}

module.exports = {
  EDITS, takeEdits, typeSync, v1Object, fromInstance, fromObjectSet, V1ObjectSet, Objects, Filters,
  Function: Function_, OntologyEditFunction, Query, Edits, UserFacingError, FunctionsMap, Timestamp, LocalDate,
};
