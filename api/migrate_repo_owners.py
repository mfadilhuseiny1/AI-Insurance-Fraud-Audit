"""Give owners to code repositories in the default Project "Code repositories (migrated)" (code_repos.migrate_owners).

Repositories put there by the Project migration have no Owner but the administrators (the Project's roles are
Everyone -> Editor). Each gets the first of: its creator (repo.json created_by) -> its first committer (the audit log:
first commit / file save / merge) -> the creator of its output folder in Files -> the Owners of its Project. An active
user only; none found: administrators only, as before (listed). Idempotent and only adds: a repository that has owners,
or was decided before, is never changed again.

    .venv/Scripts/python.exe api/migrate_repo_owners.py            # DRY RUN: lists what it would do, changes nothing
    .venv/Scripts/python.exe api/migrate_repo_owners.py --apply    # gives the owners (an administrator's decision)
    ... --json FILE   also write the full plan as JSON

Applied runs are logged (bluesandai.code_repos, one line per repository), recorded in data/code-repos/
_owners_migration.json and written to the audit log (event code_repo_owners_migration).
Also available to administrators as POST /api/code-repos/tools/owners-migration?dry_run=true|false.
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
    out = Path(argv[argv.index("--json") + 1]).resolve() if "--json" in argv else None
    sys.modules.setdefault("magic", types.SimpleNamespace(from_buffer=lambda *a, **k: "application/octet-stream",
                                                          from_file=lambda *a, **k: "application/octet-stream",
                                                          Magic=object, MagicException=Exception))
    sys.path.insert(0, str(API))
    os.chdir(API)
    import server

    server._init_storage()
    server._init_database()
    import code_repos

    res = code_repos.migrate_owners(dry_run=not apply)
    print(f"{'APPLIED' if apply else 'DRY RUN (nothing changed)'} on {code_repos.DIR} (default Project {res['default_project_id']})")
    print(f"repositories without owners: {len(res['repos'])}; already decided: {res['already']}")
    print("by source: " + (", ".join(f"{k} {v}" for k, v in sorted(res["by_rule"].items())) or "-"))
    print(f"left to administrators: {len(res['unresolved'])}")
    for r in res["repos"]:
        owners = ", ".join(f"{o['type']}:{o['id']}" for o in r["owners"]) or "(administrators only)"
        print(f"  {r['id']:18} {str(r['name'])[:44]:44} {r['rule']:15} {owners}  <- {r['detail']}")
    if out:
        out.write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
