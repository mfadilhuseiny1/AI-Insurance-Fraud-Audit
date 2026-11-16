"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { confirmDialog } from "@/lib/dialogs";
import { timeseries, type DemoStatus } from "@/lib/timeseries";

/**
 * Loads (or reloads / removes) the demo syncs: ships in Jakarta Bay and trucks in Jakarta (geotemporal), vessel speeds
 * and port sensors (time series), three hours of history plus a live feed for an hour, and a demo monitoring view.
 */
export function DemoButton({ onChange, compact = false }: { onChange: () => void; compact?: boolean }) {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    timeseries.demoStatus().then(setStatus, () => {});
  }, []);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await timeseries.loadDemo(60));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog("Remove the demo syncs, their data and the demo monitoring view?"))) return;
    setBusy(true);
    try {
      await timeseries.removeDemo();
      setStatus({ loaded: false, live: false, live_until: null });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`inline-flex items-center gap-2 ${compact ? "flex-nowrap" : "flex-wrap"}`}>
      <button type="button" onClick={load} disabled={busy} className={`${status?.loaded ? buttonClass.secondary : buttonClass.primary} whitespace-nowrap ${compact ? "py-1 text-xs" : ""}`}
        title="Ships in Jakarta Bay, delivery trucks in Jakarta, vessel speeds and port sensors: 3 hours of history and a live feed for 1 hour">
        <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {status?.loaded ? (compact ? "Reload demo" : "Reload demo (live 1 h)") : "Load demo data"}
      </button>
      {status?.loaded && (
        <>
          {status.live && (
            <span className="flex items-center gap-1 text-xs text-ok">
              <span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> live
            </span>
          )}
          <button type="button" onClick={remove} disabled={busy} className={`${buttonClass.secondary} whitespace-nowrap ${compact ? "py-1 text-xs" : ""}`}>
            <Icon name="trash" className="h-3.5 w-3.5" /> {compact ? "Remove" : "Remove demo"}
          </button>
        </>
      )}
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
