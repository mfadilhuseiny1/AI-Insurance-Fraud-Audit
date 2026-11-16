"use client";

import { ItemMarkingsPanel } from "./auth/ItemMarkings";
import { CompassMetaRows, FolderReadme } from "./security/CompassMeta";
import { ProjectRolesPanel } from "./auth/ProjectRoles";
import { MoveProjectDialog, NewProjectDialog, ProjectGovernancePanel } from "./security/ProjectGovernance";
import { useAuth } from "./AuthGate";
import { governance } from "@/lib/governanceModel";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  driveContentUrl,
  driveZipUrl,
  isContainer,
  shareLinkUrl,
  uploadDriveFile,
  type DriveItem,
  type DriveShare,
  type DriveUsage,
  type SharedItem,
} from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { FolderPicker, Preview, ShareDialog } from "./drive/dialogs";
import { NewMediaSetDialog } from "./media/NewMediaSetDialog";
import { DatasetMaintenance } from "./drive/DatasetMaintenance";
import {
  buttonClass,
  Checkbox,
  DefaultBadge,
  folderHref,
  iconColor,
  iconFor,
  Menu,
  MenuDivider,
  MenuItem,
  NameInput,
  PointMenu,
  previewable,
  typeLabel,
} from "./drive/ui";
import { Icon, type IconName } from "./Icon";
import { isPipelineFile } from "@/lib/pipelineFiles";
import { datasetHref, datasetPreview } from "@/lib/datasetPreview";
import { ApiError, Loading } from "./States";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { codeWorkspaces } from "@/lib/codeWorkspaces";
import { containers } from "@/lib/containers";
import { driveImport, extensionOf, isSpreadsheet, spreadsheetHref } from "@/lib/driveImport";
import { UploadDialog, type UploadPlan } from "./drive/UploadDialog";
import { NewMenu } from "./drive/NewMenu";

/** Which list the Files & Projects tab shows: a folder (or the top level), or a cross-folder view. */
export type DriveView = "folder" | "starred" | "recent" | "shared" | "trash";

/** dataTransfer type for items dragged inside the list (vs. files dragged in from the OS) */
const ITEM_DRAG = "application/x-bluesandai-drive-items";
/** Parquet opens as a table in the Preview dialog (its first rows) rather than downloading */
const PREVIEW = { tables: true };
const TABLE_PREVIEW_ROWS = 200; // what DataPreview shows
const readTable = (item: SharedItem) => api.pipelineData.table(item.id, TABLE_PREVIEW_ROWS);
const TRASH_DAYS = 30; // keep in sync with api/drive.py

type SortKey = "name" | "updated" | "size";
type Upload = { key: number; name: string; progress: number; error?: string; done?: boolean };
type Dialog = { type: "move" | "copyTo" | "share" | "mediaSet" | "space"; items: DriveItem[] } | null;
let uploadCount = 0;

// projects, then folders, then files
const KIND_ORDER = { project: 0, folder: 1, file: 2 } as const;

const VIEWS: { view: DriveView; href: string; label: string; icon: IconName }[] = [
  { view: "folder", href: "/files", label: "Files & Projects", icon: "folder" },
  { view: "starred", href: "/files/starred", label: "Starred", icon: "star" },
  { view: "recent", href: "/files/recent", label: "Recent", icon: "clock" },
  { view: "shared", href: "/files/shared", label: "Shared links", icon: "link" },
  { view: "trash", href: "/files/trash", label: "Trash", icon: "trash" },
];

export function Drive({ view = "folder", folderId = null }: { view?: DriveView; folderId?: string | null }) {
  const router = useRouter();
  const [listing, setListing] = useState<{ folder: DriveItem | null; items: DriveItem[] } | null>(null);
  const [shares, setShares] = useState<DriveShare[] | null>(null);
  const [error, setError] = useState<{ message: string; offline: boolean } | null>(null);
  const [usage, setUsage] = useState<DriveUsage | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ q: string; items: DriveItem[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [creating, setCreating] = useState<false | "folder" | "project">(false);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>(
    view === "recent" || view === "trash" ? { key: "updated", asc: false } : { key: "name", asc: true },
  );
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder id, "root" or "here"
  const [newMenu, setNewMenu] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [pointMenu, setPointMenu] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // bumped when a Project moves to another space: the details panel reloads its governance
  const [moves, setMoves] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  // the "Upload files" dialog (how to store them), for files picked or dropped into a folder
  const [uploadDialog, setUploadDialog] = useState<{ files: File[]; parentId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);

  const isFolderView = view === "folder";
  const q = query.trim();
  const searching = q.length > 0;

  // -- loading --

  const loadUsage = useCallback(() => {
    api.drive.usage().then(setUsage).catch(() => {});
  }, []);

  const load = useCallback(() => {
    const done = () => setError(null);
    const fail = (e: Error) => setError({ message: e.message, offline: e instanceof TypeError });
    loadUsage();
    if (view === "shared") return api.drive.shares().then((s) => (setShares(s), done())).catch(fail);
    const req =
      view === "folder"
        ? api.drive.folder(folderId)
        : (view === "starred" ? api.drive.starred() : view === "recent" ? api.drive.recent() : api.drive.trashList()).then(
            (items) => ({ folder: null, items }),
          );
    return req.then((d) => (setListing(d), done())).catch(fail);
  }, [view, folderId, loadUsage]);

  useEffect(() => {
    load();
  }, [load]);

  // search the whole drive as the user types
  useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => {
      api.drive
        .search(q)
        .then((items) => setResults({ q, items }))
        .catch(() => setResults({ q, items: [] }));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const reloadSearch = () => q && api.drive.search(q).then((items) => setResults({ q, items }));
  const reload = () => {
    load();
    reloadSearch();
  };

  // -- what is shown --

  const source: DriveItem[] | null = searching ? (results?.q === q ? results.items : null) : (listing?.items ?? null);
  const crossFolder = searching || !isFolderView;
  const inTrash = view === "trash" && !searching;

  const items = useMemo(() => {
    if (!source) return [];
    const dir = sort.asc ? 1 : -1;
    const stamp = (i: DriveItem) => (inTrash ? (i.trashed_at ?? "") : i.updated_at);
    return [...source].sort((a, b) => {
      if (isFolderView && !searching && a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (sort.key === "updated") return dir * stamp(a).localeCompare(stamp(b));
      if (sort.key === "size") return dir * (a.size - b.size);
      return dir * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [source, sort, isFolderView, searching, inTrash]);

  const selection = items.filter((i) => checked.has(i.id));
  const single = selection.length === 1 ? selection[0] : null;
  const allChecked = items.length > 0 && selection.length === items.length;
  const files = items.filter((i) => i.kind === "file");
  const folderPath = listing?.folder
    ? [...(listing.folder.path ?? []), { id: listing.folder.id, name: listing.folder.name }]
    : [];
  const locationOf = (item: DriveItem) => item.path ?? (isFolderView ? folderPath : []);

  // what the selection allows
  const hasDefault = selection.some((i) => i.default);
  const hasProject = selection.some((i) => i.kind === "project");
  // a Project moves to another space (administrators), one at a time
  const { me, enabled: authOn } = useAuth();
  const moveSpace = hasProject && selection.length === 1 && (!authOn || me?.role === "admin");  const allStarred = selection.length > 0 && selection.every((i) => i.starred);

  // -- selection --

  const selectOnly = (id: string) => {
    setChecked(new Set([id]));
    setAnchor(id);
  };
  const toggle = (id: string, on: boolean) => {
    setChecked((c) => {
      const next = new Set(c);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setAnchor(id);
  };
  const clickRow = (item: DriveItem, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const ids = items.map((i) => i.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(item.id)].sort((x, y) => x - y);
      if (a >= 0) {
        setChecked(new Set(ids.slice(a, b + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) toggle(item.id, !checked.has(item.id));
    else selectOnly(item.id);
  };
  const clearSelection = () => {
    setChecked(new Set());
    setAnchor(null);
  };

  // -- actions --

  const fail = (e: unknown) => void alertDialog((e as Error).message);

  /** Run an action on each item; report failures together, then refresh. */
  const runEach = async (list: DriveItem[], fn: (item: DriveItem) => Promise<unknown>, clear = true) => {
    setBusy(true);
    const errors: string[] = [];
    for (const item of list) {
      try {
        await fn(item);
      } catch (e) {
        errors.push(`${item.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (clear) clearSelection();
    reload();
    if (errors.length) void alertDialog(errors.join("\n"));
  };

  const upload = async (
    picked: File[],
    parentId: string | null,
    withPaths = false,
    send?: (file: File, onProgress: (p: number) => void) => Promise<unknown>,
  ) => {
    const batch = picked.map((f) => ({ key: ++uploadCount, name: withPaths ? f.webkitRelativePath : f.name, progress: 0 }));
    setUploads((u) => [...u, ...batch]);
    const patch = (key: number, change: Partial<Upload>) =>
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...change } : x)));
    // three at a time: enough to fill the pipe without starving the API
    let next = 0;
    const worker = async () => {
      while (next < picked.length) {
        const i = next++;
        try {
          const onProgress = (p: number) => patch(batch[i].key, { progress: p });
          if (send) await send(picked[i], onProgress);
          else await uploadDriveFile(picked[i], parentId, onProgress, withPaths ? picked[i].webkitRelativePath : undefined);
          patch(batch[i].key, { progress: 1, done: true });
        } catch (e) {
          patch(batch[i].key, { error: (e as Error).message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    reload();
    // finished uploads disappear after a moment; failed ones stay until dismissed
    setTimeout(() => setUploads((u) => u.filter((x) => !(x.done && batch.some((b) => b.key === x.key)))), 2500);
  };

  /** Store files the way the Upload files dialog chose: datasets, spreadsheets, a media set, an unstructured dataset or raw files. */
  const runUpload = async (plan: UploadPlan, parentId: string | null) => {
    setUploadDialog(null);
    try {
      if (plan.mode === "dataset") return await upload(plan.files, parentId, false, (f, p) => driveImport.dataset(f, parentId, plan.sheets, p));
      if (plan.mode === "spreadsheet") return await upload(plan.files, parentId, false, (f, p) => driveImport.spreadsheet(f, parentId, p));
      if (plan.mode === "mediaSet") {
        const ms = await driveImport.newMediaSet(plan.name, parentId, plan.files.map((f) => extensionOf(f.name)));
        await upload(plan.files, parentId, false, (f, p) => driveImport.mediaSetFile(ms.id, f, p));
        return selectOnly(ms.id);
      }
      if (plan.mode === "unstructured") {
        const ds = await driveImport.newUnstructured(plan.name, parentId);
        await upload(plan.files, parentId, false, (f, p) => driveImport.unstructuredFile(ds.id, f, p));
        return selectOnly(ds.id);
      }
      return await upload(plan.files, parentId);
    } catch (e) {
      fail(e);
    }
  };

  const uploadDestination = (parentId: string | null) => {
    if (parentId === null) return "Files & Projects";
    if (parentId === folderId) return pathLabel(folderPath);
    const target = (source ?? []).find((i) => i.id === parentId);
    return pathLabel(target ? [...folderPath, target] : folderPath);
  };

  const createFolder = async (name: string) => {
    const kind = creating || "folder";
    setCreating(false);
    if (!name.trim()) return;
    try {
      // Projects go through the governance API: the Default space, the creator as Owner, the security settings' default role
      const folder = kind === "project" ? await governance.createProject({ name }) : await api.drive.createFolder(name, folderId, kind);
      await load();
      selectOnly(folder.id);
    } catch (e) {
      fail(e);
    }
  };

  const rename = async (item: DriveItem, name: string) => {
    setRenamingId(null);
    if (!name.trim() || name === item.name) return;
    try {
      await api.drive.update(item.id, { name });
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const moveIds = async (ids: string[], target: string | null) => {
    const list = (source ?? []).filter((i) => ids.includes(i.id) && i.id !== target);
    if (list.length) await runEach(list, (i) => api.drive.update(i.id, { moveTo: target }));
  };

  const trash = (list: DriveItem[]) => {
    if (list.some((i) => i.default)) return void alertDialog("Default items cannot be deleted.");
    runEach(list, (i) => api.drive.trash(i.id));
  };

  const deleteForever = async (list: DriveItem[]) => {
    const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} items`;
    if (!(await confirmDialog(`Delete ${what} forever? This cannot be undone.`))) return;
    runEach(list, (i) => api.drive.remove(i.id));
  };

  const emptyTrash = async () => {
    if (!(await confirmDialog("Delete everything in the trash forever? This cannot be undone."))) return;
    try {
      await api.drive.emptyTrash();
      clearSelection();
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const download = (list: DriveItem[]) => {
    if (!list.length) return;
    const one = list.length === 1 && list[0].kind === "file";
    window.location.assign(one ? driveContentUrl(list[0].id) : driveZipUrl(list.map((i) => i.id)));
  };

  const newWebLink = async () => {
    if (!isFolderView || !folderId) return;
    const url = (await promptDialog("Web address", "https://", { title: "New web link", placeholder: "https://example.com" }))?.trim();
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url)) return fail(new Error("A web link starts with http:// or https://"));
    const name = (await promptDialog("Name of the link", url.replace(/^https?:\/\//i, "").split("/")[0], { title: "New web link" }))?.trim();
    if (!name) return;
    try {
      const file = new File([`[InternetShortcut]\r\nURL=${url}\r\n`], `${name.replace(/\.url$/i, "")}.url`, { type: "application/internet-shortcut" });
      await uploadDriveFile(file, folderId, () => {});
      reload();
    } catch (e) {
      fail(e);
    }
  };

  const open = (item: DriveItem) => {
    // a web link (.url Internet Shortcut): the page it points to, in a new tab
    if (item.kind === "file" && /\.url$/i.test(item.name)) {
      fetch(driveContentUrl(item.id), { credentials: "include" })
        .then((r) => r.text())
        .then((t) => {
          const url = /^URL=(.+)$/im.exec(t)?.[1]?.trim();
          if (url && /^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
          else download([item]);
        }, () => download([item]));
      return;
    }
    if (isContainer(item)) return router.push(folderHref(item.id));
    if (isPipelineFile(item)) return router.push(`/pipeline/${item.id}`);
    if (item.content_type === "application/vnd.apache.iceberg+json") return router.push(datasetHref(item.id));
    // structured datasets open in Dataset Preview, spreadsheets in the spreadsheet viewer (drive_import.py)
    if (item.content_type === "application/vnd.apache.parquet") return router.push(datasetHref(item.id));
    if (isSpreadsheet(item)) return router.push(spreadsheetHref(item.id));
    // SQL Studio worksheets saved into a project (api/sql_studio.py)
    if (item.content_type === "application/vnd.bluesandai.sql-worksheet+json") return router.push(`/sql-studio?item=${item.id}`);
    // Docker Artifacts repositories (api/container_registry.py)
    if (item.content_type === "application/vnd.bluesandai.artifacts-repository+json") return router.push(`/artifact-repositories?item=${item.id}`);
    if (item.content_type === "application/vnd.bluesandai.logic-flow+json") return router.push(`/logic-flows?flow=${item.id}`);
    // models trained in Python transforms (api/model_assets.py)
    if (item.content_type === "application/vnd.bluesandai.model+json") return router.push(`/model-assets?item=${item.id}`);
    if (item.content_type === "application/vnd.bluesandai.code-workspace+json") return router.push(`/code-workspaces?item=${item.id}`);
    if (item.content_type === "application/vnd.bluesandai.preparation+json") return router.push(`/preparation/${item.id}`);
    // Workshop modules and Slate applications are Files items: their home resolves the item to the module / application
    if (item.content_type === "application/vnd.bluesandai.workshop+json") return router.push(`/workshop?item=${item.id}`);
    if (item.content_type === "application/vnd.bluesandai.slate+json") return router.push(`/slate?item=${item.id}`);
    // analytics documents open in their application
    const app = APP_DOCUMENTS[item.content_type ?? ""];
    if (app) return router.push(`${app}/${item.id}`);
    const i = files.findIndex((f) => f.id === item.id);
    if (previewable(item, PREVIEW) && i >= 0) setPreview(i);
    else download([item]);
  };

  const showLocation = (item: DriveItem) => {
    router.push(folderHref(item.parent_id));
  };

  // -- keyboard: Ctrl+A, Delete, F2, Enter, Escape --

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || dialog || uploadDialog || preview !== null) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && items.length) {
        e.preventDefault();
        setChecked(new Set(items.map((i) => i.id)));
      } else if (e.key === "Escape") clearSelection();
      else if (e.key === "Delete" && selection.length) (inTrash ? deleteForever : trash)(selection);
      else if (e.key === "F2" && single && !single.default && !inTrash) {
        e.preventDefault();
        setRenamingId(single.id);
      } else if (e.key === "Enter" && single && !inTrash) open(single);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  // -- drag and drop: OS files upload, list items move --

  const dragItems = (item: DriveItem) => (checked.has(item.id) ? selection : [item]).filter((i) => !i.default && i.kind !== "project");

  const dropProps = (target: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      if (!types.includes(ITEM_DRAG) && !types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = types.includes(ITEM_DRAG) ? "move" : "copy";
      setDropTarget(key);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === key ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const dragged = e.dataTransfer.getData(ITEM_DRAG);
      if (dragged) moveIds(JSON.parse(dragged) as string[], target);
      else if (e.dataTransfer.files.length) setUploadDialog({ files: Array.from(e.dataTransfer.files), parentId: target });
    },
  });

  if (error?.offline) return <ApiError message={error.message} />;

  // -- the actions offered for the current selection (toolbar, right-click and ⋯ menus) --

  type Action = { icon: IconName; label: string; run: () => void; danger?: boolean; shortcut?: string; divider?: boolean };
  const actionsFor = (list: DriveItem[]): Action[] => {
    if (!list.length) return [];
    const one = list.length === 1 ? list[0] : null;
    if (inTrash)
      return [
        { icon: "restore", label: "Restore", run: () => runEach(list, (i) => api.drive.restore(i.id)) },
        { icon: "trash", label: "Delete forever", danger: true, shortcut: "Del", run: () => deleteForever(list) },
      ];
    const def = list.some((i) => i.default);
    const out: Action[] = [];
    if (one) out.push({ icon: isContainer(one) ? iconFor(one) : "eye", label: isContainer(one) ? "Open" : "Preview", shortcut: "Enter", run: () => open(one) });
    if (one && crossFolder) out.push({ icon: "folder", label: "Show file location", run: () => showLocation(one) });
    if (one?.media_set) out.push({ icon: "image", label: "Open media set", run: () => router.push(`/media-sets/${one.id}`) });
    else if (one?.kind === "folder" && !one.default) out.push({ icon: "image", label: "Make media set…", run: () => setDialog({ type: "mediaSet", items: [one] }) });
    out.push({ icon: "download", label: list.length > 1 || (one && isContainer(one)) ? "Download as zip" : "Download", run: () => download(list) });
    if (one) out.push({ icon: "link", label: "Share…", run: () => setDialog({ type: "share", items: [one] }), divider: true });
    if (one && !def) out.push({ icon: "pencil", label: "Rename", shortcut: "F2", run: () => setRenamingId(one.id), divider: !one });
    if (!def && !list.some((i) => i.kind === "project"))
      out.push({ icon: "move", label: "Move to…", run: () => setDialog({ type: "move", items: list }) });
    if (!list.some((i) => i.kind === "project")) {
      out.push({ icon: "copy", label: "Make a copy", run: () => runEach(list, (i) => api.drive.copy(i.id), false) });
      out.push({ icon: "folderPlus", label: "Copy to…", run: () => setDialog({ type: "copyTo", items: list }) });
    }
    const starred = list.every((i) => i.starred);
    out.push({
      icon: "star",
      label: starred ? "Remove from Starred" : "Add to Starred",
      run: () => runEach(list, (i) => api.drive.star(i.id, !starred), false),
      divider: true,
    });
    if (!def) out.push({ icon: "trash", label: "Move to trash", danger: true, shortcut: "Del", run: () => trash(list), divider: true });
    return out;
  };

  const renderActions = (list: DriveItem[], close: () => void) =>
    actionsFor(list).map((a, i) => (
      <div key={a.label}>
        {a.divider && i > 0 && <MenuDivider />}
        <MenuItem
          icon={a.icon}
          label={a.label}
          shortcut={a.shortcut}
          danger={a.danger}
          onClick={() => {
            close();
            a.run();
          }}
        />
      </div>
    ));

  const title = searching
    ? `Search results for “${q}”`
    : (VIEWS.find((v) => v.view === view)?.label ?? "Files & Projects");

  return (
    <div className="flex min-h-0 flex-1">
      {/* -- left: New, views, storage -- */}
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel/60 p-3 text-sm">
        <div className="relative mb-3">
          <button
            type="button"
            onClick={() => setNewMenu((m) => !m)}
            // keep the menu's outside-click handler from closing it just before this toggles it
            onMouseDown={(e) => e.stopPropagation()}
            className="flex w-full items-center gap-2 rounded-xl bg-ocean px-4 py-2.5 font-medium text-white shadow-lg shadow-ocean/20 hover:bg-ocean-deep"
          >
            <Icon name="plus" className="h-5 w-5" /> New
          </button>
          {newMenu && (
            <NewMenu
              folderId={isFolderView ? folderId : null}
              folderName={folderPath.at(-1)?.name ?? "Files & Projects"}
              projectId={folderPath[0]?.id ?? null}
              atRoot={isFolderView && folderId === null}
              onClose={() => setNewMenu(false)}
              onProject={() => {
                setQuery("");
                setCreating("project");
              }}
              onProjectInSpace={() => setNewProject(true)}
              onFolder={() => {
                setQuery("");
                setCreating("folder");
              }}
              onMediaSet={() => setDialog({ type: "mediaSet", items: [] })}
              onWebLink={newWebLink}
              onUploadFiles={() => setUploadDialog({ files: [], parentId: isFolderView ? folderId : null })}
              onUploadFolder={() => folderInput.current?.click()}
              onError={fail}
              canRunCode={me?.can_run_code !== false}
            />
          )}
          <input
            ref={folderInput}
            type="file"
            hidden
            {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => {
              if (e.target.files?.length) upload(Array.from(e.target.files), isFolderView ? folderId : null, true);
              e.target.value = "";
            }}
          />
        </div>

        {VIEWS.map((v) => {
          const active = v.view === view && !searching;
          return (
            <Link
              key={v.view}
              href={v.href}
              onClick={() => setQuery("")}
              {...(v.view === "folder" ? dropProps(null, "nav-root") : {})}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 ${
                active ? "bg-ocean/15 font-medium text-white" : "text-soft hover:bg-panel-2 hover:text-white"
              } ${dropTarget === "nav-root" && v.view === "folder" ? "ring-1 ring-ocean" : ""}`}
            >
              <Icon name={v.icon} className={`h-4 w-4 ${active ? "text-ocean" : "text-muted"}`} />
              <span className="flex-1">{v.label}</span>
              {v.view === "trash" && !!usage?.trash_items && (
                <span className="text-[11px] tabular-nums text-muted">{usage.trash_items}</span>
              )}
            </Link>
          );
        })}

        {usage && (
          <div className="mt-auto rounded-lg border border-line bg-panel-2 p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-soft">
              <Icon name="database" className="h-3.5 w-3.5 text-muted" /> Storage
            </div>
            <div className="text-base font-semibold tabular-nums">{bytes(usage.bytes)}</div>
            <div className="text-muted">
              {usage.files.toLocaleString()} files · {usage.folders.toLocaleString()} folders
            </div>
            {usage.trash_bytes > 0 && <div className="mt-1 text-muted">{bytes(usage.trash_bytes)} in trash</div>}
          </div>
        )}
      </nav>

      {/* -- middle: header, toolbar, list -- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
          {isFolderView && !searching ? (
            // breadcrumbs; each crumb is also a drop target for moving items up
            <nav className="flex min-w-0 flex-1 items-center gap-1">
              <Link
                href="/files"
                {...dropProps(null, "root")}
                className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 hover:bg-panel-2 ${
                  dropTarget === "root" ? "bg-ocean/20 ring-1 ring-ocean" : ""
                } ${folderPath.length ? "text-soft" : "font-medium"}`}
              >
                <Icon name="folder" className="h-4 w-4 text-sand" /> Files &amp; Projects
              </Link>
              {folderPath.map((p, i) => (
                <span key={p.id} className="flex min-w-0 items-center gap-1">
                  <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <Link
                    href={folderHref(p.id)}
                    {...dropProps(p.id, p.id)}
                    className={`truncate rounded px-1.5 py-1 hover:bg-panel-2 ${
                      dropTarget === p.id ? "bg-ocean/20 ring-1 ring-ocean" : ""
                    } ${i === folderPath.length - 1 ? "font-medium" : "text-soft"}`}
                    title={p.name}
                  >
                    {p.name}
                  </Link>
                </span>
              ))}
            </nav>
          ) : (
            <h1 className="flex min-w-0 flex-1 items-center gap-2 font-medium">
              <Icon name={searching ? "search" : (VIEWS.find((v) => v.view === view)?.icon ?? "folder")} className="h-4 w-4 text-muted" />
              <span className="truncate">{title}</span>
            </h1>
          )}

          <label className="flex w-72 items-center gap-2 rounded-lg border border-line bg-ink px-3 py-1.5 focus-within:border-ocean">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                clearSelection();
              }}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search in Files & Projects"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="text-muted hover:text-white" title="Clear search">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            )}
          </label>

          {view !== "shared" && (
            <div className="flex overflow-hidden rounded-md border border-line">
              {(["list", "grid"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLayout(l)}
                  title={l === "list" ? "List view" : "Grid view"}
                  className={`p-1.5 ${layout === l ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
                >
                  <Icon name={l} className="h-4 w-4" />
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            title={showDetails ? "Hide details" : "Show details"}
            className={`rounded-md p-1.5 ${showDetails ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
          >
            <Icon name="info" className="h-4 w-4" />
          </button>
        </header>

        {/* selection toolbar (Google Drive style), or view notes */}
        {view !== "shared" && (
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-4 text-sm">
            {selection.length ? (
              <>
                <button type="button" onClick={clearSelection} className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white" title="Clear selection (Esc)">
                  <Icon name="x" />
                </button>
                <span className="mr-3 font-medium tabular-nums">{selection.length} selected</span>
                {inTrash ? (
                  <>
                    <ToolButton icon="restore" label="Restore" onClick={() => runEach(selection, (i) => api.drive.restore(i.id))} disabled={busy} />
                    <ToolButton icon="trash" label="Delete forever" danger onClick={() => deleteForever(selection)} disabled={busy} />
                  </>
                ) : (
                  <>
                    <ToolButton icon="download" label="Download" onClick={() => download(selection)} />
                    <ToolButton icon="link" label="Share" onClick={() => single && setDialog({ type: "share", items: [single] })} disabled={!single} title={single ? undefined : "Share one item at a time"} />
                    <ToolButton
                      icon="move"
                      label="Move"
                      onClick={() => setDialog({ type: moveSpace ? "space" : "move", items: selection })}
                      disabled={busy || hasDefault || (hasProject && !moveSpace)}
                      title={hasProject && !moveSpace ? "Administrators move Projects to another space, one at a time" : undefined}
                    />
                    <ToolButton icon="copy" label="Copy" onClick={() => runEach(selection, (i) => api.drive.copy(i.id), false)} disabled={busy || hasProject} />
                    <ToolButton icon="star" label={allStarred ? "Unstar" : "Star"} onClick={() => runEach(selection, (i) => api.drive.star(i.id, !allStarred), false)} disabled={busy} active={allStarred} />
                    <ToolButton icon="trash" label="Trash" danger onClick={() => trash(selection)} disabled={busy || hasDefault} title={hasDefault ? "Default items cannot be deleted" : undefined} />
                  </>
                )}
                {busy && <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />}
              </>
            ) : inTrash ? (
              <>
                <span className="flex-1 text-xs text-muted">
                  Items in the trash are deleted forever after {TRASH_DAYS} days. Restoring puts them back where they were.
                </span>
                <button type="button" onClick={emptyTrash} disabled={!items.length} className={`${buttonClass.ghost} text-bad`}>
                  Empty trash
                </button>
              </>
            ) : (
              <span className="text-xs text-muted">
                {source ? `${items.length} item${items.length === 1 ? "" : "s"}` : ""}
                {items.length > 0 && " · click to select, Ctrl/Shift+click for more, right-click for actions"}
              </span>
            )}
          </div>
        )}

        {/* the list area accepts files dropped from the OS (into this folder, or the top level) */}
        <div
          {...(isFolderView && !searching ? dropProps(folderId, "here") : {})}
          onClick={clearSelection}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) e.preventDefault();
          }}
          className={`relative min-h-0 flex-1 overflow-y-auto p-5 ${
            dropTarget === "here" ? "bg-ocean/5 outline-2 -outline-offset-8 outline-dashed outline-ocean/60" : ""
          }`}
        >
          {view === "folder" && folderId && !searching && !error && <FolderReadme key={folderId} folderId={folderId} />}
          {error ? (
            <div className="py-20 text-center text-sm">
              <div className="mb-2 text-bad">{error.message}</div>
              <Link href="/files" className="text-ocean hover:underline">
                Back to Files &amp; Projects
              </Link>
            </div>
          ) : view === "shared" && !searching ? (
            <SharesTable shares={shares} onChange={load} onOpen={(s) => api.drive.item(s.item_id).then((i) => router.push(folderHref(isContainer(i) ? i.id : i.parent_id))).catch(fail)} />
          ) : !source ? (
            <Loading />
          ) : items.length === 0 && !creating ? (
            <EmptyState view={searching ? "search" : view} query={q} />
          ) : layout === "grid" ? (
            <div onClick={(e) => e.stopPropagation()} className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
              {creating && (
                <div className="col-span-full flex items-center gap-2.5 rounded-xl border border-ocean bg-ocean/10 px-3 py-2">
                  <Icon name={creating} className="h-4 w-4 text-sand" />
                  <NameInput initial={creating === "project" ? "New project" : "New folder"} onDone={createFolder} onCancel={() => setCreating(false)} />
                </div>
              )}
              {items.map((item) => (
                <GridCard
                  key={item.id}
                  item={item}
                  checked={checked.has(item.id)}
                  anyChecked={selection.length > 0}
                  renaming={renamingId === item.id}
                  dropActive={dropTarget === item.id}
                  inTrash={inTrash}
                  rowProps={{
                    draggable: !inTrash && renamingId !== item.id && !item.default && item.kind !== "project",
                    onDragStart: (e: React.DragEvent) => {
                      e.dataTransfer.setData(ITEM_DRAG, JSON.stringify(dragItems(item).map((i) => i.id)));
                      e.dataTransfer.effectAllowed = "move";
                    },
                    ...(isContainer(item) && !inTrash ? dropProps(item.id, item.id) : {}),
                    onClick: (e: React.MouseEvent) => clickRow(item, e),
                    onDoubleClick: () => !inTrash && open(item),
                    onContextMenu: (e: React.MouseEvent) => {
                      e.preventDefault();
                      if (!checked.has(item.id)) selectOnly(item.id);
                      setPointMenu({ x: e.clientX, y: e.clientY });
                    },
                  }}
                  onToggle={(on) => toggle(item.id, on)}
                  onRename={(name) => rename(item, name)}
                  onCancelRename={() => setRenamingId(null)}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line" onClick={(e) => e.stopPropagation()}>
              <table className="w-full table-fixed text-sm">
                <thead className="bg-panel text-left text-xs text-muted">
                  <tr>
                    <th className="w-11 pl-4">
                      <Checkbox
                        checked={allChecked}
                        indeterminate={selection.length > 0 && !allChecked}
                        onChange={(on) => (on ? setChecked(new Set(items.map((i) => i.id))) : clearSelection())}
                        label={allChecked ? "Select none" : "Select all"}
                      />
                    </th>
                    <SortHeader label="Name" k="name" sort={sort} setSort={setSort} />
                    {crossFolder && <th className="w-56 px-3 py-2.5 font-medium uppercase tracking-wide">{inTrash ? "Original location" : "Location"}</th>}
                    <SortHeader label={inTrash ? "Trashed" : "Last updated"} k="updated" sort={sort} setSort={setSort} className="w-44" />
                    <SortHeader label="Size" k="size" sort={sort} setSort={setSort} className="w-28" />
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {creating && (
                    <tr className="border-t border-line bg-ocean/10">
                      <td />
                      <td className="px-3 py-2" colSpan={crossFolder ? 5 : 4}>
                        <div className="flex items-center gap-2.5">
                          <Icon name={creating} className="h-4 w-4 shrink-0 text-sand" />
                          <NameInput initial={creating === "project" ? "New project" : "New folder"} onDone={createFolder} onCancel={() => setCreating(false)} />
                        </div>
                      </td>
                    </tr>
                  )}
                  {items.map((item) => {
                    const container = isContainer(item);
                    const isChecked = checked.has(item.id);
                    const location = locationOf(item);
                    return (
                      <tr
                        key={item.id}
                        // the default items stay put, and projects stay at the top level
                        draggable={!inTrash && renamingId !== item.id && !item.default && item.kind !== "project"}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(ITEM_DRAG, JSON.stringify(dragItems(item).map((i) => i.id)));
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        {...(container && !inTrash ? dropProps(item.id, item.id) : {})}
                        onClick={(e) => clickRow(item, e)}
                        onDoubleClick={() => !inTrash && open(item)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!isChecked) selectOnly(item.id);
                          setPointMenu({ x: e.clientX, y: e.clientY });
                        }}
                        className={`group cursor-default select-none border-t border-line ${
                          dropTarget === item.id
                            ? "bg-ocean/20 outline-1 -outline-offset-1 outline-ocean"
                            : isChecked
                              ? "bg-ocean/15"
                              : "hover:bg-panel/60"
                        }`}
                      >
                        <td className="pl-4">
                          <Checkbox
                            checked={isChecked}
                            onChange={(on) => toggle(item.id, on)}
                            label={`Select ${item.name}`}
                            className={isChecked || selection.length ? "" : "opacity-40 group-hover:opacity-100"}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Icon name={iconFor(item)} className={`h-4 w-4 shrink-0 ${iconColor(item)}`} />
                            {renamingId === item.id ? (
                              <NameInput initial={item.name} onDone={(name) => rename(item, name)} onCancel={() => setRenamingId(null)} />
                            ) : container && !inTrash ? (
                              <Link
                                href={folderHref(item.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="truncate hover:text-ocean hover:underline"
                                title={item.name}
                              >
                                {item.name}
                              </Link>
                            ) : (
                              <span className="truncate" title={item.name}>
                                {item.name}
                              </span>
                            )}
                            {item.starred && <Icon name="star" className="h-3.5 w-3.5 shrink-0 fill-sand text-sand" />}
                            {item.default && <DefaultBadge />}
                            {item.media_set && (
                              <Link
                                href={`/media-sets/${item.id}`}
                                onClick={(e) => e.stopPropagation()}
                                title="Open in the Media sets app"
                                className="shrink-0 rounded bg-ocean/15 px-1.5 text-[10px] text-ocean hover:bg-ocean/25"
                              >
                                media set · {item.media_set}
                              </Link>
                            )}
                          </div>
                        </td>
                        {crossFolder && (
                          <td className="px-3 py-2">
                            {inTrash ? (
                              <span className="block truncate text-soft" title={pathLabel(location)}>
                                {pathLabel(location)}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  showLocation(item);
                                }}
                                className="flex max-w-full items-center gap-1.5 truncate text-soft hover:text-ocean"
                                title={pathLabel(location)}
                              >
                                <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted" />
                                <span className="truncate">{location.length ? location[location.length - 1].name : "Files & Projects"}</span>
                              </button>
                            )}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-3 py-2 text-soft">{when(inTrash ? (item.trashed_at ?? item.updated_at) : item.updated_at)}</td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-soft">
                          {container ? `${item.items ?? 0} item${item.items === 1 ? "" : "s"}` : bytes(item.size)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <RowMenu
                            onOpenMenu={() => {
                              if (!isChecked) selectOnly(item.id);
                            }}
                          >
                            {(close) => renderActions(isChecked ? selection : [item], close)}
                          </RowMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* -- right: details -- */}
      {showDetails && view !== "shared" && (
        <Details
          moves={moves}
          key={single?.id ?? `n${selection.length}`}
          item={single}
          count={selection.length}
          totalSize={selection.reduce((n, i) => n + (i.kind === "file" ? i.size : 0), 0)}
          folder={!searching && isFolderView ? listing?.folder ?? null : null}
          location={single ? locationOf(single) : folderPath.slice(0, -1)}
          inTrash={inTrash}
          onClose={() => setShowDetails(false)}
          actions={single ? actionsFor([single]).slice(0, 4) : []}
          onShare={() => single && setDialog({ type: "share", items: [single] })}
          onStar={() => single && runEach([single], (i) => api.drive.star(i.id, !i.starred), false)}
        />
      )}

      {/* -- overlays -- */}
      {pointMenu && selection.length > 0 && (
        <PointMenu x={pointMenu.x} y={pointMenu.y} onClose={() => setPointMenu(null)}>
          {renderActions(selection, () => setPointMenu(null))}
        </PointMenu>
      )}

      {uploadDialog && (
        <UploadDialog
          initialFiles={uploadDialog.files}
          destination={uploadDestination(uploadDialog.parentId)}
          onClose={() => setUploadDialog(null)}
          onSubmit={(plan) => runUpload(plan, uploadDialog.parentId)}
        />
      )}
      {dialog?.type === "space" && <MoveProjectDialog project={dialog.items[0]} onClose={() => setDialog(null)} onMoved={() => (setDialog(null), setMoves((n) => n + 1), load())} />}
      {dialog?.type === "share" && <ShareDialog item={dialog.items[0]} onClose={() => (setDialog(null), loadUsage())} />}
      {newProject && <NewProjectDialog onClose={() => setNewProject(false)} onCreated={(id) => (setNewProject(false), load().then(() => selectOnly(id)))} />}
      {dialog?.type === "mediaSet" && (
        <NewMediaSetDialog
          parent={dialog.items.length ? undefined : listing?.folder ? { id: listing.folder.id, name: listing.folder.name } : undefined}
          folderToConvert={dialog.items[0] ? { id: dialog.items[0].id, name: dialog.items[0].name } : undefined}
          onClose={() => setDialog(null)}
          onCreated={(m) => router.push(`/media-sets/${m.id}`)}
        />
      )}
      {(dialog?.type === "move" || dialog?.type === "copyTo") && (
        <FolderPicker
          title={`${dialog.type === "move" ? "Move" : "Copy"} ${dialog.items.length === 1 ? `“${dialog.items[0].name}”` : `${dialog.items.length} items`}`}
          action={dialog.type === "move" ? "Move here" : "Copy here"}
          moving={dialog.items}
          startAt={isFolderView ? folderId : (dialog.items[0].parent_id ?? null)}
          onClose={() => setDialog(null)}
          onPick={(target) => {
            const list = dialog.items;
            const type = dialog.type;
            setDialog(null);
            if (type === "move") runEach(list, (i) => api.drive.update(i.id, { moveTo: target }));
            else runEach(list, (i) => api.drive.copy(i.id, target), false);
          }}
        />
      )}
      {preview !== null && files[preview] && (
        <Preview
          items={files}
          index={preview}
          onIndex={(i) => {
            setPreview(i);
            selectOnly(files[i].id);
          }}
          urlFor={(f) => driveContentUrl(f.id, true)}
          downloadUrlFor={(f) => driveContentUrl(f.id)}
          readTable={readTable}
          onClose={() => setPreview(null)}
        />
      )}

      {uploads.length > 0 && <UploadsPanel uploads={uploads} onClear={() => setUploads((u) => u.filter((x) => !x.done && !x.error))} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

/** What Dataset Preview opens: Parquet, CSV / TSV / JSON files, Iceberg tables, and folders (raw datasets of such files). */
/** Documents of the analytics applications (Files items by content type): the route that opens one by its item id. */
const APP_DOCUMENTS: Record<string, string> = {
  "application/vnd.bluesandai.fusion+json": "/fusion",
  "application/vnd.bluesandai.notepad+json": "/notepad",
  "application/vnd.bluesandai.contour+json": "/analytics",
  "application/vnd.bluesandai.code-workbook+json": "/code-workbook/workbooks",
  "application/vnd.bluesandai.report+json": "/reports",
  "application/vnd.bluesandai.form+json": "/forms",
  "application/vnd.bluesandai.quiver-dashboard+json": "/quiver/dashboards",
};

const opensAsDataset = (i: Pick<DriveItem, "kind" | "name" | "content_type">) =>
  i.kind === "folder" ||
  (i.kind === "file" &&
    !isPipelineFile(i) &&
    (i.content_type === "application/vnd.apache.parquet" || i.content_type === "application/vnd.apache.iceberg+json" || /\.(parquet|csv|tsv|json|jsonl|ndjson)$/i.test(i.name)));

const pathLabel = (path: { name: string }[]) => ["Files & Projects", ...path.map((p) => p.name)].join(" / ");

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  active,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-35 ${
        danger ? "text-bad hover:bg-bad/10" : "text-soft hover:bg-panel-2 hover:text-white"
      }`}
    >
      <Icon name={icon} className={`h-4 w-4 ${active ? "fill-sand text-sand" : ""}`} />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function SortHeader({
  label,
  k,
  sort,
  setSort,
  className = "",
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; asc: boolean };
  setSort: (s: { key: SortKey; asc: boolean }) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2.5 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => setSort({ key: k, asc: active ? !sort.asc : k === "name" })}
        className={`flex items-center gap-1 uppercase tracking-wide hover:text-white ${active ? "text-soft" : ""}`}
      >
        {label}
        {active && <Icon name="down" className={`h-3 w-3 ${sort.asc ? "rotate-180" : ""}`} />}
      </button>
    </th>
  );
}

function RowMenu({ onOpenMenu, children }: { onOpenMenu: () => void; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!open) onOpenMenu();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white ${
          open ? "bg-panel-2 text-white" : "opacity-0 group-hover:opacity-100"
        }`}
        title="Actions"
      >
        <Icon name="dots" />
      </button>
      {open && <Menu onClose={() => setOpen(false)}>{children(() => setOpen(false))}</Menu>}
    </div>
  );
}

function GridCard({
  item,
  checked,
  anyChecked,
  renaming,
  dropActive,
  inTrash,
  rowProps,
  onToggle,
  onRename,
  onCancelRename,
}: {
  item: DriveItem;
  checked: boolean;
  anyChecked: boolean;
  renaming: boolean;
  dropActive: boolean;
  inTrash: boolean;
  rowProps: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  onToggle: (on: boolean) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const container = isContainer(item);
  const image = item.kind === "file" && item.content_type?.startsWith("image/") && !inTrash;
  return (
    <div
      {...rowProps}
      className={`group relative flex cursor-default select-none flex-col overflow-hidden rounded-xl border ${
        dropActive ? "border-ocean bg-ocean/20" : checked ? "border-ocean/60 bg-ocean/15" : "border-line bg-panel hover:border-line-2"
      }`}
    >
      <div className="absolute left-2 top-2 z-10">
        <Checkbox
          checked={checked}
          onChange={onToggle}
          label={`Select ${item.name}`}
          className={checked || anyChecked ? "" : "opacity-0 group-hover:opacity-100"}
        />
      </div>
      {item.starred && <Icon name="star" className="absolute right-2 top-2 z-10 h-3.5 w-3.5 fill-sand text-sand" />}
      {!container && (
        <div className="flex h-28 items-center justify-center border-b border-line bg-ink/60">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={driveContentUrl(item.id, true)} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-1">
              <Icon name={iconFor(item)} className="h-9 w-9 text-ocean/70" />
              <span className="text-[10px] font-medium tracking-wide text-muted">{typeLabel(item)}</span>
            </span>
          )}
        </div>
      )}
      <div className={`flex items-center gap-2 px-3 py-2.5 ${container ? "pl-8" : ""}`}>
        {container && <Icon name={iconFor(item)} className={`h-4 w-4 shrink-0 ${iconColor(item)}`} />}
        {renaming ? (
          <NameInput initial={item.name} onDone={onRename} onCancel={onCancelRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>
            {item.name}
          </span>
        )}
        {item.default && <DefaultBadge />}
      </div>
    </div>
  );
}

function EmptyState({ view, query }: { view: DriveView | "search"; query: string }) {
  const text: Record<DriveView | "search", [IconName, string, string]> = {
    folder: ["folder", "This folder is empty.", "Drop files here, or use New to add a folder or upload files."],
    starred: ["star", "Nothing starred yet.", "Star files and folders you use often (right-click → Add to Starred)."],
    recent: ["clock", "No files yet.", "Files you upload or change show up here."],
    shared: ["link", "No shared links.", "Share an item to create a link."],
    trash: ["trash", "The trash is empty.", "Deleted items stay here for 30 days."],
    search: ["search", `Nothing matches “${query}”.`, "Search looks at names of files, folders and projects everywhere."],
  };
  const [icon, title, hint] = text[view];
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-sm text-muted">
      <Icon name={icon} className="mb-1 h-11 w-11 text-line-2" />
      <span className="text-soft">{title}</span>
      <span className="text-xs">{hint}</span>
    </div>
  );
}

function SharesTable({
  shares,
  onChange,
  onOpen,
}: {
  shares: DriveShare[] | null;
  onChange: () => void;
  onOpen: (share: DriveShare) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!shares) return <Loading />;
  if (!shares.length) return <EmptyState view="shared" query="" />;
  const copy = async (token: string) => {
    await navigator.clipboard.writeText(shareLinkUrl(token));
    setCopied(token);
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  };
  const revoke = async (s: DriveShare) => {
    if (!(await confirmDialog(`Turn off this link to “${s.name}”? People who have it will no longer be able to open it.`))) return;
    try {
      await api.drive.revokeShare(s.token);
      onChange();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line" onClick={(e) => e.stopPropagation()}>
      <table className="w-full table-fixed text-sm">
        <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">Shared item</th>
            <th className="w-80 px-3 py-2.5 font-medium">Link</th>
            <th className="w-36 px-3 py-2.5 font-medium">Created</th>
            <th className="w-36 px-3 py-2.5 font-medium">Expires</th>
            <th className="w-14" />
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => {
            const expired = s.expired;
            return (
              <tr key={s.token} className="border-t border-line hover:bg-panel/60">
                <td className="px-4 py-2">
                  <button type="button" onClick={() => onOpen(s)} className="flex max-w-full items-center gap-2.5 hover:text-ocean" title="Show in Files & Projects">
                    <Icon name={iconFor({ kind: s.kind ?? "file", content_type: null })} className={`h-4 w-4 shrink-0 ${iconColor({ kind: s.kind ?? "file" })}`} />
                    <span className="truncate">{s.name}</span>
                  </button>
                </td>
                <td className="px-3 py-2">
                  <button type="button" onClick={() => copy(s.token)} className="flex max-w-full items-center gap-1.5 text-soft hover:text-ocean" title="Copy link">
                    <Icon name={copied === s.token ? "check" : "copy"} className={`h-3.5 w-3.5 shrink-0 ${copied === s.token ? "text-ok" : "text-muted"}`} />
                    <span className="truncate font-mono text-xs">{shareLinkUrl(s.token)}</span>
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-soft">{when(s.created_at)}</td>
                <td className={`whitespace-nowrap px-3 py-2 ${expired ? "text-bad" : "text-soft"}`}>
                  {s.expires_at ? (expired ? "Expired" : when(s.expires_at)) : "Never"}
                </td>
                <td className="px-2 text-right">
                  <button type="button" onClick={() => revoke(s)} className="rounded p-1.5 text-muted hover:bg-bad/10 hover:text-bad" title="Turn off link">
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Details({
  item,
  count,
  totalSize,
  folder,
  location,
  inTrash,
  onClose,
  actions,
  onShare,
  onStar,
  moves = 0,
}: {
  item: DriveItem | null;
  count: number;
  totalSize: number;
  folder: DriveItem | null;
  location: { id: string; name: string }[];
  inTrash: boolean;
  onClose: () => void;
  actions: { icon: IconName; label: string; run: () => void }[];
  onShare: () => void;
  onStar: () => void;
  /** bumped when a Project moved to another space: its governance panel reloads */
  moves?: number;
}) {
  const [copied, setCopied] = useState(false);
  const [shareCount, setShareCount] = useState<number | null>(null);
  const shown = item ?? (count === 0 ? folder : null);

  useEffect(() => {
    if (!item || inTrash) return;
    api.drive
      .shares(item.id)
      .then((s) => setShareCount(s.length))
      .catch(() => {});
  }, [item, inTrash]);

  const copyId = async (id: string) => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-sm">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
          <Icon name="info" className="h-4 w-4" /> Details
        </span>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
          <Icon name="x" />
        </button>
      </div>

      {count > 1 ? (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <Icon name="layers" className="h-10 w-10 text-ocean/70" />
          <div className="font-medium">{count} items selected</div>
          {totalSize > 0 && <div className="text-xs text-muted">{bytes(totalSize)} in files (folder contents not counted)</div>}
        </div>
      ) : !shown ? (
        <div className="flex flex-col items-center gap-2 p-8 text-center text-xs text-muted">
          <Icon name="info" className="h-9 w-9 text-line-2" />
          Select a file or folder to see its details.
        </div>
      ) : (
        <>
          <div className="border-b border-line p-4">
            <div className="flex items-start gap-2.5">
              <Icon name={iconFor(shown)} className={`mt-0.5 h-5 w-5 shrink-0 ${iconColor(shown)}`} />
              <span className="min-w-0 flex-1 break-all font-medium">{shown.name}</span>
              {item && !inTrash && (
                <button type="button" onClick={onStar} title={shown.starred ? "Remove from Starred" : "Add to Starred"} className="shrink-0 rounded p-0.5 hover:bg-panel-2">
                  <Icon name="star" className={`h-4 w-4 ${shown.starred ? "fill-sand text-sand" : "text-muted"}`} />
                </button>
              )}
            </div>
            {shown.default && (
              <p className="mt-2 text-xs text-muted">
                <DefaultBadge />{" "}
                {shown.kind === "project"
                  ? "The default project. Uploads, parse results and extractions are saved here automatically."
                  : "A default folder that the app saves into automatically. It cannot be renamed, moved or deleted."}
              </p>
            )}
            {!item && <p className="mt-2 text-xs text-muted">The {shown.kind} you are in.</p>}
            {!inTrash && opensAsDataset(shown) && (
              <Link href={datasetHref(shown.id)} className="mt-2 inline-flex items-center gap-1.5 text-xs text-ocean hover:underline">
                <Icon name="table" className="h-3.5 w-3.5" /> Open in Dataset Preview
              </Link>
            )}
            {item && item.kind === "file" && item.content_type?.startsWith("image/") && !inTrash && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={driveContentUrl(item.id, true)} alt={item.name} className="mt-3 max-h-48 w-full rounded-md border border-line bg-ink object-contain" />
            )}
            {item && actions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.map((a) => (
                  <button key={a.label} type="button" onClick={a.run} className={buttonClass.outline}>
                    <Icon name={a.icon} className="h-3.5 w-3.5" /> {a.label.replace("…", "")}
                  </button>
                ))}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-3 p-4 text-xs">
            <dt className="text-muted">Type</dt>
            <dd>{typeLabel(shown)}</dd>
            <dt className="text-muted">{shown.kind === "file" ? "Size" : "Contains"}</dt>
            <dd className="tabular-nums">
              {shown.kind === "file" ? `${bytes(shown.size)} (${shown.size.toLocaleString()} bytes)` : `${shown.items ?? 0} items`}
            </dd>
            <dt className="text-muted">{inTrash ? "Was in" : "Location"}</dt>
            <dd className="break-words">{pathLabel(location)}</dd>
            {item && !inTrash && (
              <>
                <dt className="text-muted">Sharing</dt>
                <dd>
                  <button type="button" onClick={onShare} className="flex items-center gap-1.5 text-ocean hover:underline">
                    <Icon name="link" className="h-3.5 w-3.5" />
                    {shareCount === null ? "…" : shareCount === 0 ? "Not shared · Share" : `${shareCount} active link${shareCount === 1 ? "" : "s"} · Manage`}
                  </button>
                </dd>
              </>
            )}
            {!inTrash && shown.kind === "project" && (
              <>
                <dt className="text-muted">Roles</dt>
                <dd>
                  <ProjectRolesPanel key={`roles-${shown.id}`} projectId={shown.id} />
                </dd>
                <dt className="text-muted">Governance</dt>
                <dd>
                  <ProjectGovernancePanel key={`gov-${shown.id}-${moves}`} projectId={shown.id} />
                </dd>
              </>
            )}
            {!inTrash && item && shown.kind !== "project" && (
              <>
                <dt className="text-muted">Roles</dt>
                <dd>
                  <ProjectRolesPanel key={`item-roles-${shown.id}`} itemId={shown.id} />
                </dd>
              </>
            )}
            {!inTrash && (
              <>
                <dt className="text-muted">Markings</dt>
                <dd>
                  <ItemMarkingsPanel key={shown.id} itemId={shown.id} compact />
                </dd>
              </>
            )}
            {!inTrash && <CompassMetaRows key={`compass-${shown.id}`} itemId={shown.id} isProject={shown.kind === "project"} />}
            {shown.trashed_at && (
              <>
                <dt className="text-muted">Trashed</dt>
                <dd>{new Date(shown.trashed_at).toLocaleString()}</dd>
              </>
            )}
            <dt className="text-muted">Created</dt>
            <dd>{new Date(shown.created_at).toLocaleString()}</dd>
            <dt className="text-muted">Last modified</dt>
            <dd>{new Date(shown.updated_at).toLocaleString()}</dd>
            <dt className="text-muted">ID</dt>
            <dd>
              <button
                type="button"
                onClick={() => copyId(shown.id)}
                className="flex max-w-full items-center gap-1.5 rounded border border-line px-1.5 py-0.5 font-mono text-[11px] hover:border-ocean"
                title="Copy ID"
              >
                <span className="truncate">{shown.id}</span>
                <Icon name={copied ? "check" : "copy"} className={`h-3 w-3 shrink-0 ${copied ? "text-ok" : "text-muted"}`} />
              </button>
            </dd>
          </dl>
          {item && !inTrash && previewable(item, PREVIEW) === "table" && <DatasetMaintenance key={item.id} itemId={item.id} />}
        </>
      )}
    </aside>
  );
}

function UploadsPanel({ uploads, onClear }: { uploads: Upload[]; onClear: () => void }) {
  const done = uploads.filter((u) => u.done).length;
  return (
    <div className="fixed bottom-4 right-4 z-30 w-80 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs font-medium">
        Uploads · {done} of {uploads.length} done
        <button type="button" onClick={onClear} className="text-muted hover:text-white" title="Clear finished">
          <Icon name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {uploads.map((u) => (
          <li key={u.key} className="border-b border-line px-3 py-2 text-xs last:border-0">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={u.name}>
                {u.name}
              </span>
              {u.error ? (
                <Icon name="alert" className="h-3.5 w-3.5 text-bad" />
              ) : u.done ? (
                <Icon name="check" className="h-3.5 w-3.5 text-ok" />
              ) : (
                <span className="tabular-nums text-muted">{Math.round(u.progress * 100)}%</span>
              )}
            </div>
            {u.error ? (
              <div className="mt-1 text-bad">{u.error}</div>
            ) : (
              !u.done && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-ocean transition-all" style={{ width: `${u.progress * 100}%` }} />
                </div>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
