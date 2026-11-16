"""Backups (Security & Governance → Infrastructure security, "Disaster recovery"): encrypted, scheduled backups of
the platform's metadata, verified by restoring them into a scratch folder.

A backup is one file, <folder>/bluesandai-<UTC time>.bsbak: a zip of
  data/…              the platform's metadata and stores under the data folder (ontology, pipelines, code repositories,
                      lineage, time series, streaming…), less the folders listed in `exclude` (by default parse uploads,
                      job outputs, package environments and caches; Files content kept in S3 is backed up by its bucket)
  auth/auth.sqlite    a consistent copy of the sign-in store (SQLite's backup API)
  postgres.dump       pg_dump (custom format) of BLUESANDAI_DATABASE_URL, when pg_dump is found (PATH, PG_DUMP, or the
                      PostgreSQL installation folder)
  manifest.json       what is inside, with sizes and SHA-256 digests
encrypted with AES-256-GCM in 4 MiB chunks (a 12-byte nonce per chunk, the chunk index as associated data) under a key
derived from the platform's secret key (secretbox: BLUESANDAI_SECRET_KEY or secrets/connections.key). Keep that key
somewhere other than the backups: without it a backup cannot be read.

The scheduler (every `interval_hours`, when enabled) makes a backup and keeps the newest `keep`. Verify decrypts a
backup, checks every digest, opens the auth store (PRAGMA integrity_check) and lists the database dump (pg_restore
--list) — a restore test, recorded for the posture page. Restoring is done with the API stopped:
    python api/backups.py restore <backup file> <empty folder>
which writes the archive's files there (copy data/ back, restore postgres.dump with pg_restore).

Settings: data/backups/settings.json (administrators, Control Panel → Backups). Mounted under /api/backups.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("bluesandai.backups")
router = APIRouter(prefix="/api/backups", tags=["backups"])
ROOT = Path(__file__).resolve().parent.parent
DATA: Path = ROOT / "data"
STATE: Path = DATA / "backups"
MAGIC = b"BSBAK1\n"
CHUNK = 4 * 1024 * 1024
DEFAULT_EXCLUDE = ["files", "jobs", "code-envs", "sidecars", "tts", "backups"]
_lock = threading.Lock()
_running = threading.Event()


def configure(data_dir: Path) -> None:
    global DATA, STATE
    DATA = data_dir
    STATE = data_dir / "backups"
    STATE.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def settings() -> dict:
    s = {"enabled": False, "interval_hours": 24, "keep": 7, "folder": str(ROOT / "backups"), "exclude": list(DEFAULT_EXCLUDE), "include_database": True}
    try:
        s.update(json.loads((STATE / "settings.json").read_text("utf-8")))
    except (OSError, ValueError):
        pass
    return s


def _state() -> dict:
    try:
        return json.loads((STATE / "state.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {"runs": [], "verifications": []}


def _save_state(s: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    s["runs"] = s.get("runs", [])[-50:]
    s["verifications"] = s.get("verifications", [])[-50:]
    (STATE / "state.json").write_text(json.dumps(s, indent=1), "utf-8")


# ------------------------------------------------------------------------------------------------
# encryption
# ------------------------------------------------------------------------------------------------


def _key() -> bytes:
    """A key for backups only, derived from the platform's secret key (HKDF-SHA256)."""
    import secretbox
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    base = secretbox._box()._signing_key + secretbox._box()._encryption_key  # noqa: SLF001 - the Fernet key's two halves
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"bluesandai-backups", info=b"backup-file-v1").derive(base)


def _encrypt(src: Path, dst: Path) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aes = AESGCM(_key())
    with src.open("rb") as fi, dst.open("wb") as fo:
        fo.write(MAGIC)
        i = 0
        while True:
            chunk = fi.read(CHUNK)
            if not chunk:
                break
            nonce = os.urandom(12)
            ct = aes.encrypt(nonce, chunk, struct.pack(">Q", i))
            fo.write(nonce + struct.pack(">I", len(ct)) + ct)
            i += 1


def _decrypt(src: Path, dst: Path) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aes = AESGCM(_key())
    with src.open("rb") as fi, dst.open("wb") as fo:
        if fi.read(len(MAGIC)) != MAGIC:
            raise ValueError("not a BluesandAI backup")
        i = 0
        while True:
            head = fi.read(16)
            if not head:
                break
            nonce, n = head[:12], struct.unpack(">I", head[12:])[0]
            fo.write(aes.decrypt(nonce, fi.read(n), struct.pack(">Q", i)))
            i += 1


# ------------------------------------------------------------------------------------------------
# making a backup
# ------------------------------------------------------------------------------------------------


def _pg_dump() -> Optional[str]:
    found = os.environ.get("PG_DUMP") or shutil.which("pg_dump")
    if found:
        return found
    for base in (Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "PostgreSQL", Path("/usr/lib/postgresql")):
        if base.is_dir():
            hits = sorted(base.glob("*/bin/pg_dump.exe")) + sorted(base.glob("*/bin/pg_dump"))
            if hits:
                return str(hits[-1])
    return None


def _database_url() -> Optional[str]:
    try:
        import mailer

        return mailer.env("BLUESANDAI_DATABASE_URL") or None
    except Exception:  # noqa: BLE001
        return os.environ.get("BLUESANDAI_DATABASE_URL")


def _sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def make_backup(trigger: str = "manual") -> dict:
    """Write one encrypted backup now (one at a time) and prune old ones."""
    if _running.is_set():
        raise HTTPException(409, "a backup is running")
    _running.set()
    started = time.time()
    s = settings()
    run: dict[str, Any] = {"at": _now(), "trigger": trigger, "ok": False}
    try:
        out_dir = Path(s["folder"])
        out_dir.mkdir(parents=True, exist_ok=True)
        if out_dir.resolve().is_relative_to(DATA.resolve()):
            raise HTTPException(400, "keep backups outside the data folder")
        with tempfile.TemporaryDirectory(prefix="bsbak-") as tmp:
            tmp_p = Path(tmp)
            manifest: dict[str, Any] = {"created_at": run["at"], "files": {}, "excluded": s["exclude"], "database": None}
            zpath = tmp_p / "backup.zip"
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
                excl = set(s["exclude"]) | {"auth"}
                for p in sorted(DATA.rglob("*")):
                    if not p.is_file():
                        continue
                    rel = p.relative_to(DATA)
                    if rel.parts and rel.parts[0] in excl:
                        continue
                    try:
                        arc = "data/" + rel.as_posix()
                        z.write(p, arc)
                        manifest["files"][arc] = {"size": p.stat().st_size, "sha256": _sha_file(p)}
                    except OSError as e:  # a file being rewritten: skipped, noted
                        manifest.setdefault("skipped", []).append(f"{rel.as_posix()}: {e}")
                # the sign-in store: a consistent copy
                import auth_store

                if auth_store.kind() == "sqlite" and (DATA / "auth" / "auth.sqlite").exists():
                    copy = tmp_p / "auth.sqlite"
                    src = sqlite3.connect(DATA / "auth" / "auth.sqlite")
                    dst = sqlite3.connect(copy)
                    with dst:
                        src.backup(dst)
                    src.close()
                    dst.close()
                    z.write(copy, "auth/auth.sqlite")
                    manifest["files"]["auth/auth.sqlite"] = {"size": copy.stat().st_size, "sha256": _sha_file(copy)}
                url, dump = _database_url(), _pg_dump()
                if s.get("include_database", True) and url and dump:
                    dp = tmp_p / "postgres.dump"
                    r = subprocess.run([dump, "--format=custom", "--no-owner", "--file", str(dp), url], capture_output=True, text=True, timeout=3600)
                    if r.returncode != 0:
                        raise RuntimeError(f"pg_dump failed: {r.stderr.strip()[:400]}")
                    z.write(dp, "postgres.dump")
                    manifest["files"]["postgres.dump"] = {"size": dp.stat().st_size, "sha256": _sha_file(dp)}
                    manifest["database"] = "postgres.dump"
                elif s.get("include_database", True) and url:
                    manifest["database"] = None
                    manifest["database_note"] = "pg_dump was not found: set PG_DUMP to back up the database"
                z.writestr("manifest.json", json.dumps(manifest, indent=1))
            name = f"bluesandai-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.bsbak"
            target = out_dir / name
            _encrypt(zpath, target.with_suffix(".partial"))
            target.with_suffix(".partial").replace(target)
        # keep the newest `keep`
        olds = sorted(out_dir.glob("bluesandai-*.bsbak"))
        for old in olds[: max(0, len(olds) - int(s["keep"]))]:
            old.unlink(missing_ok=True)
        run.update(ok=True, file=str(target), size=target.stat().st_size, files=len(manifest["files"]), database=bool(manifest["database"]),
                   note=manifest.get("database_note"), seconds=round(time.time() - started, 1))
        return run
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("backup failed")
        run["error"] = str(e)[:500]
        return run
    finally:
        _running.clear()
        with _lock:
            st = _state()
            st["runs"].append(run)
            _save_state(st)
        try:
            import audit3

            audit3.emit("BACKUP_CREATED" if run.get("ok") else "BACKUP_FAILED", ["dataExport"], {"backup": run.get("file")}, {"ok": run.get("ok")},
                        result="SUCCESS" if run.get("ok") else "ERROR", product="backups")
        except Exception:  # noqa: BLE001
            pass


def extract(backup: Path, folder: Path) -> dict:
    """Decrypt and unpack a backup into a folder; returns its manifest (digests checked)."""
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bsrst-") as tmp:
        zpath = Path(tmp) / "backup.zip"
        _decrypt(backup, zpath)
        with zipfile.ZipFile(zpath) as z:
            manifest = json.loads(z.read("manifest.json"))
            z.extractall(folder)
    bad = [k for k, v in manifest["files"].items() if _sha_file(folder / k) != v["sha256"]]
    if bad:
        raise ValueError(f"{len(bad)} file(s) do not match their digests, e.g. {bad[0]}")
    return manifest


def verify(backup: Path) -> dict:
    """A restore test: unpack into a scratch folder, check digests, the auth store and the database dump."""
    out: dict[str, Any] = {"at": _now(), "file": str(backup), "ok": False}
    try:
        with tempfile.TemporaryDirectory(prefix="bsvfy-") as tmp:
            m = extract(backup, Path(tmp))
            out["files"] = len(m["files"])
            auth_db = Path(tmp) / "auth" / "auth.sqlite"
            if auth_db.exists():
                con = sqlite3.connect(auth_db)
                (res,) = con.execute("PRAGMA integrity_check").fetchone()
                (users,) = con.execute("SELECT COUNT(*) FROM users").fetchone()
                con.close()
                if res != "ok":
                    raise ValueError(f"the auth store fails its integrity check: {res}")
                out["users"] = users
            if m.get("database"):
                restore = (_pg_dump() or "").replace("pg_dump", "pg_restore")
                if restore and Path(restore).exists() or shutil.which("pg_restore"):
                    r = subprocess.run([restore if Path(restore).exists() else "pg_restore", "--list", str(Path(tmp) / "postgres.dump")],
                                       capture_output=True, text=True, timeout=600)
                    if r.returncode != 0:
                        raise ValueError(f"pg_restore cannot read the dump: {r.stderr.strip()[:300]}")
                    out["database_objects"] = sum(1 for line in r.stdout.splitlines() if line and not line.startswith(";"))
        out["ok"] = True
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:500]
    with _lock:
        st = _state()
        st["verifications"].append(out)
        _save_state(st)
    return out


def last_ok(kind: str = "runs") -> Optional[dict]:
    return next((r for r in reversed(_state().get(kind) or []) if r.get("ok")), None)


def _loop() -> None:
    while True:
        try:
            s = settings()
            if s["enabled"]:
                last = last_ok()
                due = not last or (datetime.now(timezone.utc) - datetime.fromisoformat(last["at"])).total_seconds() >= float(s["interval_hours"]) * 3600
                if due and not _running.is_set():
                    make_backup("schedule")
        except Exception:  # noqa: BLE001
            log.exception("backup scheduler")
        time.sleep(300)


def startup() -> None:
    threading.Thread(target=_loop, daemon=True, name="backups").start()


# ------------------------------------------------------------------------------------------------
# API (administrators)
# ------------------------------------------------------------------------------------------------


class SettingsIn(BaseModel):
    enabled: bool = False
    interval_hours: int = Field(24, ge=1, le=24 * 30)
    keep: int = Field(7, ge=1, le=365)
    folder: str = Field(min_length=1, max_length=500)
    exclude: list[str] = Field(default_factory=lambda: list(DEFAULT_EXCLUDE))
    include_database: bool = True


def _admin() -> None:
    import auth

    auth.require_admin()


def _backups() -> list[dict]:
    folder = Path(settings()["folder"])
    return [{"name": p.name, "size": p.stat().st_size, "at": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")}
            for p in sorted(folder.glob("bluesandai-*.bsbak"), reverse=True)] if folder.is_dir() else []


@router.get("")
def overview() -> dict:
    _admin()
    st = _state()
    return {"settings": settings(), "backups": _backups(), "runs": list(reversed(st.get("runs") or []))[:20],
            "verifications": list(reversed(st.get("verifications") or []))[:20], "running": _running.is_set(),
            "pg_dump": _pg_dump(), "database": bool(_database_url())}


@router.put("/settings")
def put_settings(req: SettingsIn) -> dict:
    _admin()
    folder = Path(req.folder).expanduser()
    if not folder.is_absolute():
        folder = ROOT / folder
    if folder.resolve().is_relative_to(DATA.resolve()):
        raise HTTPException(400, "keep backups outside the data folder")
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "settings.json").write_text(json.dumps({**req.model_dump(), "folder": str(folder)}, indent=1), "utf-8")
    import auth

    auth.audit("backup_settings_changed", None, f"{'on' if req.enabled else 'off'}, every {req.interval_hours} h, keep {req.keep}, {folder}")
    return overview()


@router.post("/run")
def run_now() -> dict:
    _admin()
    return make_backup("manual")


class VerifyIn(BaseModel):
    name: str


@router.post("/verify")
def verify_route(req: VerifyIn) -> dict:
    _admin()
    p = Path(settings()["folder"]) / Path(req.name).name
    if not p.is_file():
        raise HTTPException(404, "backup not found")
    return verify(p)


if __name__ == "__main__":  # python api/backups.py restore <backup> <folder>
    if len(sys.argv) == 4 and sys.argv[1] == "restore":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        m = extract(Path(sys.argv[2]), Path(sys.argv[3]))
        print(f"restored {len(m['files'])} files into {sys.argv[3]}" + (" (with postgres.dump: pg_restore it)" if m.get("database") else ""))
    else:
        print("usage: python api/backups.py restore <backup file> <empty folder>")
