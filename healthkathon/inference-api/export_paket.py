"""Export the deployed fraud-model package of the platform for this service (paket/): model.pkl (the pickle), the
ONNX twins, signature.json, the feature store, and a few real claims to try (paket/contoh_klaim_nyata.json). The
package comes from the production pipeline's last deployed run (POST /api/aip/produksi/jalankan on the platform), whose
gates already checked the data contract, drift, the ONNX parity and the training-serving parity.

    python export_paket.py                  # from ../../data (this repository's platform data)
    python export_paket.py --data D:/data   # elsewhere
    python export_paket.py --tanpa-peserta  # without the members' visit history (smaller; history features then empty)
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "api"))
CLAIM_FIELDS = ["kunjungan_fkrtl_id", "edisi", "peserta_id", "tgl_datang", "tgl_pulang", "kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl",
                "tingkat_pelayanan", "poli", "segmen", "kelas_rawat", "status_pulang", "dx_primer_icd3", "inacbg_kode", "inacbg_cmg", "inacbg_tipe_kasus",
                "inacbg_keparahan", "regional_tarif", "prosedur", "tarif_inacbg_rp", "sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp",
                "biaya_tagih_rp", "los_hari", "jumlah_dx_sekunder", "flag_calon_klaim_ganda", "flag_los_ekstrem", "layanan_covid", "dx_masuk_kode",
                "dx_masuk_nama", "dx_primer_kode", "dx_primer_nama", "inacbg_deskripsi", "sa_kode", "sp_kode", "sp_deskripsi", "rr_kode", "rr_deskripsi",
                "si_kode", "si_deskripsi", "sd_kode", "sd_deskripsi", "kabkota_fkrtl", "provinsi_fkrtl"]


def examples(data: Path, out: Path) -> int:
    """A few real claims in the claims contract: the model's riskiest uncorrected hospital claims, a corrected one, an
    ordinary one (by the deployed model's own scores)."""
    import duckdb

    cur = json.loads((data / "aip" / "ml" / "current.json").read_text("utf-8"))
    scores = data / "aip" / "ml" / "versions" / cur["version"] / "klaim.parquet"
    silver = data / "drive" / cur["source_item"]
    if not scores.is_file() or not silver.is_file():
        return 0
    con = duckdb.connect()
    pick = con.execute(f"""
        (SELECT klaim_id, 'berisiko tinggi, lolos verifikasi' AS jenis FROM read_parquet('{scores.as_posix()}')
         WHERE lolos_verifikasi_berisiko AND segmen_model = 'rumah_sakit' ORDER BY risiko DESC LIMIT 2)
        UNION ALL (SELECT klaim_id, 'dikoreksi verifikator' FROM read_parquet('{scores.as_posix()}') WHERE sudah_dikoreksi AND segmen_model = 'rumah_sakit'
                   ORDER BY risiko DESC LIMIT 1)
        UNION ALL (SELECT klaim_id, 'biasa (risiko rendah)' FROM read_parquet('{scores.as_posix()}') WHERE NOT ditandai AND segmen_model = 'rumah_sakit'
                   ORDER BY risiko ASC LIMIT 1)""").fetchall()
    rows = []
    for kid, kind in pick:
        edisi, _, vid = kid.partition(":")
        df = con.execute(f"SELECT {', '.join(CLAIM_FIELDS)} FROM read_parquet('{silver.as_posix()}') WHERE edisi = ? AND kunjungan_fkrtl_id = ?", [edisi, vid]).df()
        if df.empty:
            continue
        rec = {k: (None if v is None or (isinstance(v, float) and v != v) else (v.item() if hasattr(v, "item") else v)) for k, v in df.iloc[0].to_dict().items()}
        rec = {k: (str(v) if k.startswith("tgl_") and v is not None else v) for k, v in rec.items() if v is not None}
        rows.append({"jenis": kind, "klaim": rec})
    (out / "contoh_klaim_nyata.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1, default=str), "utf-8")
    # the examples are claims of the data: their members' history is rebuilt without them, so they arrive as new claims
    # (as the pipeline's training-serving parity check does), not counted twice in their own history
    dep = json.loads((data / "aip" / "produksi" / "deployed.json").read_text("utf-8"))
    import ml_klaim as M  # (api/ on the path: main.py's package)

    cache = data / "aip" / "ml" / "cache" / f"fitur-{dep.get('sumber')}-v{M.FEATURES_VERSION}.parquet"
    if rows and cache.is_file() and (out / "toko_fitur" / "peserta.parquet").is_file():
        ids = [f"{r['klaim']['edisi']}:{r['klaim']['kunjungan_fkrtl_id']}" for r in rows]
        tmp = out / "toko_fitur" / "peserta.tmp.parquet"
        con.execute(f"""COPY (SELECT edisi, peserta_id, faskes_profil_id, tgl_datang, inacbg_kode, count(*) AS n FROM read_parquet('{cache.as_posix()}')
                        WHERE klaim_id NOT IN (SELECT unnest(?::VARCHAR[])) GROUP BY ALL) TO '{tmp.as_posix()}' (FORMAT parquet)""", [ids])
        tmp.replace(out / "toko_fitur" / "peserta.parquet")
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", type=Path, default=HERE.parent.parent / "data")
    ap.add_argument("--tanpa-peserta", action="store_true")
    a = ap.parse_args()
    dep = json.loads((a.data / "aip" / "produksi" / "deployed.json").read_text("utf-8"))
    src, fs = Path(dep["paket"]), Path(dep["toko_fitur"])
    out = HERE / "paket"
    (out / "toko_fitur").mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        if f.suffix in (".pkl", ".onnx", ".json"):
            shutil.copyfile(f, out / f.name)
    sig = json.loads((out / "signature.json").read_text("utf-8"))
    sig.update(run=dep["run"], model_versi=dep.get("model_versi"), diekspor_dari=str(src))
    (out / "signature.json").write_text(json.dumps(sig, ensure_ascii=False, default=float), "utf-8")
    for f in fs.glob("*.parquet"):
        if a.tanpa_peserta and f.stem == "peserta":
            continue
        shutil.copyfile(f, out / "toko_fitur" / f.name)
    n = examples(a.data, out)  # (after the copy: the examples' members' history is rebuilt without them)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"paket {dep['run']} (model {dep.get('model_versi')}) → {out}: {size / 1e6:.1f} MB; {n} klaim nyata di paket/contoh_klaim_nyata.json")


if __name__ == "__main__":
    main()
