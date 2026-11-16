"use client";

/** Object Explorer's "Open in" menu: the modules Carbon workspaces mark as discoverable for an object type. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { carbon, MODULE_LABEL, type ModuleRef, type WorkspaceSummary } from "@/lib/carbon";

/** The key Carbon opens a discoverable module by (?module=…). */
export const moduleKey = (m: ModuleRef) => `${m.type}:${m.id ?? m.objectTypeId ?? m.url ?? ""}`;

export function CarbonOpenIn({ typeId }: { typeId: string }) {
  const [list, setList] = useState<{ workspace: WorkspaceSummary; module: ModuleRef }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stale = false;
    carbon.discoverable(typeId).then((x) => !stale && setList(x), () => !stale && setList([]));
    return () => {
      stale = true;
    };
  }, [typeId]);
  if (!list.length) return null;
  return (
    <div className="relative" data-open-in>
      <button type="button" onClick={() => setOpen(!open)} className={buttonClass.secondary}>
        <Icon name="grid" className="h-3.5 w-3.5" /> Open in ({list.length})
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-line-2 bg-panel p-1 text-xs shadow-xl" onMouseLeave={() => setOpen(false)}>
          {list.map((x, i) => (
            <Link key={i} href={`/carbon/${x.workspace.id}?module=${encodeURIComponent(moduleKey(x.module))}`} target="_blank" className="block rounded px-2 py-1.5 hover:bg-panel-2" data-open-in-item>
              <div className="text-soft">{x.module.title || MODULE_LABEL[x.module.type]}</div>
              <div className="text-muted">
                {MODULE_LABEL[x.module.type]} · {x.workspace.title}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
