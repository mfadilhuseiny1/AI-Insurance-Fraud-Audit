"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/api";
import { functions as fnRegistry } from "@/lib/actions";
import { ontology } from "@/lib/ontology";
import { emptyKeys, emptySet, extractVars, fillVars, isOsFilter, rankedSet, resolveVar, workshop, type Module, type SectionLayout, type Variable, type Widget, type WsEvent } from "@/lib/workshop";
import { evalTransform } from "@/lib/workshopTransforms";
import { timed } from "@/lib/workshopProfiler";
import { keepAlive } from "./CrossApp";
import { scenarios } from "@/lib/scenarios";
import { actions as fnActions } from "@/lib/actions";
import type { ModuleState } from "./WidgetView";

/** The name a variable is known by outside the module (URL parameters, embedding modules, Open module events). */
export const externalName = (v: Variable) => v.external_id || v.name;

/** A module's starting variable values: static defaults, then the given ones (by name or external ID). */
export function initialVariables(vars: Variable[] | undefined, given: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of vars ?? []) if ((v.definition?.kind ?? "static") === "static" && v.default !== undefined && v.default !== "") out[v.name] = coerce(v, v.default);
  for (const [k, val] of Object.entries(given)) {
    const v = vars?.find((x) => x.name === k || (x.external_id && x.external_id === k));
    if (v) out[v.name] = coerce(v, val);
    else out[k] = val;
  }
  return out;
}

export function coerce(v: Pick<Variable, "type">, val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (v.type === "number") return typeof val === "number" ? val : val === "" ? undefined : Number(val);
  if (v.type === "boolean") return typeof val === "boolean" ? val : String(val) === "true";
  if (v.type === "struct" || v.type === "struct_array" || v.type === "object_set_filter") {
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  if (v.type === "array" || v.type === "object_set") return Array.isArray(val) ? val : String(val).split(",").map((x) => x.trim()).filter(Boolean);
  return val;
}

/** The value an event or a parameter gives: $var:name, a lone {{name}} (keeps the type), text with {{name}}, or a constant. */
export function valueOf(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v !== "string") return v;
  const one = v.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
  if (one) return vars[one[1]];
  if (v.startsWith("$var:")) return resolveVar(v, vars);
  return v.includes("{{") ? fillVars(v, vars) : v;
}

/** The variables a definition reads. */
export function definitionInputs(v: Variable): string[] {
  const d = v.definition;
  if (!d) return [];
  const refs = (x: unknown): string[] => {
    const s = JSON.stringify(x ?? "");
    return [...s.matchAll(/\$var:([\w-]+)|\{\{\s*([\w-]+)\s*\}\}|"var":"([\w-]+)"/g)].map((m) => m[1] || m[2] || m[3]);
  };
  if (d.kind === "transform") return [...new Set(refs(d.steps))];
  if (d.kind === "sql") return [...new Set(d.params.map((p) => p.variable))];
  if (d.kind === "property") return d.object ? refs(d.object) : [];
  return [...new Set(refs(d))];
}

/** SQL results shaped by the variable type (Workshop's rules: scalars need one row and one column, arrays one column, structs one row). */
export function shapeSql(v: Variable, r: { columns: { name: string }[]; rows: unknown[][] }): unknown {
  const cols = r.columns.map((c) => c.name);
  if (v.type === "struct" || v.type === "struct_array") {
    if (new Set(cols).size !== cols.length) throw new Error("column names must be unique: alias each one with AS");
    const structs = r.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    if (v.type === "struct_array") return structs;
    if (structs.length > 1) throw new Error("a struct variable needs exactly one row");
    return structs[0];
  }
  if (v.type === "array") {
    if (cols.length !== 1) throw new Error("an array variable needs exactly one column");
    return r.rows.flatMap((row) => (Array.isArray(row[0]) ? row[0] : [row[0]])).filter((x) => x !== null && x !== undefined);
  }
  if (cols.length !== 1 || r.rows.length !== 1) throw new Error(`a ${v.type} variable needs exactly one row and one column (got ${r.rows.length} × ${cols.length})`);
  return r.rows[0][0];
}

/** Compute one non-static, non-transform variable (functions, aggregations, object properties, SQL queries). */
export async function computeAsync(v: Variable, vars: Record<string, unknown>, selection: Record<string, string | undefined>): Promise<unknown> {
  const d = v.definition!;
  if (d.kind === "function") {
    const inputs: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(d.inputs ?? {})) inputs[k] = valueOf(x, vars);
    const r = await fnRegistry.execute(d.function_id, inputs, d.version || undefined, "workshop");
    if (!r.ok) throw new Error(r.error || "the function failed");
    return r.value;
  }
  if (d.kind === "aggregation") {
    if (!d.source) return undefined;
    const filters = (d.filters ?? []).map((f) => ({ ...f, value: valueOf(f.value, vars) }));
    const sid = d.scenario ? valueOf(d.scenario, vars) : undefined;
    const r = await workshop.query({ source: d.source, filters, metric: d.metric, metric_column: d.column, limit: 0, scenario_id: sid ? String(sid) : undefined });
    return r.value;
  }
  if (d.kind === "property") {
    const pk = d.object ? valueOf(d.object, vars) : selection[`object_type:${d.object_type_id}`];
    if (!pk) return undefined;
    const sid = d.scenario ? valueOf(d.scenario, vars) : undefined;
    if (sid) {
      // the object as it is in the scenario
      const res = await fetch(`${API_URL}/api/ontology/scenarios/${sid}/objects/${d.object_type_id}/${encodeURIComponent(String(pk))}`, { credentials: "include" });
      const o = await res.json();
      if (!res.ok) throw new Error(o.detail ?? res.statusText);
      return (o.properties ?? o.after ?? {})[d.property];
    }
    const o = await ontology.object(d.object_type_id, String(pk));
    return o.properties[d.property];
  }
  if (d.kind === "scenario_objects") {
    // saved scenarios: the scenario ids held by objects of a scenario object type
    const filters = (d.filters ?? []).map((f) => ({ ...f, value: valueOf(f.value, vars) }));
    const r = await workshop.query({ source: { kind: "object_type", id: d.object_type_id }, filters, columns: [d.id_property], limit: 500 });
    return (r.rows ?? []).map((x) => String(x[d.id_property] ?? "")).filter(Boolean);
  }
  if (d.kind === "knn") {
    // the query: a numeric array is a vector, anything else text; no query or no results: an empty object set (widgets
    // on it show no objects, as a KNN object set with nothing to search for has no neighbors)
    const q = valueOf(d.query, vars);
    const vector = Array.isArray(q) && q.length && q.every((x) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)))) ? q.map(Number) : undefined;
    const text = vector ? "" : Array.isArray(q) ? q.join(" ") : q === undefined || q === null ? "" : String(q);
    const none = () => (v.type === "object_set_filter" ? emptySet() : emptyKeys());
    if (!vector && !text.trim()) return none();
    const r = await workshop.knn({ object_type_id: d.object_type_id, ...(vector ? { vector } : { query: text.trim(), mode: d.mode ?? "semantic" }), property: d.property || undefined, k: d.k ?? 10, resource: "workshop" });
    if (!r.objects.length) return none();
    const pks = r.objects.map((o) => String(o.primary_key));
    return v.type === "object_set_filter" ? rankedSet(pks, Object.fromEntries(r.objects.map((o) => [String(o.primary_key), o.relevance]))) : pks;
  }
  if (d.kind === "sql") {
    const r = await workshop.sql({
      query: d.query,
      tables: Object.fromEntries(d.tables.filter((t) => t.alias && t.object_type_id).map((t) => [t.alias, t.object_type_id])),
      params: Object.fromEntries(d.params.filter((p) => p.alias && p.variable).map((p) => [p.alias, vars[p.variable] ?? null])),
    });
    if (r.row_count >= 10000) throw new Error("the query returns 10,000 rows or more: add a LIMIT");
    return shapeSql(v, r);
  }
  return undefined;
}

/** Shared state of a running module: filters, selections, variables (static and computed), the page, tabs, overlays and events. */
export function useModuleRuntime(
  mod: Module | null,
  opts: {
    initial?: Record<string, unknown>;
    renderCanvas: (key: string, widgets: Widget[], layout?: SectionLayout) => ReactNode;
    onApplyAction?: (actionTypeId: string) => void;
    /** kiosk mode: no Ontology writes; editing: auto-refresh can be off while building; lang: a translation to show */
    readOnly?: boolean;
    editing?: boolean;
    lang?: string | null;
  },
) {
  const router = useRouter();
  const [filters, setFilters] = useState<ModuleState["filters"]>({});
  const [selection, setSelection] = useState<ModuleState["selection"]>(() => ({ ...(mod?.settings?.default_selection ?? {}) }));
  const [version, setVersion] = useState(0);
  const [stat, setVariables] = useState<Record<string, unknown>>(() => initialVariables(mod?.variables, opts.initial));
  const [computed, setComputed] = useState<Record<string, { value?: unknown; error?: string; at?: string }>>({});
  const [recompute, setRecompute] = useState<Record<string, number>>({});
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const [page, setPage] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
  // collapsed state of collapsible sections (absent: the section's "collapsed by default")
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const pages = mod?.pages?.length ? mod.pages : [{ id: "main", name: "Page 1" }];
  const { renderCanvas, onApplyAction, readOnly = false, editing = false } = opts;
  // auto-refresh: poll when the watched object types last changed; a change reloads every widget (when updates are on)
  const [refreshOn, setRefreshOn] = useState(true);
  const ar = mod?.settings?.auto_refresh;
  const watched = ar?.enabled && !(editing && ar.disable_in_edit) ? (ar.object_type_ids ?? []).join(",") : "";
  const minSeconds = Math.max(10, ar?.min_seconds ?? 10);
  const lastSeen = useRef<string | null>(null);
  const keepSets = useMemo(() => (mod ? keepAlive(mod) : { never: new Set<string>(), eager: new Set<string>() }), [mod]);
  const refreshOnRef = useRef(refreshOn);
  useEffect(() => {
    refreshOnRef.current = refreshOn;
  }, [refreshOn]);
  useEffect(() => {
    if (!watched) return;
    lastSeen.current = null;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const f = await workshop.freshness(watched.split(","));
        const sig = JSON.stringify(Object.entries(f).map(([k, x]) => [k, x.version]));
        if (lastSeen.current !== null && sig !== lastSeen.current && refreshOnRef.current) setVersion((n) => n + 1);
        if (refreshOnRef.current || lastSeen.current === null) lastSeen.current = sig;
      } catch {
        // offline for a moment: the next poll tries again
      }
    };
    void check();
    const t = setInterval(check, minSeconds * 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [watched, minSeconds]);
  // translations: the chosen language (preview in edit mode, else the browser's when the module has it)
  const tr = useMemo(() => {
    const t = mod?.settings?.translations;
    if (!t?.enabled || !t.languages) return undefined;
    const want = opts.lang ?? (typeof navigator !== "undefined" ? navigator.language : "");
    const code = Object.keys(t.languages).find((k) => k === want) ?? Object.keys(t.languages).find((k) => want && k.split("-")[0] === want.split("-")[0]);
    const strings = code ? t.languages[code].strings : null;
    if (!strings) return undefined;
    return (s: string) => (s && strings[s] ? strings[s] : s);
  }, [mod?.settings?.translations, opts.lang]);
  const widgets = mod?.widgets;
  const defs = mod?.variables;

  // variables: static values and async results, then transformations (in dependency order, a few passes)
  const variables = useMemo(() => {
    const out: Record<string, unknown> = { ...stat };
    for (const [k, c] of Object.entries(computed)) out[k] = c.value;
    const transforms = (defs ?? []).filter((v) => v.definition?.kind === "transform");
    for (let pass = 0; pass < 4; pass++)
      for (const v of transforms) {
        try {
          out[v.name] = v.definition?.kind === "transform" ? evalTransform(v.definition.steps, out) : undefined;
        } catch {
          out[v.name] = undefined;
        }
      }
    return out;
  }, [stat, computed, defs]);

  // async definitions recompute when their inputs change (automatic), or only on recompute events
  const asyncVars = useMemo(() => (defs ?? []).filter((v) => ["function", "aggregation", "property", "sql", "scenario_objects", "knn"].includes(v.definition?.kind ?? "")), [defs]);
  const keys = asyncVars.map((v) => {
    const mode = v.recompute ?? "auto";
    const inputs = mode === "auto" ? definitionInputs(v).map((n) => variables[n]) : [];
    const sel = v.definition?.kind === "property" && mode === "auto" ? selection[`object_type:${(v.definition as { object_type_id: string }).object_type_id}`] : undefined;
    return JSON.stringify([v.name, v.definition, inputs, sel, recompute[v.name] ?? 0, mode === "auto" ? version : 0]);
  });
  const keyStr = keys.join("|");
  useEffect(() => {
    let stale = false;
    asyncVars.forEach((v) => {
      if ((v.recompute ?? "auto") === "event" && !recompute[v.name]) return;
      timed("variable", v.name, v.name, "", computeAsync(v, variables, selection)).then(
        (value) => !stale && setComputed((c) => ({ ...c, [v.name]: { value, at: new Date().toISOString() } })),
        (e: Error) => !stale && setComputed((c) => ({ ...c, [v.name]: { error: e.message, at: new Date().toISOString() } })),
      );
    });
    return () => {
      stale = true;
    };
    // keyStr holds every input that matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr]);

  // variable-backed page selection and overlay open state
  const pageVar = mod?.settings?.page_variable;
  const fromVar = pageVar ? String(variables[pageVar] ?? "") : "";
  const current = fromVar && pages.some((p) => p.id === fromVar) ? fromVar : page && pages.some((p) => p.id === page) ? page : pages[0].id;
  const backedOverlay = (mod?.overlays ?? []).find((o) => o.open_variable && variables[o.open_variable] === true)?.id ?? null;
  const openOverlay = backedOverlay ?? overlay;
  const setOverlayBacked = useCallback(
    (id: string | null) => {
      setOverlay(id);
      setVariables((v) => {
        let next = v;
        for (const o of mod?.overlays ?? []) if (o.open_variable) next = { ...next, [o.open_variable]: o.id === id };
        return next;
      });
    },
    [mod?.overlays],
  );
  const setTab = useCallback(
    (w: string, t: string) => {
      setTabs((x) => ({ ...x, [w]: t }));
      const tv = widgets?.find((x) => x.id === w)?.config.tab_variable;
      if (tv) setVariables((v) => ({ ...v, [tv]: t }));
    },
    [widgets],
  );
  const tabState = useMemo(() => {
    const out = { ...tabs };
    for (const w of widgets ?? []) if (w.type === "tabs" && w.config.tab_variable && variables[w.config.tab_variable]) out[w.id] = String(variables[w.config.tab_variable]);
    return out;
  }, [tabs, widgets, variables]);

  const runEvents = useCallback(
    async (events: WsEvent[]) => {
      const queue = [...events];
      while (queue.length) {
        const e = queue.shift()!;
        if (e.kind === "section") {
          const w = widgets?.find((x) => x.id === e.widget);
          if (w) setSections((s) => ({ ...s, [w.id]: e.action === "toggle" ? !(s[w.id] ?? !!w.config.collapsed) : e.action === "collapse" }));
        } else if (e.kind === "set_variable") setVariables((v) => ({ ...v, [e.variable]: valueOf(e.value, { ...variables, ...v }) }));
        else if (e.kind === "reset_variable") {
          const d = defs?.find((x) => x.name === e.variable);
          setVariables((v) => ({ ...v, [e.variable]: d?.default !== undefined && d.default !== "" ? coerce(d, d.default) : undefined }));
        } else if (e.kind === "recompute_variable") setRecompute((r) => ({ ...r, [e.variable]: (r[e.variable] ?? 0) + 1 }));
        else if (e.kind === "open_overlay") setOverlayBacked(e.overlay);
        else if (e.kind === "close_overlay") {
          // the overlay's own "on close" events run next
          queue.unshift(...((mod?.overlays ?? []).find((o) => o.id === openOverlay)?.on_close ?? []));
          setOverlayBacked(null);
        }
        else if (e.kind === "switch_tab") setTab(e.widget, e.tab);
        else if (e.kind === "go_page") {
          setPage(e.page);
          setOverlayBacked(null);
        } else if (e.kind === "refresh") setVersion((x) => x + 1);
        else if (e.kind === "apply_action") {
          if (!readOnly) onApplyAction?.(e.action_type_id);
        } else if (e.kind === "auto_refresh") setRefreshOn(e.enabled);
        else if (e.kind === "scenario") {
          const sid = String(variables[e.variable] ?? "");
          if (e.op === "create") {
            const sc = await scenarios.create({ name: `Scenario ${Date.now().toString(36).slice(-4)}`, description: "Workshop scenario" });
            setVariables((v) => ({ ...v, [e.variable]: sc.id, ...(e.list_variable ? { [e.list_variable]: [...(Array.isArray(v[e.list_variable]) ? (v[e.list_variable] as string[]) : []), sc.id] } : {}) }));
          } else if (sid && e.op === "save" && e.object_type_id && !readOnly) {
            // save to a scenario object: the id, name and object parameters fill from their type classes; a scenario
            // already saved updates its object
            await workshop.saveScenario(sid, { object_type_id: e.object_type_id, create_action_id: e.action_type_id, update_action_id: e.update_action_type_id });
            setVersion((n) => n + 1);
          } else if (sid && e.op === "save") {
            // persist the scenario; with an action, also its scenario object (id and name parameters)
            if (!e.action_type_id) await workshop.saveScenario(sid, {});
            const sc = await scenarios.update(sid, { persisted: true });
            if (e.action_type_id && !readOnly) await fnActions.apply(e.action_type_id, { ...(e.id_param ? { [e.id_param]: sc.rid ?? sc.id } : {}), ...(e.name_param ? { [e.name_param]: sc.name } : {}) });
          } else if (sid && e.op === "duplicate") {
            const sc = await workshop.duplicateScenario(sid);
            setVariables((v) => ({ ...v, [e.variable]: sc.id, ...(e.list_variable ? { [e.list_variable]: [...(Array.isArray(v[e.list_variable]) ? (v[e.list_variable] as string[]) : []), sc.id] } : {}) }));
          } else if (sid && e.op === "apply" && e.action_type_id && !readOnly) {
            await scenarios.merge(sid, e.action_type_id);
            setVersion((n) => n + 1);
          } else if (sid && e.op === "delete") {
            await scenarios.remove(sid);
            setVariables((v) => ({ ...v, [e.variable]: "", ...(e.list_variable ? { [e.list_variable]: (Array.isArray(v[e.list_variable]) ? (v[e.list_variable] as string[]) : []).filter((x) => x !== sid) } : {}) }));
          }
        } else if (e.kind === "send_command") {
          // to an embedded page (an iframe widget) or the window this module is embedded in
          const msg = { type: "bluesandai.command", command: e.command, payload: valueOf(e.payload, variables), from: mod?.id };
          if (e.target === "parent") window.parent?.postMessage(msg, "*");
          else (document.querySelector(`[data-iframe-widget="${e.target}"]`) as HTMLIFrameElement | null)?.contentWindow?.postMessage(msg, "*");
        }
        else if (e.kind === "llm_to_variable") {
          setVariables((v) => ({ ...v, [e.variable]: "…" }));
          const prompt = fillVars(e.prompt, variables);
          const res = await fetch(`${API_URL}/api/functions/llm/chat`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, model: e.model || undefined }) });
          const body = await res.json().catch(() => ({}));
          setVariables((v) => ({ ...v, [e.variable]: res.ok ? body.text : `Error: ${body.detail ?? res.statusText}` }));
        } else if (e.kind === "open_object") {
          const url = `/ontology/objects/${e.object_type_id}/${encodeURIComponent(String(valueOf(e.primary_key, variables) ?? ""))}`;
          if (e.new_tab) window.open(url, "_blank", "noopener");
          else router.push(url); // external URLs make a full navigation
        } else if (e.kind === "open_url" || e.kind === "open_module") {
          let url = e.kind === "open_url" ? fillVars(e.url, variables) : `/workshop/${e.module_id}`;
          if (e.kind === "open_module" && e.params) {
            const q = new URLSearchParams();
            for (const [k, x] of Object.entries(e.params)) {
              const val = valueOf(x, variables);
              if (val !== undefined && val !== null && val !== "") q.set(`v.${k}`, Array.isArray(val) ? val.join(",") : typeof val === "object" ? JSON.stringify(val) : String(val));
            }
            url += `?${q}`;
          }
          // redact mode stays on across navigation between modules
          if (e.kind === "open_module" && new URLSearchParams(window.location.search).get("workshop_enableRedactMode") === "true")
            url += `${url.includes("?") ? "&" : "?"}workshop_enableRedactMode=true`;
          // inside a Carbon workspace the module opens in a workspace tab (Carbon keeps its menu bar and tabs)
          const inCarbon = e.kind === "open_module" && window.parent !== window && new URLSearchParams(window.location.search).get("embed") === "1";
          if (inCarbon) window.parent.postMessage({ type: "bluesandai.carbon.open", module: { type: "workshop", id: e.module_id, params: Object.fromEntries(new URLSearchParams(url.split("?")[1] ?? "")) } }, window.location.origin);
          else if (e.new_tab) window.open(url, "_blank", "noopener");
          else router.push(url); // external URLs make a full navigation
        }
      }
    },
    [onApplyAction, variables, defs, setOverlayBacked, setTab, router, widgets, mod?.overlays, openOverlay, readOnly, mod?.id],
  );
  // commands: other applications (the parent window, embedded pages) run the module's declared commands
  const runRef = useRef(runEvents);
  useEffect(() => {
    runRef.current = runEvents;
  });
  const commands = mod?.settings?.commands;
  useEffect(() => {
    if (!commands?.length) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; command?: string; payload?: unknown } | null;
      if (!d || d.type !== "bluesandai.command") return;
      const cmd = commands.find((x) => x.name === d.command);
      (e.source as Window | null)?.postMessage({ type: "bluesandai.command.result", command: d.command, ok: !!cmd }, "*");
      if (!cmd) return;
      if (cmd.variable) setVariables((v) => ({ ...v, [cmd.variable!]: d.payload }));
      // the events see the payload: run them after the variable is set
      setTimeout(() => void runRef.current(cmd.events), 0);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [commands]);

  const state: ModuleState = useMemo(
    () => ({
      filters,
      variables,
      setVariable: (name, value) =>
        setVariables((v) => {
          // object set filter variables with extraction write the matching values into the variables their default uses
          const d = defs?.find((x) => x.name === name);
          const extra = d?.type === "object_set_filter" && d.extract && isOsFilter(d.default) ? extractVars(d.default, value, defs) : {};
          return { ...v, ...extra, [name]: value };
        }),
      setFilter: (src, column, value) => setFilters((f) => ({ ...f, [src]: { ...f[src], [column]: value } })),
      selection,
      select: (src, pk) => setSelection((s) => ({ ...s, [src]: pk })),
      version,
      bump: () => setVersion((v) => v + 1),
      moduleId: mod?.id,
      tabs: tabState,
      setTab,
      page: current,
      goPage: (p) => (pageVar ? setVariables((v) => ({ ...v, [pageVar]: p })) : setPage(p)),
      openOverlay: (o) => setOverlayBacked(o),
      closeOverlay: () => setOverlayBacked(null),
      renderContainer: (key) => {
        // a section's body uses the section's layout
        const owner = key.endsWith(":body") ? widgets?.find((w) => `${w.id}:body` === key) : undefined;
        // the module header: a toolbar (horizontal) or a scrolling column (vertical)
        if (key === "header") return renderCanvas(key, (widgets ?? []).filter((w) => w.parent === key), mod?.settings?.header?.orientation === "vertical" ? "flow" : "toolbar");
        return renderCanvas(key, (widgets ?? []).filter((w) => w.parent === key), owner?.type === "section" ? owner.config.section_layout ?? "grid" : undefined);
      },
      runEvents,
      derived: mod?.derived,
      sections,
      setSection: (id, collapsed) => setSections((s) => ({ ...s, [id]: collapsed })),
      tr,
      readOnly,
      autoRefresh: watched ? refreshOn : undefined,
      variableTypes: Object.fromEntries((defs ?? []).map((v) => [v.name, v.type])),
      keep: keepSets,
    }),
    [filters, variables, selection, version, mod?.id, tabState, setTab, current, pageVar, renderCanvas, widgets, runEvents, setOverlayBacked, mod?.derived, sections, mod?.settings?.header?.orientation, tr, readOnly, watched, refreshOn, defs, keepSets],
  );
  const choosePage = (p: string) => (pageVar ? setVariables((v) => ({ ...v, [pageVar]: p })) : setPage(p));
  return { state, page: current, pages, setPage: choosePage, overlay: openOverlay, setOverlay: setOverlayBacked, setVariables, setFilters, setSelection, computed };
}

/** The widgets of a page (widgets without a parent belong to the first page). */
export function pageWidgets(mod: Module, page: string): Widget[] {
  const first = mod.pages?.[0]?.id ?? "main";
  return mod.widgets.filter((w) => (w.parent ? w.parent === `page:${page}` : page === first));
}

/** Variables, filters and selections as a URL (state saving: a link that reopens the module in this state). */
export function stateLink(moduleId: string, page: string, s: { variables: Record<string, unknown>; filters: ModuleState["filters"]; selection: ModuleState["selection"] }): string {
  const packed = btoa(unescape(encodeURIComponent(JSON.stringify({ v: s.variables, f: s.filters, s: s.selection, p: page }))));
  return `${window.location.origin}/workshop/${moduleId}?state=${encodeURIComponent(packed)}`;
}

export function readStateParam(raw: string | null): { v?: Record<string, unknown>; f?: ModuleState["filters"]; s?: ModuleState["selection"]; p?: string } | null {
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(raw))));
  } catch {
    return null;
  }
}
