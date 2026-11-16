"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { reports, type ReportRevision, type RevisionChange, type RevisionDiff } from "@/lib/reports";

/** A report's revision history (api/reports.py): the kept revisions with who / when / what changed, the changes
 * between two revisions, a read-only preview of one (shown in the page), and restoring one (saved as a new revision,
 * merged with saves made since like any save). */
export function HistoryPanel({ id, currentRev, dirty, canEdit, previewRev, onPreview, onRestore, onClose }: {
  id: string;
  /** the revision on screen; the list reloads when it changes */
  currentRev: number;
  /** unsaved changes on screen: restoring is disabled until they are saved */
  dirty: boolean;
  canEdit: boolean;
  /** the revision previewed in the page (null: the current report is shown) */
  previewRev: number | null;
  /** shows a revision read-only in the page (null: back to the current report) */
  onPreview: (r: ReportRevision | null) => void;
  onRestore: (rev: number) => Promise<void>;
  onClose: () => void;
}) {
  const [list, setList] = useState<ReportRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    reports.revisions(id).then((l) => (setList(l), setError(null)), (e: Error) => setError(e.message));
  }, [id, currentRev]);
  const latest = list?.[0]?.rev ?? currentRev;
  const pick = (r: ReportRevision) => {
    setSel(r.rev);
    // an older revision: what changed from it to now; the newest: what it changed from the one before
    const older = r.rev === latest && r.prev_rev !== null;
    setFrom(older ? r.prev_rev : r.rev);
    setTo(older ? r.rev : latest);
  };
  useEffect(() => {
    if (from === null || to === null) return;
    let live = true;
    reports.diff(id, from, to).then(
      (d) => {
        if (!live) return;
        setDiff(d);
        setDiffError(null);
      },
      (e: Error) => {
        if (!live) return;
        setDiff(null);
        setDiffError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [id, from, to, currentRev]);

  const selected = list?.find((r) => r.rev === sel) ?? null;
  const restore = async () => {
    if (sel === null) return;
    setBusy(true);
    try {
      await onRestore(sel);
    } finally {
      setBusy(false);
    }
  };
  const why = !canEdit ? "You can view this report but not edit it" : dirty ? "Save your changes first" : sel === latest ? "This is the current revision" : null;

  return (
    <aside aria-label="Revision history" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-line bg-panel shadow-2xl print:hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Icon name="history" className="h-4 w-4" />
        <span className="font-semibold">History</span>
        <span className="text-xs text-muted">{list ? `${list.length} revision${list.length === 1 ? "" : "s"} kept` : ""}</span>
        <button type="button" onClick={onClose} className={`${buttonClass.ghost} ml-auto`} aria-label="Close history">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-4 text-xs text-bad">{error}</p>}
        {!list && !error && <p className="p-4 text-xs text-muted">Loading…</p>}
        {list && list.length === 0 && <p className="p-4 text-xs text-muted">No revisions kept yet: each save adds one.</p>}
        <ul className="divide-y divide-line" aria-label="Revisions">
          {list?.map((r) => (
            <li key={r.rev}>
              <button type="button" data-rev={r.rev} aria-pressed={sel === r.rev} onClick={() => pick(r)}
                className={`block w-full px-4 py-2.5 text-left text-xs hover:bg-panel-2 ${sel === r.rev ? "bg-ocean/10" : ""}`}>
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-soft">Revision {r.rev}</span>
                  {r.rev === latest && <span className="rounded bg-ok/15 px-1.5 text-[10px] text-ok">current</span>}
                  {r.restored_from !== undefined && <span className="rounded bg-ocean/15 px-1.5 text-[10px] text-ocean">restored {r.restored_from}</span>}
                  {r.merged && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">merged</span>}
                  {r.rev === previewRev && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">previewing</span>}
                  <span className="ml-auto text-muted">{r.by} · {when(r.at)}</span>
                </span>
                <span className="mt-0.5 block break-words text-muted">{r.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected && list && (
        <div className="max-h-[55%] overflow-y-auto border-t border-line p-4 text-xs" aria-label="Changes between revisions">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-muted">Changes from</span>
            <RevSelect value={from} list={list} onChange={setFrom} label="From revision" />
            <span className="text-muted">to</span>
            <RevSelect value={to} list={list} onChange={setTo} label="To revision" />
          </div>
          {diffError && <p className="text-bad">{diffError}</p>}
          {diff && diff.changes.length === 0 && <p className="text-muted">No changes between these revisions.</p>}
          {diff && diff.changes.length > 0 && (
            <ul className="space-y-1.5" aria-label="Changes">
              {diff.changes.map((c, i) => <ChangeRow key={i} c={c} />)}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
            <button type="button" disabled={busy || !!why} onClick={restore} className={buttonClass.primary} title={why ?? `Save revision ${selected.rev}'s content as a new revision`}>
              <Icon name="restore" className="h-3.5 w-3.5" /> {busy ? "Restoring…" : `Restore revision ${selected.rev}`}
            </button>
            {sel !== latest && (
              previewRev === selected.rev ? (
                <button type="button" onClick={() => onPreview(null)} className={buttonClass.secondary} title="Show the current report again">
                  Back to current
                </button>
              ) : (
                <button type="button" onClick={() => onPreview(selected)} className={buttonClass.secondary} title={`Show revision ${selected.rev} read-only in the page, on today's data`}>
                  <Icon name="eye" className="h-3.5 w-3.5" /> Preview
                </button>
              )
            )}
            {why && sel !== latest && <span className="text-muted">{why}</span>}
          </div>
        </div>
      )}
    </aside>
  );
}

function RevSelect({ value, list, onChange, label }: { value: number | null; list: ReportRevision[]; onChange: (v: number) => void; label: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className={`${fieldClass} w-28 py-0.5 text-xs`}>
      {list.map((r, i) => <option key={r.rev} value={r.rev}>{`${r.rev}${i === 0 ? " (current)" : ""}`}</option>)}
    </select>
  );
}

const KIND_STYLE: Record<RevisionChange["kind"], string> = {
  added: "bg-ok/15 text-ok",
  removed: "bg-bad/15 text-bad",
  changed: "bg-ocean/15 text-ocean",
  moved: "bg-panel-2 text-muted",
};

function ChangeRow({ c }: { c: RevisionChange }) {
  const what = c.scope === "report" ? "Report" : c.scope === "parameter" ? `Parameter ${c.label}` : cap(c.label);
  return (
    <li data-change={`${c.scope}:${c.item_id ?? ""}:${c.kind}:${c.field ?? ""}`} className="rounded border border-line p-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`rounded px-1.5 text-[10px] ${KIND_STYLE[c.kind]}`}>{c.kind}</span>
        <span className="font-medium text-soft">{what}</span>
        {c.field && c.kind === "changed" && <span className="text-muted">{c.field.replace(/_/g, " ")}</span>}
      </div>
      {c.kind === "moved" && <p className="mt-1 text-muted">position {String(c.before)} → {String(c.after)}</p>}
      {c.kind === "changed" && (
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          <span className="break-words rounded bg-bad/5 px-1.5 py-0.5 text-muted line-through decoration-bad/50">{show(c.before)}</span>
          <span className="break-words rounded bg-ok/5 px-1.5 py-0.5 text-soft">{show(c.after)}</span>
        </div>
      )}
    </li>
  );
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s || "(empty)";
}

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
