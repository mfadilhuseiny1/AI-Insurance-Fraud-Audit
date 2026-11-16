"""Copies what the realtime engine needs into .tmp/testing-data, so the /testing service never writes to the synthetic
stream the experiments use. The SQLite store is copied with the backup API (consistent even with a WAL); the trained
SSL / active-learning models and the registry are copied; the deployed model package is referenced, not copied
(read-only). The copy's engine config writes no tags and builds no Box (nothing outside the copy is touched)."""
import json
import shutil
import sqlite3
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "data" / "aip"
DST = Path(__file__).resolve().parent.parent / ".tmp" / "testing-data" / "aip"


def main(force: bool = False) -> None:
    rt_src, rt_dst = SRC / "realtime", DST / "realtime"
    rt_dst.mkdir(parents=True, exist_ok=True)
    db = rt_dst / "realtime.sqlite"
    if force or not db.exists():
        for f in rt_dst.glob("realtime.sqlite*"):
            f.unlink()
        src = sqlite3.connect(f"file:{rt_src / 'realtime.sqlite'}?mode=ro", uri=True)
        dst = sqlite3.connect(db)
        src.backup(dst)
        dst.close(); src.close()
        print("store copied:", round(db.stat().st_size / 1e6), "MB")
    if force or not (rt_dst / "al").exists():
        if (rt_dst / "al").exists():
            shutil.rmtree(rt_dst / "al")
        shutil.copytree(rt_src / "al", rt_dst / "al")
    for name in ("sumber.json",):
        if (rt_src / name).exists():
            shutil.copy2(rt_src / name, rt_dst / name)
    cfg = json.loads((rt_src / "konfigurasi.json").read_text("utf-8"))
    cfg.update(aktif=False, pemilik=None, tulis_tag=False, box_otomatis=False)
    (rt_dst / "konfigurasi.json").write_text(json.dumps(cfg, indent=1), "utf-8")
    (DST / "produksi").mkdir(parents=True, exist_ok=True)
    shutil.copy2(SRC / "produksi" / "deployed.json", DST / "produksi" / "deployed.json")
    print("ready:", DST)


if __name__ == "__main__":
    main("--force" in sys.argv)
