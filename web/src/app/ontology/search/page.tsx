"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox, ValueCell } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { ontology, type ObjectType, type Property } from "@/lib/ontology";
import { FILTER_OPS, om, type DerivedMetric, type DerivedSpec, type Filter, type LinkType, type SearchResult } from "@/lib/ontologyModel";

const METRICS: { id: DerivedMetric; label: string; needsProperty: boolean }[] = [
  { id: "count", label: "Count", needsProperty: false },
  { id: "sum", label: "Sum", needsProperty: true },
  { id: "avg", label: "Average", needsProperty: true },
  { id: "min", label: "Min", needsProperty: true },
  { id: "max", label: "Max", needsProperty: true },
  { id: "exact_distinct", label: "Distinct count", needsProperty: true },
  { id: "collect_list", label: "Collect list", needsProperty: true },
  { id: "collect_set", label: "Collect set", needsProperty: true },
  { id: "select", label: "Select (to-one link)", needsProperty: true },
];

const SYNTAX: [string, string][] = [
  [".", "any single character — c.t matches cat, cot, cut"],
  ["?", "previous character optional — colou?r"],
  ["+", "one or more — go+d matches god, good"],
  ["*", "zero or more — go*d matches gd, god"],
  ["{2,4}", "between 2 and 4 repeats — go{2,4}d"],
  ["|", "or — cat|dog"],
  ["( )", "group — (un)?happy"],
  ["[ ]", "one of — gr[ae]y, [a-z], [^0-9]"],
  ['" "', 'literal text — "v2.0"'],
  ["\\d \\s \\w", "digit, whitespace, word character (\\D \\S \\W negate)"],
];

/**
 * Ontology search: the search syntax (keyword terms, quoted phrases, * and ? wildcards, Lucene regular expressions on
 * properties indexed for regex) and derived properties computed from linked objects at query time.
 */
export default function OntologySearchPage() {
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string>("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [derived, setDerived] = useState<DerivedSpec[]>([]);
  const [sort, setSort] = useState<{ key: string; order: "asc" | "desc" } | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([ontology.objectTypes(), om.linkTypes()]).then(
      ([t, l]) => {
        setTypes(t);
        setLinks(l);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const type = types?.find((t) => t.id === typeId);
  const typeName = (id: string) => types?.find((t) => t.id === id)?.display_name ?? id;
  const outgoing = useMemo(
    () =>
      links.flatMap((lt) => [
        ...(lt.source.object_type_id === typeId ? [{ lt, direction: "forward" as const, to: lt.target.object_type_id }] : []),
        ...(lt.target.object_type_id === typeId ? [{ lt, direction: "reverse" as const, to: lt.source.object_type_id }] : []),
      ]),
    [links, typeId],
  );
  const filterProps: Property[] = [
    ...(type?.properties ?? []),
    ...derived.filter((d) => d.api_name).map((d) => ({ api_name: d.api_name, display_name: `${d.api_name} (derived)`, type: "double" }) as Property),
  ];

  const run = async () => {
    if (!typeId) return;
    setBusy(true);
    try {
      const r = await om.search({
        object_type_id: typeId,
        q,
        filters: filters.filter((f) => f.property && (f.op === "is_null" || f.op === "not_null" || (f.value !== "" && f.value !== undefined))),
        with_properties: derived.filter((d) => d.api_name && d.link_type_id),
        sort: sort?.key ?? null,
        order: sort?.order ?? "asc",
        limit: 200,
        histograms: false,
        resource: "ontology-search",
      });
      setResult(r);
      setSearchError(null);
    } catch (e) {
      setSearchError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!typeId) return;
    const t = setTimeout(() => void run(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, q, filters, derived, sort]);

  if (error && !types) return <ApiError message={error} />;

  const derivedNames = new Set(derived.map((d) => d.api_name));
  const columns = result?.result_type.properties.filter((p) => p.visibility !== "hidden" && p.type !== "vector").slice(0, 14) ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Search" icon="search" href="/ontology/search" crumbs={type ? [{ label: type.display_name }] : []}>
        {type && (
          <Link href={`/object-explorer?type=${type.id}&q=${encodeURIComponent(q)}`} className={buttonClass.secondary}>
            <Icon name="search" className="h-3.5 w-3.5" /> Open in Object Explorer
          </Link>
        )}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Object types</div>
          {(types ?? [])
            .filter((t) => t.visibility !== "hidden")
            .map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTypeId(t.id);
                  setFilters([]);
                  setDerived([]);
                  setSort(null);
                  setResult(null);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${typeId === t.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
              >
                <Icon name="cube" className="h-3.5 w-3.5 text-ocean" />
                <span className="min-w-0 flex-1 truncate">{t.display_name}</span>
                <span className="text-[11px] tabular-nums text-muted">{t.object_count}</span>
              </button>
            ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto bg-ink p-5">
          {!type ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
              <Icon name="search" className="h-8 w-8 text-ocean" />
              <div className="text-base font-semibold text-white">Search with the Nexus search syntax</div>
              Pick an object type. Use keyword terms, &quot;quoted phrases&quot; and * / ? wildcards, regex filters on properties indexed for regex, and derived properties from linked objects.
            </div>
          ) : (
            <div className="space-y-4">
              <Card title="Query">
                <div className="space-y-3 p-4 text-xs">
                  <div className="flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-2.5">
                    <Icon name="search" className="h-4 w-4 text-muted" />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder={`Search ${type.plural_name ?? type.display_name}: terms, "a phrase", harb*, gr?y`}
                      className="w-full bg-transparent py-1.5 text-sm outline-none"
                    />
                  </div>
                  <div className="text-muted">
                    Every term must match the title, primary key or a searchable property. A term starting with * or ? only searches properties with
                    &quot;Leading wildcards&quot; on ({type.properties.filter((p) => p.render_hints?.includes("leading_wildcards")).map((p) => p.display_name).join(", ") || "none"}).
                  </div>
                  <div className="space-y-1.5">
                    {filters.map((f, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <select value={f.property} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)))} className={fieldClass}>
                          {filterProps.map((p) => (
                            <option key={p.api_name} value={p.api_name}>
                              {p.display_name || p.api_name}
                              {p.render_hints?.includes("regex_queries") ? " · regex" : ""}
                            </option>
                          ))}
                        </select>
                        <select value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value as Filter["op"] } : x)))} className={fieldClass}>
                          {FILTER_OPS.filter((o) => o.id !== "between").map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {f.op !== "is_null" && f.op !== "not_null" && (
                          <input value={String(f.value ?? "")} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={f.op === "regex" ? "e.g. .*harbor.*" : "value"} className={`${fieldClass} w-56 font-mono`} />
                        )}
                        <button type="button" onClick={() => setFilters(filters.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove filter">
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setFilters([...filters, { property: type.properties[0]?.api_name ?? "", op: "regex", value: "" }])} className={buttonClass.ghost}>
                      <Icon name="filter" className="h-3.5 w-3.5" /> Add filter
                    </button>
                  </div>
                </div>
              </Card>

              <Card title="Derived properties" count={derived.length} action={<span className="text-[11px] font-normal text-muted">Beta · computed at query time from linked objects</span>}>
                <div className="space-y-2 p-4 text-xs">
                  {outgoing.length === 0 && <div className="text-muted">{type.display_name} has no link types: derived properties aggregate or select across links.</div>}
                  {derived.map((d, i) => {
                    const way = outgoing.find((o) => o.lt.id === d.link_type_id && o.direction === d.direction);
                    const linkedProps = types?.find((t) => t.id === way?.to)?.properties ?? [];
                    const set = (c: Partial<DerivedSpec>) => setDerived(derived.map((x, j) => (j === i ? { ...x, ...c } : x)));
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <input value={d.api_name} onChange={(e) => set({ api_name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} placeholder="apiName" className={`${fieldClass} w-36 font-mono`} />
                        <span className="text-muted">=</span>
                        <select value={d.metric} onChange={(e) => set({ metric: e.target.value as DerivedMetric })} className={fieldClass}>
                          {METRICS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        {METRICS.find((m) => m.id === d.metric)?.needsProperty && (
                          <select value={d.property ?? ""} onChange={(e) => set({ property: e.target.value })} className={fieldClass}>
                            <option value="">property…</option>
                            {linkedProps.map((p) => (
                              <option key={p.api_name} value={p.api_name}>
                                {p.display_name}
                              </option>
                            ))}
                          </select>
                        )}
                        <span className="text-muted">of</span>
                        <select
                          value={`${d.link_type_id}|${d.direction}`}
                          onChange={(e) => {
                            const [id, dir] = e.target.value.split("|");
                            set({ link_type_id: id, direction: dir as "forward" | "reverse", property: null });
                          }}
                          className={fieldClass}
                        >
                          {outgoing.map((o) => (
                            <option key={`${o.lt.id}|${o.direction}`} value={`${o.lt.id}|${o.direction}`}>
                              {(o.direction === "forward" ? o.lt.target.display_name : o.lt.source.display_name) || typeName(o.to)} ({typeName(o.to)})
                            </option>
                          ))}
                        </select>
                        <button type="button" onClick={() => setDerived(derived.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove derived property">
                          <Icon name="x" className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                  {outgoing.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setDerived([...derived, { api_name: `derived${derived.length + 1}`, link_type_id: outgoing[0].lt.id, direction: outgoing[0].direction, metric: "count" }])}
                      className={buttonClass.ghost}
                    >
                      <Icon name="plus" className="h-3.5 w-3.5" /> Add derived property
                    </button>
                  )}
                </div>
              </Card>

              <ErrorBox message={searchError} />

              <Card
                title="Results"
                count={result?.total}
                action={
                  result && (
                    <span className="text-[11px] font-normal text-muted">
                      {busy ? "Searching…" : `${result.query_types.join(" + ")} · ${result.compute_seconds} compute-seconds`}
                    </span>
                  )
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-panel-2 text-left text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Title</th>
                        {columns.map((p) => (
                          <th key={p.api_name} className={`whitespace-nowrap px-3 py-2 font-medium ${derivedNames.has(p.api_name) ? "text-sand" : ""}`}>
                            <button
                              type="button"
                              onClick={() => setSort(sort?.key === p.api_name ? { key: p.api_name, order: sort.order === "asc" ? "desc" : "asc" } : { key: p.api_name, order: "asc" })}
                              className="inline-flex items-center gap-1 hover:text-white"
                            >
                              {p.display_name}
                              {sort?.key === p.api_name && <span>{sort.order === "asc" ? "↑" : "↓"}</span>}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(result?.objects ?? []).map((o) => (
                        <tr key={o.primary_key} className="hover:bg-panel-2">
                          <td className="px-3 py-2">
                            <Link href={`/ontology/objects/${o.object_type_id}/${encodeURIComponent(o.primary_key)}`} className="text-ocean hover:underline">
                              {o.title}
                            </Link>
                          </td>
                          {columns.map((p) => (
                            <td key={p.api_name} className={`max-w-56 truncate px-3 py-2 ${derivedNames.has(p.api_name) ? "bg-sand/5" : ""}`}>
                              <ValueCell type={p.type} value={o.properties[p.api_name]} />
                            </td>
                          ))}
                        </tr>
                      ))}
                      {result && result.objects.length === 0 && (
                        <tr>
                          <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-muted">
                            No objects match.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </main>

        <aside className="w-80 shrink-0 space-y-4 overflow-y-auto border-l border-line bg-panel p-4 text-xs">
          <RegexTester />
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Regex syntax</div>
            <p className="mb-2 text-muted">Patterns match the whole value (add .* on both sides to find text inside it). ^ and $ are not supported. Regex is case-sensitive.</p>
            <div className="divide-y divide-line rounded-md border border-line">
              {SYNTAX.map(([op, text]) => (
                <div key={op} className="flex gap-3 px-2.5 py-1.5">
                  <code className="w-14 shrink-0 font-mono text-ocean">{op}</code>
                  <span className="text-soft">{text}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-muted">A string property needs &quot;Regex queries&quot; (Nexus Manager → Properties → Interaction) before it can be filtered by regex.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function RegexTester() {
  const [pattern, setPattern] = useState(".*harbor.*");
  const [samples, setSamples] = useState("Grey harbor\nharbor\nHarbor Bay\nv2.0");
  const [res, setRes] = useState<{ valid: boolean; error: string | null; matches: string[] } | null>(null);
  useEffect(() => {
    const t = setTimeout(
      () =>
        om.checkRegex(pattern, samples.split("\n").filter(Boolean)).then(
          (r) => setRes(r),
          (e: Error) => setRes({ valid: false, error: e.message, matches: [] }),
        ),
      250,
    );
    return () => clearTimeout(t);
  }, [pattern, samples]);
  const lines = samples.split("\n").filter(Boolean);
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Regex tester</div>
      <input value={pattern} onChange={(e) => setPattern(e.target.value)} className={`${inputClass} font-mono`} aria-label="Pattern" />
      {res && !res.valid && <div className="mt-1 text-bad">{res.error}</div>}
      <textarea value={samples} onChange={(e) => setSamples(e.target.value)} rows={4} className={`${inputClass} mt-2 font-mono`} aria-label="Sample values, one per line" />
      <div className="mt-2 space-y-0.5">
        {lines.map((l, i) => (
          <div key={i} className={`flex items-center gap-2 font-mono ${res?.matches.includes(l) ? "text-ok" : "text-muted"}`}>
            <Icon name={res?.matches.includes(l) ? "check" : "x"} className="h-3 w-3" /> {l}
          </div>
        ))}
      </div>
    </div>
  );
}
