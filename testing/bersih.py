"""Clean data for the v3 retrain (step 2 of the plan agreed 2026-11-12 after generator 2; the user: "oke kerjakan, nanti update report").

Two problems generator 2 exposed in how the training data v2 and tests A/B were built, fixed here for every new data set:
1. The echo. A claim of Jan–Nov moved into the replay window kept its original in the member history (the engine's `peserta` table,
   built from the feature store), at the same hospital, so no moved normal claim was ever a member's first visit to that hospital
   (stream: 20 % of normals). Fix: every source claim a chunk uses is taken out of that chunk's in-memory history before anything is
   ingested (`hapus_gema`). First visits then occur at their natural rate, with nothing planted.
2. Member reuse. Each member gets one role from a fixed hash (`peran`), so the new training data, its validation members, test C and
   the second generator 2 run never share a member; members already used by the old tests or by generator 2's first run (both used
   for diagnosis) and the replay stream's members are left out of all of them (`dipakai`).
Synthetic data only."""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TMP = ROOT / ".tmp"
REPLAY = ROOT / "data" / "aip" / "realtime" / "replay_fkrtl_2024-12-18_2024-12-31.parquet"
# roles over 20 hash buckets: training 0–13, validation 14–15, test C 16–17, generator 2 (second run) 18–19
PERAN = {"latih": range(0, 14), "validasi": range(14, 16), "uji_c": range(16, 18), "gen2_baru": range(18, 20)}


def peran(pid: int) -> str:
    b = int(hashlib.md5(f"{int(pid)}|peran-v4".encode()).hexdigest()[:8], 16) % 20
    return next(k for k, r in PERAN.items() if b in r)


def peran_array(pids) -> np.ndarray:
    return np.array([peran(p) for p in pids])


def ember(pid: int, n: int, garam: str) -> int:
    """A second, independent hash bucket inside a role (the chunk of a member)."""
    return int(hashlib.md5(f"{int(pid)}|{garam}".encode()).hexdigest()[:8], 16) % n


def tabel_peran(silver: Path):
    """Every reguler member of the silver claims with its role and its chunk buckets, as a DataFrame for a DuckDB join."""
    import duckdb

    ids = duckdb.sql(f"SELECT DISTINCT peserta_id FROM read_parquet('{silver.as_posix()}') WHERE edisi = 'reguler'").df()
    ids["peran"] = peran_array(ids.peserta_id)
    ids["ember8"] = [ember(p, 8, "latih") for p in ids.peserta_id]
    ids["ember2"] = [ember(p, 2, "validasi") for p in ids.peserta_id]
    ids["ember20"] = [ember(p, 20, "uji_c") for p in ids.peserta_id]
    ids["ember10"] = [ember(p, 10, "uji_c") for p in ids.peserta_id]
    return ids


def _peserta_npz(pola: str, kunci: str = "peserta") -> set[int]:
    out: set[int] = set()
    for f in sorted(TMP.glob(pola)):
        try:
            out.update(int(x) for x in np.load(f)[kunci] if str(x).isdigit())
        except (KeyError, ValueError):
            pass
    return out


def dipakai() -> dict[str, set[int]]:
    """Members that no new data set may use: the replay stream's, tests A and B's, generator 2's first run (both diagnosed on)."""
    import pandas as pd

    return {"aliran": set(int(x) for x in pd.read_parquet(REPLAY, columns=["peserta_id"]).peserta_id.unique()),
            "uji_a": _peserta_npz("uji100k/hasil_[0-9][0-9].npz"), "uji_b": _peserta_npz("uji100k_b/hasil_[0-9][0-9].npz"),
            "gen2": _peserta_npz("gen2/hasil_[0-9][0-9].npz")}


def semua_dipakai() -> set[int]:
    return set().union(*dipakai().values())


def profil(row: dict) -> str:
    """layanan.profile_id from a silver row (md5 of 'FKRTL|kab|ownership|kind|type', missing parts left out)."""
    tipe = row.get("tipe_fkrtl")
    tipe = tipe if isinstance(tipe, str) and tipe else None
    parts = ["FKRTL", str(int(row["kabkota_fkrtl_kode"])) if row.get("kabkota_fkrtl_kode") is not None else None, row.get("kepemilikan_fkrtl"),
             row.get("jenis_fkrtl"), tipe]
    return hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()


def hapus_gema(con, rows) -> dict:
    """Take the source claims out of the engine's in-memory member history (table `peserta`: edisi, peserta_id, faskes_profil_id,
    tgl_datang, inacbg_kode, n): one count per source claim, the row removed when it reaches zero. Nothing on disk changes."""
    import pandas as pd

    df = pd.DataFrame([{"edisi": "reguler", "peserta_id": int(r["peserta_id"]), "faskes_profil_id": profil(r),
                        "tgl_datang": pd.Timestamp(r["tgl_datang"]), "inacbg_kode": r["inacbg_kode"]} for r in rows])
    if df.empty:
        return {"sumber": 0, "dihapus": 0}
    g = df.groupby(list(df.columns)).size().rename("k").reset_index()
    con.register("gema_df", g)
    con.execute("CREATE OR REPLACE TEMP TABLE gema AS SELECT edisi, peserta_id::BIGINT AS peserta_id, faskes_profil_id, tgl_datang::DATE AS tgl_datang, inacbg_kode, k FROM gema_df")
    sebelum = con.execute("SELECT coalesce(sum(n), 0) FROM peserta").fetchone()[0]
    ada = con.execute("""SELECT count(*) FROM gema JOIN peserta p USING (edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode)""").fetchone()[0]
    con.execute("""UPDATE peserta p SET n = p.n - g.k FROM gema g WHERE p.edisi = g.edisi AND p.peserta_id = g.peserta_id
                   AND p.faskes_profil_id = g.faskes_profil_id AND p.tgl_datang = g.tgl_datang AND p.inacbg_kode = g.inacbg_kode""")
    con.execute("DELETE FROM peserta WHERE n <= 0")
    sesudah = con.execute("SELECT coalesce(sum(n), 0) FROM peserta").fetchone()[0]
    con.execute("DROP TABLE gema"); con.unregister("gema_df")
    return {"sumber": int(len(df)), "ketemu_di_riwayat": int(ada), "dihapus": int(sebelum - sesudah)}


def sisa_gema(con, rows) -> int:
    """How many of the source claims are still in the history (0 after hapus_gema)."""
    import pandas as pd

    df = pd.DataFrame([{"edisi": "reguler", "peserta_id": int(r["peserta_id"]), "faskes_profil_id": profil(r),
                        "tgl_datang": pd.Timestamp(r["tgl_datang"]), "inacbg_kode": r["inacbg_kode"]} for r in rows]).drop_duplicates()
    if df.empty:
        return 0
    con.register("cek_df", df)
    n = con.execute("""SELECT count(*) FROM (SELECT edisi, peserta_id::BIGINT AS peserta_id, faskes_profil_id, tgl_datang::DATE AS tgl_datang, inacbg_kode FROM cek_df) c
                       JOIN peserta USING (edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode)""").fetchone()[0]
    con.unregister("cek_df")
    return int(n)
