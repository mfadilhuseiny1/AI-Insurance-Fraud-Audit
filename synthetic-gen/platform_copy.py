"""Copy the platform state (data/) of AI JKN Audit into AI JKN Synthetic WITHOUT anything derived from the real BPJS data.

Left out:
  * the Files items of the BPJS projects (raw .dta, bronze/silver/gold/ml datasets) and their dataset versions: rebuilt from
    the synthetic source by the app's own pipeline;
  * the stored objects and indexes of the BPJS Nexus types: re-indexed from the rebuilt datasets;
  * every AIP store (runs, Swarm reports, verdict cache, indication ledger, ML jobs and models, prompt optimisation, golden
    sets, lessons, missions): all of them were made from real claims;
  * caches, previews, notebooks and audit logs (they can hold rows or query values).
Everything else (users, roles, markings, object/link/action types, pipelines' definitions, code repositories, functions,
demo projects) is copied, then scanned for real identifiers by scan_real_ids.py.

  .venv\\Scripts\\python.exe -I synthetic-gen\\platform_copy.py --dry-run
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SRC = Path(r"D:\BluesandAI\ai-jkn-audit\data")
DST = Path(__file__).resolve().parents[1] / "data"
PG_BIN = next(Path(r"C:\Program Files\PostgreSQL").glob("*/bin"))
BPJS_PROJECTS = ["Data Sampel BPJS 2025", "Uji drag & drop pipeline JKN (test)", "Portal Data BPJS per Peran (demo)"]
SKIP_DIRS = {"aip", "audit3", "duckdb-checkpoints", "dataset_preview", "bpjs-sampel", "code-workspaces", "backups", "streaming"}
SKIP_SUB = {("media-sets", "cache")}


def _items_under(where: str) -> set[str]:
    pw = (SRC.parent / "secrets" / "pg-superuser.txt").read_text().strip()
    sql = f"""WITH RECURSIVE t AS (SELECT id FROM drive_items WHERE parent_id IS NULL AND ({where})
              UNION ALL SELECT c.id FROM drive_items c JOIN t ON c.parent_id = t.id) SELECT id FROM t"""
    r = subprocess.run([str(PG_BIN / "psql.exe"), "-h", "127.0.0.1", "-p", "5434", "-U", "postgres", "-d", "ai_jkn_audit", "-At", "-c", sql],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": pw}, check=True)
    return {x.strip() for x in r.stdout.split() if x.strip()}


def bpjs_items() -> set[str]:
    names = ",".join("'" + n.replace("'", "''") + "'" for n in BPJS_PROJECTS)
    return _items_under(f"name IN ({names})")


def test_items() -> set[str]:
    """Items of the platform's own test projects (re-index benchmarks and the like): their dataset history is left out."""
    return _items_under("name LIKE '%(test)%'")


def _types(pred) -> set[str]:
    out = set()
    for f in (SRC / "ontology" / "object-types").glob("*.json"):
        try:
            t = json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if pred(t.get("display_name") or ""):
            out.add(t.get("id") or f.stem)
    return out


def bpjs_types() -> set[str]:
    return _types(lambda n: any(k in n for k in ("(BPJS)", "(AI Agent Swarm)", "(Semantik)")))


def test_types() -> set[str]:
    """Object types of platform tests: their stored objects are left out (the type definitions are copied)."""
    return _types(lambda n: "(test" in n)


def main(dry: bool) -> None:
    items, types = bpjs_items(), bpjs_types()
    print(f"BPJS Files items: {len(items)}, BPJS object types: {len(types)}")
    t_items, t_types = test_items(), test_types()
    print(f"test project items (history left out): {len(t_items)}, test object types (objects left out): {len(t_types)}")
    no_versions = items | t_items
    no_objects = types | t_types
    copied = skipped = bytes_ = 0
    for dirpath, dirnames, filenames in os.walk(SRC):
        rel = Path(dirpath).relative_to(SRC)
        parts = rel.parts
        if parts and parts[0] in SKIP_DIRS or (len(parts) >= 2 and (parts[0], parts[1]) in SKIP_SUB):
            dirnames[:] = []
            skipped += len(filenames)
            continue
        keep_dirs = []
        for d in dirnames:
            if parts in (("lineage", "versions"),) and d in no_versions:
                continue
            if parts == ("ontology", "objects") or parts == ("ontology", "indexing"):
                if d.split(".")[0] in no_objects:
                    continue
            keep_dirs.append(d)
        dirnames[:] = keep_dirs
        for fn in filenames:
            if parts == ("drive",) and fn in items:
                skipped += 1
                continue
            if len(parts) >= 2 and parts[0] == "ontology" and fn.split(".")[0] in types:
                skipped += 1
                continue
            if parts in (("ontology", "objects"), ("ontology", "indexing")) and fn.split(".")[0] in t_types:
                skipped += 1
                continue
            src = Path(dirpath) / fn
            dst = DST / rel / fn
            bytes_ += src.stat().st_size
            copied += 1
            if not dry:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
    (DST / "aip").mkdir(parents=True, exist_ok=True) if not dry else None
    print(f"{'would copy' if dry else 'copied'} {copied:,} files, {bytes_ / 1e9:.2f} GB; left out {skipped:,} files")
    if not dry:
        (DST / "_bpjs_items_left_out.json").write_text(json.dumps({"items": sorted(items), "types": sorted(types)}, indent=1), "utf-8")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main("--dry-run" in sys.argv)
