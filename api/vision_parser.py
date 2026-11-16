"""Vision for the Fast tier: tables and images, which the PDF text layer cannot represent.

The Fast text pipeline (pdfminer through unstructured) is left as it is. Afterwards:

- Tables: pdfminer gives a table as rows of short text elements side by side. Runs of such rows
  (plus the "Tabel 5.1 ..." caption above) are cropped from the page and a small Qwen vision model
  rebuilds them as headers and rows. The table replaces the elements it covers, which are kept in
  the table's metadata as `original_text`; if the model fails or says it is not a table, the
  original elements stay.
- Images: raster images placed on the page, minus logos and decoration (tiny, in the header or
  footer band, repeated in the same spot on several pages, or full-page scans), are cropped and
  described for retrieval. A failed image is left out.

Both become first-class elements (`Table` with `text_as_html`, `Image`), so Markdown, chunking and
the viewer handle them like any other tier's.

Layout detection (Cost Effective tier, `detect_model`): the text-layout heuristic above misses tables
whose cells pdfminer merges into long lines or single elements. With a detect model, each whole page
is first shown to a small vision model (LAYOUT_MODEL) that returns boxes for its tables and figures;
those boxes become the table and image candidates, and the text elements inside a table box are what
the table replaces. Heuristic tables the detector did not cover are still tried (the table model
rejects ones that are not tables), and a page whose detection fails falls back to the heuristics.

Configuration: OPENROUTER_API_KEY; BLUESANDAI_VISION_MODEL (default below); BLUESANDAI_FAST_VISION=0
turns this off; BLUESANDAI_LAYOUT_MODEL overrides LAYOUT_MODEL.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import html
import io
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import requests

import language

log = logging.getLogger("bluesandai.vision")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# cheapest of the Qwen models tested with complete tables; qwen/qwen3-vl-8b-instruct is ~2x faster
# per item and ~3.5x the price
DEFAULT_MODEL = "qwen/qwen3.7-flash"
TIMEOUT = 60
ATTEMPTS = 3
PARALLEL = 8
# bounds the cost and time of one job
MAX_ITEMS = 300
# longest side of a crop sent to the model: legible table text, few image tokens
MAX_CROP_PX = 1280
FURNITURE = {"Header", "Footer", "PageNumber", "PageBreak"}

# -- table candidates (PDF points, top-left origin, as in element coordinates) --
CELL_MAX_CHARS = 120  # longer text is a paragraph, not a cell
ROW_GAP = 30  # largest vertical gap inside a table
MIN_TABLE_ROWS = 3  # rows with two or more cells side by side
CAPTION = re.compile(r"^\s*(?:tabel|table|tab\.)\s*[\dIVX]", re.IGNORECASE)

# -- image candidates --
MIN_IMAGE_SIDE = 60  # points; smaller is an icon or bullet
MIN_IMAGE_AREA = 0.02  # of the page
MAX_IMAGE_AREA = 0.85  # larger is a scanned page: Fast reads text layers only
FURNITURE_BAND = 0.09  # top and bottom of the page, where logos and running heads sit
REPEATED_ON_PAGES = 3  # the same box on this many pages is a logo or watermark

# -- layout detection (whole pages) --
LAYOUT_MODEL = "qwen/qwen3-vl-8b-instruct"
DETECT_PAGE_PX = 1024  # longest side of a page sent to the detector: layout, not text, has to be legible
DETECT_PARALLEL = 16
DETECT_MAX_REGIONS = 12  # per page
DETECT_PAD = 0.01  # of the page, added around a detected box: the model's boxes tend to be tight
MIN_TABLE_SIDE = 20  # points; a smaller detected table is noise
INSIDE_SHARE = 0.5  # a text element at least this much inside a table box belongs to the table


TABLE_PROMPT = (
    "Rebuild this table as JSON: "
    '{"is_table":true,"caption":"","headers":["..."],"rows":[["..."]]}. '
    "Copy cell text exactly, in its original language; one string per cell; repeat merged cells; "
    '"" for empty cells; headers is the header row (join stacked header rows with " / "). '
    "caption: the table's title if shown, else \"\". "
    'If it is not a table, return {"is_table":false}.'
)
IMAGE_PROMPT = (
    "Describe this image from a document for search, as JSON: "
    '{"decorative":false,"caption":"","description":""}. '
    "caption: at most 12 words. description: at most 60 words on what it shows, its key labels, "
    "numbers and trends. Write in {language}. "
    'If it is a logo, icon, decorative border or background, return {"decorative":true}.'
)
TABLE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_table": {"type": "boolean"},
        "caption": {"type": "string"},
        "headers": {"type": "array", "items": {"type": "string"}},
        "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
    },
    "required": ["is_table", "caption", "headers", "rows"],
    "additionalProperties": False,
}
IMAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "decorative": {"type": "boolean"},
        "caption": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["decorative", "caption", "description"],
    "additionalProperties": False,
}
# Qwen-VL models are trained to give boxes as bbox_2d in coordinates normalized to 0-1000
DETECT_PROMPT = (
    "Locate every table and every figure on this document page. "
    'Return JSON: {"regions":[{"label":"table","bbox_2d":[x1,y1,x2,y2]}]} with coordinates normalized to 0-1000. '
    'label "table": data laid out in rows and columns, with or without ruling lines; the box covers all of its '
    "header and body rows, not its title. "
    'label "figure": a chart, graph, diagram, photo, map or illustration; the box covers the whole figure. '
    "Ignore logos, icons, decorative lines, page headers and footers, and ordinary paragraphs and lists. "
    'If there are none, return {"regions":[]}.'
)
DETECT_SCHEMA = {
    "type": "object",
    "properties": {
        "regions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "enum": ["table", "figure"]},
                    "bbox_2d": {"type": "array", "items": {"type": "number"}},
                },
                "required": ["label", "bbox_2d"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["regions"],
    "additionalProperties": False,
}


def enabled(env: Callable[[str], str]) -> bool:
    return env("BLUESANDAI_FAST_VISION").lower() not in ("0", "false", "off", "no") and bool(env("OPENROUTER_API_KEY"))


def enrich(
    pdf_path: Path,
    elements: list[dict],
    api_key: str,
    model: str = "",
    progress: Optional[Callable[[int, int], None]] = None,
    detect_model: str = "",
    first_page: int = 1,
    language: str = "",
) -> tuple[list[dict], dict]:
    """Add tables and images to a Fast job's elements; returns (elements, stats with cost).
    With `detect_model`, tables and figures are located on each page by that model first.
    `pdf_path` may be a chunk of the document whose first page is page `first_page`; `language`
    (for image descriptions) is then best given from the whole document."""
    model = model or DEFAULT_MODEL
    pages = sorted(p for p in {e["metadata"].get("page_number") for e in elements} if p)
    stats = {"tables_found": 0, "images_found": 0, "tables": 0, "images": 0,
             "failed": 0, "cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0}
    heuristic = find_tables(elements)
    if detect_model:
        stats.update(pages_scanned=0, scan_failed=0)
        regions, scanned = detect_regions(pdf_path, pages, elements, api_key, detect_model, stats, first_page)
        tables = _claim([r for r in regions if r["kind"] == "table"], elements)
        # the heuristic still gets what the detector did not cover; chart labels inside a detected
        # figure look like table rows, so those are left alone
        tables += [t for t in heuristic if t["page"] not in scanned or not _overlaps_any(t, regions)]
        # raster images the detector did not account for (e.g. an infographic it boxed only the
        # table inside of) are still described, as on Fast
        images = [r for r in regions if r["kind"] == "image"]
        images += [im for im in find_images(pdf_path, pages, first_page) if im["page"] not in scanned or _covered_share(im, regions) < 0.5]
    else:
        tables, images = heuristic, find_images(pdf_path, pages, first_page)
    images = [im for im in images if not _inside_any(im, tables)]
    items = (tables + images)[:MAX_ITEMS]
    stats.update(tables_found=len(tables), images_found=len(images))
    if not items:
        stats["cost_usd"] = round(stats["cost_usd"], 6)
        return elements, stats

    _render_crops(pdf_path, items, first_page)
    language = language or _main_language(elements)
    lock = threading.Lock()
    done = [0]

    def run(item: dict) -> None:
        prompt, schema, max_tokens = (
            (TABLE_PROMPT, TABLE_SCHEMA, 3000) if item["kind"] == "table"
            else (IMAGE_PROMPT.replace("{language}", language), IMAGE_SCHEMA, 300)
        )
        try:
            item["result"], usage = _ask(api_key, model, prompt, schema, max_tokens, item["jpeg"])
            with lock:
                _add_usage(stats, usage)
        except Exception as e:
            log.warning("vision %s on page %s failed: %s", item["kind"], item["page"], e)
            with lock:
                stats["failed"] += 1
        finally:
            item.pop("jpeg", None)
            with lock:
                done[0] += 1
                if progress:
                    progress(done[0], len(items))

    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        list(pool.map(run, items))

    out = _merge(elements, items, stats)
    stats["cost_usd"] = round(stats["cost_usd"], 6)
    return out, stats


def _add_usage(stats: dict, usage: dict) -> None:
    stats["cost_usd"] += float(usage.get("cost") or 0.0)
    stats["input_tokens"] += int(usage.get("prompt_tokens") or 0)
    stats["output_tokens"] += int(usage.get("completion_tokens") or 0)


# ------------------------------------------------------------------------------------------------
# candidates
# ------------------------------------------------------------------------------------------------


def _box(e: dict) -> Optional[tuple[float, float, float, float, float, float]]:
    """(x0, y0, x1, y1, page width, page height) in points, top-left origin."""
    c = e["metadata"].get("coordinates") or {}
    pts = c.get("points")
    if not pts or not c.get("layout_width"):
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys), c["layout_width"], c["layout_height"]


def find_tables(elements: list[dict]) -> list[dict]:
    """Runs of three or more lines with two or more short elements side by side."""
    by_page: dict[int, list[tuple[int, tuple]]] = collections.defaultdict(list)
    for i, e in enumerate(elements):
        b = _box(e)
        if b and e["type"] not in FURNITURE and e["type"] not in ("Table", "Image"):
            by_page[e["metadata"]["page_number"]].append((i, b))

    tables = []
    for page, items in by_page.items():
        # lines: elements whose vertical extents overlap
        lines: list[dict] = []
        for i, b in sorted(items, key=lambda t: (t[1][1], t[1][0])):
            line = lines[-1] if lines else None
            if line and min(line["y1"], b[3]) - max(line["y0"], b[1]) > 0.5 * min(line["y1"] - line["y0"], b[3] - b[1]):
                line["members"].append((i, b))
                line["y0"], line["y1"] = min(line["y0"], b[1]), max(line["y1"], b[3])
            else:
                lines.append({"members": [(i, b)], "y0": b[1], "y1": b[3]})
        for line in lines:
            short = all(len(elements[i]["text"]) <= CELL_MAX_CHARS for i, _ in line["members"])
            line["short"] = short
            line["cells"] = _side_by_side(line["members"]) if short else 0

        run: list[dict] = []
        for line in lines + [None]:
            if line is not None and line["short"] and (not run or line["y0"] - run[-1]["y1"] <= ROW_GAP):
                run.append(line)
                continue
            # trim single-cell lines from the ends: a table starts and ends with a full row
            while run and run[0]["cells"] < 2:
                run.pop(0)
            while run and run[-1]["cells"] < 2:
                run.pop()
            if sum(1 for ln in run if ln["cells"] >= 2) >= MIN_TABLE_ROWS:
                tables.append(_table_candidate(page, run, lines, elements))
            run = [line] if line is not None and line["short"] else []
    return tables


def _side_by_side(members: list[tuple[int, tuple]]) -> int:
    """How many elements on a line sit next to each other without overlapping horizontally."""
    xs = sorted((b[0], b[2]) for _, b in members)
    cells, right = 0, float("-inf")
    for x0, x1 in xs:
        if x0 >= right - 2:
            cells += 1
            right = x1
        else:
            right = max(right, x1)
    return cells


def _table_candidate(page: int, run: list[dict], lines: list[dict], elements: list[dict]) -> dict:
    members = [m for ln in run for m in ln["members"]]
    boxes = [b for _, b in members]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    w, h = boxes[0][4], boxes[0][5]
    # pdfminer occasionally reports a box off the page: keep the crop on it
    x0, y0, x1, y1 = max(0.0, x0), max(0.0, y0), min(w, x1), min(h, y1)
    # the caption just above goes into the crop (the model reads it) but stays a text element
    k = lines.index(run[0])
    if k > 0 and run[0]["y0"] - lines[k - 1]["y1"] <= ROW_GAP:
        above = lines[k - 1]["members"]
        if any(CAPTION.match(elements[i]["text"]) for i, _ in above):
            y0 = min(b[1] for _, b in above)
            x0, x1 = min(x0, *(b[0] for _, b in above)), max(x1, *(b[2] for _, b in above))
    x0, x1 = max(0.0, x0), min(w, x1)
    return {"kind": "table", "page": page, "bbox": (x0, y0, x1, y1), "page_size": (w, h),
            "replaces": sorted(i for i, _ in members)}


def find_images(pdf_path: Path, pages: list[int], first_page: int = 1) -> list[dict]:
    """Raster images worth describing on the given pages (1-based; the PDF starts at first_page)."""
    found = []
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        for p in pages:
            if p < first_page or p - first_page >= len(pdf):
                continue
            page = pdf[p - first_page]
            w, h = page.get_size()
            boxes = []
            for obj in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=3):
                left, bottom, right, top = obj.get_bounds()
                boxes.append((max(0.0, left), max(0.0, h - top), min(w, right), min(h, h - bottom)))
            for b in _merge_overlapping(boxes):
                bw, bh = b[2] - b[0], b[3] - b[1]
                area = bw * bh / (w * h)
                if bw < MIN_IMAGE_SIDE or bh < MIN_IMAGE_SIDE or area < MIN_IMAGE_AREA or area > MAX_IMAGE_AREA:
                    continue
                if b[3] <= h * FURNITURE_BAND or b[1] >= h * (1 - FURNITURE_BAND):
                    continue
                found.append({"kind": "image", "page": p, "bbox": b, "page_size": (w, h)})
            page.close()
    finally:
        pdf.close()
    # the same box on several pages is a logo, letterhead or watermark
    seen = collections.Counter(tuple(round(v / 5) for v in im["bbox"]) for im in found)
    return [im for im in found if seen[tuple(round(v / 5) for v in im["bbox"])] < REPEATED_ON_PAGES]


def _merge_overlapping(boxes: list[tuple]) -> list[tuple]:
    """Tiled images (one figure drawn as several strips) become one box."""
    merged: list[list[float]] = []
    for b in sorted(boxes):
        for m in merged:
            if b[0] <= m[2] + 2 and b[2] >= m[0] - 2 and b[1] <= m[3] + 2 and b[3] >= m[1] - 2:
                m[0], m[1], m[2], m[3] = min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3])
                break
        else:
            merged.append(list(b))
    return [tuple(m) for m in merged]


def _inside_any(image: dict, tables: list[dict]) -> bool:
    x0, y0, x1, y1 = _unit_box(image)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return any(t["page"] == image["page"] and (b := _unit_box(t))[0] <= cx <= b[2] and b[1] <= cy <= b[3] for t in tables)


def _unit_box(item: dict) -> tuple[float, float, float, float]:
    """bbox as fractions of the page: raster images use the PDF's page size, the rest the layout's."""
    (x0, y0, x1, y1), (w, h) = item["bbox"], item["page_size"]
    return x0 / w, y0 / h, x1 / w, y1 / h


def _overlap(a: tuple, b: tuple) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _overlaps_any(item: dict, others: list[dict]) -> bool:
    a = _unit_box(item)
    return any(o["page"] == item["page"] and _overlap(a, _unit_box(o)) > 0 for o in others)


def _covered_share(item: dict, others: list[dict]) -> float:
    """How much of item's area the others on its page cover (overlaps between them counted twice)."""
    a = _unit_box(item)
    area = max(1e-9, (a[2] - a[0]) * (a[3] - a[1]))
    return sum(_overlap(a, _unit_box(o)) for o in others if o["page"] == item["page"]) / area


# ------------------------------------------------------------------------------------------------
# layout detection
# ------------------------------------------------------------------------------------------------


def detect_regions(
    pdf_path: Path, pages: list[int], elements: list[dict], api_key: str, model: str, stats: dict, first_page: int = 1
) -> tuple[list[dict], set[int]]:
    """Table and image candidates located by `model` on whole pages, in the elements' coordinate
    space; and the pages it answered for (the others fall back to the heuristics)."""
    sizes: dict[int, tuple[float, float]] = {}
    for e in elements:
        c = e["metadata"].get("coordinates") or {}
        if c.get("layout_width"):
            sizes.setdefault(e["metadata"]["page_number"], (c["layout_width"], c["layout_height"]))
    found: list[dict] = []
    scanned: set[int] = set()
    lock = threading.Lock()
    # pages are rendered here (pdfium is not thread-safe) only as fast as the model takes them
    slots = threading.BoundedSemaphore(DETECT_PARALLEL * 2)

    def run(page: int, jpeg: str, size: tuple[float, float]) -> None:
        try:
            r, usage = _ask(api_key, model, DETECT_PROMPT, DETECT_SCHEMA, 600, jpeg)
            regions = _regions(page, r, size)
            with lock:
                _add_usage(stats, usage)
                found.extend(regions)
                scanned.add(page)
                stats["pages_scanned"] += 1
        except Exception as e:
            log.warning("layout detection on page %s failed: %s", page, e)
            with lock:
                stats["scan_failed"] += 1
        finally:
            slots.release()

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        with ThreadPoolExecutor(max_workers=DETECT_PARALLEL) as pool:
            for p in pages:
                if p < first_page or p - first_page >= len(pdf):
                    continue
                slots.acquire()
                try:
                    page = pdf[p - first_page]
                    pw, ph = page.get_size()
                    image = page.render(scale=DETECT_PAGE_PX / max(pw, ph, 1)).to_pil()
                    page.close()
                except Exception as e:
                    slots.release()
                    log.warning("rendering page %s for layout detection failed: %s", p, e)
                    continue
                pool.submit(run, p, _jpeg(image), sizes.get(p) or (pw, ph))
    finally:
        pdf.close()
    # a figure in the same spot on several pages is a logo, letterhead or watermark
    seen = collections.Counter(tuple(round(v / 5) for v in r["bbox"]) for r in found if r["kind"] == "image")
    found = [r for r in found if r["kind"] == "table" or seen[tuple(round(v / 5) for v in r["bbox"])] < REPEATED_ON_PAGES]
    return sorted(found, key=lambda r: (r["page"], r["bbox"][1], r["bbox"][0])), scanned


def _regions(page: int, reply: dict, size: tuple[float, float]) -> list[dict]:
    """The detector's reply as candidates: boxes from 0-1000 to page coordinates, padded a little."""
    w, h = size
    out = []
    for r in (reply.get("regions") or [])[:DETECT_MAX_REGIONS]:
        box = r.get("bbox_2d") if isinstance(r, dict) else None
        if not isinstance(box, list) or len(box) != 4 or r.get("label") not in ("table", "figure"):
            continue
        try:
            nx0, ny0, nx1, ny1 = (min(1000.0, max(0.0, float(v))) / 1000 for v in box)
        except (TypeError, ValueError):
            continue
        nx0, nx1, ny0, ny1 = min(nx0, nx1), max(nx0, nx1), min(ny0, ny1), max(ny0, ny1)
        x0, y0 = max(0.0, nx0 - DETECT_PAD) * w, max(0.0, ny0 - DETECT_PAD) * h
        x1, y1 = min(1.0, nx1 + DETECT_PAD) * w, min(1.0, ny1 + DETECT_PAD) * h
        if r["label"] == "table":
            if x1 - x0 >= MIN_TABLE_SIDE and y1 - y0 >= MIN_TABLE_SIDE:
                out.append({"kind": "table", "page": page, "bbox": (x0, y0, x1, y1), "page_size": (w, h)})
            continue
        # figures: the same size and furniture filters as raster images (a full-page figure is fine:
        # unlike a scan, the page still has its text layer)
        if x1 - x0 < MIN_IMAGE_SIDE or y1 - y0 < MIN_IMAGE_SIDE or (x1 - x0) * (y1 - y0) / (w * h) < MIN_IMAGE_AREA:
            continue
        if y1 <= h * FURNITURE_BAND or y0 >= h * (1 - FURNITURE_BAND):
            continue
        out.append({"kind": "image", "page": page, "bbox": (x0, y0, x1, y1), "page_size": (w, h)})
    return out


def _claim(tables: list[dict], elements: list[dict]) -> list[dict]:
    """Detected tables with the text elements they replace (each element goes to one table), and
    a table title just above in the crop, as the heuristic does."""
    claimed: set[int] = set()
    by_page: dict[int, list[tuple[int, tuple]]] = collections.defaultdict(list)
    for i, e in enumerate(elements):
        b = _box(e)
        if b and e["type"] not in FURNITURE and e["type"] not in ("Table", "Image"):
            by_page[e["metadata"]["page_number"]].append((i, b))
    for t in tables:
        x0, y0, x1, y1 = t["bbox"]
        inside = []
        for i, b in by_page.get(t["page"], []):
            area = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
            overlap = max(0.0, min(x1, b[2]) - max(x0, b[0])) * max(0.0, min(y1, b[3]) - max(y0, b[1]))
            if i not in claimed and overlap / area >= INSIDE_SHARE:
                inside.append(i)
        claimed.update(inside)
        t["replaces"] = sorted(inside)
        above = [(i, b) for i, b in by_page.get(t["page"], [])
                 if i not in claimed and b[3] <= y0 + 2 and y0 - b[3] <= ROW_GAP and CAPTION.match(elements[i]["text"])]
        if above:
            _, b = max(above, key=lambda ib: ib[1][3])
            t["bbox"] = (max(0.0, min(x0, b[0])), b[1], min(t["page_size"][0], max(x1, b[2])), y1)
    return tables


# ------------------------------------------------------------------------------------------------
# crops and model calls
# ------------------------------------------------------------------------------------------------


def _render_crops(pdf_path: Path, items: list[dict], first_page: int = 1) -> None:
    """JPEG of each candidate's region, rendered here in one thread (pdfium is not thread-safe)."""
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        for item in items:
            page = pdf[item["page"] - first_page]
            pw, ph = page.get_size()
            # element coordinates use the layout's page size; pdfium uses the PDF's
            sx, sy = pw / item["page_size"][0], ph / item["page_size"][1]
            pad = 6
            x0, y0 = max(0.0, item["bbox"][0] * sx - pad), max(0.0, item["bbox"][1] * sy - pad)
            x1, y1 = min(pw, item["bbox"][2] * sx + pad), min(ph, item["bbox"][3] * sy + pad)
            scale = max(1.0, min(2.5, MAX_CROP_PX / max(x1 - x0, y1 - y0, 1)))
            item["jpeg"] = _jpeg(page.render(scale=scale, crop=(x0, ph - y1, pw - x1, y0)).to_pil())
            page.close()
    finally:
        pdf.close()


def _jpeg(image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _ask(api_key: str, model: str, prompt: str, schema: dict, max_tokens: int, jpeg_b64: str) -> tuple[dict, dict]:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{jpeg_b64}"}},
            {"type": "text", "text": prompt},
        ]}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": schema}},
        # transcribing a crop needs no reasoning; thinking models otherwise take ~5x longer
        "reasoning": {"enabled": False},
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    error = ""
    for attempt in range(ATTEMPTS):
        try:
            resp = requests.post(OPENROUTER_URL, headers={"Authorization": f"Bearer {api_key}"}, json=body, timeout=TIMEOUT)
            if resp.status_code == 200:
                payload = resp.json()
                content = (payload["choices"][0]["message"].get("content") or "").strip()
                content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
                return json.loads(content), payload.get("usage") or {}
            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if resp.status_code not in (408, 429, 500, 502, 503, 504):
                break
        except (requests.RequestException, ValueError, KeyError, IndexError) as e:
            # a timeout, or a reply that is not the JSON asked for: worth one more try
            error = repr(e)
        time.sleep(2**attempt)
    raise RuntimeError(error)


# ------------------------------------------------------------------------------------------------
# results into elements
# ------------------------------------------------------------------------------------------------


def _merge(elements: list[dict], items: list[dict], stats: dict) -> list[dict]:
    """Tables replace the elements they cover; images go in reading order by position."""
    replaced: set[int] = set()
    insert_at: dict[int, list[dict]] = collections.defaultdict(list)
    images_by_page: dict[int, list[dict]] = collections.defaultdict(list)

    for item in items:
        r = item.get("result")
        if not isinstance(r, dict):
            continue
        if item["kind"] == "table":
            rows = [[str(c) for c in row] for row in (r.get("rows") or []) if isinstance(row, list)]
            if not r.get("is_table") or not rows:
                continue
            originals = [elements[i] for i in item["replaces"]]
            table = _table_element(item, r, rows, originals, elements)
            if item["replaces"]:
                insert_at[item["replaces"][0]].append(table)
            else:
                # a detected table with no text layer under it (drawn as a picture) goes in by position
                images_by_page[item["page"]].append(table)
            replaced.update(item["replaces"])
            stats["tables"] += 1
        elif not r.get("decorative") and (r.get("caption") or r.get("description")):
            images_by_page[item["page"]].append(_image_element(item, r, elements))
            stats["images"] += 1

    # an image goes before the first text element that starts below its top edge
    for page, images in images_by_page.items():
        images.sort(key=lambda im: im["metadata"]["coordinates"]["points"][0][1])
        on_page = [(i, _box(e)) for i, e in enumerate(elements) if e["metadata"].get("page_number") == page]
        for im in images:
            top = im["metadata"]["coordinates"]["points"][0][1]
            below = [i for i, b in on_page if b and b[1] >= top and elements[i]["type"] not in FURNITURE]
            if below:
                insert_at[below[0]].append(im)
            else:
                last = max((i for i, _ in on_page), default=len(elements) - 1)
                insert_at[last + 1].append(im)

    out = []
    for i in range(len(elements) + 1):
        out.extend(insert_at.get(i, []))
        if i < len(elements) and i not in replaced:
            out.append(elements[i])
    return out


def _coordinates(item: dict) -> dict:
    x0, y0, x1, y1 = item["bbox"]
    w, h = item["page_size"]
    return {"points": [[x0, y0], [x0, y1], [x1, y1], [x1, y0]], "system": "PixelSpace", "layout_width": w, "layout_height": h}


def _base_metadata(item: dict, like: Optional[dict]) -> dict:
    meta = {k: like["metadata"][k] for k in ("filename", "filetype", "last_modified") if like and k in like["metadata"]}
    meta.update(page_number=item["page"], coordinates=_coordinates(item))
    return meta


def _element_id(item: dict, filename: str) -> str:
    key = f"{filename}|{item['kind']}|{item['page']}|{[round(v, 1) for v in item['bbox']]}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:32]


def _table_element(item: dict, r: dict, rows: list[list[str]], originals: list[dict], elements: list[dict]) -> dict:
    headers = [str(h) for h in (r.get("headers") or [])]
    # a table without a header row comes back as empty headers
    headers = headers if any(h.strip() for h in headers) else []
    caption = str(r.get("caption") or "").strip()
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in row) + "</tr>" for row in rows)
    table_html = "<table>" + (f"<thead><tr>{head}</tr></thead>" if headers else "") + f"<tbody>{body}</tbody></table>"
    text = "\n".join([caption] * bool(caption) + [" | ".join(headers)] * bool(headers) + [" | ".join(row) for row in rows])
    like = originals[0] if originals else next((e for e in elements if e["metadata"].get("page_number") == item["page"]), None)
    meta = _base_metadata(item, like)
    langs = sorted({lang for o in originals for lang in (o["metadata"].get("languages") or [])})
    if langs:
        meta["languages"] = langs[:1]
    meta.update(
        text_as_html=table_html,
        table={"caption": caption, "headers": headers, "rows": rows, "bbox": [round(v, 1) for v in item["bbox"]], "page": item["page"]},
        # the text layer's version, for when the rebuilt table is wrong
        original_text="\n".join(o["text"] for o in originals),
    )
    return {"type": "Table", "element_id": _element_id(item, meta.get("filename", "")), "text": text, "metadata": meta}


def _image_element(item: dict, r: dict, elements: list[dict]) -> dict:
    caption = str(r.get("caption") or "").strip()
    description = str(r.get("description") or "").strip()
    like = next((e for e in elements if e["metadata"].get("page_number") == item["page"]), None)
    meta = _base_metadata(item, like)
    meta["image"] = {"caption": caption, "description": description, "bbox": [round(v, 1) for v in item["bbox"]], "page": item["page"]}
    text = ". ".join(t.rstrip(".") for t in (caption, description) if t) + "."
    return {"type": "Image", "element_id": _element_id(item, meta.get("filename", "")), "text": text, "metadata": meta}


def _main_language(elements: list[dict]) -> str:
    """The document's language, for image descriptions (from the text, as language.py labels it)."""
    texts = [e.get("text") or "" for e in elements if len(e.get("text") or "") >= 200]
    if sum(language.is_arabic(t) for t in texts) > len(texts) / 2:
        return "Arabic"
    return language.NAMES[language.document_language(texts)]
