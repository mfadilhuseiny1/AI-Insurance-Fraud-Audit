"""The realtime store: <data>/aip/realtime/realtime.sqlite (WAL). What the engine decided is kept here; the simulator's
truth is kept in its own table, which the engine never reads (only the evaluation joins it)."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Optional


def data_dir() -> Path:
    from aip import vertex as aip_vertex

    d = aip_vertex.DIR.parent / "realtime"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


class Store:
    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or data_dir() / "realtime.sqlite"
        self.lock = threading.RLock()
        self.con = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA synchronous=NORMAL")
        self.con.executescript("""
CREATE TABLE IF NOT EXISTS peristiwa (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, klaim TEXT, sumber TEXT, diterima REAL,
  diputus REAL, latensi_ms REAL, skor REAL, keputusan TEXT, faskes TEXT, peserta TEXT, kasus TEXT, rec TEXT);
CREATE INDEX IF NOT EXISTS peristiwa_klaim ON peristiwa(klaim);
CREATE INDEX IF NOT EXISTS peristiwa_kasus ON peristiwa(kasus);
CREATE TABLE IF NOT EXISTS kasus (id TEXT PRIMARY KEY, status TEXT, prioritas REAL, diperbarui TEXT, rec TEXT);
CREATE TABLE IF NOT EXISTS entitas (id TEXT PRIMARY KEY, jenis TEXT, rec TEXT);
CREATE TABLE IF NOT EXISTS kebenaran (peristiwa TEXT PRIMARY KEY, klaim TEXT, skenario TEXT, instans TEXT, label_verifikator INTEGER, pada REAL);
CREATE TABLE IF NOT EXISTS keputusan (seq INTEGER PRIMARY KEY AUTOINCREMENT, kasus TEXT, keputusan TEXT, oleh TEXT, pada TEXT, catatan TEXT);
CREATE TABLE IF NOT EXISTS tanda_terima (id TEXT PRIMARY KEY, sumber TEXT, klaim TEXT, versi INTEGER, pada TEXT, status TEXT, alasan TEXT, peristiwa TEXT);
CREATE TABLE IF NOT EXISTS label (peristiwa TEXT PRIMARY KEY, label INTEGER, sumber TEXT, oleh TEXT, pada TEXT, catatan TEXT);
CREATE TABLE IF NOT EXISTS permintaan (id TEXT PRIMARY KEY, peristiwa TEXT, tanda_terima TEXT, sumber TEXT, klaim TEXT, butir TEXT, pesan TEXT,
  status TEXT, oleh TEXT, dibuat TEXT, balasan TEXT, dibalas TEXT);
CREATE INDEX IF NOT EXISTS permintaan_klaim ON permintaan(sumber, klaim);
CREATE INDEX IF NOT EXISTS permintaan_peristiwa ON permintaan(peristiwa);
CREATE TABLE IF NOT EXISTS precheck (id TEXT PRIMARY KEY, sumber TEXT, kunci TEXT, pada TEXT, ringkas TEXT, dokumen TEXT, peringatan TEXT);
CREATE INDEX IF NOT EXISTS precheck_kunci ON precheck(sumber, kunci);
""")
        self.con.commit()

    # events -----------------------------------------------------------------------------------------
    def add_events(self, evs: list[dict]) -> None:
        with self.lock:
            self.con.executemany(
                "INSERT OR REPLACE INTO peristiwa (id, klaim, sumber, diterima, diputus, latensi_ms, skor, keputusan, faskes, peserta, kasus, rec) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(e["id"], e["klaim"], e["sumber"], e["diterima"], e["diputus"], e["latensi_ms"], e["skor"], e["keputusan"], e["faskes"],
                  str(e["peserta"]), e.get("kasus"), _j(e)) for e in evs])
            self.con.commit()

    def event(self, eid: str) -> Optional[dict]:
        with self.lock:
            r = self.con.execute("SELECT rec FROM peristiwa WHERE id = ?", (eid,)).fetchone()
        return json.loads(r[0]) if r else None

    def events_of(self, ids: Iterable[str]) -> list[dict]:
        ids = list(ids)
        out = []
        with self.lock:
            for i in range(0, len(ids), 500):
                part = ids[i:i + 500]
                out += [json.loads(r[0]) for r in self.con.execute(f"SELECT rec FROM peristiwa WHERE id IN ({','.join('?' * len(part))})", part)]
        return out

    def recent(self, limit: int = 200) -> list[dict]:
        with self.lock:
            rows = self.con.execute("SELECT rec FROM peristiwa ORDER BY seq DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def rows(self, sql: str, args: tuple = ()) -> list[tuple]:
        with self.lock:
            return self.con.execute(sql, args).fetchall()

    def set_event_case(self, eid: str, case_id: str) -> None:
        with self.lock:
            r = self.con.execute("SELECT rec FROM peristiwa WHERE id = ?", (eid,)).fetchone()
            if r:
                rec = json.loads(r[0])
                rec["kasus"] = case_id
                self.con.execute("UPDATE peristiwa SET kasus = ?, rec = ? WHERE id = ?", (case_id, _j(rec), eid))
                self.con.commit()

    # cases ------------------------------------------------------------------------------------------
    def put_cases(self, cases: list[dict]) -> None:
        with self.lock:
            self.con.executemany("INSERT OR REPLACE INTO kasus (id, status, prioritas, diperbarui, rec) VALUES (?, ?, ?, ?, ?)",
                                 [(c["id"], c["status"], c["prioritas"], c["diperbarui"], _j(c)) for c in cases])
            self.con.commit()

    def cases(self) -> dict[str, dict]:
        with self.lock:
            return {i: json.loads(r) for i, r in self.con.execute("SELECT id, rec FROM kasus")}

    def decision(self, case_id: str, keputusan: str, oleh: str, pada: str, catatan: str) -> None:
        with self.lock:
            self.con.execute("INSERT INTO keputusan (kasus, keputusan, oleh, pada, catatan) VALUES (?, ?, ?, ?, ?)", (case_id, keputusan, oleh, pada, catatan))
            self.con.commit()

    # entities ---------------------------------------------------------------------------------------
    def entities(self, jenis: str) -> list[dict]:
        with self.lock:
            return [json.loads(r[0]) for r in self.con.execute("SELECT rec FROM entitas WHERE jenis = ?", (jenis,))]

    def put_entity(self, e: dict) -> None:
        with self.lock:
            self.con.execute("INSERT OR REPLACE INTO entitas (id, jenis, rec) VALUES (?, ?, ?)", (e["id"], e["jenis"], _j(e)))
            self.con.commit()

    # the simulator's truth (never read by the engine) ----------------------------------------------
    def add_truth(self, rows: list[tuple]) -> None:
        with self.lock:
            self.con.executemany("INSERT OR REPLACE INTO kebenaran (peristiwa, klaim, skenario, instans, label_verifikator, pada) VALUES (?, ?, ?, ?, ?, ?)", rows)
            self.con.commit()

    # receipts of hospital submissions ---------------------------------------------------------------
    def add_receipt(self, r: dict) -> None:
        with self.lock:
            self.con.execute("INSERT OR REPLACE INTO tanda_terima (id, sumber, klaim, versi, pada, status, alasan, peristiwa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                             (r["id"], r["sumber"], r["klaim"], r.get("versi"), r["pada"], r["status"], r.get("alasan"), r.get("peristiwa")))
            self.con.commit()

    def receipts_of(self, sumber: str, klaim: list[str]) -> dict[str, dict]:
        """The latest receipt of each of a hospital system's claims (by its own claim id)."""
        out: dict[str, dict] = {}
        with self.lock:
            for i in range(0, len(klaim), 500):
                part = klaim[i:i + 500]
                for r in self.con.execute(f"""SELECT id, klaim, versi, pada, status, alasan, peristiwa FROM tanda_terima
                                              WHERE sumber = ? AND klaim IN ({','.join('?' * len(part))}) ORDER BY pada""", [sumber, *part]):
                    out[r[1]] = {"tanda_terima": r[0], "versi": r[2], "pada": r[3], "status": r[4], "alasan": r[5], "peristiwa": r[6]}
        return out

    # requests for supporting documents (auditor → hospital) -----------------------------------------
    _REQ = "id, peristiwa, tanda_terima, sumber, klaim, butir, pesan, status, oleh, dibuat, balasan, dibalas"

    def _req(self, r: tuple) -> dict:
        d = dict(zip([c.strip() for c in self._REQ.split(",")], r))
        d["butir"] = json.loads(d["butir"] or "[]")
        return d

    def add_request(self, r: dict) -> None:
        with self.lock:
            self.con.execute(f"INSERT INTO permintaan ({self._REQ}) VALUES ({','.join('?' * 12)})",
                             (r["id"], r["peristiwa"], r["tanda_terima"], r["sumber"], r["klaim"], _j(r["butir"]), r.get("pesan") or "", r["status"],
                              r.get("oleh"), r["dibuat"], None, None))
            self.con.commit()

    def requests(self, peristiwa: Optional[str] = None, sumber: Optional[str] = None, klaim: Optional[list[str]] = None) -> list[dict]:
        with self.lock:
            if peristiwa:
                rows = self.con.execute(f"SELECT {self._REQ} FROM permintaan WHERE peristiwa = ? ORDER BY dibuat", (peristiwa,)).fetchall()
            elif klaim is not None:
                rows = []
                for i in range(0, len(klaim), 500):
                    part = klaim[i:i + 500]
                    rows += self.con.execute(f"SELECT {self._REQ} FROM permintaan WHERE sumber = ? AND klaim IN ({','.join('?' * len(part))}) ORDER BY dibuat",
                                             [sumber, *part]).fetchall()
            else:
                rows = self.con.execute(f"SELECT {self._REQ} FROM permintaan ORDER BY dibuat DESC LIMIT 200").fetchall()
        return [self._req(r) for r in rows]

    def reply_request(self, rid: str, sumber: str, balasan: str, pada: str) -> Optional[dict]:
        with self.lock:
            n = self.con.execute("UPDATE permintaan SET balasan = ?, dibalas = ?, status = 'dibalas' WHERE id = ? AND sumber = ?",
                                 (balasan, pada, rid, sumber)).rowcount
            self.con.commit()
            r = self.con.execute(f"SELECT {self._REQ} FROM permintaan WHERE id = ?", (rid,)).fetchone() if n else None
        return self._req(r) if r else None

    def close_request(self, rid: str, status: str) -> None:
        with self.lock:
            self.con.execute("UPDATE permintaan SET status = ? WHERE id = ?", (status, rid))
            self.con.commit()

    def requests_of_source(self, sumber: str, limit: int = 2000) -> list[dict]:
        with self.lock:
            rows = self.con.execute(f"SELECT {self._REQ} FROM permintaan WHERE sumber = ? ORDER BY dibuat DESC LIMIT ?", (sumber, limit)).fetchall()
        return [self._req(r) for r in rows]

    # pre-checks of hospital drafts (before submission; billing fields only) -------------------------
    def add_precheck(self, r: dict) -> None:
        with self.lock:
            self.con.execute("INSERT INTO precheck (id, sumber, kunci, pada, ringkas, dokumen, peringatan) VALUES (?, ?, ?, ?, ?, ?, ?)",
                             (r["id"], r["sumber"], r.get("kunci"), r["pada"], _j(r["ringkas"]), _j(r["dokumen"]), _j(r["peringatan"])))
            self.con.commit()

    def precheck_count(self, kunci: str, day: str) -> int:
        with self.lock:
            return self.con.execute("SELECT count(*) FROM precheck WHERE kunci = ? AND substr(pada, 1, 10) = ?", (kunci, day)).fetchone()[0]

    def prechecks(self, sumber: str, kunci: str) -> list[dict]:
        with self.lock:
            rows = self.con.execute("SELECT id, pada, ringkas, dokumen, peringatan FROM precheck WHERE sumber = ? AND kunci = ? ORDER BY pada",
                                    (sumber, kunci)).fetchall()
        return [{"id": r[0], "pada": r[1], "ringkas": json.loads(r[2]), "dokumen": json.loads(r[3]), "peringatan": json.loads(r[4])} for r in rows]

    # active-learning labels -------------------------------------------------------------------------
    def add_labels(self, rows: list[tuple]) -> None:
        """(peristiwa, label, sumber, oleh, pada, catatan); a person's label replaces an earlier one of the same event."""
        with self.lock:
            self.con.executemany("INSERT OR REPLACE INTO label (peristiwa, label, sumber, oleh, pada, catatan) VALUES (?, ?, ?, ?, ?, ?)", rows)
            self.con.commit()

    def labels(self) -> list[tuple]:
        with self.lock:
            return self.con.execute("SELECT l.peristiwa, l.label, l.sumber, l.oleh, l.pada, p.rec FROM label l JOIN peristiwa p ON p.id = l.peristiwa").fetchall()

    def reset(self) -> None:
        with self.lock:
            for t in ("peristiwa", "kasus", "kebenaran", "keputusan", "entitas", "tanda_terima", "label", "permintaan", "precheck"):
                self.con.execute(f"DELETE FROM {t}")
            self.con.commit()
            self.con.execute("VACUUM")
