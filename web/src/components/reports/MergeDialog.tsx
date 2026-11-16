"use client";

import { useState } from "react";
import { buttonClass, Modal } from "@/components/pipeline/Modal";
import type { MergeConflict, MergeConflicts, Resolution } from "@/lib/reports";

/** Conflicts of a save merged with others' saves (api/reports.py merge_reports): per conflict keep mine or theirs,
 * then save the settled copy. Everything that did not conflict is merged already. */
export function MergeDialog({ merge, busy, error, onSave, onCancel }: {
  merge: MergeConflicts;
  busy?: boolean;
  error?: string | null;
  onSave: (resolutions: Record<string, Resolution>) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Record<string, Resolution>>({});
  const pick = (c: MergeConflict): Resolution => choice[c.id] ?? "mine";
  const all = (r: Resolution) => setChoice(Object.fromEntries(merge.conflicts.map((c) => [c.id, r])));
  const by = merge.theirs_by.length ? merge.theirs_by.join(", ") : "someone else";
  return (
    <Modal title="Merge your changes" icon="join" onClose={onCancel} wide>
      <div className="space-y-3 p-4 text-sm" role="dialog" aria-label="Merge conflicts">
        <p className="text-muted">
          {by} saved the report since you opened it (revision {merge.base_rev} → {merge.theirs_rev}). Changes to different
          widgets, parameters and settings are merged; {merge.conflicts.length === 1 ? "this change conflicts" : `these ${merge.conflicts.length} changes conflict`}.
          Choose which to keep.
        </p>
        <div className="flex items-center gap-2 text-xs">
          <button type="button" onClick={() => all("mine")} className={buttonClass.ghost}>Keep all mine</button>
          <button type="button" onClick={() => all("theirs")} className={buttonClass.ghost}>Keep all theirs</button>
        </div>
        <ul className="space-y-2" aria-label="Conflicts">
          {merge.conflicts.map((c) => (
            <li key={c.id} data-conflict={c.id} className="rounded-lg border border-line p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{c.scope === "report" ? "Report" : c.label}</span>
                <span className="text-xs text-muted">{what(c)}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["mine", "theirs"] as const).map((side) => (
                  <button key={side} type="button" aria-pressed={pick(c) === side} aria-label={`Keep ${side} for ${c.id}`}
                    onClick={() => setChoice((x) => ({ ...x, [c.id]: side }))}
                    className={`rounded border p-2 text-left text-xs ${pick(c) === side ? "border-ocean bg-ocean/10" : "border-line hover:border-line-2"}`}>
                    <span className="mb-1 block font-semibold">{side === "mine" ? "Keep mine" : `Keep theirs (${by})`}</span>
                    <span className="block whitespace-pre-wrap break-words text-muted">{show(c, side)}</span>
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" onClick={onCancel} className={buttonClass.secondary}>Keep editing</button>
          <button type="button" disabled={busy} onClick={() => onSave(Object.fromEntries(merge.conflicts.map((c) => [c.id, pick(c)])))} className={buttonClass.primary}>
            {busy ? "Saving…" : "Save merged report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function what(c: MergeConflict): string {
  if (c.kind === "deleted_mine") return "you deleted it; they changed it";
  if (c.kind === "deleted_theirs") return "you changed it; they deleted it";
  if (c.kind === "position") return "moved to different places";
  return `${(c.field ?? "").replace(/_/g, " ")} changed on both sides`;
}

function show(c: MergeConflict, side: "mine" | "theirs"): string {
  const v = c[side];
  if (c.kind === "position") return `Position ${String(v)} (was ${String(c.base)})`;
  if (c.kind === "deleted_mine" || c.kind === "deleted_theirs") {
    if (v === null || v === undefined) return "Deleted";
    const base = (c.base ?? {}) as Record<string, unknown>;
    const now = v as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(base), ...Object.keys(now)])].filter((k) => JSON.stringify(base[k]) !== JSON.stringify(now[k]));
    return `Kept, with changes to ${changed.map((k) => k.replace(/_/g, " ")).join(", ") || "nothing"}`;
  }
  if (v === null || v === undefined) return "(removed)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s || "(empty)";
}
