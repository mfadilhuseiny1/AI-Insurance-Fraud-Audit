"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, isContainer, type DriveFolder, type DriveItem } from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { Icon } from "./Icon";
import { NewProjectDialog } from "./security/ProjectGovernance";

/** Where a folder-mode picker puts things: the open folder (null = top level). */
export type PickedFolder = { id: string | null; name: string };

/**
 * Browse the Files tab and pick one file (`canPick` explains why a file can't be chosen), or, with
 * `onPickMany`, tick any number of files across folders; or, with `folder`, pick the open folder as
 * a destination (`folder.extra` adds controls to the footer).
 */
export function DrivePicker({
  title,
  canPick = () => null,
  onPick = () => {},
  onPickMany,
  folder,
  onClose,
}: {
  title: string;
  canPick?: (item: DriveItem) => string | null;
  onPick?: (item: DriveItem) => void;
  onPickMany?: (items: DriveItem[]) => void;
  folder?: { action: string; busy?: boolean; extra?: ReactNode; onPick: (folder: PickedFolder) => void };
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [data, setData] = useState<DriveFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [filter, setFilter] = useState("");
  // ticked files (multiple mode), kept while moving between folders, in the order ticked
  const [ticked, setTicked] = useState<Map<string, DriveItem>>(new Map());
  const multiple = !!onPickMany && !folder;
  // creating the destination in place: a folder inside the one shown, a Project at the top level
  const [naming, setNaming] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api.drive
      .folder(folderId)
      .then((d) => !stale && setData(d))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [folderId]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const makeFolder = async () => {
    const name = (naming ?? "").trim();
    if (!name) return;
    setCreating(true);
    setNameErr(null);
    try {
      const made = await api.drive.createFolder(name, folderId);
      setNaming(null);
      go(made.id); // inside it: "Use this folder" picks it
    } catch (e) {
      setNameErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const go = (id: string | null) => {
    setData(null);
    setError(null);
    setSelected(null);
    setFilter("");
    setFolderId(id);
  };

  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [data, filter]);

  const path = data?.folder ? [...(data.folder.path ?? []), { id: data.folder.id, name: data.folder.name }] : [];
  const pick = (item: DriveItem) => !canPick(item) && onPick(item);
  const toggle = (item: DriveItem) =>
    setTicked((m) => {
      const next = new Map(m);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  const pickable = items.filter((i) => !isContainer(i) && !canPick(i));
  const allTicked = pickable.length > 0 && pickable.every((i) => ticked.has(i.id));
  const tickAll = () =>
    setTicked((m) => {
      const next = new Map(m);
      for (const i of pickable) {
        if (allTicked) next.delete(i.id);
        else next.set(i.id, i);
      }
      return next;
    });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[min(36rem,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="font-medium">{title}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
            <Icon name="x" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
          <nav className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => go(null)}
              className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 hover:bg-panel-2 ${
                path.length ? "text-soft" : "font-medium"
              }`}
            >
              <Icon name="folder" className="h-4 w-4 text-sand" /> Files
            </button>
            {path.map((p, i) => (
              <span key={p.id} className="flex min-w-0 items-center gap-1">
                <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />
                <button
                  type="button"
                  onClick={() => go(p.id)}
                  className={`truncate rounded px-1.5 py-1 hover:bg-panel-2 ${
                    i === path.length - 1 ? "font-medium" : "text-soft"
                  }`}
                  title={p.name}
                >
                  {p.name}
                </button>
              </span>
            ))}
          </nav>
          {folder &&
            (folderId === null ? (
              <button type="button" onClick={() => setNewProject(true)} className="flex shrink-0 items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:border-ocean/60 hover:text-white" data-picker-new-project>
                <Icon name="plus" className="h-3.5 w-3.5" /> New Project
              </button>
            ) : naming === null ? (
              <button type="button" onClick={() => setNaming("")} className="flex shrink-0 items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:border-ocean/60 hover:text-white" data-picker-new-folder>
                <Icon name="plus" className="h-3.5 w-3.5" /> New folder
              </button>
            ) : null)}
          <label className="flex w-48 items-center gap-2 rounded-md border border-line bg-ink px-2.5 py-1.5 focus-within:border-ocean">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </label>
        </div>

        {naming !== null && (
          // not a <form>: the picker often opens inside a dialog's form, and forms cannot nest
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2/40 px-4 py-2 text-sm" data-picker-folder-name>
            <Icon name="folder" className="h-4 w-4 shrink-0 text-sand" />
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void makeFolder();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setNaming(null);
                }
              }}
              placeholder={`New folder in ${data?.folder?.name ?? "this folder"}`}
              className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean"
            />
            <button type="button" onClick={() => void makeFolder()} disabled={creating || !naming.trim()} className="rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-40">
              {creating ? "Creating…" : "Create folder"}
            </button>
            <button type="button" onClick={() => (setNaming(null), setNameErr(null))} className="rounded-md px-2 py-1.5 text-xs text-soft hover:bg-panel-2">
              Cancel
            </button>
            {nameErr && <span className="w-full text-xs text-bad">{nameErr}</span>}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="p-8 text-center text-sm text-bad">{error}</div>
          ) : !data ? (
            <div className="flex items-center justify-center p-8 text-sm text-muted">
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-12 text-sm text-muted">
              <Icon name="folder" className="h-10 w-10 text-line-2" />
              {filter ? `Nothing here matches “${filter}”.` : "This folder is empty."}
            </div>
          ) : (
            <ul>
              {multiple && pickable.length > 0 && (
                <li className="flex items-center gap-3 border-b border-line bg-panel-2/50 px-4 py-1.5 text-xs text-soft">
                  <input type="checkbox" checked={allTicked} onChange={tickAll} className="accent-ocean" aria-label="Select all in this folder" />
                  Select all {pickable.length} parseable files in this folder
                </li>
              )}
              {items.map((item) => {
                const isFolder = isContainer(item);
                const reason = isFolder ? null : folder ? "file" : canPick(item);
                const isSelected = multiple ? ticked.has(item.id) : selected?.id === item.id;
                return (
                  <li key={item.id} className="flex items-center border-b border-line">
                    {multiple && (
                      <span className="flex w-9 shrink-0 justify-center pl-4">
                        {!isFolder && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!!reason}
                            onChange={() => toggle(item)}
                            className="accent-ocean"
                            aria-label={`Select ${item.name}`}
                          />
                        )}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={!!reason}
                      title={reason ?? item.name}
                      onClick={() => (isFolder ? go(item.id) : multiple ? toggle(item) : setSelected(item))}
                      onDoubleClick={() => !isFolder && !multiple && pick(item)}
                      className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                        isSelected ? "bg-ocean/15" : "hover:bg-panel-2"
                      }`}
                    >
                      <Icon
                        name={item.kind === "project" ? "project" : isFolder ? "folder" : item.content_type?.startsWith("image/") ? "image" : "doc"}
                        className={`h-4 w-4 shrink-0 ${isFolder ? "text-sand" : "text-ocean"}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {isFolder ? `${item.items ?? 0} items` : reason && !folder ? reason : bytes(item.size)}
                      </span>
                      <span className="w-28 shrink-0 text-right text-xs text-muted">{when(item.updated_at)}</span>
                      {isFolder && <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm">
          {folder ? (
            <div className="min-w-0 flex-1">{folder.extra}</div>
          ) : multiple ? (
            <span className="min-w-0 truncate text-muted">
              {ticked.size ? (
                <>
                  {ticked.size} selected
                  <button type="button" onClick={() => setTicked(new Map())} className="ml-2 text-xs text-ocean hover:underline">
                    clear
                  </button>
                </>
              ) : (
                "Tick files to parse; one file opens it, several make a batch"
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate text-muted">{selected ? selected.name : "Select a file"}</span>
          )}
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-soft hover:bg-panel-2">
              Cancel
            </button>
            {folder ? (
              <button
                type="button"
                disabled={!data || folder.busy}
                onClick={() => folder.onPick({ id: folderId, name: data?.folder?.name ?? "Files" })}
                className="rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
              >
                {folder.action}
              </button>
            ) : multiple ? (
              <button
                type="button"
                disabled={!ticked.size}
                onClick={() => onPickMany?.([...ticked.values()])}
                className="rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
              >
                {ticked.size > 1 ? `Use ${ticked.size} files` : "Use file"}
              </button>
            ) : (
              <button
                type="button"
                disabled={!selected}
                onClick={() => selected && pick(selected)}
                className="rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
              >
                Use file
              </button>
            )}
          </div>
        </div>
      </div>
      {/* its own layer: clicks in it never reach the picker's backdrop (which closes the picker) */}
      {newProject && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <NewProjectDialog onClose={() => setNewProject(false)} onCreated={(id) => (setNewProject(false), go(id))} />
        </div>
      )}
    </div>
  );
}
