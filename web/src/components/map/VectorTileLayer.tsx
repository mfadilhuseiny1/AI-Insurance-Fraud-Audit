"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { geoApi } from "@/lib/geo";
import { clipToBox, loadTile, MAX_TILE_RETRIES, mergePieces, retryable, tileBox, retryDelay, tileFeatures, tileProjector, tilesFor, tileUrl, validTemplate, type GeoFeature, type LonLat } from "@/lib/mvt";
import type { Projection } from "./MapCanvas";
import { lineAnchor, placeLabels, polygonAnchor, type Box, type LabelCandidate, type Pt } from "./vectorLabels";
import { buildColorScale, type ColorLegend, type VectorColorBy } from "./vectorTileStyle";

/**
 * A vector tile layer (Mapbox Vector Tiles from a {z}/{x}/{y}.pbf / .mvt server) drawn in a MapCanvas's SVG: only the
 * tiles in view are loaded (decoded by lib/mvt.ts, cached by URL; straight from the server, or through the platform's
 * tile proxy for servers without CORS headers), each tile's features clipped to the tile so the buffer around it is not
 * drawn twice. Failed tiles are retried with back-off (1, 2, 4, 8, 16 s; not for 4xx answers other than 408 / 429).
 * Features are clickable (onFeature) and hoverable, can be colored by a property (colorBy) or by values per feature id
 * (valueById, a vector-tile choropleth), and labeled from a property — as hover titles, or drawn on the map with
 * collision avoidance (labels: "always").
 */
export type VectorTileStyle = {
  /** polygon fill */
  fill?: string;
  fillOpacity?: number;
  /** line features' color and width */
  line?: string;
  width?: number;
  /** polygon outline (defaults: line color, 1 px) */
  outline?: string;
  outlineWidth?: number;
  /** point features */
  circle?: string;
  radius?: number;
  /** the whole layer */
  opacity?: number;
};
export type VectorTileFeature = {
  id: string;
  layer: string;
  properties: Record<string, unknown>;
  /** the piece in the clicked tile (clipped to the tile and its buffer) */
  geometry: GeoFeature["geometry"];
  /** the feature as far as the loaded tiles hold it: every tile's piece of it (same source layer and id) merged */
  whole: GeoFeature["geometry"];
  /** how many tiles' pieces `whole` was made of */
  pieces: number;
  tile: string;
};
export type VectorTileStatus = {
  loading: number;
  tiles: number;
  features: number;
  /** tiles in view that failed (and are not loaded yet); `retrying` of them have a retry scheduled */
  failed?: number;
  retrying?: number;
  /** labels drawn on the map (labels: "always") */
  labels?: number;
  error?: string;
  legend?: ColorLegend | null;
  layers?: string[];
  properties?: string[];
};
export type VectorLabelMode = "hover" | "always";

/** a loaded tile: its features (narrowed to the source layers) and the names of every layer in it; or why it failed */
type Loaded = { features: GeoFeature[]; names: string[] } | { error: string; attempts: number; retrying: boolean };

export function VectorTileLayer({
  p,
  url,
  sourceLayers,
  minZoom = 0,
  maxZoom = 14,
  idKey = "id",
  labelKey,
  labels = "hover",
  labelStyle = "minimal",
  proxy = false,
  retryNonce = 0,
  allowIds,
  style,
  selectedStyle,
  hoverStyle,
  color = "#38bdf8",
  colorBy,
  valueById,
  selectedIds,
  onFeature,
  onStatus,
}: {
  p: Projection;
  url: string;
  /** source-layer names to draw (empty: every layer of the tile) */
  sourceLayers?: string[];
  minZoom?: number;
  maxZoom?: number;
  /** property used as the feature id (falls back to the MVT feature id) */
  idKey?: string;
  /** property shown on hover and as the label (default name / NAME / title) */
  labelKey?: string;
  /** "hover": a title on hover only; "always": also drawn on the map (overlapping labels are left out) */
  labels?: VectorLabelMode;
  /** drawn labels: "card" on a dark background, "minimal" text with a halo */
  labelStyle?: "card" | "minimal";
  /** load the tiles through the platform's tile proxy (GET /api/geo/tile-proxy; the host must be on its allow-list) */
  proxy?: boolean;
  /** change it to retry every failed tile now */
  retryNonce?: number;
  /** only features whose id matches one of these (exact, or a regular expression matching the whole id) */
  allowIds?: string[];
  style?: VectorTileStyle;
  selectedStyle?: VectorTileStyle;
  hoverStyle?: VectorTileStyle;
  color?: string;
  /** color each feature by a property (or by its valueById value) */
  colorBy?: VectorColorBy | null;
  /** values per feature id (e.g. a Slate choropleth's ids / values): colored by colorBy, features without one keep the base color */
  valueById?: Record<string, unknown> | null;
  selectedIds?: string[];
  onFeature?: (f: VectorTileFeature) => void;
  onStatus?: (s: VectorTileStatus) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const layersSig = (sourceLayers ?? []).filter(Boolean).join(",");
  const ok = validTemplate(url);
  // the tiles in view: the map's zoom, over-zoomed past the source's maximum, nothing below its minimum
  const z = Math.max(0, Math.min(Math.round(p.z), Math.round(maxZoom)));
  const [lon0, lat1] = p.unproject(0, 0);
  const [lon1, lat0] = p.unproject(p.w, p.h);
  const visible = ok && p.z >= minZoom && p.w > 0 ? tilesFor([Math.max(-180, lon0), Math.max(-85.05, lat0), Math.min(180, lon1), Math.min(85.05, lat1)], z, 64) : [];
  const wanted = visible.map((t) => {
    const u = tileUrl(url, t.z, t.x, t.y);
    return { ...t, url: proxy ? geoApi.tileProxyUrl(u) : u, upstream: u, key: `${proxy ? "proxy:" : ""}${u}#${layersSig}` };
  });
  const sig = wanted.map((t) => t.key).join("|");

  // the tiles loaded so far (by URL + source layers); `requested` remembers what is in flight or done
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Loaded>>(() => new Map());
  const requested = useRef(new Set<string>());
  // failed tiles: attempts so far and the pending retry timers (a retry clears the key from `requested` and bumps `tick`)
  const attempts = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const [hover, setHover] = useReducer((_: string | null, v: string | null) => v, null);
  useEffect(() => {
    const ts = timers.current;
    return () => {
      ts.forEach(clearTimeout);
      ts.clear();
    };
  }, []);
  // "retry now": every failed tile starts over (attempts reset)
  const firstNonce = useRef(retryNonce);
  useEffect(() => {
    if (retryNonce === firstNonce.current) return;
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    for (const k of [...attempts.current.keys()]) requested.current.delete(k);
    attempts.current.clear();
    bump();
  }, [retryNonce]);
  useEffect(() => {
    const layers = layersSig ? layersSig.split(",") : [];
    const keep = new Set(wanted.map((t) => t.key));
    const put = (key: string, v: Loaded) =>
      setLoaded((cur) => {
        const next = new Map(cur).set(key, v);
        // forget tiles out of view once the map grows (the decoded tiles stay in lib/mvt's cache)
        if (next.size > 256)
          for (const k of [...next.keys()])
            if (!keep.has(k) && k !== key) {
              next.delete(k);
              requested.current.delete(k);
            }
        return next;
      });
    for (const t of wanted) {
      if (requested.current.has(t.key)) continue;
      requested.current.add(t.key);
      loadTile(t.url).then(
        (tile) => {
          attempts.current.delete(t.key);
          put(t.key, { features: tile ? tileFeatures(tile, t.z, t.x, t.y, layers) : [], names: tile ? tile.layers.map((l) => l.name) : [] });
        },
        (e: Error) => {
          const n = (attempts.current.get(t.key) ?? 0) + 1;
          attempts.current.set(t.key, n);
          const again = retryable(e) && n <= MAX_TILE_RETRIES;
          // name the tile server's URL, not the proxy's
          const msg = (e.message || "the tile could not be loaded").replace(t.url, proxy ? `${t.upstream} (through the tile proxy)` : t.url);
          put(t.key, { error: msg, attempts: n, retrying: again });
          if (!again) return;
          clearTimeout(timers.current.get(t.key));
          timers.current.set(
            t.key,
            setTimeout(() => {
              timers.current.delete(t.key);
              requested.current.delete(t.key); // loaded again when (still or again) in view
              bump();
            }, retryDelay(n)),
          );
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tick]);

  const allow = (allowIds ?? []).filter(Boolean).map((s) => {
    try {
      return { s, re: new RegExp(`^(?:${s})$`) };
    } catch {
      return { s, re: null };
    }
  });
  const allowed = (id: string) => !allow.length || allow.some((a) => a.s === id || a.re?.test(id));

  // the features to draw per tile, with their ids (a property, the MVT id, or the position in the tile)
  let loading = 0;
  let failed = 0;
  let retrying = 0;
  let error: string | undefined;
  const names = new Set<string>();
  const drawn: { t: (typeof wanted)[number]; items: { f: GeoFeature; id: string; i: number }[] }[] = [];
  for (const t of wanted) {
    const d = loaded.get(t.key);
    if (!d) loading++;
    else if ("error" in d) {
      error = error ?? d.error;
      failed++;
      if (d.retrying) retrying++;
    } else {
      d.names.forEach((n) => names.add(n));
      const items = d.features
        .map((f, i) => {
          const raw = f.properties[idKey] ?? f.id;
          return { f, i, id: raw === null || raw === undefined ? `${t.z}/${t.x}/${t.y}/${f.layer}/${i}` : String(raw) };
        })
        .filter((x) => allowed(x.id));
      drawn.push({ t, items });
    }
  }
  // distinct features (a feature crossing tiles is in each of them)
  const count = new Set(drawn.flatMap((d) => d.items.map((x) => `${x.f.layer}\u0000${x.id}`))).size;
  // the property names of the features in view (for pickers: color by, label, id)
  const keys = new Set<string>();
  for (const d of drawn) for (const x of d.items) for (const k of Object.keys(x.f.properties)) if (keys.size < 60) keys.add(k);

  // styling by property (or by values per id): the scale's domain / categories come from the features in view
  const valueOf = (f: GeoFeature, id: string): unknown => (valueById ? valueById[id] : colorBy?.property ? f.properties[colorBy.property] : undefined);
  const styled = !!colorBy && (!!valueById || !!colorBy.property);
  const scale = buildColorScale(styled ? colorBy : null, styled ? drawn.flatMap((d) => d.items.map((x) => valueOf(x.f, x.id))) : []);

  // labels drawn on the map: a candidate per feature piece (the largest piece of a feature wins), placed without overlaps
  const labelOf = (f: GeoFeature): string | null => {
    const v = labelKey ? f.properties[labelKey] : (f.properties.name ?? f.properties.NAME ?? f.properties.title);
    return v === null || v === undefined || v === "" ? null : String(v);
  };
  const placed =
    labels === "always" && p.w > 0
      ? (() => {
          const cands: LabelCandidate[] = [];
          const obstacles: Box[] = [];
          const toPx = (q: LonLat): Pt => [p.px(q[0]), p.py(q[1])];
          const r = (style?.radius ?? 5) + 1;
          for (const d of drawn)
            for (const { f, id } of d.items) {
              const g = f.geometry;
              const text = labelOf(f);
              if (g.type === "Point" || g.type === "MultiPoint") {
                const pts = (g.type === "Point" ? [g.coordinates] : g.coordinates).map(toPx);
                for (const [x, y] of pts) obstacles.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
                if (text && pts.length) cands.push({ id, text, kind: "point", x: pts[0][0], y: pts[0][1], r, priority: 1e12 });
              } else if (!text) continue;
              else if (g.type === "LineString" || g.type === "MultiLineString") {
                const best = (g.type === "LineString" ? [g.coordinates] : g.coordinates)
                  .map((l) => lineAnchor(l.map(toPx)))
                  .reduce<ReturnType<typeof lineAnchor>>((a, b) => (b && (!a || b.length > a.length) ? b : a), null);
                if (best) cands.push({ id, text, kind: "line", x: best.x, y: best.y, priority: best.length, room: best.length });
              } else {
                const best = (g.type === "Polygon" ? [g.coordinates] : g.coordinates)
                  .map((poly) => polygonAnchor(poly.map((ring) => ring.map(toPx))))
                  .reduce<ReturnType<typeof polygonAnchor>>((a, b) => (b && (!a || b.area > a.area) ? b : a), null);
                if (best && best.area > 150) cands.push({ id, text, kind: "area", x: best.x, y: best.y, priority: best.area, room: best.width });
              }
            }
          return placeLabels(cands, { width: p.w, height: p.h, fontSize: LABEL_FONT_SIZE, measure: measureLabel, obstacles });
        })()
      : [];

  // status for the layer list: tiles loading / loaded / failed, features drawn, the first error, the legend, the tiles' layers
  const status = JSON.stringify([loading, wanted.length, count, error ?? null, scale.legend, [...names].sort(), [...keys].sort(), failed, retrying, placed.length]);
  const statusCb = useRef(onStatus);
  useEffect(() => {
    statusCb.current = onStatus;
  });
  useEffect(() => {
    const [l, t, f, e, legend, layerNames, props, nFailed, nRetrying, nLabels] = JSON.parse(status) as [
      number,
      number,
      number,
      string | null,
      ColorLegend | null,
      string[],
      string[],
      number,
      number,
      number,
    ];
    statusCb.current?.({
      loading: l,
      tiles: t,
      features: f,
      failed: nFailed,
      retrying: nRetrying,
      labels: nLabels,
      error: e ?? (ok || !url ? undefined : "The URL template needs http(s) with {z}, {x} and {y}"),
      legend,
      layers: layerNames,
      properties: props,
    });
  }, [status, ok, url]);

  const base: Required<Omit<VectorTileStyle, "outline" | "outlineWidth">> & Pick<VectorTileStyle, "outline" | "outlineWidth"> = {
    fill: style?.fill || color,
    fillOpacity: style?.fillOpacity ?? 0.3,
    line: style?.line || color,
    width: style?.width ?? 1.5,
    outline: style?.outline,
    outlineWidth: style?.outlineWidth,
    circle: style?.circle || color,
    radius: style?.radius ?? 5,
    opacity: style?.opacity ?? 1,
  };
  const sel = new Set((selectedIds ?? []).map(String));
  const px = (q: LonLat) => `${p.px(q[0]).toFixed(1)},${p.py(q[1]).toFixed(1)}`;
  const ringPath = (r: LonLat[]) => r.map((q, i) => `${i ? "L" : "M"}${px(q)}`).join("") + "Z";
  const linePath = (r: LonLat[]) => r.map((q, i) => `${i ? "L" : "M"}${px(q)}`).join("");

  return (
    <g opacity={base.opacity} data-vector-tiles={url}>
      <defs>
        {wanted.map((t) => {
          // the tile's own square: features in its buffer belong to (and are drawn by) the neighbouring tile
          const pr = tileProjector(t.z, t.x, t.y, 1);
          const [a, b] = [pr([0, 0]), pr([1, 1])];
          const x0 = p.px(a[0]);
          const y0 = p.py(a[1]);
          return (
            <clipPath key={t.key} id={`vt-${uid}-${t.z}-${t.x}-${t.y}`}>
              {/* exact, pixel-aligned squares: an overlap would draw translucent fills twice along the tile seams */}
              <rect x={Math.round(x0)} y={Math.round(y0)} width={Math.round(p.px(b[0])) - Math.round(x0)} height={Math.round(p.py(b[1])) - Math.round(y0)} />
            </clipPath>
          );
        })}
      </defs>
      {/* three passes over the tiles — polygons, then lines, then points — so a neighbouring tile's polygons never cover points */}
      {PASSES.flatMap((pass) => drawn.map(({ t, items }) => {
        const mine = items.filter((x) => pass.includes(x.f.geometry.type));
        if (!mine.length) return null;
        return (
          <g key={`${pass[0]}|${t.key}`} clipPath={`url(#vt-${uid}-${t.z}-${t.x}-${t.y})`}>
            {mine.map(({ f, id, i }) => {
              const on = sel.has(id);
              const hov = hover === id;
              const c = styled ? scale.color(valueOf(f, id)) : null;
              const byValue = c ? { fill: c, line: c, circle: c } : {};
              const st = { ...base, ...byValue, ...(hov ? clean(hoverStyle) : {}), ...(on ? clean(selectedStyle) : {}) };
              const label = labelOf(f) ?? id;
              const events = {
                className: "cursor-pointer",
                onPointerDown: (e: React.PointerEvent) => {
                  e.stopPropagation();
                  // a feature crossing tiles: its pieces in every loaded tile, so "search inside" covers all of it
                  // (each piece clipped to its own tile's square: the tiles' buffers would overlap)
                  const all = drawn.flatMap((d) =>
                    d.items.filter((x) => x.id === id && x.f.layer === f.layer).flatMap((x) => clipToBox(x.f.geometry, tileBox(d.t.z, d.t.x, d.t.y)) ?? []),
                  );
                  const whole = mergePieces(all.length ? all : [f.geometry]) ?? f.geometry;
                  onFeature?.({ id, layer: f.layer, properties: f.properties, geometry: f.geometry, whole, pieces: Math.max(1, all.length), tile: `${t.z}/${t.x}/${t.y}` });
                },
                onPointerEnter: () => setHover(id),
                onPointerLeave: () => setHover(null),
                "data-vt-feature": id,
              };
              const g = f.geometry;
              const title = <title>{`${label}${f.layer ? ` · ${f.layer}` : ""}`}</title>;
              if (g.type === "Point" || g.type === "MultiPoint") {
                const pts = g.type === "Point" ? [g.coordinates] : g.coordinates;
                return (
                  <g key={i} {...events}>
                    {pts.map((q, j) => (
                      <circle key={j} cx={p.px(q[0])} cy={p.py(q[1])} r={st.radius + (on ? 2 : 0)} fill={st.circle} stroke={on ? "#ffffff" : "#0b1220"} strokeWidth={on ? 2.5 : 1.5} />
                    ))}
                    {title}
                  </g>
                );
              }
              if (g.type === "LineString" || g.type === "MultiLineString") {
                const lines = g.type === "LineString" ? [g.coordinates] : g.coordinates;
                return (
                  <path key={i} d={lines.map(linePath).join("")} fill="none" stroke={on && !selectedStyle?.line ? "#ffffff" : st.line} strokeWidth={st.width + (on ? 2 : 0)} strokeLinejoin="round" strokeLinecap="round" {...events}>
                    {title}
                  </path>
                );
              }
              const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
              return (
                <path
                  key={i}
                  d={polys.flatMap((poly) => poly.map(ringPath)).join("")}
                  fillRule="evenodd"
                  fill={st.fill}
                  fillOpacity={st.fillOpacity}
                  stroke={on && !selectedStyle?.outline ? "#ffffff" : st.outline || st.line}
                  strokeWidth={(st.outlineWidth ?? 1) + (on ? 1.5 : 0)}
                  {...events}
                >
                  {title}
                </path>
              );
            })}
          </g>
        );
      }))}
      {placed.length > 0 && (
        <g pointerEvents="none" data-vt-labels={placed.length} fontSize={LABEL_FONT_SIZE} fontFamily={LABEL_FONT_FAMILY} fontWeight={600} textAnchor="middle">
          {placed.map((l) => (
            <g key={l.id} data-vt-label={l.id}>
              {labelStyle === "card" && <rect x={l.x - l.w / 2} y={l.y - l.h / 2} width={l.w} height={l.h} rx={3} fill="#0b1220" fillOpacity={0.85} stroke="#334155" strokeWidth={0.5} />}
              <text
                x={l.x}
                y={l.y}
                dy="0.35em"
                fill="#f1f5f9"
                {...(labelStyle === "card" ? {} : { stroke: "#0b1220", strokeWidth: 3, strokeLinejoin: "round" as const, paintOrder: "stroke" })}
              >
                {l.text}
              </text>
            </g>
          ))}
        </g>
      )}
    </g>
  );
}

const PASSES: string[][] = [["Polygon", "MultiPolygon"], ["LineString", "MultiLineString"], ["Point", "MultiPoint"]];

const LABEL_FONT_SIZE = 11;
const LABEL_FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif";
/** label widths from a canvas (the font the labels are drawn in), else 0.6 em per character */
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureLabel = (text: string): number => {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
    if (measureCtx) measureCtx.font = `600 ${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`;
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * LABEL_FONT_SIZE * 0.6;
};

/** a style without its undefined / empty entries (so a partial hover / selected style keeps the base values) */
const clean = (s?: VectorTileStyle): VectorTileStyle => Object.fromEntries(Object.entries(s ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "")) as VectorTileStyle;
