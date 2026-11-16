"use client";

import { useState, type ReactNode } from "react";
import { when } from "@/lib/format";
import { Icon, type IconName } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";

/** A Data Connection tab: title, description, actions and content. */
export function TabPage({ title, description, actions, children }: { title: string; description: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="dot-grid min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-1 text-sm text-muted">{description}</p>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1 break-words">{text}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-xs underline">
          Retry
        </button>
      )}
    </p>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-line-2 py-14 text-center">
      <span className="mb-3 rounded-full bg-panel-2 p-3 text-ocean ring-1 ring-line-2">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <span className="font-semibold">{title}</span>
      <span className="mt-1 max-w-md text-sm text-muted">{text}</span>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Run / event status: running, completed / succeeded, failed, or nothing yet. */
export function RunStatus({ status, at, error, detail }: { status?: string | null; at?: string | null; error?: string | null; detail?: ReactNode }) {
  if (status === "running" || status === "generating")
    return (
      <span className="flex items-center gap-1.5 text-xs text-ocean">
        <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> {status === "generating" ? "Generating" : "Running"}
      </span>
    );
  if (status === "failed")
    return (
      <span className="flex items-center gap-1.5 text-xs text-bad" title={error ?? undefined}>
        <Icon name="alert" className="h-3.5 w-3.5" /> Failed {at && when(at)}
      </span>
    );
  if (status === "completed" || status === "succeeded" || status === "ready")
    return (
      <span className="flex items-center gap-1.5 text-xs text-ok">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {detail ?? (status === "ready" ? "Ready" : "Succeeded")} {at && when(at)}
      </span>
    );
  return <span className="text-xs text-muted">Never run</span>;
}

export function CopyText({ text, className = "" }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className={`flex min-w-0 items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1 font-mono text-[11px] ${className}`}>
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button
        type="button"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        className="shrink-0 text-muted hover:text-white"
      >
        <Icon name={done ? "check" : "copy"} className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/** Editable key / value rows (query parameters, headers, form fields). */
export function PairsEditor({ value, onChange, keyLabel = "Key", valueLabel = "Value", add = "Add" }: { value: [string, string][]; onChange: (v: [string, string][]) => void; keyLabel?: string; valueLabel?: string; add?: string }) {
  return (
    <div className="space-y-1">
      {value.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input value={k} placeholder={keyLabel} onChange={(e) => onChange(value.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} className={`${inputClass} w-2/5 py-1 font-mono text-xs`} />
          <input value={v} placeholder={valueLabel} onChange={(e) => onChange(value.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} className={`${inputClass} flex-1 py-1 font-mono text-xs`} />
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-bad" title="Remove">
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, ["", ""]])} className={`${buttonClass.ghost} py-0.5 text-xs`}>
        <Icon name="plus" className="h-3 w-3" /> {add}
      </button>
    </div>
  );
}

/** JSON (or text) shown compactly, expandable. */
export function JsonBlock({ value, max = 4000 }: { value: unknown; max?: number }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="max-h-64 overflow-auto rounded-md bg-ink p-2 font-mono text-[11px] text-soft ring-1 ring-line-2">{text.length > max ? text.slice(0, max) + "\n…" : text}</pre>;
}

export const FREQUENCIES = [
  ["manual", "Manually"],
  ["15m", "Every 15 minutes"],
  ["hourly", "Hourly"],
  ["6h", "Every 6 hours"],
  ["daily", "Daily"],
] as const;
