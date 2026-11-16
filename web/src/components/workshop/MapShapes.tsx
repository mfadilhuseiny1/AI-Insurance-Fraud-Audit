"use client";

/**
 * Workshop Map widget beyond points: geoshape geometry (GeoJSON polygons, lines, multi-geometries, geometry
 * collections) drawn in the MapCanvas SVG, overlay layers from saved maps (the Map app's layers: tile / WMS / WMTS
 * servers, vector tiles, feature services and GeoJSON, object searches, Enterprise Map Layers, boundaries, rasters) or
 * given in the widget (tile / vector tile / GeoJSON URLs, GeoJSON files in Files), and map templates (a saved map's
 * layers, base map and view with its object layers bound to module variables). The Map app's own pieces are reused
 * by import (useLayerData, VectorTileLayer, buildColorScale); nothing in components/map is changed.
 */

import { memo, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import type { Projection } from "@/components/map/MapCanvas";
import { useLayerData, type LayerData } from "@/components/map/useLayerData";
import { VectorTileLayer } from "@/components/map/VectorTileLayer";
import type { ColorLegend, VectorColorBy } from "@/components/map/vectorTileStyle";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { driveContentUrl } from "@/lib/api";
import { geoApi, LAYER_KIND_LABEL, type Layer as GeoLayer, type SavedMap } from "@/lib/geo";
import type { MapOverlay, MapTemplate, Module } from "@/lib/workshop";
import { copyOf, drawShape, frameOf, mercX, mercY, parseShape, prepare, turnsTo, type Bin, type Frame, type Prepared } from "./mapGeometry";

// ------------------------------------------------------------------------------------------------
// geometry
// ------------------------------------------------------------------------------------------------

// The geometry itself (parsing, Web Mercator, antimeridian, paths, hit tests, color bins) is in mapGeometry.ts (pure).

/** How far (pixels) the map pans before the shapes are drawn again; in between they only move with the map. */
const REACH = 1536;

/**
 * The frame shapes are drawn in: kept while the map pans (the group is translated, the paths stay as they are) and
 * replaced on a zoom, a resize or a pan beyond REACH. Everything under it draws in the frame's coordinates.
 */
export function ShapeFrame({ p, children }: { p: Projection; children: (f: Frame) => ReactNode }) {
  const now = frameOf(p);
  const [kept, setKept] = useState(now);
  const stale = kept.s !== now.s || kept.w !== now.w || kept.h !== now.h || Math.abs(now.ox - kept.ox) > REACH || Math.abs(now.oy - kept.oy) > REACH;
  if (stale) setKept(now);
  const f = stale ? now : kept;
  return (
    <g transform={`translate(${now.ox - f.ox},${now.oy - f.oy})`} data-map-frame>
      {children(f)}
    </g>
  );
}

/** One shape drawn in a frame: filled areas (holes open) with an outline, lines (with a wide transparent band to
 * hit), points as circles. Nothing when it is far outside the frame. */
export const ShapePath = memo(function ShapePath({
  shape,
  f,
  color,
  outline,
  fillOpacity = 0.3,
  width = 2,
  radius = 5,
  opacity = 1,
  selected,
}: {
  shape: Prepared;
  f: Frame;
  color: string;
  /** the outline's color (default: the fill color) */
  outline?: string;
  fillOpacity?: number;
  width?: number;
  radius?: number;
  opacity?: number;
  selected?: boolean;
}) {
  const drawn = useMemo(() => drawShape(shape, f, { margin: REACH + 64 }), [shape, f]);
  if (!drawn) return null;
  const { area, line, points } = drawn;
  return (
    <g opacity={opacity}>
      {area && (
        <path
          d={area}
          fillRule="evenodd"
          fill={color}
          fillOpacity={selected ? Math.min(0.8, fillOpacity + 0.25) : fillOpacity}
          stroke={selected ? "#ffffff" : outline || color}
          strokeWidth={selected ? width + 1.5 : width}
          strokeLinejoin="round"
        />
      )}
      {line && (
        <>
          <path d={line} fill="none" stroke="transparent" strokeWidth={Math.max(12, width + 8)} strokeLinecap="round" />
          {selected && <path d={line} fill="none" stroke="#ffffff" strokeWidth={width + 4} strokeLinecap="round" strokeLinejoin="round" />}
          <path d={line} fill="none" stroke={color} strokeWidth={width + (selected ? 1 : 0)} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={radius + (selected ? 2 : 0)} fill={color} stroke={selected ? "#fff" : "#0b1220"} strokeWidth={2} />
      ))}
    </g>
  );
});

/** One object of an object layer: its shape (prepared geometry) and / or its point, color, label and hover text. */
export type MapItem = { pk?: string; lat: number; lon: number; shape: Prepared | null; dot: boolean; label: string; color: string; hover: string; /** the timeline's time (epoch ms) */ t?: number | null };
export type LayerStyle = { fillOpacity?: number; width?: number; radius?: number; dotRadius?: number; outline?: string; locked?: boolean };

const LABEL_STYLE = { paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 } as const;

/**
 * An object layer in a frame: its shapes, then its points. Drawn again only when the frame, the objects, the style or
 * the selection change (not while the map pans). Shapes are picked by the map's own hit test (onClick on the layers'
 * group); points select on press, as before shapes existed.
 */
export const ObjectLayer = memo(function ObjectLayer({
  index,
  items,
  f,
  style,
  selected,
  onHover,
  onDot,
}: {
  index: number;
  items: MapItem[];
  f: Frame;
  style: LayerStyle;
  selected: Set<string>;
  onHover: (e: { clientX: number; clientY: number } | null, text: string) => void;
  onDot: (layer: number, pk: string | undefined, additive: boolean) => void;
}) {
  const z = Math.log2(f.s / 256);
  const mid = (f.w / 2 - f.ox) / f.s;
  const itemAt = (e: { target: EventTarget }) => {
    const el = (e.target as Element).closest?.("[data-i]");
    return el ? items[Number(el.getAttribute("data-i"))] : undefined;
  };
  return (
    <g
      data-map-layer={index}
      onPointerMove={(e) => {
        const q = itemAt(e);
        onHover(q ? e : null, q?.hover ?? "");
      }}
      onPointerLeave={() => onHover(null, "")}
    >
      {items.map((q, i) => {
        if (!q.shape) return null;
        const on = !!q.pk && selected.has(q.pk);
        const at = q.label && z >= 9 ? q.shape.box : null;
        return (
          <g key={`s${i}`} data-i={i} className={style.locked ? "" : "cursor-pointer"} data-map-shape={q.pk} data-selected={on ? "true" : undefined}>
            <ShapePath shape={q.shape} f={f} color={q.color} outline={style.outline} fillOpacity={style.fillOpacity ?? 0.3} width={style.width ?? 2} radius={style.radius ?? 5} selected={on} />
            {at && (
              <text
                x={((at[0] + at[2]) / 2 + copyOf(q.shape, f)) * f.s + f.ox}
                y={((at[1] + at[3]) / 2) * f.s + f.oy}
                textAnchor="middle"
                className="pointer-events-none fill-white text-[11px]"
                style={LABEL_STYLE}
              >
                {q.label}
              </text>
            )}
          </g>
        );
      })}
      {items.map((q, i) => {
        if (!q.dot) return null;
        const on = !!q.pk && selected.has(q.pk);
        const x = mercX(q.lon);
        return (
          <g
            key={i}
            data-i={i}
            transform={`translate(${(x + turnsTo(x, mid)) * f.s + f.ox},${mercY(q.lat) * f.s + f.oy})`}
            className={style.locked ? "" : "cursor-pointer"}
            onPointerDown={(e) => (e.stopPropagation(), onDot(index, q.pk, e.shiftKey || e.metaKey || e.ctrlKey))}
            data-map-point={q.pk}
            data-selected={on ? "true" : undefined}
          >
            <circle r={(style.dotRadius ?? 6) + (on ? 2 : 0)} fill={q.color} stroke={on ? "#fff" : "#0b1220"} strokeWidth={2} />
            {q.label && z >= 6 && (
              <text x={10} y={4} className="pointer-events-none fill-white text-[11px]" style={LABEL_STYLE}>
                {q.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

// ------------------------------------------------------------------------------------------------
// overlay layers and templates: saved maps' layers through the Map app's loader
// ------------------------------------------------------------------------------------------------

const mapCache = new Map<string, Promise<SavedMap>>();
/** A saved map, fetched once per page (a failed fetch is retried next time). */
export function savedMap(id: string): Promise<SavedMap> {
  let m = mapCache.get(id);
  if (!m) {
    m = geoApi.map(id);
    mapCache.set(id, m);
    m.catch(() => mapCache.delete(id));
  }
  return m;
}

/** The saved maps with these ids (and why one could not be read). */
export function useSavedMaps(ids: string[]): { maps: Record<string, SavedMap>; errors: Record<string, string> } {
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  const [out, setOut] = useState<{ key: string; maps: Record<string, SavedMap>; errors: Record<string, string> }>({ key: "", maps: {}, errors: {} });
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(
      key.split(",").map((id) =>
        savedMap(id).then(
          (m) => [id, m, null] as const,
          (e: Error) => [id, null, e.message] as const,
        ),
      ),
    ).then((all) => {
      if (!live) return;
      setOut({
        key,
        maps: Object.fromEntries(all.filter(([, m]) => m).map(([id, m]) => [id, m!])),
        errors: Object.fromEntries(all.filter(([, , e]) => e).map(([id, , e]) => [id, e!])),
      });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return key && out.key === key ? out : { maps: {}, errors: {} };
}

const toList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

/** An overlay ready to draw: the Map app layer it stands for (or a GeoJSON file in Files) and its legend name. */
export type OverlayEntry = { key: string; label: string; layer: GeoLayer; item?: string; error?: string; /** drawn over the object layers */ above?: boolean };

/**
 * The overlay entries of a widget: each overlay's saved map layer(s) or its own layer; a template's layers, objects
 * layers restricted to the objects of their input variable. Hidden overlays (visibility variable false) are left out.
 */
export function useOverlays(overlays: MapOverlay[] | undefined, template: MapTemplate | null | undefined, variables: Record<string, unknown>) {
  const ids = [...(overlays ?? []).map((o) => o.map_id ?? ""), template?.map_id ?? ""];
  const { maps, errors } = useSavedMaps(ids);
  const entries = useMemo(() => {
    const out: OverlayEntry[] = [];
    if (template?.map_id) {
      const m = maps[template.map_id];
      if (errors[template.map_id]) out.push({ key: "tpl", label: "Map template", layer: blank("tpl"), error: errors[template.map_id] });
      for (const l of m?.layers ?? []) {
        const v = template.inputs?.[l.id];
        const pks = v ? toList(variables[v]) : [];
        // an input bound to a variable: the layer shows the objects of the variable (all of them while it is empty)
        const layer: GeoLayer = pks.length && (l.kind === "objects" || l.kind === "dropped") ? { ...l, kind: "dropped", config: { ...l.config, primary_keys: pks } } : l;
        out.push({ key: `tpl/${l.id}`, label: l.name, layer: { ...layer, visible: l.visible } });
      }
    }
    (overlays ?? []).forEach((o, i) => {
      if (o.visible_variable && variables[o.visible_variable] === false) return;
      const base = { color: o.color || "#f97316", opacity: o.opacity ?? 0.85, visible: true };
      if (o.map_id) {
        const m = maps[o.map_id];
        if (errors[o.map_id]) return out.push({ key: `ov${i}`, label: o.label, layer: blank(`ov${i}`), error: errors[o.map_id] });
        for (const l of (m?.layers ?? []).filter((l) => !o.layer_id || l.id === o.layer_id))
          out.push({ key: `ov${i}/${l.id}`, label: o.layer_id ? o.label || l.name : `${o.label} · ${l.name}`, layer: { ...l, id: `ov${i}-${l.id}`, visible: true, opacity: o.opacity ?? l.opacity } });
        return;
      }
      const id = `ov${i}`;
      if (o.tiles) out.push({ key: id, label: o.label, layer: { id, name: o.label, kind: "tiles", ...base, config: { url: o.tiles, max_zoom: 19 } } });
      else if (o.vector_tiles)
        out.push({ key: id, label: o.label, layer: { id, name: o.label, kind: "tiles", ...base, config: { url: o.vector_tiles, format: "vector", source_layers: o.source_layers ?? "" } } });
      else if (o.geojson_url) out.push({ key: id, label: o.label, layer: { id, name: o.label, kind: "features", ...base, config: { url: o.geojson_url, kind: "geojson" } } });
      else if (o.geojson_item) out.push({ key: id, label: o.label, layer: { id, name: o.label, kind: "features", ...base, config: {} }, item: o.geojson_item });
    });
    // an overlay set "above the objects" (keys ov<i>…): its entries are drawn over the object layers
    return out.map((e) => {
      const m = /^ov(\d+)/.exec(e.key);
      return m && overlays?.[Number(m[1])]?.above ? { ...e, above: true } : e;
    });
  }, [overlays, template, maps, errors, variables]);
  return { entries, template: template?.map_id ? maps[template.map_id] : undefined };
}
const blank = (id: string): GeoLayer => ({ id, name: "", kind: "features", visible: false, color: "#888", opacity: 0, config: {} });

const NO_EML: Record<string, number | null> = {};
const isVector = (l: GeoLayer) => l.kind === "tiles" && l.config.format === "vector";

/** GeoJSON files in Files (read in the browser; the Map app's feature service loader only fetches URLs). */
function useGeojsonItems(entries: OverlayEntry[]): Record<string, LayerData> {
  const items = [...new Set(entries.map((e) => e.item).filter((x): x is string => !!x))].sort().join(",");
  const [data, setData] = useState<Record<string, LayerData>>({});
  useEffect(() => {
    if (!items) return;
    let live = true;
    for (const id of items.split(",")) {
      fetch(driveContentUrl(id, true), { credentials: "include", cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(`the file could not be read (${r.status})`);
          const doc = await r.json();
          const feats: { geometry?: unknown; properties?: Record<string, unknown>; id?: unknown }[] =
            doc?.type === "FeatureCollection" ? doc.features ?? [] : doc?.type === "Feature" ? [doc] : [{ geometry: doc, properties: {} }];
          const features = feats.flatMap((f, k) => {
            const g = parseShape(f.geometry);
            if (!g) return [];
            const pr = f.properties ?? {};
            const title = String(pr.name ?? pr.NAME ?? pr.title ?? f.id ?? k + 1);
            return [{ object_type_id: `file:${id}`, primary_key: String(f.id ?? k), title, properties: pr, geometry: g as { type: string; coordinates: unknown } }];
          });
          if (live) setData((d) => ({ ...d, [id]: { loading: false, features, total: features.length } }));
        })
        .catch((e: Error) => live && setData((d) => ({ ...d, [id]: { loading: false, error: e.message } })));
    }
    return () => {
      live = false;
    };
  }, [items]);
  return data;
}

/** The data of every overlay entry (the Map app's loader; GeoJSON files read here). */
export function useOverlayData(entries: OverlayEntry[]): Record<string, LayerData> {
  const layers = useMemo(() => entries.filter((e) => !e.item && !e.error && e.layer.visible).map((e) => e.layer), [entries]);
  const loaded = useLayerData(layers, NO_EML);
  const files = useGeojsonItems(entries);
  return useMemo(() => {
    const out: Record<string, LayerData> = {};
    for (const e of entries) {
      const d = e.item ? files[e.item] : loaded[e.layer.id];
      if (d) out[e.key] = d;
    }
    return out;
  }, [entries, loaded, files]);
}

/** A feature picked on an overlay: an object (selectable in the module) or an external / file feature. */
export type OverlayPick = { layer: string; object_type_id?: string; primary_key: string; title: string; properties: Record<string, unknown> };

/** Raster overlays (tile / WMS servers, GeoTIFF rasters): HTML images under the SVG, as the Map app draws them. */
export function OverlayImages({ entries, data, p }: { entries: OverlayEntry[]; data: Record<string, LayerData>; p: Projection }) {
  return (
    <>
      {entries.map((e) => {
        const l = e.layer;
        if (!l.visible || e.error) return null;
        if (l.kind === "tiles" && !isVector(l)) return <TileImages key={e.key} p={p} template={String(l.config.url ?? "")} opacity={l.opacity} maxZoom={Number(l.config.max_zoom) || 19} />;
        if (l.kind === "raster")
          return (data[e.key]?.rasters ?? []).map((r) => {
            const lon = (x: number) => (x / 6378137) * (180 / Math.PI);
            const lat = (y: number) => (Math.atan(Math.sinh(y / 6378137)) * 180) / Math.PI;
            const [x0, y0, x1, y1] = r.mercator;
            const left = p.px(lon(x0));
            const top = p.py(lat(y1));
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={`${e.key}/${r.key}`} src={r.url} alt="" draggable={false} className="pointer-events-none absolute" style={{ left, top, width: p.px(lon(x1)) - left, height: p.py(lat(y0)) - top, opacity: l.opacity }} />
            );
          });
        return null;
      })}
    </>
  );
}

/** An XYZ ({z}/{x}/{y}, {s}) or WMS ({bbox-epsg-3857}) tile server's tiles in view. */
function TileImages({ p, template, opacity, maxZoom }: { p: Projection; template: string; opacity: number; maxZoom: number }) {
  const bboxed = template.includes("{bbox-epsg-3857}");
  if (!bboxed && !(template.includes("{z}") && template.includes("{x}") && template.includes("{y}"))) return null;
  const z = Math.max(0, Math.min(maxZoom, Math.round(p.z)));
  const n = 2 ** z;
  const [lon0, lat0] = p.unproject(0, 0);
  const [lon1, lat1] = p.unproject(p.w, p.h);
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  };
  const lonOf = (x: number) => (x / n) * 360 - 180;
  const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const [xa, xb] = [tx(lon0), tx(lon1)];
  const [ya, yb] = [Math.max(0, ty(lat0)), Math.min(n - 1, ty(lat1))];
  if ((xb - xa + 1) * (yb - ya + 1) > 400) return null;
  const R = 20037508.342789244;
  const tiles: ReactElement[] = [];
  for (let x = xa; x <= xb; x++)
    for (let y = ya; y <= yb; y++) {
      const wx = ((x % n) + n) % n;
      const step = (2 * R) / n;
      const bbox = `${-R + wx * step},${R - (y + 1) * step},${-R + (wx + 1) * step},${R - y * step}`;
      const url = template.replace("{bbox-epsg-3857}", bbox).replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y)).replace("{s}", "abc"[(wx + y) % 3]);
      const left = p.px(lonOf(x));
      const top = p.py(latOf(y));
      tiles.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${z}/${x}/${y}`} src={url} alt="" draggable={false} className="pointer-events-none absolute" style={{ left, top, width: p.px(lonOf(x + 1)) - left, height: p.py(latOf(y + 1)) - top, opacity }} data-overlay-tile />,
      );
    }
  return <>{tiles}</>;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const colorByOf = (c: Record<string, unknown>): VectorColorBy | null =>
  c.color_by
    ? {
        property: String(c.color_by),
        mode: c.color_mode === "category" || c.color_mode === "range" ? c.color_mode : undefined,
        colors: [String(c.color_from || "#dbeafe"), String(c.color_to || "#1d4ed8")],
        defaultColor: (c.default_color as string) || undefined,
      }
    : null;

type PickFn = (f: OverlayPick, e: { clientX: number; clientY: number; shiftKey?: boolean } | null) => void;

/** Vector tile overlays in the SVG (screen coordinates: they follow the projection themselves). `above` picks the
 * overlays drawn over (true) or under (false) the object layers. */
export function OverlayTiles({ entries, p, picked, onPick, above }: { entries: OverlayEntry[]; p: Projection; picked: OverlayPick | null; onPick: PickFn; above: boolean }) {
  return (
    <>
      {entries.map((e) => {
        const l = e.layer;
        if (!l.visible || e.error || !isVector(l) || !!e.above !== above) return null;
        {
          const c = l.config;
          const labelKey = (c.label_key as string) || undefined;
          return (
            <g key={e.key} data-overlay={e.key}>
              <VectorTileLayer
                p={p}
                url={String(c.url ?? "")}
                sourceLayers={strList(c.source_layers)}
                minZoom={Number(c.min_zoom) || 0}
                maxZoom={Number(c.max_zoom) || 14}
                idKey={(c.id_key as string) || "id"}
                labelKey={labelKey}
                labels={c.label_mode === "always" ? "always" : "hover"}
                proxy={!!c.proxy}
                color={l.color}
                style={{ opacity: l.opacity, width: Number(c.line_width) || undefined, radius: Number(c.radius) || undefined, fillOpacity: c.fill_opacity === undefined ? undefined : Number(c.fill_opacity) }}
                colorBy={colorByOf(c)}
                selectedIds={picked?.layer === e.key ? [picked.primary_key] : []}
                onFeature={(f) => {
                  const pr = f.properties;
                  onPick({ layer: e.key, primary_key: f.id, title: String(pr[labelKey ?? ""] ?? pr.name ?? pr.NAME ?? pr.title ?? f.id), properties: { ...pr, "source layer": f.layer } }, null);
                }}
              />
            </g>
          );
        }
      })}
    </>
  );
}

/**
 * Feature overlays in a frame: objects, EMLs, templates, feature services, GeoJSON, boundaries (colored by value).
 * `above` picks the overlays drawn over (true) or under (false) the object layers; they are drawn in the configured
 * order. Drawn again only when the frame, the data or the pick change (not while the map pans).
 */
export const OverlayShapes = memo(function OverlayShapes({
  entries,
  data,
  f,
  picked,
  onPick,
  onHover,
  above,
}: {
  entries: OverlayEntry[];
  data: Record<string, LayerData>;
  f: Frame;
  picked: OverlayPick | null;
  onPick: PickFn;
  onHover: (e: { clientX: number; clientY: number } | null, text: string) => void;
  above: boolean;
}) {
  return (
    <>
      {entries.map((e) => {
        const l = e.layer;
        if (!l.visible || e.error || isVector(l) || !!e.above !== above) return null;
        const d = data[e.key];
        if (!d) return null;
        if (d.regions) {
          const { min, max } = d.regions;
          return (
            <g key={e.key} data-overlay={e.key}>
              {d.regions.features.map((r, i) => {
                const g = parseShape(r.geometry);
                if (!g) return null;
                const t = r.value === null || min === null || max === null ? null : max === min ? 1 : (r.value - min) / (max - min);
                const sel = picked?.layer === e.key && picked.primary_key === String(r.id);
                return (
                  <g
                    key={i}
                    className="cursor-pointer"
                    onClick={(ev) => onPick({ layer: e.key, primary_key: String(r.id), title: String(r.name ?? r.id), properties: { value: r.value } }, ev)}
                    onPointerMove={(ev) => onHover(ev, `${String(r.name ?? r.id)}\nvalue: ${r.value ?? "—"}`)}
                    onPointerLeave={() => onHover(null, "")}
                  >
                    <ShapePath shape={prepare(g)} f={f} color={l.color} fillOpacity={t === null ? 0 : 0.1 + 0.7 * t} width={1} opacity={l.opacity} selected={sel} />
                  </g>
                );
              })}
            </g>
          );
        }
        const feats = d.features ?? [];
        return (
          <g key={e.key} data-overlay={e.key}>
            {feats.map((ft) => {
              const g = parseShape(ft.geometry);
              if (!g) return null;
              const sel = picked?.layer === e.key && picked.primary_key === ft.primary_key;
              const obj = !ft.object_type_id.startsWith("ext:") && !ft.object_type_id.startsWith("file:");
              return (
                <g
                  key={`${ft.object_type_id}/${ft.primary_key}`}
                  className="cursor-pointer"
                  data-overlay-feature={ft.primary_key}
                  onClick={(ev) => onPick({ layer: e.key, object_type_id: obj ? ft.object_type_id : undefined, primary_key: ft.primary_key, title: ft.title, properties: ft.properties }, ev)}
                  onPointerMove={(ev) => onHover(ev, `${e.label}\n${ft.title}`)}
                  onPointerLeave={() => onHover(null, "")}
                >
                  <ShapePath shape={prepare(g)} f={f} color={l.color} fillOpacity={0.22} width={2} opacity={l.opacity} selected={sel} />
                </g>
              );
            })}
          </g>
        );
      })}
    </>
  );
});

// ------------------------------------------------------------------------------------------------
// legend
// ------------------------------------------------------------------------------------------------

export type LegendRow = {
  label: string;
  color: string;
  count?: number;
  hidden?: boolean;
  legend?: ColorLegend | null;
  /** color classes (a stepped scale): one line per class with its range and number of objects */
  bins?: Bin[];
  /** what the colors stand for (the property colored by) */
  by?: string;
  note?: string;
  kind?: "point" | "shape" | "line" | "tiles";
};

const fmtNum = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100));

export function MapLegend({ rows, collapsed: initial, error }: { rows: LegendRow[]; collapsed?: boolean; error?: string | null }) {
  const [collapsed, setCollapsed] = useState(!!initial);
  if (!rows.length && !error) return null;
  return (
    <div className="absolute bottom-6 left-3 z-10 max-h-[60%] max-w-[16rem] overflow-y-auto rounded-md border border-line bg-panel/95 p-2 text-[11px] shadow" data-map-legend>
      <button type="button" onClick={() => setCollapsed(!collapsed)} className="flex w-full items-center justify-between gap-2 font-medium text-soft">
        Legend <span className="text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {error && <div className="mt-1 text-bad">{error}</div>}
      {!collapsed &&
        rows.map((r, i) => (
          <div key={i} className={`mt-1 ${r.hidden ? "opacity-40" : ""}`} data-legend-row={r.label}>
            <div className="flex items-center gap-1.5">
              <span className={r.kind === "line" ? "h-0.5 w-3" : r.kind === "shape" || r.kind === "tiles" ? "h-2.5 w-3 rounded-sm" : "h-2.5 w-2.5 rounded-full"} style={{ background: r.color, opacity: r.kind === "shape" ? 0.7 : 1 }} />
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {r.count !== undefined && <span className="text-muted">{r.count}</span>}
            </div>
            {r.note && <div className="ml-4 text-muted">{r.note}</div>}
            {r.by && (r.bins?.length || r.legend) && <div className="ml-4 text-[10px] text-muted">{r.by}</div>}
            {!!r.bins?.length && (
              <div className="ml-4 mt-0.5 space-y-0.5 text-[10px] text-muted">
                {r.bins.map((b, k) => (
                  <div key={k} className="flex items-center gap-1" data-legend-bin={k} data-color={b.color} data-count={b.count}>
                    <span className="h-2 w-3 rounded-sm" style={{ background: b.color }} />
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <span>{b.count}</span>
                  </div>
                ))}
              </div>
            )}
            {r.legend?.kind === "range" && (
              <div className="ml-4 mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                {fmtNum(r.legend.min)}
                <span className="h-2 flex-1 rounded" style={{ background: `linear-gradient(to right, ${r.legend.colors.join(", ")})` }} />
                {fmtNum(r.legend.max)}
              </div>
            )}
            {r.legend?.kind === "category" && (
              <div className="ml-4 mt-0.5 space-y-0.5 text-[10px] text-muted">
                {r.legend.items.map(([v, c]) => (
                  <div key={v} className="flex items-center gap-1" data-legend-item={v}>
                    <span className="h-2 w-2 rounded-sm" style={{ background: c }} />
                    <span className="truncate">{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

/** Hover card (tooltip) at the pointer (x, y relative to the map box of the given width). */
export function HoverCard({ hover, width }: { hover: { x: number; y: number; text: string } | null; width: number }) {
  if (!hover) return null;
  const { x, y } = hover;
  const flip = x > width - 220;
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-[220px] whitespace-pre-line rounded border border-line bg-panel/95 px-2 py-1 text-[11px] text-soft shadow"
      style={{ left: flip ? x - 14 : x + 14, top: y + 12, transform: flip ? "translateX(-100%)" : undefined }}
      data-map-tooltip
    >
      {hover.text}
    </div>
  );
}

/** The picked overlay feature's properties. */
export function PickCard({ pick, onClose }: { pick: OverlayPick; onClose: () => void }) {
  const entries = Object.entries(pick.properties ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object").slice(0, 10);
  return (
    <div className="absolute right-14 top-3 z-10 w-60 rounded-md border border-line bg-panel/95 p-2 text-[11px] shadow" data-map-pick>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 truncate font-medium text-soft">{pick.title}</div>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="w-24 shrink-0 truncate text-muted">{k}</span>
          <span className="min-w-0 flex-1 truncate">{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration: overlay layers and map templates
// ------------------------------------------------------------------------------------------------

let mapsOnce: Promise<SavedMap[]> | null = null;
const allMaps = () => {
  if (!mapsOnce) {
    mapsOnce = geoApi.maps();
    mapsOnce.catch(() => (mapsOnce = null));
  }
  return mapsOnce;
};
function useMapList() {
  const [maps, setMaps] = useState<SavedMap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    allMaps().then(setMaps, (e: Error) => setError(e.message));
  }, []);
  return { maps, error };
}

function describe(o: MapOverlay, maps: SavedMap[] | null): string {
  if (o.map_id) {
    const m = maps?.find((x) => x.id === o.map_id);
    return `Map “${m?.name ?? o.map_id}” · ${o.layer_id ? "one layer" : "every layer"}`;
  }
  if (o.tiles) return `Tile server: ${o.tiles}`;
  if (o.vector_tiles) return `Vector tiles: ${o.vector_tiles}`;
  if (o.geojson_url) return `GeoJSON: ${o.geojson_url}`;
  if (o.geojson_item) return `GeoJSON file ${o.geojson_item}`;
  return "";
}

export function MapOverlaysConfig({ overlays, onChange, mod }: { overlays: MapOverlay[]; onChange: (v: MapOverlay[]) => void; mod: Module }) {
  const { maps, error } = useMapList();
  const [adding, setAdding] = useState<"" | "map" | "tiles" | "vector" | "geojson" | "file">("");
  const [mapId, setMapId] = useState("");
  const [layerId, setLayerId] = useState("");
  const [url, setUrl] = useState("");
  const [layersOf, setLayersOf] = useState<SavedMap | null>(null);
  useEffect(() => {
    if (!mapId) return;
    let live = true;
    savedMap(mapId).then((m) => live && setLayersOf(m), () => live && setLayersOf(null));
    return () => {
      live = false;
    };
  }, [mapId]);
  const set = (i: number, x: Partial<MapOverlay>) => onChange(overlays.map((y, j) => (j === i ? { ...y, ...x } : y)));
  // overlays are drawn in this order (the last one on top)
  const move = (i: number, d: -1 | 1) => {
    const next = [...overlays];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const bools = (mod.variables ?? []).filter((v) => v.type === "boolean");
  const add = (o: MapOverlay) => {
    onChange([...overlays, o]);
    setAdding("");
    setUrl("");
    setMapId("");
    setLayerId("");
  };
  const shownLayers = layersOf && layersOf.id === mapId ? layersOf.layers : [];
  return (
    <div className="space-y-2" data-map-overlays-config>
      {overlays.map((o, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2 text-xs" data-map-overlay-config={i}>
          <div className="flex gap-1">
            <input value={o.label} onChange={(e) => set(i, { label: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
            {!o.map_id && <input type="color" value={o.color ?? "#f97316"} onChange={(e) => set(i, { color: e.target.value })} className="h-6 w-7 bg-transparent" />}
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 text-muted hover:text-white disabled:opacity-30" title="Draw earlier (further down)" data-overlay-up>
              ↑
            </button>
            <button type="button" disabled={i === overlays.length - 1} onClick={() => move(i, 1)} className="px-1 text-muted hover:text-white disabled:opacity-30" title="Draw later (further up)" data-overlay-down>
              ↓
            </button>
            <button type="button" onClick={() => onChange(overlays.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
              ✕
            </button>
          </div>
          <div className="truncate text-muted" title={describe(o, maps)}>
            {describe(o, maps)}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted">Opacity</span>
            <input type="range" min={0.1} max={1} step={0.05} value={o.opacity ?? 0.85} onChange={(e) => set(i, { opacity: Number(e.target.value) })} className="min-w-0 flex-1" />
            <select value={o.visible_variable ?? ""} onChange={(e) => set(i, { visible_variable: e.target.value || undefined })} className={`${fieldClass} w-28 text-xs`}>
              <option value="">Always visible</option>
              {bools.map((v) => (
                <option key={v.name}>{v.name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1" title="Vector layers (features, GeoJSON, vector tiles) are drawn over the object layers; tile and raster images always stay under them">
            <input type="checkbox" checked={!!o.above} onChange={(e) => set(i, { above: e.target.checked || undefined })} data-overlay-above /> Draw above the object layers
          </label>
        </div>
      ))}
      {error && <div className="text-xs text-bad">{error}</div>}
      {adding === "" ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {(
            [
              ["map", "+ From a saved map"],
              ["tiles", "+ Tile / WMS server"],
              ["vector", "+ Vector tiles"],
              ["geojson", "+ GeoJSON URL"],
              ["file", "+ GeoJSON file"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setAdding(k)} className="text-ocean" data-add-overlay={k}>
              {label}
            </button>
          ))}
        </div>
      ) : adding === "file" ? (
        <DrivePicker
          title="Pick a GeoJSON file"
          canPick={(it) => (it.kind !== "file" ? "Pick a file" : /\.(geo)?json$/i.test(it.name) ? null : "Pick a .geojson or .json file")}
          onPick={(it) => add({ label: it.name.replace(/\.(geo)?json$/i, ""), geojson_item: it.id, color: "#f97316" })}
          onClose={() => setAdding("")}
        />
      ) : (
        <div className="space-y-1 rounded border border-ocean/40 p-2 text-xs">
          {adding === "map" ? (
            <>
              <select value={mapId} onChange={(e) => (setMapId(e.target.value), setLayerId(""))} className={inputClass} data-overlay-map>
                <option value="">Choose a saved map…</option>
                {(maps ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {mapId && (
                <select value={layerId} onChange={(e) => setLayerId(e.target.value)} className={inputClass} data-overlay-layer>
                  <option value="">Every layer of the map</option>
                  {shownLayers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.kind === "tiles" && l.config.format === "vector" ? "Vector tiles" : LAYER_KIND_LABEL[l.kind]})
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={adding === "tiles" ? "https://…/{z}/{x}/{y}.png or a WMS GetMap URL with {bbox-epsg-3857}" : adding === "vector" ? "https://…/{z}/{x}/{y}.pbf" : "https://…/data.geojson"}
              className={inputClass}
              data-overlay-url
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={adding === "map" ? !mapId : !url.trim()}
              onClick={() => {
                if (adding === "map") {
                  const m = maps?.find((x) => x.id === mapId);
                  const l = shownLayers.find((x) => x.id === layerId);
                  add({ label: l?.name ?? m?.name ?? "Overlay", map_id: mapId, layer_id: layerId || undefined });
                } else {
                  const u = url.trim();
                  const label = adding === "tiles" ? "Tiles" : adding === "vector" ? "Vector tiles" : "GeoJSON";
                  add({ label, color: "#f97316", ...(adding === "tiles" ? { tiles: u } : adding === "vector" ? { vector_tiles: u } : { geojson_url: u }) });
                }
              }}
              className="text-ocean disabled:opacity-40"
              data-overlay-add
            >
              Add overlay
            </button>
            <button type="button" onClick={() => setAdding("")} className="text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MapTemplateConfig({ template, onChange, mod }: { template: MapTemplate; onChange: (t: MapTemplate) => void; mod: Module }) {
  const { maps, error } = useMapList();
  const [m, setM] = useState<SavedMap | null>(null);
  useEffect(() => {
    if (!template.map_id) return;
    let live = true;
    savedMap(template.map_id).then((x) => live && setM(x), () => live && setM(null));
    return () => {
      live = false;
    };
  }, [template.map_id]);
  const sets = (mod.variables ?? []).filter((v) => ["object_set", "array", "string"].includes(v.type));
  const inputs = m && m.id === template.map_id ? m.layers.filter((l) => l.kind === "objects" || l.kind === "dropped") : [];
  const varSel = (value: string | undefined, onSel: (v: string | undefined) => void, empty: string): ReactNode => (
    <select value={value ?? ""} onChange={(e) => onSel(e.target.value || undefined)} className={`${fieldClass} w-full text-xs`}>
      <option value="">{empty}</option>
      {sets.map((v) => (
        <option key={v.name}>{v.name}</option>
      ))}
    </select>
  );
  return (
    <div className="space-y-2 rounded border border-line p-2 text-xs" data-map-template-config>
      <select value={template.map_id} onChange={(e) => onChange({ ...template, map_id: e.target.value, inputs: {} })} className={inputClass} data-template-map>
        <option value="">Choose a saved map…</option>
        {(maps ?? []).map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {error && <div className="text-bad">{error}</div>}
      {m && m.id === template.map_id && (
        <div className="text-muted">
          {m.layers.length} layers · base map {m.basemap}
        </div>
      )}
      {inputs.length > 0 && (
        <Field label="Inputs: object layers shown as the objects of a variable (all while it is empty)">
          <div className="space-y-1">
            {inputs.map((l) => (
              <div key={l.id} className="grid grid-cols-2 items-center gap-1">
                <span className="truncate" title={l.name}>
                  {l.name}
                </span>
                {varSel(template.inputs?.[l.id], (v) => onChange({ ...template, inputs: { ...(template.inputs ?? {}), [l.id]: v ?? "" } }), "No input")}
              </div>
            ))}
          </div>
        </Field>
      )}
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={template.use_view !== false} onChange={(e) => onChange({ ...template, use_view: e.target.checked })} /> Use the template&apos;s base map and view
      </label>
      <Field label="Selected objects (output variable)">{varSel(template.selected_variable, (v) => onChange({ ...template, selected_variable: v }), "None")}</Field>
    </div>
  );
}
