"use client";

import { useEffect, useRef, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";

export type PickedLocation = { id: string; name: string };

const REMEMBER = "bluesandai.last-location";

function remembered(): PickedLocation | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(REMEMBER) ?? "null");
    return v && typeof v.id === "string" && typeof v.name === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Where a new resource is saved: a required field that reads like the other inputs, shows the chosen folder's path,
 * starts from the folder last chosen in any dialog (when it still exists and can be opened), and says so in red when
 * a create was attempted without it. Pair it with a create button that stays enabled and shows what is missing.
 */
export function LocationField({
  value,
  onChange,
  label = "Location",
  hint = "The Project or folder it is saved in.",
  invalid = false,
  remember = true,
}: {
  value: PickedLocation | null;
  onChange: (v: PickedLocation | null) => void;
  label?: string;
  hint?: string;
  /** a create was attempted while it is empty */
  invalid?: boolean;
  /** start from (and keep) the last folder chosen */
  remember?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [path, setPath] = useState<string[] | null>(null);
  const restored = useRef(false);

  // the last folder chosen anywhere, when it still opens
  useEffect(() => {
    if (!remember || value || restored.current) return;
    restored.current = true;
    const last = remembered();
    if (!last) return;
    api.drive.folder(last.id).then(
      () => onChange(last),
      () => {
        try {
          window.localStorage.removeItem(REMEMBER);
        } catch {
          // nothing remembered then
        }
      },
    );
  }, [remember, value, onChange]);

  // the chosen folder's path, for "Project / folder"
  useEffect(() => {
    if (!value) return;
    let stale = false;
    api.drive.folder(value.id).then(
      (f) => !stale && setPath([...(f.folder?.path ?? []).map((p) => p.name), f.folder?.name ?? value.name]),
      () => !stale && setPath(null),
    );
    return () => {
      stale = true;
    };
  }, [value]);

  const pick = (v: PickedLocation) => {
    onChange(v);
    if (remember) {
      try {
        window.localStorage.setItem(REMEMBER, JSON.stringify(v));
      } catch {
        // not remembered
      }
    }
  };

  return (
    <div className="block" data-location-field>
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">
        {label} <span className="text-bad" aria-hidden>*</span>
      </span>
      <button
        type="button"
        onClick={() => setPicking(true)}
        aria-describedby="location-field-hint"
        className={`flex w-full items-center gap-2 rounded-md border bg-ink px-2.5 py-2 text-left text-sm transition ${
          invalid && !value ? "border-bad ring-1 ring-bad/40" : "border-line-2 hover:border-ocean/60"
        }`}
      >
        <Icon name="folder" className={`h-4 w-4 shrink-0 ${value ? "text-ocean" : "text-muted"}`} />
        <span className={`min-w-0 flex-1 truncate ${value ? "text-strong" : "text-muted"}`}>
          {value ? (path ?? [value.name]).join(" / ") : "Choose a folder…"}
        </span>
        <span className="shrink-0 text-xs text-ocean">{value ? "Change" : "Browse"}</span>
      </button>
      <span id="location-field-hint" role={invalid && !value ? "alert" : undefined} className={`mt-1 block text-[11px] ${invalid && !value ? "text-bad" : "text-muted"}`}>
        {invalid && !value ? "Choose where to save it before creating." : hint}
      </span>
      {picking && (
        <DrivePicker
          title={`${label}: choose a folder`}
          onClose={() => setPicking(false)}
          folder={{
            action: "Use this folder",
            onPick: (f) => {
              if (f.id) pick({ id: f.id, name: f.name });
              setPicking(false);
            },
          }}
        />
      )}
    </div>
  );
}

/** What a create button still needs, as one sentence ("Enter a name and choose a location."), or null when ready. */
export function missingText(missing: string[]): string | null {
  if (!missing.length) return null;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `${list[0].toUpperCase()}${list.slice(1)}.`;
}
