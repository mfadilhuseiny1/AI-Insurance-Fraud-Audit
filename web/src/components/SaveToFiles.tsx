"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DriveItem, ResultFormat } from "@/lib/api";
import { DrivePicker, type PickedFolder } from "./DrivePicker";
import { Icon } from "./Icon";
import { alertDialog } from "@/lib/dialogs";

/** a parse job's result formats */
export const RESULT_FORMATS: { id: ResultFormat; label: string }[] = [
  { id: "json", label: "JSON" },
  { id: "md", label: "MD" },
  { id: "txt", label: "TXT" },
];

/**
 * "Save to Files": pick formats and a project or folder, then `save` copies the results there.
 * A note with a link to the folder shows for a few seconds afterwards.
 */
export function SaveToFiles<F extends string>({
  title,
  formats,
  save,
  iconOnly = false,
  className,
}: {
  title: string;
  formats: { id: F; label: string }[];
  save: (formats: F[], parentId: string | null) => Promise<DriveItem[]>;
  iconOnly?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<F[]>(formats.map((f) => f.id));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ count: number; folder: PickedFolder } | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 8000);
    return () => clearTimeout(t);
  }, [saved]);

  // keep the formats in their listed order
  const toggle = (id: F) =>
    setChosen((cur) => formats.map((f) => f.id).filter((x) => (x === id ? !cur.includes(id) : cur.includes(x))));

  const saveTo = async (folder: PickedFolder) => {
    setBusy(true);
    try {
      const items = await save(chosen, folder.id);
      setSaved({ count: items.length, folder });
      setOpen(false);
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Save to a project or folder in Files"
        className={
          className ??
          (iconOnly
            ? "rounded p-1.5 text-muted hover:bg-panel-2 hover:text-sand"
            : "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-soft hover:text-white")
        }
      >
        <Icon name="folderPlus" className={iconOnly ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!iconOnly && "Save to Files"}
      </button>

      {open && (
        <DrivePicker
          title={title}
          onClose={() => setOpen(false)}
          folder={{
            action: busy ? "Saving…" : "Save here",
            busy: busy || chosen.length === 0,
            onPick: saveTo,
            extra:
              formats.length > 1 ? (
                <div className="flex items-center gap-3 text-xs text-soft">
                  {formats.map((f) => (
                    <label key={f.id} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={chosen.includes(f.id)}
                        onChange={() => toggle(f.id)}
                        className="accent-ocean"
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              ) : null,
          }}
        />
      )}

      {saved && (
        <div className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm shadow-2xl">
          <Icon name="check" className="h-4 w-4 text-ok" />
          Saved {saved.count} {saved.count === 1 ? "file" : "files"} to {saved.folder.name}
          <Link href={saved.folder.id ? `/files/${saved.folder.id}` : "/files"} className="text-ocean hover:underline">
            Open
          </Link>
          <button type="button" onClick={() => setSaved(null)} className="text-muted hover:text-white" title="Dismiss">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
