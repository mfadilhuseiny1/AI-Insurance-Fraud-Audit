"use client";

import { useRef, useState } from "react";
import { bytes } from "@/lib/format";
import { fitsSpreadsheet, isTabular, isWorkbook, mediaSchemaLabel, type UploadMode } from "@/lib/driveImport";
import { Icon } from "../Icon";
import { buttonClass, Modal } from "./ui";

export type UploadPlan = {
  mode: UploadMode;
  files: File[];
  /** workbooks → structured dataset: one dataset per sheet with data, or the first sheet only */
  sheets: "each" | "first";
  /** name of the new media set / unstructured dataset */
  name: string;
};

type Option = {
  mode: UploadMode;
  title: string;
  text: string;
  /** what it makes and what you can do with it, shown under the chosen option */
  does: string[];
  /** why it is not available for these files (null = available) */
  unavailable: string | null;
};

const stem = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name);

/** Palantir-style "Upload files": pick files, then how they are stored. */
export function UploadDialog({
  initialFiles,
  destination,
  onClose,
  onSubmit,
}: {
  initialFiles: File[];
  destination: string;
  onClose: () => void;
  onSubmit: (plan: UploadPlan) => void;
}) {
  const [files, setFiles] = useState<File[]>(initialFiles);
  const allTabular = files.length > 0 && files.every(isTabular);
  const [mode, setMode] = useState<UploadMode>(allTabular ? "dataset" : "raw");
  const [sheets, setSheets] = useState<"each" | "first">("each");
  const [name, setName] = useState(initialFiles.length === 1 ? stem(initialFiles[0].name) : "");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const add = (more: File[]) => {
    const next = [...files, ...more.filter((m) => !files.some((f) => f.name === m.name && f.size === m.size))];
    setFiles(next);
    // files picked after the dialog opened empty: CSV / Excel / Parquet are converted unless another way was chosen
    if (!files.length && mode === "raw" && next.length && next.every(isTabular)) setMode("dataset");
    if (!name && next.length) setName(next.length === 1 ? stem(next[0].name) : "");
  };
  const remove = (i: number) => setFiles(files.filter((_, j) => j !== i));

  const workbooks = files.filter(isWorkbook).length;
  const options: Option[] = [
    {
      mode: "dataset",
      title: "Convert to a structured dataset (recommended)",
      text: "Recommended for one-time uploads to quickly make this data available in other applications. If this data will be updated regularly, consider uploading to an unstructured dataset instead.",
      does: [
        "Each file becomes a Parquet dataset with a schema: the first row names the columns, types (integer, double, date, timestamp…) are inferred.",
        ...(files.some((f) => f.name.toLowerCase().endsWith(".parquet")) ? ["A Parquet file is already a dataset: it keeps its own columns and types."] : []),
        "Opens in Dataset Preview (preview, column stats, history, Time Travel) and can be read by Pipeline Builder, Code Repositories, SQL Studio and Contour-style analysis.",
        "The upload is recorded as the dataset's first transaction.",
      ],
      unavailable: allTabular ? null : "Only CSV, TSV, Excel and Parquet files can be converted.",
    },
    {
      mode: "spreadsheet",
      title: "Upload as a spreadsheet",
      text: "Importing as a spreadsheet preserves cell references, formulas and formatting. Spreadsheets can also create new datasets.",
      does: [
        "The workbook is kept as it is, with every sheet (a CSV becomes a one-sheet workbook).",
        "Opens in the spreadsheet viewer: sheet tabs, cell grid, formula bar, merged cells.",
        "Any sheet can be turned into a structured dataset later.",
      ],
      unavailable: files.length && files.every(fitsSpreadsheet) ? null : "Only .xlsx, .xlsm, CSV and TSV files (save old .xls files as .xlsx).",
    },
    {
      mode: "mediaSet",
      title: "Upload to a new media set",
      text: "Media sets enable media-specific capabilities for media files (e.g. audio, imagery, video and documents).",
      does: [
        `Creates one media set with the ${mediaSchemaLabel(files)} schema holding every file (other input formats are converted to its primary format).`,
        "Opens in the Media sets app: thumbnails, rendered pages, sheets as JSON, version history per path.",
      ],
      unavailable: null,
    },
    {
      mode: "unstructured",
      title: "Upload to a new unstructured dataset",
      text: "Unstructured datasets can store arbitrary files for processing and analysis. Structured data can be extracted from them with Pipeline Builder or transforms.",
      does: [
        "Creates one schema-less dataset folder that keeps every file exactly as uploaded (Excel workbooks stay .xlsx).",
        "CSV / TSV / JSON files are read in Dataset Preview with an inferred schema; each upload is a transaction, and later uploads append files, so it suits data that is updated regularly.",
        "Pull rows out of Excel and other files in Pipeline Builder: Add data from Files → use the folder as an unstructured dataset → Extract rows from an Excel file.",
      ],
      unavailable: null,
    },
    {
      mode: "raw",
      title: "Upload as a raw file",
      text: "Raw files cannot be used in data pipelines, analyses or models.",
      does: ["Each file is stored as it is, to preview, download or share."],
      unavailable: null,
    },
  ];
  const chosen = options.find((o) => o.mode === mode)!;
  const blocked = !!chosen.unavailable;
  const needsName = mode === "mediaSet" || mode === "unstructured";
  const canUpload = files.length > 0 && !blocked && (!needsName || name.trim().length > 0);

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Icon name="upload" className="h-4 w-4 text-ocean" /> Upload files
        </span>
      }
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto truncate text-xs text-muted">To: {destination}</span>
          <button type="button" onClick={onClose} className={buttonClass.ghost}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canUpload}
            onClick={() => onSubmit({ mode, files, sheets, name: name.trim() })}
            className={buttonClass.primary}
          >
            Upload
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4 text-sm">
        {/* drop zone */}
        <div
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(Array.from(e.dataTransfer.files));
          }}
          className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed py-6 ${
            dragging ? "border-ocean bg-ocean/10" : "border-line-2"
          }`}
        >
          <Icon name="upload" className="h-7 w-7 text-muted" />
          <span className="text-soft">
            Drop files here or{" "}
            <button type="button" onClick={() => input.current?.click()} className="text-ocean hover:underline">
              choose from your computer
            </button>
          </span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) add(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
        </div>

        {/* chosen files */}
        {files.length > 0 && (
          <ul className="max-h-32 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <Icon name={isTabular(f) ? "table" : "doc"} className="h-4 w-4 shrink-0 text-ocean" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs tabular-nums text-muted">{bytes(f.size)}</span>
                <button type="button" onClick={() => remove(i)} className="rounded p-0.5 text-muted hover:text-white" title="Remove">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* how to store them */}
        <div className="space-y-1" role="radiogroup" aria-label="Upload as">
          {options.map((o) => {
            const active = o.mode === mode;
            return (
              <label
                key={o.mode}
                className={`flex cursor-pointer gap-3 rounded-lg px-3 py-2 ${active ? "bg-ocean/10 ring-1 ring-ocean/40" : "hover:bg-panel-2"} ${
                  o.unavailable ? "opacity-50" : ""
                }`}
              >
                <input
                  type="radio"
                  name="upload-mode"
                  checked={active}
                  onChange={() => setMode(o.mode)}
                  className="mt-1 accent-[var(--color-ocean)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{o.title}</span>
                  <span className="block text-xs text-muted">{o.text}</span>
                  {active && o.unavailable && <span className="mt-1 block text-xs text-bad">{o.unavailable}</span>}
                  {active && !o.unavailable && (
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-soft">
                      {o.does.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                  {active && !o.unavailable && o.mode === "dataset" && workbooks > 0 && (
                    <span className="mt-2 flex flex-wrap gap-3 text-xs">
                      {(["each", "first"] as const).map((s) => (
                        <label key={s} className="flex items-center gap-1.5">
                          <input type="radio" name="sheets" checked={sheets === s} onChange={() => setSheets(s)} className="accent-[var(--color-ocean)]" />
                          {s === "each" ? "Every sheet with data becomes its own dataset" : "First sheet only"}
                        </label>
                      ))}
                    </span>
                  )}
                  {active && !o.unavailable && (o.mode === "mediaSet" || o.mode === "unstructured") && (
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={o.mode === "mediaSet" ? "Media set name" : "Dataset name"}
                      className="mt-2 w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean"
                    />
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
