"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { when } from "@/lib/format";

type Definition = {
  id: string;
  sql: string;
  operation: string;
  inputs: { item_id: string; name: string }[];
  adhoc: boolean;
  active: boolean;
  created_at: string;
  created_by: string;
  last_run_at: string | null;
  query_id: string | null;
};

type Schedule = { cron: string; timezone: string; enabled: boolean; owner_name?: string; last_run_at?: string | null; last_status?: string | null; last_error?: string | null; next?: string[] };

async function call<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/sql/definitions/${path}`, {
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

/** The SQL definitions of an output written from SQL Studio (palantir.com/docs/foundry/sql-warehousing/sql-definitions):
 *  the active one runs on every rebuild. Renders nothing for outputs without definitions unless `always`. */
export function SqlDefinitions({ itemId, always = false, onBuilt }: { itemId: string; always?: boolean; onBuilt?: () => void }) {
  const [data, setData] = useState<{ definitions: Definition[]; can_edit: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => call<{ definitions: Definition[]; can_edit: boolean }>(itemId).then(setData, (e: Error) => setErr(e.message)), [itemId]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data || (!data.definitions.length && !always)) return err && always ? <p className="text-xs text-bad">{err}</p> : null;
  const act = async (path: string, method: string) => {
    setBusy(true);
    setErr(null);
    try {
      await call(path, method);
      await load();
      onBuilt?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-soft">SQL definitions</h3>
        <span className="text-muted">the active definition runs whenever the table is rebuilt</span>
        {data.can_edit && data.definitions.some((d) => d.active) && (
          <button type="button" disabled={busy} onClick={() => act(`${itemId}/build`, "POST")} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
            <Icon name="refresh" className="h-3.5 w-3.5" /> {busy ? "Building…" : "Build"}
          </button>
        )}
      </div>
      {err && <p className="text-bad">{err}</p>}
      {!data.definitions.length && <p className="text-muted">No SQL definitions: this output was not written from SQL Studio.</p>}
      {data.definitions.some((d) => d.active) && <ScheduleRow itemId={itemId} canEdit={data.can_edit} />}
      {data.definitions.map((d) => (
        <div key={d.id} className={`rounded-md border p-3 ${d.active ? "border-ocean/50 bg-ocean/5" : "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-soft">{d.operation}</span>
            {d.active && <span className="rounded bg-ocean/20 px-1.5 text-[11px] text-ocean">Active</span>}
            {d.adhoc && <span className="rounded bg-panel-2 px-1.5 text-[11px] text-muted">ad hoc</span>}
            <span className="text-muted">
              last run {d.last_run_at ? when(d.last_run_at) : "—"} · query {d.query_id ?? "—"} · {d.created_by}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} className="text-ocean hover:underline">
                {open === d.id ? "Hide SQL" : "Show SQL"}
              </button>
              {data.can_edit && !d.active && (
                <button type="button" disabled={busy} onClick={() => act(`${itemId}/${d.id}/active`, "PUT")} className="text-ocean hover:underline">
                  Set as active definition
                </button>
              )}
              <Link href={`/sql-studio?sql=${encodeURIComponent(d.sql)}`} className="text-ocean hover:underline">
                Open in SQL Studio
              </Link>
            </div>
          </div>
          {d.inputs.length > 0 && <p className="mt-1 text-muted">Inputs: {d.inputs.map((i) => i.name).join(", ")}</p>}
          {open === d.id && <pre className="mt-2 max-h-64 overflow-auto rounded bg-ink p-2 font-mono text-[11px] text-soft">{d.sql}</pre>}
        </div>
      ))}
    </section>
  );
}

function ScheduleRow({ itemId, canEdit }: { itemId: string; canEdit: boolean }) {
  const [s, setS] = useState<Schedule | null>(null);
  const [cron, setCron] = useState("");
  const [tz, setTz] = useState("UTC");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    call<{ schedule: Schedule | null }>(`${itemId}/schedule`).then(
      (r) => {
        setS(r.schedule);
        setCron(r.schedule?.cron ?? "");
        setTz(r.schedule?.timezone ?? "UTC");
      },
      () => {},
    );
  }, [itemId]);
  const save = async (enabled: boolean, c = cron) => {
    setErr(null);
    try {
      const r = await call<{ schedule: Schedule | null }>(`${itemId}/schedule`, "PUT", { cron: c, timezone: tz, enabled });
      setS(r.schedule);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="clock" className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium text-soft">Rebuild schedule</span>
        <input value={cron} disabled={!canEdit} onChange={(e) => setCron(e.target.value)} placeholder="0 6 * * * (cron)" className="w-36 rounded border border-line-2 bg-ink px-2 py-1 font-mono" />
        <input value={tz} disabled={!canEdit} onChange={(e) => setTz(e.target.value)} placeholder="UTC" className="w-32 rounded border border-line-2 bg-ink px-2 py-1" />
        {canEdit && (
          <>
            <button type="button" onClick={() => save(true)} className="text-ocean hover:underline">
              Save
            </button>
            {s && (
              <button type="button" onClick={() => save(!s.enabled, s.cron)} className="text-ocean hover:underline">
                {s.enabled ? "Pause" : "Resume"}
              </button>
            )}
            {s && (
              <button type="button" onClick={() => (setCron(""), save(false, ""))} className="text-muted hover:text-bad">
                Remove
              </button>
            )}
          </>
        )}
      </div>
      <p className="mt-1 text-muted">
        {!s
          ? "Not scheduled: Build runs the active definition on demand."
          : `${s.enabled ? "Runs" : "Paused"} as ${s.owner_name ?? "its owner"}${s.next?.length ? ` · next ${s.next.map((n) => when(n)).join(", ")}` : ""}${
              s.last_run_at ? ` · last ${when(s.last_run_at)} ${s.last_status}${s.last_error ? `: ${s.last_error}` : ""}` : ""
            }`}
      </p>
      {err && <p className="text-bad">{err}</p>}
    </div>
  );
}
