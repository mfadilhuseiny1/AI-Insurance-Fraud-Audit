"""Paths, editions and the synthesizer's settings.

The real source is read only where it already sits (the BPJS project folder); nothing from it is written here except the
synthetic files. Override with environment variables:
  SGEN_REAL_BRONZE  the real bronze Parquet (one dataset per table, partitioned by edisi)
  SGEN_REAL_DTA     the real Stata source folder (for variable labels, value-label books and column order only)
"""

from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parent

REAL_BRONZE = Path(os.environ.get("SGEN_REAL_BRONZE", r"D:\BluesandAI\ai-jkn-audit\data\bpjs-sampel\bronze"))
REAL_DTA = Path(os.environ.get("SGEN_REAL_DTA", r"D:\BluesandAI\ai-jkn-audit\Data BPJS\2025"))

# the synthetic Stata source, laid out exactly like the real one, so the app's pipeline reads it unchanged
OUT_DTA = REPO / "Data Sintetis" / "2025"
WORK = HERE / "kerja"  # intermediate synthetic Parquet (synthetic rows only)
REPORT = HERE / "laporan"  # fidelity / utility / privacy results (aggregates only)

EDITIONS = {
    "reguler": "Data Sampel Reguler Edisi 2025",
    "covid": "Data Sampel Kontekstual COVID Edisi 2025",
    "dm": "Data Sampel Kontekstual DM Edisi 2025",
    "kesehatan_mental": "Data Sampel Kontekstual Kesehatan Mental Edisi 2025",
    "kia_ibu": "Data Sampel Kontekstual KIA Edisi 2025 - Subset Ibu",
    "kia_anak": "Data Sampel Kontekstual KIA Edisi 2025 - Subset Anak",
    "tb": "Data Sampel Kontekstual TB Edisi 2025",
}
TABLES = ["kepesertaan", "fktpkapitasi", "fkrtl", "nonkapitasi", "diagnosissekunder"]

SEED = 20261109
MIN_LEAF = 10  # smallest CART leaf: every synthetic value is drawn from a pool of at least 10 real records
RARE_K = 5  # a category value (diagnosis code, procedure text, facility profile) seen fewer times is never emitted
HOLDOUT_MOD = 5  # peserta with (PSTV01 * 48271 mod 2^31-1) mod 5 == 0 are held out: never used to fit, used to evaluate
TRAIN_ROWS = 400_000  # rows per model fit (a uniform sample of peserta when a table is larger)
AGE_JITTER_DAYS = 30  # birth dates are moved by up to this many days (synthpop-style smoothing of a quasi-identifier)
BIRTH_SENTINEL = "1900-07-01"  # the source's placeholder birth date: kept as it is

HOLDOUT_SQL = "((PSTV01::BIGINT * 48271) % 2147483647) % 5 = 0"
