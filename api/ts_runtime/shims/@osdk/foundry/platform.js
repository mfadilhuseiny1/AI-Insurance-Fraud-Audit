/*
 * @osdk/foundry (the Foundry platform SDK) for TypeScript v2 functions: the platform API subset this platform has,
 * in the real package's function shapes — every function takes the client first (`Admin.Users.getCurrent(client)`,
 * `Datasets.Files.list(client, datasetRid)`), resources are namespaces (plural and singular names), and the
 * sub-packages (`@osdk/foundry.admin`, `@osdk/foundry.admin/User`, …) are the same functions (runner.cjs resolves
 * them here). Calls carry the run's job token like the other SDK shims (runtime.call: inside a staged-write run or a
 * scenario, Ontology calls stay in it). Errors are PalantirApiError {errorName, errorCode, statusCode, parameters}.
 *
 *   Admin.Users          getCurrent, get, getBatch           /api/platform-sdk/admin/users/…
 *   Admin.Groups         get, getBatch                       /api/platform-sdk/admin/groups/{id}
 *   Datasets.Datasets    get, readTable (CSV), getSchema     /api/drive/items/{rid}, /api/pipeline/datasets/{rid}/table
 *   Datasets.Files       list, get, content (read)           a Parquet dataset is one file; a folder lists its files
 *   Filesystem.Resources get, getByPath                      /api/drive/items/{rid} (path walked from the top level)
 *   Filesystem.Folders   get, children, create               /api/drive/folders/{rid}
 *   Filesystem.Projects  get
 *   Ontologies.*         Ontologies (list, get), ObjectTypes (list, get), OntologyObjects (list, get, count, search,
 *                        aggregate), LinkedObjects (listLinkedObjects, getLinkedObject), Actions (apply, applyBatch),
 *                        Queries (execute), Attachments (get, read)         /api/v2/ontologies/…
 *   Functions.Queries    execute (an API-named query, or a Palantir model's CreateChatCompletion → {completion})
 *
 * Anything else throws "not available" when it is called.
 */
"use strict";
const rt = require("../functions/runtime.js");

const API = (process.env.BLUESANDAI_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const REALM = "bluesandai";

class PalantirApiError extends Error {
  constructor(message, errorName, errorCode, statusCode, parameters) {
    super(message);
    this.name = "PalantirApiError";
    this.errorName = errorName;
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.parameters = parameters || {};
  }
}

const CODES = { 400: "INVALID_ARGUMENT", 401: "UNAUTHORIZED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 409: "CONFLICT", 413: "REQUEST_ENTITY_TOO_LARGE" };

/** A platform API error from runtime.call's message ("… (404): detail"), detail a string or a Foundry error body. */
function apiError(e) {
  const m = /\((\d{3})\): ([\s\S]*)$/.exec((e && e.message) || "");
  if (!m) return e;
  const status = Number(m[1]);
  let body = null;
  try {
    body = JSON.parse(m[2]);
  } catch {}
  if (body && typeof body === "object" && body.errorName)
    return new PalantirApiError(`${body.errorName}${body.parameters ? " " + JSON.stringify(body.parameters) : ""}`, body.errorName, body.errorCode || CODES[status] || "INTERNAL", status, body.parameters);
  return new PalantirApiError(m[2], CODES[status] === "NOT_FOUND" ? "NotFound" : CODES[status] === "PERMISSION_DENIED" ? "PermissionDenied" : "ApiError", CODES[status] || "INTERNAL", status);
}

async function api(p, body, method) {
  try {
    return await rt.call(p, body, method);
  } catch (e) {
    throw apiError(e);
  }
}

/** A response body as is (file contents): a fetch Response, like the real SDK's binary endpoints. */
async function raw(p) {
  const headers = {};
  if (process.env.BLUESANDAI_API_TOKEN) headers.authorization = `Bearer ${process.env.BLUESANDAI_API_TOKEN}`;
  if (process.env.BLUESANDAI_SNAPSHOT) headers["x-bluesandai-snapshot"] = process.env.BLUESANDAI_SNAPSHOT;
  const r = await fetch(API + p, { headers });
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try {
      detail = JSON.parse(text).detail || text;
    } catch {}
    throw apiError(new Error(`(${r.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`));
  }
  return r;
}

const q = (s) => encodeURIComponent(String(s));
const query = (params) => {
  const parts = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${q(k)}=${q(Array.isArray(v) ? v.join(",") : v)}`);
  return parts.length ? "?" + parts.join("&") : "";
};
const needClient = (client, fn) => {
  if (client === undefined || client === null) throw new TypeError(`${fn}: pass the function's client first (${fn}(client, …))`);
};
/** A resource identifier: a Files item id, or a Foundry-style RID ending in it ("ri.foundry.main.dataset.<id>"). */
const idOf = (rid) => {
  const s = String(rid == null ? "" : rid).trim();
  if (!s) throw new PalantirApiError("a resource identifier is required", "InvalidArgument", "INVALID_ARGUMENT", 400);
  const m = /^ri\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9-]+\.(.+)$/.exec(s);
  return m ? m[1] : s;
};
/** Wrap one function so it checks the client and turns failures into PalantirApiError. */
const fn = (name, impl) => async (client, ...args) => {
  needClient(client, name);
  return impl(...args);
};

// ------------------------------------------------------------------ Admin

const userOf = (u) => ({
  id: u.id,
  username: u.username,
  givenName: u.given_name ?? u.givenName ?? undefined,
  familyName: u.family_name ?? u.familyName ?? undefined,
  // the names some Foundry examples read (user.firstName)
  firstName: u.given_name ?? u.givenName ?? undefined,
  lastName: u.family_name ?? u.familyName ?? undefined,
  email: u.email ?? undefined,
  realm: REALM,
  organization: u.organization ?? undefined,
  attributes: u.attributes || {},
  status: String(u.status || "active").toUpperCase(),
});
const groupOf = (g) => ({ id: g.id, name: g.name, description: g.description || undefined, realm: REALM, organizations: [], attributes: {} });

const Users = {
  getCurrent: fn("Users.getCurrent", async () => userOf(await api("/api/platform-sdk/admin/users/current"))),
  get: fn("Users.get", async (userId) => userOf(await api(`/api/platform-sdk/admin/users/${q(userId)}`))),
  getBatch: fn("Users.getBatch", async (body) => {
    const data = {};
    for (const x of body || []) {
      const id = typeof x === "object" && x ? x.userId : x;
      data[id] = userOf(await api(`/api/platform-sdk/admin/users/${q(id)}`));
    }
    return { data };
  }),
};
const Groups = {
  get: fn("Groups.get", async (groupId) => groupOf(await api(`/api/platform-sdk/admin/groups/${q(groupId)}`))),
  getBatch: fn("Groups.getBatch", async (body) => {
    const data = {};
    for (const x of body || []) {
      const id = typeof x === "object" && x ? x.groupId : x;
      data[id] = groupOf(await api(`/api/platform-sdk/admin/groups/${q(id)}`));
    }
    return { data };
  }),
};

// ------------------------------------------------------------------ Filesystem

const TYPES = { project: "FOUNDRY_PROJECT", folder: "COMPASS_FOLDER" };
const resourceType = (item) =>
  TYPES[item.kind] || (/\.parquet$/i.test(item.name || "") ? "FOUNDRY_DATASET" : /\.pipeline$/i.test(item.name || "") ? "FOUNDRY_PIPELINE_BUILDER_PIPELINE" : "FOUNDRY_FILE");
function resourceOf(item) {
  const path = (item.path || []).map((x) => x.name);
  const project = item.kind === "project" ? item.id : ((item.path || [])[0] || {}).id;
  return {
    rid: item.id,
    displayName: item.name,
    description: item.description || undefined,
    path: "/" + [...path, item.name].join("/"),
    type: resourceType(item),
    parentFolderRid: item.parent_id || undefined,
    projectRid: project || undefined,
    spaceRid: REALM,
    createdTime: item.created_at,
    updatedTime: item.updated_at,
    trashStatus: item.trashed_at ? "DIRECTLY_TRASHED" : "NOT_TRASHED",
    sizeBytes: item.size == null ? undefined : String(item.size),
  };
}
const item = (rid) => api(`/api/drive/items/${q(idOf(rid))}`);
const folderItems = async (rid) => (await api(`/api/drive/folders/${rid === "root" ? "root" : q(idOf(rid))}`)).items || [];
const page = (rows, params) => {
  const size = Math.max(1, Math.min(Number((params && params.pageSize) || 1000), 10000));
  const start = Number((params && params.pageToken) || 0) || 0;
  const data = rows.slice(start, start + size);
  return { data, nextPageToken: start + size < rows.length ? String(start + size) : undefined };
};

const Resources = {
  get: fn("Resources.get", async (rid) => resourceOf(await item(rid))),
  getByPath: fn("Resources.getByPath", async (params) => {
    const path = typeof params === "string" ? params : params && params.path;
    const parts = String(path || "").split("/").filter(Boolean);
    if (!parts.length) throw new PalantirApiError("path is required", "InvalidArgument", "INVALID_ARGUMENT", 400);
    let parent = "root";
    let hit = null;
    for (const name of parts) {
      hit = (await folderItems(parent)).find((x) => x.name === name && !x.trashed_at);
      if (!hit) throw new PalantirApiError(`ResourceNotFound {"path":${JSON.stringify(path)}}`, "ResourceNotFound", "NOT_FOUND", 404, { path });
      parent = hit.id;
    }
    return resourceOf(await item(hit.id));
  }),
};
const Folders = {
  get: fn("Folders.get", async (rid) => {
    const it = await item(rid);
    if (it.kind !== "folder" && it.kind !== "project") throw new PalantirApiError(`${it.name} is not a folder`, "NotAFolder", "INVALID_ARGUMENT", 400);
    return { ...resourceOf(it), type: undefined, rid: it.id };
  }),
  children: fn("Folders.children", async (rid, params) => {
    const rows = await folderItems(rid);
    const full = await Promise.all(rows.filter((x) => !x.trashed_at).map((x) => item(x.id).catch(() => ({ ...x, path: [] }))));
    return page(full.map(resourceOf), params);
  }),
  create: fn("Folders.create", async (body) => {
    const made = await api("/api/drive/folders", { name: body && body.displayName, parent_id: body && body.parentFolderRid ? idOf(body.parentFolderRid) : null, kind: "folder" });
    return resourceOf(await item(made.id));
  }),
};
const Projects = {
  get: fn("Projects.get", async (rid) => {
    const it = await item(rid);
    if (it.kind !== "project") throw new PalantirApiError(`${it.name} is not a project`, "ProjectNotFound", "NOT_FOUND", 404, { projectRid: rid });
    return { rid: it.id, displayName: it.name, description: it.description || undefined, path: "/" + it.name, spaceRid: REALM, trashStatus: it.trashed_at ? "DIRECTLY_TRASHED" : "NOT_TRASHED", createdTime: it.created_at, updatedTime: it.updated_at };
  }),
};

// ------------------------------------------------------------------ Datasets

const datasetOf = (it) => ({ rid: it.id, name: it.name, parentFolderRid: it.parent_id || undefined });
const fileOf = (it) => ({ path: it.name, transactionRid: `ri.foundry.main.transaction.${it.id}`, sizeBytes: it.size == null ? undefined : String(it.size), updatedTime: it.updated_at });
/** A dataset's files: a Parquet dataset (a file) is its one file, a folder dataset the files inside it. */
async function datasetFiles(rid) {
  const it = await item(rid);
  if (it.kind === "file") return { it, files: [it] };
  return { it, files: (await folderItems(it.id)).filter((x) => x.kind === "file" && !x.trashed_at) };
}
const fileIn = async (rid, filePath) => {
  const { files } = await datasetFiles(rid);
  const want = String(filePath || "").replace(/^\/+/, "");
  const f = files.find((x) => x.name === want) || (files.length === 1 && !want ? files[0] : null);
  if (!f) throw new PalantirApiError(`FileNotFound {"filePath":${JSON.stringify(filePath)}}`, "FileNotFound", "NOT_FOUND", 404, { datasetRid: rid, filePath });
  return f;
};
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const table = (rid, limit) => api(`/api/pipeline/datasets/${q(idOf(rid))}/table${query({ limit })}`);
const SCHEMA_TYPES = { String: "STRING", Integer: "INTEGER", Long: "LONG", Double: "DOUBLE", Float: "FLOAT", Boolean: "BOOLEAN", Date: "DATE", Timestamp: "TIMESTAMP", Decimal: "DECIMAL", Short: "SHORT", Byte: "BYTE", Binary: "BINARY" };

const DatasetsNs = {
  get: fn("Datasets.get", async (rid) => datasetOf(await item(rid))),
  readTable: fn("Datasets.readTable", async (rid, params) => {
    const format = String((params && params.format) || "CSV").toUpperCase();
    if (format !== "CSV") throw new PalantirApiError(`format ${format} is not available here: read the table with format "CSV"`, "InvalidTableFormat", "INVALID_ARGUMENT", 400, { format });
    const t = await table(rid, params && params.rowLimit != null ? Number(params.rowLimit) : undefined);
    const cols = params && params.columns && params.columns.length ? params.columns : t.columns.map((c) => c.name);
    const missing = cols.filter((c) => !t.columns.some((x) => x.name === c));
    if (missing.length) throw new PalantirApiError(`ColumnsNotFound ${JSON.stringify(missing)}`, "ColumnsNotFound", "INVALID_ARGUMENT", 400, { columns: missing });
    const lines = [cols.map(csvCell).join(","), ...t.rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))];
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv" } });
  }),
  getSchema: fn("Datasets.getSchema", async (rid) => {
    const t = await table(rid, 0);
    return { datasetRid: idOf(rid), schema: { fieldSchemaList: t.columns.map((c) => ({ name: c.name, type: SCHEMA_TYPES[c.type] || String(c.type || "STRING").toUpperCase(), nullable: true })) } };
  }),
};
const Files = {
  list: fn("Files.list", async (rid, params) => page((await datasetFiles(rid)).files.map(fileOf), params)),
  get: fn("Files.get", async (rid, filePath) => fileOf(await fileIn(rid, filePath))),
  content: fn("Files.content", async (rid, filePath) => raw(`/api/drive/items/${q((await fileIn(rid, filePath)).id)}/content`)),
};
Files.read = Files.content;

// ------------------------------------------------------------------ Ontologies (/api/v2: the Platform API shape)

const ont = (o) => q(o === undefined || o === null || o === "" ? "default" : o);
const OntologiesNs = {
  list: fn("Ontologies.list", async () => api("/api/v2/ontologies")),
  get: fn("Ontologies.get", async (o) => {
    const all = (await api("/api/v2/ontologies")).data || [];
    const hit = all.find((x) => x.apiName === o || x.rid === o) || (o === "default" ? all[0] : null);
    if (!hit) throw new PalantirApiError(`OntologyNotFound {"ontology":${JSON.stringify(o)}}`, "OntologyNotFound", "NOT_FOUND", 404, { ontology: o });
    return hit;
  }),
};
const ObjectTypes = {
  list: fn("ObjectTypes.list", async (o, params) => page((await api(`/api/v2/ontologies/${ont(o)}/objectTypes`)).data || [], params)),
  get: fn("ObjectTypes.get", async (o, objectType) => api(`/api/v2/ontologies/${ont(o)}/objectTypes/${q(objectType)}`)),
};
const OntologyObjects = {
  list: fn("OntologyObjects.list", async (o, objectType, params) => api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}${query(params)}`)),
  get: fn("OntologyObjects.get", async (o, objectType, primaryKey, params) => api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/${q(primaryKey)}${query(params)}`)),
  count: fn("OntologyObjects.count", async (o, objectType) => {
    const r = await api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/aggregate`, { aggregation: [{ type: "count", name: "count" }] });
    const first = (r && r.data && r.data[0]) || {};
    const metric = (first.metrics || []).find((m) => m.name === "count");
    return { count: metric ? Number(metric.value) : Number(first.count || 0) };
  }),
  search: fn("OntologyObjects.search", async (o, objectType, body) => api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/search`, body || {})),
  aggregate: fn("OntologyObjects.aggregate", async (o, objectType, body) => api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/aggregate`, body || {})),
};
const LinkedObjects = {
  listLinkedObjects: fn("LinkedObjects.listLinkedObjects", async (o, objectType, primaryKey, linkType, params) =>
    api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/${q(primaryKey)}/links/${q(linkType)}${query(params && { pageSize: params.pageSize, pageToken: params.pageToken })}`)),
  getLinkedObject: fn("LinkedObjects.getLinkedObject", async (o, objectType, primaryKey, linkType, linkedPrimaryKey) => {
    const all = (await api(`/api/v2/ontologies/${ont(o)}/objects/${q(objectType)}/${q(primaryKey)}/links/${q(linkType)}?pageSize=10000`)).data || [];
    const hit = all.find((x) => String(x.__primaryKey) === String(linkedPrimaryKey));
    if (!hit) throw new PalantirApiError(`LinkedObjectNotFound`, "LinkedObjectNotFound", "NOT_FOUND", 404, { linkType, linkedObjectPrimaryKey: linkedPrimaryKey });
    return hit;
  }),
};
const Actions = {
  apply: fn("Actions.apply", async (o, action, body) => api(`/api/v2/ontologies/${ont(o)}/actions/${q(action)}/apply`, { parameters: (body && body.parameters) || {}, options: (body && body.options) || {} })),
  applyBatch: fn("Actions.applyBatch", async (o, action, body) => {
    for (const r of (body && body.requests) || []) await api(`/api/v2/ontologies/${ont(o)}/actions/${q(action)}/apply`, { parameters: r.parameters || {}, options: (body && body.options) || {} });
    return {};
  }),
};
const OntologyQueries = {
  execute: fn("Queries.execute", async (o, queryApiName, body) => api(`/api/v2/ontologies/${ont(o)}/queries/${q(queryApiName)}/execute`, { parameters: (body && body.parameters) || {} })),
};
const Attachments = {
  get: fn("Attachments.get", async (rid) => api(`/api/v2/ontologies/attachments/${q(rid)}`)),
  read: fn("Attachments.read", async (rid) => raw(`/api/v2/ontologies/attachments/${q(rid)}/content`)),
};

// ------------------------------------------------------------------ Functions

const LLM = /^com\.foundry\.languagemodelservice\.models\..*CreateChatCompletion$/;
const FunctionQueries = {
  execute: fn("Functions.Queries.execute", async (queryApiName, body) => {
    const params = (body && body.parameters) || {};
    if (LLM.test(String(queryApiName))) {
      const messages = (params.messages || []).map((m) => ({ role: String(m.role || "user").toLowerCase(), content: m.content }));
      return { value: await api("/api/platform-sdk/language-models/chat", { messages }) };
    }
    // an API-named query: the runtime's call (signature checks, decoded results, staged-write runs joined)
    try {
      return { value: await rt.executeQuery(String(queryApiName), params) };
    } catch (e) {
      throw e && e.name === "QueryError" ? new PalantirApiError(e.message, "QueryRuntimeError", "INVALID_ARGUMENT", 400, { message: e.message }) : e;
    }
  }),
};

// ------------------------------------------------------------------ namespaces

/** A resource namespace: its functions, and a clear error for the ones this platform does not have. */
function resource(label, impl) {
  return new Proxy(impl, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target || name === "then" || name === "__esModule") return target[name];
      return async () => {
        throw new PalantirApiError(`${label}.${name} is not available in @osdk/foundry here`, "NotAvailable", "NOT_FOUND", 404);
      };
    },
  });
}

// plural (Admin.Users) and singular (@osdk/foundry.admin/User) names
const PACKAGES = {
  admin: { Users: resource("Users", Users), User: resource("User", Users), Groups: resource("Groups", Groups), Group: resource("Group", Groups) },
  datasets: { Datasets: resource("Datasets", DatasetsNs), Dataset: resource("Dataset", DatasetsNs), Files: resource("Files", Files), File: resource("File", Files) },
  filesystem: {
    Resources: resource("Resources", Resources), Resource: resource("Resource", Resources),
    Folders: resource("Folders", Folders), Folder: resource("Folder", Folders),
    Projects: resource("Projects", Projects), Project: resource("Project", Projects),
  },
  ontologies: {
    Ontologies: resource("Ontologies", OntologiesNs), Ontology: resource("Ontology", OntologiesNs), OntologiesV2: resource("OntologiesV2", OntologiesNs),
    ObjectTypes: resource("ObjectTypes", ObjectTypes), ObjectType: resource("ObjectType", ObjectTypes), ObjectTypesV2: resource("ObjectTypesV2", ObjectTypes),
    OntologyObjects: resource("OntologyObjects", OntologyObjects), OntologyObject: resource("OntologyObject", OntologyObjects), OntologyObjectsV2: resource("OntologyObjectsV2", OntologyObjects),
    LinkedObjects: resource("LinkedObjects", LinkedObjects), LinkedObject: resource("LinkedObject", LinkedObjects), LinkedObjectsV2: resource("LinkedObjectsV2", LinkedObjects),
    Actions: resource("Actions", Actions), Action: resource("Action", Actions), ActionsV2: resource("ActionsV2", Actions),
    Queries: resource("Queries", OntologyQueries), Query: resource("Query", OntologyQueries), QueriesV2: resource("QueriesV2", OntologyQueries),
    Attachments: resource("Attachments", Attachments), Attachment: resource("Attachment", Attachments), AttachmentsV2: resource("AttachmentsV2", Attachments),
  },
  functions: { Queries: resource("Queries", FunctionQueries), Query: resource("Query", FunctionQueries) },
  core: { PalantirApiError },
};
const NAMESPACES = { Admin: "admin", Datasets: "datasets", Filesystem: "filesystem", Ontologies: "ontologies", Functions: "functions" };

/** A package namespace: its resources, and a clear error for a resource this platform does not have. */
function pkg(name) {
  const p = PACKAGES[name];
  if (!p) return null;
  return new Proxy(p, {
    get: (target, k) => {
      if (typeof k !== "string" || k in target || k === "then" || k === "__esModule" || k === "default") return target[k];
      return resource(k, {});
    },
  });
}

/** `@osdk/foundry.<name>` (a package) or `@osdk/foundry.<name>/<Resource>` (one resource's functions). */
function subpackage(name, res) {
  const p = pkg(name);
  if (!p) throw new Error(`@osdk/foundry.${name} is not available here (available: ${Object.keys(PACKAGES).map((x) => "@osdk/foundry." + x).join(", ")})`);
  if (!res) return p;
  return p[res];
}

const root = { PalantirApiError };
for (const [ns, name] of Object.entries(NAMESPACES)) root[ns] = pkg(name);

module.exports = { root, subpackage, PalantirApiError, PACKAGES };
