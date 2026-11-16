"use client";

import type { ChartValue } from "@/lib/fusion";
import { chartGeometry, chartSize } from "@/lib/fusionChart";

/**
 * A chart cell (chart.bar / chart.line / chart.chart) as SVG. Without a size it is a small chart inside the cell;
 * with chart.options('width', …, 'height', …) it is a panel of that size anchored at the cell's top-left corner.
 * Zooming, the toolbar and range selection of Fusion's charts are not drawn.
 */
export function FusionChart({ chart }: { chart: ChartValue }) {
  const size = chartSize(chart);
  const g = size ? chartGeometry(chart, size.width, size.height) : chartGeometry(chart, 100, 22, true);
  const svg = (
    <svg
      viewBox={`0 0 ${g.width} ${g.height}`}
      width={size ? g.width : undefined}
      height={size ? g.height : undefined}
      preserveAspectRatio={size ? undefined : "none"}
      className={size ? "block" : "block h-[22px] w-full"}
      role="img"
      aria-label={`Chart: ${chart.plots.map((p) => `${p.type} of ${p.y.length} values`).join(", ")}`}
    >
      {g.axes &&
        g.valueTicks.map((t, i) =>
          g.horizontal ? (
            <g key={`v${i}`}>
              <line x1={t.at} x2={t.at} y1={g.area.y0} y2={g.area.y1} className="stroke-line" strokeWidth={1} />
              <text x={t.at} y={g.area.y1 + 13} textAnchor="middle" className="fill-muted text-[10px]">
                {t.label}
              </text>
            </g>
          ) : (
            <g key={`v${i}`}>
              <line x1={g.area.x0} x2={g.area.x1} y1={t.at} y2={t.at} className="stroke-line" strokeWidth={1} />
              <text x={g.area.x0 - 5} y={t.at + 3} textAnchor="end" className="fill-muted text-[10px]">
                {t.label}
              </text>
            </g>
          ),
        )}
      {g.axes &&
        g.xTicks.map((t, i) =>
          g.horizontal ? (
            <text key={`x${i}`} x={g.area.x0 - 5} y={t.at + 3} textAnchor="end" className="fill-muted text-[10px]">
              {t.label}
            </text>
          ) : (
            <text key={`x${i}`} x={t.at} y={g.area.y1 + 13} textAnchor="middle" className="fill-muted text-[10px]">
              {t.label}
            </text>
          ),
        )}
      {g.bars.map((b, i) => (
        <g key={`b${i}`}>
          <rect x={b.x} y={b.y} width={Math.max(b.w, 0.5)} height={Math.max(b.h, 0.5)} fill={b.color} rx={size ? 1.5 : 0}>
            {b.title && <title>{b.title}</title>}
          </rect>
          {b.label &&
            (g.horizontal ? (
              <text x={b.value < 0 ? b.x - 3 : b.x + b.w + 3} y={b.y + b.h / 2 + 3} textAnchor={b.value < 0 ? "end" : "start"} className="fill-soft text-[10px]">
                {b.label}
              </text>
            ) : (
              <text x={b.x + b.w / 2} y={b.value < 0 ? b.y + b.h + 11 : b.y - 3} textAnchor="middle" className="fill-soft text-[10px]">
                {b.label}
              </text>
            ))}
        </g>
      ))}
      {g.lines.map((l, i) => (
        <g key={`l${i}`}>
          <path d={l.d} fill="none" stroke={l.color} strokeWidth={size ? 2 : 1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {size &&
            l.points.map((p, j) => (
              <circle key={j} cx={p.x} cy={p.y} r={l.markers ? 3 : 6} fill={l.markers ? l.color : "transparent"}>
                {p.title && <title>{p.title}</title>}
              </circle>
            ))}
        </g>
      ))}
      {g.legend.map((item, i) => (
        <g key={`g${i}`} transform={`translate(${g.area.x0 + i * 110}, 4)`}>
          <rect width={8} height={8} y={1} fill={item.color} rx={1.5} />
          <text x={12} y={9} className="fill-soft text-[10px]">
            {item.label}
          </text>
        </g>
      ))}
    </svg>
  );
  if (!size) return svg;
  return (
    <div className="absolute left-0 top-0 z-[5] rounded border border-line-2 bg-panel p-1 shadow-lg" style={{ width: g.width + 10 }}>
      {svg}
    </div>
  );
}
