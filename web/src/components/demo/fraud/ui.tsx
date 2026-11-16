"use client";
import type { ReactNode } from "react";
import { TIER_TONE } from "./types";

export function ToneBadge({ text }: { text: string }) {
  const c = TIER_TONE[text] ?? "#8391a7";
  return <span className="inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: `${c}22`, color: c }}>{text}</span>;
}

export function ScoreBar({ value }: { value: number }) {
  const c = value >= 70 ? "#f0616d" : value >= 50 ? "#f0a843" : value >= 30 ? "#e2b866" : "#34c38f";
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded bg-line"><span className="block h-full rounded" style={{ width: `${Math.min(100, value)}%`, background: c }} /></span>
      <span className="tabular-nums font-medium">{value}</span>
    </span>
  );
}

export function StateMsg({ kind, text }: { kind: "loading" | "error" | "empty"; text: string }) {
  const cls = kind === "error" ? "border-bad/40 bg-bad/5 text-bad" : "border-line bg-panel text-muted";
  return <p className={`rounded-lg border p-4 text-center text-xs ${cls}`}>{text}</p>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  );
}

export function DataTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-[10.5px] uppercase tracking-wide text-muted">
          <tr className="border-b border-line">{head.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Pager({ total, limit, offset, onPage }: { total: number; limit: number; offset: number; onPage: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  const btn = "rounded-md border border-line-2 px-2 py-1 text-[11px] text-soft hover:border-ocean hover:text-white disabled:opacity-40";
  return (
    <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[11px] text-muted">
      <span>Halaman {page} dari {pages} · {total} baris</span>
      <span className="ml-auto flex gap-1.5">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(offset - limit)}>Sebelumnya</button>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(offset + limit)}>Berikutnya</button>
      </span>
    </div>
  );
}

export const inputCls = "rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs text-soft outline-none focus:border-ocean";
