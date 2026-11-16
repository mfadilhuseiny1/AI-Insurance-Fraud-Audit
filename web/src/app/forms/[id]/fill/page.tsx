"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormFill } from "@/components/forms/FormFill";
import { EMBED_PARAMS, FORM_HEIGHT, FORM_SUBMITTED, forms, withLink, type FormHeightMessage, type FormSubmittedMessage, type Prefill, type Submission } from "@/lib/forms";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";

const RESERVED = new Set(EMBED_PARAMS);

export default function FillPage() {
  return (
    <Suspense>
      <Fill />
    </Suspense>
  );
}

/**
 * A respondent's view of the published form. Embedded (`?embed=1`, or the doc's `?embedded=true`): no platform chrome,
 * `noHeader=true` hides the title, `progressOnly=true` shows only a progress bar as the header, `forceDarkMode=true`.
 * Other parameters prefill fields (`field.<id>=…`, a field's URL parameter, or its ID); `object_type` + `pk` name the
 * object the form is embedded for. The server validates prefilled values; the ones it does not use are listed.
 * In an iframe the page posts `bluesandai.form.height` when its height changes and `bluesandai.form.submitted` after a
 * submission to the parent window (see FormEmbed).
 */
function Fill() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const embedded = params.get("embed") === "1" || params.get("embedded") === "true";
  const noHeader = params.get("noHeader") === "true";
  const progressOnly = !noHeader && params.get("progressOnly") === "true";
  const link = params.get("link");
  const objectType = params.get("object_type") || null;
  const pk = params.get("pk") || null;
  const formId = withLink(id, link);
  // URL parameter → value (a list when it is repeated)
  const fieldParams = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of params.entries()) {
      if (RESERVED.has(k)) continue;
      const had = out[k];
      out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
    }
    return out;
  }, [params]);
  const paramsKey = JSON.stringify(fieldParams);
  const redirecting = params.get("embedded") === "true" && params.get("embed") !== "1";
  const wantsPrefill = !redirecting && (Object.keys(fieldParams).length > 0 || !!objectType || !!pk);

  // the doc's `embedded=true` alone: the platform's chrome is left out for `embed=1`, so the page reloads with it
  useEffect(() => {
    if (redirecting) {
      const u = new URL(window.location.href);
      u.searchParams.set("embed", "1");
      window.location.replace(u.toString());
    }
  }, [redirecting]);
  // forceDarkMode: this page only (the reader's saved theme is not changed)
  useEffect(() => {
    if (params.get("forceDarkMode") !== "true") return;
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = "dark";
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    };
  }, [params]);

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!wantsPrefill) return;
    let stale = false;
    forms.prefill(formId, { params: JSON.parse(paramsKey) as Record<string, string | string[]>, object_type: objectType, pk }).then(
      (r) => !stale && (setPrefill(r), setError(null)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [formId, paramsKey, objectType, pk, wantsPrefill, round]);

  // the host page learns the content's height (the iframe is sized to it) and each submission
  const box = useRef<HTMLDivElement>(null);
  const inFrame = typeof window !== "undefined" && window.parent !== window;
  useEffect(() => {
    if (!embedded || !inFrame || !box.current) return;
    let last = -1;
    const post = () => {
      const height = Math.ceil(box.current?.scrollHeight ?? 0);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: FORM_HEIGHT, form_id: id, height } satisfies FormHeightMessage, "*");
    };
    const ro = new ResizeObserver(post);
    ro.observe(box.current);
    post();
    return () => ro.disconnect();
  }, [embedded, inFrame, id, prefill, error]);
  const onSubmitted = useCallback(
    (r: Submission) => {
      if (inFrame) {
        const msg: FormSubmittedMessage = {
          type: FORM_SUBMITTED, form_id: id, response_id: r.response_id, rows: r.rows,
          object: objectType && pk ? { object_type: objectType, pk } : null, edited_object: !!r.edited_object,
        };
        window.parent.postMessage(msg, "*");
      }
      // an edited object has new values: the next response starts from them
      if (wantsPrefill) setRound((n) => n + 1);
    },
    [inFrame, id, objectType, pk, wantsPrefill],
  );

  const ready = !redirecting && (!wantsPrefill || prefill !== null);
  const body = error ? (
    <ErrorBox message={error} />
  ) : !ready ? (
    <p className="p-6 text-sm text-muted">Loading the form…</p>
  ) : (
    <FormFill
      key={wantsPrefill ? "prefilled" : "plain"}
      formId={formId}
      initial={prefill?.values ?? {}}
      notice={prefill?.ignored}
      noHeader={noHeader || progressOnly}
      progress={progressOnly}
      embedded={embedded}
      source={embedded || objectType ? { ...(embedded ? { embedded: true } : {}), ...(prefill?.object ? { object_type: prefill.object.object_type_id, pk: prefill.object.primary_key } : {}) } : undefined}
      subtitle={prefill?.object ? `${prefill.edits_object ? "Editing" : "For"} ${prefill.object.title || prefill.object.primary_key}` : undefined}
      onSubmitted={onSubmitted}
    />
  );
  if (embedded)
    return (
      <div className="flex-1 overflow-y-auto">
        {/* the measured box: its height is what the host page's iframe needs */}
        <div ref={box} className="p-3 sm:p-4">{body}</div>
      </div>
    );
  return (
    <div className="flex-1 overflow-y-auto">
      <AppHeader app="Forms (Sunset)" icon="doc" href="/forms" crumbs={[{ label: "Fill" }]} />
      {/* phone width: 16 px gutters (the submit bar sticks to the bottom of the screen) */}
      <div className="mx-auto max-w-2xl px-4 pt-4 pb-0 sm:p-8">{body}</div>
    </div>
  );
}
