/**
 * Client for the geospatial API (api/geospatial.py): data sources for maps, geo search over objects with geopoint /
 * geoshape / geotemporal series reference properties, tracks, saved maps and their layers, Enterprise Map Layers,
 * search templates, rasters and choropleths.
 */
import { API_URL } from "./api";
import type { Property } from "./ontology";
import type { Observation, SeriesSync } from "./timeseries";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/geo" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export type GeoJSONGeometry = { type: string; coordinates: unknown };

/** All: no filter; View: the map's extent; Draw: a drawn polygon or circle; Select: a shape picked on the map. */
export type AreaMode = "all" | "view" | "draw" | "select";
export type Area = { mode: AreaMode; bbox?: number[]; polygon?: GeoJSONGeometry; circle?: { lat: number; lon: number; radius_m: number } };
export type TimeFilter = { property?: string; mode: "static" | "rolling"; start?: string; end?: string; minutes?: number };
export type PropertyFilter = { property: string; op: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in"; value: unknown };

export type GeoObjectType = {
  id: string;
  display_name: string;
  plural_name: string;
  api_name: string;
  icon?: string;
  properties: Property[];
  /** geopoint / geoshape properties */
  geo: string[];
  gtsr: { property: string; sync_id: string } | null;
  media: string[];
  time: string[];
  object_count: number;
};
export type Eml = {
  id: string;
  name: string;
  description: string;
  kind: "function" | "object_set";
  object_type_id: string;
  function_id?: string | null;
  filters: PropertyFilter[];
  refresh_seconds?: number | null;
  geo_filter_property?: string | null;
  capabilities: string[];
  icon: string;
  classification: string;
  acl_groups: string[];
};
export type TemplateInput = { id: string; label?: string; hint?: string; inputType?: "TEXTFIELD" | "NUMBER" | "DATE" | "SELECT"; options?: string[]; required?: boolean };
export type SearchTemplate = { id: string; title?: string; description?: string; inputs?: TemplateInput[]; query?: unknown };
export type GeoSearch = {
  id: string;
  title: string;
  description: string;
  tab_id: string;
  tab_icon: string;
  template_id: string;
  classification: string;
  acl_groups: string[];
  template?: SearchTemplate | null;
};
export type Sources = { object_types: GeoObjectType[]; syncs: SeriesSync[]; emls: Eml[]; geo_searches: GeoSearch[] };

export type Feature = {
  object_type_id: string;
  primary_key: string;
  title: string;
  properties: Record<string, unknown>;
  geometry: GeoJSONGeometry;
  series?: { sync_id: string; series_id: string; position: { t: string; latitude: number; longitude: number; properties: Record<string, unknown> } | null };
};
export type FeatureSet = {
  object_type: { id: string; display_name: string; plural_name: string; icon?: string; title_property: string; properties: Property[] };
  property: string | null;
  total: number;
  truncated: boolean;
  features: Feature[];
};
export type ObjectSearch = {
  object_type_id: string;
  property?: string | null;
  area?: Area;
  time?: TimeFilter | null;
  q?: string;
  filters?: PropertyFilter[];
  primary_keys?: string[] | null;
  limit?: number;
};
export type TrackSearch = { sync_id: string; mode: "historic" | "live"; start?: string; end?: string; minutes?: number; area?: Area; series?: string[] };
export type Tracks = { sync: SeriesSync; total: number; truncated: boolean; observations: Observation[]; live_properties: string[] };

export type LayerKind = "objects" | "tracks" | "eml" | "template" | "raster" | "choropleth" | "dropped" | "tiles" | "features";
/** An external feature service layer (api/geospatial.py: ArcGIS FeatureServer, OGC API Features, GeoJSON). */
export type FeatureServiceConfig = { url: string; kind: "arcgis" | "ogc" | "geojson"; where?: string; title_field?: string; limit?: number };
export type Layer = { id: string; name: string; kind: LayerKind; visible: boolean; color: string; opacity: number; config: Record<string, unknown> };
export type SavedMap = {
  id: string;
  name: string;
  description: string;
  basemap: string;
  view: { lat: number; lon: number; zoom: number } | null;
  layers: Layer[];
  created_by?: string;
  created_at: string;
  updated_at: string;
  layer_count?: number;
};

export type RasterInfo = { name: string; bbox: number[]; mercator: number[]; width: number; height: number; crs: string; crs_assumed: boolean; corners: number[][] };
export type Choropleth = { features: { id: unknown; name: unknown; geometry: GeoJSONGeometry; value: number | null }[]; min: number | null; max: number | null; matched: number };

export const LAYER_KIND_LABEL: Record<LayerKind, string> = {
  objects: "Object search",
  tracks: "Tracks and observations",
  eml: "Enterprise Map Layer",
  template: "Search template",
  raster: "Raster",
  choropleth: "Boundaries (choropleth)",
  dropped: "Added objects",
  tiles: "Tile server",
  features: "Feature service",
};

export const geoApi = {
  /** the fishing demo (api/demo_nelayan.py): fishers' GPS catches and predicted fish aggregations, built when missing */
  ensureFishingDemo: () => fetch(`${API_URL}/api/demo/nelayan`, { method: "POST", cache: "no-store", credentials: "include" }).then((r) => r.ok),
  /** the JKN audit demo (api/demo_jkn_map.py): facilities coloured by audit status, built when missing */
  ensureJknAuditDemo: () => fetch(`${API_URL}/api/demo/jkn/map`, { method: "POST", cache: "no-store", credentials: "include" }).then((r) => r.ok),
  sources: (q = "") => req<Sources>(`/sources?q=${encodeURIComponent(q)}`),
  searchObjects: (body: ObjectSearch) => req<FeatureSet>("/objects/search", { method: "POST", json: body }),
  track: (typeId: string, pk: string, opts: { minutes?: number; start?: string; end?: string } = {}) => {
    const s = new URLSearchParams(Object.entries(opts).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return req<{ sync_id: string; series_id: string | null; live_properties: string[]; total: number; truncated: boolean; observations: Observation[] }>(
      `/objects/${typeId}/${encodeURIComponent(pk)}/track${s.size ? `?${s}` : ""}`,
    );
  },
  searchTracks: (body: TrackSearch) => req<Tracks>("/tracks/search", { method: "POST", json: body }),
  validate: (type: "geopoint" | "geoshape", value: unknown) => req<{ valid: boolean; value: string | null; problems: string[] }>("/validate", { method: "POST", json: { type, value } }),
  crs: () => req<{ code: string; name: string }[]>("/crs"),
  /** a WMS / WMTS service's layers: Web Mercator ones with a tile URL template, others (EPSG:4326, CRS84, …) with a
   * template of the platform's reprojected tiles (`warp`), the rest with a `reason` */
  capabilities: (url: string, kind: "wms" | "wmts") =>
    req<{ title: string | null; layers: ServiceLayer[] }>("/capabilities", { method: "POST", json: { url, kind } }).then((r) => ({
      ...r,
      layers: r.layers.map((l) => ({ ...l, template: l.template?.startsWith("/api/") ? API_URL + l.template : l.template })),
    })),
  featureService: (body: FeatureServiceConfig & { bbox?: number[] }) =>
    req<{ features: { id: string; title: string; properties: Record<string, unknown>; geometry: GeoJSONGeometry }[]; total: number; truncated: boolean }>("/feature-service", {
      method: "POST",
      json: body,
    }),

  maps: () => req<SavedMap[]>("/maps"),
  map: (id: string) => req<SavedMap>(`/maps/${id}`),
  createMap: (body: Partial<SavedMap>) => req<SavedMap>("/maps", { method: "POST", json: body }),
  saveMap: (id: string, body: Partial<SavedMap>) => req<SavedMap>(`/maps/${id}`, { method: "PUT", json: body }),
  deleteMap: (id: string) => req<unknown>(`/maps/${id}`, { method: "DELETE" }),
  duplicates: (id: string, objectTypeId: string, primaryKeys: string[]) =>
    req<{ duplicates: string[] }>(`/maps/${id}/duplicates`, { method: "POST", json: { object_type_id: objectTypeId, primary_keys: primaryKeys } }),

  emls: () => req<Eml[]>("/emls"),
  createEml: (body: Partial<Eml>) => req<Eml>("/emls", { method: "POST", json: body }),
  saveEml: (id: string, body: Partial<Eml>) => req<Eml>(`/emls/${id}`, { method: "PUT", json: body }),
  deleteEml: (id: string) => req<unknown>(`/emls/${id}`, { method: "DELETE" }),
  emlFeatures: (id: string, area?: Area) => req<FeatureSet & { refreshed_at: string }>(`/emls/${id}/features`, { method: "POST", json: { area: area ?? { mode: "all" } } }),

  templates: () => req<{ yaml: string; templates: SearchTemplate[]; geo_searches: GeoSearch[] }>("/search-templates"),
  saveTemplates: (yaml: string) => req<{ yaml: string; templates: SearchTemplate[]; geo_searches: GeoSearch[] }>("/search-templates", { method: "PUT", json: { yaml } }),
  createGeoSearch: (body: Partial<GeoSearch>) => req<GeoSearch>("/geo-searches", { method: "POST", json: body }),
  deleteGeoSearch: (id: string) => req<unknown>(`/geo-searches/${id}`, { method: "DELETE" }),
  runTemplate: (id: string, inputs: Record<string, unknown>, area?: Area) =>
    req<{ template: SearchTemplate; total: number; results: FeatureSet[] }>(`/search-templates/${encodeURIComponent(id)}/run`, { method: "POST", json: { inputs, area: area ?? { mode: "all" } } }),

  raster: (itemId: string) => req<RasterInfo>(`/raster/${encodeURIComponent(itemId)}`),
  rasterUrl: (itemId: string) => `${API_URL}/api/geo/raster/${encodeURIComponent(itemId)}/image`,
  rasterObjects: (objectTypeId: string, property?: string) =>
    req<{ property: string; items: { primary_key: string; title: string; item_id: string }[] }>("/raster/objects", { method: "POST", json: { object_type_id: objectTypeId, property } }),
  choropleth: (body: { boundaries_item_id: string; feature_key: string; object_type_id?: string; join_property?: string; agg?: string; value_property?: string }) =>
    req<Choropleth>("/choropleth", { method: "POST", json: body }),

  /** a tile / TileJSON / style URL fetched through the platform's tile proxy (for tile servers without CORS headers) */
  tileProxyUrl: (url: string) => `${API_URL}/api/geo/tile-proxy?url=${encodeURIComponent(url)}`,
  tileProxySettings: () => req<TileProxySettings>("/tile-proxy/settings"),
  saveTileProxyHosts: (hosts: string[]) => req<TileProxySettings>("/tile-proxy/settings", { method: "PUT", json: { hosts } }),
  tileProxyLog: () => req<TileProxyLogEntry[]>("/tile-proxy/log"),
};

/** A layer of a WMS / WMTS service (POST /api/geo/capabilities). `mercator`: drawn straight from the service;
 * `warp`: drawn by the platform, reprojected from `warp.crs` (its upstream `hosts` must be on the tile proxy's
 * allow-list: `allowed`); no template: `reason` says why it cannot be shown. */
export type ServiceLayer = {
  name: string;
  title: string;
  abstract: string;
  mercator: boolean;
  template: string | null;
  crs?: string | null;
  tile_matrix_set?: string | null;
  reason?: string | null;
  warp?: { crs: string; via: "wms" | "wmts"; hosts: string[]; allowed: boolean } | null;
};

/** A tile template of the platform's reprojected WMS / WMTS tiles (GET /api/geo/warp/…). */
export const isWarpTemplate = (url: string) => url.startsWith(`${API_URL}/api/geo/warp/`);

/** How reprojected tiles sample their source: "auto" (bilinear for imagery, nearest for classes — paletted or
 * few-colour sources), "bilinear" (imagery) or "nearest" (categorical layers keep their exact colours). */
export type WarpSampling = "auto" | "bilinear" | "nearest";
export const WARP_SAMPLINGS: { value: WarpSampling; label: string }[] = [
  { value: "auto", label: "Auto (bilinear for imagery, nearest for classes)" },
  { value: "bilinear", label: "Bilinear (imagery)" },
  { value: "nearest", label: "Nearest neighbour (categorical)" },
];

/** The sampling of a reprojected tile template (its ?sampling=, else auto). */
export function warpSampling(url: string): WarpSampling {
  const m = /[?&]sampling=(auto|bilinear|nearest)(?:&|$)/.exec(url);
  return (m?.[1] as WarpSampling) ?? "auto";
}

/** A reprojected tile template with its sampling set (auto: no parameter); other templates unchanged. */
export function withWarpSampling(url: string, sampling: WarpSampling): string {
  if (!isWarpTemplate(url)) return url;
  const base = url.replace(/([?&])sampling=[^&]*(&|$)/, (_, pre: string, post: string) => (post ? pre : "")).replace(/[?&]$/, "");
  return sampling === "auto" ? base : `${base}${base.includes("?") ? "&" : "?"}sampling=${sampling}`;
}

/** The tile proxy's allow-list (stored by an administrator, and from the BSAI_TILE_PROXY_HOSTS variable) and limits. */
export type TileProxySettings = { hosts: string[]; env_hosts: string[]; env_var: string; max_bytes: number; max_redirects: number; timeout_s: number; content_types: string[] };
export type TileProxyLogEntry = { at: string; user: string; url: string; status: number; bytes: number; cache: string; ms: number; reason?: string; hops?: string[] };

/** "lat,lon" of a geopoint value (also a geohash: its bottom-left corner), or null. */
export function parseGeopoint(v: unknown): [number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Every [lon, lat] position of a GeoJSON geometry. */
export function positions(g: GeoJSONGeometry | null | undefined): number[][] {
  const out: number[][] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === "number") out.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  if (g) walk(g.coordinates);
  return out;
}

/** A link that opens the Map with one object (Ontology Manager → "Show on map"). */
export const mapHrefForObject = (objectTypeId: string, pk: string) => `/map/new?object_type=${encodeURIComponent(objectTypeId)}&pk=${encodeURIComponent(pk)}`;
