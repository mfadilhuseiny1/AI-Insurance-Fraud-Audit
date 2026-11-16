"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { FiltersEditor } from "@/components/map/DataSources";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { geoApi, type Eml, type GeoSearch, type SearchTemplate, type TileProxyLogEntry, type TileProxySettings } from "@/lib/geo";
import { ontology, type LogicFunction, type ObjectType } from "@/lib/ontology";

const EXAMPLE_YAML = `templates:
  - id: ports_by_region # matches the geo search's Tab ID and Template ID
    title: Ports by region
    query:
      queryType: AND
      subqueries:
        - inputId: keyword
          queryType: KEYWORD
        - field: region
          queryType: EXACT
          inputId: region
        - field: object_type
          queryType: OBJECT_TYPE
          value:
            - Port # object type API name or id
    dataSource: foundry-federation
    namespaces:
      - foundry-federation
    description: Search for ports and show where they are.
    inputs:
      - hint: Type a keyword...
        id: keyword
        inputType: TEXTFIELD
        label: Keyword
      - id: region
        inputType: TEXTFIELD
        label: Region
    aggregations: []
`;

/**
 * Curated data sources for maps, as Gaia's admin application: Enterprise Map Layers (backed by an AIP Logic function
 * or a versioned object set) and geo searches with their search templates (YAML). Changing them needs an
 * administrator; everyone sees them under Data sources → Curated data sources.
 */
export default function MapAdmin() {
  const [emls, setEmls] = useState<Eml[] | null>(null);
  const [tpl, setTpl] = useState<{ yaml: string; templates: SearchTemplate[]; geo_searches: GeoSearch[] } | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [logic, setLogic] = useState<LogicFunction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([geoApi.emls(), geoApi.templates(), ontology.objectTypes(), ontology.logicList().catch(() => [])])
      .then(([e, t, ty, lo]) => {
        setEmls(e);
        setTpl(t);
        setTypes(ty);
        setLogic(lo);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (error) return <ApiError message={error} />;
  if (!emls || !tpl) return <Loading />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 p-8">
        <div className="flex items-center gap-3">
          <Link href="/map" className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="left" className="h-3.5 w-3.5" /> Map
          </Link>
          <h1 className="flex-1 text-xl font-semibold">Curated data sources</h1>
        </div>
        <EmlSection emls={emls} types={types} logic={logic} onChanged={load} />
        <TemplateSection tpl={tpl} onChanged={load} />
        <TileProxySection />
      </div>
    </div>
  );
}

const geoProps = (t?: ObjectType) => (t?.properties ?? []).filter((p) => p.type === "geopoint" || p.type === "geoshape").map((p) => p.api_name);

function EmlSection({ emls, types, logic, onChanged }: { emls: Eml[]; types: ObjectType[]; logic: LogicFunction[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<Partial<Eml> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const geoTypes = types.filter((t) => t.properties.some((p) => ["geopoint", "geoshape", "geotemporal_series_reference"].includes(p.type)));
  const t = types.find((x) => x.id === editing?.object_type_id);
  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await geoApi.saveEml(editing.id, editing);
      else await geoApi.createEml(editing);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <div className="flex-1">
          <h2 className="font-semibold">Enterprise Map Layers</h2>
          <p className="text-xs text-muted">Reference data layers: objects from an AIP Logic function (its output: primary keys or objects) or a versioned object set (an object type with saved filters).</p>
        </div>
        <button type="button" onClick={() => setEditing({ kind: "object_set", object_type_id: geoTypes[0]?.id, filters: [], capabilities: [], acl_groups: [], icon: "layers" })} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {!emls.length && <p className="p-4 text-center text-sm text-muted">No Enterprise Map Layers yet.</p>}
        {emls.map((e) => (
          <div key={e.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
            <Icon name="layers" className="h-4 w-4 text-ocean" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{e.name}</div>
              <div className="truncate text-xs text-muted">
                {e.kind === "function" ? `Foundry function EML · ${logic.find((l) => l.id === e.function_id)?.name ?? e.function_id}` : "Versioned object set EML"} ·{" "}
                {types.find((x) => x.id === e.object_type_id)?.plural_name ?? e.object_type_id}
                {e.refresh_seconds ? ` · every ${e.refresh_seconds} s` : " · no refresh"}
                {e.acl_groups.length ? ` · ${e.acl_groups.join(", ")}` : ""}
              </div>
            </div>
            <button type="button" onClick={() => setEditing(e)} className={buttonClass.ghost}>
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={async () => (await confirmDialog(`Delete the layer ${e.name}?`)) && geoApi.deleteEml(e.id).then(onChanged)} className={`${buttonClass.ghost} text-bad`}>
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      {editing && (
        <div className="mt-3 grid gap-3 rounded-xl border border-ocean/40 bg-panel p-4 text-sm md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-soft">Name</span>
            <input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-soft">EML type</span>
            <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Eml["kind"] })} className={inputClass}>
              <option value="object_set">Versioned object set EML</option>
              <option value="function">Foundry function EML</option>
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-xs text-soft">Description</span>
            <input value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-soft">Object type</span>
            <select value={editing.object_type_id ?? ""} onChange={(e) => setEditing({ ...editing, object_type_id: e.target.value, geo_filter_property: null, filters: [] })} className={inputClass}>
              {geoTypes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.plural_name}
                </option>
              ))}
            </select>
          </label>
          {editing.kind === "function" ? (
            <label className="block">
              <span className="mb-1 block text-xs text-soft">Function (AIP Logic, no required inputs)</span>
              <select value={editing.function_id ?? ""} onChange={(e) => setEditing({ ...editing, function_id: e.target.value })} className={inputClass}>
                <option value="">—</option>
                {logic.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div>
              <span className="mb-1 block text-xs text-soft">Object set filters</span>
              <FiltersEditor props={(t?.properties ?? []).map((p) => p.api_name)} value={editing.filters ?? []} onChange={(filters) => setEditing({ ...editing, filters })} />
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-soft">Refresh interval (seconds; blank: no refresh)</span>
            <input
              type="number"
              min={5}
              value={editing.refresh_seconds ?? ""}
              onChange={(e) => setEditing({ ...editing, refresh_seconds: e.target.value ? Number(e.target.value) : null })}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-soft">Geo filter property (filters to the map&apos;s area)</span>
            <select value={editing.geo_filter_property ?? ""} onChange={(e) => setEditing({ ...editing, geo_filter_property: e.target.value || null })} className={inputClass}>
              <option value="">None</option>
              {geoProps(t).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-soft">Classification</span>
            <input value={editing.classification ?? ""} onChange={(e) => setEditing({ ...editing, classification: e.target.value })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-soft">ACL groups (comma separated; blank: everyone)</span>
            <input
              value={(editing.acl_groups ?? []).join(", ")}
              onChange={(e) => setEditing({ ...editing, acl_groups: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              className={inputClass}
            />
          </label>
          {error && <p className="text-xs text-bad md:col-span-2">{error}</p>}
          <div className="flex justify-end gap-2 md:col-span-2">
            <button type="button" onClick={() => setEditing(null)} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" onClick={save} className={buttonClass.primary}>
              <Icon name="save" className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function TemplateSection({ tpl, onChanged }: { tpl: { yaml: string; templates: SearchTemplate[]; geo_searches: GeoSearch[] }; onChanged: () => void }) {
  const [yaml, setYaml] = useState(tpl.yaml.trim() === "templates: []" ? EXAMPLE_YAML : tpl.yaml);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [gs, setGs] = useState<Partial<GeoSearch> | null>(null);
  const [gsError, setGsError] = useState<string | null>(null);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-semibold">Geo searches</h2>
        <p className="text-xs text-muted">A geo search shows a search template under Data sources (its Template ID matches a template&apos;s id below).</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {!tpl.geo_searches.length && <p className="p-4 text-center text-sm text-muted">No geo searches yet.</p>}
        {tpl.geo_searches.map((g) => (
          <div key={g.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
            <Icon name="search" className="h-4 w-4 text-ocean" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{g.title}</div>
              <div className="truncate text-xs text-muted">
                Template {g.template_id}
                {g.description ? ` · ${g.description}` : ""}
                {g.acl_groups.length ? ` · ${g.acl_groups.join(", ")}` : ""}
              </div>
            </div>
            <button type="button" onClick={async () => (await confirmDialog(`Delete the geo search ${g.title}?`)) && geoApi.deleteGeoSearch(g.id).then(onChanged)} className={`${buttonClass.ghost} text-bad`}>
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div className="border-t border-line p-3">
          {gs ? (
            <div className="grid gap-2 text-sm md:grid-cols-3">
              <input value={gs.title ?? ""} onChange={(e) => setGs({ ...gs, title: e.target.value })} placeholder="Title" className={inputClass} />
              <select value={gs.template_id ?? ""} onChange={(e) => setGs({ ...gs, template_id: e.target.value, tab_id: e.target.value })} className={inputClass}>
                <option value="">Template ID…</option>
                {tpl.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                    {t.title ? ` — ${t.title}` : ""}
                  </option>
                ))}
              </select>
              <input value={gs.description ?? ""} onChange={(e) => setGs({ ...gs, description: e.target.value })} placeholder="Description" className={inputClass} />
              <input value={gs.classification ?? ""} onChange={(e) => setGs({ ...gs, classification: e.target.value })} placeholder="Classification (optional)" className={inputClass} />
              <input
                value={(gs.acl_groups ?? []).join(", ")}
                onChange={(e) => setGs({ ...gs, acl_groups: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder="ACL groups (optional)"
                className={inputClass}
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setGs(null)} className={buttonClass.secondary}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setGsError(null);
                    try {
                      await geoApi.createGeoSearch(gs);
                      setGs(null);
                      onChanged();
                    } catch (e) {
                      setGsError((e as Error).message);
                    }
                  }}
                  className={buttonClass.primary}
                >
                  Preview and save
                </button>
              </div>
              {gsError && <p className="text-xs text-bad md:col-span-3">{gsError}</p>}
            </div>
          ) : (
            <button type="button" onClick={() => setGs({ acl_groups: [] })} className={buttonClass.ghost}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add geo search
            </button>
          )}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-3">
          <div className="flex-1">
            <h2 className="font-semibold">Search templates</h2>
            <p className="text-xs text-muted">
              YAML: a <code>templates:</code> list; each query is a tree of AND / OR / NOT, KEYWORD, OBJECT_TYPE and property subqueries (EXACT, CONTAINS, RANGE with min / max or
              minInputId / maxInputId), filled in from the template&apos;s inputs (TEXTFIELD, NUMBER, DATE, SELECT).
            </p>
          </div>
          {saved && <span className="text-xs text-ok">Saved</span>}
          <button
            type="button"
            onClick={async () => {
              setError(null);
              setSaved(false);
              try {
                await geoApi.saveTemplates(yaml);
                setSaved(true);
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="save" className="h-3.5 w-3.5" /> Preview and save
          </button>
        </div>
        {error && <p className="mb-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <textarea value={yaml} onChange={(e) => (setYaml(e.target.value), setSaved(false))} rows={28} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
      </div>
    </section>
  );
}

/**
 * The tile proxy (GET /api/geo/tile-proxy): the tile servers it may fetch from for vector tile layers whose server
 * sends no CORS headers, its limits and its latest requests.
 */
function TileProxySection() {
  const [settings, setSettings] = useState<TileProxySettings | null>(null);
  const [text, setText] = useState("");
  const [logRows, setLogRows] = useState<TileProxyLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const loadLog = useCallback(() => {
    geoApi.tileProxyLog().then(setLogRows, () => setLogRows(null));
  }, []);
  useEffect(() => {
    geoApi.tileProxySettings().then(
      (s) => {
        setSettings(s);
        setText(s.hosts.join("\n"));
      },
      (e: Error) => setError(e.message),
    );
    loadLog();
  }, [loadLog]);
  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const s = await geoApi.saveTileProxyHosts(text.split(/[\n,]/).map((h) => h.trim()).filter(Boolean));
      setSettings(s);
      setText(s.hosts.join("\n"));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-3" data-section="tile-proxy">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="font-semibold">Tile proxy</h2>
          <p className="text-xs text-muted">
            Vector tile layers can load their tiles through the platform when the tile server sends no CORS headers. Only these hosts are fetched from: one per line,{" "}
            <code>tiles.example.com</code>, <code>*.example.com</code> (sub-domains) or a public IP, optionally with <code>:port</code> (else 80 / 443 only). Hosts that resolve to private,
            loopback, link-local or metadata addresses are always refused, redirects are checked again (at most {settings?.max_redirects ?? 3}), answers are limited to{" "}
            {Math.round((settings?.max_bytes ?? 5242880) / 1048576)} MB and {settings?.timeout_s ?? 20} s and to tile / TileJSON / style content types, and no cookies or credentials are
            forwarded.
          </p>
        </div>
        {saved && <span className="text-xs text-ok">Saved</span>}
        <button type="button" onClick={save} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> Save
        </button>
      </div>
      {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
      <textarea
        value={text}
        onChange={(e) => (setText(e.target.value), setSaved(false))}
        rows={4}
        spellCheck={false}
        placeholder="tiles.example.com"
        aria-label="Tile proxy allowed hosts"
        className={`${inputClass} font-mono text-xs`}
      />
      {!!settings?.env_hosts.length && (
        <p className="text-xs text-muted">
          Also allowed by the {settings.env_var} environment variable: {settings.env_hosts.join(", ")}
        </p>
      )}
      <div>
        <div className="mb-1 flex items-center gap-2">
          <h3 className="flex-1 text-sm font-medium">Latest requests</h3>
          <button type="button" onClick={loadLog} className={`${buttonClass.ghost} text-xs`}>
            <Icon name="refresh" className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        <div className="max-h-72 overflow-auto rounded-xl border border-line bg-panel text-xs">
          {!logRows?.length && <p className="p-3 text-center text-muted">{logRows ? "No requests since the API started." : "Only administrators see the request log."}</p>}
          {logRows?.slice(0, 100).map((r, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-3 py-1.5 last:border-0">
              <span className="shrink-0 text-muted">{r.at.slice(11, 19)}</span>
              <span className={`w-8 shrink-0 font-mono ${r.status >= 400 ? "text-bad" : "text-ok"}`}>{r.status}</span>
              <span className="min-w-0 flex-1 truncate font-mono" title={r.url}>
                {r.url}
              </span>
              <span className="shrink-0 text-muted">
                {r.user} · {r.cache} · {r.bytes.toLocaleString()} B · {r.ms} ms
              </span>
              {r.reason && <span className="w-full truncate text-bad" title={r.reason}>{r.reason}</span>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
