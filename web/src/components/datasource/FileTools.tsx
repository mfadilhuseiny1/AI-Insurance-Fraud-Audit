"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, type ConnectorSpec, type DataSource, type DbConnection } from "@/lib/api";
import { fileTransfers, MediaSyncFailed, oauth, type DatasetRef, type MediaRun, type MediaSyncResult } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { DrivePicker } from "../DrivePicker";
import { NewMediaSetDialog } from "../media/NewMediaSetDialog";
import { mediaSets } from "@/lib/mediaSets";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";
import { useLoad } from "./DataSourceWizard";

export const FILE_KINDS = ["amazon-s3", "filesystem"];

/** OAuth 2.0 sign-in for a connection form: opens the provider, then fills the token field with a reference. */
export function OAuthSignIn({
  spec,
  values,
  onToken,
}: {
  spec: ConnectorSpec;
  values: Record<string, string | number | boolean>;
  onToken: (field: string, ref: string) => void;
}) {
  const [state, setState] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    oauth
      .redirectUri()
      .then((r) => setRedirect(r.redirect_uri))
      .catch(() => {});
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  if (!spec.oauth) return null;
  const field = spec.oauth.token_field;
  const start = async () => {
    setMessage(null);
    try {
      const s = await oauth.start(spec.id, values);
      setRedirect(s.redirect_uri);
      window.open(s.url, "bluesandai-oauth", "width=560,height=720");
      setState("waiting");
      const started = Date.now();
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        try {
          const r = await oauth.result(s.state);
          if (r.status === "done" && r.ref) {
            clearInterval(timer.current!);
            onToken(field, r.ref);
            setState("done");
            setMessage(r.refresh ? "Signed in — the refresh token is kept when you save." : "Signed in (the provider issued no refresh token: sign in again when it expires).");
          } else if (r.status === "error") {
            clearInterval(timer.current!);
            setState("error");
            setMessage(r.message ?? "Sign-in failed");
          } else if (Date.now() - started > 10 * 60_000) {
            clearInterval(timer.current!);
            setState("error");
            setMessage("Sign-in timed out");
          }
        } catch (e) {
          clearInterval(timer.current!);
          setState("error");
          setMessage((e as Error).message);
        }
      }, 1500);
    } catch (e) {
      setState("error");
      setMessage((e as Error).message);
    }
  };
  return (
    <div className="col-span-6 rounded-lg border border-line-2 bg-panel-2 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={start} disabled={state === "waiting"} className={buttonClass.secondary}>
          <Icon name={state === "waiting" ? "refresh" : state === "done" ? "check" : "link"} className={`h-3.5 w-3.5 ${state === "waiting" ? "animate-spin" : ""}`} />
          {state === "waiting" ? "Waiting for sign-in…" : state === "done" ? "Signed in" : `Sign in with ${spec.name}`}
        </button>
        <span className="text-muted">OAuth 2.0: fill in your app&apos;s client ID (and secret), then sign in in the window that opens.</span>
      </div>
      {redirect && (
        <p className="mt-2 text-muted">
          Register this redirect URL in your {spec.name} app: <code className="select-all font-mono text-soft">{redirect}</code>
        </p>
      )}
      {message && <p className={`mt-2 ${state === "error" ? "text-bad" : "text-ok"}`}>{message}</p>}
    </div>
  );
}

/** Media sets and file exports of an Amazon S3 / filesystem connection (Connections tab). */
export function FileTools({ connection }: { connection: DbConnection }) {
  const [open, setOpen] = useState<"media" | "export" | null>(null);
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setOpen(open === "media" ? null : "media")} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="image" className="h-3.5 w-3.5" /> Media sets
        </button>
        <button type="button" onClick={() => setOpen(open === "export" ? null : "export")} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="upload" className="h-3.5 w-3.5" /> File export
        </button>
      </div>
      {open === "media" && <MediaSync connection={connection} />}
      {open === "export" && <FileExport connection={connection} />}
    </div>
  );
}

const clean = (reason: string) => reason.replace(/^MediaSet:\w+: /, "");

/** One media set sync run: its status said plainly, the counts, and the files it skipped or failed on with the reasons. */
function RunSummary({ run, setName, heading }: { run: MediaRun & Partial<Pick<MediaSyncResult, "errors">>; setName: string; heading?: string }) {
  const status = run.status ?? "succeeded";
  const tone = status === "failed" ? "text-bad" : status === "partial" ? "text-warn" : "text-ok";
  const title = status === "failed" ? "Sync failed" : status === "partial" ? "Sync partially failed" : "Sync succeeded";
  const transactional = run.transaction_policy === "transactional";
  const aborted = status === "failed" && transactional && !!run.transaction_id;
  const skipped = run.errors ? run.errors.filter((e) => e.rejected).map((e) => ({ path: e.path, reason: e.error })) : (run.skipped_files ?? []);
  const failed = run.errors ? run.errors.filter((e) => !e.rejected).map((e) => ({ path: e.path, reason: e.error })) : (run.failed_files ?? []);
  const counts: [string, number, string][] = [
    ["written", run.written ?? run.accepted ?? 0, "Files written into the media set"],
    ["skipped", run.skipped ?? run.rejected ?? 0, "Files the media set does not take (schema, format or content)"],
    ["unchanged", run.unchanged ?? 0, "Files already synced with the same content"],
    ["deleted", run.deleted ?? 0, "Items deleted because their file is gone from the source"],
    ["failed", run.failed ?? 0, "Files that could not be read or written"],
    ["filtered out", run.filtered ?? 0, "Files left out by Path matches or File size limit"],
  ];
  if (run.aborted) counts.push(["aborted", run.aborted, "Files staged in the transaction that was aborted"]);
  return (
    <div data-media-run={status} className={`rounded-md border p-2 ${status === "failed" ? "border-bad/50" : status === "partial" ? "border-warn/50" : "border-line-2"}`}>
      <p className={`flex flex-wrap items-center gap-x-2 font-medium ${tone}`}>
        <Icon name={status === "succeeded" ? "check" : "alert"} className="h-3.5 w-3.5" />
        <span data-media-run-title>
          {heading ? `${heading}: ` : ""}
          {title}
          {aborted ? " — transaction aborted" : ""}
        </span>
        <span className="font-normal text-muted">
          {setName ? `media set ${setName}` : "media set"}
          {run.transaction_id ? ` · transaction ${run.transaction_id}` : ""}
        </span>
      </p>
      {run.error && (
        <p data-media-run-error className="mt-1 text-bad">
          {clean(run.error)}
        </p>
      )}
      {status === "failed" && (
        <p className="mt-1 text-muted">
          {transactional
            ? "Nothing of this run is visible in the media set: a transactional run commits only when every file succeeded."
            : "Files written before the failure stay in the media set (transactionless)."}
        </p>
      )}
      {status === "partial" && <p className="mt-1 text-muted">Some files failed; the others were written and stay in the media set. Failed files are retried on the next run.</p>}
      <p data-media-run-counts className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-soft">
        {counts.map(([label, n, hint]) => (
          <span key={label} title={hint} className={n && (label === "failed" || label === "aborted") ? "text-bad" : n && label === "skipped" ? "text-warn" : ""}>
            <span className="font-medium tabular-nums">{n}</span> {label}
          </span>
        ))}
        {run.remaining ? <span className="text-muted">{run.remaining} more on the next run</span> : null}
      </p>
      {failed.length > 0 && (
        <div className="mt-2">
          <p className="text-bad">
            Failed files ({run.failed ?? failed.length}
            {(run.failed ?? 0) > failed.length ? `, first ${failed.length} shown` : ""})
          </p>
          <ul data-media-run-failed className="max-h-32 space-y-0.5 overflow-auto">
            {failed.map((f) => (
              <li key={f.path} className="text-bad">
                <span className="font-mono">{f.path}</span> — {clean(f.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mt-2">
          <p className="text-warn">
            Skipped files ({run.skipped ?? run.rejected ?? skipped.length}
            {(run.skipped ?? 0) > skipped.length ? `, first ${skipped.length} shown` : ""}) — not matching the media set&apos;s schema
          </p>
          <ul data-media-run-skipped className="max-h-40 space-y-0.5 overflow-auto">
            {skipped.map((f) => (
              <li key={f.path} className="text-warn">
                <span className="font-mono">{f.path}</span> — {clean(f.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MediaSync({ connection }: { connection: DbConnection }) {
  const state = useLoad(`media:${connection.id}`, () => fileTransfers.mediaState(connection.id));
  const [folder, setFolder] = useState("/");
  const [exts, setExts] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<"files" | "media-set">("files");
  const [mediaSetId, setMediaSetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [fileErrors, setFileErrors] = useState<{ path: string; error: string; rejected?: boolean }[]>([]);
  // the media set run made here (succeeded, partial or failed), shown with its counts and files
  const [summary, setSummary] = useState<MediaSyncResult | null>(null);
  // sync filters of a media set sync (Data Connection: "Set up a media set sync") and deletion propagation
  const [excludeSynced, setExcludeSynced] = useState(true);
  const [pathMatches, setPathMatches] = useState("");
  const [sizeLimit, setSizeLimit] = useState("");
  const [ignoreMismatch, setIgnoreMismatch] = useState(true);
  const [propagate, setPropagate] = useState(false);
  const sets = useLoad(target === "media-set" ? "media-sets-for-sync" : null, () => mediaSets.list());
  // a sync writes copies: virtual media sets read their source, and build outputs are written by their pipeline
  const targets = (sets.data ?? []).filter((m) => !m.virtual && !m.built_by);
  const chosen = targets.find((m) => m.id === mediaSetId);
  const extensions = exts ?? (state.data?.extensions ?? []).join(", ");
  const limit = sizeLimit.trim() === "" ? null : Number(sizeLimit);
  const limitBad = limit !== null && (!Number.isInteger(limit) || limit <= 0);
  const nameOf = (id?: string | null) => (sets.data ?? []).find((m) => m.id === id)?.name ?? "";
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setFileErrors([]);
    setSummary(null);
    try {
      const r = await fileTransfers.mediaSync(connection.id, {
        folder,
        extensions: extensions
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        ...(target === "media-set"
          ? {
              target_media_set_id: mediaSetId,
              exclude_already_synced: excludeSynced,
              path_matches: pathMatches.trim() || null,
              file_size_limit: limit,
              ignore_items_not_matching_schema: ignoreMismatch,
              propagate_deletions: propagate,
            }
          : {}),
      });
      if (r.target_media_set_id) {
        setSummary(r);
        sets.retry();
      } else {
        setResult(
          `Copied ${r.copied} file${r.copied === 1 ? "" : "s"} into Files (My Project / Data Source / Media)${r.failed ? `, ${r.failed} failed` : ""}${r.remaining ? `; ${r.remaining} more on the next run` : ""}.`,
        );
        setFileErrors(r.errors);
      }
    } catch (e) {
      // a run that failed as a whole comes back as an error carrying the run (its counts, the files and the reason)
      if (e instanceof MediaSyncFailed) setSummary(e.run);
      else setError(`Sync failed: ${(e as Error).message}`);
    } finally {
      state.retry();
      setBusy(false);
    }
  };
  const last: MediaRun | undefined = state.data?.runs.at(-1);
  const setCounts = mediaSetId ? state.data?.media_sets?.[mediaSetId] : undefined;
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted">
        Copies documents, images, audio and video from a folder of this source into Files or into a media set. Each run copies only new or changed files;
        a media set checks every file against its schema and formats and keeps its transaction policy.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-soft">Target</span>
        <select value={target} onChange={(e) => setTarget(e.target.value as typeof target)} className={`${inputClass} w-44`} aria-label="Sync target">
          <option value="files">Files folder</option>
          <option value="media-set">Media set</option>
        </select>
        {target === "media-set" && (
          <>
            <select value={mediaSetId} onChange={(e) => setMediaSetId(e.target.value)} className={`${inputClass} w-64`} aria-label="Target media set">
              <option value="">{sets.data ? "Choose a media set…" : "Loading media sets…"}</option>
              {targets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.schema}
                  {m.primary_format ? ` (.${[m.primary_format, ...m.additional_formats].join(", .")})` : ""} · {m.transaction_policy}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setCreating(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New media set…
            </button>
          </>
        )}
      </div>
      {target === "media-set" && chosen && (
        <p className="text-muted">
          {chosen.transaction_policy === "transactional"
            ? "Transactional: each run stages its files in one transaction, committed only when every file succeeded (nothing is visible if the run fails)."
            : "Transactionless: each accepted file is readable at once."}{" "}
          Files are checked by content as well as by extension; files that do not fit are skipped and listed below, and retried when they change or the media
          set&apos;s formats change.
          {setCounts ? ` ${setCounts.synced} synced, ${setCounts.rejected} skipped so far.` : ""}
        </p>
      )}
      {creating && (
        <NewMediaSetDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            setMediaSetId(m.id);
            sets.retry();
          }}
        />
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-soft">Folder</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} className={inputClass} placeholder="/ or invoices/2024" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-soft">File types</span>
          <input value={extensions} onChange={(e) => setExts(e.target.value)} className={inputClass} />
        </label>
      </div>
      {target === "media-set" && (
        <fieldset data-media-sync-filters className="rounded-md border border-line-2 p-2.5">
          <legend className="px-1 text-soft">Sync filters</legend>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={excludeSynced} onChange={(e) => setExcludeSynced(e.target.checked)} className="mt-0.5" aria-label="Exclude files already synced" />
              <span>
                <span className="text-soft">Exclude files already synced</span>
                <span className="block text-muted">Only sync files that were added or modified in size or date since the last sync. Off: every file is read again.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={ignoreMismatch}
                onChange={(e) => setIgnoreMismatch(e.target.checked)}
                className="mt-0.5"
                aria-label="Ignore items not matching schema"
              />
              <span>
                <span className="text-soft">Ignore items not matching schema</span>
                <span className="block text-muted">Such a file is skipped and listed with the reason. Off: it fails the run.</span>
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-soft">Path matches</span>
              <input value={pathMatches} onChange={(e) => setPathMatches(e.target.value)} className={inputClass} placeholder="e.g. ^scans/.*\.png$" aria-label="Path matches" />
              <span className="mt-0.5 block text-muted">
                Only sync files with a path (relative to the root of the source) that matches the regular expression; anchor it with ^ and $ to match the whole path. A
                glob from earlier syncs (scans/*.png) still matches the path below the folder.
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-soft">File size limit</span>
              <input
                value={sizeLimit}
                onChange={(e) => setSizeLimit(e.target.value)}
                className={inputClass}
                inputMode="numeric"
                placeholder="bytes, e.g. 10485760"
                aria-label="File size limit"
              />
              <span className={`mt-0.5 block ${limitBad ? "text-bad" : "text-muted"}`}>
                {limitBad ? "Give a whole number of bytes above 0, or leave it empty." : "Only sync files within the specified size limit (in bytes)."}
              </span>
            </label>
          </div>
          <label className="mt-2 flex items-start gap-2 border-t border-line pt-2">
            <input type="checkbox" checked={propagate} onChange={(e) => setPropagate(e.target.checked)} className="mt-0.5" aria-label="Propagate deletions" />
            <span>
              <span className="text-soft">Propagate deletions</span>
              <span className="block text-muted">
                A file deleted at the source has its item deleted from the media set too (kept in the path&apos;s history as a deleted version). Off: the item
                stays.
              </span>
            </span>
          </label>
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={run} disabled={busy || (target === "media-set" && (!mediaSetId || limitBad))} className={buttonClass.primary}>
          <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Syncing…" : "Sync media"}
        </button>
        {state.data && (
          <span className="text-muted">
            {state.data.synced} file{state.data.synced === 1 ? "" : "s"} synced{last ? ` · last run ${when(last.at)}` : ""}
            {last?.status && last.status !== "succeeded" ? (
              <span data-media-last-status className={last.status === "failed" ? "text-bad" : "text-warn"}>
                {" "}
                — {last.status === "failed" ? "failed" : "partially failed"}
              </span>
            ) : null}
          </span>
        )}
      </div>
      {result && <p className="text-ok">{result}</p>}
      {error && (
        <p data-media-sync-error className="text-bad">
          {error}
        </p>
      )}
      {summary && <RunSummary run={summary} setName={chosen?.name ?? nameOf(summary.target_media_set_id)} />}
      {!summary && !error && !busy && target === "media-set" && last?.status && last.target_media_set_id && (
        <RunSummary run={last} setName={nameOf(last.target_media_set_id)} heading={`Last run ${when(last.at)}`} />
      )}
      {fileErrors.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-line-2 p-2">
          {fileErrors.map((e) => (
            <li key={e.path} className={e.rejected ? "text-warn" : "text-bad"}>
              <span className="font-mono">{e.path}</span> — {e.rejected ? "rejected: " : "failed: "}
              {clean(e.error)}
            </li>
          ))}
        </ul>
      )}
      {connection.kind === "s3" && <VirtualMediaSet connection={connection} folder={folder} />}
    </div>
  );
}

/** A virtual media set over this S3 connection: items are registered, not copied (read from the source on demand). */
function VirtualMediaSet({ connection, folder }: { connection: DbConnection; folder: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="mt-3 rounded-md border border-line-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className="font-medium text-soft">Virtual media set sync</span>
        <span className="text-muted">— register the folder&apos;s files in a media set that reads them from this source, without copying them.</span>
        <button type="button" onClick={() => setOpen(true)} className={`${buttonClass.secondary} ml-auto`}>
          <Icon name="image" className="h-3.5 w-3.5" /> Create virtual media set…
        </button>
      </div>
      {note && <p className="mt-1 text-ok">{note}</p>}
      {open && (
        <NewMediaSetDialog
          virtualSource={{ connection, folder }}
          onClose={() => setOpen(false)}
          onCreated={async (m) => {
            setOpen(false);
            try {
              const r = await mediaSets.virtualSync(m.id);
              setNote(`Registered ${r.registered} items.`);
            } catch (e) {
              setNote((e as Error).message);
            }
            router.push(`/media-sets/${m.id}`);
          }}
        />
      )}
    </div>
  );
}

function FileExport({ connection }: { connection: DbConnection }) {
  const sources = useLoad("sources-for-file-export", () => api.dataSources.sources());
  const [dataset, setDataset] = useState<(DatasetRef & { label: string }) | null>(null);
  const [picking, setPicking] = useState(false);
  const [path, setPath] = useState("exports/");
  const [format, setFormat] = useState<"parquet" | "csv" | "jsonl">("parquet");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!dataset) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const ref: DatasetRef = dataset.kind === "source" ? { kind: "source", id: dataset.id } : { kind: dataset.kind, item_id: dataset.item_id };
      const target = path.endsWith("/") ? `${path}${dataset.label.replace(/\.(parquet|view)$/i, "")}` : path;
      const r = await fileTransfers.fileExport(connection.id, { dataset: ref, path: target, format });
      setResult(`Wrote ${r.rows.toLocaleString()} rows (${(r.bytes / 1024).toFixed(1)} KB) to ${r.path}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted">Writes a dataset into this source as a file. Turn on &quot;Enable exports to this source&quot; first.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="folder" className="h-3.5 w-3.5" /> Choose in Files…
        </button>
        <select
          value={dataset?.kind === "source" ? dataset.id : ""}
          onChange={(e) => {
            const s = sources.data?.find((x: DataSource) => x.id === e.target.value);
            if (s) setDataset({ kind: "source", id: s.id, label: s.name });
          }}
          className={`${inputClass} w-56`}
        >
          <option value="">…or a data source</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {dataset && <span className="rounded-md bg-ocean/10 px-2 py-1 text-white">{dataset.label}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-soft">Path in the source</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} className={inputClass} placeholder="exports/sales.parquet" />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className={inputClass}>
            <option value="parquet">Parquet</option>
            <option value="csv">CSV</option>
            <option value="jsonl">JSON Lines</option>
          </select>
        </label>
      </div>
      <button type="button" onClick={run} disabled={busy || !dataset || !path.trim()} className={buttonClass.primary}>
        <Icon name={busy ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Exporting…" : "Export file"}
      </button>
      {!connection.exports_enabled && <p className="text-warn">Exports are not enabled for this connection.</p>}
      {result && <p className="text-ok">{result}</p>}
      {error && <p className="text-bad">{error}</p>}
      {picking && (
        <DrivePicker
          title="Choose the dataset to export"
          canPick={(i) => (i.kind === "file" && /\.(parquet|view)$/i.test(i.name) ? null : "File exports read Parquet datasets and Views")}
          onPick={(i) => {
            setDataset(/\.view$/i.test(i.name) ? { kind: "view", item_id: i.id, label: i.name } : { kind: "file", item_id: i.id, label: i.name });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
