/** The Slate runtime: the state of a running application and everything that recomputes from it.
 *
 * Scope (what {{handlebars}} see): variables, query results (with _response), function results, object sets
 * ({data, objectRids, aggregations}), object contexts, Foundry function results, widgets (their properties with
 * the user's state on top: selectedValue, text, selectedRows…), $global and sl_user_storage.
 * Automatic queries, functions, object sets, contexts and Foundry functions re-run when the values they read change
 * (their dependency signature); manual ones only through events. Functions and event code run one at a time in a
 * Web Worker (no DOM; lodash, moment, numeral and math.js when the CDN is reachable). */
import { API_URL } from "./api";
import { functions as fnRegistry } from "./actions";
import { ontology } from "./ontology";
import { GLOBAL_ACTIONS, GLOBAL_EVENTS, slate, type SlateDocument, type SlateViewState, type SlateWidget } from "./slate";
import { checkJsonTemplate, dependencies, dependenciesOf, jsonPath, render, type Scope } from "./slateHandlebars";
import { workshop, type Filter } from "./workshop";
import { allowExport } from "./checkpoints";

/** A full navigation out of the application (the runtime is not a component: no router). */
const leave = (url: string) => window.location.assign(url);
export const DISABLE = "__slDisableAction__";
export type Status = { hasRun: boolean; success: boolean; running: boolean; message: string | null; ms?: number };
export type LogEntry = { at: number; kind: "query" | "function" | "event" | "action" | "error"; name: string; message: string };

const WORKER = `
let libs = null;
function loadLibs() {
  if (libs) return libs;
  libs = {};
  const tries = [["_", "https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js"], ["moment", "https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.30.1/moment.min.js"],
                 ["numeral", "https://cdnjs.cloudflare.com/ajax/libs/numeral.js/2.0.6/numeral.min.js"], ["math", "https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.2/math.min.js"]];
  for (const [name, url] of tries) { try { importScripts(url); libs[name] = self[name]; } catch (e) { libs[name] = undefined; } }
  return libs;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
self.onmessage = async (ev) => {
  const { id, code, library, useLibs } = ev.data;
  try {
    const l = useLibs ? loadLibs() : {};
    const fn = new AsyncFunction("_", "moment", "numeral", "math", (library || "") + "\\n" + code);
    const value = await fn(l._, l.moment, l.numeral, l.math);
    self.postMessage({ id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};`;

class JsQueue {
  private worker: Worker | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private start() {
    if (!this.worker) this.worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    return this.worker;
  }
  /** Run one piece of code after the previous ones (Slate runs functions sequentially). */
  run(code: string, library: string, timeoutMs = 15000): Promise<unknown> {
    const useLibs = /\b(_|moment|numeral|math)\s*[.(]/.test(code + library);
    const job = () =>
      new Promise<unknown>((resolve, reject) => {
        const w = this.start();
        const id = ++this.seq;
        const timer = setTimeout(() => {
          w.terminate();
          this.worker = null;
          reject(new Error(`timed out after ${timeoutMs / 1000} s`));
        }, timeoutMs);
        const on = (ev: MessageEvent) => {
          if (ev.data.id !== id) return;
          clearTimeout(timer);
          w.removeEventListener("message", on);
          if (ev.data.ok) resolve(ev.data.value);
          else reject(new Error(ev.data.error));
        };
        w.addEventListener("message", on);
        w.postMessage({ id, code, library, useLibs });
      });
    const p = this.chain.then(job, job);
    this.chain = p.catch(() => {});
    return p;
  }
  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}

function allWidgets(doc: SlateDocument): SlateWidget[] {
  const out: SlateWidget[] = [];
  const walk = (ws: SlateWidget[]) =>
    ws.forEach((w) => {
      out.push(w);
      walk(w.children ?? []);
    });
  doc.pages.forEach((p) => walk(p.widgets));
  walk(doc.toolbar);
  return out;
}

const parseDefault = (s: string): unknown => {
  if (s === undefined || s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export type RuntimeOptions = {
  appId: string | null;
  isEditMode: boolean;
  publicApp?: boolean;
  user?: { id: string; username?: string; display_name?: string; email?: string } | null;
  urlParams?: Record<string, string>;
  onNavigate?: (page: string) => void;
};

export class SlateRuntime {
  doc: SlateDocument;
  opts: RuntimeOptions;
  page: string;
  variables: Record<string, unknown> = {};
  widgetState: Record<string, Record<string, unknown>> = {};
  results: Record<string, unknown> = {};
  status: Record<string, Status> = {};
  userStorage: unknown = {};
  log: LogEntry[] = [];
  private sigs: Record<string, string> = {};
  private listeners = new Set<() => void>();
  private js = new JsQueue();
  private scheduled = false;
  private channels: Record<string, BroadcastChannel> = {};
  private children: Record<string, Window> = {};
  private version = 0;
  private stopped = false;
  /** Set by the editor: writes a widget's properties into the document (a graph's node positions in Manual layout,
   *  which Slate keeps on save). Not set when viewing. */
  private persister?: (id: string, patch: Record<string, unknown>) => void;
  setPersister(fn: ((id: string, patch: Record<string, unknown>) => void) | undefined) {
    this.persister = fn;
  }
  /** Writes a widget's properties into the document when an editor is attached (no-op when viewing). */
  persistWidgetProps(id: string, patch: Record<string, unknown>) {
    this.persister?.(id, patch);
  }

  constructor(doc: SlateDocument, opts: RuntimeOptions) {
    this.doc = doc;
    this.opts = opts;
    this.page = doc.pages[0]?.name ?? "home";
    this.resetVariables();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getVersion = () => this.version;
  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** A new document (the editor changed it): keep the running state, recompute what changed. */
  setDocument(doc: SlateDocument) {
    const known = new Set(Object.keys(this.variables));
    this.doc = doc;
    for (const v of doc.variables) if (!known.has(v.name)) this.variables[v.name] = parseDefault(v.default);
    this.schedule();
    this.notify();
  }

  resetVariables() {
    this.variables = {};
    for (const v of this.doc.variables) this.variables[v.name] = parseDefault(v.default);
    for (const [k, val] of Object.entries(this.opts.urlParams ?? {})) if (k in this.variables) this.variables[k] = val;
  }

  async start() {
    this.stopped = false;
    if (this.opts.appId && !this.opts.publicApp) {
      try {
        this.userStorage = (await slate.getStorage(this.opts.appId)).value ?? {};
      } catch {
        this.userStorage = {};
      }
    }
    this.schedule();
    setTimeout(() => {
      this.fire("slate.ready", null);
      this.fire(`slate.onNavigate[${this.page}]`, this.page);
    }, 0);
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { target?: string; message?: unknown; slateActionOption?: { type: string; payload: unknown } } | null;
      if (!d || typeof d !== "object") return;
      if (d.slateActionOption?.type === "SET_VARIABLES" && d.slateActionOption.payload && typeof d.slateActionOption.payload === "object") {
        Object.entries(d.slateActionOption.payload as object).forEach(([k, v]) => this.setVariable(k, v));
      }
      if (d.target === "slate-parent-iframe-event" || d.target === "SLATE_MESSAGING_SERVICE") this.fire("slate.getMessage", d.target === "slate-parent-iframe-event" ? d.message : d);
    };
    const onResize = () => this.fire("slate.resize", { width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    // child windows opened by slate.redirectToUrl with windowSharingOptions: tell when one closes
    const watch = setInterval(() => {
      for (const [id, win] of Object.entries(this.children))
        if (win.closed) {
          delete this.children[id];
          this.fire("slate.onChildWindowClosed", { id });
        }
    }, 1000);
    this.cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      clearInterval(watch);
      Object.values(this.channels).forEach((c) => c.close());
      this.channels = {};
    };
    // a shareable view (?view=<id>): its saved widget state and local variables override the defaults
    const viewId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
    if (viewId) void this.loadView(viewId).catch((e: Error) => this.addLog("error", "slate.loadView", e.message));
  }
  private cleanup: () => void = () => {};
  stop() {
    this.stopped = true;
    this.cleanup();
    this.js.stop();
  }

  private addLog(kind: LogEntry["kind"], name: string, message: string) {
    this.log = [{ at: Date.now(), kind, name, message }, ...this.log].slice(0, 200);
  }

  // ----------------------------------------------------------------------------------------------
  // scope
  // ----------------------------------------------------------------------------------------------

  private baseScope(): Scope {
    const u = this.opts.user;
    const scope: Scope = {
      $global: {
        locale: typeof navigator !== "undefined" ? navigator.language : "en",
        app: { isEditMode: this.opts.isEditMode, rid: this.opts.appId ? `ri.slate.main.document.${this.opts.appId}` : null, page: this.page },
        user: u ? { id: u.id, username: u.username, firstName: (u.display_name ?? u.username ?? "").split(" ")[0], displayName: u.display_name ?? u.username, email: u.email } : null,
        url: typeof window !== "undefined" ? { href: window.location.href, params: this.opts.urlParams ?? {} } : {},
      },
      sl_user_storage: this.userStorage,
      ...this.results,
      ...this.variables,
    };
    for (const [name, st] of Object.entries(this.status)) {
      const r = scope[name];
      if (r && typeof r === "object" && !Array.isArray(r)) scope[name] = { ...(r as object), _response: st };
    }
    return scope;
  }

  /** The scope with every widget's resolved properties (two passes, so widgets can read each other). */
  scope(): Scope {
    const base = this.baseScope();
    const ws = allWidgets(this.doc);
    const pass = (s: Scope) => {
      const out: Scope = { ...s };
      for (const w of ws) {
        const props = this.safeRender(w.props, s) as Record<string, unknown>;
        const st = this.widgetState[w.id] ?? {};
        out[w.id] = { ...props, ...st };
        // a graph's dragged node positions sit inside `nodes`, next to ids / labels that may come from a query
        if (w.type === "graph" && st.nodes && typeof st.nodes === "object") (out[w.id] as Record<string, unknown>).nodes = { ...((props?.nodes as object) ?? {}), ...(st.nodes as object) };
      }
      return out;
    };
    return pass(pass(base));
  }

  private safeRender(v: unknown, s: Scope) {
    try {
      return render(v, s, "value");
    } catch {
      return v;
    }
  }

  /** A widget's properties for display. */
  widgetProps(w: SlateWidget, scope: Scope): Record<string, unknown> {
    return (scope[w.id] as Record<string, unknown>) ?? {};
  }

  // ----------------------------------------------------------------------------------------------
  // state changes
  // ----------------------------------------------------------------------------------------------

  setVariable(name: string, value: unknown) {
    if (!(name in this.variables) && !this.doc.variables.some((v) => v.name === name)) return;
    const before = JSON.stringify(this.variables[name]);
    this.variables[name] = value;
    if (JSON.stringify(value) !== before) {
      this.fire(`${name}.changed`, value);
      this.schedule();
      this.notify();
    }
  }

  setWidget(id: string, patch: Record<string, unknown>, event?: { name: string; value: unknown }) {
    this.widgetState[id] = { ...(this.widgetState[id] ?? {}), ...patch };
    this.schedule();
    this.notify();
    if (event) this.fire(`${id}.${event.name}`, event.value);
  }

  navigate(page: string) {
    if (!this.doc.pages.some((p) => p.name === page)) return;
    this.page = page;
    this.opts.onNavigate?.(page);
    this.notify();
    this.fire(`slate.onNavigate[${page}]`, page);
  }

  // ----------------------------------------------------------------------------------------------
  // automatic recomputation
  // ----------------------------------------------------------------------------------------------

  schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.refresh();
    });
  }

  private signature(deps: string[], scope: Scope) {
    try {
      return JSON.stringify(deps.map((d) => scope[d]));
    } catch {
      return String(Math.random());
    }
  }

  private async refresh() {
    const scope = this.scope();
    const auto: { name: string; deps: string[]; run: () => Promise<void> }[] = [];
    for (const q of this.doc.queries) if (q.run === "auto") auto.push({ name: q.name, deps: dependencies(q.template), run: () => this.runQuery(q.name) });
    for (const f of this.doc.functions) if (f.run === "auto") auto.push({ name: f.name, deps: dependencies(f.code), run: () => this.runFunction(f.name) });
    for (const o of this.doc.objectSets) auto.push({ name: o.name, deps: dependenciesOf(o.filters), run: () => this.runObjectSet(o.name) });
    for (const o of this.doc.objectContexts) auto.push({ name: o.name, deps: dependenciesOf([o.pk, o.object_type_id]), run: () => this.runObjectContext(o.name) });
    for (const f of this.doc.foundryFunctions) if (f.run === "auto") auto.push({ name: f.name, deps: dependenciesOf(f.inputs), run: () => this.runFoundryFunction(f.name) });
    const due = auto.filter((a) => {
      const sig = a.deps.filter((d) => d !== a.name).length ? this.signature(a.deps, scope) : "static";
      const key = `${a.name}:${JSON.stringify(a.deps)}`;
      if (this.sigs[a.name] === `${key}:${sig}`) return false;
      this.sigs[a.name] = `${key}:${sig}`;
      return true;
    });
    for (const a of due) void a.run();
  }

  /** The document changed in the editor: re-run everything (the signatures depend on the definitions too). */
  invalidate(name?: string) {
    if (name) delete this.sigs[name];
    else this.sigs = {};
    this.schedule();
  }

  private setStatus(name: string, st: Partial<Status>) {
    const prev: Status = this.status[name] ?? { hasRun: false, success: false, running: false, message: null };
    this.status[name] = { ...prev, ...st };
  }

  private done(name: string, value: unknown, ms: number, kind: "query" | "function", ok = true, message: string | null = null) {
    if (ok) this.results[name] = value;
    this.setStatus(name, { hasRun: true, success: ok, running: false, message, ms });
    this.addLog(ok ? kind : "error", name, ok ? `${kind} ran in ${ms} ms` : (message ?? "failed"));
    this.schedule();
    this.notify();
    if (kind === "query") this.fire(`${name}.${ok ? "success" : "failure"}`, ok ? value : message);
    else this.fire(`${name}.ran`, value);
  }

  async runQuery(name: string) {
    const q = this.doc.queries.find((x) => x.name === name);
    if (!q) return;
    const t0 = performance.now();
    this.setStatus(name, { running: true });
    this.notify();
    try {
      const scope = this.scope();
      let value: unknown;
      if (q.source === "foundry") {
        if (this.opts.publicApp) throw new Error("public applications cannot read Foundry data");
        const sql = String(render(q.template, scope, "sql"));
        value = (await slate.runQuery(this.opts.appId!, { kind: "foundry_sql", sql })).data ?? {};
      } else if (q.source === "api-gateway") {
        if (this.opts.publicApp) throw new Error("public applications cannot call the platform API");
        const reqObj = JSON.parse(String(render(q.template, scope, "text"))) as { method?: string; path: string; body?: unknown };
        if (!String(reqObj.path).startsWith("/api/") || reqObj.path.includes("..")) throw new Error("API Gateway paths start with /api/ (no ..)");
        const res = await fetch(API_URL + reqObj.path, {
          method: reqObj.method ?? "GET",
          credentials: "include",
          headers: reqObj.body !== undefined ? { "content-type": "application/json" } : undefined,
          body: reqObj.body !== undefined ? JSON.stringify(reqObj.body) : undefined,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body as { detail?: string })?.detail ?? res.statusText);
        value = q.extractors && Object.keys(q.extractors).length ? Object.fromEntries(Object.entries(q.extractors).map(([k, p]) => [k, jsonPath(body, p)])) : body;
      } else if (q.source === "secure-upload") {
        const why = checkJsonTemplate(q.template);
        if (why) throw new Error(why);
        const reqObj = JSON.parse(String(render(q.template, scope, "text"))) as { token: string; data: unknown };
        value = await slate.publicUpload(reqObj.token, reqObj.data);
      } else {
        if (this.opts.publicApp) throw new Error("public applications cannot call external sources");
        const why = checkJsonTemplate(q.template);
        if (why) throw new Error(why);
        const reqObj = JSON.parse(String(render(q.template, scope, "text")));
        const out = await slate.runQuery(this.opts.appId!, { kind: "http_json", source: q.source, request: reqObj });
        const extractors = (reqObj.extractors as Record<string, string> | undefined) ?? q.extractors ?? { result: "$" };
        value = Object.fromEntries(Object.entries(extractors).map(([k, p]) => [k, jsonPath(out.body, p)]));
      }
      this.done(name, value, Math.round(performance.now() - t0), "query");
    } catch (e) {
      this.done(name, null, Math.round(performance.now() - t0), "query", false, (e as Error).message);
    }
  }

  async runFunction(name: string) {
    const f = this.doc.functions.find((x) => x.name === name);
    if (!f) return;
    const t0 = performance.now();
    this.setStatus(name, { running: true });
    try {
      const code = String(render(f.code, this.scope(), "js"));
      const value = await this.js.run(code, this.doc.library ?? "");
      this.done(name, value, Math.round(performance.now() - t0), "function");
    } catch (e) {
      this.done(name, null, Math.round(performance.now() - t0), "function", false, (e as Error).message);
    }
  }

  async runObjectSet(name: string) {
    const o = this.doc.objectSets.find((x) => x.name === name);
    if (!o || !o.object_type_id) return;
    const t0 = performance.now();
    this.setStatus(name, { running: true });
    try {
      const scope = this.scope();
      const filters: Filter[] = o.filters
        .filter((f) => f.property)
        .map((f) => {
          let value = render(f.value, scope, "value");
          if (f.op === "in" && typeof value === "string") {
            try {
              value = JSON.parse(value);
            } catch {
              value = (value as string).split(",").map((s: string) => s.trim());
            }
          }
          return { column: f.property, op: f.op, value };
        })
        // a filter whose value is empty (an input nobody filled) is ignored
        .filter((f) => f.op === "is_null" || f.op === "not_null" || !(f.value === null || f.value === undefined || f.value === "" || (Array.isArray(f.value) && !f.value.length)));
      const source = { kind: "object_type" as const, id: o.object_type_id };
      const rows = await workshop.query({ source, filters, filter_mode: o.filter_mode, columns: [], sort: o.sort?.property, descending: o.sort?.descending, limit: o.limit || 100 });
      const cols = rows.columns.map((c) => c.name);
      const data: Record<string, unknown[]> = Object.fromEntries(cols.map((c) => [c, (rows.rows ?? []).map((r) => r[c] ?? null)]));
      const aggregations: Record<string, unknown> = {};
      for (const a of o.aggregations) {
        const r = await workshop.query({ source, filters, filter_mode: o.filter_mode, metric: a.metric, metric_column: a.property, limit: 0 });
        aggregations[a.name] = r.value;
      }
      this.done(name, { data, objectRids: (rows.rows ?? []).map((r) => r.__pk), totalCount: rows.total, aggregations }, Math.round(performance.now() - t0), "query");
    } catch (e) {
      this.done(name, null, Math.round(performance.now() - t0), "query", false, (e as Error).message);
    }
  }

  async runObjectContext(name: string) {
    const o = this.doc.objectContexts.find((x) => x.name === name);
    if (!o || !o.object_type_id) return;
    const t0 = performance.now();
    try {
      const pk = render(o.pk, this.scope(), "value");
      if (pk === null || pk === undefined || pk === "") {
        this.done(name, null, 0, "query");
        return;
      }
      const obj = await ontology.object(o.object_type_id, String(pk));
      this.done(name, { ...obj.properties, $primaryKey: obj.primary_key, $title: obj.title }, Math.round(performance.now() - t0), "query");
    } catch (e) {
      this.done(name, null, Math.round(performance.now() - t0), "query", false, (e as Error).message);
    }
  }

  async runFoundryFunction(name: string) {
    const f = this.doc.foundryFunctions.find((x) => x.name === name);
    if (!f || !f.function_id) return;
    const t0 = performance.now();
    this.setStatus(name, { running: true });
    try {
      const scope = this.scope();
      const inputs = Object.fromEntries(Object.entries(f.inputs).map(([k, v]) => [k, render(v, scope, "value")]));
      const r = await fnRegistry.execute(f.function_id, inputs, f.version || undefined, "slate");
      if (!r.ok) throw new Error(r.error ?? "the function failed");
      this.done(name, r.value, Math.round(performance.now() - t0), "function");
    } catch (e) {
      this.done(name, null, Math.round(performance.now() - t0), "function", false, (e as Error).message);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // events and actions
  // ----------------------------------------------------------------------------------------------

  fire(trigger: string, value: unknown) {
    const evs = this.doc.events.filter((e) => e.trigger === trigger);
    for (const ev of evs) void this.handle(ev.code, ev.action, value, trigger);
  }

  private async handle(code: string, action: string, eventValue: unknown, trigger: string) {
    let result: unknown = eventValue;
    try {
      if (code.trim()) {
        const scope = { ...this.scope(), slEventValue: eventValue, slDisableAction: DISABLE };
        result = await this.js.run(String(render(code, scope, "js")), this.doc.library ?? "");
        if (result === DISABLE) {
          this.addLog("event", trigger, `${action} disabled by the event's code`);
          this.notify();
          return;
        }
      }
      this.addLog("event", trigger, `→ ${action}`);
      await this.act(action, result, eventValue);
    } catch (e) {
      this.addLog("error", trigger, `${action}: ${(e as Error).message}`);
      this.notify();
    }
  }

  async act(action: string, value: unknown, eventValue?: unknown) {
    const nav = /^slate\.navigateTo\[(.+)\]$/.exec(action);
    if (nav) return this.navigate(nav[1]);
    const [target, verb] = [action.slice(0, action.lastIndexOf(".")), action.slice(action.lastIndexOf(".") + 1)];
    if (target === "slate") {
      const v = (value ?? {}) as Record<string, unknown>;
      if (verb === "redirectToUrl") {
        // one target or several; target / popup as in window.open; windowSharingOptions.id keeps the child window
        // for slate.sendMessage and slate.onChildWindowClosed
        for (const one of Array.isArray(value) ? value : [value]) {
          const o = (one && typeof one === "object" ? one : {}) as Record<string, unknown>;
          const url = typeof one === "string" ? one : String(o.url ?? "");
          if (!/^(https?:|\/)/.test(url)) throw new Error("redirectToUrl needs an http(s) or / URL");
          const share = (o.windowSharingOptions ?? null) as { id?: string | number } | null;
          const target = o.target ? String(o.target) : o.newTab || o.popup || share ? "_blank" : "";
          if (!target || target === "_self") window.location.assign(url);
          else {
            const win = window.open(url, target, o.popup ? "popup,width=900,height=700" : share ? undefined : "noopener");
            if (win && share?.id !== undefined) this.children[String(share.id)] = win;
          }
        }
      } else if (verb === "scrollToId") {
        const id = typeof value === "string" ? value : String(v.id ?? "");
        (document.getElementById(id) ?? document.querySelector(`[data-slate-widget="${CSS.escape(id)}"]`))?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (verb === "setWindowTitle") document.title = typeof value === "string" ? value : String(v.title ?? "");
      else if (verb === "exportWidget") await this.exportWidget(v);
      else if (verb === "createBroadcastChannel") {
        const name = typeof value === "string" ? value : String(v.channel ?? "");
        if (!name) throw new Error("createBroadcastChannel needs {channel}");
        if (!this.channels[name]) {
          const c = new BroadcastChannel(name);
          c.onmessage = (e) => this.fire("slate.getBroadcast", { channel: name, data: e.data });
          this.channels[name] = c;
        }
      } else if (verb === "closeBroadcastChannel") {
        const name = typeof value === "string" ? value : String(v.channel ?? "");
        this.channels[name]?.close();
        delete this.channels[name];
      } else if (verb === "broadcastMessage") {
        const c = this.channels[String(v.channel ?? "")];
        if (!c) throw new Error(`broadcastMessage: open the channel ${String(v.channel ?? "")} first (slate.createBroadcastChannel)`);
        c.postMessage(v.message ?? null);
      } else if (verb === "showCheckpoint") {
        // no Checkpoints application on this platform: every checkpoint closes as "no-checkpoint"
        setTimeout(() => this.fire("slate.onCloseCheckpoint", { slateCheckpointId: String(v.slateCheckpointId ?? ""), status: "no-checkpoint" }), 0);
      } else if (verb === "openAppsPortal") leave("/apps");
      else if (verb === "logout") {
        if (window.confirm("Log out?")) {
          await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
          leave("/login");
        }
      } else if (verb === "saveView") await this.saveView();
      else if (verb === "loadView") {
        const id = typeof value === "string" ? value : String(v.id ?? v.viewId ?? "");
        const u = new URL(window.location.href);
        u.searchParams.set("view", id);
        window.history.replaceState(window.history.state, "", u.toString());
        await this.loadView(id);
      } else if (verb === "copyToClipboard") await navigator.clipboard?.writeText(typeof value === "string" ? value : JSON.stringify(value));
      else if (verb === "downloadBlob") {
        if (!(await allowExport({ type: "slate_export", item_id: this.opts.appId, detail: String(v.fileName ?? "download") }))) return;
        const data = typeof v.data === "string" ? v.data : JSON.stringify(v.data ?? value);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(v.blob instanceof Blob ? v.blob : new Blob([data], { type: String(v.mimeType ?? "text/plain") }));
        a.download = String(v.fileName ?? "download.txt");
        a.click();
      } else if (verb === "setUserStorage") {
        this.userStorage = value ?? {};
        if (this.opts.appId && !this.opts.publicApp) await slate.putStorage(this.opts.appId, this.userStorage).catch(() => {});
        this.schedule();
        this.notify();
        this.fire("slate.userStorageChanged", this.userStorage);
      } else if (verb === "print") {
        window.print();
        this.fire("slate.onPrint", null);
      } else if (verb === "sendMessage") {
        // {targetOptions: {targetWindow: child | opener | parent, children?}, message}, or a plain payload to the parent
        const to = (v.targetOptions ?? null) as { targetWindow?: string; children?: (string | number)[] } | null;
        if (!to) window.parent?.postMessage({ target: "slate-child-iframe-event", source: "slate-parent-iframe-action", message: value }, "*");
        else {
          const msg = { target: "slate-parent-iframe-event", source: "slate-parent-iframe-action", message: v.message ?? null };
          if (to.targetWindow === "child") {
            for (const [id, win] of Object.entries(this.children)) if (!to.children || to.children.map(String).includes(id)) win.postMessage(msg, "*");
          }
          else (to.targetWindow === "opener" ? window.opener : window.parent)?.postMessage(msg, "*");
        }
      } else throw new Error(`unknown action ${action}`);
      return;
    }
    if (this.doc.variables.some((x) => x.name === target) && verb === "set") return this.setVariable(target, value);
    if (this.doc.queries.some((x) => x.name === target) || this.doc.objectSets.some((x) => x.name === target)) {
      if (verb === "run") return this.doc.queries.some((x) => x.name === target) ? this.runQuery(target) : this.runObjectSet(target);
      if (verb === "exportCsv") return this.exportCsv(target);
    }
    if (this.doc.functions.some((x) => x.name === target) && verb === "run") return this.runFunction(target);
    if (this.doc.foundryFunctions.some((x) => x.name === target) && verb === "run") return this.runFoundryFunction(target);
    const w = allWidgets(this.doc).find((x) => x.id === target);
    if (w) {
      if (verb === "open") return this.setWidget(w.id, { open: true }, { name: "opened", value: null });
      if (verb === "close") return this.setWidget(w.id, { open: false }, { name: "closed", value: null });
      if (verb === "show") {
        this.setWidget(w.id, { open: true, ...(typeof value === "string" ? { message: value } : {}) });
        const t = Number((this.scope()[w.id] as Record<string, unknown>)?.timeout ?? 3000);
        if (t > 0) setTimeout(() => this.setWidget(w.id, { open: false }, { name: "closed", value: null }), t);
        return;
      }
      if (verb === "hide") return this.setWidget(w.id, { open: false });
      if (verb === "clear") return this.setWidget(w.id, { selectedValue: null, selectedValues: [], text: "", selectedDate: "", data: null, fileName: null, ...(w.type === "daterange" ? { fromDateValue: null, toDateValue: null } : {}) });
      if (verb === "clearSelection")
        return this.setWidget(w.id, w.type === "tree" ? { selected: [], selectedNodes: [] } : w.type === "graph" ? { selectedNodeIds: [] } : w.type === "map" ? { selection: { layer: null, ids: [] } }
          : w.type === "heatgrid" ? { selection: { indices: [], cellValues: [], xValues: [], yValues: [] } } : { selectedRowKeys: [], selectedRows: [], selectedIndex: null });
      if (verb === "select") return this.setWidget(w.id, { selectedTab: Number(value ?? eventValue ?? 0) });
      if (verb === "fit") {
        const camera = { x: null, y: null, ratio: null };
        return this.setWidget(w.id, { camera }, { name: "camera.changed", value: camera });
      }
      if (verb === "submit") {
        this.widgetState[w.id] = { ...(this.widgetState[w.id] ?? {}), submitRequest: Date.now() };
        this.notify();
        return;
      }
    }
    throw new Error(`unknown action ${action}`);
  }

  // ----------------------------------------------------------------------------------------------
  // shareable views, widget export
  // ----------------------------------------------------------------------------------------------

  /** The state a shareable view keeps: every widget's interaction properties and the local variables. */
  viewState(): SlateViewState {
    const local = new Set(this.doc.variables.filter((v) => v.scope !== "shared").map((v) => v.name));
    return { widgets: structuredClone(this.widgetState), variables: Object.fromEntries(Object.entries(this.variables).filter(([k]) => local.has(k))) };
  }

  async saveView(): Promise<string> {
    if (!this.opts.appId || this.opts.publicApp) throw new Error("shareable views need a saved (non-public) application");
    const { id } = await slate.saveView(this.opts.appId, this.viewState());
    this.fire("slate.viewSaved", id);
    return id;
  }

  /** Apply a saved view: widgets and variables that still exist (by name) take the saved values. */
  async loadView(viewId: string) {
    if (!this.opts.appId) throw new Error("shareable views need a saved application");
    const { state } = await slate.getView(this.opts.appId, viewId);
    const known = new Map(allWidgets(this.doc).map((w) => [w.id, w]));
    for (const [id, st] of Object.entries(state.widgets ?? {})) if (known.has(id)) this.widgetState[id] = { ...(this.widgetState[id] ?? {}), ...st };
    for (const [k, v] of Object.entries(state.variables ?? {})) if (this.doc.variables.some((x) => x.name === k && x.scope !== "shared")) this.variables[k] = v;
    this.schedule();
    this.notify();
  }

  /** A widget as a PNG or a one-page PDF (copied, downloaded, or only reported by slate.onExportWidget). */
  async exportWidget(o: Record<string, unknown>) {
    const id = String(o.widgetId ?? "");
    const w = allWidgets(this.doc).find((x) => x.id === id);
    if (!w) throw new Error(`exportWidget: no widget ${id}`);
    if (["iframe", "codesandbox", "multiselect"].includes(w.type)) throw new Error(`exportWidget: ${w.type} widgets cannot be exported`);
    const el = document.querySelector<HTMLElement>(`[data-slate-widget="${CSS.escape(id)}"]`);
    if (!el) throw new Error(`exportWidget: ${id} is not on the page`);
    const { widgetPng, pngToPdf } = await import("./slateExport");
    const png = await widgetPng(el);
    const pdf = o.outputType === "pdf";
    const blob = pdf ? await pngToPdf(png) : png;
    const base64 = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.readAsDataURL(blob);
    });
    const how = String(o.exportType ?? "download");
    if (how === "copy" && !pdf) await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    else if (how !== "eventOnly") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${String(o.fileName ?? id)}.${pdf ? "pdf" : "png"}`;
      a.click();
    }
    this.fire("slate.onExportWidget", { widgetId: id, base64 });
  }

  async exportCsv(name: string) {
    if (!(await allowExport({ type: "slate_export", item_id: this.opts.appId, detail: `${name}.csv` }))) return;
    const r = this.results[name] as Record<string, unknown> | undefined;
    const data = (r?.data ?? r) as Record<string, unknown[]> | undefined;
    if (!data || typeof data !== "object") return;
    const cols = Object.keys(data).filter((k) => Array.isArray(data[k]));
    const n = Math.max(0, ...cols.map((c) => data[c].length));
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...Array.from({ length: n }, (_, i) => cols.map((c) => esc(data[c][i])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${name}.csv`;
    a.click();
  }

  /** Every trigger and action name the document offers (for the Events editor). */
  catalog(specs: (type: SlateWidget["type"]) => { events: string[]; actions: string[] }) {
    const triggers = [...GLOBAL_EVENTS.filter((e) => e !== "slate.onNavigate"), ...this.doc.pages.map((p) => `slate.onNavigate[${p.name}]`)];
    const actions: string[] = [...GLOBAL_ACTIONS.filter((a) => a !== "slate.navigateTo"), ...this.doc.pages.map((p) => `slate.navigateTo[${p.name}]`)];
    for (const w of allWidgets(this.doc)) {
      const s = specs(w.type);
      triggers.push(...s.events.map((e) => `${w.id}.${e}`));
      actions.push(...s.actions.map((a) => `${w.id}.${a}`));
    }
    for (const q of this.doc.queries) {
      triggers.push(`${q.name}.success`, `${q.name}.failure`);
      actions.push(`${q.name}.run`, `${q.name}.exportCsv`);
    }
    for (const o of this.doc.objectSets) {
      triggers.push(`${o.name}.success`, `${o.name}.failure`);
      actions.push(`${o.name}.run`, `${o.name}.exportCsv`);
    }
    for (const f of [...this.doc.functions, ...this.doc.foundryFunctions]) {
      triggers.push(`${f.name}.ran`);
      actions.push(`${f.name}.run`);
    }
    for (const v of this.doc.variables) {
      triggers.push(`${v.name}.changed`);
      actions.push(`${v.name}.set`);
    }
    return { triggers, actions };
  }
}

/** The dependency graph (for the Dependency graph panel): who reads whom. */
export function dependencyGraph(doc: SlateDocument) {
  const nodes: { id: string; kind: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const add = (id: string, kind: string, deps: string[]) => {
    nodes.push({ id, kind });
    deps.filter((d) => d !== id).forEach((d) => edges.push({ from: d, to: id }));
  };
  doc.variables.forEach((v) => add(v.name, "variable", []));
  doc.queries.forEach((q) => add(q.name, "query", dependencies(q.template)));
  doc.functions.forEach((f) => add(f.name, "function", dependencies(f.code)));
  doc.objectSets.forEach((o) => add(o.name, "object set", dependenciesOf(o.filters)));
  doc.objectContexts.forEach((o) => add(o.name, "object context", dependenciesOf(o.pk)));
  doc.foundryFunctions.forEach((f) => add(f.name, "Foundry function", dependenciesOf(f.inputs)));
  allWidgets(doc).forEach((w) => add(w.id, "widget", dependenciesOf(w.props)));
  const known = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => known.has(e.from)) };
}

export { allWidgets };
