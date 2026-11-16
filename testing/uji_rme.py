"""The medical-record (SATUSEHAT) rules on a file of claims with their records, offline. Synthetic data only.

  --masuk PATH        judge an input file or folder (aip/realtime/rme_batch.py lists the accepted shapes: JSONL of
                      {"klaim", "rekam_medis", "label"}, FHIR Bundles holding an ID Core Claim, a folder of them).
                      A folder with klaim/ + rekam_medis/ (FHIR Bulk Data NDJSON per resource type, per replica) + kunci/
                      is read as a bulk export: the 100,000 synthetic cardiac claims and records of testing/gen_tema.py +
                      testing/rekam_medis.py ("Data Sintetis/tema_jantung_kc_sul-7371"). Claims are linked to the record
                      by the member number in Patient.identifier and by date, never by the key file.
  --replika 0 1 ...   bulk: only these replicas
  --sintetis N        build a labelled set first: N claims per variant from the replayed synthetic inpatient claims (half of
                      them turned into cardiac claims: catheterisation/PCI, pacemaker, ablation), each with a synthetic
                      SATUSEHAT record (aip/realtime/rme_sintetis.py): consistent with documentation gaps (normal) or
                      contradicting the claim (the fraud variants). --tulis FILE keeps that set as JSONL (the input format).
  --keluar FILE       per-claim results (JSONL: decision, score, every finding with its evidence, the checked items)
  --laporan FILE      the report (JSON; default testing/laporan_rme.json)
  --proses N          worker processes (100k claims: use 8-12)

Run: .venv\\Scripts\\python.exe -I testing\\uji_rme.py --sintetis 300
     .venv\\Scripts\\python.exe -I testing\\uji_rme.py --masuk D:\\path\\klaim_jantung_rme.jsonl --keluar .tmp\\rme_hasil.jsonl --proses 10
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))

from aip.realtime import rme as R  # noqa: E402
from aip.realtime import rme_batch as RB  # noqa: E402
from aip.realtime import rme_sintetis as RS  # noqa: E402

REPLAY = ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet"
VARIAN_UJI = {"sesuai": ("normal", False), "tindakan_fiktif": ("tindakan_fiktif", True), "dx_tidak_didukung": ("dx_tidak_didukung", True),
              "los": ("los_diperpanjang", True), "kunjungan_fiktif": ("kunjungan_fiktif", True), "rawat_jalan": ("rawat_jalan_ditagih_inap", True),
              "pasien_berbeda": ("pasien_berbeda", True)}
# cardiac claim packages: principal diagnosis -> procedures (ICD-9-CM, as the claims carry them)
JANTUNG = [("I25.1", ["3722 - Left heart cardiac catheterization", "8856 - Coronary arteriography using two catheters"]),
           ("I20.0", ["3723 - Combined right and left heart cardiac catheterization", "0066 - Percutaneous transluminal coronary angioplasty",
                      "3607 - Insertion of drug-eluting coronary artery stent(s)"]),
           ("I21.4", ["3722 - Left heart cardiac catheterization", "0066 - Percutaneous transluminal coronary angioplasty",
                      "3607 - Insertion of drug-eluting coronary artery stent(s)"]),
           ("I44.2", ["3783 - Initial insertion of dual-chamber device"]),
           ("I48.9", ["3734 - Excision or destruction of other lesion or tissue of heart, endovascular approach"]),
           ("I35.0", ["3522 - Other replacement of aortic valve"])]
SEKUNDER = ["I10", "E11.9", "E78.5", "N18.3", "K21.9", "E66.9"]


def bangun(n: int, seed: int = 20261114) -> list[dict]:
    """A labelled set: n claims per variant, each with its synthetic record."""
    import pandas as pd

    rng = random.Random(seed)
    rp = pd.read_parquet(REPLAY)
    ritl = rp[(rp.tingkat_pelayanan == "RITL") & rp.tgl_pulang.notna() & (rp.los_hari >= 1)].to_dict("records")
    out = []
    for varian, (sk, fraud) in VARIAN_UJI.items():
        made = 0
        while made < n:
            t = rng.choice(ritl)
            d0 = t["tgl_datang"].date() if hasattr(t["tgl_datang"], "date") else t["tgl_datang"]
            d1 = t["tgl_pulang"].date() if hasattr(t["tgl_pulang"], "date") else t["tgl_pulang"]
            if varian == "los" and (d1 - d0).days < 4:
                d1 = d0 + timedelta(days=rng.randint(4, 8))
            k = {"klaim_id": f"SIN-{varian[:4].upper()}-{made:05d}", "tgl_datang": str(d0), "tgl_pulang": str(d1), "tingkat_pelayanan": "RITL",
                 "dx_utama": t.get("dx_primer_kode") or t.get("dx_primer_icd3"), "dx_sekunder": rng.sample(SEKUNDER, rng.randint(0, 2)),
                 "tindakan": [x.strip() for x in str(t.get("prosedur") or "").split(";") if x.strip() and x.strip() != "None"],
                 "inacbg_kode": t.get("inacbg_kode"), "biaya_tagih_rp": int(t.get("biaya_tagih_rp") or 0),
                 "peserta": {"jk": rng.choice(["L", "P"]), "tgl_lahir": str(d0 - timedelta(days=int(365.25 * rng.randint(30, 75))))}}
            if rng.random() < 0.5:  # a cardiac claim
                dx, pr = rng.choice(JANTUNG)
                k.update(dx_utama=dx, tindakan=list(pr))
            if varian == "tindakan_fiktif" and not any(R.bermakna(R.icd9(x)) for x in k["tindakan"] if R.icd9(x)):
                continue
            if varian == "dx_tidak_didukung":
                k["dx_sekunder"] = k["dx_sekunder"] + ["J96.0", "E87.1"]
            kk = RB.klaim_umum(k)
            b = RS.bundel(kk, varian, rng, k["peserta"], derau=0.1 if varian == "sesuai" else 0.0)
            out.append({"klaim": k, "rekam_medis": b, "label": {"fraud": fraud, "skenario": sk}})
            made += 1
    rng.shuffle(out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--masuk")
    ap.add_argument("--sintetis", type=int)
    ap.add_argument("--tulis")
    ap.add_argument("--keluar")
    ap.add_argument("--laporan", default=str(HERE / "laporan_rme.json"))
    ap.add_argument("--proses", type=int, default=0)
    ap.add_argument("--batas", type=int)
    ap.add_argument("--replika", nargs="*")
    ap.add_argument("--ambang", nargs=2, type=float, default=list(RB.AMBANG), metavar=("PERIKSA", "TAHAN"))
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):  # -I ignores PYTHONIOENCODING: a Windows console cannot print "≥" in the findings
        sys.stdout.reconfigure(errors="replace")
    t0 = time.time()
    masuk = a.masuk
    if a.sintetis:
        data = bangun(a.sintetis)
        masuk = a.tulis or str(ROOT / ".tmp" / f"rme_sintetis_{a.sintetis}.jsonl")
        Path(masuk).parent.mkdir(parents=True, exist_ok=True)
        with open(masuk, "w", encoding="utf-8") as fh:
            for x in data:
                fh.write(json.dumps(x, ensure_ascii=False) + "\n")
        print(f"set berlabel: {len(data)} klaim -> {masuk}")
    if not masuk:
        ap.error("--masuk atau --sintetis")
    if Path(masuk).is_dir() and (Path(masuk) / "rekam_medis").is_dir():
        rep = RB.jalankan_bulk(masuk, a.keluar, tuple(a.ambang), a.proses, a.replika)
    else:
        rep = RB.jalankan(masuk, a.keluar, tuple(a.ambang), a.proses, a.batas)
    rep["masukan"] = str(masuk)
    rep["detik"] = round(time.time() - t0, 1)
    rep["catatan"] = ("Data sintetis. Basis pengetahuan klinis rme.py adalah subset kerja untuk demonstrasi; perlu ditinjau TKMKB/tim medis BPJS "
                      "sebelum dipakai pada klaim riil.")
    Path(a.laporan).write_text(json.dumps(rep, ensure_ascii=False, indent=1, default=str), "utf-8")
    print(json.dumps({k: rep[k] for k in ("klaim", "keputusan", "per_skenario", "fraud", "fraud_terlihat_di_rm", "fraud_tak_terlihat_di_rm", "normal",
                                          "per_ketidaksesuaian", "normal_per_noise", "galat", "detik") if k in rep},
                     ensure_ascii=False, indent=1, default=str)[:6000])
    print("laporan:", a.laporan)


if __name__ == "__main__":
    main()
