"""The Blu 3.0 data package (the user, 2026-11-12: "bikin juga arsitektur multiagent baru buat AI agent swarm yg pake v3 ini …
Blu 3.0", "source data AI agent swarm pake synthetic data dulu aja, nanti … ganti ke data bpjs asli").

Input: .tmp/blu3_data (testing/uji100k.py with UJI100K_SET=B, UJI100K_FITUR=1, UJI100K_REKAM=1): synthetic FKRTL claims of
Sep–Nov 2024 moved into the replay window, judged by the realtime engine, about 4.6 % with planted fraud; per claim its
record and its feature rows. Every claim is scored by architecture v3 (testing/model_v3).

Output (testing/blu3/out), in the exact schema of the Nexus types they will back (testing/blu3/skema_cart.json), so the
swarm, the tag ledger and the quarantine box read them unchanged (testing/blu3_profil.py swaps the types' datasets):
  klaim_berisiko.parquet          Klaim Berisiko (BPJS): the claims v3 flags, the rules flag, or v3 gives >= 20 %
  skor_risiko_klaim_ml.parquet    Skor Risiko Klaim ML (BPJS): every claim, risiko = the v3 calibrated probability
  risiko_faskes_ml.parquet        Risiko Faskes ML (BPJS): per facility, the v3 expected fraud claims
  peserta_klaim_berisiko.parquet  Peserta Klaim Berisiko (BPJS): the members of the risky claims
  kebenaran.parquet               the planted fraud per claim: never a Nexus type, read only by the ground-truth check
  ringkasan_v3.json               the v3 scoring machine's summary for the run (Blu 3.0 phase 0)
Facility profiles, provinces, regencies and the INA-CBG peer table stay the baseline (the same facility ids: both come
from the same synthetic claims). No verifier data exists here: verified amounts are empty, so no claim reads as corrected.
Synthetic data only.

Usage: .venv/Scripts/python.exe testing/blu3_data.py"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

os.environ.setdefault("BLUESANDAI_AUTH", "off")
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(HERE))
import arsitektur_v2 as A  # noqa: E402

DIR = ROOT / ".tmp" / "blu3_data"
OUT = HERE / "blu3" / "out"
SKEMA = json.loads((HERE / "blu3" / "skema_cart.json").read_text("utf-8"))
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
NAMA_LAPISAN = {"model1": "Model 1 graph", "koding": "Spesialis coding", "tagihan": "Spesialis tagihan", "episode": "Spesialis episode",
                "identitas": "Spesialis identitas"}
FAMILI_MODUS = {f: d["modus"] for f, d in A.FAMILI.items()}
GANDA = {"KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP"}


def muat() -> tuple[pd.DataFrame, np.ndarray, np.ndarray, np.ndarray, dict]:
    rows, X1, X2, XR, truth = [], [], [], [], {}
    for f in sorted(DIR.glob("hasil_[0-9][0-9].npz")):
        c = f.stem[-2:]
        d = np.load(f)
        rek = [json.loads(x) for x in (DIR / f"rekam_{c}.jsonl").read_text("utf-8").splitlines() if x.strip()]
        if len(rek) != len(d["sk"]):
            raise SystemExit(f"chunk {c}: {len(rek)} records vs {len(d['sk'])} feature rows")
        rows += rek; X1.append(d["X1"]); X2.append(d["X2"]); XR.append(d["XR"])
        truth.update(json.loads((DIR / f"kebenaran_{c}.json").read_text("utf-8")))
    return pd.DataFrame(rows), np.vstack(X1), np.vstack(X2), np.vstack(XR), truth


def cast(df: pd.DataFrame, type_name: str) -> pd.DataFrame:
    """The columns of the type's dataset, in its order and with its property types."""
    t = SKEMA[type_name]
    kol = t.get("kolom") or {p["api"]: p["api"] for p in t["props"]}
    out = pd.DataFrame(index=df.index)
    for p in t["props"]:
        col = kol.get(p["api"], p["api"])
        v = df[p["api"]] if p["api"] in df else pd.Series([None] * len(df), index=df.index)
        ty = p["type"]
        if ty in ("integer", "long", "short"):
            v = pd.to_numeric(v, errors="coerce").round().astype("Int64")
        elif ty in ("double", "float", "decimal"):
            v = pd.to_numeric(v, errors="coerce").astype("float64")
        elif ty == "boolean":
            v = v.map(lambda x: None if x is None or (isinstance(x, float) and np.isnan(x)) else bool(x)).astype("boolean")
        elif ty in ("date", "timestamp"):
            v = pd.to_datetime(v, errors="coerce")
        else:
            v = v.map(lambda x: None if x is None or (isinstance(x, float) and np.isnan(x)) else str(x)).astype("string")
        out[col] = v
    return out.reset_index(drop=True)


def main() -> None:
    import joblib

    OUT.mkdir(parents=True, exist_ok=True)
    df, X1, X2, XR, truth = muat()
    b = joblib.load(HERE / "model_v3" / "model.joblib")
    s = A.skor(b, X1, X2, XR)
    n = len(df)
    print("claims", n, "planted fraud", sum(1 for v in truth.values() if v != "normal"))
    df["cal"], df["flag"], df["rute"], df["jar"] = s["cal"], s["flag"].astype(bool), s["rute"].astype(bool), s["jaringan_rule"].astype(bool)
    for k in b["urutan"]:
        df[f"p_{k}"] = s[k]
    # identities and places
    df["klaim_id"] = "reguler:" + df["kunjungan_fkrtl_id"].astype(str)
    df["edisi"] = "reguler"
    df["peserta_key"] = "reguler:" + df["peserta_id"].astype(str)
    df["peserta_id"] = df["peserta_id"].astype(str)
    df["kabkota_kode"] = pd.to_numeric(df["kabkota_fkrtl_kode"], errors="coerce")
    df["provinsi_kode"] = (df["kabkota_kode"] // 100)
    df["kabkota"], df["faskes_profil_id"] = df["kab"], df["faskes"]
    df["bulan"] = df["tgl_datang"].astype(str).str[:7]
    df["rawat_inap"] = df["tingkat_pelayanan"] == "RITL"
    for c in SPECIALS:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    df["topup_subakut_rp"] = df["sa_tarif_rp"]
    df["topup_khusus_rp"] = df[["sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp"]].sum(axis=1)
    df["sisa_di_luar_tarif_rp"] = (df["biaya_tagih_rp"] - df["tarif_inacbg_rp"] - df["topup_subakut_rp"] - df["topup_khusus_rp"]).clip(lower=0)
    kode_sin = df["sinyal"].map(lambda xs: {x["kode"] for x in xs})
    df["flag_calon_klaim_ganda"] = kode_sin.map(lambda k: bool(k & GANDA))
    df["flag_los_ekstrem"] = kode_sin.map(lambda k: "LOS_DIPERPANJANG" in k)
    df["readmisi_30"] = kode_sin.map(lambda k: bool(k & {"READMISI", "READMISI_DX_SAMA"}))
    df["flag_selisih_verifikasi"] = False
    df["jumlah_indikasi"] = df["sinyal"].map(len)
    df["skor_risiko"] = (100 * df["cal"]).round()
    df["tahun_tarif"] = 2024
    # the INA-CBG peer of the claim: the baseline peer table (same codes), the row with most claims per code and facility type
    ind = pd.read_parquet(ROOT / "data" / "drive" / SKEMA["Indikator INA-CBG (BPJS)"]["dataset_id"])
    ind = ind[ind["edisi"].astype(str) == "reguler"].sort_values("klaim", ascending=False).drop_duplicates(["inacbg_kode", "tipe_fkrtl"])
    peer = ind.set_index(["inacbg_kode", "tipe_fkrtl"])
    def ambil(col):
        return [peer[col].get((k, t)) if (k, t) in peer.index else None for k, t in zip(df["inacbg_kode"], df["tipe_fkrtl"])]
    df["indikator_id"], df["peer_klaim"], df["peer_biaya_p50_rp"] = ambil("indikator_id"), ambil("klaim"), ambil("biaya_tagih_p50_rp")
    df["peer_los_inap_p90"], df["regional_tarif"] = ambil("los_inap_p90"), ambil("regional_tarif")
    df["rasio_biaya_peer"] = [round(bt / p, 3) if p else None for bt, p in zip(df["biaya_tagih_rp"], pd.to_numeric(df["peer_biaya_p50_rp"], errors="coerce").fillna(0))]

    # why each claim: the strongest layer, the Permenkes family of the strongest specialist, the rule findings
    def alasan(r) -> tuple[str, str, list]:
        lap = [(k, float(r[f"p_{k}"])) for k in b["urutan"]]
        fam = max(((k, p) for k, p in lap if k in FAMILI_MODUS), key=lambda x: x[1])
        sin = [x["label"] for x in sorted(r["sinyal"], key=lambda x: -(x.get("s") or 0) * (x.get("w") or 0))][:3]
        if r["flag"] and fam[1] >= 0.5:
            utama = f"{A.FAMILI[fam[0]]['nama']} ({', '.join(FAMILI_MODUS[fam[0]])})"
        elif r["rute"]:
            utama = "Rule route: sinyal tanpa contoh berlabel"
        elif r["jar"] or any(x["kode"] in ("CINCIN_FASKES", "KARTU_BANYAK_FASKES") for x in r["sinyal"]):
            utama = "Jaringan faskes (M10)"
        elif sin:
            utama = sin[0]
        else:
            utama = "Pola tidak lazim menurut Model 1 graph"
        teks = f"v3 {r['cal'] * 100:.0f}% · {NAMA_LAPISAN.get(fam[0], fam[0])} {fam[1]:.2f}" + (f" · rule: {', '.join(sin)}" if sin else "")
        js = [{"fitur": k, "label": NAMA_LAPISAN.get(k, k), "nilai": round(p, 4)} for k, p in sorted(lap, key=lambda x: -x[1])]
        js += [{"fitur": "rute_rule", "label": "Rule route", "nilai": bool(r["rute"])}, {"fitur": "rule_jaringan", "label": "Network rule", "nilai": bool(r["jar"])}]
        return utama, teks, js

    al = df.apply(alasan, axis=1, result_type="expand")
    df["indikasi_utama"], df["alasan_risiko"], df["alasan_json"] = al[0], al[1], al[2].map(lambda x: json.dumps(x, ensure_ascii=False))
    df["alasan_utama"] = df["alasan_risiko"]

    berisiko = df["flag"] | df["keputusan"].isin(["PERIKSA", "TAHAN"]) | (df["cal"] >= 0.2)
    kb = cast(df[berisiko], "Klaim Berisiko (BPJS)")
    kb.to_parquet(OUT / "klaim_berisiko.parquet", index=False)

    # every claim's v3 score
    m = df.copy()
    m["judul"] = m["klaim_id"] + " · " + m["inacbg_kode"].astype(str)
    m["tingkat_pelayanan"], m["jenis_fkrtl"], m["biaya_tagih"], m["tarif_inacbg"], m["los"] = m["tingkat_pelayanan"], m["jenis_fkrtl"], m["biaya_tagih_rp"], m["tarif_inacbg_rp"], m["los_hari"]
    m["segmen_model"], m["risiko"], m["ditandai"], m["risiko_pct"] = "arsitektur_v3", m["cal"], m["flag"], (100 * m["cal"]).round(3)
    m["tingkat_risiko"] = np.where(m["flag"] | (m["cal"] >= 0.5), "tinggi", np.where(m["cal"] >= 0.1, "sedang", "rendah"))
    m["sudah_dikoreksi"] = False
    m["lolos_verifikasi_berisiko"] = m["flag"] & (m["keputusan"] == "LOLOS")
    m["peringkat_segmen"] = m["cal"].rank(ascending=False, method="first")
    m["nama_profil"] = "FKRTL · " + m["faskes_label"].astype(str)
    ml = cast(m, "Skor Risiko Klaim ML (BPJS)")
    ml.to_parquet(OUT / "skor_risiko_klaim_ml.parquet", index=False)

    # per facility: the expected fraud claims under v3
    g = m.groupby("faskes_profil_id").agg(nama_profil=("nama_profil", "first"), klaim=("klaim_id", "size"), ekspektasi_koreksi=("cal", "sum"),
                                          jenis_fkrtl=("jenis_fkrtl", "first"), tipe_fkrtl=("tipe_fkrtl", "first"), provinsi_kode=("provinsi_kode", "first"),
                                          klaim_ditandai=("flag", "sum"), berisiko_lolos_verifikasi=("lolos_verifikasi_berisiko", "sum"),
                                          provinsi=("provinsi", "first"), kabkota=("kabkota", "first")).reset_index()
    g["segmen_model"] = "arsitektur_v3"
    g["koreksi_aktual"] = None
    g["rasio_aktual_ekspektasi"] = None
    g["ekspektasi_koreksi"] = g["ekspektasi_koreksi"].round(2)
    g["risiko_per_1000_klaim"] = (1000 * g["ekspektasi_koreksi"] / g["klaim"]).round(3)
    g["peringkat"] = g["ekspektasi_koreksi"].rank(ascending=False, method="first")
    rf = cast(g, "Risiko Faskes ML (BPJS)")
    rf.to_parquet(OUT / "risiko_faskes_ml.parquet", index=False)

    # the members of the risky claims
    r = df[berisiko].copy()
    roman = {1: "KELAS I", 2: "KELAS II", 3: "KELAS III"}
    p = r.groupby("peserta_key").agg(peserta_id=("peserta_id", "first"), jk=("jk", "first"), tahun_lahir=("tahun_lahir", "first"), segmen=("segmen", "first"),
                                     hak_kelas=("hak_kelas", "first"), provinsi_tinggal=("provinsi", "first"), kabkota_tinggal_kode=("kabkota_kode", "first"),
                                     kabkota_tinggal=("kabkota", "first"), klaim_berisiko=("klaim_id", "size"), biaya_klaim_berisiko_rp=("biaya_tagih_rp", "sum"),
                                     skor_risiko_maks=("skor_risiko", "max")).reset_index()
    p["edisi"] = "reguler"
    p["jenis_kelamin"] = p["jk"].map(lambda x: {"L": "LAKI-LAKI", "P": "PEREMPUAN"}.get(str(x), x))
    p["usia_akhir_2024"] = 2024 - pd.to_numeric(p["tahun_lahir"], errors="coerce")
    p["kelas_rawat"] = pd.to_numeric(p["hak_kelas"], errors="coerce").map(roman)
    p["status_kepesertaan"], p["flag_tgl_lahir_pengganti"] = "AKTIF", False
    pk = cast(p, "Peserta Klaim Berisiko (BPJS)")
    pk.to_parquet(OUT / "peserta_klaim_berisiko.parquet", index=False)

    # the planted fraud: the ground-truth check only
    pd.DataFrame({"klaim_id": df["klaim_id"], "id": df["id"], "faskes_profil_id": df["faskes_profil_id"],
                  "skema": df["id"].map(lambda i: truth.get(i, "normal"))}).to_parquet(OUT / "kebenaran.parquet", index=False)

    # the v3 scoring machine's summary (Blu 3.0 phase 0): what the plan and every agent read first
    fam_rows = []
    for f, d in A.FAMILI.items():
        mk = df[f"p_{f}"] >= 0.5
        fam_rows.append({"famili": f, "nama": d["nama"], "modus": d["modus"], "klaim": int(mk.sum()), "ditandai": int((mk & df["flag"]).sum()),
                         "faskes": int(df.loc[mk, "faskes_profil_id"].nunique()), "biaya_rp": float(df.loc[mk, "biaya_tagih_rp"].sum())})
    top = g.sort_values("ekspektasi_koreksi", ascending=False).head(25)
    ring = {"klaim": int(df["jar"].sum()), "faskes": int(df.loc[df["jar"], "faskes_profil_id"].nunique())}
    # each family's work list for its agent: the claims its v3 specialist (or, for the network, the ring evidence) points at
    jar_mask = df["jar"] | df["sinyal"].map(lambda xs: any(x["kode"] in ("CINCIN_FASKES", "KARTU_BANYAK_FASKES") for x in xs))
    def daftar(mask, skor):
        sub = df[mask].assign(sk_famili=skor[mask]).sort_values(["sk_famili", "cal"], ascending=False).head(60)
        return [{"klaim_id": x.klaim_id, "faskes_profil_id": x.faskes_profil_id, "faskes": x.faskes_label, "provinsi": x.provinsi, "inacbg_kode": x.inacbg_kode,
                 "biaya_tagih_rp": float(x.biaya_tagih_rp), "tarif_inacbg_rp": float(x.tarif_inacbg_rp), "los_hari": int(x.los_hari or 0),
                 "risiko_v3": round(float(x.cal), 4), "skor_keluarga": round(float(x.sk_famili), 4),
                 "sinyal_rule": "; ".join(y["label"] for y in x.sinyal)[:200]} for x in sub.itertuples()]
    famili_teratas = {f: daftar(df[f"p_{f}"] >= 0.5, df[f"p_{f}"]) for f in A.FAMILI}
    famili_teratas["jaringan"] = daftar(jar_mask, df["cal"])
    ringkas = {"model": "arsitektur_v3", "klaim": n, "ditandai": int(df["flag"].sum()), "berisiko": int(berisiko.sum()),
               "faskes": int(df["faskes_profil_id"].nunique()), "provinsi": int(df["provinsi"].nunique()),
               "rute_rule": int(df["rute"].sum()), "rule_jaringan": ring, "famili": fam_rows, "famili_teratas": famili_teratas,
               "faskes_teratas": [{"faskes_profil_id": x.faskes_profil_id, "nama": x.nama_profil, "provinsi": x.provinsi, "klaim": int(x.klaim),
                                   "ditandai": int(x.klaim_ditandai), "ekspektasi": float(x.ekspektasi_koreksi)} for x in top.itertuples()],
               "provinsi_teratas": [{"provinsi": k, "ekspektasi": round(float(v), 2)} for k, v in m.groupby("provinsi")["cal"].sum().sort_values(ascending=False).head(10).items()],
               # every province (Blu 3.0: one regional analyst per province, its share of the v3 expected fraud)
               "provinsi_semua": [{"provinsi": k, "ekspektasi": round(float(r["cal"]), 2), "klaim": int(r["klaim_id"])}
                                  for k, r in m.groupby("provinsi").agg({"cal": "sum", "klaim_id": "count"}).sort_values("cal", ascending=False).iterrows()],
               "periode": [str(df["tgl_datang"].min())[:10], str(df["tgl_datang"].max())[:10]],
               "catatan": "Data sintetis: klaim FKRTL Sep–Nov 2024 dipindah ke 18–31 Des 2024, sebagian berisi planted fraud; skor = arsitektur v3."}
    (OUT / "ringkasan_v3.json").write_text(json.dumps(ringkas, ensure_ascii=False, indent=1), "utf-8")
    prof = pd.read_parquet(ROOT / "data" / "drive" / SKEMA["Profil Faskes (BPJS)"]["dataset_id"], columns=["faskes_profil_id"])
    cocok = df["faskes_profil_id"].isin(set(prof["faskes_profil_id"].astype(str))).mean()
    print({"klaim_berisiko": len(kb), "skor_ml": len(ml), "faskes_ml": len(rf), "peserta": len(pk), "ditandai_v3": ringkas["ditandai"],
           "faskes_ada_di_profil_baseline": round(float(cocok), 4)})


if __name__ == "__main__":
    main()
