/**
 * Client for the Files & Projects upload options (api/drive_import.py), Palantir's "Upload files" dialog:
 * structured dataset (Parquet), spreadsheet, media set, unstructured dataset, or raw file — plus the spreadsheet
 * viewer's data.
 */
import { API_URL, postWithProgress, uploadDriveFile, type DriveItem } from "./api";

export type UploadMode = "dataset" | "spreadsheet" | "mediaSet" | "unstructured" | "raw";

export const SPREADSHEET_TYPE = "application/vnd.bluesandai.spreadsheet";
export const isSpreadsheet = (i: Pick<DriveItem, "kind" | "content_type">) => i.kind === "file" && i.content_type === SPREADSHEET_TYPE;
export const spreadsheetHref = (id: string) => `/spreadsheets/${id}`;

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
/** Files "Convert to a structured dataset" takes: CSV / TSV / Excel, and Parquet (kept with its own schema, e.g. a dataset downloaded from Files). */
export const isTabular = (f: { name: string }) => ["csv", "tsv", "xlsx", "xlsm", "xls", "parquet"].includes(ext(f.name));
export const isWorkbook = (f: { name: string }) => ["xlsx", "xlsm", "xls"].includes(ext(f.name));
export const fitsSpreadsheet = (f: { name: string }) => ["csv", "tsv", "xlsx", "xlsm"].includes(ext(f.name));
export const extensionOf = ext;

/** The media set schema the server will pick for these files (mirrors drive_import.media_schema). */
export function mediaSchemaLabel(files: { name: string }[]): string {
  const e = new Set(files.map((f) => ext(f.name)).filter(Boolean));
  const groups: [string, string[]][] = [
    ["Image", ["png", "jpg", "jpeg", "bmp", "tiff", "tif", "webp", "gif", "jp2", "nitf"]],
    ["Audio", ["wav", "flac", "mp3", "mp4", "sph", "webm", "ogg", "m4a", "opus"]],
    ["Video", ["mp4", "mov", "ts", "mkv"]],
    ["Document", ["pdf", "docx", "pptx", "txt"]],
    ["Spreadsheet", ["xlsx"]],
    ["Email", ["eml"]],
    ["DICOM", ["dcm", "dicom"]],
  ];
  for (const [label, exts] of groups) if (e.size && [...e].every((x) => exts.includes(x))) return label;
  return "Multimodal (any file format)";
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : (body.detail?.message ?? JSON.stringify(body.detail));
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

type Progress = (fraction: number) => void;
const form = (file: File, fields: Record<string, string | null | undefined>) => {
  const f = new FormData();
  f.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) f.append(k, v);
  return f;
};

export type CreatedDataset = DriveItem & { rows: number; columns: number };

export const driveImport = {
  /** Parquet dataset(s) from a CSV / TSV / Excel file; sheets "each" = one dataset per sheet with data */
  dataset: (file: File, parentId: string | null, sheets: "each" | "first", onProgress: Progress) =>
    postWithProgress<{ items: CreatedDataset[] }>("/api/drive/import/dataset", form(file, { parent_id: parentId, sheets }), onProgress),
  spreadsheet: (file: File, parentId: string | null, onProgress: Progress) =>
    postWithProgress<DriveItem>("/api/drive/import/spreadsheet", form(file, { parent_id: parentId }), onProgress),
  newMediaSet: (name: string, parentId: string | null, extensions: string[]) =>
    req<{ id: string; name: string; schema: string }>("/api/drive/import/media-set", {
      method: "POST",
      json: { name, parent_id: parentId, extensions },
    }),
  mediaSetFile: (mediaSetId: string, file: File, onProgress: Progress) =>
    postWithProgress<unknown>(`/api/media-sets/${mediaSetId}/items`, form(file, {}), onProgress),
  newUnstructured: (name: string, parentId: string | null) =>
    req<{ id: string; name: string }>("/api/drive/import/unstructured", { method: "POST", json: { name, parent_id: parentId } }),
  unstructuredFile: (datasetId: string, file: File, onProgress: Progress) =>
    postWithProgress<unknown>(`/api/drive/import/unstructured/${datasetId}/files`, form(file, {}), onProgress),
  raw: (file: File, parentId: string | null, onProgress: Progress) => uploadDriveFile(file, parentId, onProgress),
  spreadsheetData: (id: string) => req<SpreadsheetData>(`/api/drive/import/spreadsheets/${id}`),
  /** add a dataset to the spreadsheet as a new sheet (header + first 100,000 rows) */
  datasetToSheet: (id: string, datasetId: string) =>
    req<{ sheet: string; rows: number; total_rows: number; truncated: boolean }>(`/api/drive/import/spreadsheets/${id}/sheets`, {
      method: "POST",
      json: { dataset_id: datasetId },
    }),
  sheetToDataset: (id: string, sheet: string, name?: string) =>
    req<CreatedDataset>(`/api/drive/import/spreadsheets/${id}/dataset`, { method: "POST", json: { sheet, name: name || null } }),
};

/** A cell: shown value, formula (when it has one) and type (n number, s text, d date, b boolean, err an error such as
 * #NAME?, e a formula with no result). `calc`: the file had no saved result, so the value was calculated on the server. */
export type Cell = { v: string | null; f?: string; t: "n" | "s" | "d" | "b" | "err" | "e"; calc?: boolean } | null;
export type Sheet = {
  name: string;
  rows: Cell[][];
  max_row: number;
  max_column: number;
  truncated: boolean;
  merged: string[];
  widths: (number | null)[];
  frozen: string | null;
};
export type SpreadsheetData = { item: DriveItem; sheets: Sheet[] };
