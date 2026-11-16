"use client";

import { useCallback, useEffect, useState } from "react";
import { when } from "@/lib/format";
import { syncChecks, type SyncCheck, type SyncCheckKind, type SyncCheckStatus } from "@/lib/health";
import { confirmDialog } from "@/lib/dialogs";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";

const KINDS: { id: SyncCheckKind; label: string; help: string }[] = [
  { id: "sync_status", label: "Sync status", help: "Fails when the last run failed." },
  { id: "sync_freshness", label: "Sync freshness", help: "Fails when there was no successful run within the limit (an export: its dataset changed and was not exported since)." },
  { id: "sync_row_count", label: "Sync row count", help: "Fails when the rows are outside the minimum / maximum." },
];

const DOT: Record<SyncCheck["status"], string> = { passing: "bg-ok", failing: "bg-bad", disabled: "bg-muted", unknown: "bg-muted" };

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

function rule(c: SyncCheck, isExport: boolean): string {
  if (c.kind === "sync_freshness") return `within ${c.config.hours ?? 24} h`;
  if (c.kind === "sync_row_count") {
    const of = c.config.measure === "total" ? (isExport ? "rows in the target" : "rows in the dataset") : "rows of the last successful run";
    const lo = c.config.min ?? null;
    const hi = c.config.max ?? null;
    return `${of}: ${lo !== null ? `≥ ${lo.toLocaleString()}` : ""}${lo !== null && hi !== null ? " and " : ""}${hi !== null ? `≤ ${hi.toLocaleString()}` : ""}`;
  }
  return "the last run must succeed";
}

/** Health checks set on a Data Connection sync ("source:<id>") or export ("export:<id>"): their state (evaluated when
 * shown, after every run and in the background), and in-app notifications to subscribers when one fails or passes again. */
export function SyncChecks({ resourceId, refreshKey }: { resourceId: string; refreshKey?: string }) {
  const isExport = resourceId.startsWith("export:");
  const [checks, setChecks] = useState<SyncCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<SyncCheckKind>("sync_status");
  const [hours, setHours] = useState("24");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [measure, setMeasure] = useState<"run" | "total">("run");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    syncChecks
      .list(resourceId)
      .then((r) => {
        setChecks(r.checks);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [resourceId]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    act(async () => {
      await syncChecks.create({
        resource_id: resourceId,
        kind,
        ...(kind === "sync_freshness" ? { hours: num(hours) } : {}),
        ...(kind === "sync_row_count" ? { min: num(min), max: num(max), measure } : {}),
      });
      setAdding(false);
      setMin("");
      setMax("");
    });

  const failing = checks?.filter((c) => c.status === "failing").length ?? 0;

  return (
    <div data-testid="sync-checks">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Health checks
        {checks && checks.length > 0 && (
          <span className={`rounded px-1.5 py-px text-[10px] font-medium normal-case tracking-normal ring-1 ${failing ? "text-bad ring-bad/40" : "text-ok ring-ok/40"}`}>
            {failing ? `${failing} failing` : "all passing"}
          </span>
        )}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="ml-auto flex items-center gap-1 text-[11px] font-normal normal-case tracking-normal text-ocean hover:underline">
            <Icon name="plus" className="h-3 w-3" /> Add check
          </button>
        )}
      </h4>
      {error && <p className="mb-2 text-xs text-bad">{error}</p>}
      {checks === null ? (
        !error && <p className="text-xs text-muted">Loading…</p>
      ) : checks.length === 0 && !adding ? (
        <p className="text-xs text-muted">
          No checks. Add one to be told in the app when this {isExport ? "export" : "sync"} fails, goes stale or {isExport ? "exports" : "brings"} an unexpected number of rows.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {checks.map((c) => (
            <li key={c.id} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs" data-check={c.kind} data-status={c.status}>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.status]}`} title={c.status} />
                <span className="font-medium">{c.label}</span>
                <span className="truncate text-muted">· {rule(c, isExport)}</span>
                <span className={`ml-auto shrink-0 ${c.status === "failing" ? "text-bad" : c.status === "passing" ? "text-ok" : "text-muted"}`}>
                  {c.status === "failing" ? "Failing" : c.status === "passing" ? "Passing" : c.status === "disabled" ? "Off" : "Not checked"}
                </span>
              </div>
              {c.enabled && c.message && <div className={`mt-0.5 break-words ${c.status === "failing" ? "text-bad/90" : "text-soft"}`}>{c.message}</div>}
              {c.status === "failing" && c.failing_since && <div className="text-muted">failing since {when(c.failing_since)}</div>}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                {c.kind === "sync_freshness" && (
                  <label className="flex items-center gap-1">
                    limit
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      defaultValue={c.config.hours ?? 24}
                      disabled={busy}
                      onBlur={(e) => {
                        const v = num(e.target.value);
                        if (v && v > 0 && v !== c.config.hours) void act(() => syncChecks.update(c.id, { hours: v }));
                      }}
                      className={`${inputClass} w-16 px-1 py-0.5 text-[11px]`}
                    />
                    h
                  </label>
                )}
                {c.kind === "sync_row_count" && (
                  <>
                    <label className="flex items-center gap-1">
                      min
                      <input
                        type="number"
                        min={0}
                        defaultValue={c.config.min ?? ""}
                        disabled={busy}
                        onBlur={(e) => {
                          const v = num(e.target.value);
                          if (v === (c.config.min ?? undefined)) return;
                          void act(() => syncChecks.update(c.id, v === undefined ? { clear_min: true } : { min: v }));
                        }}
                        className={`${inputClass} w-20 px-1 py-0.5 text-[11px]`}
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      max
                      <input
                        type="number"
                        min={0}
                        defaultValue={c.config.max ?? ""}
                        disabled={busy}
                        onBlur={(e) => {
                          const v = num(e.target.value);
                          if (v === (c.config.max ?? undefined)) return;
                          void act(() => syncChecks.update(c.id, v === undefined ? { clear_max: true } : { max: v }));
                        }}
                        className={`${inputClass} w-20 px-1 py-0.5 text-[11px]`}
                      />
                    </label>
                  </>
                )}
                <label className="flex items-center gap-1" title="Notify me in the app when this check fails or passes again">
                  <input type="checkbox" checked={c.subscribed} disabled={busy} onChange={(e) => act(() => syncChecks.update(c.id, { subscribed: e.target.checked }))} />
                  <Icon name="bell" className="h-3 w-3" /> notify me
                  {c.subscribers > (c.subscribed ? 1 : 0) && <span>(+{c.subscribers - (c.subscribed ? 1 : 0)})</span>}
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => act(() => syncChecks.update(c.id, { enabled: e.target.checked }))} />
                  on
                </label>
                {c.checked_at && <span>checked {when(c.checked_at)}</span>}
                <button
                  type="button"
                  disabled={busy}
                  title="Delete the check"
                  onClick={async () => {
                    if (await confirmDialog(`Delete the ${c.label.toLowerCase()} check?`)) void act(() => syncChecks.remove(c.id));
                  }}
                  className="ml-auto text-muted hover:text-bad"
                >
                  <Icon name="trash" className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="mt-2 space-y-2 rounded-md border border-ocean/40 bg-panel-2/40 p-2.5 text-xs">
          <select value={kind} onChange={(e) => setKind(e.target.value as SyncCheckKind)} className={`${inputClass} w-full py-1 text-xs`} aria-label="Check">
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <p className="text-muted">
            {KINDS.find((k) => k.id === kind)?.help}
            {isExport && kind === "sync_row_count" && " It is also checked before each run writes: a run whose rows would fail it stops, and nothing is exported."}
            {!isExport && kind === "sync_row_count" && " It is also checked before each run commits: a run whose rows would fail it stops, and the dataset keeps its previous version (a run that brings no rows is never stopped)."}
          </p>
          {kind === "sync_freshness" && (
            <label className="flex items-center gap-2">
              Limit (hours)
              <input type="number" min={0.1} step="any" value={hours} onChange={(e) => setHours(e.target.value)} className={`${inputClass} w-24 py-1 text-xs`} />
            </label>
          )}
          {kind === "sync_row_count" && (
            <>
              <select value={measure} onChange={(e) => setMeasure(e.target.value as "run" | "total")} className={`${inputClass} w-full py-1 text-xs`} aria-label="Rows of">
                <option value="run">Rows of the last successful run</option>
                <option value="total">{isExport ? "Rows in the export target" : "Rows in the synced dataset"}</option>
              </select>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1">
                  Min
                  <input type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} className={`${inputClass} w-24 py-1 text-xs`} />
                </label>
                <label className="flex items-center gap-1">
                  Max
                  <input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} className={`${inputClass} w-24 py-1 text-xs`} />
                </label>
              </div>
            </>
          )}
          <p className="text-muted">You are notified in the app when it starts failing and when it passes again.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className={`${buttonClass.secondary} py-1 text-xs`}>
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={add} className={`${buttonClass.primary} py-1 text-xs`}>
              Add check
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Failing / passing checks of a sync or export, for listings. */
export function SyncCheckBadge({ status }: { status?: SyncCheckStatus }) {
  if (!status) return null;
  const failing = status.failing.length;
  return (
    <span
      className={`mt-0.5 flex items-center gap-1 text-[11px] ${failing ? "text-bad" : "text-muted"}`}
      title={failing ? `Failing: ${status.failing.map((k) => KINDS.find((x) => x.id === k)?.label ?? k).join(", ")}` : "All health checks passing"}
    >
      <Icon name={failing ? "alert" : "check"} className="h-3 w-3" />
      {failing ? `${failing} of ${status.checks} check${status.checks === 1 ? "" : "s"} failing` : `${status.checks} check${status.checks === 1 ? "" : "s"} passing`}
    </span>
  );
}

/** Check states of every sync and export the caller can see, keyed by resource id ("source:<id>" / "export:<id>"). */
export function useSyncCheckStatus(refreshKey?: string): Record<string, SyncCheckStatus> {
  const [map, setMap] = useState<Record<string, SyncCheckStatus>>({});
  useEffect(() => {
    let live = true;
    syncChecks
      .status()
      .then((rows) => live && setMap(Object.fromEntries(rows.map((r) => [r.resource_id, r]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return map;
}
