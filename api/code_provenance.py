"""Which code trained a model, kept so anyone can audit it later.

A training process (aip.ml's jobs, Model Studio's runs) calls `capture()` as its last step: every source file it loaded
from this repository (or from a named external checkout, such as the evaluation kit) is listed from `sys.modules` —
the code that actually ran, not a list kept by hand — with its sha256, its contents, and its git state (equal to the
file at HEAD, or changed and not committed); with the libraries it imported and their versions, the data it read (sha256
of each input file), the entry point, the parameters and the seed. The caller (the API) then `store()`s it: contents in
a content-addressed store (<data>/code-snapshots/files/<sha256>), the manifest under the run's key. `verify()` compares a
manifest with the code as it is now, `diff()` one file, and `bundle()` zips everything with a README for reproducing.
"""

from __future__ import annotations

import hashlib
import io
import json
import platform
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parent.parent
STORE: Optional[Path] = None
_KEY = re.compile(r"[A-Za-z0-9_.-]{1,80}")


def configure(data_dir: Path) -> None:
    global STORE
    STORE = data_dir / "code-snapshots"


def _store() -> Path:
    if STORE is None:
        import os

        configure(Path(os.environ.get("BLUESANDAI_DATA_DIR") or REPO / "data"))
    return STORE  # type: ignore[return-value]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _git(cwd: Path, *args: str) -> str:
    try:
        # trailing newlines only: `git status --porcelain` lines begin with a space (" M path")
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace").stdout.rstrip("\n")
    except (OSError, subprocess.SubprocessError):
        return ""


def _blob(data: bytes) -> str:
    """git's object id of a file's contents (what `git hash-object` gives): equal to HEAD's blob = unchanged since the commit."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _packages(modules: set[str]) -> dict[str, str]:
    """The installed distributions of the top-level modules loaded, with their versions."""
    from importlib import metadata

    try:
        dists = metadata.packages_distributions()
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, str] = {}
    for m in sorted(modules):
        for d in dists.get(m, []):
            try:
                out[d] = metadata.version(d)
            except metadata.PackageNotFoundError:
                pass
    return out


def capture(entrypoint: str, params: Optional[dict] = None, data: Optional[dict[str, str]] = None, seed: Any = None,
            external: Optional[dict[str, Path]] = None) -> dict:
    """The manifest of the code this process ran (contents included). external: label → a checkout outside the repo
    whose loaded files count too (e.g. {"healthkathon-eval-kit": <dir>}); data: name → an input file to fingerprint."""
    roots: list[tuple[str, Path]] = [("repo", REPO)] + [(k, Path(v).resolve()) for k, v in (external or {}).items()]
    seen: dict[Path, tuple[str, Path, str]] = {}
    for name, m in list(sys.modules.items()):
        f = getattr(m, "__file__", None)
        if not f or not str(f).endswith(".py"):
            continue
        p = Path(f).resolve()
        if any(part in (".venv", ".venv-adk", "site-packages", "node_modules") for part in p.parts):
            continue
        for label, root in roots:
            if root in p.parents:
                seen.setdefault(p, (label, root, name))
                break
    if sys.argv and sys.argv[0].endswith(".py"):  # a script run directly (python model_studio.py job.json) is __main__
        p = Path(sys.argv[0]).resolve()
        for label, root in roots:
            if root in p.parents:
                seen.setdefault(p, (label, root, "__main__"))
    commits = {label: _git(root, "rev-parse", "HEAD") for label, root in roots}
    # the contents are read now, at the end of the run: a file saved after the process started (another session shares
    # the working tree) may hold other code than what ran, so it is flagged instead of being passed off as the code run
    try:
        import psutil

        started: Optional[float] = psutil.Process().create_time()
    except Exception:  # noqa: BLE001
        started = None
    files = []
    for p, (label, root, mod) in sorted(seen.items(), key=lambda x: (x[1][0] != "repo", str(x[0]))):
        raw = p.read_bytes()
        rel = p.relative_to(root).as_posix()
        files.append({"path": rel, "root": label, "module": mod, "sha256": _sha(raw), "bytes": len(raw), "lines": raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1),
                      "blob": _blob(raw), "content": raw.decode("utf-8", "replace"),
                      **({"changed_during_run": True} if started and p.stat().st_mtime > started else {})})
    # git: each file against the commit checked out, as git itself judges it (`git status` applies the checkout's
    # line-ending normalisation: a CRLF working copy of an LF blob is unchanged), and its blob id as git computes it
    for label, root in roots:
        mine = [f for f in files if f["root"] == label]
        if not mine or not commits[label]:
            continue
        paths = [f["path"] for f in mine]
        state = {line[3:].strip('"'): line[:2] for line in _git(root, "status", "--porcelain=v1", "--untracked-files=all", "--", *paths).splitlines()}
        blobs = _git(root, "hash-object", "--", *paths).splitlines()
        for i, f in enumerate(mine):
            code = state.get(f["path"])
            f["git"] = "committed" if code is None else "untracked" if code == "??" else "modified"
            if len(blobs) == len(mine):
                f["blob"] = blobs[i]
    top = {n.split(".")[0] for n in sys.modules if not n.startswith("_")}
    inputs = {}
    for name, path in (data or {}).items():
        if path and Path(path).is_file():
            info: dict[str, Any] = {"file": Path(path).name, "sha256": _file_sha(Path(path)), "bytes": Path(path).stat().st_size}
            try:  # a Parquet file (whatever its name: the API's local copies are named by item id): rows and columns from its footer
                import pyarrow.parquet as pq

                md = pq.ParquetFile(path).metadata
                info.update(rows=md.num_rows, columns=md.num_columns)
            except Exception:  # noqa: BLE001 - not Parquet
                pass
            inputs[name] = info
    fingerprint = _sha("\n".join(f"{f['root']}:{f['path']} {f['sha256']}" for f in files).encode())
    return {
        "format": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fingerprint": fingerprint,
        "entrypoint": entrypoint,
        "params": params or {},
        "seed": seed,
        "git": {label: {"commit": commits[label], **({"branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD")} if label == "repo" else {})} for label, root in roots},
        "environment": {"python": sys.version.split()[0], "implementation": platform.python_implementation(), "platform": platform.platform(),
                        "packages": _packages(top)},
        "data": inputs,
        "files": files,
        **({"process_started_at": datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds"),
            "changed_during_run": [f["path"] for f in files if f.get("changed_during_run")]} if started else {}),
    }


def write(manifest: dict, path: Path) -> None:
    Path(path).write_bytes(json.dumps(manifest, ensure_ascii=False).encode("utf-8"))


def summary(manifest: Optional[dict]) -> Optional[dict]:
    """What a run or a model version keeps: enough for a table; the manifest itself is read by its key."""
    if not manifest:
        return None
    files = manifest.get("files") or []
    return {"key": manifest.get("key"), "fingerprint": manifest["fingerprint"], "files": len(files), "lines": sum(f["lines"] for f in files),
            "commit": (manifest.get("git") or {}).get("repo", {}).get("commit"), "branch": (manifest.get("git") or {}).get("repo", {}).get("branch"),
            "modified": sum(1 for f in files if f.get("git") in ("modified", "untracked")), "captured_at": manifest.get("captured_at")}


def store(key: str, manifest: dict) -> dict:
    """Keeps the contents (content-addressed) and the manifest under `key` (a run id); returns the manifest without contents."""
    if not _KEY.fullmatch(key):
        raise ValueError(f"bad manifest key {key!r}")
    root = _store()
    (root / "files").mkdir(parents=True, exist_ok=True)
    (root / "runs").mkdir(parents=True, exist_ok=True)
    slim = {**manifest, "key": key, "files": []}
    for f in manifest.get("files") or []:
        target = root / "files" / f["sha256"]
        if "content" in f and not target.exists():
            target.write_bytes(f["content"].encode("utf-8"))  # bytes: no newline translation
        slim["files"].append({k: v for k, v in f.items() if k != "content"})
    (root / "runs" / f"{key}.json").write_bytes(json.dumps(slim, ensure_ascii=False).encode("utf-8"))
    return slim


def load(key: str) -> Optional[dict]:
    if not _KEY.fullmatch(key or ""):
        return None
    p = _store() / "runs" / f"{key}.json"
    return json.loads(p.read_bytes()) if p.exists() else None


def content(sha: str) -> Optional[str]:
    if not re.fullmatch(r"[0-9a-f]{64}", sha or ""):
        return None
    p = _store() / "files" / sha
    return p.read_bytes().decode("utf-8") if p.exists() else None


def _current(f: dict, external: dict[str, Path]) -> Optional[Path]:
    root = REPO if f["root"] == "repo" else external.get(f["root"])
    return (root / f["path"]) if root else None


def verify(manifest: dict, external: Optional[dict[str, Path]] = None) -> dict:
    """Each file of the manifest against the code as it is now: same, changed or missing; and the stored copy's own hash."""
    ext = {k: Path(v) for k, v in (external or {}).items()}
    rows, counts = [], {"same": 0, "changed": 0, "missing": 0, "unverifiable": 0}
    for f in manifest.get("files") or []:
        stored = content(f["sha256"])
        intact = stored is not None and _sha(stored.encode("utf-8")) == f["sha256"]
        p = _current(f, ext)
        if p is None:
            state = "unverifiable"
        elif not p.is_file():
            state = "missing"
        else:
            state = "same" if _file_sha(p) == f["sha256"] else "changed"
        counts[state] += 1
        rows.append({"path": f["path"], "root": f["root"], "state": state, "stored_intact": intact})
    head = _git(REPO, "rev-parse", "HEAD")
    return {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "counts": counts, "files": rows,
            "head_now": head, "head_then": (manifest.get("git") or {}).get("repo", {}).get("commit"),
            "all_same": counts["same"] == len(rows) and all(r["stored_intact"] for r in rows)}


def diff(manifest: dict, path: str, root: str = "repo", external: Optional[dict[str, Path]] = None) -> Optional[str]:
    """The unified diff from the file as trained to the file as it is now ('' when equal)."""
    import difflib

    f = next((x for x in manifest.get("files") or [] if x["path"] == path and x["root"] == root), None)
    if not f:
        return None
    then = content(f["sha256"]) or ""
    p = _current(f, {k: Path(v) for k, v in (external or {}).items()})
    now = p.read_bytes().decode("utf-8", "replace") if p and p.is_file() else ""
    return "".join(difflib.unified_diff(then.splitlines(True), now.splitlines(True), f"dilatih/{path}", f"sekarang/{path}", n=3))


def bundle_readme(manifest: dict, title: str) -> str:
    """The README of a code bundle: the run's provenance, what the bundle holds, how to reproduce and verify it."""
    repo = (manifest.get("git") or {}).get("repo", {})
    env = manifest.get("environment") or {}
    readme = [
        f"# Kode training — {title}", "",
        f"Sidik kode (sha256 atas daftar file + hash): `{manifest['fingerprint']}`",
        f"Dicatat: {manifest.get('captured_at')}  ·  commit repo: `{repo.get('commit') or '-'}` ({repo.get('branch') or '-'})",
        f"Titik masuk: `{manifest.get('entrypoint')}`  ·  seed: {manifest.get('seed')}", "",
        "## Isi paket",
        "- `code/` — setiap file sumber yang dimuat proses training, persis seperti saat dilatih (hash di manifest.json).",
        "- `manifest.json` — daftar file (sha256, baris, status git), parameter, data masukan (sha256), lingkungan.", "",
        "## Status git tiap file",
        "- `committed`: sama persis dengan file di commit di atas.",
        "- `modified` / `untracked`: belum di-commit saat training; isi yang benar-benar dipakai ada di `code/`.", "",
        "## Cara mengulang",
        f"1. `git checkout {repo.get('commit') or '<commit>'}`, lalu salin isi `code/repo/` ke atas repositori (file yang belum di-commit).",
        f"2. Python {env.get('python')} dengan paket di `manifest.json` → `environment.packages`.",
        "3. Siapkan data masukan dengan sha256 yang sama (`manifest.json` → `data`).",
        f"4. Jalankan `{manifest.get('entrypoint')}` dengan parameter di `manifest.json` → `params`.", "",
        "## Verifikasi", "`sha256sum code/repo/<path>` harus sama dengan `sha256` file itu di manifest.json.",
    ]
    return "\n".join(readme) + "\n"


def bundle(manifest: dict, title: str) -> bytes:
    """A zip for the auditor: the code as trained (code/<root>/<path>), the manifest, and a README to reproduce the run."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.md", bundle_readme(manifest, title))
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for f in manifest.get("files") or []:
            body = content(f["sha256"])
            if body is not None:
                z.writestr(f"code/{f['root']}/{f['path']}", body)
    return buf.getvalue()
