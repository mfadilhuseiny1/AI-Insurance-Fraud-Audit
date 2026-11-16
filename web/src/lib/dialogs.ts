/**
 * In-app dialogs replacing the browser's alert / confirm / prompt (which ignore the theme and
 * block the page). Each returns a promise; <DialogHost /> (in the root layout) renders them in turn.
 *
 *   if (!(await confirmDialog(`Delete "${x.name}"?`))) return;
 *   const name = await promptDialog("Rename", current);   // string, or null when cancelled
 *   void alertDialog(error.message);
 *   const pick = await chooseDialog({ message, choices: [{ id: "all", label: "Delete with data", danger: true }, …] });
 */

export type DialogChoice = { id: string; label: string; danger?: boolean; primary?: boolean };
export type DialogRequest =
  | { id: number; kind: "alert"; title?: string; message: string; resolve: () => void }
  | { id: number; kind: "confirm"; title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
  | { id: number; kind: "prompt"; title?: string; message: string; defaultValue?: string; placeholder?: string; resolve: (value: string | null) => void }
  | { id: number; kind: "choose"; title?: string; message: string; choices: DialogChoice[]; resolve: (choice: string | null) => void };

type Listener = (queue: DialogRequest[]) => void;
let queue: DialogRequest[] = [];
let next = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(queue));

export function subscribeDialogs(l: Listener): () => void {
  listeners.add(l);
  l(queue);
  return () => listeners.delete(l);
}

/** Called by the host when the user answers the front dialog. */
export function settleDialog(id: number) {
  queue = queue.filter((d) => d.id !== id);
  emit();
}

function push<T>(make: (resolve: (v: T) => void, id: number) => DialogRequest): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = next++;
    queue = [...queue, make(resolve, id)];
    emit();
  });
}

const DANGER = /^(delete|remove|discard|revoke|stop|turn off|clear|roll|replace|move .* to the trash|run .* again|close .* without)/i;
/** "Delete …?" → a red "Delete" button; other questions → "OK". */
function confirmLabel(message: string): { label: string; danger: boolean } {
  const first = message.trim().split(/\s+/)[0]?.replace(/[^A-Za-z]/g, "") ?? "";
  const danger = DANGER.test(message.trim());
  const verbs = ["Delete", "Remove", "Discard", "Revoke", "Stop", "Clear", "Replace", "Rotate", "Finish", "Embed", "Count", "Create", "Close", "Roll", "Run", "Move", "Turn"];
  const verb = verbs.find((v) => v.toLowerCase() === first.toLowerCase());
  return { label: verb === "Turn" ? "Turn off" : verb === "Roll" ? "Roll back" : verb === "Move" && /trash/i.test(message) ? "Move to trash" : (verb ?? "OK"), danger };
}

export type ConfirmOptions = { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };

export function confirmDialog(message: string | ConfirmOptions): Promise<boolean> {
  const o = typeof message === "string" ? { message } : message;
  const guess = confirmLabel(o.message);
  return push<boolean>((resolve, id) => ({
    id,
    kind: "confirm",
    title: o.title,
    message: o.message,
    confirmLabel: o.confirmLabel ?? guess.label,
    cancelLabel: o.cancelLabel,
    danger: o.danger ?? guess.danger,
    resolve,
  }));
}

export function alertDialog(message: string | { title?: string; message: string }): Promise<void> {
  const o = typeof message === "string" ? { message } : message;
  return push<void>((resolve, id) => ({ id, kind: "alert", title: o.title, message: o.message, resolve }));
}

export function promptDialog(message: string, defaultValue?: string | null, opts: { title?: string; placeholder?: string } = {}): Promise<string | null> {
  return push<string | null>((resolve, id) => ({ id, kind: "prompt", title: opts.title, message, defaultValue: defaultValue ?? "", placeholder: opts.placeholder, resolve }));
}

export function chooseDialog(o: { title?: string; message: string; choices: DialogChoice[] }): Promise<string | null> {
  return push<string | null>((resolve, id) => ({ id, kind: "choose", ...o, resolve }));
}
