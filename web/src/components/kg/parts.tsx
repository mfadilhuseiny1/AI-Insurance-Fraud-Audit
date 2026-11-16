"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { kg, type KgModel, type KgStatus } from "@/lib/kg";

const COST: Record<KgModel["cost"], string> = { low: "$", medium: "$$", high: "$$$" };

export function useKgModels() {
  const [models, setModels] = useState<KgModel[] | null>(null);
  useEffect(() => {
    kg.models()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);
  return models;
}

/** The five extraction models as radio cards. */
export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: KgModel[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      {models.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={!m.available}
          onClick={() => onChange(m.id)}
          title={m.available ? m.id : "Its API key is missing from .env.local"}
          className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
            value === m.id ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"
          }`}
        >
          <span
            className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${value === m.id ? "border-ocean bg-ocean shadow-[inset_0_0_0_2px_var(--color-panel)]" : "border-line-2"}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              {m.label}
              <span className="text-xs font-normal text-muted">{m.vendor}</span>
              {m.default && <span className="rounded bg-ocean/15 px-1.5 text-[10px] text-ocean">default</span>}
            </span>
            <span className="block text-xs text-muted">{m.description}</span>
          </span>
          <span className="text-xs text-sand" title={`Relative cost: ${m.cost}`}>
            {COST[m.cost]}
          </span>
        </button>
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<KgStatus, string> = {
  queued: "bg-panel-2 text-soft ring-line-2",
  running: "bg-ocean/15 text-ocean ring-ocean/30",
  completed: "bg-ok/15 text-ok ring-ok/30",
  failed: "bg-bad/15 text-bad ring-bad/30",
  cancelled: "bg-warn/15 text-warn ring-warn/30",
};

export function KgStatusPill({ status, label }: { status: KgStatus; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs capitalize ring-1 ${STATUS_STYLE[status]}`}>
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ocean" />}
      {label ?? (status === "cancelled" ? "stopped" : status)}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
      <div className="h-full rounded-full bg-ocean transition-[width] duration-500" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export type MenuItem =
  | { label: string; icon: IconName; onClick: () => void; danger?: boolean; disabled?: boolean; href?: undefined }
  | { label: string; icon: IconName; href: string; danger?: undefined; disabled?: undefined; onClick?: undefined }
  | "divider";

/** A "⋯" button with a dropdown of actions; closes on outside click or Escape. */
export function ActionMenu({ items, className = "" }: { items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const itemClass = (danger?: boolean) =>
    `flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
      danger ? "text-bad hover:bg-bad/10" : "text-soft hover:bg-panel-2 hover:text-white"
    }`;
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        title="More actions"
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        className={`rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white ${open ? "bg-panel-2 text-white" : ""}`}
      >
        <Icon name="dots" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-line-2 bg-panel py-1 shadow-2xl">
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="my-1 h-px bg-line" />
            ) : it.href ? (
              <a key={i} href={it.href} onClick={() => setOpen(false)} className={itemClass()}>
                <Icon name={it.icon} className="h-3.5 w-3.5" /> {it.label}
              </a>
            ) : (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
                className={itemClass(it.danger)}
              >
                <Icon name={it.icon} className="h-3.5 w-3.5" /> {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Poll `load` every `ms` while `active` says there is work in progress. */
export function usePolling(load: () => void, active: boolean, ms = 3000) {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, active, ms]);
}
