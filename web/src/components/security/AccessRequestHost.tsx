"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { ACCESS_DENIED } from "@/lib/auth";
import { approvals, type RequestOptions } from "@/lib/securityGov";

type Denied = { kind: "project"; project_id: string; project: string; role: string; message: string } | { kind: "marking"; markings: string[]; message: string };

/**
 * When the API refuses something for a missing Project role or marking (403 with X-Bluesandai-Access), offer to ask
 * for it: an Approvals request routed to the Project's Owners or the administrators.
 */
export function AccessRequestHost() {
  const { me } = useAuth();
  const [denied, setDenied] = useState<Denied | null>(null);
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a Project's access request form: join one of its groups (narrowed by their categories) or ask for the role
  const [options, setOptions] = useState<RequestOptions | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [cats, setCats] = useState<Record<string, string>>({});
  useEffect(() => {
    setOptions(null);
    setPicked("");
    setCats({});
    if (denied?.kind === "project") approvals.requestOptions(denied.project_id).then(setOptions, () => {});
  }, [denied]);
  useEffect(() => {
    let last = "";
    const on = (e: Event) => {
      const d = (e as CustomEvent<Denied>).detail;
      const key = JSON.stringify(d);
      if (key === last) return; // the same refusal repeated by several requests of a page
      last = key;
      setDenied(d);
      setOpen(false);
      setSent(null);
      setError(null);
      setWhy("");
    };
    window.addEventListener(ACCESS_DENIED, on);
    return () => window.removeEventListener(ACCESS_DENIED, on);
  }, []);
  if (!denied || !me) return null;
  const what = denied.kind === "project" ? `the ${denied.role} role on ${denied.project}` : `the marking${denied.markings.length > 1 ? "s" : ""} you are missing`;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const tasks = denied.kind === "project" && picked
        ? [{ kind: "group_membership", params: { group_id: picked, users: [me.id] } }]
        : denied.kind === "project"
        ? [{ kind: "project_access", params: { project_id: denied.project_id, principal_type: "user", principal_id: me.id, role: denied.role } }]
        : denied.markings.filter((m) => !m.startsWith("org:")).map((m) => ({ kind: "marking_access", params: { marking_id: m, user_id: me.id } }));
      if (!tasks.length) throw new Error("Organization markings come with organization membership: ask an administrator");
      const r = await approvals.create({ description: why, tasks });
      setSent({ id: r.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed bottom-4 right-4 z-[80] w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-panel p-4 text-sm shadow-2xl" data-access-request>
      <div className="flex items-start gap-2">
        <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Access needed</p>
          <p className="mt-0.5 text-xs text-muted">{denied.message || `You need ${what}.`}</p>
        </div>
        <button type="button" onClick={() => setDenied(null)} className="text-muted hover:text-white" aria-label="Dismiss"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      {sent ? (
        <p className="mt-3 text-xs text-ok">Request sent to its reviewers. <Link href={`/approvals/${sent.id}`} className="text-ocean hover:underline" onClick={() => setDenied(null)}>Open the request</Link></p>
      ) : open ? (
        <div className="mt-3 space-y-2">
          {options && options.groups.length > 0 && (
            <div className="space-y-1.5 text-xs">
              {options.categories.map((c) => (
                <label key={c} className="flex items-center gap-2">
                  <span className="w-20 text-muted">{c}</span>
                  <select value={cats[c] ?? ""} onChange={(e) => (setCats({ ...cats, [c]: e.target.value }), setPicked(""))} className="flex-1 rounded border border-line-2 bg-ink px-1 py-0.5">
                    <option value="">Any</option>
                    {[...new Set(options.groups.map((g) => g.categories[c]).filter(Boolean))].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <select value={picked} onChange={(e) => setPicked(e.target.value)} className="w-full rounded border border-line-2 bg-ink px-1 py-0.5">
                <option value="">The {denied.kind === "project" ? denied.role : ""} role on the Project itself</option>
                {options.groups
                  .filter((g) => Object.entries(cats).every(([c, v]) => !v || g.categories[c] === v))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      Join {g.name} ({g.role})
                    </option>
                  ))}
              </select>
              {picked && options.groups.find((g) => g.id === picked)?.policy && <p className="text-muted">{options.groups.find((g) => g.id === picked)!.policy}</p>}
            </div>
          )}
          <textarea className="min-h-16 w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean" placeholder="Why do you need access?"
            value={why} onChange={(e) => setWhy(e.target.value)} />
          {error && <p className="text-xs text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-soft hover:text-white">Cancel</button>
            <button type="button" disabled={busy} onClick={send} className="rounded-md bg-ocean px-3 py-1 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-40">{busy ? "Sending…" : "Send request"}</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep">
          <Icon name="check" className="h-3.5 w-3.5" />Request access
        </button>
      )}
    </div>
  );
}
