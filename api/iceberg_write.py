"""Writing Iceberg tables with PyIceberg the way Foundry's APIs do (used by the catalog server and by Python transforms
in their own process, so nothing here imports the server's modules):
- replace_contents: a non-incremental write — the rows (and schema) replaced in ONE overwrite snapshot (an append
  snapshot when the table was empty), as Foundry's table replaces;
- rewrite_files: compaction — the branch's data rewritten (delete files applied) as a REPLACE snapshot;
- evolve_to / prepare: appends that add new columns, Arrow data cast to the table's schema;
- supported_arrow: nanosecond timestamps as microseconds (Foundry has no timestamp_ns), time columns refused.
"""

from __future__ import annotations

from typing import Any, Optional

import iceberg_eqdeletes

# PyIceberg scans in this process (the API, or a transform's process once it imports this) read equality deletes
iceberg_eqdeletes.hook()

MAIN = "main"


def supported_arrow(data):
    """Arrow data Foundry's Iceberg tables accept: timestamp[ns] becomes timestamp[us]; time columns are refused."""
    import pyarrow as pa

    fields, cols, changed = [], [], False
    for f, c in zip(data.schema, data.columns):
        t = f.type
        if pa.types.is_time(t):
            raise ValueError(f'column "{f.name}" has type {t}: Foundry Iceberg tables do not support time columns — convert it to a string or timestamp')
        if pa.types.is_timestamp(t) and t.unit == "ns":
            t = pa.timestamp("us", tz=t.tz)
            c = c.cast(t, safe=False)
            changed = True
        fields.append(pa.field(f.name, t, f.nullable, f.metadata))
        cols.append(c)
    return pa.Table.from_arrays(cols, schema=pa.schema(fields)) if changed else data


def evolve_to(tbl, arrow_schema) -> Any:
    """Make the table's schema accept an Arrow table's columns (adds new ones, widens types); returns the reloaded
    table."""
    if not len(tbl.schema().fields):
        with tbl.update_schema() as u:
            u.union_by_name(arrow_schema)
        return tbl.refresh()
    have = {f.name for f in tbl.schema().fields}
    if any(n not in have for n in arrow_schema.names):
        with tbl.update_schema() as u:
            u.union_by_name(arrow_schema)
        return tbl.refresh()
    return tbl


def prepare(tbl, data):
    """An Arrow table matching the Iceberg schema's column order and types (missing columns as nulls)."""
    import pyarrow as pa

    target = tbl.schema().as_arrow()
    cols = []
    for f in target:
        if f.name in data.column_names:
            c = data.column(f.name)
            if c.type != f.type:
                try:
                    c = c.cast(f.type)
                except (pa.ArrowInvalid, pa.ArrowNotImplementedError):
                    pass
            cols.append(c)
        else:
            cols.append(pa.nulls(data.num_rows, f.type))
    return pa.Table.from_arrays(cols, schema=pa.schema([pa.field(f.name, f.type, f.nullable) for f in target]))


def _dropping_deletes(base):
    """`base` (a PyIceberg overwrite producer) that can also remove delete files (position or equality) with
    drop_delete_file(): PyIceberg 0.12 removes data files only (a delete file passed to delete_data_file fails its
    "missing required files" check). Their delete manifests are rewritten without them (as delete manifests) and
    the removed ones recorded as DELETED entries; the summary counts them as removed. Only for writes that remove
    every data file the dropped delete files apply to."""
    from pyiceberg.manifest import ManifestContent, ManifestEntry, ManifestEntryStatus, ManifestWriterV2

    class _DeleteManifestWriter(ManifestWriterV2):
        def content(self) -> ManifestContent:
            return ManifestContent.DELETES

        @property
        def _meta(self) -> dict:
            return {**super()._meta, "content": "deletes"}

    def entry(e, status):  # noqa: ANN001, ANN202
        return ManifestEntry.from_args(status=status, snapshot_id=e.snapshot_id, sequence_number=e.sequence_number,
                                       file_sequence_number=e.file_sequence_number, data_file=e.data_file)

    class Producer(base):
        dropped: frozenset = frozenset()

        def drop_delete_file(self, f) -> None:  # noqa: ANN001
            self.dropped = self.dropped | {f}

        def _write(self, spec_id: int, entries: list):  # noqa: ANN202
            w = _DeleteManifestWriter(self.spec(spec_id), self.schema(), self.new_manifest_output(), self._snapshot_id, self._compression)
            with w:
                for e in entries:
                    w.add_entry(e)
            return w.to_manifest_file()

        def _existing_manifests(self) -> list:
            manifests = super()._existing_manifests()
            if not self.dropped:
                return manifests
            out = []
            for m in manifests:
                if m.content != ManifestContent.DELETES:
                    out.append(m)
                    continue
                entries = m.fetch_manifest_entry(self._io, discard_deleted=True)
                keep = [e for e in entries if e.data_file not in self.dropped]
                if len(keep) == len(entries):
                    out.append(m)
                    continue
                gone = [ManifestEntry.from_args(status=ManifestEntryStatus.DELETED, snapshot_id=self._snapshot_id,
                                                sequence_number=e.sequence_number, file_sequence_number=e.file_sequence_number,
                                                data_file=e.data_file) for e in entries if e.data_file in self.dropped]
                out.append(self._write(m.partition_spec_id, [entry(e, ManifestEntryStatus.EXISTING) for e in keep] + gone))
            return out

        def _summary(self, snapshot_properties: dict = {}):  # noqa: ANN202, B006 - pyiceberg's signature
            saved = self._deleted_data_files
            self._deleted_data_files = saved | set(self.dropped)
            try:
                return super()._summary(snapshot_properties)
            finally:
                self._deleted_data_files = saved

    return Producer


def replace_contents(tbl, data, branch: str = MAIN, properties: Optional[dict] = None):
    """Replace every row with `data` in ONE overwrite snapshot (an append snapshot when the table is empty), the
    schema replaced to match (as Foundry's non-incremental writes do with a table replace)."""
    from pyiceberg.io.pyarrow import _dataframe_to_data_files
    from pyiceberg.table.snapshots import Operation
    from pyiceberg.table.update.snapshot import _OverwriteFiles

    names = data.schema.names
    cur = [f.name for f in tbl.schema().fields]
    if cur != names or any(str(a) != str(b) for a, b in zip(tbl.schema().as_arrow().types, data.schema.types)):
        with tbl.update_schema(allow_incompatible_changes=True) as u:
            for n in cur:
                if n not in names:
                    u.delete_column(n)
            u.union_by_name(data.schema)
        tbl = tbl.refresh()
    data = prepare(tbl, data)
    existing = list(tbl.scan(snapshot_id=tbl.metadata.refs[branch].snapshot_id).plan_files()) if branch in tbl.metadata.refs else []
    if not existing:
        tbl.append(data, branch=branch, snapshot_properties=properties or {})
        return tbl.refresh()
    with tbl.transaction() as tx:
        prod = _dropping_deletes(_OverwriteFiles)(Operation.OVERWRITE, tx, tbl.io, branch=branch, snapshot_properties=properties or {})
        for task in existing:
            prod.delete_data_file(task.file)
            for d in task.delete_files:
                prod.drop_delete_file(d)
        # no rows: a snapshot that only removes files (PyIceberg's bin-packing divides by the row count)
        if data.num_rows:
            for f in _dataframe_to_data_files(table_metadata=tx.table_metadata, write_uuid=prod.commit_uuid, df=data, io=tbl.io):
                prod.append_data_file(f)
        prod.commit()
    return tbl.refresh()


def rewrite_files(tbl, branch: str = MAIN, target_file_size: Optional[int] = None, properties: Optional[dict] = None) -> dict:
    """Compaction: rewrite the branch's data (applying delete files) into new files, committed as a REPLACE snapshot
    (the logical contents do not change). Returns {rewritten, added}."""
    import pyarrow as pa
    from pyiceberg.io.pyarrow import _dataframe_to_data_files
    from pyiceberg.table.snapshots import Operation, Summary
    from pyiceberg.table.update.snapshot import _OverwriteFiles

    class _Replace(_OverwriteFiles):
        def _summary(self, snapshot_properties: dict = {}) -> Summary:  # noqa: B006 - pyiceberg's signature
            self._operation = Operation.OVERWRITE
            try:
                s = super()._summary(snapshot_properties)
            finally:
                self._operation = Operation.REPLACE
            return Summary(Operation.REPLACE, **s.additional_properties)

    if branch not in tbl.metadata.refs:
        return {"rewritten": 0, "added": 0}
    snap = tbl.metadata.refs[branch].snapshot_id
    tasks = list(tbl.scan(snapshot_id=snap).plan_files())
    if not tasks:
        return {"rewritten": 0, "added": 0}
    data = tbl.scan(snapshot_id=snap).to_arrow()
    props = dict(tbl.metadata.properties)
    if target_file_size:
        props["write.target-file-size-bytes"] = str(int(target_file_size))
    with tbl.transaction() as tx:
        prod = _dropping_deletes(_Replace)(Operation.REPLACE, tx, tbl.io, branch=branch, snapshot_properties=properties or {})
        for t in tasks:
            prod.delete_data_file(t.file)
            for d in t.delete_files:
                prod.drop_delete_file(d)
        md = tx.table_metadata.model_copy(update={"properties": props})
        added = 0
        for f in _dataframe_to_data_files(table_metadata=md, write_uuid=prod.commit_uuid, df=data if data.num_rows else pa.table({}), io=tbl.io):
            prod.append_data_file(f)
            added += 1
        prod.commit()
    return {"rewritten": len(tasks), "added": added}


def rewrite_manifests(tbl, branch: str = MAIN, properties: Optional[dict] = None) -> dict:
    """Consolidate the branch's data manifests into one per partition spec (entries kept as EXISTING, with their
    sequence numbers): a REPLACE snapshot; delete-file manifests are carried over as they are."""
    from collections import defaultdict

    from pyiceberg.manifest import ManifestContent, ManifestEntry, ManifestEntryStatus
    from pyiceberg.table.snapshots import Operation, Summary
    from pyiceberg.table.update.snapshot import _OverwriteFiles

    ref = tbl.metadata.refs.get(branch)
    if ref is None:
        return {"manifests_before": 0, "manifests_after": 0}
    current = tbl.metadata.snapshot_by_id(ref.snapshot_id).manifests(tbl.io)
    data = [m for m in current if m.content == ManifestContent.DATA]
    if len(data) <= 1:
        return {"manifests_before": len(current), "manifests_after": len(current), "skipped": "nothing to consolidate"}

    class _Rewrite(_OverwriteFiles):
        def _summary(self, snapshot_properties: dict = {}) -> Summary:  # noqa: B006 - pyiceberg's signature
            self._operation = Operation.OVERWRITE
            try:
                s = super()._summary(snapshot_properties)
            finally:
                self._operation = Operation.REPLACE
            return Summary(Operation.REPLACE, **s.additional_properties)

        def _manifests(self):  # noqa: ANN202
            by_spec = defaultdict(list)
            for m in data:
                for e in m.fetch_manifest_entry(tbl.io, discard_deleted=True):
                    by_spec[m.partition_spec_id].append(e)
            out = []
            for spec_id, entries in by_spec.items():
                with self.new_manifest_writer(self.spec(spec_id)) as w:
                    for e in entries:
                        w.add_entry(ManifestEntry.from_args(status=ManifestEntryStatus.EXISTING, snapshot_id=e.snapshot_id,
                                                            sequence_number=e.sequence_number, file_sequence_number=e.file_sequence_number,
                                                            data_file=e.data_file))
                out.append(w.to_manifest_file())
            return out + [m for m in current if m.content != ManifestContent.DATA]

    with tbl.transaction() as tx:
        _Rewrite(Operation.REPLACE, tx, tbl.io, branch=branch, snapshot_properties=properties or {}).commit()
    tbl = tbl.refresh()
    after = len(tbl.metadata.snapshot_by_id(tbl.metadata.refs[branch].snapshot_id).manifests(tbl.io))
    return {"manifests_before": len(current), "manifests_after": after}


def upsert_rows(tbl, data, keys: list[str], branch: str = MAIN, properties: Optional[dict] = None) -> dict:
    """Update rows matching `keys` and insert new ones in ONE snapshot: an overwrite of only the data files holding
    a matched key (their other rows are kept), or an append when no key matches. Tables with delete files use
    PyIceberg's upsert."""
    import pyarrow as pa
    from pyiceberg.io.pyarrow import ArrowScan, _dataframe_to_data_files
    from pyiceberg.table.snapshots import Operation
    from pyiceberg.table.update.snapshot import _OverwriteFiles

    data = prepare(tbl, data)
    ref = tbl.metadata.refs.get(branch)
    if ref is None:
        tbl.append(data, branch=branch, snapshot_properties=properties or {})
        return {"updated": 0, "inserted": data.num_rows}
    tasks = list(tbl.scan(snapshot_id=ref.snapshot_id).plan_files())
    if any(t.delete_files for t in tasks):
        res = tbl.upsert(data, join_cols=keys, branch=branch, snapshot_properties=properties or {})
        return {"updated": res.rows_updated, "inserted": res.rows_inserted}
    new_keys = set(zip(*[data.column(k).to_pylist() for k in keys]))
    scan = ArrowScan(tbl.metadata, tbl.io, tbl.schema(), tbl.scan().row_filter, True)
    affected, kept, updated = [], [], 0
    for t in tasks:
        rows = scan.to_table([t])
        ks = list(zip(*[rows.column(k).to_pylist() for k in keys])) if rows.num_rows else []
        hit = [i for i, k in enumerate(ks) if k in new_keys]
        if hit:
            affected.append(t.file)
            updated += len(hit)
            keep = [i for i in range(len(ks)) if ks[i] not in new_keys]
            if keep:
                kept.append(rows.take(pa.array(keep, type=pa.int64())))
    if not affected:
        tbl.append(data, branch=branch, snapshot_properties=properties or {})
        return {"updated": 0, "inserted": data.num_rows}
    out = pa.concat_tables([*[prepare(tbl, k) for k in kept], data]) if kept else data
    with tbl.transaction() as tx:
        prod = _OverwriteFiles(Operation.OVERWRITE, tx, tbl.io, branch=branch, snapshot_properties=properties or {})
        for f in affected:
            prod.delete_data_file(f)
        for f in _dataframe_to_data_files(table_metadata=tx.table_metadata, write_uuid=prod.commit_uuid, df=out, io=tbl.io):
            prod.append_data_file(f)
        prod.commit()
    return {"updated": updated, "inserted": data.num_rows - updated}


def overwrite_files(tbl, remove: list, data, branch: str = MAIN, properties: Optional[dict] = None):
    """Copy-on-write: remove these data files and add `data` (already in the table's schema) in ONE overwrite
    snapshot. Delete files are left in place (a positional delete file may also cover files that are kept; those
    that pointed at removed files no longer apply to anything). Returns the reloaded table."""
    from pyiceberg.io.pyarrow import _dataframe_to_data_files
    from pyiceberg.table.snapshots import Operation
    from pyiceberg.table.update.snapshot import _OverwriteFiles

    with tbl.transaction() as tx:
        prod = _OverwriteFiles(Operation.OVERWRITE, tx, tbl.io, branch=branch, snapshot_properties=properties or {})
        for f in remove:
            prod.delete_data_file(f)
        if data.num_rows:
            for f in _dataframe_to_data_files(table_metadata=tx.table_metadata, write_uuid=prod.commit_uuid, df=data, io=tbl.io):
                prod.append_data_file(f)
        prod.commit()
    return tbl.refresh()
