"""The Docker registry hosted in the platform (palantir.com/docs/foundry/transforms-container/container-overview).

- Artifacts repositories of type Docker: a Files item in a Project (`<name>.artifacts`, content type
  application/vnd.bluesandai.artifacts-repository+json) whose Project roles govern it: viewers pull, editors push.
- The Docker Registry HTTP API v2 / OCI Distribution API at `/v2/` (outside `/api`, so `docker login` / `push` /
  `pull` work): `docker login <host> -u <anything> -p <personal API token>` (Basic auth; the password is the token).
  Images are named `<host>/<repository slug>/<image>:<tag>`. Blobs are content-addressed on disk.
- Image requirements, checked when a manifest is pushed (and shown per tag): a numeric non-root user (5001 for bring
  your own container transforms), linux/amd64, a tag other than `latest` (or a digest), layers under ~10 GB, exposed
  ports in 1024–65535, and optionally telemetry (/bin/sh with `set` and `tee`).
- `docker save` archives (OCI layout or the classic format) can be uploaded through the API instead of pushed.
- Layers are read for the telemetry check whether they are tar, gzip or zstd compressed (OCI zstd layers).
- Garbage collection (POST /api/containers/registry/gc, administrators): blobs no manifest references any longer
  (deleted tags, failed pushes) are removed after a grace period that protects pushes in progress; with
  `delete_untagged`, manifests no tag reaches (directly or through an index) go first, except the ones a model
  version runs (referenced by digest: "kept_for_models"). A dry run reports what would go.
  It can also run on a schedule (GET / PUT /api/containers/registry/gc/schedule, administrators; off by default):
  every interval_hours with the same options, checked each minute by a background job; the last runs are kept.
"""

from __future__ import annotations

import base64
import datetime as dt
import gzip
import hashlib
import io
import json
import re
import shutil
import tarfile
import threading
import types
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

import auth
import db
import drive

router = APIRouter(prefix="/api/containers")
registry = APIRouter(prefix="/v2")

REPO_TYPE = "application/vnd.bluesandai.artifacts-repository+json"
DIR = Path("data/container-registry")
_lock = threading.RLock()

MANIFEST_TYPES = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
INDEX_TYPES = {
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
}
LAYER_LIMIT = 10 * 1024**3
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME_PART = re.compile(r"^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$")
TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "container-registry"
    for sub in ("blobs/sha256", "uploads", "repos"):
        (DIR / sub).mkdir(parents=True, exist_ok=True)
    ensure_gc_scheduler()


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


# ------------------------------------------------------------------------------------------------
# repositories (records + their Files item)
# ------------------------------------------------------------------------------------------------


def _repo_path(repo_id: str) -> Path:
    if not re.fullmatch(r"art-[0-9a-f]{10}", repo_id or ""):
        raise HTTPException(404, "no such Artifacts repository")
    return DIR / "repos" / f"{repo_id}.json"


def _load(repo_id: str) -> dict:
    p = _repo_path(repo_id)
    if not p.exists():
        raise HTTPException(404, "no such Artifacts repository")
    return json.loads(p.read_text("utf-8"))


def _save(rec: dict) -> None:
    p = _repo_path(rec["id"])
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(rec, indent=1), "utf-8")
    tmp.replace(p)


def _all() -> list[dict]:
    out = []
    for p in sorted((DIR / "repos").glob("art-*.json")):
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except ValueError:
            continue
    return out


def _access(rec: dict, need: str = "viewer") -> dict:
    """The repository when the caller has the Project role (viewer pulls, editor pushes) on its Files item."""
    item = drive._item(rec["item_id"], need=need)
    rec["path"] = "/" + "/".join(x["name"] for x in db.drive_path(item["id"])[:-1])
    return rec


def visible() -> list[dict]:
    out = []
    for rec in _all():
        try:
            out.append(_access(rec))
        except HTTPException:
            continue
    return out


def by_slug(slug: str, need: str = "viewer") -> dict:
    rec = next((r for r in _all() if r["slug"] == slug), None)
    if not rec:
        raise HTTPException(404, f"no Artifacts repository {slug}")
    return _access(rec, need)


def get(repo_id: str, need: str = "viewer") -> dict:
    return _access(_load(repo_id), need)


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "repository"
    base, i = s[:40], 2
    taken = {r["slug"] for r in _all()}
    s = base
    while s in taken:
        s = f"{base}-{i}"
        i += 1
    return s


class RepoIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    folder_id: str
    description: str = ""


def _summary(rec: dict) -> dict:
    images = rec.get("images") or {}
    return {k: rec.get(k) for k in ("id", "name", "slug", "type", "description", "item_id", "path", "created_at", "created_by")} | {
        "images": len(images), "tags": sum(len(i.get("tags") or {}) for i in images.values()),
        "size": sum(m.get("size_total") or 0 for i in images.values() for m in (i.get("manifests") or {}).values())}


@router.get("/repositories")
def list_repositories() -> list[dict]:
    return [_summary(r) for r in visible()]


@router.post("/repositories")
def create_repository(req: RepoIn) -> dict:
    folder = drive._item(req.folder_id, need="editor")
    if folder["kind"] not in ("project", "folder"):
        raise HTTPException(400, "create the Artifacts repository in a Project or a folder")
    with _lock:
        rid = "art-" + uuid.uuid4().hex[:10]
        name = req.name.strip()
        body = json.dumps({"repository_id": rid, "type": "docker"}).encode()
        item = drive._store(folder["id"], name if name.endswith(".artifacts") else f"{name}.artifacts", io.BytesIO(body), len(body), REPO_TYPE)
        rec = {"id": rid, "name": name.removesuffix(".artifacts"), "slug": _slugify(name.removesuffix(".artifacts")), "type": "docker",
               "description": req.description.strip(), "item_id": item["id"], "created_at": _now(), "created_by": _me(), "images": {}}
        _save(rec)
    return repository(rid)


@router.get("/repositories/by-item/{item_id}")
def repository_by_item(item_id: str) -> dict:
    rec = next((r for r in _all() if r["item_id"] == item_id), None)
    if not rec:
        raise HTTPException(404, "this Files item is not an Artifacts repository")
    return repository(rec["id"])


@router.get("/repositories/{repo_id}")
def repository(repo_id: str) -> dict:
    rec = get(repo_id)
    images = []
    for name, img in sorted((rec.get("images") or {}).items()):
        tags = []
        for tag, digest in sorted((img.get("tags") or {}).items(), key=lambda kv: (img["manifests"].get(kv[1]) or {}).get("pushed_at") or "", reverse=True):
            m = img["manifests"].get(digest) or {}
            tags.append({"tag": tag, "digest": digest, **{k: m.get(k) for k in ("pushed_at", "pushed_by", "size_total", "platform", "user", "ports", "layers", "media_type")},
                         "checks": requirement_checks(m, tag)})
        untagged = [{"digest": d, "pushed_at": m.get("pushed_at"), "size_total": m.get("size_total")} for d, m in img["manifests"].items() if d not in (img.get("tags") or {}).values()]
        images.append({"name": name, "tags": tags, "untagged": untagged})
    can_push = True
    try:
        drive._item(rec["item_id"], need="editor")
    except HTTPException:
        can_push = False
    return {**_summary(rec), "images_detail": images, "can_push": can_push}


@router.delete("/repositories/{repo_id}/images/{image:path}/tags/{tag}")
def delete_tag(repo_id: str, image: str, tag: str) -> dict:
    with _lock:
        rec = get(repo_id, "editor")
        img = (rec.get("images") or {}).get(image)
        if not img or tag not in img.get("tags", {}):
            raise HTTPException(404, "no such tag")
        img["tags"].pop(tag)
        rec.pop("path", None)
        _save(rec)
    return {"deleted": f"{image}:{tag}"}


# ------------------------------------------------------------------------------------------------
# blobs
# ------------------------------------------------------------------------------------------------


def blob_path(digest: str) -> Path:
    if not DIGEST.match(digest or ""):
        raise HTTPException(400, "bad digest")
    return DIR / "blobs" / "sha256" / digest[7:]


def has_blob(digest: str) -> bool:
    try:
        return blob_path(digest).exists()
    except HTTPException:
        return False


def _put_blob(data: bytes) -> str:
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    p = blob_path(digest)
    if not p.exists():
        tmp = p.with_suffix(".tmp" + uuid.uuid4().hex[:6])
        tmp.write_bytes(data)
        tmp.replace(p)
    return digest


def read_blob(digest: str) -> bytes:
    p = blob_path(digest)
    if not p.exists():
        raise HTTPException(404, f"blob {digest} is not in the registry")
    return p.read_bytes()


# ------------------------------------------------------------------------------------------------
# garbage collection
# ------------------------------------------------------------------------------------------------

GC_GRACE_S = 3600


class GcIn(BaseModel):
    dry_run: bool = True
    # also delete manifests no tag reaches (an image pushed by digest only stays unless this is on)
    delete_untagged: bool = False
    grace_seconds: int = Field(GC_GRACE_S, ge=0, le=7 * 86400)


@router.post("/registry/gc")
def garbage_collect(req: GcIn) -> dict:
    """Remove the blobs no manifest references (after the grace period), and untagged manifests when asked."""
    auth.require_admin()
    return collect(req)


def collect(req: GcIn) -> dict:
    """Garbage collection itself (the route and the schedule)."""
    import time

    # images a model version runs are referenced by digest: they stay whatever happened to their tag. Read before
    # anything is deleted: when the models cannot be read, nothing untagged is removed (the error is the run's)
    used = _model_images() if req.delete_untagged else {}
    with _lock:
        recs = _all()
        removed_manifests: list[str] = []
        kept_for_models: list[str] = []
        keep: set[str] = set()
        for rec in recs:
            changed = False
            for name, img in (rec.get("images") or {}).items():
                mans = img.get("manifests") or {}
                tagged = set((img.get("tags") or {}).values())
                pinned = {d for d in used.get((rec["id"], name), ()) if d in mans and d not in tagged}
                kept_for_models += [f"{rec.get('slug') or rec['id']}/{name}@{d}" for d in sorted(pinned)]
                tagged |= pinned
                for d in list(tagged):
                    tagged |= set((mans.get(d) or {}).get("children") or [])
                for d in list(mans):
                    if req.delete_untagged and d not in tagged:
                        removed_manifests.append(f"{rec.get('slug') or rec['id']}/{name}@{d}")
                        if not req.dry_run:
                            mans.pop(d)
                            changed = True
                        continue
                    keep.add(d)
                    m = mans[d]
                    if m.get("config_digest"):
                        keep.add(m["config_digest"])
                    keep |= {x["digest"] for x in m.get("layers") or []}
            if changed:
                _save(rec)
        root = DIR / "blobs" / "sha256"
        now = time.time()
        gone, kept_young, freed = [], 0, 0
        for p in sorted(root.glob("*")) if root.is_dir() else []:
            if not re.fullmatch(r"[0-9a-f]{64}", p.name):
                continue
            digest = "sha256:" + p.name
            if digest in keep:
                continue
            st = p.stat()
            if now - st.st_mtime < req.grace_seconds:
                kept_young += 1
                continue
            gone.append(digest)
            freed += st.st_size
            if not req.dry_run:
                p.unlink(missing_ok=True)
    return {"dry_run": req.dry_run, "deleted_blobs": len(gone), "freed_bytes": freed, "freed": _human(freed), "blobs": gone[:200],
            "deleted_manifests": removed_manifests, "kept_recent_unreferenced": kept_young, "referenced": len(keep),
            "kept_for_models": kept_for_models}


def _model_images() -> dict[tuple[str, str], set[str]]:
    """The image manifests model versions run: {(repository id, image): {digest}}."""
    import model_assets

    return model_assets.image_references()


# ------------------------------------------------------------------------------------------------
# scheduled garbage collection: a setting (administrators) and a background job checking it every minute
# ------------------------------------------------------------------------------------------------

GC_CHECK_S = 60
_gc: dict = {}


class GcScheduleIn(BaseModel):
    enabled: bool = False
    interval_hours: float = Field(24, ge=0.25, le=24 * 31)
    delete_untagged: bool = False
    grace_seconds: int = Field(GC_GRACE_S, ge=0, le=7 * 86400)


def _schedule_path() -> Path:
    return DIR / "gc-schedule.json"


def gc_schedule() -> dict:
    """The stored schedule (off by default), with its last runs."""
    p = _schedule_path()
    try:
        s = json.loads(p.read_text("utf-8")) if p.exists() else {}
    except ValueError:
        s = {}
    return {**GcScheduleIn().model_dump(), "next_run_at": None, "last_run_at": None, "runs": [], **s}


def _save_schedule(s: dict) -> None:
    p = _schedule_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(s, indent=1), "utf-8")
    tmp.replace(p)


def _iso(t: dt.datetime) -> str:
    return t.isoformat(timespec="seconds")


@router.get("/registry/gc/schedule")
def get_gc_schedule() -> dict:
    auth.require_admin()
    return {**gc_schedule(), "checker_running": bool(_gc.get("thread") and _gc["thread"].is_alive()), "check_interval_s": GC_CHECK_S}


@router.put("/registry/gc/schedule")
def put_gc_schedule(req: GcScheduleIn) -> dict:
    """Turn scheduled garbage collection on or off; the first run is one interval from now."""
    auth.require_admin()
    with _lock:
        s = gc_schedule()
        changed = any(s.get(k) != v for k, v in req.model_dump().items())
        s.update(req.model_dump(), updated_at=_now(), updated_by=_me())
        if req.enabled and (changed or not s.get("next_run_at")):
            s["next_run_at"] = _iso(dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=req.interval_hours))
        if not req.enabled:
            s["next_run_at"] = None
        _save_schedule(s)
    ensure_gc_scheduler()
    return get_gc_schedule()


def gc_tick(now: Optional[dt.datetime] = None) -> Optional[dict]:
    """Run the scheduled garbage collection when it is due (the background job calls this every GC_CHECK_S); the
    run's summary, or None. The next run is claimed before collecting, so another process checking the same
    schedule does not run it too."""
    now = now or dt.datetime.now(dt.timezone.utc)
    with _lock:
        s = gc_schedule()
        if not s.get("enabled") or not s.get("next_run_at") or dt.datetime.fromisoformat(s["next_run_at"]) > now:
            return None
        s["next_run_at"] = _iso(now + dt.timedelta(hours=float(s["interval_hours"])))
        _save_schedule(s)
    run: dict = {"at": _iso(now), "delete_untagged": bool(s.get("delete_untagged")), "grace_seconds": int(s.get("grace_seconds") or 0)}
    try:
        res = collect(GcIn(dry_run=False, delete_untagged=run["delete_untagged"], grace_seconds=run["grace_seconds"]))
        run.update({k: res[k] for k in ("deleted_blobs", "freed_bytes", "freed", "kept_recent_unreferenced", "referenced")},
                   deleted_manifests=len(res["deleted_manifests"]), kept_for_models=len(res["kept_for_models"]), ok=True)
    except Exception as e:  # noqa: BLE001 - recorded, tried again at the next run
        run.update(ok=False, error=f"{type(e).__name__}: {e}"[:1000])
    with _lock:
        s = gc_schedule()
        s.update(last_run_at=run["at"], runs=[run, *(s.get("runs") or [])][:20])
        _save_schedule(s)
    return run


def _gc_loop() -> None:
    import time

    while True:
        time.sleep(GC_CHECK_S)
        try:
            gc_tick()
            _gc.pop("error", None)
        except Exception as e:  # noqa: BLE001 - the job keeps running
            _gc["error"] = f"{type(e).__name__}: {e}"


def ensure_gc_scheduler() -> None:
    """Start the scheduled-GC checker once per process (BLUESANDAI_REGISTRY_GC_SCHEDULER=off: never)."""
    import os

    if (os.environ.get("BLUESANDAI_REGISTRY_GC_SCHEDULER") or "").lower() in ("off", "0", "false"):
        return
    with _lock:
        t = _gc.get("thread")
        if t and t.is_alive():
            return
        t = threading.Thread(target=_gc_loop, name="registry-gc-schedule", daemon=True)
        _gc["thread"] = t
        t.start()


# ------------------------------------------------------------------------------------------------
# manifests and image requirements
# ------------------------------------------------------------------------------------------------


def _uid(user: str) -> Optional[int]:
    u = (user or "").split(":", 1)[0].strip()
    return int(u) if u.isdigit() else None


def requirement_checks(m: dict, tag: Optional[str]) -> list[dict]:
    """The image requirements, for one tag of a manifest: [{id, label, status: pass | fail | warn | pending, detail}]."""
    out = []
    user = m.get("user") or ""
    uid = _uid(user)
    if uid is None:
        out.append({"id": "user", "label": "Numeric non-root user", "status": "fail",
                    "detail": "the image sets no USER (it runs as root)" if not user else f"USER {user} is not numeric: set a numeric user such as 5001"})
    elif uid == 0:
        out.append({"id": "user", "label": "Numeric non-root user", "status": "fail", "detail": "USER 0 is root"})
    else:
        out.append({"id": "user", "label": "Numeric non-root user", "status": "pass",
                    "detail": f"USER {user}" + ("" if uid == 5001 else " (bring your own container transforms need 5001)")})
    plat = m.get("platform") or ""
    out.append({"id": "platform", "label": "Built for linux/amd64", "status": "pass" if plat == "linux/amd64" else "fail",
                "detail": plat if plat == "linux/amd64" else f"built for {plat or 'an unknown platform'}: build with --platform linux/amd64"})
    if tag is None:
        out.append({"id": "tag", "label": "Pushed with a digest or a tag other than latest", "status": "pass", "detail": "referenced by digest"})
    else:
        out.append({"id": "tag", "label": "Pushed with a digest or a tag other than latest", "status": "fail" if tag == "latest" else "pass",
                    "detail": "images tagged latest are not run: push a versioned tag" if tag == "latest" else f"tag {tag}"})
    big = [x for x in m.get("layers") or [] if (x.get("size") or 0) >= LAYER_LIMIT]
    out.append({"id": "layers", "label": "Layers under ~10 GB", "status": "warn" if big else "pass",
                "detail": f"{len(big)} layer(s) of 10 GB or more" if big else f"{len(m.get('layers') or [])} layers, largest {_human(max([x.get('size') or 0 for x in m.get('layers') or []] + [0]))}"})
    ports = m.get("ports") or []
    bad = [p for p in ports if not 1024 <= p <= 65535]
    out.append({"id": "ports", "label": "Exposed ports between 1024 and 65535", "status": "fail" if bad else "pass",
                "detail": f"ports {', '.join(map(str, bad))} are reserved for root" if bad else (", ".join(map(str, ports)) or "no exposed ports")})
    tel = m.get("telemetry")
    if tel is None:
        out.append({"id": "telemetry", "label": "Telemetry (optional): /bin/sh with set and tee", "status": "pending", "detail": "checking the layers…"})
    else:
        out.append({"id": "telemetry", "label": "Telemetry (optional): /bin/sh with set and tee", "status": "pass" if tel.get("ok") else "warn", "detail": tel.get("detail")})
    return out


def runnable(m: dict, tag: Optional[str]) -> Optional[str]:
    """Why an image cannot run, or None."""
    bad = [c for c in requirement_checks(m, tag) if c["status"] == "fail"]
    return "; ".join(f"{c['label']}: {c['detail']}" for c in bad) or None


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _describe(manifest: dict, raw_len: int) -> dict:
    """What a pushed image manifest says (its config blob must be present)."""
    cfg_digest = manifest["config"]["digest"]
    cfg = json.loads(read_blob(cfg_digest))
    c = cfg.get("config") or {}
    ports = sorted({int(k.split("/")[0]) for k in (c.get("ExposedPorts") or {}) if k.split("/")[0].isdigit()})
    layers = [{"digest": x["digest"], "size": x.get("size") or 0, "media_type": x.get("mediaType")} for x in manifest.get("layers") or []]
    return {"config_digest": cfg_digest, "platform": f"{cfg.get('os', '?')}/{cfg.get('architecture', '?')}" + (f"/{cfg['variant']}" if cfg.get("variant") else ""),
            "user": c.get("User") or "", "ports": ports, "entrypoint": c.get("Entrypoint"), "cmd": c.get("Cmd"), "env": c.get("Env") or [],
            "workdir": c.get("WorkingDir") or "", "layers": layers, "size_total": raw_len + (manifest["config"].get("size") or 0) + sum(x["size"] for x in layers)}


def _telemetry(layers: list[dict]) -> dict:
    """Whether the image has /bin/sh and tee (telemetry logging uses `set` and `tee` from /bin/sh)."""
    found: set[str] = set()
    for layer in layers:
        p = blob_path(layer["digest"])
        try:
            for ti in _layer_members(p):
                n = ti.name.lstrip("./")
                if n in ("bin/sh", "usr/bin/sh", "bin/tee", "usr/bin/tee", "bin/busybox", "usr/bin/busybox", "bin"):
                    found.add(n if n != "bin" or not ti.issym() else "bin->usr/bin")
        except (tarfile.TarError, OSError, EOFError, ValueError) as e:
            return {"ok": False, "detail": f"could not read a layer: {e}"}
    merged = "bin->usr/bin" in found
    sh = "bin/sh" in found or (merged and "usr/bin/sh" in found)
    tee = bool({"bin/tee", "usr/bin/tee"} & found) or bool({"bin/busybox", "usr/bin/busybox"} & found)
    if sh and tee:
        return {"ok": True, "detail": "/bin/sh and tee are present"}
    return {"ok": False, "detail": "no /bin/sh in the image" if not sh else "no tee in the image"}


def _layer_members(p: Path):
    """The tar entries of a layer blob: plain tar, gzip or zstd (read as a stream)."""
    with open(p, "rb") as f:
        head = f.read(4)
    if head == b"\x28\xb5\x2f\xfd":
        import zstandard

        with open(p, "rb") as f, zstandard.ZstdDecompressor().stream_reader(f) as reader, tarfile.open(fileobj=reader, mode="r|") as tf:
            yield from tf
        return
    with tarfile.open(p, "r:gz" if head[:2] == b"\x1f\x8b" else "r:") as tf:
        yield from tf


def _check_telemetry_later(repo_id: str, image: str, digest: str, layers: list[dict]) -> None:
    def work():
        res = _telemetry(layers)
        with _lock:
            try:
                rec = _load(repo_id)
            except HTTPException:
                return
            m = ((rec.get("images") or {}).get(image) or {}).get("manifests", {}).get(digest)
            if m is not None:
                m["telemetry"] = res
                _save(rec)

    threading.Thread(target=work, daemon=True).start()


def store_manifest(rec: dict, image: str, reference: str, raw: bytes, media_type: str, background: bool = True) -> str:
    """Record a pushed manifest (and its tag); every blob it references must be in the registry."""
    try:
        manifest = json.loads(raw)
    except ValueError:
        raise _err(400, "MANIFEST_INVALID", "the manifest is not JSON") from None
    media_type = manifest.get("mediaType") or media_type
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if DIGEST.match(reference) and reference != digest:
        raise _err(400, "DIGEST_INVALID", "the manifest does not match its digest")
    if not DIGEST.match(reference) and not TAG.match(reference):
        raise _err(400, "TAG_INVALID", f"invalid tag {reference}")
    entry: dict[str, Any] = {"media_type": media_type, "pushed_at": _now(), "pushed_by": _me(), "size": len(raw)}
    if media_type in INDEX_TYPES or "manifests" in manifest:
        children = manifest.get("manifests") or []
        img = (rec.get("images") or {}).get(image) or {}
        missing = [c["digest"] for c in children if c["digest"] not in (img.get("manifests") or {})]
        if missing:
            raise _err(400, "MANIFEST_BLOB_UNKNOWN", f"push the platform manifests first: {', '.join(missing[:3])}")
        amd = next((c for c in children if (c.get("platform") or {}).get("os") == "linux" and (c.get("platform") or {}).get("architecture") == "amd64"), None)
        entry.update(index=True, children=[c["digest"] for c in children], platform="linux/amd64" if amd else "",
                     amd64=amd["digest"] if amd else None)
        if amd:
            child = img["manifests"][amd["digest"]]
            entry.update({k: child.get(k) for k in ("user", "ports", "layers", "size_total", "config_digest", "telemetry")})
    else:
        refs = [manifest.get("config", {}).get("digest"), *[x.get("digest") for x in manifest.get("layers") or []]]
        missing = [d for d in refs if not d or not has_blob(d)]
        if missing:
            raise _err(400, "MANIFEST_BLOB_UNKNOWN", f"blobs not pushed yet: {', '.join(str(d) for d in missing[:3])}")
        entry.update(_describe(manifest, len(raw)))
    _put_blob(raw)
    with _lock:
        fresh = _load(rec["id"])
        img = fresh.setdefault("images", {}).setdefault(image, {"tags": {}, "manifests": {}})
        if digest in img["manifests"]:
            entry["telemetry"] = img["manifests"][digest].get("telemetry", entry.get("telemetry"))
        img["manifests"][digest] = entry
        if not DIGEST.match(reference):
            img["tags"][reference] = digest
        _save(fresh)
    if not entry.get("index") and entry.get("telemetry") is None:
        if background:
            _check_telemetry_later(rec["id"], image, digest, entry["layers"])
        else:
            with _lock:
                fresh = _load(rec["id"])
                fresh["images"][image]["manifests"][digest]["telemetry"] = _telemetry(entry["layers"])
                _save(fresh)
    return digest


def resolve(rec: dict, image: str, reference: str) -> tuple[str, dict]:
    """(digest, manifest entry) of image:tag or image@digest; an index resolves to its linux/amd64 manifest."""
    img = (rec.get("images") or {}).get(image)
    if not img:
        raise HTTPException(404, f"no image {image} in {rec['name']}")
    digest = reference if DIGEST.match(reference) else img["tags"].get(reference)
    if not digest or digest not in img["manifests"]:
        raise HTTPException(404, f"no {image}:{reference} in {rec['name']}")
    m = img["manifests"][digest]
    if m.get("index"):
        if not m.get("amd64"):
            raise HTTPException(400, f"{image}:{reference} has no linux/amd64 image")
        return m["amd64"], img["manifests"][m["amd64"]]
    return digest, m


# ------------------------------------------------------------------------------------------------
# the registry API (/v2)
# ------------------------------------------------------------------------------------------------


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"errors": [{"code": code, "message": message}]})


REGISTRY_HEADERS = {"Docker-Distribution-API-Version": "registry/2.0"}


class _TokenRequest:
    """What auth._principal_for reads, for a token presented as a Basic auth password."""

    def __init__(self, token: str) -> None:
        self.headers = {"authorization": f"Bearer {token}"}
        self.cookies: dict = {}
        self.method = "GET"
        self.state = types.SimpleNamespace()


def _principal(request: Request) -> Optional[dict]:
    if not auth.enabled():
        return {"id": "system", "username": "system", "role": "service", "markings": None, "service": True}
    header = request.headers.get("authorization", "")
    token = ""
    if header.lower().startswith("basic "):
        try:
            token = base64.b64decode(header[6:].strip()).decode().split(":", 1)[1]
        except (ValueError, IndexError, UnicodeDecodeError):
            token = ""
    elif header.lower().startswith("bearer "):
        token = header[7:].strip()
    return auth._principal_for(_TokenRequest(token)) if token else None


def _challenge() -> JSONResponse:
    return JSONResponse({"errors": [{"code": "UNAUTHORIZED", "message": "docker login with a personal API token as the password"}]}, status_code=401,
                        headers={**REGISTRY_HEADERS, "WWW-Authenticate": 'Basic realm="BluesandAI registry"'})


def _split(name: str) -> tuple[str, str]:
    parts = name.strip("/").split("/")
    if len(parts) < 2 or not all(NAME_PART.match(p) for p in parts):
        raise _err(404, "NAME_UNKNOWN", f"images are named <repository>/<image>: {name}")
    return parts[0], "/".join(parts[1:])


async def _authed(request: Request, call):
    principal = _principal(request)
    if principal is None:
        return _challenge()
    token = auth._principal.set(principal)
    try:
        res = await call()
        if isinstance(res, Response):
            res.headers.update(REGISTRY_HEADERS)
        return res
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) and "errors" in e.detail else {"errors": [{"code": "DENIED" if e.status_code == 403 else "NAME_UNKNOWN" if e.status_code == 404 else "UNSUPPORTED", "message": str(e.detail)}]}
        return JSONResponse(detail, status_code=e.status_code, headers=REGISTRY_HEADERS)
    finally:
        auth._principal.reset(token)


@registry.get("/")
async def ping(request: Request):
    async def call():
        return JSONResponse({})

    return await _authed(request, call)


@registry.get("/_catalog")
async def catalog(request: Request):
    async def call():
        return JSONResponse({"repositories": sorted(f"{r['slug']}/{i}" for r in visible() for i in (r.get("images") or {}))})

    return await _authed(request, call)


@registry.get("/{name:path}/tags/list")
async def tags_list(name: str, request: Request):
    async def call():
        slug, image = _split(name)
        rec = by_slug(slug)
        img = (rec.get("images") or {}).get(image)
        if not img:
            raise _err(404, "NAME_UNKNOWN", f"no image {name}")
        return JSONResponse({"name": name, "tags": sorted(img["tags"])})

    return await _authed(request, call)


def _manifest_response(rec: dict, image: str, reference: str, head: bool) -> Response:
    img = (rec.get("images") or {}).get(image) or {}
    digest = reference if DIGEST.match(reference) else (img.get("tags") or {}).get(reference)
    if not digest or digest not in (img.get("manifests") or {}):
        raise _err(404, "MANIFEST_UNKNOWN", f"no manifest {image}:{reference}")
    m = img["manifests"][digest]
    data = read_blob(digest)
    headers = {"Docker-Content-Digest": digest, "Content-Length": str(len(data)), "Content-Type": m["media_type"]}
    return Response(b"" if head else data, headers=headers, media_type=m["media_type"])


@registry.api_route("/{name:path}/manifests/{reference}", methods=["GET", "HEAD"])
async def get_manifest(name: str, reference: str, request: Request):
    async def call():
        slug, image = _split(name)
        return _manifest_response(by_slug(slug), image, reference, request.method == "HEAD")

    return await _authed(request, call)


@registry.put("/{name:path}/manifests/{reference}")
async def put_manifest(name: str, reference: str, request: Request):
    async def call():
        slug, image = _split(name)
        rec = by_slug(slug, "editor")
        raw = await request.body()
        digest = store_manifest(rec, image, reference, raw, request.headers.get("content-type", "").split(";")[0])
        return Response(status_code=201, headers={"Location": f"/v2/{name}/manifests/{digest}", "Docker-Content-Digest": digest})

    return await _authed(request, call)


@registry.delete("/{name:path}/manifests/{reference}")
async def delete_manifest(name: str, reference: str, request: Request):
    async def call():
        slug, image = _split(name)
        with _lock:
            rec = by_slug(slug, "editor")
            img = (rec.get("images") or {}).get(image) or {}
            if DIGEST.match(reference):
                if reference not in (img.get("manifests") or {}):
                    raise _err(404, "MANIFEST_UNKNOWN", "no such manifest")
                img["manifests"].pop(reference)
                img["tags"] = {t: d for t, d in img["tags"].items() if d != reference}
            elif reference in (img.get("tags") or {}):
                img["tags"].pop(reference)
            else:
                raise _err(404, "MANIFEST_UNKNOWN", "no such tag")
            rec.pop("path", None)
            _save(rec)
        return Response(status_code=202)

    return await _authed(request, call)


def _upload_path(upload_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
        raise _err(404, "BLOB_UPLOAD_UNKNOWN", "no such upload")
    return DIR / "uploads" / upload_id


async def _append(request: Request, path: Path) -> int:
    with open(path, "ab") as f:
        async for chunk in request.stream():
            f.write(chunk)
    return path.stat().st_size


def _finish(path: Path, digest: str) -> None:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if "sha256:" + h.hexdigest() != digest:
        path.unlink(missing_ok=True)
        raise _err(400, "DIGEST_INVALID", "the uploaded content does not match its digest")
    target = blob_path(digest)
    if target.exists():
        path.unlink(missing_ok=True)
    else:
        shutil.move(str(path), str(target))


@registry.post("/{name:path}/blobs/uploads/")
async def start_upload(name: str, request: Request):
    async def call():
        slug, _ = _split(name)
        by_slug(slug, "editor")
        mount = request.query_params.get("mount")
        if mount and has_blob(mount):
            return Response(status_code=201, headers={"Location": f"/v2/{name}/blobs/{mount}", "Docker-Content-Digest": mount})
        upload_id = uuid.uuid4().hex
        path = _upload_path(upload_id)
        path.write_bytes(b"")
        digest = request.query_params.get("digest")
        if digest:
            await _append(request, path)
            _finish(path, digest)
            return Response(status_code=201, headers={"Location": f"/v2/{name}/blobs/{digest}", "Docker-Content-Digest": digest})
        return Response(status_code=202, headers={"Location": f"/v2/{name}/blobs/uploads/{upload_id}", "Range": "0-0", "Docker-Upload-UUID": upload_id})

    return await _authed(request, call)


@registry.api_route("/{name:path}/blobs/uploads/{upload_id}", methods=["PATCH", "PUT", "GET", "DELETE"])
async def upload(name: str, upload_id: str, request: Request):
    async def call():
        slug, _ = _split(name)
        by_slug(slug, "editor")
        path = _upload_path(upload_id)
        if not path.exists():
            raise _err(404, "BLOB_UPLOAD_UNKNOWN", "no such upload")
        if request.method == "DELETE":
            path.unlink(missing_ok=True)
            return Response(status_code=204)
        if request.method == "GET":
            size = path.stat().st_size
            return Response(status_code=204, headers={"Range": f"0-{max(0, size - 1)}", "Docker-Upload-UUID": upload_id})
        size = await _append(request, path)
        if request.method == "PATCH":
            return Response(status_code=202, headers={"Location": f"/v2/{name}/blobs/uploads/{upload_id}", "Range": f"0-{max(0, size - 1)}", "Docker-Upload-UUID": upload_id})
        digest = request.query_params.get("digest") or ""
        if not DIGEST.match(digest):
            raise _err(400, "DIGEST_INVALID", "PUT needs ?digest=sha256:…")
        _finish(path, digest)
        return Response(status_code=201, headers={"Location": f"/v2/{name}/blobs/{digest}", "Docker-Content-Digest": digest})

    return await _authed(request, call)


@registry.api_route("/{name:path}/blobs/{digest}", methods=["GET", "HEAD"])
async def get_blob(name: str, digest: str, request: Request):
    async def call():
        slug, _ = _split(name)
        by_slug(slug)
        if not DIGEST.match(digest) or not has_blob(digest):
            raise _err(404, "BLOB_UNKNOWN", f"no blob {digest}")
        p = blob_path(digest)
        headers = {"Docker-Content-Digest": digest, "Content-Length": str(p.stat().st_size)}
        if request.method == "HEAD":
            return Response(headers=headers, media_type="application/octet-stream")
        return FileResponse(p, headers={"Docker-Content-Digest": digest}, media_type="application/octet-stream")

    return await _authed(request, call)


# ------------------------------------------------------------------------------------------------
# docker save archives
# ------------------------------------------------------------------------------------------------


def import_archive(rec: dict, fileobj, image: Optional[str], tag: Optional[str]) -> list[dict]:
    """Store the images of a `docker save` archive: OCI layout (index.json + blobs/) or the classic format
    (manifest.json + layer tars). Returns [{image, tag, digest}]."""
    out = []
    with tarfile.open(fileobj=fileobj, mode="r:*") as tf:
        members = {m.name.lstrip("./"): m for m in tf.getmembers() if m.isfile()}

        def read(name: str) -> bytes:
            m = members.get(name.lstrip("./"))
            if not m:
                raise HTTPException(400, f"the archive has no {name}")
            return tf.extractfile(m).read()  # type: ignore[union-attr]

        refs: list[tuple[Optional[str], str]] = []
        if "index.json" in members and any(n.startswith("blobs/sha256/") for n in members):
            for n in members:
                if n.startswith("blobs/sha256/"):
                    p = blob_path("sha256:" + n.rsplit("/", 1)[1])
                    if not p.exists():
                        with tf.extractfile(members[n]) as src, open(p, "wb") as dst:  # type: ignore[union-attr]
                            shutil.copyfileobj(src, dst)
            index = json.loads(read("index.json"))
            for d in index.get("manifests") or []:
                ann = d.get("annotations") or {}
                ref = ann.get("io.containerd.image.name") or ann.get("org.opencontainers.image.ref.name")
                refs.append((ref, d["digest"]))
            for ref, digest in refs:
                raw = read_blob(digest)
                mt = json.loads(raw).get("mediaType") or "application/vnd.oci.image.manifest.v1+json"
                if mt in INDEX_TYPES:
                    for c in json.loads(raw).get("manifests") or []:
                        if has_blob(c["digest"]):
                            child = read_blob(c["digest"])
                            if all(has_blob(x["digest"]) for x in json.loads(child).get("layers") or []):
                                store_manifest(rec, *_name_tag(ref, image, tag)[:1], c["digest"], child, json.loads(child).get("mediaType") or "application/vnd.oci.image.manifest.v1+json", background=False)
                name, t = _name_tag(ref, image, tag)
                d = store_manifest(rec, name, t, raw, mt, background=False)
                out.append({"image": name, "tag": t, "digest": d})
        elif "manifest.json" in members:
            for entry in json.loads(read("manifest.json")):
                cfg = read(entry["Config"])
                cfg_digest = _put_blob(cfg)
                layers = []
                for layer in entry["Layers"]:
                    data = read(layer)
                    layers.append({"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": _put_blob(data), "size": len(data)})
                manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                            "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": cfg_digest, "size": len(cfg)}, "layers": layers}
                raw = json.dumps(manifest, separators=(",", ":")).encode()
                for ref in entry.get("RepoTags") or [None]:
                    name, t = _name_tag(ref, image, tag)
                    d = store_manifest(rec, name, t, raw, manifest["mediaType"], background=False)
                    out.append({"image": name, "tag": t, "digest": d})
        else:
            raise HTTPException(400, "not a docker save archive (no index.json or manifest.json)")
    return out


def _name_tag(ref: Optional[str], image: Optional[str], tag: Optional[str]) -> tuple[str, str]:
    name, t = None, None
    if ref and ":" in ref.rsplit("/", 1)[-1]:
        name, t = ref.rsplit(":", 1)
    elif ref:
        name = ref
    name = (image or (name or "").rsplit("/", 1)[-1] or "").strip().lower()
    t = (tag or t or "").strip()
    if not name or not all(NAME_PART.match(p) for p in name.split("/")):
        raise HTTPException(400, f"name the image (got {name or 'nothing'}): lowercase letters, digits, . _ -")
    if not t or not TAG.match(t):
        raise HTTPException(400, "give the image a tag (not latest), such as 0.0.1")
    return name, t


@router.post("/repositories/{repo_id}/images/upload")
def upload_archive(repo_id: str, file: UploadFile = File(...), image: Optional[str] = Form(None), tag: Optional[str] = Form(None)) -> dict:
    """Upload a `docker save -o image.tar <image>:<tag>` archive (instead of docker push)."""
    rec = get(repo_id, "editor")
    if gzip_magic(file.file):
        data = gzip.GzipFile(fileobj=file.file)
        stored = import_archive(rec, io.BytesIO(data.read()), image, tag)
    else:
        stored = import_archive(rec, file.file, image, tag)
    return {"stored": stored, "repository": repository(repo_id)}


def gzip_magic(f) -> bool:
    pos = f.tell()
    head = f.read(2)
    f.seek(pos)
    return head == b"\x1f\x8b"


# ------------------------------------------------------------------------------------------------
# the container runtime
# ------------------------------------------------------------------------------------------------


@router.get("/runtime")
def runtime_info() -> dict:
    """Where sidecar containers run (Docker on this machine or in WSL), the running sidecars, and the push relay."""
    import container_runtime

    return container_runtime.info()


@router.post("/runtime/relay")
def start_relay() -> dict:
    """Start the WSL relay so `docker push 127.0.0.1:<port>/…` from WSL reaches this registry."""
    import container_runtime

    return container_runtime.relay_start()


# ------------------------------------------------------------------------------------------------
# Code Repositories: images a transform can use (Settings → Libraries → Artifacts repositories)
# ------------------------------------------------------------------------------------------------


def find_image(repo_ids: list[str], image: str, tag: str) -> tuple[dict, str, dict]:
    """(repository, digest, manifest) of image:tag in the first of these Artifacts repositories that has it."""
    searched = []
    for rid in repo_ids:
        try:
            rec = get(rid)
        except HTTPException:
            continue
        searched.append(rec["name"])
        if image in (rec.get("images") or {}):
            digest, m = resolve(rec, image, tag)
            return rec, digest, m
    where = f" ({', '.join(searched)})" if searched else ""
    raise HTTPException(400, f"no image {image}:{tag} in the Artifacts repositories of this code repository{where}: add the repository holding it "
                             "in Settings → Libraries")


def oci_layout(digest: str, m: dict, ref: str, dest: Path) -> None:
    """Write an OCI image layout tar of one image (docker load reads it) to dest."""
    raw = read_blob(digest)
    index = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
             "manifests": [{"mediaType": m["media_type"], "digest": digest, "size": len(raw),
                            "annotations": {"io.containerd.image.name": ref, "org.opencontainers.image.ref.name": ref.rsplit(":", 1)[-1]}}]}
    blobs = [digest, m["config_digest"], *[x["digest"] for x in m.get("layers") or []]]
    with tarfile.open(dest, "w") as tf:
        def add(name: str, data: bytes) -> None:
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))

        add("oci-layout", b'{"imageLayoutVersion":"1.0.0"}')
        add("index.json", json.dumps(index).encode())
        for d in dict.fromkeys(blobs):
            tf.add(str(blob_path(d)), arcname=f"blobs/sha256/{d[7:]}")
