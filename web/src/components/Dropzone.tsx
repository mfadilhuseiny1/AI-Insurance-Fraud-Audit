"use client";

import { useRef, useState } from "react";
import { api, uploadFile, type DriveItem, type FileMeta } from "@/lib/api";
import { DrivePicker } from "./DrivePicker";
import { Icon } from "./Icon";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp";
const MAX_MB = 50; // also enforced by the API

/** null if a Files-tab item can be parsed, else why not */
export function unparseable(item: DriveItem): string | null {
  const ext = "." + (item.name.split(".").pop() ?? "").toLowerCase();
  if (!item.name.includes(".") || !ACCEPT.split(",").includes(ext)) return "Not a PDF or image";
  if (item.size > MAX_MB * 1024 * 1024) return `Over ${MAX_MB} MB`;
  return null;
}

/**
 * Upload from the computer (drop or browse, any number of files) or pick from Files (tick any
 * number). One file opens it for parsing (`onUploaded`); several go to `onBatch`, if given.
 * `compact`: a shorter drop area that doesn't fill the page, for when content follows it.
 */
export function Dropzone({
  onUploaded,
  onBatch,
  compact,
}: {
  onUploaded: (meta: FileMeta) => void;
  onBatch?: (metas: FileMeta[]) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // several files: which one is uploading / opening (1-based) and how many
  const [step, setStep] = useState<{ n: number; of: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [preparing, setPreparing] = useState<string | null>(null); // name of the drive file being fetched

  const done = (metas: FileMeta[]) => {
    if (metas.length === 1) onUploaded(metas[0]);
    else if (metas.length > 1) onBatch?.(metas);
  };

  const upload = async (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const allowed = onBatch ? files : files.slice(0, 1);
    const big = allowed.filter((f) => f.size > MAX_MB * 1024 * 1024);
    const wrong = allowed.filter((f) => !ACCEPT.split(",").includes("." + (f.name.split(".").pop() ?? "").toLowerCase()));
    const ok = allowed.filter((f) => !big.includes(f) && !wrong.includes(f));
    const skipped = [
      ...big.map((f) => `${f.name} is ${(f.size / 1024 ** 2).toFixed(1)} MB (max ${MAX_MB} MB)`),
      ...wrong.map((f) => `${f.name} is not a PDF or image`),
    ];
    setError(skipped.length ? `Skipped: ${skipped.join("; ")}.` : null);
    if (!ok.length) return;
    const metas: FileMeta[] = [];
    try {
      for (const [i, f] of ok.entries()) {
        setStep(ok.length > 1 ? { n: i + 1, of: ok.length, name: f.name } : null);
        setProgress(0);
        metas.push(await uploadFile(f, setProgress));
      }
    } catch (e) {
      setError(`${(e as Error).message}${metas.length ? ` (${metas.length} of ${ok.length} uploaded)` : ""}`);
    } finally {
      setProgress(null);
      setStep(null);
    }
    done(metas);
  };

  const pickDriveFiles = async (items: DriveItem[]) => {
    setPicking(false);
    setError(null);
    const metas: FileMeta[] = [];
    try {
      for (const [i, item] of items.entries()) {
        setPreparing(items.length > 1 ? `${item.name} (${i + 1} of ${items.length})` : item.name);
        metas.push(await api.fileFromDrive(item.id));
      }
    } catch (e) {
      setError(`${(e as Error).message}${metas.length ? ` (${metas.length} of ${items.length} opened)` : ""}`);
    } finally {
      setPreparing(null);
    }
    done(metas);
  };

  const busy = progress !== null || preparing !== null;

  return (
    <div className={`flex flex-col items-center justify-center ${compact ? "px-8 pb-4 pt-8" : "flex-1 p-8"}`}>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          upload(e.dataTransfer.files);
        }}
        disabled={busy}
        className={`flex ${compact ? "h-48" : "h-80"} w-full max-w-3xl flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-colors ${
          dragging ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/60 hover:bg-panel/60"
        }`}
      >
        {preparing !== null ? (
          <div className="flex items-center gap-2 text-sm text-soft">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />
            Opening {preparing} from Files…
          </div>
        ) : progress === null ? (
          <>
            <span className="mb-4 rounded-full bg-panel-2 p-3 text-ocean ring-1 ring-line-2">
              <Icon name="upload" className="h-6 w-6" />
            </span>
            <span className="text-lg font-semibold">Drop {onBatch ? "files" : "a file"} here to upload</span>
            <span className="mt-1 text-sm text-muted">
              or click to browse · {onBatch ? "PDFs or images, several make a batch" : "one PDF or image"} · max {MAX_MB} MB each
            </span>
          </>
        ) : (
          <div className="w-72">
            <div className="mb-2 flex justify-between gap-3 text-sm">
              <span className="truncate">{step ? `Uploading ${step.n} of ${step.of}: ${step.name}` : "Uploading…"}</span>
              <span className="tabular-nums text-muted">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-ocean transition-all" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple={!!onBatch}
        className="hidden"
        onChange={(e) => {
          upload(e.target.files);
          e.target.value = ""; // choosing the same files again still fires
        }}
      />
      <div className="mt-4 flex w-full max-w-3xl items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        onClick={() => setPicking(true)}
        disabled={busy}
        className="mt-4 flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-4 py-2 text-sm hover:border-ocean hover:text-ocean disabled:opacity-50"
      >
        <Icon name="folder" className="h-4 w-4 text-sand" /> Choose from Files
      </button>
      {picking && (
        <DrivePicker
          title={onBatch ? "Choose files to parse" : "Choose a file to parse"}
          canPick={unparseable}
          onPick={(item) => pickDriveFiles([item])}
          onPickMany={onBatch ? pickDriveFiles : undefined}
          onClose={() => setPicking(false)}
        />
      )}
      {error && (
        <p className="mt-4 flex items-center gap-2 text-sm text-bad">
          <Icon name="alert" /> {error}
        </p>
      )}
      <div className="mt-6 flex gap-6 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <Icon name="doc" className="h-3.5 w-3.5" /> PDF (scanned or digital)
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="layers" className="h-3.5 w-3.5" /> Images (PNG, JPG, TIFF, WebP)
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="globe" className="h-3.5 w-3.5" /> Arabic, Indonesian, English…
        </span>
      </div>
    </div>
  );
}
