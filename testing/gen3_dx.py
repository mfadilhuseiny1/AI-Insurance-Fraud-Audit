"""Primary diagnosis (ICD-10) of every claim of a generator 3 run, recovered by regenerating its chunks (the generator is
deterministic given GEN3_GARAM, the chunk and the excluded members) and aligning them with the run's saved rows.
The runner (uji_gen2.py) kept no diagnosis; the branch report needs it for clinical themes. No model, no engine.

    GEN3_GARAM=gen3-v5 .venv/Scripts/python.exe testing/gen3_dx.py D:/.../.tmp/gen3_v5      -> <dir>/dx.npz (per chunk, per row)"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import generator3 as G  # noqa: E402
import uji100k as U  # noqa: E402


def kecuali_stream() -> set[int]:
    """The members of the replay stream the runner excluded (the same query as uji_gen2.chunk, on the source copy)."""
    con = sqlite3.connect(f"file:{U.SRC_DATA / 'aip' / 'realtime' / 'realtime.sqlite'}?mode=ro", uri=True)
    rows = con.execute("""SELECT p.rec FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                 WHERE json_extract(p.rec, '$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'uji:%' OR p.sumber LIKE 'aug:%') ORDER BY p.seq""")
    out = set()
    for (r,) in rows:
        p = json.loads(r).get("peserta")
        if str(p).isdigit():
            out.add(int(p))
    con.close()
    return out


def satu_chunk(d: Path, c: int) -> None:
    """One chunk in this process (its PYTHONHASHSEED decides set orders inside the generator): <d>/dx_<c>.npz if better."""
    kec = kecuali_stream()
    h = np.load(d / f"hasil_{c:02d}.npz", allow_pickle=False)
    klaim = G.buat(c, kec)
    key = lambda tgl, kode, biaya: (str(tgl)[:10], str(kode), int(biaya))  # noqa: E731
    gen = [key(b["tgl_datang"], b["inacbg_kode"], b["biaya_tagih_rp"]) for b in klaim]
    j, icd, nama, ok = 0, [], [], 0
    for r in (key(t, k, bi) for t, k, bi in zip(h["tgl"], h["kode"], h["biaya"])):
        jj = next((x for x in range(j, min(len(gen), j + 50)) if gen[x] == r), None)
        if jj is None:
            icd.append(""); nama.append(""); continue
        b = klaim[jj]; j = jj + 1; ok += 1
        icd.append(str(b.get("dx_primer_icd3") or "")); nama.append(str(b.get("dx_primer_nama") or ""))
    f = d / f"dx_{c:02d}.npz"
    lama = int(np.load(f)["ok"]) if f.exists() else -1
    if ok > lama:
        np.savez_compressed(f, icd=np.array(icd), nama=np.array(nama), ok=ok)
    print(f"chunk {c}: {ok}/{len(icd)} aligned (best so far {max(ok, lama)})", flush=True)


def main(d: Path) -> None:
    kec = kecuali_stream()
    out = {}
    for c in range(G.N_CHUNK):
        h = np.load(d / f"hasil_{c:02d}.npz", allow_pickle=False)
        klaim = G.buat(c, kec)
        # align: the saved rows are the generated claims in order, minus the few that failed validation or judging. The
        # engine may rewrite a claim's member (identity schemes), so the match is on (date, code, bill), in order.
        key = lambda tgl, kode, biaya: (str(tgl)[:10], str(kode), int(biaya))  # noqa: E731
        gen = [key(b["tgl_datang"], b["inacbg_kode"], b["biaya_tagih_rp"]) for b in klaim]
        j, icd, nama, hilang = 0, [], [], 0
        for i, r in enumerate(key(t, k, bi) for t, k, bi in zip(h["tgl"], h["kode"], h["biaya"])):
            jj = next((x for x in range(j, min(len(gen), j + 50)) if gen[x] == r), None)
            if jj is None:
                icd.append(""); nama.append(""); hilang += 1
                continue
            b = klaim[jj]; j = jj + 1
            icd.append(str(b.get("dx_primer_icd3") or "")); nama.append(str(b.get("dx_primer_nama") or ""))
        out[f"icd_{c:02d}"] = np.array(icd); out[f"nama_{c:02d}"] = np.array(nama)
        print(f"chunk {c}: {len(icd) - hilang}/{len(icd)} rows aligned ({len(klaim)} generated)", flush=True)
    np.savez_compressed(d / "dx.npz", **out)
    print("written", d / "dx.npz")


if __name__ == "__main__":
    assert os.environ.get("GEN3_GARAM"), "set GEN3_GARAM to the run's salt"
    if len(sys.argv) > 2:
        satu_chunk(Path(sys.argv[1]), int(sys.argv[2]))
    else:
        main(Path(sys.argv[1]))
