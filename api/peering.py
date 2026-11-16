"""Peer Manager (palantir.com/docs/foundry/peer-manager): peering ontology data between BluesandAI enrollments.

Pieces, as in Foundry:

- This enrollment: an RID and a platform title (how it appears to remote peers), kept in data/peering/enrollment.json.
- Network connections (Foundry's Multipass exchanger): each side generates an invite code (its API URL, RID, title,
  a secret and a direction: bidirectional, egress only, ingress only) and enters the other side's. Requests between
  enrollments carry X-Peer-Enrollment and X-Peer-Secret (the secret the receiving side generated). Data relay
  connections (CDS channels) of the File type write / read payload files in a directory (HTTP channels are network
  connections); S3 and Lattice transports do not exist here.
- Peer connections, over a network connection, between a Project on each side (Projects stand in for spaces): the
  data types and directions (objects export / import), and the security (the markings allowed to peer; an object
  type peers only when every marking on it is allowed). Create a peer request (invite code) → the remote enters it,
  picks its Project and security and approves → the originator activates. Either side can disable it (nothing
  peers until both are enabled); security changes are change requests the other side approves.
- Ontology peering: object types are added to the connection on both sides (imports allowed or blocked), then
  mapped (local ↔ remote type, property mapping between properties of the same type, directions for source data
  and actions). Objects travel by primary key with their mapped properties.
- Peering jobs: export jobs are concurrent (each local edit of a mapped object type is sent at once) or sequential
  (every minute, everything changed since the remote's last acknowledgment is collected and sent; nothing to send
  is an Empty job). The receiver applies the objects (as ontology edits; objects it already holds as sent are not
  written) and answers with an Ack job. No echo loop: imported edits are relayed at once to the receiver's other
  connections mapping the type, never back over the connection they came from, and a sequential export skips an
  object as last received from that remote (a fingerprint of its mapped properties, data/peering/received.json)
  until it changes here; links imported to exactly the remote's pairs are not sent back either. Conflicts (a ring or
  mesh of peers editing the same object at once, a slow relay): every object edit and deletion carries its origin
  version (the origin enrollment's hybrid logical clock and RID, unchanged through relays) and a receiver applies it only
  when it is newer than what it holds (last writer wins, ties ordered by origin RID; a deletion leaves a versioned
  tombstone: an edit newer than the tombstone brings the object back, an older one never does, and a deletion older
  than the edit held is skipped); older copies are counted as stale_skipped on the import job. The echo record keeps the version received,
  so a skipped object is never fingerprinted again. A peer offline (or a connection disabled) catches up when back:
  objects with the next sequential export, deletions it missed kept as owed to it (data/peering/pending_deletions.json)
  and sent with every export until delivered. Statuses: collecting data, exporting, saving, awaiting pull (the remote pulls), ready to
  download (data relay), empty, failed; imports mirror them. Health comes from the recent non-empty jobs.
- One-way networks (one side Egress only / the other Ingress only): the side that cannot call keeps its control
  messages (approvals, activation, entities, mappings, status) and its payloads for the remote, which pulls them
  every minute or on Pull now and acknowledges each (a payload it cannot apply is reported back and sent again by the
  next sequential job). A sequential payload supersedes the ones of its mapping still waiting.
- A remote with an export File relay channel (peering integration) gets the payloads as signed files in the channel's
  directory instead of over HTTP; the control plane stays on the network connection while this side can call the
  remote. Without one (a data relay connection: no MPX invite at all, only channels), the control messages travel as
  signed files through the same channel, in the same sequence as the payloads: creating a peering channel to a remote
  RID creates its relay network connection, an export channel sends a hello (platform title, markings), and the peer
  request / approval / activation / entities / mappings / status / security messages are applied by the same handlers
  as over HTTP. Every relay file carries its origin and destination enrollments and a per-remote sequence number
  (signed with the channel secret). The receiver applies them strictly in sequence: a file whose sequence was already
  applied is a duplicate (dropped), a file after a missing one waits for it. Over its own export channel it sends
  cumulative signed acknowledgements (applied up to N, the sequences it is missing); the sender keeps each file until it
  is acknowledged and writes it again when the remote reports it missing, or when it left the directory unacknowledged
  for RELAY_RETRY_AFTER seconds (once an acknowledgement proved the way back). Without an export channel back, the
  acknowledgements travel over the network connection when there is one (sent, or left for the remote to pull); with
  neither there is no way back: the channel says so (files count as delivered once written, nothing is resent). Each
  acknowledgement is an Ack job on the connections with that remote (the sequences acknowledged and missing).
- Peer profiles (beta): a hub / spoke pair of reusable configurations (security, data types, ontology entries) that,
  installed with a remote strategy (all, or one enrollment), creates or configures the peer connections it applies to.
  Marketplace distribution does not exist here: profiles are installed from Peer Manager.

- Marking mapping: enrollments have their own marking ids, so a connection maps each local marking to one of the
  remote's (listed from the remote). With a mapping, security change requests reach the remote in its own ids and
  marking-typed property values are translated on export; an unmapped marking stops the export.
- Link type peering: join table link types whose two object types are mapped can be mapped too; sequential jobs send
  the link pairs when they changed (a link edit sends them at once, concurrently), and the receiver adds and removes
  the pairs that changed since the last payload
  (links between objects it does not have are skipped). Foreign key links travel with the objects' properties.

File peering (Gotham files, Gaia maps) does not exist: there is no Gotham here.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth

log = logging.getLogger("bluesandai.peering")
router = APIRouter(prefix="/api/peering")
remote = APIRouter(prefix="/api/peering/remote")
DIR = Path("data/peering")
_lock = threading.RLock()
_local = threading.local()
JOBS_KEPT = 500
# seconds between runs of the background loop (sequential jobs, pulls, relay channels); shorter for tests
SEQUENTIAL_EVERY = max(float(os.environ.get("BLUESANDAI_PEER_TICK_S") or 60), 0.5)
# a relay file the remote has not acknowledged is written again after this many seconds (when it left the directory)
RELAY_RETRY_AFTER = float(os.environ.get("BLUESANDAI_PEER_RELAY_RETRY_S") or 120)
RELAY_SENT_KEPT = 1000  # unacknowledged relay files kept per remote for resending


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "peering"
    DIR.mkdir(parents=True, exist_ok=True)
    _install_hook()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="milliseconds")


def _read(name: str, default: Any) -> Any:
    p = DIR / name
    try:
        return json.loads(p.read_text("utf-8")) if p.exists() else default
    except ValueError:
        return default


def _write(name: str, value: Any) -> None:
    p = DIR / name
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(value, indent=1, default=str), "utf-8")
    for i in range(20):
        try:
            tmp.replace(p)
            return
        except PermissionError:  # Windows: the file is open in a concurrent read for a moment
            if i == 19:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.01 * (i + 1))


def _admin() -> None:
    p = auth.current()
    if auth.enabled() and p and not p.get("service") and p.get("role") != "admin":
        raise HTTPException(403, "enrollment administrators manage network connections")


def _manage_project(project_id: str) -> None:
    """Managing a peer connection needs managing its local space: Owner of the local Project here."""
    import drive

    item = drive._item(project_id, need="owner")
    if item["kind"] != "project":
        raise HTTPException(400, "peer connections are between Projects")


# ------------------------------------------------------------------------------------------------
# this enrollment
# ------------------------------------------------------------------------------------------------


def enrollment() -> dict:
    e = _read("enrollment.json", None)
    if not e:
        e = {"rid": "ri.multipass..enrollment." + uuid.uuid4().hex, "title": os.environ.get("BLUESANDAI_PLATFORM_TITLE") or "", "created_at": _iso()}
        _write("enrollment.json", e)
    return e


def _api_url() -> str:
    return (os.environ.get("BLUESANDAI_API_URL") or f"http://127.0.0.1:{os.environ.get('BLUESANDAI_API_PORT') or 8000}").rstrip("/")


def _my_url() -> str:
    return enrollment().get("api_url") or _api_url()


class EnrollmentIn(BaseModel):
    title: str = Field(max_length=120)
    api_url: Optional[str] = None


@router.get("/enrollment")
def get_enrollment() -> dict:
    e = enrollment()
    return {**e, "api_url": _my_url(), "display": e.get("title") or "Unnamed enrollment (set a platform title)"}


@router.put("/enrollment")
def set_enrollment(req: EnrollmentIn) -> dict:
    """The platform title remote peers see, and the API address put in invite codes."""
    _admin()
    with _lock:
        e = enrollment()
        e["title"] = req.title.strip()
        if req.api_url is not None:
            e["api_url"] = req.api_url.strip().rstrip("/") or None
        _write("enrollment.json", e)
    return get_enrollment()


# ------------------------------------------------------------------------------------------------
# network connections (MPX invite codes) and data relay channels
# ------------------------------------------------------------------------------------------------


def _networks() -> list[dict]:
    return _read("networks.json", [])


def _save_networks(v: list[dict]) -> None:
    _write("networks.json", v)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def encode_code(d: dict) -> str:
    return "bsai-peer-" + base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_code(code: str) -> dict:
    code = (code or "").strip()
    if not code.startswith("bsai-peer-"):
        raise HTTPException(400, "not a BluesandAI invite code")
    body = code[len("bsai-peer-"):]
    try:
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, json.JSONDecodeError):
        raise HTTPException(400, "the invite code is damaged") from None


class InviteIn(BaseModel):
    direction: Literal["bidirectional", "egress", "ingress"] = "bidirectional"


@router.post("/networks/invite")
def new_invite(req: InviteIn) -> dict:
    """New MPX invite: a code for the remote administrator. Its secret authenticates the remote's requests here."""
    _admin()
    e = enrollment()
    secret = secrets.token_urlsafe(32)
    pending = _read("invites.json", [])
    pending.append({"secret_hash": _sha(secret), "direction": req.direction, "created_at": _iso()})
    _write("invites.json", pending[-50:])
    return {"code": encode_code({"kind": "network", "rid": e["rid"], "title": e.get("title"), "url": _my_url(), "secret": secret, "direction": req.direction}),
            "direction": req.direction}


class EnterInviteIn(BaseModel):
    code: str
    name: str = Field(min_length=1, max_length=120)


@router.post("/networks")
def enter_invite(req: EnterInviteIn) -> dict:
    """Enter MPX invite code: the remote's URL and the secret to present to it. The connection is complete once both
    sides entered each other's code (this side's own invite is matched when the remote first calls with it)."""
    _admin()
    d = decode_code(req.code)
    if d.get("kind") != "network":
        raise HTTPException(400, "this is not a network (MPX) invite code")
    if d["rid"] == enrollment()["rid"]:
        raise HTTPException(400, "this invite code is from this enrollment: enter the remote administrator's code")
    with _lock:
        nets = _networks()
        cur = next((n for n in nets if n["remote_rid"] == d["rid"]), None)
        rec = cur or {"id": "net-" + uuid.uuid4().hex[:10], "created_at": _iso(), "inbound_secret_hash": None}
        rec.update(name=req.name.strip(), remote_rid=d["rid"], remote_title=d.get("title") or rec.get("remote_title") or "", remote_url=d["url"].rstrip("/"),
                   outbound_secret=d["secret"], remote_direction=d.get("direction", "bidirectional"))
        rec.pop("relay", None)  # a data relay connection that now has an MPX connection too
        if not cur:
            nets.append(rec)
        _save_networks(nets)
    status = check_network(rec["id"])
    return {**_public_net(_net(rec["id"])), "check": status}


def _public_net(n: dict) -> dict:
    relay = {"export": bool(_relay_channel(n["remote_rid"], "export")), "import": bool(_relay_channel(n["remote_rid"], "import"))}
    complete = (relay["export"] and relay["import"]) if _relay_only(n) else bool(n.get("inbound_secret_hash") and n.get("outbound_secret"))
    return {k: v for k, v in n.items() if k not in ("outbound_secret", "remote_markings")} | {
        "complete": complete, "can_initiate": _can_initiate(n), "pulls": _pulls(n), "relay_only": _relay_only(n), "relay": relay}


def _relay_only(n: dict) -> bool:
    """A data relay connection: no MPX invite was entered on either side (no URL to call, nobody called in)."""
    return not n.get("remote_url") and not n.get("inbound_secret_hash")


def _relay_net(remote_rid: str, name: str = "") -> dict:
    """The network connection record of a remote enrollment, created as a data relay connection when there is none
    (peer connections reference a network connection; a relay-only one is reached through its channels)."""
    with _lock:
        nets = _networks()
        n = next((x for x in nets if x["remote_rid"] == remote_rid), None)
        if n:
            return n
        n = {"id": "net-" + uuid.uuid4().hex[:10], "name": name or f"Data relay …{remote_rid[-8:]}", "remote_rid": remote_rid, "remote_title": "",
             "remote_url": "", "outbound_secret": "", "inbound_secret_hash": None, "remote_direction": "bidirectional", "relay": True, "created_at": _iso()}
        nets.append(n)
        _save_networks(nets)
        return n


def _net(nid: str) -> dict:
    n = next((x for x in _networks() if x["id"] == nid), None)
    if not n:
        raise HTTPException(404, "no such network connection")
    return n


def _can_initiate(n: dict) -> bool:
    """Whether this side sends requests to the remote: not when the remote chose Egress only (it initiates), nor
    when this side chose Ingress only (the remote initiates)."""
    return bool(n.get("remote_url") and n.get("outbound_secret")) and n.get("remote_direction") in ("bidirectional", "ingress") \
        and n.get("local_direction") != "ingress"


def _call(n: dict, method: str, path: str, body: Optional[dict] = None, timeout: float = 30) -> Any:
    if not _can_initiate(n):
        raise HTTPException(409, f"{n['name']}: this side does not initiate requests to the remote (it pulls, or the remote pulls)")
    e = enrollment()
    try:
        r = httpx.request(method, f"{n['remote_url']}/api/peering/remote{path}", json=body, timeout=timeout,
                          headers={"X-Peer-Enrollment": e["rid"], "X-Peer-Secret": n["outbound_secret"]})
    except httpx.HTTPError as ex:
        raise HTTPException(502, f"network path to {n.get('remote_title') or n['remote_url']} not found: {ex}") from None
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = r.text[:300]
        raise HTTPException(r.status_code if r.status_code < 500 else 502, f"{n.get('remote_title') or 'remote'}: {detail}")
    return r.json() if r.content else {}


def _pulls(n: dict) -> bool:
    """Whether this side pulls from the remote: it can call the remote but the remote cannot call it (this side
    chose Egress only, or the remote chose Ingress only)."""
    return _can_initiate(n) and (n.get("local_direction") == "egress" or n.get("remote_direction") == "ingress")


def _send(n: dict, path: str, body: dict) -> Any:
    """A control message to the remote: sent at once, or written to the remote's export File relay channel (peering
    integration) when this side cannot call it, or left for the remote to pull."""
    if _can_initiate(n):
        return _call(n, "POST", path, body)
    if _relay_channel(n["remote_rid"]):
        return _relay_send(n, path, body)
    if _relay_only(n):
        raise HTTPException(409, f"{n['name']}: no network connection and no export File relay channel with the Peering integration to this remote enrollment")
    with _lock:
        msgs = _read("messages.json", [])
        msgs.append({"id": "msg-" + uuid.uuid4().hex[:12], "network_id": n["id"], "path": path, "body": body, "at": _iso()})
        _write("messages.json", msgs[-1000:])
    return {"queued": True}


def _relay_send(n: dict, path: str, body: dict) -> dict:
    """A control message as a relay file: queued behind the payloads already waiting (one sequence per remote) and
    written at once."""
    parts = path.strip("/").split("/")
    cid = parts[1] if len(parts) == 3 and parts[0] == "connections" else None
    mid = "msg-" + uuid.uuid4().hex[:12]
    with _lock:
        out = _read("relay_outbox.json", [])
        out.append({"connection_id": cid, "remote_rid": n["remote_rid"], "payload": {"kind": "control", "id": mid, "path": path, "body": body, "at": _iso()}})
        _write("relay_outbox.json", out)
        _relay_export()
    return {"relayed": True, "id": mid}

def _complete_from_hello(nid: str, your_invite: Optional[str]) -> None:
    """The remote entered one of this side's invites but never calls this side (so the invite was never matched):
    match it from the hash the remote returns, which records this side's direction and completes the connection."""
    if not your_invite:
        return
    with _lock:
        nets = _networks()
        n = next((x for x in nets if x["id"] == nid), None)
        if not n or n.get("inbound_secret_hash"):
            return
        invites = _read("invites.json", [])
        inv = next((i for i in invites if hmac.compare_digest(i["secret_hash"], your_invite)), None)
        if not inv:
            return
        n["inbound_secret_hash"] = inv["secret_hash"]
        n["local_direction"] = inv["direction"]
        _save_networks(nets)
        _write("invites.json", [i for i in invites if i["secret_hash"] != inv["secret_hash"]])


@router.post("/networks/{nid}/check")
def check_network(nid: str) -> dict:
    n = _net(nid)
    if _relay_only(n):
        # a data relay connection: write a hello into the export channel; reachable once the remote's hello came in
        try:
            _send(n, "/hello", _hello_body())
        except HTTPException as e:
            return {"ok": False, "relay": True, "error": e.detail}
        n = _net(nid)
        return {"ok": bool(n.get("last_ok_at")), "relay": True,
                "error": None if n.get("last_ok_at") else "hello written to the export channel; waiting for the remote enrollment's hello through the import channel"}
    if not _can_initiate(n):
        # the remote initiates every request: it is reachable when it has called in
        return {"ok": bool(n.get("last_ok_at")), "remote_calls_in": True,
                "error": None if n.get("last_ok_at") else "the remote enrollment initiates the requests on this connection: waiting for it to call in"}
    try:
        info = _call(n, "POST", "/hello", {**_hello_body(), "url": _my_url()}, timeout=10)
        _update_net(nid, last_ok_at=_iso(), last_error=None, remote_title=info.get("title") or n.get("remote_title"))
        _complete_from_hello(nid, info.get("your_invite"))
        return {"ok": True, "remote": {k: v for k, v in info.items() if k != "your_invite"}}
    except HTTPException as e:
        _update_net(nid, last_error=str(e.detail))
        return {"ok": False, "error": e.detail}


def _update_net(nid: str, **changes: Any) -> None:
    with _lock:
        nets = _networks()
        for x in nets:
            if x["id"] == nid:
                x.update(changes)
        _save_networks(nets)


@router.get("/networks")
def list_networks() -> list[dict]:
    return [_public_net(n) for n in _networks()]


@router.delete("/networks/{nid}")
def delete_network(nid: str) -> dict:
    _admin()
    if any(c["network_id"] == nid for c in _conns()):
        raise HTTPException(400, "delete the peer connections that use this network connection first")
    _save_networks([n for n in _networks() if n["id"] != nid])
    return {"deleted": nid}


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    remote_rid: str
    secret: str = ""
    direction: Literal["export", "import"]
    connection_type: Literal["file", "http", "s3", "lattice"] = "file"
    directory: str = ""
    integrations: list[Literal["peering", "chat", "geotime", "heartbeat"]] = Field(default_factory=lambda: ["peering"])


@router.get("/channels")
def list_channels() -> list[dict]:
    """The channels, each with its relay state: an export channel the last sequence written to its remote, the last one
    acknowledged and how many wait for an acknowledgement; an import channel the last sequence applied, the one it waits
    for (files after a missing one), and the duplicates dropped."""
    sent, acked, seen, seqs = _read("relay_sent.json", {}), _read("relay_acked.json", {}), _read("relay_seen.json", {}), _read("relay_seq.json", {})
    out = []
    for c in _read("channels.json", []):
        rr = c["remote_rid"]
        a = acked.get(rr) or {}
        state = ({"sent_seq": int(seqs.get(rr) or 0), "acked_seq": a.get("seq"), "acked_at": a.get("at"), "unacked": len(sent.get(rr) or []),
                  "missing": a.get("missing") or [], "acked_via": a.get("via")} if c["direction"] == "export" else
                 {"applied_seq": int(seen.get(rr) or 0), "waiting_for": c.get("waiting_for"), "held": int(c.get("held") or 0), "duplicates": int(c.get("duplicates") or 0),
                  "last_ack_at": c.get("last_ack_at"), "last_ack_seq": c.get("last_ack_seq")})
        if "peering" in c.get("integrations", []):
            state["ack_path"] = _ack_path(c)
            state["ack_warning"] = _ack_warning(c)
        out.append({k: v for k, v in c.items() if k not in ("secret", "waiting_for", "held", "duplicates", "last_ack_at", "last_ack_seq")}
                   | {"has_secret": bool(c.get("secret")), "relay_state": state})
    return out


def _remote_calls_in(n: dict) -> bool:
    """Whether the remote sends requests to this enrollment over the network connection (it entered this side's
    invite, and neither this side chose Egress only nor the remote Ingress only)."""
    return bool(n.get("inbound_secret_hash")) and n.get("local_direction") != "egress" and n.get("remote_direction") != "ingress"


def _ack_path(ch: dict) -> Optional[str]:
    """How the acknowledgements of a peering channel's files travel. Export channel: how the remote's come back to this
    side (its export channel = this side's import channel, else the network connection: it calls in, or this side
    pulls); import channel: how this side's reach the remote (this side's export channel, else the network connection:
    called, or left for the remote to pull). None: no way back."""
    rr = ch["remote_rid"]
    if _relay_channel(rr, "import" if ch["direction"] == "export" else "export"):
        return "relay"
    n = next((x for x in _networks() if x["remote_rid"] == rr), None)
    if not n or _relay_only(n):
        return None
    if ch["direction"] == "export":
        return "network" if _pulls(n) or _remote_calls_in(n) else None
    return "network" if _can_initiate(n) or n.get("inbound_secret_hash") else None


def _ack_warning(ch: dict) -> Optional[str]:
    if _ack_path(ch):
        return None
    if ch["direction"] == "export":
        return ("no way back for acknowledgements: there is no import channel (Peering) from this remote enrollment and no network connection it can "
                "acknowledge over, so files written here count as delivered once written and a lost file is not written again. Ask the remote "
                "administrator for an export channel to this enrollment (an import channel here), or set up an MPX connection.")
    return ("no way back for acknowledgements: there is no export channel (Peering) to this remote enrollment and no network connection, so the "
            "remote is never told which files arrived and does not write a lost one again. Create an export channel to it (the remote creates the "
            "matching import channel), or set up an MPX connection.")


@router.post("/channels")
def create_channel(req: ChannelIn) -> dict:
    """A data relay CDS channel: File channels exchange signed payload files through a directory."""
    _admin()
    if req.connection_type in ("s3", "lattice"):
        raise HTTPException(400, f"{req.connection_type.upper()} channels are not available here: use a File channel, or a network connection for HTTP")
    if req.connection_type == "http":
        raise HTTPException(400, "HTTP channels are network connections here: create an MPX invite")
    d = Path(req.directory).expanduser()
    if not req.directory or not d.is_absolute():
        raise HTTPException(400, "give the channel an absolute directory")
    if req.remote_rid.strip() == enrollment()["rid"]:
        raise HTTPException(400, "the remote enrollment RID is this enrollment's own: enter the remote administrator's RID")
    d.mkdir(parents=True, exist_ok=True)
    ch = {"id": "cds-" + uuid.uuid4().hex[:10], **req.model_dump(), "created_at": _iso()}
    ch["remote_rid"] = ch["remote_rid"].strip()
    with _lock:
        chans = _read("channels.json", [])
        chans.append(ch)
        _write("channels.json", chans)
    if "peering" in req.integrations:
        # a peering channel is a data relay connection to the remote: its network record (when there is no MPX one),
        # and over an export channel this enrollment's hello (title and markings, for the remote's marking mapping)
        n = _relay_net(ch["remote_rid"], req.name.strip())
        if req.direction == "export" and _relay_only(n):
            try:
                _send(n, "/hello", _hello_body())
            except HTTPException as e:
                _update_channel(ch["id"], last_error=str(e.detail))
        # a one-way channel is allowed (a CDS that only carries data one way), but say what it costs
        warning = _ack_warning(ch)
        if warning:
            return {k: v for k, v in ch.items() if k != "secret"} | {"warning": warning}
    return {k: v for k, v in ch.items() if k != "secret"}


@router.delete("/channels/{cid}")
def delete_channel(cid: str) -> dict:
    _admin()
    with _lock:
        chans = _read("channels.json", [])
        gone = next((c for c in chans if c["id"] == cid), None)
        _write("channels.json", [c for c in chans if c["id"] != cid])
        if gone:
            # the last peering channel of a data relay connection nothing uses: the connection goes too
            n = next((x for x in _networks() if x["remote_rid"] == gone["remote_rid"]), None)
            if n and _relay_only(n) and not _relay_channel(n["remote_rid"], "export") and not _relay_channel(n["remote_rid"], "import") \
                    and not any(c["network_id"] == n["id"] for c in _conns()):
                _save_networks([x for x in _networks() if x["id"] != n["id"]])
    return {"deleted": cid}


# ------------------------------------------------------------------------------------------------
# peer connections
# ------------------------------------------------------------------------------------------------


def _conns() -> list[dict]:
    return _read("connections.json", [])


def _save_conns(v: list[dict]) -> None:
    _write("connections.json", v)


def _conn(cid: str) -> dict:
    c = next((x for x in _conns() if x["id"] == cid), None)
    if not c:
        raise HTTPException(404, "no such peer connection")
    return c


def _update_conn(cid: str, **changes: Any) -> dict:
    with _lock:
        cs = _conns()
        for c in cs:
            if c["id"] == cid:
                c.update(changes)
                c["updated_at"] = _iso()
                _save_conns(cs)
                return c
    raise HTTPException(404, "no such peer connection")


def _project_name(pid: Optional[str]) -> str:
    import db

    it = db.drive_get(pid) if pid else None
    return it["name"] if it else "?"


def _marking_names(ids: list[str]) -> list[str]:
    try:
        return auth._marking_names(ids)
    except Exception:  # noqa: BLE001
        return ids


def _public_conn(c: dict) -> dict:
    n = next((x for x in _networks() if x["id"] == c["network_id"]), None)
    jobs = [j for j in _jobs() if j["connection_id"] == c["id"]]
    nonempty = [j for j in jobs if j["status"] != "empty"][:10]
    health = "unknown" if not nonempty else "failing" if any(j["status"] == "failed" for j in nonempty[:3]) else "healthy"
    if c["status"] != "active":
        health = c["status"]
    elif not c.get("local_enabled", True) or not c.get("remote_enabled", True):
        health = "disabled"
    return {**c, "project_name": _project_name(c.get("project_id")), "network": _public_net(n) if n else None, "health": health,
            "security_names": _marking_names(c.get("security") or []), "jobs_count": len(jobs)}


class PeerRequestIn(BaseModel):
    network_id: str
    project_id: str
    export_objects: bool = True
    import_objects: bool = True
    security: list[str] = Field(default_factory=list)


@router.post("/connections/request")
def create_request(req: PeerRequestIn) -> dict:
    """Create a peer request: the invite code the remote administrator enters."""
    n = _net(req.network_id)
    _manage_project(req.project_id)
    c = {"id": "peer-" + uuid.uuid4().hex[:12], "network_id": n["id"], "remote_rid": n["remote_rid"], "project_id": req.project_id,
         "role": "originator", "status": "requested", "local_enabled": True, "remote_enabled": True,
         "data_types": {"objects": {"export": req.export_objects, "import": req.import_objects}, "files": {"export": False, "import": False}},
         "security": req.security, "security_requests": [], "ontology": {"local": [], "remote": [], "mappings": []},
         "created_at": _iso(), "created_by": (auth.current() or {}).get("id") or "system"}
    with _lock:
        cs = _conns()
        cs.append(c)
        _save_conns(cs)
    e = enrollment()
    code = encode_code({"kind": "peer", "connection_id": c["id"], "from_rid": e["rid"], "from_title": e.get("title"),
                        "project_name": _project_name(req.project_id), "data_types": c["data_types"], "security": req.security})
    return {"connection": _public_conn(c), "code": code}


class CodeIn(BaseModel):
    code: str


@router.post("/connections/inspect")
def inspect_request(req: CodeIn) -> dict:
    """The connection details of a peer request invite code, before approving it."""
    d = decode_code(req.code)
    if d.get("kind") != "peer":
        raise HTTPException(400, "this is not a peer request invite code")
    n = next((x for x in _networks() if x["remote_rid"] == d["from_rid"]), None)
    dt = d["data_types"]["objects"]
    # the originator's export is this side's import
    return {"from": d.get("from_title") or d["from_rid"], "from_rid": d["from_rid"], "remote_project": d.get("project_name"),
            "objects": {"export": dt["import"], "import": dt["export"]}, "security": d.get("security") or [], "network": _public_net(n) if n else None}


class ImportRequestIn(BaseModel):
    code: str
    project_id: str
    security: Optional[list[str]] = None


@router.post("/connections/import")
def import_request(req: ImportRequestIn) -> dict:
    """Approve request: the connection on this side; the originator then activates it."""
    d = decode_code(req.code)
    if d.get("kind") != "peer":
        raise HTTPException(400, "this is not a peer request invite code")
    n = next((x for x in _networks() if x["remote_rid"] == d["from_rid"]), None)
    if not n:
        raise HTTPException(400, "no network connection to that enrollment: establish an MPX connection first")
    _manage_project(req.project_id)
    dt = d["data_types"]["objects"]
    c = {"id": d["connection_id"], "network_id": n["id"], "remote_rid": d["from_rid"], "project_id": req.project_id, "role": "acceptor", "status": "approved",
         "remote_project": d.get("project_name"), "local_enabled": True, "remote_enabled": True,
         "data_types": {"objects": {"export": dt["import"], "import": dt["export"]}, "files": {"export": False, "import": False}},
         "security": req.security if req.security is not None else d.get("security") or [], "security_requests": [],
         "ontology": {"local": [], "remote": [], "mappings": []}, "created_at": _iso(), "created_by": (auth.current() or {}).get("id") or "system"}
    with _lock:
        cs = [x for x in _conns() if x["id"] != c["id"]]
        cs.append(c)
        _save_conns(cs)
    try:
        _send(n, f"/connections/{c['id']}/approved", {"project_name": _project_name(req.project_id), "security": c["security"]})
    except HTTPException as e:
        _update_conn(c["id"], last_error=str(e.detail))
    return _public_conn(_conn(c["id"]))


@router.post("/connections/{cid}/activate")
def activate(cid: str) -> dict:
    """The originator activates an approved request."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    if c["role"] != "originator":
        raise HTTPException(400, "only the originator of the request activates it")
    if c["status"] == "requested":
        raise HTTPException(400, "the remote enrollment has not approved the request yet")
    if c["status"] != "approved":
        raise HTTPException(400, f"the connection is already {c['status']}")
    _send(_net(c["network_id"]), f"/connections/{cid}/activated", {})
    return _public_conn(_update_conn(cid, status="active", activated_at=_iso()))


class StatusIn(BaseModel):
    enabled: bool


@router.post("/connections/{cid}/status")
def set_status(cid: str, req: StatusIn) -> dict:
    """Enable / disable this side; data stops peering when either side is disabled."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    _update_conn(cid, local_enabled=req.enabled)
    try:
        _send(_net(c["network_id"]), f"/connections/{cid}/remote-status", {"enabled": req.enabled})
    except HTTPException as e:
        _update_conn(cid, last_error=str(e.detail))
    return _public_conn(_conn(cid))


class SecurityIn(BaseModel):
    markings: list[str]


@router.post("/connections/{cid}/security")
def request_security(cid: str, req: SecurityIn) -> dict:
    """Security changes open a change request the remote side approves before they take effect."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    remote_ids = _to_remote(c, req.markings)
    rq = {"id": "sec-" + uuid.uuid4().hex[:8], "markings": req.markings, "from": "local", "at": _iso(), "state": "pending"}
    _update_conn(cid, security_requests=[*(c.get("security_requests") or []), rq])
    _send(_net(c["network_id"]), f"/connections/{cid}/security-request", {"id": rq["id"], "markings": remote_ids})
    return _public_conn(_conn(cid))


def _to_remote(c: dict, ids: list[str]) -> list[str]:
    """Local marking ids in the remote enrollment's ids (unchanged without a marking mapping)."""
    mapping = {m["local"]: m["remote"] for m in c.get("marking_map") or []}
    if not mapping:
        return list(ids)
    missing = [i for i in ids if i not in mapping]
    if missing:
        raise HTTPException(400, f"map these markings to markings of the remote enrollment first: {', '.join(_marking_names(missing))}")
    return [mapping[i] for i in ids]


@router.get("/connections/{cid}/remote-markings")
def remote_markings(cid: str) -> list[dict]:
    """The remote enrollment's markings, to map local markings to."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    n = _net(c["network_id"])
    if not _can_initiate(n):
        # the remote calls in: the markings it sent with its last hello
        if n.get("remote_markings") is None:
            raise HTTPException(409, "the remote enrollment has not sent its markings yet: they come with its hello through the relay channel"
                                if _relay_only(n) else "the remote enrollment has not sent its markings yet: it sends them when it next calls in")
        return n["remote_markings"]
    return _call(n, "GET", "/markings")


class MarkingMapIn(BaseModel):
    # local marking id -> remote marking id
    map: dict[str, str]


@router.put("/connections/{cid}/marking-map")
def set_marking_map(cid: str, req: MarkingMapIn) -> dict:
    c = _conn(cid)
    _manage_project(c["project_id"])
    remote = {m["id"]: m["name"] for m in remote_markings(cid)}
    local = {m["id"]: m["name"] for m in auth._markings()}
    rows = []
    for lid, rid in req.map.items():
        if lid not in local:
            raise HTTPException(400, f"unknown local marking {lid}")
        if rid not in remote:
            raise HTTPException(400, f"the remote enrollment has no marking {rid}")
        rows.append({"local": lid, "local_name": local[lid], "remote": rid, "remote_name": remote[rid]})
    if len({r["remote"] for r in rows}) != len(rows):
        raise HTTPException(400, "map each remote marking from one local marking")
    return _public_conn(_update_conn(cid, marking_map=rows))


class ApproveIn(BaseModel):
    request_id: str
    approve: bool = True


@router.post("/connections/{cid}/security/approve")
def approve_security(cid: str, req: ApproveIn) -> dict:
    c = _conn(cid)
    _manage_project(c["project_id"])
    reqs = c.get("security_requests") or []
    rq = next((r for r in reqs if r["id"] == req.request_id and r["from"] == "remote" and r["state"] == "pending"), None)
    if not rq:
        raise HTTPException(404, "no pending change request from the remote enrollment")
    rq["state"] = "approved" if req.approve else "rejected"
    changes: dict[str, Any] = {"security_requests": reqs}
    if req.approve:
        changes["security"] = rq["markings"]
    _update_conn(cid, **changes)
    _send(_net(c["network_id"]), f"/connections/{cid}/security-decision", {"id": rq["id"], "approve": req.approve})
    return _public_conn(_conn(cid))


def _visible_conn(c: dict) -> bool:
    import drive

    try:
        drive._item(c["project_id"])
        return True
    except HTTPException:
        return False


@router.get("/connections")
def list_connections() -> list[dict]:
    return [_public_conn(c) for c in _conns() if _visible_conn(c)]


@router.get("/connections/{cid}")
def get_connection(cid: str) -> dict:
    c = _conn(cid)
    if not _visible_conn(c):
        raise HTTPException(404, "no such peer connection")
    return _public_conn(c)


@router.delete("/connections/{cid}")
def delete_connection(cid: str) -> dict:
    c = _conn(cid)
    _manage_project(c["project_id"])
    try:
        _send(_net(c["network_id"]), f"/connections/{cid}/remote-status", {"enabled": False})
    except HTTPException:
        pass
    _save_conns([x for x in _conns() if x["id"] != cid])
    with _lock:
        rec = _read("received.json", {})
        if rec.pop(cid, None) is not None:
            _write("received.json", rec)
        rec = _read("pending_deletions.json", {})
        if rec.pop(cid, None) is not None:
            _write("pending_deletions.json", rec)
    return {"deleted": cid}


# ------------------------------------------------------------------------------------------------
# ontology peering
# ------------------------------------------------------------------------------------------------


def _type_info(tid: str) -> dict:
    import ontology

    t = ontology._object_type(tid)
    return {"id": t["id"], "api_name": t.get("api_name"), "display_name": t["display_name"], "primary_key": t["primary_key"],
            "properties": [{"api_name": p["api_name"], "display_name": p.get("display_name") or p["api_name"], "type": p["type"]} for p in t["properties"]]}


class EntitiesIn(BaseModel):
    object_type_ids: list[str] = Field(default_factory=list)
    imports_blocked: bool = False
    # join table link types offered to peer
    link_type_ids: list[str] = Field(default_factory=list)


def _link_info(lid: str) -> dict:
    import ontology_model

    lt = ontology_model._get("link-types", lid, "link type")
    if lt["kind"] != "join_table":
        raise HTTPException(400, f"{lt.get('display_name') or lid}: only join table link types peer as links (foreign keys travel with the objects)")
    return {"link_type_id": lt["id"], "display_name": lt.get("display_name") or lt["id"], "source_type_id": lt["source"]["object_type_id"],
            "target_type_id": lt["target"]["object_type_id"]}


@router.post("/connections/{cid}/ontology/entities")
def add_entities(cid: str, req: EntitiesIn) -> dict:
    """Make object types available to peer on this side (Unmapped), with their peer permissions."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    local = [x for x in c["ontology"]["local"] if x["object_type_id"] not in req.object_type_ids]
    for tid in req.object_type_ids:
        auth.check_resource("object_type", tid)
        info = _type_info(tid)
        local.append({"object_type_id": tid, "imports_blocked": req.imports_blocked, **{k: v for k, v in info.items() if k != "id"}})
    links = [x for x in c["ontology"].get("local_links") or [] if x["link_type_id"] not in req.link_type_ids]
    for lid in req.link_type_ids:
        links.append(_link_info(lid))
    _update_conn(cid, ontology={**c["ontology"], "local": local, "local_links": links})
    try:
        _send(_net(c["network_id"]), f"/connections/{cid}/entities", {"entities": [{**x, "id": x["object_type_id"]} for x in local], "links": links})
    except HTTPException as e:
        _update_conn(cid, last_error=str(e.detail))
    return _public_conn(_conn(cid))


class MappingIn(BaseModel):
    local_type_id: str
    remote_type_id: str
    properties: dict[str, str]  # local API name -> remote API name
    source_export: bool = False
    source_import: bool = False
    actions_export: bool = True
    actions_import: bool = True


@router.post("/connections/{cid}/ontology/mappings")
def create_mapping(cid: str, req: MappingIn) -> dict:
    """Create the ontology mapping; the remote side receives its mirror (directions swapped)."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    lt = next((x for x in c["ontology"]["local"] if x["object_type_id"] == req.local_type_id), None)
    rt = next((x for x in c["ontology"]["remote"] if x["id"] == req.remote_type_id), None)
    if not lt or not rt:
        raise HTTPException(400, "add the object type on both sides of the connection first (Unmapped)")
    lprops = {p["api_name"]: p["type"] for p in lt["properties"]}
    rprops = {p["api_name"]: p["type"] for p in rt["properties"]}
    for a, b in req.properties.items():
        if a not in lprops or b not in rprops:
            raise HTTPException(400, f"unknown property {a} → {b}")
        if lprops[a] != rprops[b]:
            raise HTTPException(400, f"{a} ({lprops[a]}) and {b} ({rprops[b]}) are not the same property type")
    if req.properties.get(lt["primary_key"]) != rt["primary_key"]:
        raise HTTPException(400, "map the primary key to the remote primary key")
    m = {"id": "map-" + uuid.uuid4().hex[:8], **req.model_dump(), "created_at": _iso(), "acked": None}
    if lt.get("imports_blocked"):
        m["actions_import"] = m["source_import"] = False
    mirror = {"id": m["id"], "local_type_id": req.remote_type_id, "remote_type_id": req.local_type_id, "properties": {v: k for k, v in req.properties.items()},
              "source_export": req.source_import, "source_import": req.source_export, "actions_export": req.actions_import, "actions_import": req.actions_export}
    _send(_net(c["network_id"]), f"/connections/{cid}/mapping", mirror)
    _update_conn(cid, ontology={**c["ontology"], "mappings": [*[x for x in c["ontology"]["mappings"] if x["local_type_id"] != req.local_type_id], m]})
    return _public_conn(_conn(cid))


class LinkMappingIn(BaseModel):
    local_link_type_id: str
    remote_link_type_id: str
    export: bool = True
    import_links: bool = True


@router.post("/connections/{cid}/ontology/link-mappings")
def create_link_mapping(cid: str, req: LinkMappingIn) -> dict:
    """Map a join table link type to the remote's; both of its object types must already be mapped (source to source,
    target to target)."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    ll = next((x for x in c["ontology"].get("local_links") or [] if x["link_type_id"] == req.local_link_type_id), None)
    rl = next((x for x in c["ontology"].get("remote_links") or [] if x["link_type_id"] == req.remote_link_type_id), None)
    if not ll or not rl:
        raise HTTPException(400, "add the link type on both sides of the connection first")
    types = {m["local_type_id"]: m["remote_type_id"] for m in c["ontology"]["mappings"]}
    if types.get(ll["source_type_id"]) != rl["source_type_id"] or types.get(ll["target_type_id"]) != rl["target_type_id"]:
        raise HTTPException(400, "map the link type's object types first: its source and target must map to the remote link type's source and target")
    lm = {"id": "lmap-" + uuid.uuid4().hex[:8], "local_link_type_id": req.local_link_type_id, "remote_link_type_id": req.remote_link_type_id,
          "export": req.export, "import": req.import_links, "created_at": _iso(), "sent_hash": None, "received": []}
    mirror = {"id": lm["id"], "local_link_type_id": req.remote_link_type_id, "remote_link_type_id": req.local_link_type_id,
              "export": req.import_links, "import": req.export}
    _send(_net(c["network_id"]), f"/connections/{cid}/link-mapping", mirror)
    others = [x for x in c["ontology"].get("link_mappings") or [] if x["local_link_type_id"] != req.local_link_type_id]
    _update_conn(cid, ontology={**c["ontology"], "link_mappings": [*others, lm]})
    return _public_conn(_conn(cid))


def _set_link_mapping(cid: str, lid: str, **changes: Any) -> None:
    with _lock:
        cs = _conns()
        for c in cs:
            if c["id"] == cid:
                for lm in c["ontology"].get("link_mappings") or []:
                    if lm["id"] == lid:
                        lm.update(changes)
        _save_conns(cs)


def _link_pairs(link_type_id: str) -> list[list[str]]:
    import ontology

    return sorted([str(a), str(b)] for a, b in (ontology._read(ontology.DIR / "links" / f"{link_type_id}.json", []) or []))


def _export_links(c: dict, n: dict, sequencing: str) -> list[dict]:
    jobs = []
    for lm in c["ontology"].get("link_mappings") or []:
        if not lm.get("export"):
            continue
        job = _new_job(c, "export", "data", sequencing, f"links:{lm['local_link_type_id']}")
        try:
            pairs = _link_pairs(lm["local_link_type_id"])
            digest = hashlib.sha256(json.dumps(pairs).encode()).hexdigest()
            job["objects"] = len(pairs)
            if digest == lm.get("sent_hash"):
                job.update(status="empty", finished_at=_iso())
                jobs.append(_record_job(job))
                continue
            payload = {"kind": "links", "job_id": job["id"], "mapping_id": lm["id"], "remote_link_type_id": lm["remote_link_type_id"], "pairs": pairs,
                       "sequencing": sequencing}
            _deliver(c, n, payload, job)
            _set_link_mapping(c["id"], lm["id"], sent_hash=digest)
        except HTTPException as e:
            job.update(status="failed", finished_at=_iso(), error=str(e.detail), error_instance_id=uuid.uuid4().hex[:12])
        except Exception as e:  # noqa: BLE001
            job.update(status="failed", finished_at=_iso(), error=str(e)[:500], error_instance_id=uuid.uuid4().hex[:12])
        jobs.append(_record_job(job))
    return jobs


def apply_links_payload(c: dict, payload: dict, sequencing: str) -> dict:
    """Import link pairs: add the pairs new since the last payload, remove the ones it no longer has (only pairs
    that came from peering are removed), skipping links to objects this side does not have."""
    import ontology
    import ontology_actions
    import ontology_model

    job = _new_job(c, "import", "data", sequencing, f"links:{payload.get('remote_link_type_id')}")
    lm = next((x for x in c["ontology"].get("link_mappings") or [] if x["id"] == payload.get("mapping_id")), None)
    try:
        if _peerable(c):
            raise HTTPException(409, _peerable(c))
        if not c["data_types"]["objects"]["import"] or not lm or not lm.get("import"):
            raise HTTPException(403, "imports of this link type are blocked on this side")
        lt = ontology_model._get("link-types", lm["local_link_type_id"], "link type")
        for side in ("source", "target"):
            bad = _security_ok(c, lt[side]["object_type_id"])
            if bad:
                raise HTTPException(403, bad)
        have_src = set(ontology._objects(lt["source"]["object_type_id"]))
        have_tgt = set(ontology._objects(lt["target"]["object_type_id"]))
        received = {(str(a), str(b)) for a, b in payload.get("pairs") or []}
        before = {tuple(p) for p in lm.get("received") or []}
        ops = [{"op": "add", "link_type_id": lt["id"], "source": a, "target": b} for a, b in sorted(received - before) if a in have_src and b in have_tgt]
        ops += [{"op": "remove", "link_type_id": lt["id"], "source": a, "target": b} for a, b in sorted(before - received)]
        skipped = len([1 for a, b in received - before if a not in have_src or b not in have_tgt])
        _local.importing = c["id"]  # relayed at once to the other connections, never back over this one
        try:
            with ontology._lock:
                done = ontology_actions._apply_links(ops)
        finally:
            _local.importing = None
        applied = {(o["source"], o["target"]) for o in done if o["op"] == "add"}
        kept = (before & received) | applied
        changes: dict[str, Any] = {"received": sorted([a, b] for a, b in kept)}
        local_pairs = _link_pairs(lm["local_link_type_id"])
        if {tuple(p) for p in local_pairs} == received:
            # this side now holds exactly the remote's pairs: nothing to send back (no echo loop)
            changes["sent_hash"] = hashlib.sha256(json.dumps(local_pairs).encode()).hexdigest()
        _set_link_mapping(c["id"], lm["id"], **changes)
        job.update(status="succeeded" if ops else "empty", objects=len(done), finished_at=_iso(), skipped=skipped)
    except HTTPException as e:
        job.update(status="failed", error=str(e.detail), finished_at=_iso(), error_instance_id=uuid.uuid4().hex[:12])
        _record_job(job)
        raise
    _record_job(job)
    ack = {**_new_job(c, "export", "ack", sequencing, job["producer"]), "status": "succeeded", "finished_at": _iso(), "objects": job["objects"],
           "ack_of": payload.get("job_id")}
    if not getattr(_local, "relay", False):  # from a relay file: the run's relay acknowledgement is the Ack job
        _record_job(ack)
    return {"ack_job_id": ack["id"], "applied": job["objects"], "watermark": None}


@router.delete("/connections/{cid}/ontology/mappings/{mid}")
def delete_mapping(cid: str, mid: str) -> dict:
    c = _conn(cid)
    _manage_project(c["project_id"])
    _update_conn(cid, ontology={**c["ontology"], "mappings": [m for m in c["ontology"]["mappings"] if m["id"] != mid]})
    try:
        _send(_net(c["network_id"]), f"/connections/{cid}/mapping-delete", {"id": mid})
    except HTTPException:
        pass
    return _public_conn(_conn(cid))


@router.get("/object-types")
def object_types() -> list[dict]:
    import ontology

    return [_type_info(t["id"]) for t in ontology.list_object_types()]


@router.get("/link-types")
def link_types() -> list[dict]:
    """Join table link types (the link types that peer as links)."""
    import ontology

    return [_link_info(t["id"]) for t in ontology._all("link-types") if t.get("kind") == "join_table"]


# ------------------------------------------------------------------------------------------------
# peering jobs
# ------------------------------------------------------------------------------------------------


def _jobs() -> list[dict]:
    return _read("jobs.json", [])


def _record_job(job: dict) -> dict:
    with _lock:
        jobs = [j for j in _jobs() if j["id"] != job["id"]]
        jobs.insert(0, job)
        _write("jobs.json", jobs[:JOBS_KEPT])
    return job


def _new_job(c: dict, direction: str, payload: str, sequencing: str, producer: str) -> dict:
    return {"id": "job-" + uuid.uuid4().hex[:12], "connection_id": c["id"], "direction": direction, "payload": payload, "sequencing": sequencing,
            "producer": producer, "status": "collecting_data", "started_at": _iso(), "finished_at": None, "objects": 0, "error": None}


def _peerable(c: dict) -> Optional[str]:
    """Why nothing may peer over the connection now (None: it may)."""
    if c["status"] != "active":
        return f"the connection is {c['status']}"
    if not c.get("local_enabled", True) or not c.get("remote_enabled", True):
        return "the connection is disabled on one side"
    return None


def _security_ok(c: dict, type_id: str) -> Optional[str]:
    need = set(auth.effective_markings(auth.resource_id("object_type", type_id)))
    extra = sorted(need - set(c.get("security") or []))
    return f"markings not allowed on the connection: {', '.join(_marking_names(extra))}" if extra else None


def _collect(m: dict, since: Optional[str], pks: Optional[set[str]] = None) -> list[dict]:
    """The objects to send for a mapping (its mapped properties, under the remote's API names), each with its origin
    version. `_local` (this side's property values, for a legacy fingerprint) is removed before sending."""
    import ontology

    out = []
    me = enrollment()["rid"]
    with ontology._lock:  # the objects and their versions as one snapshot (imports write both under this lock)
        store = _versions().get(m["local_type_id"]) or {}
        objs = ontology._objects(m["local_type_id"])
    for pk, o in objs.items():
        if pks is not None and pk not in pks:
            continue
        if pks is None and since and (o.get("updated_at") or "") <= since:
            continue
        props = {m["properties"][k]: v for k, v in (o.get("properties") or {}).items() if k in m["properties"]}
        out.append({"pk": pk, "properties": props, "updated_at": o.get("updated_at"), "version": _version_of(store, pk, o, me),
                    "_local": o.get("properties") or {}})
    return out


def _fp(m: dict, props: dict) -> str:
    """A fingerprint of an object's mapped properties (this side's names and values): what a remote holds (only for
    objects received without an origin version, from an enrollment that does not send one)."""
    return hashlib.sha256(json.dumps({k: props.get(k) for k in sorted(m["properties"]) if k in props}, sort_keys=True, default=str).encode()).hexdigest()[:32]


# origin versions ---------------------------------------------------------------------------------------------------
# Every peered object edit carries the version it was made at: [time, counter, origin enrollment RID] from the origin's
# hybrid logical clock (wall time in milliseconds, a counter for edits within the same millisecond, never behind a
# version this enrollment has seen), carried unchanged through relays. A receiver applies an edit only when its version
# is newer than the one it holds (last writer wins; equal times and counters are ordered by origin RID, so every
# enrollment picks the same winner), and a deletion the same way: a tombstone with its version, kept so a slower copy of
# an older edit cannot bring the object back. data/peering/versions.json: {object type id: {pk: {"v": version, "at":
# the object's updated_at when the version was recorded (None while an import is being written), "del": tombstone}}};
# an object changed here without a recorded version (another writer than an ontology edit, or before versions existed)
# has the version [its updated_at, 0, this RID].


def _versions() -> dict:
    with _lock:
        return _read("versions.json", {})


def _vkey(v: list) -> tuple:
    return (str(v[0]), int(v[1]), str(v[2]))


def _newer(a: Optional[list], b: Optional[list]) -> bool:
    """Version a is newer than b (any version is newer than none)."""
    return a is not None and (b is None or _vkey(a) > _vkey(b))


def _ms(t: str) -> str:
    try:
        return datetime.fromisoformat(t).astimezone(timezone.utc).isoformat(timespec="milliseconds")
    except (TypeError, ValueError):
        return t or ""


def _version_of(store: dict, pk: str, obj: Optional[dict], me: str) -> Optional[list]:
    """The version this side holds for an object (`obj` None: absent here, its tombstone's version or None)."""
    rec = store.get(pk)
    if obj is None:
        return rec["v"] if rec and rec.get("del") else None
    if rec and not rec.get("del") and rec.get("at") in (None, obj.get("updated_at")):
        return rec["v"]
    return [_ms(obj.get("updated_at") or ""), 0, me]


def _clock(seen: Optional[list] = None) -> Optional[list]:
    """The hybrid logical clock: a new version for a local edit, or (`seen`) move past a received version."""
    with _lock:
        ck = _read("clock.json", {"t": "", "n": 0})
        if seen is not None:
            if (str(seen[0]), int(seen[1])) > (ck["t"], ck["n"]):
                _write("clock.json", {"t": str(seen[0]), "n": int(seen[1])})
            return None
        now = _iso()
        ck = {"t": now, "n": 0} if now > ck["t"] else {"t": ck["t"], "n": ck["n"] + 1}
        _write("clock.json", ck)
        return [ck["t"], ck["n"], enrollment()["rid"]]


def _versions_update(tid: str, changes: dict[str, Optional[dict]], only_pending: bool = False) -> None:
    """Record versions (None: forget). `only_pending`: set "at" only on records still pending with that version (a
    local edit made meanwhile keeps its own)."""
    if not changes:
        return
    with _lock:
        st = _read("versions.json", {})
        cur = st.setdefault(tid, {})
        for pk, r in changes.items():
            if r is None:
                cur.pop(pk, None)
            elif only_pending:
                old = cur.get(pk)
                if old and old.get("at") is None and old.get("v") == r.get("v") and bool(old.get("del")) == bool(r.get("del")):
                    cur[pk] = r
            else:
                cur[pk] = r
        _write("versions.json", st)


def _mapped_types() -> set[str]:
    return {m["local_type_id"] for c in _conns() for m in c["ontology"]["mappings"]}


def _record_local(records: list[dict]) -> None:
    """Local edits of mapped object types get a new version (one per edit batch). Called by the ontology's
    "user_edits" hook, inside the ontology's write lock: the version is recorded with the write, so an import comparing
    versions (under the same lock) always sees it. Pending ("at" None) until the "edits" hook gives the updated_at."""
    if getattr(_local, "importing", None):
        return
    mapped = _mapped_types()
    rel = [w for w in records if w["object_type_id"] in mapped]
    if not rel:
        return
    v = _clock()
    by: dict[str, dict[str, Optional[dict]]] = {}
    pend = getattr(_local, "pending", None) or {}
    for w in rel:
        dele = w.get("op") == "delete"
        by.setdefault(w["object_type_id"], {})[str(w["primary_key"])] = {"v": v, "at": None, "del": dele}
        pend[(w["object_type_id"], str(w["primary_key"]))] = v
    _local.pending = pend
    for tid, ch in by.items():
        _versions_update(tid, ch)


def _settle_local(written: list[dict]) -> None:
    """After a local edit ("edits" hook): the recorded versions get the objects' updated_at (unless an import replaced
    them meanwhile). A write the "user_edits" hook did not see (e.g. an action revert) gets its version here."""
    pend = getattr(_local, "pending", None) or {}
    _local.pending = None
    mapped = None
    fix: dict[str, dict[str, Optional[dict]]] = {}
    new: dict[str, dict[str, Optional[dict]]] = {}
    v_new = None
    for w in written:
        tid, pk = w["object_type_id"], str(w["primary_key"])
        dele = w.get("op") == "delete"
        if (tid, pk) in pend:
            if not dele:
                fix.setdefault(tid, {})[pk] = {"v": pend[(tid, pk)], "at": w.get("updated_at"), "del": False}
            continue
        if mapped is None:
            mapped = _mapped_types()
        if tid in mapped:
            v_new = v_new or _clock()
            new.setdefault(tid, {})[pk] = {"v": v_new, "at": None if dele else w.get("updated_at"), "del": dele}
    for tid, ch in fix.items():
        _versions_update(tid, ch, only_pending=True)
    for tid, ch in new.items():
        _versions_update(tid, ch)


def _is_echo(rec: Any, o: dict, m: dict, counter: list[int]) -> bool:
    """The remote holds this object as it is here: it last sent this very version (or, from an enrollment without
    versions, these values: a fingerprint, the only case that hashes anything)."""
    if rec is None:
        return False
    if isinstance(rec, dict) and rec.get("v") is not None:
        return rec["v"] == o.get("version")
    fp = rec if isinstance(rec, str) else (rec or {}).get("fp")
    if not fp:
        return False
    counter[0] += 1
    return fp == _fp(m, o.get("_local") or {})


def _echo(cid: str, mid: str) -> dict:
    """{pk: {"v": version} or {"fp": fingerprint}} of the objects this side last received from the remote over a
    connection's mapping (and has not changed since): the remote already holds them, so exports never send them back
    (no echo loop). The version comparison is cheap: nothing is fingerprinted again on later runs."""
    with _lock:
        return dict((_read("received.json", {}).get(cid) or {}).get(mid) or {})


def _echo_update(cid: str, mid: str, changes: dict[str, Any]) -> None:
    """Record what the remote holds (None: forget the object — deleted, or changed here and sent)."""
    if not changes:
        return
    with _lock:
        rec = _read("received.json", {})
        cur = rec.setdefault(cid, {}).setdefault(mid, {})
        for pk, fp in changes.items():
            if fp is None:
                cur.pop(pk, None)
            else:
                cur[pk] = fp
        _write("received.json", rec)


# deletions owed to a remote -----------------------------------------------------------------------------------------
# Objects travel again with every sequential export (everything changed since the last acknowledgment), but a deletion
# leaves nothing to collect: one that could not be delivered (the remote offline or unreachable, a pulled payload it
# could not apply, the connection disabled for a while) is kept per connection and mapping
# (data/peering/pending_deletions.json: {connection id: {mapping id: {pk: tombstone version or None}}}) and sent with
# every export until one is delivered.


def _pending_dels(cid: str, mid: str) -> dict:
    with _lock:
        return dict((_read("pending_deletions.json", {}).get(cid) or {}).get(mid) or {})


def _pending_dels_update(cid: str, mid: str, add: Optional[dict[str, Optional[list]]] = None, done: Optional[dict[str, Optional[list]]] = None) -> None:
    """Keep deletions owed to the remote (`add`), or drop the ones delivered (`done`: dropped only when the version
    delivered is the one owed; a newer deletion owed since stays)."""
    if not add and not done:
        return
    with _lock:
        rec = _read("pending_deletions.json", {})
        cur = rec.setdefault(cid, {}).setdefault(mid, {})
        for pk, v in (add or {}).items():
            if pk not in cur or _newer(v, cur[pk]):
                cur[pk] = v
        for pk, v in (done or {}).items():
            if pk in cur and (cur[pk] is None or not _newer(cur[pk], v)):
                cur.pop(pk)
        if not cur:
            rec[cid].pop(mid, None)
        if not rec[cid]:
            rec.pop(cid, None)
        _write("pending_deletions.json", rec)


def _relay_channel(remote_rid: str, direction: str = "export") -> Optional[dict]:
    """The File data relay channel carrying peering data to (export) or from (import) a remote enrollment."""
    return next((x for x in _read("channels.json", []) if x["direction"] == direction and x["remote_rid"] == remote_rid
                 and x.get("connection_type", "file") == "file" and "peering" in x.get("integrations", [])), None)


def _deliver(c: dict, n: dict, payload: dict, job: dict) -> Optional[dict]:
    """Send an export payload: through the remote's export File relay channel when there is one (written by the next
    relay run: Ready to download), else over the network connection (the remote's ack is returned), else left for the
    remote to pull (Awaiting pull)."""
    if _relay_channel(c["remote_rid"]):
        with _lock:
            out = _read("relay_outbox.json", [])
            out.append({"connection_id": c["id"], "remote_rid": c["remote_rid"], "payload": payload})
            _write("relay_outbox.json", out)
        job["status"] = "ready_to_download"
        return None
    if _can_initiate(n):
        ack = _call(n, "POST", f"/connections/{c['id']}/payload", payload, timeout=120)
        job.update(status="succeeded", finished_at=_iso(), ack_job=ack.get("ack_job_id"))
        return ack
    _queue_pull(c["id"], payload, job)
    return None


def _queue_pull(cid: str, payload: dict, job: dict) -> None:
    """Leave a payload for the remote to pull. A sequential payload carries everything since the last acknowledgment
    and a links payload all the pairs, so either supersedes the payloads of its mapping still waiting (their deletions
    carried over); one identical to the payload already waiting is an Empty job."""
    links = payload.get("kind") == "links"
    with _lock:
        out = _read("outbox.json", [])
        if links or payload.get("sequencing") == "sequential":
            same = [p for p in out if p["connection_id"] == cid and p["payload"].get("mapping_id") == payload["mapping_id"]]
            if not links:
                have = {str(o["pk"]) for o in payload["objects"]}
                dels = list(dict.fromkeys([*[str(d) for p in same for d in p["payload"].get("deleted") or []], *payload.get("deleted", [])]))
                payload["deleted"] = [d for d in dels if d not in have]
                tombs: dict[str, list] = {}
                for t in [*(p["payload"].get("tombstones") or {} for p in same), payload.get("tombstones") or {}]:
                    for k, v in t.items():
                        if _newer(v, tombs.get(k)):
                            tombs[k] = v
                if tombs:
                    payload["tombstones"] = {k: v for k, v in tombs.items() if k in payload["deleted"]}
            if len(same) == 1 and same[0]["payload"].get("sequencing", "sequential") == payload.get("sequencing", "sequential") and all(
                    same[0]["payload"].get(k) == payload.get(k) for k in ("objects", "deleted", "pairs")):
                job.update(status="empty", finished_at=_iso(), objects=0, waiting=same[0]["payload"]["job_id"])
                return
            for p in same:
                for j in _jobs():
                    if j["id"] == p["payload"]["job_id"] and j["status"] == "awaiting_pull":
                        _record_job({**j, "status": "empty", "finished_at": _iso(), "superseded_by": job["id"]})
            out = [p for p in out if p not in same]
        out.append({"connection_id": cid, "payload": payload})
        _write("outbox.json", out[-1000:])
    job["status"] = "awaiting_pull"


def export(cid: str, sequencing: str = "sequential", only: Optional[dict[str, set[str]]] = None, deleted: Optional[dict[str, list[str]]] = None) -> list[dict]:
    """Export jobs for a connection: one per mapped object type that exports. `only`: {type id: pks} for a concurrent
    export of just-edited objects (and `deleted`: {type id: pks} removed)."""
    c = _conn(cid)
    if _peerable(c) or not c["data_types"]["objects"]["export"]:
        return []
    n = _net(c["network_id"])
    jobs = []
    for m in c["ontology"]["mappings"]:
        if not (m["actions_export"] or m["source_export"]):
            continue
        if only is not None and m["local_type_id"] not in only and m["local_type_id"] not in (deleted or {}):
            continue
        job = _new_job(c, "export", "data", sequencing, f"ontology:{m['local_type_id']}")
        owe: dict[str, Optional[list]] = {}  # the deletions this export carries: owed to the remote until delivered
        try:
            bad = _security_ok(c, m["local_type_id"])
            if bad:
                raise HTTPException(403, bad)
            objects = _collect(m, m.get("acked"), (only or {}).get(m["local_type_id"], set()) if only is not None else None)
            # no echo: an object as it came from this remote (unchanged here since) is not sent back to it; the
            # watermark does not move for them (an older payload may still wait), they are skipped again next time
            # (by origin version: an echo-skipped object is never fingerprinted again, run after run)
            echo = _echo(cid, m["id"])
            hashed = [0]
            flags = [_is_echo(echo.get(o["pk"]), o, m, hashed) for o in objects]
            echoed = [o for o, e in zip(objects, flags) if e]
            objects = [o for o, e in zip(objects, flags) if not e]
            sent_back = {o["pk"]: None for o in objects if o["pk"] in echo}  # changed here since: the remote's copy is stale
            for o in objects:
                o.pop("_local", None)
            _translate_markings(c, m, objects)
            # this export's deletions and the ones still owed to the remote (an earlier export could not deliver them)
            owed = _pending_dels(cid, m["id"])
            dels = list(dict.fromkeys([*(str(d) for d in (deleted or {}).get(m["local_type_id"]) or []), *owed]))
            store = _versions().get(m["local_type_id"]) or {} if dels else {}
            # a deletion superseded by a newer version of the object held since (re-created, or a newer edit imported
            # before this export ran) is not sent: that version travels as its own edit
            superseded = {d: (store.get(d) or {}).get("v") for d in dels if not (store.get(d) or {}).get("del", True)}
            if owed:
                import ontology

                here = ontology._objects(m["local_type_id"])
                superseded.update({d: None for d in owed if d in here and d not in superseded})
            dels = [d for d in dels if d not in superseded]
            _pending_dels_update(cid, m["id"], done={d: v for d, v in superseded.items() if d in owed and v is not None})
            _pending_dels_update(cid, m["id"], done={d: owed[d] for d, v in superseded.items() if d in owed and v is None})
            tombs = {d: store[d]["v"] for d in dels if (store.get(d) or {}).get("del")}
            owe = {d: tombs.get(d) for d in dels}
            if any(d in owed for d in dels):
                job["owed_deletions"] = sum(1 for d in dels if d in owed)
            _echo_update(cid, m["id"], {**sent_back, **{str(d): None for d in dels if str(d) in echo}})
            job["objects"] = len(objects) + len(dels)
            if echoed:
                job["echo_skipped"] = len(echoed)
            if hashed[0]:
                job["echo_fingerprinted"] = hashed[0]
            if not objects and not dels:
                job.update(status="empty", finished_at=_iso())
                jobs.append(_record_job(job))
                continue
            job["status"] = "exporting"
            watermark = max((o["updated_at"] or "") for o in objects) if objects else m.get("acked")
            payload = {"job_id": job["id"], "mapping_id": m["id"], "remote_type_id": m["remote_type_id"], "objects": objects, "deleted": dels, "watermark": watermark,
                       "sequencing": sequencing}
            if tombs:
                payload["tombstones"] = tombs
            job["status"] = "saving"
            ack = _deliver(c, n, payload, job)
            _pending_dels_update(cid, m["id"], done=owe)  # delivered (sent, written for the relay or left for a pull)
            if ack is not None:
                # a concurrent export only moves the watermark when nothing older is still unacknowledged
                if sequencing == "sequential":
                    _ack_mapping(cid, m["id"], ack.get("watermark") or watermark)
                _record_job({**_new_job(c, "import", "ack", sequencing, job["producer"]), "status": "succeeded", "finished_at": _iso(),
                             "objects": ack.get("applied", 0), "ack_of": job["id"]})
        except HTTPException as e:
            job.update(status="failed", finished_at=_iso(), error=str(e.detail), error_instance_id=uuid.uuid4().hex[:12])
            _pending_dels_update(cid, m["id"], add=owe)  # the remote offline or refusing: sent with the next export
        except Exception as e:  # noqa: BLE001
            job.update(status="failed", finished_at=_iso(), error=str(e)[:500], error_instance_id=uuid.uuid4().hex[:12])
            _pending_dels_update(cid, m["id"], add=owe)
        jobs.append(_record_job(job))
    if only is None:
        jobs += _export_links(c, n, sequencing)
    return jobs


def _translate_markings(c: dict, m: dict, objects: list[dict]) -> None:
    """Marking-typed property values in the remote's marking ids (with a marking mapping)."""
    if not c.get("marking_map"):
        return
    lt = next((x for x in c["ontology"]["local"] if x["object_type_id"] == m["local_type_id"]), None)
    names = {m["properties"][p["api_name"]] for p in (lt or {}).get("properties") or [] if p["type"] == "marking" and p["api_name"] in m["properties"]}
    for o in objects:
        for k in names & set(o["properties"]):
            v = o["properties"][k]
            if v in (None, ""):
                continue
            o["properties"][k] = _to_remote(c, [v])[0] if isinstance(v, str) else _to_remote(c, list(v))


def _ack_mapping(cid: str, mid: Optional[str], watermark: Optional[str]) -> None:
    with _lock:
        cs = _conns()
        for c in cs:
            if c["id"] == cid:
                for m in c["ontology"]["mappings"]:
                    if m["id"] == mid and watermark and watermark > (m.get("acked") or ""):
                        m["acked"] = watermark
        _save_conns(cs)


def apply_payload(c: dict, payload: dict, sequencing: str = "concurrent") -> dict:
    """Import: apply the remote's objects to the mapped local object type (as ontology edits, not sent back)."""
    import ontology

    if payload.get("kind") == "links":
        return apply_links_payload(c, payload, sequencing)

    job = _new_job(c, "import", "data", sequencing, f"ontology:{payload.get('remote_type_id')}")
    m = next((x for x in c["ontology"]["mappings"] if x["id"] == payload.get("mapping_id")), None)
    try:
        if _peerable(c):
            raise HTTPException(409, _peerable(c))
        if not c["data_types"]["objects"]["import"] or not m or not (m["actions_import"] or m["source_import"]):
            raise HTTPException(403, "imports of this object type are blocked on this side")
        bad = _security_ok(c, m["local_type_id"])
        if bad:
            raise HTTPException(403, bad)
        tid = m["local_type_id"]
        me = enrollment()["rid"]
        # compare and write under the ontology's write lock (as ontology.delete_object does): no local edit or other
        # import of the object lands between the version comparison and the write
        with _apply_lock, ontology._lock:
            local = ontology._objects(tid)
            store = _versions().get(tid) or {}
            edits = []
            unchanged = stale = 0
            seen: list[list] = []  # versions received: this side's clock moves past them (its next edits are newer)
            incoming: dict[str, Optional[list]] = {}  # pk: the version the remote sent (None: an enrollment without versions)
            held: dict[str, Optional[list]] = {}  # pk: the version this side holds afterwards
            pre: dict[str, dict] = {}  # versions recorded before writing (the relayed exports read them)
            adopt: list[dict] = []  # a newer version of what is already here: recorded and relayed on, nothing written
            tombs = payload.get("tombstones") or {}
            gone = [str(pk) for pk in payload.get("deleted") or []]
            objects = list(payload.get("objects") or [])
            # an object both sent and deleted in one payload (edited and deleted while the export was collected): only
            # the newer of its edit and its deletion counts (both compared with what is held here would apply both)
            both = {str(o["pk"]) for o in objects} & set(gone)
            for pk in both:
                ov = next((o.get("version") for o in objects if str(o["pk"]) == pk), None)
                if ov is not None and tombs.get(pk) is not None and not _newer(tombs[pk], ov):
                    gone.remove(pk)
                else:
                    objects = [o for o in objects if str(o["pk"]) != pk]
            for o in objects:
                # the sender mapped its properties to this side's API names; keep the mapped ones
                props = {k: v for k, v in (o.get("properties") or {}).items() if k in m["properties"]}
                pk = str(o["pk"])
                v = o.get("version")
                incoming[pk] = v
                obj = local.get(pk)
                cur = (obj or {}).get("properties")
                lv = _version_of(store, pk, obj, me)
                if v is not None:
                    seen.append(v)
                newer = v is None or _newer(v, lv)
                if cur is not None and all(cur.get(k) == x for k, x in props.items()):
                    # already so here (e.g. relayed back by a third enrollment): nothing written; a newer version of
                    # the same values is still recorded and relayed on (another enrollment may hold an older value)
                    unchanged += 1
                    if v is not None and newer:
                        pre[pk] = {"v": v, "at": obj.get("updated_at"), "del": False}
                        adopt.append({"op": "modify", "object_type_id": tid, "primary_key": pk})
                    held[pk] = v if newer else lv
                    continue
                if not newer:
                    # a slower copy of an older edit (or one made before this side's own): never overwrites a newer value
                    stale += 1
                    held[pk] = lv
                    continue
                if v is not None:
                    pre[pk] = {"v": v, "at": None, "del": False}
                held[pk] = v
                edits.append({"op": "modify" if obj is not None else "create", "object_type_id": tid, "primary_key": pk, "properties": props})
            for pk in gone:
                tv = tombs.get(pk)
                obj = local.get(pk)
                if tv is None:  # an enrollment without versions: deleted as before (a tombstone of this side's own, relayed on)
                    if obj is not None:
                        pre[pk] = {"v": _clock(), "at": None, "del": True}
                        edits.append({"op": "delete", "object_type_id": tid, "primary_key": pk})
                    continue
                seen.append(tv)
                lv = _version_of(store, pk, obj, me)
                if not _newer(tv, lv):
                    if tv == lv:
                        unchanged += 1
                    else:
                        stale += 1  # an older deletion than the edit (or deletion) held here
                    continue
                pre[pk] = {"v": tv, "at": None, "del": True}
                if obj is not None:
                    edits.append({"op": "delete", "object_type_id": tid, "primary_key": pk})
                else:
                    unchanged += 1
                    adopt.append({"op": "delete", "object_type_id": tid, "primary_key": pk})
            if seen:
                _clock(max(seen, key=_vkey))
            before = {pk: store.get(pk) for pk in pre}
            _versions_update(tid, pre)
            # the edits are relayed at once to the other connections mapping the type, never back over this one
            _local.importing = c["id"]
            try:
                if edits:
                    ontology.apply_edits(edits, f"peering:{c['id']}")
            except Exception:
                _versions_update(tid, before)
                raise
            finally:
                _local.importing = None
            now = ontology._objects(tid) if edits else local
            _versions_update(tid, {pk: {**r, "at": now[pk].get("updated_at")} for pk, r in pre.items()
                                   if not r["del"] and r["at"] is None and pk in now}, only_pending=True)
        if adopt:
            _on_edits(adopt, c["id"])
        # what the remote now holds: exports over this connection skip these objects until they change here
        echo: dict[str, Any] = {pk: None for pk in gone if pk not in now}
        for pk, v in incoming.items():
            if pk not in now:
                continue
            if v is None:
                echo[pk] = {"fp": _fp(m, now[pk].get("properties") or {})}
            elif held.get(pk) == v:
                echo[pk] = {"v": v}
        _echo_update(c["id"], m["id"], echo)
        # a payload of stale copies only is not Empty: it carried data (listed by default, with its stale count)
        job.update(status="succeeded" if edits or stale else "empty", objects=len(edits), finished_at=_iso())
        if unchanged:
            job["unchanged"] = unchanged
        if stale:
            job["stale_skipped"] = stale
    except HTTPException as e:
        job.update(status="failed", error=str(e.detail), finished_at=_iso(), error_instance_id=uuid.uuid4().hex[:12])
        _record_job(job)
        raise
    _record_job(job)
    ack = {**_new_job(c, "export", "ack", sequencing, job["producer"]), "status": "succeeded", "finished_at": _iso(), "objects": job["objects"],
           "ack_of": payload.get("job_id")}
    if not getattr(_local, "relay", False):  # from a relay file: the run's relay acknowledgement is the Ack job
        _record_job(ack)
    return {"ack_job_id": ack["id"], "applied": job["objects"], "watermark": payload.get("watermark")}


def _install_hook() -> None:
    """Concurrent exports: every local edit of a mapped object type is sent at once."""
    import ontology

    if getattr(ontology.MODEL_HOOKS.get("edits"), "_peering", False):
        return
    prev = ontology.MODEL_HOOKS.get("edits")

    def hook(written: list[dict]) -> Any:
        res = prev(written) if prev else None
        # an import from a peer is relayed to the other connections only (never back to the sender)
        try:
            _on_edits(written, getattr(_local, "importing", None))
        except Exception:  # noqa: BLE001 - peering never breaks an edit
            log.exception("peering: concurrent export failed")
        return res

    hook._peering = True  # type: ignore[attr-defined]
    ontology.MODEL_HOOKS["edits"] = hook
    prev_links = ontology.MODEL_HOOKS.get("links")

    def links_hook(link_type_ids: list[str]) -> Any:
        res = prev_links(link_type_ids) if prev_links else None
        try:
            _on_links(link_type_ids, getattr(_local, "importing", None))
        except Exception:  # noqa: BLE001 - peering never breaks a link edit
            log.exception("peering: concurrent link export failed")
        return res

    ontology.MODEL_HOOKS["links"] = links_hook
    prev_user = ontology.MODEL_HOOKS.get("user_edits")

    def user_edits_hook(records: list[dict]) -> Any:
        res = prev_user(records) if prev_user else None
        # inside the ontology's write lock: local edits get their origin version together with the write
        try:
            _record_local(records)
        except Exception:  # noqa: BLE001 - peering never breaks an edit
            log.exception("peering: recording origin versions failed")
        return res

    ontology.MODEL_HOOKS["user_edits"] = user_edits_hook


def _on_edits(written: list[dict], skip: Optional[str] = None) -> None:
    """Concurrent exports of edited objects over every connection mapping their type, except `skip` (the connection
    the edits were just imported from: sending them back would echo). A local edit (no `skip`) gets a new origin
    version first; an imported one keeps the version it came with (recorded by apply_payload)."""
    if skip is None:
        _settle_local(written)
    by: dict[str, set[str]] = {}
    dels: dict[str, list[str]] = {}
    for w in written:
        if w.get("op") == "delete":
            dels.setdefault(w["object_type_id"], []).append(str(w["primary_key"]))
        else:
            by.setdefault(w["object_type_id"], set()).add(str(w["primary_key"]))
    for c in _conns():
        mapped = {m["local_type_id"] for m in c["ontology"]["mappings"] if m["actions_export"]}
        if c["id"] != skip and (mapped & (set(by) | set(dels))) and not _peerable(c):
            threading.Thread(target=export, args=(c["id"], "concurrent", {k: v for k, v in by.items() if k in mapped},
                                                  {k: v for k, v in dels.items() if k in mapped}), daemon=True).start()
        elif c["id"] != skip and c["status"] == "active" and mapped & set(dels):
            # disabled for now: the deletions are owed to the remote and sent once the connection is enabled again
            store = _versions()
            for m in c["ontology"]["mappings"]:
                if m["actions_export"] and m["local_type_id"] in dels:
                    st = store.get(m["local_type_id"]) or {}
                    _pending_dels_update(c["id"], m["id"], add={pk: (st.get(pk) or {}).get("v") if (st.get(pk) or {}).get("del") else None
                                                                for pk in dels[m["local_type_id"]]})


def _on_links(link_type_ids: list[str], skip: Optional[str] = None) -> None:
    """Concurrent link exports: a changed join table link type is sent at once over every connection mapping it
    (except `skip`, the connection the links were just imported from)."""
    for c in _conns():
        mapped = {lm["local_link_type_id"] for lm in c["ontology"].get("link_mappings") or [] if lm.get("export")}
        if c["id"] != skip and mapped & set(link_type_ids) and not _peerable(c) and c["data_types"]["objects"]["export"]:
            n = _net(c["network_id"])
            threading.Thread(target=_export_links, args=(c, n, "concurrent"), daemon=True).start()


def tick() -> None:
    """Every minute: sequential (catch-up) jobs; pulls from remotes that cannot call this enrollment; data relay
    File channels (write outgoing, read incoming payload files)."""
    for n in _networks():
        if _pulls(n):
            try:
                _pull_messages(n)
            except Exception as e:  # noqa: BLE001
                log.warning("peering: pulling control messages from %s failed: %s", n["name"], e)
    nets = {n["id"]: n for n in _networks()}
    for c in _conns():
        if _peerable(c):
            continue
        try:
            export(c["id"], "sequential")
        except Exception:  # noqa: BLE001
            log.exception("peering: sequential export of %s failed", c["id"])
        n = nets.get(c["network_id"])
        if n and _pulls(n):
            try:
                pull(c["id"], messages=False)
            except Exception as e:  # noqa: BLE001
                log.warning("peering: pull of %s failed: %s", c["id"], e)
    _relay_tick()


def _sign(secret: str, msg: dict) -> str:
    """The channel secret's signature of a relay message (its connection, origin, destination, sequence and payload)."""
    body = {"connection_id": msg.get("connection_id"), "from_rid": msg.get("from_rid"), "to_rid": msg.get("to_rid"), "seq": msg.get("seq"),
            "payload": msg.get("payload")}
    return hmac.new(secret.encode(), json.dumps(body, sort_keys=True).encode(), "sha256").hexdigest()


_relay_run_lock = threading.Lock()
_apply_lock = threading.RLock()  # imports compare origin versions and write one at a time


def _update_channel(cid: str, **changes: Any) -> None:
    with _lock:
        chans = _read("channels.json", [])
        for x in chans:
            if x["id"] == cid:
                x.update(changes)
        _write("channels.json", chans)


def _relay_import(ch: dict) -> int:
    """Read an import File channel: apply each file from the channel's remote enrollment, oldest first: payloads, and the
    control messages of a data relay connection (applied by the same handlers as over HTTP). A file must come from the
    channel's remote enrollment, be addressed to this one, carry the channel secret's signature (with a secret) and a
    sequence number. Files are applied strictly in sequence, whatever order they arrive in: one whose sequence was
    already applied is a duplicate (removed), one after a missing sequence waits in the directory until the missing one
    comes. The remote's acknowledgements are taken here too, and this side acknowledges what it applied (and reports
    what it is missing) over its export channel. Applied files are removed; a file that cannot be applied, or is
    refused, is renamed *.failed (the channel and the import job record why)."""
    d = Path(ch["directory"])
    if not d.is_dir():
        return 0
    me = enrollment()["rid"]
    rr = ch["remote_rid"]
    applied = dups = 0
    pending: list[tuple[int, Path, dict]] = []
    for f in sorted(d.glob("*.peer.json")):
        try:
            msg = json.loads(f.read_text("utf-8"))
            if msg.get("from_rid") == me:
                continue  # this enrollment's own export written to a shared directory
            if msg.get("from_rid") != rr:
                raise ValueError(f"the payload comes from {msg.get('from_rid') or 'an unknown enrollment'}, not this channel's remote enrollment")
            if ch.get("secret") and not hmac.compare_digest(str(msg.get("signature") or ""), _sign(ch["secret"], msg)):
                raise ValueError("the payload signature does not match the channel secret")
            if msg.get("to_rid") != me:
                raise ValueError(f"the payload is addressed to {msg.get('to_rid') or 'no enrollment'}, not this enrollment")
            p = msg.get("payload") or {}
            if p.get("kind") == "ack":
                _relay_take_ack(rr, p)
                f.unlink()
                continue
            seq = msg.get("seq")
            if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
                raise ValueError("the payload carries no sequence number")
            pending.append((seq, f, msg))
        except Exception as e:  # noqa: BLE001
            _relay_refuse(ch, f, e)
    with _lock:
        last = int(_read("relay_seen.json", {}).get(rr) or 0)
    first = last
    waiting: Optional[int] = None
    held: list[int] = []
    for seq, f, msg in sorted(pending, key=lambda x: (x[0], x[1].name)):
        if seq <= last:
            # a copy of a file already applied (a resend whose acknowledgement was lost, a duplicated file): dropped
            try:
                f.unlink()
            except OSError:
                pass
            dups += 1
            continue
        if waiting is not None or seq > last + 1:
            # a sequence is missing: this file waits for it (the sender writes it again)
            waiting = last + 1 if waiting is None else waiting
            held.append(seq)
            continue
        try:
            with _lock:
                # consumed before it is applied: a file that fails is not applied again either
                seen = _read("relay_seen.json", {})
                seen[rr] = seq
                _write("relay_seen.json", seen)
            last = seq
            p = msg.get("payload") or {}
            if p.get("kind") == "control":
                _relay_control(ch, msg.get("connection_id"), p)
            else:
                c = _conn(msg["connection_id"])
                if c["remote_rid"] != rr:
                    raise ValueError("the payload's peer connection is not with this channel's remote enrollment")
                # no per-payload Ack job here: the relay acknowledgement of this run (an Ack job with its sequences)
                # is what actually goes back
                _local.relay = True
                try:
                    apply_payload(c, p, p.get("sequencing") or "sequential")
                finally:
                    _local.relay = False
            f.unlink()
            applied += 1
            _update_channel(ch["id"], last_ok_at=_iso(), last_error=None)
        except Exception as e:  # noqa: BLE001
            _relay_refuse(ch, f, e)
    missing = sorted(set(range(waiting, max(held) + 1)) - set(held))[:200] if waiting is not None else []
    with _lock:
        cur = next((x for x in _read("channels.json", []) if x["id"] == ch["id"]), ch)
        _update_channel(ch["id"], waiting_for=waiting, held=len(held), duplicates=int(cur.get("duplicates") or 0) + dups)
    if pending:  # applied, duplicates or waiting files: say so (an acknowledgement alone is not answered)
        _relay_ack(rr, last, missing, prev=first, imp=ch)
    return applied


def _relay_refuse(ch: dict, f: Path, e: Exception) -> None:
    err = str(getattr(e, "detail", None) or e)[:500]
    log.warning("relay import %s: %s", f.name, err)
    _update_channel(ch["id"], last_error=f"{f.name}: {err}")
    try:
        f.replace(f.with_name(f.name[: -len(".peer.json")] + ".failed"))
    except OSError:
        pass


def _seq_ranges(seqs: Any) -> str:
    """Sequence numbers as ranges: #1–#4, #7."""
    out: list[list[int]] = []
    for s in sorted(set(seqs)):
        if out and s == out[-1][1] + 1:
            out[-1][1] = s
        else:
            out.append([s, s])
    return ", ".join(f"#{a}" if a == b else f"#{a}–#{b}" for a, b in out)


def _ack_jobs(remote_rid: str, direction: str, prev: int, applied: int, missing: list[int], via: str, status: str = "succeeded",
              error: Optional[str] = None) -> None:
    """A relay acknowledgement as an Ack job (concurrent: the immediate confirmation after an import) on every peer
    connection with the remote (relay sequences are per remote enrollment, not per connection): the sequences newly
    acknowledged, the cumulative one, and those reported missing. Export: this side acknowledged; import: the remote's."""
    new = list(range(prev + 1, applied + 1))
    for c in _conns():
        if c.get("remote_rid") != remote_rid:
            continue
        job = {**_new_job(c, direction, "ack", "concurrent", f"relay:{via}"), "status": status, "finished_at": _iso(), "objects": len(new),
               "acked_seq": applied, "acknowledged": _seq_ranges(new) if new else "", "missing": _seq_ranges(missing), "via": via, "error": error}
        if status == "failed":
            job["error_instance_id"] = uuid.uuid4().hex[:12]
        _record_job(job)


def _relay_ack(remote_rid: str, applied: int, missing: list[int], prev: Optional[int] = None, imp: Optional[dict] = None) -> None:
    """Acknowledge the relay files applied from a remote (cumulative: every sequence up to `applied`) and report the
    ones missing, as a signed file in this side's export channel to it. An earlier acknowledgement of this side's still
    in the directory is replaced (the new one says more). Without an export channel the acknowledgement goes over the
    network connection when there is one; with neither there is no way back (the import channel says so)."""
    prev = applied if prev is None else prev
    ch = _relay_channel(remote_rid)
    if not ch:
        _relay_ack_network(remote_rid, applied, missing, prev, imp)
        return
    me = enrollment()["rid"]
    msg: dict[str, Any] = {"connection_id": None, "from_rid": me, "to_rid": remote_rid, "seq": None,
                           "payload": {"kind": "ack", "applied": applied, "missing": missing, "at": _iso()}}
    if ch.get("secret"):
        msg["signature"] = _sign(ch["secret"], msg)
    try:
        d = Path(ch["directory"])
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("*-ack-*.peer.json"):
            try:
                o = json.loads(old.read_text("utf-8"))
                if o.get("from_rid") == me and o.get("to_rid") == remote_rid:
                    old.unlink()
            except (OSError, ValueError):
                pass
        name = f"{time.time_ns():020d}-ack-{applied:012d}.peer.json"
        tmp = d / (name + ".tmp")
        tmp.write_text(json.dumps(msg), "utf-8")
        tmp.replace(d / name)
    except OSError as e:
        _update_channel(ch["id"], last_error=f"acknowledgement: {str(e)[:480]}")
        _ack_jobs(remote_rid, "export", prev, applied, missing, "relay", "failed", f"acknowledgement not written: {str(e)[:400]}")
        return
    if imp:
        _update_channel(imp["id"], last_ack_at=_iso(), last_ack_seq=applied)
    _ack_jobs(remote_rid, "export", prev, applied, missing, "relay")


def _relay_ack_network(remote_rid: str, applied: int, missing: list[int], prev: int, imp: Optional[dict]) -> None:
    """A relay acknowledgement over the network connection (no export channel back): sent at once when this side calls
    the remote, else left for the remote to pull (replacing an older one still waiting: the new one says more)."""
    n = next((x for x in _networks() if x["remote_rid"] == remote_rid), None)
    if not n or _relay_only(n):
        return  # no way back: the import channel's ack_warning says so (no job: nothing was acknowledged)
    body = {"applied": applied, "missing": missing, "at": _iso()}
    if _can_initiate(n):
        try:
            _call(n, "POST", "/relay-ack", body, timeout=15)
        except HTTPException as e:
            if imp:
                _update_channel(imp["id"], last_error=f"acknowledgement over the network: {str(e.detail)[:450]}")
            _ack_jobs(remote_rid, "export", prev, applied, missing, "network", "failed", str(e.detail)[:500])
            return
        status = "succeeded"
    elif n.get("inbound_secret_hash"):
        with _lock:
            msgs = [m for m in _read("messages.json", []) if not (m["network_id"] == n["id"] and m["path"] == "/relay-ack")]
            msgs.append({"id": "msg-" + uuid.uuid4().hex[:12], "network_id": n["id"], "path": "/relay-ack", "body": body, "at": _iso()})
            _write("messages.json", msgs[-1000:])
        status = "awaiting_pull"
    else:
        return
    if imp:
        _update_channel(imp["id"], last_ack_at=_iso(), last_ack_seq=applied)
    _ack_jobs(remote_rid, "export", prev, applied, missing, "network", status)


def _relay_take_ack(remote_rid: str, p: dict, via: str = "relay") -> None:
    """The remote's acknowledgement: the files up to its sequence are delivered (no longer kept for resending), and the
    sequences it reports missing are written again by the next export. Listed as an import Ack job."""
    a = p.get("applied")
    if not isinstance(a, int) or isinstance(a, bool) or a < 0:
        raise ValueError("the acknowledgement carries no sequence number")
    missing = [s for s in (p.get("missing") or []) if isinstance(s, int) and not isinstance(s, bool) and s > a][:200]
    with _lock:
        acked = _read("relay_acked.json", {})
        before = int((acked.get(remote_rid) or {}).get("seq") or 0)
        hi = max(before, a)
        acked[remote_rid] = {"seq": hi, "at": _iso(), "missing": [s for s in missing if s > hi], "via": via}
        _write("relay_acked.json", acked)
        sent = _read("relay_sent.json", {})
        if remote_rid in sent:
            sent[remote_rid] = [s for s in sent[remote_rid] if s["seq"] > hi]
            _write("relay_sent.json", sent)
    _ack_jobs(remote_rid, "import", before, hi, [s for s in missing if s > hi], via)


def _relay_control(ch: dict, cid: Optional[str], p: dict) -> dict:
    """A control message from a relay file: the hello, or a connection message for the handler its path names (the
    handler checks that the connection is with the channel's remote enrollment)."""
    n = _relay_net(ch["remote_rid"])
    parts = str(p.get("path") or "").strip("/").split("/")
    if parts == ["hello"]:
        return _h_hello(n, None, p.get("body") or {})
    h = _HANDLERS.get(parts[-1]) if len(parts) == 3 and parts[0] == "connections" else None
    if not h:
        raise HTTPException(400, f"unknown control message {p.get('path')}")
    if parts[1] != cid:
        raise HTTPException(400, "the control message names another peer connection than the file")
    return h(n, cid, p.get("body") or {})


def _relay_export() -> int:
    """Write the payloads waiting for export File channels into their directories (a temp file renamed into place,
    named so that a directory listing is in the order they were exported)."""
    me = enrollment()["rid"]
    written = 0
    with _lock:
        items = _read("relay_outbox.json", [])
        keep = []
        blocked: set[str] = set()  # remotes whose earlier file could not be written: the later ones wait, in order
        for item in items:
            ch = _relay_channel(item["remote_rid"])
            if not ch or item["remote_rid"] in blocked:
                keep.append(item)
                continue
            seqs = _read("relay_seq.json", {})
            seq = int(seqs.get(item["remote_rid"]) or 0) + 1
            msg: dict[str, Any] = {"connection_id": item["connection_id"], "from_rid": me, "to_rid": item["remote_rid"], "seq": seq, "payload": item["payload"]}
            if ch.get("secret"):
                msg["signature"] = _sign(ch["secret"], msg)
            control = item["payload"].get("kind") == "control"
            try:
                d = Path(ch["directory"])
                d.mkdir(parents=True, exist_ok=True)
                # time first (the order of a listing), then the sequence (files written within one clock tick)
                name = f"{time.time_ns():020d}-{seq:012d}-{item['payload']['id' if control else 'job_id']}.peer.json"
                tmp = d / (name + ".tmp")
                tmp.write_text(json.dumps(msg), "utf-8")
                tmp.replace(d / name)
            except OSError as e:
                keep.append(item)
                blocked.add(item["remote_rid"])
                _update_channel(ch["id"], last_error=str(e)[:500])
                continue
            seqs[item["remote_rid"]] = seq
            _write("relay_seq.json", seqs)
            if _ack_path(ch):
                # an acknowledgement can come back (an import channel, or the network connection): kept until
                # acknowledged, for resending
                sent = _read("relay_sent.json", {})
                kept = [*(sent.get(item["remote_rid"]) or []), {"seq": seq, "name": name, "msg": msg, "sent_at": time.time(), "tries": 1}]
                if len(kept) > RELAY_SENT_KEPT:
                    log.warning("peering: %d relay files to %s unacknowledged; the oldest are no longer kept for resending", len(kept), item["remote_rid"])
                sent[item["remote_rid"]] = kept[-RELAY_SENT_KEPT:]
                _write("relay_sent.json", sent)
            written += 1
            _update_channel(ch["id"], last_ok_at=_iso(), last_error=None)
            if control:
                continue
            for j in _jobs():
                if j["id"] == item["payload"]["job_id"]:
                    _record_job({**j, "status": "succeeded", "finished_at": _iso(), "relay_channel": ch["id"]})
            # one-way: written to the channel counts as acknowledged (a concurrent payload never moves the watermark)
            if item["payload"].get("kind") != "links" and item["payload"].get("sequencing", "sequential") == "sequential":
                _ack_mapping(item["connection_id"], item["payload"].get("mapping_id"), item["payload"].get("watermark"))
        _write("relay_outbox.json", keep)
    return written


def _relay_resend(me: str) -> int:
    """Write again the relay files a remote has not acknowledged: the sequences its last acknowledgement reports missing,
    and those unacknowledged for RELAY_RETRY_AFTER seconds that are no longer in the directory (lost on the way). Only
    once the remote has acknowledged something (the way back works); the same signed file, under a new name."""
    resent = 0
    with _lock:
        sent, acked = _read("relay_sent.json", {}), _read("relay_acked.json", {})
        changed = False
        for rr, items in sent.items():
            ch, a = _relay_channel(rr), acked.get(rr)
            if not ch or not a or not items:
                continue
            d = Path(ch["directory"])
            missing = set(a.get("missing") or [])
            now = time.time()
            for s in items:
                if s["seq"] not in missing and now - float(s.get("sent_at") or 0) < RELAY_RETRY_AFTER:
                    continue
                if any(_relay_mine(f, me, s["seq"]) for f in d.glob(f"*-{s['seq']:012d}-*.peer.json")):
                    continue  # still waiting to be read: not lost
                try:
                    d.mkdir(parents=True, exist_ok=True)
                    name = f"{time.time_ns():020d}-{s['name'].split('-', 1)[1]}"
                    tmp = d / (name + ".tmp")
                    tmp.write_text(json.dumps(s["msg"]), "utf-8")
                    tmp.replace(d / name)
                except OSError as e:
                    _update_channel(ch["id"], last_error=f"resending {s['seq']}: {str(e)[:480]}")
                    break
                s.update(sent_at=time.time(), tries=int(s.get("tries") or 1) + 1)
                missing.discard(s["seq"])
                resent += 1
                changed = True
            if missing != set(a.get("missing") or []):
                a["missing"] = sorted(missing)
        if changed:
            _write("relay_sent.json", sent)
            _write("relay_acked.json", acked)
    return resent


def _relay_mine(f: Path, me: str, seq: int) -> bool:
    try:
        m = json.loads(f.read_text("utf-8"))
        return m.get("from_rid") == me and m.get("seq") == seq
    except (OSError, ValueError):
        return False


def _relay_tick() -> dict:
    # one run at a time (the minute loop and Run channels now): a file is read and applied once. Incoming files (and
    # acknowledgements) first, so that a resend only follows the latest acknowledgement
    with _relay_run_lock:
        imported = sum(_relay_import(ch) for ch in _read("channels.json", []) if ch["direction"] == "import" and ch.get("connection_type", "file") == "file"
                       and "peering" in ch.get("integrations", []))
        written = _relay_export()
        return {"written": written, "imported": imported, "resent": _relay_resend(enrollment()["rid"])}


_started = {"v": False}


def start() -> None:
    if _started["v"]:
        return
    _started["v"] = True

    def loop() -> None:
        while True:
            time.sleep(SEQUENTIAL_EVERY)
            try:
                tick()
            except Exception:  # noqa: BLE001
                log.exception("peering tick failed")

    threading.Thread(target=loop, daemon=True, name="peering").start()


@router.get("/connections/{cid}/jobs")
def connection_jobs(cid: str, direction: Optional[str] = None, payload: Optional[str] = None, sequencing: Optional[str] = None, producer: Optional[str] = None,
                    status: Optional[str] = None, q: str = "", since: Optional[str] = None, until: Optional[str] = None) -> list[dict]:
    """The jobs table: filters by job ID, direction, payload type, sequencing, producer, statuses (Empty hidden unless
    asked for) and time (a job matches when it ran at some point in the range)."""
    get_connection(cid)
    statuses = set(status.split(",")) if status else None
    out = []
    for j in _jobs():
        if j["connection_id"] != cid:
            continue
        if statuses is None and j["status"] == "empty":
            continue
        if (direction and j["direction"] != direction) or (payload and j["payload"] != payload) or (sequencing and j["sequencing"] != sequencing):
            continue
        if (producer and j["producer"] != producer) or (statuses and j["status"] not in statuses) or (q and q not in j["id"]):
            continue
        if since and (j.get("finished_at") or _iso()) < since:
            continue
        if until and j["started_at"] > until:
            continue
        out.append(j)
    return out


@router.post("/connections/{cid}/sync")
def sync_now(cid: str) -> list[dict]:
    """Run a sequential export now."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    jobs = export(cid, "sequential")
    if any(j["status"] == "ready_to_download" for j in jobs):
        _relay_export()  # write File relay payloads now, not at the next minute
        ids = {j["id"] for j in jobs}
        jobs = [j for j in _jobs() if j["id"] in ids]
    return jobs


@router.post("/channels/run")
def run_channels() -> dict:
    """Run the File data relay channels now: write waiting export payloads, read and apply incoming payload files."""
    _admin()
    return _relay_tick()


def _pull_messages(n: dict) -> int:
    """Take the control messages the remote left for this side (it cannot call this enrollment) and apply them; the
    hello first, which also tells the remote this side's markings and completes this side of the network connection."""
    check_network(n["id"])
    msgs = _call(n, "GET", "/messages")
    done, errors = [], []
    for m in msgs:
        parts = m.get("path", "").strip("/").split("/")
        h = _HANDLERS.get(parts[-1]) if len(parts) == 3 and parts[0] == "connections" else None
        try:
            if parts == ["relay-ack"]:
                # the remote's acknowledgement of this side's relay files (it has no export channel back)
                try:
                    _relay_take_ack(n["remote_rid"], m.get("body") or {}, "network")
                except ValueError as e:
                    raise HTTPException(400, str(e)) from None
                done.append(m["id"])
                continue
            if not h:
                raise HTTPException(400, f"unknown control message {m.get('path')}")
            h(_net(n["id"]), parts[1], m.get("body") or {})
        except HTTPException as e:
            errors.append(f"{m.get('path')}: {e.detail}")
            _update_net(n["id"], last_error=f"{m.get('path')}: {e.detail}")
        done.append(m["id"])
    if done:
        _call(n, "POST", "/messages/ack", {"ids": done, "errors": errors})
    return len(done)


@router.post("/connections/{cid}/pull")
def pull_now(cid: str) -> dict:
    """Pull now: the remote's control messages and waiting payloads (for remotes that cannot call this enrollment)."""
    c = _conn(cid)
    _manage_project(c["project_id"])
    return pull(cid)


def pull(cid: str, messages: bool = True) -> dict:
    c = _conn(cid)
    n = _net(c["network_id"])
    if not _can_initiate(n):
        raise HTTPException(409, f"{n['name']}: this side does not call the remote; the remote pulls from it")
    got = _pull_messages(n) if messages else 0
    c = _conn(cid)
    payloads = _call(n, "GET", f"/connections/{cid}/pull")
    applied, failed = 0, 0
    for p in payloads:
        try:
            res = apply_payload(c, p, p.get("sequencing") or "sequential")
        except HTTPException as e:
            failed += 1
            _call(n, "POST", f"/connections/{cid}/ack", {"job_id": p["job_id"], "mapping_id": p.get("mapping_id"), "error": str(e.detail)})
            continue
        _call(n, "POST", f"/connections/{cid}/ack", {"job_id": p["job_id"], "mapping_id": p.get("mapping_id"), "watermark": p.get("watermark"),
                                                      "applied": res["applied"]})
        applied += res["applied"]
    return {"messages": got, "payloads": len(payloads), "applied": applied, "failed": failed}


# ------------------------------------------------------------------------------------------------
# peer profiles (beta)
# ------------------------------------------------------------------------------------------------


class ProfileIn(BaseModel):
    hub_name: str = Field(min_length=1, max_length=120)
    spoke_name: str = Field(min_length=1, max_length=120)
    project_id: str
    auto_create: bool = True
    security: list[str] = Field(default_factory=list)
    objects_direction: Literal["export", "import", "both"] = "export"
    object_types: list[dict] = Field(default_factory=list)  # [{object_type_id, direction}]


@router.get("/profiles")
def list_profiles() -> list[dict]:
    return _read("profiles.json", [])


@router.post("/profiles")
def create_profile_pair(req: ProfileIn) -> list[dict]:
    """Create peer profile pair: the hub profile as configured and its mirrored spoke profile (drafts)."""
    import drive

    drive._item(req.project_id, need="editor")
    pair = "pair-" + uuid.uuid4().hex[:8]
    flip = {"export": "import", "import": "export", "both": "both"}
    hub = {"id": "prof-" + uuid.uuid4().hex[:8], "pair": pair, "side": "hub", "name": req.hub_name, "project_id": req.project_id, "auto_create": req.auto_create,
           "security": req.security, "objects_direction": req.objects_direction, "object_types": req.object_types, "state": "draft", "created_at": _iso()}
    spoke = {**hub, "id": "prof-" + uuid.uuid4().hex[:8], "side": "spoke", "name": req.spoke_name, "objects_direction": flip[req.objects_direction],
             "object_types": [{**o, "direction": flip.get(o.get("direction", "export"), "both")} for o in req.object_types]}
    profiles = _read("profiles.json", [])
    profiles += [hub, spoke]
    _write("profiles.json", profiles)
    return [hub, spoke]


class InstallIn(BaseModel):
    project_id: str
    remote_strategy: Literal["all", "specific"] = "all"
    remote_rid: Optional[str] = None


@router.post("/profiles/{pid}/install")
def install_profile(pid: str, req: InstallIn) -> dict:
    """Install a profile here: peer requests are created (or existing connections configured) for every network
    connection the remote strategy selects."""
    _manage_project(req.project_id)
    profiles = _read("profiles.json", [])
    p = next((x for x in profiles if x["id"] == pid), None)
    if not p:
        raise HTTPException(404, "no such profile")
    if p.get("state") == "installed":
        raise HTTPException(400, "uninstall the profile before changing or reinstalling it")
    exp = p["objects_direction"] in ("export", "both")
    imp = p["objects_direction"] in ("import", "both")
    results = []
    for n in _networks():
        if req.remote_strategy == "specific" and n["remote_rid"] != req.remote_rid:
            continue
        existing = next((c for c in _conns() if c["network_id"] == n["id"] and c["project_id"] == req.project_id), None)
        try:
            if existing:
                _update_conn(existing["id"], data_types={**existing["data_types"], "objects": {"export": exp, "import": imp}}, security=p["security"], profile_id=pid)
                results.append({"network": n["name"], "connection_id": existing["id"], "status": "configured"})
            elif p["auto_create"]:
                r = create_request(PeerRequestIn(network_id=n["id"], project_id=req.project_id, export_objects=exp, import_objects=imp, security=p["security"]))
                _update_conn(r["connection"]["id"], profile_id=pid)
                results.append({"network": n["name"], "connection_id": r["connection"]["id"], "status": "requested", "code": r["code"]})
        except HTTPException as e:
            results.append({"network": n["name"], "status": "failed", "error": str(e.detail)})
    p.update(state="installed", installed={"project_id": req.project_id, "remote_strategy": req.remote_strategy, "remote_rid": req.remote_rid, "at": _iso(), "results": results})
    _write("profiles.json", profiles)
    return p


@router.post("/profiles/{pid}/uninstall")
def uninstall_profile(pid: str) -> dict:
    profiles = _read("profiles.json", [])
    p = next((x for x in profiles if x["id"] == pid), None)
    if not p:
        raise HTTPException(404, "no such profile")
    p.update(state="draft", installed=None)
    _write("profiles.json", profiles)
    return p


# ------------------------------------------------------------------------------------------------
# the API peer enrollments call (authenticated by the network connection's secret)
# ------------------------------------------------------------------------------------------------


def _peer(request: Request) -> dict:
    rid = request.headers.get("x-peer-enrollment", "")
    secret = request.headers.get("x-peer-secret", "")
    if not rid or not secret:
        raise HTTPException(401, "peer requests carry X-Peer-Enrollment and X-Peer-Secret")
    h = _sha(secret)
    with _lock:
        nets = _networks()
        n = next((x for x in nets if x["remote_rid"] == rid), None)
        if n and n.get("inbound_secret_hash") and hmac.compare_digest(n["inbound_secret_hash"], h):
            return n
        invites = _read("invites.json", [])
        inv = next((i for i in invites if hmac.compare_digest(i["secret_hash"], h)), None)
        if not inv:
            raise HTTPException(401, "unknown peer secret: enter this enrollment's current invite code on the remote")
        if not n:
            # the remote entered our code before we entered theirs: a half-complete network connection
            n = {"id": "net-" + uuid.uuid4().hex[:10], "name": f"Enrollment …{rid[-8:]}", "remote_rid": rid, "remote_title": "", "remote_url": "",
                 "outbound_secret": "", "remote_direction": "bidirectional", "created_at": _iso()}
            nets.append(n)
        n["inbound_secret_hash"] = h
        n["local_direction"] = inv["direction"]
        _save_networks(nets)
        _write("invites.json", [i for i in invites if i["secret_hash"] != inv["secret_hash"]])
        return n


def _rconn(n: dict, cid: str) -> dict:
    c = _conn(cid)
    if c["network_id"] != n["id"]:
        raise HTTPException(403, "this connection is not with your enrollment")
    return c


@remote.post("/hello")
def r_hello(request: Request, body: dict) -> dict:
    n = _peer(request)
    changes: dict[str, Any] = {}
    if body.get("title"):
        changes["remote_title"] = body["title"]
    if body.get("url") and not n.get("remote_url"):
        changes["remote_url"] = body["url"]
    if isinstance(body.get("markings"), list):
        # kept for the marking mapping when this side cannot call the remote to list them
        changes["remote_markings"] = [{"id": str(m.get("id")), "name": str(m.get("name"))} for m in body["markings"] if isinstance(m, dict)][:1000]
    if not _can_initiate(n):
        # the remote calls in: its hello is how this side knows the connection works
        changes["last_ok_at"] = _iso()
        changes["last_error"] = None
    if changes:
        _update_net(n["id"], **changes)
    e = enrollment()
    out = {"rid": e["rid"], "title": e.get("title"), "at": _iso()}
    if n.get("outbound_secret"):
        # which of the caller's own invites this side entered: a remote that is never called back (this side is
        # Ingress only, or the caller is Egress only) completes its half of the connection from it
        out["your_invite"] = _sha(n["outbound_secret"])
    return out


def _h_approved(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    _update_conn(cid, status="approved", remote_project=body.get("project_name"), approved_at=_iso(), security=body.get("security", c["security"]))
    return {"ok": True}


@remote.post("/connections/{cid}/approved")
def r_approved(cid: str, request: Request, body: dict) -> dict:
    return _h_approved(_peer(request), cid, body)


def _h_activated(n: dict, cid: str, body: dict) -> dict:
    _rconn(n, cid)
    _update_conn(cid, status="active", activated_at=_iso())
    return {"ok": True}


@remote.post("/connections/{cid}/activated")
def r_activated(cid: str, request: Request) -> dict:
    return _h_activated(_peer(request), cid, {})


def _h_status(n: dict, cid: str, body: dict) -> dict:
    _rconn(n, cid)
    _update_conn(cid, remote_enabled=bool(body.get("enabled")))
    return {"ok": True}


@remote.post("/connections/{cid}/remote-status")
def r_status(cid: str, request: Request, body: dict) -> dict:
    return _h_status(_peer(request), cid, body)


def _h_security_request(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    if any(r["id"] == body.get("id") for r in c.get("security_requests") or []):
        return {"ok": True, "duplicate": True}
    rq = {"id": body["id"], "markings": body["markings"], "from": "remote", "at": _iso(), "state": "pending"}
    _update_conn(cid, security_requests=[*(c.get("security_requests") or []), rq])
    return {"ok": True}


@remote.post("/connections/{cid}/security-request")
def r_security_request(cid: str, request: Request, body: dict) -> dict:
    return _h_security_request(_peer(request), cid, body)


@remote.post("/connections/{cid}/security-decision")
def r_security_decision(cid: str, request: Request, body: dict) -> dict:
    return _h_security_decision(_peer(request), cid, body)


def _h_security_decision(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    reqs = c.get("security_requests") or []
    rq = next((r for r in reqs if r["id"] == body.get("id")), None)
    if rq:
        rq["state"] = "approved" if body.get("approve") else "rejected"
        changes: dict[str, Any] = {"security_requests": reqs}
        if body.get("approve"):
            changes["security"] = rq["markings"]
        _update_conn(cid, **changes)
    return {"ok": True}


def _h_entities(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    _update_conn(cid, ontology={**c["ontology"], "remote": body.get("entities") or [], "remote_links": body.get("links") or []})
    return {"ok": True}


@remote.post("/connections/{cid}/entities")
def r_entities(cid: str, request: Request, body: dict) -> dict:
    return _h_entities(_peer(request), cid, body)


@remote.get("/markings")
def r_markings(request: Request) -> list[dict]:
    """This enrollment's markings (ids and names), for the remote's marking mapping."""
    _peer(request)
    return _my_markings()


def _my_markings() -> list[dict]:
    return [{"id": m["id"], "name": m["name"]} for m in auth._markings()]


def _hello_body() -> dict:
    return {"title": enrollment().get("title"), "markings": _my_markings()}


def _h_hello(n: dict, cid: Optional[str], body: dict) -> dict:
    """A remote's hello through a data relay channel: its platform title and markings (it cannot be called)."""
    changes: dict[str, Any] = {"last_ok_at": _iso(), "last_error": None}
    if body.get("title"):
        changes["remote_title"] = str(body["title"])[:120]
    if isinstance(body.get("markings"), list):
        changes["remote_markings"] = [{"id": str(m.get("id")), "name": str(m.get("name"))} for m in body["markings"] if isinstance(m, dict)][:1000]
    _update_net(n["id"], **changes)
    return {"ok": True}


def _h_link_mapping(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    if not any(x["link_type_id"] == body.get("local_link_type_id") for x in c["ontology"].get("local_links") or []):
        raise HTTPException(400, "that link type is not available to peer on this side: add it first")
    lm = {**body, "created_at": _iso(), "sent_hash": None, "received": []}
    others = [x for x in c["ontology"].get("link_mappings") or [] if x["local_link_type_id"] != body["local_link_type_id"]]
    _update_conn(cid, ontology={**c["ontology"], "link_mappings": [*others, lm]})
    return {"ok": True}


@remote.post("/connections/{cid}/link-mapping")
def r_link_mapping(cid: str, request: Request, body: dict) -> dict:
    return _h_link_mapping(_peer(request), cid, body)


def _h_mapping(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    lt = next((x for x in c["ontology"]["local"] if x["object_type_id"] == body.get("local_type_id")), None)
    if not lt:
        raise HTTPException(400, "that object type is not available to peer on this side: add it (Unmapped) first")
    m = {**body, "created_at": _iso(), "acked": None}
    if lt.get("imports_blocked"):
        m["actions_import"] = m["source_import"] = False
    _update_conn(cid, ontology={**c["ontology"], "mappings": [*[x for x in c["ontology"]["mappings"] if x["local_type_id"] != body["local_type_id"]], m]})
    return {"ok": True}


@remote.post("/connections/{cid}/mapping")
def r_mapping(cid: str, request: Request, body: dict) -> dict:
    return _h_mapping(_peer(request), cid, body)


def _h_mapping_delete(n: dict, cid: str, body: dict) -> dict:
    c = _rconn(n, cid)
    _update_conn(cid, ontology={**c["ontology"], "mappings": [m for m in c["ontology"]["mappings"] if m["id"] != body.get("id")]})
    return {"ok": True}


@remote.post("/connections/{cid}/mapping-delete")
def r_mapping_delete(cid: str, request: Request, body: dict) -> dict:
    return _h_mapping_delete(_peer(request), cid, body)


# control messages a side that cannot call the remote leaves for the remote to pull, by their path's last segment
_HANDLERS = {"approved": _h_approved, "activated": _h_activated, "remote-status": _h_status, "security-request": _h_security_request,
             "security-decision": _h_security_decision, "entities": _h_entities, "link-mapping": _h_link_mapping, "mapping": _h_mapping,
             "mapping-delete": _h_mapping_delete}


@remote.get("/messages")
def r_messages(request: Request) -> list[dict]:
    """Control messages waiting for the remote (this side cannot call it): it pulls them, applies each and acks them."""
    n = _peer(request)
    return [m for m in _read("messages.json", []) if m["network_id"] == n["id"]]


@remote.post("/messages/ack")
def r_messages_ack(request: Request, body: dict) -> dict:
    n = _peer(request)
    ids = set(body.get("ids") or [])
    with _lock:
        _write("messages.json", [m for m in _read("messages.json", []) if not (m["network_id"] == n["id"] and m["id"] in ids)])
    if body.get("errors"):
        _update_net(n["id"], last_error="the remote could not apply: " + "; ".join(body["errors"])[:500])
    return {"ok": True}


@remote.post("/relay-ack")
def r_relay_ack(request: Request, body: dict) -> dict:
    """The remote's acknowledgement of this side's relay files, over the network connection (it has no export
    channel back): cumulative, with the sequences it is missing."""
    n = _peer(request)
    try:
        _relay_take_ack(n["remote_rid"], body, "network")
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True}


@remote.post("/connections/{cid}/payload")
def r_payload(cid: str, request: Request, body: dict) -> dict:
    n = _peer(request)
    return apply_payload(_rconn(n, cid), body, "concurrent")


@remote.get("/connections/{cid}/pull")
def r_pull(cid: str, request: Request) -> list[dict]:
    """Payloads awaiting pull (this side cannot call the remote): it takes them and acknowledges each."""
    n = _peer(request)
    _rconn(n, cid)
    return [p["payload"] for p in _read("outbox.json", []) if p["connection_id"] == cid]


@remote.post("/connections/{cid}/ack")
def r_ack(cid: str, request: Request, body: dict) -> dict:
    """The puller applied a payload (or could not: `error`). A failed payload leaves the outbox too: the next sequential
    job sends everything since the last acknowledgment again."""
    n = _peer(request)
    c = _rconn(n, cid)
    with _lock:
        out = _read("outbox.json", [])
        item = next((p for p in out if p["connection_id"] == cid and p["payload"]["job_id"] == body.get("job_id")), None)
        _write("outbox.json", [p for p in out if p is not item])
    if not item:
        return {"ok": True, "unknown": True}
    err = body.get("error")
    # a concurrent payload only moves the watermark when nothing older is still unacknowledged (as in a push)
    if not err and item["payload"].get("sequencing", "sequential") == "sequential" and item["payload"].get("kind") != "links":
        _ack_mapping(cid, item["payload"].get("mapping_id"), item["payload"].get("watermark"))
    if err and item["payload"].get("kind") == "links":
        _set_link_mapping(cid, item["payload"]["mapping_id"], sent_hash=None)  # send the pairs again
    elif err and item["payload"].get("deleted"):  # objects go again with the next sequential job, deletions are owed
        tombs = item["payload"].get("tombstones") or {}
        _pending_dels_update(cid, item["payload"].get("mapping_id"), add={str(d): tombs.get(str(d)) for d in item["payload"]["deleted"]})
    for j in _jobs():
        if j["id"] == body.get("job_id"):
            _record_job({**j, "status": "failed" if err else "succeeded", "finished_at": _iso(), "error": err,
                         **({"error_instance_id": uuid.uuid4().hex[:12]} if err else {})})
    if not err:
        _record_job({**_new_job(c, "import", "ack", item["payload"].get("sequencing", "sequential"), "pull"), "status": "succeeded", "finished_at": _iso(),
                     "objects": body.get("applied", 0), "ack_of": body.get("job_id")})
    return {"ok": True}
