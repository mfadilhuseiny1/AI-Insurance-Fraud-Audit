"use client";

/** An image access pattern (thumbnail / frame) of an audio or video item, whose output a background job computes on
 *  the server: waits for the job (showing its progress) before handing the URL to <img>. Other items' images are
 *  computed inline, so their URL is used at once. */
import { useEffect, useState } from "react";
import { accessJobNote, accessUrl, mediaSets } from "@/lib/mediaSets";

export function AccessImage({
  id,
  pattern,
  params = {},
  background = false,
  alt,
  className,
  loading,
}: {
  id: string;
  pattern: string;
  params?: Record<string, string | number>;
  /** computed by a background job (a video's thumbnail or frame) */
  background?: boolean;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const key = `${id}|${pattern}|${JSON.stringify(params)}`;
  const [res, setRes] = useState<{ key: string; src?: string; note?: string }>({ key: "" });
  useEffect(() => {
    if (!background) return;
    const ctl = new AbortController();
    const p = JSON.parse(key.split("|").slice(2).join("|")) as Record<string, string | number>;
    mediaSets
      .accessReadyUrl(id, pattern, p, (s) => setRes({ key, note: accessJobNote(s, "Rendering") }), ctl.signal)
      .then(
        (src) => setRes({ key, src }),
        (e: Error) => e.name !== "AbortError" && setRes({ key, note: e.message }),
      );
    return () => ctl.abort();
  }, [id, pattern, key, background]);
  const src = background ? (res.key === key ? res.src : undefined) : accessUrl(id, pattern, params);
  if (!src)
    return (
      <span className="px-2 text-center text-[11px] text-muted" role="status">
        {(res.key === key && res.note) || "Preparing the preview…"}
      </span>
    );
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={src} alt={alt} loading={loading} className={className} />;
}
