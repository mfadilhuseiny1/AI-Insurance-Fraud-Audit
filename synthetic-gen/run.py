"""Generate the synthetic Data Sampel BPJS, one or more editions per process.

  .venv\\Scripts\\python.exe -I synthetic-gen\\run.py tb covid     # these editions, one after the other
  powershell -File synthetic-gen\\run_all.ps1                      # every edition, several processes at once

Reads the real bronze tables (training split only) where they are; writes only synthetic files. kia_anak needs
kia_ibu first (children are linked to synthetic mothers).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

import numpy as np  # noqa: E402

from sgen import config, edition, maps, real, write  # noqa: E402

SLOTS = ["reguler", "covid", "dm", "kesehatan_mental", "kia_ibu", "kia_anak", "tb"]  # each edition's id namespace


def main(eds: list[str]) -> None:
    t0 = time.time()
    con = real.connect()
    tariffs = maps.tariff_maps(con)
    mother_share = real.mother_link_share(con)
    config.WORK.mkdir(parents=True, exist_ok=True)
    ibu_file = config.WORK / "kia_ibu_ids.npy"
    for e in eds:
        print(f"\n=== {e}", flush=True)
        rng = np.random.default_rng(config.SEED + SLOTS.index(e))
        ids = edition.IdBank(con, rng, SLOTS.index(e))
        kia_ibu_ids = np.load(ibu_file) if (e == "kia_anak" and ibu_file.exists()) else None
        if e == "kia_anak" and kia_ibu_ids is None:
            raise SystemExit("kia_anak needs kia_ibu first")
        tables, info = edition.synth_edition(con, e, ids, tariffs, rng, print, kia_ibu_ids=kia_ibu_ids, mother_share=mother_share)
        if e == "kia_ibu":
            np.save(ibu_file, tables["kepesertaan"]["PSTV01"].to_numpy())
        info["files"] = write.write_edition(e, tables, print)
        (config.WORK / f"run_info_{e}.json").write_text(json.dumps(info, indent=1, default=str), "utf-8")
        del tables
    print(f"\nall done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main(sys.argv[1:] or SLOTS)
