"""The audit kit of a training run: everything an auditor needs to check which code trained a model, in a Docker
JupyterLab pinned to the training environment.

    README.md            what the kit holds and how to use it, the run's provenance
    manifest.json        code_provenance's manifest (files with sha256 and git state, environment, data, parameters)
    code/<root>/<path>   every source file the training process loaded, exactly as it ran
    audit_<model>.ipynb  the notebook: hashes checked, environment compared, the training code shown, the input data
                         checked, and (a model with its scored claims) the published scores computed again
    verify.py            the hash check as a script (python verify.py)
    requirements.txt     the libraries the training imported, at the versions it ran with
    Dockerfile           python:<version>-slim + requirements + JupyterLab: the training environment
    docker-compose.yml   docker compose up → JupyterLab on http://localhost:8888
    model/               (in the platform's workspace only) the model file and its scored claims

`files(...)` returns {path: bytes}; the API zips it (download) or writes it into a Code Workspace (code_workspaces).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Optional

import code_provenance

# distributions that exist only on Windows (or only for the API's process): not part of a Linux training environment
NOT_ON_LINUX = {"pywin32", "pywinpty", "pypiwin32", "wmi", "comtypes", "pywin32-ctypes", "win32-setctime", "pyreadline3", "winloop"}
# the CPU-only Linux build of the same version (the default Linux wheel adds CUDA and NCCL: ±600 MB for a CPU container)
LINUX_CPU = {"xgboost": "xgboost-cpu"}
JUPYTER = ["jupyterlab>=4.4,<5", "ipykernel"]
# the functions the notebook shows (file → functions), when the file is in the manifest
SHOW = {
    "api/ml_klaim.py": ["evaluation_set", "make_model", "benchmark", "fit_final", "predict"],
    "api/aip/ml.py": ["_train", "_capture_code"],
    "api/bluesandai_model_studio.py": ["train_tabular", "train_time_series"],
    "api/model_studio.py": ["job"],
}


def requirements(manifest: dict) -> list[str]:
    pk = (manifest.get("environment") or {}).get("packages") or {}
    return [f"{LINUX_CPU.get(d.lower(), d)}=={v}" for d, v in sorted(pk.items(), key=lambda x: x[0].lower()) if d.lower() not in NOT_ON_LINUX]


def _python(manifest: dict) -> str:
    return ".".join(((manifest.get("environment") or {}).get("python") or "3.12").split(".")[:2])


def fastest_files_host(manifest: dict, seconds: float = 1.5, rounds: int = 2) -> Optional[str]:
    """The address of PyPI's file CDN (files.pythonhosted.org) that serves this machine fastest, or None. A connection
    to it runs at ~14 MB/s or at ~0.2 MB/s from this network (2026-10-27), with a strong bias per address, and pip
    keeps the one connection DNS gave it: a 700 MB image took over an hour instead of a minute. Each address downloads
    the first megabytes of one of the image's own wheels for `seconds`, `rounds` times on new connections; the address
    whose slowest round is fastest wins."""
    import socket
    import ssl
    import time
    import urllib.request

    host = "files.pythonhosted.org"
    try:
        name, ver = requirements(manifest)[0].split("==")
        with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{ver}/json", timeout=10) as r:
            urls = [u["url"] for u in sorted(json.loads(r.read())["urls"], key=lambda u: -u["size"])]
        path = urls[0].split(host, 1)[1]
        ips = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)})
    except (OSError, ValueError, IndexError, KeyError):
        return None
    def rate(ip: str) -> float:
        got, t = 0, time.monotonic()
        try:
            with socket.create_connection((ip, 443), timeout=5) as raw, ssl.create_default_context().wrap_socket(raw, server_hostname=host) as s:
                s.settimeout(seconds + 3)
                s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes=0-40000000\r\nConnection: close\r\n\r\n".encode())
                while time.monotonic() - t < seconds:
                    b = s.recv(1 << 16)
                    if not b:
                        break
                    got += len(b)
        except OSError:
            return 0.0
        return got / max(time.monotonic() - t, 1e-3)

    if len(ips) < 2:
        return None
    worst = {ip: min(rate(ip) for _ in range(rounds)) for ip in ips}
    ip = max(worst, key=worst.get)
    return ip if worst[ip] > 0 else None


def image_tag(manifest: dict) -> str:
    """One image per training environment (Python version and pinned libraries)."""
    env = manifest.get("environment") or {}
    key = json.dumps([env.get("python"), requirements(manifest), JUPYTER])
    return f"bluesandai.local/ml-audit-jupyter:{hashlib.sha256(key.encode()).hexdigest()[:16]}"


def dockerfile(manifest: dict, inline: bool = False) -> str:
    """inline: the requirements written into the Dockerfile (a build with no context, from stdin)."""
    py = _python(manifest)
    reqs = requirements(manifest)
    install = (" \\\n    ".join(["RUN pip install --no-cache-dir"] + [f"'{r}'" for r in reqs + JUPYTER])) if inline else \
        "COPY requirements.txt /tmp/requirements.txt\nRUN pip install --no-cache-dir -r /tmp/requirements.txt " + " ".join(f"'{r}'" for r in JUPYTER)
    return "\n".join([
        "# The training environment of the run (manifest.json → environment): Python and the libraries it imported, pinned.",
        f"FROM python:{py}-slim",
        "ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1",
        "RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*",
        install,
        "WORKDIR /home/audit/work",
        "EXPOSE 8888",
        'CMD ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser", "--allow-root", "--ServerApp.root_dir=/home/audit/work"]',
        "",
    ])


COMPOSE = """services:
  audit:
    build: .
    ports:
      - "127.0.0.1:8888:8888"
    volumes:
      - ./:/home/audit/work
"""

VERIFY = '''"""Checks every file in code/ against manifest.json (sha256) and the code fingerprint. Exit code 1 on a mismatch."""
import hashlib
import json
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
m = json.loads((here / "manifest.json").read_text("utf-8"))
bad = 0
for f in m["files"]:
    p = here / "code" / f["root"] / f["path"]
    ok = p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == f["sha256"]
    bad += not ok
    print(("OK  " if ok else "BEDA"), f["root"], f["path"], f["sha256"][:12])
fp = hashlib.sha256("\\n".join(f"{f['root']}:{f['path']} {f['sha256']}" for f in m["files"]).encode()).hexdigest()
print("sidik kode:", fp, "(cocok)" if fp == m["fingerprint"] else "(TIDAK cocok)")
sys.exit(1 if bad or fp != m["fingerprint"] else 0)
'''


def _md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n")}


def _code(text: str) -> dict:
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip("\n")}


def notebook(manifest: dict, run: dict, model: Optional[dict] = None) -> dict:
    """The audit notebook of a run. run: what ML Studio lists of it (name, model, version, started_at…)."""
    repo = (manifest.get("git") or {}).get("repo") or {}
    files = manifest.get("files") or []
    changed = sum(1 for f in files if f.get("git") in ("modified", "untracked"))
    shown = [(p, fns) for p, fns in SHOW.items() if any(f["path"] == p and f["root"] == "repo" for f in files)]
    cells = [
        _md(f"""
# Audit kode training — {run.get('model') or 'model'}

**Run:** `{manifest.get('key')}` · {run.get('name') or ''}
**Versi model:** {run.get('version') or '—'} · **dilatih:** {manifest.get('captured_at')}
**Sidik kode:** `{manifest['fingerprint']}`
**Commit repositori:** `{repo.get('commit') or '—'}` (branch `{repo.get('branch') or '—'}`) · {len(files)} file sumber, {changed} belum di-commit saat training

Notebook ini membuktikan kode mana yang benar-benar melatih model ini. Proses training mencatat sendiri setiap file
sumber yang dimuatnya (dari `sys.modules`, bukan daftar yang ditulis tangan), lengkap dengan hash sha256, isi file,
status git, versi pustaka dan hash data masukan. Jalankan sel dari atas ke bawah (Run → Run All Cells).
"""),
        _md("## 1. Kode yang dipakai training: hash tiap file\n\nSetiap file di `code/` dihitung ulang hash sha256-nya dan dibandingkan dengan manifest. "
            "Sidik kode adalah sha256 atas daftar file + hash, sehingga satu karakter yang berubah di file mana pun mengubah sidiknya."),
        _code("""
import hashlib, json, pathlib
import pandas as pd

m = json.loads(pathlib.Path("manifest.json").read_text("utf-8"))
rows = []
for f in m["files"]:
    p = pathlib.Path("code") / f["root"] / f["path"]
    now = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
    rows.append({"sumber": f["root"], "file": f["path"], "baris": f["lines"], "git saat training": f.get("git", "-"),
                 "sha256": f["sha256"][:16], "cocok": now == f["sha256"]})
files = pd.DataFrame(rows)
fp = hashlib.sha256("\\n".join(f"{f['root']}:{f['path']} {f['sha256']}" for f in m["files"]).encode()).hexdigest()
print(f"{int(files['cocok'].sum())} / {len(files)} file cocok dengan manifest")
print("sidik kode dihitung ulang:", fp, "→", "COCOK" if fp == m["fingerprint"] else "TIDAK COCOK")
assert files["cocok"].all() and fp == m["fingerprint"]
files
"""),
        _md("**Status git saat training**: `committed` = sama persis dengan file di commit di atas; `modified`/`untracked` = belum di-commit "
            "saat training, isi yang benar-benar dipakai ada di `code/`."),
        _md("## 2. Lingkungan: versi pustaka\n\nPustaka yang diimpor proses training dan versinya, dibandingkan dengan lingkungan notebook ini "
            "(image Docker dibangun dari `requirements.txt` yang sama)."),
        _code("""
import sys
from importlib import metadata

def have(d):  # xgboost runs here as its CPU build, xgboost-cpu (same version)
    for name in (d, f"{d}-cpu"):
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return None

env = m["environment"]
print("Python saat training:", env["python"], "· di sini:", sys.version.split()[0])
pk = pd.DataFrame([{"pustaka": d, "saat training": v, "di sini": have(d)} for d, v in sorted(env["packages"].items())])
pk["sama"] = pk["saat training"] == pk["di sini"]
print(f"{int(pk['sama'].sum())} / {len(pk)} pustaka di versi yang sama")
pk
"""),
    ]
    if shown:
        cells.append(_md("## 3. Kode training\n\nFungsi inti training, dibaca langsung dari file di `code/` (yang hash-nya sudah dicek di langkah 1)."))
        for path, fns in shown:
            cells.append(_code(f"""
import ast
from IPython.display import Code, display

src = pathlib.Path("code/repo/{path}").read_text("utf-8")
tree = ast.parse(src)
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in {fns!r}:
        print(f"── {path} · {{node.name}} (baris {{node.lineno}}–{{node.end_lineno}})")
        display(Code(ast.get_source_segment(src, node), language="python"))
"""))
    cells += [
        _md("## 4. Data masukan\n\nHash sha256 tiap file data yang dibaca training. Bila datanya tersedia di folder `data/`, hash-nya dihitung ulang di sini."),
        _code("""
data = pd.DataFrame([{"masukan": k, **v} for k, v in m["data"].items()])
def check(row):
    p = pathlib.Path("data") / row["file"]
    if not p.is_file():
        return "tidak tersedia di sini"
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "COCOK" if h.hexdigest() == row["sha256"] else "BERBEDA"
if len(data):
    data["cek"] = data.apply(check, axis=1)
data
"""),
    ]
    if model and model.get("rescore"):
        cells += [
            _md("## 5. Skor model dihitung ulang\n\nModel yang dipublikasikan (`model/model.pkl`) dipakai lagi pada fitur klaim yang disimpan bersama versi ini, "
                "dengan kode training di `code/`. Skor hasil hitung ulang dibandingkan dengan skor yang dipublikasikan (`model/klaim.parquet`)."),
            _code("""
import pickle, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path("code/repo/api").resolve()))
import ml_klaim as M

bundle = pickle.loads(pathlib.Path("model/model.pkl").read_bytes())
X = pd.read_parquet("model/fitur_klaim.parquet")
pub = pd.read_parquet("model/klaim.parquet")[["klaim_id", "segmen_model", "risiko"]]
parts = []
for name, seg in bundle["segments"].items():
    sel = (X["jenis_fkrtl"] == "Rumah sakit") == (name == "rumah_sakit")
    parts.append(pd.DataFrame({"klaim_id": X.loc[sel, "klaim_id"].to_numpy(), "segmen": name, "risiko_ulang": M.predict(seg, X[sel])}))
ulang = pd.concat(parts)
j = pub.merge(ulang, on="klaim_id")
diff = np.abs(j["risiko"] - j["risiko_ulang"])
print({s: f"{v['name']} (ambang {v['threshold']:.4f})" for s, v in bundle["segments"].items()})
print(f"{len(j):,} klaim dibandingkan; selisih terbesar {diff.max():.2e}; identik: {int((diff == 0).sum()):,}")
assert diff.max() < 1e-9
j.head(10)
"""),
        ]
    cells.append(_md(f"""
## {6 if model and model.get('rescore') else 5}. Mengulang training

- Titik masuk: `{manifest.get('entrypoint')}` · seed `{manifest.get('seed')}`
- Parameter: `{json.dumps(manifest.get('params') or {}, ensure_ascii=False)[:600]}`
- `git checkout {repo.get('commit') or '<commit>'}`, salin `code/repo/` ke atas repositori, siapkan data dengan sha256 di langkah 4,
  lalu jalankan titik masuk di atas di lingkungan ini (Dockerfile).
"""))
    for i, c in enumerate(cells):  # nbformat 4.5: every cell has an id
        c["id"] = f"audit-{i:02d}"
    return {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
            "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "model").lower()).strip("_")[:48] or "model"


def files(manifest: dict, run: dict, model: Optional[dict] = None) -> dict[str, bytes]:
    """The kit's files. model: {"rescore": True, "files": {"model.pkl": bytes, …}} for a model whose scores the
    notebook computes again (only in the platform's workspace: the scored claims are data)."""
    out: dict[str, bytes] = {}
    for f in manifest.get("files") or []:
        body = code_provenance.content(f["sha256"])
        if body is not None:
            out[f"code/{f['root']}/{f['path']}"] = body.encode("utf-8")
    out["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=1).encode("utf-8")
    out[f"audit_{slug(run.get('model') or '')}.ipynb"] = json.dumps(notebook(manifest, run, model), ensure_ascii=False, indent=1).encode("utf-8")
    out["verify.py"] = VERIFY.encode()
    out["requirements.txt"] = ("\n".join(requirements(manifest) + JUPYTER) + "\n").encode()
    out["Dockerfile"] = dockerfile(manifest).encode()
    out["docker-compose.yml"] = COMPOSE.encode()
    readme = code_provenance.bundle_readme(manifest, run.get("model") or "model")
    readme += ("\n## Docker + JupyterLab\n\n`docker compose up --build`, lalu buka http://localhost:8888 dan jalankan "
               f"`audit_{slug(run.get('model') or '')}.ipynb`. Tanpa Docker: `pip install -r requirements.txt && jupyter lab`.\n"
               "Cek hash tanpa notebook: `python verify.py`.\n")
    out["README.md"] = readme.encode()
    for name, body in ((model or {}).get("files") or {}).items():
        out[f"model/{name}"] = body
    return out
