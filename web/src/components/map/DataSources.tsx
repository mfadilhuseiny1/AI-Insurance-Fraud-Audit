"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import {
  geoApi,
  isWarpTemplate,
  WARP_SAMPLINGS,
  warpSampling,
  withWarpSampling,
  type Area,
  type AreaMode,
  type Eml,
  type GeoObjectType,
  type GeoSearch,
  type Layer,
  type PropertyFilter,
  type ServiceLayer,
  type Sources,
  type TimeFilter,
} from "@/lib/geo";
import { loadTile, tileFeatures, tilesFor, tileUrl, validTemplate } from "@/lib/mvt";
import { ontology, type OntologyObject } from "@/lib/ontology";
import type { SeriesSync } from "@/lib/timeseries";
import type { Bounds, Drawn } from "./MapCanvas";

export const LAYER_COLORS = ["#38bdf8", "#f97316", "#a3e635", "#f472b6", "#facc15", "#34d399", "#c084fc", "#fb7185", "#60a5fa", "#fbbf24"];
const newId = () => "l-" + Math.random().toString(16).slice(2, 10);

/** What the panel needs from the map: its extent, drawing a shape, picking a shape on the map. */
export type MapTools = {
  bounds: () => Bounds;
  draw: (kind: "polygon" | "circle") => Promise<Drawn | null>;
  select: () => Promise<{ type: string; coordinates: unknown } | null>;
  nextColor: () => string;
};

type Picked =
  | { kind: "objects"; t: GeoObjectType }
  | { kind: "raster-objects"; t: GeoObjectType }
  | { kind: "tracks"; s: SeriesSync }
  | { kind: "template"; g: GeoSearch }
  | { kind: "raster" }
  | { kind: "choropleth" }
  | { kind: "add-objects" }
  | { kind: "tiles" }
  | { kind: "vector" }
  | { kind: "features" };

/** Gaia's Data sources tab: search for a source, configure it and add it to the map as a layer. */
export function DataSources({ tools, onAdd, onClose }: { tools: MapTools; onAdd: (l: Layer) => void; onClose?: () => void }) {
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<Sources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  useEffect(() => {
    const t = setTimeout(() => geoApi.sources(q).then(setSources, (e: Error) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [q]);
  const add = (l: Omit<Layer, "id" | "visible" | "opacity" | "color"> & { color?: string }) => {
    onAdd({ id: newId(), visible: true, opacity: 1, color: l.color ?? tools.nextColor(), ...l } as Layer);
    setPicked(null);
    onClose?.();
  };
  if (picked) {
    const back = () => setPicked(null);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button type="button" onClick={back} className="flex items-center gap-1 border-b border-line px-3 py-2 text-left text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3.5 w-3.5" /> Data sources
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
          {picked.kind === "objects" && <ObjectSearchForm t={picked.t} tools={tools} onAdd={add} />}
          {picked.kind === "raster-objects" && <RasterObjectsForm t={picked.t} onAdd={add} />}
          {picked.kind === "tracks" && <TracksForm s={picked.s} tools={tools} onAdd={add} />}
          {picked.kind === "template" && <TemplateForm g={picked.g} tools={tools} onAdd={add} />}
          {picked.kind === "raster" && <RasterFileForm onAdd={add} onCancel={back} />}
          {picked.kind === "choropleth" && <ChoroplethForm types={sources?.object_types ?? []} onAdd={add} />}
          {picked.kind === "add-objects" && <AddObjectsForm types={sources?.object_types ?? []} onAdd={add} />}
          {picked.kind === "tiles" && <TileServerForm onAdd={add} />}
          {picked.kind === "vector" && <VectorTileForm onAdd={add} />}
          {picked.kind === "features" && <FeatureServiceForm onAdd={add} />}
        </div>
      </div>
    );
  }
  const row = (icon: IconName, title: string, sub: string, onClick: () => void, key: string, action = "Search for objects") => (
    <li key={key}>
      <button type="button" onClick={onClick} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-panel-2" data-source-row={key}>
        <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          <span className="block truncate text-[11px] text-muted">{sub}</span>
        </span>
        <span className="shrink-0 text-[10px] text-ocean">{action}</span>
      </button>
    </li>
  );
  const section = (label: string, items: ReactNode[]) =>
    items.length > 0 && (
      <div>
        <div className="sticky top-0 bg-panel px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        <ul>{items}</ul>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-2">
        <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search data sources" className="w-full bg-transparent py-1.5 text-sm outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {error && <p className="p-3 text-xs text-bad">{error}</p>}
        {!sources && !error && <Loading />}
        {sources && (
          <>
            {section("Curated data sources · Reference data layers", sources.emls.map((e: Eml) =>
              row("layers", e.name, `${e.kind === "function" ? "Function" : "Versioned object set"} EML${e.refresh_seconds ? ` · refreshes every ${e.refresh_seconds} s` : ""}${e.description ? ` · ${e.description}` : ""}`,
                () => add({ name: e.name, kind: "eml", config: { eml_id: e.id } }), e.id, "Add to map"),
            ))}
            {section("Curated data sources · Search templates", sources.geo_searches.map((g) =>
              row("search", g.title, g.description || g.template?.title || g.template_id, () => setPicked({ kind: "template", g }), g.id, "Open"),
            ))}
            {section("Object types", sources.object_types.flatMap((t) => [
              ...(t.geo.length || t.gtsr
                ? [row("cube", t.plural_name, `${t.object_count.toLocaleString()} objects · ${[...t.geo, ...(t.gtsr ? [`${t.gtsr.property} (track)`] : [])].join(", ")}`, () => setPicked({ kind: "objects", t }), t.id)]
                : []),
              ...(t.media.length ? [row("image", `${t.plural_name} · rasters`, `media: ${t.media.join(", ")} (GeoTIFF)`, () => setPicked({ kind: "raster-objects", t }), `${t.id}-r`, "Add rasters")] : []),
            ]))}
            {section("Geotemporal series syncs", sources.syncs.map((s) =>
              row("wave", s.name, `${s.series} series · ${s.stored.toLocaleString()} observations${s.mode === "streaming" ? " · streaming" : ""}`, () => setPicked({ kind: "tracks", s }), s.id, "Tracks and observations"),
            ))}
            {section("Other", [
              row("cube", "Add objects", "Pick objects of a type to place on the map", () => setPicked({ kind: "add-objects" }), "add-objects", "Pick"),
              row("image", "Raster from Files", "A GeoTIFF or GeoJP2 (≤ 67 MB), warped to Web Mercator", () => setPicked({ kind: "raster" }), "raster", "Pick file"),
              row("grid", "Boundaries (choropleth)", "Regions from a GeoJSON in Files, coloured by your objects", () => setPicked({ kind: "choropleth" }), "choropleth", "Configure"),
              row("layers", "Tile server", "An external XYZ tile layer ({z}/{x}/{y}) above the basemap", () => setPicked({ kind: "tiles" }), "tiles", "Configure"),
              row("layers", "Vector tiles", "Mapbox Vector Tiles (MVT URL {z}/{x}/{y}.pbf or a TileJSON): features you can click and style", () => setPicked({ kind: "vector" }), "vector", "Configure"),
              row("globe", "Feature service", "Features of an ArcGIS FeatureServer, an OGC API Features collection or a GeoJSON URL", () => setPicked({ kind: "features" }), "features", "Configure"),
            ])}
            {!sources.object_types.length && !sources.syncs.length && !sources.emls.length && (
              <p className="px-3 pt-4 text-xs text-muted">
                Nothing to map{q ? " matches" : " yet"}. Give an object type a geopoint, geoshape or geotemporal series reference property in Nexus Manager, or add a
                geotemporal series sync output to a pipeline.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ shared inputs

function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">{text}</span>
      {children}
    </label>
  );
}

/** All / View / Draw / Select, as Gaia's geometric filters. */
export function AreaPicker({ area, onChange, tools }: { area: Area; onChange: (a: Area) => void; tools: MapTools }) {
  const [busy, setBusy] = useState(false);
  const pick = async (mode: AreaMode, how?: "polygon" | "circle") => {
    if (mode === "all") return onChange({ mode });
    if (mode === "view") return onChange({ mode, bbox: tools.bounds() });
    setBusy(true);
    try {
      if (mode === "draw") {
        const d = await tools.draw(how ?? "polygon");
        if (d) onChange({ mode, ...(d.polygon ? { polygon: d.polygon } : {}), ...(d.circle ? { circle: d.circle } : {}) });
      } else {
        const g = await tools.select();
        if (g) onChange({ mode, polygon: g });
      }
    } finally {
      setBusy(false);
    }
  };
  const btn = (mode: AreaMode, label: string, hint: string, how?: "polygon" | "circle") => (
    <button
      type="button"
      disabled={busy}
      title={hint}
      onClick={() => pick(mode, how)}
      className={`flex-1 px-2 py-1 ${area.mode === mode && (!how || (how === "circle") === !!area.circle) ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
    >
      {label}
    </button>
  );
  return (
    <div>
      <div className="flex overflow-hidden rounded-md border border-line text-xs">
        {btn("all", "All", "Every object")}
        {btn("view", "View", "Only what is in the current map view")}
        {btn("draw", "Draw", "Inside a polygon you draw", "polygon")}
        {btn("draw", "Circle", "Within a circle you draw", "circle")}
        {btn("select", "Select", "Inside a shape you pick on the map")}
      </div>
      <p className="mt-1 text-[11px] text-muted">
        {busy
          ? "Draw or pick on the map…"
          : area.mode === "all"
            ? "No geometric filter."
            : area.mode === "view"
              ? "Within the map view at the time of the search."
              : area.circle
                ? `Within ${(area.circle.radius_m / 1000).toFixed(2)} km of ${area.circle.lat.toFixed(4)}, ${area.circle.lon.toFixed(4)}.`
                : area.polygon
                  ? `Inside the ${area.mode === "select" ? "picked" : "drawn"} shape.`
                  : ""}
      </p>
    </div>
  );
}

const ROLLING = [
  [15, "15 minutes"],
  [60, "1 hour"],
  [360, "6 hours"],
  [1440, "24 hours"],
  [10080, "7 days"],
] as const;

function TimePicker({ t, value, onChange }: { t: GeoObjectType; value: TimeFilter | null; onChange: (v: TimeFilter | null) => void }) {
  const props = t.time;
  const canTime = props.length > 0 || !!t.gtsr;
  if (!canTime) return null;
  return (
    <Label text="Time">
      <div className="space-y-1.5">
        <select
          value={value ? value.mode : ""}
          onChange={(e) => onChange(e.target.value ? { mode: e.target.value as "static" | "rolling", property: props[0], minutes: 60 } : null)}
          className={inputClass}
        >
          <option value="">Any time</option>
          <option value="static">Static range</option>
          <option value="rolling">Rolling window</option>
        </select>
        {value && props.length > 0 && (
          <select value={value.property ?? ""} onChange={(e) => onChange({ ...value, property: e.target.value })} className={inputClass}>
            {props.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {value?.mode === "static" && (
          <div className="grid grid-cols-2 gap-1.5">
            <input type="datetime-local" value={value.start?.slice(0, 16) ?? ""} onChange={(e) => onChange({ ...value, start: e.target.value ? new Date(e.target.value + "Z").toISOString() : undefined })} className={fieldClass} />
            <input type="datetime-local" value={value.end?.slice(0, 16) ?? ""} onChange={(e) => onChange({ ...value, end: e.target.value ? new Date(e.target.value + "Z").toISOString() : undefined })} className={fieldClass} />
          </div>
        )}
        {value?.mode === "rolling" && (
          <select value={value.minutes ?? 60} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })} className={inputClass}>
            {ROLLING.map(([m, l]) => (
              <option key={m} value={m}>
                Last {l}
              </option>
            ))}
          </select>
        )}
      </div>
    </Label>
  );
}

const OPS: [PropertyFilter["op"], string][] = [
  ["eq", "is"],
  ["neq", "is not"],
  ["contains", "contains"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["in", "one of (a,b)"],
];

export function FiltersEditor({ props, value, onChange }: { props: string[]; value: PropertyFilter[]; onChange: (v: PropertyFilter[]) => void }) {
  return (
    <div className="space-y-1.5">
      {value.map((f, i) => {
        const set = (c: Partial<PropertyFilter>) => onChange(value.map((x, j) => (j === i ? { ...x, ...c } : x)));
        return (
          <div key={i} className="flex gap-1">
            <select value={f.property} onChange={(e) => set({ property: e.target.value })} className={`${fieldClass} w-24 min-w-0`}>
              {props.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => set({ op: e.target.value as PropertyFilter["op"] })} className={`${fieldClass} w-20`}>
              {OPS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {/* "in": a comma-separated list of values */}
            <input
              value={Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")}
              onChange={(e) => set({ value: f.op === "in" ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })}
              placeholder={f.op === "in" ? "a, b, c" : undefined}
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove filter">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...value, { property: props[0], op: "eq", value: "" }])} className={buttonClass.ghost}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Property filter
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ forms

type AddFn = (l: Omit<Layer, "id" | "visible" | "opacity" | "color"> & { color?: string }) => void;

function ObjectSearchForm({ t, tools, onAdd }: { t: GeoObjectType; tools: MapTools; onAdd: AddFn }) {
  const [property, setProperty] = useState<string>(t.geo[0] ?? "");
  const [area, setArea] = useState<Area>({ mode: "all" });
  const [time, setTime] = useState<TimeFilter | null>(null);
  const [kw, setKw] = useState("");
  const [filters, setFilters] = useState<PropertyFilter[]>([]);
  const [live, setLive] = useState(false);
  const [title, setTitle] = useState(t.plural_name);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ name: title.trim() || t.plural_name, kind: "objects", config: { object_type_id: t.id, property: property || null, area, time, q: kw, filters, live } });
      }}
    >
      <div className="font-medium">{t.plural_name}</div>
      <Label text="Draw by">
        <select value={property} onChange={(e) => setProperty(e.target.value)} className={inputClass}>
          {t.geo.map((p) => (
            <option key={p} value={p}>
              {p} ({t.properties.find((x) => x.api_name === p)?.type})
            </option>
          ))}
          {t.gtsr && <option value="">Current position (track {t.gtsr.property})</option>}
        </select>
      </Label>
      <Label text="Where">
        <AreaPicker area={area} onChange={setArea} tools={tools} />
      </Label>
      <TimePicker t={t} value={time} onChange={setTime} />
      <Label text="Keyword">
        <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="Any property contains…" className={inputClass} />
      </Label>
      <Label text="Filters">
        <FiltersEditor props={t.properties.map((p) => p.api_name)} value={filters} onChange={setFilters} />
      </Label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--color-ocean)]" /> Live update search results (every 30 s)
      </label>
      <Label text="Search title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </Label>
      <button type="submit" className={`${buttonClass.primary} w-full justify-center`}>
        <Icon name="search" className="h-3.5 w-3.5" /> Search and add to map
      </button>
      <p className="text-[11px] text-muted">At most 5,000 objects per search.</p>
    </form>
  );
}

function RasterObjectsForm({ t, onAdd }: { t: GeoObjectType; onAdd: AddFn }) {
  const [property, setProperty] = useState(t.media[0]);
  return (
    <div className="space-y-3">
      <div className="font-medium">{t.plural_name} · rasters</div>
      <Label text="Media reference property">
        <select value={property} onChange={(e) => setProperty(e.target.value)} className={inputClass}>
          {t.media.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Label>
      <p className="text-[11px] text-muted">Each object&apos;s image is drawn where its GeoTIFF (or GeoJP2) georeference puts it; files over 67 MB are skipped. At most 25 per layer.</p>
      <button type="button" onClick={() => onAdd({ name: `${t.plural_name} (rasters)`, kind: "raster", config: { object_type_id: t.id, property } })} className={`${buttonClass.primary} w-full justify-center`}>
        <Icon name="image" className="h-3.5 w-3.5" /> Add to map
      </button>
    </div>
  );
}

function TracksForm({ s, tools, onAdd }: { s: SeriesSync; tools: MapTools; onAdd: AddFn }) {
  const [mode, setMode] = useState<"historic" | "live">(s.mode === "streaming" ? "live" : "historic");
  const [start, setStart] = useState(s.first_ts ?? "");
  const [end, setEnd] = useState(s.last_ts ?? "");
  const [minutes, setMinutes] = useState(60);
  const [area, setArea] = useState<Area>({ mode: "all" });
  const [title, setTitle] = useState(s.name);
  const local = (iso: string) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ name: title.trim() || s.name, kind: "tracks", config: { sync_id: s.id, mode, start: mode === "historic" ? start : undefined, end: mode === "historic" ? end : undefined, minutes, area } });
      }}
    >
      <div className="font-medium">Tracks and observations search</div>
      <div className="text-xs text-muted">{s.name}</div>
      <div className="flex overflow-hidden rounded-md border border-line text-xs">
        {(["historic", "live"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`flex-1 px-2 py-1 ${mode === m ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
            {m === "historic" ? "Historic search" : "Live feed"}
          </button>
        ))}
      </div>
      {mode === "historic" ? (
        <div className="grid grid-cols-2 gap-1.5">
          <Label text="From">
            <input type="datetime-local" value={local(start)} onChange={(e) => setStart(e.target.value ? new Date(e.target.value + "Z").toISOString() : "")} className={fieldClass} />
          </Label>
          <Label text="To">
            <input type="datetime-local" value={local(end)} onChange={(e) => setEnd(e.target.value ? new Date(e.target.value + "Z").toISOString() : "")} className={fieldClass} />
          </Label>
        </div>
      ) : (
        <Label text="Window (refreshes every 10 s)">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={inputClass}>
            {ROLLING.map(([m, l]) => (
              <option key={m} value={m}>
                Last {l}
              </option>
            ))}
          </select>
        </Label>
      )}
      <Label text="Where (series with an observation inside)">
        <AreaPicker area={area} onChange={setArea} tools={tools} />
      </Label>
      <Label text="Search title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </Label>
      <button type="submit" className={`${buttonClass.primary} w-full justify-center`}>
        <Icon name="wave" className="h-3.5 w-3.5" /> Add to map
      </button>
    </form>
  );
}

function TemplateForm({ g, tools, onAdd }: { g: GeoSearch; tools: MapTools; onAdd: AddFn }) {
  const t = g.template;
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [area, setArea] = useState<Area>({ mode: "all" });
  const [live, setLive] = useState(false);
  if (!t) return <p className="text-xs text-bad">The search template {g.template_id} no longer exists.</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const summary = Object.values(inputs).filter((v) => v !== "" && v !== undefined).join(", ");
        onAdd({ name: `${t.title || g.title}${summary ? `: ${summary}` : ""}`, kind: "template", config: { template_id: t.id, inputs, area, live } });
      }}
    >
      <div className="font-medium">{t.title || g.title}</div>
      {(g.description || t.description) && <p className="text-xs text-muted">{g.description || t.description}</p>}
      {(t.inputs ?? []).map((i) => (
        <Label key={i.id} text={i.label || i.id}>
          {i.inputType === "SELECT" && i.options ? (
            <select value={String(inputs[i.id] ?? "")} onChange={(e) => setInputs({ ...inputs, [i.id]: e.target.value })} className={inputClass}>
              <option value="">—</option>
              {i.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              type={i.inputType === "NUMBER" ? "number" : i.inputType === "DATE" ? "date" : "text"}
              value={String(inputs[i.id] ?? "")}
              placeholder={i.hint}
              required={i.required}
              onChange={(e) => setInputs({ ...inputs, [i.id]: e.target.value })}
              className={inputClass}
            />
          )}
        </Label>
      ))}
      <Label text="Where">
        <AreaPicker area={area} onChange={setArea} tools={tools} />
      </Label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--color-ocean)]" /> Live update (every 30 s)
      </label>
      <button type="submit" className={`${buttonClass.primary} w-full justify-center`}>
        <Icon name="search" className="h-3.5 w-3.5" /> Search
      </button>
    </form>
  );
}

function RasterFileForm({ onAdd, onCancel }: { onAdd: AddFn; onCancel: () => void }) {
  return (
    <DrivePicker
      title="Pick a GeoTIFF or GeoJP2"
      canPick={(i) => (i.kind !== "file" ? "Pick a file" : /\.(tiff?|jp2|j2k|ntf|nitf)$/i.test(i.name) ? null : "Pick a .tif, .tiff or .jp2 file")}
      onPick={(i) => onAdd({ name: i.name, kind: "raster", config: { item_id: i.id } })}
      onClose={onCancel}
    />
  );
}

function ChoroplethForm({ types, onAdd }: { types: GeoObjectType[]; onAdd: AddFn }) {
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [featureKey, setFeatureKey] = useState("mapbox_id");
  const [typeId, setTypeId] = useState("");
  const [join, setJoin] = useState("");
  const [agg, setAgg] = useState("count");
  const [valueProp, setValueProp] = useState("");
  // every object type (not only geo ones) can colour regions: list them all
  const [all, setAll] = useState<{ id: string; plural_name: string; properties: { api_name: string; type: string }[] }[]>(types);
  useEffect(() => {
    ontology.objectTypes().then(setAll, () => {});
  }, []);
  const t = all.find((x) => x.id === typeId);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return;
        onAdd({
          name: `${file.name.replace(/\.(geo)?json$/i, "")}${t ? ` · ${agg} of ${t.plural_name}` : ""}`,
          kind: "choropleth",
          config: { boundaries_item_id: file.id, feature_key: featureKey, object_type_id: typeId || undefined, join_property: join || undefined, agg, value_property: valueProp || undefined },
        });
      }}
    >
      <div className="font-medium">Boundaries (choropleth)</div>
      <p className="text-[11px] text-muted">
        Regions come from a GeoJSON FeatureCollection in Files (for example Mapbox Boundaries exported with their mapbox_id, or any administrative boundaries); each is coloured by an
        aggregate of the objects whose join property holds its region id.
      </p>
      <Label text="Boundaries file">
        <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} w-full justify-start`}>
          <Icon name="folder" className="h-3.5 w-3.5" /> {file ? file.name : "Pick a .geojson file"}
        </button>
      </Label>
      <Label text="Region id property in the boundaries">
        <input value={featureKey} onChange={(e) => setFeatureKey(e.target.value)} className={`${inputClass} font-mono`} />
      </Label>
      <Label text="Object type">
        <select value={typeId} onChange={(e) => (setTypeId(e.target.value), setJoin(""), setValueProp(""))} className={inputClass}>
          <option value="">None (outline only)</option>
          {all.map((x) => (
            <option key={x.id} value={x.id}>
              {x.plural_name}
            </option>
          ))}
        </select>
      </Label>
      {t && (
        <>
          <Label text="Property holding the region id">
            <select value={join} onChange={(e) => setJoin(e.target.value)} className={inputClass} required>
              <option value="">—</option>
              {t.properties.map((p) => (
                <option key={p.api_name}>{p.api_name}</option>
              ))}
            </select>
          </Label>
          <div className="grid grid-cols-2 gap-1.5">
            <Label text="Aggregate">
              <select value={agg} onChange={(e) => setAgg(e.target.value)} className={inputClass}>
                {["count", "sum", "avg", "min", "max"].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </Label>
            {agg !== "count" && (
              <Label text="Of">
                <select value={valueProp} onChange={(e) => setValueProp(e.target.value)} className={inputClass} required>
                  <option value="">—</option>
                  {t.properties.filter((p) => p.type === "integer" || p.type === "double").map((p) => (
                    <option key={p.api_name}>{p.api_name}</option>
                  ))}
                </select>
              </Label>
            )}
          </div>
        </>
      )}
      <button type="submit" disabled={!file} className={`${buttonClass.primary} w-full justify-center`}>
        <Icon name="grid" className="h-3.5 w-3.5" /> Add to map
      </button>
      {picking && (
        <DrivePicker
          title="Pick a GeoJSON file"
          canPick={(i) => (i.kind === "file" && /\.(geo)?json$/i.test(i.name) ? null : "Pick a .geojson or .json file")}
          onPick={(i) => (setFile({ id: i.id, name: i.name }), setPicking(false))}
          onClose={() => setPicking(false)}
        />
      )}
    </form>
  );
}

function AddObjectsForm({ types, onAdd }: { types: GeoObjectType[]; onAdd: AddFn }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<OntologyObject[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!typeId) return;
    const t = setTimeout(() => ontology.objects(typeId, q).then((r) => setRows(r.objects), () => setRows([])), 200);
    return () => clearTimeout(t);
  }, [typeId, q]);
  const t = types.find((x) => x.id === typeId);
  return (
    <div className="space-y-3">
      <div className="font-medium">Add objects</div>
      <select value={typeId} onChange={(e) => (setTypeId(e.target.value), setPicked(new Set()))} className={inputClass}>
        {types.filter((x) => x.geo.length || x.gtsr).map((x) => (
          <option key={x.id} value={x.id}>
            {x.plural_name}
          </option>
        ))}
      </select>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search objects" className={inputClass} />
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {rows === null && <li className="p-3 text-xs text-muted">Loading…</li>}
        {rows?.slice(0, 200).map((o) => (
          <li key={o.primary_key}>
            <label className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-panel-2">
              <input
                type="checkbox"
                checked={picked.has(o.primary_key)}
                onChange={() => setPicked((s) => (s.has(o.primary_key) ? new Set([...s].filter((x) => x !== o.primary_key)) : new Set([...s, o.primary_key])))}
                className="accent-[var(--color-ocean)]"
              />
              <span className="truncate">{o.title}</span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!picked.size || !t}
        onClick={() => t && onAdd({ name: `${t.plural_name} (${picked.size})`, kind: "dropped", config: { object_type_id: t.id, primary_keys: [...picked] } })}
        className={`${buttonClass.primary} w-full justify-center`}
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> Add {picked.size || ""} to map
      </button>
      <p className="text-[11px] text-muted">You can also drag objects from Nexus Manager&apos;s Objects table onto the map.</p>
    </div>
  );
}

function TileServerForm({ onAdd }: { onAdd: AddFn }) {
  const [name, setName] = useState("Tile layer");
  const [url, setUrl] = useState("");
  const [maxZoom, setMaxZoom] = useState("19");
  const valid = (url.includes("{bbox-epsg-3857}") || (/\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url))) && (/^https?:\/\//.test(url) || isWarpTemplate(url));
  // read a WMS / WMTS service's layers and pick one
  const [svc, setSvc] = useState("");
  const [svcKind, setSvcKind] = useState<"wms" | "wmts">("wms");
  const [svcLayers, setSvcLayers] = useState<ServiceLayer[] | null>(null);
  const [svcError, setSvcError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ServiceLayer | null>(null);
  const shown = picked && picked.template === withWarpSampling(url, "auto") ? picked : null;
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), valid && onAdd({ name, kind: "tiles", config: { url, max_zoom: Number(maxZoom) || 19 } }))}>
      <Label text="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Label>
      <div className="space-y-1.5 rounded border border-line p-2">
        <div className="text-xs font-medium">From a WMS / WMTS service</div>
        <div className="flex gap-1">
          <select value={svcKind} onChange={(e) => setSvcKind(e.target.value as "wms")} className={fieldClass} aria-label="Service kind">
            <option value="wms">WMS</option>
            <option value="wmts">WMTS</option>
          </select>
          <input value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="https://example.com/wms" className={`${inputClass} flex-1`} aria-label="Service URL" />
          <button
            type="button"
            disabled={!/^https?:\/\//.test(svc)}
            onClick={() =>
              geoApi.capabilities(svc, svcKind).then(
                (r) => (setSvcLayers(r.layers), setSvcError(null), setPicked(null)),
                (e: Error) => (setSvcLayers(null), setSvcError(e.message)),
              )
            }
            className={buttonClass.secondary}
          >
            Read layers
          </button>
        </div>
        {svcError && <p className="text-xs text-bad">{svcError}</p>}
        {svcLayers && (
          <select
            value=""
            onChange={(e) => {
              const l = svcLayers.find((x) => x.name === e.target.value);
              setPicked(l ?? null);
              if (l?.template) {
                setUrl(l.template);
                setName(l.title);
              }
            }}
            className={inputClass}
            aria-label="Service layer"
          >
            <option value="">{svcLayers.length} layers — pick one…</option>
            {svcLayers.map((l) => (
              <option key={l.name} value={l.name} disabled={!l.template} title={l.reason ?? undefined} data-crs={l.crs ?? ""}>
                {l.title}
                {l.warp ? ` (reprojected from ${l.warp.crs})` : l.template ? "" : " (cannot be shown)"}
              </option>
            ))}
          </select>
        )}
        {svcLayers && svcLayers.some((l) => !l.template) && (
          <details className="text-xs text-muted" data-service-unshown>
            <summary>
              {svcLayers.filter((l) => !l.template).length === 1 ? "1 layer cannot" : `${svcLayers.filter((l) => !l.template).length} layers cannot`} be shown
            </summary>
            <ul className="mt-1 space-y-0.5">
              {svcLayers
                .filter((l) => !l.template)
                .map((l) => (
                  <li key={l.name}>
                    <span className="text-white">{l.title}</span>: {l.reason || "not offered in a CRS the map can draw"}
                  </li>
                ))}
            </ul>
          </details>
        )}
        {shown?.warp && (
          <p className={`text-xs ${shown.warp.allowed ? "text-muted" : "text-bad"}`} data-warp-note>
            {shown.warp.via === "wmts" ? `Tiles of the matrix set ${shown.tile_matrix_set} (${shown.warp.crs})` : `GetMap images in ${shown.warp.crs}`} are reprojected
            to Web Mercator by the platform, fetched through its tile proxy from {shown.warp.hosts.join(", ")}.
            {shown.warp.allowed ? "" : " That host is not on the tile proxy's allow-list yet: an administrator adds it under Map admin → Tile proxy."}
          </p>
        )}
      </div>
      <Label text="URL template">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tiles.example.com/{z}/{x}/{y}.png or …&BBOX={bbox-epsg-3857}" className={inputClass} />
      </Label>
      <Label text="Maximum zoom">
        <input value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} className={inputClass} />
      </Label>
      {isWarpTemplate(url) && (
        <Label text="Sampling">
          <select value={warpSampling(url)} onChange={(e) => setUrl(withWarpSampling(url, e.target.value as "auto"))} className={inputClass} aria-label="Sampling">
            {WARP_SAMPLINGS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Label>
      )}
      <p className="text-xs text-muted">
        {isWarpTemplate(url)
          ? "Tiles are reprojected by the platform (sign-in needed; upstream requests go through the tile proxy)."
          : "Tiles load in the browser straight from the server (it must allow cross-origin image requests)."}
      </p>
      <button type="submit" disabled={!valid} className={`${buttonClass.primary} w-full justify-center`}>
        Add to map
      </button>
    </form>
  );
}

/**
 * A vector tile source: an MVT URL template ({z}/{x}/{y}, also {-y} / {s}) or a TileJSON URL (read for its tiles, zoom
 * range, bounds and source layers). "Test" loads one tile in the browser and lists its layers.
 */
function VectorTileForm({ onAdd }: { onAdd: AddFn }) {
  const [name, setName] = useState("Vector tiles");
  const [url, setUrl] = useState("");
  const [minZoom, setMinZoom] = useState("0");
  const [maxZoom, setMaxZoom] = useState("14");
  const [bounds, setBounds] = useState<number[] | null>(null);
  const [layers, setLayers] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [idKey, setIdKey] = useState("");
  const [labelKey, setLabelKey] = useState("");
  const [labelsAlways, setLabelsAlways] = useState(false);
  const [proxy, setProxy] = useState(false);
  const [proxyHosts, setProxyHosts] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = validTemplate(url);
  // the tile proxy's allow-list, shown when the proxy is ticked
  useEffect(() => {
    if (proxy && proxyHosts === null)
      geoApi.tileProxySettings().then(
        (s) => setProxyHosts([...s.hosts, ...s.env_hosts]),
        () => setProxyHosts([]),
      );
  }, [proxy, proxyHosts]);
  const via = (u: string) => (proxy ? geoApi.tileProxyUrl(u) : u);
  const readTileJson = async () => {
    try {
      const r = await fetch(via(url));
      if (!r.ok) throw new Error(`${r.status} ${await r.json().then((b: { detail?: unknown }) => (typeof b.detail === "string" ? b.detail : r.statusText), () => r.statusText)}`);
      const j = (await r.json()) as { name?: string; tiles?: string[]; minzoom?: number; maxzoom?: number; bounds?: number[]; vector_layers?: { id: string }[] };
      const t = j.tiles?.find((x) => validTemplate(x));
      if (!t) throw new Error("the TileJSON has no http(s) tile URL with {z}, {x} and {y}");
      setUrl(t);
      if (j.name) setName(j.name);
      if (Number.isFinite(j.minzoom)) setMinZoom(String(j.minzoom));
      if (Number.isFinite(j.maxzoom)) setMaxZoom(String(j.maxzoom));
      if (Array.isArray(j.bounds) && j.bounds.length === 4) setBounds(j.bounds.map(Number));
      setLayers((j.vector_layers ?? []).map((l) => l.id).filter(Boolean));
      setMsg({ ok: true, text: `TileJSON read: ${(j.vector_layers ?? []).length} source layers, zoom ${j.minzoom ?? 0}–${j.maxzoom ?? "?"}` });
    } catch (e) {
      setMsg({ ok: false, text: `TileJSON could not be read: ${(e as Error).message}` });
    }
  };
  const test = async () => {
    // one tile around the centre of the bounds (or the world) at the minimum zoom
    const z = Math.max(0, Number(minZoom) || 0);
    const b = bounds ?? [-180, -85, 180, 85];
    const [t] = tilesFor([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2], z, 1);
    try {
      const tile = await loadTile(via(tileUrl(url, t.z, t.x, t.y)));
      const names = tile?.layers.map((l) => l.name) ?? [];
      setLayers((cur) => [...new Set([...cur, ...names])]);
      const n = tile ? tileFeatures(tile, t.z, t.x, t.y, chosen).length : 0;
      setMsg({ ok: true, text: `Tile ${t.z}/${t.x}/${t.y}: ${names.length ? `layers ${names.join(", ")}` : "empty"} · ${n} features` });
    } catch (e) {
      setMsg({ ok: false, text: proxy ? (e as Error).message : `${(e as Error).message}. The server must allow cross-origin requests from this site (or use the tile proxy).` });
    }
  };
  const config = { format: "vector", url, source_layers: chosen, min_zoom: Number(minZoom) || 0, max_zoom: Number(maxZoom) || 14, ...(bounds ? { bounds } : {}), ...(idKey ? { id_key: idKey } : {}),
    ...(labelKey ? { label_key: labelKey } : {}),
    ...(labelsAlways ? { label_mode: "always" } : {}),
    ...(proxy ? { proxy: true } : {}),
  };
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), valid && onAdd({ name, kind: "tiles", config }))}>
      <Label text="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Label>
      <Label text="MVT URL template or TileJSON URL">
        <div className="flex gap-1">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tiles.example.com/{z}/{x}/{y}.pbf" className={`${inputClass} flex-1`} aria-label="Vector tile URL" />
          {/^https?:\/\//.test(url) && !valid && (
            <button type="button" onClick={readTileJson} className={buttonClass.secondary}>
              Read TileJSON
            </button>
          )}
        </div>
      </Label>
      <div className="flex gap-2">
        <Label text="Min zoom">
          <input value={minZoom} onChange={(e) => setMinZoom(e.target.value)} className={inputClass} />
        </Label>
        <Label text="Max zoom (tiles)">
          <input value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} className={inputClass} />
        </Label>
      </div>
      <div>
        <span className="mb-1 block text-xs font-medium text-soft">Source layers (none ticked: all)</span>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {layers.map((n) => (
            <label key={n} className="flex items-center gap-1">
              <input type="checkbox" checked={chosen.includes(n)} onChange={(e) => setChosen(e.target.checked ? [...chosen, n] : chosen.filter((x) => x !== n))} className="accent-[var(--color-ocean)]" />
              {n}
            </label>
          ))}
          {!layers.length && <span className="text-muted">Read the TileJSON or test a tile to list them.</span>}
        </div>
      </div>
      <Label text="Id property (optional)">
        <input value={idKey} onChange={(e) => setIdKey(e.target.value)} placeholder="id (else the feature id)" className={inputClass} />
      </Label>
      <Label text="Label property (optional)">
        <input value={labelKey} onChange={(e) => setLabelKey(e.target.value)} placeholder="name" className={inputClass} />
      </Label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={labelsAlways} onChange={(e) => setLabelsAlways(e.target.checked)} className="accent-[var(--color-ocean)]" />
        Draw labels on the map (else on hover only)
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={proxy} onChange={(e) => setProxy(e.target.checked)} className="accent-[var(--color-ocean)]" aria-label="Load through the tile proxy" />
        Load through the platform&apos;s tile proxy (for servers without CORS headers)
      </label>
      {proxy && proxyHosts && (
        <p className="text-xs text-muted" data-proxy-hosts={proxyHosts.length}>
          {proxyHosts.length
            ? `Allowed tile servers: ${proxyHosts.join(", ")}.`
            : "No tile server is allowed yet: an administrator adds its host under Map admin → Tile proxy."}
        </p>
      )}
      <p className="text-xs text-muted">
        {proxy
          ? "The platform fetches the tiles (public addresses only, at most 5 MB each, no cookies or credentials forwarded) and caches them."
          : "Tiles load in the browser straight from the server (it must allow cross-origin requests)."}{" "}
        Gzip-compressed tiles are fine. Style by property in the layer&apos;s settings.
      </p>
      <div className="flex gap-2">
        <button type="button" disabled={!valid} onClick={test} className={buttonClass.secondary}>
          Test
        </button>
        <button type="submit" disabled={!valid} className={`${buttonClass.primary} flex-1 justify-center`}>
          Add to map
        </button>
      </div>
      {msg && <p className={`break-words text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </form>
  );
}

function FeatureServiceForm({ onAdd }: { onAdd: AddFn }) {
  const [name, setName] = useState("Feature service");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"arcgis" | "ogc" | "geojson">("arcgis");
  const [where, setWhere] = useState("1=1");
  const [titleField, setTitleField] = useState("");
  const [count, setCount] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const config = { url, kind, where, title_field: titleField || undefined, limit: 2000 };
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), url && onAdd({ name, kind: "features", config }))}>
      <Label text="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Label>
      <Label text="Service">
        <select value={kind} onChange={(e) => setKind(e.target.value as "arcgis" | "ogc" | "geojson")} className={inputClass}>
          <option value="arcgis">ArcGIS FeatureServer / MapServer layer</option>
          <option value="ogc">OGC API Features collection</option>
          <option value="geojson">GeoJSON URL</option>
        </select>
      </Label>
      <Label text="URL">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === "arcgis" ? "https://…/FeatureServer/0" : kind === "ogc" ? "https://…/collections/buildings" : "https://…/data.geojson"} className={inputClass} />
      </Label>
      {kind === "arcgis" && (
        <Label text="Where">
          <input value={where} onChange={(e) => setWhere(e.target.value)} className={inputClass} />
        </Label>
      )}
      <Label text="Title field (optional)">
        <input value={titleField} onChange={(e) => setTitleField(e.target.value)} placeholder="name" className={inputClass} />
      </Label>
      <p className="text-xs text-muted">Read through the platform (egress policies apply), up to 2,000 features.</p>
      <div className="flex gap-2">
        <button type="button" disabled={!url} onClick={() => geoApi.featureService(config).then((r) => (setCount(`${r.total} features${r.truncated ? " (more on the server)" : ""}`), setErr(null)), (e: Error) => setErr(e.message))} className={buttonClass.secondary}>
          Test
        </button>
        <button type="submit" disabled={!url} className={`${buttonClass.primary} flex-1 justify-center`}>
          Add to map
        </button>
      </div>
      {count && <p className="text-xs text-ok">{count}</p>}
      {err && <p className="text-xs text-bad">{err}</p>}
    </form>
  );
}
