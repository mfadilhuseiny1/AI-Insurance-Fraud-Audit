"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { Icon } from "@/components/Icon";
import { DataSources, LAYER_COLORS, type MapTools } from "@/components/map/DataSources";
import { MapCanvas, type Basemap, type Bounds, type Drawn, type MapHandle, type Projection } from "@/components/map/MapCanvas";
import { PairControl } from "@/components/map/PairControl";
import { useLayerData, type LayerData } from "@/components/map/useLayerData";
import { VectorTileLayer, type VectorTileStatus } from "@/components/map/VectorTileLayer";
import type { VectorColorBy } from "@/components/map/vectorTileStyle";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { selectionByType, usePairing, type ObjectRef } from "@/lib/appPairing";
import { chooseDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { geoApi, LAYER_KIND_LABEL, positions, type Feature, type GeoJSONGeometry, type GeoObjectType, type Layer, type SavedMap } from "@/lib/geo";
import { formatValue, type Property } from "@/lib/ontology";
import type { Observation } from "@/lib/timeseries";
import { vertex, type GraphRow } from "@/lib/vertex";

/**
 * A saved map (Gaia-style): layers from the Ontology (object searches over geopoint / geoshape properties, objects
 * with a geotemporal series reference drawn at their live position), geotemporal series syncs (tracks and
 * observations), curated sources (Enterprise Map Layers, search templates), rasters and boundaries. /map/new creates
 * one (?object_type=&pk= starts it with that object; ?sync= with that sync's tracks).
 */
export default function MapPage() {
  const { mapId } = useParams<{ mapId: string }>();
  return mapId === "new" ? <NewMap /> : <MapEditor id={mapId} />;
}

function NewMap() {
  const router = useRouter();
  const qs = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const typeId = qs.get("object_type");
    const pk = qs.get("pk");
    const sync = qs.get("sync");
    const layers: Partial<Layer>[] = [];
    if (typeId && pk) layers.push({ name: pk, kind: "dropped", color: LAYER_COLORS[0], visible: true, opacity: 1, config: { object_type_id: typeId, primary_keys: [pk] } });
    if (sync) layers.push({ name: "Tracks", kind: "tracks", color: LAYER_COLORS[1], visible: true, opacity: 1, config: { sync_id: sync, mode: "live", minutes: 1440, area: { mode: "all" } } });
    geoApi
      .createMap({ name: qs.get("name") || (pk ? `Map of ${pk}` : "Untitled map"), layers: layers as Layer[] })
      .then((m) => router.replace(`/map/${m.id}`), (e: Error) => setError(e.message));
  }, [qs, router]);
  return error ? <ApiError message={error} /> : <Loading label="Creating map…" />;
}

type Selection =
  | { kind: "feature"; layer: Layer; feature: Feature }
  | { kind: "observation"; layer: Layer; obs: Observation }
  | { kind: "region"; layer: Layer; region: { id: unknown; name: unknown; value: number | null } };

/** the layer that holds objects a paired window selected (or an add command named) that were not on the map */
const PAIRED_LAYER = "Paired objects";

const ROLLING = [
  [15, "15 min"],
  [60, "1 h"],
  [360, "6 h"],
  [1440, "24 h"],
  [10080, "7 d"],
  [0, "All"],
] as const;

function MapEditor({ id }: { id: string }) {
  const [m, setM] = useState<SavedMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [tab, setTab] = useState<"layers" | "sources">("layers");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [draw, setDraw] = useState<"polygon" | "circle" | null>(null);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mapRef = useRef<MapHandle>(null);
  const drawResolve = useRef<((d: Drawn | null) => void) | null>(null);
  const pickResolve = useRef<((g: GeoJSONGeometry | null) => void) | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    geoApi.map(id).then(setM, (e: Error) => setError(e.message));
  }, [id]);
  // autosave
  useEffect(() => {
    if (!m) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    setSaveState("saving");
    const t = setTimeout(
      () =>
        geoApi.saveMap(m.id, { name: m.name, description: m.description, basemap: m.basemap, view: m.view, layers: m.layers }).then(
          () => setSaveState("saved"),
          (e: Error) => (setSaveState("error"), setNotice(e.message)),
        ),
      700,
    );
    return () => clearTimeout(t);
  }, [m]);

  const update = (c: Partial<SavedMap>) => setM((cur) => (cur ? { ...cur, ...c } : cur));
  const setLayers = (fn: (ls: Layer[]) => Layer[]) => setM((cur) => (cur ? { ...cur, layers: fn(cur.layers) } : cur));

  const [emlRefresh, setEmlRefresh] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (m?.layers.some((l) => l.kind === "eml")) geoApi.emls().then((es) => setEmlRefresh(Object.fromEntries(es.map((e) => [e.id, e.refresh_seconds ?? null]))), () => {});
  }, [m?.layers]);
  const layers = useMemo(() => m?.layers ?? [], [m?.layers]);
  const data = useLayerData(layers, emlRefresh);
  // vector tile layers report their tiles / features / legend from the canvas
  const [vtStatus, setVtStatus] = useState<Record<string, VectorTileStatus>>({});
  const onVtStatus = useCallback((id: string, s: VectorTileStatus) => setVtStatus((cur) => (JSON.stringify(cur[id]) === JSON.stringify(s) ? cur : { ...cur, [id]: s })), []);
  // "Retry now" on a vector tile layer's failed tiles
  const [vtRetry, setVtRetry] = useState<Record<string, number>>({});

  const layerCount = m?.layers.length ?? 0;
  const tools: MapTools = {
    bounds: () => mapRef.current?.bounds() ?? [-180, -85, 180, 85],
    draw: (kind) =>
      new Promise((resolve) => {
        drawResolve.current = resolve;
        setDraw(kind);
      }),
    select: () =>
      new Promise((resolve) => {
        pickResolve.current = resolve;
        setPicking(true);
      }),
    nextColor: () => LAYER_COLORS[layerCount % LAYER_COLORS.length],
  };
  const onDrawn = useCallback((d: Drawn | null) => {
    setDraw(null);
    drawResolve.current?.(d);
    drawResolve.current = null;
  }, []);
  useEffect(() => {
    if (!picking) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicking(false);
        pickResolve.current?.(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [picking]);

  const clickFeature = (layer: Layer, f: Feature) => {
    if (picking) {
      if (/Polygon/.test(f.geometry.type)) {
        setPicking(false);
        pickResolve.current?.(f.geometry);
        pickResolve.current = null;
      } else setNotice("Pick a polygon (a geoshape) to search inside it.");
      return;
    }
    selectLocal({ kind: "feature", layer, feature: f });
  };

  // objects dragged in (Ontology Manager rows carry "object:<type id>:<primary key>")
  const onDrop = async (dt: DataTransfer) => {
    const text = dt.getData("text/plain");
    const mm = /^object:([^:]+):(.+)$/.exec(text.trim());
    if (!mm || !m) return setNotice("Drop objects dragged from Nexus Manager's Objects table.");
    const [, typeId, pk] = mm;
    const { duplicates } = await geoApi.duplicates(m.id, typeId, [pk]).catch(() => ({ duplicates: [] as string[] }));
    if (duplicates.length) {
      const c = await chooseDialog({
        title: "Already on the map",
        message: `${pk} is already on this map.`,
        choices: [
          { id: "exclude", label: "Exclude duplicates", primary: true },
          { id: "include", label: "Include anyway" },
        ],
      });
      if (c !== "include") return;
    }
    setLayers((ls) => {
      const existing = ls.find((l) => l.kind === "dropped" && l.config.object_type_id === typeId && l.name.startsWith("Dropped objects"));
      if (existing)
        return ls.map((l) => (l === existing ? { ...l, config: { ...l.config, primary_keys: [...((l.config.primary_keys as string[]) ?? []), pk] } } : l));
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      return [...ls, { id: "l-" + Math.random().toString(16).slice(2, 10), name: `Dropped objects ${stamp}`, kind: "dropped", visible: true, opacity: 1, color: tools.nextColor(), config: { object_type_id: typeId, primary_keys: [pk] } }];
    });
  };

  // tracks: a shared time slider
  const trackTimes = useMemo(() => {
    let lo = Infinity,
      hi = -Infinity;
    for (const l of layers)
      if (l.visible && l.kind === "tracks")
        for (const o of data[l.id]?.observations ?? []) {
          const t = Date.parse(o.t);
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
    return Number.isFinite(lo) ? { lo, hi } : null;
  }, [layers, data]);
  const at = time ?? trackTimes?.hi ?? 0;

  const layerBounds = (l: Layer): Bounds | null => {
    // a vector tile layer's extent comes from its TileJSON (bounds), when it was read
    if (isVector(l)) {
      const b = Array.isArray(l.config.bounds) ? l.config.bounds.map(Number) : [];
      return b.length === 4 && b.every(Number.isFinite) ? (b as Bounds) : null;
    }
    const d = data[l.id];
    const pts: number[][] = [];
    d?.features?.forEach((f) => pts.push(...positions(f.geometry)));
    d?.observations?.forEach((o) => pts.push([o.longitude, o.latitude]));
    d?.regions?.features.forEach((r) => pts.push(...positions(r.geometry)));
    d?.rasters?.forEach((r) => pts.push([r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]));
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const earthPoints = useMemo(() => {
    const out: { lat: number; lng: number; label?: string }[] = [];
    for (const l of layers) {
      if (!l.visible) continue;
      for (const f of data[l.id]?.features ?? []) {
        const pos = positions(f.geometry)[0];
        if (pos) out.push({ lng: pos[0], lat: pos[1], label: f.title });
      }
      for (const o of data[l.id]?.observations ?? []) out.push({ lng: o.longitude, lat: o.latitude });
    }
    return out.slice(0, 500);
  }, [layers, data]);
  // fit once every visible layer has loaded, on a map that has no saved view
  const fitted = useRef(false);
  // a link can open the map on an area: ?bbox=min lon,min lat,max lon,max lat (e.g. from the JKN national IoT map)
  const bboxParam = useSearchParams().get("bbox");
  const bboxDone = useRef(false);
  useEffect(() => {
    if (!m || !bboxParam || bboxDone.current) return;
    const b = bboxParam.split(",").map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite)) return;
    bboxDone.current = true;
    fitted.current = true;
    const t = setTimeout(() => mapRef.current?.fit(b as Bounds), 60);
    return () => clearTimeout(t);
  }, [m, bboxParam]);
  useEffect(() => {
    if (fitted.current || !m || m.view) return;
    if (m.layers.some((l) => l.visible && (!data[l.id] || data[l.id].loading))) return;
    const bs = m.layers.filter((l) => l.visible).map(layerBounds).filter((b): b is Bounds => !!b);
    if (!bs.length) return;
    fitted.current = true;
    mapRef.current?.fit([Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, m]);

  // App Pairing (the map plays Gaia's role): the selected object syncs with paired Workshop modules and windows, and
  // paired / embedding windows send commands (select, zoom to, add objects, clear)
  const [addIncoming, setAddIncoming] = useState(false);
  const pending = useRef<{ refs: ObjectRef[]; select: boolean } | null>(null);
  const findFeatures = (refs: ObjectRef[]) => {
    const want = new Set(refs.map((r) => `${r.object_type_id}/${r.primary_key}`));
    const out: { layer: Layer; feature: Feature }[] = [];
    const seen = new Set<string>();
    for (const l of layers)
      for (const f of l.visible ? (data[l.id]?.features ?? []) : []) {
        const k = trackKey(f);
        if (want.has(k) && !seen.has(k)) {
          seen.add(k);
          out.push({ layer: l, feature: f });
        }
      }
    // in the order asked for
    return out.sort((a, b) => refs.findIndex((r) => r.primary_key === a.feature.primary_key) - refs.findIndex((r) => r.primary_key === b.feature.primary_key));
  };
  const focusOn = (fs: { feature: Feature }[]) => {
    const pts = fs.flatMap((x) => positions(x.feature.geometry));
    if (!pts.length) return;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const b: Bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    fitted.current = true;
    if (b[2] - b[0] < 1e-4 && b[3] - b[1] < 1e-4) mapRef.current?.center(b[0], b[1]);
    else mapRef.current?.fit(b);
  };
  const addObjects = (refs: ObjectRef[]) =>
    setLayers((ls) => {
      let next = ls;
      for (const [typeId, pks] of Object.entries(selectionByType(refs))) {
        const existing = next.find((l) => l.kind === "dropped" && l.config.object_type_id === typeId && l.name === PAIRED_LAYER);
        if (existing) {
          const have = (existing.config.primary_keys as string[]) ?? [];
          next = next.map((l) => (l === existing ? { ...l, visible: true, config: { ...l.config, primary_keys: [...have, ...pks.filter((pk) => !have.includes(pk))] } } : l));
        } else
          next = [...next, { id: "l-" + Math.random().toString(16).slice(2, 10), name: PAIRED_LAYER, kind: "dropped", visible: true, opacity: 1, color: LAYER_COLORS[next.length % LAYER_COLORS.length], config: { object_type_id: typeId, primary_keys: pks } }];
      }
      return next;
    });
  /** Shows objects a paired window selected or a command named: selects the first, zooms to them; objects not on the
   * map are added to a "Paired objects" layer when asked (the add command, or "Add selected objects") and shown once loaded. */
  const showObjects = (refs: ObjectRef[], mode: "select" | "focus" | "add", quiet = false): boolean => {
    if (!refs.length) return false;
    const found = findFeatures(refs);
    const missing = refs.filter((r) => !found.some((x) => x.feature.object_type_id === r.object_type_id && x.feature.primary_key === r.primary_key));
    if (mode === "select" && found.length) setSelection({ kind: "feature", ...found[0] });
    if (found.length) focusOn(found);
    if (missing.length && (mode === "add" || addIncoming)) {
      addObjects(missing);
      pending.current = { refs, select: mode === "select" && !found.length };
      return true;
    }
    // a paired window's selection of objects this map does not show is ignored quietly (a command says so)
    if (!found.length && !quiet) setNotice(`${refs.map((r) => r.primary_key).slice(0, 3).join(", ")}${refs.length > 3 ? "…" : ""} ${refs.length === 1 ? "is" : "are"} not on this map.`);
    return found.length > 0;
  };
  // objects added for a paired window: select / zoom once their layer has loaded
  useEffect(() => {
    const p = pending.current;
    if (!p || layers.some((l) => l.visible && (!data[l.id] || data[l.id].loading))) return;
    pending.current = null;
    const found = findFeatures(p.refs);
    if (!found.length) return setNotice(`${p.refs.map((r) => r.primary_key).slice(0, 3).join(", ")} ${p.refs.length === 1 ? "has" : "have"} no location to show on the map.`);
    if (p.select) setSelection({ kind: "feature", ...found[0] });
    focusOn(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layers]);
  const pairing = usePairing("map", {
    onSelection: (typeId, pks) => {
      if (!pks.length) {
        setSelection((s) => (s?.kind === "feature" && s.feature.object_type_id === typeId ? null : s));
        return;
      }
      showObjects(pks.map((pk) => ({ object_type_id: typeId, primary_key: pk })), "select", true);
    },
    onCommand: (cmd) => {
      if (cmd.name === "clear") return void setSelection(null);
      return showObjects(cmd.objects, cmd.name);
    },
  });
  /** a selection made here (a click, closing the panel) goes to the paired windows */
  const selectLocal = (s: Selection | null) => {
    setSelection(s);
    pairing.publish(s?.kind === "feature" && !s.feature.object_type_id.startsWith("ext:") ? [{ object_type_id: s.feature.object_type_id, primary_key: s.feature.primary_key }] : []);
  };

  if (error) return <ApiError message={error} />;
  if (!m) return <Loading />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-sm">
        <Link href="/map" className={`${buttonClass.secondary} py-1 text-xs`} title="All maps">
          <Icon name="left" className="h-3.5 w-3.5" /> All maps
        </Link>
        <Icon name="globe" className="h-4 w-4 shrink-0 text-ocean" />
        <input value={m.name} onChange={(e) => update({ name: e.target.value })} className="min-w-0 max-w-sm flex-1 rounded bg-transparent px-1 py-0.5 font-medium outline-none hover:bg-panel-2 focus:bg-ink" />
        <span className="text-[11px] text-muted">{saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}</span>
        <span className="ml-auto" />
        <PairControl pairing={pairing} addIncoming={addIncoming} setAddIncoming={setAddIncoming} what="map" />
        <Link href="/map/admin" className={`${buttonClass.ghost} py-1 text-xs`} title="Enterprise Map Layers and search templates">
          <Icon name="sliders" className="h-3.5 w-3.5" /> Curated sources
        </Link>
      </nav>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex border-b border-line text-xs">
            {(
              [
                ["layers", "Map layers"],
                ["sources", "Data sources"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`flex-1 px-3 py-2 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === "sources" ? (
            <DataSources tools={tools} onAdd={(l) => setLayers((ls) => [...ls, l])} onClose={() => setTab("layers")} />
          ) : (
            <LayersPanel
              layers={m.layers}
              data={data}
              vtStatus={vtStatus}
              onVtRetry={(id) => setVtRetry((cur) => ({ ...cur, [id]: (cur[id] ?? 0) + 1 }))}
              onChange={(ls) => setLayers(() => ls)}
              onFit={(l) => mapRef.current?.fit(layerBounds(l))}
              onAdd={() => setTab("sources")}
            />
          )}
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <MapCanvas
            handle={mapRef}
            basemap={(m.basemap as Basemap) || "google-satellite"}
            onBasemap={(b) => update({ basemap: b })}
            initial={m.view}
            onMove={(_, v) => {
              const same = m.view && Math.abs(m.view.lat - v.lat) < 1e-6 && Math.abs(m.view.lon - v.lon) < 1e-6 && m.view.zoom === v.zoom;
              if (!same && (fitted.current || m.view)) update({ view: v });
            }}
            earthPoints={earthPoints}
            draw={draw}
            onDrawn={onDrawn}
            onDrop={onDrop}
            overlays={(p) => (
              <>
                {m.layers.filter((l) => l.visible && l.kind === "tiles" && !isVector(l)).map((l) => (
                  <TileLayer key={l.id} p={p} template={String(l.config.url ?? "")} opacity={l.opacity} maxZoom={Number(l.config.max_zoom) || 19} />
                ))}
                {m.layers.filter((l) => l.visible && l.kind === "raster").map((l) =>
                  (data[l.id]?.rasters ?? []).map((r) => {
                    const lon = (x: number) => (x / 6378137) * (180 / Math.PI);
                    const lat = (y: number) => (Math.atan(Math.sinh(y / 6378137)) * 180) / Math.PI;
                    const [x0, y0, x1, y1] = r.mercator;
                    const left = p.px(lon(x0));
                    const top = p.py(lat(y1));
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={`${l.id}/${r.key}`}
                        src={r.url}
                        alt=""
                        draggable={false}
                        className="pointer-events-none absolute"
                        style={{ left, top, width: p.px(lon(x1)) - left, height: p.py(lat(y0)) - top, opacity: l.opacity, imageRendering: p.z > 14 ? "pixelated" : "auto" }}
                      />
                    );
                  }),
                )}
              </>
            )}
            corner={
              <>
                {picking && (
                  <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-ocean/50 bg-panel/95 px-3 py-1.5 text-xs text-soft">
                    Click a shape on the map to search inside it. Esc cancels.
                  </div>
                )}
                {notice && (
                  <button type="button" onClick={() => setNotice(null)} className="absolute bottom-6 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-line bg-panel/95 px-3 py-1.5 text-xs text-soft">
                    {notice} <span className="text-muted">(dismiss)</span>
                  </button>
                )}
                {!m.layers.length && (
                  <div className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted">
                    Add layers from <span className="text-soft">Data sources</span>, or drag objects here from Nexus Manager.
                  </div>
                )}
              </>
            }
          >
            {(p) => (
              <>
                {m.layers.map((l) =>
                  !l.visible ? null : isVector(l) ? (
                    <VectorLayer key={l.id} layer={l} p={p} selection={selection} retryNonce={vtRetry[l.id] ?? 0} onFeature={clickFeature} onStatus={onVtStatus} />
                  ) : (
                    <LayerShapes key={l.id} layer={l} d={data[l.id]} p={p} at={at} selection={selection} onFeature={clickFeature} onSelect={selectLocal} />
                  ),
                )}
                {selection?.kind === "feature" && <SelectedTrack selection={selection} p={p} />}
              </>
            )}
          </MapCanvas>
          {trackTimes && trackTimes.hi > trackTimes.lo && (
            <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-1.5 text-xs">
              <Icon name="clock" className="h-3.5 w-3.5 text-muted" />
              <input
                type="range"
                min={trackTimes.lo}
                max={trackTimes.hi}
                value={Math.min(at, trackTimes.hi)}
                onChange={(e) => setTime(Number(e.target.value) >= trackTimes.hi ? null : Number(e.target.value))}
                className="flex-1 accent-[var(--color-ocean)]"
              />
              <span className="font-mono">{new Date(Math.min(at, trackTimes.hi)).toISOString().slice(0, 19).replace("T", " ")}</span>
              <button type="button" onClick={() => setTime(null)} className="text-muted hover:text-white">
                latest
              </button>
            </div>
          )}
        </div>
        {selection && (
          <SelectionPanel
            key={selectionKey(selection)}
            selection={selection}
            data={data}
            onClose={() => selectLocal(null)}
            onZoom={(lon, lat) => mapRef.current?.center(lon, lat, 15)}
            onSearchInside={(t, shape, title) => {
              const id = "l-" + Math.random().toString(16).slice(2, 10);
              const area = { mode: "select" as const, polygon: shape };
              setLayers((ls) => [
                ...ls,
                { id, name: `${t.plural_name} inside ${title}`, kind: "objects", visible: true, opacity: 1, color: tools.nextColor(),
                  config: { object_type_id: t.id, property: t.geo[0] ?? null, area, time: null, q: "", filters: [], live: false } },
              ]);
              return id;
            }}
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ layers panel

function LayersPanel({
  layers,
  data,
  vtStatus,
  onVtRetry,
  onChange,
  onFit,
  onAdd,
}: {
  layers: Layer[];
  data: Record<string, LayerData>;
  vtStatus: Record<string, VectorTileStatus>;
  onVtRetry: (id: string) => void;
  onChange: (ls: Layer[]) => void;
  onFit: (l: Layer) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const set = (id: string, c: Partial<Layer>) => onChange(layers.map((l) => (l.id === id ? { ...l, ...c } : l)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= layers.length) return;
    const next = [...layers];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {!layers.length && (
          <li className="p-4 text-center text-xs text-muted">
            No layers yet.
            <div className="mt-2">
              <button type="button" onClick={onAdd} className={`${buttonClass.secondary} py-1 text-xs`}>
                <Icon name="plus" className="h-3.5 w-3.5" /> Add from data sources
              </button>
            </div>
          </li>
        )}
        {[...layers.keys()].reverse().map((i) => {
          const l = layers[i];
          const d = data[l.id];
          const count = d?.features
            ? `${d.features.length.toLocaleString()}${d.truncated ? ` of ${d.total?.toLocaleString()}` : ""} objects`
            : d?.observations
              ? `${new Set(d.observations.map((o) => o.series_id)).size} series · ${d.observations.length.toLocaleString()} observations`
              : d?.rasters
                ? `${d.rasters.length} raster${d.rasters.length === 1 ? "" : "s"}`
                : d?.regions
                  ? `${d.regions.features.length} regions · ${d.regions.matched} matched`
                  : "";
          const vt = isVector(l) ? vtStatus[l.id] : undefined;
          const vtCount = !vt
            ? ""
            : vt.tiles === 0
              ? `no tiles in view (shown from zoom ${Number(l.config.min_zoom) || 0})`
              : `${vt.features.toLocaleString()} features · ${vt.tiles - vt.loading - (vt.failed ?? 0)}/${vt.tiles} tiles${vt.loading ? " · loading…" : ""}${vt.labels ? ` · ${vt.labels} labels` : ""}`;
          return (
            <li key={l.id} className="border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={l.visible} onChange={() => set(l.id, { visible: !l.visible })} className="accent-[var(--color-ocean)]" aria-label="Show layer" />
                <input type="color" value={l.color} onChange={(e) => set(l.id, { color: e.target.value })} className="h-4 w-4 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Colour" />
                <button type="button" onClick={() => setOpen(open === l.id ? null : l.id)} className="min-w-0 flex-1 truncate text-left text-sm hover:text-ocean" title="Layer settings">
                  {l.name}
                </button>
                {l.visible && refreshing(l) && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-ok" title="Live" />}
                <button type="button" onClick={() => onFit(l)} className="text-muted hover:text-white" title="Zoom to layer" aria-label="Zoom to layer">
                  <Icon name="fit" className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="ml-6 mt-0.5 text-[11px] text-muted">
                {isVector(l) ? "Vector tiles" : LAYER_KIND_LABEL[l.kind]}
                {isVector(l) ? (l.visible && vtCount ? ` · ${vtCount}` : "") : d?.loading ? " · loading…" : count ? ` · ${count}` : ""}
                {d?.refreshedAt && refreshing(l) ? ` · ${when(new Date(d.refreshedAt).toISOString())}` : ""}
              </div>
              {d?.error && <div className="ml-6 mt-0.5 text-[11px] text-bad">{d.error}</div>}
              {!!vt?.failed && l.visible && (
                <div className="ml-6 mt-0.5 flex items-center gap-2 text-[11px] text-bad" data-vt-failed={vt.failed}>
                  <span className="min-w-0 flex-1">
                    {vt.failed} failed tile{vt.failed === 1 ? "" : "s"}
                    {vt.retrying ? ` · ${vt.retrying === vt.failed ? "" : `${vt.retrying} `}retrying with back-off` : " · not retried"}
                  </span>
                  <button type="button" onClick={() => onVtRetry(l.id)} className="shrink-0 underline hover:text-white">
                    Retry now
                  </button>
                </div>
              )}
              {vt?.error && l.visible && <div className="ml-6 mt-0.5 break-words text-[11px] text-bad">{vt.error}</div>}
              {vt?.legend && l.visible && <VectorLegend legend={vt.legend} />}
              {l.kind === "choropleth" && d?.regions && d.regions.min !== null && (
                <div className="ml-6 mt-1 flex items-center gap-1 text-[10px] text-muted">
                  {formatNum(d.regions.min)}
                  <span className="h-2 flex-1 rounded" style={{ background: `linear-gradient(to right, ${l.color}22, ${l.color})` }} />
                  {formatNum(d.regions.max)}
                </div>
              )}
              {open === l.id && (
                <div className="ml-6 mt-2 space-y-2 text-xs">
                  <input value={l.name} onChange={(e) => set(l.id, { name: e.target.value })} className={inputClass} />
                  <label className="flex items-center gap-2">
                    Opacity
                    <input type="range" min={0.1} max={1} step={0.05} value={l.opacity} onChange={(e) => set(l.id, { opacity: Number(e.target.value) })} className="flex-1 accent-[var(--color-ocean)]" />
                  </label>
                  {(l.kind === "objects" || l.kind === "template") && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={!!l.config.live} onChange={(e) => set(l.id, { config: { ...l.config, live: e.target.checked } })} className="accent-[var(--color-ocean)]" />
                      Live update (every 30 s)
                    </label>
                  )}
                  {isVector(l) && <VectorSettings layer={l} status={vt} onChange={(config) => set(l.id, { config })} />}
                  {l.kind === "tracks" && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={l.config.mode === "live"}
                        onChange={(e) => set(l.id, { config: { ...l.config, mode: e.target.checked ? "live" : "historic" } })}
                        className="accent-[var(--color-ocean)]"
                      />
                      Live feed (last {Number(l.config.minutes) || 60} min, every 10 s)
                    </label>
                  )}
                  <div className="flex gap-1">
                    <button type="button" onClick={() => move(i, 1)} className={buttonClass.ghost} title="Move up">
                      ↑
                    </button>
                    <button type="button" onClick={() => move(i, -1)} className={buttonClass.ghost} title="Move down">
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={async () => (await confirmDialog(`Remove the layer ${l.name}?`)) && onChange(layers.filter((x) => x.id !== l.id))}
                      className={`${buttonClass.ghost} ml-auto text-bad`}
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" /> Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {layers.length > 0 && (
        <div className="border-t border-line p-2">
          <button type="button" onClick={onAdd} className={`${buttonClass.secondary} w-full justify-center py-1 text-xs`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add layer
          </button>
        </div>
      )}
    </div>
  );
}

const refreshing = (l: Layer) => (l.kind === "objects" || l.kind === "template" ? !!l.config.live : l.kind === "tracks" ? l.config.mode === "live" : l.kind === "eml");
const formatNum = (n: number | null) => (n === null ? "—" : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100));

// ------------------------------------------------------------------------------------------------ vector tile layers

/** A "Tile server" layer whose tiles are Mapbox Vector Tiles (config.format "vector"): drawn by VectorTileLayer. */
const isVector = (l: Layer) => l.kind === "tiles" && l.config.format === "vector";
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

function VectorLayer({
  layer,
  p,
  selection,
  retryNonce,
  onFeature,
  onStatus,
}: {
  layer: Layer;
  p: Projection;
  selection: Selection | null;
  retryNonce: number;
  onFeature: (l: Layer, f: Feature) => void;
  onStatus: (id: string, s: VectorTileStatus) => void;
}) {
  const c = layer.config;
  const sel = selection?.kind === "feature" && selection.layer.id === layer.id ? [selection.feature.primary_key] : [];
  const labelKey = (c.label_key as string) || undefined;
  return (
    <VectorTileLayer
      p={p}
      url={String(c.url ?? "")}
      sourceLayers={strList(c.source_layers)}
      minZoom={Number(c.min_zoom) || 0}
      maxZoom={Number(c.max_zoom) || 14}
      idKey={(c.id_key as string) || "id"}
      labelKey={labelKey}
      labels={c.label_mode === "always" ? "always" : "hover"}
      labelStyle={c.label_style === "card" ? "card" : "minimal"}
      proxy={!!c.proxy}
      retryNonce={retryNonce}
      color={layer.color}
      style={{ opacity: layer.opacity, width: Number(c.line_width) || undefined, radius: Number(c.radius) || undefined, fillOpacity: c.fill_opacity === undefined ? undefined : Number(c.fill_opacity) }}
      colorBy={colorByOf(c)}
      selectedIds={sel}
      onStatus={(s) => onStatus(layer.id, s)}
      onFeature={(f) => {
        const pr = f.properties;
        const title = String(pr[labelKey ?? ""] ?? pr.name ?? pr.NAME ?? pr.title ?? f.id);
        // the whole feature (its pieces in every loaded tile): picked for "Select" searches and "Search inside this shape"
        onFeature(layer, { object_type_id: `ext:${layer.id}`, primary_key: f.id, title, properties: { ...pr, "source layer": f.layer, tile: f.tile, ...(f.pieces > 1 ? { tiles: f.pieces } : {}) }, geometry: f.whole });
      }}
    />
  );
}

function VectorLegend({ legend }: { legend: NonNullable<VectorTileStatus["legend"]> }) {
  if (legend.kind === "range")
    return (
      <div className="ml-6 mt-1 flex items-center gap-1 text-[10px] text-muted">
        {formatNum(legend.min)}
        <span className="h-2 flex-1 rounded" style={{ background: `linear-gradient(to right, ${legend.colors.join(", ")})` }} />
        {formatNum(legend.max)}
      </div>
    );
  return (
    <div className="ml-6 mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted">
      {legend.items.map(([v, c]) => (
        <span key={v} className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ background: c }} />
          {v}
        </span>
      ))}
    </div>
  );
}

/** The settings of a vector tile layer: URL template, source layers, zoom range, id / label properties, styling by property. */
function VectorSettings({ layer, status, onChange }: { layer: Layer; status?: VectorTileStatus; onChange: (config: Record<string, unknown>) => void }) {
  const c = layer.config;
  const set = (k: string, v: unknown) => onChange({ ...c, [k]: v });
  const chosen = strList(c.source_layers);
  const names = [...new Set([...(status?.layers ?? []), ...chosen])];
  const props = status?.properties ?? [];
  const listId = `vt-props-${layer.id}`;
  return (
    <div className="space-y-2 rounded border border-line p-2">
      <datalist id={listId}>
        {props.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <label className="block">
        <span className="text-muted">URL template</span>
        <input value={String(c.url ?? "")} onChange={(e) => set("url", e.target.value)} className={`${inputClass} font-mono text-[11px]`} aria-label="Vector tile URL template" />
      </label>
      <label className="flex items-center gap-2" title="For tile servers without CORS headers: the platform fetches the tiles (the host must be on the tile proxy's allow-list, Map admin)">
        <input type="checkbox" checked={!!c.proxy} onChange={(e) => set("proxy", e.target.checked)} className="accent-[var(--color-ocean)]" aria-label="Load through the tile proxy" />
        Load through the platform&apos;s tile proxy
      </label>
      <div>
        <span className="text-muted">Source layers {chosen.length ? "" : "(all)"}</span>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
          {names.map((n) => (
            <label key={n} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={chosen.includes(n)}
                onChange={(e) => set("source_layers", e.target.checked ? [...chosen, n] : chosen.filter((x) => x !== n))}
                className="accent-[var(--color-ocean)]"
              />
              {n}
            </label>
          ))}
          {!names.length && <span className="text-[11px] text-muted">Shown once a tile has loaded.</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-muted">Min zoom</span>
          <input type="number" min={0} max={22} value={Number(c.min_zoom) || 0} onChange={(e) => set("min_zoom", Number(e.target.value))} className={inputClass} />
        </label>
        <label className="flex-1">
          <span className="text-muted">Max zoom (tiles)</span>
          <input type="number" min={0} max={22} value={Number(c.max_zoom) || 14} onChange={(e) => set("max_zoom", Number(e.target.value))} className={inputClass} />
        </label>
      </div>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-muted">Id property</span>
          <input value={String(c.id_key ?? "")} placeholder="id" list={listId} onChange={(e) => set("id_key", e.target.value)} className={inputClass} />
        </label>
        <label className="flex-1">
          <span className="text-muted">Label property</span>
          <input value={String(c.label_key ?? "")} placeholder="name" list={listId} onChange={(e) => set("label_key", e.target.value)} className={inputClass} />
        </label>
      </div>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-muted">Labels</span>
          <select value={c.label_mode === "always" ? "always" : "hover"} onChange={(e) => set("label_mode", e.target.value)} className={inputClass} aria-label="Label visibility">
            <option value="hover">Only on hover</option>
            <option value="always">Always visible</option>
          </select>
        </label>
        {c.label_mode === "always" && (
          <label className="flex-1">
            <span className="text-muted">Label style</span>
            <select value={c.label_style === "card" ? "card" : "minimal"} onChange={(e) => set("label_style", e.target.value)} className={inputClass} aria-label="Label style">
              <option value="minimal">Minimal</option>
              <option value="card">Card</option>
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="text-muted">Color by property</span>
        <input value={String(c.color_by ?? "")} placeholder="none (layer color)" list={listId} onChange={(e) => set("color_by", e.target.value)} className={inputClass} aria-label="Color by property" />
      </label>
      {!!c.color_by && (
        <div className="flex items-center gap-2">
          <select value={String(c.color_mode ?? "")} onChange={(e) => set("color_mode", e.target.value)} className={inputClass} aria-label="Color scale">
            <option value="">Automatic</option>
            <option value="category">Categories</option>
            <option value="range">Numeric range</option>
          </select>
          {c.color_mode !== "category" && (
            <>
              <input type="color" value={String(c.color_from || "#dbeafe")} onChange={(e) => set("color_from", e.target.value)} className="h-5 w-6 shrink-0 cursor-pointer bg-transparent" aria-label="Low color" />
              <input type="color" value={String(c.color_to || "#1d4ed8")} onChange={(e) => set("color_to", e.target.value)} className="h-5 w-6 shrink-0 cursor-pointer bg-transparent" aria-label="High color" />
            </>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-muted">Line width</span>
          <input type="number" min={0.5} max={12} step={0.5} value={Number(c.line_width) || 1.5} onChange={(e) => set("line_width", Number(e.target.value))} className={inputClass} />
        </label>
        <label className="flex-1">
          <span className="text-muted">Point radius</span>
          <input type="number" min={1} max={20} value={Number(c.radius) || 5} onChange={(e) => set("radius", Number(e.target.value))} className={inputClass} />
        </label>
        <label className="flex-1">
          <span className="text-muted">Fill</span>
          <input type="number" min={0} max={1} step={0.05} value={c.fill_opacity === undefined ? 0.3 : Number(c.fill_opacity)} onChange={(e) => set("fill_opacity", Number(e.target.value))} className={inputClass} />
        </label>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ drawing layers

function pathOf(g: GeoJSONGeometry, p: Projection): string {
  const ring = (r: number[][]) => r.map((q, i) => `${i ? "L" : "M"}${p.px(q[0]).toFixed(1)},${p.py(q[1]).toFixed(1)}`).join("") + "Z";
  if (g.type === "Polygon") return (g.coordinates as number[][][]).map(ring).join("");
  if (g.type === "MultiPolygon") return (g.coordinates as number[][][][]).flatMap((poly) => poly.map(ring)).join("");
  return "";
}
const line = (pts: number[][], p: Projection) => pts.map((q) => `${p.px(q[0]).toFixed(1)},${p.py(q[1]).toFixed(1)}`).join(" ");

function Shape({ g, color, opacity, selected, p, label, onClick }: { g: GeoJSONGeometry; color: string; opacity: number; selected: boolean; p: Projection; label?: string; onClick: () => void }) {
  const stroke = selected ? "#ffffff" : color;
  const down = (e: ReactPointerEvent) => (e.stopPropagation(), onClick());
  if (g.type === "Point" || g.type === "MultiPoint") {
    const pts = g.type === "Point" ? [g.coordinates as number[]] : (g.coordinates as number[][]);
    return (
      <g className="cursor-pointer" onPointerDown={down} opacity={opacity}>
        {label && <title>{label}</title>}
        {pts.map((q, i) => (
          <circle key={i} cx={p.px(q[0])} cy={p.py(q[1])} r={selected ? 8 : 6} fill={color} stroke={selected ? "#fff" : "#0b1220"} strokeWidth={2} />
        ))}
        {/* labels only close in (or on the selected point), so a dense layer stays readable; hover shows the title */}
        {label && (selected || p.z >= 12) && (
          <text x={p.px(pts[0][0]) + 9} y={p.py(pts[0][1]) + 4} className="pointer-events-none fill-white text-[11px]" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
            {label}
          </text>
        )}
      </g>
    );
  }
  if (g.type === "LineString" || g.type === "MultiLineString") {
    const parts = g.type === "LineString" ? [g.coordinates as number[][]] : (g.coordinates as number[][][]);
    return (
      <g className="cursor-pointer" onPointerDown={down} opacity={opacity}>
        {parts.map((pts, i) => (
          <polyline key={i} points={line(pts, p)} fill="none" stroke={stroke} strokeWidth={selected ? 4 : 3} strokeLinejoin="round" />
        ))}
      </g>
    );
  }
  return <path d={pathOf(g, p)} fillRule="evenodd" fill={color} fillOpacity={0.22 * opacity} stroke={stroke} strokeOpacity={opacity} strokeWidth={selected ? 3 : 1.5} className="cursor-pointer" onPointerDown={down} />;
}

function LayerShapes({
  layer,
  d,
  p,
  at,
  selection,
  onFeature,
  onSelect,
}: {
  layer: Layer;
  d?: LayerData;
  p: Projection;
  at: number;
  selection: Selection | null;
  onFeature: (l: Layer, f: Feature) => void;
  onSelect: (s: Selection) => void;
}) {
  const series = useMemo(() => {
    const m = new Map<string, Observation[]>();
    for (const o of d?.observations ?? []) (m.get(o.series_id) ?? m.set(o.series_id, []).get(o.series_id)!).push(o);
    return [...m.entries()];
  }, [d?.observations]);
  if (!d) return null;
  if (layer.kind === "choropleth" && d.regions) {
    const { min, max } = d.regions;
    return (
      <g>
        {d.regions.features.map((r, i) => {
          const t = r.value === null || min === null || max === null ? null : max === min ? 1 : (r.value - min) / (max - min);
          const sel = selection?.kind === "region" && selection.layer.id === layer.id && selection.region.id === r.id;
          return (
            <path
              key={i}
              d={pathOf(r.geometry, p)}
              fillRule="evenodd"
              fill={t === null ? "transparent" : layer.color}
              fillOpacity={t === null ? 0 : (0.1 + 0.7 * t) * layer.opacity}
              stroke={sel ? "#fff" : layer.color}
              strokeOpacity={0.8}
              strokeWidth={sel ? 2.5 : 1}
              className="cursor-pointer"
              onPointerDown={(e) => (e.stopPropagation(), onSelect({ kind: "region", layer, region: r }))}
            />
          );
        })}
      </g>
    );
  }
  if (d.observations) {
    return (
      <g opacity={layer.opacity}>
        {series.map(([sid, list], i) => {
          const color = i === 0 ? layer.color : LAYER_COLORS[(LAYER_COLORS.indexOf(layer.color) + i + LAYER_COLORS.length) % LAYER_COLORS.length];
          const shown = list.filter((o) => Date.parse(o.t) <= at);
          const head = shown[shown.length - 1];
          if (!head) return null;
          const sel = selection?.kind === "observation" && selection.layer.id === layer.id && selection.obs.series_id === sid;
          const name = ["vessel_name", "name", "plate", "label", "title"].map((k) => head.properties[k]).find((v) => typeof v === "string" && v) as string | undefined;
          return (
            <g key={sid}>
              {shown.length > 1 && <polyline points={line(shown.map((o) => [o.longitude, o.latitude]), p)} fill="none" stroke={color} strokeWidth={sel ? 3 : 2} strokeOpacity={0.75} strokeLinejoin="round" />}
              <g transform={`translate(${p.px(head.longitude)},${p.py(head.latitude)})`} className="cursor-pointer" onPointerDown={(e) => (e.stopPropagation(), onSelect({ kind: "observation", layer, obs: head }))}>
                <circle r={sel ? 8 : 6} fill={color} stroke={sel ? "#fff" : "#0b1220"} strokeWidth={2} />
                {p.z >= 8 && (
                  <text x={9} y={4} className="pointer-events-none fill-white text-[11px]" style={{ paintOrder: "stroke", stroke: "#0b1220", strokeWidth: 3 }}>
                    {name ?? sid}
                  </text>
                )}
              </g>
            </g>
          );
        })}
      </g>
    );
  }
  return (
    <g>
      {(d.features ?? []).map((f) => (
        <Shape
          key={`${f.object_type_id}/${f.primary_key}`}
          g={f.geometry}
          color={layer.color}
          opacity={layer.opacity}
          p={p}
          label={(d.features?.length ?? 0) <= 300 ? f.title : undefined}
          selected={selection?.kind === "feature" && selection.feature.primary_key === f.primary_key && selection.feature.object_type_id === f.object_type_id}
          onClick={() => onFeature(layer, f)}
        />
      ))}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ selection: properties, track, observation log

/** The track of the selected object's geotemporal series (loaded by SelectionPanel, shared through this cache). */
const trackCache = new Map<string, Observation[]>();
const trackListeners = new Set<() => void>();
const trackKey = (f: Feature) => `${f.object_type_id}/${f.primary_key}`;

function SelectedTrack({ selection, p }: { selection: Extract<Selection, { kind: "feature" }>; p: Projection }) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    trackListeners.add(l);
    return () => void trackListeners.delete(l);
  }, []);
  const obs = trackCache.get(trackKey(selection.feature));
  if (!obs || obs.length < 2) return null;
  return <polyline className="pointer-events-none" points={line(obs.map((o) => [o.longitude, o.latitude]), p)} fill="none" stroke="#ffffff" strokeWidth={2.5} strokeDasharray="6 3" strokeOpacity={0.9} />;
}

const selectionKey = (s: Selection) =>
  s.kind === "feature" ? `f/${s.layer.id}/${trackKey(s.feature)}` : s.kind === "observation" ? `o/${s.layer.id}/${s.obs.series_id}` : `r/${s.layer.id}/${String(s.region.id)}`;

/** A property's definition, from the object type of the layer the object came from. */
function propertyMeta(data: Record<string, LayerData>, typeId: string, apiName: string): Property | undefined {
  for (const d of Object.values(data)) if (d.objectType?.id === typeId) return d.objectType.properties.find((p) => p.api_name === apiName);
  return undefined;
}

/** A value as people read it: thousands separators, rupiah amounts, short coordinates. */
function displayValue(v: unknown, key: string, meta?: Property): string {
  if (v == null || v === "") return "—";
  const num = typeof v === "number" ? v : null;
  const money = /_rp$/.test(key) || /\(Rp\)/.test(meta?.display_name ?? "");
  if (num !== null && money) return `Rp ${num.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
  if (num !== null) return num.toLocaleString("id-ID", { maximumFractionDigits: 2 });
  if (meta?.type === "geopoint" && typeof v === "string") return v.split(",").map((x) => Number(x).toFixed(4)).join(", ");
  return formatValue(v);
}

/** The Vertex graph templates that start from this object's type: each opens its graph generated from the object. */
function VertexLinks({ objectTypeId, primaryKey }: { objectTypeId: string; primaryKey: string }) {
  const [rows, setRows] = useState<GraphRow[]>([]);
  useEffect(() => {
    let stale = false;
    vertex.graphs().then((all) => !stale && setRows(all.filter((g) => g.template && g.template_types?.includes(objectTypeId))), () => !stale && setRows([]));
    return () => {
      stale = true;
    };
  }, [objectTypeId]);
  if (!rows.length) return null;
  return (
    <div className="mb-2 space-y-1">
      {rows.map((g) => (
        <Link key={g.id} href={`/vertex?template=${g.id}&objects=${encodeURIComponent(primaryKey)}`} title={g.description}
          className={`${buttonClass.secondary} flex items-center gap-1.5 text-xs`}>
          <Icon name="graph" className="h-3.5 w-3.5" /> Telusuri di Vertex: {g.name}
        </Link>
      ))}
    </div>
  );
}

function SelectionPanel({
  selection,
  data,
  onClose,
  onZoom,
  onSearchInside,
}: {
  selection: Selection;
  data: Record<string, LayerData>;
  onClose: () => void;
  onZoom: (lon: number, lat: number) => void;
  /** adds an object search inside the shape as a layer; its layer id back */
  onSearchInside?: (t: GeoObjectType, shape: GeoJSONGeometry, title: string) => string;
}) {
  const [minutes, setMinutes] = useState<number>(1440);
  const [remote, setRemote] = useState<{ observations: Observation[]; live: string[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = selection.kind === "feature" ? selection.feature : null;
  const series = f?.series ?? null;
  // a tracks layer already holds the series' observations
  const local = useMemo(() => {
    if (selection.kind !== "observation") return null;
    const all = (data[selection.layer.id]?.observations ?? []).filter((o) => o.series_id === selection.obs.series_id);
    const last = all.length ? Date.parse(all[all.length - 1].t) : 0;
    const shown = minutes ? all.filter((o) => Date.parse(o.t) >= last - minutes * 60_000) : all;
    return { observations: shown, live: data[selection.layer.id]?.liveProperties ?? [], total: shown.length };
  }, [selection, data, minutes]);
  // an object's geotemporal series reference: load its track (the panel is keyed by the selection)
  useEffect(() => {
    if (!f || !series) return;
    let stale = false;
    geoApi.track(f.object_type_id, f.primary_key, minutes ? { minutes } : {}).then(
      (r) => {
        if (stale) return;
        trackCache.set(trackKey(f), r.observations);
        trackListeners.forEach((l) => l());
        setRemote({ observations: r.observations, live: r.live_properties, total: r.total });
        setError(null);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
      trackCache.delete(trackKey(f));
      trackListeners.forEach((l) => l());
    };
  }, [f, series, minutes]);
  const track = local ?? remote;

  const title =
    selection.kind === "feature" ? selection.feature.title : selection.kind === "observation" ? selection.obs.series_id : String(selection.region.name ?? selection.region.id);
  const props: Record<string, unknown> =
    selection.kind === "feature"
      ? selection.feature.properties
      : selection.kind === "observation"
        ? { series_id: selection.obs.series_id, time: selection.obs.t, latitude: selection.obs.latitude, longitude: selection.obs.longitude, ...selection.obs.properties }
        : { region: selection.region.id, value: selection.region.value };
  const showLog = selection.kind === "observation" || !!series;
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-sm">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name={selection.kind === "feature" ? "cube" : selection.kind === "observation" ? "wave" : "grid"} className="h-4 w-4 text-ocean" />
        <span className="line-clamp-2 min-w-0 flex-1 font-semibold" title={title}>{title}</span>
        {selection.kind === "feature" && !selection.feature.object_type_id.startsWith("ext:") && (
          <Link href={`/ontology/${selection.feature.object_type_id}?tab=objects`} className="text-muted hover:text-white" title="Open the object type">
            <Icon name="external" className="h-3.5 w-3.5" />
          </Link>
        )}
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <dl className={`${showLog ? "max-h-[40%]" : "flex-1"} space-y-1.5 overflow-y-auto p-3 text-xs`}>
        {series?.position && (
          <div className="mb-2 rounded border border-line bg-ink px-2 py-1.5 text-[11px] text-muted">
            Live position {series.position.latitude.toFixed(5)}, {series.position.longitude.toFixed(5)} · {series.position.t.slice(0, 19).replace("T", " ")}
          </div>
        )}
        {f && !f.object_type_id.startsWith("ext:") && <VertexLinks objectTypeId={f.object_type_id} primaryKey={f.primary_key} />}
        {Object.entries(props).map(([k, v]) => {
          const meta = f ? propertyMeta(data, f.object_type_id, k) : undefined;
          const text = displayValue(v, k, meta);
          const list = typeof v === "string" && v.includes("; ") ? v.split("; ") : null;
          const label = meta?.display_name || k;
          // long text and lists (e.g. the doctors linked to a facility) go under their label instead of being cut off
          return list || text.length > 36 ? (
            <div key={k} className="space-y-0.5 border-t border-line/60 pt-1.5">
              <dt className="text-muted">{label}</dt>
              {list ? (
                <dd className="flex flex-wrap gap-1">
                  {list.map((x) => (
                    <span key={x} className="rounded border border-line-2 bg-ink px-1.5 py-0.5">{x}</span>
                  ))}
                </dd>
              ) : (
                <dd className="break-words">{text}</dd>
              )}
            </div>
          ) : (
            <div key={k} className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">{label}</dt>
              <dd className="min-w-0 truncate text-right tabular-nums" title={text}>{text}</dd>
            </div>
          );
        })}
      </dl>
      {f && onSearchInside && /Polygon$/.test(f.geometry?.type ?? "") && <SearchInside feature={f} data={data} onSearch={onSearchInside} />}
      {showLog && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-xs font-semibold">Observation log</span>
            <span className="text-[11px] text-muted">{track ? `${track.observations.length.toLocaleString()} observations` : ""}</span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="ml-auto rounded border border-line-2 bg-ink px-1.5 py-0.5 text-[11px]" title="Rolling window">
              {ROLLING.map(([mins, l]) => (
                <option key={mins} value={mins}>
                  {mins ? `Last ${l}` : l}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="px-3 text-xs text-bad">{error}</p>}
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">Time</th>
                  {(track?.live ?? []).slice(0, 4).map((k) => (
                    <th key={k} className="px-2 py-1 font-medium">
                      {k}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...(track?.observations ?? [])]
                  .reverse()
                  .slice(0, 500)
                  .map((o, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{o.t.slice(5, 19).replace("T", " ")}</td>
                      {(track?.live ?? []).slice(0, 4).map((k) => (
                        <td key={k} className="max-w-24 truncate px-2 py-1">
                          {formatValue(o.properties[k])}
                        </td>
                      ))}
                      <td className="px-1">
                        <button type="button" onClick={() => onZoom(o.longitude, o.latitude)} className="text-ocean hover:underline">
                          Zoom to
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {track && !track.observations.length && <p className="p-3 text-center text-xs text-muted">No observations in this window.</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * "Search inside this shape" for a selected polygon (a vector tile feature — all its loaded tiles' pieces — or an
 * object's geoshape): an object type's objects whose geopoint / geoshape lies in it, added as a layer (the map's geo
 * search, POST /api/geo/objects/search with area "select"); the count and the first matches are listed here.
 */
function SearchInside({ feature, data, onSearch }: { feature: Feature; data: Record<string, LayerData>; onSearch: (t: GeoObjectType, shape: GeoJSONGeometry, title: string) => string }) {
  const [types, setTypes] = useState<GeoObjectType[] | null>(null);
  const [typeId, setTypeId] = useState("");
  const [layerId, setLayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    geoApi.sources().then(
      (s) => {
        const ts = s.object_types.filter((t) => t.geo.length || t.gtsr);
        setTypes(ts);
        setTypeId((cur) => cur || ts[0]?.id || "");
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  const d = layerId ? data[layerId] : undefined;
  const t = types?.find((x) => x.id === typeId);
  return (
    <div className="space-y-2 border-t border-line p-3 text-xs" data-search-inside>
      <div className="font-semibold">Search inside this shape</div>
      <div className="flex gap-2">
        <select value={typeId} onChange={(e) => (setTypeId(e.target.value), setLayerId(null))} className={`${inputClass} min-w-0 flex-1 py-1 text-xs`} aria-label="Object type">
          {!types && <option value="">Loading object types…</option>}
          {types?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.plural_name}
            </option>
          ))}
        </select>
        <button type="button" disabled={!t} onClick={() => t && setLayerId(onSearch(t, feature.geometry, feature.title))} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="search" className="h-3.5 w-3.5" /> Search
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {types && !types.length && <p className="text-muted">No object type has a geopoint, geoshape or track to search.</p>}
      {layerId && (!d || d.loading) && <p className="text-muted">Searching…</p>}
      {d?.error && <p className="text-bad">{d.error}</p>}
      {d && !d.loading && !d.error && (
        <div data-search-inside-result={d.total ?? 0}>
          <p className="text-soft">
            {(d.total ?? 0).toLocaleString()} {t?.plural_name ?? "objects"} inside{d.truncated ? ` (the first ${(d.features?.length ?? 0).toLocaleString()} drawn)` : ""} — added as a layer.
          </p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {(d.features ?? []).slice(0, 8).map((x) => (
              <li key={x.primary_key} className="truncate">
                {x.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** An external XYZ tile server ({z}/{x}/{y}, also {s} subdomains a / b / c) drawn above the basemap. */
function TileLayer({ p, template, opacity, maxZoom }: { p: Projection; template: string; opacity: number; maxZoom: number }) {
  // {z}/{x}/{y} tile servers, or WMS GetMap per tile with {bbox-epsg-3857}
  const bboxed = template.includes("{bbox-epsg-3857}");
  if (!bboxed && (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{y\}/.test(template))) return null;
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
  const tiles: ReactElement[] = [];
  const [xa, xb] = [tx(lon0), tx(lon1)];
  const [ya, yb] = [Math.max(0, ty(lat0)), Math.min(n - 1, ty(lat1))];
  if ((xb - xa + 1) * (yb - ya + 1) > 400) return null;
  for (let x = xa; x <= xb; x++)
    for (let y = ya; y <= yb; y++) {
      const wx = ((x % n) + n) % n;
      const R = 20037508.342789244;
      const step = (2 * R) / n;
      const bbox = `${-R + wx * step},${R - (y + 1) * step},${-R + (wx + 1) * step},${R - y * step}`;
      const url = template.replace("{bbox-epsg-3857}", bbox).replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y)).replace("{s}", "abc"[(wx + y) % 3]);
      const left = p.px(lonOf(x));
      const top = p.py(latOf(y));
      tiles.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${z}/${x}/${y}`} src={url} alt="" draggable={false} className="pointer-events-none absolute"
          style={{ left, top, width: p.px(lonOf(x + 1)) - left, height: p.py(latOf(y + 1)) - top, opacity }} />,
      );
    }
  return <>{tiles}</>;
}
