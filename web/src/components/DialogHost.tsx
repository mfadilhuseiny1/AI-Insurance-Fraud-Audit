"use client";

import { useEffect, useRef, useState } from "react";
import { settleDialog, subscribeDialogs, type DialogRequest } from "@/lib/dialogs";
import { Icon } from "./Icon";

const BTN = "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium disabled:opacity-40";
const PRIMARY = `${BTN} bg-ocean text-white hover:bg-ocean-deep`;
const DANGER = `${BTN} bg-bad text-white hover:brightness-110`;
const SECONDARY = `${BTN} border border-line-2 bg-panel-2 text-soft hover:text-white`;

/** Renders the in-app alert / confirm / prompt dialogs (lib/dialogs.ts), one at a time, in the app's theme. */
export default function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  useEffect(() => subscribeDialogs(setQueue), []);
  const d = queue[0];
  if (!d) return null;
  return <Dialog key={d.id} d={d} />;
}

function Dialog({ d }: { d: DialogRequest }) {
  const [value, setValue] = useState(d.kind === "prompt" ? (d.defaultValue ?? "") : "");
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);

  const answer = (v: unknown) => {
    settleDialog(d.id);
    if (d.kind === "alert") d.resolve();
    else if (d.kind === "confirm") d.resolve(v as boolean);
    else if (d.kind === "prompt") d.resolve(v as string | null);
    else d.resolve(v as string | null);
  };
  const cancel = () => answer(d.kind === "confirm" ? false : d.kind === "alert" ? undefined : null);
  const accept = () => answer(d.kind === "confirm" ? true : d.kind === "prompt" ? value : undefined);

  useEffect(() => {
    if (d.kind === "prompt") {
      input.current?.focus();
      input.current?.select();
    } else ok.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // the dialog is keyed by its request: these run once per dialog
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const danger = d.kind === "confirm" && d.danger;
  const title = d.title ?? (d.kind === "alert" ? "Something went wrong" : d.kind === "prompt" ? null : null);
  const icon = d.kind === "alert" ? "alert" : danger ? "alert" : d.kind === "prompt" ? "edit" : "info";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/70 p-4 backdrop-blur-[1px]" onMouseDown={cancel}>
      <div
        role={d.kind === "alert" ? "alertdialog" : "dialog"}
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            accept();
          }}
        >
          <div className="flex gap-3 p-5">
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${danger || d.kind === "alert" ? "bg-bad/10 text-bad ring-bad/30" : "bg-ocean/10 text-ocean ring-ocean/30"}`}>
              <Icon name={icon} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              {title && <h2 className="mb-1 text-sm font-semibold text-white">{title}</h2>}
              <p className="whitespace-pre-line break-words text-sm text-soft">{d.message}</p>
              {d.kind === "prompt" && (
                <input
                  ref={input}
                  value={value}
                  placeholder={d.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  className="mt-3 w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm text-white outline-none focus:border-ocean"
                />
              )}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-panel-2/40 px-5 py-3">
            {d.kind === "choose" ? (
              <>
                <button type="button" onClick={cancel} className={SECONDARY}>
                  Cancel
                </button>
                {d.choices.map((c, i) => (
                  <button
                    key={c.id}
                    ref={i === d.choices.length - 1 ? ok : undefined}
                    type="button"
                    onClick={() => answer(c.id)}
                    className={c.danger ? DANGER : c.primary ? PRIMARY : SECONDARY}
                  >
                    {c.label}
                  </button>
                ))}
              </>
            ) : d.kind === "alert" ? (
              <button ref={ok} type="submit" className={PRIMARY}>
                OK
              </button>
            ) : (
              <>
                <button type="button" onClick={cancel} className={SECONDARY}>
                  {(d.kind === "confirm" && d.cancelLabel) || "Cancel"}
                </button>
                <button ref={ok} type="submit" className={danger ? DANGER : PRIMARY}>
                  {d.kind === "confirm" ? d.confirmLabel : "OK"}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
