"""Upload options of the Files & Projects tab (Palantir's "Upload files" dialog). Every upload picks one:

* structured dataset (recommended for tables): a CSV / TSV / Excel file is parsed (types inferred as Dataset
  Preview does, dataset_reader.py) and saved as a Parquet dataset; with an Excel workbook, each sheet with data
  becomes its own dataset, or only the first one. The upload is recorded as the dataset's first transaction
  (dataset_versions.py), so History and Time Travel work, and Pipeline Builder / Code Repositories / SQL read it.
* spreadsheet: the workbook is kept as is (cells, formulas, merged cells, every sheet) and opens in the
  spreadsheet viewer (/spreadsheets/<id>); a CSV becomes a one-sheet workbook. Any sheet can later be turned into
  a structured dataset.

Formulas: Excel saves each formula's last result in the file, and that is what is shown and converted. A workbook
written by a program (not saved in Excel) has formulas without results; those are calculated here with the
`formulas` package (most Excel functions; an unknown one gives #NAME?), for workbooks up to MAX_CALC_BYTES.
* media set (media_sets.py): a new media set whose schema fits the uploaded files (image, audio, video, document,
  spreadsheet, email, DICOM, or multimodal); the client then uploads the files into it.
* unstructured dataset: a new dataset folder (Dataset Preview's "raw" dataset) that keeps every file as it is
  (Palantir's schema-less dataset). CSV / TSV / JSON files are read by Dataset Preview with a schema inferred from
  the first one (as "Apply a schema" does) and each such upload is a transaction; Excel and other files are parsed
  later in Pipeline Builder ("Add data from Files" → use the folder as an unstructured dataset, then "Extract rows
  from an Excel file") or in transforms.
* raw file: drive.py's plain upload (no route here).

Mounted by server.py under /api/drive/import.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Literal, Optional

import pyarrow as pa
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

import auth
import dataset_reader as R
import dataset_versions
import db
import drive
from excel_calc import EXCEL_ERRORS, MAX_CALC_BYTES, calculated, is_excel_error, needs_calculation  # noqa: F401

router = APIRouter(prefix="/api/drive/import")
log = logging.getLogger("bluesandai.drive_import")

PARQUET = "application/vnd.apache.parquet"
# a workbook uploaded "as a spreadsheet" (the bytes are a normal .xlsx file)
SPREADSHEET = "application/vnd.bluesandai.spreadsheet"
EXCEL = (".xlsx", ".xlsm", ".xls")
TABULAR = (".csv", ".tsv", *EXCEL)
# what the spreadsheet viewer sends at most per sheet
MAX_ROWS, MAX_COLS = 2000, 100


def _read_upload(file: UploadFile) -> tuple[str, bytes]:
    name = drive._clean_name(Path(file.filename or "upload").name)
    data = file.file.read()
    if len(data) > drive.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file is larger than {drive.MAX_UPLOAD_MB} MB")
    return name, data


def _ext(name: str) -> str:
    return Path(name).suffix.lower()


def _stem(name: str) -> str:
    return name.rsplit(".", 1)[0] if "." in name.strip(".") else name


def sheet_names(name: str, data: bytes) -> list[str]:
    if _ext(name) in (".xlsx", ".xlsm"):
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
        try:
            return list(wb.sheetnames)
        finally:
            wb.close()
    if _ext(name) == ".xls":
        import xlrd

        return xlrd.open_workbook(file_contents=data, on_demand=True).sheet_names()
    return []


# ------------------------------------------------------------------------------------------------
# formulas without a saved result (the calculation is shared with the Python readers: excel_calc.py)
# ------------------------------------------------------------------------------------------------


def with_calculated_values(name: str, data: bytes) -> bytes:
    """The workbook with formulas that have no saved result replaced by their calculated values (for conversion
    to a dataset); unchanged when nothing needs calculating."""
    if _ext(name) not in (".xlsx", ".xlsm") or not needs_calculation(data):
        return data
    values = calculated(data)
    if not values:
        return data
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data))
    cached = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    saved = cached[ws.title][cell.coordinate].value
                    # openpyxl's save drops every saved formula result, so saved results are written as values too
                    value = values.get((ws.title, cell.coordinate)) if saved is None else saved
                    # an error (#NAME?, #DIV/0!...) becomes null, so the column keeps its type
                    cell.value = None if is_excel_error(value) else value
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def table_from(name: str, data: bytes, sheet: Optional[str] = None) -> pa.Table:
    """A CSV / TSV file or one sheet of a workbook as a typed table (header row, types inferred)."""
    # short rows are padded and values that don't fit the inferred type become null, instead of rows being dropped
    options: dict[str, Any] = {"jaggedRowBehavior": "PAD", "parseErrorBehavior": "REPLACE_WITH_NULL"}
    if _ext(name) in EXCEL:
        name, data = R.excel_to_csv(name, with_calculated_values(name, data), sheet, calculate=False)
        # a sheet's first row is its header (the sniffer can't tell when every cell is text); Excel's error values
        # (#N/A, #DIV/0!... saved by Excel) are nulls, so a numeric column stays numeric
        options.update(skipLines=1, fieldDelimiter=",", nullValues=["", *sorted(EXCEL_ERRORS)])
    if not data.strip():
        return pa.table({})
    files = [(name, data)]
    table, _problems = R.read(files, R.infer(files, options), strict=False)
    return table


def save_dataset(parent_id: Optional[str], name: str, table: pa.Table, source: dict) -> dict:
    """Store a table as a Parquet dataset in a folder and record it as the dataset's first transaction."""
    data = R.to_parquet(table)
    item = drive._store(parent_id, f"{name}.parquet", io.BytesIO(data), len(data), PARQUET)
    dataset_versions.record(item["id"], data, "upload", {**source, "by": (auth.current() or {}).get("username")})
    return {**drive._public(item), "rows": table.num_rows, "columns": table.num_columns}


# ------------------------------------------------------------------------------------------------
# structured dataset
# ------------------------------------------------------------------------------------------------


@router.post("/dataset")
def import_dataset(
    file: UploadFile = File(...),
    parent_id: Optional[str] = Form(None),
    sheets: Literal["each", "first"] = Form("each"),
) -> dict:
    """Convert a CSV / TSV / Excel file to Parquet dataset(s): one per sheet with data ("each") or the first sheet only.
    A Parquet file (e.g. a dataset downloaded from Files) is already one: it is kept with its own schema."""
    parent_id = drive._folder_id(parent_id)
    name, data = _read_upload(file)
    if _ext(name) == ".parquet":
        import pyarrow.parquet as pq

        try:
            table = pq.read_table(io.BytesIO(data))
        except Exception as e:  # noqa: BLE001 - not a Parquet file
            raise HTTPException(400, f"could not read {name}: {e}") from None
        return {"items": [save_dataset(parent_id, _stem(name), table, {"kind": "upload", "file": name, "sheet": None})]}
    if _ext(name) not in TABULAR:
        raise HTTPException(400, "only CSV, TSV, Excel and Parquet files can become a structured dataset")
    stem = _stem(name)
    try:
        names = sheet_names(name, data) if _ext(name) in EXCEL else [None]
        if sheets == "first":
            names = names[:1]
        tables = [(s, table_from(name, data, s)) for s in names]
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - a broken or encrypted workbook, an undecodable CSV
        raise HTTPException(400, f"could not read {name}: {e}") from None
    tables = [(s, t) for s, t in tables if t.num_columns]
    if not tables:
        raise HTTPException(400, f"{name} has no data to convert")
    many = len(tables) > 1
    out = [
        save_dataset(parent_id, f"{stem} - {s}" if many else stem, t, {"kind": "upload", "file": name, "sheet": s})
        for s, t in tables
    ]
    return {"items": out}


# ------------------------------------------------------------------------------------------------
# spreadsheet
# ------------------------------------------------------------------------------------------------


def _csv_to_xlsx(name: str, data: bytes) -> bytes:
    """A CSV / TSV file as a one-sheet workbook (numbers stay numbers)."""
    import openpyxl

    text = data.decode("utf-8-sig", errors="replace")
    delim = "\t" if _ext(name) == ".tsv" else (R.sniff(text[:65536]).get("fieldDelimiter") or ",")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _stem(name)[:31] or "Sheet1"
    for row in csv.reader(io.StringIO(text), delimiter=delim):
        ws.append([_number(v) for v in row])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _number(v: str) -> Any:
    s = v.strip()
    if not s:
        return None
    try:
        return int(s) if s.lstrip("-").isdigit() and not (len(s.lstrip("-")) > 1 and s.lstrip("-")[0] == "0") else float(s)
    except ValueError:
        return v


@router.post("/spreadsheet")
def import_spreadsheet(file: UploadFile = File(...), parent_id: Optional[str] = Form(None)) -> dict:
    """Keep a workbook as a spreadsheet (cells, formulas and formatting stay); a CSV / TSV becomes a one-sheet workbook."""
    parent_id = drive._folder_id(parent_id)
    name, data = _read_upload(file)
    ext = _ext(name)
    if ext == ".xls":
        raise HTTPException(400, "old .xls workbooks cannot be kept as a spreadsheet: save it as .xlsx, or convert it to a dataset")
    if ext not in (".xlsx", ".xlsm", ".csv", ".tsv"):
        raise HTTPException(400, "only Excel (.xlsx, .xlsm), CSV and TSV files can be uploaded as a spreadsheet")
    try:
        if ext in (".csv", ".tsv"):
            data, name = _csv_to_xlsx(name, data), f"{_stem(name)}.xlsx"
        else:
            sheet_names(name, data)  # fails on a file that is not a workbook
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"could not read {name} as a workbook: {e}") from None
    item = drive._store(parent_id, name, io.BytesIO(data), len(data), SPREADSHEET)
    return drive._public(item)


def _spreadsheet(item_id: str, need: str = "viewer") -> dict:
    item = drive._item(item_id, need=need)
    if item["kind"] != "file" or _ext(item["name"]) not in (".xlsx", ".xlsm"):
        raise HTTPException(400, f'"{item["name"]}" is not a spreadsheet')
    return item


def _shown(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, datetime):
        return v.isoformat(sep=" ", timespec="seconds").removesuffix(" 00:00:00")
    if isinstance(v, (date, time)):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _cell_type(v: Any) -> str:
    if isinstance(v, bool):
        return "b"
    if isinstance(v, (int, float)):
        return "n"
    if isinstance(v, (datetime, date, time)):
        return "d"
    return "s"


@router.get("/spreadsheets/{item_id}")
def read_spreadsheet(item_id: str) -> dict:
    """Every sheet of a spreadsheet: cells as {v: shown value, f: formula, t: n|s|d|b|e}, merged ranges, column
    widths; at most MAX_ROWS x MAX_COLS cells per sheet (`truncated` says when there are more)."""
    import openpyxl
    from openpyxl.utils import get_column_letter

    item = _spreadsheet(item_id)
    data = drive.read_bytes(item)
    formulas = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
    values = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    calc = calculated(data, f"{item['id']}:{item['updated_at']}") if needs_calculation(data) else {}
    sheets = []
    for ws in formulas.worksheets:
        wv = values[ws.title]
        n_rows, n_cols = min(ws.max_row, MAX_ROWS), min(ws.max_column, MAX_COLS)
        rows = []
        for r in range(1, n_rows + 1):
            row = []
            for c in range(1, n_cols + 1):
                raw, cached = ws.cell(r, c).value, wv.cell(r, c).value
                formula = raw if isinstance(raw, str) and raw.startswith("=") else None
                if formula:
                    # the value Excel last calculated; a file written by a program has none: calculated here
                    # ("calc"), an error such as #NAME? ("err"), or "e" when it could not be calculated
                    calculated_here = cached is None and (ws.title, ws.cell(r, c).coordinate) in calc
                    if calculated_here:
                        cached = calc[(ws.title, ws.cell(r, c).coordinate)]
                    t = "err" if is_excel_error(cached) else _cell_type(cached) if cached is not None else "e"
                    cell = {"v": _shown(cached), "f": formula, "t": t, **({"calc": True} if calculated_here else {})}
                elif raw is None:
                    cell = None
                else:
                    cell = {"v": _shown(raw), "t": _cell_type(raw)}
                row.append(cell)
            rows.append(row)
        widths = [
            round(ws.column_dimensions[get_column_letter(c)].width or 0) or None for c in range(1, n_cols + 1)
        ]
        sheets.append({
            "name": ws.title,
            "rows": rows,
            "max_row": ws.max_row,
            "max_column": ws.max_column,
            "truncated": ws.max_row > MAX_ROWS or ws.max_column > MAX_COLS,
            "merged": [str(m) for m in ws.merged_cells.ranges],
            "widths": widths,
            "frozen": ws.freeze_panes,
        })
    return {"item": drive._with_path(item), "sheets": sheets}


class SheetToDataset(BaseModel):
    sheet: str
    name: Optional[str] = Field(None, max_length=200)
    # destination folder; default: the spreadsheet's folder
    parent_id: Optional[str] = None


@router.post("/spreadsheets/{item_id}/dataset")
def sheet_to_dataset(item_id: str, req: SheetToDataset) -> dict:
    """Create a structured (Parquet) dataset from one sheet: its first row is the header."""
    item = _spreadsheet(item_id)
    parent_id = drive._folder_id(req.parent_id if req.parent_id is not None else item["parent_id"])
    data = drive.read_bytes(item)
    if req.sheet not in sheet_names(item["name"], data):
        raise HTTPException(404, f'the spreadsheet has no sheet "{req.sheet}"')
    table = table_from(item["name"], data, req.sheet)
    if not table.num_columns:
        raise HTTPException(400, f'sheet "{req.sheet}" is empty')
    name = drive._clean_name(req.name or f"{_stem(item['name'])} - {req.sheet}")
    return save_dataset(parent_id, name, table, {"kind": "spreadsheet", "spreadsheet": item["id"], "sheet": req.sheet})


# ------------------------------------------------------------------------------------------------
# media set and unstructured dataset
# ------------------------------------------------------------------------------------------------


class NewContainer(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None
    # extensions of the files that will go in (media sets pick their schema from them)
    extensions: list[str] = Field(default_factory=list)


def media_schema(extensions: list[str]) -> tuple[str, Optional[str], list[str]]:
    """(schema, primary format, additional formats) of a media set that accepts every one of these extensions."""
    import media_sets as M

    exts = {M._canon(e) for e in extensions if e}
    for key in ("image", "audio", "video", "document", "spreadsheet", "email", "dicom"):
        s = M.SCHEMAS[key]
        for primary in s["formats"]:
            accepted = {primary, *s["additional"].get(primary, [])}
            if exts and exts <= accepted:
                return key, primary, sorted(exts - {primary})
    return "multimodal", None, []


@router.post("/media-set")
def new_media_set(req: NewContainer) -> dict:
    """A new media set in the folder, with the schema (and format conversions) the uploaded files need."""
    import media_sets as M

    schema, primary, additional = media_schema(req.extensions)
    parent_id = drive._folder_id(req.parent_id)
    body = M.MediaSetIn(name=req.name, parent_id=parent_id, schema=schema, primary_format=primary, additional_formats=additional)
    if parent_id is None:
        # media_sets puts parentless sets into My Project / Media sets; an upload at the top level stays there
        fid = drive._insert_container(None, "folder", drive._free_name(None, drive._clean_name(req.name)))
        body = M.MediaSetIn(folder_id=fid, schema=schema, primary_format=primary, additional_formats=additional)
    return M.create_media_set(body)


@router.post("/unstructured")
def new_unstructured(req: NewContainer) -> dict:
    """A new (empty) unstructured dataset: a dataset folder that takes any files."""
    import dataset_preview

    return dataset_preview.create_dataset(dataset_preview.NewDataset(parent_id=req.parent_id, name=req.name))


@router.post("/unstructured/{folder_id}/files")
def unstructured_file(folder_id: str, file: UploadFile = File(...)) -> dict:
    """Add a file to an unstructured dataset, as it is. A CSV / TSV / JSON file is also read by Dataset Preview: the
    first one applies an inferred schema, and the upload is recorded as a transaction."""
    import mimetypes

    import dataset_preview as P

    folder = drive._item(folder_id, need="editor")
    if folder["kind"] != "folder":
        raise HTTPException(400, "not a dataset folder")
    name, data = _read_upload(file)
    content_type = file.content_type
    if not content_type or content_type == "application/octet-stream":
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    item = drive._store(folder["id"], name, io.BytesIO(data), len(data), content_type)
    db.drive_set(folder["id"], updated_at=drive._now())
    readable = name.lower().endswith(P.TEXT_EXT)
    schema_applied = False
    if readable:
        try:
            saved = P.saved_schema(folder["id"])
            if not (saved and saved.get("fieldSchemaList")):
                P._write(P.DIR / "schemas" / f"{folder['id']}.json", R.infer(P._contents(P._raw_files(folder))))
                schema_applied = True
            P._cache.pop(folder["id"], None)
            P._record(db.drive_get(folder["id"]) or folder, "raw",
                      {"kind": "upload", "file": name, "mode": "append", "by": (auth.current() or {}).get("username")})
        except Exception:  # noqa: BLE001 - the file is stored; reading it with a schema can be fixed in Dataset Preview
            log.exception("could not apply a schema to %s in dataset %s", name, folder["id"])
    return {"item": drive._public(item), "readable": readable, "schema_applied": schema_applied}


# ------------------------------------------------------------------------------------------------
# datasets into spreadsheets
# ------------------------------------------------------------------------------------------------

# rows written into a sheet at most (Excel's own limit is 1,048,576)
MAX_SHEET_ROWS = 100_000
_BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")


class DatasetToSheet(BaseModel):
    dataset_id: str
    # the new sheet's name; default: the dataset's name
    sheet: Optional[str] = Field(None, max_length=31)


def _sheet_cell(v: Any) -> Any:
    """A dataset value as something openpyxl can store."""
    if isinstance(v, datetime):
        return v.replace(tzinfo=None) if v.tzinfo else v
    if isinstance(v, (list, dict)):
        import json

        return json.dumps(v, ensure_ascii=False, default=str)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if v is None or isinstance(v, (bool, int, float, str, date, time)):
        return v
    return str(v)  # Decimal and the like keep their exact text


@router.post("/spreadsheets/{item_id}/sheets")
def dataset_to_sheet(item_id: str, req: DatasetToSheet) -> dict:
    """Add a dataset (Parquet, CSV / JSON file, or a dataset folder) to the spreadsheet as a new sheet: a header row
    and the first MAX_SHEET_ROWS rows. The workbook keeps its id, so links and shares keep working."""
    import openpyxl
    from openpyxl.styles import Font

    import dataset_preview
    import pipeline_datasets

    item = _spreadsheet(item_id, need="editor")
    ds, kind = dataset_preview._dataset(req.dataset_id)
    table = dataset_preview.table(ds, kind)
    wb = openpyxl.load_workbook(io.BytesIO(drive.read_bytes(item)))
    base = _BAD_SHEET_CHARS.sub("_", (req.sheet or "").strip() or _stem(ds["name"]))[:31] or "Dataset"
    name, n = base, 1
    while name.lower() in (t.lower() for t in wb.sheetnames):
        n += 1
        name = f"{base[: 31 - len(f' ({n})')]} ({n})"
    ws = wb.create_sheet(name)
    ws.append(table.column_names)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    rows = table.slice(0, MAX_SHEET_ROWS).to_pylist()
    for row in rows:
        ws.append([_sheet_cell(v) for v in row.values()])
    ws.freeze_panes = "A2"
    buf = io.BytesIO()
    wb.save(buf)
    pipeline_datasets._replace_content(item, buf.getvalue(), SPREADSHEET)
    return {"sheet": name, "rows": len(rows), "total_rows": table.num_rows, "truncated": table.num_rows > MAX_SHEET_ROWS}
