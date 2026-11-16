"""Run a golden question set against the JKN copilot with a chosen model, and score it.

    python -m aip.golden.run                                  dry run: the questions and the estimated cost, no call
    python -m aip.golden.run --live                           gpt-oss-120b on Vertex, the run stops itself at $0.10
    python -m aip.golden.run --live --model vertex/zai-org/glm-5.2-maas --max-usd 0.30
    python -m aip.golden.run --live --model gemini-3.5-flash --allow-unmetered      today's copilot model

Run from api/. The agent (jkn_agent's tool loop) runs in this process with the model under test. Its tools call the
running platform API (--api, default http://localhost:8000) as one user: a personal API token in
BLUESANDAI_GOLDEN_TOKEN, else a password sign-in as BLUESANDAI_GOLDEN_USER (default demo.kedeputian, the national audit
team) with BLUESANDAI_GOLDEN_PASSWORD, from .env.local. The agent sees exactly what that user may see; the live truths
are read the same way. Vertex calls go through the spend guard and book into
the same ledger as the server. A model outside Vertex is not behind the guard and needs --allow-unmetered.
Results: <data>/aip/golden/runs/<time>-<model>.json and a table on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

API_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(API_DIR))

import pipeline_ai  # noqa: E402
from aip import models as aip_models  # noqa: E402
from aip import vertex as aip_vertex  # noqa: E402
from mailer import env  # noqa: E402

DATA = Path(os.environ.get("BLUESANDAI_DATA_DIR", API_DIR.parent / "data"))
SETS = Path(__file__).resolve().parent
# the words an Indonesian answer uses for each lane the claim screening returns
LANE_WORDS = {"hold": ["hold", "ditahan", "tahan"], "review": ["review", "tinjau", "ditinjau"], "auto": ["otomatis", "auto"]}
# a budget guess for the dry run: tool rounds per question, prompt and answer tokens per round
EST_ROUNDS, EST_IN, EST_OUT = 3, 4000, 500


def _pick(obj: Any, path: str) -> Any:
    for part in path.split("."):
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


def _numbers(text: str) -> set[str]:
    """Every number in an answer as plain digits: "3.000.000", "3,000,000" and "3000000" all give "3000000"."""
    return {re.sub(r"[.,]", "", m.group()) for m in re.finditer(r"\d[\d.,]*\d|\d", text)}


def _says(answer: str, value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return str(value).lower() in answer.lower()
    if isinstance(value, (int, float)) and float(value).is_integer():
        return str(int(value)) in _numbers(answer)
    if isinstance(value, str):
        low = answer.lower()
        return any(w in low for w in LANE_WORDS.get(value.lower(), [value.lower(), value.lower().replace("_", " ")]))
    return str(value) in answer


def score(q: dict, result: dict, truths: list[dict]) -> list[dict]:
    answer = result.get("answer") or ""
    called = {s["tool"] for s in result.get("steps") or [] if s.get("ok")}
    checks = []
    if q.get("must_call"):
        checks.append({"check": "calls " + " or ".join(q["must_call"]), "ok": bool(called & set(q["must_call"]))})
    for t in truths:
        checks.append({"check": f"says {t['pick']} = {t['value']}", "ok": t["value"] is not None and _says(answer, t["value"])})
    if q.get("must_say_any"):
        checks.append({"check": "says " + " | ".join(q["must_say_any"]), "ok": any(p in answer.lower() for p in q["must_say_any"])})
    return checks


class _Request:
    """What jkn_agent.Platform reads from a request: the API's address and the user's credentials."""

    def __init__(self, api: str, auth: dict):
        self.base_url = api.rstrip("/") + "/"
        self.headers = {**auth, "origin": api.rstrip("/"), "referer": api.rstrip("/") + "/"}


def _sign_in(api: str) -> tuple[httpx.Client, dict]:
    """A client signed in as the golden user, and the header that carries it: a personal API token
    (BLUESANDAI_GOLDEN_TOKEN, Account → API tokens) or else a password sign-in."""
    base = {"origin": api.rstrip("/")}
    pat = env("BLUESANDAI_GOLDEN_TOKEN")
    if pat:
        auth = {"authorization": f"Bearer {pat}"}
        client = httpx.Client(base_url=api.rstrip("/"), timeout=120, headers={**base, **auth})
        me = client.get("/api/auth/me")
        if me.status_code != 200:
            sys.exit(f"BLUESANDAI_GOLDEN_TOKEN was refused: {me.status_code} {me.text[:200]}")
        return client, auth
    user, password = env("BLUESANDAI_GOLDEN_USER") or "demo.kedeputian", env("BLUESANDAI_GOLDEN_PASSWORD")
    if not password:
        sys.exit("Set BLUESANDAI_GOLDEN_TOKEN (a personal API token) or BLUESANDAI_GOLDEN_USER/PASSWORD in .env.local to run live.")
    client = httpx.Client(base_url=api.rstrip("/"), timeout=120, headers=base)
    r = client.post("/api/auth/login", json={"username": user, "password": password})
    body = r.json() if r.status_code == 200 else {}
    if r.status_code != 200 or body.get("mfa_required") or body.get("mfa_enrollment_required") or body.get("password_expired"):
        sys.exit(f"Password sign-in as {user} cannot start a session ({r.status_code}: {', '.join(k for k in body if k != 'user') or r.text[:120]}). "
                 "Create a personal API token for that account (Account → API tokens) and set BLUESANDAI_GOLDEN_TOKEN.")
    return client, {"cookie": "; ".join(f"{k}={v}" for k, v in client.cookies.items())}


def _truths(client: httpx.Client, q: dict) -> list[dict]:
    out = []
    for t in q.get("truth") or []:
        r = client.post(t["post"], json=t.get("body") or {}) if "post" in t else client.get(t["get"])
        r.raise_for_status()
        out.append({"pick": t["pick"], "value": _pick(r.json(), t["pick"])})
    return out


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", default="jkn_audit", help="golden set name (a .json file next to this script)")
    ap.add_argument("--model", default=aip_models.GPT_OSS)
    ap.add_argument("--api", default="http://localhost:8000")  # 127.0.0.1 is the hosting origin, where session cookies never apply
    ap.add_argument("--live", action="store_true", help="call the model; without it nothing is called")
    ap.add_argument("--max-usd", type=float, default=0.10, help="stop the run once it has spent this much on Vertex")
    ap.add_argument("--allow-unmetered", action="store_true", help="allow a model outside Vertex (not behind the spend guard)")
    ap.add_argument("--only", default="", help="comma-separated question ids")
    ap.add_argument("--skip", default="", help="comma-separated question ids to leave out (out-of-domain probes)")
    a = ap.parse_args()

    gs = json.loads((SETS / f"{a.set}.json").read_text("utf-8"))
    skipped = set(x for x in a.skip.split(",") if x)
    qs = [q for q in gs["questions"] if (not a.only or q["id"] in a.only.split(",")) and q["id"] not in skipped]
    vertex = aip_models.is_vertex(a.model)
    est = len(qs) * EST_ROUNDS * aip_models.cost(a.model, {"prompt_tokens": EST_IN, "completion_tokens": EST_OUT}) if vertex else None
    print(f"{gs['name']}: {len(qs)} questions ({len(skipped)} skipped), model {a.model}"
          + (f", estimated ${est:.4f} (~{EST_ROUNDS} rounds of {EST_IN}/{EST_OUT} tokens each)" if est is not None else ", cost not metered"))
    if not a.live:
        for q in qs:
            print(f"  {q['id']:<20} {q['q']}")
        print("Dry run: nothing was called. Add --live to run it.")
        return
    if not vertex and not a.allow_unmetered:
        sys.exit(f"{a.model} is not behind the Vertex spend guard; add --allow-unmetered to run it anyway.")

    pipeline_ai.configure(DATA, env)
    import jkn_agent
    from fastapi import HTTPException

    jkn_agent.MODEL = a.model
    client, auth_header = _sign_in(a.api)
    tokens = {"n": 0}
    pipeline_ai.USAGE_HOOKS.append(lambda m, s, t: tokens.__setitem__("n", tokens["n"] + (t if s == "succeeded" else 0)))
    start_usd = aip_vertex.spend()["total_usd"]
    rows = []
    out = DATA / "aip" / "golden" / "runs" / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{a.model.replace('/', '_')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    def save(final: bool) -> dict:
        done = [r for r in rows if "pass" in r]
        summary = {"set": a.set, "model": a.model, "user": env("BLUESANDAI_GOLDEN_USER") or "demo.kedeputian", "complete": final,
                   "time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "questions": len(qs), "answered": len(done),
                   "passed": sum(r["pass"] for r in done), "usd": round(aip_vertex.spend()["total_usd"] - start_usd, 6) if vertex else None,
                   "tokens": sum(r["tokens"] for r in done), "avg_secs": round(sum(r["secs"] for r in done) / len(done), 1) if done else None}
        out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1), "utf-8")  # after every question
        return summary

    for q in qs:
        if vertex and aip_vertex.spend()["total_usd"] - start_usd >= a.max_usd:
            rows.append({"id": q["id"], "skipped": f"run cap ${a.max_usd:.2f} reached"})
            continue
        truths = _truths(client, q)
        usd0, tok0, t0 = aip_vertex.spend()["total_usd"], tokens["n"], time.time()
        try:
            res = jkn_agent.ask(jkn_agent.AskIn(q=q["q"]), _Request(a.api, auth_header))
        except HTTPException as e:
            res = {"answer": "", "steps": [], "error": str(e.detail)}
        except aip_vertex.BudgetExceeded as e:
            res = {"answer": "", "steps": [], "error": str(e)}
        checks = score(q, res, truths)
        rows.append({"id": q["id"], "q": q["q"], "pass": all(c["ok"] for c in checks), "checks": checks, "answer": res.get("answer"),
                     "error": res.get("error"), "tools": [s["tool"] + ("" if s.get("ok") else " (failed)") for s in res.get("steps") or []],
                     "usd": round(aip_vertex.spend()["total_usd"] - usd0, 6) if vertex else None, "tokens": tokens["n"] - tok0,
                     "secs": round(time.time() - t0, 1)})
        r = rows[-1]
        print(f"  {'PASS' if r['pass'] else 'FAIL'}  {r['id']:<20} {r['secs']:>5}s  {r['tokens']:>6} tok  "
              + (f"${r['usd']:.5f}  " if r["usd"] is not None else "") + ", ".join(r["tools"]))
        for c in checks:
            if not c["ok"]:
                print(f"        missed: {c['check']}")
        if r["error"]:
            print(f"        error: {r['error'][:200]}")
        save(False)

    summary = save(True)
    print(f"\n{summary['passed']}/{summary['answered']} passed"
          + (f", ${summary['usd']:.4f}" if summary["usd"] is not None else "") + f", {summary['tokens']} tokens, avg {summary['avg_secs']}s"
          + f"\nSaved {out}")


if __name__ == "__main__":
    main()
