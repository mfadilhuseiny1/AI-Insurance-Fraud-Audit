"""ML v7 + the rule engine on the REAL BPJS sample, one branch office (the user, 2026-11-13: "coba bikin tes baru swarm + ML v7
pake dataset BPJS asli 1 KC").

The real sample is bound by the pakta integritas: it is read in place (ai-jkn-audit data/drive, read-only) and everything derived
from it is written under RIIL = ai-jkn-audit/data/aip/uji_riil (the BPJS project's own data folder, git-ignored), never into this
app's folders. This process refuses every network connection except loopback (`tanpa_jaringan`): no claim leaves the machine here.
The swarm (Vertex) is a separate step that runs only with the user's explicit go-ahead.

  data      the engine's data root for real data: the /testing copy's settings and the AL folder (no Box, no stored events), the
            BPJS app's deployed feature store (its own deployed.json)
  jalankan  the national replay window 18–31 Dec 2024 (edition reguler) ingested in date order into the realtime engine on the real
            silver; the stream features X1/X2/XR (fitur.Stream with the first model's standardisation, as every test) and X4
            (fitur_v4 on the real references) for every claim; <RIIL>/<set>/hasil_00.npz with the claim fields the branch report
            reads. No labels exist: sk is "normal" for every claim; the verifiers' corrections (flag_selisih_verifikasi, selisih_rp)
            are kept apart as a weak proxy for the appendix only, never as an input
  rs        the hospitals' profiles (kab/kota, ownership, kind, type) and their 2024 volume, for the branch areas

Usage: .venv/Scripts/python.exe testing/uji_riil.py data | rs | jalankan [--set riil_kc] | fitur [--set riil_kc] (from the stored events)"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
AUDIT = Path(os.environ.get("JKN_AUDIT_ROOT") or ROOT.parent / "ai-jkn-audit")
DRIVE = AUDIT / "data" / "drive"                       # the real silver datasets (same item ids as this app's synthetic copies)
DEPLOYED = AUDIT / "data" / "aip" / "produksi" / "deployed.json"
RIIL = Path(os.environ.get("UJI_RIIL") or AUDIT / "data" / "aip" / "uji_riil")
SRC_DATA = ROOT / ".tmp" / "testing-data"
FKRTL = DRIVE / "217f2b804b0c4525"
W0, W1 = date(2024, 12, 18), date(2024, 12, 31)
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def tanpa_jaringan() -> None:
    """Every outbound connection of this process fails unless it is to this machine."""
    lokal = ("127.0.0.1", "::1", "localhost")

    def cek(addr) -> None:
        host = addr[0] if isinstance(addr, tuple) else addr
        if str(host) not in lokal:
            raise PermissionError(f"uji_riil: koneksi keluar ke {host} diblokir (data riil BPJS tidak boleh keluar)")

    asli_connect, asli_ex = socket.socket.connect, socket.socket.connect_ex

    def connect(self, addr):  # noqa: ANN001
        if self.family in (socket.AF_INET, socket.AF_INET6):
            cek(addr)
        return asli_connect(self, addr)

    def connect_ex(self, addr):  # noqa: ANN001
        if self.family in (socket.AF_INET, socket.AF_INET6):
            cek(addr)
        return asli_ex(self, addr)

    socket.socket.connect, socket.socket.connect_ex = connect, connect_ex
    asli_gai = socket.getaddrinfo

    def getaddrinfo(host, *a, **k):  # noqa: ANN001
        if host not in (None, *lokal):
            raise PermissionError(f"uji_riil: resolusi nama {host} diblokir")
        return asli_gai(host, *a, **k)

    socket.getaddrinfo = getaddrinfo


def env_riil() -> None:
    os.environ["BLUESANDAI_AUTH"] = "off"
    os.environ["PLATFORM_DRIVE"] = str(DRIVE)
    os.environ["FITUR_V4_DRIVE"] = str(DRIVE)
    os.environ["FITUR_V4_CACHE"] = str(RIIL / "fitur_v4_ref_riil.pkl")


# ---------------------------------------------------------------------------------------------------------- the data root
def data() -> None:
    dst = RIIL / "data"
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "aip" / "realtime").mkdir(parents=True)
    (dst / "aip" / "vertex_spend").mkdir()
    (dst / "aip" / "produksi").mkdir()
    # the BPJS app's deployed package and feature store (built from the real silver), referenced in place
    shutil.copy2(DEPLOYED, dst / "aip" / "produksi" / "deployed.json")
    # the bench's settings and active-learning folder (synthetic models; AL runs in shadow mode); no events, no Box
    for nm in ("konfigurasi.json", "sumber.json"):
        shutil.copy2(SRC_DATA / "aip" / "realtime" / nm, dst / "aip" / "realtime" / nm)
    shutil.copytree(SRC_DATA / "aip" / "realtime" / "al", dst / "aip" / "realtime" / "al")
    (dst / "aip" / "indikasi").mkdir()
    say("data root", dst)


# ---------------------------------------------------------------------------------------------------------- the hospitals
def rs() -> dict:
    import duckdb

    sys.path.insert(0, str(HERE))
    env_riil()
    import fitur_v4 as F4

    con = duckdb.connect()
    out = {}
    for kab, kep, jenis, tipe, kab_nama, prov_nama, n in con.execute(f"""
            SELECT kabkota_fkrtl_kode, kepemilikan_fkrtl, jenis_fkrtl, tipe_fkrtl, any_value(kabkota_fkrtl), any_value(provinsi_fkrtl),
                   count(*) FILTER (WHERE year(tgl_datang) = 2024)
            FROM read_parquet('{FKRTL.as_posix()}') WHERE edisi = 'reguler' AND kabkota_fkrtl_kode IS NOT NULL GROUP BY 1, 2, 3, 4""").fetchall():
        out[F4.profil(kab, kep, jenis, tipe)] = {"kab": int(kab), "kab_nama": kab_nama, "prov_nama": prov_nama, "n": int(n or 0),
                                                 "kepemilikan": kep, "jenis": jenis, "tipe": tipe if isinstance(tipe, str) and tipe else None}
    RIIL.mkdir(parents=True, exist_ok=True)
    (RIIL / "rs_riil.json").write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    say("rs", len(out), "profil")
    return out


# ---------------------------------------------------------------------------------------------------------- the run
def jalankan(nama: str) -> None:
    tanpa_jaringan()
    env_riil()
    data_root = RIIL / "data"
    assert (data_root / "aip" / "produksi" / "deployed.json").exists(), "jalankan dulu: uji_riil.py data"
    sys.path.insert(0, str(ROOT / "api")); sys.path.insert(0, str(HERE))
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    assert platform_lokal.DRIVE == DRIVE, platform_lokal.DRIVE
    platform_lokal.pasang()
    import duckdb
    import joblib
    from aip import layanan as L
    from aip.realtime import mesin as E
    import fitur as FT
    import fitur_v4 as F4

    assert F4.SILVER == FKRTL, F4.SILVER
    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        if E.ENGINE.error:
            raise RuntimeError(E.ENGINE.error)
        time.sleep(1)
    eng = E.ENGINE
    say("engine ready on the real silver")

    have = {r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{FKRTL.as_posix()}')").fetchall()}
    cols = [f for f in L.KlaimIn.model_fields if f in have]
    proksi = ["flag_selisih_verifikasi", "selisih_rp", "biaya_verifikasi_rp", "provinsi_fkrtl", "dx_primer_nama"]
    sel = cols + [c for c in proksi if c not in cols]
    con = duckdb.connect()
    rows = con.execute(f"""SELECT {', '.join(sel)} FROM read_parquet('{FKRTL.as_posix()}')
                           WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{W0}' AND DATE '{W1}'
                           ORDER BY tgl_datang, kunjungan_fkrtl_id""").fetchall()
    con.close()
    recs_in = [dict(zip(sel, r)) for r in rows]
    say("window", len(recs_in), "claims")

    def ke_klaim(b: dict):
        x = {k: v for k, v in b.items() if k in L.KlaimIn.model_fields}
        for k in SPECIALS:
            x[k] = int(x.get(k) or 0)
        x = {k: v for k, v in x.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        return L.KlaimIn.model_validate(x)

    objs, keep = [], []
    for b in recs_in:
        try:
            objs.append(ke_klaim(b)); keep.append(b)
        except Exception as e:  # noqa: BLE001
            say("skipped a claim:", str(e)[:160])
    t1 = time.time()
    sumber = f"riil:{nama}"
    for a in range(0, len(objs), 2000):
        eng.ingest(objs[a:a + 2000], sumber, None)
        while len(eng.q) > 3000:
            time.sleep(0.5)
    while True:
        with eng.store.lock:
            k = eng.store.con.execute("SELECT count(*) FROM peristiwa WHERE sumber = ?", (sumber,)).fetchone()[0]
        if k >= len(objs) and not len(eng.q):
            break
        if time.time() - t1 > 7200:
            raise TimeoutError(f"engine stored {k}/{len(objs)}")
        time.sleep(2)
    say(f"engine judged {k}/{len(objs)} in {time.time() - t1:.0f} s")
    eng.stop()
    fitur(nama, keep)


def fitur(nama: str, keep: list[dict] | None = None) -> None:
    """The features of the stored events (date order = the engine's order), joined to their silver rows by claim id."""
    tanpa_jaringan()
    env_riil()
    sys.path.insert(0, str(ROOT / "api")); sys.path.insert(0, str(HERE))
    import sqlite3

    import duckdb
    import joblib
    import fitur as FT
    import fitur_v4 as F4

    assert F4.SILVER == FKRTL, F4.SILVER
    data_root = RIIL / "data"
    if keep is None:
        from aip import layanan as L

        have = {r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{FKRTL.as_posix()}')").fetchall()}
        sel = [f for f in L.KlaimIn.model_fields if f in have]
        sel += [c for c in ("flag_selisih_verifikasi", "selisih_rp", "biaya_verifikasi_rp", "provinsi_fkrtl", "dx_primer_nama") if c not in sel]
        con = duckdb.connect()
        keep = [dict(zip(sel, r)) for r in con.execute(f"""SELECT {', '.join(sel)} FROM read_parquet('{FKRTL.as_posix()}')
                WHERE edisi = 'reguler' AND tgl_datang BETWEEN DATE '{W0}' AND DATE '{W1}'""").fetchall()]
        con.close()
    src = {str(b["kunjungan_fkrtl_id"]): b for b in keep}
    db = sqlite3.connect(f"file:{(data_root / 'aip' / 'realtime' / 'realtime.sqlite').as_posix()}?mode=ro", uri=True)
    recs = [json.loads(r) for r, in db.execute("SELECT rec FROM peristiwa WHERE sumber = ? AND keputusan NOT IN ('GAGAL', 'DIGANTIKAN') ORDER BY seq",
                                               (f"riil:{nama}",))]
    db.close()
    recs = [e for e in recs if str(e.get("kunjungan")) in src]
    bs = [src[str(e["kunjungan"])] for e in recs]
    say("stored events", len(recs))
    m = joblib.load(HERE / "model" / "model.joblib")
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    S = FT.sys_features(recs, ssl)
    st = FT.Stream(S, [FT.claim_fields(e) for e in recs], m["mu"], m["sd"])  # the batch in date order: each claim sees the earlier ones
    r1 = np.vstack([st.agg_row(i) for i in range(len(st))]).astype(np.float32)
    r2 = np.vstack([st.s2_row(i) for i in range(len(st))]).astype(np.float32)
    rr = np.vstack([st.r2_row(i) for i in range(len(st))]).astype(np.float32)
    say("stream features", r1.shape)
    f4 = F4.Fitur4(F4.referensi(), F4.domisili([e.get("peserta") for e in recs]))
    X4 = np.vstack([f4.tambah(e) for e in recs]).astype(np.float32)
    say("X4", X4.shape)
    keluar = RIIL / nama
    keluar.mkdir(parents=True, exist_ok=True)
    n = len(bs)
    np.savez_compressed(
        keluar / "hasil_00.npz", sk=np.array(["normal"] * n), y=np.zeros(n, np.int8), varian=np.array(["riil"] * n),
        X1=r1, X2=r2, XR=rr, X4=X4,
        keputusan=np.array([str(e.get("keputusan")) for e in recs]), skor_rule=np.array([float(e.get("skor") or 0) for e in recs]),
        sinyal=np.array([" ".join(sorted({str(s.get("kode")) for s in (e.get("sinyal") or [])})) for e in recs]),
        tingkat=np.array([str(b["tingkat_pelayanan"]) for b in bs]), kode=np.array([str(b["inacbg_kode"]) for b in bs]),
        los=np.array([int(b.get("los_hari") or 0) for b in bs]), biaya=np.array([int(b["biaya_tagih_rp"] or 0) for b in bs]),
        tarif=np.array([int(b.get("tarif_inacbg_rp") or 0) for b in bs]), dxs=np.array([int(b.get("jumlah_dx_sekunder") or 0) for b in bs]),
        topup=np.array([sum(int(b.get(s) or 0) for s in SPECIALS) for b in bs]), prosedur=np.array([b.get("prosedur") is not None for b in bs]),
        kelas=np.array([str(b.get("kelas_rawat")) for b in bs]), riwayat=np.zeros(n, bool),
        peserta=np.array([str(e.get("peserta")) for e in recs]), faskes=np.array([str(e.get("faskes")) for e in recs]),
        tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs]),
        dx=np.array([str(b.get("dx_primer_icd3") or "") for b in bs]), dx_nama=np.array([str(b.get("dx_primer_nama") or "") for b in bs]),
        # the verifiers' corrections: a weak proxy for the appendix only (0.07 % of the window), never a model input or a label
        proksi_selisih=np.array([bool(b.get("flag_selisih_verifikasi")) for b in bs]),
        selisih_rp=np.array([int(b.get("selisih_rp") or 0) for b in bs]),
        calon_ganda=np.array([bool(b.get("flag_calon_klaim_ganda")) for b in bs]))
    say(f"saved {n} claims -> {keluar / 'hasil_00.npz'}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("perintah", choices=["data", "jalankan", "fitur", "rs"])
    ap.add_argument("--set", default="riil_kc")
    a = ap.parse_args()
    {"data": data, "rs": rs, "jalankan": lambda: jalankan(a.set), "fitur": lambda: fitur(a.set)}[a.perintah]()
