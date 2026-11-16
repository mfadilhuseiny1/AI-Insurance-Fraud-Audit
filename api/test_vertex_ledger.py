"""The Vertex spend ledger when several processes book into it at once (the API, aip/golden/run.py, aip/optimasi.py):
real processes writing one month file, no model call. Runs in either venv:

    ..\\.venv-adk\\Scripts\\python -m unittest test_vertex_ledger -v
"""

from __future__ import annotations

import json
import multiprocessing
import tempfile
import unittest
from pathlib import Path

from aip import models as aip_models
from aip import vertex

USAGE = {"prompt_tokens": 1000, "completion_tokens": 100}


def _book(folder: str, n: int) -> None:
    vertex.configure(Path(folder), lambda key: "")
    for _ in range(n):
        vertex.record(aip_models.GPT_OSS, USAGE)


class Ledger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        vertex.configure(Path(self.tmp.name), lambda key: "")

    def tearDown(self):
        self.tmp.cleanup()

    def test_processes_booking_at_once_lose_nothing(self):
        ctx = multiprocessing.get_context("spawn")
        procs = [ctx.Process(target=_book, args=(self.tmp.name, 40)) for _ in range(4)]
        for p in procs:
            p.start()
        for p in procs:
            p.join(120)
        self.assertEqual([p.exitcode for p in procs], [0, 0, 0, 0])
        day = vertex._today()
        d = vertex._read(day)["days"][day]
        self.assertEqual(d["calls"], 160)
        self.assertAlmostEqual(d["usd"], 160 * aip_models.cost(aip_models.GPT_OSS, USAGE), places=6)
        self.assertEqual(list(vertex.DIR.glob("*.tmp")), [])

    def test_an_unreadable_ledger_is_not_written_over(self):
        day = vertex._today()
        path = vertex._ledger_path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"days": {"2026-10-01": {"usd": 3.5', "utf-8")  # a month that cannot be read right now
        vertex.record(aip_models.GPT_OSS, USAGE)
        self.assertEqual(path.read_text("utf-8"), '{"days": {"2026-10-01": {"usd": 3.5')

    def test_a_first_booking_starts_the_month(self):
        vertex.record(aip_models.GPT_OSS, USAGE)
        day = vertex._today()
        self.assertEqual(json.loads(vertex._ledger_path(day).read_text("utf-8"))["days"][day]["calls"], 1)


if __name__ == "__main__":
    unittest.main()
