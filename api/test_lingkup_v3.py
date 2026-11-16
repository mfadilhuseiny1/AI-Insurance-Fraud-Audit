"""Blu 3.0's reading scope (the user, 2026-11-12: ML v3 reads every claim, the swarm reads its output): the tools refuse claim
rows outside Klaim Berisiko and the control sample, and still answer aggregates. A stub platform, no model, no API.

Run: .venv-adk/Scripts/python.exe -m unittest test_lingkup_v3   (from api/)"""
from __future__ import annotations

import contextlib
import io
import unittest

from aip.adk_runtime import tools as T

RAW = {"id": "ot-raw", "name": "Skor Risiko Klaim ML (BPJS)", "api_name": "skor_risiko_klaim_ml", "primary_key": "klaim_id",
       "properties": [{"api_name": n, "type": "string"} for n in ("klaim_id", "judul", "provinsi", "faskes_profil_id")] + [{"api_name": "risiko", "type": "double"}]}
KB = {"id": "ot-kb", "name": "Klaim Berisiko (BPJS)", "api_name": "klaim_berisiko", "primary_key": "klaim_id",
      "properties": [{"api_name": n, "type": "string"} for n in ("klaim_id", "judul", "provinsi")]}


class Stub:
    """Answers a search, an aggregation and one object; records what was asked."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def post(self, path: str, body: dict) -> dict:
        self.calls.append(("POST", path))
        if body.get("aggregate"):
            return {"total": 3, "aggregation": {"groups": [{"group": "JAWA BARAT", "value": 3, "count": 3}]}}
        return {"total": 1, "objects": [{"primary_key": "k1", "title": "k1", "properties": {"klaim_id": "k1", "provinsi": "JAWA BARAT"}}]}

    def get(self, path: str, params: dict | None = None) -> dict:
        self.calls.append(("GET", path))
        key = path.rstrip("/").split("/")[-1]
        return {"primary_key": key, "title": key, "properties": {"klaim_id": key, "risiko": 0.9}}


def tools(scope: bool) -> tuple[dict, Stub]:
    p = Stub()
    box = T.Toolbox(p, {"agents": [{"key": "klaim_fraud", "name": "Agen Klaim", "object_types": [RAW, KB]}]})
    if scope:
        box.lingkup = {"tipe": RAW["name"], "boleh": {"k1", "kontrol1"}, "kontrol": {"kontrol1"}}
    return {f.__name__: f for f in T.object_tools(box, "klaim_fraud")}, p


def quiet(fn, **kw) -> dict:
    with contextlib.redirect_stdout(io.StringIO()):  # the tools emit their events on stdout
        return fn(**kw)


class LingkupV3(unittest.TestCase):
    def test_raw_type_search_refused(self) -> None:
        f, p = tools(True)
        r = quiet(f["cari_objek"], tipe=RAW["name"], kata_kunci="", filter_json="", urut_berdasarkan="risiko", urutan="desc", batas=20)
        self.assertIn("Blu 3.0", r.get("error", ""))
        self.assertFalse(p.calls, "a refused search must not reach the data")

    def test_klaim_berisiko_search_allowed(self) -> None:
        f, _ = tools(True)
        r = quiet(f["cari_objek"], tipe=KB["name"], kata_kunci="", filter_json="", urut_berdasarkan="", urutan="desc", batas=20)
        self.assertNotIn("error", r)
        self.assertEqual(r["total"], 1)

    def test_aggregates_allowed_but_not_per_claim(self) -> None:
        f, _ = tools(True)
        ok = quiet(f["agregasi_objek"], tipe=RAW["name"], metrik="count", properti="", kelompok="provinsi", filter_json="")
        self.assertNotIn("error", ok)
        per_claim = quiet(f["agregasi_objek"], tipe=RAW["name"], metrik="count", properti="", kelompok="klaim_id", filter_json="")
        self.assertIn("Blu 3.0", per_claim.get("error", ""))

    def test_detail_in_and_out_of_scope(self) -> None:
        f, _ = tools(True)
        self.assertNotIn("error", quiet(f["detail_objek"], tipe=RAW["name"], kunci="kontrol1"))
        self.assertIn("di luar lingkup", quiet(f["detail_objek"], tipe=RAW["name"], kunci="k999").get("error", ""))

    def test_no_scope_reads_open(self) -> None:
        """Blu 1.x and Blu 3.0 runs started before the scope: nothing changes."""
        f, _ = tools(False)
        r = quiet(f["cari_objek"], tipe=RAW["name"], kata_kunci="", filter_json="", urut_berdasarkan="risiko", urutan="desc", batas=20)
        self.assertNotIn("error", r)
        self.assertNotIn("error", quiet(f["detail_objek"], tipe=RAW["name"], kunci="k999"))


if __name__ == "__main__":
    unittest.main()
