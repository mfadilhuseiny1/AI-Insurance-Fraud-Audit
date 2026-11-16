"""Formulas without a saved result in .xlsx / .xlsm workbooks.

Excel saves each formula's last result in the file, and readers use that. A workbook written by a program (not
saved in Excel: openpyxl, pandas, many exporters) has formulas without results; those are calculated here with the
`formulas` package (most Excel functions; an unknown one gives #NAME?).

* `calculated` / `needs_calculation`: every formula cell of a workbook, as the spreadsheet viewer and the
  "structured dataset" upload use them (drive_import.py).
* `rows_with_calculated_values`: what the Python readers use (Dataset Preview's workbook upload,
  dataset_reader.excel_to_csv; Pipeline Builder's "Extract rows from an Excel file", pipeline_parse.parse_excel).
  `has_uncached_formulas` is a quick look at the sheet XML, so a workbook whose formulas all have a saved result
  (or that has none) is read as before, without the calculation. The calculation is capped (workbook size, number
  of formulas, time); past a cap, or for a formula that cannot be calculated (an unsupported function, a circular
  reference), the cell is left empty and a warning says which cell and why.
"""

from __future__ import annotations

import io
import logging
import os
import re
import tempfile
import threading
import zipfile
from typing import Any, Optional

log = logging.getLogger("bluesandai.excel_calc")

# workbooks larger than this are not recalculated (formulas without a saved result stay "not calculated")
MAX_CALC_BYTES = 5 * 1024 * 1024
# the readers' caps: the `formulas` package takes about 1-2 ms per formula cell (it models every formula of the
# workbook, not only the ones without a result)
MAX_CALC_FORMULAS = 10_000
CALC_SECONDS = 60.0
# warnings listed per workbook (the rest are counted)
MAX_WARNINGS = 20

# Excel's error values
EXCEL_ERRORS = {"#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!"}


def is_excel_error(v: Any) -> bool:
    return isinstance(v, str) and v.strip().upper() in EXCEL_ERRORS


# ------------------------------------------------------------------------------------------------
# every formula cell (drive_import.py)
# ------------------------------------------------------------------------------------------------

_calc_cache: dict[str, dict[tuple[str, str], Any]] = {}
_calc_lock = threading.Lock()
_CELL_KEY = re.compile(r"^'?\[[^\]]*\](.+?)'?!([A-Z]+[0-9]+)$")


def needs_calculation(data: bytes) -> bool:
    """True when an .xlsx / .xlsm workbook has formulas without a saved result."""
    import openpyxl

    formulas_wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
    values_wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        for ws in formulas_wb.worksheets:
            for frow, vrow in zip(ws.iter_rows(), values_wb[ws.title].iter_rows()):
                for f, v in zip(frow, vrow):
                    if isinstance(f.value, str) and f.value.startswith("=") and v.value is None:
                        return True
        return False
    finally:
        formulas_wb.close()
        values_wb.close()


def _plain(v: Any) -> Any:
    """A `formulas` result as a plain value (errors such as #NAME? as their text)."""
    import numpy as np

    if isinstance(v, np.ndarray):
        v = v.flat[0] if v.size else None
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, str):
        return str(v)  # also XlError (#NAME?, #DIV/0!...), a str subclass
    if v is None or isinstance(v, (bool, int, float)):
        return v
    return str(v)  # XlError and the like


def calculated(data: bytes, key: Optional[str] = None) -> dict[tuple[str, str], Any]:
    """{(sheet title, "B2"): value} for every formula cell, calculated with the `formulas` package. Empty for
    workbooks over MAX_CALC_BYTES or when the calculation fails. Cached by `key` (e.g. item id + update time)."""
    if key and key in _calc_cache:
        return _calc_cache[key]
    out: dict[tuple[str, str], Any] = {}
    if len(data) <= MAX_CALC_BYTES:
        import openpyxl

        titles = {t.upper(): t for t in openpyxl.load_workbook(io.BytesIO(data), read_only=True).sheetnames}
        with _calc_lock, tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "book.xlsx")
            with open(path, "wb") as f:
                f.write(data)
            try:
                import formulas

                solution = formulas.ExcelModel().loads(path).finish().calculate()
            except Exception:  # noqa: BLE001 - an unsupported construct; keep "not calculated"
                log.exception("could not calculate the workbook's formulas")
                solution = {}
            for k, v in solution.items():
                m = _CELL_KEY.match(str(k))
                if m and m.group(1).upper() in titles:
                    out[(titles[m.group(1).upper()], m.group(2))] = _plain(getattr(v, "value", v))
    if key:
        _calc_cache[key] = out
    return out


# ------------------------------------------------------------------------------------------------
# the readers: only formulas without a saved result, capped, with warnings
# ------------------------------------------------------------------------------------------------

_SHEET_XML = re.compile(r"^xl/worksheets/[^/]+\.xml$", re.I)
# a formula element (<f>…</f>, <f t="shared" si="0"/>, with or without a namespace prefix)
_FORMULA = re.compile(rb"<(?:\w+:)?f[\s>/]")
# …directly followed by the end of the cell or an empty <v>: a formula without a saved result
_UNCACHED = re.compile(
    rb"<(?:\w+:)?f(?:\s[^>]*)?(?:/>|>[^<]*</(?:\w+:)?f>)\s*(?:</(?:\w+:)?c>|<(?:\w+:)?v\s*/>|<(?:\w+:)?v(?:\s[^>]*)?>\s*</(?:\w+:)?v>)"
)
_FUNCTION = re.compile(r"(?<![A-Za-z0-9_.\"'!])((?:_xlfn\.|_xlws\.)?[A-Za-z][A-Za-z0-9_.]*)\(")


def scan(data: bytes) -> tuple[int, int]:
    """(formulas without a saved result, all formulas) in an .xlsx / .xlsm workbook, read from the sheet XML
    without parsing the workbook; (0, 0) for anything that is not such a workbook."""
    uncached = total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if not _SHEET_XML.match(info.filename):
                    continue
                xml = z.read(info)
                if not _FORMULA.search(xml):
                    continue
                total += len(_FORMULA.findall(xml))
                uncached += len(_UNCACHED.findall(xml))
    except (zipfile.BadZipFile, OSError, KeyError):
        return 0, 0
    return uncached, total


def has_uncached_formulas(data: bytes) -> bool:
    return scan(data)[0] > 0


def _capped_calculation(data: bytes, uncached: int, total: int) -> tuple[Optional[dict[tuple[str, str], Any]], list[str]]:
    """calculated(), within the readers' caps: (values, []) or (None, [why nothing was calculated])."""
    left = f"{uncached} formula cell{'s' if uncached != 1 else ''} without a saved result {'are' if uncached != 1 else 'is'} left empty"
    if len(data) > MAX_CALC_BYTES:
        return None, [f"warning: {left}: the workbook is larger than {MAX_CALC_BYTES // (1024 * 1024)} MB, too large to calculate (open and save it in Excel to store the results)"]
    if total > MAX_CALC_FORMULAS:
        return None, [f"warning: {left}: the workbook has {total} formulas, more than the {MAX_CALC_FORMULAS} that are calculated (open and save it in Excel to store the results)"]
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["values"] = calculated(data)
        except Exception as e:  # noqa: BLE001
            box["error"] = e

    worker = threading.Thread(target=run, name="excel-calc", daemon=True)
    worker.start()
    worker.join(CALC_SECONDS)
    if worker.is_alive():
        return None, [f"warning: {left}: calculating the workbook took longer than {CALC_SECONDS:g} s (open and save it in Excel to store the results)"]
    values = box.get("values")
    if not values:
        why = f" ({str(box['error'])[:200]})" if "error" in box else ""
        return None, [f"warning: {left}: the workbook's formulas could not be calculated{why}"]
    return values, []


def _unknown_functions(formula: str) -> list[str]:
    import formulas

    known = formulas.get_functions()
    out = []
    for name in _FUNCTION.findall(formula):
        bare = re.sub(r"^_(?:xlfn|xlws)\.", "", name, flags=re.I).upper()
        if bare not in known and name.upper() not in known and bare not in out:
            out.append(bare)
    return out


def rows_with_calculated_values(data: bytes, sheets: list[Optional[str]]) -> tuple[dict[str, list[tuple]], list[str]]:
    """The rows (cell values, as openpyxl's read-only data_only `iter_rows(values_only=True)` gives them) of each
    sheet in `sheets` (None: the first sheet), with formulas that have no saved result filled with their calculated
    value. Dates come back as datetimes (by the cell's number format), Excel errors as their text (#DIV/0!...);
    a cell that cannot be calculated (an unknown function, a circular reference, a cap) is None. Returns
    ({sheet title: rows}, warnings): one "warning: …" per cell that was not calculated, naming it."""
    import openpyxl
    from openpyxl.styles.numbers import is_date_format
    from openpyxl.utils.datetime import from_excel

    uncached, total = scan(data)
    values, warnings = _capped_calculation(data, uncached, total) if uncached else ({}, [])
    cell_warnings: list[str] = []
    formulas_wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True)
    values_wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    out: dict[str, list[tuple]] = {}
    try:
        for sheet in sheets:
            fws = formulas_wb[sheet] if sheet else formulas_wb.worksheets[0]
            vws = values_wb[fws.title]
            rows: list[tuple] = []
            for frow, vrow in zip(fws.iter_rows(), vws.iter_rows()):
                row = []
                for f, v in zip(frow, vrow):
                    value = v.value
                    formula = f.value
                    if value is None and values and isinstance(formula, str) and formula.startswith("="):
                        where = f"'{fws.title}'!{f.coordinate} ({formula[:120]})"
                        key = (fws.title, f.coordinate)
                        if key not in values:
                            cell_warnings.append(f"warning: {where} could not be calculated (a circular reference, or a formula the calculator cannot read); left empty")
                        else:
                            value = values[key]
                            if isinstance(value, str) and value.strip().upper() == "#NAME?":
                                unknown = _unknown_functions(formula)
                                what = f"unsupported function{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}" if unknown else "an unknown name"
                                cell_warnings.append(f"warning: {where} could not be calculated: {what}; left empty")
                                value = None
                            elif isinstance(value, str) and value.strip().upper() == "#VALUE!":
                                cell_warnings.append(f"warning: {where} calculated as #VALUE! (a wrong argument, or a function the calculator does not support)")
                            elif isinstance(value, (int, float)) and not isinstance(value, bool) and is_date_format(f.number_format or "General"):
                                try:
                                    value = from_excel(value, formulas_wb.epoch)
                                except (ValueError, OverflowError):
                                    pass
                            elif isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
                                value = int(value)  # as a saved result reads (<v>10</v> is 10)
                    row.append(value)
                rows.append(tuple(row))
            out[fws.title] = rows
    finally:
        formulas_wb.close()
        values_wb.close()
    if len(cell_warnings) > MAX_WARNINGS:
        cell_warnings = cell_warnings[:MAX_WARNINGS] + [f"warning: … and {len(cell_warnings) - MAX_WARNINGS} more formula cells not calculated"]
    for w in warnings + cell_warnings:
        log.info("%s", w)
    return out, warnings + cell_warnings
