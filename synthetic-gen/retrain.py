"""After the rebuild: train the claim-risk ML on the synthetic data and rebuild the access overview, through the API of AI JKN
Synthetic (port 8300) as admin (ADMIN_ACCESS_TOKEN from .env.local; never printed).

  .venv\\Scripts\\python.exe -I synthetic-gen\\retrain.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API = "http://localhost:8300"


def token() -> str:
    for line in (REPO / ".env.local").read_text("utf-8").splitlines():
        if line.startswith("ADMIN_ACCESS_TOKEN="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("ADMIN_ACCESS_TOKEN not in .env.local")


def call(method: str, path: str, body: dict | None = None, timeout: int = 120) -> dict:
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    job = call("POST", "/api/aip/ml/train", {})
    jid = job.get("id")
    print("ML training job", jid, job.get("status"))
    t0 = time.time()
    while time.time() - t0 < 7200:
        j = call("GET", f"/api/aip/ml/jobs/{jid}")
        if j.get("status") in ("succeeded", "failed"):  # aip/ml.py: running -> succeeded | failed
            print("ML job:", j.get("status"), (j.get("error") or "")[:500], f"{time.time() - t0:.0f} s")
            break
        time.sleep(15)
    try:
        a = call("POST", "/api/aip/akses/bangun", {}, timeout=1800)
        print("akses rebuilt:", {k: a[k] for k in list(a)[:6]} if isinstance(a, dict) else a)
    except Exception as e:  # noqa: BLE001
        print("akses rebuild failed:", e)


if __name__ == "__main__":
    main()
