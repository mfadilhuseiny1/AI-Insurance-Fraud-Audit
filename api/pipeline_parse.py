"""Parsers for semi-structured files in Pipeline Builder (the "Extract rows from …" transforms that need
Python): Excel workbooks, XML (with schemas generated from XSD files), email (.eml), KML and shapefiles,
plus text embeddings. Like pipeline_ai, it answers batches keyed by hash and caches what it computed.

Files arrive as base64 (binary) or text; the answer is {columns: [{name, type}], rows: [...]} in the
pipeline's column types, or a list of vectors for embeddings.

Mounted by server.py under /api/pipeline.
"""

from __future__ import annotations

import base64
import email
import email.policy
import io
import json
import math
import struct
import zipfile
from datetime import date, datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import pipeline_ai

router = APIRouter(prefix="/api/pipeline")

MAX_ROWS = 500_000
EXCEL_EXT = (".xlsx", ".xlsm", ".xltx", ".xltm")


def _type_of(values: list[Any]) -> str:
    present = [v for v in values if v is not None and v != ""]
    if not present:
        return "String"
    if all(isinstance(v, bool) for v in present):
        return "Boolean"
    if all(isinstance(v, int) and not isinstance(v, bool) for v in present):
        return "Integer" if all(-(2**31) <= v < 2**31 for v in present) else "Long"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
        return "Double"
    if all(isinstance(v, datetime) for v in present):
        return "Timestamp"
    if all(isinstance(v, date) and not isinstance(v, datetime) for v in present):
        return "Date"
    return "String"


def _cell(v: Any, kind: str) -> Any:
    if v is None or v == "":
        return None
    if kind == "Timestamp":
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if kind == "Date":
        return v.isoformat()
    if kind == "Double":
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if kind == "String" and not isinstance(v, str):
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False, default=str)
        if isinstance(v, (datetime, date)):
            return v.isoformat()
        return str(v)
    return v


def _table(records: list[dict], order: Optional[list[str]] = None) -> dict:
    names: list[str] = list(order or [])
    for r in records:
        for k in r:
            if k not in names:
                names.append(k)
    kinds = {n: _type_of([r.get(n) for r in records]) for n in names}
    return {
        "columns": [{"name": n, "type": kinds[n]} for n in names],
        "rows": [{n: _cell(r.get(n), kinds[n]) for n in names} for r in records[:MAX_ROWS]],
    }


def _unique(names: list[str]) -> list[str]:
    out, seen = [], {}
    for i, n in enumerate(names):
        n = (str(n).strip() if n is not None else "") or f"column_{i + 1}"
        if n in seen:
            seen[n] += 1
            n = f"{n}_{seen[n]}"
        else:
            seen[n] = 1
        out.append(n)
    return out


# ------------------------------------------------------------------------------------------------
# Excel
# ------------------------------------------------------------------------------------------------


def parse_excel(data: bytes, name: str, sheet: str = "", header_row: int = 1, all_sheets: bool = False) -> dict:
    lower = name.lower()
    if lower.endswith((".xls", ".xlt")):
        raise ValueError(f'"{name}" is an Excel 97–2003 workbook (.xls / .xlt) — save it as .xlsx to extract rows')
    from openpyxl import load_workbook

    import excel_calc

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheets = wb.sheetnames if all_sheets else [sheet if sheet else wb.sheetnames[0]]
    for sh in sheets:
        if sh not in wb.sheetnames:
            raise ValueError(f'"{name}" has no sheet "{sh}" (sheets: {", ".join(wb.sheetnames)})')
    # formulas without a saved result (a workbook written by a program) are calculated; cells that could not be
    # are empty, and the answer carries a "warnings" list naming them
    calculated: Optional[dict[str, list[tuple]]] = None
    warnings: list[str] = []
    if excel_calc.has_uncached_formulas(data):
        calculated, warnings = excel_calc.rows_with_calculated_values(data, list(sheets))
    records: list[dict] = []
    order: list[str] = []
    for sh in sheets:
        rows = calculated[sh] if calculated is not None else list(wb[sh].iter_rows(values_only=True))
        if len(rows) < header_row:
            continue
        header = _unique(list(rows[header_row - 1]))
        for h in header:
            if h not in order:
                order.append(h)
        for r in rows[header_row:]:
            if r is None or all(v is None for v in r):
                continue
            rec = {header[i]: r[i] if i < len(r) else None for i in range(len(header))}
            if all_sheets:
                rec["sheet_name"] = sh
            records.append(rec)
    if all_sheets:
        order.append("sheet_name")
    table = _table(records, order)
    if warnings:
        table["warnings"] = warnings
    return table


# ------------------------------------------------------------------------------------------------
# XML (+ XSD)
# ------------------------------------------------------------------------------------------------


def _xsd_records(xsd: str) -> dict[str, str]:
    """Element names in an XSD and their simple types (xs:int → Integer …), to type the columns."""
    from lxml import etree

    root = etree.fromstring(xsd.encode())
    types = {
        "int": "Integer", "integer": "Long", "long": "Long", "short": "Short", "byte": "Byte", "decimal": "Double",
        "double": "Double", "float": "Double", "boolean": "Boolean", "date": "Date", "dateTime": "Timestamp", "string": "String",
    }
    out: dict[str, str] = {}
    for el in root.iter("{http://www.w3.org/2001/XMLSchema}element"):
        n, t = el.get("name"), (el.get("type") or "").split(":")[-1]
        if n and t in types:
            out[n] = types[t]
    return out


def _coerce(text: Optional[str], kind: str) -> Any:
    if text is None:
        return None
    t = text.strip()
    if t == "":
        return None
    try:
        if kind in ("Integer", "Long", "Short", "Byte"):
            return int(t)
        if kind == "Double":
            return float(t)
        if kind == "Boolean":
            return t.lower() in ("true", "1")
        if kind == "Date":
            return date.fromisoformat(t[:10])
        if kind == "Timestamp":
            return datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return t
    return t


def parse_xml(text: str, record_path: str = "", xsd: str = "", include_attributes: bool = True) -> dict:
    """One row per record element (an XPath such as //order, or the repeating children of the root);
    child elements and attributes become columns, nested elements JSON text."""
    from lxml import etree

    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
    root = etree.fromstring(text.encode(), parser)
    if record_path:
        elems = root.xpath(record_path)
    else:
        kids = [c for c in root if isinstance(c.tag, str)]
        tags = [etree.QName(c).localname for c in kids]
        common = max(set(tags), key=tags.count) if tags else None
        elems = [c for c in kids if etree.QName(c).localname == common] or [root]
    schema = _xsd_records(xsd) if xsd.strip() else {}

    def value(el: Any) -> Any:
        children = [c for c in el if isinstance(c.tag, str)]
        if not children:
            return el.text
        out: dict[str, Any] = {}
        for c in children:
            k = etree.QName(c).localname
            v = value(c)
            if k in out:
                out[k] = out[k] if isinstance(out[k], list) else [out[k]]
                out[k].append(v)
            else:
                out[k] = v
        return out

    records = []
    for el in elems:
        rec: dict[str, Any] = {}
        if include_attributes:
            for k, v in el.attrib.items():
                rec[f"@{etree.QName(k).localname}"] = v
        children = [c for c in el if isinstance(c.tag, str)]
        if not children:
            rec[etree.QName(el).localname] = el.text
        for c in children:
            k = etree.QName(c).localname
            v = value(c)
            rec[k] = _coerce(v, schema[k]) if k in schema and isinstance(v, (str, type(None))) else v
        records.append(rec)
    return _table(records)


# ------------------------------------------------------------------------------------------------
# email
# ------------------------------------------------------------------------------------------------


def parse_email(data: bytes, name: str) -> dict:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    body = msg.get_body(preferencelist=("plain", "html"))
    attachments = [p.get_filename() for p in msg.iter_attachments() if p.get_filename()]
    date_header = msg.get("date")
    try:
        sent = email.utils.parsedate_to_datetime(date_header) if date_header else None
    except (TypeError, ValueError):
        sent = None
    return _table(
        [
            {
                "file_path": name,
                "subject": msg.get("subject"),
                "from": msg.get("from"),
                "to": msg.get("to"),
                "cc": msg.get("cc"),
                "date": sent,
                "message_id": msg.get("message-id"),
                "body": body.get_content() if body else None,
                "content_type": body.get_content_type() if body else None,
                "attachments": json.dumps(attachments) if attachments else None,
            }
        ]
    )


# ------------------------------------------------------------------------------------------------
# KML and shapefiles → GeoJSON geometry text
# ------------------------------------------------------------------------------------------------


def parse_kml(text: str) -> dict:
    from lxml import etree

    root = etree.fromstring(text.encode(), etree.XMLParser(resolve_entities=False, no_network=True))
    ns = {"k": root.nsmap.get(None, "http://www.opengis.net/kml/2.2")}

    def coords(s: str) -> list[list[float]]:
        out = []
        for part in s.split():
            xs = [float(x) for x in part.split(",")[:2]]
            if len(xs) == 2:
                out.append(xs)
        return out

    records = []
    for pm in root.iter("{%s}Placemark" % ns["k"]):
        geom: Optional[dict] = None
        point = pm.find(".//k:Point/k:coordinates", ns)
        line = pm.find(".//k:LineString/k:coordinates", ns)
        poly = pm.find(".//k:Polygon//k:outerBoundaryIs//k:coordinates", ns)
        if point is not None:
            c = coords(point.text or "")
            geom = {"type": "Point", "coordinates": c[0]} if c else None
        elif line is not None:
            geom = {"type": "LineString", "coordinates": coords(line.text or "")}
        elif poly is not None:
            geom = {"type": "Polygon", "coordinates": [coords(poly.text or "")]}
        rec: dict[str, Any] = {
            "name": (pm.findtext("k:name", namespaces=ns) or None),
            "description": (pm.findtext("k:description", namespaces=ns) or None),
            "geometry": json.dumps(geom) if geom else None,
        }
        for d in pm.iter("{%s}Data" % ns["k"]):
            rec[d.get("name") or "data"] = d.findtext("k:value", namespaces=ns)
        records.append(rec)
    return _table(records, ["name", "description", "geometry"])


def _read_dbf(data: bytes) -> list[dict]:
    n, header_len, rec_len = struct.unpack("<xxxxIHH", data[:12])
    fields = []
    for i in range(32, header_len - 1, 32):
        raw = data[i : i + 32]
        if raw[0] == 0x0D:
            break
        name = raw[:11].split(b"\x00")[0].decode("latin-1")
        fields.append((name, chr(raw[11]), raw[16], raw[17]))
    out = []
    for r in range(n):
        start = header_len + r * rec_len
        rec = data[start : start + rec_len]
        if not rec or rec[0:1] == b"*":
            continue
        pos, row = 1, {}
        for name, kind, size, dec in fields:
            v = rec[pos : pos + size].decode("latin-1").strip()
            pos += size
            if v == "":
                row[name] = None
            elif kind in "NF":
                try:
                    row[name] = float(v) if (dec or "." in v) else int(v)
                except ValueError:
                    row[name] = v
            elif kind == "L":
                row[name] = v.upper() in ("T", "Y")
            elif kind == "D" and len(v) == 8:
                row[name] = date(int(v[:4]), int(v[4:6]), int(v[6:]))
            else:
                row[name] = v
        out.append(row)
    return out


def _read_shp(data: bytes) -> list[Optional[dict]]:
    out: list[Optional[dict]] = []
    pos = 100
    while pos + 8 <= len(data):
        _, length = struct.unpack(">ii", data[pos : pos + 8])
        content = data[pos + 8 : pos + 8 + length * 2]
        pos += 8 + length * 2
        if len(content) < 4:
            break
        kind = struct.unpack("<i", content[:4])[0]
        if kind == 0:
            out.append(None)
        elif kind in (1, 11, 21):
            x, y = struct.unpack("<dd", content[4:20])
            out.append({"type": "Point", "coordinates": [x, y]})
        elif kind in (3, 5, 13, 15, 23, 25):
            num_parts, num_points = struct.unpack("<ii", content[36:44])
            parts = list(struct.unpack(f"<{num_parts}i", content[44 : 44 + 4 * num_parts]))
            pts_at = 44 + 4 * num_parts
            pts = [list(struct.unpack("<dd", content[pts_at + 16 * i : pts_at + 16 * i + 16])) for i in range(num_points)]
            rings = [pts[parts[i] : (parts[i + 1] if i + 1 < num_parts else num_points)] for i in range(num_parts)]
            if kind in (3, 13, 23):
                out.append({"type": "LineString", "coordinates": rings[0]} if len(rings) == 1 else {"type": "MultiLineString", "coordinates": rings})
            else:
                out.append({"type": "Polygon", "coordinates": rings})
        elif kind in (8, 18, 28):
            num_points = struct.unpack("<i", content[36:40])[0]
            pts = [list(struct.unpack("<dd", content[40 + 16 * i : 56 + 16 * i])) for i in range(num_points)]
            out.append({"type": "MultiPoint", "coordinates": pts})
        else:
            out.append(None)
    return out


def parse_shapefile(data: bytes, name: str) -> dict:
    """A zip holding <name>.shp and <name>.dbf (and .shx / .prj): one row per shape with its attributes."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError(f'"{name}": upload the shapefile as a .zip of its .shp, .dbf and .shx files') from e
    names = z.namelist()
    shp = next((n for n in names if n.lower().endswith(".shp")), None)
    if not shp:
        raise ValueError(f'"{name}" has no .shp file')
    base = shp[:-4]
    dbf = next((n for n in names if n.lower() == (base + ".dbf").lower()), None)
    prj = next((n for n in names if n.lower() == (base + ".prj").lower()), None)
    shapes = _read_shp(z.read(shp))
    attrs = _read_dbf(z.read(dbf)) if dbf else [{} for _ in shapes]
    records = [{**(attrs[i] if i < len(attrs) else {}), "geometry": json.dumps(s) if s else None} for i, s in enumerate(shapes)]
    table = _table(records)
    if prj:
        table["crs"] = z.read(prj).decode("latin-1")[:500]
    return table


# ------------------------------------------------------------------------------------------------
# batch endpoint
# ------------------------------------------------------------------------------------------------


class ParseCall(BaseModel):
    key: str
    format: str  # excel | xml | email | kml | shapefile
    name: str = ""
    base64: Optional[str] = None
    text: Optional[str] = None
    sheet: str = ""
    header_row: int = 1
    all_sheets: bool = False
    record_path: str = ""
    xsd: str = ""
    include_attributes: bool = True


class ParseBatch(BaseModel):
    calls: list[ParseCall]


def _payload(c: ParseCall) -> bytes:
    if c.base64 is not None:
        return base64.b64decode(c.base64)
    return (c.text or "").encode()


def _run_parse(c: ParseCall) -> dict:
    try:
        if c.format == "excel":
            value = parse_excel(_payload(c), c.name, c.sheet, max(1, c.header_row), c.all_sheets)
        elif c.format == "xml":
            value = parse_xml(_payload(c).decode("utf-8", "replace"), c.record_path, c.xsd, c.include_attributes)
        elif c.format == "email":
            value = parse_email(_payload(c), c.name)
        elif c.format == "kml":
            value = parse_kml(_payload(c).decode("utf-8", "replace"))
        elif c.format == "shapefile":
            value = parse_shapefile(_payload(c), c.name)
        else:
            raise ValueError(f"unknown format {c.format}")
        pipeline_ai._cache_put(c.key, value)
        return {"value": value}
    except Exception as e:  # noqa: BLE001 — reported per file
        return {"error": f"{c.name or c.format}: {str(e)[:400]}"}


@router.post("/parse")
def parse_batch(req: ParseBatch) -> dict:
    if len(req.calls) > 200:
        raise HTTPException(413, "at most 200 files per request")
    cached = pipeline_ai._cache_get([c.key for c in req.calls])
    results: dict[str, dict] = {k: {"value": v} for k, v in cached.items()}
    todo = [c for c in req.calls if c.key not in results]
    for c, r in zip(todo, pipeline_ai._pool.map(_run_parse, todo)):
        results[c.key] = r
    return {"results": results}


class EmbedCall(BaseModel):
    key: str
    text: str
    model: str = "baai/bge-m3"
    dimension: int = 1024


class EmbedBatch(BaseModel):
    calls: list[EmbedCall]


@router.post("/ai/embed")
def embed_batch(req: EmbedBatch) -> dict:
    """Text embeddings (unit length) for the Text to embeddings transform."""
    import vectors

    cached = pipeline_ai._cache_get([c.key for c in req.calls])
    results: dict[str, dict] = {k: {"value": v} for k, v in cached.items()}
    todo = [c for c in req.calls if c.key not in results]
    by_model: dict[tuple[str, int], list[EmbedCall]] = {}
    for c in todo:
        by_model.setdefault((c.model, c.dimension), []).append(c)
    for (model, dim), calls in by_model.items():
        try:
            vecs, _ = vectors.embed([c.text for c in calls], model, dim)
            for c, v in zip(calls, vecs):
                rounded = [round(x, 6) for x in v]
                pipeline_ai._cache_put(c.key, rounded)
                results[c.key] = {"value": rounded}
        except Exception as e:  # noqa: BLE001
            for c in calls:
                results[c.key] = {"error": str(e)[:300]}
    return {"results": results}
