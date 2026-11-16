"use client";

import { useMemo, useSyncExternalStore } from "react";
import { PIPELINES_CHANGED, PIPELINE_INDEX_KEY, pipelineKey, type Pipeline, type PipelineSummary } from "./pipeline";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PIPELINES_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PIPELINES_CHANGED, onChange);
  };
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

function parse<T>(raw: string | null | undefined, fallback: T): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** The saved pipelines, newest first; undefined until read in the browser. */
export function usePipelineList(): PipelineSummary[] | undefined {
  const raw = useSyncExternalStore(subscribe, () => read(PIPELINE_INDEX_KEY), () => undefined);
  return useMemo(() => parse<PipelineSummary[]>(raw, []), [raw]);
}

const noSubscribe = () => () => {};

/**
 * One pipeline as stored when the page opened (null if missing, undefined until read in the browser).
 * It does not follow later saves: the builder owns the live copy.
 */
export function useStoredPipeline(id: string): Pipeline | null | undefined {
  const raw = useSyncExternalStore(noSubscribe, () => read(pipelineKey(id)), () => undefined);
  return useMemo(() => parse<Pipeline | null>(raw, null), [raw]);
}
