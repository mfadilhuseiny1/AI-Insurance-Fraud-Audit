"""Fingerprint scan: is any REAL visit/claim identifier (FKL02, FKP02, PNK02 of the real Data Sampel BPJS, ~15 million
values, 13-16 characters each) anywhere in this repo's data? Also real participant numbers (PSTV01) in columns that hold
participant numbers.

Reports file paths and hit counts only, never an identifier.
  .venv\\Scripts\\python.exe -I synthetic-gen\\scan_real_ids.py [folder ...]       (default: data, Data Sintetis, synthetic-gen)
  .venv\\Scripts\\python.exe -I synthetic-gen\\scan_real_ids.py --sql dump.sql      (a plain-text database dump)
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

import duckdb  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from sgen import config  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
TOKEN = re.compile(rb"[A-Za-z0-9]{10,16}")
TEXT_EXT = {".json", ".jsonl", ".txt", ".csv", ".tsv", ".md", ".log", ".sql", ".py", ".ts", ".tsx", ".js", ".html", ".yaml", ".yml", ".xml",
            ".ipynb", ".toml", ".ini", ".cfg", ".r", ".java", ".scala", ".contour", ".codeworkbook", ".graph", ".slate", ".wal"}
PERSON_COLS = re.compile(r"(?i)^(pstv01|pstv02|pstv01_a|peserta_id|keluarga_id|peserta_ibu_id|nomor_peserta)$")
MAX_BIN = 400 * 1024 * 1024


def real_sets():
    con = duckdb.connect()
    b = str(config.REAL_BRONZE).replace("\\", "/")
    ids = set()
    for t, c in [("fkrtl", "FKL02"), ("fkrtl", "FKP02"), ("fktpkapitasi", "FKP02"), ("nonkapitasi", "PNK02")]:
        for (v,) in con.execute(f"SELECT DISTINCT {c} FROM read_parquet('{b}/{t}/*/data.parquet', hive_partitioning=1) WHERE length({c}) >= 10").fetchall():
            ids.add(v.encode())
    people = set(con.execute(f"SELECT DISTINCT PSTV01 FROM read_parquet('{b}/kepesertaan/*/data.parquet', hive_partitioning=1)").df()["PSTV01"].astype("int64"))
    return ids, people


WEAK = re.compile(rb"^[0-9]{10,12}$")  # a 10-12 digit number can be a real numeric FKP02 by chance (epoch seconds, phone numbers)
WEAK_HITS: dict[str, int] = {}
UNREADABLE: list[str] = []
_CURRENT = [""]


def scan_bytes(data: bytes, ids) -> int:
    strong = 0
    for m in TOKEN.finditer(data):
        t = m.group(0)
        if t in ids:
            if WEAK.match(t):
                WEAK_HITS[_CURRENT[0]] = WEAK_HITS.get(_CURRENT[0], 0) + 1
            else:
                strong += 1
    return strong


def scan_parquet(p: Path, ids, people) -> int:
    hits = 0
    pf = pq.ParquetFile(p)
    for rg in range(pf.num_row_groups):
        t = pf.read_row_group(rg)
        for name, col in zip(t.column_names, t.columns):
            ty = str(col.type)
            if any(ty.startswith(k) for k in ("struct", "list", "large_list", "map", "fixed_size_list")):
                for v in col.to_pylist():
                    if v is not None:
                        hits += scan_bytes(json.dumps(v, default=str).encode(), ids)
            elif "string" in ty or "binary" in ty:
                for v in col.to_pylist():
                    if v is None:
                        continue
                    b = v.encode() if isinstance(v, str) else bytes(v) if isinstance(v, (bytes, bytearray)) else str(v).encode()
                    hits += scan_bytes(b, ids)
            elif PERSON_COLS.match(name) and ("int" in ty or "double" in ty):
                hits += sum(1 for v in col.to_pylist() if v is not None and int(v) in people)
    return hits


def scan_sqlite(p: Path, ids) -> int:
    hits = 0
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall():
        try:
            for row in con.execute(f'SELECT * FROM "{t}"'):
                for v in row:
                    if isinstance(v, str):
                        hits += scan_bytes(v.encode("utf-8", "ignore"), ids)
                    elif isinstance(v, bytes):
                        hits += scan_bytes(v, ids)
        except sqlite3.Error:
            continue
    con.close()
    return hits


def scan_file(p: Path, ids, people) -> int:
    suf = p.suffix.lower()
    try:
        if suf == ".parquet" or (suf == "" and p.stat().st_size > 8 and p.read_bytes()[:4] == b"PAR1"):
            return scan_parquet(p, ids, people)
        head = p.open("rb").read(16)
        if head.startswith(b"SQLite format 3"):
            return scan_sqlite(p, ids)
        if p.stat().st_size > MAX_BIN:
            data = b""
            with p.open("rb") as f:
                hits = 0
                while chunk := f.read(64 * 1024 * 1024):
                    hits += scan_bytes(data[-16:] + chunk, ids)
                    data = chunk
                return hits
        return scan_bytes(p.read_bytes(), ids)
    except Exception as e:  # noqa: BLE001
        print(f"  ! unreadable {p}: {type(e).__name__}")
        return -1


def main(args: list[str]) -> None:
    t0 = time.time()
    ids, people = real_sets()
    print(f"real identifiers loaded: {len(ids):,} visit/claim ids, {len(people):,} participant numbers ({time.time() - t0:.0f} s)")
    if args[:1] == ["--sql"]:
        targets = [Path(args[1])]
    else:
        targets = [Path(a) for a in args] or [REPO / "data", REPO / "Data Sintetis", REPO / "synthetic-gen"]
    found, files, nbytes = {}, 0, 0
    for root in targets:
        paths = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for p in paths:
            files += 1
            nbytes += p.stat().st_size
            _CURRENT[0] = str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p)
            h = scan_file(p, ids, people)
            if h > 0:
                found[_CURRENT[0]] = h
            elif h < 0:
                UNREADABLE.append(_CURRENT[0])
            if files % 2000 == 0:
                print(f"  {files:,} files, {nbytes / 1e9:.1f} GB, {len(found)} with hits, {time.time() - t0:.0f} s")
    out = {"files_scanned": files, "gb_scanned": round(nbytes / 1e9, 2), "files_with_real_ids": found,
           "weak_numeric_matches": WEAK_HITS, "unreadable_files": UNREADABLE, "secs": round(time.time() - t0),
           "catatan": "files_with_real_ids: alphanumeric real visit ids (13-16 chars) or real participant numbers in participant columns; "
                      "weak_numeric_matches: 10-12 digit numbers equal to a real numeric visit id (can be chance: timestamps, counts)"}
    (config.REPORT).mkdir(parents=True, exist_ok=True)
    (config.REPORT / "scan_real_ids.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    print(f"scanned {files:,} files ({nbytes / 1e9:.2f} GB) in {out['secs']} s: {len(found)} file(s) contain real identifiers")
    for k, v in sorted(found.items(), key=lambda kv: -kv[1])[:60]:
        print(f"  {v:>9,}  {k}")
    print(f"weak numeric matches in {len(WEAK_HITS)} file(s)")
    for k, v in sorted(WEAK_HITS.items(), key=lambda kv: -kv[1])[:20]:
        print(f"  {v:>9,}  {k}  (weak)")


if __name__ == "__main__":
    main(sys.argv[1:])
