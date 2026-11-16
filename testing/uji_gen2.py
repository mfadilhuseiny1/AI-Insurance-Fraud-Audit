"""The v3 workflow on generator 2's 200.000 claims (testing/generator2.py; the user, 2026-11-12).

Per chunk (40 x ~5.000 claims, members split by hash so chunks never share one): a fresh copy of the /testing data, the
realtime engine as /testing runs it now (no VIME: platform_lokal), the claims ingested in date order, then the stream
features exactly as for test B (fitur.Stream with the first model's standardisation). The feature rows, the labels and a
few claim fields are saved to .tmp/gen2/hasil_<c>.npz. `skor` then scores every model offline:
  model_v3            what /testing loads; on VIME-free features although it was trained with the VIME anomaly in the rule score
                      (it fired on ~0.2 % of the training stream)
  model_v3_tanpa_vime the matched pair (trained without VIME); not in service
  model_v2, model     the earlier architectures, for context
Nothing here chooses or tunes anything: the thresholds are the models' own. Synthetic data only.

Usage: .venv/Scripts/python.exe testing/uji_gen2.py jalankan          (all chunks, resumable, then skor)
       .venv/Scripts/python.exe testing/uji_gen2.py chunk 0 [--maks 500]
       .venv/Scripts/python.exe testing/uji_gen2.py skor"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
if os.environ.get("GEN4"):  # generator 4 (testing/generator4.py, written blind for ML v7's final test), same runner
    import generator4 as G  # noqa: E402
elif os.environ.get("GEN3"):  # generator 3 (testing/generator3.py), same runner
    import generator3 as G  # noqa: E402
else:
    import generator2 as G  # noqa: E402

if os.environ.get("GEN4"):
    KERJA = Path(os.environ["GEN4_KERJA"]) if os.environ.get("GEN4_KERJA") else ROOT / ".tmp" / "gen4_uji"
else:
    KERJA = (Path(os.environ["GEN3_KERJA"]) if os.environ.get("GEN3_KERJA") else ROOT / ".tmp" / "gen3_uji") if os.environ.get("GEN3") else G.KERJA
SPECIALS = getattr(G, "SPECIALS", ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp"))
MODELS = tuple(m for m in os.environ.get("UJI_MODELS", "").split(",") if m) or (("model_v3_bersih", "model_v3") if getattr(G, "BARU", False)
                                                                              else ("model_v3", "model_v3_tanpa_vime", "model_v2", "model"))
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def chunk(c: int, keluar: Path, maks: int | None = None) -> None:
    import pandas as pd

    import uji100k as U

    data_root = KERJA / f"data_{c:02d}"
    U.salin(data_root)
    say("data copied", data_root)
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api"))
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    platform_lokal.pasang()
    import joblib
    from aip import layanan as L
    from aip.realtime import mesin as E
    import fitur as FT

    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        time.sleep(1)
    eng = E.ENGINE
    say("engine ready")
    m = joblib.load(HERE / "model" / "model.joblib")
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    con = sqlite3.connect(f"file:{data_root / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")]
    con.close()
    st = FT.Stream(FT.sys_features(recs, ssl), [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])
    say("stream", len(st), "claims")

    # members of the training data are left out (the replay window, data v2, and every member already in the stream copy)
    kecuali = (G.kecuali_latih() if hasattr(G, "kecuali_latih") else set()) | {int(fd["peserta"]) for fd in st.f if str(fd["peserta"]).isdigit()}
    klaim = G.buat(c, kecuali)
    if maks:
        klaim = klaim[:maks]
    say("generated", len(klaim), "claims,", sum(b["_sk"] != "normal" for b in klaim), "fraud")

    def ke_klaim(b: dict):
        x = {k: v for k, v in b.items() if k in L.KlaimIn.model_fields}
        for k in SPECIALS:
            x[k] = int(x.get(k) or 0)
        x = {k: v for k, v in x.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        return L.KlaimIn.model_validate(x)

    objs, keep = [], []
    for b in klaim:
        try:
            objs.append(ke_klaim(b)); keep.append(b)
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", b["_sk"], str(e)[:160])
    t1 = time.time()
    ids = []
    for a in range(0, len(objs), 2000):
        ids += eng.ingest(objs[a:a + 2000], f"gen2:{c}", None)
        while len(eng.q) > 3000:
            time.sleep(0.5)
    briefs = eng.wait(ids, 3600)
    ok = [k for k, b in enumerate(briefs) if b and b.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
    say(f"engine judged {len(ok)}/{len(ids)} in {time.time() - t1:.0f} s")
    recs_new = [eng.store.event(ids[k]) for k in ok]
    bs = [keep[k] for k in ok]
    S_new = FT.sys_features(recs_new, ssl)
    r1, r2, rr = [], [], []
    for x, e in zip(S_new, recs_new):
        i = st.append(x, FT.claim_fields(e))
        r1.append(st.agg_row(i)); r2.append(st.s2_row(i)); rr.append(st.r2_row(i))
    sk = np.array([b["_sk"] for b in bs])
    import fitur_v4 as F4  # the v4 features, the stream first then the new claims, one at a time

    f4 = F4.Fitur4(F4.referensi(), F4.domisili([e.get("peserta") for e in recs] + [e.get("peserta") for e in recs_new]))
    for e in recs:
        f4.tambah(e)
    X4 = np.vstack([f4.tambah(e) for e in recs_new]).astype(np.float32)
    np.savez_compressed(
        keluar, sk=sk, y=(sk != "normal").astype(np.int8), varian=np.array([b["_varian"] for b in bs]),
        X1=np.vstack(r1).astype(np.float32), X2=np.vstack(r2).astype(np.float32), XR=np.vstack(rr).astype(np.float32), X4=X4,
        keputusan=np.array([str(e.get("keputusan")) for e in recs_new]), skor_rule=np.array([float(e.get("skor") or 0) for e in recs_new]),
        sinyal=np.array([" ".join(sorted({str(s.get("kode")) for s in (e.get("sinyal") or [])})) for e in recs_new]),
        # claim fields for the fidelity check against generator 1 (aggregates only leave this folder)
        tingkat=np.array([b["tingkat_pelayanan"] for b in bs]), kode=np.array([b["inacbg_kode"] for b in bs]),
        los=np.array([int(b.get("los_hari") or 0) for b in bs]), biaya=np.array([int(b["biaya_tagih_rp"]) for b in bs]),
        tarif=np.array([int(b.get("tarif_inacbg_rp") or 0) for b in bs]), dxs=np.array([int(b.get("jumlah_dx_sekunder") or 0) for b in bs]),
        topup=np.array([sum(int(b.get(s) or 0) for s in SPECIALS) for b in bs]), prosedur=np.array([b.get("prosedur") is not None for b in bs]),
        kelas=np.array([str(b.get("kelas_rawat")) for b in bs]), riwayat=np.array([bool(b["_m"].get("rs")) for b in bs]),
        peserta=np.array([str(e.get("peserta")) for e in recs_new]), faskes=np.array([str(e.get("faskes")) for e in recs_new]),
        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs_new]),
        # the primary diagnosis (the branch report themes claims by its ICD-10 chapter; added 2026-11-13)
        dx=np.array([str(b.get("dx_primer_icd3") or "") for b in bs]), dx_nama=np.array([str(b.get("dx_primer_nama") or "") for b in bs]))
    y = sk != "normal"
    say(f"chunk {c}: claims {len(sk)}, fraud {int(y.sum())}, PERIKSA/TAHAN on fraud {np.isin([str(e.get('keputusan')) for e in recs_new], ['PERIKSA', 'TAHAN'])[y].mean():.2f}")
    eng.stop() if hasattr(eng, "stop") else None


def jalankan() -> None:
    KERJA.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONUTF8": "1", "TEMP": str(ROOT / ".tmp"), "TMP": str(ROOT / ".tmp")}
    for c in range(getattr(G, "N_CHUNK", 8)):
        keluar = KERJA / f"hasil_{c:02d}.npz"
        if keluar.exists():
            say("chunk", c, "done earlier")
            continue
        for coba in range(3):  # the native access violation (0xC0000005) also hits chunks now and then
            log = KERJA / f"log_{c:02d}.txt"
            say("chunk", c, "running" + (f" (retry {coba})" if coba else ""))
            with log.open("w", encoding="utf-8") as fh:
                r = subprocess.run([sys.executable, str(Path(__file__)), "chunk", str(c), "--keluar", str(keluar)], stdout=fh, stderr=subprocess.STDOUT, env=env)
            shutil.rmtree(KERJA / f"data_{c:02d}", ignore_errors=True)
            say("chunk", c, "exit", r.returncode, (log.read_text("utf-8").strip().splitlines() or [""])[-1][:200])
            # the native access violation (0xC0000005) sometimes hits at process exit, after the chunk was saved
            if keluar.exists() and f"chunk {c}: claims" in log.read_text("utf-8"):
                break
        else:
            say("stopped: chunk", c, "failed 3 times")
            return
    skor()


def skor() -> None:
    """Every model's scores on the generator 2 claims (thresholds as trained)."""
    import joblib

    os.environ.setdefault("BLUESANDAI_AUTH", "off")
    sys.path.insert(0, str(ROOT / "api"))
    import arsitektur_v2 as A

    files = sorted(KERJA.glob("hasil_[0-9][0-9].npz"))
    ds = [np.load(f) for f in files]
    for mname in MODELS:
        b = joblib.load(HERE / mname / "model.joblib")
        parts = [(A.skor_lama if mname == "model" else A.skor)(b, d["X1"], d["X2"], d["XR"]) for d in ds]
        s = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
        np.savez_compressed(KERJA / f"skor_{mname}.npz", **s)
        y = np.concatenate([d["y"] for d in ds]).astype(bool)
        f = s["flag"].astype(bool)
        say(mname, f"recall {f[y].mean():.4f} precision {y[f].mean():.4f} fpr {f[~y].mean():.5f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["chunk", "jalankan", "skor"])
    ap.add_argument("c", nargs="?", type=int, default=0)
    ap.add_argument("--keluar", default=None)
    ap.add_argument("--maks", type=int, default=None)
    a = ap.parse_args()
    if a.perintah == "chunk":
        KERJA.mkdir(parents=True, exist_ok=True)
        chunk(a.c, Path(a.keluar) if a.keluar else KERJA / f"hasil_{a.c:02d}.npz", a.maks)
        os._exit(0)  # the engine's threads end with the process
    elif a.perintah == "jalankan":
        jalankan()
    else:
        skor()
