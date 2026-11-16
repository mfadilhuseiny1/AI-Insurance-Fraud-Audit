/** Merging Slate application changes: a three-way merge (the version both editors started from, mine, theirs) per
 *  element — each page's widgets (a container with its children is one element), queries, functions, object sets,
 *  object contexts, Foundry functions, variables, events, pages, the stylesheet and the function library. An element
 *  changed on one side takes that side; changed the same way on both sides merges; changed differently is a conflict
 *  the editor resolves (mine, theirs, or edited JSON). */
import type { SlateDocument, SlateWidget } from "./slate";

export type Conflict = { key: string; label: string; base: unknown; mine: unknown; theirs: unknown; resolved?: unknown; done?: boolean };
type Elements = Map<string, { label: string; value: unknown }>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function elements(doc: SlateDocument): Elements {
  const m: Elements = new Map();
  doc.pages.forEach((p, i) => {
    m.set(`page:${p.id}`, { label: `page ${p.name}`, value: { id: p.id, name: p.name, order: i } });
    p.widgets.forEach((w, j) => m.set(`widget:${p.id}:${w.id}`, { label: `widget ${w.id} (page ${p.name})`, value: { ...w, order: j } }));
  });
  doc.toolbar.forEach((w, j) => m.set(`widget:toolbar:${w.id}`, { label: `toolbar widget ${w.id}`, value: { ...w, order: j } }));
  const named = ["queries", "functions", "objectSets", "objectContexts", "foundryFunctions", "variables"] as const;
  for (const k of named) (doc[k] as { name: string }[]).forEach((x, j) => m.set(`${k}:${x.name}`, { label: `${k.replace(/s$/, "")} ${x.name}`, value: { ...x, order: j } }));
  doc.events.forEach((e, j) => m.set(`events:${e.id}`, { label: `event ${e.trigger} → ${e.action}`, value: { ...e, order: j } }));
  m.set("styles", { label: "stylesheet", value: doc.styles });
  m.set("library", { label: "function library", value: doc.library ?? "" });
  m.set("title", { label: "title", value: doc.title ?? "" });
  return m;
}

function build(values: Map<string, unknown>): SlateDocument {
  const ord = <T>(xs: (T & { order?: number })[]) =>
    xs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((x) => {
      const out = { ...x };
      delete out.order;
      return out as unknown as T;
    });
  const pages = ord([...values].filter(([k]) => k.startsWith("page:")).map(([, v]) => v as { id: string; name: string; order: number }));
  const widgetsOf = (pid: string) =>
    ord([...values].filter(([k]) => k.startsWith(`widget:${pid}:`)).map(([, v]) => v as SlateWidget & { order: number })) as SlateWidget[];
  const named = <T>(k: string) => ord([...values].filter(([key]) => key.startsWith(`${k}:`)).map(([, v]) => v as T & { order: number })) as T[];
  return {
    schema: 1,
    title: (values.get("title") as string) ?? "",
    pages: (pages as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name, widgets: widgetsOf(p.id) })),
    toolbar: widgetsOf("toolbar"),
    queries: named("queries"),
    functions: named("functions"),
    objectSets: named("objectSets"),
    objectContexts: named("objectContexts"),
    foundryFunctions: named("foundryFunctions"),
    variables: named("variables"),
    events: named("events"),
    styles: (values.get("styles") as SlateDocument["styles"]) ?? { css: "" },
    library: (values.get("library") as string) ?? "",
  };
}

export function merge(base: SlateDocument, mine: SlateDocument, theirs: SlateDocument): { doc: SlateDocument; conflicts: Conflict[]; values: Map<string, unknown> } {
  const b = elements(base);
  const m = elements(mine);
  const t = elements(theirs);
  const keys = [...new Set([...b.keys(), ...m.keys(), ...t.keys()])];
  const out = new Map<string, unknown>();
  const conflicts: Conflict[] = [];
  for (const k of keys) {
    const bv = b.get(k)?.value;
    const mv = m.get(k)?.value;
    const tv = t.get(k)?.value;
    const label = (m.get(k) ?? t.get(k) ?? b.get(k))!.label;
    let v: unknown;
    if (same(mv, tv)) v = mv;
    else if (same(mv, bv)) v = tv;
    else if (same(tv, bv)) v = mv;
    else {
      conflicts.push({ key: k, label, base: bv, mine: mv, theirs: tv });
      v = tv;
    }
    if (v !== undefined) out.set(k, v);
  }
  return { doc: build(out), conflicts, values: out };
}

/** The merged document with the editor's resolutions applied (undefined: the element is deleted). */
export function resolve(values: Map<string, unknown>, conflicts: Conflict[]): SlateDocument {
  const next = new Map(values);
  for (const c of conflicts) {
    if (c.resolved === undefined) next.delete(c.key);
    else next.set(c.key, c.resolved);
  }
  return build(next);
}
