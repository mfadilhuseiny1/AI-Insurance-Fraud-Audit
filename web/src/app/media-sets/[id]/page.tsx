"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AccessImage } from "@/components/media/AccessImage";
import { AccessPatternsSection } from "@/components/media/AccessPatterns";
import { MediaPreview } from "@/components/media/MediaPreview";
import { AppHeader, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { bytes, mediaContentUrl, mediaSets, SCHEMA_ICON, type MediaItem, type MediaSet, type MediaUsage, type SchemaInfo } from "@/lib/mediaSets";

type Tab = "items" | "details" | "usage";
const THUMBS = new Set(["image", "document", "video", "dicom"]);

export default function MediaSetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [set, setSet] = useState<MediaSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("items");
  const [code, setCode] = useState(false);
  const load = useCallback(() => mediaSets.get(id).then(setSet, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error && !set) return <ApiError message={error} />;
  if (!set) return <Loading />;
  const label = [set.schema === "multimodal" ? "Multimodal" : set.schema, set.primary_format && `.${set.primary_format}`, set.transaction_policy].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Media sets" icon="image" href="/media-sets">
        <button type="button" onClick={() => setCode(true)} className={buttonClass.secondary}>
          <Icon name="code" /> Use in code
        </button>
        <Link href="/pipeline" className={buttonClass.secondary}>
          <Icon name="pipeline" /> Create pipeline
        </Link>
        <Link href={`/files/${set.id}`} className={buttonClass.secondary}>
          <Icon name="folder" /> Open in Files
        </Link>
      </AppHeader>
      <div className="border-b border-line bg-panel px-6 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name={SCHEMA_ICON[set.schema] as IconName} className="h-5 w-5 text-ocean" />
          <h1 className="text-lg font-semibold">{set.name}</h1>
          <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-muted">{label}</span>
          {set.virtual && <span className="rounded bg-sand/15 px-2 py-0.5 text-xs text-sand">virtual · {set.virtual.connection_name}</span>}
          {set.built_by && <span className="rounded bg-panel-2 px-2 py-0.5 text-xs text-muted">updated by {set.built_by === "code" ? "a Code Repositories build" : "a Pipeline Builder build"}</span>}
          <span className="ml-auto text-xs text-muted">
            {set.items.toLocaleString()} items · {bytes(set.size)} · {set.versions} older versions
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted">{set.path.join(" / ")}</div>
        <nav className="mt-3 flex gap-4 text-sm">
          {(
            [
              ["items", "Media items"],
              ["details", "Details"],
              ["usage", "Usage"],
            ] as [Tab, string][]
          ).map(([t, l]) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`border-b-2 pb-2 ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>
              {l}
            </button>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "items" && <ItemsTab set={set} onChanged={load} />}
        {tab === "details" && <DetailsTab set={set} onChanged={load} onRemoved={() => router.push("/media-sets")} />}
        {tab === "usage" && <UsageTab set={set} />}
      </div>
      {code && <CodeDialog set={set} onClose={() => setCode(false)} />}
    </div>
  );
}

function ItemsTab({ set, onChanged }: { set: MediaSet; onChanged: () => void }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => mediaSets.items(set.id, { deduplicate: !all, q }).then((r) => setItems(r.items), (e: Error) => setError(e.message)), [set.id, all, q]);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    let tx = set.open_transaction ?? undefined;
    try {
      if (set.transaction_policy === "transactional" && !tx) tx = (await mediaSets.openTransaction(set.id)).id;
      const failed: string[] = [];
      for (const [i, f] of list.entries()) {
        setBusy(`Uploading ${i + 1} of ${list.length}: ${f.name}`);
        try {
          await mediaSets.upload(set.id, f, tx);
        } catch (e) {
          failed.push(`${f.name}: ${(e as Error).message}`);
        }
      }
      if (failed.length) setError(failed.join("\n"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
      load();
    }
  };
  const txAction = async (commit: boolean) => {
    if (!set.open_transaction) return;
    setBusy(commit ? "Committing…" : "Aborting…");
    try {
      if (commit) await mediaSets.commit(set.id, set.open_transaction);
      else await mediaSets.abort(set.id, set.open_transaction);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
      load();
    }
  };
  return (
    <div className="flex h-full min-h-0">
      <div
        className={`flex min-w-0 flex-1 flex-col ${drag ? "ring-2 ring-inset ring-ocean" : ""}`}
        onDragOver={(e) => {
          if (set.virtual) return;
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!set.virtual) upload(e.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <div className="relative w-64">
            <Icon name="search" className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path…" className={`${inputClass} pl-8 text-xs`} />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-[var(--color-ocean)]" />
            Show overwritten and deleted items
          </label>
          <span className="ml-auto" />
          {busy && <span className="text-xs text-ocean">{busy}</span>}
          {!set.virtual && (
            <>
              <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
              <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()} className={buttonClass.primary}>
                <Icon name="upload" /> Upload
              </button>
            </>
          )}
        </div>
        {set.open_transaction && (
          <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-4 py-2 text-xs text-warn">
            <Icon name="clock" className="h-3.5 w-3.5" />
            Transaction {set.open_transaction} is open: its uploads become readable when it is committed.
            <button type="button" onClick={() => txAction(true)} className="ml-auto rounded bg-ok/20 px-2 py-0.5 text-ok hover:bg-ok/30">
              Commit
            </button>
            <button type="button" onClick={() => txAction(false)} className="rounded bg-bad/15 px-2 py-0.5 text-bad hover:bg-bad/25">
              Abort
            </button>
          </div>
        )}
        {error && <pre className="mx-4 mt-2 whitespace-pre-wrap rounded bg-bad/10 p-2 text-xs text-bad">{error}</pre>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {items === null ? (
            <Loading />
          ) : items.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-line-2 py-14 text-center text-sm text-muted">
              {set.virtual ? (
                "No items registered yet: run a virtual sync from the Details tab."
              ) : (
                <>
                  Drag files here, or{" "}
                  <button type="button" onClick={() => fileRef.current?.click()} className="text-ocean hover:underline">
                    choose from your computer
                  </button>
                  .{set.schema !== "multimodal" && ` Accepted: .${[set.primary_format, ...set.additional_formats].join(", .")}`}
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setOpen(it)}
                  className={`overflow-hidden rounded-lg border bg-panel text-left ${open?.id === it.id ? "border-ocean" : "border-line hover:border-ocean/50"} ${it.overwritten ? "opacity-60" : ""}`}
                >
                  <div className="flex h-28 items-center justify-center bg-ink">
                    {it.schema && THUMBS.has(it.schema) ? (
                      <AccessImage id={it.id} pattern="thumbnail" params={{ width: 300 }} background={it.schema === "video"} alt="" loading="lazy" className="max-h-28 max-w-full object-contain" />
                    ) : (
                      <Icon name={(SCHEMA_ICON[it.schema ?? "multimodal"] ?? "doc") as IconName} className="h-8 w-8 text-muted" />
                    )}
                  </div>
                  <div className="p-2">
                    <div className="truncate text-xs text-soft" title={it.path}>
                      {it.path}
                    </div>
                    <div className="text-[11px] text-muted">
                      {bytes(it.size)}
                      {it.overwritten ? ` · ${it.state}` : ""}
                      {it.virtual ? " · virtual" : ""}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {open && (
        <ItemPanel
          key={open.id}
          set={set}
          item={open}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            onChanged();
            load();
          }}
        />
      )}
    </div>
  );
}

function ItemPanel({ set, item, onClose, onDeleted }: { set: MediaSet; item: MediaItem; onClose: () => void; onDeleted: () => void }) {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [history, setHistory] = useState<MediaItem[] | null>(null);
  const [shown, setShown] = useState<MediaItem>(item);
  const [panel, setPanel] = useState<"metadata" | "history">("metadata");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mediaSets.metadata(shown.id).then(setMeta, () => setMeta({}));
  }, [shown.id]);
  useEffect(() => {
    if (panel === "history" && history === null) mediaSets.history(set.id, item.path).then(setHistory, () => setHistory([]));
  }, [panel, history, set.id, item.path]);
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${item.path}? It leaves the media set, but media references to it keep working.`))) return;
    try {
      await mediaSets.remove(set.id, item.id);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const skip = new Set(["id", "path", "media_set", "page_dimensions"]);
  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={shown.path}>
          {shown.path}
        </span>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {shown.id !== item.id && <p className="rounded bg-warn/10 px-2 py-1 text-xs text-warn">An older version of this path ({shown.state}).</p>}
        <MediaPreview id={shown.id} schema={shown.schema ?? set.schema} path={shown.path} compact />
        <div className="flex flex-wrap gap-2 text-xs">
          <a href={mediaContentUrl(shown.id, true)} className={buttonClass.secondary}>
            <Icon name="download" /> Download
          </a>
          <button type="button" onClick={() => navigator.clipboard.writeText(shown.id)} className={buttonClass.secondary} title="The media reference used by datasets and object properties">
            <Icon name="copy" /> Copy media reference
          </button>
          {!item.overwritten && !set.built_by && (
            <button type="button" onClick={remove} className={buttonClass.secondary}>
              <Icon name="trash" /> Delete
            </button>
          )}
        </div>
        <ErrorBox message={error} />
        <div className="flex gap-3 border-b border-line text-xs">
          {(["metadata", "history"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPanel(p)} className={`border-b-2 pb-1.5 ${panel === p ? "border-ocean text-white" : "border-transparent text-muted"}`}>
              {p === "metadata" ? "Metadata" : "Version history"}
            </button>
          ))}
        </div>
        {panel === "metadata" ? (
          meta === null ? (
            <Loading />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted">Uploaded</dt>
              <dd className="text-soft">{shown.uploaded_at ? when(shown.uploaded_at) : "—"}</dd>
              <dt className="text-muted">Media reference</dt>
              <dd className="break-all font-mono text-soft">{shown.id}</dd>
              {Object.entries(meta)
                .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="capitalize text-muted">{k.replace(/_/g, " ")}</dt>
                    <dd className="break-words text-soft">{k === "size" ? bytes(Number(v)) : Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                  </div>
                ))}
            </dl>
          )
        ) : history === null ? (
          <Loading />
        ) : (
          <ul className="space-y-1 text-xs">
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => setShown(h)} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${shown.id === h.id ? "bg-ocean/15" : "hover:bg-panel-2"}`}>
                  <span className={h.state === "current" ? "text-ok" : "text-muted"}>{h.state}</span>
                  <span className="text-soft">{h.uploaded_at ? when(h.uploaded_at) : "—"}</span>
                  <span className="ml-auto text-muted">{bytes(h.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function DetailsTab({ set, onChanged, onRemoved }: { set: MediaSet; onChanged: () => void; onRemoved: () => void }) {
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [extra, setExtra] = useState<string[]>(set.additional_formats);
  const [maxAge, setMaxAge] = useState(set.retention.max_age_days?.toString() ?? "");
  const [overwritten, setOverwritten] = useState(set.retention.overwritten_days?.toString() ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    mediaSets.schemas().then((s) => setSchema(s.schemas.find((x) => x.id === set.schema) ?? null), () => setSchema(null));
  }, [set.schema]);
  const allowed = schema && set.primary_format ? schema.additional[set.primary_format] ?? [] : [];
  const save = async () => {
    setError(null);
    try {
      await mediaSets.saveSettings(set.id, {
        additional_formats: set.virtual ? undefined : extra,
        retention: { max_age_days: maxAge ? Number(maxAge) : null, overwritten_days: overwritten ? Number(overwritten) : null },
      });
      setNote("Saved. Retention applies right away and then every 10 minutes.");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const r = await mediaSets.virtualSync(set.id);
      setNote(`Registered ${r.registered} new items (${r.skipped} files skipped); the media set has ${r.items} items.`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };
  const unregister = async () => {
    if (!(await confirmDialog("Stop treating this folder as a media set? Its files stay in Files; older versions and virtual items are dropped."))) return;
    await mediaSets.unregister(set.id);
    onRemoved();
  };
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-6 text-sm">
        <section className="space-y-2">
          <h2 className="font-semibold">Formats</h2>
          <p className="text-xs text-muted">
            {set.schema === "multimodal"
              ? "A multimodal media set accepts every file format."
              : `Every item is stored as .${set.primary_format}. Items with another path extension are rejected unless they are an additional input format, which is converted on upload.`}
          </p>
          {allowed.length > 0 && (
            <Field label="Additional input formats" hint={set.virtual ? "Virtual media sets cannot have additional input formats" : undefined}>
              <div className="flex flex-wrap gap-1">
                {allowed.map((f) => (
                  <label key={f} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${extra.includes(f) ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                    <input
                      type="checkbox"
                      disabled={!!set.virtual}
                      checked={extra.includes(f)}
                      onChange={(e) => setExtra(e.target.checked ? [...extra, f] : extra.filter((x) => x !== f))}
                      className="accent-[var(--color-ocean)]"
                    />
                    .{f}
                  </label>
                ))}
              </div>
            </Field>
          )}
        </section>
        <section className="space-y-1">
          <h2 className="font-semibold">Transaction policy: {set.transaction_policy}</h2>
          <p className="text-xs text-muted">
            {set.transaction_policy === "transactional"
              ? "Items are added within a transaction (one open at a time, at most 10,000 items); committing makes them readable, aborting deletes them. A failed build changes nothing. Builds can use the replace and modify write modes."
              : "Uploads are readable at once and cannot be rolled back. Builds only use the modify write mode (add or overwrite items); the media set cannot be reset to empty."}
          </p>
        </section>
        <section className="space-y-2">
          <h2 className="font-semibold">Retention policy</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Permanently delete media items older than (days)" hint="Empty: never">
              <input type="number" min={0} step="any" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} className={inputClass} placeholder="Never delete" />
            </Field>
            <Field label="Permanently delete overwritten or deleted items after (days)" hint="Counted from when they were overwritten">
              <input type="number" min={0} step="any" value={overwritten} onChange={(e) => setOverwritten(e.target.value)} className={inputClass} placeholder="Never delete" />
            </Field>
          </div>
          <p className="text-xs text-muted">An item is deleted when either policy says so. Shortening a window deletes what is now outside it at once; widening it does not bring back deleted items.</p>
        </section>
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} className={buttonClass.primary}>
            Save settings
          </button>
          {note && <span className="text-xs text-ok">{note}</span>}
        </div>
        <ErrorBox message={error} />
        <AccessPatternsSection setId={set.id} schema={set.schema} />
        {set.virtual && (
          <section className="space-y-2">
            <h2 className="font-semibold">Virtual media set</h2>
            <p className="text-xs text-muted">
              Reads {set.virtual.folder} of the Amazon S3 connection <span className="text-soft">{set.virtual.connection_name}</span> without copying files. It is not aware of later
              updates or deletions in the source; transformed items are stored in the platform. Python transforms can register items with{" "}
              <code className="text-soft">register_media_item(physical_path, path)</code>.
            </p>
            <button type="button" disabled={syncing} onClick={sync} className={buttonClass.secondary}>
              <Icon name="refresh" className={syncing ? "animate-spin" : ""} /> Sync now
            </button>
          </section>
        )}
        <section className="space-y-1 text-xs text-muted">
          <h2 className="text-sm font-semibold text-soft">Limits</h2>
          <p>Paths are at most 256 characters; an item is at most 50 GB; a transaction holds at most 10,000 items.</p>
          {set.built_by && <p>A build pipeline updates this media set, so its items cannot be deleted by hand.</p>}
        </section>
        <section>
          <button type="button" onClick={unregister} className="text-xs text-bad hover:underline">
            Stop using this folder as a media set
          </button>
        </section>
      </div>
    </div>
  );
}

function UsageTab({ set }: { set: MediaSet }) {
  const [usage, setUsage] = useState<MediaUsage | null>(null);
  useEffect(() => {
    mediaSets.usage(30).then(setUsage, () => setUsage(null));
  }, []);
  if (!usage) return <Loading />;
  const mine = usage.media_sets.find((m) => m.id === set.id);
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4 text-sm">
        <p className="text-muted">
          Downloads and access patterns (previews, page renders, waveforms, …) are metered in compute-seconds per GB processed, over the last 30 days. All media usage is in{" "}
          <Link href="/resource-management" className="text-ocean hover:underline">
            Resource Management
          </Link>
          .
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Compute-seconds", (mine?.compute_seconds ?? 0).toFixed(3)],
            ["Data processed", bytes(Math.round((mine?.gb ?? 0) * 1024 ** 3))],
            ["Requests", String(mine?.requests ?? 0)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-panel p-4">
              <div className="text-xs text-muted">{k}</div>
              <div className="mt-1 text-xl font-semibold">{v}</div>
            </div>
          ))}
        </div>
        <table className="w-full rounded-xl border border-line bg-panel text-xs">
          <thead className="text-left text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2 font-medium">Transformation</th>
              <th className="px-3 py-2 font-medium">Rate (compute-s / GB)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(usage.rates).map(([k, v]) => (
              <tr key={k} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 text-soft">{k.replace(/_/g, " ")}</td>
                <td className="px-3 py-1.5 text-muted">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CodeDialog({ set, onClose }: { set: MediaSet; onClose: () => void }) {
  const path = [...set.path, set.name].join("/");
  const snippet = `from transforms.api import transform, Output
from transforms.mediasets import MediaSetInput

@transform.using(
    media=MediaSetInput("${path}"),
    listing=Output("${set.name}_listing"),
)
def compute(media, listing):
    # one row per media item: mediaItemRid, path, mediaReference
    listing.write_table(media.list_media_items_by_path_with_media_reference().pandas())`;
  return (
    <Modal title="Use this media set in code" icon="code" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted">
          In a Python repository of{" "}
          <Link href="/code-repositories" className="text-ocean hover:underline">
            Code Repositories
          </Link>
          , read it with <code>MediaSetInput</code> and write to it with <code>MediaSetOutput</code>
          {set.transaction_policy === "transactional" ? " (transactional: the replace and modify write modes)" : " (transactionless: the modify write mode)"}.
        </p>
        <pre className="overflow-x-auto rounded bg-ink p-3 text-xs text-soft">{snippet}</pre>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => navigator.clipboard.writeText(snippet)} className={buttonClass.secondary}>
            <Icon name="copy" /> Copy
          </button>
          <button type="button" onClick={onClose} className={buttonClass.primary}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
