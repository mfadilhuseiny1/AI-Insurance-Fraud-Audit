"""Cipher (Security & Governance → Cipher): encrypt, decrypt and hash data with Channels and Licenses.

A Cipher Channel (ri.bellaso.main.cipher-channel.<id>) is a Files item: an algorithm (cipher_crypto.ALGORITHMS) and its
key material — a key stretched from a secret (scrypt), a single base64 key, a hashing pepper, or a visual
obfuscation seed — sealed with secretbox and never returned. Its Project's Editors create channels; its Owners (and
administrators) issue licenses.

A Cipher License (ri.bellaso.main.cipher-license.<id>) is a Files item too: viewing it is what grants its
operations. Each belongs to one channel:
  operational   single values in the applications (Object Explorer, Workshop, Functions): every value audited,
                optional rate limit per user, Checkpoints apply (cipher_encrypt / cipher_decrypt) unless the license
                bypasses them for callers that cannot show one (functions, API calls)
  data_manager  whole columns in Pipeline Builder (Cipher encrypt / decrypt / hash steps) and Contour (Cipher board)
  admin         columns in Python transforms (bellaso_python_lib's EncrypterInput / DecrypterInput / HasherInput) —
                the transform gets the key, so this effectively grants key access
with permissions encrypt (and hash) and / or decrypt, and an optional expiry.
Licenses made before channels existed ("legacy": a key of their own, a list of users) keep working for media
transforms (code_media.py, Control Panel → Cipher licenses).

Mounted by server.py under /api/cipher.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import cipher_crypto as cc
import rate_limits
import secretbox

router = APIRouter(prefix="/api/cipher")
RID = "ri.bellaso.main.cipher-license."
CHANNEL_RID = cc.CHANNEL_RID
CHANNEL_TYPE = "application/vnd.bluesandai.cipher-channel+json"
LICENSE_TYPE = "application/vnd.bluesandai.cipher-license+json"
DIR: Path = Path("data/cipher")
_lock = threading.Lock()
KINDS = ("operational", "data_manager", "admin")


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "cipher"
    DIR.mkdir(parents=True, exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _all() -> list[dict]:
    p = DIR / "licenses.json"
    return json.loads(p.read_text("utf-8")) if p.is_file() else []


def _save(rows: list[dict]) -> None:
    (DIR / "licenses.json").write_text(json.dumps(rows, indent=1), "utf-8")


def _channels() -> list[dict]:
    p = DIR / "channels.json"
    return json.loads(p.read_text("utf-8")) if p.is_file() else []


def _save_channels(rows: list[dict]) -> None:
    (DIR / "channels.json").write_text(json.dumps(rows, indent=1), "utf-8")


def _public(r: dict) -> dict:
    return {k: v for k, v in r.items() if k != "sealed"} | {"rid": RID + r["id"], "kind": r.get("kind") or "legacy"}


def _public_channel(c: dict) -> dict:
    return {k: v for k, v in c.items() if k != "sealed"} | {"rid": CHANNEL_RID + c["id"]}


def _strip(ref: str, prefix: str) -> str:
    return ref[len(prefix):] if ref.startswith(prefix) else ref


def _find(ref: str) -> dict:
    """A license by rid, id, Files item id or Files path."""
    ref = (ref or "").strip()
    lid = _strip(ref, RID)
    rows = _all()
    r = next((x for x in rows if x["id"] == lid or x.get("item_id") == ref), None)
    if not r and "/" in ref:
        try:
            import code_repos

            item = code_repos.resolve_dataset(ref)
            r = next((x for x in rows if x.get("item_id") == item["id"]), None)
        except Exception:  # noqa: BLE001
            r = None
    if not r:
        raise HTTPException(404, f"no Cipher license {ref}")
    return r


def _channel(ref: str) -> dict:
    cid = _strip((ref or "").strip(), CHANNEL_RID)
    c = next((x for x in _channels() if x["id"] == cid or x.get("item_id") == ref), None)
    if not c:
        raise HTTPException(404, f"no Cipher channel {ref}")
    return c


def _material(c: dict) -> dict:
    """{algorithm, channel_rid, key (base64)}: the channel's key (or pepper) for cipher_crypto.Operator."""
    sealed = secretbox.unseal(base64.b64decode(c["sealed"]))
    return {"algorithm": c["algorithm"], "channel_rid": CHANNEL_RID + c["id"], "key": sealed["key"]}


def _item_access(item_id: Optional[str], need: str = "viewer") -> bool:
    if not item_id:
        return True
    try:
        import drive

        drive._item(item_id, need=need)
        return True
    except HTTPException:
        return False


def _usable(r: dict, p: Optional[dict] = None) -> Optional[str]:
    """Why the caller cannot use a license (None: they can)."""
    p = p or auth.current()
    if r.get("expires_at") and r["expires_at"] < _now():
        return f'the Cipher license "{r["name"]}" expired on {r["expires_at"][:10]}'
    if (r.get("kind") or "legacy") == "legacy":
        if auth.enabled() and r.get("users"):
            if not p or (p.get("id") not in r["users"] and p.get("username") not in r["users"]):
                return f'the Cipher license "{r["name"]}" is not granted to you'
        return None
    if p and p.get("service"):
        return None
    if not _item_access(r.get("item_id")):
        return f'you cannot view the Cipher license "{r["name"]}" (viewing a license grants its operations)'
    return None


def _check(r: dict, operation: str, kinds: tuple[str, ...]) -> None:
    why = _usable(r)
    if why:
        raise HTTPException(403, why)
    kind = r.get("kind") or "legacy"
    if kind not in kinds:
        names = {"operational": "Operational User", "data_manager": "Data Manager", "admin": "Admin", "legacy": "media"}
        raise HTTPException(403, f'"{r["name"]}" is a{"n" if kind in ("operational", "admin") else ""} {names[kind]} license: use '
                                 + " or ".join(names[k] for k in kinds) + " licenses here")
    ops = set(r.get("operations") or [])
    if operation == "hash":
        operation = "encrypt"
    if operation not in ops:
        raise HTTPException(403, f'the Cipher license "{r["name"]}" does not allow {operation}')


def _audit(r: dict, operation: str, count: int, detail: str = "") -> None:
    try:
        import audit3

        audit3.emit(f"CIPHER_{operation.upper()}", ["secretUse"], {"usedSecretOperation": operation, "usedSecretIdentifiers": [RID + r["id"]],
                                                                   "valueCount": count, "channel": CHANNEL_RID + (r.get("channel_id") or ""), "context": detail},
                    product="cipher")
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------------------------------------
# channels
# ------------------------------------------------------------------------------------------------


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    folder_id: str
    algorithm: Literal["AES_GCM_SIV", "AES_SIV", "SHA256", "SHA512", "VISUAL"] = "AES_SIV"
    key_mode: Literal["derived", "single"] = "derived"
    # the secret to stretch (derived), the base64 key (single), the hash pepper or the visual seed; empty: generated
    secret: str = ""
    description: str = ""


def _store_item(folder_id: str, name: str, ctype: str, record: dict) -> dict:
    import drive

    drive._item(folder_id, need="editor")
    data = json.dumps(record, indent=1).encode()
    return drive.save_bytes(folder_id, name, data, ctype)


@router.post("/channels")
def create_channel(req: ChannelIn) -> dict:
    p = auth.require_user()
    cid = uuid.uuid4().hex[:12]
    secret = req.secret.strip() or cc.generate_secret(req.algorithm)
    try:
        if req.algorithm in cc.HASHING:
            if len(secret) < 14:
                raise ValueError("a hash secret is at least 14 characters (randomly generated)")
            key = secret.encode()
        elif req.algorithm == "VISUAL":
            key = cc.visual_key(secret)
        elif req.key_mode == "single":
            key = cc.single_key(req.algorithm, secret)
        else:
            key = cc.derive_key(req.algorithm, secret, cid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    c = {"id": cid, "name": req.name.strip(), "description": req.description, "algorithm": req.algorithm,
         "key_mode": req.key_mode if req.algorithm in cc.ENCRYPTION else ("pepper" if req.algorithm in cc.HASHING else "seed"),
         "created_by": p.get("username"), "created_at": _now(), "item_id": None,
         "sealed": base64.b64encode(secretbox.seal({"key": base64.b64encode(key).decode()})).decode()}
    item = _store_item(req.folder_id, f"{c['name']}.cipher-channel", CHANNEL_TYPE, {"rid": CHANNEL_RID + cid, "algorithm": req.algorithm})
    c["item_id"] = item["id"]
    with _lock:
        rows = _channels()
        rows.append(c)
        _save_channels(rows)
    auth.audit("cipher_channel_created", None, f"{c['name']} ({req.algorithm})")
    return _public_channel(c)


@router.get("/channels")
def list_channels() -> list[dict]:
    auth.require_user()
    out = []
    for c in _channels():
        if _item_access(c.get("item_id")):
            n = sum(1 for r in _all() if r.get("channel_id") == c["id"])
            out.append({**_public_channel(c), "licenses": n, "can_manage": _item_access(c.get("item_id"), "owner")})
    return out


@router.get("/channels/{cid}")
def get_channel(cid: str) -> dict:
    auth.require_user()
    c = _channel(cid)
    if not _item_access(c.get("item_id")):
        raise HTTPException(403, "You cannot view this Cipher channel")
    lic = [_public(r) for r in _all() if r.get("channel_id") == c["id"]]
    return {**_public_channel(c), "licenses": lic, "can_manage": _item_access(c.get("item_id"), "owner")}


# -- Marketplace: a channel and its licenses as a product; installing makes a new key --


@router.get("/channels/{cid}/package")
def package_channel(cid: str) -> dict:
    """A Marketplace product with the channel (its algorithm, never its key) and its licenses (kind, operations,
    rate limit, expiry). Owners of the channel."""
    c = _channel(cid)
    if not _item_access(c.get("item_id"), "owner"):
        raise HTTPException(403, "Packaging a channel needs the Owner role on it")
    lic = [{k: r.get(k) for k in ("name", "description", "kind", "operations", "rate_limit", "bypass_checkpoints", "expires_at")}
           for r in _all() if r.get("channel_id") == c["id"] and not r.get("revoked")]
    return {"kind": "bluesandai.cipher.product", "version": 1, "name": c["name"], "packaged_at": _now(), "packaged_by": (auth.current() or {}).get("username"),
            "channel": {"name": c["name"], "algorithm": c["algorithm"], "description": c.get("description") or ""}, "licenses": lic}


class CipherInstallIn(BaseModel):
    package: dict
    folder_id: str
    name: Optional[str] = None


@router.post("/install")
def install_channel(req: CipherInstallIn) -> dict:
    """Install a packaged channel: the same algorithm with a newly generated key (installations never share keys),
    and its licenses with the same kinds, operations, rate limits and expiry dates."""
    pk = req.package
    if pk.get("kind") != "bluesandai.cipher.product" or not isinstance(pk.get("channel"), dict):
        raise HTTPException(400, "not a Cipher product")
    ch = pk["channel"]
    made = create_channel(ChannelIn(name=(req.name or ch.get("name") or "Installed channel").strip(), folder_id=req.folder_id,
                                    algorithm=ch.get("algorithm") or "AES_SIV", key_mode="derived", secret="", description=ch.get("description") or ""))
    cid = made["id"] if "id" in made else made["rid"].rsplit(".", 1)[-1]
    out = []
    for lic in pk.get("licenses") or []:
        out.append(issue_license(cid, LicenseIssue(**{k: v for k, v in lic.items() if v is not None})))
    auth.audit("cipher_channel_installed", None, f"{made.get('name')} from {pk.get('name')} with {len(out)} licenses")
    return {"channel": made, "licenses": out}


class LicenseIssue(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["operational", "data_manager", "admin"]
    operations: list[Literal["encrypt", "decrypt"]] = Field(min_length=1)
    folder_id: Optional[str] = None  # default: the channel's folder
    rate_limit: Optional[dict[str, int]] = None  # {"count": n, "minutes": m}, operational only
    bypass_checkpoints: bool = False
    expires_at: Optional[str] = None
    description: str = ""


@router.post("/channels/{cid}/licenses")
def issue_license(cid: str, req: LicenseIssue) -> dict:
    p = auth.require_user()
    c = _channel(cid)
    if not _item_access(c.get("item_id"), "owner"):
        raise HTTPException(403, "Issuing licenses needs the Owner role on the channel")
    if c["algorithm"] in cc.HASHING and "decrypt" in req.operations:
        raise HTTPException(400, "hashing channels cannot decrypt")
    if c["algorithm"] == "VISUAL" and req.kind == "data_manager":
        raise HTTPException(400, "visual obfuscation runs in Code Repositories (Admin) and image widgets (Operational)")
    if req.rate_limit and req.kind != "operational":
        raise HTTPException(400, "rate limits are for Operational User licenses")
    if req.rate_limit and (req.rate_limit.get("count", 0) < 1 or req.rate_limit.get("minutes", 0) < 1):
        raise HTTPException(400, "a rate limit is a count and a period in minutes, both at least 1")
    lid = uuid.uuid4().hex[:12]
    folder = req.folder_id
    if not folder:
        import db

        folder = (db.drive_get(c["item_id"]) or {}).get("parent_id")
    r = {"id": lid, "name": req.name.strip(), "description": req.description, "channel_id": c["id"], "kind": req.kind,
         "operations": sorted(set(req.operations)), "rate_limit": req.rate_limit, "bypass_checkpoints": req.bypass_checkpoints and req.kind == "operational",
         "expires_at": req.expires_at, "created_at": _now(), "created_by": p.get("username"), "item_id": None, "users": []}
    item = _store_item(folder, f"{r['name']}.cipher-license", LICENSE_TYPE, {"rid": RID + lid, "channel": CHANNEL_RID + c["id"], "kind": req.kind})
    r["item_id"] = item["id"]
    with _lock:
        rows = _all()
        rows.append(r)
        _save(rows)
    auth.audit("cipher_license_created", None, f"{r['name']} ({req.kind}) on {c['name']}")
    return _public(r)


@router.get("/licenses")
def list_licenses(usable_for: Optional[str] = None, channel: Optional[str] = None, kind: Optional[str] = None) -> list[dict]:
    """Licenses the caller can see; usable_for=encrypt|decrypt|hash narrows to those they can use for it."""
    auth.require_user()
    out = []
    names = {c["id"]: c for c in _channels()}
    for r in _all():
        k = r.get("kind") or "legacy"
        if k != "legacy" and not _item_access(r.get("item_id")):
            continue
        if channel and r.get("channel_id") != _strip(channel, CHANNEL_RID) or kind and k != kind:
            continue
        if usable_for:
            op = "encrypt" if usable_for == "hash" else usable_for
            if op not in (r.get("operations") or []) or _usable(r):
                continue
        ch = names.get(r.get("channel_id") or "")
        out.append({**_public(r), "channel": {"rid": CHANNEL_RID + ch["id"], "name": ch["name"], "algorithm": ch["algorithm"]} if ch else None})
    return out


# -- legacy (media) licenses, Control Panel → Cipher licenses --


class LicenseIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    operations: list[Literal["encrypt", "decrypt"]] = Field(default_factory=lambda: ["encrypt", "decrypt"])
    # user ids (or usernames) allowed to use the license; empty: every signed-in user
    users: list[str] = Field(default_factory=list)
    description: str = ""


@router.post("/licenses")
def create_license(req: LicenseIn) -> dict:
    auth.require_admin()
    key = os.urandom(32)
    r = {"id": uuid.uuid4().hex[:12], "name": req.name.strip(), "description": req.description, "operations": sorted(set(req.operations)),
         "users": req.users, "created_at": auth._iso(), "created_by": (auth.current() or {}).get("username") or "system", "kind": "legacy",
         "sealed": base64.b64encode(secretbox.seal({"key": base64.b64encode(key).decode()})).decode()}
    with _lock:
        rows = _all()
        rows.append(r)
        _save(rows)
    auth.audit("cipher_license_created", None, r["name"])
    return _public(r)


class LicenseChange(BaseModel):
    operations: Optional[list[Literal["encrypt", "decrypt"]]] = None
    users: Optional[list[str]] = None
    rate_limit: Optional[dict[str, int]] = None
    bypass_checkpoints: Optional[bool] = None
    expires_at: Optional[str] = None
    revoked: Optional[bool] = None


@router.patch("/licenses/{lid}")
def update_license(lid: str, req: LicenseChange) -> dict:
    p = auth.require_user()
    with _lock:
        rows = _all()
        r = next((x for x in rows if x["id"] == _find(lid)["id"]), None)
        if (r.get("kind") or "legacy") == "legacy":
            auth.require_admin()
        else:
            c = _channel(r["channel_id"])
            if not _item_access(c.get("item_id"), "owner"):
                raise HTTPException(403, "Changing licenses needs the Owner role on the channel")
        if req.operations is not None:
            r["operations"] = sorted(set(req.operations))
        if req.users is not None:
            r["users"] = req.users
        if req.rate_limit is not None:
            r["rate_limit"] = req.rate_limit or None
        if req.bypass_checkpoints is not None:
            r["bypass_checkpoints"] = req.bypass_checkpoints
        if req.expires_at is not None:
            r["expires_at"] = req.expires_at or None
        if req.revoked:
            r["expires_at"] = _now()
        r["updated_by"] = p.get("username")
        _save(rows)
    return _public(r)


def key_for(ref: str, operation: str) -> bytes:
    """The key for an operation the current user may perform (raises 403 otherwise): media transforms (legacy and
    Admin licenses; a visual channel's seed key)."""
    r = _find(ref)
    _check(r, operation, ("legacy", "admin"))
    if (r.get("kind") or "legacy") == "legacy":
        return base64.b64decode(secretbox.unseal(base64.b64decode(r["sealed"]))["key"])
    c = _channel(r["channel_id"])
    return base64.b64decode(_material(c)["key"])


class KeyIn(BaseModel):
    operation: Literal["encrypt", "decrypt"]


@router.post("/licenses/{lid}/key")
def license_key(lid: str, req: KeyIn) -> dict:
    """For transform builds (their job token): the key of a license for one operation (legacy and Admin licenses)."""
    key = key_for(lid, req.operation)
    r = _find(lid)
    p = auth.current() or {}
    try:
        auth.audit(f"cipher_{req.operation}_key", None, f"{r['name']} for {p.get('username') or 'system'}")
    except Exception:  # noqa: BLE001 - auditing never blocks the key
        pass
    return {"license": RID + r["id"], "operation": req.operation, "key": base64.b64encode(key).decode(),
            "channel": CHANNEL_RID + r["channel_id"] if r.get("channel_id") else None}


class MaterialIn(BaseModel):
    license: str  # rid, Files item id or Files path
    operation: Literal["encrypt", "decrypt"]


@router.post("/material")
def license_material(req: MaterialIn) -> dict:
    """For Python transforms (bellaso_python_lib, Admin licenses): the channel's algorithm and key."""
    r = _find(req.license)
    _check(r, req.operation, ("admin",))
    m = _material(_channel(r["channel_id"]))
    auth.audit(f"cipher_{req.operation}_key", None, f"{r['name']} (transform) for {(auth.current() or {}).get('username') or 'system'}")
    return {"license": RID + r["id"], **m}


# ------------------------------------------------------------------------------------------------
# operations
# ------------------------------------------------------------------------------------------------


def run(r: dict, operation: str, values: list[Optional[str]], regex: Optional[str] = None) -> list[Optional[str]]:
    """Apply a license's channel operation to values (permissions are checked by the caller)."""
    c = _channel(r["channel_id"])
    if c["algorithm"] == "VISUAL":
        raise HTTPException(400, "visual obfuscation channels work on images (media transforms)")
    op = cc.Operator(_material(c))
    if operation == "encrypt" and c["algorithm"] in cc.HASHING:
        operation = "hash"
    if operation == "hash" and c["algorithm"] not in cc.HASHING:
        raise HTTPException(400, f'"{c["name"]}" is an encryption channel: use encrypt')
    fn = {"encrypt": op.encrypt, "decrypt": op.decrypt, "hash": op.hash}[operation]
    out = []
    for v in values:
        try:
            out.append(cc.all_matches(v, regex, fn) if regex and operation != "decrypt" else fn(None if v is None else str(v)))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
    return out


def _rate_limit(r: dict, n: int) -> None:
    rl = r.get("rate_limit")
    if not rl:
        return
    key = ((auth.current() or {}).get("id") or "local", r["id"])
    # counted across every API process (PostgreSQL; this process's window while it is unreachable)
    if not rate_limits.take(f"cipher:{key[0]}:{key[1]}", rl["count"], rl["minutes"] * 60, n=n):
        raise HTTPException(429, f'the Cipher license "{r["name"]}" allows {rl["count"]} operations per {rl["minutes"]} minutes: try again later')


class OperateIn(BaseModel):
    operation: Literal["encrypt", "decrypt", "hash"]
    value: Optional[str] = None
    context: str = ""  # where the value is (an object, a property), for the audit log


@router.post("/licenses/{lid}/operate")
def operate(lid: str, req: OperateIn) -> dict:
    """Operational User licenses: one value, audited and rate limited (Checkpoints cipher_encrypt / cipher_decrypt
    apply through the checkpoint middleware)."""
    r = _find(lid)
    _check(r, req.operation, ("operational",))
    _rate_limit(r, 1)
    out = run(r, req.operation, [req.value])[0]
    _audit(r, req.operation, 1, req.context)
    return {"value": out}


class InlineEditIn(BaseModel):
    object_type_id: str
    primary_key: str
    property: str
    # the new plain text, encrypted here with the license's channel
    value: str = Field(max_length=100_000)
    license: str
    context: str = ""


def _editable(prop: dict) -> bool:
    return any(tc.replace(" ", "").lower() == "cipher:editable" for tc in prop.get("type_classes") or [])


@router.post("/inline-edit")
def inline_edit(req: InlineEditIn) -> dict:
    """In-line edits of an encrypted property (the `cipher: editable` type class): the new value is encrypted with an
    Operational User license that may encrypt (audited, rate limited, checkpointed as cipher_encrypt) and written as
    an object edit by a user who edits the object type and sees the object and the property."""
    import ontology
    import ontology_model

    t = ontology._object_type(req.object_type_id)
    prop = next((p for p in t["properties"] if p["api_name"] == req.property), None)
    if not prop:
        raise HTTPException(404, f"{t['display_name']} has no property {req.property}")
    if not _editable(prop):
        raise HTTPException(403, f"{prop.get('display_name') or req.property} is not editable in line: add the type class cipher: editable")
    if req.property == t["primary_key"]:
        raise HTTPException(400, "the primary key cannot be encrypted in line")
    ontology_model.require_role(t.get("ontology_id"), "editor", t, "edit its objects")
    obj = ontology._objects(t["id"]).get(str(req.primary_key))
    if not obj or not ontology._can_see(t, obj):
        raise HTTPException(404, f'{t["display_name"]} "{req.primary_key}" not found')
    hidden = ontology.MODEL_HOOKS["property_policy"](t, obj) if "property_policy" in ontology.MODEL_HOOKS else []
    if req.property in (hidden or []):
        raise HTTPException(403, "a property security policy hides this property from you")
    r = _find(req.license)
    _check(r, "encrypt", ("operational",))
    cur = (obj.get("properties") or {}).get(req.property)
    channel = cc.VALUE.match(str(cur or ""))
    if channel and channel.group(1) != CHANNEL_RID + (r.get("channel_id") or ""):
        raise HTTPException(400, "the value is encrypted with another channel: use a license of that channel")
    _rate_limit(r, 1)
    value = run(r, "encrypt", [req.value])[0]
    ontology.apply_edits([{"op": "modify", "object_type_id": t["id"], "primary_key": str(req.primary_key), "properties": {req.property: value}}], "cipher")
    _audit(r, "encrypt", 1, req.context or f"in-line edit of {req.property} of {req.primary_key}")
    return {"value": value}


class PipelineIn(BaseModel):
    dataset_item_id: str
    column: str
    # where the pipeline (its own folder) and the encrypted output go
    folder_id: str
    name: Optional[str] = None


@router.post("/licenses/{lid}/create-pipeline")
def create_pipeline(lid: str, req: PipelineIn) -> dict:
    """Cipher's "Create pipeline": a Pipeline Builder pipeline that reads a dataset and encrypts one String column
    (replacing it) with this Data Manager license, writing an encrypted copy into the folder. The pipeline file keeps
    no sample rows, so it never holds the plain values."""
    import dataset_preview
    import pipeline_datasets as pdx

    r = _find(lid)
    _check(r, "encrypt", ("data_manager",))
    item, kind = dataset_preview._dataset(req.dataset_item_id)
    table = dataset_preview.table(item, kind)
    if req.column not in table.column_names:
        raise HTTPException(400, f"{item['name']} has no column {req.column}")
    import pyarrow as pa

    if not pa.types.is_string(table.schema.field(req.column).type) and not pa.types.is_large_string(table.schema.field(req.column).type):
        raise HTTPException(400, f"Only String columns are encrypted: cast {req.column} to String first")
    auth.check_item_id(req.folder_id, "editor")
    now = _now()
    base = item["name"].rsplit(".", 1)[0]
    name = (req.name or f"Encrypt {req.column} of {base}").strip()
    rid = RID + r["id"]
    content = {
        "type": "batch", "createdAt": now, "updatedAt": now,
        "datasets": {"ds_src": {"id": "ds_src", "name": base, "origin": f"Files · {item['name']}", "createdAt": now, "refreshedAt": now,
                                "columns": [{"name": f.name, "type": "String" if pa.types.is_string(f.type) else str(f.type)} for f in table.schema],
                                "rows": [], "ref": {"kind": "drive", "itemId": item["id"]}}},
        "nodes": [{"id": "src", "name": base, "kind": "source", "datasetId": "ds_src", "x": 80, "y": 120},
                  {"id": "encrypt", "name": f"Encrypt {req.column}", "kind": "transform", "input": "src", "x": 400, "y": 120,
                   "steps": [{"id": "s_encrypt", "kind": "cipher_encrypt", "params": {"column": req.column, "license": rid, "output": req.column}}]}],
        "outputs": [{"id": "o_encrypted", "name": f"{base}_encrypted", "node": "encrypt", "kind": "dataset", "columns": None, "writeMode": "default",
                     "location": {"id": req.folder_id, "name": ""}, "expectations": [], "x": 720, "y": 120}],
        "legend": [], "textNodes": [], "schedules": [],
        "meta": {"description": f"Created by Cipher from the license {r['name']}: encrypts {req.column} of {item['name']}."},
    }
    out = pdx.create_pipeline(pdx.NewPipelineFile(name=name, parent_id=req.folder_id, content=content))
    _audit(r, "encrypt", 0, f"pipeline created to encrypt {req.column} of {item['name']}")
    return {"pipeline": out}


class VisualDecryptIn(BaseModel):
    # the image (a Files item: a PNG written by a media transform's encrypt())
    item_id: str
    # areas to decrypt: boxes as fractions of the image ({x, y, w, h} in 0..1, Workshop annotations) and / or polygons
    # in pixels ([[x, y], ...])
    boxes: list[dict] = Field(default_factory=list)
    polygons: list[list[list[float]]] = Field(default_factory=list)
    # an Operational User license of the areas' visual obfuscation channel (default: the first one you may use)
    license: Optional[str] = None


@router.post("/visual/decrypt")
def visual_decrypt(req: VisualDecryptIn):
    """Decrypt selected areas of a visually obfuscated image (Workshop: Decrypt selected areas): the original pixels of
    the encrypted regions inside the areas, for viewing only (nothing is stored), with an Operational User license
    that may decrypt — audited per area, rate limited, checkpointed as cipher_decrypt."""
    import io

    from fastapi.responses import Response
    from PIL import Image

    import code_media
    import drive

    item = drive._item(req.item_id)
    data = drive.read_bytes(item)
    try:
        im = Image.open(io.BytesIO(data))
        regions = json.loads(im.info.get(code_media.CIPHER_CHUNK) or "[]") if im.format == "PNG" else []
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "not an image") from None
    if not regions:
        raise HTTPException(400, "this image has no encrypted areas")
    w, h = im.size
    polys = [p for p in req.polygons if len(p) >= 3]
    for b in req.boxes:
        x, y, bw, bh = (float(b.get(k, 0)) for k in ("x", "y", "w", "h"))
        polys.append([[x * w, y * h], [(x + bw) * w, y * h], [(x + bw) * w, (y + bh) * h], [x * w, (y + bh) * h]])
    if not polys:
        raise HTTPException(400, "select at least one area")
    channels = {r.get("channel") for r in regions if r.get("channel")}
    if req.license:
        lic = _find(req.license)
    else:
        mine = [x for x in list_licenses(usable_for="decrypt", kind="operational") if (x.get("channel") or {}).get("rid") in channels]
        if not mine:
            raise HTTPException(403, "No Operational User license of this image's Cipher channel lets you decrypt")
        lic = _find(mine[0]["rid"])
    _check(lic, "decrypt", ("operational",))
    c = _channel(lic["channel_id"])
    if c["algorithm"] != "VISUAL":
        raise HTTPException(400, f'"{c["name"]}" is not a visual obfuscation channel')
    _rate_limit(lic, len(polys))
    key = base64.b64decode(_material(c)["key"])
    try:
        out = code_media._cipher_image("decrypt", data, polys, RID + lic["id"], key_info=(key, CHANNEL_RID + c["id"]))
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    _audit(lic, "decrypt", len(polys), f"visual decrypt of {len(polys)} area(s) of {item['name']}")
    return Response(out, media_type="image/png", headers={"Cache-Control": "no-store"})


class ColumnCall(BaseModel):
    key: str
    license: str
    operation: Literal["encrypt", "decrypt", "hash"]
    values: list[Optional[str]]
    regex: Optional[str] = None


class ColumnCalls(BaseModel):
    calls: list[ColumnCall]


@router.post("/pipeline")
def pipeline_calls(req: ColumnCalls) -> dict:
    """Pipeline Builder's Cipher steps (a ServiceRequest batch): whole columns with Data Manager or Admin licenses."""
    auth.require_user()
    results: dict[str, Any] = {}
    for call in req.calls:
        try:
            r = _find(call.license)
            _check(r, call.operation, ("data_manager", "admin"))
            results[call.key] = {"value": run(r, call.operation, call.values, call.regex)}
            _audit(r, call.operation, len(call.values), "Pipeline Builder")
        except HTTPException as e:
            results[call.key] = {"error": str(e.detail)}
    return {"results": results}


def columns(license_ref: str, operation: str, values: list[Optional[str]], where: str) -> list[Optional[str]]:
    """Contour's Cipher board (and other column tools): Data Manager or Admin licenses."""
    r = _find(license_ref)
    _check(r, operation, ("data_manager", "admin"))
    out = run(r, operation, values)
    _audit(r, operation, len(values), where)
    return out
