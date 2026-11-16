"""Many claims through POST /verify: a CSV (as Excel writes it) or a JSON list, each claim through the six stages.

The reading of the CSV is checked on real bytes (separators, Indonesian numbers, quoted multi-line notes, encodings,
refusals); then the running API verifies a CSV and a JSON list end to end with the real model and LLM (no stubs).

    python -m pytest test_verify_batch.py -q -s          # the API on BLUESANDAI_E2E_API (default http://localhost:8000)
"""

from __future__ import annotations

import csv
import io
import re
import time

import pytest
import requests
from fastapi import HTTPException

from aip import layanan as L
from test_aip_e2e import API, auditor  # noqa: F401  (the signed-in session of the AIP suite)

JURI = [c for c in L._columns("juri")[0]]
NOTES_9942 = L.TEMPLATE[1]["clinical_notes"]


def _rows(text: str, enc: str = "utf-8") -> dict:
    return L.read_claims_csv(text.encode(enc))


# ------------------------------------------------------------------------------------------------
# reading a CSV
# ------------------------------------------------------------------------------------------------


def test_the_template_reads_back_as_the_judges_two_claims():
    c = L.read_claims_csv(L.template_csv().encode("utf-8"))
    assert c["format"] == "juri" and c["pemisah"] == "," and c["kolom"] == JURI and not c["kolom_tambahan"]
    assert [r["id"] for r in c["baris"]] == ["CLM-2026-8801", "CLM-2026-9942"] and not any(r["ditolak"] for r in c["baris"])
    assert c["baris"][1]["body"]["claimed_cost"] == 18450000.0 and c["baris"][1]["no"] == 3  # spreadsheet row: header = 1


def test_the_example_batch_is_an_indonesian_excel_csv_with_one_refused_row():
    c = L.read_claims_csv(L.template_csv(True).encode("utf-8"))
    assert c["format"] == "juri" and c["pemisah"] == ";" and c["kolom_tambahan"] == ["label"]
    assert [r["id"] for r in c["baris"]] == [e["claim_id"] for e in L.EXAMPLES]
    assert [r["ditolak"] for r in c["baris"]] == [e["label"] == "tidak_valid" for e in L.EXAMPLES]
    for r, e in zip(c["baris"], L.EXAMPLES):  # "Rp 18.450.000" read back as the number it was
        assert r["body"].get("claimed_cost") == e["claimed_cost"] and r["masukan"]["label"] == e["label"] and "label" not in r["body"]


def test_an_indonesian_excel_csv_is_read_as_the_contract_reads_it():
    # Excel on an Indonesian locale: ';' separators, headers as people write them, Rupiah with thousand dots, a note
    # quoted across two lines with ';' inside, a column the contract does not know (kept, never sent), a BOM
    text = ("﻿Claim ID;Patient Age;INA-CBG Code;Primary Diagnosis;Claimed Cost;Real Cost;Length of Stay Days;Clinical Notes;label\r\n"
            f"CLM-2026-9942;29;A-4-13-III;A41.9;Rp 18.450.000;3.150.000;2;\"{NOTES_9942}\r\nCatatan perawat; tanpa ICU.\";fraud\r\n"
            ";;;;;;;;\r\n"
            "CLM-X-1;40;A-4-13-III;A41.9;-5;3150000;2;demam;\r\n"
            "CLM-X-2;40;sepsis;A41;1000;900;1;demam;\r\n")
    c = _rows(text)
    assert c["format"] == "juri" and c["pemisah"] == ";" and c["kolom_tambahan"] == ["label"]
    ok, neg, code = c["baris"]
    assert ok["no"] == 2 and not ok["ditolak"] and ok["body"]["claimed_cost"] == 18450000.0 and ok["body"]["real_cost"] == 3150000.0
    assert ok["body"]["clinical_notes"].endswith("tanpa ICU.") and "label" not in ok["body"] and ok["masukan"]["label"] == "fraud"
    assert neg["no"] == 4 and neg["ditolak"] and "claimed_cost" in neg["galat"]  # the blank row 3 is skipped, its number kept
    assert code["ditolak"] and "ina_cbg_code" in code["galat"]


def test_english_numbers_windows_1252_and_a_trailing_separator():
    text = ("claim_id,patient_age,ina_cbg_code,primary_diagnosis,claimed_cost,real_cost,length_of_stay_days,clinical_notes\r\n"
            "CLM-1,58,I-4-10-II,I21.0,\"15,100,000\",\"14,200,000.00\",6,Pasien dirawat di ruang intensif; kondisi stabil é,\r\n")
    c = _rows(text, "cp1252")
    r = c["baris"][0]
    assert not r["ditolak"], r["galat"]
    assert r["body"]["claimed_cost"] == 15100000.0 and r["body"]["real_cost"] == 14200000.0 and r["body"]["clinical_notes"].endswith("é")


def test_a_csv_without_the_needed_columns_is_refused_with_what_is_missing():
    with pytest.raises(HTTPException) as e:
        _rows("claim_id,patient_age\r\nCLM-1,40\r\n")
    assert e.value.status_code == 400 and "clinical_notes" in e.value.detail and "real_cost" in e.value.detail
    with pytest.raises(HTTPException) as e:
        _rows("nomor,umur\r\n1,2\r\n")
    assert "claim_id" in e.value.detail and "klaim_id" in e.value.detail
    with pytest.raises(HTTPException) as e:  # the standalone service has no data to read claims from
        L.read_claims_csv(b"klaim_id\r\nreguler:1\r\n", data_ok=False)
    assert e.value.status_code == 400 and "klaim nyata" not in e.value.detail


def test_claims_of_the_data_by_id_and_a_json_list_of_mixed_formats():
    c = _rows("klaim_id\r\nreguler:123\r\nbukan-id\r\n")
    assert c["format"] == "data" and not c["baris"][0]["ditolak"] and c["baris"][1]["ditolak"]
    rows = L.read_claims_json([L.TEMPLATE[1], {"klaim_id": "reguler:123"}, {"claim_id": "X", "patient_age": 300}, {"apa": 1}, "teks"])
    assert [r["format"] for r in rows] == ["juri", "data", "juri", None, None]
    assert [r["ditolak"] for r in rows] == [False, False, True, True, True]


def test_the_results_csv_keeps_the_input_and_never_writes_a_formula():
    done = [{"no": 2, "masukan": {"claim_id": "CLM-1", "catatan": "=HYPERLINK(\"http://x\")", "status": "lama"}, "galat": None,
             "ringkas": {"klaim_id": "reguler:CLM-1", "status": "WAJAR", "fraud_probability": 0.000004, "ai_reasoning": "+wajar", "llm_fallback": False}},
            {"no": 3, "masukan": {"claim_id": "CLM-2", "catatan": "-5", "status": ""}, "galat": "claimed_cost: Input should be ...", "ringkas": None}]
    text = L.results_csv(done, ["claim_id", "catatan", "status"], ";")
    assert text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿")), delimiter=";"))
    head = rows[0]
    assert head[:3] == ["claim_id", "catatan", "status"] and "hasil_status" in head and "fraud_probability" in head  # the input's name kept
    one = dict(zip(head, rows[1]))
    assert one["catatan"].startswith("'=") and one["ai_reasoning"] == "'+wajar" and one["fraud_probability"] == "0,000004"
    assert one["hasil_status"] == "WAJAR" and one["status"] == "lama" and one["llm_fallback"] == "tidak"
    two = dict(zip(head, rows[2]))
    assert two["catatan"] == "-5" and two["galat"].startswith("claimed_cost")


# ------------------------------------------------------------------------------------------------
# end to end on the running API: real model, real LLM
# ------------------------------------------------------------------------------------------------


def _wait(s: requests.Session, bid: str, limit: float = 900) -> dict:
    t0 = time.time()
    while time.time() - t0 < limit:
        j = s.get(f"{API}/api/aip/fraud/v1/verify/batch/{bid}", params={"limit": 1000}, timeout=60).json()
        if j["status"] != "berjalan":
            return j
        time.sleep(3)
    raise AssertionError(f"batch {bid} masih berjalan setelah {limit} detik")


def test_a_csv_of_claims_is_verified_row_by_row(auditor: requests.Session):  # noqa: F811
    t = auditor.get(f"{API}/api/aip/fraud/v1/verify/csv/templat", params={"contoh": "true"}, timeout=60)
    assert t.status_code == 200 and t.content.decode("utf-8-sig").startswith("claim_id;")
    r = auditor.post(f"{API}/api/aip/fraud/v1/verify/csv", files={"berkas": ("contoh klaim (test).csv", t.content, "text/csv")}, timeout=120)
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["format"] == "juri" and job["jumlah"] == 7 and job["ditolak"] == 1 and job["kolom_tambahan"] == ["label"]
    j = _wait(auditor, job["id"])
    assert j["status"] == "selesai" and j["selesai"] == 7, j
    rows = {x["id"]: x for x in j["baris"]}
    assert rows["CLM-2026-1007"]["ditolak"] and "patient_age" in rows["CLM-2026-1007"]["galat"]
    for e in L.EXAMPLES[:-1]:
        x = rows[e["claim_id"]]["ringkas"]
        assert x and x["status"] in ("INDIKASI_KUAT", "PERLU_DIPERIKSA", "WAJAR") and 0 <= x["fraud_probability"] <= 1 and len(x["ai_reasoning"]) > 40
        assert x["lolos_gerbang_angka"], e["claim_id"]  # every number the review wrote is one of the facts it was given
        print(f"\n{e['claim_id']} [{e['label']}]: {x['status']} p={x['fraud_probability']} · {x['kesimpulan_klinis']} ({x['llm']}) · {x['ai_reasoning'][:140]}")
    for cid in ("CLM-2026-9942", "CLM-2026-1004", "CLM-2026-1006"):  # sepsis on a mild typhoid fever; 9 days for a hernia repair; a same-day visit as 4 days
        assert rows[cid]["ringkas"]["status"] != "WAJAR", rows[cid]
    one = auditor.get(f"{API}/api/aip/fraud/v1/verify/batch/{job['id']}/baris/{rows['CLM-2026-9942']['no']}", timeout=60).json()
    assert one["hasil"]["pipeline"][0]["tahap"] == "01_client_request" and "contoh klaim (test).csv" in one["hasil"]["pipeline"][0]["keterangan"]
    assert one["masukan"]["label"] == "upcoding"  # carried with the row (never in the request: test_the_example_batch_...)
    refused = auditor.get(f"{API}/api/aip/fraud/v1/verify/batch/{job['id']}", params={"status": "DITOLAK"}, timeout=60).json()
    assert refused["total_baris"] == 1 and refused["baris"][0]["id"] == "CLM-2026-1007"
    d = auditor.get(f"{API}/api/aip/fraud/v1/verify/batch/{job['id']}/unduh", timeout=60)
    assert d.status_code == 200 and "attachment" in d.headers["content-disposition"]
    out = list(csv.DictReader(io.StringIO(d.content.decode("utf-8-sig")), delimiter=";"))
    assert [o["claim_id"] for o in out] == [e["claim_id"] for e in L.EXAMPLES]
    assert out[1]["label"] == "upcoding" and out[1]["status"] == rows["CLM-2026-9942"]["ringkas"]["status"]
    assert re.fullmatch(r"\d+(,\d+)?", out[1]["fraud_probability"])  # ';' file: decimal comma, as the spreadsheet reads it
    assert out[-1]["galat"] and not out[-1]["status"]
    mine = auditor.get(f"{API}/api/aip/fraud/v1/verify/batch", timeout=60).json()
    assert job["id"] in [b["id"] for b in mine]


def test_a_json_list_mixes_the_judges_format_and_a_claim_of_the_data(auditor: requests.Session):  # noqa: F811
    box = auditor.get(f"{API}/api/aip/karantina", params={"kelompok": "A"}, timeout=120).json()
    fac = auditor.get(f"{API}/api/aip/karantina/{box['kelompok']['A']['faskes'][0]['faskes_profil_id']}", timeout=120).json()
    kid = fac["klaim_kontributor"][0]["klaim_id"]
    r = auditor.post(f"{API}/api/aip/fraud/v1/verify/batch", json={"klaim": [L.TEMPLATE[1], {"klaim_id": kid}, {"klaim_id": "reguler:tidak-ada-123"}]},
                     timeout=120)
    assert r.status_code == 200, r.text
    j = _wait(auditor, r.json()["id"])
    assert j["status"] == "selesai" and j["format"] == "data+juri", j
    rows = {x["no"]: x for x in j["baris"]}
    assert rows[1]["ringkas"]["status"] != "WAJAR"
    assert rows[2]["ringkas"] and rows[2]["ringkas"]["klaim_id"] == kid
    assert rows[3]["galat"] and "tidak ada" in rows[3]["galat"] and not rows[3]["ditolak"]  # passed the contract, absent from the data
    one = auditor.get(f"{API}/api/aip/fraud/v1/verify/batch/{j['id']}/baris/2", timeout=60).json()
    assert one["hasil"]["pipeline"][2]["keterangan"].startswith("fitur batch") and "dikoreksi_verifikator" in one["hasil"]["di_luar_prompt"]
