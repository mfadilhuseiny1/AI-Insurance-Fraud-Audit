"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { renderMarkdown } from "@/lib/markdown";
import { checkpointsApi, settleCheckpoint, subscribeCheckpoints, type CheckpointAnswer, type CheckpointPrompt } from "@/lib/checkpoints";
import { auth, type SsoProvider } from "@/lib/auth";

/** Accounts without a password answer a reauthentication prompt by signing in again with single sign-on (in a new
 * tab), then submitting within a few minutes; or with their two-factor code. */
function SsoReauth() {
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  useEffect(() => {
    auth.policy().then((p) => setProviders(p.sso ?? []), () => {});
  }, []);
  if (!providers.length) return null;
  const next = typeof window === "undefined" ? "/" : "/checkpoint-reauthenticated";
  return (
    <p className="text-[11px] text-muted">
      No password (single sign-on account)?{" "}
      {providers.map((p, i) => (
        <span key={p.id}>
          {i > 0 && " · "}
          <a href={`${p.start}?next=${encodeURIComponent(next)}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
            Sign in again with {p.name}
          </a>
        </span>
      ))}
      , then submit here within 5 minutes with the password left empty.
    </p>
  );
}

const FIELD = "w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none placeholder:text-muted focus:border-ocean";

/** Whether a checkpoint's justification is complete. */
export function checkpointReady(c: CheckpointPrompt, a: CheckpointAnswer = {}): boolean {
  const j = c.justification;
  if (j.kind === "acknowledgment") return !!a.acknowledged;
  if (j.kind === "response") return !!a.response?.trim();
  if (j.kind === "dropdown") return !!a.selected?.length && (j.free_text !== "required" || !!a.response?.trim());
  return !!a.password;
}

/** The prompts and justification fields of checkpoints (the dialog, and forms that show them inline such as actions). */
export function CheckpointFields({ checkpoints, answers, set }: {
  checkpoints: CheckpointPrompt[];
  answers: Record<string, CheckpointAnswer>;
  set: (configId: string, a: Partial<CheckpointAnswer>) => void;
}) {
  return (
    <>
      {checkpoints.map((c) => {
        const a = answers[c.config_id] ?? {};
        const j = c.justification;
        return (
          <section key={c.config_id} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <Icon name="alert" className="h-4 w-4 text-warn" />
              <h3 className="text-sm font-semibold">{c.title}</h3>
              <span className="ml-auto rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-muted ring-1 ring-line-2">{c.type_name}</span>
            </div>
            <div className="prose-sm text-sm text-soft [&_a]:text-ocean [&_ul]:ml-4 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.prompt) }} />
            {c.description && <div className="text-xs text-muted [&_a]:text-ocean" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.description) }} />}
            {j.kind === "acknowledgment" && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={!!a.acknowledged} onChange={(e) => set(c.config_id, { acknowledged: e.target.checked })} />
                {j.checkbox_text || "I acknowledge"}
              </label>
            )}
            {j.kind === "dropdown" && (
              j.multiple ? (
                <div className="space-y-1">
                  {j.options.map((o) => (
                    <label key={o} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!a.selected?.includes(o)}
                        onChange={(e) => set(c.config_id, { selected: e.target.checked ? [...(a.selected ?? []), o] : (a.selected ?? []).filter((x) => x !== o) })} />
                      {o}
                    </label>
                  ))}
                </div>
              ) : (
                <select className={FIELD} value={a.selected?.[0] ?? ""} onChange={(e) => set(c.config_id, { selected: e.target.value ? [e.target.value] : [] })}>
                  <option value="">Choose a justification…</option>
                  {j.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              )
            )}
            {(j.kind === "response" || (j.kind === "dropdown" && j.free_text !== "none")) && (
              <>
                <textarea className={`${FIELD} min-h-16`} placeholder={j.kind === "dropdown" && j.free_text === "optional" ? "Details (optional)" : "Your justification"}
                  value={a.response ?? ""} onChange={(e) => set(c.config_id, { response: e.target.value })} />
                {!!c.recent?.length && (
                  <div className="flex flex-wrap gap-1 text-[11px]">
                    <span className="text-muted">Recent:</span>
                    {c.recent.map((r) => <button key={r} type="button" className="rounded bg-panel-2 px-1.5 py-0.5 text-soft ring-1 ring-line-2 hover:text-white" onClick={() => set(c.config_id, { response: r })}>{r}</button>)}
                  </div>
                )}
              </>
            )}
            {j.kind === "reauthentication" && (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input type="password" autoComplete="current-password" className={FIELD} placeholder="Your password" value={a.password ?? ""} onChange={(e) => set(c.config_id, { password: e.target.value })} />
                  <input inputMode="numeric" autoComplete="one-time-code" className={FIELD} placeholder="Two-factor code (if set up)" value={a.code ?? ""} onChange={(e) => set(c.config_id, { code: e.target.value })} />
                </div>
                <SsoReauth />
              </>
            )}
          </section>
        );
      })}
    </>
  );
}

/**
 * The prompts of a checkpoint with their justification fields; submits them and hands back the one-time pass.
 * Used by the global dialog (any API call answered with 428) and by the /checkpoint page (downloads opened as links).
 */
export function CheckpointForm({ context, checkpoints, items, onDone, onCancel }: {
  context: string;
  checkpoints: CheckpointPrompt[];
  items?: { type?: string; id: string; name?: string }[];
  onDone: (pass: string) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, CheckpointAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, a: Partial<CheckpointAnswer>) => setAnswers((x) => ({ ...x, [id]: { ...x[id], ...a } }));
  const ready = checkpoints.every((c) => checkpointReady(c, answers[c.config_id]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await checkpointsApi.submit(context, answers);
      onDone(r.pass);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const named = (items ?? []).filter((i) => i.name);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }} data-checkpoint-form>
      {named.length > 0 && <p className="text-xs text-muted">Applies to: {named.slice(0, 5).map((i) => i.name).join(", ")}{named.length > 5 ? ` and ${named.length - 5} more` : ""}</p>}
      <CheckpointFields checkpoints={checkpoints} answers={answers} set={set} />
      <p className="text-[11px] text-muted">Your justification is recorded with this interaction and can be reviewed by data governance officers.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-line-2 bg-panel-2 px-3 py-1.5 text-sm text-soft hover:text-white">Cancel</button>
        <button type="submit" disabled={!ready || busy} className="rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-40">{busy ? "Submitting…" : "Submit and continue"}</button>
      </div>
    </form>
  );
}

/** The checkpoint dialog for API calls answered with 428 (mounted once in the root layout). */
export function CheckpointHost() {
  const [queue, setQueue] = useState<{ id: number; payload: { context: string; checkpoints: CheckpointPrompt[]; items: { id: string; name?: string }[] } }[]>([]);
  useEffect(() => subscribeCheckpoints(setQueue), []);
  const p = queue[0];
  if (!p) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" data-checkpoint-dialog>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Icon name="lock" className="h-4 w-4 text-ocean" />Checkpoint</h2>
        <CheckpointForm key={p.id} context={p.payload.context} checkpoints={p.payload.checkpoints} items={p.payload.items}
          onDone={(pass) => settleCheckpoint(p.id, pass)} onCancel={() => settleCheckpoint(p.id, null)} />
      </div>
    </div>
  );
}
