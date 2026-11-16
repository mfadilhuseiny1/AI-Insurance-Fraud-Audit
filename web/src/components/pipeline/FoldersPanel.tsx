"use client";

import { useState } from "react";
import { folderSubtree, hiddenFolders } from "@/lib/graphLayout";
import { uid, type Pipeline, type PipelineFolder, type PipelineNode } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { NODE_ICON } from "./Graph";
import { DropMenu, Panel } from "./ui";
import { confirmDialog } from "@/lib/dialogs";

/** The pipeline file tree: folders and sub-folders of nodes, shown or hidden together. */
export function FoldersPanel({
  pipeline,
  selected,
  onSelect,
  change,
  onCenter,
  onRemoveNodes,
  onClose,
}: {
  pipeline: Pipeline;
  selected: string[];
  onSelect: (ids: string[], additive: boolean) => void;
  change: (fn: (p: Pipeline) => Pipeline, record?: boolean) => void;
  onCenter: (ids: string[]) => void;
  onRemoveNodes: (ids: string[]) => void;
  onClose: () => void;
}) {
  const folders = pipeline.folders ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(folders.map((f) => f.id)));
  const [dragOver, setDragOver] = useState<string | null>(null);
  const hidden = hiddenFolders(folders);

  const addFolder = (parent: string | null) => {
    const id = uid();
    change((p) => ({ ...p, folders: [...(p.folders ?? []), { id, name: "New folder", parent }] }));
    setOpen(new Set([...open, id, ...(parent ? [parent] : [])]));
    setRenaming(id);
  };
  const patchFolder = (id: string, patch: Partial<PipelineFolder>, record = true) =>
    change((p) => ({ ...p, folders: (p.folders ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)) }), record);

  const nodesIn = (folderId: string) => {
    const ids = folderSubtree(folders, folderId);
    return pipeline.nodes.filter((n) => n.folder && ids.has(n.folder));
  };

  const deleteFolder = async (f: PipelineFolder) => {
    const inside = nodesIn(f.id);
    if (inside.length && !(await confirmDialog(`Delete "${f.name}" and the ${inside.length} node${inside.length > 1 ? "s" : ""} inside it?`))) return;
    const ids = folderSubtree(folders, f.id);
    if (inside.length) onRemoveNodes(inside.map((n) => n.id));
    change((p) => ({
      ...p,
      folders: (p.folders ?? []).filter((x) => !ids.has(x.id)),
      textNodes: (p.textNodes ?? []).map((t) => (t.folder && ids.has(t.folder) ? { ...t, folder: undefined } : t)),
    }));
  };

  /** drop: node ids (dragging a highlighted node moves every highlighted one) or a folder */
  const drop = (target: string | null, data: string) => {
    setDragOver(null);
    if (data.startsWith("folder:")) {
      const id = data.slice(7);
      if (target && folderSubtree(folders, id).has(target)) return; // not into itself
      patchFolder(id, { parent: target });
      return;
    }
    const ids = data.split(",");
    change((p) => ({ ...p, nodes: p.nodes.map((n) => (ids.includes(n.id) ? { ...n, folder: target ?? undefined } : n)) }));
    if (target) setOpen(new Set([...open, target]));
  };

  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(target ?? "__root");
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      drop(target, e.dataTransfer.getData("text/x-pipeline"));
    },
  });

  const nodeRow = (n: PipelineNode, depth: number) => {
    const isSel = selected.includes(n.id);
    return (
      <li
        key={n.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/x-pipeline", (isSel ? selected.filter((s) => pipeline.nodes.some((x) => x.id === s)) : [n.id]).join(","))}
        onClick={(e) => onSelect([n.id], e.shiftKey || e.ctrlKey || e.metaKey)}
        className={`flex cursor-pointer items-center gap-1.5 rounded py-1 pr-2 text-xs ${isSel ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <Icon name={NODE_ICON[n.kind]} className="h-3.5 w-3.5 shrink-0 text-ocean" />
        <span className="truncate">{n.name}</span>
        {(pipeline.hidden ?? []).includes(n.id) && <Icon name="eye" className="ml-auto h-3 w-3 text-muted opacity-50" />}
      </li>
    );
  };

  const folderRow = (f: PipelineFolder, depth: number): React.ReactNode => {
    const children = folders.filter((c) => c.parent === f.id);
    const members = pipeline.nodes.filter((n) => n.folder === f.id);
    const isOpen = open.has(f.id);
    const isHidden = hidden.has(f.id);
    return (
      <li key={f.id}>
        <div
          draggable={renaming !== f.id}
          onDragStart={(e) => e.dataTransfer.setData("text/x-pipeline", `folder:${f.id}`)}
          {...dropProps(f.id)}
          className={`group flex items-center gap-1 rounded py-1 pr-1 text-xs ${dragOver === f.id ? "bg-ocean/20 ring-1 ring-ocean" : "hover:bg-panel-2"} ${isHidden ? "opacity-50" : ""}`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <button type="button" onClick={() => setOpen(isOpen ? new Set([...open].filter((x) => x !== f.id)) : new Set([...open, f.id]))} className="rounded p-0.5 text-muted">
            <Icon name={isOpen ? "down" : "right"} className="h-3 w-3" />
          </button>
          <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-sand" />
          {renaming === f.id ? (
            <input
              autoFocus
              defaultValue={f.name}
              onBlur={(e) => {
                patchFolder(f.id, { name: e.target.value.trim() || f.name });
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              className="min-w-0 flex-1 rounded border border-ocean bg-ink px-1 py-0.5 text-xs outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => onSelect(nodesIn(f.id).map((n) => n.id), false)}
              onDoubleClick={() => setRenaming(f.id)}
              className="min-w-0 flex-1 truncate text-left text-soft"
              title="Click to select its nodes · double-click to rename"
            >
              {f.name} <span className="text-muted">{nodesIn(f.id).length}</span>
            </button>
          )}
          <button type="button" title="Center its nodes on the graph" onClick={() => onCenter(nodesIn(f.id).map((n) => n.id))} className="rounded p-0.5 text-muted opacity-0 hover:text-white group-hover:opacity-100">
            <Icon name="fit" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={f.hidden ? "Show the nodes in this folder" : "Hide the nodes in this folder"}
            onClick={() => patchFolder(f.id, { hidden: !f.hidden })}
            className={`rounded p-0.5 ${f.hidden ? "text-warn" : "text-muted opacity-0 hover:text-white group-hover:opacity-100"}`}
          >
            <Icon name="eye" className="h-3.5 w-3.5" />
          </button>
          <DropMenu
            label=""
            hideLabel
            icon="dots"
            align="right"
            buttonClass="rounded p-0.5 text-muted hover:text-white"
            items={[
              { icon: "folderPlus", label: "Create folder", run: () => addFolder(f.id) },
              { icon: "edit", label: "Rename", run: () => setRenaming(f.id) },
              {
                icon: "check",
                label: "Move selected nodes here",
                disabled: !selected.length,
                run: () => drop(f.id, selected.join(",")),
              },
              ...(f.parent ? [{ icon: "folderUp" as const, label: "Move to top level", run: () => patchFolder(f.id, { parent: null }) }] : []),
              { divider: true as const },
              { icon: "trash", label: "Delete folder", danger: true, run: () => deleteFolder(f) },
            ]}
          />
        </div>
        {isOpen && (
          <ul>
            {children.map((c) => folderRow(c, depth + 1))}
            {members.map((n) => nodeRow(n, depth + 1))}
            {!children.length && !members.length && (
              <li className="py-1 text-[11px] italic text-muted" style={{ paddingLeft: 26 + depth * 14 }}>
                Drag nodes here
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const loose = pipeline.nodes.filter((n) => !n.folder || !folders.some((f) => f.id === n.folder));

  return (
    <Panel
      title="Pipeline file tree"
      icon="folder"
      onClose={onClose}
      actions={
        <button type="button" title="New folder" onClick={() => addFolder(null)} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
          <Icon name="folderPlus" className="h-4 w-4" />
        </button>
      }
    >
      <p className="border-b border-line px-3 py-2 text-[11px] text-muted">
        Group nodes into folders; the eye shows or hides a folder&apos;s nodes on the graph. Select nodes on the graph to highlight them here, then drag them into a folder.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul>{folders.filter((f) => !f.parent || !folders.some((x) => x.id === f.parent)).map((f) => folderRow(f, 0))}</ul>
        <div {...dropProps(null)} className={`mt-2 rounded border border-dashed px-1 py-1 ${dragOver === "__root" ? "border-ocean bg-ocean/10" : "border-transparent"}`}>
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Not in a folder · {loose.length}</div>
          <ul>{loose.map((n) => nodeRow(n, 0))}</ul>
        </div>
      </div>
    </Panel>
  );
}
