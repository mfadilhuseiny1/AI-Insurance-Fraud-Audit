"""`transforms.tables` in Python transforms (Palantir's "Transforms with Iceberg" docs): Iceberg table inputs and
outputs, run by code_runner.py through Foundry's Iceberg REST catalog (iceberg_rest.py) as the build's job — the
build's commits are staged and swapped in together when it succeeds, its reads pinned (iceberg_catalog.py).

Declarations: `TableInput(path or rid)`, `TableOutput(path)`, in `@transform.using(...)` (single node),
`@transform.spark.using(...)` or `@transform(...)` (Spark).

Single node — IcebergInput / IcebergOutput (and Incremental… for incremental transforms):
  `.polars()` (a LazyFrame), `.pandas()`, `.arrow(row_filter=None)`, `.table()` (the PyIceberg Table: upsert, delete,
  overwrite, transactions, scans at snapshots), `.current_snapshot_id` / `.previous_snapshot_id`;
  `output.write_table(df)` (Polars, pandas, Arrow, a DuckDB relation): replaces the table in one snapshot, or appends
  on an incremental run; `output.table()` is None before the first write; `output.iceberg().table()`.
Spark — TableTransformInput / TableTransformOutput (IncrementalTableTransformInput):
  `.dataframe()`, `.write_dataframe(df)`, `.identifier` / `.catalog` for Iceberg Spark SQL (MERGE INTO, UPDATE,
  DELETE, ALTER TABLE, CALL system.* procedures, `<identifier>.snapshots`) and DataFrameWriterV2; incremental
  `source.changelog([ids])` (identifier changelog; no ids: net changes) and `output.apply_changelog(df, keys)`.
Spark runs with the Iceberg Spark runtime (iceberg-spark-runtime-3.5_2.12, downloaded once by code_java.py).

Virtual tables (virtual_tables.py; Foundry-native compute): a TableInput naming a virtual table is read through its
source before the transform runs (`.dataframe(options=...)` on Spark — JDBC partitioning options repartition the
DataFrame —, `.pandas()` / `.polars()` / `.arrow()` on a single node); `TableOutput(path, source, SnowflakeTable(...) |
BigQueryTable(...) | DatabricksTable(...) | IcebergTable(...) | FilesTable(...) | DeltaTable(...))` is written with
`write_dataframe` / `write_table` and replaces the external table after the build.

Incremental (`@incremental(v2_semantics=True).with_table_incremental_options(table_read_mode=...)`): a table input
is read from the snapshot the last build read (exclusive) to its current one. `append_only` (default) resolves over
append and replace (compaction) snapshots only; `changelog` over every kind (Spark only). Otherwise the build runs
non-incrementally — or fails with require_incremental=True.
"""

from __future__ import annotations

import os
from typing import Any, Optional

READ_MODES = ("append_only", "changelog")
CHANGE_TYPE = "_change_type"
CHANGE_ORDINAL = "_change_ordinal"
# set by code_runner from the spec: {uri, token, branch, job, inputs: {param: {rid, item_id, spark}}, outputs: {...},
# preview, spark_jar}
CTX: dict[str, Any] = {}


# ------------------------------------------------------------------------------------------------
# declarations
# ------------------------------------------------------------------------------------------------


class TableInput:
    """An Iceberg table input: its Files path or RID (ri.tables.main.table.<id>)."""

    def __init__(self, path: Optional[str] = None, branch: Optional[str] = None, description: Optional[str] = None, **_: object) -> None:
        if not path:
            raise TypeError("TableInput(...) needs the Iceberg table's path or RID")
        self.ref = path
        self.branch = branch
        self.description = description
        self.checks: list = []


class _Locator:
    """Where a virtual table output is stored in the external system."""

    fields: tuple[str, ...] = ()

    def __init__(self, *args: object, **kwargs: object) -> None:
        values = dict(zip(self.fields, args))
        values.update({k: v for k, v in kwargs.items() if k in self.fields})
        self.values = values

    def to_dict(self) -> dict:
        return {"type": type(self).__name__, **{k: v for k, v in self.values.items() if v is not None}}

    def __repr__(self) -> str:
        return f"{type(self).__name__}({', '.join(f'{k}={v!r}' for k, v in self.values.items())})"


class SnowflakeTable(_Locator):
    fields = ("database", "schema", "table")


class BigQueryTable(_Locator):
    fields = ("project", "dataset", "table")


class DatabricksTable(_Locator):
    fields = ("catalog", "schema", "table", "format", "location")


class DeltaTable(_Locator):
    fields = ("path",)


class FilesTable(_Locator):
    fields = ("path", "format")


class IcebergTable(_Locator):
    fields = ("table", "warehouse_path")


class TableOutput:
    """An Iceberg table output: a Files path ("/Project/folder/table"), or a name in the repository's output folder.
    With a source and a locator: a virtual table output written to that source."""

    def __init__(self, path: Optional[str] = None, source: Optional[str] = None, table: Optional[_Locator] = None,
                 description: Optional[str] = None, **_: object) -> None:
        if not path:
            raise TypeError("TableOutput(...) needs the Iceberg table's path")
        if (source is None) != (table is None):
            raise TypeError("a virtual table output needs both its source RID and its table locator: TableOutput(path, source, SnowflakeTable(...))")
        if table is not None and not isinstance(table, _Locator):
            raise TypeError("TableOutput's table must be a SnowflakeTable, BigQueryTable, DatabricksTable, DeltaTable, FilesTable or IcebergTable")
        self.source = source
        self.locator = table.to_dict() if table is not None else None
        name = path.rstrip("/")
        self.ref = name
        self.name = name.rsplit("/", 1)[-1]
        self.folder = (name.rsplit("/", 1)[0].strip("/") or None) if "/" in name else None
        self.description = description
        self.checks: list = []


# ------------------------------------------------------------------------------------------------
# the catalog client
# ------------------------------------------------------------------------------------------------

_catalog: dict[str, Any] = {}


def catalog():
    """A PyIceberg REST catalog on Foundry's Iceberg catalog, as this build's job (and branch)."""
    if "c" in _catalog:
        return _catalog["c"]
    try:
        # equality delete files are applied on read (iceberg_eqdeletes.py); PyIceberg alone refuses them
        import iceberg_eqdeletes

        iceberg_eqdeletes.hook()
    except Exception:  # noqa: BLE001 - without the patch, tables without equality deletes still read
        pass
    if os.name == "nt":
        # file:///D:/warehouse/... is a drive path, as in the API process (iceberg_catalog._patch_windows_paths):
        # without it PyArrowFileIO opens /D:/warehouse/... and every write to a local warehouse fails. Patched here, not
        # by importing iceberg_catalog: that would load auth / db / drive into the process running the user's code
        try:
            import re

            from pyiceberg.io.pyarrow import PyArrowFileIO

            if not getattr(PyArrowFileIO.parse_location, "_bsai_drive_paths", False):
                original = PyArrowFileIO.parse_location

                def parse_location(location: str, properties=None):  # noqa: ANN001, ANN202
                    m = re.match(r"^file:/{1,3}([A-Za-z]:[/\\].*)$", location or "")
                    if m:
                        return "file", "", m.group(1)
                    return original(location, properties) if properties is not None else original(location)

                parse_location._bsai_drive_paths = True  # type: ignore[attr-defined]
                PyArrowFileIO.parse_location = staticmethod(parse_location)
        except Exception as e:  # noqa: BLE001 - object-store warehouses still work without it
            import sys

            print(f"warning: Windows drive paths for Iceberg not patched: {e}", file=sys.stderr)
    from pyiceberg.catalog import load_rest

    props = {"uri": CTX["uri"]}
    if CTX.get("token"):
        props["token"] = CTX["token"]
    if CTX.get("job"):
        props["header.X-PLTR-Job"] = CTX["job"]
    if CTX.get("branch"):
        props["header.X-PLTR-Branch"] = CTX["branch"]
    _catalog["c"] = load_rest("foundry", props)
    return _catalog["c"]


def _ident(entry: dict) -> tuple[str, ...]:
    return ("ri", "tables", "main", "table", entry["item_id"])


def _spark_ident(entry: dict) -> str:
    parts = [*entry["namespace"], entry["name"]]
    return "foundry." + ".".join("`" + p.replace("`", "``") + "`" for p in parts)


def _load(entry: dict):
    return catalog().load_table(_ident(entry))


def _head(tbl) -> Optional[int]:
    r = tbl.metadata.refs.get("main")
    return r.snapshot_id if r else None


def _ancestry(tbl, snapshot_id: Optional[int]) -> list:
    out, seen = [], set()
    s = tbl.metadata.snapshot_by_id(snapshot_id) if snapshot_id is not None else None
    while s is not None and s.snapshot_id not in seen:
        out.append(s)
        seen.add(s.snapshot_id)
        s = tbl.metadata.snapshot_by_id(s.parent_snapshot_id) if s.parent_snapshot_id is not None else None
    return out


def snapshot_range(tbl, start: Optional[int], end: Optional[int]) -> Optional[list]:
    """The snapshots after `start` up to `end` (oldest first), or None when `start` is not an ancestor of `end`."""
    chain = _ancestry(tbl, end)
    if start is None:
        return list(reversed(chain))
    ids = [s.snapshot_id for s in chain]
    if start not in ids:
        return None
    return list(reversed(chain[: ids.index(start)]))


# ------------------------------------------------------------------------------------------------
# incremental planning (called by code_runner._run_new)
# ------------------------------------------------------------------------------------------------


def plan(t: dict, spec: dict, plan_: Optional[dict]) -> dict:
    """Whether the table inputs can be read incrementally: {incremental, reason, ranges: {param: (start, end)},
    read: {param: snapshot id read}}. Pins every input's snapshot for the job (the first load pins it)."""
    inc = t.get("incremental") or {}
    mode = inc.get("table_read_mode") or "append_only"
    state = (spec.get("incremental_state") or {}).get("tables") or {}
    snaps = set(inc.get("snapshot_inputs") or [])
    out = {"incremental": bool(plan_ and plan_["incremental"]), "reason": (plan_ or {}).get("reason"), "ranges": {}, "read": {}}
    for param, entry in (CTX.get("inputs") or {}).items():
        tbl = _load(entry)
        cur = _head(tbl)
        out["read"][param] = str(cur) if cur is not None else None
        if not inc or param in snaps or not out["incremental"]:
            continue
        prev = state.get(param)
        prev = int(prev) if prev not in (None, "") else None
        if param not in state:
            out.update(incremental=False, reason=f"table input {param} is new")
            continue
        rng = snapshot_range(tbl, prev, cur)
        if rng is None:
            out.update(incremental=False, reason=f"table input {param} was replaced, rolled back or expired past the snapshot the last build read")
            continue
        if mode == "append_only":
            bad = [s for s in rng if s.summary and s.summary.operation.value not in ("append", "replace")]
            if bad:
                out.update(incremental=False, reason=f"table input {param} has a {bad[0].summary.operation.value} snapshot ({bad[0].snapshot_id}) "
                                                     "and is read in append_only mode")
                continue
        out["ranges"][param] = (prev, cur)
    if not out["incremental"] and inc and inc.get("require_incremental") and spec.get("incremental_state") and not spec.get("force_snapshot") \
            and not str(out["reason"] or "").startswith("semantic_version"):
        raise RuntimeError(f"require_incremental=True but this build cannot run incrementally: {out['reason']}")
    return out


# ------------------------------------------------------------------------------------------------
# single-node runtime objects
# ------------------------------------------------------------------------------------------------


class IcebergInput:
    """An Iceberg table input of a single-node transform."""

    def __init__(self, name: str, entry: dict, incremental: bool = False, rng: Optional[tuple] = None, snapshot_input: bool = False) -> None:
        self.name = name
        self._entry = entry
        self._incremental = incremental and not snapshot_input
        self._range = rng
        self._table = None

    def table(self):
        """The PyIceberg Table (at the snapshot this build pinned)."""
        if self._table is None:
            self._table = _load(self._entry)
        return self._table

    @property
    def identifier(self) -> tuple:
        return _ident(self._entry)

    @property
    def current_snapshot_id(self) -> Optional[int]:
        return _head(self.table())

    @property
    def previous_snapshot_id(self) -> Optional[int]:
        """The snapshot the last incremental build read (None on a non-incremental run)."""
        return self._range[0] if self._incremental and self._range else None

    def arrow(self, row_filter: Any = None, mode: str = "added"):
        """The rows (on an incremental run, those appended since the last build), as an Arrow table."""
        import pyarrow as pa

        tbl = self.table()
        cur = self.current_snapshot_id
        kw: dict = {}
        if row_filter is not None:
            kw["row_filter"] = row_filter
        if cur is None:
            return tbl.schema().as_arrow().empty_table() if tbl.schema().fields else pa.table({})
        if self._incremental and mode == "added":
            if not self._range:
                return tbl.scan(**kw).to_arrow()
            start, end = self._range
            if start == end:
                return tbl.schema().as_arrow().empty_table()
            return tbl.incremental_append_scan(from_snapshot_id_exclusive=start, to_snapshot_id_inclusive=end, **kw).to_arrow()
        if self._incremental and mode == "previous":
            start = self._range[0] if self._range else None
            return tbl.scan(snapshot_id=start, **kw).to_arrow() if start is not None else tbl.schema().as_arrow().empty_table()
        # the current state (pinned for the job), with the branch's schema
        return tbl.scan(**kw).to_arrow()

    def pandas(self, row_filter: Any = None, mode: str = "added"):
        return self.arrow(row_filter, mode).to_pandas()

    def polars(self, row_filter: Any = None, mode: str = "added", lazy: bool = True):
        import polars as pl

        df = pl.from_arrow(self.arrow(row_filter, mode))
        return df.lazy() if lazy else df

    def dataframe(self, mode: str = "added"):
        return self.polars(mode=mode)

    def changelog(self, identifier_columns: Optional[list] = None):
        raise TypeError("changelog() is available in Spark transforms only (@transform.spark.using): single-node transforms read "
                        "Iceberg tables incrementally in append_only mode")


IncrementalIcebergInput = IcebergInput


class _IcebergHandle:
    def __init__(self, out: "IcebergOutput") -> None:
        self._out = out

    def table(self):
        return self._out.table()


class IcebergOutput:
    """An Iceberg table output of a single-node transform."""

    def __init__(self, name: str, entry: Optional[dict], incremental: bool = False) -> None:
        self.name = name
        self._entry = entry
        self._incremental = incremental
        self.written: dict = {}
        self.preview_data = None

    @property
    def identifier(self) -> Optional[tuple]:
        return _ident(self._entry) if self._entry else None

    def table(self):
        """The PyIceberg Table, or None before the table's first write."""
        if not self._entry:
            return None
        tbl = _load(self._entry)
        if not tbl.schema().fields and not tbl.metadata.snapshots:
            return None
        return tbl

    def iceberg(self) -> _IcebergHandle:
        return _IcebergHandle(self)

    def write_table(self, df, **_: object) -> None:
        """Replace the table's rows with `df` (one snapshot; the schema follows df), or append them on an incremental
        run."""
        import code_pyapi
        import iceberg_write

        data = code_pyapi.to_arrow(df)
        data = iceberg_write.supported_arrow(data)
        if self._entry is None or CTX.get("preview"):
            self.preview_data = data
            self.written = {"rows": data.num_rows, "mode": "preview"}
            if self._entry is None:
                return
        tbl = _load(self._entry)
        if tbl.metadata.format_version >= 3:
            raise RuntimeError(f"{self.name} is a format version 3 Iceberg table: single-node transforms cannot write v3 tables yet "
                               "(PyIceberg writes v2) — write it from a Spark transform (@transform.spark.using)")
        if self._incremental and (tbl.schema().fields or tbl.metadata.snapshots):
            tbl = iceberg_write.evolve_to(tbl, data.schema)
            tbl.append(iceberg_write.prepare(tbl, data))
            mode = "APPEND"
        else:
            iceberg_write.replace_contents(tbl, data)
            mode = "SNAPSHOT"
        self.written = {"rows": data.num_rows, "mode": mode, "columns": [{"name": f.name, "type": str(f.type)} for f in data.schema]}

    write_pandas = write_table
    write_polars = write_table
    write_dataframe = write_table

    def arrow(self):
        tbl = self.table()
        if tbl is None:
            import pyarrow as pa

            return pa.table({})
        return tbl.scan().to_arrow()

    def apply_changelog(self, df, keys: list):
        raise TypeError("apply_changelog() is available in Spark transforms only (@transform.spark.using)")


IncrementalIcebergOutput = IcebergOutput


# ------------------------------------------------------------------------------------------------
# Spark runtime objects
# ------------------------------------------------------------------------------------------------


def spark_conf() -> dict:
    """Spark settings for the Iceberg catalog `foundry` (code_pyapi.spark_session adds them)."""
    conf = {
        "spark.jars": CTX["spark_jar"],
        "spark.sql.extensions": "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
        "spark.sql.catalog.foundry": "org.apache.iceberg.spark.SparkCatalog",
        "spark.sql.catalog.foundry.type": "rest",
        "spark.sql.catalog.foundry.uri": CTX["uri"],
        "spark.sql.catalog.foundry.default-namespace": "foundry",
        "spark.sql.catalog.foundry.cache-enabled": "false",
    }
    if CTX.get("token"):
        conf["spark.sql.catalog.foundry.token"] = CTX["token"]
    if CTX.get("job"):
        conf["spark.sql.catalog.foundry.header.X-PLTR-Job"] = CTX["job"]
    if CTX.get("branch"):
        conf["spark.sql.catalog.foundry.header.X-PLTR-Branch"] = CTX["branch"]
    return conf


def _spark():
    import code_pyapi

    return code_pyapi.spark_session()


class TableTransformInput:
    """An Iceberg table input of a Spark transform."""

    catalog = "foundry"

    def __init__(self, name: str, entry: dict, incremental: bool = False, rng: Optional[tuple] = None, snapshot_input: bool = False,
                 read_mode: str = "append_only") -> None:
        self.name = name
        self._entry = entry
        self._incremental = incremental and not snapshot_input
        self._range = rng
        self._read_mode = read_mode
        self._tbl = None

    @property
    def identifier(self) -> str:
        return _spark_ident(self._entry)

    def _pyiceberg(self):
        if self._tbl is None:
            self._tbl = _load(self._entry)
        return self._tbl

    @property
    def current_snapshot_id(self) -> Optional[int]:
        return _head(self._pyiceberg())

    @property
    def previous_snapshot_id(self) -> Optional[int]:
        return self._range[0] if self._incremental and self._range else None

    def dataframe(self, mode: str = "added"):
        spark = _spark()
        cur = self.current_snapshot_id
        if cur is None:
            from code_pyapi import spark_frame

            return spark_frame(self._pyiceberg().schema().as_arrow().empty_table())
        reader = spark.read.format("iceberg")
        if self._incremental and mode == "added" and self._range and self._range[0] is not None:
            start, end = self._range
            if start == end:
                return spark.read.option("snapshot-id", str(cur)).table(self.identifier).limit(0)
            return reader.option("start-snapshot-id", str(start)).option("end-snapshot-id", str(end)).load(self.identifier)
        if self._incremental and mode == "previous":
            start = self._range[0] if self._range else None
            if start is None:
                return spark.read.option("snapshot-id", str(cur)).table(self.identifier).limit(0)
            return spark.read.option("snapshot-id", str(start)).table(self.identifier)
        return spark.read.option("snapshot-id", str(cur)).table(self.identifier)

    def changelog(self, identifier_columns: Optional[list] = None):
        """The rows changed since the last build: an identifier changelog (INSERT, DELETE, UPDATE_BEFORE,
        UPDATE_AFTER) with identifier columns, else a net changes changelog (INSERT, DELETE); with _change_type and
        _change_ordinal columns."""
        if self._read_mode != "changelog":
            raise RuntimeError("changelog() needs the transform's inputs resolved in changelog read mode: add "
                               '.with_table_incremental_options(table_read_mode="changelog") to @incremental(...)')
        spark = _spark()
        tbl = self._pyiceberg()
        start = self._range[0] if self._incremental and self._range else None
        end = self.current_snapshot_id
        ids = [str(c) for c in (identifier_columns or [])]
        empty_cols = ", ".join(f"`{f.name}`" for f in tbl.schema().fields)
        if end is None or start == end:
            return spark.sql(f"SELECT {empty_cols}, CAST(NULL AS STRING) AS {CHANGE_TYPE}, CAST(NULL AS INT) AS {CHANGE_ORDINAL} "
                             f"FROM {self.identifier} LIMIT 0")
        rng = snapshot_range(tbl, start, end) or []
        for s in rng:
            p = s.summary.additional_properties if s.summary else {}
            if int(p.get("added-delete-files") or 0) or int(p.get("added-position-delete-files") or 0) or int(p.get("added-equality-delete-files") or 0):
                raise RuntimeError("Delete files are currently not supported in changelog scans: the input table had a merge-on-read "
                                   "delete, update or merge (keep tables read as changelogs on copy-on-write)")
        view = f"_foundry_changelog_{abs(hash((self.name, start, end))) % 10**8}"
        opts = [f"'end-snapshot-id', '{end}'"] + ([f"'start-snapshot-id', '{start}'"] if start is not None else [])
        ident = self.identifier.replace("'", "\\'")
        if ids:
            args = (f"identifier_columns => array({', '.join(repr(c) for c in ids)}), compute_updates => true")
        else:
            args = "net_changes => true"
        spark.sql(f"CALL foundry.system.create_changelog_view(table => '{ident}', changelog_view => '{view}', "
                  f"options => map({', '.join(opts)}), {args})")
        df = spark.table(view).drop("_commit_snapshot_id")
        if ids:
            dup = (df.groupBy(*ids, CHANGE_ORDINAL, CHANGE_TYPE).count().filter("count > 1").limit(1).collect())
            if dup:
                raise ValueError(f"Duplicate rows found for identifier columns {ids} in changelog view.")
            df = _latest_updates(df, ids)
        return df

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self.dataframe(), name)


IncrementalTableTransformInput = TableTransformInput


def _latest_updates(df, ids: list):
    """Foundry's step over Iceberg's changelog view: per identifier, the changes across the snapshot range collapse
    to the row as it was before the range and as it is after it — an update keeps the first UPDATE_BEFORE and the
    last UPDATE_AFTER; a row inserted in the range is an INSERT of its last image; one that existed and was deleted
    is a DELETE; one inserted and deleted within the range disappears."""
    from pyspark.sql import Window
    from pyspark.sql import functions as F

    cols = list(df.columns)
    is_before = F.col(CHANGE_TYPE).isin("UPDATE_BEFORE", "DELETE")
    everything = Window.partitionBy(*ids).rowsBetween(Window.unboundedPreceding, Window.unboundedFollowing)
    asc = Window.partitionBy(*ids).orderBy(F.col(CHANGE_ORDINAL).asc(), F.when(is_before, 0).otherwise(1))
    desc = Window.partitionBy(*ids).orderBy(F.col(CHANGE_ORDINAL).desc(), F.when(is_before, 1).otherwise(0))
    m = (df.withColumn("_ra", F.row_number().over(asc)).withColumn("_rd", F.row_number().over(desc))
           .withColumn("_ft", F.max(F.when(F.col("_ra") == 1, F.col(CHANGE_TYPE))).over(everything))
           .withColumn("_lt", F.max(F.when(F.col("_rd") == 1, F.col(CHANGE_TYPE))).over(everything)))
    existed = F.col("_ft").isin("UPDATE_BEFORE", "DELETE")
    kept = F.col("_lt").isin("INSERT", "UPDATE_AFTER")
    before = m.filter((F.col("_ra") == 1) & existed).withColumn(CHANGE_TYPE, F.when(kept, F.lit("UPDATE_BEFORE")).otherwise(F.lit("DELETE")))
    after = m.filter((F.col("_rd") == 1) & kept).withColumn(CHANGE_TYPE, F.when(existed, F.lit("UPDATE_AFTER")).otherwise(F.lit("INSERT")))
    return before.select(*cols).unionByName(after.select(*cols)).orderBy(CHANGE_ORDINAL)


class TableTransformOutput:
    """An Iceberg table output of a Spark transform."""

    catalog = "foundry"

    def __init__(self, name: str, entry: Optional[dict], incremental: bool = False) -> None:
        self.name = name
        self._entry = entry
        self._incremental = incremental
        self.written: dict = {}
        self.preview_data = None

    @property
    def identifier(self) -> str:
        if not self._entry:
            raise RuntimeError(f"output {self.name}: the Iceberg table does not exist yet (it is created by the first build, not by a preview)")
        return _spark_ident(self._entry)

    def _exists(self) -> bool:
        if not self._entry:
            return False
        tbl = _load(self._entry)
        return bool(tbl.schema().fields or tbl.metadata.snapshots)

    def write_dataframe(self, df, **_: object) -> None:
        """Replace the table with `df` (a table replace: the schema follows df), or append on an incremental run."""
        if self._entry is None or CTX.get("preview"):
            import code_pyapi

            self.preview_data = code_pyapi.to_arrow(df)
            self.written = {"rows": self.preview_data.num_rows, "mode": "preview"}
            if self._entry is None:
                return
        n = df.count()
        if self._incremental and self._exists():
            df.writeTo(self.identifier).append()
            mode = "APPEND"
        else:
            df.writeTo(self.identifier).using("iceberg").createOrReplace()
            mode = "SNAPSHOT"
        self.written = {"rows": int(n), "mode": mode, "columns": [{"name": f.name, "type": f.dataType.simpleString()} for f in df.schema.fields]}

    def dataframe(self, mode: str = "current"):
        spark = _spark()
        if not self._exists():
            return spark.createDataFrame([], "dummy string").drop("dummy")
        return spark.table(self.identifier)

    def apply_changelog(self, changelog_df, keys: list) -> None:
        """Merge a changelog into the table by its key columns: INSERT / UPDATE_AFTER upsert, DELETE deletes,
        UPDATE_BEFORE is ignored."""
        from pyspark.sql import functions as F

        keys = [str(k) for k in keys]
        if CHANGE_TYPE not in changelog_df.columns:
            raise ValueError(f"apply_changelog needs the changelog's {CHANGE_TYPE} column")
        missing = [k for k in keys if k not in changelog_df.columns]
        if missing:
            raise ValueError(f"apply_changelog: key columns {missing} are not in the changelog")
        changes = changelog_df.filter(F.col(CHANGE_TYPE) != "UPDATE_BEFORE")
        if changes.groupBy(*keys).count().filter("count > 1").limit(1).collect():
            raise Exception(f"apply_changelog failed: the changelog has multiple rows for key {keys} (deduplicate it first)")
        data_cols = [c for c in changelog_df.columns if c not in (CHANGE_TYPE, CHANGE_ORDINAL, "_commit_snapshot_id")]
        spark = _spark()
        if not self._exists():
            rows = changes.filter(F.col(CHANGE_TYPE) != "DELETE").select(*data_cols)
            if self._entry is None or CTX.get("preview"):
                import code_pyapi

                self.preview_data = code_pyapi.to_arrow(rows)
                self.written = {"rows": self.preview_data.num_rows, "mode": "preview"}
                return
            rows.writeTo(self.identifier).using("iceberg").createOrReplace()
            self.written = {"rows": rows.count(), "mode": "SNAPSHOT"}
            return
        target = spark.table(self.identifier)
        if target.groupBy(*keys).count().filter("count > 1").limit(1).collect():
            raise Exception(f"apply_changelog failed: multiple rows in destination table match key {keys}")
        view = f"_foundry_apply_{abs(hash(self.name)) % 10**8}"
        changes.createOrReplaceTempView(view)
        cols = [c for c in data_cols if c in target.columns]
        on = " AND ".join(f"t.`{k}` <=> s.`{k}`" for k in keys)
        sets = ", ".join(f"t.`{c}` = s.`{c}`" for c in cols)
        ins_cols = ", ".join(f"`{c}`" for c in cols)
        ins_vals = ", ".join(f"s.`{c}`" for c in cols)
        if self._entry is None or CTX.get("preview"):
            import code_pyapi

            self.preview_data = code_pyapi.to_arrow(changes)
            self.written = {"rows": self.preview_data.num_rows, "mode": "preview"}
            return
        spark.sql(f"MERGE INTO {self.identifier} t USING {view} s ON {on} "
                  f"WHEN MATCHED AND s.{CHANGE_TYPE} = 'DELETE' THEN DELETE "
                  f"WHEN MATCHED THEN UPDATE SET {sets} "
                  f"WHEN NOT MATCHED AND s.{CHANGE_TYPE} != 'DELETE' THEN INSERT ({ins_cols}) VALUES ({ins_vals})")
        self.written = {"rows": changes.count(), "mode": "UPDATE"}


# ------------------------------------------------------------------------------------------------
# for code_runner
# ------------------------------------------------------------------------------------------------


class VirtualTableInput:
    """A virtual table input (read through its source before the transform ran)."""

    def __init__(self, name: str, entry: dict, spark: bool) -> None:
        self.name = name
        self._entry = entry
        self._spark = spark

    def arrow(self, **_: object):
        import pyarrow.parquet as pq

        return pq.read_table(self._entry["path"])

    def pandas(self, **_: object):
        return self.arrow().to_pandas()

    def polars(self, lazy: bool = True, **_: object):
        import polars as pl

        return pl.scan_parquet(self._entry["path"]) if lazy else pl.read_parquet(self._entry["path"])

    def dataframe(self, options: Optional[dict] = None, **_: object):
        if not self._spark:
            return self.pandas()
        df = _spark().read.parquet(self._entry["path"])
        opts = options or {}
        if opts.get("numPartitions") and opts.get("partitionColumn"):
            # JDBC partitioning: the table is read already; its rows are spread over that many partitions by the column
            df = df.repartitionByRange(int(opts["numPartitions"]), opts["partitionColumn"])
        return df


class VirtualTableOutput:
    """A virtual table output: what the transform writes replaces the external table after the build."""

    def __init__(self, name: str, entry: dict) -> None:
        self.name = name
        self._entry = entry
        self.written: dict = {}
        self.preview_data = None

    def _write(self, df) -> None:
        import pyarrow.parquet as pq

        import code_pyapi

        data = code_pyapi.to_arrow(df)
        pq.write_table(data, self._entry["path"])
        self.preview_data = data
        self.written = {"rows": data.num_rows, "mode": "preview" if CTX.get("preview") else "SNAPSHOT", "virtual": True,
                        "columns": [{"name": f.name, "type": str(f.type)} for f in data.schema]}

    def write_dataframe(self, df, **_: object) -> None:
        self._write(df)

    def write_table(self, df, **_: object) -> None:
        self._write(df)

    def write(self, df, **_: object) -> None:
        self._write(df)

    def write_pandas(self, df, **_: object) -> None:
        self._write(df)


def runtime_objects(t: dict, spark: bool, tplan: dict, is_inc: bool) -> tuple[dict, dict]:
    """(inputs, outputs) runtime objects for a transform's table parameters."""
    inc = t.get("incremental") or {}
    snaps = set(inc.get("snapshot_inputs") or [])
    mode = inc.get("table_read_mode") or "append_only"
    ins, outs = {}, {}
    for param, entry in (CTX.get("inputs") or {}).items():
        rng = tplan["ranges"].get(param)
        if spark:
            ins[param] = TableTransformInput(param, entry, is_inc, rng, param in snaps, mode)
        else:
            ins[param] = IcebergInput(param, entry, is_inc, rng, param in snaps)
    for param, entry in (CTX.get("outputs") or {}).items():
        outs[param] = (TableTransformOutput if spark else IcebergOutput)(param, entry, is_inc)
    virtual = CTX.get("virtual") or {}
    for param, entry in (virtual.get("inputs") or {}).items():
        ins[param] = VirtualTableInput(param, entry, spark)
    for param, entry in (virtual.get("outputs") or {}).items():
        outs[param] = VirtualTableOutput(param, entry)
    return ins, outs


def configure(spec: dict) -> None:
    CTX.clear()
    CTX.update(spec.get("iceberg") or {})
    CTX["virtual"] = spec.get("virtual") or {}
    CTX["preview"] = spec.get("mode") == "preview"
    _catalog.clear()
    if not CTX.get("token"):
        CTX["token"] = os.environ.get("BLUESANDAI_API_TOKEN") or ""


NAMES = ("TableInput", "TableOutput", "IcebergInput", "IcebergOutput", "IncrementalIcebergInput", "IncrementalIcebergOutput",
         "TableTransformInput", "TableTransformOutput", "IncrementalTableTransformInput",
         "SnowflakeTable", "BigQueryTable", "DatabricksTable", "DeltaTable", "FilesTable", "IcebergTable")
