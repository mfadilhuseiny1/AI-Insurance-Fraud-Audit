"""Keep Project "Data Sampel BPJS 2025" on this machine's disk instead of S3 (the user's choice, 2026-10-20: the NVMe
disk is faster for these builds). Files stay in /drive as before; only where their contents live changes.

1. a space "Data Sampel BPJS (lokal)" with storage = local (drive._store asks the Project's space where new files go);
2. the Project moves into it: every new file — build outputs included — is written to data/drive;
3. the files already in S3 are copied to data/drive and their record switched to local. A copy is written and checked
   before the switch, and updated_at is kept (no "data changed" trigger, no incremental reset). The S3 objects are
   left in place (removing them is a separate decision).
"""

from __future__ import annotations

import os
import time
from typing import Optional

SPACE = "Data Sampel BPJS (lokal)"


def ensure_space() -> dict:
    import governance_model as gm

    s = next((x for x in gm.spaces() if x["name"] == SPACE), None)
    if s:
        return s
    return gm.create_space(gm.SpaceIn(name=SPACE, storage="local",
                                      description="Project Data Sampel BPJS Kesehatan: file disimpan di disk lokal server (NVMe), bukan S3."), None)


def move_project(project_id: str, space_id: str) -> None:
    import governance_model as gm

    if gm.project_record(project_id).get("space_id") != space_id:
        gm.move_project(project_id, gm.MoveIn(space_id=space_id), None)


def _files_under(folder_id: str) -> list[dict]:
    import db
    import drive

    out = []
    for c in db.drive_list(folder_id):
        if c.get("trashed_at"):
            continue
        if c["kind"] in drive.CONTAINERS:
            out += _files_under(c["id"])
        elif c["kind"] == "file":
            out.append(c)
    return out


def migrate(project_id: str, log=print) -> dict:
    import db
    import drive
    import storage

    moved, kept, size = 0, 0, 0
    for f in _files_under(project_id):
        if f.get("stored_in") != "s3":
            kept += 1
            continue
        dest = drive.LOCAL_DIR / f["id"]
        tmp = dest.with_suffix(".part")
        t = time.time()
        storage.download_file(f"drive/{f['id']}", str(tmp))
        if os.path.getsize(tmp) != int(f.get("size_bytes") or 0):
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"{f['name']}: ukuran salinan tidak sama dengan catatan — tidak dialihkan")
        tmp.replace(dest)
        db.drive_update(f["id"], f["updated_at"], stored_in="local")
        moved += 1
        size += int(f.get("size_bytes") or 0)
        log(f"  lokal  {f['name']} ({int(f.get('size_bytes') or 0) / 1e6:.0f} MB, {time.time() - t:.0f} s)")
    return {"dipindah": moved, "sudah_lokal": kept, "bytes": size}


def run(project_id: str, log=print) -> dict:
    s = ensure_space()
    move_project(project_id, s["id"])
    log(f"space {s['name']} ({s['id']}, storage={s.get('storage')}); project dipindah")
    return {"space": s["id"], **migrate(project_id, log)}


def check(project_id: Optional[str]) -> dict:
    files = _files_under(project_id)
    return {"lokal": sum(1 for f in files if f.get("stored_in") == "local"), "s3": sum(1 for f in files if f.get("stored_in") == "s3")}
