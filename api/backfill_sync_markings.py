"""Backfill: datasets synced by Data Connection batch syncs before syncs carried their connection's markings.

Every sync whose connection has markings (its own or inherited): its dataset folder and the files of its current view
gain those markings as inherited markings, so users without them can no longer find or read what was synced from the
marked connection. Idempotent; never narrows; hand-set markings are untouched. A Project constraint the markings would
violate is reported (the data is still marked when applied).

    .venv/Scripts/python.exe api/backfill_sync_markings.py            # DRY RUN: lists what it would change
    .venv/Scripts/python.exe api/backfill_sync_markings.py --apply    # changes it (an administrator's decision)
    ... --connection <id>   only that connection's syncs;   --json   the full report as JSON

Applied changes are printed here, logged (bluesandai.datasources) and written to the audit log
(event sync_markings_backfill), one line per sync.

Also available to administrators as POST /api/datasources/sources/markings-backfill?dry_run=true|false.
"""
from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

API = Path(__file__).resolve().parent


def main(argv: list[str]) -> int:
    apply = "--apply" in argv
    sys.modules.setdefault("magic", types.SimpleNamespace(from_buffer=lambda *a, **k: "application/octet-stream",
                                                          from_file=lambda *a, **k: "application/octet-stream",
                                                          Magic=object, MagicException=Exception))
    sys.path.insert(0, str(API))
    os.chdir(API)
    import server

    server._init_storage()
    server._init_database()
    import datasources

    conn = argv[argv.index("--connection") + 1] if "--connection" in argv else None
    rep = datasources.backfill_markings(dry_run=not apply, connection_id=conn)
    print(f"{'APPLIED' if apply else 'DRY RUN (nothing changed)'}: {rep['items']} items of {len(rep['sources'])} syncs "
          f"lack their connection's markings")
    for s in rep["sources"]:
        print(f"  sync {s['name']!r} ({s['id']}), connection {s['connection_id']}: markings {s['markings']} -> "
              f"{len(s['items'])} items {s['items']}" + (f"  [Project constraint: {s['constraint']}]" if s.get("constraint") else ""))
    if "--json" in argv:
        print(json.dumps(rep, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
