"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { JpIcon } from "./icons";

// ------------------------------------------------------------------------------------------------ menus

export type MenuItem =
  | "-"
  | { label: string; shortcut?: string; onClick?: () => void; disabled?: boolean; checked?: boolean; submenu?: MenuItem[]; hidden?: boolean };

export function Menu({ items, x, y, onClose, level = 0 }: { items: MenuItem[]; x: number; y: number; onClose: () => void; level?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const r = el.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(0, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(0, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    if (level) return;
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".jp-Menu")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose, level]);
  const visible = items.filter((it) => it === "-" || !it.hidden);
  return (
    <>
      <div ref={el} className="jp-Menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
        {visible.map((it, i) =>
          it === "-" ? (
            visible[i - 1] === "-" || i === 0 || i === visible.length - 1 ? null : <div key={i} className="jp-Menu-sep" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={`jp-Menu-item${sub?.i === i ? " jp-mod-active" : ""}`}
              onMouseEnter={(e) => {
                if (it.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ i, x: r.right - 2, y: r.top - 5 });
                } else setSub(null);
              }}
              onClick={() => {
                if (it.submenu || it.disabled) return;
                onClose();
                it.onClick?.();
              }}
            >
              <span className="jp-Menu-itemCheck">{it.checked && <JpIcon name="check" />}</span>
              <span className="jp-Menu-itemLabel">{it.label}</span>
              {it.shortcut && <span className="jp-Menu-itemShortcut">{it.shortcut}</span>}
              {it.submenu && <JpIcon name="caretRight" />}
            </button>
          ),
        )}
      </div>
      {sub && typeof visible[sub.i] === "object" && (
        <Menu items={(visible[sub.i] as { submenu: MenuItem[] }).submenu} x={sub.x} y={sub.y} onClose={onClose} level={level + 1} />
      )}
    </>
  );
}

export function MenuBar({ menus }: { menus: { label: string; items: () => MenuItem[] }[] }) {
  const [open, setOpen] = useState<{ i: number; x: number; y: number } | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const show = (i: number) => {
    const r = refs.current[i]?.getBoundingClientRect();
    if (r) setOpen({ i, x: r.left, y: r.bottom });
  };
  const close = useCallback(() => setOpen(null), []);
  return (
    <div className="jp-MenuBar" role="menubar">
      {menus.map((m, i) => (
        <button
          key={m.label}
          ref={(e) => {
            refs.current[i] = e;
          }}
          type="button"
          className={`jp-MenuBar-item${open?.i === i ? " jp-mod-active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open?.i === i) setOpen(null);
            else show(i);
          }}
          onMouseEnter={() => open && open.i !== i && show(i)}
        >
          {m.label}
        </button>
      ))}
      {open && <Menu key={open.i} items={menus[open.i].items()} x={open.x} y={open.y} onClose={close} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ dialogs

type DialogSpec = {
  title: string;
  body?: ReactNode;
  buttons: { label: string; kind?: "accept" | "reject" | "warn"; value: string }[];
  input?: { value: string; placeholder?: string; select?: [number, number] };
  wide?: boolean;
};
type DialogApi = {
  show: (spec: DialogSpec) => Promise<{ button: string; value: string }>;
  confirm: (title: string, body: ReactNode, accept?: string, warn?: boolean) => Promise<boolean>;
  prompt: (title: string, value: string, accept?: string, label?: ReactNode) => Promise<string | null>;
  alert: (title: string, body: ReactNode) => Promise<void>;
  custom: (render: (close: () => void) => ReactNode) => void;
};

const DialogCtx = createContext<DialogApi | null>(null);
export const useDialogs = () => useContext(DialogCtx)!;

export function DialogHost({ children, theme }: { children: ReactNode; theme: string }) {
  const [spec, setSpec] = useState<(DialogSpec & { resolve: (r: { button: string; value: string }) => void }) | null>(null);
  const [customs, setCustoms] = useState<{ id: number; render: (close: () => void) => ReactNode }[]>([]);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [api] = useState<DialogApi>(() => {
    const show: DialogApi["show"] = (s) =>
      new Promise((resolve) => {
        setValue(s.input?.value ?? "");
        setSpec({ ...s, resolve });
      });
    return {
      show,
      confirm: async (title, body, accept = "OK", warn = false) =>
        (await show({ title, body, buttons: [{ label: "Cancel", kind: "reject", value: "cancel" }, { label: accept, kind: warn ? "warn" : "accept", value: "ok" }] })).button === "ok",
      prompt: async (title, v, accept = "Rename", label) => {
        const r = await show({ title, body: label, input: { value: v, select: [0, v.lastIndexOf(".") > 0 ? v.lastIndexOf(".") : v.length] }, buttons: [{ label: "Cancel", kind: "reject", value: "cancel" }, { label: accept, kind: "accept", value: "ok" }] });
        return r.button === "ok" ? r.value : null;
      },
      alert: async (title, body) => {
        await show({ title, body, buttons: [{ label: "OK", kind: "accept", value: "ok" }] });
      },
      custom: (render) => setCustoms((c) => [...c, { id: Date.now() + Math.random(), render }]),
    };
  });
  useEffect(() => {
    if (spec?.input && input.current) {
      input.current.focus();
      const [a, b] = spec.input.select ?? [0, spec.input.value.length];
      input.current.setSelectionRange(a, b);
    }
  }, [spec]);
  const finish = (button: string) => {
    spec?.resolve({ button, value });
    setSpec(null);
  };
  return (
    <DialogCtx.Provider value={api}>
      {children}
      {spec && (
        <div className="jp-Dialog" data-jp-theme={theme} onMouseDown={(e) => e.target === e.currentTarget && finish("cancel")}>
          <div
            className="jp-Dialog-content"
            style={spec.wide ? { width: "min(760px, calc(100vw - 32px))" } : undefined}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") finish("cancel");
              if (e.key === "Enter" && (spec.input || !(e.target as HTMLElement).closest("button"))) {
                e.preventDefault();
                finish(spec.buttons[spec.buttons.length - 1].value);
              }
            }}
            tabIndex={-1}
            ref={(e) => {
              if (e && !spec.input && !e.contains(document.activeElement)) e.querySelector<HTMLButtonElement>(".jp-mod-accept, .jp-mod-warn")?.focus();
            }}
          >
            <div className="jp-Dialog-header">{spec.title}</div>
            {(spec.body || spec.input) && (
              <div className="jp-Dialog-body">
                {spec.body}
                {spec.input && <input ref={input} className="jp-mod-styled" style={{ marginTop: spec.body ? 8 : 0 }} value={value} placeholder={spec.input.placeholder} onChange={(e) => setValue(e.target.value)} />}
              </div>
            )}
            <div className="jp-Dialog-footer">
              {spec.buttons.map((b) => (
                <button key={b.value} type="button" className={`jp-Button jp-mod-${b.kind ?? "reject"}`} onClick={() => finish(b.value)}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {customs.map((c) => (
        <div key={c.id} className="jp-Dialog" data-jp-theme={theme}>
          {c.render(() => setCustoms((all) => all.filter((x) => x.id !== c.id)))}
        </div>
      ))}
    </DialogCtx.Provider>
  );
}

/** A dialog box (header, body, footer) for dialogs with their own state. */
export function DialogBox({ title, children, footer, onClose, width }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div
      className="jp-Dialog-content"
      style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="jp-Dialog-header">{title}</div>
      <div className="jp-Dialog-body">{children}</div>
      <div className="jp-Dialog-footer">{footer}</div>
    </div>
  );
}

export const relTime = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "seconds ago";
  if (s < 3600) return `${Math.floor(s / 60)} minute${Math.floor(s / 60) === 1 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${Math.floor(s / 3600) === 1 ? "" : "s"} ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
};
