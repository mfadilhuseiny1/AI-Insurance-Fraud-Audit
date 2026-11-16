"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { driveContentUrl, type DriveItem } from "@/lib/api";
import { datasetHref } from "@/lib/datasetPreview";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import { driveImport, type Cell, type Sheet, type SpreadsheetData } from "@/lib/driveImport";
import { buttonClass, folderHref } from "@/components/drive/ui";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { ApiError, Loading } from "@/components/States";

/** Spreadsheet viewer (Palantir's "Upload as a spreadsheet"): a workbook kept as is, with sheet tabs, a formula
 * bar, merged cells and column widths; any sheet can become a structured (Parquet) dataset. */

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** "B2:C4" → [row, col, rows, cols] (0-based) */
function parseRange(range: string): [number, number, number, number] | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const col = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const [r1, c1, r2, c2] = [Number(m[2]) - 1, col(m[1]), Number(m[4]) - 1, col(m[3])];
  return [r1, c1, r2 - r1 + 1, c2 - c1 + 1];
}

// Excel column width is in characters; ~7px each plus padding
const px = (w: number | null) => Math.max(48, Math.min(480, Math.round((w ?? 10) * 7 + 10)));

export default function SpreadsheetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<SpreadsheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let stale = false;
    driveImport
      .spreadsheetData(id)
      .then((d) => !stale && setData(d))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [id]);

  const sheet: Sheet | undefined = data?.sheets[tab];
  const cols = useMemo(() => Math.max(sheet?.rows.reduce((n, r) => Math.max(n, r.length), 0) ?? 0, 1), [sheet]);

  // merged ranges: the top-left cell spans, the others are not drawn
  const { spans, hidden } = useMemo(() => {
    const spans = new Map<string, [number, number]>();
    const hidden = new Set<string>();
    for (const m of sheet?.merged ?? []) {
      const r = parseRange(m);
      if (!r) continue;
      const [row, col, h, w] = r;
      spans.set(`${row}:${col}`, [h, w]);
      for (let i = row; i < row + h; i++) for (let j = col; j < col + w; j++) if (i !== row || j !== col) hidden.add(`${i}:${j}`);
    }
    return { spans, hidden };
  }, [sheet]);

  // arrow keys move the selected cell
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!sheet || (e.target as HTMLElement).closest("input, textarea")) return;
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      setSel(([r, c]) => [Math.max(0, Math.min(sheet.rows.length - 1, r + d[0])), Math.max(0, Math.min(cols - 1, c + d[1]))]);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [sheet, cols]);

  if (error) return <ApiError message={error} />;
  if (!data || !sheet) return <Loading />;

  const item = data.item;
  const cell: Cell = sheet.rows[sel[0]]?.[sel[1]] ?? null;

  const toDataset = async () => {
    const name = await promptDialog(`Create a structured dataset from the sheet "${sheet.name}". Its first row names the columns.`, `${item.name.replace(/\.[^.]+$/, "")} - ${sheet.name}`, {
      title: "Create dataset",
      placeholder: "Dataset name",
    });
    if (name === null) return;
    setBusy(true);
    try {
      const ds = await driveImport.sheetToDataset(item.id, sheet.name, name.trim() || undefined);
      router.push(datasetHref(ds.id));
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addDataset = async (ds: DriveItem) => {
    setPicking(false);
    setBusy(true);
    try {
      const added = await driveImport.datasetToSheet(item.id, ds.id);
      const d = await driveImport.spreadsheetData(id);
      setData(d);
      setTab(Math.max(0, d.sheets.findIndex((s) => s.name === added.sheet)));
      setSel([0, 0]);
      if (added.truncated)
        void alertDialog(`The dataset has ${added.total_rows.toLocaleString()} rows: the sheet holds the first ${added.rows.toLocaleString()}.`);
    } catch (e) {
      void alertDialog((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5 text-sm">
        <nav className="flex min-w-0 flex-1 items-center gap-1">
          <Link href="/files" className="shrink-0 rounded px-1.5 py-1 text-soft hover:bg-panel-2">
            Files &amp; Projects
          </Link>
          {(item.path ?? []).map((p) => (
            <span key={p.id} className="flex min-w-0 items-center gap-1">
              <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />
              <Link href={folderHref(p.id)} className="truncate rounded px-1.5 py-1 text-soft hover:bg-panel-2">
                {p.name}
              </Link>
            </span>
          ))}
          <Icon name="right" className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="flex min-w-0 items-center gap-1.5 px-1.5 font-medium">
            <Icon name="grid" className="h-4 w-4 shrink-0 text-ok" />
            <span className="truncate">{item.name}</span>
          </span>
        </nav>
        <button type="button" onClick={() => setPicking(true)} disabled={busy} className={`${buttonClass.ghost} flex items-center gap-1.5`} title="Add a dataset to this workbook as a new sheet">
          <Icon name="plus" className="h-4 w-4" /> Add dataset as sheet
        </button>
        <button type="button" onClick={toDataset} disabled={busy} className={`${buttonClass.primary} flex items-center gap-1.5`}>
          <Icon name="table" className="h-4 w-4" /> Create dataset from sheet
        </button>
        <a href={driveContentUrl(item.id)} className={`${buttonClass.ghost} flex items-center gap-1.5`} title="Download the workbook">
          <Icon name="download" className="h-4 w-4" /> Download
        </a>
      </header>

      {picking && (
        <DrivePicker
          title="Add a dataset as a new sheet"
          canPick={(i) =>
            i.content_type === "application/vnd.apache.parquet" || /\.(parquet|csv|tsv|json|jsonl|ndjson)$/i.test(i.name) ? null : "Not a dataset"
          }
          onPick={addDataset}
          onClose={() => setPicking(false)}
        />
      )}

      {/* formula bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-3 font-mono text-xs">
        <span className="w-16 shrink-0 rounded border border-line bg-ink px-2 py-0.5 text-center text-soft">
          {colName(sel[1])}
          {sel[0] + 1}
        </span>
        <span className="italic text-muted">fx</span>
        <span className="min-w-0 flex-1 truncate" title={cell?.f ?? cell?.v ?? ""}>
          {cell?.f ?? cell?.v ?? ""}
        </span>
        {cell?.f && (
          <span className={`shrink-0 ${cell.t === "err" ? "text-bad" : "text-muted"}`}>
            = {cell.v ?? <span title="The file has no saved result for this formula and it could not be calculated">not calculated</span>}
            {cell.calc && (
              <span className="ml-1.5 rounded border border-line-2 px-1" title="The file had no saved result (it was not last saved by Excel), so this value was calculated here">
                calculated
              </span>
            )}
          </span>
        )}
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-auto bg-ink">
        <table className="border-separate border-spacing-0 text-xs" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 44 }} />
            {Array.from({ length: cols }, (_, c) => (
              <col key={c} style={{ width: px(sheet.widths[c] ?? null) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border-b border-r border-line bg-panel-2" />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  className={`sticky top-0 z-10 border-b border-r border-line px-1 py-1 font-medium ${
                    sel[1] === c ? "bg-ocean/25 text-white" : "bg-panel-2 text-muted"
                  }`}
                >
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <th
                  className={`sticky left-0 z-10 border-b border-r border-line px-1 text-right font-medium tabular-nums ${
                    sel[0] === r ? "bg-ocean/25 text-white" : "bg-panel-2 text-muted"
                  }`}
                >
                  {r + 1}
                </th>
                {Array.from({ length: cols }, (_, c) => {
                  const key = `${r}:${c}`;
                  if (hidden.has(key)) return null;
                  const v = row[c] ?? null;
                  const span = spans.get(key);
                  const selected = sel[0] === r && sel[1] === c;
                  return (
                    <td
                      key={c}
                      rowSpan={span?.[0]}
                      colSpan={span?.[1]}
                      onClick={() => setSel([r, c])}
                      title={v?.f ? `${v.f}` : (v?.v ?? undefined)}
                      className={`h-6 cursor-cell truncate border-b border-r border-line/70 px-1.5 ${
                        v?.t === "n" ? "text-right tabular-nums" : ""
                      } ${v?.t === "e" ? "italic text-muted" : v?.t === "err" ? "text-bad" : v?.f ? "text-ocean" : "text-soft"} ${
                        selected ? "outline-2 -outline-offset-2 outline-ocean" : ""
                      } ${span ? "bg-panel/60 text-center" : ""}`}
                    >
                      {v ? (v.t === "e" ? v.f : v.v) : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length === 0 && <div className="p-10 text-center text-sm text-muted">This sheet is empty.</div>}
      </div>

      {/* sheet tabs */}
      <footer className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-panel px-2 text-xs">
        {data.sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            onClick={() => {
              setTab(i);
              setSel([0, 0]);
            }}
            className={`shrink-0 rounded-b-md border-x border-b px-3 py-1 ${
              i === tab ? "border-line-2 bg-ink font-medium text-white" : "border-transparent text-muted hover:text-white"
            }`}
          >
            {s.name}
          </button>
        ))}
        <span className="ml-auto shrink-0 pl-3 text-muted">
          {sheet.max_row.toLocaleString()} rows × {sheet.max_column.toLocaleString()} columns
          {sheet.truncated && ` · showing the first ${sheet.rows.length.toLocaleString()} × ${cols}`}
          {sheet.rows.some((row) => row.some((c) => c?.f)) && " · blue cells hold formulas"}
        </span>
      </footer>
    </div>
  );
}
