"""Put the source files into the platform: Project "Data Sampel BPJS 2025" with raw/<tabel> (the Stata files of one
table type, 7 editions: each bronze transform reads its own folder, so a build downloads only what it needs) and
raw/icd10/<edisi> (the code books), plus empty bronze/, silver/, gold/ for the transforms' outputs. Idempotent: a file already there with the same size is kept.
Run in-process as the Project's owner (see run_upload.py)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from bpjs_sampel.catalog import EDITIONS, SOURCE, TABLES, source_files
from bpjs_sampel.repo.bpjs_common import FKRTL_PARTS

PROJECT = "Data Sampel BPJS 2025"
CONTENT = {".dta": "application/x-stata-dta", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def folder(parent: Optional[str], name: str, kind: str = "folder") -> str:
    import db
    import drive

    found = next((c for c in db.drive_list(parent) if c["name"] == name and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
    if found:
        return found["id"]
    return drive.create_folder(drive.NewFolder(name=name, parent_id=parent, kind=kind))["id"]


def layout() -> dict:
    project = folder(None, PROJECT, "project")
    raw = folder(project, "raw")
    out = {"project": project, "raw": raw, "raw_icd10": folder(raw, "icd10")}
    for tabel in TABLES:
        if tabel != "fkrtl":
            out[f"raw_{tabel}"] = folder(raw, tabel)
    for part in FKRTL_PARTS:
        out[f"raw_{part}"] = folder(raw, part)
    for name in ("bronze", "silver", "gold", "pipelines"):
        out[name] = folder(project, name)
    return out


def _put(parent: str, path: Path, log) -> str:
    import db
    import drive

    size = path.stat().st_size
    have = next((c for c in db.drive_list(parent) if c["name"] == path.name and c["kind"] == "file" and not c.get("trashed_at")), None)
    if have and int(have.get("size_bytes") or 0) == size:
        log(f"  ada   {path.name} ({size / 1e6:.0f} MB)")
        return have["id"]
    t = time.time()
    with open(path, "rb") as f:
        item = drive._store(parent, path.name, f, size, CONTENT.get(path.suffix, "application/octet-stream"))
    log(f"  unggah {path.name} ({size / 1e6:.0f} MB, {time.time() - t:.0f} s)")
    return item["id"]


def _tidy_flat_upload(ids: dict, log) -> None:
    """A first run put every Stata file in raw/data: move them into their table's folder (no re-upload)."""
    import db
    import drive

    flat = next((c for c in db.drive_list(ids["raw"]) if c["name"] == "data" and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
    if not flat:
        return
    for f in db.drive_list(flat["id"]):
        i = {x["path"].name: x for x in source_files()}.get(f["name"])
        if i and not f.get("trashed_at"):
            target = _raw_folder(i["tabel"], i["edisi"])
            drive.update_item(f["id"], drive.ItemChange(move_to=ids[f"raw_{target}"]))
            log(f"  pindah {f['name']} -> raw/{target}")
    if not [c for c in db.drive_list(flat["id"]) if not c.get("trashed_at")]:
        drive.delete_item(flat["id"])  # the empty folder of the first run


def _raw_folder(tabel: str, edisi: str) -> str:
    if tabel != "fkrtl":
        return tabel
    return next(part for part, editions in FKRTL_PARTS.items() if edisi in editions)


def _split_fkrtl(ids: dict, log) -> None:
    """raw/fkrtl (one folder, 2.16 GB: over a code build's 2 GiB) → raw/fkrtl_bagian_1 and _2 (moved, no re-upload)."""
    import db
    import drive

    old = next((c for c in db.drive_list(ids["raw"]) if c["name"] == "fkrtl" and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
    if not old:
        return
    by_name = {i["path"].name: i for i in source_files()}
    for f in db.drive_list(old["id"]):
        i = by_name.get(f["name"])
        if i and not f.get("trashed_at"):
            part = _raw_folder("fkrtl", i["edisi"])
            drive.update_item(f["id"], drive.ItemChange(move_to=ids[f"raw_{part}"]))
            log(f"  pindah {f['name']} -> raw/{part}")
    if not [c for c in db.drive_list(old["id"]) if not c.get("trashed_at")]:
        drive.delete_item(old["id"])  # the empty folder


def upload(log=print) -> dict:
    ids = layout()
    log(f"project {PROJECT} = {ids['project']}")
    files = {}
    _tidy_flat_upload(ids, log)
    _split_fkrtl(ids, log)
    for i in source_files():
        files[i["path"].name] = _put(ids[f"raw_{_raw_folder(i['tabel'], i['edisi'])}"], i["path"], log)
    for fold, edisi in EDITIONS.items():
        target = folder(ids["raw_icd10"], edisi)
        for p in sorted((SOURCE / fold / "icd10").glob("*")):
            if p.suffix in CONTENT:
                files[f"icd10/{edisi}/{p.name}"] = _put(target, p, log)
    return {**ids, "files": files}
