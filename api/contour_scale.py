"""Contour's engines for large inputs: which engine runs a path, and how its datasets are read (contour.py).

The in-memory engine (contour_engine.py) reads every source into an Arrow table and runs the boards' SQL with DuckDB.
For large inputs there are two more tiers:

- "duckdb-scan" (automatic): a dataset above the analysis' row or byte threshold is not read into memory. DuckDB scans
  its Parquet file lazily (a pyarrow dataset: only the columns and row groups a query needs, filters pushed down) and
  spills to a temporary directory past a memory limit. It runs exactly the SQL the in-memory engine runs, so its
  results are the same by construction; it is the default for large inputs because interactive boards stay
  interactive (no JVM to start, no job scheduling).
- "spark" (opt-in): the analysis' engine mode "spark" (or automatically above `spark_rows` when that is set) runs the
  path's boards through a local PySpark session (contour_spark.py: the boards as Spark SQL over the Parquet files).
  A local Spark session takes ~10 s to start and seconds per job, which is why it is not the automatic first tier.
  Boards Spark does not support (Cipher, object type and restricted view sources, map layers on fractional text
  columns, scatters on text / timestamp columns or switched to their rows, …) run the
  path on DuckDB instead, with a note saying why; when Spark cannot start or fails, the path runs on DuckDB too.

Saving a dataset, Build, CSV export and Code Workbook's Contour nodes use DuckDB (the scan tier for large inputs), so
saved datasets keep the in-memory engine's exact column types. Every run reports the engine that ran (`engine`).

The analysis' `engine` setting: {"mode": "auto" | "memory" | "spark", "large_rows": N, "large_bytes": N, "spark_rows": N}
— "memory" always reads sources into memory (the engine before this tier existed); the thresholds default to
BLUESANDAI_CONTOUR_LARGE_ROWS (1,000,000 rows) / BLUESANDAI_CONTOUR_LARGE_BYTES (128 MB) and
BLUESANDAI_CONTOUR_SPARK_ROWS (0: never automatically); BLUESANDAI_CONTOUR_MEMORY_LIMIT (4GB) caps a scanning query's
memory before it spills.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable, Optional

import contour_engine as E

MODES = ("auto", "memory", "spark")
DEFAULT_ROWS = int(os.environ.get("BLUESANDAI_CONTOUR_LARGE_ROWS") or 1_000_000)
DEFAULT_BYTES = int(os.environ.get("BLUESANDAI_CONTOUR_LARGE_BYTES") or 128 * 1024 * 1024)
DEFAULT_SPARK_ROWS = int(os.environ.get("BLUESANDAI_CONTOUR_SPARK_ROWS") or 0)
MEMORY_LIMIT = os.environ.get("BLUESANDAI_CONTOUR_MEMORY_LIMIT") or "4GB"


def settings(a: dict) -> dict:
    e = a.get("engine") if isinstance(a.get("engine"), dict) else {}
    mode = e.get("mode") or "auto"
    if mode not in MODES:
        raise E.ContourError(f"unknown engine mode {mode!r} (auto, memory or spark)")

    def num(k: str, d: int) -> int:
        try:
            v = int(e.get(k)) if e.get(k) not in (None, "") else d
        except (TypeError, ValueError):
            raise E.ContourError(f"the engine setting {k} must be a whole number") from None
        if v < 0:
            raise E.ContourError(f"the engine setting {k} cannot be negative")
        return v

    return {"mode": mode, "large_rows": num("large_rows", DEFAULT_ROWS), "large_bytes": num("large_bytes", DEFAULT_BYTES),
            "spark_rows": num("spark_rows", DEFAULT_SPARK_ROWS)}


def source_key(src: dict) -> str:
    """The relation name contour_engine.Compiler gives a source."""
    import re

    return f"src_{src.get('kind')}_{re.sub(r'[^A-Za-z0-9]', '_', str(src.get('id')))}"


def reachable_sources(a: dict, path_id: Optional[str]) -> list[dict]:
    """The dataset / object type / restricted view sources a path reads (its start, the paths it starts from, and the
    join / enrich / set math boards' other sides, map layers with a source of their own); every path's when path_id is
    None."""
    paths = {p["id"]: p for p in a.get("paths") or []}
    out: dict[str, dict] = {}
    seen: set[str] = set()

    def visit_src(src: Optional[dict]) -> None:
        if not isinstance(src, dict):
            return
        if src.get("kind") == "path":
            visit(src.get("id"))
        elif src.get("kind"):
            out.setdefault(source_key(src), src)

    def visit(pid: Optional[str]) -> None:
        if not pid or pid in seen or pid not in paths:
            return
        seen.add(pid)
        p = paths[pid]
        visit_src(p.get("source"))
        for b in p.get("boards") or []:
            if b.get("type") in ("join", "enrich", "set_math"):
                visit_src((b.get("config") or {}).get("source"))
            elif b.get("type") == "map":  # a map layer drawn from a source of its own
                for layer in (b.get("config") or {}).get("layers") or []:
                    if isinstance(layer, dict):
                        visit_src(layer.get("source"))

    for pid in ([path_id] if path_id else list(paths)):
        visit(pid)
    return list(out.values())


class Plan:
    """The engine decision for one request: each source's size, which datasets are scanned, whether to try Spark."""

    def __init__(self, a: dict, path_id: Optional[str], scale: bool = True) -> None:
        self.cfg = settings(a)
        if not scale:
            self.cfg["mode"] = "memory"
        self.stats: dict[str, dict] = {}
        self.notes: list[str] = []
        self.scan_dir: Optional[str] = None
        for src in reachable_sources(a, path_id):
            self.stat(src)

    def stat(self, src: dict) -> dict:
        """A source's rows / bytes (a dataset's file size and Parquet footer; nothing is read for the others)."""
        key = source_key(src)
        if key in self.stats:
            return self.stats[key]
        info: dict[str, Any] = {"key": key, "kind": src.get("kind"), "id": src.get("id"), "name": None, "rows": None, "bytes": None, "scan": False}
        if src.get("kind") == "dataset":
            try:
                import drive

                item = drive._item(src["id"])
                info["name"] = item.get("name")
                info["bytes"] = item.get("size") if item.get("size") is not None else item.get("size_bytes")
                info["rows"] = parquet_rows(item)
            except Exception:  # noqa: BLE001 — the loader reports an unreadable dataset with its own message
                pass
            c = self.cfg
            big = (info["rows"] or 0) >= c["large_rows"] > 0 or (info["bytes"] or 0) >= c["large_bytes"] > 0
            info["scan"] = bool(big and c["mode"] != "memory")
        self.stats[key] = info
        return info

    @property
    def scanning(self) -> bool:
        return any(s["scan"] for s in self.stats.values())

    def want_spark(self) -> bool:
        c = self.cfg
        if c["mode"] == "spark":
            return True
        return c["mode"] == "auto" and c["spark_rows"] > 0 and any((s["rows"] or 0) >= c["spark_rows"] for s in self.stats.values())

    def loader(self, load_memory: Callable[[dict], Any]) -> Callable[[dict], Any]:
        """The Compiler's source loader: a large dataset as a lazy pyarrow dataset over its Parquet file, the rest read
        into memory by `load_memory` (contour._load_source)."""
        def load(src: dict):
            info = self.stat(src)
            if src.get("kind") == "dataset" and info["scan"]:
                import drive
                import pyarrow.dataset as pads

                item = drive._item(src["id"])
                try:
                    return pads.dataset(dataset_file(item), format="parquet")
                except Exception as e:  # noqa: BLE001
                    raise E.ContourError(f'"{item["name"]}" is not a readable Parquet dataset: {e}') from None
            return load_memory(src)
        return load

    def spill_dir(self) -> str:
        if self.scan_dir is None:
            self.scan_dir = tempfile.mkdtemp(prefix="bsai-contour-")
        return self.scan_dir

    def compiler(self, a: dict, params: dict, load_memory: Callable[[dict], Any]) -> E.Compiler:
        comp = E.Compiler(a, params, self.loader(load_memory))
        if self.scanning:
            comp.duck_config = {"temp_directory": str(Path(self.spill_dir(), "spill")), "memory_limit": MEMORY_LIMIT}
            import weakref

            weakref.finalize(comp, shutil.rmtree, self.scan_dir, True)
        return comp

    def report(self, engine: str, notes: Optional[list[str]] = None) -> dict:
        """What a run says about its engine: duckdb (in memory), duckdb-scan or spark, the sources' sizes, notes."""
        return {"engine": engine, "mode": self.cfg["mode"], "large_rows": self.cfg["large_rows"], "large_bytes": self.cfg["large_bytes"],
                "sources": [{k: s[k] for k in ("kind", "id", "name", "rows", "bytes", "scan")} for s in self.stats.values()],
                "notes": list(self.notes) + list(notes or [])}

    def duck_engine(self) -> str:
        return "duckdb-scan" if self.scanning else "duckdb"


_ROWS: dict[tuple, Optional[int]] = {}


def _version(item: dict) -> tuple:
    return (item["id"], str(item.get("updated_at")), item.get("size_bytes") or item.get("size"))


def parquet_rows(item: dict) -> Optional[int]:
    """A Parquet dataset's row count from its footer alone (for S3 storage, a downloaded copy's footer or a ranged
    read of the file's end), remembered per version of the file."""
    key = _version(item)
    if key not in _ROWS:
        if len(_ROWS) > 2000:
            _ROWS.clear()
        _ROWS[key] = _parquet_rows(item)
    return _ROWS[key]


def _parquet_rows(item: dict) -> Optional[int]:
    import pyarrow.parquet as pq

    local = dataset_file(item, download=False)
    if local:
        return pq.ParquetFile(local).metadata.num_rows
    import storage

    def tail(n: int) -> bytes:
        return storage._s3().get_object(Bucket=storage._bucket(), Key=f"drive/{item['id']}", Range=f"bytes=-{n}")["Body"].read()

    end = tail(65536)
    if len(end) < 12 or end[-4:] != b"PAR1":
        return None
    n = int.from_bytes(end[-8:-4], "little")
    if n + 8 > len(end) and len(end) == 65536:  # a footer over 64 KB: read exactly it
        end = tail(n + 8)
    if n + 8 > len(end):
        return None
    # the footer behind a bare magic number: enough for pyarrow to read the metadata (no row group is read)
    return pq.ParquetFile(io.BytesIO(b"PAR1" + end[-(n + 8):])).metadata.num_rows


_DOWNLOADS: dict[tuple, str] = {}
_DOWNLOAD_LOCK = threading.Lock()


def dataset_file(item: dict, download: bool = True) -> Optional[str]:
    """A local path to a dataset's Parquet file, checked like drive.read_bytes (the item's markings): the stored file
    itself, or for S3 storage a downloaded copy (None when download is False)."""
    import auth
    import drive

    auth.check_item(item)
    if item.get("stored_in") != "s3":
        return str(drive.LOCAL_DIR / item["id"])
    key = _version(item)
    if key in _DOWNLOADS and Path(_DOWNLOADS[key]).exists():
        return _DOWNLOADS[key]
    if not download:
        return None
    with _DOWNLOAD_LOCK:  # one download per file version, even for concurrent requests
        if key in _DOWNLOADS and Path(_DOWNLOADS[key]).exists():
            return _DOWNLOADS[key]
        for old in [k for k in _DOWNLOADS if k[0] == item["id"]]:  # an older version of the file
            shutil.rmtree(Path(_DOWNLOADS.pop(old)).parent, ignore_errors=True)
        dest = Path(tempfile.mkdtemp(prefix="bsai-contour-s3-"), item["id"] + ".parquet")
        try:
            drive.copy_content(item, dest)
        except BaseException:
            shutil.rmtree(dest.parent, ignore_errors=True)
            raise
        _DOWNLOADS[key] = str(dest)
        return str(dest)
