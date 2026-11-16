"""Proof that the 100.000 test claims (testing/uji100k.py) lie outside the training data, fraud and normal alike.

The training data is what latih_model.py reads: the labelled stream claims and the clean plants and copy-built normals
(aug:*) of the /testing copy. For every test claim (from .tmp/uji100k/hasil_*.npz):
1. its member has no claim in the training data;
2. its source claim (a September–November 2024 claim) is not a training claim;
3. no training claim has the same member, hospital, admission date and INA-CBG code;
4. the source claim's own admission date lies in 1 September – 15 November 2024 (the silver data).
Writes the counts into data/aip/ml/sistem_terbaru/uji_100k.json ("cek_luar_latih"); prints them. Synthetic data only.
Usage: .venv/Scripts/python.exe testing/uji100k_cek.py"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import sys

import duckdb
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DB = ROOT / ".tmp" / "testing-data" / "aip" / "realtime" / "realtime.sqlite"
SILVER = ROOT / "data" / "drive" / "217f2b804b0c4525"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru" / "uji_100k.json"
# an argument: another test folder (test B, .tmp/uji100k_b); its result goes to <folder>/cek.json and it is also checked
# against the members of test A
UJI = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".tmp" / "uji100k"


def main() -> None:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = con.execute("""SELECT json_extract(p.rec,'$.peserta'), json_extract(p.rec,'$.faskes'), substr(json_extract(p.rec,'$.tgl_datang'),1,10),
                                 json_extract(p.rec,'$.kode'), json_extract(p.rec,'$.kunjungan')
                          FROM peristiwa p LEFT JOIN kebenaran k ON k.peristiwa = p.id
                          WHERE json_extract(p.rec,'$.jenis') = 'fkrtl' AND (k.peristiwa IS NOT NULL OR p.sumber LIKE 'aug:%')""").fetchall()
    con.close()
    latih_peserta = {str(r[0]) for r in rows}
    latih_kunci = {(str(r[0]), str(r[1]), str(r[2]), str(r[3])) for r in rows}
    latih_klaim = {str(r[4]) for r in rows}
    # the training data of architecture v2 (data_v2.py, all ten chunks: training and validation): members, source claims, content
    v2 = sorted((ROOT / ".tmp" / "data_v2").glob("fitur_[0-9][0-9].npz"))
    n_v2 = 0
    for f in v2:
        d = np.load(f)
        n_v2 += len(d["sk"])
        latih_peserta.update(str(x) for x in d["peserta"])
        latih_klaim.update(str(x) for x in d["asal"])
        latih_kunci.update(zip(map(str, d["peserta"]), map(str, d["faskes"]), map(str, d["tgl"]), map(str, d["kode"])))
    ds = [np.load(f, allow_pickle=False) for f in sorted(UJI.glob("hasil_[0-9][0-9].npz"))]
    cat = {k: np.concatenate([d[k] for d in ds]) for k in ("sk", "peserta", "faskes", "tgl", "kode", "asal")}
    fraud = cat["sk"] != "normal"
    sama_peserta = np.array([p in latih_peserta for p in cat["peserta"]])
    sama_asal = np.array([a in latih_klaim for a in cat["asal"]])
    sama_kunci = np.array([(p, f, t, k) in latih_kunci for p, f, t, k in zip(cat["peserta"], cat["faskes"], cat["tgl"], cat["kode"])])
    asal = sorted(set(cat["asal"].tolist()))
    tgl_asal = dict(duckdb.sql(f"""SELECT kunjungan_fkrtl_id, tgl_datang FROM read_parquet('{SILVER.as_posix()}')
                                   WHERE kunjungan_fkrtl_id IN (SELECT unnest(?::VARCHAR[]))""", params=[asal]).fetchall()) if asal else {}
    di_luar = np.array([str(tgl_asal.get(a)) < "2024-09-01" or str(tgl_asal.get(a)) > "2024-11-15" if a in tgl_asal else True for a in cat["asal"]])

    def hitung(mask: np.ndarray) -> dict:
        return {"klaim": int(mask.sum()), "peserta_di_latih": int((sama_peserta & mask).sum()), "asal_di_latih": int((sama_asal & mask).sum()),
                "isi_sama_dengan_latih": int((sama_kunci & mask).sum()), "asal_di_luar_sep_nov": int((di_luar & mask).sum())}

    cek = {"latih": {"klaim": len(rows) + n_v2, "klaim_aliran": len(rows), "klaim_data_v2": n_v2, "peserta": len(latih_peserta)}, "fraud": hitung(fraud), "normal": hitung(~fraud), "semua": hitung(np.ones(len(fraud), bool)),
           "catatan": "Riwayat peserta di engine (fitur) memuat klaim asalnya 45+ hari sebelumnya, seperti pasien sungguhan yang punya riwayat; itu bukan data latih model."}
    if UJI != ROOT / ".tmp" / "uji100k":  # test B: no member of test A either
        a = set()
        for f in sorted((ROOT / ".tmp" / "uji100k").glob("hasil_[0-9][0-9].npz")):
            a.update(str(x) for x in np.load(f)["peserta"])
        di_a = np.array([x in a for x in cat["peserta"]])
        for g, m in (("fraud", fraud), ("normal", ~fraud), ("semua", np.ones(len(fraud), bool))):
            cek[g]["peserta_di_uji_a"] = int((di_a & m).sum())
    cek["lulus"] = all(cek["semua"].get(k, 0) == 0 for k in ("peserta_di_latih", "asal_di_latih", "isi_sama_dengan_latih", "asal_di_luar_sep_nov", "peserta_di_uji_a"))
    print(json.dumps(cek, indent=1, ensure_ascii=False))
    if UJI != ROOT / ".tmp" / "uji100k":
        (UJI / "cek.json").write_text(json.dumps(cek, ensure_ascii=False, indent=1), "utf-8")
        print("written", UJI / "cek.json")
    elif OUT.exists():
        d = json.loads(OUT.read_text("utf-8"))
        d["cek_luar_latih"] = cek
        OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
        print("added to", OUT)


if __name__ == "__main__":
    main()
