"""References the realtime rules read, built once when the engine warms up, from the silver datasets in Files (read as
the engine's owner): the member registry as a table, per-code statistics of the FKRTL claims, and the history of each
FKTP and non-capitation facility before the replay window (so a facility is compared with itself, not with the window
it is judged on).

  anggota            member registry (sex, birth date, class entitlement, segment, death year, status, family, the FKTP
                     unit it is registered at): a DuckDB table looked up per batch
  kode               per INA-CBG code: claims, p99 of secondary diagnoses; per code and special-CMG top-up type: how
                     often it carries one and its p95 amount
  pasangan           diagnosis (ICD-10 category) → INA-CBG code counts for diagnoses with >= 1,000 claims
  fktp               per FKTP profile: visits per day, share of contact-only visits (online/home-visit), referrals per day,
                     share of non-specialist referrals, referral destinations; per FKTP unit (kab/kota, ownership, kind:
                     the key the registry has) visits per day and registered members
  nonkap             per procedure: median and p95 billed; per non-capitation facility profile: claims per day
"""

from __future__ import annotations

import hashlib
import logging
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from aip.realtime.modus import CONTACT_ONLY_POLI, NON_SPESIALISTIK

log = logging.getLogger("aip.realtime.ref")
HISTORY_DAYS = 60
TOPUPS = {"sa_tarif_rp": "subakut", "sp_tarif_rp": "prosedur khusus", "rr_tarif_rp": "prostesis", "si_tarif_rp": "investigasi khusus", "sd_tarif_rp": "obat khusus"}
HAK = {"KELAS I": 1, "KELAS II": 2, "KELAS III": 3}


def profile(tingkat: str, kab: Any, kepemilikan: Any, jenis: Any, tipe: Any) -> str:
    """The facility profile key of the silver pipeline: md5(concat_ws('|', tingkat, kab/kota, ownership, kind, type))."""
    parts = [tingkat, None if kab is None else str(int(kab)), kepemilikan, jenis, tipe]
    return hashlib.md5("|".join(str(p) for p in parts if p is not None).encode("utf-8")).hexdigest()


def anggota_sql(ps: str) -> str:
    """The member registry projection (one row per edition and member), used by the engine and by SSL pretraining."""
    return f"""SELECT edisi, peserta_id, keluarga_id, peserta_ibu_id,
              CASE WHEN jenis_kelamin ILIKE 'laki%' THEN 'L' WHEN jenis_kelamin ILIKE 'perempuan%' THEN 'P' END AS jk, tgl_lahir,
              CASE kelas_rawat WHEN 'KELAS I' THEN 1 WHEN 'KELAS II' THEN 2 WHEN 'KELAS III' THEN 3 END AS hak, segmen, tahun_meninggal,
              status_kepesertaan, flag_tgl_lahir_pengganti AS tgl_lahir_pengganti,
              kabkota_fktp_terdaftar_kode::VARCHAR || '|' || upper(coalesce(kepemilikan_fktp_terdaftar, '')) || '|' || upper(coalesce(jenis_fktp_terdaftar, '')) AS unit_terdaftar
            FROM read_parquet('{ps}')"""


def unit(kab: Any, kepemilikan: Any, jenis: Any) -> str:
    """An FKTP capitation unit as the member registry knows it (no type): kab/kota | ownership | kind."""
    return f"{kab}|{(kepemilikan or '').upper()}|{(jenis or '').upper()}"


def silver_path(name: str, dest: Path) -> Path:
    """A silver dataset of the BPJS project (Files), checked as the caller."""
    import drive

    from aip import ml as aip_ml

    project = aip_ml._child(None, aip_ml.PROJECT)
    silver = project and aip_ml._child(project["id"], "silver")
    item = silver and aip_ml._child(silver["id"], f"{name}.parquet")
    if not item:
        raise HTTPException(404, f"dataset silver {name} tidak ditemukan")
    return Path(aip_ml._local(drive._item(item["id"]), dest))


class Referensi:
    def __init__(self) -> None:
        self.kode: dict[str, dict] = {}
        self.topup: dict[tuple[str, str], dict] = {}
        self.dx_total: dict[str, int] = {}
        self.pair: dict[tuple[str, str], int] = {}
        self.fktp: dict[str, dict] = {}
        self.fktp_dest: dict[str, dict[str, float]] = {}
        self.unit: dict[str, dict] = {}
        self.nonkap_tindakan: dict[str, dict] = {}
        self.nonkap_fac: dict[str, float] = {}
        self.info: dict = {}

    def build(self, con: Any, start: date, edisi: str, dest: Path) -> None:
        t0 = time.time()
        fk = silver_path("kunjungan_fkrtl", dest).as_posix()
        ps = silver_path("peserta", dest).as_posix()
        ft = silver_path("kunjungan_fktp", dest).as_posix()
        nk = silver_path("tindakan_nonkapitasi", dest).as_posix()
        lo = start - timedelta(days=HISTORY_DAYS)
        # the member registry
        con.execute(f"CREATE OR REPLACE TABLE anggota AS {anggota_sql(ps)}")
        # per-code statistics of the FKRTL claims (the whole year: a code's habits)
        for code, n, p99 in con.execute(f"""SELECT inacbg_kode, count(*), quantile_cont(jumlah_dx_sekunder, 0.99) FROM read_parquet('{fk}')
                                            WHERE inacbg_kode IS NOT NULL GROUP BY 1""").fetchall():
            self.kode[code] = {"n": int(n), "dx_sek_p99": float(p99 or 0)}
        cols = ", ".join(f"count(*) FILTER (WHERE {c} > 0), quantile_cont({c}, 0.95) FILTER (WHERE {c} > 0)" for c in TOPUPS)
        for row in con.execute(f"SELECT inacbg_kode, {cols} FROM read_parquet('{fk}') WHERE inacbg_kode IS NOT NULL GROUP BY 1").fetchall():
            code = row[0]
            for i, c in enumerate(TOPUPS):
                self.topup[(code, c)] = {"n": int(row[1 + 2 * i] or 0), "p95": float(row[2 + 2 * i] or 0)}
        self.dx_total = {dx: int(n) for dx, n in con.execute(f"""SELECT dx_primer_icd3, count(*) FROM read_parquet('{fk}')
                                                                   WHERE dx_primer_icd3 IS NOT NULL GROUP BY 1""").fetchall()}
        big = [dx for dx, n in self.dx_total.items() if n >= 1000]
        con.register("dx_besar", __import__("pandas").DataFrame({"dx": big}))
        self.pair = {(dx, code): int(n) for dx, code, n in con.execute(f"""SELECT dx_primer_icd3, inacbg_kode, count(*) FROM read_parquet('{fk}')
                     WHERE dx_primer_icd3 IN (SELECT dx FROM dx_besar) AND inacbg_kode IS NOT NULL GROUP BY 1, 2""").fetchall()}
        con.unregister("dx_besar")
        # FKTP: each profile's own history before the window
        ns = ", ".join(f"'{d}'" for d in sorted(NON_SPESIALISTIK))
        co = ", ".join(f"'{p}'" for p in sorted(CONTACT_ONLY_POLI))
        days = (start - lo).days
        con.execute(f"""CREATE OR REPLACE TEMP VIEW fh AS SELECT *, md5(concat_ws('|', 'FKTP', kabkota_fktp_kode, kepemilikan_fktp, jenis_fktp, tipe_fktp)) AS prof,
              kabkota_fktp_kode::VARCHAR || '|' || upper(coalesce(kepemilikan_fktp, '')) || '|' || upper(coalesce(jenis_fktp, '')) AS unit,
              (status_pulang = 'RUJUK LANJUT') AS rujuk,
              concat_ws('|', kabkota_rujukan_kode, kepemilikan_rujukan, jenis_faskes_rujukan, tipe_faskes_rujukan) AS tujuan
            FROM read_parquet('{ft}') WHERE edisi = '{edisi}' AND tgl_datang >= DATE '{lo}' AND tgl_datang < DATE '{start}'""")
        for prof, n, kontak, rujuk, nonspes, peme in con.execute(f"""SELECT prof, count(*), count(*) FILTER (WHERE poli IN ({co})), count(*) FILTER (WHERE rujuk),
                 count(*) FILTER (WHERE rujuk AND dx_icd3 IN ({ns})), bool_or(kepemilikan_fktp ILIKE 'PEM%') FROM fh GROUP BY 1""").fetchall():
            self.fktp[prof] = {"per_hari": n / days, "kontak_semu": kontak / n if n else 0.0, "rujukan_per_hari": rujuk / days,
                               "rrns": nonspes / rujuk if rujuk else None, "rujukan": int(rujuk), "pemerintah": bool(peme)}
        for prof, tujuan, n, tot in con.execute("""SELECT prof, tujuan, count(*), sum(count(*)) OVER (PARTITION BY prof) FROM fh WHERE rujuk GROUP BY 1, 2""").fetchall():
            self.fktp_dest.setdefault(prof, {})[tujuan] = n / tot
        reg = dict(con.execute("SELECT unit_terdaftar, count(*) FROM anggota WHERE edisi = ? GROUP BY 1", [edisi]).fetchall())
        for u, n in con.execute("SELECT unit, count(*) FROM fh GROUP BY 1").fetchall():
            self.unit[u] = {"per_hari": n / days, "terdaftar": int(reg.get(u, 0))}
        # non-capitation: each procedure's norm (all editions, before the window) and each facility's daily volume
        con.execute(f"""CREATE OR REPLACE TEMP VIEW nh AS SELECT *, md5(concat_ws('|', 'NONKAPITASI', kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes,
              tipe_faskes)) AS prof FROM read_parquet('{nk}') WHERE tgl_kunjungan < DATE '{start}'""")
        for t, n, med, p95 in con.execute("SELECT tindakan, count(*), median(biaya_tagih_rp), quantile_cont(biaya_tagih_rp, 0.95) FROM nh GROUP BY 1").fetchall():
            self.nonkap_tindakan[t] = {"n": int(n), "median": float(med or 0), "p95": float(p95 or 0)}
        for prof, n in con.execute(f"SELECT prof, count(*) FROM nh WHERE edisi = '{edisi}' AND tgl_kunjungan >= DATE '{lo}' GROUP BY 1").fetchall():
            self.nonkap_fac[prof] = n / days
        self.paths = {"fkrtl": fk, "peserta": ps, "fktp": ft, "nonkap": nk}
        self.info = {"detik": round(time.time() - t0, 1), "anggota": con.execute("SELECT count(*) FROM anggota").fetchone()[0], "kode": len(self.kode),
                     "pasangan_dx_kode": len(self.pair), "fktp_profil": len(self.fktp), "fktp_unit": len(self.unit),
                     "tindakan_nonkap": len(self.nonkap_tindakan), "riwayat_dari": str(lo), "riwayat_sampai": str(start - timedelta(days=1))}
        log.info("realtime: references in %.1fs %s", time.time() - t0, self.info)

    # ------------------------------------------------------------------------------------------------
    def members(self, con: Any, keys: list[tuple[str, int]]) -> dict[tuple[str, int], dict]:
        """Registry rows of the batch's members (one query)."""
        if not keys:
            return {}
        import pandas as pd

        con.register("cari", pd.DataFrame({"edisi": [k[0] for k in keys], "peserta_id": [int(k[1]) for k in keys]}))
        rows = con.execute("""SELECT a.* FROM anggota a JOIN (SELECT DISTINCT edisi, peserta_id FROM cari) c USING (edisi, peserta_id)""").df()
        con.unregister("cari")
        out = {}
        for r in rows.to_dict("records"):
            out[(r["edisi"], int(r["peserta_id"]))] = r
        return out

    def family(self, con: Any, edisi: str, keluarga_id: Any, but: int) -> list[dict]:
        if keluarga_id is None:
            return []
        return con.execute("SELECT peserta_id, jk, tgl_lahir FROM anggota WHERE edisi = ? AND keluarga_id = ? AND peserta_id <> ?",
                           [edisi, keluarga_id, int(but)]).df().to_dict("records")

    def rare_pair(self, dx: Optional[str], code: Optional[str]) -> Optional[tuple[int, int]]:
        """(pair count, diagnosis count) when the diagnosis is common (>= 1,000 claims) and the pair almost never seen (<= 3)."""
        if not dx or not code:
            return None
        dn = self.dx_total.get(dx, 0)
        if dn < 1000:
            return None
        n = self.pair.get((dx, code), 0)
        return (n, dn) if n <= 3 else None
