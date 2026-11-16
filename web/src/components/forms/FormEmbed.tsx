"use client";

import { useEffect, useRef, useState } from "react";
import { FORM_HEIGHT, FORM_SUBMITTED, formEmbedPath, type FormEmbedOptions, type FormSubmittedMessage } from "@/lib/forms";

/**
 * A published form inside another page (an object view's section, a Workshop or Slate-like app, a Fusion sheet): the
 * fill page in an iframe (`/forms/<id>/fill?embed=1…`). The iframe takes the height the form reports, and
 * `onSubmitted` is called with each submission. Only messages from this iframe and this app's origin are trusted.
 */
export function FormEmbed({ formId, object, prefill, link, noHeader, progressOnly, forceDarkMode, minHeight = 160, maxHeight, onSubmitted, className, title }: FormEmbedOptions & {
  formId: string;
  progressOnly?: boolean;
  forceDarkMode?: boolean;
  /** the iframe's height before the form reports its own */
  minHeight?: number;
  /** a taller form scrolls inside the iframe */
  maxHeight?: number;
  onSubmitted?: (m: FormSubmittedMessage) => void;
  className?: string;
  title?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  let src = formEmbedPath(formId, { object, prefill, link, noHeader });
  if (progressOnly && !noHeader) src += "&progressOnly=true";
  if (forceDarkMode) src += "&forceDarkMode=true";
  const submitted = useRef(onSubmitted);
  useEffect(() => {
    submitted.current = onSubmitted;
  }, [onSubmitted]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const m = e.data as { type?: string; height?: unknown } | null;
      if (!m || typeof m !== "object") return;
      if (m.type === FORM_HEIGHT && typeof m.height === "number" && Number.isFinite(m.height)) {
        // + the iframe's 1 px top and bottom border (border-box), so the form does not scroll inside it
        const h = Math.max(minHeight, Math.ceil(m.height) + 2);
        setHeight(maxHeight ? Math.min(h, maxHeight) : h);
      } else if (m.type === FORM_SUBMITTED) submitted.current?.(m as FormSubmittedMessage);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [minHeight, maxHeight]);
  return (
    <iframe
      ref={frame}
      src={src}
      title={title ?? "Form"}
      style={{ height }}
      className={`block w-full max-w-full rounded-lg border border-line bg-transparent ${className ?? ""}`}
    />
  );
}
