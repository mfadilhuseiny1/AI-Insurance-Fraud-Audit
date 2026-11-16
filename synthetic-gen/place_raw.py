"""Put the synthetic Stata files (and the ICD-10 code books) into the raw/ Files items of the project "Data Sampel BPJS
2025", in place of the real files, keeping every item id (pipelines, lineage and Nexus refer to them by id).

  .venv\\Scripts\\python.exe -I synthetic-gen\\place_raw.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SYN = REPO / "Data Sintetis" / "2025"
DRIVE = REPO / "data" / "drive"
PG_BIN = next(Path(r"C:\Program Files\PostgreSQL").glob("*/bin"))
EDITION_OF_FOLDER = {"covid": "Data Sampel Kontekstual COVID Edisi 2025", "dm": "Data Sampel Kontekstual DM Edisi 2025",
                     "kesehatan_mental": "Data Sampel Kontekstual Kesehatan Mental Edisi 2025", "kia_ibu": "Data Sampel Kontekstual KIA Edisi 2025 - Subset Ibu",
                     "kia_anak": "Data Sampel Kontekstual KIA Edisi 2025 - Subset Anak", "reguler": "Data Sampel Reguler Edisi 2025",
                     "tb": "Data Sampel Kontekstual TB Edisi 2025"}


def psql(sql: str) -> str:
    pw = (REPO / "secrets" / "pg-superuser.txt").read_text().strip()
    r = subprocess.run([str(PG_BIN / "psql.exe"), "-h", "127.0.0.1", "-p", "5435", "-U", "postgres", "-d", "ai_jkn_synthetic", "-At", "-F", "\t", "-c", sql],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": pw}, check=True)
    return r.stdout


def main() -> None:
    rows = psql("""WITH RECURSIVE t AS (SELECT id, name, kind, name::text path FROM drive_items WHERE parent_id IS NULL AND name = 'Data Sampel BPJS 2025'
                   UNION ALL SELECT c.id, c.name, c.kind, t.path || '/' || c.name FROM t JOIN drive_items c ON c.parent_id = t.id AND c.trashed_at IS NULL)
                   SELECT id, name, path FROM t WHERE kind = 'file' AND path LIKE 'Data Sampel BPJS 2025/raw/%'""")
    data_files = {f.name: f for f in SYN.glob("*/data/*.dta")}
    placed, missing = 0, []
    for line in rows.strip().splitlines():
        item_id, name, path = line.split("\t")
        parts = path.split("/")
        if parts[2] == "icd10":  # raw/icd10/<edisi>/<file>
            src = SYN / EDITION_OF_FOLDER[parts[3]] / "icd10" / name
        else:
            src = data_files.get(name)
        if not src or not src.exists():
            missing.append(path)
            continue
        shutil.copyfile(src, DRIVE / item_id)
        size = (DRIVE / item_id).stat().st_size
        psql(f"UPDATE drive_items SET size_bytes = {size}, updated_at = now() WHERE id = '{item_id}'")
        placed += 1
    print(f"placed {placed} synthetic files into raw/ items; missing: {len(missing)}")
    for m in missing:
        print("  missing:", m)
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
