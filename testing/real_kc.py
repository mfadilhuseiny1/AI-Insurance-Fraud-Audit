"""REAL BPJS claims of ONE demo branch area through the v4 feature pipeline, locally (the user, 2026-11-13: "run audit
arsitektur v4 di dataset real BPJS kantor cabang", "yg daerah satu kantor cabang aja", "1 KC, 2024 penuh").

Data: ai-jkn-audit/data/bpjs-sampel/silver/kunjungan_fkrtl, READ-ONLY (that repo is not changed). Bound by the pakta
integritas: nothing leaves this machine in this step (no model provider is called), and this script prints aggregates only
(no claim row, no validation message that could carry field values). Outputs stay under .tmp/real_<kc>/ on this machine.

The branch's claims are replayed in date order through the realtime engine with an EMPTY history (the synthetic events are
removed from the engine's copy), 2023 first as warm-up (history, not scored), then 2024 month by month; each claim gets the
same features the v4 model was trained on (X1 graph + neighbours, XR network, X4 mechanisms), computed causally. The files
mirror the generator runs (hasil_MM.npz, months 01-12), so testing/v5.py and the branch report read them unchanged; the
label slot carries the verifier's correction flag (a proxy, NOT fraud). Also saved: the national 2024 peer median bill per
(INA-CBG code, class, regional tariff, hospital type), for the overpayment estimate.

    .venv/Scripts/python.exe testing/real_kc.py --kc Medan"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
REAL = Path("D:/BluesandAI/ai-jkn-audit/data/bpjs-sampel/silver/kunjungan_fkrtl")
PESERTA_REAL = Path("D:/BluesandAI/ai-jkn-audit/data/bpjs-sampel/silver/peserta/**/*.parquet")  # real registry (domicile features)
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
T0 = time.time()


def say(*a) -> None:
    print(f"[{(time.time() - T0) / 60:5.1f} min]", *a, flush=True)


def area(nama: str) -> tuple[str, dict, list[int]]:
    import generator3 as G
    import laporan_cabang as LC

    P = LC.bagi_kc(G.dunia().rs)
    kid = next(k for k, v in P["kc"].items() if nama.lower() in v["nama"].lower())
    return kid, P["kc"][kid], sorted(int(kab) for kab, k in P["kab_kc"].items() if k == kid)


def muat_klaim(kabs: list[int], fields: list[str]) -> tuple[list[dict], dict]:
    import duckdb

    con = duckdb.connect()
    v = f"read_parquet('{REAL.as_posix()}/**/*.parquet', union_by_name=true)"
    kol = ", ".join(sorted(set(fields) | {"biaya_verifikasi_rp", "flag_selisih_verifikasi", "selisih_rp", "kabkota_fkrtl", "provinsi_fkrtl"}))
    df = con.execute(f"""SELECT {kol} FROM {v} WHERE kabkota_fkrtl_kode IN ({','.join(map(str, kabs))})
                         AND tgl_datang >= DATE '2023-01-01' AND tgl_datang <= DATE '2024-12-31' ORDER BY tgl_datang, kunjungan_fkrtl_id""").df()
    # national 2024 peer median of the bill (aggregates only) for the overpayment estimate
    peer = con.execute(f"""SELECT inacbg_kode, kelas_rawat, regional_tarif, tipe_fkrtl, median(biaya_tagih_rp) m, count(*) n FROM {v}
                           WHERE year(tgl_datang) = 2024 GROUP BY 1, 2, 3, 4""").fetchall()
    pm = {(a, b, c, d): (float(m), int(n)) for a, b, c, d, m, n in peer}
    return df.to_dict("records"), pm


def kosongkan_store(data_root: Path) -> None:
    db = data_root / "aip" / "realtime" / "realtime.sqlite"
    con = sqlite3.connect(db)
    for t in ("peristiwa", "kasus", "kebenaran", "keputusan", "tanda_terima", "label", "permintaan", "precheck"):
        con.execute(f'DELETE FROM "{t}"')
    con.execute("DELETE FROM sqlite_sequence")
    con.commit(); con.execute("VACUUM"); con.close()


def main(nama: str) -> None:
    os.environ["BLUESANDAI_AUTH"] = "off"
    sys.path.insert(0, str(ROOT / "api"))
    import joblib

    import fitur as FT
    import fitur_v4 as F4
    import uji100k as U
    from aip import layanan as L

    kid, kc, kabs = area(nama)
    kerja = ROOT / ".tmp" / f"real_{kid.replace('-', '_')}"
    kerja.mkdir(parents=True, exist_ok=True)
    say(f"{kc['nama']} ({kc['provinsi']}): {len(kabs)} kab/kota")
    fields = list(L.KlaimIn.model_fields)
    rows, pm = muat_klaim(kabs, fields)
    tahun = np.array([str(r["tgl_datang"])[:4] for r in rows])
    say(f"klaim real dimuat: {int((tahun == '2023').sum())} (2023, pemanasan) + {int((tahun == '2024').sum())} (2024)")

    data_root = kerja / "data"
    U.salin(data_root)
    kosongkan_store(data_root)
    from mailer import env
    from aip import vertex

    vertex.configure(data_root, env)
    import platform_lokal

    platform_lokal.pasang()
    from aip.realtime import mesin as E

    E.ENGINE.start(None)
    while not E.ENGINE.ready():
        time.sleep(1)
    eng = E.ENGINE
    say("engine siap (riwayat kosong)")
    m = joblib.load(HERE / "model" / "model.joblib")
    ssl = FT.load_ssl(data_root / "aip" / "realtime" / "al")
    st = FT.Stream(np.zeros((0, len(m["mu"])), np.float32), [], m["mu"], m["sd"])
    F4.PESERTA = PESERTA_REAL  # the members' domicile from the REAL registry (code norms stay the model's own reference)
    f4 = F4.Fitur4(F4.referensi(), F4.domisili([str(r.get("peserta_id")) for r in rows]))

    def ke_klaim(b: dict):
        x = {k: b.get(k) for k in fields}
        for k in SPECIALS:
            x[k] = int(x.get(k) or 0)
        x = {k: v for k, v in x.items() if not (v is None or (isinstance(v, float) and np.isnan(v))) or k in ("tipe_fkrtl", "prosedur")}
        return L.KlaimIn.model_validate(x)

    batches = [("2023", [r for r, t in zip(rows, tahun) if t == "2023"])] + \
              [(f"2024-{mm:02d}", [r for r in rows if str(r["tgl_datang"])[:7] == f"2024-{mm:02d}"]) for mm in range(1, 13)]
    total_skip = 0
    for label, bs_all in batches:
        objs, bs = [], []
        for b in bs_all:
            try:
                objs.append(ke_klaim(b)); bs.append(b)
            except Exception:  # noqa: BLE001 - counted only: the message could carry field values
                total_skip += 1
        ids = []
        for a in range(0, len(objs), 2000):
            ids += eng.ingest(objs[a:a + 2000], f"real:{label}", None)
            while len(eng.q) > 3000:
                time.sleep(0.5)
        briefs = eng.wait(ids, 7200)
        ok = [k for k, br in enumerate(briefs) if br and br.get("keputusan") not in ("GAGAL", "DIGANTIKAN")]
        recs = [eng.store.event(ids[k]) for k in ok]
        bs = [bs[k] for k in ok]
        S = FT.sys_features(recs, ssl) if recs else np.zeros((0, len(m["mu"])), np.float32)
        r1, r2, rr, x4 = [], [], [], []
        for x, e in zip(S, recs):
            i = st.append(x, FT.claim_fields(e))
            r1.append(st.agg_row(i)); r2.append(st.s2_row(i)); rr.append(st.r2_row(i)); x4.append(f4.tambah(e))
        if label == "2023" or not recs:
            say(f"{label}: {len(recs)} klaim masuk riwayat")
            continue
        flag = np.array([bool(b.get("flag_selisih_verifikasi")) for b in bs])
        peer = [pm.get((b.get("inacbg_kode"), b.get("kelas_rawat"), b.get("regional_tarif"), b.get("tipe_fkrtl")), (np.nan, 0)) for b in bs]
        np.savez_compressed(
            kerja / f"hasil_{label[5:]}.npz",
            sk=np.where(flag, "koreksi_verifikator", "normal"), y=flag.astype(np.int8), varian=np.full(len(bs), "real"),
            X1=np.vstack(r1).astype(np.float32), X2=np.vstack(r2).astype(np.float32), XR=np.vstack(rr).astype(np.float32), X4=np.vstack(x4).astype(np.float32),
            keputusan=np.array([str(e.get("keputusan")) for e in recs]), skor_rule=np.array([float(e.get("skor") or 0) for e in recs]),
            sinyal=np.array([" ".join(sorted({str(s.get("kode")) for s in (e.get("sinyal") or [])})) for e in recs]),
            tingkat=np.array([str(b.get("tingkat_pelayanan")) for b in bs]), kode=np.array([str(b.get("inacbg_kode")) for b in bs]),
            los=np.array([int(b.get("los_hari") or 0) for b in bs]), biaya=np.array([int(b.get("biaya_tagih_rp") or 0) for b in bs]),
            tarif=np.array([int(b.get("tarif_inacbg_rp") or 0) for b in bs]), dxs=np.array([int(b.get("jumlah_dx_sekunder") or 0) for b in bs]),
            topup=np.array([sum(int(b.get(s) or 0) for s in SPECIALS) for b in bs]), prosedur=np.array([b.get("prosedur") is not None for b in bs]),
            kelas=np.array([str(b.get("kelas_rawat")) for b in bs]), riwayat=np.zeros(len(bs), bool),
            peserta=np.array([str(e.get("peserta")) for e in recs]), faskes=np.array([str(e.get("faskes")) for e in recs]),
            tgl=np.array([str(e.get("tgl_datang"))[:10] for e in recs]),
            dx=np.array([str(b.get("dx_primer_icd3") or "") for b in bs]), dx_nama=np.array([str(b.get("dx_primer_nama") or "") for b in bs]),
            biaya_verifikasi=np.array([float(b.get("biaya_verifikasi_rp") or 0) for b in bs]), selisih=np.array([float(b.get("selisih_rp") or 0) for b in bs]),
            peer_median=np.array([p[0] for p in peer], dtype=float), peer_n=np.array([p[1] for p in peer]),
            tipe=np.array([str(b.get("tipe_fkrtl") or b.get("jenis_fkrtl") or "") for b in bs]), kab=np.array([int(b.get("kabkota_fkrtl_kode") or 0) for b in bs]),
            kab_nama=np.array([str(b.get("kabkota_fkrtl") or "") for b in bs]))
        say(f"{label}: {len(recs)} klaim dinilai, dikoreksi verifikator {int(flag.sum())}")
    (kerja / "meta.json").write_text(json.dumps({"kc": kid, "nama": kc["nama"], "provinsi": kc["provinsi"], "kabkota": kc["kabkota"],
                                                 "dibuat": time.strftime("%Y-%m-%d %H:%M"), "dilewati_validasi": total_skip}, ensure_ascii=False), "utf-8")
    say(f"selesai -> {kerja} (dilewati validasi: {total_skip})")
    eng.stop() if hasattr(eng, "stop") else None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kc", default="Medan")
    a = ap.parse_args()
    import varian_graf_dl as VG

    VG.LOCK_NAMA = "real-kc"
    with VG.kunci_berat():
        main(a.kc)
