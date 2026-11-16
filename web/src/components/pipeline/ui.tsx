"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon";

export function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  hideLabel,
  active,
  title,
  shortcut,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  hideLabel?: boolean;
  active?: boolean;
  title?: string;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      title={`${title ?? label}${shortcut ? ` (${shortcut})` : ""}`}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-30 ${
        active ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-soft"
      } ${danger ? "hover:bg-bad/10 hover:text-bad" : "hover:bg-panel-2 hover:text-white"}`}
    >
      <Icon name={icon} className="h-4 w-4" />
      {!hideLabel && label}
    </button>
  );
}

export type MenuItem =
  | {
      icon?: IconName;
      label: string;
      hint?: string;
      run: () => void;
      danger?: boolean;
      disabled?: boolean | string;
      swatch?: string;
      checked?: boolean;
      shortcut?: string;
    }
  | { divider: true; label?: string }
  | { submenu: string; icon?: IconName; items: MenuItem[] };

function MenuList({ items, onClose, width = "w-60" }: { items: MenuItem[]; onClose: () => void; width?: string }) {
  const [sub, setSub] = useState<number | null>(null);
  // a submenu low on the screen opens upwards
  const [up, setUp] = useState(false);
  // leaving a submenu row closes it after a moment, so a diagonal move into the submenu keeps it open
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSub = (i: number, el: HTMLElement) => {
    if (closing.current) clearTimeout(closing.current);
    setUp(el.getBoundingClientRect().top > window.innerHeight * 0.55);
    setSub(i);
  };
  const leaveSub = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = setTimeout(() => setSub(null), 350);
  };
  return (
    <div className={`${width} rounded-lg border border-line-2 bg-panel-2 py-1 text-sm shadow-xl`} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        if ("divider" in item)
          return item.label ? (
            <div key={i} className="mt-1 border-t border-line px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              {item.label}
            </div>
          ) : (
            <div key={i} className="my-1 border-t border-line" />
          );
        if ("submenu" in item)
          return (
            <div key={i} className="relative" onMouseEnter={(e) => openSub(i, e.currentTarget)} onMouseLeave={leaveSub}>
              <button
                type="button"
                onClick={(e) => openSub(i, e.currentTarget)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel hover:text-white ${sub === i ? "bg-panel text-white" : "text-soft"}`}
              >
                {item.icon && <Icon name={item.icon} className="h-3.5 w-3.5 shrink-0 text-ocean" />}
                <span className="flex-1 truncate">{item.submenu}</span>
                <Icon name="right" className="h-3 w-3 text-muted" />
              </button>
              {sub === i && (
                <div className={`absolute left-full z-10 -ml-1 pl-1 ${up ? "bottom-0" : "top-0"}`}>
                  <MenuList items={item.items} onClose={onClose} />
                </div>
              )}
            </div>
          );
        const disabled = !!item.disabled;
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            title={typeof item.disabled === "string" ? item.disabled : item.hint}
            onClick={() => {
              item.run();
              onClose();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
              item.danger ? "text-soft hover:bg-bad/10 hover:text-bad" : "text-soft hover:bg-panel hover:text-white"
            }`}
          >
            {item.swatch ? (
              <span className="h-3.5 w-3.5 shrink-0 rounded ring-1 ring-line-2" style={{ background: item.swatch }} />
            ) : item.checked !== undefined ? (
              <Icon name="check" className={`h-3.5 w-3.5 shrink-0 ${item.checked ? "text-ocean" : "opacity-0"}`} />
            ) : item.icon ? (
              <Icon name={item.icon} className={`h-3.5 w-3.5 shrink-0 ${item.danger ? "" : "text-ocean"}`} />
            ) : (
              <span className="w-3.5" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.label}</span>
              {item.hint && <span className="block truncate text-[11px] text-muted">{item.hint}</span>}
            </span>
            {item.shortcut && <kbd className="text-[10px] text-muted">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** A button with a dropdown menu. */
export function DropMenu({
  label,
  icon,
  items,
  align = "left",
  className,
  buttonClass,
  disabled,
  title,
  width,
  hideLabel,
}: {
  label: ReactNode;
  icon?: IconName;
  items: MenuItem[] | (() => MenuItem[]);
  align?: "left" | "right";
  className?: string;
  buttonClass?: string;
  disabled?: boolean;
  title?: string;
  width?: string;
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className={`relative shrink-0 ${className ?? ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
        className={
          buttonClass ??
          `inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-soft hover:bg-panel-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 ${open ? "bg-panel-2 text-white" : ""}`
        }
      >
        {icon && <Icon name={icon} className="h-4 w-4" />}
        {!hideLabel && label}
        <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className={`absolute top-full z-40 mt-1 ${align === "right" ? "right-0" : "left-0"}`}>
          <MenuList items={typeof items === "function" ? items() : items} onClose={() => setOpen(false)} width={width} />
        </div>
      )}
    </div>
  );
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  return (
    <div ref={ref} className="fixed z-50" style={pos} onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={items} onClose={onClose} width="w-56" />
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className = "",
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: ReactNode; badge?: number | string; tone?: "bad" | "warn" }[];
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs ${value === t.id ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}
        >
          {t.label}
          {t.badge !== undefined && t.badge !== 0 && (
            <span
              className={`rounded px-1 text-[10px] tabular-nums ${t.tone === "bad" ? "bg-bad/20 text-bad" : t.tone === "warn" ? "bg-warn/20 text-warn" : "bg-panel text-soft"}`}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (on: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex items-start gap-2 text-left text-xs text-soft disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-ocean" : "bg-line-2"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      {(label || hint) && (
        <span>
          {label && <span className="block font-medium text-white">{label}</span>}
          {hint && <span className="block text-muted">{hint}</span>}
        </span>
      )}
    </button>
  );
}

export function Field({ label, hint, required, children }: { label: ReactNode; hint?: ReactNode; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">
        {label}
        {required && <span className="text-bad"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words text-soft">{children}</dd>
    </div>
  );
}

/**
 * A node's or an output's note, as a card: lines written "Label: text" (Apa: …, Kenapa: …, Dipakai oleh: …) become
 * headed sections; a line without a label continues the one before, and a note without labels is plain text.
 */
export function NoteCard({ text }: { text: string }) {
  const parts: { label?: string; body: string }[] = [];
  const lines = text.trim().split("\n");
  for (const line of lines) {
    // "Label: text" lines head their sections; a one-line note is a plain description ("Buku label: …" included)
    const m = lines.length > 1 ? /^([A-Z][\p{L} ]{0,24}):\s*(.*)$/u.exec(line.trim()) : null;
    if (m) parts.push({ label: m[1], body: m[2] });
    else if (parts.length) parts[parts.length - 1].body += `\n${line}`;
    else parts.push({ body: line });
  }
  return (
    <div className="rounded-md border border-line-2 bg-panel-2/60 p-2.5">
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ocean">
        <Icon name="comment" className="h-3 w-3" /> Note
      </div>
      <div className="space-y-1.5">
        {parts.map((p, i) => (
          <div key={i}>
            {p.label && <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{p.label}</div>}
            <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-soft">{p.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <Icon name={icon} className="h-8 w-8 text-line-2" />
      <div className="mt-1 text-sm font-medium">{title}</div>
      {children && <div className="text-xs text-muted">{children}</div>}
    </div>
  );
}

/** Rail panel chrome: title bar with a close button. */
export function Panel({ title, icon, onClose, actions, children, width = "w-80" }: { title: string; icon: IconName; onClose: () => void; actions?: ReactNode; children: ReactNode; width?: string }) {
  return (
    <aside className={`flex ${width} shrink-0 flex-col border-l border-line bg-panel`}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 text-sm font-medium">
        <Icon name={icon} className="h-4 w-4 text-ocean" />
        <span className="flex-1 truncate">{title}</span>
        {actions}
        <button type="button" onClick={onClose} title="Close panel" className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  );
}
