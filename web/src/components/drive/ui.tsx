"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DriveItem, SharedItem } from "@/lib/api";
import { Icon, type IconName } from "../Icon";

/** Small building blocks shared by the Files & Projects views, dialogs and the share page. */

export const folderHref = (id: string | null) => (id ? `/files/${id}` : "/files");

export function iconFor(item: Pick<DriveItem, "kind" | "content_type">): IconName {
  if (item.kind === "project") return "project";
  if (item.kind === "folder") return "folder";
  if (item.content_type?.startsWith("image/")) return "image";
  // Pipeline Builder files: pipelines and their deployed Parquet datasets
  if (item.content_type === "application/vnd.bluesandai.pipeline+json") return "pipeline";
  if (item.content_type === "application/vnd.bluesandai.workshop+json") return "device";
  if (item.content_type === "application/vnd.apache.parquet") return "table";
  // a workbook uploaded as a spreadsheet (drive_import.py)
  if (item.content_type === "application/vnd.bluesandai.spreadsheet") return "grid";
  // Foundry Iceberg tables (iceberg_catalog.py)
  if (item.content_type === "application/vnd.apache.iceberg+json") return "layers";
  if (item.content_type === "application/vnd.bluesandai.sql-worksheet+json") return "database";
  if (item.content_type === "application/vnd.bluesandai.artifacts-repository+json") return "layers";
  if (item.content_type === "application/vnd.bluesandai.logic-flow+json") return "bolt";
  if (item.content_type === "application/vnd.bluesandai.model+json") return "cube";
  if (item.content_type === "application/vnd.bluesandai.code-workspace+json") return "code";
  if (item.content_type === "application/vnd.bluesandai.preparation+json") return "transform";
  return "doc";
}

export const iconColor = (item: Pick<DriveItem, "kind">) => (item.kind === "file" ? "text-ocean" : "text-sand");

/** "PDF", "PNG", "Folder"… */
export function typeLabel(item: Pick<DriveItem, "kind" | "name" | "content_type">): string {
  if (item.kind === "project") return "Project";
  if (item.kind === "folder") return "Folder";
  if (item.content_type === "application/vnd.apache.iceberg+json") return "Iceberg table";
  if (item.content_type === "application/vnd.bluesandai.workshop+json") return "Workshop module";
  if (item.content_type === "application/vnd.bluesandai.sql-worksheet+json") return "SQL worksheet";
  if (item.content_type === "application/vnd.bluesandai.artifacts-repository+json") return "Artifact repository";
  if (item.content_type === "application/vnd.bluesandai.logic-flow+json") return "Connected flow";
  if (item.content_type === "application/vnd.bluesandai.model+json") return "Model";
  if (item.content_type === "application/vnd.bluesandai.code-workspace+json") return "Jupyter workspace";
  if (item.content_type === "application/vnd.bluesandai.dc-agent+json") return "Data Connection agent";
  if (item.content_type === "application/vnd.bluesandai.preparation+json") return "Preparation";
  const ext = item.name.includes(".") ? item.name.split(".").pop()!.toUpperCase() : "";
  return ext || item.content_type || "File";
}

/** Files the browser can show in a preview (the rest are downloaded). */
/** How the Preview dialog shows a file; "table" (Parquet, read through the API) only where `tables` is set. */
export function previewable(
  item: Pick<SharedItem, "kind" | "content_type" | "name">,
  { tables = false }: { tables?: boolean } = {},
): "image" | "frame" | "table" | null {
  if (item.kind !== "file") return null;
  const type = item.content_type ?? "";
  if (tables && (type === "application/vnd.apache.parquet" || /\.parquet$/i.test(item.name))) return "table";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || type.startsWith("text/") || type.startsWith("video/") || type.startsWith("audio/"))
    return "frame";
  if (/\.(json|md|txt|csv|log|xml|ya?ml)$/i.test(item.name)) return "frame";
  return null;
}

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  className = "",
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean, e: React.MouseEvent) => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked, e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked || indeterminate ? "border-ocean bg-ocean text-white" : "border-line-2 bg-ink hover:border-ocean"
      } ${className}`}
    >
      {checked && !indeterminate && <Icon name="check" className="h-3 w-3" />}
      {indeterminate && <Icon name="minus" className="h-3 w-3" />}
    </button>
  );
}

export function DefaultBadge() {
  return (
    <span
      className="shrink-0 rounded border border-sand/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-sand"
      title="Created by the app and saved into automatically; cannot be renamed, moved or deleted"
    >
      Default
    </span>
  );
}

/** Inline name editor: Enter or blur saves, Escape cancels. The extension starts unselected. */
export function NameInput({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save) onDone(ref.current!.value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep list shortcuts (Delete, Ctrl+A…) out of the editor
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="min-w-0 flex-1 rounded border border-ocean bg-ink px-2 py-0.5 text-sm outline-none"
    />
  );
}

function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [ref, onClose]);
}

/** A dropdown anchored under its (relative) parent. */
export function Menu({
  onClose,
  children,
  align = "right",
}: {
  onClose: () => void;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`absolute top-full z-30 mt-1 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel-2 py-1 text-left shadow-2xl ${
        align === "right" ? "right-0" : "left-0"
      }`}
    >
      {children}
    </div>
  );
}

/** A menu at a point on screen (right-click), kept inside the window. */
export function PointMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useDismiss(ref, onClose);
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  return (
    <div
      ref={ref}
      style={pos}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel-2 py-1 text-left shadow-2xl"
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  shortcut,
  danger,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-ocean/15 ${
        danger ? "text-bad" : "text-white"
      }`}
    >
      <Icon name={icon} className={`mt-0.5 h-4 w-4 shrink-0 ${danger ? "" : "text-muted"}`} />
      <span className="min-w-0 flex-1">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {shortcut && <span className="mt-0.5 text-[11px] text-muted">{shortcut}</span>}
    </button>
  );
}

export const MenuDivider = () => <div className="my-1 border-t border-line" />;

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="min-w-0 truncate font-medium">{title}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 text-sm">{footer}</div>}
      </div>
    </div>
  );
}

export const buttonClass = {
  primary: "rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-40",
  ghost: "rounded-md px-3 py-1.5 text-sm text-soft hover:bg-panel-2 disabled:opacity-40",
  outline:
    "flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1 text-xs hover:border-ocean hover:text-ocean disabled:opacity-40",
};
