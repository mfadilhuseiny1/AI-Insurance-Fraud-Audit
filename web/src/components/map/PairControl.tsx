"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { COMMANDS, newPairCode, type Pairing } from "@/lib/appPairing";

/**
 * The "Pair" control of the Map application and Vertex: join a pairing code shared with Workshop modules (their App
 * Pairing widget) and other Map / Vertex windows; selections sync both ways and paired windows send commands.
 */
export function PairControl({ pairing, addIncoming, setAddIncoming, what }: { pairing: Pairing; addIncoming: boolean; setAddIncoming: (v: boolean) => void; what: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);
  const { paired, code, peers } = pairing;
  return (
    <div ref={box} className="relative" data-pairing={paired ? "on" : "off"}>
      <button type="button" onClick={() => setOpen(!open)} className={`${buttonClass.secondary} py-1 text-xs`} title="App Pairing: share selections with paired windows" data-pairing-open>
        <Icon name="link" className={`h-3.5 w-3.5 ${paired ? "text-ok" : ""}`} />
        {paired ? `Paired · ${code}${peers.length ? ` (${peers.length})` : ""}` : "Pair"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 space-y-2 rounded-md border border-line bg-panel p-3 text-xs shadow-xl">
          <div className="font-semibold">App Pairing</div>
          <p className="text-muted">
            Enter the pairing code of a Workshop module&apos;s App Pairing widget (or of another map or graph window). Selections sync both ways; paired
            windows can also send commands.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => pairing.setCode(e.target.value.trim())}
              disabled={paired}
              placeholder="Pairing code"
              className={`${fieldClass} w-32 text-xs`}
              aria-label="Pairing code"
              data-pairing-code
            />
            <button
              type="button"
              disabled={!code}
              onClick={() => (paired ? pairing.unpair() : pairing.pair())}
              className={`rounded px-2 py-1 ${paired ? "border border-line-2 text-soft" : "bg-ocean text-white"} disabled:opacity-40`}
              data-pairing-toggle
            >
              {paired ? "Unpair" : "Pair"}
            </button>
            {!paired && (
              <button type="button" onClick={() => pairing.setCode(newPairCode())} className="text-muted hover:text-white" title="New code" aria-label="New code">
                <Icon name="refresh" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="text-muted" data-pairing-peers={peers.length}>
            {paired
              ? peers.length
                ? `Paired with ${peers.map((p) => p.app).join(", ")}`
                : "Waiting for another window with this code…"
              : "Not paired."}
            {paired && pairing.last && <div className="mt-0.5 text-soft" data-pairing-last>Last: {pairing.last}</div>}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={addIncoming} onChange={(e) => setAddIncoming(e.target.checked)} className="accent-[var(--color-ocean)]" />
            Add selected objects that are not on the {what}
          </label>
          <details className="text-muted">
            <summary className="cursor-pointer">Commands this window accepts</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {COMMANDS.map((c) => (
                <li key={c.name}>{c.label}</li>
              ))}
            </ul>
            <p className="mt-1">
              From a paired window, or as <code>{'{type: "bluesandai.command", command, payload}'}</code> from a Workshop module embedding this page. The
              payload holds objects: <code>{"{object_type_id, primary_keys}"}</code>.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
