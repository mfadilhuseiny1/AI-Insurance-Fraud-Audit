"""Free disk: keep only the newest dataset version of each Files item in the project "Data Sampel BPJS 2025" (older
versions are synthetic data from earlier rebuilds), the way dataset_versions retention does it (file removed, kept=False
in index.json). Also clears the DuckDB checkpoint cache (rebuilt by the next pipeline build).

  .venv\\Scripts\\python.exe -I synthetic-gen\\prune_versions.py
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VERS = REPO / "data" / "lineage" / "versions"
PG = next(Path(r"C:\Program Files\PostgreSQL").glob("*/bin"))


def bpjs_items() -> set[str]:
    pw = (REPO / "secrets" / "pg-superuser.txt").read_text().strip()
    sql = """WITH RECURSIVE t AS (SELECT id FROM drive_items WHERE parent_id IS NULL AND name = 'Data Sampel BPJS 2025'
             UNION ALL SELECT c.id FROM drive_items c JOIN t ON c.parent_id = t.id) SELECT id FROM t"""
    r = subprocess.run([str(PG / "psql.exe"), "-h", "127.0.0.1", "-p", "5435", "-U", "postgres", "-d", "ai_jkn_synthetic", "-At", "-c", sql],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": pw}, check=True)
    return {x.strip() for x in r.stdout.split() if x.strip()}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    freed = 0
    for item in bpjs_items():
        f = VERS / item
        idx = f / "index.json"
        if not idx.exists():
            continue
        txs = json.loads(idx.read_text("utf-8"))
        newest_kept = next((t["id"] for t in txs if t.get("kept")), None)
        for t in txs:
            if t.get("kept") and t["id"] != newest_kept:
                p = f / f"{t['id']}.parquet"
                if p.exists():
                    freed += p.stat().st_size
                    p.unlink()
                t["kept"] = False
        tmp = f / "index.prune.tmp"
        tmp.write_text(json.dumps(txs, ensure_ascii=False), "utf-8")
        tmp.replace(idx)
    ck = REPO / "data" / "duckdb-checkpoints"
    if ck.exists():
        size = sum(p.stat().st_size for p in ck.rglob("*") if p.is_file())
        shutil.rmtree(ck)
        ck.mkdir()
        freed += size
    print(f"freed {freed / 1e9:.2f} GB")


if __name__ == "__main__":
    main()
