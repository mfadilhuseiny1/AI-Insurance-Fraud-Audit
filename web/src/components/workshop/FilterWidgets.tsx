"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import {
  describeFilter,
  filterSets,
  fmt,
  KEYWORD_OPS,
  keywordOp,
  linkGaps,
  linkKey,
  linkSpec,
  linkTargets,
  resolveOsFilter,
  resolveVar,
  unionColumns,
  workshop,
  type Column,
  type Filter,
  type FilterItem,
  type InterfaceLink,
  type ItemLink,
  type KeywordSyntax,
  type LinkInfo,
  type LinkRef,
  type LinkSpec,
  type Module,
  type ObjectTypeSource,
  type OsFilter,
  type SourceRef,
  type QueryBody,
  type QueryResult,
  type Sources,
  type Variable,
  type Widget,
  type WidgetConfig,
} from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { barHeight, bucketAt, bucketLabel, countIn, endsReversed, fmtDay, fmtNumber, inputFilters, inputValues, nudgeSpan, rangeFilters, rangeSummary, readRange, selectedSpan, type ChartKind } from "./filterCharts";

const NUMERIC_TYPE = /Integer|Long|Double|Float|Decimal|Short|Byte/i;
const TIME_TYPE = /Date|Timestamp/i;
/** A timeline on a property that is not a date, or a distribution on one that is not a number (unknown types pass). */
const chartMismatch = (component: string, type: string | undefined) => !!type && ((component === "timeline" && !TIME_TYPE.test(type)) || (component === "distribution" && !NUMERIC_TYPE.test(type)));

const EMPTY: OsFilter = { filters: [], mode: "all" };
/** A filter that filters: a link filter, a null check, or a value (an empty one, e.g. an unset $var:, does not). */
const live = (f: Filter) => f.column === "__link" || f.op === "is_null" || f.op === "not_null" || !(f.value === undefined || f.value === null || f.value === "" || (Array.isArray(f.value) && !f.value.length));
const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;
const OPS: Filter["op"][] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null", "starts_with", "search", "regex"];
const SYNTAX_LABEL: Record<KeywordSyntax, string> = { simple: "Simple", advanced: "Advanced", regex: "Regex" };
const SYNTAX_HELP: Record<KeywordSyntax, string> = {
  simple: "Finds the text anywhere in a value",
  advanced: 'AND, OR, NOT, ( ) and "quoted phrases"; terms side by side mean AND. Press Enter to search',
  regex: 'A regular expression on the whole value (.*cat.* finds cat anywhere; "v2.0" is literal). Press Enter to search',
};
/** A keyword item's syntax now: the value's (its filter op, or the keyword's syntax), else the item's default. */
function syntaxOf(v: OsFilter, item: FilterItem): KeywordSyntax {
  if (item.column === "__keyword") return v.keyword ? (v.syntax ?? "simple") : (v.syntax ?? item.syntax ?? "simple");
  const f = v.filters.find((x) => x.column === item.column && KEYWORD_OPS.includes(x.op));
  return f ? (f.op === "search" ? "advanced" : f.op === "regex" ? "regex" : "simple") : (item.syntax ?? "simple");
}

/** A keyword filter: simple text applies as it is typed; advanced syntax and regex apply on Enter (or leaving the box). */
function KeywordItem({ item, value, setValue }: { item: FilterItem; value: OsFilter; setValue: (v: OsFilter) => void }) {
  const kw = item.column === "__keyword";
  const own = kw ? undefined : value.filters.find((f) => f.column === item.column && KEYWORD_OPS.includes(f.op));
  const current = kw ? (value.keyword ?? "") : String(own?.value ?? "");
  const [syntax, setSyntax] = useState<KeywordSyntax>(() => syntaxOf(value, item));
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? current;
  const apply = (text: string, s: KeywordSyntax) => {
    setDraft(null);
    if (kw) setValue({ ...value, keyword: text, syntax: s === "simple" ? undefined : s });
    else setValue(withOwn(value, item, text ? [{ column: item.column, op: keywordOp(s), value: text }] : []));
  };
  const modes: KeywordSyntax[] = item.allow_regex ? ["simple", "advanced", "regex"] : ["simple", "advanced"];
  return (
    <div className="space-y-1" data-filter-keyword-item={item.column}>
      <div className="flex gap-1">
        <input
          value={shown}
          onChange={(e) => (syntax === "simple" ? apply(e.target.value, syntax) : setDraft(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && draft !== null && apply(draft, syntax)}
          onBlur={() => draft !== null && apply(draft, syntax)}
          placeholder={kw ? (syntax === "regex" ? "Regex on every indexed property…" : "Search every property…") : `Search ${item.label || item.column}…`}
          className={`${fieldClass} min-w-0 flex-1 text-xs ${syntax !== "simple" ? "font-mono" : ""}`}
          data-filter-keyword={item.column}
        />
        <select
          value={syntax}
          onChange={(e) => {
            const s = e.target.value as KeywordSyntax;
            setSyntax(s);
            apply(shown, s);
          }}
          className={`${fieldClass} text-[11px]`}
          title="Search syntax"
          data-filter-syntax={item.column}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {SYNTAX_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      {syntax !== "simple" && (
        <p className="text-[10px] text-muted" data-filter-syntax-help>
          {SYNTAX_HELP[syntax]}
          {draft !== null && draft !== current ? " · not applied yet" : ""}
        </p>
      )}
    </div>
  );
}

/** The object types of a union source ("object_types": a union of several object types' object sets). */
export function UnionTypesPicker({ source, types, onChange }: { source: SourceRef; types: ObjectTypeSource[]; onChange: (s: SourceRef) => void }) {
  const ids = source.id.split(",").map((x) => x.trim()).filter(Boolean);
  const cols = unionColumns(source, types);
  const toggle = (id: string) => onChange({ kind: "object_types", id: (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]).join(",") });
  return (
    <div className="mt-1 space-y-1 rounded border border-line p-1.5 text-xs" data-union-picker>
      <div className="max-h-40 space-y-0.5 overflow-y-auto">
        {types.map((t) => (
          <label key={t.id} className="flex items-center gap-1.5">
            <input type="checkbox" checked={ids.includes(t.id)} onChange={() => toggle(t.id)} data-union-type={t.id} />
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            <span className="text-muted">{t.count}</span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted" data-union-summary>
        {ids.length < 2
          ? "Choose two or more object types"
          : `${ids.length} object types · ${cols.filter((x) => !x.only && x.name !== "object_type").length} common properties (same property ID) · ${cols.filter((x) => x.only).length} single properties`}
      </p>
    </div>
  );
}

/** The filter variable a widget reads and writes (or its own state without one). */
function useFilterValue(widget: Widget, state: ModuleState): [OsFilter, (v: OsFilter) => void] {
  const out = widget.config.filter_output;
  const [local, setLocal] = useState<OsFilter>(EMPTY);
  const raw = out ? state.variables[out] : local;
  const value = resolveOsFilter(raw, state.variables) ?? EMPTY;
  const set = (v: OsFilter) => (out ? state.setVariable(out, v) : setLocal(v));
  return [value, set];
}

/** One query, rerun when its body or the module version changes. */
function useQ(body: QueryBody | null, version: number) {
  const [r, setR] = useState<{ result: QueryResult | null; error: string | null }>({ result: null, error: null });
  const key = JSON.stringify([body, version]);
  useEffect(() => {
    if (!body) return;
    let stale = false;
    workshop.query(body).then((result) => !stale && setR({ result, error: null }), (e: Error) => !stale && setR({ result: null, error: e.message }));
    return () => {
      stale = true;
    };
    // key holds the body and the version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return r;
}

/** The base of a filter widget's counts: its source, own filters, other filter variables, and the current filter
 * without the part the item itself sets (so its counts show what choosing would give). */
function baseQuery(widget: Widget, state: ModuleState, current: OsFilter | null, extra: Partial<QueryBody>): QueryBody | null {
  const c = widget.config;
  if (!c.source) return null;
  const sets = filterSets(c, state.variables);
  return {
    source: c.source,
    filters: (c.filters ?? []).map((f) => ({ ...f, value: resolveVar(f.value, state.variables) })),
    filter_sets: current && (current.filters.length || current.keyword) ? [...sets, current] : sets,
    limit: 0,
    ...extra,
  };
}

const sameLink = (f: Filter, item: FilterItem) => f.column === "__link" && !!f.value && typeof f.value === "object" && linkKey(f.value as LinkSpec) === linkKey(item.link);
const isOwn = (f: Filter, item: FilterItem) => (item.link ? sameLink(f, item) : item.column === "__keyword" ? false : f.column === item.column);
const without = (v: OsFilter, item: FilterItem): OsFilter => ({ ...v, filters: v.filters.filter((f) => !isOwn(f, item)), keyword: item.column === "__keyword" ? "" : v.keyword });
const withOwn = (v: OsFilter, item: FilterItem, own: Filter[]): OsFilter => ({ ...without(v, item), keyword: v.keyword, filters: [...without(v, item).filters, ...own] });

/** When a link item's setup changes (its link, or the linked property it filters) while a filter from it is active, the
 * filter follows: a new link with the same linked property (or the same has-link item) rewrites the filter onto the new
 * link, keeping its linked-object filters and has / has-no state; anything else clears it. Items added or removed: the
 * filters of link setups no item has any more are cleared. */
const setupKey = (it: FilterItem) => (it.link ? `${linkKey(it.link)}|${it.column}` : "");
function useFollowLinks(items: FilterItem[], value: OsFilter, setValue: (v: OsFilter) => void) {
  const prev = useRef<FilterItem[] | null>(null);
  const key = JSON.stringify(items.map(setupKey));
  useEffect(() => {
    const before = prev.current;
    prev.current = items;
    if (!before) return;
    let v = value;
    const sameShape = before.length === items.length;
    before.forEach((old, i) => {
      if (!old.link || items.some((it) => setupKey(it) === setupKey(old))) return;
      if (!v.filters.some((f) => isOwn(f, old))) return;
      const now = sameShape ? items[i] : undefined;
      const follow = !!now?.link && now.column === old.column && !items.some((it, j) => j !== i && linkKey(it.link) === linkKey(now.link));
      v = {
        ...v,
        filters: v.filters.flatMap((f) => {
          if (!isOwn(f, old)) return [f];
          const was = f.value as LinkSpec;
          return follow ? [{ ...f, value: { ...linkSpec(now!.link!), filters: was.filters ?? [], negate: !!was.negate } }] : [];
        }),
      };
    });
    if (v !== value) setValue(v);
    // runs when the items' link setups change; value / setValue are read as they are then
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** The values an item has chosen (terms of an "in" / "eq" filter, also inside a link filter). */
function chosen(v: OsFilter, item: FilterItem): string[] {
  const f = v.filters.find((x) => isOwn(x, item));
  if (!f) return [];
  const inner = item.link ? ((f.value as LinkSpec).filters ?? []).find((x) => x.column === item.column) : f;
  if (!inner) return [];
  return Array.isArray(inner.value) ? inner.value.map(String) : inner.value === undefined || inner.value === null ? [] : [String(inner.value)];
}
function termFilter(item: FilterItem, values: string[]): Filter[] {
  if (!values.length) return [];
  const inner: Filter = values.length === 1 ? { column: item.column, op: "eq", value: values[0] } : { column: item.column, op: "in", value: values };
  return item.link ? [{ column: "__link", op: "eq", value: { ...linkSpec(item.link), filters: [inner] } }] : [inner];
}

/** The object types of an object set: one, a union's members, or an interface's implementing types (from the sources). */
const memberIds = (source: SourceRef | undefined, sources?: Sources | null): string[] =>
  source?.kind === "object_types"
    ? source.id.split(",").map((x) => x.trim()).filter(Boolean)
    : source?.kind === "object_type"
      ? [source.id]
      : source?.kind === "interface"
        ? (sources?.interfaces?.find((x) => x.id === source.id)?.types ?? []).map((t) => t.id)
        : [];

/** The sources (object type and interface names), loaded once per page. */
let typeNames: Promise<Sources> | null = null;

/** A link item made of links read from member types (one per type on a union or an interface). */
function linkFromRefs(refs: LinkRef[], links: LinkInfo[]): ItemLink {
  const infos = refs.map((r) => links.find((x) => x.link_type_id === r.link_type_id && x.direction === r.direction && (x.from_type_id ?? "") === (r.from_type_id ?? x.from_type_id ?? "")));
  const targets = [...new Set(infos.map((x) => x?.target_type_id).filter((x): x is string => !!x))];
  return { links: refs, name: [...new Set(infos.map((x) => x?.name).filter(Boolean))].join(" / ") || "link", ...(targets.length === 1 ? { target_type_id: targets[0] } : {}) };
}

/** An interface link type as a link item: its name, and each implementing type's concrete link (for targets and gaps). */
const interfaceItemLink = (lc: InterfaceLink): ItemLink => ({
  interface_link: lc.api_name,
  name: lc.display_name,
  links: Object.entries(lc.by_type).map(([tid, r]) => ({ link_type_id: r.link_type_id, direction: r.direction, from_type_id: tid })),
  ...(lc.target_kind === "object_type" && lc.target_id ? { target_type_id: lc.target_id } : {}),
});

/** A link an object set can be filtered by (the Filter List's link picker and the search bar's link suggestions). */
type LinkChoice = { value: string; label: string; group: "interface" | "every" | "link"; link: ItemLink };

/** The link forms of an object set: its interface's link types, every link to an object type (on a union or an
 * interface always, on one object type where several links reach the same type), and each link from each member type
 * (on several member types: a link per member type, the others without the link). */
function linkChoices(members: string[], links: LinkInfo[], tname: (id: string) => string, ifaceLinks: InterfaceLink[] = []): LinkChoice[] {
  const multi = members.length > 1;
  const every = [...new Map(links.map((l) => [l.target_type_id, l.target_name])).entries()].filter(([tid]) => multi || links.filter((l) => l.target_type_id === tid).length > 1);
  return [
    ...ifaceLinks.map((lc): LinkChoice => ({ value: `iface:${lc.api_name}`, label: lc.display_name, group: "interface", link: interfaceItemLink(lc) })),
    ...every.map(([tid, tn]): LinkChoice => ({ value: `to:${tid}`, label: `Every link to ${tn}`, group: "every", link: { every: true, target_type_id: tid, name: tname(tid) } })),
    ...links.map(
      (l): LinkChoice => ({
        value: `link:${l.link_type_id}:${l.direction}:${l.from_type_id ?? ""}`,
        label: `${multi && l.from_type_id ? `${tname(l.from_type_id)} → ` : ""}${l.name} (${l.target_name})`,
        group: "link",
        link: multi ? linkFromRefs([{ link_type_id: l.link_type_id, direction: l.direction, from_type_id: l.from_type_id }], links) : { link_type_id: l.link_type_id, direction: l.direction, name: l.name, target_type_id: l.target_type_id },
      }),
    ),
  ];
}

/** An object set's member types, their links (each with the type it starts from; loaded when `on`), type names and,
 * on an interface source, its link types. */
function useLinkSet(source: SourceRef | undefined, on: boolean) {
  const [sources, setSources] = useState<Sources | null>(null);
  useEffect(() => void (typeNames ??= workshop.sources()).then(setSources, () => {}), []);
  const members = memberIds(source, sources);
  const key = on ? members.join(",") : "";
  const [links, setLinks] = useState<LinkInfo[]>([]);
  useEffect(() => {
    if (key) workshop.links(key).then(setLinks, () => setLinks([]));
  }, [key]);
  const iface = source?.kind === "interface" ? sources?.interfaces?.find((x) => x.id === source.id) : undefined;
  const tname = (id: string) => sources?.object_types.find((t) => t.id === id)?.name ?? links.find((x) => x.target_type_id === id)?.target_name ?? id;
  return { sources, members, links: key ? links : [], tname, iface, ifaceLinks: iface?.link_constraints ?? [] };
}

/** On a union: the member types without the item's link (no linked objects: "has link" drops their objects, "has no
 * link" keeps them all), or a warning when no member type has it. */
function LinkGaps({ link, members, infos, names, detail }: { link: ItemLink; members: string[]; infos: LinkInfo[]; names: (id: string) => string; detail?: boolean }) {
  const gaps = linkGaps(members, link, infos);
  if (!gaps.length) return null;
  const all = gaps.length === members.length;
  return (
    <p className={`text-[10px] ${all ? "text-warn" : "text-muted"}`} data-link-gaps={gaps.join(",")}>
      {all
        ? "No object type of this object set has this link"
        : `No such link on ${gaps.map(names).join(", ")}: ${gaps.length === 1 ? "its" : "their"} objects have no linked objects${detail ? " (Has link leaves them out, No link keeps them all)" : ""}`}
    </p>
  );
}

// ------------------------------------------------------------------------------------------------
// Filter List
// ------------------------------------------------------------------------------------------------

/** A timeline (date / timestamp property) or distribution (numeric property): a histogram of the objects the other
 * filters leave, brushed with the pointer or the arrow keys, with from / to inputs beside it. The range is written as
 * "from ≤ value < to" filters on the property. */
function RangeChartItem({ widget, state, item, value, setValue, compact }: { widget: Widget; state: ModuleState; item: FilterItem; value: OsFilter; setValue: (v: OsFilter) => void; compact?: boolean }) {
  const kind: ChartKind = item.component === "timeline" ? "timeline" : "distribution";
  const col = item.column;
  const spec = kind === "timeline" ? { column: col, kind, interval: item.interval ?? "auto" } : { column: col, kind, bins: item.bins ?? 24 };
  const { result, error } = useQ(col && col !== "__keyword" ? baseQuery(widget, state, without(value, item), { histogram: spec }) : null, state.version);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const h = result?.histogram && result.histogram.column === col && result.histogram.kind === kind ? result.histogram : null;
  const buckets = h?.buckets ?? [];
  const n = buckets.length;
  const ends = readRange(value.filters, col);
  const active = !!(ends.lo || ends.hi);
  const span = selectedSpan(kind, buckets, ends);
  const shown: [number, number] | null = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] : span;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const texts = inputValues(kind, ends);
  const reset = () => setValue(without(value, item));
  const choose = (i: number, j: number) => setValue(withOwn(value, item, rangeFilters(col, buckets, i, j)));
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return bucketAt(e.clientX - r.left, r.width, n);
  };
  const setEnd = (which: "from" | "to", text: string) => {
    const own = inputFilters(kind, col, which === "from" ? text : "", which === "to" ? text : "");
    setValue(withOwn(value, item, which === "from" ? [...own, ...(ends.hi ? [ends.hi] : [])] : [...(ends.lo ? [ends.lo] : []), ...own]));
  };
  const label = item.label || col;
  const fmtEnd = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : kind === "timeline" ? fmtDay(String(v)) : fmtNumber(Number(v)));
  const unit = kind === "timeline" ? (h?.interval ? `by ${(h.years ?? 1) > 1 ? `${h.years} years` : h.interval}` : "") : h?.step ? `bins of ${fmtNumber(Number(h.step))}` : "";
  return (
    <div className="space-y-1" data-filter-chart={col} data-chart-kind={kind}>
      {error ? (
        <p className="text-[11px] text-bad" data-chart-error>
          {error}
        </p>
      ) : !h ? (
        <p className="text-[11px] text-muted">Loading…</p>
      ) : !n ? (
        <p className="text-[11px] text-muted" data-chart-empty>
          No {kind === "timeline" ? "dates" : "numbers"} to chart
          {h.nulls ? ` · ${h.nulls.toLocaleString()} without a value` : ""}
        </p>
      ) : (
        <>
          <div
            ref={box}
            tabIndex={0}
            role="group"
            aria-label={`${label}: ${n} ${kind === "timeline" ? "periods" : "bins"} from ${fmtEnd(h.min)} to ${fmtEnd(h.max)}. Drag to choose a range; the arrow keys move it, Shift with an arrow key resizes it, Escape clears it`}
            className={`flex ${compact ? "h-12" : "h-16"} cursor-crosshair touch-none select-none items-end rounded border border-line bg-panel-2/40 outline-none focus-visible:border-ocean`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // a synthetic pointer has no capture
              }
              setDrag({ a: at(e), b: at(e) });
            }}
            onPointerMove={(e) => drag && setDrag({ a: drag.a, b: at(e) })}
            onPointerUp={(e) => {
              if (!drag) return;
              const b = at(e);
              const [i, j] = [Math.min(drag.a, b), Math.max(drag.a, b)];
              setDrag(null);
              // a click on the one chosen bucket clears it
              if (i === j && span && span[0] === i && span[1] === i) reset();
              else choose(i, j);
            }}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Delete" || e.key === "Backspace") return active ? (e.preventDefault(), reset()) : undefined;
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const next = nudgeSpan(span, n, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
              if (next) choose(next[0], next[1]);
            }}
            data-chart-bars={n}
          >
            {buckets.map((b, i) => {
              const on = !!shown && i >= shown[0] && i <= shown[1];
              return (
                <div key={i} className="flex h-full min-w-0 flex-1 items-end" title={`${bucketLabel(h, b)}: ${b.count.toLocaleString()}`} data-bucket={i} data-count={b.count} data-on={on ? 1 : undefined}>
                  <div className={`w-full rounded-t-sm ${n <= 40 ? "mx-px" : ""} ${on ? "bg-ocean" : shown ? "bg-ocean/25" : "bg-ocean/60"}`} style={{ height: `${barHeight(b.count, max) * 100}%` }} />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between gap-1 text-[10px] text-muted">
            <span>{fmtEnd(h.min)}</span>
            <span>{unit}</span>
            <span>{fmtEnd(h.max)}</span>
          </div>
        </>
      )}
      <div className="flex items-center gap-1">
        <input
          type={kind === "timeline" ? "date" : "number"}
          step="any"
          value={texts.from}
          onChange={(e) => setEnd("from", e.target.value)}
          placeholder="from"
          aria-label={`${label}: from`}
          className={`${fieldClass} min-w-0 flex-1 text-xs`}
          data-chart-from
        />
        <span className="text-muted">–</span>
        <input
          type={kind === "timeline" ? "date" : "number"}
          step="any"
          value={texts.to}
          onChange={(e) => setEnd("to", e.target.value)}
          placeholder="to"
          aria-label={`${label}: to${kind === "timeline" ? " (this day included)" : ""}`}
          className={`${fieldClass} min-w-0 flex-1 text-xs`}
          data-chart-to
        />
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span data-chart-status>
          {h
            ? `${active ? `${countIn(buckets, span).toLocaleString()} of ${h.count.toLocaleString()} in the range` : `${h.count.toLocaleString()} with a value`}${h.nulls && n ? ` · ${h.nulls.toLocaleString()} without` : ""}${h.invalid ? ` · ${h.invalid.toLocaleString()} unreadable` : ""}`
            : ""}
        </span>
        {endsReversed(kind, texts.from, texts.to) && <span className="text-warn">From is above to</span>}
        {active && (
          <button type="button" onClick={reset} className="ml-auto text-ocean" data-chart-reset>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function FilterItemView({ widget, state, item, value, setValue, compact, links = [] }: { widget: Widget; state: ModuleState; item: FilterItem; value: OsFilter; setValue: (v: OsFilter) => void; compact?: boolean; links?: LinkInfo[] }) {
  const rest = without(value, item);
  const terms = ["histogram", "single", "multi"].includes(item.component);
  // linked items count the linked types' values (the link's other side; several on a union's links), plain items the source's
  const targets = item.link ? linkTargets(item.link, links) : [];
  const groupBody: QueryBody | null = !terms
    ? null
    : item.link
      ? targets.length
        ? { source: targets.length === 1 ? { kind: "object_type", id: targets[0] } : { kind: "object_types", id: targets.join(",") }, group_by: item.column, metric: "count", sort: undefined, descending: true, limit: 100 }
        : null
      : baseQuery(widget, state, rest, { group_by: item.column, metric: "count", descending: true, limit: 100 });
  const { result, error } = useQ(groupBody, state.version);
  const pick = chosen(value, item);
  const setTerms = (vals: string[]) => setValue(withOwn(value, item, termFilter(item, vals)));
  if (item.component === "keyword") return <KeywordItem item={item} value={value} setValue={setValue} />;
  if (item.component === "timeline" || item.component === "distribution") return <RangeChartItem widget={widget} state={state} item={item} value={value} setValue={setValue} compact={compact} />;
  if (item.component === "range" || item.component === "date_range") {
    const lo = value.filters.find((f) => f.column === item.column && f.op === "gte")?.value;
    const hi = value.filters.find((f) => f.column === item.column && f.op === "lte")?.value;
    const set = (a: unknown, b: unknown) =>
      setValue(withOwn(value, item, [...(a !== "" && a !== undefined ? [{ column: item.column, op: "gte" as const, value: a }] : []), ...(b !== "" && b !== undefined ? [{ column: item.column, op: "lte" as const, value: b }] : [])]));
    const type = item.component === "date_range" ? "date" : "number";
    const conv = (s: string) => (s === "" ? "" : type === "number" ? Number(s) : s);
    return (
      <div className="flex items-center gap-1" data-filter-range={item.column}>
        <input type={type} value={lo === undefined ? "" : String(lo)} onChange={(e) => set(conv(e.target.value), hi)} placeholder="from" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        <span className="text-muted">–</span>
        <input type={type} value={hi === undefined ? "" : String(hi)} onChange={(e) => set(lo, conv(e.target.value))} placeholder="to" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
      </div>
    );
  }
  if (item.component === "has_link") {
    const f = value.filters.find((x) => isOwn(x, item));
    const state3 = !f ? "any" : (f.value as LinkSpec).negate ? "none" : "has";
    const set = (s: string) =>
      setValue(withOwn(value, item, s === "any" ? [] : [{ column: "__link", op: "eq", value: { ...linkSpec(item.link!), filters: [], negate: s === "none" } }]));
    return (
      <div className="flex gap-1" data-filter-has-link={item.link?.link_type_id ?? linkKey(item.link)}>
        {(["any", "has", "none"] as const).map((s) => (
          <button key={s} type="button" onClick={() => set(s)} className={`flex-1 rounded border px-1 py-0.5 text-[11px] ${state3 === s ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`} data-link-state={s} aria-pressed={state3 === s}>
            {s === "any" ? "Any" : s === "has" ? `Has ${item.link?.name ?? "link"}` : `No ${item.link?.name ?? "link"}`}
          </button>
        ))}
      </div>
    );
  }
  if (error) return <p className="text-[11px] text-bad">{error}</p>;
  const groups = (result?.groups ?? []).filter((g) => g.key !== null && g.key !== "").slice(0, compact ? 12 : 30);
  const max = Math.max(1, ...groups.map((g) => g.count));
  if (item.component === "single")
    return (
      <select value={pick[0] ?? ""} onChange={(e) => setTerms(e.target.value ? [e.target.value] : [])} className={`${fieldClass} w-full text-xs`} data-filter-single={item.column}>
        <option value="">Any</option>
        {groups.map((g) => (
          <option key={String(g.key)} value={String(g.key)}>
            {fmt(g.key)} ({g.count})
          </option>
        ))}
      </select>
    );
  return (
    <div className="space-y-0.5" data-filter-terms={item.column}>
      {groups.map((g) => {
        const k = String(g.key);
        const on = pick.includes(k);
        const toggle = () => setTerms(on ? pick.filter((x) => x !== k) : [...pick, k]);
        return item.component === "histogram" ? (
          <button key={k} type="button" onClick={toggle} className={`relative flex w-full items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-left text-[11px] ${on ? "ring-1 ring-ocean" : "hover:bg-panel-2"}`} data-term={k}>
            <span className={`absolute inset-y-0 left-0 rounded ${on ? "bg-ocean/35" : "bg-ocean/15"}`} style={{ width: `${(g.count / max) * 100}%` }} />
            <span className="relative min-w-0 flex-1 truncate">{fmt(g.key)}</span>
            <span className="relative text-muted">{g.count}</span>
          </button>
        ) : (
          <label key={k} className="flex items-center gap-1.5 text-[11px]" data-term={k}>
            <input type="checkbox" checked={on} onChange={toggle} />
            <span className="min-w-0 flex-1 truncate">{fmt(g.key)}</span>
            <span className="text-muted">{g.count}</span>
          </label>
        );
      })}
      {!groups.length && <p className="text-[11px] text-muted">{result ? "No values" : "Loading…"}</p>}
    </div>
  );
}

function itemSummary(v: OsFilter, item: FilterItem): string {
  if (item.column === "__keyword") return v.keyword ? `${v.syntax && v.syntax !== "simple" ? `${SYNTAX_LABEL[v.syntax]} ` : ""}“${v.keyword}”` : "";
  const own = v.filters.filter((f) => isOwn(f, item) && live(f));
  if (!item.link && (item.component === "timeline" || item.component === "distribution")) return rangeSummary(item.component, readRange(own, item.column));
  return own.map(describeFilter).join(" · ");
}

export function FilterListWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [value, setValue] = useFilterValue(widget, state);
  const [added, setAdded] = useState<FilterItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const total = useQ(baseQuery(widget, state, value, { metric: "count" }), state.version);
  const cols = useQ(c.source ? { source: c.source, limit: 1 } : null, state.version).result?.columns ?? [];
  const items = [...(c.filter_items ?? []), ...added];
  // link items: the object set's links (each with the type it starts from) and, on a union / interface, the member types' names
  const { members, links: linkInfos, tname } = useLinkSet(c.source, items.some((it) => it.link));
  const gaps = (it: FilterItem) => it.link && members.length > 1 ? <LinkGaps link={it.link} members={members} infos={linkInfos} names={tname} detail={it.component === "has_link"} /> : null;
  useFollowLinks(items, value, setValue);
  if (!c.source) return <Msg>Choose the object set (a source) in the panel</Msg>;
  if (!items.length && !c.allow_add) return <Msg>Add filters in the panel</Msg>;
  const pills = c.filter_layout === "pills";
  const active = value.filters.some(live) || !!value.keyword;
  const label = (it: FilterItem) => it.label || (it.column === "__keyword" ? "Keyword" : it.link ? `${it.link.name ?? "Link"} · ${it.column || "has link"}` : it.column);
  return (
    <div className={`h-full overflow-y-auto p-2 text-xs ${pills ? "flex flex-wrap items-start gap-1" : "space-y-3"}`} data-filter-list={widget.id}>
      <div className={`flex items-center gap-2 ${pills ? "w-full" : ""}`}>
        <span className="text-muted">{total.error ? "" : total.result ? `${total.result.total.toLocaleString()} objects` : "…"}</span>
        {active && (
          <button type="button" onClick={() => setValue({ ...EMPTY, mode: value.mode, ...(value.contains_prefix ? { contains_prefix: true } : {}) })} className="ml-auto text-ocean" data-filter-clear>
            Clear
          </button>
        )}
      </div>
      {total.error && (
        <p className={`text-[11px] text-bad ${pills ? "w-full" : ""}`} data-filter-error>
          {total.error}
        </p>
      )}
      {items.map((it, i) =>
        pills ? (
          <div key={i} className="relative">
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className={`rounded-full border px-2 py-0.5 ${itemSummary(value, it) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`} data-filter-pill={i}>
              {label(it)}
              {itemSummary(value, it) ? `: ${itemSummary(value, it).slice(0, 40)}` : ""}
            </button>
            {open === i && (
              <div className="absolute left-0 top-full z-20 mt-1 w-60 rounded-lg border border-line-2 bg-panel p-2 shadow-xl">
                <FilterItemView widget={widget} state={state} item={it} value={value} setValue={setValue} compact links={linkInfos} />
                {gaps(it)}
              </div>
            )}
          </div>
        ) : (
          <div key={i} data-filter-item={i}>
            <div className="mb-1 flex items-center gap-1 font-semibold text-soft">
              {label(it)}
              {i >= (c.filter_items ?? []).length && (
                <button type="button" onClick={() => (setAdded(added.filter((_, j) => j !== i - (c.filter_items ?? []).length)), setValue(without(value, it)))} className="ml-auto text-muted hover:text-bad" title="Remove the filter">
                  ✕
                </button>
              )}
            </div>
            <FilterItemView widget={widget} state={state} item={it} value={value} setValue={setValue} links={linkInfos} />
            {gaps(it)}
          </div>
        ),
      )}
      {c.allow_add && !editing && (
        <div className={pills ? "" : "border-t border-line pt-2"}>
          {adding ? (
            <select
              autoFocus
              value=""
              onChange={(e) => {
                const col = cols.find((x) => x.name === e.target.value);
                if (col) setAdded([...added, { column: col.name, component: NUMERIC_TYPE.test(col.type) ? "distribution" : TIME_TYPE.test(col.type) ? "timeline" : "multi" }]);
                setAdding(false);
              }}
              onBlur={() => setAdding(false)}
              className={`${fieldClass} text-xs`}
            >
              <option value="">Property…</option>
              {cols.filter((x) => !items.some((it) => it.column === x.name && !it.link)).map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
            </select>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="text-ocean" data-filter-add>
              + Add filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Exploration Filter Pills and Search Bar
// ------------------------------------------------------------------------------------------------

export function ExplorationWidget({ widget, state, editing, search }: { widget: Widget; state: ModuleState; editing: boolean; search: boolean }) {
  const c = widget.config;
  const [value, setValue] = useFilterValue(widget, state);
  const mode = c.pills_mode ?? (search ? "add" : "remove");
  const canRemove = mode !== "read";
  const canEdit = mode === "update" || mode === "add";
  const [edit, setEdit] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<{ column: string; op: Filter["op"]; value: string } | null>(null);
  // the search bar's link suggestions: the same link forms as the Filter List (one type, a union, an interface)
  const { sources, members, links, tname, iface, ifaceLinks } = useLinkSet(c.source, search);
  const typeName = c.source?.kind === "interface" ? (iface?.name ?? "") : sources ? members.map(tname).join(" + ") : "";
  const choices = q.length >= 2 ? linkChoices(members, links, tname, ifaceLinks) : [];
  const sample = useQ(search && c.source && q.length >= 2 && !c.no_autocomplete ? { source: c.source, limit: 300 } : null, state.version);
  const cols = useQ(c.source ? { source: c.source, limit: 1 } : null, state.version).result?.columns ?? [];
  const suggestions = useMemo(() => {
    if (!q || q.length < 2) return [];
    const needle = q.toLowerCase();
    const seen = new Set<string>();
    const out: { column: string; value: string }[] = [];
    for (const r of sample.result?.rows ?? [])
      for (const [k, v] of Object.entries(r)) {
        if (k === "__pk" || v === null || v === undefined || typeof v === "object") continue;
        const s = String(v);
        if (s.toLowerCase().includes(needle) && !seen.has(`${k}=${s}`) && out.length < 8) {
          seen.add(`${k}=${s}`);
          out.push({ column: k, value: s });
        }
      }
    return out;
  }, [q, sample.result]);
  if (!c.source) return <Msg>Choose the object set (a source) in the panel</Msg>;
  const remove = (i: number) => setValue({ ...value, filters: value.filters.filter((_, j) => j !== i) });
  const commitEdit = (i: number) => {
    const f = value.filters[i];
    const v = f.op === "in" ? draft.split(",").map((x) => x.trim()).filter(Boolean) : ["gt", "gte", "lt", "lte"].includes(f.op) && draft !== "" && !Number.isNaN(Number(draft)) ? Number(draft) : draft;
    setValue({ ...value, filters: value.filters.map((x, j) => (j === i ? { ...x, value: v } : x)) });
    setEdit(null);
  };
  const add = (f: Filter) => setValue({ ...value, filters: [...value.filters, f] });
  const sep = value.mode === "any" ? "or" : "and";
  return (
    <div className="flex h-full flex-wrap items-center gap-1 px-2 py-1 text-xs" data-exploration={search ? "search" : "pills"}>
      {search && <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-muted" />}
      {c.show_type_pill !== false && typeName && <span className="rounded bg-panel-2 px-2 py-0.5 text-soft" data-type-pill>{typeName}</span>}
      {value.keyword && (
        <span className="flex items-center gap-1 rounded-full border border-ocean/50 bg-ocean/10 px-2 py-0.5" data-pill="keyword">
          “{value.keyword}”
          {canRemove && !editing && (
            <button type="button" onClick={() => setValue({ ...value, keyword: "" })} className="text-muted hover:text-white">
              ✕
            </button>
          )}
        </span>
      )}
      {value.filters.map((f, i) => ({ f, i })).filter(({ f }) => live(f)).map(({ f, i }, k) => (
        <span key={i} className="flex items-center gap-1">
          {k > 0 && (
            <button
              type="button"
              disabled={!!c.fixed_operator || !canEdit || editing}
              onClick={() => setValue({ ...value, mode: value.mode === "any" ? "all" : "any" })}
              className="rounded px-1 text-[10px] uppercase text-muted enabled:hover:text-white"
              title={c.fixed_operator ? "The operator is fixed" : "Switch between and / or"}
              data-operator
            >
              {sep}
            </button>
          )}
          {edit === i ? (
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => commitEdit(i)} onKeyDown={(e) => e.key === "Enter" && commitEdit(i)} className={`${fieldClass} w-36 text-xs`} />
          ) : (
            <span className="flex items-center gap-1 rounded-full border border-line-2 bg-panel-2 px-2 py-0.5" data-pill={i}>
              <button type="button" disabled={!canEdit || editing || f.column === "__link" || f.op === "is_null" || f.op === "not_null"} onClick={() => (setEdit(i), setDraft(Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")))} className="text-soft enabled:hover:text-white">
                {describeFilter(f)}
              </button>
              {canRemove && !editing && (
                <button type="button" onClick={() => remove(i)} className="text-muted hover:text-white" data-pill-remove={i}>
                  ✕
                </button>
              )}
            </span>
          )}
        </span>
      ))}
      {!search && mode === "add" && !editing && (
        adding ? (
          <span className="flex items-center gap-1">
            <select value={adding.column} onChange={(e) => setAdding({ ...adding, column: e.target.value })} className={`${fieldClass} text-xs`}>
              <option value="">Property…</option>
              {cols.map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
            </select>
            <select value={adding.op} onChange={(e) => setAdding({ ...adding, op: e.target.value as Filter["op"] })} className={`${fieldClass} text-xs`}>
              {OPS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} className={`${fieldClass} w-28 text-xs`} />
            <button type="button" disabled={!adding.column} onClick={() => (add({ column: adding.column, op: adding.op, value: adding.op === "in" ? adding.value.split(",").map((x) => x.trim()) : adding.value }), setAdding(null))} className="text-ocean disabled:opacity-40">
              Add
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding({ column: "", op: "eq", value: "" })} className="rounded-full border border-dashed border-line-2 px-2 py-0.5 text-muted hover:text-white" data-pill-add>
            + Filter
          </button>
        )
      )}
      {search && canEdit && !editing && (
        <div className="relative min-w-[10rem] flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim() && !c.no_keyword) {
                setValue({ ...value, keyword: q.trim() });
                setQ("");
              }
              if (e.key === "Backspace" && !q && value.filters.some(live) && canRemove) remove(value.filters.map(live).lastIndexOf(true));
            }}
            placeholder={c.placeholder || "Search or filter…"}
            className="w-full bg-transparent px-1 py-0.5 text-xs outline-none"
            data-search-input
          />
          {q.length >= 2 && (
            <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-line-2 bg-panel p-1 shadow-xl" data-suggestions>
              {!c.no_keyword && (
                <button type="button" onClick={() => (setValue({ ...value, keyword: q.trim() }), setQ(""))} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
                  Search “{q}” in every property
                </button>
              )}
              {suggestions.map((s) => (
                <button key={`${s.column}=${s.value}`} type="button" onClick={() => (add({ column: s.column, op: "eq", value: s.value }), setQ(""))} className="block w-full truncate rounded px-2 py-1 text-left hover:bg-panel-2" data-suggestion={s.column}>
                  <span className="text-muted">{s.column}:</span> {s.value}
                </button>
              ))}
              {choices
                .filter((ch) => [ch.label, ch.link.name ?? "", ...linkTargets(ch.link, links).map(tname)].some((x) => x.toLowerCase().includes(q.toLowerCase())))
                .map((ch) => {
                  const gaps = linkGaps(members, ch.link, links);
                  return (
                    <button
                      key={ch.value}
                      type="button"
                      onClick={() => (add({ column: "__link", op: "eq", value: { ...linkSpec(ch.link), filters: [] } }), setQ(""))}
                      className="block w-full truncate rounded px-2 py-1 text-left hover:bg-panel-2"
                      title={gaps.length ? `No such link on ${gaps.map(tname).join(", ")}: ${gaps.length === 1 ? "its" : "their"} objects have no linked objects` : undefined}
                      data-link-suggestion={ch.value}
                    >
                      <span className="text-muted">{ch.group === "interface" ? "interface link:" : "link:"}</span> {ch.group === "every" ? `has a link to ${tname(ch.link.target_type_id ?? "")}` : `has ${ch.label}`}
                      {gaps.length > 0 && <span className="text-muted" data-link-suggestion-gaps={gaps.join(",")}> · not on {gaps.map(tname).join(", ")}</span>}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}
      {search && c.show_clear !== false && (value.filters.some(live) || value.keyword) && canRemove && !editing && (
        <button type="button" onClick={() => setValue({ ...EMPTY, mode: value.mode })} className="ml-auto text-muted hover:text-white" title="Clear all filters" data-search-clear>
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      )}
      {!search && !value.filters.some(live) && !value.keyword && <span className="text-muted">No filters</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Prominent Terms
// ------------------------------------------------------------------------------------------------

export function ProminentTermsWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const [value, setValue] = useFilterValue(widget, state);
  const item: FilterItem = { column: c.term_column ?? "", component: "multi" };
  const { result, error } = useQ(c.term_column ? baseQuery(widget, state, without(value, item), { group_by: c.term_column, metric: "count", limit: 1000 }) : null, state.version);
  if (!c.source || !c.term_column) return <Msg>Choose the base object set and the property in the panel</Msg>;
  if (error) return <Msg>{error}</Msg>;
  const counts = new Map((result?.groups ?? []).map((g) => [String(g.key), g.count]));
  const pick = chosen(value, item);
  const terms = (c.terms ?? []).filter((t) => !c.hide_empty || (counts.get(t.value) ?? 0) > 0);
  return (
    <div className="h-full space-y-0.5 overflow-y-auto p-2 text-xs" data-prominent>
      {terms.map((t) => {
        const on = pick.includes(t.value);
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => setValue(withOwn(value, item, termFilter(item, on ? pick.filter((x) => x !== t.value) : [...pick, t.value])))}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${on ? "bg-ocean/15 text-white ring-1 ring-ocean" : "hover:bg-panel-2"}`}
            data-term={t.value}
          >
            {t.icon && <Icon name={t.icon as "star"} className="h-3.5 w-3.5 text-ocean" />}
            <span className="min-w-0 flex-1 truncate">{state.tr?.(t.label || t.value) ?? (t.label || t.value)}</span>
            <span className="text-muted">{result ? (counts.get(t.value) ?? 0).toLocaleString() : "…"}</span>
          </button>
        );
      })}
      {!terms.length && <p className="text-muted">{c.terms?.length ? "No term has results" : "Add terms in the panel"}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

export const FILTER_TYPES = new Set(["filter_list", "filter_pills", "search_bar", "prominent_terms"]);

function OutputVar({ mod, value, onChange }: { mod: Module; value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <Field label="Filter output (an object set filter variable; its default is the starting state)">
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass} data-filter-output>
        <option value="">None (the widget keeps its own state)</option>
        {(mod.variables ?? []).filter((v) => v.type === "object_set_filter").map((v) => (
          <option key={v.name}>{v.name}</option>
        ))}
      </select>
    </Field>
  );
}

/** The source's properties indexed for regex search (null: no index needed, a dataset or an interface), and on a union
 * the type that alone has a property. */
function regexInfo(source: SourceRef | undefined, sources: Sources | undefined): { regex: Set<string> | null; only: Map<string, string> } {
  if (source?.kind === "object_types") {
    const u = unionColumns(source, sources?.object_types ?? []);
    return { regex: new Set(u.filter((x) => x.regex).map((x) => x.name)), only: new Map(u.filter((x) => x.only).map((x) => [x.name, x.only!])) };
  }
  if (source?.kind === "object_type") return { regex: new Set((sources?.object_types.find((x) => x.id === source.id)?.properties ?? []).filter((p) => p.regex).map((p) => p.name)), only: new Map() };
  return { regex: null, only: new Map() };
}

/** A keyword item's settings: the syntax it opens with, regex offered, and whether its properties are indexed for regex. */
function KeywordItemConfig({ it, setI, info }: { it: FilterItem; setI: (x: Partial<FilterItem>) => void; info: { regex: Set<string> | null } }) {
  const indexed = info.regex === null ? null : it.column === "__keyword" ? info.regex.size : info.regex.has(it.column) ? 1 : 0;
  return (
    <div className="space-y-1" data-keyword-config>
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted">Syntax</span>
        <select value={it.syntax ?? "simple"} onChange={(e) => setI({ syntax: e.target.value === "simple" ? undefined : (e.target.value as KeywordSyntax) })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
          <option value="simple">Simple (substring)</option>
          <option value="advanced">Advanced (AND / OR / NOT, brackets, phrases)</option>
          {it.allow_regex && <option value="regex">Regex</option>}
        </select>
      </div>
      <label className="flex items-center gap-1.5 text-[11px]">
        <input type="checkbox" checked={!!it.allow_regex} onChange={(e) => setI({ allow_regex: e.target.checked || undefined, ...(!e.target.checked && it.syntax === "regex" ? { syntax: undefined } : {}) })} data-allow-regex /> Offer regex search
      </label>
      {indexed !== null && (
        <p className={`text-[10px] ${indexed ? "text-muted" : "text-warn"}`} data-regex-index>
          {it.column === "__keyword"
            ? indexed
              ? `${indexed} propert${indexed === 1 ? "y is" : "ies are"} indexed for regex search`
              : 'No property is indexed for regex search: enable "Regex queries" in Ontology Manager'
            : indexed
              ? "Indexed for regex search"
              : 'Not indexed for regex search: enable "Regex queries" on the property in Ontology Manager'}
        </p>
      )}
    </div>
  );
}

export function FilterWidgetConfig({ widget, set, mod, cols, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources?: Sources }) {
  const c = widget.config;
  const t = widget.type;
  const info = regexInfo(c.source, sources);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const members = memberIds(c.source, sources);
  const linkSrc = t === "filter_list" ? members.join(",") : "";
  const ifaceLinks = c.source?.kind === "interface" ? (sources?.interfaces?.find((x) => x.id === c.source?.id)?.link_constraints ?? []) : [];
  useEffect(() => {
    if (linkSrc) workshop.links(linkSrc).then(setLinks, () => setLinks([]));
  }, [linkSrc]);
  if (t === "filter_list") {
    const items = c.filter_items ?? [];
    const setI = (i: number, x: Partial<FilterItem>) => set({ filter_items: items.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    const union = members.length > 1;
    const tname = (id: string) => sources?.object_types.find((x) => x.id === id)?.name ?? links.find((x) => x.target_type_id === id)?.target_name ?? id;
    const fromOf = (r: LinkRef) => r.from_type_id ?? links.find((x) => x.link_type_id === r.link_type_id && x.direction === r.direction)?.from_type_id ?? "";
    const refKey = (r: LinkRef) => `${r.link_type_id}:${r.direction}:${fromOf(r)}`;
    // a link item's links as refs (the one-link form read as one ref)
    const refsOf = (l: ItemLink): LinkRef[] => (l.links ? l.links : l.link_type_id ? [{ link_type_id: l.link_type_id, direction: l.direction ?? "forward", from_type_id: fromOf({ link_type_id: l.link_type_id, direction: l.direction ?? "forward" }) || undefined }] : []);
    const pickValue = (l?: ItemLink) => {
      if (!l) return "own";
      if (l.interface_link) return `iface:${l.interface_link}`;
      if (l.every) return `to:${l.target_type_id ?? ""}`;
      const refs = refsOf(l);
      return refs.length === 1 ? `link:${refKey(refs[0])}` : "per";
    };
    // the link forms (shared with the search bar's link suggestions)
    const choices = linkChoices(members, links, tname, ifaceLinks);
    const group = (g: LinkChoice["group"]) => choices.filter((x) => x.group === g);
    /** The linked types' properties (several targets: every property once, marked when only some targets have it). */
    const linkProps = (l: ItemLink): (Column & { only?: string })[] => {
      const targets = linkTargets(l, links);
      const per = targets.map((tid) => ({ tid, props: links.find((x) => x.target_type_id === tid)?.properties ?? [] }));
      const out = new Map<string, Column & { n: number; only?: string }>();
      for (const { tid, props } of per) for (const p of props) out.set(p.name, out.has(p.name) ? { ...out.get(p.name)!, n: out.get(p.name)!.n + 1 } : { name: p.name, type: p.type, n: 1, only: tname(tid) });
      return [...out.values()].map(({ n, only, ...x }) => ({ ...x, ...(n < per.length ? { only } : {}) }));
    };
    return (
      <div className="space-y-3">
        <OutputVar mod={mod} value={c.filter_output} onChange={(v) => set({ filter_output: v })} />
        <Field label="Filters">
          <div className="space-y-1">
            {items.map((it, i) => {
              const lprops = it.link ? linkProps(it.link) : [];
              const props: (Column & { only?: string })[] = it.link ? lprops : cols;
              const colType = props.find((x) => x.name === it.column)?.type;
              const picked = pickValue(it.link);
              const refs = it.link && !it.link.every ? refsOf(it.link) : [];
              // every link to a type and an interface link: each member type's links are given (shown, not chosen)
              const fixed = !!it.link && (!!it.link.every || !!it.link.interface_link);
              const setPer = (tid: string, v: string) => {
                const [id, dir] = v.split(":");
                const next = [...refs.map((r) => ({ ...r, from_type_id: fromOf(r) || undefined })).filter((r) => r.from_type_id !== tid), ...(v ? [{ link_type_id: id, direction: dir as LinkRef["direction"], from_type_id: tid }] : [])];
                next.sort((a, b) => members.indexOf(a.from_type_id ?? "") - members.indexOf(b.from_type_id ?? ""));
                const link = linkFromRefs(next, links);
                const keep = !!it.column && linkProps(link).some((p) => p.name === it.column);
                setI(i, { link, ...(keep ? {} : { column: "", component: "has_link" as const }) });
              };
              return (
                <div key={i} className="space-y-1 rounded border border-line p-1.5 text-xs" data-config-item={i}>
                  <div className="flex gap-1">
                    <select
                      value={picked}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "own") return setI(i, { link: undefined, column: cols[0]?.name ?? "" });
                        const ch = choices.find((x) => x.value === v);
                        if (ch) setI(i, { link: ch.link, column: "", component: "has_link" });
                      }}
                      className={`${fieldClass} min-w-0 flex-1 text-xs`}
                      data-link-pick={i}
                    >
                      <option value="own">{c.source?.kind === "interface" ? "The interface's objects" : union ? "These object types" : "This object type"}</option>
                      {picked === "per" && <option value="per">A link per object type ({refs.length})</option>}
                      {group("interface").length > 0 && (
                        <optgroup label="An interface link type">
                          {group("interface").map((x) => (
                            <option key={x.value} value={x.value}>
                              Interface link · {x.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {group("every").length > 0 && (
                        <optgroup label="Every link to an object type">
                          {group("every").map((x) => (
                            <option key={x.value} value={x.value}>
                              {x.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label={union ? "A link (then choose one per object type)" : "A link"}>
                        {group("link").map((x) => (
                          <option key={x.value} value={x.value}>
                            Link · {x.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <button type="button" onClick={() => set({ filter_items: items.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                      ✕
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <select value={it.column} onChange={(e) => setI(i, { column: e.target.value, component: it.link && !e.target.value ? "has_link" : e.target.value === "__keyword" ? "keyword" : it.component === "has_link" ? "multi" : it.component })} className={`${fieldClass} min-w-0 flex-1 text-xs`} data-link-column={it.link ? i : undefined}>
                      {it.link ? <option value="">Has link</option> : <option value="__keyword">Keyword (every property)</option>}
                      {props.map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name}
                          {it.link ? (x.only ? ` (only ${x.only})` : "") : info.only.has(x.name) ? ` (only ${info.only.get(x.name)})` : ""}
                        </option>
                      ))}
                    </select>
                    <select value={it.component} onChange={(e) => setI(i, { component: e.target.value as FilterItem["component"] })} className={`${fieldClass} text-xs`} disabled={it.column === "__keyword" || (!!it.link && !it.column)}>
                      {(it.link ? ["histogram", "multi", "single"] : ["histogram", "multi", "single", "keyword", "range", "date_range", "timeline", "distribution"]).map((x) => (
                        <option key={x} disabled={chartMismatch(x, colType)} title={chartMismatch(x, colType) ? (x === "timeline" ? "Needs a date or timestamp property" : "Needs a numeric property") : undefined}>
                          {x}
                        </option>
                      ))}
                      {it.link && !it.column && <option value="has_link">has_link</option>}
                    </select>
                  </div>
                  {it.link && union && (
                    <div className="space-y-0.5 rounded bg-panel-2/40 p-1" data-link-per-type={i}>
                      {members.map((tid) => {
                        const own = links.filter((x) => x.from_type_id === tid);
                        const mine = it.link!.every
                          ? own.filter((x) => x.target_type_id === it.link!.target_type_id)
                          : it.link!.interface_link
                            ? own.filter((x) => refs.some((r) => r.from_type_id === tid && r.link_type_id === x.link_type_id && r.direction === x.direction))
                            : refs.filter((r) => fromOf(r) === tid);
                        return (
                          <div key={tid} className="flex items-center gap-1" data-link-member={tid}>
                            <span className="w-28 shrink-0 truncate text-[11px] text-soft" title={tname(tid)}>
                              {tname(tid)}
                            </span>
                            {fixed ? (
                              <span className={`min-w-0 flex-1 truncate text-[11px] ${mine.length ? "" : "text-muted"}`} data-link-member-links>
                                {mine.length ? (mine as LinkInfo[]).map((x) => x.name).join(", ") : "no link: no linked objects"}
                              </span>
                            ) : (
                              <select
                                value={mine[0] ? `${mine[0].link_type_id}:${mine[0].direction}` : ""}
                                onChange={(e) => setPer(tid, e.target.value)}
                                className={`${fieldClass} min-w-0 flex-1 text-[11px]`}
                                data-link-member-pick={tid}
                              >
                                <option value="">No link (no linked objects)</option>
                                {own.map((x) => (
                                  <option key={`${x.link_type_id}:${x.direction}`} value={`${x.link_type_id}:${x.direction}`}>
                                    {x.name} ({x.target_name})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        );
                      })}
                      <LinkGaps link={it.link} members={members} infos={links} names={tname} detail />
                    </div>
                  )}
                  <input value={it.label ?? ""} onChange={(e) => setI(i, { label: e.target.value || undefined })} placeholder="Label" className={`${fieldClass} w-full text-xs`} />
                  {!it.link && it.component === "keyword" && <KeywordItemConfig it={it} setI={(x) => setI(i, x)} info={info} />}
                  {!it.link && it.component === "timeline" && (
                    <div className="flex items-center gap-1" data-timeline-config>
                      <span className="text-[11px] text-muted">Buckets</span>
                      <select value={it.interval ?? "auto"} onChange={(e) => setI(i, { interval: e.target.value === "auto" ? undefined : (e.target.value as FilterItem["interval"]) })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                        <option value="auto">Automatic (by the range of dates)</option>
                        <option value="day">Days</option>
                        <option value="week">Weeks (from Monday)</option>
                        <option value="month">Months</option>
                        <option value="year">Years</option>
                      </select>
                    </div>
                  )}
                  {!it.link && it.component === "distribution" && (
                    <div className="flex items-center gap-1" data-distribution-config>
                      <span className="text-[11px] text-muted">Bins (about)</span>
                      <input
                        type="number"
                        min={2}
                        max={100}
                        value={it.bins ?? ""}
                        onChange={(e) => setI(i, { bins: e.target.value === "" ? undefined : Math.max(2, Math.min(100, Math.round(Number(e.target.value)) || 24)) })}
                        placeholder="24"
                        className={`${fieldClass} w-20 text-xs`}
                      />
                      <span className="text-[10px] text-muted">edges are round numbers</span>
                    </div>
                  )}
                  {!it.link && chartMismatch(it.component, colType) && (
                    <p className="text-[10px] text-warn" data-chart-mismatch>
                      {it.component === "timeline" ? "A timeline needs a date or timestamp property" : "A distribution needs a numeric property"}
                    </p>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => set({ filter_items: [...items, { column: cols[0]?.name ?? "__keyword", component: "histogram" }] })} className="text-xs text-ocean">
              + Filter
            </button>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.allow_add} onChange={(e) => set({ allow_add: e.target.checked })} /> Users can add and remove filters
        </label>
        <Field label="Layout">
          <select value={c.filter_layout ?? "vertical"} onChange={(e) => set({ filter_layout: e.target.value as "vertical" })} className={inputClass}>
            <option value="vertical">Vertical</option>
            <option value="pills">Pills</option>
          </select>
        </Field>
      </div>
    );
  }
  if (t === "filter_pills" || t === "search_bar")
    return (
      <div className="space-y-3">
        <OutputVar mod={mod} value={c.filter_output} onChange={(v) => set({ filter_output: v })} />
        <Field label="Mode">
          <select value={c.pills_mode ?? (t === "search_bar" ? "add" : "remove")} onChange={(e) => set({ pills_mode: e.target.value as "add" })} className={inputClass}>
            <option value="read">Read only</option>
            <option value="remove">Remove only</option>
            <option value="update">Update existing filters only</option>
            <option value="add">Add, update, remove</option>
          </select>
        </Field>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={!!c.fixed_operator} onChange={(e) => set({ fixed_operator: e.target.checked })} /> Prevent changing operators (and / or)
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={c.show_type_pill !== false} onChange={(e) => set({ show_type_pill: e.target.checked })} /> Object type pill
          </label>
        </div>
        {t === "search_bar" && (
          <>
            <Field label="Placeholder">
              <input value={c.placeholder ?? ""} onChange={(e) => set({ placeholder: e.target.value || undefined })} className={inputClass} />
            </Field>
            <div className="flex flex-wrap gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={c.show_clear !== false} onChange={(e) => set({ show_clear: e.target.checked })} /> Clear button
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!c.no_autocomplete} onChange={(e) => set({ no_autocomplete: e.target.checked })} /> No value suggestions
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!c.no_keyword} onChange={(e) => set({ no_keyword: e.target.checked })} /> No keyword search
              </label>
            </div>
          </>
        )}
      </div>
    );
  if (t === "prominent_terms") {
    const terms = c.terms ?? [];
    return (
      <div className="space-y-3">
        <OutputVar mod={mod} value={c.filter_output} onChange={(v) => set({ filter_output: v })} />
        <Field label="Property">
          <select value={c.term_column ?? ""} onChange={(e) => set({ term_column: e.target.value || undefined })} className={inputClass}>
            <option value="">Choose…</option>
            {cols.map((x) => (
              <option key={x.name}>{x.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Terms (exact values)">
          <div className="space-y-1">
            {terms.map((x, i) => (
              <div key={i} className="flex gap-1">
                <input value={x.value} onChange={(e) => set({ terms: terms.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} placeholder="value" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                <input value={x.label ?? ""} onChange={(e) => set({ terms: terms.map((y, j) => (j === i ? { ...y, label: e.target.value || undefined } : y)) })} placeholder="display name" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                <input value={x.icon ?? ""} onChange={(e) => set({ terms: terms.map((y, j) => (j === i ? { ...y, icon: e.target.value || undefined } : y)) })} placeholder="icon" className={`${fieldClass} w-14 text-xs`} />
                <button type="button" onClick={() => set({ terms: terms.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" onClick={() => set({ terms: [...terms, { value: "" }] })} className="text-xs text-ocean">
              + Term
            </button>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.hide_empty} onChange={(e) => set({ hide_empty: e.target.checked })} /> Hide terms without results
        </label>
      </div>
    );
  }
  return null;
}

/** The default state of an object set filter variable: property filters (values inline or $var:name), all / any, a
 * keyword, and filter value extraction. */
export function FilterDefaultEditor({ v, vars, onDefault, onExtract }: { v: Variable; vars: Variable[]; onDefault: (x: unknown) => void; onExtract: (on: boolean) => void }) {
  const d: OsFilter = v.default && typeof v.default === "object" && Array.isArray((v.default as OsFilter).filters) ? (v.default as OsFilter) : EMPTY;
  const setD = (x: Partial<OsFilter>) => onDefault({ ...d, ...x });
  const setF = (i: number, x: Partial<Filter>) => setD({ filters: d.filters.map((f, j) => (j === i ? { ...f, ...x } : f)) });
  const prim = vars.filter((x) => x.name !== v.name && ["string", "number", "date", "timestamp", "array"].includes(x.type));
  return (
    <div className="space-y-1 text-xs" data-filter-default>
      <div className="text-[11px] text-muted">Default filters</div>
      {d.filters.map((f, i) => (
        <div key={i} className="flex gap-1">
          <input value={f.column} onChange={(e) => setF(i, { column: e.target.value })} placeholder="property" className={`${fieldClass} w-20 text-xs`} />
          <select value={f.op} onChange={(e) => setF(i, { op: e.target.value as Filter["op"] })} className={`${fieldClass} text-xs`}>
            {OPS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input value={Array.isArray(f.value) ? f.value.join(",") : String(f.value ?? "")} onChange={(e) => setF(i, { value: f.op === "in" && !e.target.value.startsWith("$var:") ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })} list={`vars-${v.name}`} placeholder="value or $var:name" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
          <button type="button" onClick={() => setD({ filters: d.filters.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
            ✕
          </button>
        </div>
      ))}
      <datalist id={`vars-${v.name}`}>
        {prim.map((x) => (
          <option key={x.name} value={`$var:${x.name}`} />
        ))}
      </datalist>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setD({ filters: [...d.filters, { column: "", op: "eq", value: "" }] })} className="text-ocean">
          + Filter
        </button>
        <select value={d.mode ?? "all"} onChange={(e) => setD({ mode: e.target.value as "all" })} className={`${fieldClass} text-xs`}>
          <option value="all">all (and)</option>
          <option value="any">any (or)</option>
        </select>
        <input value={d.keyword ?? ""} onChange={(e) => setD({ keyword: e.target.value || undefined })} placeholder="keyword" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        <select value={d.syntax ?? "simple"} onChange={(e) => setD({ syntax: e.target.value === "simple" ? undefined : (e.target.value as KeywordSyntax) })} className={`${fieldClass} text-xs`} title="Keyword syntax" data-default-syntax>
          {(["simple", "advanced", "regex"] as const).map((s) => (
            <option key={s} value={s}>
              {SYNTAX_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!d.contains_prefix} onChange={(e) => setD({ contains_prefix: e.target.checked || undefined })} data-filter-prefix /> CONTAIN matches prefixes only (as Foundry&apos;s starting filters)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!v.extract} onChange={(e) => onExtract(e.target.checked)} data-filter-extract /> Update used variables on filter value changes
      </label>
      <p className="text-[11px] text-muted">Extraction writes the values of matching filters (ranges by operator, terms as a list or the first one) into the $var: variables above.</p>
    </div>
  );
}

