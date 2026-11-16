"""Architecture v3 without VIME (the user, 2026-11-12: "buat sekarang ga usah dulu ada VIME SSL", then "minta file .pkl nya").

fitur.py now scales the claim fields with the frozen penskala_fkrtl.json and drops the VIME anomaly from stored events'
rule scores; platform_lokal.py gives the engine an input-only stand-in, so no VIME network runs and no ANOMALI_SSL is
raised. This script rebuilds what v3 was trained and tested on with that engine, into NEW folders only, so the published
v3 (testing/model_v3, .tmp/data_v2, .tmp/v2_stream.npz, .tmp/uji100k_b) stays as it was:

  data      DO NOT USE. Re-drawing the training data v2 on today's bench gives other claims (0 % member overlap with the
            original draw) and 2.245 members of test B: training on it leaks test B. Tried 2026-11-12 and deleted.
  latih     v3 on the stream (recomputed without VIME from its stored events: exact) + the ORIGINAL data v2 features
            (.tmp/data_v2, drawn before test B; its events are gone, so ~0.2 % of its claims keep the VIME anomaly in
            their rule score)                  → testing/model_v3_tanpa_vime (stream cache .tmp/v2_stream_tanpa_vime.npz)
  uji       test B again (same claims and seeds)  → .tmp/uji100k_b_tanpa_vime/hasil_<c>.npz, then the v3 scores
  pkl       the model as a plain pickle           → testing/model_v3_tanpa_vime/model.pkl (+ model_pkl.json)

Test B was already used once, for v3's published numbers: a re-run here is its second use and chooses nothing (removing
VIME is the user's decision). The check is the training out-of-fold numbers. Heavy steps run one at a time.
Synthetic data only.

Usage: .venv/Scripts/python.exe testing/tanpa_vime.py data|latih|uji|pkl"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TMP = ROOT / ".tmp"
DV2 = TMP / "data_v2_tanpa_vime"
CACHE = TMP / "v2_stream_tanpa_vime.npz"
UJI = TMP / "uji100k_b_tanpa_vime"
MODEL = "model_v3_tanpa_vime"
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def anak(args: list[str], log: Path, env: dict | None = None) -> int:
    """One chunk in its own process (the engine's threads end with it), retried once after a native crash."""
    for coba in (1, 2):
        with log.open("w", encoding="utf-8") as fh:
            r = subprocess.run([sys.executable, str(Path(__file__)), *args], stdout=fh, stderr=subprocess.STDOUT,
                               env={**os.environ, "PYTHONUTF8": "1", **(env or {})})
        if r.returncode == 0:
            return 0
        say("  exit", r.returncode, "attempt", coba, (log.read_text("utf-8", errors="replace").strip().splitlines() or [""])[-1][:200])
    return r.returncode


def data() -> None:
    sys.exit("data: not to be used (it leaks test B members into training; see the module note)")
    import data_v2 as D

    DV2.mkdir(parents=True, exist_ok=True)
    for c in range(D.N_V2):
        if (DV2 / f"fitur_{c:02d}.npz").exists():
            say("data chunk", c, "done earlier")
            continue
        say("data chunk", c, "running")
        rc = anak(["_data_chunk", str(c)], DV2 / f"log_{c:02d}.txt")
        shutil.rmtree(DV2 / f"data_{c:02d}", ignore_errors=True)
        if rc != 0:
            sys.exit(f"data chunk {c} failed")
        say("data chunk", c, "done")


def _data_chunk(c: int) -> None:
    import data_v2 as D

    D.KERJA = DV2
    D.chunk(c, DV2 / f"fitur_{c:02d}.npz")


def latih() -> None:
    import latih_v2 as LV

    LV.CACHE = CACHE  # LV.DV2 stays the original .tmp/data_v2 (see the module note)
    LV.OPSI.update(LV.V3)
    LV.latih("v3", True, HERE / MODEL)


def uji() -> None:
    UJI.mkdir(parents=True, exist_ok=True)
    env = {"UJI100K_SET": "B", "UJI100K_FITUR": "1"}
    for c in range(20):
        if (UJI / f"hasil_{c:02d}.npz").exists():
            say("test B chunk", c, "done earlier")
            continue
        say("test B chunk", c, "running")
        rc = anak(["_uji_chunk", str(c)], UJI / f"log_{c:02d}.txt", env)
        shutil.rmtree(UJI / f"data_{c:02d}", ignore_errors=True)
        if rc != 0:
            sys.exit(f"test B chunk {c} failed")
    import latih_v2 as LV

    LV.UJI_R2 = UJI
    LV.uji([MODEL])


def _uji_chunk(c: int) -> None:
    import uji100k as U

    assert U.SET == "B", "UJI100K_SET=B expected"
    U.KERJA = U.HASIL = UJI
    U.chunk(c, U.NORMAL, UJI / f"hasil_{c:02d}.npz")


def pkl() -> None:
    """The v3 bundle as a plain pickle (loads with pickle.load or joblib.load), with the frozen scaling inside and a
    manifest of what it holds and the versions it needs."""
    import json
    import pickle

    import joblib
    import lightgbm
    import numpy
    import sklearn

    src = HERE / MODEL
    b = joblib.load(src / "model.joblib")
    b["penskala"] = json.loads((HERE / "penskala_fkrtl.json").read_text("utf-8"))
    with (src / "model.pkl").open("wb") as fh:
        pickle.dump(b, fh, protocol=pickle.HIGHEST_PROTOCOL)
    with (src / "model.pkl").open("rb") as fh:
        back = pickle.load(fh)
    assert set(back) == set(b)
    man = {
        "file": "model.pkl", "dibuat": time.strftime("%Y-%m-%d %H:%M"),
        "arsitektur": {"model_v3_tanpa_vime": "v3 tanpa VIME", "model_v3_bersih": "v3 bersih: satu jalur feature, data v2 tanpa echo, tanpa VIME"}.get(MODEL, MODEL),
        "isi": {"komponen": {k: f"{type(v['model']).__name__}, {'semua' if v['kolom'] is None else len(v['kolom'])} kolom X1" for k, v in b["komponen"].items()},
                "urutan_fusi": b["urutan"], "stacker": type(b["stacker"]).__name__, "kalibrasi": type(b["iso"]).__name__,
                "ambang_peluang": b["ambang_peluang"], "rute_rule": (b.get("rute_rule") or {}).get("nama"), "rule_jaringan": b.get("rule_jaringan"),
                "fitur_klaim": len(b["sys_names"]), "fitur_model1": len(b["agg_names"]), "penskala": b["penskala"]["versi"]},
        "cara_skor": "testing/arsitektur_v2.py: skor(bundle, X1, X2, XR); X1 dari testing/fitur.py (Stream.agg_row), XR dari Stream.r2_row",
        "versi": {"python": sys.version.split()[0], "lightgbm": lightgbm.__version__, "scikit-learn": sklearn.__version__, "numpy": numpy.__version__},
        "peringatan": "pickle menjalankan kode saat dibuka: buka hanya file dari sumber tepercaya.",
        "data": "sintetis",
    }
    (src / "model_pkl.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), "utf-8")
    say("written", src / "model.pkl", f"{(src / 'model.pkl').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "api"))
    sys.path.insert(0, str(HERE))
    os.environ.setdefault("BLUESANDAI_AUTH", "off")
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["data", "latih", "uji", "pkl", "_data_chunk", "_uji_chunk"])
    ap.add_argument("c", nargs="?", type=int, default=0)
    a = ap.parse_args()
    if a.perintah == "_data_chunk":
        _data_chunk(a.c)
        os._exit(0)
    if a.perintah == "_uji_chunk":
        _uji_chunk(a.c)
        os._exit(0)
    {"data": data, "latih": latih, "uji": uji, "pkl": pkl}[a.perintah]()
