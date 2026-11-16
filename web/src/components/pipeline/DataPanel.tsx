"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { api, type DriveItem } from "@/lib/api";
import { DATA_FILE } from "@/lib/deployed";

/** What a dataset drag carries onto the pipeline canvas (Graph's onDropDataset). */
export const DATASET_MIME = "application/x-bluesandai-dataset";
export type DraggedDataset = { item: DriveItem; path: string[] };

/**
 * Data: browse Files & Projects and drag datasets onto the canvas — each becomes an input node where it is dropped
 * (several at once with Ctrl/⌘-click before dragging).
 */
export function DataPanel({ onClose }: { onClose: () => void }) {
  const [trail, setTrail] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "Files" }]);
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const here = trail[trail.length - 1];
  useEffect(() => {
    setItems(null);
    setPicked([]);
    api.drive.folder(here.id).then(
      (f) => setItems(f.items),
      (e: Error) => setError(e.message),
    );
  }, [here.id]);
  const path = trail.slice(1).map((t) => t.name);
  const shown = (items ?? []).filter((i) => !i.trashed_at && i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const isData = (i: DriveItem) => i.kind === "file" && DATA_FILE.test(i.name);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel text-xs" data-data-panel>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="table" className="h-4 w-4 text-ocean" />
        <span className="font-medium">Data</span>
        <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <p className="px-3 pt-2 text-[11px] text-muted">Drag a dataset onto the canvas to add it as an input. Ctrl-click to pick several, then drag one of them.</p>
      <div className="flex flex-wrap items-center gap-1 px-3 pt-2 text-[11px]">
        {trail.map((t, i) => (
          <button key={`${t.id}-${i}`} type="button" onClick={() => setTrail(trail.slice(0, i + 1))} className="text-ocean hover:underline">
            {i ? "/ " : ""}
            {t.name}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter this folder…" className="mx-3 mt-2 rounded border border-line-2 bg-ink px-2 py-1 outline-none" />
      {error && <p className="px-3 pt-2 text-bad">{error}</p>}
      <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {items === null && <li className="px-2 py-1 text-muted">Loading…</li>}
        {shown.map((i) => {
          const data = isData(i);
          const on = picked.includes(i.id);
          return (
            <li
              key={i.id}
              draggable={data}
              onDragStart={(e) => {
                const ids = on ? picked : [i.id];
                const payload: DraggedDataset[] = shown.filter((x) => ids.includes(x.id)).map((x) => ({ item: x, path }));
                e.dataTransfer.setData(DATASET_MIME, JSON.stringify(payload));
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(e) => {
                if (!data) return i.kind !== "file" && setTrail([...trail, { id: i.id, name: i.name }]);
                setPicked(e.ctrlKey || e.metaKey ? (on ? picked.filter((x) => x !== i.id) : [...picked, i.id]) : on ? [] : [i.id]);
              }}
              data-dataset={data ? i.name : undefined}
              className={`flex items-center gap-2 rounded px-2 py-1 ${data ? "cursor-grab" : i.kind === "file" ? "opacity-50" : "cursor-pointer"} ${on ? "bg-ocean/20 text-white" : "hover:bg-panel-2"}`}
              title={data ? "Drag onto the canvas" : i.kind === "file" ? "Not a dataset" : "Open"}
            >
              <Icon name={i.kind === "project" ? "project" : i.kind === "folder" ? "folder" : data ? "table" : "doc"} className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              {i.kind !== "file" && <Icon name="right" className="h-3 w-3 text-muted" />}
            </li>
          );
        })}
        {items && !shown.length && <li className="px-2 py-1 text-muted">Nothing here.</li>}
      </ul>
    </aside>
  );
}
