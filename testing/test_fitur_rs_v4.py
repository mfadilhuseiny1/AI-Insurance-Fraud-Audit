"""Checks of testing/fitur_rs_v4.py (hospital × period features, one per-claim path). Synthetic data only.

  deterministic        two runs give the same rows, bit for bit (NaN in the same cells)
  prefix               the stream alone == the stream part of stream+chunk processing; matriks_rs_chunks == matriks_rs per chunk
  causal (arrival)     truncating or shuffling/changing the tail (stream or chunk) leaves the earlier rows unchanged
  causal (date)        changing earlier-arriving claims dated on/after a claim's date leaves that claim's row unchanged
  frozen peers         dropping the chunk rows of one hospital leaves every other hospital's chunk rows unchanged
  small data           < 30 inpatient claims in a window -> NaN inpatient features + rs: sedikit_data flag
  brute force          a few features recomputed from the raw claim lists by a separate, naive implementation
  real data            the same determinism/prefix/tail checks on a slice of the real stream (+ X4) and chunk 00, if present
Run: .venv/Scripts/python.exe testing/test_fitur_rs_v4.py   (or pytest testing/test_fitur_rs_v4.py)"""
from __future__ import annotations

import math
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fitur_rs_v4 as RS  # noqa: E402

IDX = {n: j for j, n in enumerate(RS.NAMES_RS)}


# ---- a synthetic world (its own reference: no silver file needed)
def _dunia(seed: int = 3):
    rng = np.random.default_rng(seed)
    hs = [f"H{i:02d}" for i in range(12)]
    peer = {h: f"G{i % 3}" for i, h in enumerate(hs)}
    peer["H11"] = "G9"  # a peer group of one hospital -> falls back to all hospitals
    fams = [f"A-{i}-10" for i in range(6)]
    kode_med = {f"{f}-{s}": {"med_los": float(2 + i)} for i, f in enumerate(fams) for s in ("I", "II", "III")}
    kode_med["Q-5-44-0"] = {"med_los": 0.0}
    R = {"versi": "uji", "rs_peer": peer, "P3": 0.05, "P23": 0.2, "g3": {f: 0.04 + 0.01 * i for i, f in enumerate(fams)},
         "g23": {f: 0.2 for f in fams}, "p3": {("G0", fams[0]): 0.08}, "p23": {("G0", fams[0]): 0.3}, "kode": kode_med,
         "silver": {}, "famili": {}}
    size = {h: (40 if h in ("H00", "H01", "H02") else 1 if h in ("H10", "H11") else 8) for h in hs}  # claims per day

    def klaim(h, tgl):
        ritl = rng.random() < 0.3
        f = fams[int(rng.integers(0, len(fams)))]
        kode = f"{f}-{rng.choice(['I', 'I', 'II', 'III'])}" if ritl else "Q-5-44-0"
        lr = float(rng.gamma(4, 0.25)) if ritl else -1.0
        return {"faskes": h, "tgl": tgl, "kode": kode, "ritl": ritl, "lr": lr, "br": float(rng.lognormal(0, 0.3)),
                "tr": float(rng.lognormal(0, 0.5)) if rng.random() < 0.1 else 0.0, "dx": float(rng.integers(-3, 3)),
                "b25": float(ritl and lr < 0.6)}
    # silver history (days 40..N_SILVER-1), through the module's contribution, as referensi() does
    silver = []
    fr0 = RS.FiturRS(R, kosong=True)
    for d in range(40, RS.N_SILVER):
        for h in hs:
            for _ in range(int(rng.poisson(size[h] * 0.5))):
                silver.append((d, klaim(h, str(RS.BASIS + timedelta(days=d)))))
    for d, e in silver:
        c = fr0.kontribusi(e["faskes"], e["ritl"], e["kode"], e)
        R["silver"].setdefault(e["faskes"], np.zeros((RS.N_SILVER, RS.K)))[d] += c
        f, s = RS._famili(e["kode"])
        if e["ritl"] and s:
            R["famili"].setdefault((e["faskes"], f), []).append((d, c[RS.C_O23], c[RS.C_E23], c[RS.C_V23]))
    # stream (18 Dec .. 5 Jan, mostly in date order with some late arrivals) and a chunk (18 .. 31 Dec, file order)
    t0 = date(2024, 12, 18)
    stream = []
    for k in range(19):
        for h in hs:
            stream += [klaim(h, str(t0 + timedelta(days=k))) for _ in range(int(rng.poisson(size[h] * 0.3)))]
    late = rng.choice(len(stream), len(stream) // 20, replace=False)
    for i in late:
        stream[i]["tgl"] = str(date.fromisoformat(stream[i]["tgl"]) - timedelta(days=int(rng.integers(1, 6))))
    chunk = [klaim(hs[int(rng.integers(0, len(hs)))], str(t0 + timedelta(days=int(rng.integers(0, 14))))) for _ in range(1500)]
    chunk.sort(key=lambda e: e["tgl"])
    return R, silver, stream, chunk


def _jalan(R, stream, chunk=None):
    fr = RS.FiturRS(R)
    a = RS._stack([fr.tambah(r) for r in stream])
    fr.bekukan()
    b = RS._stack([fr.tambah(r) for r in chunk]) if chunk is not None else None
    return a, b


def _sama(a, b) -> bool:
    return a.shape == b.shape and a.dtype == b.dtype == np.float32 and np.array_equal(a, b, equal_nan=True)


# ---- the checks
def test_deterministik_dan_prefix():
    R, _, s, c = _dunia()
    a1, b1 = _jalan(R, s, c)
    a2, b2 = _jalan(R, s, c)
    assert _sama(a1, a2) and _sama(b1, b2), "two runs differ"
    a0, _ = _jalan(R, s)
    assert _sama(a0, a1), "the stream alone != the stream part of stream+chunk"
    assert np.isfinite(b1).sum() > 0.5 * b1.size


def test_kausal_ekor():
    R, _, s, c = _dunia()
    a, b = _jalan(R, s, c)
    rng = np.random.default_rng(1)
    for k in (1, 300, len(s) // 2, len(s) - 5):
        a_k, _ = _jalan(R, s[:k])
        assert _sama(a_k, a[:k]), f"stream truncated at {k}: earlier rows changed"
        ekor = [dict(e, lr=e["lr"] * 3, br=e["br"] * 5, kode=e["kode"].replace("-I", "-III")) for e in s[k:]]
        ekor = [ekor[i] for i in rng.permutation(len(ekor))]
        a_x, _ = _jalan(R, s[:k] + ekor)
        assert _sama(a_x[:k], a[:k]), f"stream tail shuffled/changed after {k}: earlier rows changed"
    for k in (1, 400, len(c) - 3):
        _, b_k = _jalan(R, s, c[:k])
        assert _sama(b_k, b[:k]), f"chunk truncated at {k}: earlier rows changed"
        ekor = [dict(e, tr=9.0, dx=5.0) for e in c[k:]][::-1]
        _, b_x = _jalan(R, s, c[:k] + ekor)
        assert _sama(b_x[:k], b[:k]), f"chunk tail changed after {k}: earlier rows changed"


def test_kausal_tanggal():
    R, _, s, c = _dunia()
    _, b = _jalan(R, s, c)
    for i in (200, 700, 1400):
        t = c[i]["tgl"]
        c2 = [dict(e, lr=4.0, b25=1.0, kode=e["kode"].replace("-I", "-III"), tr=9.0) if (j < i and e["tgl"] >= t) else e
              for j, e in enumerate(c)]
        _, b2 = _jalan(R, s, c2)
        assert _sama(b2[i:i + 1], b[i:i + 1]), f"row {i} depends on claims dated on/after its own date"


def test_peer_beku():
    R, _, s, c = _dunia()
    _, b = _jalan(R, s, c)
    keep = [j for j, e in enumerate(c) if e["faskes"] != "H03"]   # H03 is in H00's peer group G0
    _, b2 = _jalan(R, s, [c[j] for j in keep])
    assert _sama(b2, b[keep]), "chunk rows of one hospital changed the rows of another (peers not frozen)"
    # whereas H03's STREAM rows do move the peers of H00 (same group): the freeze is what makes the check above hold
    s2 = [e for e in s if e["faskes"] != "H03"]
    _, b3 = _jalan(R, s2, c)
    h0 = [j for j, e in enumerate(c) if e["faskes"] == "H00"]
    assert not _sama(b3[h0], b[h0])


def test_sedikit_data():
    R, _, s, c = _dunia()
    _, b = _jalan(R, s, c)
    inap = [IDX[n] for n in ("rs: sev3_lebih_vs_peer_90h", "rs: sev3_z_90h", "rs: los_rasio_vs_peer_90h", "rs: rawat_pendek_z_90h")]
    f90 = b[:, IDX["rs: sedikit_data_90h"]] == 1
    assert np.isnan(b[f90][:, inap]).all(), "flagged rows must have NaN inpatient features"
    # the small hospitals (~1 claim a day) start below 30 inpatient claims; the chunk's own rows fill their window later
    for h in ("H10", "H11"):
        rows = [j for j, e in enumerate(c) if e["faskes"] == h][:20]
        assert f90[rows].all(), f"{h}: early rows not flagged"
    besar = np.array([e["faskes"] in ("H00", "H01", "H02") for e in c])
    assert (b[besar, IDX["rs: sedikit_data_90h"]] == 0).all() and np.isfinite(b[besar][:, inap]).all()
    flag = b[:, IDX["rs: sedikit_data_30h"]] == 1
    assert np.isnan(b[flag, IDX["rs: sev3_z_30h"]]).all() and np.isnan(b[flag, IDX["rs: tren_sev3"]]).all()


def _naif(R, silver, stream, chunk, i_chunk: int) -> dict:
    """Separate naive implementation for chunk row i: lists of raw claims, window filters, plain means."""
    e = chunk[i_chunk]
    d = (date.fromisoformat(e["tgl"]) - RS.BASIS).days
    h = e["faskes"]
    g = R["rs_peer"].get(h, "?")
    semua = [(dd, x, "ref") for dd, x in silver] + [((date.fromisoformat(x["tgl"]) - RS.BASIS).days, x, "ref") for x in stream] \
        + [((date.fromisoformat(x["tgl"]) - RS.BASIS).days, x, "chunk") for x in chunk[:i_chunk]]
    win = [(x, src) for dd, x, src in semua if d - 90 <= dd < d]
    own = [x for x, src in win if x["faskes"] == h]
    peer = [x for x, src in win if src == "ref" and x["faskes"] != h and R["rs_peer"].get(x["faskes"], "?") == g]
    if sum(x["ritl"] for x in peer) < 30:
        peer = [x for x, src in win if src == "ref" and x["faskes"] != h]

    def mean(v):
        return sum(v) / len(v) if v else math.nan

    def exp3(x):
        f, _ = RS._famili(x["kode"])
        gg = R["rs_peer"].get(x["faskes"], "?")
        return R["p3"].get((gg, f), R["g3"].get(f, R["P3"]))

    def sev(xs):
        z = [x for x in xs if x["ritl"] and RS._famili(x["kode"])[1]]
        return mean([float(x["kode"].endswith("-III")) - exp3(x) for x in z])
    n_ri = sum(x["ritl"] for x in own)
    ok = n_ri >= 30
    return {"rs: n_rawat_inap_90h": math.log1p(n_ri),
            "rs: los_rasio_vs_peer_90h": (mean([min(x["lr"], 4) for x in own if x["ritl"] and x["lr"] >= 0])
                                          - mean([min(x["lr"], 4) for x in peer if x["ritl"] and x["lr"] >= 0])) if ok else math.nan,
            "rs: topup_laju_vs_peer_90h": (mean([float(x["tr"] > 0) for x in own]) - mean([float(x["tr"] > 0) for x in peer]))
            if len(own) >= 30 else math.nan,
            "rs: sev3_lebih_vs_peer_90h": (sev(own) - sev(peer)) if ok else math.nan}


def test_brute_force():
    R, silver, s, c = _dunia()
    _, b = _jalan(R, s, c)
    for i in (5, 333, 777, 1111, 1499):
        ref = _naif(R, silver, s, c, i)
        for n, v in ref.items():
            got = float(b[i, IDX[n]])
            assert (math.isnan(v) and math.isnan(got)) or abs(got - v) <= 1e-4 * max(1.0, abs(v)), f"row {i} {n}: {got} vs naive {v}"


def test_chunks_sekaligus():
    R, _, s, c = _dunia()
    S = _sebagai_npz(s)
    C1, C2 = _sebagai_npz(c[:700]), _sebagai_npz(c[700:])
    many = RS.matriks_rs_chunks(S, [C1, C2], R)
    assert _sama(many[0], RS.matriks_rs(S, C1, R)) and _sama(many[1], RS.matriks_rs(S, C2, R))


def _sebagai_npz(rows):
    """Rows -> an npz-like dict (X1 with the RITL one-hot at its model column, X4 at fitur_v4.NAMES), to test baris()."""
    import fitur_v4 as F4

    n = len(rows)
    X1 = np.zeros((n, RS._ritl_idx() + 1), np.float32)
    X4 = np.zeros((n, len(F4.NAMES)), np.float32)
    for i, e in enumerate(rows):
        X1[i, RS._ritl_idx()] = float(e["ritl"])
        for k, col in RS.X4_KOLOM.items():
            X4[i, F4.NAMES.index(col)] = e[k]
    return {"X1": X1, "X4": X4, "faskes": np.array([e["faskes"] for e in rows]), "tgl": np.array([e["tgl"] for e in rows]),
            "kode": np.array([e["kode"] for e in rows])}


def test_data_nyata():
    f = RS.TMP / "data_v4" / "fitur_00.npz"
    if not (f.exists() and RS.STREAM.exists() and RS.STREAM_X4.exists()):
        return
    S = RS.muat_stream()
    n = 20000
    Ss = {k: S[k][:n] for k in ("X1", "X4", "faskes", "tgl", "kode")}
    Z = np.load(f, allow_pickle=False)
    C = {k: Z[k][:1500] for k in ("X1", "X4", "faskes", "tgl", "kode")}
    R = RS.referensi()
    b1, b2 = RS.matriks_rs(Ss, C, R), RS.matriks_rs(Ss, C, R)
    assert _sama(b1, b2)
    a = RS.matriks_rs(Ss, None, R)
    a_k = RS.matriks_rs({k: v[:12000] for k, v in Ss.items()}, None, R)
    assert _sama(a_k, a[:12000])
    b_k = RS.matriks_rs(Ss, {k: v[:900] for k, v in C.items()}, R)
    assert _sama(b_k, b1[:900])


def main() -> int:
    gagal = 0
    for nama, fn in [(k, v) for k, v in globals().items() if k.startswith("test_")]:
        try:
            fn()
            print(f"PASS {nama}")
        except AssertionError as ex:
            gagal += 1
            print(f"FAIL {nama}: {ex}")
    print("PASS" if not gagal else f"FAIL ({gagal})")
    return 1 if gagal else 0


if __name__ == "__main__":
    sys.exit(main())
