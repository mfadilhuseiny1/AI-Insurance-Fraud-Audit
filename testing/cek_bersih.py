"""Checks of the clean draw (step 2 of the v3 retrain, testing/bersih.py) before anything is trained on it: zero shared members and
zero shared source claims between the sets that must stay apart, every member in its fixed role, no echo left in any chunk's
history, and the share of first visits (a member's first claim at that hospital) per set. Writes .tmp/cek_bersih.json.

Usage: .venv/Scripts/python.exe testing/cek_bersih.py [--gen2-baru]   (--gen2-baru also checks .tmp/gen2_baru, step 4)"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import bersih as BS  # noqa: E402

TMP = ROOT / ".tmp"


def muat(pola: str, kunci: tuple[str, ...]) -> dict:
    fs = sorted(TMP.glob(pola))
    if not fs:
        return {}
    ds = [np.load(f) for f in fs]
    out = {k: np.concatenate([d[k] for d in ds]) for k in kunci if k in ds[0].files}
    out["_gema"] = [json.loads(str(d["gema"][0])) for d in ds if "gema" in d.files]
    out["_n"] = len(fs)
    return out


def pids(d: dict) -> set[int]:
    return {int(x) for x in d.get("peserta", []) if str(x).isdigit()}


def main() -> None:
    import joblib
    import arsitektur_v2 as A

    kunci = ("peserta", "asal", "sk", "X1", "chunk")
    baru = muat("data_v2_bersih/fitur_[0-9][0-9].npz", kunci)
    uc = muat("uji100k_c/hasil_[0-9][0-9].npz", kunci)
    g2b = muat("gen2_baru/hasil_[0-9][0-9].npz", ("peserta", "sk", "X1")) if "--gen2-baru" in sys.argv else {}
    lama = {"data_v2_lama": muat("data_v2/fitur_[0-9][0-9].npz", ("peserta", "asal")), "uji_a": muat("uji100k/hasil_[0-9][0-9].npz", ("peserta", "asal")),
            "uji_b": muat("uji100k_b/hasil_[0-9][0-9].npz", ("peserta", "asal"))}
    dp = BS.dipakai()
    ch = baru.get("chunk", np.array([]))
    latih = {int(x) for x, c in zip(baru.get("peserta", []), ch) if str(x).isdigit() and c < 8}
    valid = {int(x) for x, c in zip(baru.get("peserta", []), ch) if str(x).isdigit() and c >= 8}
    sets = {"latih_baru": latih, "validasi_baru": valid, "uji_c": pids(uc), **({"gen2_baru": pids(g2b)} if g2b else {}),
            "aliran": dp["aliran"], "uji_a": dp["uji_a"], "uji_b": dp["uji_b"], "gen2": dp["gen2"], "data_v2_lama": pids(lama["data_v2_lama"])}
    # pairs that must not share a member (the old sets may share among themselves: they are not used for the new model)
    harus = [(a, b) for a in ("latih_baru", "validasi_baru", "uji_c", "gen2_baru") for b in sets if a != b and a in sets
             and not (a in ("latih_baru", "validasi_baru") and b == "data_v2_lama")
             and not ({a, b} == {"uji_c", "gen2"})]  # test C may share members with generator 2's first run (generated claims, never trained on)
    irisan = {f"{a} ∩ {b}": len(sets[a] & sets[b]) for a, b in harus if f"{b} ∩ {a}" not in []}
    # source claims (the Jan–Nov claim a moved claim came from)
    asal = lambda d: {str(x) for x in d.get("asal", []) if str(x) and str(x) != "None"}  # noqa: E731
    asal_irisan = {"latih/validasi baru ∩ uji C": len(asal(baru) & asal(uc)), "uji C ∩ uji A": len(asal(uc) & asal(lama["uji_a"])),
                   "uji C ∩ uji B": len(asal(uc) & asal(lama["uji_b"])), "baru ∩ uji B": len(asal(baru) & asal(lama["uji_b"])),
                   "uji C ∩ data_v2 lama": len(asal(uc) & asal(lama["data_v2_lama"]))}
    peran_salah = {"latih_baru": sum(BS.peran(p) != "latih" for p in latih), "validasi_baru": sum(BS.peran(p) != "validasi" for p in valid),
                   "uji_c": sum(BS.peran(p) != "uji_c" for p in sets["uji_c"]), **({"gen2_baru": sum(BS.peran(p) != "gen2_baru" for p in sets["gen2_baru"])} if g2b else {})}
    gema = {nm: {"chunk": len(d["_gema"]), "sumber": sum(g["sumber"] for g in d["_gema"]), "dihapus": sum(g["dihapus"] for g in d["_gema"]),
                 "sisa": sum(g.get("sisa", 0) for g in d["_gema"])} for nm, d in (("data_v2_bersih", baru), ("uji_c", uc)) if d}
    # first visits per set (zero earlier claims of the member at that hospital; the stream's minimum of the standardized count)
    b3 = joblib.load(HERE / "model_v3" / "model.joblib")
    kf = list(b3["sys_names"]).index("klaim: kunjungan_peserta_faskes")
    nol = float(np.load(TMP / "v2_stream.npz", allow_pickle=True)["X1"][:, kf].min())
    pertama = {}
    for nm, d in (("data_v2_bersih", baru), ("uji_c", uc), ("gen2_baru", g2b)):
        if d and "X1" in d:
            y = ~np.isin(d["sk"].astype(str), A.NORMAL)
            pv = d["X1"][:, kf] <= nol + 1e-5
            pertama[nm] = {"normal": round(float(pv[~y].mean()), 4), "fraud": round(float(pv[y].mean()), 4), "klaim": int(len(y)), "fraud_n": int(y.sum())}
    # hard rules (must be 0): the retrained model's own training/validation members and source claims against the test sets, the
    # stream against the tests, and the old training data's members against the tests (for the contrast model). Allowed and reported:
    # members shared between test sets (generated or test claims, never trained on), and source claims that an older set used only as a
    # plant template for another member (that member was not in the older set's member list, so it was not excluded)
    wajib_pasangan = [k for k in irisan if any(k.startswith(t) for t in ("latih_baru", "validasi_baru"))
                      or (k.split(" ∩ ")[0] in ("uji_c", "gen2_baru") and k.split(" ∩ ")[1] in ("latih_baru", "validasi_baru", "aliran", "data_v2_lama"))]
    wajib = {k: irisan[k] for k in wajib_pasangan}
    wajib["klaim asal: latih/validasi baru ∩ uji C"] = asal_irisan["latih/validasi baru ∩ uji C"]
    catatan = {k: v for k, v in {**irisan, **asal_irisan}.items() if k not in wajib and k != "latih/validasi baru ∩ uji C" and v}
    lulus = all(v == 0 for v in wajib.values()) and all(v == 0 for v in peran_salah.values()) \
        and all(g["dihapus"] == g["sumber"] for g in gema.values()) and bool(baru) and bool(uc)
    # "sisa": history rows still equal to a source claim after its one count was taken out = the member's own identical duplicates
    # in the original data (same day, hospital and code), not the moved claim's echo
    out = {"lulus": lulus, "wajib_nol": wajib, "catatan_diizinkan": catatan, "ukuran": {k: len(v) for k, v in sets.items()}, "irisan_peserta": irisan, "irisan_klaim_asal": asal_irisan,
           "peran_salah": peran_salah, "gema": gema, "kunjungan_pertama": pertama,
           "chunk": {"data_v2_bersih": baru.get("_n", 0), "uji_c": uc.get("_n", 0), "gen2_baru": g2b.get("_n", 0) if g2b else None}}
    (TMP / "cek_bersih.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
