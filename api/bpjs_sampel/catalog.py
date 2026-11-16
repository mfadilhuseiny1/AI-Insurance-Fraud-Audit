"""Data Sampel BPJS Kesehatan Edisi 2025 — what the source is: editions, tables, files.

See docs/PIPELINE_DATA_SAMPEL_BPJS.md. The source lives on the owner's disk at `D:\\BPJS\\2025` (never in
git, never in the database: the .dta files are read from that folder; bronze/silver/gold are derived from
them). BLUESANDAI_BPJS_DIR overrides the folder; the workspace copy `Data BPJS/2025` is only a fallback for
machines without the D: drive.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _source() -> Path:
    """AI JKN Synthetic: the source is the SYNTHETIC Stata files in `Data Sintetis/2025` (made by synthetic-gen/), never
    the real BPJS folders. BLUESANDAI_BPJS_DIR is honoured only when it points inside this repo."""
    env = os.environ.get("BLUESANDAI_BPJS_DIR")
    if env and Path(env).resolve().is_relative_to(ROOT):
        return Path(env)
    return ROOT / "Data Sintetis" / "2025"


SOURCE = _source()
OUT = ROOT / "data" / "bpjs-sampel"

# folder → edition key (one dataset per table carries every edition in the column `edisi`)
EDITIONS = {
    "Data Sampel Reguler Edisi 2025": "reguler",
    "Data Sampel Kontekstual COVID Edisi 2025": "covid",
    "Data Sampel Kontekstual DM Edisi 2025": "dm",
    "Data Sampel Kontekstual Kesehatan Mental Edisi 2025": "kesehatan_mental",
    "Data Sampel Kontekstual KIA Edisi 2025 - Subset Ibu": "kia_ibu",
    "Data Sampel Kontekstual KIA Edisi 2025 - Subset Anak": "kia_anak",
    "Data Sampel Kontekstual TB Edisi 2025": "tb",
}
TABLES = ["kepesertaan", "fktpkapitasi", "fkrtl", "nonkapitasi", "diagnosissekunder"]
_TABLE_RE = re.compile(r"_(" + "|".join(TABLES) + r")\.dta$")


def source_files() -> list[dict]:
    """Every data file of the source: {path, edisi, tabel}."""
    out = []
    for folder, edisi in EDITIONS.items():
        for f in sorted((SOURCE / folder / "data").glob("*.dta")):
            m = _TABLE_RE.search(f.name)
            if m:
                out.append({"path": f, "edisi": edisi, "tabel": m.group(1)})
    return out


def icd10_files() -> list[dict]:
    """The ICD-10 reference files of every edition (code books for the 3-digit labels)."""
    out = []
    for folder, edisi in EDITIONS.items():
        for f in sorted((SOURCE / folder / "icd10").glob("*")):
            if f.suffix in (".dta", ".xlsx"):
                out.append({"path": f, "edisi": edisi})
    return out
