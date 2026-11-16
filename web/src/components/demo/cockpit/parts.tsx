"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { datasetUrl, lineageUrl, objUrl, typeUrl, type Ref, type Sumber } from "./api";

/* Shared pieces of the grid cockpit: severity/status badges, links into Nexus/lineage, provenance chips, a sortable
   exportable table, and a single-series bar strip. Severity colours are reserved for state and always carry a label. */

export const SEV: Record<string, { label: string; color: string; icon: IconName }> = {
  critical: { label: "Kritis", color: "#dc2626", icon: "alert" },
  warning: { label: "Peringatan", color: "#f97316", icon: "bell" },
  info: { label: "Info", color: "#38bdf8", icon: "info" },
};
export const RISK_COLOR: Record<string, string> = { Tinggi: "#dc2626", Sedang: "#f97316", Rendah: "#22c55e" };
export const STATUS_TONE: Record<string, string> = {
  Baru: "border-red-500/50 bg-red-500/10 text-red-200",
  Diakui: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  Ditugaskan: "border-sky-500/50 bg-sky-500/10 text-sky-200",
  Selesai: "border-emerald-500/50 bg-emerald-500/10 text-emerald-200",
  Pulih: "border-emerald-500/40 bg-emerald-500/5 text-emerald-300",
};

export function SevBadge({ sev }: { sev: string }) {
  const s = SEV[sev] ?? SEV.info;
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: s.color, background: `${s.color}1f` }}>
      <Icon name={s.icon} className="h-3 w-3" /> {s.label}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[status] ?? "border-line-2 text-soft"}`}>{status}</span>;
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: `${color}80`, color, background: `${color}14` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {text}
    </span>
  );
}

/** a value that opens its Nexus object (new tab keeps the cockpit in place) */
export function NexusLink({ r, children, className = "" }: { r: Ref; children: ReactNode; className?: string }) {
  const href = objUrl(r);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link href={href} target="_blank" title="Buka objek Nexus" className={`inline-flex items-center gap-1 text-ocean hover:underline ${className}`} onClick={(e) => e.stopPropagation()}>
      {children}
      <Icon name="link" className="h-3 w-3 shrink-0 opacity-70" />
    </Link>
  );
}

/** provenance: the Nexus types and datasets a widget reads, each to its app and its lineage node */
export function Sources({ items, note }: { items?: Sumber[]; note?: string }) {
  if (!items?.length && !note) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[10px] text-muted">
      <span className="font-medium uppercase tracking-wide">Sumber</span>
      {(items ?? []).map((s) => {
        const isType = !!s.type_id;
        return (
          <span key={`${s.key}-${s.type_id ?? s.dataset_id}`} className="inline-flex items-center overflow-hidden rounded border border-line-2">
            <Link
              href={(isType ? typeUrl(s.type_id) : datasetUrl(s.dataset_id)) ?? "#"}
              target="_blank"
              className={`flex items-center gap-1 px-1.5 py-0.5 hover:text-white ${isType ? "bg-violet-500/10 text-violet-200" : "bg-ink text-soft"}`}
              title={isType ? "Object type Nexus" : "Dataset"}
            >
              <Icon name={isType ? "cube" : "database"} className="h-3 w-3" />
              {s.nama}
            </Link>
            {s.lineage && (
              <Link href={lineageUrl(s.lineage)!} target="_blank" className="border-l border-line-2 px-1 py-0.5 hover:text-white" title="Buka di Data Lineage">
                <Icon name="split" className="h-3 w-3" />
              </Link>
            )}
          </span>
        );
      })}
      {note && <span className="basis-full text-[10px] leading-snug">{note}</span>}
    </div>
  );
}

export type Col<T> = { key: string; label: string; render?: (r: T) => ReactNode; value?: (r: T) => string | number | null | undefined; align?: "right"; width?: string };

/** a sortable table with CSV export of the rows it shows (what the account may see) */
export function DataTable<T extends Record<string, unknown>>({
  rows, cols, name, maxH = "max-h-96", onRow, empty = "Tidak ada baris.", initialSort,
}: { rows: T[]; cols: Col<T>[]; name: string; maxH?: string; onRow?: (r: T) => void; empty?: string; initialSort?: { key: string; desc: boolean } }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ?? null);
  const val = (c: Col<T>, r: T) => (c.value ? c.value(r) : (r[c.key] as string | number | null | undefined));
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = cols.find((x) => x.key === sort.key);
    if (!c) return rows;
    return [...rows].sort((a, b) => {
      const x = val(c, a);
      const y = val(c, b);
      const r = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), "id");
      return sort.desc ? -r : r;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, cols]);
  const csv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [cols.map((c) => esc(c.label)).join(","), ...sorted.map((r) => cols.map((c) => esc(val(c, r))).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="min-w-0">
      <div className={`${maxH} overflow-auto`}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-panel text-left text-muted">
            <tr className="border-b border-line">
              {cols.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-2 py-2 font-medium ${c.align === "right" ? "text-right" : ""}`} style={c.width ? { width: c.width } : undefined}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-white"
                    onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: true }))}
                  >
                    {c.label}
                    {sort?.key === c.key && <span aria-hidden>{sort.desc ? "↓" : "↑"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} onClick={onRow ? () => onRow(r) : undefined} className={`border-b border-line/50 last:border-0 ${onRow ? "cursor-pointer hover:bg-white/5" : ""}`}>
                {cols.map((c) => (
                  <td key={c.key} className={`px-2 py-1.5 align-top ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                    {c.render ? c.render(r) : String(val(c, r) ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
            {!sorted.length && (
              <tr>
                <td colSpan={cols.length} className="px-2 py-4 text-center text-muted">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
        <span>{sorted.length} baris</span>
        <button type="button" onClick={csv} className="inline-flex items-center gap-1 hover:text-white">
          <Icon name="download" className="h-3 w-3" /> CSV
        </button>
      </div>
    </div>
  );
}

/** one series of bars (e.g. monthly SAIDI): single hue, value label on hover, the period under each bar */
export function Bars({ data, unit, color = "#38bdf8", height = 120, onPick, picked }: {
  data: { label: string; value: number; note?: string }[]; unit: string; color?: string; height?: number; onPick?: (label: string) => void; picked?: string | null;
}) {
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="relative">
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d, i) => (
          <button
            key={d.label}
            type="button"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => onPick?.(d.label)}
            className="group relative flex h-full flex-1 flex-col justify-end"
            aria-label={`${d.label}: ${d.value.toLocaleString("id-ID", { maximumFractionDigits: 2 })} ${unit}`}
          >
            <span
              className="block w-full rounded-t transition-[filter] group-hover:brightness-125"
              style={{ height: `${Math.max(1.5, (d.value / max) * 100)}%`, background: color, opacity: picked && picked !== d.label ? 0.35 : 1 }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 border-t border-line pt-1">
        {data.map((d) => (
          <span key={d.label} className="flex-1 truncate text-center text-[10px] text-muted">
            {d.label}
          </span>
        ))}
      </div>
      {hover != null && data[hover] && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-md border border-line-2 bg-ink px-2 py-1 text-[11px] shadow-lg"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%`, top: 0 }}
        >
          <div className="font-medium">{data[hover].label}</div>
          <div className="tabular-nums text-soft">
            {data[hover].value.toLocaleString("id-ID", { maximumFractionDigits: 2 })} {unit}
          </div>
          {data[hover].note && <div className="text-muted">{data[hover].note}</div>}
        </div>
      )}
    </div>
  );
}

/** a horizontal meter for a percentage against an alarm threshold */
export function Meter({ pct, warn = 80, crit = 100 }: { pct: number | null | undefined; warn?: number; crit?: number }) {
  const v = pct ?? 0;
  const color = v > crit ? "#dc2626" : v > warn ? "#f97316" : "#22c55e";
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-24 overflow-hidden rounded bg-ink">
        <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.min(100, (v / Math.max(crit, v)) * 100)}%`, background: color }} />
        <span className="absolute inset-y-0 w-px bg-white/40" style={{ left: `${(warn / Math.max(crit, v)) * 100}%` }} />
      </span>
      <span className="w-14 text-right tabular-nums">{pct == null ? "—" : `${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`}</span>
    </span>
  );
}

export function Loading({ text = "Memuat…" }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-line bg-panel px-3 py-2 text-xs text-muted">
      <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> {text}
    </div>
  );
}

export function Unavailable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-amber-300">
        <Icon name="info" className="h-3.5 w-3.5" /> {title}
      </div>
      <div className="mt-1 text-muted">{children}</div>
    </div>
  );
}
