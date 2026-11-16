"""Clinical themes of a synthetic dataset, with their claim counts, for the theme picker of a new branch audit (the user,
2026-11-14: "create new audit, bisa milih mau audit tema apa aja, bisa select satu atau multiple tema, atau select all").

A dataset folder under "Data Sintetis/" (testing/gen_tema.py: klaim/klaim_semua.parquet, ringkasan.json) holds every claim of
its patients (all themes, all hospitals); a branch audit reads the claims at the branch's hospitals (rs_di_kc). Each claim's
theme is laporan_cabang.tema_klaim (the ICD-10 chapter of the primary diagnosis, the INA-CBG CMG as fallback), the rule the
branch report itself uses, so a count here is what an audit restricted to that theme reads. No model is called.

Usage: .venv/Scripts/python.exe testing/tema_dataset.py [--dataset tema_jantung_kc_sul-7371]   (default: every dataset folder)
Output: data/aip/cabang/tema_<dataset>.json, read by web/src/app/api/swarm-cabang/proyek/route.ts (GET ?tema=1&proyek=<id>)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
import laporan_cabang as LC  # noqa: E402  the report's own theme rule and names, so the picker and the report agree

SINTETIS = Path(os.environ.get("DATA_SINTETIS_DIR") or ROOT / "Data Sintetis")
BASIS = Path(os.environ.get("CABANG_BASIS") or ROOT / "data" / "aip" / "cabang")
KOLOM = ["dx_primer_icd3", "inacbg_kode", "rs_di_kc", "biaya_tagih_rp", "tema", "replika"]


def tema_dataset(nama: str) -> dict:
    folder = SINTETIS / nama
    ring = json.loads((folder / "ringkasan.json").read_text("utf-8"))
    df = pd.read_parquet(folder / "klaim" / "klaim_semua.parquet", columns=KOLOM)
    di_kc = df[df["rs_di_kc"].astype(bool)].copy()
    dx = di_kc["dx_primer_icd3"].fillna("").astype(str)
    kode = di_kc["inacbg_kode"].fillna("").astype(str)
    # one rule call per distinct (diagnosis, INA-CBG group): ~700k claims, a few thousand pairs
    pasangan = {p: LC.tema_klaim(*p) for p in set(zip(dx, kode))}
    di_kc["t"] = [pasangan[p] for p in zip(dx, kode)]
    beda = int((di_kc["t"] != di_kc["tema"].fillna("")).sum())  # the generator wrote the same rule's theme; a gap means drift
    utama = str(ring.get("tema") or "")
    g = di_kc.groupby("t").agg(klaim=("t", "size"), tagihan_rp=("biaya_tagih_rp", "sum"))
    # the claims of each theme per replica (the audit form's data size: the last N replicas, as jalan_kc_tema.py --replika-terakhir)
    rid = sorted(int(x) for x in di_kc["replika"].unique())
    per = di_kc.groupby(["t", "replika"]).size()
    tema = [{"kode": k, "nama": LC.TEMA.get(k, k), "klaim": int(r.klaim), "tagihan_rp": int(r.tagihan_rp), "rekam_medis": k == utama,
             "per_replika": [int(per.get((k, x), 0)) for x in rid]}
            for k, r in g.sort_values("klaim", ascending=False).iterrows()]
    replika = int(ring.get("replika") or di_kc["replika"].nunique())
    nama_utama = LC.TEMA.get(utama, utama)
    return {
        "dataset": nama, "dibuat": time.strftime("%Y-%m-%d %H:%M"), "kc": ring.get("kc"), "kc_nama": ring.get("kc_nama"),
        "tema_utama": utama or None, "tema_utama_nama": nama_utama or None, "replika": replika, "replika_ids": rid,
        "klaim": int(len(di_kc)), "tagihan_rp": int(di_kc["biaya_tagih_rp"].sum()), "di_luar_kc": int(len(df) - len(di_kc)),
        "sumber": "klaim/klaim_semua.parquet, klaim di RS wilayah KC (rs_di_kc)",
        "catatan": (f"Dataset ini dibangun untuk tema {nama_utama.lower()}: tema lain hanya berisi klaim lain dari pasien yang sama, "
                    f"bukan seluruh klaim KC. Rekam medis hanya ada untuk klaim tema {nama_utama.lower()}. "
                    f"Jumlah klaim = gabungan {replika} ulangan setahun.") if utama else None,
        "cek_kolom_tema": {"beda": beda},
        "tema": tema,
    }


def tulis(nama: str) -> Path:
    out = BASIS / f"tema_{nama}.json"
    BASIS.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(f".json.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(tema_dataset(nama), ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, out)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="", help='a folder under "Data Sintetis/" (default: every folder with klaim/klaim_semua.parquet)')
    a = ap.parse_args()
    semua = [a.dataset] if a.dataset else sorted(p.name for p in SINTETIS.iterdir() if (p / "klaim" / "klaim_semua.parquet").exists())
    if not semua:
        sys.exit(f"tidak ada dataset di {SINTETIS}")
    for nama in semua:
        if not (SINTETIS / nama / "klaim" / "klaim_semua.parquet").exists():
            sys.exit(f"dataset tidak dikenal: {nama}")
        out = tulis(nama)
        d = json.loads(out.read_text("utf-8"))
        print(f"{nama}: {d['klaim']:,} klaim di KC {d['kc']} dalam {len(d['tema'])} tema (beda dengan kolom tema: {d['cek_kolom_tema']['beda']}) -> {out}")
        for t in d["tema"][:6]:
            print(f"  {t['kode']:>2} {t['nama']:<45} {t['klaim']:>8,}")


if __name__ == "__main__":
    main()
