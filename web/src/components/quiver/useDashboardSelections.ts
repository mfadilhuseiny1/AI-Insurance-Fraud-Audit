"use client";

import { useCallback, useEffect, useState } from "react";
import { SELECTOR_CARD_KINDS, type Selection, type TableResult } from "@/lib/quiverTables";

type Selections = Record<string, Selection>;
/** Runs the dashboard's table cards with the viewer's selections in its selector cards. */
export type RunWithSelections = (selections: Selections) => Promise<Record<string, TableResult>>;

const NONE: Selections = {};
const isSelector = (k: unknown) => (SELECTOR_CARD_KINDS as readonly string[]).includes(String(k));

/**
 * A dashboard viewer's selections in its selector parameter cards: for this view only (nothing is saved). While a
 * selection is made the dashboard's cards are re-run with it (`run`) and the dependent cards show that answer; `reset`
 * goes back to the saved defaults. The selections are dropped when `resetKey` changes (another dashboard, version,
 * object or the editor leaving dashboard mode). A new `run` (e.g. the editor's draft changed) re-runs the current selections; an older answer arriving late
 * is dropped.
 */
export function useDashboardSelections(run: RunWithSelections | null, resetKey: string) {
  const [selections, setSelections] = useState<Selections>(NONE);
  const [answer, setAnswer] = useState<{ for: Selections; results?: Record<string, TableResult>; error?: string } | null>(null);
  // another dashboard, version, object or mode: start again from the defaults (also when a key comes back)
  const [shownKey, setShownKey] = useState(resetKey);
  if (shownKey !== resetKey) {
    setShownKey(resetKey);
    setSelections(NONE);
    setAnswer(null);
  }
  const active = Object.keys(selections).length > 0;
  useEffect(() => {
    if (!run || selections === NONE) return;
    let live = true;
    run(selections).then(
      (results) => live && setAnswer({ for: selections, results }),
      (e: Error) => live && setAnswer({ for: selections, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [run, selections]);
  const current = active ? answer : null;
  const select = useCallback((cardId: string, v: Selection) => setSelections((s) => ({ ...s, [cardId]: v })), []);
  const reset = useCallback(() => {
    setSelections(NONE);
    setAnswer(null);
  }, []);
  /** The card as the viewer sees it: a selector card shows the viewer's selection. */
  const cardFor = <T extends { id: unknown; kind?: unknown }>(card: T): T => {
    const id = String(card.id);
    return isSelector(card.kind) && id in selections ? { ...card, value: selections[id] } : card;
  };
  return {
    selections,
    active,
    select,
    reset,
    cardFor,
    /** The results to show: the answer for the selections (the previous one while a new one runs), else the defaults. */
    results: (defaults: Record<string, TableResult>) => current?.results ?? defaults,
    /** True while the answer for the latest selections has not arrived. */
    pending: active && current?.for !== selections,
    error: current && current.for === selections ? current.error ?? null : null,
  };
}
