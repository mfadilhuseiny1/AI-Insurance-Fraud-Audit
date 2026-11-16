"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { devConsole } from "@/lib/developerConsole";

/** OAuth2 consent: a Developer Console application asks to act for the signed-in user within its scopes. */
export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <Authorize />
    </Suspense>
  );
}

function Authorize() {
  const q = useSearchParams();
  const clientId = q.get("client_id") ?? "";
  const [info, setInfo] = useState<Awaited<ReturnType<typeof devConsole.clientInfo>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    devConsole.clientInfo(clientId).then(setInfo, (e: Error) => setError(e.message));
  }, [clientId]);
  const answer = async (deny: boolean) => {
    setBusy(true);
    try {
      const r = await devConsole.approve({
        client_id: clientId,
        redirect_uri: q.get("redirect_uri") ?? "",
        state: q.get("state") ?? "",
        code_challenge: q.get("code_challenge"),
        code_challenge_method: q.get("code_challenge_method"),
        deny,
      });
      window.location.assign(r.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-6 text-sm">
        {error && <p className="text-bad">{error}</p>}
        {!info && !error && <p className="text-muted">Loading…</p>}
        {info && (
          <>
            <div className="flex items-center gap-2">
              <Icon name="keyboard" className="h-5 w-5 text-ocean" />
              <h1 className="text-lg font-semibold">{info.name}</h1>
            </div>
            <p className="mt-1 text-muted">wants to use the platform as you{info.description ? ` · ${info.description}` : ""}.</p>
            <div className="mt-4 space-y-1 rounded-lg border border-line p-3 text-xs">
              <div className="font-medium text-soft">It will be able to, with your permissions:</div>
              {info.object_types.length > 0 && <div>Read {info.object_types.join(", ")}</div>}
              {info.action_types.length > 0 && <div>Apply the actions {info.action_types.join(", ")}</div>}
              {info.functions > 0 && <div>Run {info.functions} function{info.functions > 1 ? "s" : ""}</div>}
              {!info.object_types.length && !info.action_types.length && !info.functions && <div>Read your name and email only</div>}
              <div className="text-muted">Nothing else: its tokens reach only the Nexus SDK API.</div>
            </div>
            <p className="mt-3 break-all text-[11px] text-muted">You will return to {q.get("redirect_uri")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => answer(true)} className={buttonClass.secondary}>
                Deny
              </button>
              <button type="button" disabled={busy} onClick={() => answer(false)} className={buttonClass.primary}>
                Allow
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
