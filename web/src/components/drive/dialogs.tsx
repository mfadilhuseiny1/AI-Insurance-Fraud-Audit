"use client";

import { useCallback, useEffect, useState } from "react";
import { api, isContainer, shareLinkUrl, type DriveFolder, type DriveItem, type DriveShare, type SharedItem } from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { Icon } from "../Icon";
import { ApiError, Loading } from "../States";
import { DataPreview } from "../pipeline/DataPreview";
import type { ColType, Table } from "@/lib/pipeline";
import { buttonClass, iconColor, iconFor, Modal, previewable } from "./ui";

/** Pick a destination folder for "Move to…" / "Copy to…". The items being moved can't be chosen
 * (nor anything inside them), and projects only live at the top level. */
export function FolderPicker({
  title,
  action,
  moving,
  startAt,
  onPick,
  onClose,
}: {
  title: string;
  action: string;
  moving: DriveItem[];
  startAt: string | null;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(startAt);
  const [data, setData] = useState<DriveFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = new Set(moving.map((m) => m.id));

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

  const go = (id: string | null) => {
    setData(null);
    setError(null);
    setFolderId(id);
  };
  const path = data?.folder ? [...(data.folder.path ?? []), { id: data.folder.id, name: data.folder.name }] : [];
  const insideMoved = path.some((p) => blocked.has(p.id));
  const sameAsSource = moving.every((m) => (m.parent_id ?? null) === folderId) && action === "Move here";
  // files and folders can live anywhere; a project only at the top level
  const projectsOutOfPlace = folderId !== null && moving.some((m) => m.kind === "project");
  const canPick = data && !insideMoved && !sameAsSource && !projectsOutOfPlace;

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            {insideMoved
              ? "A folder can't go inside itself."
              : projectsOutOfPlace
                ? "Projects stay at the top level."
                : sameAsSource
                  ? "Already in this folder."
                  : `To: ${["Files & Projects", ...path.map((p) => p.name)].join(" / ")}`}
          </span>
          <button type="button" onClick={onClose} className={buttonClass.ghost}>
            Cancel
          </button>
          <button type="button" disabled={!canPick} onClick={() => onPick(folderId)} className={buttonClass.primary}>
            {action}
          </button>
        </>
      }
    >
      <nav className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2 text-sm">
        <button type="button" onClick={() => go(null)} className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-panel-2">
          <Icon name="folder" className="h-4 w-4 text-sand" /> Files &amp; Projects
        </button>
        {path.map((p) => (
          <span key={p.id} className="flex items-center gap-1">
            <Icon name="right" className="h-3.5 w-3.5 text-muted" />
            <button type="button" onClick={() => go(p.id)} className="rounded px-1.5 py-1 hover:bg-panel-2">
              {p.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="h-80 overflow-y-auto">
        {error ? (
          <div className="p-8 text-center text-sm text-bad">{error}</div>
        ) : !data ? (
          <div className="p-8 text-center text-sm text-muted">Loading…</div>
        ) : (
          <ul>
            {data.items.filter(isContainer).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={blocked.has(f.id)}
                  onClick={() => go(f.id)}
                  title={blocked.has(f.id) ? "This is one of the items being moved" : f.name}
                  className="flex w-full items-center gap-3 border-b border-line px-4 py-2 text-left text-sm hover:bg-panel-2 disabled:opacity-40"
                >
                  <Icon name={iconFor(f)} className={`h-4 w-4 ${iconColor(f)}`} />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted">{f.items ?? 0} items</span>
                  <Icon name="right" className="h-3.5 w-3.5 text-muted" />
                </button>
              </li>
            ))}
            {data.items.filter((i) => !isContainer(i)).length > 0 && (
              <li className="px-4 py-2 text-xs text-muted">
                + {data.items.filter((i) => !isContainer(i)).length} files
              </li>
            )}
            {data.items.length === 0 && <li className="p-8 text-center text-sm text-muted">This folder is empty.</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}

const EXPIRY = [
  { days: null, label: "Never expires" },
  { days: 1, label: "Expires in 1 day" },
  { days: 7, label: "Expires in 7 days" },
  { days: 30, label: "Expires in 30 days" },
] as const;

/** Create, copy and turn off the share links of one item. */
export function ShareDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const [shares, setShares] = useState<DriveShare[] | null>(null);
  const [days, setDays] = useState<number | null>(7);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.drive
      .shares(item.id)
      .then(setShares)
      .catch((e: Error) => setError(e.message));
  }, [item.id]);
  useEffect(load, [load]);

  const copy = async (token: string) => {
    await navigator.clipboard.writeText(shareLinkUrl(token));
    setCopied(token);
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const share = await api.drive.share(item.id, days);
      await copy(share.token);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    try {
      await api.drive.revokeShare(token);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Share “${item.name}”`} onClose={onClose}>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-soft">
          Anyone with the link can view and download {isContainer(item) ? "this " + item.kind + " and everything in it" : "this file"}.
        </p>
        <div className="flex gap-2">
          <select
            value={days ?? ""}
            onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}
            className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean"
          >
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.days ?? ""}>
                {x.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={create} disabled={busy} className={`${buttonClass.primary} flex items-center gap-1.5`}>
            <Icon name="link" className="h-4 w-4" /> Create &amp; copy link
          </button>
        </div>
        {error && <p className="text-bad">{error}</p>}
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Active links</div>
          {!shares ? (
            <p className="text-muted">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-muted">No links yet. Only you can see this {item.kind}.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {shares.map((s) => (
                <li key={s.token} className="flex items-center gap-2 px-3 py-2">
                  <Icon name="link" className="h-4 w-4 shrink-0 text-ocean" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{shareLinkUrl(s.token)}</div>
                    <div className="text-[11px] text-muted">
                      Created {when(s.created_at)} · {s.expires_at ? `expires ${when(s.expires_at)}` : "never expires"}
                    </div>
                  </div>
                  <button type="button" onClick={() => copy(s.token)} className={buttonClass.outline}>
                    <Icon name={copied === s.token ? "check" : "copy"} className="h-3.5 w-3.5" />
                    {copied === s.token ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    onClick={() => revoke(s.token)}
                    className="rounded p-1.5 text-muted hover:bg-bad/10 hover:text-bad"
                    title="Turn off this link"
                  >
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Full-window preview of a file, with ←/→ to step through the other files of the list. */
export function Preview({
  items,
  index,
  urlFor,
  downloadUrlFor,
  onIndex,
  onClose,
  readTable,
}: {
  items: SharedItem[];
  index: number;
  urlFor: (item: SharedItem) => string;
  downloadUrlFor: (item: SharedItem) => string;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Parquet files as a table (the first rows); without it they have no preview */
  readTable?: (item: SharedItem) => Promise<TableSample>;
}) {
  const item = items[index];
  const kind = previewable(item, { tables: !!readTable });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [index, items.length, onClose, onIndex]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex h-14 shrink-0 items-center gap-3 px-4 text-sm">
        <button type="button" onClick={onClose} className="rounded p-1.5 text-soft hover:bg-white/10" title="Close (Esc)">
          <Icon name="x" />
        </button>
        <Icon name={iconFor(item)} className={`h-4 w-4 ${iconColor(item)}`} />
        <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
        <span className="text-xs text-muted">
          {index + 1} / {items.length} · {bytes(item.size)}
        </span>
        {kind !== "table" && (
          <a href={urlFor(item)} target="_blank" rel="noopener" className="rounded p-1.5 text-soft hover:bg-white/10" title="Open in new tab">
            <Icon name="external" />
          </a>
        )}
        <a href={downloadUrlFor(item)} className="rounded p-1.5 text-soft hover:bg-white/10" title="Download">
          <Icon name="download" />
        </a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-6">
        {index > 0 && (
          <button
            type="button"
            onClick={() => onIndex(index - 1)}
            className="absolute left-3 rounded-full bg-white/10 p-2.5 hover:bg-white/20"
            title="Previous (←)"
          >
            <Icon name="left" className="h-5 w-5" />
          </button>
        )}
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={item.id} src={urlFor(item)} alt={item.name} className="max-h-full max-w-full rounded object-contain" />
        ) : kind === "table" && readTable ? (
          <TablePreview key={item.id} item={item} read={readTable} />
        ) : kind === "frame" ? (
          <iframe key={item.id} src={urlFor(item)} title={item.name} className="h-full w-full max-w-5xl rounded bg-white" />
        ) : (
          <div className="flex flex-col items-center gap-3 text-sm text-soft">
            <Icon name="doc" className="h-14 w-14 text-muted" />
            No preview for this kind of file.
            <a href={downloadUrlFor(item)} className={buttonClass.primary}>
              Download
            </a>
          </div>
        )}
        {index < items.length - 1 && (
          <button
            type="button"
            onClick={() => onIndex(index + 1)}
            className="absolute right-3 rounded-full bg-white/10 p-2.5 hover:bg-white/20"
            title="Next (→)"
          >
            <Icon name="right" className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The first rows of a dataset file, as the API reads them. */
export type TableSample = { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number };

function TablePreview({ item, read }: { item: SharedItem; read: (item: SharedItem) => Promise<TableSample> }) {
  const [state, setState] = useState<{ data?: TableSample; error?: string }>({});
  useEffect(() => {
    let live = true;
    read(item).then(
      (data) => live && setState({ data }),
      (e) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [item, read]);

  const { data, error } = state;
  if (error) return <ApiError message={error} />;
  if (!data) return <Loading label="Reading the table…" />;
  const table: Table = {
    columns: data.columns.map((c) => ({ name: c.name, type: c.type as ColType })),
    rows: data.rows as Table["rows"],
  };
  return (
    <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded border border-line bg-ink">
      <DataPreview table={table} title={item.name} />
      {data.total_rows > data.rows.length && (
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-muted">
          Preview of the first {data.rows.length.toLocaleString()} of {data.total_rows.toLocaleString()} rows. Download the file for all of it.
        </p>
      )}
    </div>
  );
}
