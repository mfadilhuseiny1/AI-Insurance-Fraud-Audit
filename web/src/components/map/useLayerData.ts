"use client";

import { useEffect, useRef, useState } from "react";
import { geoApi, type Area, type Choropleth, type Feature, type FeatureSet, type Layer, type RasterInfo } from "@/lib/geo";
import type { Observation } from "@/lib/timeseries";

export type LayerData = {
  loading: boolean;
  error?: string;
  features?: Feature[];
  /** the object type of an object search (property names and types for the selection panel) */
  objectType?: FeatureSet["object_type"];
  total?: number;
  truncated?: boolean;
  observations?: Observation[];
  liveProperties?: string[];
  rasters?: (RasterInfo & { key: string; url: string; title?: string })[];
  regions?: Choropleth;
  refreshedAt?: number;
};

/** How often a layer reloads by itself (ms); null = only when its configuration changes. */
export function refreshInterval(l: Layer, emlSeconds?: number | null): number | null {
  const c = l.config;
  if (l.kind === "objects" && c.live) return 30_000; // Gaia: live update search results every 30 seconds
  if (l.kind === "tracks" && c.mode === "live") return 10_000;
  if (l.kind === "eml" && emlSeconds) return Math.max(5, emlSeconds) * 1000;
  if (l.kind === "template" && c.live) return 30_000;
  return null;
}

async function load(l: Layer): Promise<LayerData> {
  const c = l.config as Record<string, unknown>;
  const area = (c.area as Area | undefined) ?? { mode: "all" };
  switch (l.kind) {
    case "objects":
    case "dropped": {
      const r = await geoApi.searchObjects({
        object_type_id: String(c.object_type_id),
        property: (c.property as string) || null,
        area: l.kind === "dropped" ? { mode: "all" } : area,
        time: (c.time as never) ?? null,
        q: (c.q as string) ?? "",
        filters: (c.filters as never) ?? [],
        primary_keys: l.kind === "dropped" ? ((c.primary_keys as string[]) ?? []) : null,
      });
      return { loading: false, features: r.features, total: r.total, truncated: r.truncated, objectType: r.object_type };
    }
    case "tracks": {
      const r = await geoApi.searchTracks({
        sync_id: String(c.sync_id),
        mode: c.mode === "live" ? "live" : "historic",
        start: (c.start as string) || undefined,
        end: (c.end as string) || undefined,
        minutes: Number(c.minutes) || 60,
        area,
      });
      return { loading: false, observations: r.observations, total: r.total, truncated: r.truncated, liveProperties: r.live_properties };
    }
    case "eml": {
      const r = await geoApi.emlFeatures(String(c.eml_id), area);
      return { loading: false, features: r.features, total: r.total, truncated: r.truncated };
    }
    case "template": {
      const r = await geoApi.runTemplate(String(c.template_id), (c.inputs as Record<string, unknown>) ?? {}, area);
      return { loading: false, features: r.results.flatMap((x) => x.features), total: r.total, truncated: r.results.some((x) => x.truncated) };
    }
    case "raster": {
      const items: { key: string; id: string; title?: string }[] = c.item_id
        ? [{ key: String(c.item_id), id: String(c.item_id) }]
        : (await geoApi.rasterObjects(String(c.object_type_id), (c.property as string) || undefined)).items.slice(0, 25).map((x) => ({ key: x.primary_key, id: x.item_id, title: x.title }));
      const out: LayerData["rasters"] = [];
      const errors: string[] = [];
      for (const it of items) {
        try {
          out.push({ ...(await geoApi.raster(it.id)), key: it.key, url: geoApi.rasterUrl(it.id), title: it.title });
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      return { loading: false, rasters: out, error: errors.length && !out.length ? errors[0] : errors.length ? `${errors.length} raster(s) could not be drawn: ${errors[0]}` : undefined };
    }
    case "tiles":
      // drawn straight from the tile server (MapCanvas overlays)
      return { loading: false };
    case "features": {
      const r = await geoApi.featureService({
        url: String(c.url),
        kind: (c.kind as "arcgis" | "ogc" | "geojson") || "geojson",
        where: (c.where as string) || undefined,
        title_field: (c.title_field as string) || undefined,
        limit: Number(c.limit) || 2000,
      });
      return {
        loading: false,
        features: r.features.map((f) => ({ object_type_id: `ext:${l.id}`, primary_key: f.id, title: f.title, properties: f.properties, geometry: f.geometry })),
        total: r.total,
        truncated: r.truncated,
      };
    }
    case "choropleth": {
      const regions = await geoApi.choropleth({
        boundaries_item_id: String(c.boundaries_item_id),
        feature_key: String(c.feature_key ?? "id"),
        object_type_id: (c.object_type_id as string) || undefined,
        join_property: (c.join_property as string) || undefined,
        agg: (c.agg as string) || "count",
        value_property: (c.value_property as string) || undefined,
      });
      return { loading: false, regions };
    }
  }
}

/** The data of every visible layer, reloaded when its configuration changes and on its refresh interval. */
export function useLayerData(layers: Layer[], emlRefresh: Record<string, number | null | undefined>): Record<string, LayerData> {
  const [data, setData] = useState<Record<string, LayerData>>({});
  const keys = useRef<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  useEffect(() => {
    const live = new Set<string>();
    for (const l of layers) {
      if (!l.visible) continue;
      live.add(l.id);
      const key = JSON.stringify([l.kind, l.config]);
      if (keys.current[l.id] === key) continue;
      keys.current[l.id] = key;
      clearInterval(timers.current[l.id]);
      const run = () =>
        load(l).then(
          (d) => keys.current[l.id] === key && setData((cur) => ({ ...cur, [l.id]: { ...d, refreshedAt: Date.now() } })),
          (e: Error) => keys.current[l.id] === key && setData((cur) => ({ ...cur, [l.id]: { ...(cur[l.id] ?? {}), loading: false, error: e.message } })),
        );
      setData((cur) => ({ ...cur, [l.id]: { ...(cur[l.id] ?? {}), loading: true, error: undefined } }));
      run();
      const every = refreshInterval(l, l.kind === "eml" ? emlRefresh[String(l.config.eml_id)] : null);
      if (every) timers.current[l.id] = setInterval(run, every);
    }
    // layers removed or hidden: stop and forget them
    for (const id of Object.keys(keys.current))
      if (!live.has(id)) {
        clearInterval(timers.current[id]);
        delete timers.current[id];
        delete keys.current[id];
      }
  }, [layers, emlRefresh]);
  useEffect(() => () => Object.values(timers.current).forEach(clearInterval), []);
  return data;
}
