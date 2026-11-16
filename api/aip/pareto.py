"""How many questions the chat answers without analysing again (the user, 2026-10-24: the consultancy's report is read
like a consultancy's report — the common questions are in it; only the unique ones go to the multi-agent analysis).

For each question of aip/golden/pertanyaan_umum.json the chat's planner is asked for its plan, with the prompt a run
gives it (agents.planner_text), and the route the code then takes (optimasi.route_of) is read as one of:

    langsung  no data: a greeting, a term, out of scope        laporan  the audit pack: the consultancy's report, cut by code
    baca      one read (the fast route)                         kartu    the ML agent reading its model card
    verify    a pasted claim: the /verify pipeline              agen     the multi-agent analysis

The shares are weighted by how often each question was asked (n); per question type, the route expected and taken.

    ..\\.venv-adk\\Scripts\\python -m aip.pareto           the questions and the expected shares (nothing called)
    ..\\.venv-adk\\Scripts\\python -m aip.pareto --live    ask the planner (~$0.003 a question); data/aip/pareto/<stamp>.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from aip import optimasi as Opt
from aip import vertex as aip_vertex
from aip.adk_runtime import agents as A
from mailer import env

SET = Path(__file__).resolve().parent / "golden" / "pertanyaan_umum.json"
DATA = Path(__file__).resolve().parents[2] / "data"
NOT_AGAIN = ("langsung", "laporan", "baca", "kartu", "verify")  # answered without the multi-agent analysis
NEW_WORK = re.compile(r"sub-agen|benchmark|latih ulang|uji masing|bentuk", re.I)


def route(text: str, item: dict, cat: dict) -> tuple[str, dict]:
    """(the bucket the plan leads to, what was planned)."""
    try:
        plan = A.parse_json(text)
    except ValueError:
        plan = None
    if not isinstance(plan, dict):
        return "agen", {"catatan": "rencana tidak terbaca: kode memberi pertanyaan ke agen klaim"}
    way, notes, tasks = Opt.route_of(plan, cat)
    seen = {"jalur": plan.get("jalur"), "audit": plan.get("audit"), "tugas": [{"agen": t["agen"], "instruksi": str(t.get("instruksi"))[:160]} for t in tasks],
            "catatan": notes}
    if way == "langsung":
        return "langsung", seen
    if way == "audit":
        return "laporan", seen
    if way == "cepat":
        return "baca", seen
    ml = [t for t in tasks if "kartu_model_ml" in (next((a for a in cat["agents"] if a["key"] == t["agen"]), {}).get("tools") or [])]
    # the ML agent reading its model card (its benchmark is on the card): new work only when the question asks for it
    if tasks and len(ml) == len(tasks) <= 2 and not NEW_WORK.search(item["q"]):
        return "kartu", seen
    return "agen", seen


def shares(rows: list[dict], key: str) -> dict[str, float]:
    w: Counter = Counter()
    for r in rows:
        w[r[key]] += r["n"]
    total = sum(w.values()) or 1
    return {k: round(100 * v / total, 1) for k, v in w.most_common()}


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--live", action="store_true", help="ask the planner; without it nothing is called")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    doc = json.loads(SET.read_text("utf-8"))
    expect = {t["id"]: t["jawab"] for t in doc["tipe"]}
    items = [{**q, "harap": expect[q["tipe"]]} for q in doc["questions"]]
    want = shares(items, "harap")
    print(f"{doc['name']} ({doc['versi']}): {len(items)} pertanyaan, {sum(q['n'] for q in items)} kali diajukan")
    print(f"  peta (harapan): {want} — tanpa analisis ulang {sum(v for k, v in want.items() if k in NOT_AGAIN):.1f}%")
    if not a.live:
        print("Dry run: nothing was called. Add --live to ask the planner.")
        return
    aip_vertex.configure(DATA, env)
    cat = Opt._sign_in(a.api).get("/api/aip/agents").raise_for_status().json()
    model = cat["roles"]["planner"]
    rules = A.plan_rules(cat).get("teks") or A.PLAN_RULES
    histories = doc.get("riwayat") or {}
    start, t0 = aip_vertex.spend()["total_usd"], time.time()

    def one(item: dict) -> dict:
        if item["q"].lstrip().startswith("{") and re.search(r'"(claim_id|kunjungan_fkrtl_id)"', item["q"]):  # main.ask: before any plan
            return {**item, "dapat": "verify", "rencana": {}, "detik": 0}
        got = Opt.ask_plan(model, rules, item, cat, histories)
        way, seen = route(got["text"], item, cat) if not got["error"] else ("agen", {"catatan": got["error"]})
        return {**item, "dapat": way, "rencana": seen, "detik": got["secs"]}

    with ThreadPoolExecutor(a.workers) as pool:
        rows = list(pool.map(one, items))
    got = shares(rows, "dapat")
    by_type: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        by_type[r["tipe"]][r["dapat"]] += r["n"]
    miss = [r for r in rows if r["dapat"] != r["harap"] and not (r["harap"] in NOT_AGAIN and r["dapat"] in NOT_AGAIN)]
    out = {"set": doc["versi"], "model": model, "aturan": A.plan_rules(cat).get("label") or "bawaan (kode)", "harapan": want, "dapat": got,
           "tanpa_analisis_ulang_pct": round(sum(v for k, v in got.items() if k in NOT_AGAIN), 1),
           "per_tipe": {t: dict(c) for t, c in by_type.items()}, "meleset": [{k: r[k] for k in ("id", "q", "tipe", "harap", "dapat", "rencana")} for r in miss],
           "usd": round(aip_vertex.spend()["total_usd"] - start, 4), "detik": round(time.time() - t0), "rows": rows}
    path = DATA / "aip" / "pareto" / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), "utf-8")
    print(f"  jalur dipilih: {got} — tanpa analisis ulang {out['tanpa_analisis_ulang_pct']}% (model {model})")
    for t, c in sorted(by_type.items()):
        print(f"    {t:18s} harap {expect[t]:8s} dapat {dict(c)}")
    for r in miss:
        print(f"  meleset {r['id']} [{r['tipe']}] harap {r['harap']}, dapat {r['dapat']}: {r['q'][:90]} → {json.dumps(r['rencana'], ensure_ascii=False)[:220]}")
    print(f"\n{path}\n${out['usd']:.4f}, {out['detik']} s")


if __name__ == "__main__":
    main()
