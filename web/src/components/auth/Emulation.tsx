"use client";

import { useState } from "react";
import { auth, type Me } from "@/lib/auth";
import { Icon } from "../Icon";
import { buttonClass, Modal } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";

/**
 * Emulation mode (Account → Enable emulation mode): this session keeps only the groups and markings chosen here, and no
 * administrator powers, until it is exited, so you see the platform as a user with that access would.
 */
export function EmulationDialog({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<string[]>([]);
  const [markings, setMarkings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const own = me.markings.filter((m) => m.kind !== "organization");
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <Modal title="Enable emulation mode" icon="eye" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Test what a user with less access sees: the session keeps only the groups and markings you choose (and the markings those groups grant), your organization, and no administrator powers. Role grants, restricted views and object policies all follow.
        </p>
        <Field label="Groups to keep (none: as if you were in no group)">
          <div className="space-y-1 text-xs">
            {me.groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2">
                <input type="checkbox" checked={groups.includes(g.id)} onChange={() => toggle(groups, setGroups, g.id)} />
                {g.name}
              </label>
            ))}
            {me.groups.length === 0 && <span className="text-muted">You are in no groups.</span>}
          </div>
        </Field>
        <Field label="Additional markings to keep">
          <div className="space-y-1 text-xs">
            {own.map((m) => (
              <label key={m.id} className="flex items-center gap-2">
                <input type="checkbox" checked={markings.includes(m.id)} onChange={() => toggle(markings, setMarkings, m.id)} />
                {m.name}
              </label>
            ))}
            {own.length === 0 && <span className="text-muted">You hold no markings.</span>}
          </div>
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={() => auth.startEmulation(groups, markings).then(onDone, (e: Error) => setError(e.message))} className={buttonClass.primary}>
            Start emulation mode
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The banner shown while emulation mode is on, with what the session keeps and the way out. */
export function EmulationBanner({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  if (!me.emulation) return null;
  const names = me.markings.map((m) => m.name);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/15 px-4 py-1.5 text-xs">
      <Icon name="eye" className="h-3.5 w-3.5 text-warn" />
      <button type="button" onClick={() => setOpen(!open)} className="font-medium hover:underline">
        Emulation mode
      </button>
      <span className="truncate text-muted">
        {open ? `groups: ${me.groups.map((g) => g.name).join(", ") || "none"} · markings: ${names.join(", ") || "none"}` : "you see the platform with a scoped session"}
      </span>
      <button
        type="button"
        onClick={() => auth.endEmulation().then(() => window.location.reload())}
        className="ml-auto rounded border border-line-2 px-2 py-0.5 hover:text-white"
      >
        Exit emulation mode
      </button>
    </div>
  );
}
