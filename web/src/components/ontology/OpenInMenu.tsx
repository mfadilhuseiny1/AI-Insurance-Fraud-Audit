"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { carbon, moduleUrl, type ModuleRef, type WorkspaceSummary } from "@/lib/carbon";

/** Where else an object opens: the modules Carbon workspaces make discoverable for its object type. */
export function OpenInMenu({ typeId, pk }: { typeId: string; pk: string }) {
  const [items, setItems] = useState<{ workspace: WorkspaceSummary; module: ModuleRef }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    carbon.discoverable(typeId).then(setItems, () => setItems([]));
  }, [typeId]);
  if (!items.length) return null;
  // the module's own page (not embedded), opened on this object
  const href = (m: ModuleRef) => {
    const url = moduleUrl({ ...m, objectTypeId: m.objectTypeId ?? typeId, pk: m.type === "object" ? pk : m.pk }).replace(/([?&])embed=1&?/, "$1").replace(/[?&]$/, "");
    return m.type === "workshop" ? `${url}${url.includes("?") ? "&" : "?"}object=${encodeURIComponent(pk)}` : url;
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded border border-line-2 px-2 py-1 text-xs text-soft hover:border-ocean">
        <Icon name="external" className="h-3.5 w-3.5" /> Open in
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-line bg-panel p-1 text-xs shadow-xl">
          {items.map(({ workspace, module }, i) => (
            <Link key={i} href={href(module)} className="block rounded px-2 py-1.5 hover:bg-panel-2" onClick={() => setOpen(false)}>
              <div className="text-white">{module.title || module.id || module.type}</div>
              <div className="text-muted">{workspace.title}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
