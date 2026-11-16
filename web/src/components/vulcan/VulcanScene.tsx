"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { API_URL } from "@/lib/api";
import { mediaUrl } from "@/lib/ontology";
import { colorCloud, loadCad, sniffModel, type ColorMode, type ModelInfo } from "./cadGeometry";
import { ModelInfoPanel } from "./ModelInfoPanel";

// The Vulcan viewer shared by the Vulcan page (app/vulcan/page.tsx) and the Workshop Vulcan widget
// (components/workshop/VulcanWidget.tsx): the 3D viewport (meshes, DXF drawings by layer, LAS point clouds by class),
// the tools (select, annotate, measure, section plane, mesh style, part colors) and the side panel. `useVulcanScene`
// loads a CAD object's scene and returns the toolbar, the viewport and the side panel for the caller to lay out.

export type Annotation = {
  primary_key: string;
  annotation_title: string;
  annotation_content: string;
  part_instance_id: string;
  annotation_attachment_x: number;
  annotation_attachment_y: number;
  annotation_attachment_z: number;
  annotation_sphere_size: number;
  annotation_intent: string;
  annotation_created_by: string;
  annotation_timestamp: string;
};
export type Measurement = { primary_key: string; measurement_points: number[]; measurement_created_by: string; measurement_timestamp: string };
export type Section = { primary_key: string; section_plane_position: number[]; section_plane_quaternion: number[] };
/** The cut: an offset along the plane's normal, the normal tilted from the model's up axis (about X) and turned about it (about Z), in degrees. */
export type Cut = { on: boolean; offset: number; tilt: number; turn: number };
export type Point3 = [number, number, number];

/** The plane's rotation as a quaternion [x, y, z, w]: about Z by `turn` after about X by `tilt`. */
export function cutQuaternion(c: Cut): number[] {
  const a = (c.tilt * Math.PI) / 360;
  const b = (c.turn * Math.PI) / 360;
  return [Math.cos(b) * Math.sin(a), Math.sin(b) * Math.sin(a), Math.sin(b) * Math.cos(a), Math.cos(b) * Math.cos(a)];
}

/** The plane's normal in model coordinates (the up axis rotated by tilt and turn). */
export function cutNormal(c: Cut): [number, number, number] {
  const a = (c.tilt * Math.PI) / 180;
  const b = (c.turn * Math.PI) / 180;
  return [Math.sin(a) * Math.sin(b), -Math.sin(a) * Math.cos(b), Math.cos(a)];
}

/** A saved plane (position, any quaternion) back as a cut. */
export function cutOf(s: Section): Cut {
  const [x, y, z, w] = s.section_plane_quaternion.length === 4 ? s.section_plane_quaternion : [0, 0, 0, 1];
  // the up axis rotated by the quaternion
  const n = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  const tilt = (Math.acos(Math.max(-1, Math.min(1, n[2]))) * 180) / Math.PI;
  const turn = Math.abs(Math.sin((tilt * Math.PI) / 180)) > 1e-6 ? (Math.atan2(n[0], -n[1]) * 180) / Math.PI : 0;
  const p = s.section_plane_position;
  const offset = (p[0] ?? 0) * n[0] + (p[1] ?? 0) * n[1] + (p[2] ?? 0) * n[2];
  return { on: true, offset: Math.round(offset * 100) / 100, tilt: Math.round(tilt), turn: Math.round(turn) };
}
export type Scene = {
  object: { title: string; primary_key: string; object_type_id: string };
  model: {
    media: string | null;
    file_name: string | null;
    format: string | null;
    /** mesh, drawing (DXF) or point_cloud (LAS / LAZ) */
    kind?: "mesh" | "drawing" | "point_cloud";
    /** why the file is not rendered (binary DXF, DWG, LAZ, …), from its first bytes */
    refusal?: string | null;
    up_axis: string;
    unit: string | null;
  };
  annotations: Annotation[];
  measurements: Measurement[];
  section_planes: Section[];
  problems: string[];
};
export type CadRow = { object_type_id: string; object_type: string; primary_key: string; title: string };
export type Schema = { cad_types: { id: string; display_name: string }[]; problems: string[] };

export const INTENT_COLOR: Record<string, number> = { none: 0x94a3b8, primary: 0x3b82f6, success: 0x22c55e, warning: 0xeab308, danger: 0xef4444 };

/** The Vulcan API (api/vulcan.py). */
export async function vulcanApi<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}/api/vulcan${path}`, {
    ...init,
    credentials: "include",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail));
  }
  return res.json();
}

export type Tool = "select" | "annotate" | "measure";
export type Style = "normal" | "xray" | "wireframe";
/** Part coloring from outside (a Workshop variable): a color and / or an opacity per part, layer or class. */
export type PartStyles = Record<string, { color?: string; opacity?: number }>;

export const chunk = (xs: number[]): Point3[] => Array.from({ length: Math.floor(xs.length / 3) }, (_, i) => [xs[i * 3], xs[i * 3 + 1], xs[i * 3 + 2]]);
export const polyLength = (pts: Point3[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);

/** The section offset slider: the model's extent along the plane's normal (min, max, step), else -10 to 10. */
export function offsetRange(bounds: ModelInfo["bounds"], c: Cut): [number, number, number] {
  if (!bounds) return [Math.min(-10, c.offset), Math.max(10, c.offset), 0.1];
  const n = cutNormal(c);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const d = x * n[0] + y * n[1] + z * n[2];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
  const pad = (hi - lo) * 0.02 || 1;
  const step = Number(((hi - lo) / 200 || 0.1).toPrecision(2));
  return [Math.floor((lo - pad) / step) * step, Math.ceil((hi + pad) / step) * step, step];
}

/** Which tools are offered (all by default): the Workshop widget can turn each off. */
export type VulcanTools = { annotate?: boolean; measure?: boolean; section?: boolean; styling?: boolean; coloring?: boolean };

export type VulcanOptions = {
  tools?: VulcanTools;
  /** the mesh style shown first */
  defaultStyle?: Style;
  /** the viewport background (a CSS color; unset: the page behind shows through) */
  background?: string;
  /** the color of parts without one (default gray) */
  fallbackColor?: string;
  /** part coloring from outside; the color picked in the side panel wins */
  partStyles?: PartStyles;
  /** the selected part, set from outside (two-way with onSelect); undefined: not controlled */
  selectedPart?: string | null;
  /** outline the selected part in the viewport */
  highlightSelection?: boolean;
  /** a part was picked (or the selection cleared): the part, layer or class and the point in model coordinates */
  onSelect?: (part: string | null, point: Point3 | null) => void;
  /** a measurement was saved or chosen: its length in scene units and formatted with the model's unit */
  onMeasurement?: (distance: number, formatted: string) => void;
  /** why saving annotations, measurements and section planes is off (unset: saving is on) */
  saveBlocked?: string;
  /** after an annotation, measurement or section plane was saved */
  onSaved?: () => void;
  /** reload the scene whenever this changes */
  reloadKey?: unknown;
  /** what the viewport says before a CAD object is chosen */
  emptyText?: string;
  /** the Object View link in the side panel (default on) */
  objectLink?: boolean;
};

/**
 * A CAD object's scene in Vulcan: loads it, holds the tool state and returns the toolbar (tool buttons and the mesh
 * style), the viewport (the 3D canvas with the measure overlay) and the side panel (model info, the picked part,
 * the section plane, annotations, measurements) for the caller to lay out.
 */
export function useVulcanScene(row: CadRow | null, opts: VulcanOptions = {}) {
  const tools = { annotate: true, measure: true, section: true, styling: true, coloring: true, ...opts.tools };
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [style, setStyle] = useState<Style>(opts.defaultStyle ?? "normal");
  const [picked, setPicked] = useState<{ part: string; point: Point3 | null } | null>(null);
  const [measurePts, setMeasurePts] = useState<Point3[]>([]);
  const [section, setSection] = useState<Cut>({ on: false, offset: 0, tilt: 0, turn: 0 });
  const [draft, setDraft] = useState({ title: "", content: "", intent: "primary" });
  const [partColors, setPartColors] = useState<Record<string, string>>({});
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [colorMode, setColorMode] = useState<ColorMode>("rgb");
  const [pointSize, setPointSize] = useState(2);

  /** a new CAD object: the selection, the measure points, the part colors and the model panel start again */
  const reset = useCallback(() => {
    setPicked(null);
    setMeasurePts([]);
    setPartColors({});
    setInfo(null);
    setHidden({});
    setColorMode("rgb");
    setSection((s) => ({ ...s, on: false, offset: 0 }));
  }, []);
  const key = row ? `${row.object_type_id}|${row.primary_key}` : "";
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    reset();
  }
  // the selection set from outside (a Workshop variable); a pick sets it too and keeps its point
  const [outside, setOutside] = useState<string | null | undefined>(undefined);
  if (opts.selectedPart !== undefined && opts.selectedPart !== outside) {
    setOutside(opts.selectedPart);
    if ((opts.selectedPart ?? null) !== (picked?.part ?? null)) setPicked(opts.selectedPart ? { part: opts.selectedPart, point: null } : null);
  }

  const loadScene = useCallback(
    (c: CadRow) =>
      vulcanApi<Scene>(`/scene/${c.object_type_id}/${encodeURIComponent(c.primary_key)}`).then(
        (s) => (setScene(s), setError(null)),
        (e: Error) => setError(e.message),
      ),
    [],
  );
  const reloadKey = opts.reloadKey;
  useEffect(() => {
    if (row) void loadScene(row);
  }, [row, loadScene, reloadKey]);

  const onSaved = opts.onSaved;
  const save = async (kind: string, values: Record<string, unknown>) => {
    if (!row || opts.saveBlocked) return;
    try {
      await vulcanApi(`/${kind}`, { method: "POST", json: { cad_object_type_id: row.object_type_id, cad_primary_key: row.primary_key, values } });
      await loadScene(row);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const unit = scene?.model.unit ?? "units";
  const sendMeasurement = (pts: Point3[]) => {
    const d = polyLength(pts);
    opts.onMeasurement?.(d, `${d.toFixed(2)} ${unit}`);
  };
  const onSelect = opts.onSelect;
  const pick = (p: { part: string; point: Point3 } | null) => {
    setPicked(p);
    onSelect?.(p?.part ?? null, p?.point ?? null);
  };
  const offered: Tool[] = ["select", ...(tools.annotate ? (["annotate"] as Tool[]) : []), ...(tools.measure ? (["measure"] as Tool[]) : [])];
  const current: Tool = offered.includes(tool) ? tool : "select";
  const partWord = info?.kind === "drawing" ? "Layer" : info?.kind === "point_cloud" ? "Class" : "Part";

  const toolbar = scene ? (
    <>
      {offered.length > 1 && (
        <div className="flex gap-1 rounded border border-line-2 bg-panel-2 p-1 text-xs">
          {offered.map((t) => (
            <button key={t} type="button" onClick={() => (setTool(t), setMeasurePts([]))} className={`rounded px-2 py-0.5 capitalize ${current === t ? "bg-ocean text-white" : "text-muted"}`}>
              {t}
            </button>
          ))}
        </div>
      )}
      {tools.styling && (
        <select value={style} onChange={(e) => setStyle(e.target.value as Style)} className={fieldClass} aria-label="Mesh style">
          <option value="normal">Normal</option>
          <option value="xray">X-Ray</option>
          <option value="wireframe">Wireframe</option>
        </select>
      )}
    </>
  ) : null;

  const viewport = (
    <>
      <ErrorBox message={error} />
      {scene?.model.media && scene.model.refusal ? (
        <div className="flex h-full items-center justify-center p-8">
          <div className="max-w-lg rounded border border-warn/40 bg-warn/5 p-4 text-sm text-warn">
            <div className="mb-1 font-medium">{scene.model.file_name ?? "The model file"} is not rendered</div>
            {scene.model.refusal}
          </div>
        </div>
      ) : scene?.model.media ? (
        <VulcanViewport
          key={scene.object.primary_key}
          scene={scene}
          tool={current}
          style={style}
          section={section}
          partColors={partColors}
          hidden={hidden}
          colorMode={colorMode}
          pointSize={pointSize}
          background={opts.background}
          fallbackColor={opts.fallbackColor}
          partStyles={opts.partStyles}
          highlight={opts.highlightSelection ? picked?.part : undefined}
          onInfo={(i) => {
            setInfo(i);
            if (i.kind === "point_cloud" && !i.hasColor) setColorMode("elevation");
          }}
          measurePts={measurePts}
          onPick={(part, point) => {
            if (current === "measure") setMeasurePts((p) => [...p, point]);
            else pick({ part, point });
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted">{row ? (scene ? "This CAD object has no model file." : <Loading />) : (opts.emptyText ?? "Add a CAD object to the scene.")}</div>
      )}
      {current === "measure" && (
        <div className="absolute left-3 top-3 rounded border border-line bg-panel/90 p-2 text-xs">
          Click points on the model. {measurePts.length} points · {polyLength(measurePts).toFixed(2)} {unit}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              disabled={measurePts.length < 2 || !!opts.saveBlocked}
              title={opts.saveBlocked}
              onClick={() => {
                sendMeasurement(measurePts);
                void save("measurement", { measurement_points: measurePts.flat() }).then(() => setMeasurePts([]));
              }}
              className={buttonClass.primary}
            >
              Save measurement
            </button>
            <button type="button" onClick={() => setMeasurePts([])} className={buttonClass.ghost}>
              Clear
            </button>
          </div>
        </div>
      )}
    </>
  );

  const sidebar = scene ? (
    <>
      <div>
        <div className="font-medium">{scene.object.title}</div>
        <div className="text-muted">
          {scene.model.file_name} · up {scene.model.up_axis} · {unit}
        </div>
        {opts.objectLink !== false && (
          <Link href={`/ontology/objects/${scene.object.object_type_id}/${encodeURIComponent(scene.object.primary_key)}`} className="text-ocean">
            Object View
          </Link>
        )}
      </div>
      {info && info.kind !== "mesh" && (
        <ModelInfoPanel
          info={info}
          hidden={hidden}
          onToggle={(part, hide) => setHidden({ ...hidden, [part]: hide })}
          colorMode={colorMode}
          onColorMode={setColorMode}
          pointSize={pointSize}
          onPointSize={setPointSize}
        />
      )}
      {picked && (
        <div className="space-y-1.5 rounded border border-line p-2" data-vc-picked={picked.part}>
          <div className="flex items-center gap-2 font-medium">
            <span className="min-w-0 flex-1 truncate">
              {partWord} {picked.part}
            </span>
            {onSelect && (
              <button type="button" onClick={() => pick(null)} className="shrink-0 font-normal text-muted hover:text-white">
                Clear
              </button>
            )}
          </div>
          {picked.point && <div className="text-muted">at {picked.point.map((v) => v.toFixed(2)).join(", ")}</div>}
          {tools.coloring && (
            <label className="flex items-center gap-2">
              Color <input type="color" value={partColors[picked.part] ?? "#9ca3af"} onChange={(e) => setPartColors({ ...partColors, [picked.part]: e.target.value })} />
            </label>
          )}
          {current === "annotate" && (
            <div className="space-y-1">
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" className={inputClass} />
              <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={2} placeholder="Content" className={inputClass} />
              <select value={draft.intent} onChange={(e) => setDraft({ ...draft, intent: e.target.value })} className={inputClass}>
                {Object.keys(INTENT_COLOR).map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
              {!picked.point && <div className="text-muted">Click the {partWord.toLowerCase()} in the viewport to place the annotation.</div>}
              <button
                type="button"
                disabled={!draft.title || !picked.point || !!opts.saveBlocked}
                title={opts.saveBlocked}
                onClick={() =>
                  picked.point &&
                  save("annotation", {
                    annotation_title: draft.title,
                    annotation_content: draft.content || draft.title,
                    part_instance_id: picked.part,
                    annotation_intent: draft.intent,
                    annotation_attachment_x: picked.point[0],
                    annotation_attachment_y: picked.point[1],
                    annotation_attachment_z: picked.point[2],
                    annotation_sphere_size: 0,
                  }).then(() => setDraft({ title: "", content: "", intent: "primary" }))
                }
                className={buttonClass.primary}
              >
                Save annotation
              </button>
            </div>
          )}
          {current !== "annotate" && tools.annotate && <div className="text-muted">Switch to Annotate to attach an annotation here.</div>}
        </div>
      )}
      {tools.section && (
        <div>
          <div className="mb-1 font-medium">Section plane</div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={section.on}
              onChange={(e) => {
                // a model away from the origin (map coordinates): start the cut in its middle
                const [lo, hi, step] = offsetRange(info?.bounds ?? null, section);
                const inside = section.offset >= lo && section.offset <= hi;
                setSection({ ...section, on: e.target.checked, offset: inside ? section.offset : Math.round((lo + hi) / 2 / step) * step });
              }}
            />{" "}
            Cut the model
          </label>
          {section.on && (
            <div className="space-y-1">
              {(
                [
                  ["offset", "Offset", ...offsetRange(info?.bounds ?? null, section)],
                  ["tilt", "Tilt °", 0, 180, 1],
                  ["turn", "Turn °", -180, 180, 1],
                ] as const
              ).map(([k, label, min, max, step]) => (
                <label key={k} className="flex items-center gap-2">
                  <span className="w-12 text-muted">{label}</span>
                  <input type="range" min={min} max={max} step={step} value={section[k]} onChange={(e) => setSection({ ...section, [k]: Number(e.target.value) })} className="flex-1" />
                  <span className="w-10 text-right tabular-nums">{section[k]}</span>
                </label>
              ))}
              <div className="flex gap-1">
                {(
                  [
                    ["Horizontal", 0, 0],
                    ["Front", 90, 0],
                    ["Side", 90, 90],
                  ] as const
                ).map(([l, tilt, turn]) => (
                  <button key={l} type="button" onClick={() => setSection({ ...section, tilt, turn })} className="rounded border border-line px-1.5 py-0.5 text-muted hover:text-white">
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={!!opts.saveBlocked}
            title={opts.saveBlocked}
            onClick={() => save("section_plane", { section_plane_position: cutNormal(section).map((v) => Math.round(v * section.offset * 1e4) / 1e4), section_plane_quaternion: cutQuaternion(section).map((v) => Math.round(v * 1e6) / 1e6) })}
            className={buttonClass.ghost}
          >
            Save section plane
          </button>
          {scene.section_planes.map((s) => (
            <button key={s.primary_key} type="button" onClick={() => setSection(cutOf(s))} className="block text-ocean">
              Saved plane at [{s.section_plane_position.join(", ")}]
            </button>
          ))}
        </div>
      )}
      <div>
        <div className="mb-1 font-medium">Annotations ({scene.annotations.length})</div>
        {scene.annotations.map((a) => (
          <div key={a.primary_key} className="mb-1 rounded border border-line p-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: `#${(INTENT_COLOR[a.annotation_intent] ?? 0x94a3b8).toString(16).padStart(6, "0")}` }} />
              <span className="font-medium">{a.annotation_title}</span>
            </div>
            <div className="text-soft">{a.annotation_content}</div>
            <div className="text-muted">
              {a.part_instance_id} · {a.annotation_created_by}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-medium">Measurements ({scene.measurements.length})</div>
        {scene.measurements.map((m) =>
          opts.onMeasurement ? (
            <button key={m.primary_key} type="button" onClick={() => sendMeasurement(chunk(m.measurement_points))} className="block text-left text-soft hover:text-ocean" title="Send this measurement to the module" data-vc-measurement={m.primary_key}>
              {(m.measurement_points.length / 3) | 0} points · {polyLength(chunk(m.measurement_points)).toFixed(2)} {unit}
            </button>
          ) : (
            <div key={m.primary_key} className="text-soft">
              {(m.measurement_points.length / 3) | 0} points · {polyLength(chunk(m.measurement_points)).toFixed(2)} {unit}
            </div>
          ),
        )}
      </div>
    </>
  ) : null;

  return { scene, error, setError, reset, reload: () => (row ? loadScene(row) : Promise.resolve()), info, picked, toolbar, viewport, sidebar };
}

/** The 3D canvas: loads the model (meshes, drawings, point clouds), picks parts / layers / classes, shows the overlays. */
export function VulcanViewport({
  scene,
  tool,
  style,
  section,
  partColors,
  hidden,
  colorMode,
  pointSize,
  background,
  fallbackColor,
  partStyles,
  highlight,
  onInfo,
  measurePts,
  onPick,
}: {
  scene: Scene;
  tool: Tool;
  style: Style;
  section: Cut;
  partColors: Record<string, string>;
  hidden: Record<string, boolean>;
  colorMode: ColorMode;
  pointSize: number;
  background?: string;
  fallbackColor?: string;
  partStyles?: PartStyles;
  highlight?: string;
  onInfo: (info: ModelInfo) => void;
  measurePts: Point3[];
  onPick: (part: string, point: Point3) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const [status, setStatus] = useState("Loading model…");
  const pickRef = useRef(onPick);
  const infoRef = useRef(onInfo);
  useEffect(() => {
    pickRef.current = onPick;
    infoRef.current = onInfo;
  }, [onPick, onInfo]);

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    const el = host.current!;
    (async () => {
      const three = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (disposed) return;
      const renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
      /** unmounted while loading (React's development double mount): drop this renderer */
      const dropped = () => {
        if (!disposed) return false;
        renderer.dispose();
        renderer.domElement.remove();
        return true;
      };
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(el.clientWidth, el.clientHeight);
      renderer.localClippingEnabled = true;
      el.appendChild(renderer.domElement);
      const s = new three.Scene();
      s.add(new three.HemisphereLight(0xffffff, 0x334155, 1.6));
      const sun = new three.DirectionalLight(0xffffff, 1.4);
      sun.position.set(5, 10, 7);
      s.add(sun);
      const camera = new three.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.01, 10000);
      const controls = new OrbitControls(camera, renderer.domElement);
      const model = new three.Group();
      // model coordinates are kept: annotations and measurements live in the same group
      if (scene.model.up_axis === "Z") model.rotation.x = -Math.PI / 2;
      if (scene.model.up_axis === "X") model.rotation.z = Math.PI / 2;
      s.add(model);
      const overlay = new three.Group();
      model.add(overlay);
      const plane = new three.Plane(new three.Vector3(0, -1, 0), 0);
      const url = mediaUrl(scene.model.media!);
      let fmt = scene.model.format ?? "obj";
      let obj: THREE.Object3D;
      let info: ModelInfo | null = null;
      try {
        // drawings and point clouds are read by the loaders written here; an unnamed file is sniffed first
        let bytes: ArrayBuffer | null = null;
        if (!scene.model.format || fmt === "dxf" || fmt === "las" || fmt === "laz") {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`the file could not be read (${res.status})`);
          bytes = await res.arrayBuffer();
          if (!scene.model.format) fmt = sniffModel(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2048))) ?? "obj";
        }
        if (dropped()) return;
        if (bytes && (fmt === "dxf" || fmt === "las" || fmt === "laz")) {
          setStatus(fmt === "dxf" ? "Reading the drawing…" : "Reading the point cloud…");
          await new Promise((r) => setTimeout(r, 0));
          const cad = loadCad(three, fmt, bytes);
          obj = cad.object;
          const box = new three.Box3().setFromObject(obj); // before it joins the model: model coordinates
          info = { ...cad.info, bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() } };
        } else if (fmt === "glb" || fmt === "gltf") {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          obj = (await new GLTFLoader().loadAsync(url)).scene;
        } else if (fmt === "stl") {
          const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
          obj = new three.Mesh(await new STLLoader().loadAsync(url), new three.MeshStandardMaterial({ color: 0x9ca3af }));
          obj.name = "part";
        } else if (fmt === "ply") {
          const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
          const g = await new PLYLoader().loadAsync(url);
          g.computeVertexNormals();
          obj = new three.Mesh(g, new three.MeshStandardMaterial({ color: 0x9ca3af }));
          obj.name = "part";
        } else if (fmt === "3mf") {
          const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
          obj = await new ThreeMFLoader().loadAsync(url);
        } else {
          const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
          obj = await new OBJLoader().loadAsync(url);
        }
      } catch (e) {
        if (!dropped()) setStatus(`The model could not be loaded: ${(e as Error).message}`);
        return;
      }
      if (dropped()) return;
      const meshes: THREE.Mesh[] = [];
      const pickables: THREE.Object3D[] = [];
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = new three.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.1, roughness: 0.8, side: three.DoubleSide, clippingPlanes: [] });
          meshes.push(m);
          pickables.push(m);
        } else if ((o as THREE.LineSegments).isLineSegments || (o as THREE.Points).isPoints) pickables.push(o);
      });
      if (!info) {
        const local = new three.Box3().setFromObject(obj);
        info = { kind: "mesh", parts: [...new Set(meshes.map((m) => m.name || "part"))], bounds: local.isEmpty() ? null : { min: local.min.toArray(), max: local.max.toArray() } };
      }
      model.add(obj);
      const box = new three.Box3().setFromObject(model);
      const size = box.getSize(new three.Vector3()).length() || 1;
      const center = box.getCenter(new three.Vector3());
      controls.target.copy(center);
      if (info.kind === "drawing" && info.flat) camera.position.copy(center).add(new three.Vector3(0, size * 0.9, size * 0.001)); // a 2D drawing: from above
      else camera.position.copy(center).add(new three.Vector3(size * 0.6, size * 0.5, size * 0.7));
      camera.near = size / 1000;
      camera.far = size * 20;
      camera.updateProjectionMatrix();
      ctx.current = { three, renderer, model, overlay, plane, meshes, cad: info.kind === "mesh" ? null : obj, marker: info.kind === "mesh" ? 0.08 : size * 0.006 };
      infoRef.current(info);
      setStatus("");
      const ray = new three.Raycaster();
      const down = { x: 0, y: 0 };
      renderer.domElement.addEventListener("pointerdown", (e) => ((down.x = e.clientX), (down.y = e.clientY)));
      renderer.domElement.addEventListener("pointerup", (e) => {
        if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) return;
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new three.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        // lines and points are hit within about 6 pixels at the orbit target's distance
        const px = (2 * camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, r.height);
        ray.params.Line = { threshold: px * 6 };
        ray.params.Points = { threshold: px * 6 };
        // hidden layers / classes and the part cut away by the section plane are not picked
        const clip = ctx.current?.cutOn ? ctx.current.plane : null;
        const hit = ray.intersectObjects(pickables.filter(visible), false).find((h) => !clip || clip.distanceToPoint(h.point) >= 0);
        if (!hit) return;
        const local = model.worldToLocal(hit.point.clone());
        pickRef.current(hit.object.name || "part", [Number(local.x.toFixed(3)), Number(local.y.toFixed(3)), Number(local.z.toFixed(3))]);
      });
      const loop = () => {
        controls.update();
        renderer.render(s, camera);
        raf = requestAnimationFrame(loop);
      };
      loop();
      const ro = new ResizeObserver(() => {
        renderer.setSize(el.clientWidth, el.clientHeight);
        camera.aspect = el.clientWidth / el.clientHeight;
        camera.updateProjectionMatrix();
      });
      ro.observe(el);
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ctx.current?.renderer.dispose();
      ctx.current?.renderer.domElement.remove();
      ctx.current = null;
    };
  }, [scene.model.media, scene.model.format, scene.model.up_axis]);

  // style, part colors, section plane, annotations and measurements
  useEffect(() => {
    if (ctx.current) applyLook(ctx.current, { style, partColors, section, scene, measurePts, hidden, pointSize, background, fallbackColor, partStyles, highlight });
  }, [style, partColors, section, scene, measurePts, hidden, pointSize, background, fallbackColor, partStyles, highlight, status]);
  // point clouds: color by RGB, elevation, intensity or class
  useEffect(() => {
    const c = ctx.current;
    if (c?.cad) colorCloud(c.three, c.cad, colorMode);
  }, [colorMode, status]);

  return (
    <div ref={host} className={`absolute inset-0 ${tool !== "select" ? "cursor-crosshair" : ""}`} data-vc-viewport={status ? "loading" : "ready"}>
      {/* never a bare "" child: React would set the host's text and remove the canvas */}
      {status ? <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">{status}</div> : null}
    </div>
  );
}

type Ctx = {
  three: typeof THREE;
  renderer: THREE.WebGLRenderer;
  model: THREE.Group;
  overlay: THREE.Group;
  plane: THREE.Plane;
  meshes: THREE.Mesh[];
  /** the drawing or point cloud (layers / classes as named children), null for meshes */
  cad: THREE.Object3D | null;
  /** the default marker radius (annotations, measurement points) */
  marker: number;
  cutOn?: boolean;
};

/** The object and every parent are visible. */
function visible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

const HIGHLIGHT = "#38bdf8";

/** Apply the mesh style, part colors, the section plane and the overlays (annotations, measurements) to the scene. */
function applyLook(
  c: Ctx,
  o: {
    style: Style;
    partColors: Record<string, string>;
    section: Cut;
    scene: Scene;
    measurePts: Point3[];
    hidden: Record<string, boolean>;
    pointSize: number;
    background?: string;
    fallbackColor?: string;
    partStyles?: PartStyles;
    highlight?: string;
  },
) {
  const { style, partColors, section, scene, measurePts, hidden, pointSize, partStyles = {}, highlight } = o;
  const { three, meshes, overlay, plane, model } = c;
  c.cutOn = section.on;
  if (o.background) c.renderer.setClearColor(o.background, 1);
  else c.renderer.setClearColor(0x000000, 0);
  if (c.cad) {
    // layers and classes: visibility, a part color over the entity colors, x-ray, the section plane
    for (const part of c.cad.children) {
      if (hidden[part.name] !== undefined) part.visible = !hidden[part.name];
    }
    c.cad.traverse((x) => {
      const mat = (x as THREE.Mesh).material as THREE.Material | undefined;
      if (!mat || (x as THREE.Mesh).isMesh) return;
      const own = partColors[x.name] ?? partStyles[x.name]?.color ?? (highlight && highlight === x.name ? HIGHLIGHT : undefined);
      const opacity = partStyles[x.name]?.opacity;
      if (!(x as THREE.Sprite).isSprite) {
        const m = mat as THREE.LineBasicMaterial | THREE.PointsMaterial;
        m.vertexColors = !own;
        m.color.set(own ?? "#ffffff");
        if ((x as THREE.Points).isPoints) (m as THREE.PointsMaterial).size = (x.userData.lasClass === undefined ? 2 : 0) + pointSize;
      }
      mat.transparent = style === "xray" || (x as THREE.Sprite).isSprite || (opacity !== undefined && opacity < 1);
      mat.opacity = style === "xray" ? 0.25 : (opacity ?? 1);
      mat.clippingPlanes = section.on ? [plane] : [];
      mat.needsUpdate = true;
    });
  }
  for (const m of meshes) {
    const mat = m.material as THREE.MeshStandardMaterial;
    const opacity = partStyles[m.name]?.opacity;
    mat.color.set(partColors[m.name] ?? partStyles[m.name]?.color ?? o.fallbackColor ?? "#9ca3af");
    mat.emissive.set(highlight && highlight === m.name ? 0x0c4a6e : 0x000000);
    mat.wireframe = style === "wireframe";
    mat.transparent = style === "xray" || (opacity !== undefined && opacity < 1);
    mat.opacity = style === "xray" ? 0.22 : (opacity ?? 1);
    mat.depthWrite = style !== "xray";
    mat.clippingPlanes = section.on ? [plane] : [];
    mat.needsUpdate = true;
  }
  if (section.on) {
    // the cut in model coordinates (normal = the up axis tilted and turned; the part below the plane stays), then in
    // world space after the up-axis rotation
    model.updateMatrixWorld();
    const [nx, ny, nz] = cutNormal(section);
    const p = model.localToWorld(new three.Vector3(nx * section.offset, ny * section.offset, nz * section.offset));
    const n = new three.Vector3(-nx, -ny, -nz).transformDirection(model.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(n, p);
  }
  overlay.clear();
  for (const a of scene.annotations) {
    const r = a.annotation_sphere_size > 0 ? a.annotation_sphere_size : c.marker;
    const s = new three.Mesh(new three.SphereGeometry(r, 20, 14), new three.MeshBasicMaterial({ color: INTENT_COLOR[a.annotation_intent] ?? 0x94a3b8, depthTest: false }));
    s.position.set(a.annotation_attachment_x, a.annotation_attachment_y, a.annotation_attachment_z);
    s.renderOrder = 10;
    overlay.add(s);
  }
  const lines = [...scene.measurements.map((m) => chunk(m.measurement_points)), measurePts];
  for (const pts of lines) {
    if (pts.length < 2) {
      for (const p of pts) {
        const dot = new three.Mesh(new three.SphereGeometry(c.marker * 0.75, 10, 8), new three.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false }));
        dot.position.set(...p);
        overlay.add(dot);
      }
      continue;
    }
    const g = new three.BufferGeometry().setFromPoints(pts.map((p) => new three.Vector3(...p)));
    const line = new three.Line(g, new three.LineBasicMaterial({ color: 0x22d3ee, depthTest: false }));
    line.renderOrder = 11;
    overlay.add(line);
  }
}
