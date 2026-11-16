"use client";

import { useEffect, useState } from "react";
import { api, type Chunk, type Job, type ParseElement } from "./api";

/** One colour per chunk, cycled, shared by the page preview and the chunk list. */
const CHUNK_COLORS = ["#3d8bfd", "#e2b866", "#34c38f", "#c084fc", "#f0616d", "#22d3ee"];

export const chunkColor = (index: number) => CHUNK_COLORS[index % CHUNK_COLORS.length];

/** An element's box on the page, in percent of the page, tagged with the chunk it belongs to. */
export type ChunkBox = {
  chunk: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** the chunk's first box on this page, which carries its label */
  first: boolean;
};

type Coordinates = { points: number[][]; layout_width: number; layout_height: number };

export function chunkBoxes(elements: ParseElement[], chunks: Chunk[]): ChunkBox[] {
  const byId = new Map(elements.map((e) => [e.element_id, e]));
  const boxes: ChunkBox[] = [];
  for (const c of chunks) {
    let first = true;
    for (const id of c.element_ids ?? []) {
      const coords = byId.get(id)?.metadata.coordinates as Coordinates | undefined;
      if (!coords?.points?.length || !coords.layout_width || !coords.layout_height) continue;
      const xs = coords.points.map((p) => p[0]);
      const ys = coords.points.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      boxes.push({
        chunk: c.index,
        left: (x0 / coords.layout_width) * 100,
        top: (y0 / coords.layout_height) * 100,
        width: ((Math.max(...xs) - x0) / coords.layout_width) * 100,
        height: ((Math.max(...ys) - y0) / coords.layout_height) * 100,
        first,
      });
      first = false;
    }
  }
  return boxes;
}

/** Chunk boxes for one page of a completed job, fetched once per page. */
export function usePageChunkBoxes(job: Job | undefined, page: number): ChunkBox[] {
  const [byPage, setByPage] = useState<Record<string, ChunkBox[]>>({});
  const ready = job?.status === "completed" && page >= job.page_from && page <= job.page_to;
  const key = job ? `${job.id}:${page}` : "";

  useEffect(() => {
    if (!ready || !job || byPage[key]) return;
    let stale = false;
    Promise.all([api.page(job.id, page), api.chunks(job.id, page)])
      .then(([elements, chunks]) => !stale && setByPage((b) => ({ ...b, [key]: chunkBoxes(elements, chunks) })))
      .catch(() => !stale && setByPage((b) => ({ ...b, [key]: [] })));
    return () => {
      stale = true;
    };
  }, [ready, job, page, key, byPage]);

  return (ready && byPage[key]) || [];
}
