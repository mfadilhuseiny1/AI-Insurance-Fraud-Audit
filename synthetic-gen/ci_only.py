"""Recompute only the regression CI-overlap test (Reguler) and merge it into laporan/evaluasi.json."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import evaluate as ev  # noqa: E402
from sgen import config  # noqa: E402

out = config.REPORT / "evaluasi.json"
rep = json.loads(out.read_text("utf-8"))
con = ev.connect(["reguler"])
rep["per_edisi"]["reguler"]["ci_overlap"] = r = ev.ci_overlap(con, "reguler")
out.write_text(json.dumps(rep, indent=1, default=str, ensure_ascii=False), "utf-8")
print(json.dumps(r, ensure_ascii=False))
