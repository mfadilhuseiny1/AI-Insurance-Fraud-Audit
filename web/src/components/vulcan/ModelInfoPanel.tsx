"use client";

import type { ColorMode, ModelInfo } from "./cadGeometry";

const fmtN = (n: number) => n.toLocaleString("en-US");
const fmtV = (v: number[]) => v.map((x) => (Math.abs(x) >= 1000 ? x.toFixed(2) : Number(x.toPrecision(6)).toString())).join(", ");

/**
 * What Vulcan read from a drawing or point cloud: the DXF layers (colors, counts, visibility) or the LAS header and
 * classes (visibility, color by), with what was skipped and the warnings.
 */
export function ModelInfoPanel({
  info,
  hidden,
  onToggle,
  colorMode,
  onColorMode,
  pointSize,
  onPointSize,
}: {
  info: ModelInfo;
  hidden: Record<string, boolean>;
  onToggle: (part: string, hide: boolean) => void;
  colorMode: ColorMode;
  onColorMode: (m: ColorMode) => void;
  pointSize: number;
  onPointSize: (n: number) => void;
}) {
  if (info.kind === "mesh") return null;
  const warnings = info.warnings.length > 0 && (
    <div className="space-y-0.5 rounded border border-warn/40 bg-warn/5 p-2 text-warn">
      {info.warnings.map((w) => (
        <div key={w}>{w}</div>
      ))}
    </div>
  );
  if (info.kind === "drawing") {
    const skipped = Object.entries(info.skipped);
    return (
      <div className="space-y-2">
        <div>
          <div className="mb-1 font-medium">Drawing</div>
          <div className="text-muted">
            ASCII DXF{info.version ? ` ${info.version}` : ""} · {fmtN(info.segments)} segments · {info.blocks} blocks{info.flat ? " · 2D" : " · 3D"}
            {info.units && <> · header units {info.units}</>}
          </div>
          <div className="text-muted">
            {Object.entries(info.counts)
              .map(([t, n]) => `${t} ${n}`)
              .join(" · ")}
          </div>
          {skipped.length > 0 && <div className="text-muted">Not drawn: {skipped.map(([t, n]) => `${t} ${n}`).join(" · ")}</div>}
        </div>
        <div>
          <div className="mb-1 font-medium">Layers ({info.layers.length})</div>
          {info.layers.map((l) => {
            const empty = !l.segments && !l.points && !l.labels;
            return (
              <label key={l.name} className={`flex items-center gap-2 py-0.5 ${empty ? "opacity-50" : ""}`}>
                <input type="checkbox" disabled={empty} checked={!(hidden[l.name] ?? l.hidden)} onChange={(e) => onToggle(l.name, !e.target.checked)} />
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-line" style={{ background: l.color }} />
                <span className="truncate">{l.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted">{empty ? "empty" : fmtN(l.segments + l.points + l.labels)}</span>
              </label>
            );
          })}
        </div>
        {warnings}
      </div>
    );
  }
  const h = info.header;
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 font-medium">Point cloud</div>
        <div className="text-muted">
          LAS {h.version} · point format {h.pointFormat} · {fmtN(h.pointCount)} points{info.step > 1 ? ` (${fmtN(info.loaded)} shown)` : ""}
        </div>
        <div className="text-muted">scale {fmtV(h.scale)} · offset {fmtV(h.offset)}</div>
        <div className="text-muted">
          min {fmtV(h.min)} · max {fmtV(h.max)}
        </div>
        {(h.software || h.systemId) && <div className="text-muted">{[h.software, h.systemId].filter(Boolean).join(" · ")}</div>}
        {h.crs && <div className="text-muted">coordinate system: {h.crs === "wkt" ? "WKT" : "GeoTIFF keys"} (not reprojected)</div>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">Color by</span>
        <select value={colorMode} onChange={(e) => onColorMode(e.target.value as ColorMode)} className="rounded border border-line bg-panel-2 px-1 py-0.5">
          {info.hasColor && <option value="rgb">RGB{info.eightBitColor ? " (8-bit)" : ""}</option>}
          <option value="elevation">Elevation</option>
          <option value="intensity">Intensity</option>
          <option value="classification">Classification</option>
        </select>
      </div>
      <label className="flex items-center gap-2">
        <span className="text-muted">Point size</span>
        <input type="range" min={1} max={8} step={1} value={pointSize} onChange={(e) => onPointSize(Number(e.target.value))} className="flex-1" />
        <span className="w-4 text-right tabular-nums">{pointSize}</span>
      </label>
      <div>
        <div className="mb-1 font-medium">Classes ({info.classes.length})</div>
        {info.classes.map((c) => (
          <label key={c.code} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={!hidden[c.part]} onChange={(e) => onToggle(c.part, !e.target.checked)} />
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-line" style={{ background: c.color }} />
            <span className="truncate">
              {c.name} ({c.code})
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-muted">{fmtN(c.count)}</span>
          </label>
        ))}
      </div>
      {warnings}
    </div>
  );
}
