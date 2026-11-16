"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { Modal, buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { api, type DriveItem } from "@/lib/api";
import { when } from "@/lib/format";
import { geoApi, type SavedMap } from "@/lib/geo";
import { googleTileUrl, useGoogleSessions } from "@/lib/googleMaps";
import { pipelineName } from "@/lib/pipelineFiles";
import { isDemo, monitorHref, timeseries, tsOntology, type Observation, type SeriesSync, type TsObjectType } from "@/lib/timeseries";

const TILE = 256;
const COLORS = ["#38bdf8", "#f97316", "#a3e635", "#f472b6", "#facc15", "#34d399", "#c084fc", "#fb7185", "#60a5fa", "#fbbf24"];
/** real-world basemaps: free XYZ tiles, no API key ({z}/{y}/{x} order differs per provider) */
const BASEMAPS = {
  streets: { label: "Streets", url: (z: number, x: number, y: number) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, credit: "© OpenStreetMap contributors" },
} as const;
type Basemap = keyof typeof BASEMAPS | "google-satellite" | "google-hybrid" | "none";
const GOOGLE_LABEL: Record<string, string> = { "google-satellite": "Satellite", "google-hybrid": "Hybrid" };

// Web Mercator: world pixels at zoom z
const worldX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const worldY = (lat: number, z: number) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};

type View = { z: number; cx: number; cy: number };

/** A marker's label: a name-like property (vessel name, plate, name, label) when the observation has one. */
const label = (o: Observation) => {
  const p = o.properties;
  const named = ["vessel_name", "name", "plate", "label", "title"].map((k) => p[k]).find((v) => typeof v === "string" && v);
  return (named as string | undefined) ?? o.series_id;
};

/** The built-in demo maps ("… (demo)"): listed after the user's own. */
const builtIn = (s: SeriesSync) => isDemo(s) || s.name.endsWith("(demo)");

/**
 * Map: saved maps of layers (/map/<id>, components/map: objects with geo properties, tracks, curated sources, rasters,
 * boundaries) and geotemporal series syncs (what pipelines' geotemporal outputs send) as tracks on a map. /map lists the
 * saved maps, the user's syncs, then the built-in demos; /map?sync=<id> opens a sync. Pick a time: each series shows
 * its trail up to that time and its position at that time. Streaming syncs refresh every 10 s. The demo maps are
 * built in: opening the Map loads them, or catches them up and keeps them live (vessel positions come through the
 * demo's streaming pipeline in Pipeline Builder).
 */
export default function MapApp() {
  const [syncs, setSyncs] = useState<SeriesSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?sync=<id>&series=<series id> (from the Time Series Catalog and Data Health)
  const param = (k: string) => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get(k) ?? ""));
  const [syncId, setSyncId] = useState<string>(() => param("sync"));
  const [onlySeries, setOnlySeries] = useState<string>(() => param("series"));
  const [creating, setCreating] = useState(false);
  // ?objects=<object type id>: objects whose geospatial track properties are time series
  const [objectsType, setObjectsType] = useState<string>(() => param("objects"));
  const [geoTypes, setGeoTypes] = useState<TsObjectType[]>([]);
  useEffect(() => {
    tsOntology.objectTypes().then((ts) => setGeoTypes(ts.filter((t) => t.geospatial?.track_latitude && t.geospatial?.track_longitude)), () => setGeoTypes([]));
  }, []);
  const [maps, setMaps] = useState<SavedMap[] | null>(null);
  useEffect(() => {
    const loadMaps = () => geoApi.maps().then(setMaps, () => setMaps([]));
    loadMaps();
    // the demo maps: fishing, JKN facility audit (built once; a viewer who cannot write objects just doesn't get them)
    Promise.all([geoApi.ensureFishingDemo(), geoApi.ensureJknAuditDemo()]).then((made) => { if (made.some(Boolean)) loadMaps(); }, () => {});
    const list = () =>
      timeseries.syncs("geotemporal").then((all) => setSyncs([...all.filter((s) => !builtIn(s)), ...all.filter(builtIn)]), (e: Error) => setError(e.message));
    // the demo may fail (e.g. a viewer cannot write syncs): the user's own maps still show
    timeseries.ensureDemo().catch(() => {}).finally(list);
    // back / forward between the list and a map
    const onPop = () => {
      const qs = new URLSearchParams(window.location.search);
      setSyncId(qs.get("sync") ?? "");
      setOnlySeries(qs.get("series") ?? "");
      setObjectsType(qs.get("objects") ?? "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const open = (id: string, replace = false) => {
    setSyncId(id);
    setOnlySeries("");
    setObjectsType("");
    window.history[replace ? "replaceState" : "pushState"](null, "", id ? `/map?sync=${id}` : "/map");
  };
  const openObjects = (typeId: string) => {
    setSyncId("");
    setObjectsType(typeId);
    window.history.pushState(null, "", `/map?objects=${typeId}`);
  };
  const own = (syncs ?? []).filter((s) => !builtIn(s));
  const demos = (syncs ?? []).filter(builtIn);
  // the home: saved maps, the user's geotemporal series syncs, then the built-in demos (a sync that no longer exists lands here too)
  const missing = !!syncId && !!syncs && !syncs.some((s) => s.id === syncId);
  if (!objectsType && (!syncId || missing)) {
    const syncItem = (s: SeriesSync) => ({
      id: `sync:${s.id}`,
      href: `/map?sync=${s.id}`,
      title: s.name,
      icon: "globe" as const,
      updated_at: s.last_write_at,
      badges: [
        builtIn(s) ? { label: "built-in demo", tone: "sand" as const } : { label: "geotemporal sync", tone: "ocean" as const },
        ...(s.mode === "streaming" && s.written_5m > 0 ? [{ label: "live", tone: "ok" as const }] : []),
      ],
      meta: `${s.series} series · ${s.stored.toLocaleString()} observations`,
      detail: `${isDemo(s) ? "Demo data" : `${s.mode === "streaming" ? "Streaming pipeline" : "Pipeline"} · ${s.pipeline_name || s.pipeline_id}`}${s.last_write_at ? "" : " · nothing sent yet"}`,
    });
    const items =
      syncs && maps
        ? [
            ...maps.map((mp) => ({
              id: `map:${mp.id}`,
              href: `/map/${mp.id}`,
              title: mp.name,
              icon: "layers" as const,
              updated_at: mp.updated_at,
              badges: [{ label: "saved map", tone: "ok" as const }],
              detail: mp.layers.map((l) => l.name).join(" · ") || "No layers yet",
              meta: `${mp.layers.length} layer${mp.layers.length === 1 ? "" : "s"}`,
            })),
            ...own.map(syncItem),
            ...demos.map(syncItem),
          ]
        : null;
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        // a sync opens in place (the address changes without a page load), as the old list did
        onClickCapture={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          const m = a?.getAttribute("href")?.match(/^\/map\?sync=(.+)$/);
          if (!m || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          open(m[1]);
        }}
      >
        <AppHome
          app="Map"
          icon="globe"
          accent="#0d9488"
          href="/map"
          tagline="Saved maps of layers, and the tracks your pipelines send as geotemporal series."
          description={
            <>
              A saved map combines layers: objects with geopoint, geoshape or geotemporal series reference properties, tracks of geotemporal series syncs, Enterprise Map
              Layers, search templates, GeoTIFF rasters and boundaries. A geotemporal series sync holds the tracks the <span className="text-soft">geotemporal series sync</span>{" "}
              output of a pipeline sends; open one to pick a time and see each series&apos; trail and position. Streaming syncs refresh every 10 s.
            </>
          }
          headerActions={
            <Link href="/map/admin" className={`${buttonClass.ghost} py-1 text-xs`} title="Enterprise Map Layers and search templates">
              <Icon name="sliders" className="h-3.5 w-3.5" /> Curated sources
            </Link>
          }
          noun={["map", "maps"]}
          error={missing ? "That map no longer exists. Pick another." : !syncs ? error : null}
          items={items}
          empty={{ title: "Make your first map", hint: "Start a saved map of layers, or send a pipeline's tracks to a geotemporal series sync.", steps: ["Create a map", "Add object, track or raster layers", "Pick a time and explore"] }}
          create={
            <>
              <Link href="/map/new" className={buttonClass.primary}>
                <Icon name="plus" className="h-3.5 w-3.5" /> New map
              </Link>
              <button type="button" onClick={() => setCreating(true)} className={buttonClass.secondary} title="Send a pipeline's tracks to a geotemporal series sync">
                <Icon name="pipeline" className="h-3.5 w-3.5" /> New geotemporal sync
              </button>
            </>
          }
        >
          {geoTypes.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Objects with geospatial time series</h2>
              <div className="flex flex-wrap gap-2">
                {geoTypes.map((t) => (
                  <button key={t.id} type="button" onClick={() => openObjects(t.id)} className={`${buttonClass.secondary} py-1 text-xs`}>
                    <Icon name="cube" className="h-3.5 w-3.5" /> {t.display_name} <span className="text-muted">{t.object_count}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </AppHome>
        {creating && <NewMapDialog onClose={() => setCreating(false)} />}
      </div>
    );
  }
  if (error && !syncs) return <ApiError message={error} />;
  if (!syncs) return <Loading />;
  const geoType = objectsType ? geoTypes.find((t) => t.id === objectsType) : undefined;
  // objects with geospatial time series draw like a geotemporal sync whose series are the objects
  const sync: SeriesSync | undefined = geoType
    ? ({ id: `objects:${geoType.id}`, name: geoType.display_name, kind: "geotemporal", mode: "batch", pipeline_id: "", series: geoType.object_count } as unknown as SeriesSync)
    : syncId
      ? syncs.find((s) => s.id === syncId)
      : undefined;
  const option = (s: SeriesSync) => (
    <option key={s.id} value={s.id}>
      {builtIn(s) ? s.name : `${s.name} · ${s.pipeline_name || "pipeline"} (${s.mode})`}
    </option>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-sm">
        {sync && (
          <button type="button" onClick={() => open("")} className={`${buttonClass.secondary} py-1 text-xs`} title="Back to the list of maps">
            <Icon name="left" className="h-3.5 w-3.5" /> All maps
          </button>
        )}
        <span className="mr-2 flex items-center gap-1.5 font-medium">
          <Icon name="globe" className="h-4 w-4 text-ocean" /> Map
        </span>
        {sync && geoType && <span className="text-xs text-soft">{geoType.display_name} · objects with geospatial time series</span>}
        {sync && !geoType && (
          <select value={sync.id} onChange={(e) => open(e.target.value, true)} className={`${inputClass} w-auto min-w-0 max-w-sm py-1 text-xs`}>
            {own.length > 0 && demos.length > 0 ? (
              <>
                <optgroup label="Your syncs">{own.map(option)}</optgroup>
                <optgroup label="Built-in demos">{demos.map(option)}</optgroup>
              </>
            ) : (
              syncs.map(option)
            )}
          </select>
        )}
        <span className="ml-auto" />
        {sync && geoType ? (
          <Link href={`/time-series/object-types/${geoType.id}`} className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="wave" className="h-3.5 w-3.5" /> Time series
          </Link>
        ) : sync ? (
          <>
            {!isDemo(sync) && sync.pipeline_id && (
              <Link href={`/pipeline/${sync.pipeline_id}`} className={`${buttonClass.secondary} py-1 text-xs`} title={`Written by ${sync.pipeline_name || "a pipeline"}`}>
                <Icon name="pipeline" className="h-3.5 w-3.5" /> {sync.mode === "streaming" ? "Streaming pipeline" : "Pipeline"}
              </Link>
            )}
            <Link href={`/time-series/${sync.id}`} className={`${buttonClass.secondary} py-1 text-xs`}>
              <Icon name="list" className="h-3.5 w-3.5" /> Details
            </Link>
            <Link href={monitorHref(sync)} className={`${buttonClass.secondary} py-1 text-xs`}>
              <Icon name="bell" className="h-3.5 w-3.5" /> Monitor
            </Link>
          </>
        ) : (
          <>
            <Link href="/map/admin" className={`${buttonClass.ghost} py-1 text-xs`} title="Enterprise Map Layers and search templates">
              <Icon name="sliders" className="h-3.5 w-3.5" /> Curated sources
            </Link>
            <button type="button" onClick={() => setCreating(true)} className={`${buttonClass.secondary} py-1 text-xs`} title="Send a pipeline's tracks to a geotemporal series sync">
              <Icon name="pipeline" className="h-3.5 w-3.5" /> New geotemporal sync
            </button>
            <Link href="/map/new" className={`${buttonClass.primary} py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New map
            </Link>
          </>
        )}
      </nav>
      {sync ? (
        <SyncMap
          key={sync.id}
          sync={sync}
          only={onlySeries}
          onOnly={setOnlySeries}
          loader={geoType ? () => tsOntology.objectTracks(geoType.id) : undefined}
        />
      ) : (
        <Loading />
      )}
      {creating && <NewMapDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

/** New geotemporal series sync: the geotemporal series sync output of a pipeline; pick the pipeline to add it to, or start one. */
function NewMapDialog({ onClose }: { onClose: () => void }) {
  const [pipelines, setPipelines] = useState<DriveItem[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    api.pipelineData.files().then(setPipelines, () => setPipelines([]));
  }, []);
  const shown = (pipelines ?? []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="New geotemporal series sync" icon="globe" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>Open a pipeline (batch, or streaming for a live map).</li>
          <li>
            Add an output → <span className="text-soft">New geotemporal series sync</span>, and pick its series id, timestamp, latitude and longitude columns.
          </li>
          <li>Deploy it (a streaming pipeline keeps sending). It then shows up here under Your geotemporal series syncs, and as a data source for saved maps.</li>
        </ol>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pipelines" className={inputClass} />
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {!pipelines && <li className="px-3 py-4 text-center text-xs text-muted">Loading…</li>}
          {pipelines && !shown.length && <li className="px-3 py-4 text-center text-xs text-muted">{pipelines.length ? "No pipelines match." : "No pipelines yet."}</li>}
          {shown.map((p) => (
            <li key={p.id}>
              <Link href={`/pipeline/${p.id}`} className="flex items-center gap-2 px-3 py-2 hover:bg-panel-2">
                <Icon name="pipeline" className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="truncate">{pipelineName(p.name)}</span>
                <Icon name="right" className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Link href="/pipeline" className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New pipeline
          </Link>
        </div>
      </div>
    </Modal>
  );
}

function SyncMap({
  sync,
  only,
  onOnly,
  loader,
}: {
  sync: SeriesSync;
  only: string;
  onOnly: (s: string) => void;
  /** another source of observations (objects with geospatial time series) */
  loader?: () => Promise<{ total: number; truncated: boolean; observations: Observation[] }>;
}) {
  const [data, setData] = useState<{ total: number; truncated: boolean; observations: Observation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [time, setTime] = useState<number | null>(null); // null = latest
  const [basemap, setBasemap] = useState<Basemap>("google-satellite");
  const [trail, setTrail] = useState(true);
  const [picked, setPicked] = useState<Observation | null>(null);
  const load = useCallback(
    () => (loader ? loader() : timeseries.observations(sync.id, { series: only || undefined, limit: 50_000 })).then(setData, (e: Error) => setError(e.message)),
    // the loader is fixed for a map (the component is keyed by it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync.id, only],
  );
  useEffect(() => {
    load();
    if (sync.mode !== "streaming") return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, sync.mode]);

  const obs = useMemo(() => (data?.observations ?? []).map((o) => ({ ...o, ms: new Date(o.t).getTime() })), [data]);
  const series = useMemo(() => {
    const m = new Map<string, typeof obs>();
    for (const o of obs) (m.get(o.series_id) ?? m.set(o.series_id, []).get(o.series_id)!).push(o);
    return [...m.entries()].map(([id, list], i) => ({ id, list, color: COLORS[i % COLORS.length] }));
  }, [obs]);
  const tMin = obs[0]?.ms ?? 0;
  const tMax = obs[obs.length - 1]?.ms ?? 0;
  const at = time ?? tMax;

  // the map's viewport
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const [view, setView] = useState<View | null>(null);
  const fit = useCallback(() => {
    if (!obs.length) return setView({ z: 1, cx: worldX(0, 1), cy: worldY(20, 1) });
    const lats = obs.map((o) => o.latitude);
    const lons = obs.map((o) => o.longitude);
    const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    let z = 17;
    while (z > 1 && (worldX(lo1, z) - worldX(lo0, z) > size.w * 0.85 || worldY(la0, z) - worldY(la1, z) > size.h * 0.85)) z--;
    setView({ z, cx: (worldX(lo0, z) + worldX(lo1, z)) / 2, cy: (worldY(la0, z) + worldY(la1, z)) / 2 });
  }, [obs, size.w, size.h]);
  // fit to the data once it loads and whenever the map is resized, until the user pans or zooms
  const moved = useRef(false);
  const fittedFor = useRef("");
  useEffect(() => {
    const sizeKey = `${Math.round(size.w)}x${Math.round(size.h)}`;
    if (data && !moved.current && fittedFor.current !== sizeKey) {
      fittedFor.current = sizeKey;
      fit();
    }
  }, [data, fit, size.w, size.h]);

  const v = view ?? { z: 1, cx: worldX(0, 1), cy: worldY(20, 1) };
  const px = (lon: number) => worldX(lon, v.z) - v.cx + size.w / 2;
  const py = (lat: number) => worldY(lat, v.z) - v.cy + size.h / 2;
  const zoom = (dz: number, ax = size.w / 2, ay = size.h / 2) =>
    setView((cur) => {
      moved.current = true;
      const c = cur ?? v;
      const z = Math.max(1, Math.min(18, c.z + dz));
      const f = 2 ** (z - c.z);
      // keep the point under the cursor in place
      const wx = c.cx + ax - size.w / 2;
      const wy = c.cy + ay - size.h / 2;
      return { z, cx: wx * f - (ax - size.w / 2), cy: wy * f - (ay - size.h / 2) };
    });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const { base: gBase, overlay: gOverlay } = useGoogleSessions(basemap === "google-hybrid" ? "hybrid" : basemap === "google-satellite" ? "satellite" : null);
  const tiles = useMemo(() => {
    if (basemap === "none") return [];
    if ((basemap === "google-satellite" || basemap === "google-hybrid") && (!gBase || (basemap === "google-hybrid" && !gOverlay))) return [];
    const tile = basemap === "google-satellite" || basemap === "google-hybrid"
      ? googleTileUrl(gBase!)
      : BASEMAPS[basemap as keyof typeof BASEMAPS].url;
    const overlayTile = basemap === "google-hybrid" && gOverlay ? googleTileUrl(gOverlay) : null;
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
  }, [basemap, v.z, v.cx, v.cy, size.w, size.h, gBase, gOverlay]);

  const visible = series.filter((s) => !hidden.has(s.id));
  const positions = visible
    .map((s) => {
      let last: (typeof obs)[number] | undefined;
      for (const o of s.list) {
        if (o.ms > at) break;
        last = o;
      }
      return last ? { s, o: last } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  if (error && !data) return <ApiError message={error} />;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1 overflow-hidden bg-ink" ref={box}>
        <div
          className="absolute inset-0 cursor-grab select-none active:cursor-grabbing"
          onWheel={(e) => {
            const r = box.current!.getBoundingClientRect();
            zoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
          }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, cx: v.cx, cy: v.cy };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) {
              moved.current = true;
              setView({ z: v.z, cx: d.cx - (e.clientX - d.x), cy: d.cy - (e.clientY - d.y) });
            }
          }}
          onPointerUp={() => (drag.current = null)}
        >
          {tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={t.key}
              src={t.src}
              alt=""
              draggable={false}
              // offline or blocked tiles: leave the dark background rather than broken-image boxes
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              className={`pointer-events-none absolute ${basemap === "google-satellite" || basemap === "google-hybrid" ? "opacity-90" : "opacity-80"}`}
              style={{ left: t.left, top: t.top, width: TILE, height: TILE }}
            />
          ))}
              {tiles.filter((t) => t.overlay).map((t) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={`${t.key}/overlay`} src={t.overlay} alt="" draggable={false} className="pointer-events-none absolute" style={{ left: t.left, top: t.top, width: TILE, height: TILE }} />
              ))}
          <svg width={size.w} height={size.h} className="absolute inset-0">
            {trail &&
              visible.map((s) => {
                const pts = s.list.filter((o) => o.ms <= at);
                return pts.length > 1 ? (
                  <polyline key={s.id} points={pts.map((o) => `${px(o.longitude).toFixed(1)},${py(o.latitude).toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeOpacity={0.75} strokeLinejoin="round" />
                ) : null;
              })}
            {positions.map(({ s, o }) => (
              <g key={s.id} transform={`translate(${px(o.longitude)},${py(o.latitude)})`} className="cursor-pointer" onPointerDown={(e) => (e.stopPropagation(), setPicked(o))}>
                <circle r={7} fill={s.color} stroke="#0b1220" strokeWidth={2} />
                <text x={10} y={4} className="fill-white text-[11px]" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
                  {label(o)}
                </text>
              </g>
            ))}
          </svg>
        </div>
        <div className="absolute right-3 top-3 flex flex-col gap-1">
          <button type="button" onClick={() => zoom(1)} className={`${buttonClass.secondary} px-2 py-1`} aria-label="Zoom in">
            <Icon name="plus" className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => zoom(-1)} className={`${buttonClass.secondary} px-2 py-1`} aria-label="Zoom out">
            <Icon name="minus" className="h-4 w-4" />
          </button>
          <button type="button" onClick={fit} className={`${buttonClass.secondary} px-2 py-1`} aria-label="Fit to data" title="Fit to data">
            <Icon name="fit" className="h-4 w-4" />
          </button>
        </div>
        <div className="absolute left-3 top-3 flex overflow-hidden rounded-md border border-line bg-panel/90 text-xs">
          {([...Object.keys(BASEMAPS), "google-satellite", "google-hybrid", "none"] as Basemap[]).map((b) => (
            <button key={b} type="button" onClick={() => setBasemap(b)} className={`px-2.5 py-1 ${basemap === b ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
              {b === "none" ? "None" : b in BASEMAPS ? BASEMAPS[b as keyof typeof BASEMAPS].label : GOOGLE_LABEL[b]}
            </button>
          ))}
        </div>
        {basemap !== "none" && <div className="absolute bottom-1 right-2 rounded bg-ink/70 px-1 text-[10px] text-soft">{basemap in BASEMAPS ? BASEMAPS[basemap as keyof typeof BASEMAPS].credit : "Imagery © Google"}</div>}
        {!data && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loading />
          </div>
        )}
        {data && !obs.length && <div className="absolute inset-x-0 top-1/2 text-center text-sm text-muted">No observations{only ? ` for ${only}` : ""} yet.</div>}
      </div>
      <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel text-sm">
        <div className="space-y-2 border-b border-line p-3">
          <div className="text-xs text-muted">
            {data ? `${data.observations.length.toLocaleString()} of ${data.total.toLocaleString()} observations${data.truncated ? " (newest)" : ""}` : "…"} · {series.length} series ·{" "}
            {sync.last_write_at ? `last sent ${when(sync.last_write_at)}` : "nothing sent yet"}
          </div>
          {obs.length > 1 && (
            <div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Time</span>
                <span className="font-mono">{new Date(at).toISOString().slice(0, 19).replace("T", " ")}</span>
              </div>
              <input
                type="range"
                min={tMin}
                max={tMax}
                value={at}
                onChange={(e) => setTime(Number(e.target.value) >= tMax ? null : Number(e.target.value))}
                className="w-full accent-[var(--color-ocean)]"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>{new Date(tMin).toISOString().slice(0, 16).replace("T", " ")}</span>
                <button type="button" onClick={() => setTime(null)} className="hover:text-white">
                  latest
                </button>
              </div>
            </div>
          )}
          <div className="flex gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={trail} onChange={(e) => setTrail(e.target.checked)} className="accent-[var(--color-ocean)]" /> Trails
            </label>

            {only && (
              <button type="button" onClick={() => onOnly("")} className="ml-auto text-ocean hover:underline">
                All series
              </button>
            )}
          </div>
        </div>
        {picked && (
          <div className="border-b border-line p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono font-medium">{picked.series_id}</span>
              <button type="button" onClick={() => setPicked(null)} aria-label="Close">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="text-muted">{picked.t.slice(0, 19).replace("T", " ")}</div>
            <div className="font-mono">
              {picked.latitude.toFixed(5)}, {picked.longitude.toFixed(5)}
            </div>
            {Object.entries(picked.properties).map(([k, val]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted">{k}</span>
                <span className="truncate">{String(val)}</span>
              </div>
            ))}
          </div>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {series.map((s) => {
            const pos = positions.find((p) => p.s.id === s.id);
            return (
              <li key={s.id} className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={!hidden.has(s.id)}
                  onChange={() => setHidden((h) => (h.has(s.id) ? new Set([...h].filter((x) => x !== s.id)) : new Set([...h, s.id])))}
                  className="accent-[var(--color-ocean)]"
                />
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                <button
                  type="button"
                  onClick={() => pos && setView({ z: Math.max(v.z, 10), cx: worldX(pos.o.longitude, Math.max(v.z, 10)), cy: worldY(pos.o.latitude, Math.max(v.z, 10)) })}
                  className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:text-ocean"
                  title="Center on its position"
                >
                  {label(s.list[s.list.length - 1]) !== s.id ? (
                    <>
                      <span className="font-sans">{label(s.list[s.list.length - 1])}</span> <span className="text-muted">{s.id}</span>
                    </>
                  ) : (
                    s.id
                  )}
                </button>
                <span className="text-[10px] text-muted">{s.list.length}</span>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
