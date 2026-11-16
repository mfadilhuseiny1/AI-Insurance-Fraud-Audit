"""Quick utility smoke test: TSTR on the given editions only (no report written)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import evaluate as ev  # noqa: E402

eds = sys.argv[1:] or ["tb"]
r = ev.tstr(ev.connect(eds))
print(json.dumps({k: (v if k in ("uji_holdout", "prevalensi_uji") else {x: v[x] for x in ("auroc", "auprc", "tertangkap_di_1pct_teratas")}) for k, v in r.items()},
                 ensure_ascii=False))
