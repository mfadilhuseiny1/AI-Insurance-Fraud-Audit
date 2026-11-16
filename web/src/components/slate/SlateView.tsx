"use client";

/** Running a Slate document: the runtime hook and the viewer (page navigation, a banner for unpublished
 *  versions). The editor renders the same canvas in edit mode. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { auth } from "@/lib/auth";
import type { SlateDocument } from "@/lib/slate";
import { SlateRuntime, type RuntimeOptions } from "@/lib/slateRuntime";
import { SlateCanvas } from "./SlateCanvas";

/** One runtime per mounted application (callers remount with a React key for another application or version). */
export function useSlateRuntime(doc: SlateDocument, opts: RuntimeOptions & { key: string }) {
  const [rt] = useState(() => new SlateRuntime(doc, opts));
  useEffect(() => {
    let alive = true;
    if (!opts.publicApp)
      auth.me().then(
        (me) => {
          if (alive) rt.opts.user = me;
          rt.invalidate();
        },
        () => {},
      );
    void rt.start();
    return () => {
      alive = false;
      rt.stop();
    };
  }, [rt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rt.doc !== doc) rt.setDocument(doc);
  }, [rt, doc]);
  const subscribe = useCallback((cb: () => void) => rt.subscribe(cb), [rt]);
  const version = useSyncExternalStore(subscribe, rt.getVersion, () => 0);
  const scope = useMemo(() => rt.scope(), [rt, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rt, scope, version };
}

export function urlParams(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([k]) => !k.startsWith("$") && !["edit", "version", "page", "id"].includes(k)));
}

export function SlateViewer({ doc, appId, publicApp, banner, onNavigate, initialPage, onRuntime }: { doc: SlateDocument; appId: string | null; publicApp?: boolean; banner?: string | null; onNavigate?: (p: string) => void; initialPage?: string | null; onRuntime?: (rt: SlateRuntime) => void }) {
  const { rt, scope } = useSlateRuntime(doc, { key: `${appId}:view:${publicApp ? "public" : ""}`, appId, isEditMode: false, publicApp, urlParams: urlParams(), onNavigate });
  useEffect(() => {
    if (rt && initialPage && initialPage !== rt.page) rt.navigate(initialPage);
  }, [rt, initialPage]);
  useEffect(() => {
    onRuntime?.(rt);
    // the runtime lives as long as the viewer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt]);
  if (!rt) return null;
  const page = doc.pages.find((p) => p.name === rt.page) ?? doc.pages[0];
  return (
    <div className={`flex min-h-full flex-col ${doc.styles.theme === "light" ? "foundry-light" : ""}`}>
      {banner && <div className="bg-warn/15 px-4 py-1.5 text-center text-xs text-warn">{banner}</div>}
      <SlateCanvas rt={rt} scope={scope} widgets={page?.widgets ?? []} toolbar={doc.toolbar} editing={false} />
    </div>
  );
}
