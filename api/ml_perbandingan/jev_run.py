"""JEv (typesafe/jev-router on OpenRouter) on a balanced sample of the claims Blu 1.3's OpenAI Decisions already judged, with
the same facts and the same rubric, so the two can be compared claim by claim.

The user, 2026-11-08: written BPJS approval exists; JEv only within a $5 OpenRouter budget ("jangan abisin terlalu banyak").
So: a hard stop at MAX_USD spent (read from each answer's usage.cost), a smoke mode, and a resume file so no claim is paid twice.
The sample alternates corrected / not corrected, so a stop part-way still leaves it balanced. Facts come from the API's own
review set (POST /api/aip/telaah/klaim), the label is never in the prompt. Nothing row-level is printed.

    python jev_run.py --n 3        smoke: the first 3 claims of the sample
    python jev_run.py --n 80       the sample (resumes; stops at the budget)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
KERJA = Path(__file__).resolve().parents[2] / "data" / "aip" / "ml" / "perbandingan" / "kerja"  # work files (row-level: never in git)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "api"))
from aip import telaah as T  # noqa: E402

MODEL = "typesafe/jev-router"
MAX_USD = 4.50  # the user's cap is $5: stop well before it
OUT = KERJA / "jev_verdicts.jsonl"
SAMPLE = KERJA / "jev_sample.json"
FEATURES = ROOT / "data" / "aip" / "ml" / "cache" / "fitur-217f2b804b0c4525-324971703-v1.parquet"
DB = ROOT / "data" / "aip" / "telaah" / "telaah.db"


def env(name: str) -> str:
    for line in (ROOT / ".env.local").read_text("utf-8").splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{name} missing in .env.local")


def sample(per_class: int = 40, seed: int = 20261108) -> list[dict]:
    """40 corrected and 40 not corrected claims of the screened set, alternating; fixed by the seed."""
    if SAMPLE.exists():
        return json.loads(SAMPLE.read_text("utf-8"))
    import sqlite3

    import duckdb
    import pandas as pd

    ids = [r[0] for r in sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True).execute(
        "SELECT klaim_id FROM vonis WHERE model = 'openai/gpt-6-luna' AND peran = 'saring'")]
    con = duckdb.connect()
    con.execute("SET memory_limit = '1GB'")
    con.register("ids", pd.DataFrame({"klaim_id": ids}))
    df = con.execute(f"SELECT klaim_id, y FROM read_parquet('{FEATURES.as_posix()}') JOIN ids USING (klaim_id) ORDER BY klaim_id").df()
    rng = np.random.default_rng(seed)
    pos = rng.choice(df.loc[df.y == 1, "klaim_id"].to_numpy(), per_class, replace=False)
    neg = rng.choice(df.loc[df.y == 0, "klaim_id"].to_numpy(), per_class, replace=False)
    rows = [x for pair in zip(pos, neg) for x in ({"klaim_id": str(pair[0]), "y": 1}, {"klaim_id": str(pair[1]), "y": 0})]
    SAMPLE.parent.mkdir(exist_ok=True)
    SAMPLE.write_text(json.dumps(rows), "utf-8")
    return rows


def facts(ids: list[str]) -> dict[str, dict]:
    req = urllib.request.Request("http://127.0.0.1:8300/api/aip/telaah/klaim", data=json.dumps({"klaim_ids": ids}).encode(),
                                 headers={"Authorization": f"Bearer {env('ADMIN_ACCESS_TOKEN')}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        body = json.loads(r.read())
    return {b["klaim_id"]: b for b in body["baris"]}


LEVELS = T.DECISION_QUESTIONS[0]["levels"]
TAG_CHOICES = T.DECISION_QUESTIONS[1]["choices"]
SCHEMA = {
    "name": "telaah_klaim",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "peluang": {"type": "object", "additionalProperties": False, "required": [lv["label"] for lv in LEVELS],
                        "properties": {lv["label"]: {"type": "number"} for lv in LEVELS}},
            "kesimpulan": {"type": "string", "enum": [lv["label"] for lv in LEVELS]},
            "tag": {"type": "string", "enum": [c["value"] for c in TAG_CHOICES]},
        },
        "required": ["peluang", "kesimpulan", "tag"],
    },
}


def prompt(fakta: dict) -> str:
    """Decisions' own input (rubric + facts), with its two questions written out, as Decisions' typed questions were."""
    lv = "\n".join(f"- {x['label']}: {x['description']}" for x in LEVELS)
    tg = "\n".join(f"- {c['value']}: {c['description']}" for c in TAG_CHOICES)
    return (T.decision_input(fakta) + "\n\nJawab dua pertanyaan, hanya dalam JSON sesuai skema.\n"
            f"1. kesimpulan: {T.DECISION_QUESTIONS[0]['instructions']} Beri peluang (0-1, jumlahnya 1) untuk setiap tingkat, lalu tingkat dengan peluang terbesar:\n{lv}\n"
            f"2. tag: {T.DECISION_QUESTIONS[1]['instructions']}\n{tg}")


def call(key: str, text: str, data_policy: bool) -> dict:
    body = {"model": MODEL, "messages": [{"role": "user", "content": text}], "usage": {"include": True},
            "response_format": {"type": "json_schema", "json_schema": SCHEMA}, "max_tokens": 4000}
    if data_policy:
        body["provider"] = {"data_collection": "deny"}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Title": "AI JKN Synthetic benchmark"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}", "ms": int((time.time() - t) * 1000)}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "ms": int((time.time() - t) * 1000)}
    res["ms"] = int((time.time() - t) * 1000)
    return res


def parse(res: dict) -> dict:
    try:
        content = res["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return {"ok": False, "why": "no content"}
    m = re.search(r"\{.*\}", content, re.S)
    try:
        d = json.loads(m.group(0) if m else content)
        p = {lv["label"]: float(d["peluang"][lv["label"]]) for lv in LEVELS}
    except (ValueError, KeyError, TypeError, AttributeError):
        return {"ok": False, "why": "unreadable JSON"}
    tot = sum(p.values()) or 1.0
    p = {k: v / tot for k, v in p.items()}
    k = d.get("kesimpulan") if d.get("kesimpulan") in p else max(p, key=p.get)
    return {"ok": True, "kesimpulan": k, "peluang": p, "skor": p["perlu_diperiksa"] + 2 * p["mencurigakan"], "tag": d.get("tag")}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    key = env("OPENROUTER_API_KEY")
    rows = sample()[: a.n]
    done = {}
    if OUT.exists():
        for line in OUT.read_text("utf-8").splitlines():
            r = json.loads(line)
            done[r["klaim_id"]] = r
    spent = sum(r.get("usd") or 0 for r in done.values())
    todo = [r for r in rows if r["klaim_id"] not in done or not done[r["klaim_id"]].get("ok")]
    print(f"sample {len(rows)} ({sum(r['y'] for r in rows)} corrected), already answered {len(rows) - len(todo)}, spent so far ${spent:.4f}", flush=True)
    if not todo:
        return
    F = facts([r["klaim_id"] for r in todo])
    data_policy = True
    stop = False

    def one(r: dict) -> dict:
        nonlocal data_policy
        res = call(key, prompt(F[r["klaim_id"]]["fakta"]), data_policy)
        if "error" in res and data_policy and ("data" in res["error"].lower() and "polic" in res["error"].lower() or "No endpoints" in res["error"]):
            print("  the router has no endpoint under data_collection=deny; retrying without that preference", flush=True)
            data_policy = False
            res = call(key, prompt(F[r["klaim_id"]]["fakta"]), False)
        out = {"klaim_id": r["klaim_id"], "y": r["y"], "ms": res.get("ms"), "data_policy_deny": data_policy}
        if "error" in res:
            return {**out, "ok": False, "why": res["error"], "usd": 0.0}
        u = res.get("usage") or {}
        out.update({"usd": float(u.get("cost") or 0.0), "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
                    "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"), "routed_to": res.get("model"),
                    "provider": res.get("provider")})
        return {**out, **parse(res)}

    with OUT.open("a", encoding="utf-8") as fh, ThreadPoolExecutor(max_workers=a.workers) as pool:
        i = 0
        while i < len(todo) and not stop:
            batch = todo[i : i + a.workers]
            i += len(batch)
            worst = max([r.get("usd") or 0 for r in done.values()] + [0.0])
            if spent + worst * len(batch) * 1.5 > MAX_USD:
                print(f"budget: ${spent:.3f} spent, next batch could pass ${MAX_USD:.2f}; stopping", flush=True)
                break
            for res in pool.map(one, batch):
                fh.write(json.dumps(res, ensure_ascii=False) + "\n")
                fh.flush()
                done[res["klaim_id"]] = res
                spent += res.get("usd") or 0.0
                print(f"  {len(done):3d}: {'ok' if res.get('ok') else 'FAILED ' + str(res.get('why'))[:160]}  ${res.get('usd', 0):.4f}  "
                      f"{res.get('ms', 0) / 1000:.1f} s  tokens {res.get('prompt_tokens')}/{res.get('completion_tokens')} "
                      f"(reasoning {res.get('reasoning_tokens')})  via {res.get('routed_to')} / {res.get('provider')}", flush=True)
            if spent > MAX_USD:
                print(f"budget reached: ${spent:.3f}", flush=True)
                stop = True
    ok = [r for r in done.values() if r.get("ok") and r["klaim_id"] in {x["klaim_id"] for x in rows}]
    print(f"answered {len(ok)} of {len(rows)}; spent ${spent:.4f}; mean ${spent / max(1, len(done)):.4f} a claim", flush=True)


if __name__ == "__main__":
    main()
