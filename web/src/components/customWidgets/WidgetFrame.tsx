"use client";

/** The host side of a custom widget: an iframe with an opaque origin (sandbox without allow-same-origin) loading the
 *  release's signed document, parameters sent in, events and Ontology calls received (the calls go to the platform
 *  as the viewer, limited to the widget set's SDK resources). */
import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";
import { widgetSets, type Loaded } from "@/lib/customWidgets";

export type WidgetLog = { at: number; kind: "event" | "osdk" | "error" | "ready"; text: string };

const ALLOW = ["camera", "microphone", "autoplay"];

export function WidgetFrame({
  setId,
  widgetId,
  version,
  values,
  granted = [],
  onEvent,
  onLog,
  onLoaded,
  autoHeight = false,
  theme,
  className = "",
}: {
  setId: string;
  widgetId: string;
  version?: string;
  values: Record<string, unknown>;
  granted?: string[];
  onEvent?: (eventId: string, updates: Record<string, unknown>) => void;
  onLog?: (l: WidgetLog) => void;
  onLoaded?: (l: Loaded) => void;
  autoHeight?: boolean;
  theme?: "dark" | "light";
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const ready = useRef(false);
  const latest = useRef({ values, onEvent, onLog });
  useEffect(() => {
    latest.current = { values, onEvent, onLog };
  });
  useEffect(() => {
    let stale = false;
    ready.current = false;
    widgetSets.load(setId, widgetId, version).then(
      (l) => {
        if (stale) return;
        setLoaded(l);
        onLoaded?.(l);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [setId, widgetId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const valuesJson = JSON.stringify(values);
  useEffect(() => {
    if (ready.current) ref.current?.contentWindow?.postMessage({ __bsaiHost: true, type: "parameters", values: JSON.parse(valuesJson) }, "*");
  }, [valuesJson]);
  useEffect(() => {
    const on = async (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = e.data as { __bsaiWidget?: boolean; type?: string; eventId?: string; parameterUpdates?: Record<string, unknown>; id?: number; op?: string; args?: unknown; height?: number };
      if (!d?.__bsaiWidget) return;
      const post = (m: unknown) => ref.current?.contentWindow?.postMessage(m, "*");
      if (d.type === "ready") {
        ready.current = true;
        post({ __bsaiHost: true, type: "parameters", values: latest.current.values });
        latest.current.onLog?.({ at: Date.now(), kind: "ready", text: "widget ready" });
      } else if (d.type === "emitEvent" && d.eventId) {
        const ev = loaded?.widget.events[d.eventId];
        if (!ev) {
          latest.current.onLog?.({ at: Date.now(), kind: "error", text: `unknown event ${d.eventId}` });
          return;
        }
        // an event updates only the parameters it declares
        const updates = Object.fromEntries(Object.entries(d.parameterUpdates ?? {}).filter(([k]) => (ev.parameterUpdateIds ?? []).includes(k)));
        latest.current.onLog?.({ at: Date.now(), kind: "event", text: `${d.eventId} ${JSON.stringify(updates)}` });
        latest.current.onEvent?.(d.eventId, updates);
      } else if (d.type === "osdk" && d.id) {
        try {
          const data = await widgetSets.call(setId, String(d.op), d.args ?? {});
          latest.current.onLog?.({ at: Date.now(), kind: "osdk", text: `${d.op} ✓` });
          post({ __bsaiHost: true, type: "osdkResult", id: d.id, ok: true, data });
        } catch (err) {
          latest.current.onLog?.({ at: Date.now(), kind: "error", text: `${d.op}: ${(err as Error).message}` });
          post({ __bsaiHost: true, type: "osdkResult", id: d.id, ok: false, error: (err as Error).message });
        }
      } else if (d.type === "resize" && typeof d.height === "number") setHeight(Math.min(4000, Math.max(20, d.height)));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [loaded, setId]);
  if (error) return <div className="flex h-full items-center justify-center p-3 text-xs text-bad">{error}</div>;
  if (!loaded) return <div className="flex h-full items-center justify-center text-xs text-muted">Loading the widget…</div>;
  const requested = loaded.widget.permissions.filter((p) => granted.includes(p));
  const sandbox = ["allow-scripts", ...requested.filter((p) => p.startsWith("allow-"))].join(" ");
  const allow = requested.filter((p) => ALLOW.includes(p)).join("; ");
  const src = loaded.dev?.active && loaded.dev.document ? loaded.dev.document : API_URL + loaded.document;
  return (
    <div className={`relative h-full ${className}`}>
      {loaded.dev?.active && <span className="absolute right-1 top-1 z-10 rounded bg-warn/20 px-1.5 text-[10px] text-warn">dev mode · {new URL(loaded.dev.url).host}</span>}
      <iframe
        key={src}
        ref={ref}
        src={src}
        sandbox={sandbox}
        allow={allow || undefined}
        title={loaded.widget.name}
        data-custom-widget={`${loaded.widget_set.id}:${widgetId}`}
        style={{ colorScheme: theme ?? "dark", height: autoHeight && height ? height : "100%" }}
        className="w-full border-0"
      />
    </div>
  );
}
