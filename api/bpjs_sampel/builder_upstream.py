"""How the pipeline's inputs were made: Arsip Sumber (BPJS's Stata .dta files, raw/ in Files) → Data Mentah (the
bronze datasets), by the Code Repository "Pipeline Data Sampel BPJS" (transforms-python/src/myproject/datasets/
bronze.py). Kept in the pipeline file as `upstream` (the Builder's "Dari Arsip Sumber" button): every source file
with its edition, size, sha256 and rows (bronze/_meta/katalog_*), each bronze dataset with the build and commit that
wrote it and whether its rows equal its files' rows, the transform's steps, and its code at each commit used.

`build()` is pure (the caller reads Files, the katalog and the repository): nexus.gold and the publish scripts share it.
"""

from __future__ import annotations

from typing import Any, Optional

REPO_NAME = "Pipeline Data Sampel BPJS"
BRONZE_PY = "transforms-python/src/myproject/datasets/bronze.py"
COMMON_PY = "transforms-python/src/myproject/datasets/bpjs_common.py"

# the transform's steps, as the dialog shows them (Indonesian rewritten for clarity with GPT-6 Luna, facts checked against bronze.py)
STEPS = [
    ("Satu skema untuk semua edisi",
     "Untuk setiap tabel, transform bronze membuka tiap file .dta dan membaca 1.000 baris pertama, label variabel, serta label nilai. Tipe kolom antar-edisi diselaraskan: bila di salah satu edisi kolom bertipe teks, kolom menjadi teks. Jika tidak ada edisi yang bertipe teks, tetapi setidaknya satu edisi bertipe desimal, kolom menjadi desimal. Kolom yang tidak ada di suatu edisi dibiarkan kosong untuk edisi tersebut."),
    ("Baris dibaca per 250.000",
     "Transform bronze membaca tiap file secara bertahap, per 250.000 baris, menggunakan pandas read_stata (fungsi untuk membaca file Stata). Kode tidak diterjemahkan karena transform bronze menggunakan convert_categoricals=False (opsi agar kode kategorikal tidak diterjemahkan). Transform bronze menulis data ke satu file Parquet (format penyimpanan data kolumnar) dengan kompresi zstd (algoritme kompresi). Tidak ada baris yang dibuang atau disaring, dan tidak ada nilai yang diubah."),
    ("Edisi dan asal file",
     "Transform bronze menambahkan dua kolom: edisi dan sumber_file. Nilai edisi ditentukan dari awalan nama file: COV → covid, DM → dm, KM → kesehatan_mental, KIA2024ibu → kia_ibu, KIA2024anak → kia_anak, TB → tb, dan awalan lainnya → reguler. Kolom sumber_file berisi nama file .dta asal."),
    ("Kode dan nama kolom asli",
     "Transform bronze mempertahankan nama kolom asli di Data Mentah, seperti PSTV, FKP, FKL, dan PNK, serta tidak menerjemahkan kode. Penerjemahan kode merupakan tugas Data Bersih. Dengan begitu, setiap nilai tetap dapat dicocokkan dengan file BPJS."),
    ("Buku label",
     "Transform bronze menulis label nilai Stata untuk tiap kolom berkode ke bronze/_meta/label_nilai_<tabel>. Buku label ini memuat edisi, tabel, kolom, kode, dan label."),
    ("Katalog dan sidik file",
     "Transform bronze menyimpan katalog di bronze/_meta/katalog_<tabel>. Katalog memuat label variabel, tipe, status berlabel, serta ukuran, sha256 (sidik digital), dan jumlah baris untuk tiap file. Informasi ini menjadi dasar rekonsiliasi jumlah baris yang ditampilkan di tab \"Data Mentah\"."),
    ("FKRTL dua bagian",
     "File FKRTL dari ketujuh edisi berukuran total 2,16 GB. Satu build Code Repository membaca paling banyak 2 GiB file secara sekaligus (jumlah total, bukan per file). Karena itu, transform bronze membaca file tersebut dalam dua bagian: fkrtl_bagian_1 (reguler, covid, dm) dan fkrtl_bagian_2 (kesehatan_mental, kia_ibu, kia_anak, tb). Data Bersih menyatukan kedua bagian tersebut (Union, yaitu penggabungan)."),
    ("Teks panjang Stata (strL)",
     "pandas hanya memuat tabel teks panjang (nama diagnosis dan deskripsi INA-CBG) jika baris dibaca sebelum label nilai. Jika urutannya dibalik, kolom itu bertipe angka dan isinya hilang. Sejak commit 2a226d9058, transform bronze membaca baris contoh lebih dulu. Transform bronze membangun dataset kepesertaan, nonkapitasi, dan diagnosissekunder dengan versi kode transform sebelumnya. Pemeriksaan pada 2026-10-27 menunjukkan bahwa tidak ada kolom teks yang terdampak: kepesertaan tidak memiliki kolom teks, sedangkan nama diagnosis nonkapitasi dan kode diagnosis sekunder berupa teks."),
]


def rehash(files: list[dict], path_of) -> dict:
    """Each source file hashed again (sha256 of the bytes in Files now): its "sha256_ok"; the summary for build()."""
    import hashlib
    from datetime import datetime, timezone

    matched = 0
    for f in files:
        p = path_of(f)
        if not p or not p.is_file():
            f["sha256_ok"] = None
            continue
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 22), b""):
                h.update(block)
        f["sha256_ok"] = h.hexdigest() == f["sha256"]
        matched += f["sha256_ok"]
    return {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "matched": matched, "files": len(files)}


def build(files: list[dict], bronze_rows: dict[str, int], builds: dict[str, dict], code: dict[str, str], messages: dict[str, str],
          raw_folder: Optional[dict], repo: Optional[dict], document: str, verified: Optional[dict] = None) -> dict[str, Any]:
    """files: [{name, edisi, dataset (the raw folder = the bronze dataset), bytes, sha256, rows, item_id}];
    bronze_rows: bronze dataset → rows; builds: bronze dataset → {commit, at, id}; code: commit → bronze.py text;
    messages: commit → its message; raw_folder: {id, name}; repo: {id, name}; verified: {at, matched, files} — the source
    files hashed again (each file's "sha256_ok") against the katalog's sha256."""
    outputs = []
    for ds in sorted({f["dataset"] for f in files}):
        mine = [f for f in files if f["dataset"] == ds]
        from_files = sum(f["rows"] or 0 for f in mine)
        b = builds.get(ds) or {}
        outputs.append({"name": ds, "rows": bronze_rows.get(ds), "files": len(mine), "rows_from_files": from_files,
                        "bytes_from_files": sum(f["bytes"] or 0 for f in mine), "editions": sorted({f["edisi"] for f in mine}),
                        "matches": bronze_rows.get(ds) == from_files, "commit": b.get("commit"), "built_at": b.get("at"), "build": b.get("id")})
    versions = []
    for commit in sorted({o["commit"] for o in outputs if o["commit"]}, key=lambda c: min(o["built_at"] or "" for o in outputs if o["commit"] == c)):
        versions.append({"commit": commit, "message": messages.get(commit, ""), "datasets": [o["name"] for o in outputs if o["commit"] == commit],
                         "path": BRONZE_PY, "code": code.get(commit, "")})
    total_rows = sum(f["rows"] or 0 for f in files)
    gb = f"{sum(f['bytes'] or 0 for f in files) / 1e9:.2f}".replace(".", ",")
    rows_id = f"{total_rows:,}".replace(",", ".")  # Indonesian thousands
    return {
        "title": "Arsip Sumber → Data Mentah",
        "summary": (f"{len(files)} file Stata (.dta) asli {document} — {len({f['edisi'] for f in files})} edisi, {gb} GB, {rows_id} baris — dibaca "
                    f"apa adanya oleh transform bronze di Code Repository \"{(repo or {}).get('name', REPO_NAME)}\" menjadi {len(outputs)} dataset Data Mentah. "
                    "Dataset mempertahankan kode dan nama kolom asli, serta menambahkan kolom edisi dan sumber_file. Transform bronze juga menulis buku "
                    "label dan katalog. Pipeline Data Bersih → Siap Analisis dimulai dari dataset tersebut."),
        "document": document,
        "source": {"label": "Arsip Sumber — file asli BPJS (Stata .dta)", "folder": raw_folder, "files": files, "verified": verified},
        "transform": {"label": f"Code Repository · {(repo or {}).get('name', REPO_NAME)}", "repo": repo, "path": BRONZE_PY,
                      "link": f"/code-repositories/{repo['id']}" if repo else None, "steps": [{"title": t, "detail": d} for t, d in STEPS], "versions": versions},
        "outputs": outputs,
    }
