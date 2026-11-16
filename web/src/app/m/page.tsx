"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { workshop, type MobileApp } from "@/lib/workshop";

/** The mobile app launcher: search, browse and open the Workshop modules built for phones (device type Mobile). It loads
 * only a light list of the applications, without the platform's sidebar. */
export default function MobileLauncher() {
  const [apps, setApps] = useState<MobileApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    document.title = "Mobile apps";
    workshop.mobileApps().then(setApps, (e: Error) => setError(e.message));
  }, []);
  const shown = (apps ?? []).filter((a) => !q.trim() || `${a.title} ${a.name} ${a.description}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="foundry-light flex flex-1 flex-col overflow-hidden bg-ink" data-mobile-launcher>
      <div className="shrink-0 border-b border-line bg-panel px-4 pb-3 pt-4">
        <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <Icon name="device" className="h-5 w-5 text-ocean" /> Mobile apps
        </h1>
        <div className="flex items-center gap-2 rounded-lg border border-line-2 bg-ink px-3">
          <Icon name="search" className="h-4 w-4 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search applications" className="min-h-11 flex-1 bg-transparent text-base outline-none" data-launcher-search />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p className="p-4 text-center text-sm text-bad">{error}</p>}
        {!apps && !error && <p className="p-4 text-center text-sm text-muted">Loading…</p>}
        {apps && !shown.length && (
          <p className="p-6 text-center text-sm text-muted">{apps.length ? "No application matches." : "No mobile applications yet: set a Workshop module's device type to Mobile in its settings."}</p>
        )}
        <div className="space-y-2">
          {shown.map((a) => (
            <Link key={a.id} href={`/m/${a.id}`} className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 active:bg-panel-2" data-launcher-app={a.id}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ocean/15 text-ocean">
                <Icon name={(a.icon as IconName) || "device"} className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate font-semibold">
                  {a.favorite && <Icon name="star" className="h-3 w-3 text-warn" />} {a.title}
                </span>
                {a.description && <span className="block truncate text-xs text-muted">{a.description}</span>}
              </span>
              <Icon name="right" className="h-4 w-4 text-muted" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
