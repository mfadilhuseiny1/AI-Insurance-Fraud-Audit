"""Media sets in Python transforms (transforms.mediasets): reading and writing media items, and the built-in
media transformations of `media_input.transform()` (palantir.com/docs/foundry/transforms-python/media-set-transforms-api).

A media set is a folder in Files. Built-in transformations run here with PIL / OpenCV (images), pypdf and
pypdfium2 (documents), RapidOCR (OCR), the ffmpeg bundled with imageio-ffmpeg (audio and video), openpyxl
(spreadsheets) and the standard library (email). Map tiles of GeoTIFFs are rendered with Pillow and pyproj (NITF needs
GDAL); layout-aware text (extractLayoutAwareTextV2) groups the PDF text layer or RapidOCR lines into typed blocks with
bounding boxes; encrypt() / decrypt() protect image regions with a Cipher license (cipher.py: AES-256-CTR over the
pixels, recorded in the PNG); transcribe() runs Whisper (transformers: whisper-tiny / whisper-base, downloaded once)
on audio decoded by ffmpeg; generate_image_embeddings() returns normalized CLIP ViT-B/32 vectors (SigLIP 2 when its
weights are installed). DICOM layers render with pydicom.

Media set settings (api/media_sets.py) come with the spec: an output's write mode defaults to `replace` on a
transactional media set and `modify` on a transactionless one (which cannot `replace`); `put_dataset_files`
checks files against the output's schema; virtual media sets take `register_media_item(physical path, path)`.
Inputs list overwritten items too when the repository asks for `deduplicate_by_path=False`.
"""

from __future__ import annotations

import email
import email.policy
import io
import json
import mimetypes
import re
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

SCHEMA_EXT = {
    "document": {"pdf", "docx", "pptx", "txt"},
    "image": {"png", "jpeg", "jpg", "tiff", "tif", "bmp", "webp", "jp2", "jp2k", "nitf", "ntf"},
    "audio": {"mp3", "wav", "flac", "ogg", "opus", "m4a", "webm_audio", "webm"},
    "video": {"mp4", "ts", "mov", "mkv"},
    "spreadsheet": {"xlsx"},
    "email": {"eml"},
    "dicom": {"dcm", "dicom"},
}


def _ext(path: str) -> str:
    return path.rsplit(".", 1)[-1].lower() if "." in path else ""


def schema_of(path: str, content_type: Optional[str] = None) -> Optional[str]:
    e = _ext(path)
    for k, exts in SCHEMA_EXT.items():
        if e in exts:
            return k
    ct = content_type or ""
    for k in ("image", "audio", "video"):
        if ct.startswith(f"{k}/"):
            return k
    return "document" if ct == "application/pdf" else None


class MediaItem(io.BytesIO):
    """A media item's content: a file-like stream (as in Foundry); bytes(item) or item.getvalue() is the raw bytes."""

    def __init__(self, data: bytes, path: str = "", rid: str = "") -> None:
        super().__init__(data)
        self.path = path
        self.rid = rid

    def __bytes__(self) -> bytes:
        return self.getvalue()


class _Rid(str):
    """A media item rid (a str) that also has Foundry's `.item`."""

    @property
    def item(self) -> str:
        return str(self)


class _PutResult(str):
    """put_media_item()'s response: the item's rid (a str) with `.media_item_rid`."""

    @property
    def media_item_rid(self) -> str:
        return str(self)


def _frame(rows: list[dict], columns: list[str]):
    """A pandas DataFrame that also answers .pandas() / .polars() (the lightweight listing API)."""
    import pandas as pd

    class _Listing(pd.DataFrame):
        @property
        def _constructor(self):
            return _Listing

        def pandas(self):
            return pd.DataFrame(self)

        def foreach(self, f) -> None:
            """Call f(row) for every row (like pyspark's DataFrame.foreach); rows answer camelCase and snake_case."""
            for rec in pd.DataFrame(self).to_dict(orient="records"):
                f(_Row(rec))

        def polars(self):
            import polars as pl

            return pl.from_pandas(pd.DataFrame(self))

    return _Listing(rows, columns=columns)


class _Row(dict):
    """A listing row with attribute access by either column name style (mediaItemRid / media_item_rid)."""

    def __getattr__(self, name: str):
        if name in self:
            return self[name]
        camel = re.sub(r"_([a-z])", lambda m: m.group(1).upper(), name)
        snake = re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name)
        for k in (camel, snake):
            if k in self:
                return self[k]
        raise AttributeError(name)


def reference(folder_id: Optional[str], rid: str, content_type: Optional[str]) -> str:
    return json.dumps({"mimeType": content_type or "application/octet-stream",
                       "reference": {"type": "mediaSetViewItem", "mediaSetViewItem": {"mediaSetRid": folder_id, "mediaItemRid": rid}}})


class TransformMediaSetInput:
    def __init__(self, ref: str, items: list[dict], spark=None, modes: Optional[dict] = None) -> None:
        self.ref = ref
        self._items = items
        self._spark = spark
        # incremental builds: {"added": item ids, "previous": item ids}; None runs non-incrementally
        self._modes = modes

    def _find(self, rid: str) -> dict:
        it = next((i for i in self._items if i["id"] == rid), None)
        if not it:
            raise KeyError(f"no media item {rid} in {self.ref}")
        return it

    def _reference(self, it: dict) -> str:
        return reference(it.get("folder_id"), it["id"], it.get("content_type"))

    def _out(self, df):
        if self._spark is not None:
            from code_pyapi import spark_frame, to_arrow

            return spark_frame(to_arrow(df))
        return df

    def _current(self, deduplicate_by_path: bool = True, mode: Optional[str] = None) -> list[dict]:
        """Items in a read mode ('added': new since the last build, 'previous': processed before, 'current': all;
        default 'added' when running incrementally, else 'current'); deduplicated to the newest item per path."""
        mode = mode or ("added" if self._modes is not None else "current")
        if mode not in ("added", "previous", "current"):
            raise ValueError("mode must be 'added', 'previous' or 'current'")
        items = list(self._items)
        if mode != "current":
            items = [] if self._modes is None and mode == "previous" else items if self._modes is None else [i for i in items if i["id"] in self._modes[mode]]
        if deduplicate_by_path:
            newest: dict[str, dict] = {}
            for i in items:
                if i["path"] not in newest or str(i.get("updated_at")) >= str(newest[i["path"]].get("updated_at")):
                    newest[i["path"]] = i
            items = [i for i in items if newest[i["path"]] is i]
        return items

    def list_media_items(self, deduplicate_by_path: bool = True, mode: Optional[str] = None) -> list[dict]:
        return [{"mediaItemRid": i["id"], "path": i["path"], "mediaReference": self._reference(i), "sizeBytes": i.get("size"),
                 "mediaType": i.get("content_type")} for i in self._current(deduplicate_by_path, mode)]

    def list_media_items_by_path_with_media_reference(self, ctx=None, deduplicate_by_path: bool = True, mode: Optional[str] = None):
        return self._out(_frame([{k: r[k] for k in ("mediaItemRid", "path", "mediaReference")} for r in self.list_media_items(deduplicate_by_path, mode)],
                                ["mediaItemRid", "path", "mediaReference"]))

    def list_media_items_by_path(self, ctx=None, deduplicate_by_path: bool = True, mode: Optional[str] = None):
        return self._out(_frame([{k: r[k] for k in ("mediaItemRid", "path")} for r in self.list_media_items(deduplicate_by_path, mode)], ["mediaItemRid", "path"]))

    def dataframe(self, ctx=None, deduplicate_by_path: bool = True, mode: Optional[str] = None):
        """The listing (mediaItemRid, path, mediaReference; also media_item_rid for Spark-style rows)."""
        df = self.list_media_items_by_path_with_media_reference(ctx, deduplicate_by_path, mode)
        if self._spark is None:
            df["media_item_rid"] = df["mediaItemRid"]
        return df

    def get_media_item(self, rid: str) -> MediaItem:
        it = self._find(rid)
        return MediaItem(Path(it["file"]).read_bytes(), it["path"], it["id"])

    def get_media_item_rid_by_path(self, path: str) -> _Rid:
        it = next((i for i in self._current() if i["path"] == path), None)
        if not it:
            raise KeyError(f"no media item at path {path!r} in {self.ref}")
        return _Rid(it["id"])

    def get_media_item_by_path(self, path: str) -> MediaItem:
        return self.get_media_item(self.get_media_item_rid_by_path(path))

    def get_media_item_metadata(self, rid: str) -> dict:
        it = self._find(rid)
        meta = {"mediaItemRid": it["id"], "path": it["path"], "sizeBytes": it.get("size"), "mediaType": it.get("content_type"),
                "updatedAt": it.get("updated_at")}
        kind = schema_of(it["path"], it.get("content_type"))
        if kind == "image":
            try:
                from PIL import Image

                with Image.open(it["file"]) as im:
                    meta.update(width=im.width, height=im.height, format=im.format)
            except Exception:  # noqa: BLE001
                pass
        elif _ext(it["path"]) == "pdf" or it.get("content_type") == "application/pdf":
            try:
                import pypdf

                meta["pages"] = len(pypdf.PdfReader(it["file"]).pages)
                meta["document"] = {"pages": meta["pages"]}
            except Exception:  # noqa: BLE001
                pass
        elif kind in ("audio", "video"):
            meta.update(_probe(it["file"]))
        return _Meta(meta)

    def transform(self, deduplicate_by_path: bool = True) -> "MediaSetInputTransform":
        return MediaSetInputTransform(self, deduplicate_by_path)

    # older single-item helpers
    def transform_image_to_text_ocr_output_text(self, rid: str) -> io.BytesIO:
        return io.BytesIO(_ocr_image(Path(self._find(rid)["file"]).read_bytes()).encode("utf-8"))

    def transform_document_to_jpg(self, rid: str, page: int = 0) -> MediaItem:
        out = _doc_to_images(Path(self._find(rid)["file"]).read_bytes(), page, page + 1, 1024, 1024, "jpg")
        return MediaItem(out[0][1], "", rid)

    def transform_media_item(self, rid: str, path: str, spec: dict):
        """documentToText of a PDF or an image: extractLayoutAwareTextV2 (blocks with types, bounding boxes and
        confidence; format TEXT / MARKDOWN / HTML; mode ELECTRONIC (the PDF's text layer), SCAN (OCR of the rendered
        page) or AUTO (the text layer when the page has one)) or extractRawText (one block per page), by page range."""
        it = self._find(rid)
        op = ((spec or {}).get("documentToText") or {}).get("operation") or {}
        kind = op.get("type", "") if isinstance(op, dict) else ""
        cfg = op.get(kind, {}) if isinstance(op, dict) else {}
        rng = cfg.get("pageRange") or {}
        start, end = int(rng.get("startPageInclusive") or 0), rng.get("endPageExclusive")
        conf = cfg.get("config") or {}
        data = Path(it["file"]).read_bytes()
        if kind == "extractRawText":
            texts = _pdf_text(data, start, end)
            return _Response({"pages": [{"pageNumber": start + i, "blocks": [_block(start + i, 0, "paragraph", [], t, 1.0, "TEXT")]} for i, t in enumerate(texts)]})
        return _Response({"pages": layout_pages(data, start, end, str(conf.get("mode") or "AUTO").upper(), str(conf.get("format") or "TEXT").upper())})


class _Meta(dict):
    """Media item metadata: a dict that also reads as attributes (metadata.document.pages)."""

    def __getattr__(self, name):
        v = self.get(name)
        return _Meta(v) if isinstance(v, dict) else v


class _Response:
    def __init__(self, data: dict) -> None:
        self._data = data

    def json(self) -> dict:
        return self._data


def prefix_path(path: str, page: Optional[int] = None) -> str:
    return f"transformed_{path}" if page is None else f"transformed_{page}_{path}"


class TransformMediaSetOutput:
    def __init__(self, folder: Path, existing: Optional[dict] = None, folder_id: Optional[str] = None, lightweight: bool = False,
                 settings: Optional[dict] = None) -> None:
        self._dir = folder
        self.items: dict[str, dict] = {}
        self.registrations: list[dict] = []
        self._existing = dict(existing or {})
        self._folder_id = folder_id
        self._lightweight = lightweight
        # the media set's settings (media_sets.py): schema, formats, transaction policy, virtual
        self.settings = settings or {}
        self.write_mode = "replace" if self.settings.get("transaction_policy") == "transactional" else "modify"

    def set_write_mode(self, mode: str) -> None:
        if mode not in ("modify", "replace"):
            raise ValueError("set_write_mode takes 'modify' or 'replace'")
        if mode == "replace" and self.settings and self.settings.get("transaction_policy") != "transactional":
            raise ValueError("transactionless media sets only support the 'modify' write mode (their branches cannot be reset)")
        if self.items:
            raise RuntimeError("set_write_mode must be called before the first item is uploaded")
        self.write_mode = mode

    def register_media_item(self, physical_path: str, path: str) -> None:
        """Virtual media sets: register a file of the source (relative to the source's subfolder) as a media item
        without copying it."""
        if not self.settings.get("virtual"):
            raise ValueError("register_media_item works on virtual media sets only")
        if not physical_path or not path:
            raise ValueError("register_media_item needs a physical path and a media item path")
        self.registrations.append({"physical": str(physical_path), "path": str(path)})

    def _matches(self, path: str) -> bool:
        s = self.settings
        if not s or s.get("schema") in (None, "multimodal"):
            return True
        ext = _canon_ext(path)
        return ext == s.get("primary_format") or ext in (s.get("additional_formats") or [])

    def _rid(self, name: str) -> str:
        return self._existing.get(name) or self.items.get(name, {}).get("id") or uuid.uuid4().hex[:16]

    def put_media_item(self, item, path: str) -> _PutResult:
        """Add a media item (bytes, or a file-like object) under a path (file name); the same path replaces it."""
        if hasattr(item, "getvalue"):
            data = item.getvalue()
        elif hasattr(item, "read"):
            data = item.read()
        else:
            data = item
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("put_media_item takes bytes or a file-like object")
        name = str(path).strip().replace("/", "_").replace("\\", "_")
        if not name or name in (".", ".."):
            raise ValueError("put_media_item needs a path (a file name)")
        self._dir.mkdir(parents=True, exist_ok=True)
        f = self._dir / f"{len(self.items)}.bin" if name not in self.items else Path(self.items[name]["file"])
        f.write_bytes(bytes(data))
        rid = self._rid(name)
        self.items[name] = {"path": name, "file": str(f), "size": len(data), "id": rid}
        return _PutResult(rid)

    def fast_copy_media_item(self, media_input: TransformMediaSetInput, rid: str, path: str) -> _PutResult:
        return self.put_media_item(media_input.get_media_item(rid), path)

    def put_dataset_files(self, dataset, ignore_items_not_matching_schema: bool = False) -> None:
        """Upload every file of a dataset input (e.g. a folder of PDFs) as media items."""
        if self._lightweight:
            raise TypeError("put_dataset_files is not supported in lightweight transforms (it relies on Spark): use put_media_item")
        self.put_dataset_files_and_get_dataframe_of_uploads(dataset, ignore_items_not_matching_schema)

    def put_dataset_files_and_get_dataframe_of_uploads(self, dataset, ignore_items_not_matching_schema: bool = False,
                                                       ignore_items_failing_to_convert: bool = False):
        """Upload every file of a dataset input and return a DataFrame of the uploads (path, media_item_rid,
        media_reference, status, error)."""
        fs = dataset.filesystem()
        if self.settings and self.settings.get("schema"):
            rows = []
            for f in fs.ls():
                name = f.path.rsplit("/", 1)[-1]
                if not self._matches(name):
                    if ignore_items_not_matching_schema:
                        rows.append({"path": name, "media_item_rid": None, "media_reference": None, "status": "skipped", "error": "does not match the schema"})
                        continue
                    raise ValueError(f"{f.path} does not match the media set's schema ({self.settings.get('primary_format') or self.settings['schema']})")
                try:
                    with fs.open(f.path, "rb") as fh:
                        rid = self.put_media_item(fh, name)
                    rows.append({"path": name, "media_item_rid": str(rid), "media_reference": reference(self._folder_id, str(rid), mimetypes.guess_type(name)[0]),
                                 "status": "uploaded", "error": None})
                except Exception as e:  # noqa: BLE001
                    if not ignore_items_failing_to_convert:
                        raise
                    rows.append({"path": name, "media_item_rid": None, "media_reference": None, "status": "failed", "error": str(e)[:300]})
            return _frame(rows, ["path", "media_item_rid", "media_reference", "status", "error"])
        return self._legacy_put_dataset_files(fs, ignore_items_not_matching_schema)

    def _legacy_put_dataset_files(self, fs, ignore_items_not_matching_schema: bool):
        kinds = {schema_of(f.path) for f in fs.ls()}
        if len(kinds - {None}) > 1 and not ignore_items_not_matching_schema:
            raise ValueError(f"the dataset's files are of several media types ({', '.join(sorted(k for k in kinds if k))}): "
                             "pass ignore_items_not_matching_schema=True to skip the others")
        main = max(kinds - {None}, key=lambda k: sum(1 for f in fs.ls() if schema_of(f.path) == k)) if kinds - {None} else None
        for f in fs.ls():
            if schema_of(f.path) != main:
                if ignore_items_not_matching_schema:
                    continue
                raise ValueError(f"{f.path} does not match the media set's schema ({main})")
            with fs.open(f.path, "rb") as fh:
                self.put_media_item(fh, f.path.rsplit("/", 1)[-1])
        return _frame([{"path": n, "media_item_rid": i["id"], "media_reference": reference(self._folder_id, i["id"], mimetypes.guess_type(n)[0]),
                        "status": "uploaded", "error": None} for n, i in self.items.items()], ["path", "media_item_rid", "media_reference", "status", "error"])

    def media_reference_template(self) -> str:
        """A media reference with %s for the media item rid (for format_string / str %)."""
        return reference(self._folder_id, "__RID__", None).replace("__RID__", "%s")

    def write(self, media_transform: "MediaSetInputTransform", output_path: Callable = prefix_path, suppress_errors: bool = False,
              return_dataframe: bool = False):
        """Run a media transformation and upload its results; a single item's media reference when it was for one item."""
        rows = []
        for it, results, err in media_transform._execute(suppress_errors):
            if err:
                rows.append({"media_item_rid": None, "path": it["path"], "media_reference": err})
                continue
            for suffix, data, page in results:
                base = output_path(it["path"], page)
                # one item in, several out: tell them apart by page unless output_path already does
                name = _with_ext(base, suffix, page if page is not None and len(results) > 1 and base == output_path(it["path"], None) else None)
                rid = self.put_media_item(data, name)
                rows.append({"media_item_rid": str(rid), "path": name, "media_reference": reference(self._folder_id, str(rid), mimetypes.guess_type(name)[0])})
        if media_transform._single:
            return rows[0]["media_reference"] if rows else None
        if return_dataframe:
            return media_transform._source._out(_frame(rows, ["media_item_rid", "path", "media_reference"]))
        return None


def _with_ext(path: str, ext: Optional[str], page: Optional[int]) -> str:
    stem = path.rsplit(".", 1)[0] if "." in path.rsplit("/", 1)[-1] else path
    if page is not None:
        stem = f"{stem}_{page}"
    return f"{stem}.{ext}" if ext else path


# ------------------------------------------------------------------------------------------------
# the transformations
# ------------------------------------------------------------------------------------------------


class MediaSetInputTransform:
    """media_input.transform(): chain media-to-media steps (resize().grayscale()...) and write() them to a media set,
    or call a step that returns data (ocr(), extract_raw_text(), ...) to get a DataFrame (or a value for one item)."""

    def __init__(self, source: TransformMediaSetInput, dedupe: bool = True) -> None:
        self._source = source
        self._dedupe = dedupe
        self._ops: list[tuple[str, dict]] = []
        self._rid: Optional[str] = None
        self._filter: Optional[tuple[str, Optional[list[str]]]] = None
        self._per_item: dict[str, dict] = {}

    @property
    def _single(self) -> bool:
        return self._rid is not None

    def _add(self, op: str, media_item_rid: Optional[str] = None, df=None, on: Optional[str] = None, **params) -> "MediaSetInputTransform":
        if media_item_rid:
            self._rid = media_item_rid
        if df is not None:
            self._per_item.setdefault(op, {}).update(_per_item_params(df, on, params))
        self._ops.append((op, params))
        return self

    def _items(self) -> list[dict]:
        items = list(self._source._current(self._dedupe))
        if self._rid:
            items = [self._source._find(self._rid)]
        if self._filter:
            kind, formats = self._filter
            items = [i for i in items if schema_of(i["path"], i.get("content_type")) == kind and (not formats or _ext(i["path"]) in {f.lower() for f in formats})]
        for op in self._per_item.values():
            items = [i for i in items if i["id"] in op or i.get("reference") in op]
        return items

    def _execute(self, suppress_errors: bool):
        """(item, [(extension, bytes, page)], error) per item after every chained step."""
        for it in self._items():
            try:
                results: list[tuple[Optional[str], bytes, Optional[int]]] = [(_ext(it["path"]) or None, Path(it["file"]).read_bytes(), None)]
                for op, params in self._ops:
                    extra = (self._per_item.get(op) or {}).get(it["id"]) or {}
                    nxt = []
                    for ext, data, page in results:
                        for e2, d2, p2 in _apply(op, {**params, **extra}, data, ext, it):
                            nxt.append((e2, d2, p2 if p2 is not None else page))
                    results = nxt
                yield it, results, None
            except Exception as e:  # noqa: BLE001
                if not suppress_errors:
                    raise
                yield it, [], f"error: {type(e).__name__}: {e}"

    def _values(self, column: str, fn: Callable[[dict, bytes], Any], suppress_errors: bool, per_page: bool = False, flatten: bool = False):
        rows = []
        for it in self._items():
            try:
                v = fn(it, Path(it["file"]).read_bytes())
            except Exception as e:  # noqa: BLE001
                if not suppress_errors or self._single:
                    raise
                v = f"error: {type(e).__name__}: {e}"
            if self._single:
                return v
            ref = self._source._reference(it)
            if per_page and isinstance(v, list):
                for i, x in enumerate(v):
                    rows.append({"media_item_rid": it["id"], "path": it["path"], "media_reference": ref, "page_number": i, column: x})
            else:
                rows.append({"media_item_rid": it["id"], "path": it["path"], "media_reference": ref, column: v})
        cols = ["media_item_rid", "path", "media_reference", *(["page_number"] if per_page else []), column]
        return self._source._out(_frame(rows, cols))

    # -- media-to-media
    def resize(self, media_item_rid=None, width: Optional[int] = 1024, height: Optional[int] = 1024, maintain_aspect_ratio: bool = True, output_format: str = "PNG"):
        if width is None and height is None:
            raise ValueError("resize needs a width or a height")
        return self._add("resize", media_item_rid, width=width, height=height, keep=maintain_aspect_ratio, fmt=output_format)

    def crop(self, width, height, x_offset=0, y_offset=0, media_item_rid=None, df=None, on=None, output_format: str = "PNG"):
        return self._add("crop", media_item_rid, df, on, width=width, height=height, x_offset=x_offset, y_offset=y_offset, fmt=output_format)

    def rotate(self, media_item_rid=None, angle: str = "DEGREE_90", output_format: str = "PNG"):
        if angle not in ("DEGREE_90", "DEGREE_180", "DEGREE_270"):
            raise ValueError("angle must be DEGREE_90, DEGREE_180 or DEGREE_270")
        return self._add("rotate", media_item_rid, angle=angle, fmt=output_format)

    def grayscale(self, media_item_rid=None, output_format: str = "PNG"):
        return self._add("grayscale", media_item_rid, fmt=output_format)

    def binarize(self, media_item_rid=None, threshold: Optional[int] = None, output_format: str = "PNG"):
        return self._add("binarize", media_item_rid, threshold=threshold, fmt=output_format)

    def equalize(self, media_item_rid=None, output_format: str = "PNG"):
        return self._add("equalize", media_item_rid, fmt=output_format)

    def rayleigh(self, media_item_rid=None, sigma: float = 0.5, output_format: str = "PNG"):
        if not 0 < sigma <= 1:
            raise ValueError("sigma must be between 0 and 1")
        return self._add("rayleigh", media_item_rid, sigma=sigma, fmt=output_format)

    def convert_image_to_document(self, media_item_rid=None):
        return self._add("image_to_pdf", media_item_rid)

    def convert_document_to_images(self, media_item_rid=None, start_page: int = 0, end_page: Optional[int] = None, width: Optional[int] = 1024,
                                   height: Optional[int] = 1024, output_format: str = "PNG"):
        return self._add("pdf_to_images", media_item_rid, start=start_page, end=end_page, width=width, height=height, fmt=output_format)

    def slice_document(self, start_page: int, end_page: int, media_item_rid=None, strictly_enforce_end_page: bool = True):
        return self._add("slice", media_item_rid, start=start_page, end=end_page, strict=strictly_enforce_end_page)

    def filter_to(self, schema_type: str, formats: Optional[list[str]] = None):
        if schema_type not in SCHEMA_EXT:
            raise ValueError(f"schema_type must be one of {', '.join(SCHEMA_EXT)}")
        self._filter = (schema_type, formats)
        return self

    def transcode(self, media_item_rid=None, encode_format: Optional[str] = None):
        return self._add("transcode", media_item_rid, fmt=encode_format)

    def extract_audio(self, media_item_rid=None, output_format: str = "mp3"):
        return self._add("extract_audio", media_item_rid, fmt=output_format)

    def chunk(self, media_item_rid=None, chunk_duration_milliseconds: int = 10000, output_format: Optional[str] = None):
        if int(chunk_duration_milliseconds) <= 0:
            raise ValueError("chunk_duration_milliseconds must be a positive integer")
        return self._add("chunk", media_item_rid, ms=int(chunk_duration_milliseconds), fmt=output_format)

    def extract_first_frame(self, media_item_rid=None, width: Optional[int] = None, height: Optional[int] = None, output_format: str = "PNG"):
        return self._add("frame_at", media_item_rid, at=0.0, width=width, height=height, fmt=output_format)

    def extract_frames_at_timestamp(self, timestamps, media_item_rid=None, df=None, on=None, width=None, height=None, output_format: str = "PNG"):
        return self._add("frame_at", media_item_rid, df, on, at=timestamps, width=width, height=height, fmt=output_format)

    def extract_scene_frames(self, media_item_rid=None, scene_sensitivity: str = "STANDARD", output_format: str = "PNG"):
        return self._add("scene_frames", media_item_rid, sensitivity=scene_sensitivity, fmt=output_format)

    def extract_email_attachments(self, media_item_rid=None, schema_type: Optional[str] = None):
        return self._add("email_attachments", media_item_rid, schema_type=schema_type)

    def tile(self, zoom=0, x=0, y=0, media_item_rid=None, df=None, on=None):
        """A Slippy map tile (EPSG:3857, 256 x 256 PNG) of a geo-embedded GeoTIFF (NITF needs GDAL)."""
        for name, v in (("zoom", zoom), ("x", x), ("y", y)):
            if isinstance(v, int) and v < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if isinstance(zoom, int) and isinstance(x, int) and isinstance(y, int) and not (x < 2 ** zoom and y < 2 ** zoom):
            raise ValueError("x and y must be below 2**zoom")
        return self._add("tile", media_item_rid, df, on, zoom=zoom, x=x, y=y)

    def encrypt(self, polygons=None, cipher_license_rid=None, media_item_rid=None, df=None, on=None, output_format: str = "PNG"):
        """Encrypt image regions (polygons of api.Coordinate) with a Cipher license: AES-256-CTR over the pixels, a PNG."""
        return self._add("encrypt", media_item_rid, df, on, polygons=polygons, license=cipher_license_rid, fmt=_lossless(output_format))

    def decrypt(self, polygons=None, cipher_license_rid=None, media_item_rid=None, df=None, on=None, output_format: str = "PNG"):
        """Decrypt the encrypted regions of an image that lie within the polygons (the regions encrypt() recorded)."""
        return self._add("decrypt", media_item_rid, df, on, polygons=polygons, license=cipher_license_rid, fmt=_lossless(output_format))

    def render_dicom_layer(self, media_item_rid=None, layer_number: Optional[int] = None, width: Optional[int] = None, height: Optional[int] = None,
                           output_format: str = "PNG"):
        if width is None and height is None:
            raise ValueError("render_dicom_layer needs a width or a height")
        return self._add("dicom_layer", media_item_rid, layer=layer_number, width=width, height=height, fmt=output_format)

    # -- media to data
    def ocr(self, languages: Optional[list[str]] = None, scripts: Optional[list[str]] = None, media_item_rid=None, start_page: int = 0,
            end_page: Optional[int] = None, return_structure: str = "item_per_row", suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        def fn(it, data):
            if schema_of(it["path"], it.get("content_type")) == "document":
                return [_ocr_image(img) for _, img, _ in _doc_to_images(data, start_page, end_page, 2048, 2048, "png")]
            return _ocr_image(data)

        return self._values("extracted_text", fn, suppress_errors, per_page=return_structure == "page_per_row")

    def extract_raw_text(self, media_item_rid=None, start_page: int = 0, end_page: Optional[int] = None, return_structure: str = "item_per_row",
                         suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid
        return self._values("extracted_text", lambda it, data: _pdf_text(data, start_page, end_page), suppress_errors,
                            per_page=return_structure == "page_per_row")

    def extract_form_fields(self, media_item_rid=None, suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        def fn(it, data):
            import pypdf

            fields = pypdf.PdfReader(io.BytesIO(data)).get_fields() or {}
            return json.dumps({k: {"type": str(v.get("/FT", "")), "value": str(v.get("/V", "")) if v.get("/V") is not None else None} for k, v in fields.items()})

        return self._values("form_fields", fn, suppress_errors)

    def extract_table_of_contents(self, media_item_rid=None, suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        def fn(it, data):
            import pypdf

            r = pypdf.PdfReader(io.BytesIO(data))

            def walk(items, level=0):
                out = []
                for x in items:
                    if isinstance(x, list):
                        out.extend(walk(x, level + 1))
                    else:
                        try:
                            page = r.get_destination_page_number(x)
                        except Exception:  # noqa: BLE001
                            page = None
                        out.append({"title": x.title, "level": level, "page": page})
                return out

            return json.dumps(walk(r.outline))

        return self._values("table_of_contents", fn, suppress_errors)

    def get_pdf_page_dimensions(self, media_item_rid=None, suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        def fn(it, data):
            import pypdf

            return json.dumps([{"width": float(p.mediabox.width), "height": float(p.mediabox.height)} for p in pypdf.PdfReader(io.BytesIO(data)).pages])

        return self._values("page_dimensions", fn, suppress_errors)

    def get_waveform(self, media_item_rid=None, peaks_per_second: int = 100, suppress_errors: bool = True):
        if not 0 < int(peaks_per_second) <= 1000:
            raise ValueError("peaks_per_second must be between 1 and 1000")
        if media_item_rid:
            self._rid = media_item_rid
        return self._values("waveform", lambda it, data: json.dumps(_waveform(data, _ext(it["path"]), int(peaks_per_second))), suppress_errors)

    def get_scene_frame_timestamps(self, media_item_rid=None, scene_sensitivity: str = "STANDARD", suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid
        return self._values("scene_frames", lambda it, data: json.dumps({"frames": _scenes(data, _ext(it["path"]), scene_sensitivity)}), suppress_errors)

    def extract_email_body(self, media_item_rid=None, output_format: str = "TEXT", suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        def fn(it, data):
            msg = email.message_from_bytes(data, policy=email.policy.default)
            part = msg.get_body(preferencelist=("html",) if output_format == "HTML" else ("plain", "html"))
            return part.get_content() if part else ""

        return self._values("email_body", fn, suppress_errors)

    def extract_content_from_spreadsheets(self, media_item_rid=None, suppress_errors: bool = True):
        if media_item_rid:
            self._rid = media_item_rid

        return self._values("extracted_content", lambda it, data: spreadsheet_json(data), suppress_errors)

    def transcribe(self, media_item_rid=None, language: Optional[str] = None, performance_mode: str = "more_economical",
                   output_format: str = "text", add_timestamps: Optional[bool] = False, suppress_errors: bool = True):
        """Speech to text with Whisper (transformers): whisper-tiny (more_economical) or whisper-base (more_performant)."""
        if performance_mode not in ("more_economical", "more_performant"):
            raise ValueError("performance_mode must be more_economical or more_performant")
        if output_format not in ("text", "segments"):
            raise ValueError("output_format must be text or segments")
        if media_item_rid:
            self._rid = media_item_rid
        return self._values("transcription", lambda it, data: transcribe_audio(data, language, performance_mode, output_format, bool(add_timestamps)),
                            suppress_errors)

    def generate_image_embeddings(self, media_item_rid=None, model_id: Optional[str] = None, suppress_errors: bool = True):
        """Image embeddings (a JSON list of floats): CLIP ViT-B/32 here (GOOGLE_SIGLIP_2 is used when its weights are
        installed, otherwise CLIP)."""
        if media_item_rid:
            self._rid = media_item_rid
        return self._values("embeddings", lambda it, data: json.dumps(image_embedding(data, model_id)), suppress_errors)


def _per_item_params(df, on: Optional[str], params: dict) -> dict:
    """Per media item parameters taken from DataFrame columns (crop(..., df=boxes, on='media_item_rid'))."""
    if on not in ("media_item_rid", "media_reference"):
        raise ValueError("on= must be 'media_item_rid' or 'media_reference'")
    if hasattr(df, "toPandas"):
        df = df.toPandas()
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    key_col = on if on in df.columns else ("mediaItemRid" if on == "media_item_rid" else "mediaReference")
    out: dict[str, dict] = {}
    names = {k: _column_name(v) for k, v in params.items()}
    for _, row in df.iterrows():
        key = row[key_col]
        if on == "media_reference":
            try:
                key = json.loads(key)["reference"]["mediaSetViewItem"]["mediaItemRid"]
            except (ValueError, KeyError, TypeError):
                pass
        out[str(key)] = {k: row[n] for k, n in names.items() if n is not None and n in df.columns}
    return out


def _column_name(v) -> Optional[str]:
    if isinstance(v, str):
        return None
    if hasattr(v, "_jc"):  # pyspark Column
        s = v._jc.toString()
        return s if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", s) else None
    return getattr(v, "name", None) if hasattr(v, "iloc") else None


def _img(data: bytes):
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def _save(im, fmt: str) -> tuple[str, bytes]:
    fmt = (fmt or "PNG").upper()
    fmt = {"JPG": "JPEG"}.get(fmt, fmt)
    if fmt == "JPEG" and im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format=fmt)
    return ("jpg" if fmt == "JPEG" else fmt.lower()), buf.getvalue()


# -- speech to text, image embeddings --

WHISPER = {"more_economical": "openai/whisper-tiny", "more_performant": "openai/whisper-base"}
_MODELS: dict[str, Any] = {}


def _pcm16k(data: bytes):
    """Any audio (or video) → 16 kHz mono float32 samples, through ffmpeg."""
    import numpy as np

    r = subprocess.run([_ffmpeg_exe(), "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], input=data, capture_output=True)
    if r.returncode != 0:
        raise ValueError(f"the audio could not be decoded: {r.stderr.decode('utf-8', 'replace')[-300:]}")
    return np.frombuffer(r.stdout, dtype=np.float32)


def _asr(mode: str):
    if mode not in _MODELS:
        try:
            from transformers import pipeline
        except ImportError as e:
            raise NotImplementedError("transcribe() needs transformers and torch") from e
        try:
            _MODELS[mode] = pipeline("automatic-speech-recognition", model=WHISPER[mode], chunk_length_s=30, device="cpu")
        except Exception as e:  # noqa: BLE001
            raise NotImplementedError(f"transcribe(): the Whisper model {WHISPER[mode]} could not be loaded (it is downloaded once from Hugging Face): {e}") from e
    return _MODELS[mode]


def transcribe_audio(data: bytes, language: Optional[str], mode: str, output_format: str, timestamps: bool) -> str:
    audio = _pcm16k(data)
    if not len(audio):
        return "" if output_format == "text" else json.dumps({"segments": []})
    kw: dict = {"task": "transcribe"}
    if language:
        kw["language"] = language
    res = _asr(mode)({"raw": audio, "sampling_rate": 16000}, return_timestamps=True, generate_kwargs=kw)
    chunks = res.get("chunks") or [{"timestamp": (0.0, len(audio) / 16000), "text": res.get("text", "")}]
    segs = []
    for i, c in enumerate(chunks):
        start, end = c.get("timestamp") or (None, None)
        segs.append({"id": i, "start": round(float(start or 0.0), 2), "end": round(float(end if end is not None else len(audio) / 16000), 2),
                     "text": str(c.get("text") or "").strip()})
    if output_format == "segments":
        return json.dumps({"language": language, "duration": round(len(audio) / 16000, 2), "segments": segs})
    if timestamps:
        return "\n".join(f"[{s['start']:.2f} - {s['end']:.2f}] {s['text']}" for s in segs)
    return str(res.get("text") or "").strip()


def image_embedding(data: bytes, model_id: Optional[str]) -> list[float]:
    import torch

    want = (model_id or "GOOGLE_SIGLIP_2").upper()
    name = None
    if want.startswith("GOOGLE_SIGLIP"):
        try:
            from huggingface_hub import try_to_load_from_cache

            if isinstance(try_to_load_from_cache("google/siglip2-base-patch16-224", "config.json"), str):
                name = "google/siglip2-base-patch16-224"
        except Exception:  # noqa: BLE001
            name = None
    name = name or "openai/clip-vit-base-patch32"
    if name not in _MODELS:
        try:
            from transformers import AutoModel, AutoProcessor
        except ImportError as e:
            raise NotImplementedError("generate_image_embeddings() needs transformers and torch") from e
        _MODELS[name] = (AutoModel.from_pretrained(name).eval(), AutoProcessor.from_pretrained(name))
    model, proc = _MODELS[name]
    inputs = proc(images=_img(data).convert("RGB"), return_tensors="pt")
    with torch.no_grad():
        out = model.get_image_features(**inputs)
    # transformers versions return a tensor or an output object (pooled image features)
    if not torch.is_tensor(out):
        out = getattr(out, "image_embeds", None) if getattr(out, "image_embeds", None) is not None else getattr(out, "pooler_output", None) if getattr(out, "pooler_output", None) is not None else out[0]
    vec = out.reshape(-1, out.shape[-1])[0]
    vec = vec / vec.norm()
    return [round(float(v), 6) for v in vec.tolist()]


CIPHER_CHUNK = "bluesandai:cipher"


class Coordinate:
    """transforms.mediasets.api.Coordinate: a point in image pixels."""

    def __init__(self, x: float = 0, y: float = 0) -> None:
        self.x, self.y = x, y

    def __repr__(self) -> str:
        return f"Coordinate(x={self.x}, y={self.y})"


def _lossless(fmt: str) -> str:
    if str(fmt or "PNG").upper() != "PNG":
        raise ValueError("encrypted images are written as PNG: a lossy format would destroy the encrypted pixels")
    return "PNG"


def _points(polygon) -> list[tuple[float, float]]:
    out = []
    for c in polygon:
        if isinstance(c, dict):
            out.append((float(c["x"]), float(c["y"])))
        elif hasattr(c, "x"):
            out.append((float(c.x), float(c.y)))
        else:
            out.append((float(c[0]), float(c[1])))
    if len(out) < 3:
        raise ValueError("a polygon needs at least three coordinates")
    return out


def _cipher_key(license_rid: str, operation: str) -> bytes:
    return _cipher_key_info(license_rid, operation)[0]


def _cipher_key_info(license_rid: str, operation: str) -> tuple[bytes, Optional[str]]:
    """(the license key, its channel's rid or None), asked of the API with this build's job token (as the user who
    started it)."""
    import base64
    import os
    import urllib.request

    if not license_rid:
        raise ValueError(f"{operation}() needs a cipher_license_rid")
    url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/")
    lid = str(license_rid).rsplit(".", 1)[-1]
    req = urllib.request.Request(f"{url}/api/cipher/licenses/{lid}/key", data=json.dumps({"operation": operation}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read())
            return base64.b64decode(body["key"]), body.get("channel")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail")
        except ValueError:
            detail = e.reason
        raise PermissionError(f"Cipher license {license_rid}: {detail}") from None


def _keystream(key: bytes, nonce: bytes, n: int) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    enc = Cipher(algorithms.AES(key), modes.CTR(nonce)).encryptor()
    return enc.update(b"\0" * n) + enc.finalize()


def _cipher_image(op: str, data: bytes, polygons, license_rid: str, key_info: Optional[tuple[bytes, Optional[str]]] = None) -> bytes:
    """Encrypt or decrypt the pixels of polygons. Encrypted regions record their license and channel: any license of
    the channel decrypts them (Workshop's Decrypt selected areas, cipher.visual_decrypt, passes key_info)."""
    import os

    import numpy as np
    from PIL import Image, ImageDraw, PngImagePlugin

    src = Image.open(io.BytesIO(data))
    info = json.loads(src.info.get(CIPHER_CHUNK) or "[]") if src.format == "PNG" else []
    mode = src.mode if src.mode in ("RGB", "RGBA", "L") else "RGBA"
    im = src.convert(mode)
    arr = np.array(im)
    polys = [_points(p) for p in (polygons or [])]
    if not polys:
        raise ValueError(f"{op}() needs at least one polygon")
    key, channel = key_info or _cipher_key_info(license_rid, op)
    regions = list(info)
    if op == "encrypt":
        for pts in polys:
            mask = Image.new("L", im.size, 0)
            ImageDraw.Draw(mask).polygon(pts, fill=1)
            sel = np.array(mask, dtype=bool)
            if not sel.any():
                continue
            nonce = os.urandom(16)
            region = arr[sel]
            ks = np.frombuffer(_keystream(key, nonce, region.size), dtype=np.uint8).reshape(region.shape)
            arr[sel] = region ^ ks
            regions.append({"license": str(license_rid).rsplit(".", 1)[-1], "nonce": nonce.hex(), "polygon": pts, **({"channel": channel} if channel else {})})
    else:
        lid = str(license_rid).rsplit(".", 1)[-1]
        keep = []
        for r in regions:
            ours = (channel and r.get("channel") == channel) or r["license"] == lid
            inside = ours and any(all(_in_polygon(x, y, pts) for x, y in r["polygon"]) for pts in polys)
            if not inside:
                keep.append(r)
                continue
            mask = Image.new("L", im.size, 0)
            ImageDraw.Draw(mask).polygon([tuple(c) for c in r["polygon"]], fill=1)
            sel = np.array(mask, dtype=bool)
            region = arr[sel]
            ks = np.frombuffer(_keystream(key, bytes.fromhex(r["nonce"]), region.size), dtype=np.uint8).reshape(region.shape)
            arr[sel] = region ^ ks
        if len(keep) == len(regions):
            raise ValueError("no encrypted region of this license lies within the polygons")
        regions = keep
    meta = PngImagePlugin.PngInfo()
    if regions:
        meta.add_text(CIPHER_CHUNK, json.dumps(regions))
    buf = io.BytesIO()
    Image.fromarray(arr, mode).save(buf, "PNG", pnginfo=meta)
    return buf.getvalue()


def _in_polygon(x: float, y: float, pts: list[tuple[float, float]]) -> bool:
    """Point in (or on the edge of) a polygon."""
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if min(xi, xj) <= x <= max(xi, xj) and min(yi, yj) <= y <= max(yi, yj) and abs((xj - xi) * (y - yi) - (yj - yi) * (x - xi)) < 1e-9:
            return True
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


TILE = 256
WEB_MERCATOR = 20037508.342789244


def _geotiff(data: bytes):
    """(image, crs, affine (x0, dx, y0, dy)) of a GeoTIFF: ModelTiepoint + ModelPixelScale, the CRS from its GeoKeys."""
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    if im.format != "TIFF":
        raise ValueError("tile() supports geo-embedded TIFF images (NITF needs GDAL, which is not installed here)")
    tags = im.tag_v2
    scale, tie, keys = tags.get(33550), tags.get(33922), tags.get(34735)
    if not scale or not tie:
        raise ValueError("the TIFF is not geo-embedded (no ModelPixelScale / ModelTiepoint tags)")
    epsg = None
    if keys:
        for i in range(4, len(keys), 4):
            key, loc, _count, value = keys[i:i + 4]
            if key in (2048, 3072) and loc == 0 and value not in (0, 32767):
                epsg = int(value)
    if epsg is None:
        raise ValueError("the GeoTIFF's coordinate system is not an EPSG code")
    if im.width * im.height > 100_000_000:
        raise ValueError("tile() supports images up to 100 million square pixels")
    i0, j0, _, x0, y0, _ = tie[:6]
    return im, epsg, (x0 - i0 * scale[0], scale[0], y0 + j0 * scale[1], -scale[1])


def _tile(data: bytes, zoom: int, x: int, y: int) -> bytes:
    import numpy as np
    from PIL import Image
    from pyproj import Transformer

    im, epsg, (ox, dx, oy, dy) = _geotiff(data)
    zoom, x, y = int(zoom), int(x), int(y)
    if zoom < 0 or not (0 <= x < 2 ** zoom and 0 <= y < 2 ** zoom):
        raise ValueError("x and y must be in 0 .. 2**zoom - 1")
    size = 2 * WEB_MERCATOR / 2 ** zoom
    # the centre of every output pixel in Web Mercator
    px = (np.arange(TILE) + 0.5) / TILE
    mx = -WEB_MERCATOR + (x + px) * size
    my = WEB_MERCATOR - (y + px) * size
    gx, gy = np.meshgrid(mx, my)
    if epsg != 3857:
        sx, sy = Transformer.from_crs(3857, epsg, always_xy=True).transform(gx, gy)
    else:
        sx, sy = gx, gy
    col = np.floor((sx - ox) / dx).astype(np.int64)
    row = np.floor((sy - oy) / dy).astype(np.int64)
    inside = (col >= 0) & (col < im.width) & (row >= 0) & (row < im.height)
    src = np.asarray(im.convert("RGBA"))
    out = np.zeros((TILE, TILE, 4), dtype=np.uint8)
    out[inside] = src[row[inside], col[inside]]
    buf = io.BytesIO()
    Image.fromarray(out, "RGBA").save(buf, "PNG")
    return buf.getvalue()


def _apply(op: str, p: dict, data: bytes, ext: Optional[str], it: dict) -> list[tuple[Optional[str], bytes, Optional[int]]]:
    from PIL import Image, ImageOps

    if op == "tile":
        return [("png", _tile(data, p.get("zoom", 0), p.get("x", 0), p.get("y", 0)), None)]
    if op in ("encrypt", "decrypt"):
        return [("png", _cipher_image(op, data, p.get("polygons"), p.get("license")), None)]

    if op in ("resize", "crop", "rotate", "grayscale", "binarize", "equalize", "rayleigh", "image_to_pdf"):
        im = _img(data)
        if op == "resize":
            w, h = p.get("width"), p.get("height")
            if p.get("keep", True):
                ratio = min((w or 10 ** 9) / im.width, (h or 10 ** 9) / im.height)
                im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))))
            else:
                im = im.resize((int(w or im.width), int(h or im.height)))
        elif op == "crop":
            x, y, w, h = (int(p[k]) for k in ("x_offset", "y_offset", "width", "height"))
            im = im.crop((x, y, x + w, y + h))
        elif op == "rotate":
            im = im.rotate(-{"DEGREE_90": 90, "DEGREE_180": 180, "DEGREE_270": 270}[p["angle"]], expand=True)
        elif op == "grayscale":
            im = ImageOps.grayscale(im)
        elif op == "binarize":
            g = ImageOps.grayscale(im)
            t = p.get("threshold")
            if t is None:
                import cv2
                import numpy as np

                t, _ = cv2.threshold(np.asarray(g), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            im = g.point(lambda v, t=t: 255 if v >= t else 0)
        elif op == "equalize":
            im = ImageOps.equalize(ImageOps.grayscale(im))
        elif op == "rayleigh":
            import numpy as np

            g = np.asarray(ImageOps.grayscale(im)).astype(np.float64)
            hist, _ = np.histogram(g.ravel(), 256, (0, 256))
            cdf = np.clip(hist.cumsum() / max(1, g.size), 0, 1 - 1e-9)
            target = p["sigma"] * np.sqrt(-2 * np.log(1 - cdf))
            lut = np.clip(target / max(target.max(), 1e-9) * 255, 0, 255).astype(np.uint8)
            im = Image.fromarray(lut[g.astype(np.uint8)])
        elif op == "image_to_pdf":
            buf = io.BytesIO()
            (im.convert("RGB") if im.mode not in ("RGB", "L") else im).save(buf, format="PDF")
            return [("pdf", buf.getvalue(), None)]
        e, out = _save(im, p.get("fmt", "PNG"))
        return [(e, out, None)]
    if op == "pdf_to_images":
        return _doc_to_images(data, p.get("start") or 0, p.get("end"), p.get("width"), p.get("height"), p.get("fmt") or "PNG")
    if op == "slice":
        import pypdf

        r = pypdf.PdfReader(io.BytesIO(data))
        end = p["end"]
        if end > len(r.pages):
            if p.get("strict", True):
                raise ValueError(f"end_page {end} is past the document's {len(r.pages)} pages")
            end = len(r.pages)
        w = pypdf.PdfWriter()
        for i in range(p["start"], end):
            w.add_page(r.pages[i])
        buf = io.BytesIO()
        w.write(buf)
        return [("pdf", buf.getvalue(), None)]
    if op == "transcode":
        kind = schema_of(it["path"], it.get("content_type"))
        fmt = (p.get("fmt") or ("mp4" if kind == "video" else "mp3")).lower()
        return [(fmt, _ffmpeg(data, ext, [], fmt), None)]
    if op == "extract_audio":
        fmt = (p.get("fmt") or "mp3").lower()
        return [(fmt, _ffmpeg(data, ext, ["-vn"], fmt), None)]
    if op == "chunk":
        kind = schema_of(it["path"], it.get("content_type"))
        fmt = (p.get("fmt") or ("mp4" if kind == "video" else "ts")).lower()
        return _chunks(data, ext, p["ms"], fmt)
    if op == "frame_at":
        at = float(p.get("at") or 0)
        scale = _scale(p.get("width"), p.get("height"))
        fmt = (p.get("fmt") or "PNG").lower()
        fmt = "jpg" if fmt == "jpeg" else fmt
        return [(fmt, _ffmpeg(data, ext, ["-ss", str(at), "-frames:v", "1", *scale], fmt, pre=True), None)]
    if op == "scene_frames":
        fmt = (p.get("fmt") or "PNG").lower()
        frames = _scenes(data, ext, p.get("sensitivity") or "STANDARD")
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for i, f in enumerate(frames):
                img = _ffmpeg(data, ext, ["-ss", str(f["timestamp"]), "-frames:v", "1"], fmt, pre=True)
                info = tarfile.TarInfo(f"frame_{i:04d}_{f['timestamp']:.3f}.{fmt}")
                info.size = len(img)
                tar.addfile(info, io.BytesIO(img))
        return [("tar", buf.getvalue(), None)]
    if op == "dicom_layer":
        im = dicom_layer_image(data, p.get("layer"))
        w, h = p.get("width"), p.get("height")
        ratio = min((w or 10 ** 9) / im.width, (h or 10 ** 9) / im.height)
        im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))))
        e, b = _save(im, p.get("fmt") or "PNG")
        return [(e, b, None)]
    if op == "email_attachments":
        msg = email.message_from_bytes(data, policy=email.policy.default)
        out = []
        for part in msg.iter_attachments():
            name = part.get_filename() or "attachment"
            if p.get("schema_type") and schema_of(name, part.get_content_type()) != p["schema_type"]:
                continue
            out.append((_ext(name) or None, part.get_payload(decode=True) or b"", len(out)))
        return out
    raise ValueError(f"unknown media transformation {op}")


def _doc_to_images(data: bytes, start: int, end: Optional[int], width: Optional[int], height: Optional[int], fmt: str):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    n = len(pdf)
    end = n if end is None else min(end, n)
    out = []
    for i in range(start, end):
        page = pdf[i]
        w, h = page.get_size()
        scale = min((width or 10 ** 6) / w, (height or 10 ** 6) / h) if (width or height) else 2.0
        im = page.render(scale=scale).to_pil()
        e, b = _save(im, fmt)
        out.append((e, b, i))
    return out


def _pdf_text(data: bytes, start: int = 0, end: Optional[int] = None) -> list[str]:
    import pypdf

    pages = pypdf.PdfReader(io.BytesIO(data)).pages
    end = len(pages) if end is None else min(end, len(pages))
    return [(pages[i].extract_text() or "") for i in range(start, end)]


_OCR: dict[str, Any] = {}


# -- layout-aware text (extractLayoutAwareTextV2) --


def _block(page: int, i: int, kind: str, box: list[float], text: str, confidence: float, fmt: str, rows: Optional[list[list[str]]] = None) -> dict:
    """One block: its text tagged by format; the bounding box normalized to the page (0..1, origin top left). A table
    block carries its rows of cells too."""
    if kind == "table" and rows:
        import html as _html

        if fmt == "MARKDOWN":
            md = "\n".join(["| " + " | ".join(c.replace("|", "\\|") for c in rows[0]) + " |", "|" + "---|" * len(rows[0]),
                             *("| " + " | ".join(c.replace("|", "\\|") for c in r) + " |" for r in rows[1:])])
            value = {"type": "markdown", "markdown": md}
        elif fmt == "HTML":
            head = "".join(f"<th>{_html.escape(c)}</th>" for c in rows[0])
            body = "".join("<tr>" + "".join(f"<td>{_html.escape(c)}</td>" for c in r) + "</tr>" for r in rows[1:])
            value = {"type": "html", "html": f"<table><tr>{head}</tr>{body}</table>"}
        else:
            value = {"type": "text", "text": "\n".join("\t".join(r) for r in rows)}
        bb = {"xMin": round(box[0], 4), "yMin": round(box[1], 4), "xMax": round(box[2], 4), "yMax": round(box[3], 4)}
        return {"id": f"p{page}-b{i}", "type": "table", "confidence": round(float(confidence), 3), "boundingBox": bb, "pageNumber": page, "text": value,
                "rows": rows}
    if fmt == "MARKDOWN":
        md = f"# {text}" if kind == "title" else f"## {text}" if kind == "header" else f"- {text.lstrip('-•* ').strip()}" if kind == "list_item" else text
        value = {"type": "markdown", "markdown": md}
    elif fmt == "HTML":
        import html as _html

        t = _html.escape(text).replace("\n", "<br>")
        value = {"type": "html", "html": f"<h1>{t}</h1>" if kind == "title" else f"<h2>{t}</h2>" if kind == "header" else f"<li>{t}</li>" if kind == "list_item" else f"<p>{t}</p>"}
    else:
        value = {"type": "text", "text": text}
    bb = {"xMin": round(box[0], 4), "yMin": round(box[1], 4), "xMax": round(box[2], 4), "yMax": round(box[3], 4)} if box else None
    return {"id": f"p{page}-b{i}", "type": kind, "confidence": round(float(confidence), 3), "boundingBox": bb, "pageNumber": page, "text": value}


def _group(lines: list[dict], header: float = 1.3, title: float = 1.9) -> list[dict]:
    """Lines ({box: [x0, y0, x1, y1] normalized, text, height, conf}) → blocks: a new block after a gap larger than
    the line height, a change of line height (a heading), or a list bullet."""
    lines = sorted((ln for ln in lines if ln["text"].strip()), key=lambda ln: (round(ln["box"][1], 3), ln["box"][0]))
    if not lines:
        return []
    heights = sorted(ln["height"] for ln in lines)
    body = heights[len(heights) // 2] or 1e-6
    bullet = re.compile(r"^\s*([-•*▪]|\d+[.)]|[a-z][.)])\s+")
    blocks: list[dict] = []
    tables = _table_runs(lines, body)
    skip: set[int] = set()
    for idx, ln in enumerate(lines):
        if idx in skip:
            continue
        if idx in tables:
            run = tables[idx]
            skip |= set(range(idx, idx + len(run)))
            box = [min(r["box"][0] for r in run), run[0]["box"][1], max(r["box"][2] for r in run), run[-1]["box"][3]]
            blocks.append({"kind": "table", "text": "", "rows": [[c["text"] for c in r["cells"]] for r in run], "box": box,
                           "height": body, "conf": [r["conf"] for r in run]})
            continue
        big = ln["height"] > body * header
        kind = ("title" if ln["height"] > body * title else "header") if big else ("list_item" if bullet.match(ln["text"]) else "paragraph")
        prev = blocks[-1] if blocks else None
        gap = ln["box"][1] - prev["box"][3] if prev else 1
        joins = prev and prev["kind"] != "table" and kind == prev["kind"] and kind in ("paragraph", "header", "title") and gap < body * 0.9 and abs(ln["height"] - prev["height"]) < body * 0.35
        if joins:
            prev["text"] += " " + ln["text"].strip()
            prev["box"] = [min(prev["box"][0], ln["box"][0]), prev["box"][1], max(prev["box"][2], ln["box"][2]), max(prev["box"][3], ln["box"][3])]
            prev["conf"].append(ln["conf"])
        else:
            blocks.append({"kind": kind, "text": ln["text"].strip(), "box": list(ln["box"]), "height": ln["height"], "conf": [ln["conf"]]})
    return blocks


def _table_runs(lines: list[dict], body: float) -> dict[int, list[dict]]:
    """Runs of at least two consecutive lines split into the same number (≥ 2) of cells whose columns start at the
    same places: {index of the first line: the lines}."""
    out: dict[int, list[dict]] = {}
    i = 0
    while i < len(lines):
        cells = lines[i].get("cells") or []
        if len(cells) < 2:
            i += 1
            continue
        starts = [c["x0"] for c in cells]
        j = i + 1
        while j < len(lines):
            cj = lines[j].get("cells") or []
            gap = lines[j]["box"][1] - lines[j - 1]["box"][3]
            if len(cj) != len(cells) or gap > body * 1.8 or any(abs(c["x0"] - s) > 0.035 for c, s in zip(cj, starts)):
                break
            j += 1
        if j - i >= 2:
            out[i] = lines[i:j]
            i = j
        else:
            i += 1
    return out


def _with_cells(runs: list[dict], same_row) -> list[dict]:  # noqa: ANN001
    """Pieces of text ({box, text, height, conf}) on one row merged into a line whose cells are the pieces."""
    rows: list[list[dict]] = []
    for r in sorted(runs, key=lambda x: (round((x["box"][1] + x["box"][3]) / 2, 3), x["box"][0])):
        row = next((rw for rw in rows if same_row(rw[0], r)), None)
        if row is None:
            rows.append([r])
        else:
            row.append(r)
    out = []
    for rw in rows:
        rw.sort(key=lambda x: x["box"][0])
        out.append({"box": [min(x["box"][0] for x in rw), min(x["box"][1] for x in rw), max(x["box"][2] for x in rw), max(x["box"][3] for x in rw)],
                    "text": " ".join(x["text"] for x in rw), "height": max(x["height"] for x in rw), "conf": sum(x["conf"] for x in rw) / len(rw),
                    "cells": [{"x0": x["box"][0], "x1": x["box"][2], "text": x["text"]} for x in rw]})
    return out


def _electronic_lines(page) -> list[dict]:
    """The PDF text layer as lines: characters grouped by baseline, each line's height its font size (pdfium)."""
    import ctypes

    import pypdfium2.raw as raw

    w, h = page.get_size()
    tp = page.get_textpage()
    ox, oy = ctypes.c_double(), ctypes.c_double()
    lines: list[dict] = []
    cur: Optional[dict] = None
    for i in range(tp.count_chars()):
        ch = tp.get_text_range(i, 1)
        if ch in ("\r", "\n"):
            cur = None
            continue
        raw.FPDFText_GetCharOrigin(tp.raw, i, ctypes.byref(ox), ctypes.byref(oy))
        size = raw.FPDFText_GetFontSize(tp.raw, i) or 1.0
        l, bt, r, t = tp.get_charbox(i)
        if cur is None or abs(cur["base"] - oy.value) > size * 0.5 or (ch.strip() and l - cur["x1"] > size * 1.2):
            cur = {"base": oy.value, "size": size, "text": "", "x0": l, "x1": r, "y0": bt, "y1": t}
            lines.append(cur)
        cur["text"] += ch
        if ch.strip():
            cur["x0"], cur["x1"] = min(cur["x0"], l), max(cur["x1"], r)
            cur["y0"], cur["y1"] = min(cur["y0"], bt), max(cur["y1"], t)
            cur["size"] = max(cur["size"], size)
    runs = [{"box": [ln["x0"] / w, 1 - max(ln["y1"], ln["base"] + ln["size"] * 0.75) / h, ln["x1"] / w, 1 - min(ln["y0"], ln["base"] - ln["size"] * 0.2) / h],
             "text": " ".join(ln["text"].split()), "height": ln["size"] / h, "conf": 1.0, "base": ln["base"] / h} for ln in lines if ln["text"].strip()]
    # runs on one baseline are one line; wide gaps between them make cells
    return _with_cells(runs, lambda a, b: abs(a["base"] - b["base"]) < min(a["height"], b["height"]) * 0.3)


def _ocr_lines(im) -> list[dict]:
    """RapidOCR lines with their boxes and scores on a PIL image."""
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as e:
        raise NotImplementedError("SCAN mode needs an OCR engine (rapidocr-onnxruntime)") from e
    import numpy as np

    if "engine" not in _OCR:
        _OCR["engine"] = RapidOCR()
    w, h = im.size
    result, _ = _OCR["engine"](np.asarray(im.convert("RGB"))[:, :, ::-1])
    out = []
    for pts, text, score in result or []:
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        out.append({"box": [min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h], "text": text, "height": (max(ys) - min(ys)) / h, "conf": float(score)})
    # OCR finds each cell of a table row separately: boxes whose middles line up are one line
    mid = lambda b: (b["box"][1] + b["box"][3]) / 2  # noqa: E731
    return _with_cells(out, lambda a, b: abs(mid(a) - mid(b)) < min(a["height"], b["height"]) * 0.5)


def layout_pages(data: bytes, start: int, end: Optional[int], mode: str, fmt: str) -> list[dict]:
    if mode not in ("ELECTRONIC", "SCAN", "AUTO"):
        raise ValueError("mode must be ELECTRONIC, SCAN or AUTO")
    if fmt not in ("TEXT", "MARKDOWN", "HTML"):
        raise ValueError("format must be TEXT, MARKDOWN or HTML")
    pages = []
    if data[:5] != b"%PDF-":
        # an image: always OCR
        lines = _ocr_lines(_img(data))
        # OCR boxes are padded: smaller differences in height mark headings
        blocks = _group(lines, 1.2, 1.6)
        return [{"pageNumber": 0, "blocks": [_block(0, i, b["kind"], b["box"], b["text"], sum(b["conf"]) / len(b["conf"]), fmt, b.get("rows")) for i, b in enumerate(blocks)]}]
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    end = len(pdf) if end is None else min(int(end), len(pdf))
    for p in range(start, end):
        page = pdf[p]
        lines = _electronic_lines(page) if mode in ("ELECTRONIC", "AUTO") else []
        scanned = mode == "SCAN" or (mode == "AUTO" and not lines)
        if scanned:
            lines = _ocr_lines(page.render(scale=2.0).to_pil())
        blocks = _group(lines, 1.2, 1.6) if scanned else _group(lines)
        pages.append({"pageNumber": p, "blocks": [_block(p, i, b["kind"], b["box"], b["text"], sum(b["conf"]) / len(b["conf"]), fmt, b.get("rows")) for i, b in enumerate(blocks)]})
    return pages


def _ocr_image(data: bytes) -> str:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as e:
        raise NotImplementedError("ocr(): no OCR engine is installed (rapidocr-onnxruntime)") from e
    import numpy as np

    if "engine" not in _OCR:
        _OCR["engine"] = RapidOCR()
    im = _img(data).convert("RGB")
    result, _ = _OCR["engine"](np.asarray(im)[:, :, ::-1])
    lines = sorted(result or [], key=lambda r: (round(min(p[1] for p in r[0]) / 10), min(p[0] for p in r[0])))
    return "\n".join(r[1] for r in lines)


def _ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # noqa: BLE001
        raise NotImplementedError("audio and video transformations need ffmpeg (imageio-ffmpeg)") from e


def _ffmpeg(data: bytes, ext: Optional[str], args: list[str], out_fmt: str, pre: bool = False) -> bytes:
    with tempfile.TemporaryDirectory(prefix="media-") as d:
        src = Path(d) / f"in.{ext or 'bin'}"
        src.write_bytes(data)
        dst = Path(d) / f"out.{out_fmt}"
        seek = args[:2] if pre and args[:1] == ["-ss"] else []
        rest = args[2:] if seek else args
        cmd = [_ffmpeg_exe(), "-y", "-loglevel", "error", *seek, "-i", str(src), *rest, str(dst)]
        p = subprocess.run(cmd, capture_output=True, timeout=600)
        if p.returncode or not dst.exists():
            raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', 'replace')[-500:]}")
        return dst.read_bytes()


def _scale(width, height) -> list[str]:
    if not width and not height:
        return []
    return ["-vf", f"scale={int(width) if width else -2}:{int(height) if height else -2}"]


def _probe(file: str) -> dict:
    try:
        p = subprocess.run([_ffmpeg_exe(), "-i", file], capture_output=True, timeout=60)
        m = re.search(rb"Duration: (\d+):(\d+):([\d.]+)", p.stderr)
        if m:
            return {"durationSeconds": int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))}
    except Exception:  # noqa: BLE001
        pass
    return {}


def _chunks(data: bytes, ext: Optional[str], ms: int, fmt: str):
    with tempfile.TemporaryDirectory(prefix="media-") as d:
        src = Path(d) / f"in.{ext or 'bin'}"
        src.write_bytes(data)
        cmd = [_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(src), "-f", "segment", "-segment_time", str(ms / 1000),
               "-reset_timestamps", "1", "-c", "copy", str(Path(d) / f"chunk_%04d.{fmt}")]
        p = subprocess.run(cmd, capture_output=True, timeout=600)
        if p.returncode:
            raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', 'replace')[-500:]}")
        return [(fmt, f.read_bytes(), i) for i, f in enumerate(sorted(Path(d).glob(f"chunk_*.{fmt}")))]


def _scenes(data: bytes, ext: Optional[str], sensitivity: str) -> list[dict]:
    threshold = {"MORE_SENSITIVE": 0.2, "STANDARD": 0.3, "LESS_SENSITIVE": 0.5}.get(sensitivity)
    if threshold is None:
        raise ValueError("scene_sensitivity must be MORE_SENSITIVE, STANDARD or LESS_SENSITIVE")
    with tempfile.TemporaryDirectory(prefix="media-") as d:
        src = Path(d) / f"in.{ext or 'bin'}"
        src.write_bytes(data)
        cmd = [_ffmpeg_exe(), "-i", str(src), "-vf", f"select='eq(n\\,0)+gt(scene\\,{threshold})',metadata=print", "-an", "-f", "null", "-"]
        p = subprocess.run(cmd, capture_output=True, timeout=600)
        out = p.stderr.decode("utf-8", "replace")
        frames = []
        for m in re.finditer(r"pts_time:([\d.]+)(?:.*?\n.*?lavfi\.scene_score=([\d.]+))?", out):
            frames.append({"timestamp": float(m.group(1)), "sceneScore": float(m.group(2)) if m.group(2) else 1.0})
        return frames


def _waveform(data: bytes, ext: Optional[str], peaks: int) -> list[float]:
    import numpy as np

    pcm = _ffmpeg(data, ext, ["-ac", "1", "-ar", "8000", "-f", "s16le"], "raw")
    a = np.abs(np.frombuffer(pcm, dtype=np.int16).astype(np.float64)) / 32768.0
    step = max(1, 8000 // peaks)
    n = len(a) // step
    if n == 0:
        return []
    return [round(float(x), 4) for x in a[: n * step].reshape(n, step).max(axis=1)]


def _canon_ext(path: str) -> str:
    e = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {"jpeg": "jpg", "tif": "tiff", "jp2k": "jp2", "ntf": "nitf", "dicom": "dcm"}.get(e, e)


def spreadsheet_json(data: bytes) -> str:
    """Every sheet of an XLSX file: {sheet: {table: rows of cell strings, merged_cells: ["A1:B2", ...]}}."""
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    out = {}
    for ws in wb.worksheets:
        out[ws.title] = {"table": [[None if v is None else str(v) for v in row] for row in ws.iter_rows(values_only=True)],
                         "merged_cells": [str(r) for r in ws.merged_cells.ranges]}
    return json.dumps(out)


def dicom_layer_image(data: bytes, layer: Optional[int] = None):
    """A DICOM frame (the middle one by default) as an 8-bit grayscale or RGB image, windowed when the file says how."""
    import numpy as np
    import pydicom
    from PIL import Image

    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    try:
        arr = ds.pixel_array
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"this DICOM file's pixel data cannot be decoded here ({e})") from None
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    rgb = getattr(ds, "SamplesPerPixel", 1) == 3
    if frames > 1:
        idx = frames // 2 if layer is None else int(layer)
        if not 0 <= idx < frames:
            raise ValueError(f"layer {idx} is out of range (the file has {frames} layers)")
        arr = arr[idx]
    arr = arr.astype(np.float64) * float(getattr(ds, "RescaleSlope", 1) or 1) + float(getattr(ds, "RescaleIntercept", 0) or 0)
    center, width = getattr(ds, "WindowCenter", None), getattr(ds, "WindowWidth", None)
    if center is not None and width is not None:
        c = float(center[0] if hasattr(center, "__len__") and not isinstance(center, str) else center)
        w = float(width[0] if hasattr(width, "__len__") and not isinstance(width, str) else width)
        lo, hi = c - w / 2, c + w / 2
    else:
        lo, hi = float(arr.min()), float(arr.max())
    arr = np.clip((arr - lo) / max(hi - lo, 1e-9) * 255, 0, 255).astype(np.uint8)
    if getattr(ds, "PhotometricInterpretation", "") == "MONOCHROME1":
        arr = 255 - arr
    return Image.fromarray(arr, "RGB" if rgb else "L")
