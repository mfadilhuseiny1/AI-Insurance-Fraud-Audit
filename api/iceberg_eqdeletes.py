"""Reading Iceberg tables that have equality delete files (Flink, Spark's merge-on-read writers with equality
deletes, other engines). PyIceberg 0.12 plans and applies position deletes (and deletion vectors) but refuses
equality deletes; install() teaches it, so every read in this process — Dataset Preview, SQL / Custom SQL,
MERGE INTO's target read, compaction, exports, transforms on single node in-process, virtual tables — sees them:

- planning (ManifestGroupPlanner.plan_files): an equality delete file applies to a data file when the data file's
  data sequence number is strictly lower than the delete's, and the delete's partition spec is unpartitioned (a
  global delete) or both have the same spec id and partition values (Iceberg spec, "Scan Planning"). The delete
  files are added to the task's delete_files next to its position deletes.
- reading (ArrowScan): for a data file with equality deletes, the equality columns (by field id) of the data file
  and of each delete file are read, rows whose values equal a delete row's are found with null-safe equality (a
  null deletes a null) in DuckDB, one join per set of equality field ids, and their positions are applied as
  position deletes. Row filters, projections, position deletes and limits then work as they do.

Writes are unchanged: this platform's writers (copy-on-write) drop rows that equality deletes removed when they
rewrite a data file, and the rewritten file has a newer sequence number, so the old delete no longer applies to it.
"""

from __future__ import annotations

import logging
import sys
import threading
from typing import Any

log = logging.getLogger("bluesandai.iceberg")

_lock = threading.RLock()
_installed = False
_hooked = False
_PATCHED_VERSIONS = ("0.12.",)


# ------------------------------------------------------------------------------------------------
# planning
# ------------------------------------------------------------------------------------------------


class EqualityDeleteIndex:
    """Equality delete files of a scan, by partition (and the global ones, from unpartitioned specs)."""

    def __init__(self, table_metadata) -> None:  # noqa: ANN001
        self._specs = table_metadata.specs()
        self._global: list[tuple[int, Any]] = []
        self._by_partition: dict[tuple, list[tuple[int, Any]]] = {}

    def __bool__(self) -> bool:
        return bool(self._global or self._by_partition)

    @staticmethod
    def _key(spec_id: int, partition) -> tuple:  # noqa: ANN001
        from pyiceberg.typedef import Record

        return spec_id, partition if partition else Record()

    def add(self, entry) -> None:  # noqa: ANN001
        from pyiceberg.table.metadata import INITIAL_SEQUENCE_NUMBER

        f = entry.data_file
        seq = entry.sequence_number if entry.sequence_number is not None else INITIAL_SEQUENCE_NUMBER
        spec = self._specs.get(f.spec_id or 0)
        if spec is None or spec.is_unpartitioned():
            self._global.append((seq, f))
        else:
            self._by_partition.setdefault(self._key(f.spec_id or 0, f.partition), []).append((seq, f))

    def for_data_file(self, seq: int, data_file) -> set:  # noqa: ANN001
        out = {f for s, f in self._global if s > seq}
        for s, f in self._by_partition.get(self._key(data_file.spec_id or 0, data_file.partition), ()):
            if s > seq:
                out.add(f)
        return out


def _plan_files(self, manifests, manifest_entry_filter=lambda _: True):  # noqa: ANN001, ANN202
    """ManifestGroupPlanner.plan_files with equality deletes (the rest as PyIceberg 0.12 plans)."""
    from itertools import chain

    from pyiceberg.manifest import DataFileContent
    from pyiceberg.table import FileScanTask
    from pyiceberg.table.delete_file_index import DeleteFileIndex
    from pyiceberg.table.metadata import INITIAL_SEQUENCE_NUMBER
    from pyiceberg.typedef import KeyDefaultDict

    data_entries = []
    delete_index = DeleteFileIndex()
    equality = EqualityDeleteIndex(self.table_metadata)
    residual_evaluators = KeyDefaultDict(self._build_residual_evaluator)

    for entry in chain.from_iterable(self.plan_manifest_entries(manifests)):
        if not manifest_entry_filter(entry):
            continue
        f = entry.data_file
        if f.content == DataFileContent.DATA:
            data_entries.append(entry)
        elif f.content == DataFileContent.POSITION_DELETES:
            delete_index.add_delete_file(entry, partition_key=f.partition)
        elif f.content == DataFileContent.EQUALITY_DELETES:
            equality.add(entry)
        else:
            raise ValueError(f"Unknown DataFileContent ({f.content}): {entry}")

    tasks = []
    for entry in data_entries:
        f = entry.data_file
        seq = entry.sequence_number or INITIAL_SEQUENCE_NUMBER
        deletes = delete_index.for_data_file(seq, f, partition_key=f.partition)
        if equality:
            deletes = deletes | equality.for_data_file(seq, f)
        tasks.append(FileScanTask(f, delete_files=deletes, residual=residual_evaluators[f.spec_id](f).residual_for(f.partition)))
    return tasks


# ------------------------------------------------------------------------------------------------
# reading
# ------------------------------------------------------------------------------------------------


def _is_equality(f) -> bool:  # noqa: ANN001
    from pyiceberg.manifest import DataFileContent

    return f.content == DataFileContent.EQUALITY_DELETES


def _read_all_delete_files(io, tasks):  # noqa: ANN001, ANN202
    """pyiceberg.io.pyarrow._read_all_delete_files for position deletes only (equality deletes are read per task)."""
    import pyiceberg.io.pyarrow as P
    from pyiceberg.utils.concurrent import ExecutorFactory

    out: dict[str, list] = {}
    unique = {d for t in tasks for d in t.delete_files if not _is_equality(d)}
    if unique:
        for found in ExecutorFactory.get_or_create().map(lambda d: P._read_deletes(io, d), list(unique)):
            for path, arr in found.items():
                out.setdefault(path, []).append(arr)
    return out


def _schema_for(table_metadata, ids: set[int]):  # noqa: ANN001, ANN202
    """The newest table schema that has every equality field (a dropped column is still found in older schemas)."""
    current = table_metadata.schema()
    for s in [current, *reversed(table_metadata.schemas)]:
        known = s._lazy_id_to_field
        if all(i in known for i in ids):
            return s
    raise ValueError(f"equality delete field ids {sorted(ids)} are not in any schema of the table")


def _paths(schema, ids: list[int]) -> list[list[int]]:  # noqa: ANN001
    """For each field id, its path of child indexes in `schema` (top-level column, then struct fields)."""
    from pyiceberg.types import StructType

    found: dict[int, list[int]] = {}

    def walk(fields, prefix: list[int]) -> None:  # noqa: ANN001
        for i, f in enumerate(fields):
            found[f.field_id] = [*prefix, i]
            if isinstance(f.field_type, StructType):
                walk(f.field_type.fields, [*prefix, i])

    walk(schema.fields, [])
    missing = [i for i in ids if i not in found]
    if missing:
        raise ValueError(f"equality delete field ids {missing} cannot be read (fields in lists or maps are not allowed)")
    return [found[i] for i in ids]


def _keys(table, schema, ids: list[int]):  # noqa: ANN001, ANN202
    """The equality columns of `table` (read with `schema`) as a flat Arrow table k0..kn."""
    import pyarrow as pa
    import pyarrow.compute as pc

    cols = []
    for path in _paths(schema, ids):
        col = table.column(path[0]).combine_chunks() if table.num_rows else pa.array([], table.schema.field(path[0]).type)
        for idx in path[1:]:
            col = pc.struct_field(col, [idx])
        cols.append(col)
    return pa.table(cols, names=[f"k{i}" for i in range(len(ids))])


def _read_columns(scan, file, schema, ids: set[int]):  # noqa: ANN001, ANN202
    """Every row of one data or delete file, only the fields `ids`, projected onto `schema` (by field id; columns the
    file lacks read as their identity partition value or null), in file order."""
    import pyarrow as pa
    import pyiceberg.io.pyarrow as P
    from pyiceberg.expressions import AlwaysTrue
    from pyiceberg.schema import prune_columns
    from pyiceberg.table import FileScanTask

    md = scan._table_metadata
    projected = prune_columns(schema, set(ids), select_full_types=False)
    batches = list(P._task_to_record_batches(
        scan._io, FileScanTask(file), AlwaysTrue(), projected, schema, set(ids), None, scan._case_sensitive,
        md.name_mapping(), md.specs().get(file.spec_id), md.format_version, scan._downcast_ns_timestamp_to_us))
    target = P.schema_to_pyarrow(projected, include_field_ids=False)
    if not batches:
        return projected, target.empty_table()
    out = pa.concat_tables([pa.Table.from_batches([b]) for b in batches], promote_options="permissive")
    return projected, out


def _delete_keys(scan, delete_file, ids: list[int]):  # noqa: ANN001, ANN202
    """One equality delete file's rows, as key columns over `ids` (cached on the scan: a delete file usually applies
    to many data files)."""
    cache = scan.__dict__.setdefault("_bsai_eq_cache", {})
    key = (delete_file.file_path, tuple(ids))
    with _lock:
        hit = cache.get(key)
    if hit is not None:
        return hit
    schema = _schema_for(scan._table_metadata, set(ids))
    projected, rows = _read_columns(scan, delete_file, schema, set(ids))
    keys = _keys(rows, projected, ids)
    with _lock:
        cache[key] = keys
    return keys


def equality_deleted_positions(scan, task):  # noqa: ANN001, ANN202
    """Positions (int64, in file order) of the task's data file rows that its equality delete files delete."""
    import duckdb
    import pyarrow as pa

    groups: dict[tuple[int, ...], list] = {}
    for d in task.delete_files:
        if _is_equality(d):
            ids = tuple(d.equality_ids or ())
            if not ids:
                raise ValueError(f"equality delete file without equality field ids: {d.file_path}")
            groups.setdefault(ids, []).append(d)
    if not groups:
        return pa.array([], pa.int64())
    all_ids = {i for ids in groups for i in ids}
    schema = _schema_for(scan._table_metadata, all_ids)
    projected, rows = _read_columns(scan, task.file, schema, all_ids)
    if rows.num_rows != task.file.record_count:
        raise ValueError(f"cannot apply equality deletes to {task.file.file_path}: read {rows.num_rows} of "
                         f"{task.file.record_count} rows")
    deleted = []
    con = duckdb.connect()
    try:
        for ids, files in groups.items():
            ids_l = list(ids)
            dk = pa.concat_tables([_delete_keys(scan, f, ids_l) for f in files], promote_options="permissive")
            if not dk.num_rows:
                continue
            data = _keys(rows, projected, ids_l)
            data = data.append_column("pos", pa.array(range(data.num_rows), pa.int64()))
            con.register("eq_data", data)
            con.register("eq_deletes", dk)
            on = " AND ".join(f"d.k{i} IS NOT DISTINCT FROM e.k{i}" for i in range(len(ids_l)))
            hit = con.sql(f"SELECT d.pos FROM eq_data d SEMI JOIN (SELECT DISTINCT * FROM eq_deletes) e ON {on}").arrow()
            hit = hit.read_all() if hasattr(hit, "read_all") else hit
            deleted.append(hit.column("pos").combine_chunks().cast(pa.int64()))
            con.unregister("eq_data")
            con.unregister("eq_deletes")
    finally:
        con.close()
    if not deleted:
        return pa.array([], pa.int64())
    return pa.concat_arrays(deleted) if len(deleted) > 1 else deleted[0]


def _record_batches_from_scan_tasks_and_deletes(self, tasks, deletes_per_file):  # noqa: ANN001, ANN202
    """ArrowScan._record_batches_from_scan_tasks_and_deletes (PyIceberg 0.12) with equality deletes applied as
    position deletes."""
    import pyarrow as pa
    import pyiceberg.io.pyarrow as P

    total = 0
    for task in tasks:
        if self._limit is not None and total >= self._limit:
            break
        positional = deletes_per_file.get(task.file.file_path)
        if any(_is_equality(d) for d in task.delete_files):
            pos = equality_deleted_positions(self, task)
            if len(pos):
                positional = [*(positional or []), pa.chunked_array([pos])]
        batches = P._task_to_record_batches(
            self._io, task, self._bound_row_filter, self._projected_schema, self._table_metadata.schema(),
            self._projected_field_ids, positional, self._case_sensitive, self._table_metadata.name_mapping(),
            self._table_metadata.specs().get(task.file.spec_id), self._table_metadata.format_version,
            self._downcast_ns_timestamp_to_us, self._dictionary_columns)
        for batch in batches:
            if self._limit is not None:
                if total >= self._limit:
                    break
                if total + len(batch) >= self._limit:
                    batch = batch.slice(0, self._limit - total)
            yield batch
            total += len(batch)


# ------------------------------------------------------------------------------------------------
# installing
# ------------------------------------------------------------------------------------------------


def install() -> bool:
    """Patch PyIceberg (once per process). Returns whether equality deletes are now read."""
    global _installed
    with _lock:
        if _installed:
            return True
        import pyiceberg
        import pyiceberg.io.pyarrow as P
        import pyiceberg.table as T

        if not str(pyiceberg.__version__).startswith(_PATCHED_VERSIONS) or not hasattr(T, "ManifestGroupPlanner") \
                or not hasattr(P.ArrowScan, "_record_batches_from_scan_tasks_and_deletes"):
            log.warning("equality delete files: PyIceberg %s is not a version this patch knows; not installed", pyiceberg.__version__)
            return False
        T.ManifestGroupPlanner.plan_files = _plan_files
        P._read_all_delete_files = _read_all_delete_files
        P.ArrowScan._record_batches_from_scan_tasks_and_deletes = _record_batches_from_scan_tasks_and_deletes
        _installed = True
        return True


class _AfterImport:
    """A meta path finder that installs the patch as soon as PyIceberg's table module has been imported (so reads
    that do not go through this platform's catalog, such as the Iceberg REST catalog connector, see equality
    deletes too) without importing PyIceberg when the API starts."""

    WATCH = ("pyiceberg.table", "pyiceberg.io.pyarrow")

    @staticmethod
    def ready() -> bool:
        """pyiceberg.table is loaded, and pyiceberg.io.pyarrow is loaded or not started (they import each other)."""
        t, p = sys.modules.get("pyiceberg.table"), sys.modules.get("pyiceberg.io.pyarrow")
        return t is not None and hasattr(t, "ManifestGroupPlanner") and (p is None or hasattr(p, "ArrowScan"))

    def find_spec(self, name, path=None, target=None):  # noqa: ANN001, ANN201
        if name not in self.WATCH or _installed:
            return None
        import importlib.machinery

        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return None
        loader = spec.loader
        exec_module = loader.exec_module

        def run(module) -> None:  # noqa: ANN001
            exec_module(module)
            if _installed or not self.ready():
                return
            try:
                install()
            except Exception:  # noqa: BLE001 - never break an import
                log.exception("equality delete files: patch not installed")

        loader.exec_module = run
        return spec


def hook() -> None:
    """Install now when PyIceberg is loaded, else as soon as it is."""
    global _hooked
    with _lock:
        if _installed:
            return
        if _AfterImport.ready():
            install()
            return
        if not _hooked:
            sys.meta_path.insert(0, _AfterImport())
            _hooked = True
