"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { captureSnapshot, onCaptureChange, setCapture, type Capture } from "@/lib/drillCapture";

/** Shown while this browser reports its path to a team race. */
export function DrillCaptureBadge() {
  const raw = useSyncExternalStore(onCaptureChange, captureSnapshot, () => "null");
  const c = JSON.parse(raw) as Capture | null;
  if (!c) return null;
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
      <Icon name="clock" className="h-3 w-3" />
      Recording path for{" "}
      <Link href={`/ontology/design/drills/${c.drill_id}`} className="underline">
        {c.drill_name}
      </Link>{" "}
      as {c.participant}
      <button type="button" onClick={() => setCapture(null)} className="ml-1 hover:text-white" aria-label="Stop recording">
        <Icon name="x" className="h-3 w-3" />
      </button>
    </span>
  );
}
