/**
 * "Copy for Notepad": other apps copy a ready-configured Notepad widget (a Contour board, a Quiver card, a Vertex
 * graph, a Code Workbook node); Notepad's insert menu pastes it. Kept in this browser's storage.
 */
import type { WidgetConfig, WidgetKind } from "./notepad";

export type NotepadClip = { kind: WidgetKind; config: WidgetConfig; label: string; at: string };
const KEY = "bluesandai.notepad.clipboard";

export function copyForNotepad(kind: WidgetKind, config: WidgetConfig, label: string): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ kind, config, label, at: new Date().toISOString() } satisfies NotepadClip));
    return true;
  } catch {
    return false;
  }
}

export function notepadClip(): NotepadClip | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null") as NotepadClip | null;
    return c && c.kind && c.config ? c : null;
  } catch {
    return null;
  }
}
