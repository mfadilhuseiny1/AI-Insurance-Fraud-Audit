"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { CheckpointForm } from "@/components/security/CheckpointForm";
import { ApiError, Loading } from "@/components/States";
import { API_URL } from "@/lib/api";
import { checkpointsApi, type CheckpointPrompt } from "@/lib/checkpoints";

/**
 * A checkpoint for an interaction opened as a link (a download): the API sends the browser here, the user answers,
 * and the browser goes back to the link with the one-time pass.
 */
export default function CheckpointPage() {
  const [params] = useState(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const context = params.get("context") ?? "";
  const next = params.get("next") ?? "";
  const [data, setData] = useState<{ checkpoints: CheckpointPrompt[]; items: { id: string; name?: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (context) checkpointsApi.context(context).then(setData, (e: Error) => setError(e.message));
  }, [context]);
  // only links back to this platform's API are followed
  const safeNext = next.startsWith(API_URL) || next.startsWith("/api/") ? next : "";
  if (!context) return <ApiError message="No checkpoint to answer." />;
  if (error) return <ApiError message={error} />;
  if (!data) return <Loading />;
  return (
    <main className="flex flex-1 items-start justify-center overflow-y-auto bg-ink p-4 md:p-10">
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-5">
        <h1 className="mb-3 flex items-center gap-2 text-base font-semibold"><Icon name="lock" className="h-4 w-4 text-ocean" />Checkpoint</h1>
        {done ? (
          <p className="text-sm text-soft">Thank you — your download should start. You can close this tab.</p>
        ) : (
          <CheckpointForm context={context} checkpoints={data.checkpoints} items={data.items}
            onDone={(pass) => {
              setDone(true);
              // the API download itself (not a page): a full navigation so the browser saves the file
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              if (safeNext) window.location.href = `${safeNext}${safeNext.includes("?") ? "&" : "?"}_checkpoint=${encodeURIComponent(pass)}`;
            }}
            onCancel={() => (window.history.length > 1 ? window.history.back() : window.close())} />
        )}
      </div>
    </main>
  );
}
