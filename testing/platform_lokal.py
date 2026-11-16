"""Lets the realtime engine warm up inside the /testing process without the platform's Postgres and Files service.

The engine reads four silver datasets of the BPJS project through the platform's Files (Postgres metadata). Here,
inside this process only, that lookup is answered directly with the files on disk (data/drive/<item id>). The ids are
checked at start-up against the expected columns, so a renamed or replaced dataset fails loudly instead of silently.

No VIME either (the user, 2026-11-12: "buat sekarang ga usah dulu ada VIME SSL"): the engine's self-supervised models are
replaced by InputSaja, which keeps each FKRTL claim's raw inputs (the stream features scale them with the frozen
penskala_fkrtl.json, fitur.Penskala) and runs no network, so no ANOMALI_SSL signal and no torch.
No repository code is changed."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
# PLATFORM_DRIVE (testing/uji_riil.py, 2026-11-13): another Files folder with the same item ids (the BPJS project's own, read-only)
DRIVE = Path(os.environ.get("PLATFORM_DRIVE") or ROOT / "data" / "drive")
SILVER = {  # dataset → (drive item id, a column it must have)
    "kunjungan_fkrtl": ("217f2b804b0c4525", "jumlah_dx_sekunder"),
    "peserta": ("9d7869ab23424a4e", "hubungan_keluarga"),
    "kunjungan_fktp": ("e31f0344f03d46f7", "jenis_fktp"),
    "tindakan_nonkapitasi": ("12189562c3414860", "biaya_tagih_rp"),
}


def pasang() -> None:
    import pyarrow.parquet as pq
    from fastapi import HTTPException

    from aip.realtime import referensi as RF

    for name, (iid, col) in SILVER.items():
        p = DRIVE / iid
        if not p.is_file():
            raise RuntimeError(f"dataset silver {name} tidak ada di {p}")
        if col not in pq.read_schema(p).names:
            raise RuntimeError(f"dataset silver {name} ({iid}) tidak punya kolom {col}")

    def silver_path(name: str, dest: Path) -> Path:
        if name not in SILVER:
            raise HTTPException(404, f"dataset silver {name} tidak dikenal oleh layanan testing")
        return DRIVE / SILVER[name][0]

    RF.silver_path = silver_path

    from aip.realtime import ssl as SS

    SS.load_all = lambda: {"fkrtl": InputSaja()}


class InputSaja:
    """Stands in for the FKRTL self-supervised model in the engine: each claim's raw inputs only. No error, so the engine's
    _ssl_signal raises nothing and its drift count skips it; no embedding, so an active-learning model gets none."""

    versi = "tanpa-vime"

    def __init__(self) -> None:
        from aip.realtime import ssl as SS

        self.spec = SS.SPECS["fkrtl"]
        self.meta = {"versi": self.versi, "metode": "tanpa VIME: hanya input mentah klaim yang disimpan", "ambang": {}}

    def score_events(self, base: Any) -> list[dict]:
        from aip.realtime import ssl as SS

        return [{"versi": self.versi, "spek": self.spec.key(), "err": None, "x": [SS._jv(v) for v in row]}
                for row in base.reindex(columns=self.spec.base_cols).itertuples(index=False)]

    def signal(self, err: Any) -> None:
        return None
