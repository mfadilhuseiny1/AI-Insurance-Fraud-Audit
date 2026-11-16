"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { googleTileUrl, hasGoogleMaps, useGoogleSessions } from "@/lib/googleMaps";
import { GoogleEarth3D, type EarthPoint } from "./GoogleEarth3D";

/**
 * A slippy map in Web Mercator (every map here expects WGS 84 and draws in Web Mercator, as Foundry's): free XYZ
 * basemap tiles, pan / zoom, fit to bounds, and drawing a polygon (click the vertices, double-click or click the first
 * one to close) or a circle (press at the centre and drag the radius). Layers draw themselves through `children`
 * (SVG) and `overlays` (HTML, e.g. raster images) with the projection.
 */
export const TILE = 256;
export const BASEMAPS = {
  streets: { label: "Streets", url: (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, credit: "© OpenStreetMap contributors" },
} as const;
/** Basemap Google (Map Tiles API): hanya aktif bila NEXT_PUBLIC_GOOGLE_MAPS_API_KEY terisi. */
export const GOOGLE_BASEMAPS = {
  "google-satellite": { label: "Satellite", kind: "satellite" as const, credit: "Imagery © Google, Maxar, Landsat/Copernicus" },
  "google-hybrid": { label: "Hybrid", kind: "hybrid" as const, credit: "Imagery © Google, Maxar, Landsat/Copernicus" },
} as const;
export type Basemap = keyof typeof BASEMAPS | keyof typeof GOOGLE_BASEMAPS | "none";
const basemapLabel = (b: Basemap): string => (b === "none" ? "None" : b in BASEMAPS ? BASEMAPS[b as keyof typeof BASEMAPS].label : GOOGLE_BASEMAPS[b as keyof typeof GOOGLE_BASEMAPS].label);
const basemapCredit = (b: Basemap): string => (b in BASEMAPS ? BASEMAPS[b as keyof typeof BASEMAPS].credit : GOOGLE_BASEMAPS[b as keyof typeof GOOGLE_BASEMAPS].credit);

export const worldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
export const worldY = (lat: number, z: number) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};
const lonOf = (wx: number, z: number) => (wx / (TILE * 2 ** z)) * 360 - 180;
const latOf = (wy: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / (TILE * 2 ** z)))) * 180) / Math.PI;
// Web Mercator meters (EPSG:3857) → world pixels
const R = 6378137;
export const mercX = (m: number, z: number) => ((m / (Math.PI * R) + 1) / 2) * TILE * 2 ** z;
export const mercY = (m: number, z: number) => ((1 - m / (Math.PI * R)) / 2) * TILE * 2 ** z;

export type View = { z: number; cx: number; cy: number };
export type Projection = {
  z: number;
  w: number;
  h: number;
  px: (lon: number) => number;
  py: (lat: number) => number;
  /** screen → [lon, lat] */
  unproject: (x: number, y: number) => [number, number];
};
export type Bounds = [number, number, number, number]; // min lon, min lat, max lon, max lat
export type Drawn = { polygon?: { type: "Polygon"; coordinates: number[][][] }; circle?: { lat: number; lon: number; radius_m: number } };
export type MapHandle = { fit: (b: Bounds | null) => void; center: (lon: number, lat: number, zoom?: number) => void; bounds: () => Bounds; view: () => View };

const haversine = (a: [number, number], b: [number, number]) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Basemap lama yang sudah dihapus menunya: satellite (Esri) -> Satellite Google, dark -> Streets. */
export const normalizeBasemap = (b: string): Basemap =>
  b === "satellite" ? "google-satellite" : b === "dark" ? "streets" : (b as Basemap);

export function MapCanvas({
  basemap: basemapIn,
  onBasemap,
  initial,
  onMove,
  draw,
  onDrawn,
  onDrop,
  children,
  overlays,
  corner,
  handle,
  earthPoints,
}: {
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  initial?: { lat: number; lon: number; zoom: number } | null;
  /** after a pan / zoom: the visible bounds and the view as lat, lon, zoom */
  onMove?: (b: Bounds, v: { lat: number; lon: number; zoom: number }) => void;
  draw?: "polygon" | "circle" | null;
  onDrawn?: (d: Drawn | null) => void;
  onDrop?: (data: DataTransfer) => void;
  children?: (p: Projection) => ReactNode;
  overlays?: (p: Projection) => ReactNode;
  corner?: ReactNode;
  handle?: Ref<MapHandle>;
  earthPoints?: EarthPoint[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const basemap = normalizeBasemap(basemapIn);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const [view, setView] = useState<View>(() =>
    initial ? { z: initial.zoom, cx: worldX(initial.lon, initial.zoom), cy: worldY(initial.lat, initial.zoom) } : { z: 2, cx: worldX(110, 2), cy: worldY(0, 2) },
  );
  const googleKind = basemap in GOOGLE_BASEMAPS ? GOOGLE_BASEMAPS[basemap as keyof typeof GOOGLE_BASEMAPS].kind : null;
  const { base: gBase, overlay: gOverlay, error: gError } = useGoogleSessions(googleKind);
  const [earth3d, setEarth3d] = useState(false);
  const v = view;
  const proj: Projection = useMemo(
    () => ({
      z: v.z,
      w: size.w,
      h: size.h,
      px: (lon: number) => worldX(lon, v.z) - v.cx + size.w / 2,
      py: (lat: number) => worldY(lat, v.z) - v.cy + size.h / 2,
      unproject: (x: number, y: number) => [lonOf(v.cx + x - size.w / 2, v.z), latOf(v.cy + y - size.h / 2, v.z)],
    }),
    [v.z, v.cx, v.cy, size.w, size.h],
  );
  const bounds = useCallback((): Bounds => {
    const [x0, y1] = proj.unproject(0, 0);
    const [x1, y0] = proj.unproject(size.w, size.h);
    return [Math.max(-180, x0), Math.max(-85, y0), Math.min(180, x1), Math.min(85, y1)];
  }, [proj, size.w, size.h]);
  // report moves (debounced)
  const moveCb = useRef(onMove);
  useEffect(() => {
    moveCb.current = onMove;
  });
  useEffect(() => {
    const t = setTimeout(() => {
      const [lon, lat] = proj.unproject(size.w / 2, size.h / 2);
      moveCb.current?.(bounds(), { lat, lon, zoom: v.z });
    }, 300);
    return () => clearTimeout(t);
  }, [proj, bounds, size.w, size.h, v.z]);

  const fit = useCallback(
    (b: Bounds | null) => {
      if (!b) return;
      const [lo0, la0, lo1, la1] = b;
      let z = 17;
      while (z > 1 && (worldX(lo1, z) - worldX(lo0, z) > size.w * 0.85 || worldY(la0, z) - worldY(la1, z) > size.h * 0.85)) z--;
      setView({ z, cx: (worldX(lo0, z) + worldX(lo1, z)) / 2, cy: (worldY(la0, z) + worldY(la1, z)) / 2 });
    },
    [size.w, size.h],
  );
  useImperativeHandle(
    handle,
    () => ({
      fit,
      center: (lon, lat, zoom) => setView((c) => ({ z: zoom ?? Math.max(c.z, 11), cx: worldX(lon, zoom ?? Math.max(c.z, 11)), cy: worldY(lat, zoom ?? Math.max(c.z, 11)) })),
      bounds,
      view: () => view,
    }),
    [fit, bounds, view],
  );

  const zoom = (dz: number, ax = size.w / 2, ay = size.h / 2) =>
    setView((c) => {
      const z = Math.max(1, Math.min(19, c.z + dz));
      const f = 2 ** (z - c.z);
      const wx = c.cx + ax - size.w / 2;
      const wy = c.cy + ay - size.h / 2;
      return { z, cx: wx * f - (ax - size.w / 2), cy: wy * f - (ay - size.h / 2) };
    });

  const tiles = useMemo(() => {
    if (basemap === "none") return [];
    if (basemap in GOOGLE_BASEMAPS && (!gBase || (googleKind === "hybrid" && !gOverlay))) return []; // session belum siap
    const tile = basemap in GOOGLE_BASEMAPS
      ? googleTileUrl(gBase!)
      : BASEMAPS[basemap as keyof typeof BASEMAPS].url;
    const overlayTile = googleKind === "hybrid" && gOverlay ? googleTileUrl(gOverlay) : null;
    const n = 2 ** v.z;
    const x0 = Math.floor((v.cx - size.w / 2) / TILE);
    const x1 = Math.floor((v.cx + size.w / 2) / TILE);
    const y0 = Math.max(0, Math.floor((v.cy - size.h / 2) / TILE));
    const y1 = Math.min(n - 1, Math.floor((v.cy + size.h / 2) / TILE));
    const out: { key: string; src: string; overlay?: string; left: number; top: number }[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const wx = ((x % n) + n) % n;
        out.push({ key: `${basemap}/${v.z}/${x}/${y}`, src: tile(v.z, wx, y), overlay: overlayTile ? overlayTile(v.z, wx, y) : undefined, left: x * TILE - v.cx + size.w / 2, top: y * TILE - v.cy + size.h / 2 });
      }
    return out;
  }, [basemap, v.z, v.cx, v.cy, size.w, size.h, gBase, gOverlay, googleKind]);

  // drawing
  const [vertices, setVertices] = useState<[number, number][]>([]);
  const [circle, setCircle] = useState<{ c: [number, number]; edge: [number, number] } | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  // a new drawing mode starts from scratch
  const [drawMode, setDrawMode] = useState(draw);
  if (drawMode !== draw) {
    setDrawMode(draw);
    setVertices([]);
    setCircle(null);
  }
  const finishPolygon = (pts: [number, number][]) => {
    if (pts.length < 3) return;
    const ring = [...pts, pts[0]];
    // counter-clockwise exterior ring (RFC 7946)
    const area = ring.slice(0, -1).reduce((s, p, i) => s + p[0] * ring[i + 1][1] - ring[i + 1][0] * p[1], 0);
    onDrawn?.({ polygon: { type: "Polygon", coordinates: [area < 0 ? [...ring].reverse() : ring] } });
    setVertices([]);
  };
  useEffect(() => {
    if (!draw) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVertices([]);
        setCircle(null);
        onDrawn?.(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [draw, onDrawn]);

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  return (
    <div
      className="relative min-w-0 flex-1 overflow-hidden bg-ink"
      ref={box}
      onDragOver={(e) => onDrop && (e.preventDefault(), (e.dataTransfer.dropEffect = "copy"))}
      onDrop={(e) => {
        if (!onDrop) return;
        e.preventDefault();
        onDrop(e.dataTransfer);
      }}
    >
      <div
        className={`absolute inset-0 select-none ${draw ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onWheel={(e) => {
          const [x, y] = local(e);
          zoom(e.deltaY < 0 ? 1 : -1, x, y);
        }}
        onDoubleClick={(e) => {
          if (draw === "polygon") {
            e.preventDefault();
            finishPolygon(vertices);
          } else if (!draw) {
            const [x, y] = local(e);
            zoom(1, x, y);
          }
        }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          const [x, y] = local(e);
          if (draw === "circle") {
            const c = proj.unproject(x, y);
            setCircle({ c, edge: c });
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, cx: v.cx, cy: v.cy, moved: false };
        }}
        onPointerMove={(e) => {
          const [x, y] = local(e);
          if (draw === "circle" && circle) return setCircle({ ...circle, edge: proj.unproject(x, y) });
          if (draw === "polygon") setHover(proj.unproject(x, y));
          const d = drag.current;
          if (d && (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3)) {
            d.moved = true;
            setView({ z: v.z, cx: d.cx - (e.clientX - d.x), cy: d.cy - (e.clientY - d.y) });
          }
        }}
        onPointerUp={(e) => {
          const [x, y] = local(e);
          if (draw === "circle" && circle) {
            const r = haversine(circle.c, circle.edge);
            setCircle(null);
            if (r > 1) onDrawn?.({ circle: { lon: circle.c[0], lat: circle.c[1], radius_m: Math.round(r) } });
            return;
          }
          const d = drag.current;
          drag.current = null;
          if (draw === "polygon" && d && !d.moved) {
            const p = proj.unproject(x, y);
            // clicking the first vertex closes the polygon
            if (vertices.length >= 3 && Math.hypot(proj.px(vertices[0][0]) - x, proj.py(vertices[0][1]) - y) < 8) finishPolygon(vertices);
            else setVertices([...vertices, p]);
          }
        }}
      >
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={t.key}
            src={t.src}
            alt=""
            draggable={false}
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            className={`pointer-events-none absolute ${basemap === "google-satellite" || basemap === "google-hybrid" ? "opacity-90" : "opacity-80"}`}
            style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
          />
        ))}
        {tiles.filter((t) => t.overlay).map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${t.key}/overlay`} src={t.overlay} alt="" draggable={false} className="pointer-events-none absolute" style={{ left: t.left, top: t.top, width: TILE, height: TILE }} />
        ))}
        {overlays?.(proj)}
        <svg width={size.w} height={size.h} className="absolute inset-0">
          {children?.(proj)}
          {draw === "polygon" && vertices.length > 0 && (
            <g className="pointer-events-none">
              <polyline
                points={[...vertices, ...(hover ? [hover] : [])].map((p) => `${proj.px(p[0])},${proj.py(p[1])}`).join(" ")}
                fill="rgba(56,189,248,0.15)"
                stroke="#38bdf8"
                strokeWidth={2}
                strokeDasharray="5 3"
              />
              {vertices.map((p, i) => (
                <circle key={i} cx={proj.px(p[0])} cy={proj.py(p[1])} r={i === 0 ? 6 : 4} fill={i === 0 ? "#38bdf8" : "#0b1220"} stroke="#38bdf8" strokeWidth={2} />
              ))}
            </g>
          )}
          {circle && (
            <circle
              className="pointer-events-none"
              cx={proj.px(circle.c[0])}
              cy={proj.py(circle.c[1])}
              r={Math.hypot(proj.px(circle.edge[0]) - proj.px(circle.c[0]), proj.py(circle.edge[1]) - proj.py(circle.c[1]))}
              fill="rgba(56,189,248,0.15)"
              stroke="#38bdf8"
              strokeWidth={2}
              strokeDasharray="5 3"
            />
          )}
        </svg>
      </div>
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <button type="button" onClick={() => zoom(1)} className={`${buttonClass.secondary} px-2 py-1`} aria-label="Zoom in">
          <Icon name="plus" className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => zoom(-1)} className={`${buttonClass.secondary} px-2 py-1`} aria-label="Zoom out">
          <Icon name="minus" className="h-4 w-4" />
        </button>
      </div>
      <div className="absolute left-3 top-3 flex overflow-hidden rounded-md border border-line bg-panel/90 text-xs">
        {([...Object.keys(BASEMAPS), ...Object.keys(GOOGLE_BASEMAPS), "none"] as Basemap[]).map((b) => (
          <button key={b} type="button" onClick={() => onBasemap(b)} className={`px-2.5 py-1 ${basemap === b ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
            {basemapLabel(b)}
          </button>
        ))}
      </div>
      {draw && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-ocean/50 bg-panel/95 px-3 py-1.5 text-xs text-soft">
          {draw === "polygon" ? "Click the corners; double-click or click the first one to finish." : "Press at the centre and drag out the radius."} Esc cancels.
        </div>
      )}
      {corner}
      {basemap !== "none" && <div className="absolute bottom-1 right-2 rounded bg-ink/70 px-1 text-[10px] text-soft">{basemapCredit(basemap)}</div>}
      {earthPoints && (
        <button type="button" onClick={() => setEarth3d(true)} className="absolute right-3 top-24 rounded-md bg-ocean px-2.5 py-1.5 text-xs font-semibold text-white shadow hover:bg-ocean-deep">3D Earth</button>
      )}
      {basemap in GOOGLE_BASEMAPS && !hasGoogleMaps() && (
        <div className="absolute bottom-6 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-warn/50 bg-panel/95 px-3 py-1.5 text-center text-xs text-soft">Basemap Google butuh <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> di web/.env.local — ganti ke Streets untuk sementara.</div>
      )}
      {gError && <div className="absolute bottom-6 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-bad/50 bg-panel/95 px-3 py-1.5 text-center text-xs text-bad">{gError}</div>}
      {earth3d && earthPoints && (
        <GoogleEarth3D center={(() => { const [lon, lat] = proj.unproject(size.w / 2, size.h / 2); return { lat, lng: lon }; })()} points={earthPoints} onClose={() => setEarth3d(false)} />
      )}
    </div>
  );
}
