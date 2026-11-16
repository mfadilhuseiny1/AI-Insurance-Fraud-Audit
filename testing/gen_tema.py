"""Synthetic claims of ONE clinical theme in ONE branch office, as independent one-year replicas (the user, 2026-11-14:
"buat data sintetik 100.000 row klaim khusus tema jantung, satu KC (KC Makassar)"; design chosen by the user: "ulangan
setahun" = about 40 independent replicas of one year of the branch's cardiology claims, each at a realistic per-hospital
density, instead of 100,000 claims squeezed into one window).

Built on generator 3 (testing/generator3.py), unchanged except its window (GEN3_W1): the world it learned from the 2024
silver claims, its member journeys and its 22 fraud schemes (+ the quality deviation). Per replica:
  population  members alive at the window start whose 2024 history has a claim of the theme at a hospital of the branch,
              each with their own journey over the window (natural count); then new members living in the branch, each replaying one of the branch's 2024
              patients of the theme (sex and age band matched): their claims at the branch on the same hospital profiles, care
              levels, diagnoses, INA-CBG groups and day gaps, from a random start, every episode derived by generator 3
              (severity, stay, secondary diagnoses, procedures, tariff, top-ups), until the replica holds the branch's real
              yearly volume of the theme (the 2024 silver claims, scaled to the window). Generator 3's journey model, learned
              nationally, made the follow-ups mostly outpatient controls (61% Q-5-44 vs the branch's 15%). Generator 3's world holds about 13% of the sample's members (174 with a cardiology
              claim at KC Makassar), so most of a replica's patients are new claimants;
              reserve members of the branch for the identity schemes; members already in the /testing stream are left out
              (as testing/uji_gen2.py does), so a later run of the audit pipeline stays honest
  fraud       generator 3's schemes as they are; the dishonest hospitals are fixed by the world seed (GEN3_GARAM), so every
              replica has the same ones; only the replica's randomness differs
  output      every claim of the population (all themes: the stream a later audit run would see), with the theme, whether
              the hospital is in the branch, and the replica; the labels (scheme, variant) in a separate key file
Replicas are added until the theme's claims at branch hospitals reach the target. Each claim validates as KlaimIn (the API's
claim model). Synthetic data only.

Usage: .venv/Scripts/python.exe testing/gen_tema.py [--kc sul-7371] [--tema I] [--target 100000] [--proses 4]
Output: "Data Sintetis/tema_<tema>_kc_<kc>/" (klaim/, kunci/, ringkasan.json); README written by testing/rekam_medis.py."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from datetime import timedelta
from pathlib import Path

os.environ.setdefault("GEN3_W1", "2025-12-17")  # one year from the window start (18 Dec 2024)
os.environ.setdefault("GEN3_GARAM", "gen3-tema-jantung")  # the world: which hospitals are dishonest (fixed for every replica)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import generator3 as G  # noqa: E402

TEMA_NAMA = {"I": "jantung"}
MAKS_KLAIM_ANGGOTA = 36  # claims per member in a year (generator 3 caps a 14-day window at 12)
SRC_RT = ROOT / ".tmp" / "testing-data" / "aip" / "realtime" / "realtime.sqlite"
SNAPSHOT = ("kode", "dx", "dxk", "dxs", "sev", "prosedur", "kelas", "los", "p", "tk", "topup", "status", "f", "d", "masuk", "tarif", "bill")


def berubah(o: dict | None, e: dict) -> dict:
    """The fields a scheme changed, with their value before it (empty for an untouched or a scheme-added episode)."""
    if not o:
        return {}
    return {k: v for k, v in o.items() if (dict(e[k]) if isinstance(e.get(k), dict) else e.get(k)) != v}


def tema_klaim(icd: str, kode: str) -> str:
    import laporan_cabang as LC  # the report's own theme rule, so the data and the audit report agree

    return LC.tema_klaim(icd, kode)


def anggota_stream() -> set[int]:
    """Members already in the /testing stream (testing/uji_gen2.py leaves them out of a generated batch)."""
    con = sqlite3.connect(f"file:{SRC_RT}?mode=ro", uri=True)
    try:
        out = set()
        for (p,) in con.execute("SELECT DISTINCT json_extract(rec, '$.peserta') FROM peristiwa WHERE json_extract(rec, '$.jenis') = 'fkrtl'"):
            if p is not None and str(p).isdigit():
                out.add(int(p))
        return out
    finally:
        con.close()


def siapkan(kc: str, tema: str) -> dict:
    """The branch's hospitals and the eligible members (computed once, shared by the replicas)."""
    import laporan_cabang as LC

    D = G.dunia()
    P = LC.bagi_kc(D.rs)
    kabs = {k for k, v in P["kab_kc"].items() if v == kc}
    rs_kc = {f for f, r in D.rs.items() if r["kab"] in kabs}
    kecuali = anggota_stream()
    a = D.anggota
    hidup = a.thn_mati.isna() & ~a.mati_hist
    calon = a[hidup & (a.n_hist > 0) & ~a.pid.isin(kecuali)]
    pilih, cad_h = [], []
    for pid in calon.pid.values:
        g = D.riwayat.get(int(pid))
        if g is None or not len(g):
            continue
        rows = g[["f", "dx", "kode"]].to_numpy()
        di_kc = [r for r in rows if r[0] in rs_kc]
        if not di_kc:
            continue
        if any(tema_klaim(str(r[1] or ""), str(r[2] or "")) == tema for r in di_kc):
            pilih.append(int(pid))
        else:
            cad_h.append(int(pid))
    baru = a[hidup & (a.n_hist == 0) & ~a.pid.isin(kecuali) & a.kab.isin(list(kabs))]
    mati = a[~hidup & a.kab.isin(list(kabs))]
    rs_l = sorted(rs_kc)
    w = np.array([float(D.rs[f].get("n") or 1) for f in rs_l])
    return {"silver": volume_silver(sorted(int(k) for k in kabs), tema, kecuali | set(pilih)), "rs_kc_set": rs_kc, "rs_curang": rs_curang_kc(D, rs_kc), "rs_kc_w": (w / w.sum()).tolist(),
            "kc": kc, "kc_nama": P["kc"][kc]["nama"], "kabs": sorted(int(k) for k in kabs), "rs_kc": rs_l, "pilih": pilih,
            "cad_h": cad_h, "baru": baru.pid.astype(int).tolist(), "mati": mati.pid.astype(int).tolist(), "kecuali": len(kecuali)}


def volume_silver(kabs: list[int], tema: str, kecuali: set[int]) -> dict:
    """The branch's 2024 silver claims (the synthetic sample): the yearly volume of the theme, and per patient with a theme
    claim at the branch the sequence of their claims at the branch (any theme): day from their first claim, care level,
    primary diagnosis, INA-CBG group, hospital profile; with the patient's sex and age band from the registry."""
    import laporan_cabang as LC

    D = G.dunia()
    df = G._con().execute(f"""SELECT peserta_id, f, dx_primer_icd3, inacbg_kode, tingkat_pelayanan, tgl_datang FROM s
                              WHERE CAST(kabkota_fkrtl_kode AS INT) IN ({",".join(str(int(k)) for k in kabs)})""").df()
    df["tema"] = [LC.tema_klaim(str(d or ""), str(k or "")) for d, k in zip(df.dx_primer_icd3, df.inacbg_kode)]
    hari = max(1, (df.tgl_datang.max() - df.tgl_datang.min()).days + 1)
    n_tema = int((df.tema == tema).sum())
    pasien = set(df.loc[df.tema == tema, "peserta_id"].dropna().astype(int)) - kecuali
    reg = D.anggota.set_index("pid")
    templat = []
    for pid, g in df[df.peserta_id.isin(list(pasien))].sort_values(["peserta_id", "tgl_datang"]).groupby("peserta_id"):
        d0 = g.tgl_datang.iloc[0]
        langkah = [[int((d - d0).days), tk, dx, str(k).rsplit("-", 1)[0], f] for d, tk, dx, k, f in
                   zip(g.tgl_datang, g.tingkat_pelayanan, g.dx_primer_icd3, g.inacbg_kode, g.f) if f in D.rs and dx]
        if not langkah:
            continue
        r = reg.loc[int(pid)] if int(pid) in reg.index else None
        templat.append({"jk": (r.jk or "") if r is not None else "", "ab": G._ab(r.usia) if r is not None else 2, "langkah": langkah})
    return {"per_tahun": round(n_tema * 365 / hari), "klaim_2024": n_tema, "hari": int(hari), "pasien_tema": len(templat),
            "p_ritl": float((df[df.tema == tema].tingkat_pelayanan == "RITL").mean()), "templat": templat}


def ulang_templat(D, m: dict, rng, T: dict) -> list[dict]:
    """A 2024 patient's sequence at the branch replayed for a new member of the same sex and age band: each claim at the same
    hospital profile, care level, diagnosis and INA-CBG group, on the same day gaps from a random start in the window; the
    episode itself (severity, stay, secondary diagnoses, procedures, tariff, top-ups) derived by generator 3. A stay that runs
    past the next claim's day pushes the rest of the sequence on (no overlapping stays)."""
    span = T["langkah"][-1][0]
    mulai = G.W0 + timedelta(days=int(rng.integers(0, max(1, G.NDAY - span))))
    eps: list[dict] = []
    geser = 0
    for hari, tk, dx, basis, f in T["langkah"]:
        d = mulai + timedelta(days=hari + geser)
        if eps and eps[-1]["tk"] == "RITL" and d < eps[-1]["p"]:
            geser += (eps[-1]["p"] - d).days
            d = eps[-1]["p"]
        if d > G.W1:
            break
        prev = eps[-1] if eps else None
        e = G.episode(D, m, f, tk, d, rng, dx=dx, basis=basis, prev=prev) or G.episode(D, m, f, tk, d, rng, dx=dx, prev=prev)
        if e is None:
            continue
        e["_pg"] = (d - prev["p"]).days if prev else None
        eps.append(e)
        if e["status"] == "Meninggal":
            break
    return eps


# hospital-level schemes absent from the branch in generator 3's world (its dishonest hospitals are drawn nationally, 2-4 per
# scheme, among large hospitals): the scenario gives the branch one dishonest hospital per scheme (a pair / a group for the
# network schemes), mid-volume general hospitals of the branch, the two largest left honest
SKEMA_RS_KC = ("klaim_fiktif", "kloning", "geser_bertahap", "pulang_dini", "sesi_rutin_fiktif", "rujukan_semu", "dokter_tiga_rs")


def rs_curang_kc(D, rs_kc: set) -> dict:
    urut = sorted((f for f in rs_kc if D.rs[f]["jenis"] == "Rumah sakit" and not str(D.rs[f]["tipe"] or "").startswith("Khusus")),
                  key=lambda f: -float(D.rs[f]["n"] or 0))[2:]
    pakai: list[str] = []

    def ambil(syarat=lambda f: True) -> str | None:
        f = next((x for x in urut if x not in pakai and syarat(x)), None)
        if f:
            pakai.append(f)
        return f

    out = {sk: [ambil()] for sk in ("klaim_fiktif", "kloning", "geser_bertahap", "pulang_dini")}
    rutin = sorted((f for f in rs_kc if f in D.rutin_pool and f not in pakai and D.rs[f]["jenis"] == "Rumah sakit"), key=lambda f: -D.rutin_pool[f])
    out["sesi_rutin_fiktif"] = rutin[:1]
    pakai += rutin[:1]
    a = ambil(lambda f: any(g != f and g not in pakai and D.rs[g]["kab"] == D.rs[f]["kab"] for g in urut))
    b = ambil(lambda f: D.rs[f]["kab"] == D.rs[a]["kab"]) if a else None
    out["rujukan_semu"] = [(a, b)] if a and b else []
    g3 = [ambil() for _ in range(3)]
    if all(g3):
        pa = D.M["rs_poli"].get(g3[0])
        polis = list(pa.v) if pa else []
        out["dokter_tiga_rs"] = [(g3[0], g3[1], g3[2], "JAN" if "JAN" in polis else next((p for p in polis if p not in (None, "IGD", "HDL", "IRM", "GIG", "KON", "BDM", "RDT", "KEM")), "INT"))]
    else:
        out["dokter_tiga_rs"] = []
    return {k: [x for x in v if x] for k, v in out.items()}


def replika(r: int, S: dict, tema: str) -> tuple[list[dict], dict]:
    """One replica: a year of the theme's population in the branch, generator 3's fraud applied, claims in arrival order."""
    from aip import layanan as L

    D = G.dunia()
    D.rs_skema.update({k: [tuple(x) if isinstance(x, list) else x for x in v] for k, v in S["rs_curang"].items()})
    rng = np.random.default_rng(G._h(f"{G.GARAM}|tema|{tema}|{S['kc']}|replika|{r}"))
    rs_kc = set(S["rs_kc"])
    a = D.anggota.set_index("pid", drop=False)
    eps: list[dict] = []
    members: dict[int, dict] = {}
    n_tema_h = 0
    for pid in S["pilih"]:
        m = G._anggota(D, a.loc[pid])
        e = G.jalani(D, m, rng, maks=MAKS_KLAIM_ANGGOTA)
        if not e:
            continue
        m["sumber"] = "perjalanan"
        members[pid] = m
        eps += e
        n_tema_h += sum(1 for x in e if x["f"] in rs_kc and tema_klaim(x["dx"], x["kode"]) == tema)
    # new members replaying the branch's 2024 patients of the theme (sex and age band matched), until the real yearly volume
    target = int(round(S["silver"]["per_tahun"] * G.NDAY / 365))
    n_tema_b = 0
    calon: dict[tuple, list[int]] = {}
    for pid in S["baru"]:
        r_ = a.loc[pid]
        calon.setdefault(((r_.jk or ""), G._ab(r_.usia)), []).append(pid)
    for v in calon.values():
        rng.shuffle(v)
    semua = [p for v in calon.values() for p in v]
    TT = S["silver"]["templat"]
    dipakai: set[int] = set()
    while n_tema_h + n_tema_b < target:
        T = TT[int(rng.integers(0, len(TT)))]
        pool = calon.get((T["jk"], T["ab"])) or semua
        while pool and pool[-1] in dipakai:
            pool.pop()
        if not pool:
            pool = [p for p in semua if p not in dipakai]
            if not pool:
                break
        pid = pool.pop()
        dipakai.add(pid)
        m = G._anggota(D, a.loc[pid])
        e = ulang_templat(D, m, rng, T)
        if not e:
            continue
        m["sumber"] = "baru"
        members[pid] = m
        eps += e
        n_tema_b += sum(1 for x in e if x["f"] in rs_kc and tema_klaim(x["dx"], x["kode"]) == tema)
    sisa = [p for p in semua if p not in dipakai]
    cad_b = [a.loc[p] for p in sisa[:3000]]
    cad_h_ids = [p for p in S["cad_h"]]
    rng.shuffle(cad_h_ids)
    cad_h = [G._anggota(D, a.loc[p]) for p in cad_h_ids[:3000]]
    pop = {"eps": eps, "members": members, "cad_h": cad_h, "cad_b": cad_b, "mati": [a.loc[p] for p in S["mati"][:2000]]}
    C = G.Ctx(D, pop, rng)
    # what each episode was before the fraud schemes touched it (the truth the medical record keeps): schemes change an
    # episode in place (it keeps its _seq) or add a new one (a new _seq, no snapshot)
    asli = {e["_seq"]: {k: (dict(e[k]) if isinstance(e.get(k), dict) else e.get(k)) for k in SNAPSHOT} for e in C.eps}
    for fn in G.URUTAN:
        fn(C)
    eps = [e for e in C.eps if e.get("pid") is not None]
    eps.sort(key=lambda e: (e["d"], e["_menit"], e["_seq"]))
    dup = Counter((e["pid"], e["d"], e["kode"]) for e in eps)
    ids = [f"SYNJ{r:02d}" + "".join(x) for x in G._ALFA[rng.integers(0, 36, size=(len(eps), 10))]]
    out = []
    salah = 0
    for i, (e, kid) in enumerate(zip(eps, ids)):
        k = G._klaim(D, e, kid)
        k["flag_calon_klaim_ganda"] = dup[(e["pid"], e["d"], e["kode"])] > 1
        m = C.members[e["pid"]]
        try:
            L.KlaimIn.model_validate({x: v for x, v in k.items() if x in L.KlaimIn.model_fields})
        except Exception:  # noqa: BLE001
            salah += 1
            continue
        k.update({"replika": r, "urut": i, "tema": tema_klaim(e["dx"], e["kode"]), "rs_di_kc": e["f"] in rs_kc, "faskes_profil": e["f"],
                  "_sk": e["_sk"], "_varian": e["_varian"], "_sumber_peserta": m.get("sumber", "perjalanan"), "_jk": m["jk"],
                  "_usia": None if m["usia"] is None else round(float(m["usia"]), 1), "_hak_kelas": m["hak"],
                  "_asli": json.dumps(berubah(asli.get(e["_seq"]), e), default=str, ensure_ascii=False), "_baru": e["_seq"] not in asli})
        out.append(k)
    n_t = sum(1 for k in out if k["rs_di_kc"] and k["tema"] == tema)
    return out, {"replika": r, "klaim": len(out), "klaim_tema_di_kc": n_t, "anggota": len(C.members), "tidak_valid": salah,
                 "tema_dari_riwayat": n_tema_h, "tema_dari_baru": n_tema_b, "target": target,
                 "fraud_tema_di_kc": sum(1 for k in out if k["rs_di_kc"] and k["tema"] == tema and G.adalah_fraud(k["_sk"]))}


def _kerja(arg: tuple) -> tuple[int, str, dict]:
    r, S, tema, folder = arg
    t = time.time()
    klaim, info = replika(r, S, tema)
    f = Path(folder) / "klaim" / f"replika_{r:02d}.parquet"
    pd.DataFrame(klaim).to_parquet(f, index=False)
    info["detik"] = round(time.time() - t, 1)
    return r, str(f), info


def main(kc: str, tema: str, target: int, proses: int, n_replika: int = 0) -> None:
    t0 = time.time()
    folder = ROOT / "Data Sintetis" / f"tema_{TEMA_NAMA.get(tema, tema)}_kc_{kc}"
    (folder / "klaim").mkdir(parents=True, exist_ok=True)
    (folder / "kunci").mkdir(parents=True, exist_ok=True)
    S = siapkan(kc, tema)
    print(f"{S['kc_nama']}: {len(S['rs_kc'])} hospital profiles, {len(S['pilih'])} members with {tema} history at the branch, "
          f"{len(S['baru'])} new-claimant candidates, {S['kecuali']} stream members left out ({time.time() - t0:.0f} s)", flush=True)
    for f in (folder / "klaim").glob("replika_*.parquet"):
        f.unlink()
    info, total, r = [], 0, 0
    from concurrent.futures import ProcessPoolExecutor

    with ProcessPoolExecutor(max_workers=proses) as ex:
        while (r < n_replika) if n_replika else (total < target):
            batch = list(range(r, min(r + proses, n_replika) if n_replika else r + proses))
            for rr, f, inf in ex.map(_kerja, [(x, S, tema, str(folder)) for x in batch]):
                info.append(inf)
                total += inf["klaim_tema_di_kc"]
                print(f"replica {rr:02d}: {inf['klaim']} claims, {inf['klaim_tema_di_kc']} theme claims at the branch, "
                      f"{inf['fraud_tema_di_kc']} planted fraud, {inf['tidak_valid']} invalid, {inf['detik']} s (total {total:,})", flush=True)
            r += len(batch)
    info.sort(key=lambda x: x["replika"])
    ringkas = {"dibuat": time.strftime("%Y-%m-%d %H:%M"), "kc": kc, "kc_nama": S["kc_nama"], "tema": tema, "tema_nama": TEMA_NAMA.get(tema, tema),
               "jendela": [G.W0.isoformat(), G.W1.isoformat()], "garam_dunia": G.GARAM, "rs_curang_kc": S["rs_curang"], "replika": len(info), "anggota_tema": len(S["pilih"]),
               "rs_profil_kc": len(S["rs_kc"]), "klaim_tema_di_kc": total, "klaim_semua": sum(x["klaim"] for x in info), "per_replika": info,
               "detik": round(time.time() - t0)}
    (folder / "ringkasan_klaim.json").write_text(json.dumps(ringkas, ensure_ascii=False, indent=1), "utf-8")
    print(f"{len(info)} replicas -> {folder}; theme claims at the branch {total:,}; all claims {ringkas['klaim_semua']:,}; {time.time() - t0:.0f} s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kc", default="sul-7371")
    ap.add_argument("--tema", default="I")
    ap.add_argument("--target", type=int, default=100000)
    ap.add_argument("--proses", type=int, default=4)
    ap.add_argument("--replika", type=int, default=0, help="exactly this many replicas (default: until --target)")
    ap.add_argument("--coba", action="store_true", help="one replica only, printed, nothing written")
    a = ap.parse_args()
    if a.coba:
        t = time.time()
        S = siapkan(a.kc, a.tema)
        print(f"{S['kc_nama']}: {len(S['rs_kc'])} hospital profiles, {len(S['pilih'])} members, {len(S['baru'])} new candidates ({time.time() - t:.0f} s)")
        k, inf = replika(0, S, a.tema)
        print(inf, f"{time.time() - t:.0f} s")
        df = pd.DataFrame(k)
        sub = df[df.rs_di_kc & (df.tema == a.tema)]
        print("theme at branch:", len(sub), "· RITL share", round((sub.tingkat_pelayanan == "RITL").mean(), 3), "· bill Rp", f"{sub.biaya_tagih_rp.sum():,}")
        print("schemes:", Counter(sub._sk).most_common(12))
        print("codes:", Counter(sub.inacbg_kode).most_common(10))
        print("procedures non-empty:", round(sub.prosedur.notna().mean(), 3), sub.prosedur.dropna().head(3).tolist())
    else:
        main(a.kc, a.tema, a.target, a.proses, a.replika)
