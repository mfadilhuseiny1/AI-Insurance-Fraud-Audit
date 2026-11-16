"""Outputs that carry their inputs' markings from the first moment anyone can read them.

Contour "save as dataset", Code Workbook "Save as dataset" nodes and data preparation outputs write datasets built from
other data. As a Pipeline Builder output does (auth.propagate), such an output inherits the markings of what it was
built from (its datasets — their own, inherited and folder markings —, object types, and the analysis / workbook /
preparation itself), so users without them cannot read it. Never a moment with fewer markings than its rows need:

- a new output is marked under a fresh, unused item id before its file is stored under that id (drive._store takes
  the id), so no reader ever finds it in Files, or reads its rows, unmarked (foundry_rules._create_marked_dataset);
- an existing output gains the new markings before its contents are replaced (its old rows were built from the old
  inputs) and is narrowed to the current inputs' markings after.

Markings set on the output by hand (its own) stay. A Project constraint (allowed / prohibited markings, the space's
maximum classification) the output would violate fails the save with 409 before anything is written.
"""

from __future__ import annotations

import io
import uuid
from typing import BinaryIO, Iterable, Optional

from fastapi import HTTPException

import auth


def markings_of(item_ids: Iterable[Optional[str]] = (), resources: Iterable[tuple[str, str]] = ()) -> set[str]:
    """The markings data read from these Files items (effective: own, inherited, folders') and these resources
    (kind, id), e.g. ("object_type", id), carries."""
    out: set[str] = set()
    for i in item_ids:
        if i:
            out |= set(auth.effective_markings(i))
    for kind, rid in resources:
        if rid:
            out |= set(auth.resource_effective(kind, rid))
    return out


def check(target_id: Optional[str], marks: set[str], exists: bool) -> None:
    """409 when the output would violate its Project's constraints with these inherited markings: an existing
    output (exists) with its own and its folders' markings, or a new file in the folder target_id with the folder's.
    Called before anything is written."""
    if not target_id:
        return  # the top level: no Project
    base = auth.file_markings(target_id) if exists else auth.effective_markings(target_id)
    why = auth.constraint_violation(target_id, set(base) | set(marks))
    if why:
        raise HTTPException(409, why)


def _note(item_id: str, inputs: Iterable[Optional[str]]) -> None:
    try:
        import dataset_versions

        dataset_versions.note_inputs(item_id, [i for i in inputs if i])  # the lineage note auth.propagate makes
    except Exception:  # noqa: BLE001 - an audit aid, never the write itself
        pass


def create(parent_id: Optional[str], name: str, data: bytes, content_type: str, marks: set[str],
           inputs: Iterable[Optional[str]] = ()) -> dict:
    """Store a new file in a (validated) folder already carrying `marks` as inherited markings; returns the stored
    item (drive._store's). The caller has checked the folder (Editor)."""
    return create_from(parent_id, name, io.BytesIO(data), len(data), content_type, marks, inputs)


def create_from(parent_id: Optional[str], name: str, fileobj: BinaryIO, size: int, content_type: str, marks: set[str],
                inputs: Iterable[Optional[str]] = ()) -> dict:
    """create() streaming the contents from a file object of `size` bytes (large files: a Data Connection sync's
    Parquet file is never read into memory)."""
    import db
    import drive

    drive._require_db()
    marks = set(marks)
    check(parent_id, marks, exists=False)
    while True:
        item_id = uuid.uuid4().hex[:16]
        if not db.drive_get(item_id) and auth._item_row(item_id) == ([], []):
            break
    if marks:
        auth._set_item(item_id, inherited=sorted(marks))
    try:
        item = drive._store(parent_id, drive._clean_name(name), fileobj, size, content_type, item_id=item_id)
    except BaseException:
        # stored but not returned (e.g. the caller may not open it): remove the file first, then the markings
        row = db.drive_get(item_id)
        if row:
            drive._delete_contents(db.drive_delete(item_id, drive._now()))
        auth._set_item(item_id, own=[], inherited=[])
        raise
    if item["id"] != item_id:
        # drive._store refused the id (taken meanwhile) and stored the rows under another one, unmarked: remove it
        # at once rather than leave it readable, and fail
        auth._set_item(item_id, own=[], inherited=[])
        drive._delete_contents(db.drive_delete(item["id"], drive._now()))
        raise HTTPException(500, "the output dataset could not be created under its marked id: nothing was written")
    _note(item_id, inputs)
    return item


def replace(item: dict, data: bytes, content_type: str, marks: set[str], inputs: Iterable[Optional[str]] = ()) -> None:
    """New contents for an existing output: it gains `marks` before the write and is narrowed to them after
    (inherited markings only; its own stay)."""
    import pipeline_datasets

    marks = set(marks)
    check(item["id"], marks, exists=True)
    _own, inherited = auth._item_row(item["id"])
    if not marks <= set(inherited):
        auth._set_item(item["id"], inherited=sorted(set(inherited) | marks))
    pipeline_datasets._replace_content(item, data, content_type)
    auth._set_item(item["id"], inherited=sorted(marks))
    _note(item["id"], inputs)
    auth.check_constraints(item["id"])
