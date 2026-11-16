"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";

/* A real platform app (Data Lineage, Pipeline Builder, AIP Logic, Workshop, Nexus) as the studio's centre screen: the
   same page with every tool it has, chromeless (?embed=1) and under the viewer's own access. Its switches and the
   "open in a new tab" link sit in the studio's top bar, so the app keeps all the height. */
export const embedUrl = (src: string) => `${src}${src.includes("?") ? "&" : "?"}embed=1`;

export function RealApp({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = embedUrl(src);
  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0f16]">
      {loaded !== url && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[#0b0f16]"><span className="h-8 w-8 animate-spin rounded-full border-2 border-[#383e47] border-t-violet-400" /></div>}
      <iframe key={url} src={url} title={title} onLoad={() => setLoaded(url)} className="h-full w-full border-0" />
    </main>
  );
}

/** The studio's real apps, each loaded the first time it is shown and then kept (hidden while another is shown): going
 *  back to an app is instant instead of loading the whole page again. A changed `src` reloads that app only. */
export function RealApps({ active, apps }: { active: string | null; apps: { key: string; src: string; title: string }[] }) {
  const [opened, setOpened] = useState<string[]>([]);
  if (active && apps.some((a) => a.key === active) && !opened.includes(active)) setOpened([...opened, active]);
  return (
    <>
      {apps
        .filter((a) => opened.includes(a.key) || a.key === active)
        .map((a) => (
          <div key={a.key} className={a.key === active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
            <RealApp src={a.src} title={a.title} />
          </div>
        ))}
    </>
  );
}

export function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${active ? "bg-[#5b5fd6] text-white" : "text-[#abb3bf] hover:bg-white/5 hover:text-white"}`}>{children}</button>;
}

export function OpenTab({ href }: { href: string }) {
  return <a href={href} target="_blank" rel="noreferrer" title="Buka aplikasi ini di tab baru" className="flex shrink-0 items-center rounded p-1 text-[#abb3bf] hover:bg-white/10 hover:text-white"><Icon name="external" className="h-3.5 w-3.5" /></a>;
}
