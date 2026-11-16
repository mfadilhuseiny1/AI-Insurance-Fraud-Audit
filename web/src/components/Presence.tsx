"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";

export type PresenceOther = { user_id: string; name: string; editing: boolean; at?: string | null; seconds_ago: number };
type Other = PresenceOther;

/**
 * Editing indicators: who else has this document open (api/presence.py). Sends a heartbeat every 15 seconds while
 * mounted — `editing` while in edit mode — and shows the others; a warning when someone else is editing too.
 */
export function PresenceBar({ itemId, editing, at, interval = 15_000, onOthers }: {
  itemId: string;
  editing: boolean;
  /** where in the document this user is (live cursors); with it, pass a shorter `interval` */
  at?: string;
  interval?: number;
  onOthers?: (others: PresenceOther[]) => void;
}) {
  const [others, setOthers] = useState<Other[]>([]);
  const where = useRef(at);
  const notify = useRef(onOthers);
  useEffect(() => {
    where.current = at;
    notify.current = onOthers;
  });
  useEffect(() => {
    let stop = false;
    const beat = () =>
      fetch(`${API_URL}/api/presence/${itemId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ editing, at: where.current ?? null }) })
        .then((r) => (r.ok ? r.json() : { others: [] }))
        .then((d: { others: Other[] }) => {
          if (stop) return;
          setOthers(d.others ?? []);
          notify.current?.(d.others ?? []);
        })
        .catch(() => undefined);
    void beat();
    const timer = window.setInterval(beat, interval);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [itemId, editing, interval]);
  useEffect(
    () => () => {
      void fetch(`${API_URL}/api/presence/${itemId}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    },
    [itemId],
  );
  if (!others.length) return null;
  const editors = others.filter((o) => o.editing);
  return (
    <span className="flex items-center gap-1 text-xs" title={others.map((o) => `${o.name}${o.editing ? " (editing)" : " (viewing)"}`).join(", ")}>
      {others.slice(0, 4).map((o) => (
        <span key={o.user_id} className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold uppercase ring-2 ${o.editing ? "bg-sand/20 text-sand ring-sand" : "bg-panel-2 text-soft ring-line"}`}>
          {o.name.slice(0, 2)}
        </span>
      ))}
      {editing && editors.length > 0 && <span className="text-sand">{editors.map((o) => o.name).join(", ")} {editors.length === 1 ? "is" : "are"} editing too — the last save wins</span>}
    </span>
  );
}
