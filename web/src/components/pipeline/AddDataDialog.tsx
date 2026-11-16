"use client";

import { useEffect, useRef, useState } from "react";
import { api, API_URL, uploadDriveFile, type DataSource, type DbConnection, type DriveItem, type Job, type SourceTable } from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { hashKey } from "@/lib/llm";
import {
  bytesToBase64,
  COL_TYPES,
  datasetName,
  filesTable,
  fromRecords,
  readDataFile,
  unstructuredReason,
  type ColType,
  type DataFile,
  type DatasetRef,
  type DriveLocation,
  type GeneratorConfig,
  type NodeResult,
  type PipelineNode,
  type Table,
} from "@/lib/pipeline";
import { Icon, type IconName } from "../Icon";
import { buttonClass, inputClass, Modal } from "./Modal";
import { DATA_FILE, ICEBERG_TYPE, readDriveTable } from "@/lib/deployed";
import { DrivePicker } from "../DrivePicker";
import { approx, ConnectorLogo } from "../datasource/ConnectorLogo";
import { DataSourceWizard } from "../datasource/DataSourceWizard";
import { EMPTY_MANUAL, ManualDataEditor } from "./ManualData";
import { StreamDialog } from "./Streams";

/** `ref`: where builds re-read the data; `media`: a media set; `generator`: how notional data was generated */
export type NewDataset = { name: string; origin: string; table: Table; ref?: DatasetRef; media?: boolean; generator?: GeneratorConfig };
export type AddMode = "menu" | "files" | "upload" | "media" | "database" | "sources" | "virtual" | "stream" | "parsed" | "manual";

export const ADD_OPTIONS: { mode: Exclude<AddMode, "menu">; icon: IconName; label: string; hint: string }[] = [
  { mode: "upload", icon: "upload", label: "Upload file", hint: "CSV, TSV, JSON, Excel or any file — as structured datasets, a media set or an unstructured dataset." },
  { mode: "files", icon: "table", label: "Add data from Files", hint: "Datasets in Files & Projects (Parquet, CSV, JSON, Excel; builds read their latest version), or a folder as an unstructured dataset." },
  { mode: "media", icon: "image", label: "Add a media set", hint: "PDFs and images in a Files folder, with thumbnails — extract text, run vision LLMs." },
  { mode: "database", icon: "plug", label: "Connect database", hint: "PostgreSQL, MySQL, SQL Server and more: browse, preview and ingest a table." },
  { mode: "sources", icon: "database", label: "From a data source", hint: "A table already ingested from a connected database (incremental or snapshot)." },
  { mode: "virtual", icon: "server", label: "Add a virtual table", hint: "A table read from a database each build, without ingesting it." },
  { mode: "stream", icon: "wave", label: "Add a stream", hint: "Records pushed with an API call; streaming pipelines transform them as they arrive." },
  { mode: "parsed", icon: "parse", label: "Add parsed data", hint: "Elements or RAG chunks from a finished parse job." },
  { mode: "manual", icon: "keyboard", label: "Manually enter data", hint: "Type a table, paste CSV, or generate notional data." },
];

const MEDIA_EXT = /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?)$/i;
const BINARY_EXT = /\.(xlsx|xlsm|xltx|xltm|xls|xlt|zip|pdf|png|jpe?g|gif|webp|bmp|tiff?|shp|dbf|shx|parquet)$/i;
const EXCEL_EXT = /\.(xlsx|xlsm|xltx|xltm|xls|xlt)$/i;

export function AddDataDialog({
  mode: initial,
  files,
  onClose,
  onAdd,
  nodes = [],
  result = () => ({ error: "" }),
  location,
  sampleRows,
}: {
  mode: AddMode;
  /** files dropped on the graph: the upload dialog opens with them */
  files?: File[];
  onClose: () => void;
  onAdd: (datasets: NewDataset[]) => void;
  /** the pipeline's nodes and results (foreign keys of generated data) */
  nodes?: PipelineNode[];
  result?: (ref: string) => NodeResult;
  /** the pipeline's folder: media sets are uploaded there */
  location?: DriveLocation;
  /** keep only the first rows of each Files dataset (a DuckDB local pipeline previews a sample) */
  sampleRows?: number;
}) {
  const [mode, setMode] = useState<AddMode>(initial);
  const title = mode === "menu" ? "Add data" : ADD_OPTIONS.find((o) => o.mode === mode)!.label;
  // the Files picker, the database wizard and the manual editor are dialogs of their own
  if (mode === "files") return <FromFiles onAdd={onAdd} onClose={onClose} sampleRows={sampleRows} />;
  if (mode === "media") return <MediaFromFiles onAdd={onAdd} onClose={onClose} />;
  if (mode === "stream")
    return (
      <StreamDialog
        onClose={onClose}
        onUse={(s, preview) => onAdd([{ name: s.name, origin: `Stream ${s.name} (records pushed to ${s.id})`, table: preview, ref: { kind: "stream", streamId: s.id } }])}
        onUseIngest={(s, preview) => onAdd([{ name: s.name, origin: `Ingest stream ${s.name} (Streaming app)`, table: preview, ref: { kind: "ingest", streamId: s.id } }])}
      />
    );
  if (mode === "database") return <DataSourceWizard onClose={onClose} onUse={async (s) => onAdd([await sourceDataset(s)])} useLabel="Add to pipeline" />;
  if (mode === "manual")
    return (
      <ManualDataEditor
        initial={{ name: "Manual data", table: EMPTY_MANUAL }}
        nodes={nodes}
        result={result}
        onClose={onClose}
        onSave={(d) => onAdd([{ name: d.name, origin: "Entered manually", table: d.table, generator: d.generator }])}
      />
    );

  return (
    <Modal title={title} icon={mode === "menu" ? "plus" : ADD_OPTIONS.find((o) => o.mode === mode)!.icon} onClose={onClose} wide={mode === "virtual"}>
      {mode === "menu" && (
        <div className="p-2">
          {ADD_OPTIONS.map((o) => (
            <button key={o.mode} type="button" onClick={() => setMode(o.mode)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-panel-2">
              <Icon name={o.icon} className="h-4 w-4 text-ocean" />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-muted">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {mode === "upload" && <Upload initial={files} onAdd={onAdd} location={location} />}
      {mode === "sources" && <FromSources onAdd={onAdd} onConnect={() => setMode("database")} />}
      {mode === "virtual" && <VirtualTable onAdd={onAdd} />}
      {mode === "parsed" && <Parsed onAdd={onAdd} />}
    </Modal>
  );
}

type Picked = { file: File; text?: string; base64?: boolean; table?: Table; error?: string; reason?: string | null };
type UploadAs = "structured" | "media" | "files";

const MAX_FILE_MB = 20;

const UPLOAD_AS: { id: UploadAs; label: string; hint: string }[] = [
  {
    id: "structured",
    label: "Upload as individual structured datasets (recommended)",
    hint: "Datasets are the most basic representation of tabular data: each file (CSV, TSV, JSON, Excel) becomes rows and columns that can be transformed right away.",
  },
  {
    id: "media",
    label: "Upload to a new media set",
    hint: "Media sets hold media files (imagery, PDF documents, audio, video) with thumbnails and media transforms: extract text, OCR, vision LLMs.",
  },
  {
    id: "files",
    label: "Upload to a new unstructured dataset",
    hint: 'Unstructured datasets store the files as they are. Pull rows out of them later with an "Extract rows from …" or "Parse XML" transform.',
  },
];

/** An Excel workbook as a table, parsed by the API. */
async function parseExcel(name: string, base64: string): Promise<Table> {
  const res = await fetch(`${API_URL}/api/pipeline/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ calls: [{ key: `parse:excel:${hashKey(base64)}`, format: "excel", name, base64 }] }),
  });
  if (!res.ok) throw new Error(`Could not read the workbook (${res.status})`);
  const body = (await res.json()) as { results: Record<string, { value?: Table; error?: string }> };
  const r = Object.values(body.results)[0];
  if (!r || r.error || !r.value) throw new Error(r?.error ?? "Could not read the workbook");
  return { columns: r.value.columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType })), rows: r.value.rows };
}

async function readPicked(file: File): Promise<Picked> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) return { file, error: `Files up to ${MAX_FILE_MB} MB can be used in the browser` };
  if (BINARY_EXT.test(file.name)) {
    const b64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    if (EXCEL_EXT.test(file.name)) {
      try {
        return { file, text: b64, base64: true, reason: null, table: await parseExcel(file.name, b64) };
      } catch (e) {
        return { file, text: b64, base64: true, reason: (e as Error).message };
      }
    }
    return { file, text: b64, base64: true, reason: MEDIA_EXT.test(file.name) ? "a media file" : "a binary file" };
  }
  const text = await file.text();
  const reason = unstructuredReason(file.name, text);
  if (reason) return { file, text, reason };
  try {
    return { file, text, reason: null, table: await readDataFile(file) };
  } catch (e) {
    return { file, text, reason: (e as Error).message };
  }
}

function Upload({ initial, onAdd, location }: { initial?: File[]; onAdd: (d: NewDataset[]) => void; location?: DriveLocation }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const [choice, setChoice] = useState<UploadAs>("structured");
  const [setName, setSetName] = useState("Media set");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (list: FileList | File[] | null | undefined) => {
    if (!list?.length) return;
    const picked = await Promise.all([...list].map(readPicked));
    setFiles((prev) => [...prev, ...picked]);
    if (picked.length && picked.every((p) => MEDIA_EXT.test(p.file.name))) setChoice("media");
  };

  // files dropped on the graph arrive here first, so the upload kind is still chosen
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initial?.length) return;
    seeded.current = true;
    pick(initial);
  }, [initial]);

  const usable = files.filter((f) => f.text !== undefined);
  // one file without rows and columns makes the whole upload unstructured
  const blockers = usable.filter((f) => f.reason);
  const structuredOff = blockers.length > 0;
  const mediaOff = usable.some((f) => !MEDIA_EXT.test(f.file.name));
  const uploadAs: UploadAs = structuredOff && choice === "structured" ? (mediaOff ? "files" : "media") : mediaOff && choice === "media" ? "files" : choice;
  const ready = uploadAs === "structured" ? usable.filter((f) => f.table) : usable;

  const add = async () => {
    setError(null);
    if (uploadAs === "structured") {
      onAdd(ready.map((f) => ({ name: datasetName(f.file.name), origin: `Uploaded ${f.file.name}`, table: f.table! })));
      return;
    }
    if (uploadAs === "media") {
      // the files go into a folder of their own in the pipeline's folder; the media set refers to them
      try {
        const folder = await api.drive.createFolder(setName.trim() || "Media set", location?.id ?? null);
        const items: DriveItem[] = [];
        for (const [i, f] of ready.entries()) {
          setProgress(`Uploading ${i + 1} / ${ready.length}: ${f.file.name}`);
          items.push(await uploadDriveFile(f.file, folder.id, () => {}));
        }
        onAdd([mediaDataset(setName.trim() || "Media set", items, folder.id, `Uploaded media set (${items.length} files) in ${location?.name ?? "Files & Projects"} / ${folder.name}`)]);
      } catch (e) {
        setError((e as Error).message);
        setProgress(null);
      }
      return;
    }
    const raw: DataFile[] = ready.map((f) => ({ path: f.file.name, size: f.file.size, text: f.text!, ...(f.base64 ? { encoding: "base64" as const } : {}) }));
    onAdd([
      {
        name: raw.length === 1 ? datasetName(raw[0].path) : "files",
        origin: `Uploaded ${raw.map((f) => f.path).join(", ")} as an unstructured dataset`,
        table: filesTable(raw),
      },
    ]);
  };

  return (
    <div className="space-y-3 p-4">
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
          pick(e.dataTransfer.files);
        }}
        className={`flex w-full flex-col items-center rounded-lg border-2 border-dashed py-8 text-sm ${dragging ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/60"}`}
      >
        <Icon name="upload" className="mb-2 h-6 w-6 text-ocean" />
        <span>
          Drop files here or <span className="text-ocean">choose from your computer</span>
        </span>
        <span className="mt-1 text-xs text-muted">CSV, TSV, JSON, JSON Lines, Excel, XML, PDFs, images or any file · up to {MAX_FILE_MB} MB each</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
          {files.map((f, i) => {
            const bad = f.text === undefined;
            const note = bad
              ? f.error
              : uploadAs === "structured"
                ? `${f.table!.rows.length.toLocaleString()} rows · ${f.table!.columns.length} columns`
                : uploadAs === "media"
                  ? "Media item"
                  : f.reason
                    ? `Unstructured · ${f.reason}`
                    : "Raw file";
            return (
              <li key={i} className="flex items-center gap-2 px-3 py-2">
                <Icon
                  name={bad ? "alert" : uploadAs === "structured" ? "table" : uploadAs === "media" ? "image" : "doc"}
                  className={`h-4 w-4 shrink-0 ${bad ? "text-bad" : f.reason ? "text-sand" : "text-ocean"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{f.file.name}</span>
                  <span className={`block truncate text-xs ${bad ? "text-bad" : "text-muted"}`} title={note}>
                    {note}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted">{bytes(f.file.size)}</span>
                <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-white">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-1">
        {UPLOAD_AS.map((o) => {
          const off = (o.id === "structured" && structuredOff) || (o.id === "media" && mediaOff && files.length > 0);
          return (
            <label key={o.id} className={`flex items-start gap-2.5 rounded-lg p-2 ${off ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-panel-2"}`}>
              <input type="radio" name="upload-as" disabled={off} checked={uploadAs === o.id} onChange={() => setChoice(o.id)} className="mt-0.5 accent-[var(--color-ocean)]" />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-muted">{o.hint}</span>
                {o.id === "structured" && structuredOff && (
                  <span className="mt-0.5 block text-xs text-sand">
                    Not available: {blockers.length === 1 ? `${blockers[0].file.name} has no rows and columns (${blockers[0].reason}).` : `${blockers.length} files have no rows and columns.`}
                  </span>
                )}
                {o.id === "media" && off && <span className="mt-0.5 block text-xs text-sand">Media sets hold PDFs and images only.</span>}
              </span>
            </label>
          );
        })}
      </div>
      {uploadAs === "media" && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Media set name (a folder in {location?.name ?? "Files & Projects"})</span>
          <input value={setName} onChange={(e) => setSetName(e.target.value)} className={inputClass} />
        </label>
      )}
      {progress && <p className="text-xs text-muted">{progress}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex justify-end">
        <button type="button" disabled={!ready.length || !!progress} onClick={add} className={buttonClass.primary}>
          <Icon name="upload" className="h-3.5 w-3.5" />
          {uploadAs === "files"
            ? `Upload ${ready.length || ""} file${ready.length === 1 ? "" : "s"} as unstructured`
            : uploadAs === "media"
              ? `Upload ${ready.length || ""} to a media set`
              : `Upload ${ready.length > 1 ? `${ready.length} datasets` : "dataset"}`}
        </button>
      </div>
    </div>
  );
}

/** A media set: one row per Files item (mediaReference = item id). */
export function mediaDataset(name: string, items: DriveItem[], folderId: string | null, origin: string): NewDataset {
  return {
    name,
    origin,
    media: true,
    ref: { kind: "media", folderId },
    table: {
      columns: [
        { name: "mediaReference", type: "String" },
        { name: "path", type: "String" },
        { name: "mediaType", type: "String" },
        { name: "size", type: "Long" },
      ],
      rows: items.map((i) => ({ mediaReference: i.id, path: i.name, mediaType: i.content_type ?? mediaType(i.name), size: i.size ?? null })),
    },
  };
}
const mediaType = (name: string) =>
  /\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.gif$/i.test(name) ? "image/gif" : /\.webp$/i.test(name) ? "image/webp" : "application/octet-stream";

/** PDFs and images of the Files tab (or a whole folder) as a media set. */
function MediaFromFiles({ onAdd, onClose }: { onAdd: (d: NewDataset[]) => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asFolder, setAsFolder] = useState(false);
  if (asFolder)
    return (
      <DrivePicker
        title="Media set folder — every PDF and image in it"
        folder={{
          action: busy ? "Reading…" : "Use this folder",
          busy,
          extra: error ? <span className="text-xs text-bad">{error}</span> : undefined,
          onPick: async (folder) => {
            setBusy(true);
            setError(null);
            try {
              const f = await api.drive.folder(folder.id);
              const items = f.items.filter((i) => i.kind === "file" && MEDIA_EXT.test(i.name));
              if (!items.length) throw new Error("The folder has no PDFs or images");
              onAdd([mediaDataset(folder.name, items, folder.id, `Files & Projects / ${folder.name} (media set, ${items.length} items)`)]);
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          },
        }}
        onClose={onClose}
      />
    );
  return (
    <>
      <div className="fixed left-1/2 top-4 z-[60] -translate-x-1/2">
        <button type="button" onClick={() => setAsFolder(true)} className="rounded-full bg-sand px-4 py-2 text-sm font-medium text-ink shadow-xl">
          <Icon name="folder" className="mr-1.5 inline h-4 w-4" /> Use a whole folder instead
        </button>
      </div>
      <DrivePicker
        title="Add a media set — tick PDFs and images"
        canPick={(item) => (MEDIA_EXT.test(item.name) ? null : "Media sets hold PDFs and images")}
        onPick={(item) => onAdd([mediaDataset(datasetName(item.name), [item], item.parent_id ?? null, `Files & Projects · ${item.name}`)])}
        onPickMany={(items) => items.length && onAdd([mediaDataset(items.length === 1 ? datasetName(items[0].name) : "Media set", items, items[0].parent_id ?? null, `Files & Projects · ${items.length} media items`)])}
        onClose={onClose}
      />
    </>
  );
}

function Parsed({ onAdd }: { onAdd: (d: NewDataset[]) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"elements" | "chunks">("elements");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .jobs()
      .then((js) => setJobs(js.filter((j) => j.status === "completed")))
      .catch((e: Error) => setError(e.message));
  }, []);

  const add = async (job: Job) => {
    setBusy(job.id);
    setError(null);
    try {
      const records =
        kind === "elements"
          ? (await api.result(job.id)).map((el) => ({
              element_id: el.element_id,
              type: el.type,
              text: el.text,
              page_number: el.metadata.page_number,
              languages: el.metadata.languages?.join(", ") ?? null,
              is_footnote: el.metadata.is_footnote ?? false,
              parent_id: el.metadata.parent_id ?? null,
              text_as_html: el.metadata.text_as_html ?? null,
            }))
          : (await api.chunks(job.id)).map((c) => ({
              chunk_index: c.index,
              text: c.text,
              markdown: c.markdown,
              page_numbers: c.page_numbers.join(", "),
              languages: c.languages.join(", "),
              element_types: c.element_types.join(", "),
            }));
      if (!records.length) throw new Error("This job has no " + kind);
      onAdd([{ name: `${datasetName(job.file_name)} ${kind}`, origin: `Parse job ${job.id} (${job.tier_label})`, table: fromRecords(records) }]);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex gap-1 rounded-lg bg-ink p-1 text-sm">
        {(["elements", "chunks"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`flex-1 rounded-md py-1.5 ${kind === k ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted"}`}>
            {k === "elements" ? "Elements" : "RAG chunks"}
          </button>
        ))}
      </div>
      {error && (
        <p className="flex items-center gap-2 text-sm text-bad">
          <Icon name="alert" /> {error}
        </p>
      )}
      {jobs === null && !error ? (
        <p className="py-6 text-center text-sm text-muted">Loading jobs…</p>
      ) : jobs?.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No completed parse jobs yet.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
          {jobs?.map((j) => (
            <li key={j.id}>
              <button type="button" disabled={busy !== null} onClick={() => add(j)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-panel-2 disabled:opacity-50">
                <Icon name="doc" className="h-4 w-4 text-sand" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{j.file_name}</span>
                  <span className="block text-xs text-muted">
                    {j.tier_label} · pages {j.page_from}–{j.page_to} · {j.elements.toLocaleString()} elements
                  </span>
                </span>
                <span className="text-xs text-muted">{busy === j.id ? "Adding…" : when(j.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Datasets in the Files tab: tick several (add to selection), then add them. Builds read their latest version. */
function FromFiles({ onAdd, onClose, sampleRows }: { onAdd: (d: NewDataset[]) => void; onClose: () => void; sampleRows?: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = async (items: DriveItem[]) => {
    const out: NewDataset[] = [];
    setError(null);
    for (const item of items) {
      setBusy(item.name);
      try {
        const table = EXCEL_EXT.test(item.name) ? await readExcelItem(item) : await readDriveTable(item, sampleRows);
        out.push({
          name: datasetName(item.name),
          origin: `Files & Projects / ${[...(item.path ?? []).map((x) => x.name), item.name].join(" / ")}`,
          table,
          ref: { kind: "drive", itemId: item.id },
        });
      } catch (e) {
        setError(`${item.name}: ${(e as Error).message}`);
        setBusy(null);
        return;
      }
    }
    onAdd(out);
  };
  return (
    <>
      {(busy || error) && (
        <p className={`fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg bg-panel px-4 py-2 text-sm shadow-xl ${error ? "text-bad" : "text-muted"}`}>
          <Icon name={error ? "alert" : "refresh"} /> {error ?? `Reading ${busy}…`}
        </p>
      )}
      <DrivePicker
        title="Add datasets from Files — tick several, then add them"
        canPick={(item) => (DATA_FILE.test(item.name) || EXCEL_EXT.test(item.name) || item.content_type === ICEBERG_TYPE ? null : "Choose an Iceberg table or a .parquet, .csv, .tsv, .json or Excel file")}
        onPick={(item) => read([item])}
        onPickMany={read}
        folder={{
          action: busy ? "Reading…" : "Use this folder as an unstructured dataset",
          busy: busy !== null,
          onPick: async (folder) => {
            if (!folder.id) return setError("Open a folder first: the top level cannot be used as a dataset");
            setError(null);
            setBusy(folder.name);
            try {
              const raw = await readFolderFiles(folder.id);
              if (!raw.length) throw new Error("The folder has no files");
              onAdd([
                {
                  name: datasetName(folder.name),
                  origin: `Files & Projects / ${folder.name} (unstructured dataset, ${raw.length} files)`,
                  table: filesTable(raw),
                },
              ]);
            } catch (e) {
              setError(`${folder.name}: ${(e as Error).message}`);
              setBusy(null);
            }
          },
        }}
        onClose={onClose}
      />
    </>
  );
}

// what a folder read as an unstructured dataset may hold at most (its files travel into the browser)
const MAX_FOLDER_BYTES = 100 * 1024 * 1024;

/** Every file under a Files folder (subfolders too, as "sub/name.xlsx") as the raw files of an unstructured dataset:
 * the files as they are, for "Extract rows from …" / "Parse XML" steps (Files → Upload to a new unstructured dataset). */
async function readFolderFiles(folderId: string, prefix = "", budget = { left: MAX_FOLDER_BYTES }): Promise<DataFile[]> {
  const listing = await api.drive.folder(folderId);
  const out: DataFile[] = [];
  for (const item of listing.items) {
    if (item.kind !== "file") {
      out.push(...(await readFolderFiles(item.id, `${prefix}${item.name}/`, budget)));
      continue;
    }
    budget.left -= item.size;
    if (budget.left < 0) throw new Error(`The folder holds more than ${MAX_FOLDER_BYTES / 2 ** 20} MB of files: choose a smaller folder`);
    const res = await fetch(`${API_URL}/api/drive/items/${item.id}/content`);
    if (!res.ok) throw new Error(`Could not read "${item.name}" (${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    const binary = BINARY_EXT.test(item.name) || MEDIA_EXT.test(item.name);
    out.push({
      path: prefix + item.name,
      size: data.length,
      text: binary ? bytesToBase64(data) : new TextDecoder().decode(data),
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }
  return out;
}

async function readExcelItem(item: DriveItem): Promise<Table> {
  const res = await fetch(`${API_URL}/api/drive/items/${item.id}/content`);
  if (!res.ok) throw new Error(`Could not read "${item.name}" (${res.status})`);
  return parseExcel(item.name, bytesToBase64(new Uint8Array(await res.arrayBuffer())));
}

/** A data source's ingested Parquet as a pipeline dataset. */
async function sourceDataset(s: DataSource): Promise<NewDataset> {
  const t = await api.dataSources.table(s.id);
  return {
    name: s.name,
    origin: `Data source: ${s.connection.name} · ${s.schema}.${s.table} (${s.mode === "incremental" ? "incremental" : "snapshot"})`,
    table: { columns: t.columns as Table["columns"], rows: t.rows as Table["rows"] },
    ref: { kind: "datasource", id: s.id },
  };
}

function FromSources({ onAdd, onConnect }: { onAdd: (d: NewDataset[]) => void; onConnect: () => void }) {
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.dataSources
      .sources()
      .then((s) => live && setSources(s))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const pick = async (s: DataSource) => {
    setBusy(s.id);
    setError(null);
    try {
      onAdd([await sourceDataset(s)]);
    } catch (e) {
      setError(`${s.name}: ${(e as Error).message}`);
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2 p-3">
      {error && (
        <p className="flex items-start gap-2 rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
          <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {sources === null && !error && <p className="p-3 text-sm text-muted">Loading…</p>}
      {sources?.length === 0 && (
        <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted">
          No data sources yet.
          <button type="button" onClick={onConnect} className={buttonClass.primary}>
            <Icon name="plug" className="h-3.5 w-3.5" /> Connect a database
          </button>
        </div>
      )}
      {sources?.map((s) => {
        const ready = s.state.rows_total > 0 || s.last_run?.status === "completed";
        return (
          <button
            key={s.id}
            type="button"
            disabled={!ready || !!busy}
            onClick={() => pick(s)}
            title={ready ? undefined : "Run the data source first (Data Sources)"}
            className="flex w-full items-center gap-3 rounded-lg border border-line-2 p-3 text-left hover:border-ocean/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ConnectorLogo kind={s.connection.kind} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.name}</span>
              <span className="block truncate text-xs text-muted">
                {s.connection.name} · {s.schema}.{s.table} · {s.mode === "incremental" ? "incremental" : "snapshot"}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted">{busy === s.id ? "Reading…" : ready ? `${approx(s.state.rows_total)} rows` : "Not run yet"}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A virtual table: a pointer to a table in a database; previews read up to 1,000 rows, builds read it all. */
function VirtualTable({ onAdd }: { onAdd: (d: NewDataset[]) => void }) {
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [conn, setConn] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.dataSources.connections().then(setConns, (e: Error) => setError(e.message));
  }, []);
  const pickConn = async (id: string) => {
    setConn(id);
    setTables([]);
    if (!id) return;
    try {
      const d = await api.dataSources.databases(id);
      setDbs(d);
      await pickDb(id, d[0] ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pickDb = async (id: string, database: string) => {
    setDb(database);
    if (!database) return;
    try {
      const s = await api.dataSources.schemas(id, database);
      setSchemas(s);
      await pickSchema(id, database, s.includes("public") ? "public" : (s[0] ?? ""));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pickSchema = async (id: string, database: string, sc: string) => {
    setSchema(sc);
    if (!sc) return;
    try {
      setTables(await api.dataSources.tables(id, database, sc));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const c = conns?.find((x) => x.id === conn);
  const add = async (t: SourceTable) => {
    setBusy(t.name);
    setError(null);
    try {
      const pv = await api.dataSources.preview(conn, db, schema, t.name);
      onAdd([
        {
          name: t.name,
          origin: `Virtual table: ${c?.name} · ${db}.${schema}.${t.name} (preview of ${pv.rows.length.toLocaleString()} rows; builds read the table)`,
          table: { columns: pv.columns.map((x) => ({ name: x.name, type: (COL_TYPES.includes(x.type as ColType) ? x.type : "String") as ColType })), rows: pv.rows as Table["rows"] },
          ref: { kind: "virtual", connectionId: conn, connectionName: c?.name ?? "", database: db, schema, table: t.name },
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3 p-4 text-sm">
      <p className="text-xs text-muted">A virtual table points to a table in a source outside the platform and uses it without ingesting it. Previews read its first 1,000 rows; deploys read the whole table.</p>
      {error && <p className="rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">{error}</p>}
      <div className="grid grid-cols-3 gap-2">
        <select value={conn} onChange={(e) => pickConn(e.target.value)} className={inputClass} aria-label="Source">
          <option value="">{conns === null ? "Loading…" : conns.length ? "Source…" : "No connections"}</option>
          {conns?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.kind_name})
            </option>
          ))}
        </select>
        <select value={db} onChange={(e) => pickDb(conn, e.target.value)} className={inputClass} aria-label="Database" disabled={!dbs.length}>
          {dbs.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select value={schema} onChange={(e) => pickSchema(conn, db, e.target.value)} className={inputClass} aria-label="Schema" disabled={!schemas.length}>
          {schemas.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {tables.map((t) => (
          <li key={t.name}>
            <button type="button" disabled={!!busy} onClick={() => add(t)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel-2 disabled:opacity-50">
              <Icon name="server" className="h-4 w-4 text-ocean" />
              <span className="flex-1 truncate">{t.name}</span>
              <span className="text-xs text-muted">{busy === t.name ? "Reading…" : t.rows !== null ? `${approx(t.rows)} rows` : t.kind}</span>
            </button>
          </li>
        ))}
        {conn && !tables.length && <li className="px-3 py-4 text-center text-xs text-muted">No tables here.</li>}
      </ul>
    </div>
  );
}
