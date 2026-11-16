"use client";

import { useEffect, useRef, useState } from "react";
import { pageImageUrl, sourceUrl, type FileMeta } from "@/lib/api";
import { chunkColor, type ChunkBox } from "@/lib/chunks";
import { Icon } from "./Icon";

const ZOOMS = [50, 67, 80, 100, 125, 150, 200];

export function PageViewer({
  file,
  page,
  onPage,
  chunks,
}: {
  file: FileMeta;
  page: number;
  onPage: (page: number) => void;
  /** RAG chunk boxes drawn over the page, once the job has finished */
  chunks?: ChunkOverlay;
}) {
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [showChunks, setShowChunks] = useState(true);
  const [draft, setDraft] = useState(String(page));
  const [draftFor, setDraftFor] = useState(page);
  const [loadedSrc, setLoadedSrc] = useState("");
  const [paneWidth, setPaneWidth] = useState(720);
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the page box in step when the page changes from outside (e.g. the results pager)
  if (draftFor !== page) {
    setDraftFor(page);
    setDraft(String(page));
  }

  const go = (p: number) => onPage(Math.min(file.pages, Math.max(1, p)));
  // 720px is the 100% page width; "fit" follows the pane
  const width = zoom === "fit" ? Math.max(240, Math.floor(paneWidth - 48)) : Math.round((720 * zoom) / 100);
  const percent = Math.round((width / 720) * 100);
  const zi = ZOOMS.findIndex((z) => z >= percent);
  const zoomOut = () => setZoom([...ZOOMS].reverse().find((z) => z < percent) ?? ZOOMS[0]);
  const zoomIn = () => setZoom(ZOOMS.find((z) => z > percent) ?? ZOOMS[ZOOMS.length - 1]);
  // render at 1.5x for sharpness, in 200px steps so resizing the pane doesn't refetch every pixel
  const src = pageImageUrl(file.id, page, Math.min(2400, Math.ceil((width * 1.5) / 200) * 200));

  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-line">
      <div className="flex h-11 items-center gap-1 border-b border-line bg-panel px-2 text-sm">
        <IconButton label="Previous page" onClick={() => go(page - 1)} disabled={page <= 1}>
          <Icon name="left" />
        </IconButton>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(Number(draft) || 1)}
          onBlur={() => go(Number(draft) || 1)}
          className="w-12 rounded-md border border-line-2 bg-ink px-2 py-1 text-center tabular-nums outline-none focus:border-ocean"
          aria-label="Page number"
        />
        <span className="px-1 text-muted">of {file.pages}</span>
        <IconButton label="Next page" onClick={() => go(page + 1)} disabled={page >= file.pages}>
          <Icon name="right" />
        </IconButton>
        <span className="mx-2 h-5 w-px bg-line" />
        <IconButton label="Zoom out" onClick={zoomOut} disabled={percent <= ZOOMS[0]}>
          <Icon name="minus" />
        </IconButton>
        <span className="w-12 text-center tabular-nums text-soft">{percent}%</span>
        <IconButton label="Zoom in" onClick={zoomIn} disabled={zi === -1 || percent >= ZOOMS[ZOOMS.length - 1]}>
          <Icon name="plus" />
        </IconButton>
        <IconButton label="Fit to width" onClick={() => setZoom("fit")}>
          <Icon name="fit" />
        </IconButton>
        {chunks && (
          <button
            type="button"
            title={showChunks ? "Hide chunk boxes" : "Show chunk boxes"}
            aria-pressed={showChunks}
            onClick={() => setShowChunks(!showChunks)}
            className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs ${
              showChunks ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2 hover:text-white"
            }`}
          >
            <Icon name="layers" /> Chunks
          </button>
        )}
        <a
          href={sourceUrl(file.id)}
          className="rounded-md p-1.5 text-soft hover:bg-panel-2 hover:text-white"
          title="Download original"
        >
          <Icon name="download" />
        </a>
        <span className="ml-auto truncate pl-3 text-xs text-muted" title={file.name}>
          {file.name}
        </span>
      </div>
      <div ref={pane} className="dot-grid flex-1 overflow-auto bg-ink p-6">
        <div className="relative mx-auto" style={{ width }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- rendered by our API, not static */}
          <img
            key={src}
            src={src}
            alt={`Page ${page}`}
            onLoad={() => setLoadedSrc(src)}
            className={`w-full rounded-sm bg-white shadow-2xl shadow-black/50 transition-opacity ${
              loadedSrc === src ? "opacity-100" : "opacity-40"
            }`}
          />
          {chunks && showChunks && loadedSrc === src && <ChunkBoxes overlay={chunks} />}
        </div>
      </div>
    </div>
  );
}

export type ChunkOverlay = {
  boxes: ChunkBox[];
  /** the chunk highlighted here and in the chunk list */
  active: number | null;
  onActive: (chunk: number | null) => void;
  onSelect: (chunk: number) => void;
};

/** Each element's box, coloured by its chunk; the chunk number sits on its first box on the page. */
function ChunkBoxes({ overlay }: { overlay: ChunkOverlay }) {
  const { boxes, active, onActive, onSelect } = overlay;
  return (
    <div className="absolute inset-0" onMouseLeave={() => onActive(null)}>
      {boxes.map((b, i) => {
        const color = chunkColor(b.chunk);
        const on = active === b.chunk;
        return (
          <button
            key={i}
            type="button"
            title={`Chunk ${b.chunk + 1}`}
            onMouseEnter={() => onActive(b.chunk)}
            onClick={() => onSelect(b.chunk)}
            className="absolute rounded-[2px] transition-colors"
            style={{
              left: `${b.left}%`,
              top: `${b.top}%`,
              width: `${b.width}%`,
              height: `${b.height}%`,
              border: `1.5px solid ${color}`,
              background: `${color}${on ? "38" : "14"}`,
              opacity: active === null || on ? 1 : 0.35,
            }}
          >
            {b.first && (
              <span
                className="absolute -left-[1.5px] -top-4 rounded-t px-1 text-[10px] font-semibold leading-4 text-ink"
                style={{ background: color }}
              >
                {b.chunk + 1}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-soft hover:bg-panel-2 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
