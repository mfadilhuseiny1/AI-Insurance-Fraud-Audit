"use client";

import type { MarkingRef } from "@/lib/auth";
import { Icon } from "../Icon";

/** A marking (or organization) as a small colored chip. */
export function MarkingChip({ m, onRemove, title }: { m: MarkingRef; onRemove?: () => void; title?: string }) {
  return (
    <span
      title={title ?? (m.kind === "organization" ? "Organization" : "Marking")}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
      style={{ backgroundColor: `${m.color ?? "#c0392b"}cc` }}
    >
      <Icon name={m.kind === "organization" ? "project" : "eye"} className="h-3 w-3" />
      {m.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="ml-0.5 opacity-80 hover:opacity-100">
          <Icon name="x" className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
