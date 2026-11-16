"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";

type Ext = { id: string; rid: string; name: string; api_name: string | null; domains: string[]; secrets: string[]; export_controls: { allow_foundry_inputs: boolean } };

async function call<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/code-repos${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Settings → External systems: Data Connection sources this repository's external transforms use (Source(…)). */
export function ExternalSystemsSection({ repoId, readOnly = false }: { repoId: string; readOnly?: boolean }) {
  const [data, setData] = useState<{ imported: Ext[]; available: Ext[] } | null>(null);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => call<{ imported: Ext[]; available: Ext[] }>(`/${repoId}/external-systems`).then(setData, (e: Error) => setErr(e.message)), [repoId]);
  useEffect(() => {
    load();
  }, [load]);
  const save = (ids: string[]) =>
    call<{ imported: Ext[]; available: Ext[] }>(`/${repoId}/external-systems`, "PUT", { sources: ids }).then(
      (d) => (setData(d), setErr(null), setAdding("")),
      (e: Error) => setErr(e.message),
    );
  const ids = data?.imported.map((x) => x.id) ?? [];
  return (
    <section className="rounded-xl border border-line bg-panel p-5 text-sm">
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <Icon name="globe" className="h-4 w-4 text-ocean" /> External systems
      </div>
      <p className="mb-3 text-xs text-muted">
        REST API sources (Data Connection → Webhooks, with &quot;Allow imports into code repositories&quot; on) your transforms call with{" "}
        <span className="font-mono">@external_systems(name=Source(&quot;…&quot;))</span> from <span className="font-mono">transforms.external.systems</span>. Requests go through
        the platform, which adds the source&apos;s credentials and applies egress and agent proxy policies; a transform that reads Foundry inputs needs the source&apos;s export
        controls to allow it.
      </p>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      <ul className="mb-3 space-y-2">
        {data?.imported.map((s) => (
          <li key={s.id} className="rounded-md border border-line-2 p-2.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-medium text-soft">{s.name}</span>
              <span className="font-mono text-muted">{s.domains.join(", ")}</span>
              {!readOnly && (
                <button type="button" onClick={() => save(ids.filter((x) => x !== s.id))} className="ml-auto text-muted hover:text-bad" aria-label="Remove">
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-1 text-muted">
              <span className="font-mono">Source(&quot;{s.api_name ?? s.id}&quot;)</span> · secrets: {s.secrets.join(", ") || "none"} · Foundry inputs{" "}
              {s.export_controls.allow_foundry_inputs ? "allowed" : "not allowed (export-controlled)"}
            </div>
          </li>
        ))}
        {data && !data.imported.length && <li className="text-xs text-muted">No sources imported.</li>}
      </ul>
      {readOnly ? (
        <p className="text-xs text-muted" data-testid="external-systems-read-only">
          Read-only: the repository&apos;s owners import and remove sources.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} className={`${inputClass} max-w-xs text-xs`}>
            <option value="">Add a source…</option>
            {data?.available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={!adding} onClick={() => save([...ids, adding])} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      )}
    </section>
  );
}
