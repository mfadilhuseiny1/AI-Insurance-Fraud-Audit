"""Artifact repositories beyond Docker images (palantir.com/docs/foundry/code-repositories/artifact-repositories-nav).

An Artifacts repository (container_registry.py: a `<name>.artifacts` Files item whose Project roles govern it) also
holds packages of three formats, published and consumed with their usual clients:

  Conda   noarch / platform packages (.tar.bz2 and .conda) in a conda channel:
          PUT  /artifacts/<slug>/conda/<subdir>/<file>         (curl -T, or anaconda-style upload through the API)
          conda install -c https://<user>:<token>@<host>/artifacts/<slug>/conda <package>
  PyPI    wheels and sdists behind a simple index (PEP 503 / 592):
          twine upload --repository-url https://<host>/artifacts/<slug>/pypi/ -u <user> -p <token> dist/*
          pip / uv install --index-url https://<user>:<token>@<host>/artifacts/<slug>/pypi/simple <package>
  Maven   the Maven repository layout (PUT and GET), so `gradle publish` / `mvn deploy` and builds resolve from it:
          https://<host>/artifacts/<slug>/maven/<group path>/<artifact>/<version>/<file>

Clients authenticate with Basic auth (any user name, a personal API token as the password) or a Bearer token: the
Publish tab generates a short-lived token. Viewers of the repository read, Editors publish and recall (Foundry's
"Manage permissions"). Artifacts cannot be deleted: deleting the repository (Files → Move to trash, then Delete
permanently) removes them all.

Recall (Conda, and PyPI as yanked): a recalled version disappears from the channel / index and its file cannot be
downloaded, so consumers stop resolving it; Unrecall restores it. Code Repositories consume a repository added in
Settings → Artifacts: its Conda (noarch python) and PyPI (pure-Python wheel) packages resolve in conda_recipe/meta.yaml
like published libraries (code_repos._environment), its Maven artifacts in build.gradle (code_java / maven.py).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import re
import tarfile
import threading
import uuid
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Any, Optional
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

import auth
import container_registry as reg

router = APIRouter(prefix="/api/artifact-repos")
# package clients (conda, pip / uv / twine, Maven / Gradle) talk to these, outside /api: they authenticate themselves
clients = APIRouter(prefix="/artifacts")

DIR = Path("data/artifact-repos")
_lock = threading.RLock()
FORMATS = ("docker", "conda", "pypi", "maven")
TOKEN_DAYS = 1
CONDA_SUBDIRS = ("noarch", "linux-64", "linux-aarch64", "osx-64", "osx-arm64", "win-64")
_SAFE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+!-]*$")
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "artifact-repos"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    p = auth.current() or {}
    return p.get("username") or p.get("id") or "system"


def norm(name: str) -> str:
    """PEP 503 name normalization (conda names are lower case too)."""
    return re.sub(r"[-_.]+", "-", name).lower()


# ------------------------------------------------------------------------------------------------
# storage: data/artifact-repos/<repo id>/index.json and files/<format>/...
# ------------------------------------------------------------------------------------------------


def _dir(repo_id: str) -> Path:
    reg._repo_path(repo_id)  # validates the id
    return DIR / repo_id


def _index(repo_id: str) -> dict:
    p = _dir(repo_id) / "index.json"
    if not p.exists():
        return {"conda": {}, "pypi": {}, "maven": {}}
    data = json.loads(p.read_text("utf-8"))
    for f in ("conda", "pypi", "maven"):
        data.setdefault(f, {})
    return data


def _save_index(repo_id: str, data: dict) -> None:
    d = _dir(repo_id)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f"index.json.{uuid.uuid4().hex[:8]}.tmp"  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(data, indent=1), "utf-8")
    tmp.replace(d / "index.json")


def _file(repo_id: str, fmt: str, rel: str) -> Path:
    return _dir(repo_id) / "files" / fmt / rel


def _write_file(repo_id: str, fmt: str, rel: str, data: bytes) -> Path:
    p = _file(repo_id, fmt, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(p)
    return p


def _repo(repo_id: str, need: str = "viewer") -> dict:
    return reg.get(repo_id, need)


# ------------------------------------------------------------------------------------------------
# Conda
# ------------------------------------------------------------------------------------------------


def _conda_index_json(fname: str, data: bytes) -> dict:
    """info/index.json of a conda package (.tar.bz2, or .conda: a zip with info-*.tar.zst)."""
    try:
        if fname.endswith(".tar.bz2"):
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as tf:
                m = tf.extractfile("info/index.json")
                return json.loads(m.read()) if m else {}
        if fname.endswith(".conda"):
            import zstandard

            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                inner = next((n for n in zf.namelist() if n.startswith("info-") and n.endswith(".tar.zst")), None)
                if not inner:
                    raise ValueError("no info-*.tar.zst")
                raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(zf.read(inner))).read()
                with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tf:
                    m = tf.extractfile("info/index.json")
                    return json.loads(m.read()) if m else {}
    except (tarfile.TarError, zipfile.BadZipFile, KeyError, ValueError, OSError) as e:
        raise HTTPException(400, f"{fname} is not a conda package ({e})") from None
    raise HTTPException(400, "conda packages are .tar.bz2 or .conda files")


def publish_conda(repo_id: str, subdir: str, fname: str, data: bytes) -> dict:
    _repo(repo_id, "editor")
    if subdir not in CONDA_SUBDIRS:
        raise HTTPException(400, f"unknown conda subdir {subdir} (one of {', '.join(CONDA_SUBDIRS)})")
    if not _SAFE_FILE.match(fname):
        raise HTTPException(400, f"invalid file name {fname}")
    info = _conda_index_json(fname, data)
    for k in ("name", "version", "build"):
        if not info.get(k):
            raise HTTPException(400, f"{fname}: info/index.json has no {k}")
    if (info.get("subdir") or "noarch") != subdir:
        raise HTTPException(400, f"{fname} is built for {info.get('subdir')}, not {subdir}")
    with _lock:
        idx = _index(repo_id)
        key = f"{subdir}/{fname}"
        if key in idx["conda"]:
            raise HTTPException(409, f"{key} is already published: artifacts cannot be replaced (publish a new version or build number)")
        _write_file(repo_id, "conda", key, data)
        idx["conda"][key] = {
            "file": fname, "subdir": subdir, "name": info["name"], "version": str(info["version"]), "build": info["build"],
            "build_number": info.get("build_number", 0), "depends": info.get("depends") or [], "noarch": info.get("noarch"),
            "license": info.get("license"), "md5": hashlib.md5(data).hexdigest(), "sha256": hashlib.sha256(data).hexdigest(),  # noqa: S324 - conda's repodata checksum
            "size": len(data), "timestamp": info.get("timestamp"), "published_at": _now(), "published_by": _me(), "recalled": None,
        }
        _save_index(repo_id, idx)
    return idx["conda"][key]


def conda_repodata(repo_id: str, subdir: str) -> dict:
    _repo(repo_id)
    packages: dict[str, dict] = {}
    packages_conda: dict[str, dict] = {}
    removed: list[str] = []
    for key, e in _index(repo_id)["conda"].items():
        if e["subdir"] != subdir:
            continue
        if e.get("recalled"):
            removed.append(e["file"])
            continue
        entry = {k: e[k] for k in ("name", "version", "build", "build_number", "depends", "md5", "sha256", "size")} | {"subdir": subdir}
        for k in ("noarch", "license", "timestamp"):
            if e.get(k):
                entry[k] = e[k]
        (packages_conda if e["file"].endswith(".conda") else packages)[e["file"]] = entry
    return {"info": {"subdir": subdir}, "packages": packages, "packages.conda": packages_conda, "removed": sorted(removed), "repodata_version": 1}


# ------------------------------------------------------------------------------------------------
# PyPI
# ------------------------------------------------------------------------------------------------

_WHEEL = re.compile(r"^(?P<name>[A-Za-z0-9_.]+)-(?P<version>[^-]+)(-\d[^-]*)?-[^-]+-[^-]+-[^-]+\.whl$")
_SDIST = re.compile(r"^(?P<name>.+)-(?P<version>[0-9][^-]*)\.(tar\.gz|zip)$")


def _pypi_metadata(fname: str, data: bytes) -> dict:
    """Name, version, Requires-Python and Requires-Dist from a wheel's METADATA (or the sdist's PKG-INFO)."""
    text = None
    try:
        if fname.endswith(".whl"):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                meta = next((n for n in zf.namelist() if n.endswith(".dist-info/METADATA") and n.count("/") == 1), None)
                text = zf.read(meta).decode("utf-8", "replace") if meta else None
        elif fname.endswith(".tar.gz"):
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
                m = next((x for x in tf.getmembers() if x.name.count("/") == 1 and x.name.endswith("/PKG-INFO")), None)
                f = tf.extractfile(m) if m else None
                text = f.read().decode("utf-8", "replace") if f else None
        elif fname.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                meta = next((n for n in zf.namelist() if n.count("/") == 1 and n.endswith("/PKG-INFO")), None)
                text = zf.read(meta).decode("utf-8", "replace") if meta else None
    except (zipfile.BadZipFile, tarfile.TarError, OSError) as e:
        raise HTTPException(400, f"{fname} is not a Python distribution ({e})") from None
    if not text:
        raise HTTPException(400, f"{fname}: no METADATA / PKG-INFO")
    msg = Parser().parsestr(text)
    return {"name": msg.get("Name") or "", "version": msg.get("Version") or "", "requires_python": msg.get("Requires-Python"),
            "requires_dist": msg.get_all("Requires-Dist") or [], "summary": msg.get("Summary") or ""}


def publish_pypi(repo_id: str, fname: str, data: bytes, form: Optional[dict] = None) -> dict:
    _repo(repo_id, "editor")
    if not _SAFE_FILE.match(fname) or not (fname.endswith(".whl") or fname.endswith(".tar.gz") or fname.endswith(".zip")):
        raise HTTPException(400, f"{fname}: upload wheels (.whl) or source distributions (.tar.gz, .zip)")
    meta = _pypi_metadata(fname, data)
    if not meta["name"] or not meta["version"]:
        raise HTTPException(400, f"{fname}: the metadata has no Name / Version")
    if form and form.get("sha256_digest") and form["sha256_digest"] != hashlib.sha256(data).hexdigest():
        raise HTTPException(400, "sha256_digest does not match the uploaded file")
    project = norm(meta["name"])
    with _lock:
        idx = _index(repo_id)
        key = f"{project}/{fname}"
        if key in idx["pypi"]:
            raise HTTPException(409, f"{fname} is already published: artifacts cannot be replaced (publish a new version)")
        _write_file(repo_id, "pypi", key, data)
        idx["pypi"][key] = {"file": fname, "project": project, "name": meta["name"], "version": meta["version"], "requires_python": meta["requires_python"],
                            "requires_dist": meta["requires_dist"], "summary": meta["summary"], "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                            "wheel": fname.endswith(".whl"), "published_at": _now(), "published_by": _me(), "recalled": None}
        _save_index(repo_id, idx)
    return idx["pypi"][key]


# ------------------------------------------------------------------------------------------------
# Maven
# ------------------------------------------------------------------------------------------------


def _maven_path(path: str) -> str:
    parts = path.strip("/").split("/")
    if len(parts) < 2 or not all(_SAFE_SEGMENT.match(p) for p in parts):
        raise HTTPException(400, f"invalid Maven path {path}")
    return "/".join(parts)


def _maven_coord(path: str) -> Optional[tuple[str, str, str, str]]:
    """(group, artifact, version, file) of a file in the Maven layout, None for metadata above the version."""
    parts = path.split("/")
    if len(parts) < 4:
        return None
    group, artifact, version, fname = ".".join(parts[:-3]), parts[-3], parts[-2], parts[-1]
    return (group, artifact, version, fname) if fname.startswith(f"{artifact}-") else None


def publish_maven(repo_id: str, path: str, data: bytes) -> dict:
    """A file PUT into the Maven layout. Releases are immutable (a SNAPSHOT version can be republished); checksums and
    maven-metadata.xml files the client uploads are accepted and ignored (they are served computed)."""
    _repo(repo_id, "editor")
    rel = _maven_path(path)
    name = rel.rsplit("/", 1)[-1]
    if name.startswith("maven-metadata.xml") or re.search(r"\.(md5|sha1|sha256|sha512|asc)$", name):
        return {"ignored": rel}
    coord = _maven_coord(rel)
    if not coord:
        raise HTTPException(400, f"{rel} is not <group path>/<artifact>/<version>/<artifact>-<version>[...]")
    group, artifact, version, fname = coord
    # the space's Maven group: what its Projects publish is identified by it
    try:
        import governance_model

        rec = _repo(repo_id)
        prefix = governance_model.setting_for(auth.project_of(rec.get("item_id")), "maven_group")
    except Exception:  # noqa: BLE001
        prefix = None
    if prefix and not (group == prefix or group.startswith(prefix + ".")):
        raise HTTPException(400, f"Maven packages published from this space use the group {prefix} (got {group})")
    with _lock:
        idx = _index(repo_id)
        if rel in idx["maven"] and not version.endswith("-SNAPSHOT"):
            raise HTTPException(409, f"{rel} is already published: release artifacts cannot be replaced")
        _write_file(repo_id, "maven", rel, data)
        idx["maven"][rel] = {"group": group, "artifact": artifact, "version": version, "file": fname, "size": len(data),
                             "sha1": hashlib.sha1(data).hexdigest(), "sha256": hashlib.sha256(data).hexdigest(),  # noqa: S324 - Maven's checksum files
                             "published_at": _now(), "published_by": _me()}
        _save_index(repo_id, idx)
    return idx["maven"][rel]


def maven_file(repo_id: str, path: str) -> Optional[Path]:
    """A Maven file of a repository (for builds: code_java / maven.py), or None."""
    rel = _maven_path(path)
    if rel not in _index(repo_id)["maven"]:
        return None
    p = _file(repo_id, "maven", rel)
    return p if p.is_file() else None


def _maven_metadata(repo_id: str, group_path: str, artifact: str) -> Optional[str]:
    versions = sorted({e["version"] for e in _index(repo_id)["maven"].values() if e["group"].replace(".", "/") == group_path and e["artifact"] == artifact})
    if not versions:
        return None
    from packaging.version import InvalidVersion, Version

    def key(v: str):
        try:
            return (0, Version(v.replace("-SNAPSHOT", ".dev0")))
        except InvalidVersion:
            return (-1, v)

    versions.sort(key=key)
    releases = [v for v in versions if not v.endswith("-SNAPSHOT")]
    items = "".join(f"<version>{escape(v)}</version>" for v in versions)
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<metadata><groupId>{escape(group_path.replace("/", "."))}</groupId><artifactId>{escape(artifact)}</artifactId>'
            f"<versioning><latest>{escape(versions[-1])}</latest>{f'<release>{escape(releases[-1])}</release>' if releases else ''}<versions>{items}</versions>"
            f"<lastUpdated>{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}</lastUpdated></versioning></metadata>\n")


# ------------------------------------------------------------------------------------------------
# recall, search, consumers
# ------------------------------------------------------------------------------------------------


def _set_recall(repo_id: str, fmt: str, name: str, version: str, reason: Optional[str]) -> list[str]:
    _repo(repo_id, "editor")
    if fmt not in ("conda", "pypi"):
        raise HTTPException(400, "only Conda (and PyPI) artifacts can be recalled")
    n = norm(name)
    with _lock:
        idx = _index(repo_id)
        hit = [k for k, e in idx[fmt].items() if norm(e["name"]) == n and e["version"] == version]
        if not hit:
            raise HTTPException(404, f"no {fmt} artifact {name} {version}")
        for k in hit:
            idx[fmt][k]["recalled"] = {"reason": reason, "at": _now(), "by": _me()} if reason is not None else None
        _save_index(repo_id, idx)
    return hit


class RecallIn(BaseModel):
    format: str = "conda"
    name: str
    version: str
    reason: str = Field("", max_length=500)


def _docker_artifacts(rec: dict) -> list[dict]:
    out = []
    for name, img in sorted((rec.get("images") or {}).items()):
        versions = []
        for tag, digest in (img.get("tags") or {}).items():
            m = (img.get("manifests") or {}).get(digest) or {}
            versions.append({"version": tag, "files": [digest], "size": m.get("size_total") or 0, "published_at": m.get("pushed_at"), "published_by": m.get("pushed_by"), "recalled": None})
        out.append({"format": "docker", "name": name, "versions": sorted(versions, key=lambda v: v["published_at"] or "", reverse=True)})
    return out


def _grouped(idx: dict, fmt: str) -> list[dict]:
    groups: dict[str, dict] = {}
    for e in idx[fmt].values():
        name = f"{e['group']}:{e['artifact']}" if fmt == "maven" else e["name"]
        g = groups.setdefault(name, {"format": fmt, "name": name, "versions": {}})
        v = g["versions"].setdefault(e["version"], {"version": e["version"], "files": [], "size": 0, "published_at": e["published_at"], "published_by": e["published_by"], "recalled": e.get("recalled")})
        v["files"].append(e.get("subdir", "") + "/" + e["file"] if fmt == "conda" else e["file"])
        v["size"] += e["size"]
        v["published_at"] = max(v["published_at"] or "", e["published_at"] or "")
        if fmt == "conda" and e.get("depends"):
            v["depends"] = e["depends"]
    from packaging.version import InvalidVersion, Version

    def key(v: dict):
        try:
            return (1, Version(v["version"]))
        except InvalidVersion:
            return (0, Version("0"))

    return [{**g, "versions": sorted(g["versions"].values(), key=key, reverse=True)} for g in sorted(groups.values(), key=lambda g: g["name"].lower())]


def artifacts_of(repo_id: str) -> list[dict]:
    rec = _repo(repo_id)
    idx = _index(repo_id)
    return _docker_artifacts(rec) + [a for f in ("conda", "pypi", "maven") for a in _grouped(idx, f)]


def consumers(art_repo_id: str, fmt: str, name: str) -> list[dict]:
    """Code repositories with this Artifacts repository in Settings → Artifacts that require the package (Conda / PyPI:
    conda_recipe/meta.yaml; Maven: build.gradle), with the version they request."""
    import code_env
    import code_java
    import code_repos

    out = []
    for rec in code_repos.all_repos():
        if art_repo_id not in code_repos._backing(rec):
            continue
        files = rec["branches"][rec["default_branch"]]["files"]
        if fmt in ("conda", "pypi"):
            path = code_env.meta_path(files)
            if not path:
                continue
            meta = code_env.parse_meta(files[path])
            for spec in meta["run"] + meta["pip"]:
                n = re.split(r"[\s<>=!~]", spec.strip(), maxsplit=1)[0]
                if norm(n) == norm(name):
                    out.append({"repo_id": rec["id"], "repo_name": rec["name"], "requested": spec})
        elif fmt == "maven":
            for c in code_java.project_coordinates(files):
                if c.rsplit(":", 1)[0] == name:
                    out.append({"repo_id": rec["id"], "repo_name": rec["name"], "requested": c})
    return out


# ------------------------------------------------------------------------------------------------
# Code Repositories: packages of the backing Artifacts repositories as libraries
# ------------------------------------------------------------------------------------------------


def python_libraries(repo_ids: list[str]) -> dict[str, list[dict]]:
    """{package: versions} of the Conda noarch-python packages and pure-Python wheels in these repositories, shaped
    like code_repos.python_libraries (newest first; recalled versions are not ok)."""
    out: dict[str, list[dict]] = {}
    for rid in repo_ids:
        try:
            rec = _repo(rid)
        except HTTPException:
            continue
        idx = _index(rid)
        for e in idx["conda"].values():
            if e["subdir"] != "noarch":
                continue
            out.setdefault(norm(e["name"]), []).append(_lib_entry(rec, "conda", f"{e['subdir']}/{e['file']}", e))
        for e in idx["pypi"].values():
            if not e.get("wheel") or not re.search(r"-py[23][^-]*-none-any\.whl$", e["file"]):
                continue
            out.setdefault(norm(e["name"]), []).append(_lib_entry(rec, "pypi", f"{e['project']}/{e['file']}", e))
    from packaging.version import InvalidVersion, Version

    def key(v: dict):
        try:
            return Version(v["version"])
        except InvalidVersion:
            return Version("0")

    return {k: sorted(v, key=key, reverse=True) for k, v in out.items()}


def _lib_entry(rec: dict, fmt: str, key: str, e: dict) -> dict:
    recalled = e.get("recalled")
    return {"name": norm(e["name"]), "version": e["version"], "repo_id": rec["id"], "repo_name": rec["name"], "commit": None, "tagged_at": e["published_at"],
            "ok": not recalled, "reason": f"recalled: {recalled.get('reason') or 'no reason given'}" if recalled else None, "files": [],
            "artifact": {"repo_id": rec["id"], "format": fmt, "key": key}}


def extract_library(artifact: dict, dest: Path) -> Path:
    """Unpack a library artifact for sys.path: a wheel's contents, or a conda package's site-packages."""
    p = _file(artifact["repo_id"], artifact["format"], artifact["key"])
    data = p.read_bytes()
    dest.mkdir(parents=True, exist_ok=True)
    if artifact["format"] == "pypi":
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for n in zf.namelist():
                if ".." in n.split("/") or n.startswith("/"):
                    continue
                target = dest / n
                if n.endswith("/"):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(n))
        return dest
    fname = artifact["key"].rsplit("/", 1)[-1]
    if fname.endswith(".tar.bz2"):
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2")
    else:
        import zstandard

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            inner = next(n for n in zf.namelist() if n.startswith("pkg-") and n.endswith(".tar.zst"))
            raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(zf.read(inner))).read()
        tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:")
    with tf:
        for m in tf.getmembers():
            if not m.isfile() or ".." in m.name.split("/"):
                continue
            # noarch: python packages keep their modules under site-packages/
            rel = m.name.split("site-packages/", 1)[1] if "site-packages/" in m.name else None
            if not rel:
                continue
            f = tf.extractfile(m)
            if f:
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(f.read())
    return dest


# ------------------------------------------------------------------------------------------------
# API for the app (Search / Publish / Overview)
# ------------------------------------------------------------------------------------------------


@router.get("/{repo_id}/artifacts")
def list_artifacts(repo_id: str, format: Optional[str] = None, q: Optional[str] = None) -> list[dict]:
    out = artifacts_of(repo_id)
    if format:
        out = [a for a in out if a["format"] == format]
    if q:
        out = [a for a in out if q.lower() in a["name"].lower()]
    return out


@router.get("/{repo_id}/artifacts/{fmt}/{name:path}")
def artifact_detail(repo_id: str, fmt: str, name: str) -> dict:
    if fmt not in FORMATS:
        raise HTTPException(404, "unknown format")
    a = next((x for x in artifacts_of(repo_id) if x["format"] == fmt and x["name"] == name), None)
    if not a:
        raise HTTPException(404, f"no {fmt} artifact {name}")
    return {**a, "consumers": consumers(repo_id, fmt, name) if fmt in ("conda", "pypi", "maven") else []}


@router.get("/{repo_id}/overview")
def overview(repo_id: str) -> dict:
    rec = _repo(repo_id)
    arts = artifacts_of(repo_id)
    can_publish = True
    try:
        reg.get(repo_id, "editor")
    except HTTPException:
        can_publish = False
    return {"id": rec["id"], "name": rec["name"], "slug": rec["slug"], "rid": f"ri.artifacts.main.repository.{rec['id']}", "item_id": rec["item_id"],
            "path": rec.get("path"), "created_at": rec.get("created_at"), "created_by": rec.get("created_by"), "description": rec.get("description"),
            "can_publish": can_publish,
            "counts": {f: sum(1 for a in arts if a["format"] == f) for f in FORMATS},
            "versions": sum(len(a["versions"]) for a in arts), "size": sum(v.get("size") or 0 for a in arts for v in a["versions"])}


class TokenIn(BaseModel):
    format: str = "conda"


@router.post("/{repo_id}/publish-token")
def publish_token(repo_id: str, req: TokenIn) -> dict:
    """Generate token: a personal API token valid for a day, named after the repository and format."""
    rec = reg.get(repo_id, "editor")
    if req.format not in FORMATS:
        raise HTTPException(400, f"format must be one of {', '.join(FORMATS)}")
    if not auth.enabled():
        return {"token": "sign-in-is-off", "expires_at": None, "user": _me(), "slug": rec["slug"], "note": "Sign-in is off: any password is accepted"}
    tok = auth.create_token(auth.TokenIn(name=f"Publish to {rec['name']} ({req.format})", expires_days=TOKEN_DAYS))
    return {"token": tok["token"], "expires_at": tok["expires_at"], "user": _me(), "slug": rec["slug"]}


@router.post("/{repo_id}/recall")
def recall(repo_id: str, req: RecallIn) -> dict:
    if not req.reason.strip():
        raise HTTPException(400, "give the reason for recalling the artifact")
    return {"recalled": _set_recall(repo_id, req.format, req.name, req.version, req.reason.strip())}


@router.post("/{repo_id}/unrecall")
def unrecall(repo_id: str, req: RecallIn) -> dict:
    return {"unrecalled": _set_recall(repo_id, req.format, req.name, req.version, None)}


@router.post("/{repo_id}/upload/{fmt}")
async def upload(repo_id: str, fmt: str, request: Request) -> dict:
    """Publish from the browser (the Publish tab's upload): the raw file body, its name in ?file= (Conda: ?subdir=)."""
    fname = request.query_params.get("file") or ""
    data = await request.body()
    if fmt == "conda":
        return publish_conda(repo_id, request.query_params.get("subdir") or "noarch", fname, data)
    if fmt == "pypi":
        return publish_pypi(repo_id, fname, data)
    if fmt == "maven":
        return publish_maven(repo_id, request.query_params.get("path") or "", data)
    raise HTTPException(400, "upload conda, pypi or maven artifacts here (Docker images are pushed with docker push)")


# ------------------------------------------------------------------------------------------------
# package clients
# ------------------------------------------------------------------------------------------------


def _unauthorized() -> Response:
    return JSONResponse({"detail": "authenticate with a personal API token (Basic auth password, or Bearer)"}, status_code=401,
                        headers={"WWW-Authenticate": 'Basic realm="BluesandAI artifacts"'})


async def _as_client(request: Request, call):
    principal = reg._principal(request)
    if principal is None:
        return _unauthorized()
    token = auth._principal.set(principal)
    try:
        return await call()
    except HTTPException as e:
        return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    finally:
        auth._principal.reset(token)


def _slug_repo(slug: str, need: str = "viewer") -> dict:
    if need != "viewer":
        # published packages are installed into environments that run on this machine
        auth.require_code_author()
    return reg.by_slug(slug, need)


@clients.get("/{slug}/conda/{subdir}/{fname}")
async def conda_get(slug: str, subdir: str, fname: str, request: Request):
    async def call():
        rec = _slug_repo(slug)
        if fname in ("repodata.json", "current_repodata.json"):
            return JSONResponse(conda_repodata(rec["id"], subdir) if subdir in CONDA_SUBDIRS else {"info": {"subdir": subdir}, "packages": {}, "packages.conda": {}, "removed": [], "repodata_version": 1})
        if fname == "channeldata.json":
            return JSONResponse({"channeldata_version": 1, "packages": {}, "subdirs": list(CONDA_SUBDIRS)})
        e = _index(rec["id"])["conda"].get(f"{subdir}/{fname}")
        if not e:
            raise HTTPException(404, f"no {subdir}/{fname}")
        if e.get("recalled"):
            raise HTTPException(410, f"{fname} was recalled: {e['recalled'].get('reason') or ''}")
        return FileResponse(_file(rec["id"], "conda", f"{subdir}/{fname}"), media_type="application/octet-stream", filename=fname)

    return await _as_client(request, call)


@clients.put("/{slug}/conda/{subdir}/{fname}")
async def conda_put(slug: str, subdir: str, fname: str, request: Request):
    async def call():
        rec = _slug_repo(slug, "editor")
        return JSONResponse(publish_conda(rec["id"], subdir, fname, await request.body()), status_code=201)

    return await _as_client(request, call)


@clients.post("/{slug}/pypi/")
async def pypi_upload(slug: str, request: Request):
    """twine's legacy upload API (multipart form: :action=file_upload, content, sha256_digest, ...)."""
    async def call():
        rec = _slug_repo(slug, "editor")
        form = await request.form()
        if form.get(":action") not in (None, "file_upload"):
            raise HTTPException(400, f"unsupported action {form.get(':action')}")
        content = form.get("content")
        if content is None or isinstance(content, str):
            raise HTTPException(400, "no file in the content field")
        data = await content.read()
        publish_pypi(rec["id"], content.filename or "", data, {"sha256_digest": form.get("sha256_digest")})
        return Response(status_code=200)

    return await _as_client(request, call)


@clients.get("/{slug}/pypi/simple/")
async def pypi_root(slug: str, request: Request):
    async def call():
        rec = _slug_repo(slug)
        projects = sorted({e["project"] for e in _index(rec["id"])["pypi"].values()})
        links = "".join(f'<a href="{p}/">{escape(p)}</a>\n' for p in projects)
        return HTMLResponse(f"<!DOCTYPE html><html><head><meta name=\"pypi:repository-version\" content=\"1.0\"></head><body>\n{links}</body></html>")

    return await _as_client(request, call)


@clients.get("/{slug}/pypi/simple/{project}/")
async def pypi_project(slug: str, project: str, request: Request):
    async def call():
        rec = _slug_repo(slug)
        rows = [e for e in _index(rec["id"])["pypi"].values() if e["project"] == norm(project)]
        if not rows:
            raise HTTPException(404, f"no project {project}")
        links = []
        for e in sorted(rows, key=lambda x: x["file"]):
            attrs = f'href="../../files/{e["project"]}/{e["file"]}#sha256={e["sha256"]}"'
            if e.get("requires_python"):
                attrs += f' data-requires-python="{escape(e["requires_python"], {chr(34): "&quot;"})}"'
            if e.get("recalled"):
                # PEP 592: installers skip a yanked file unless it is pinned exactly
                attrs += f' data-yanked="{escape(e["recalled"].get("reason") or "recalled", {chr(34): "&quot;"})}"'
            links.append(f"<a {attrs}>{escape(e['file'])}</a><br/>")
        return HTMLResponse(f"<!DOCTYPE html><html><head><meta name=\"pypi:repository-version\" content=\"1.0\"></head><body>\n{''.join(links)}\n</body></html>")

    return await _as_client(request, call)


@clients.get("/{slug}/pypi/files/{project}/{fname}")
async def pypi_file(slug: str, project: str, fname: str, request: Request):
    async def call():
        rec = _slug_repo(slug)
        key = f"{norm(project)}/{fname}"
        if key not in _index(rec["id"])["pypi"]:
            raise HTTPException(404, f"no file {fname}")
        return FileResponse(_file(rec["id"], "pypi", key), media_type="application/octet-stream", filename=fname)

    return await _as_client(request, call)


@clients.get("/{slug}/maven/{path:path}")
async def maven_get(slug: str, path: str, request: Request):
    async def call():
        rec = _slug_repo(slug)
        rel = path.strip("/")
        base, _, algo = rel.rpartition(".")
        if algo in ("sha1", "sha256", "md5") and base:
            target = maven_bytes(rec["id"], base)
            if target is None:
                raise HTTPException(404, f"no {base}")
            return Response(hashlib.new(algo, target).hexdigest(), media_type="text/plain")
        data = maven_bytes(rec["id"], rel)
        if data is None:
            raise HTTPException(404, f"no {rel}")
        return Response(data, media_type="application/xml" if rel.endswith((".xml", ".pom")) else "application/java-archive" if rel.endswith(".jar") else "application/octet-stream")

    return await _as_client(request, call)


def maven_bytes(repo_id: str, rel: str) -> Optional[bytes]:
    if rel.endswith("/maven-metadata.xml"):
        parts = rel.split("/")
        text = _maven_metadata(repo_id, "/".join(parts[:-2]), parts[-2]) if len(parts) >= 3 else None
        return text.encode() if text else None
    p = maven_file(repo_id, rel)
    return p.read_bytes() if p else None


@clients.put("/{slug}/maven/{path:path}")
async def maven_put(slug: str, path: str, request: Request):
    async def call():
        rec = _slug_repo(slug, "editor")
        return JSONResponse(publish_maven(rec["id"], path, await request.body()), status_code=201)

    return await _as_client(request, call)


def summary(repo_id: str) -> dict[str, Any]:
    idx = _index(repo_id)
    return {f: len({(e.get("name") or e.get("artifact")) for e in idx[f].values()}) for f in ("conda", "pypi", "maven")}
