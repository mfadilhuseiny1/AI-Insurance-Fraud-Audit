"use client";

import { useEffect, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon";

export function Modal({
  title,
  icon,
  onClose,
  children,
  wide,
  xl,
}: {
  title: string;
  icon?: IconName;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** wider still (editors with a side-by-side preview) */
  xl?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" onMouseDown={onClose}>
      <div
        className={`flex max-h-[90vh] w-full flex-col rounded-xl border border-line-2 bg-panel shadow-2xl ${xl ? "max-w-6xl" : wide ? "max-w-3xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
          {icon && <Icon name={icon} className="h-4 w-4 text-ocean" />}
          <span className="flex-1">{title}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** An input without a width, for fields given a fixed one (w-24 next to w-full does not win). */
export const fieldClass =
  "rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none placeholder:text-muted focus:border-ocean";

export const inputClass = `w-full ${fieldClass}`;

export const buttonClass = {
  primary:
    "inline-flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:cursor-not-allowed disabled:opacity-40",
  secondary:
    "inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-panel-2 px-3 py-1.5 text-sm text-soft hover:text-white disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-soft hover:bg-panel-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-40",
};
