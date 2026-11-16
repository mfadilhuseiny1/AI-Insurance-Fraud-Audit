"""Network: egress policies (direct connections and private links) and ingress allowlists, as
Foundry's Control Panel network egress / ingress and private link configuration.

Egress policies say which external destinations data connections may reach:
  direct        the destination is reached over the network as is (its public or routable address)
  private_link  the destination's hostname is routed to a private endpoint — a VPC / VNet endpoint
                address or DNS name (AWS PrivateLink, Azure Private Endpoint, GCP Private Service
                Connect, or any private address) — while TLS still uses the original hostname, the way
                a private link's private DNS works
  agent_proxy   the destination is reached through a Data Connection agent inside its network
                (dc_agents.py): the hostname resolves to a loopback listener here that relays the TCP
                connection through the agent's outbound WebSocket (the policy's target is the agent)
A policy matches a host exactly, a wildcard (*.example.com) or a CIDR block, on some or all ports.
Private link routes always apply; *enforcement* additionally refuses destinations no policy allows
(connections, syncs, exports, virtual tables, REST sources and webhooks). Besides the main host a
connection is configured with, every name a connector resolves while it works (an OAuth token
endpoint, a SaaS instance URL handed back at sign-in, a redirect, a pre-signed storage URL) is
checked too: connector calls run in an egress scope (egress_scope) and the resolver refuses a
destination no policy allows. Drivers that resolve names in C (libpq) are covered by the main
host check only.

Ingress: an allowlist of client CIDR blocks for the API, and a separate one for listener endpoints
(external systems posting events). Loopback clients are always allowed (the web app's server side
runs here), and enforcement cannot be turned on in a way that locks out the client turning it on.
Behind a reverse proxy or a private endpoint load balancer, trusted proxies let the client address
be read from X-Forwarded-For.

Mounted by server.py under /api/network.
"""

from __future__ import annotations

import contextvars
import ipaddress
import logging
import re
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import db

log = logging.getLogger("bluesandai.network")
router = APIRouter(prefix="/api/network")

SCHEMA = """
CREATE TABLE IF NOT EXISTS network_policies (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    kind        text NOT NULL,
    provider    text,
    host        text NOT NULL,
    ports       jsonb NOT NULL DEFAULT '[]',
    target      text,
    endpoint_id text,
    description text,
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS network_settings (
    key    text PRIMARY KEY,
    value  jsonb NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "enforce_egress": False,
    "enforce_ingress": False,
    "ingress_cidrs": [],
    "enforce_listener_ingress": False,
    "listener_cidrs": [],
    "trusted_proxies": [],
}
PROVIDERS = ["aws", "azure", "gcp", "other"]

_lock = threading.Lock()
_cache: dict[str, Any] = {"policies": [], "settings": dict(DEFAULT_SETTINGS), "routes": {}}
_original_getaddrinfo = socket.getaddrinfo
# set while a data connection works: names resolved in it are checked against egress policies
_scope: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("egress_scope", default=None)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with db._connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        if not cur.description:
            return []
        names = [d.name for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]


def _exec(sql: str, params: tuple = ()) -> None:
    with db._lock, db._connect() as conn:
        conn.execute(sql, params)


def startup() -> None:
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(SCHEMA)
    reload()
    socket.getaddrinfo = _getaddrinfo  # private link routing for every Python-level connection


def reload() -> None:
    policies = _rows("SELECT * FROM network_policies ORDER BY created_at")
    settings = dict(DEFAULT_SETTINGS)
    for r in _rows("SELECT key, value FROM network_settings"):
        settings[r["key"]] = r["value"]
    routes = {p["host"].lower(): p["target"] for p in policies if p["enabled"] and p["kind"] == "private_link" and p.get("target") and _is_hostname(p["host"])}
    try:
        import dc_agents

        # agent proxy: the host resolves to a loopback listener relaying through the agent
        routes.update(dc_agents.sync_tunnels(policies))
    except Exception:  # noqa: BLE001 - routing never fails a reload
        log.exception("agent proxy listeners")
    with _lock:
        _cache.update(policies=policies, settings=settings, routes=routes)


def _is_hostname(pattern: str) -> bool:
    return not pattern.startswith("*.") and "/" not in pattern and not _is_ip(pattern)


def _is_ip(v: str) -> bool:
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------------------------
# private link routing
# --------------------------------------------------------------------------------------------


def route_for(host: Optional[str]) -> Optional[str]:
    """The private endpoint a hostname is routed to (None: no private link)."""
    if not host:
        return None
    return _cache["routes"].get(host.lower().rstrip("."))


def route_address(host: Optional[str]) -> Optional[str]:
    """The private endpoint as an IP address (for drivers that resolve names themselves, e.g. libpq)."""
    target = route_for(host)
    if not target:
        return None
    if _is_ip(target):
        return target
    infos = _original_getaddrinfo(target, None, proto=socket.IPPROTO_TCP)
    return infos[0][4][0] if infos else None


def _getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
    if isinstance(host, bytes):  # (anyio / httpx pass the name IDNA-encoded; the idna codec only decodes strictly)
        try:
            host = host.decode("idna")
        except UnicodeError:
            host = host.decode("ascii", "replace")
    what = _scope.get()
    if what and isinstance(host, str):
        check_egress(host, _port(args[0] if args else kwargs.get("port")), what)
    target = route_for(host) if isinstance(host, str) else None
    return _original_getaddrinfo(target or host, *args, **kwargs)


def _port(v: Any) -> Optional[int]:
    if isinstance(v, int):
        return v
    if isinstance(v, (str, bytes)):
        v = v.decode() if isinstance(v, bytes) else v
        if v.isdigit():
            return int(v)
        try:
            return socket.getservbyname(v, "tcp")
        except OSError:
            return None
    return None


@contextmanager
def egress_scope(what: str = "This connection") -> Iterator[None]:
    """Every host resolved inside is checked against egress policies (when enforcement is on)."""
    token = _scope.set(what)
    try:
        yield
    finally:
        _scope.reset(token)


# --------------------------------------------------------------------------------------------
# egress
# --------------------------------------------------------------------------------------------


def _matches(pattern: str, host: str) -> bool:
    pattern, host = pattern.lower().strip(), host.lower().rstrip(".")
    if "/" in pattern:
        try:
            net = ipaddress.ip_network(pattern, strict=False)
        except ValueError:
            return False
        addrs = [host] if _is_ip(host) else []
        if not addrs:
            try:
                addrs = sorted({i[4][0] for i in _original_getaddrinfo(route_for(host) or host, None, proto=socket.IPPROTO_TCP)})
            except OSError:
                return False
        return any(ipaddress.ip_address(a) in net for a in addrs)
    if pattern.startswith("*."):
        return host.endswith(pattern[1:]) and host != pattern[2:]
    return host == pattern


def policy_for(host: Optional[str], port: Optional[int]) -> Optional[dict]:
    if not host:
        return None
    for p in _cache["policies"]:
        if not p["enabled"]:
            continue
        ports = p.get("ports") or []
        if ports and port and int(port) not in [int(x) for x in ports]:
            continue
        if _matches(p["host"], host):
            return p
    return None


class EgressDenied(Exception):
    pass


def check_egress(host: Optional[str], port: Optional[int], what: str = "This connection") -> Optional[dict]:
    """The policy allowing host:port; raises EgressDenied when enforcement is on and none does."""
    p = policy_for(host, port)
    if p is None and host and _cache["settings"].get("enforce_egress") and not _loopback_name(host):
        raise EgressDenied(
            f"{what} needs to reach {host}{':' + str(port) if port else ''}, which no egress policy allows — "
            "add a direct or private link policy under Data Connection → Network"
        )
    return p


def _loopback_name(host: str) -> bool:
    h = host.lower()
    if h in ("localhost", "localhost.localdomain"):
        return True
    return _is_ip(h) and ipaddress.ip_address(h).is_loopback


# --------------------------------------------------------------------------------------------
# ingress
# --------------------------------------------------------------------------------------------


def _in(ip: str, cidrs: list[str]) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for c in cidrs:
        try:
            if a in ipaddress.ip_network(c, strict=False):
                return True
        except ValueError:
            continue
    return False


def client_ip(request: Request) -> str:
    """The client's address; through trusted proxies, the last untrusted hop of X-Forwarded-For."""
    peer = request.client.host if request.client else ""
    trusted = _cache["settings"].get("trusted_proxies") or []
    if peer and trusted and _in(peer, trusted):
        hops = [h.strip() for h in (request.headers.get("x-forwarded-for") or "").split(",") if h.strip()]
        for h in reversed(hops):
            if not _in(h, trusted):
                return h
        return hops[0] if hops else peer
    return peer


def _loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def ingress_allowed(request: Request) -> Optional[str]:
    """None when the request may proceed; otherwise why it is refused."""
    s = _cache["settings"]
    listener = request.url.path.startswith("/api/listen/")
    enforce, cidrs = (s.get("enforce_listener_ingress"), s.get("listener_cidrs") or []) if listener else (s.get("enforce_ingress"), s.get("ingress_cidrs") or [])
    if not enforce:
        return None
    ip = client_ip(request)
    if _loopback(ip) or _in(ip, cidrs):
        return None
    return f"{ip} is not in the {'listener ' if listener else ''}ingress allowlist"


# --------------------------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------------------------


def _require() -> None:
    if not db.enabled():
        raise HTTPException(503, "Network settings need the PostgreSQL database (BLUESANDAI_DATABASE_URL)")


def _require_admin() -> None:
    """Egress policies, ingress allowlists and trusted proxies are enrollment settings: administrators change them."""
    _require()
    import auth

    auth.require_admin()


def _public(p: dict) -> dict:
    return {**{k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in p.items()}}


class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["direct", "private_link", "agent_proxy"] = "direct"
    provider: Optional[Literal["aws", "azure", "gcp", "other"]] = None
    host: str = Field(min_length=1, max_length=255)
    ports: list[int] = []
    # private_link: the private endpoint (an IP address or a DNS name) the host is routed to
    target: Optional[str] = None
    # the cloud provider's endpoint id (vpce-…, a private endpoint resource id, a PSC endpoint), for reference
    endpoint_id: Optional[str] = None
    description: str = ""
    enabled: bool = True


HOST_RE = re.compile(r"^(\*\.)?[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$")


def _validate(req: PolicyIn, pid: Optional[str] = None) -> dict:
    host = req.host.strip().lower().rstrip(".")
    if "/" in host:
        try:
            ipaddress.ip_network(host, strict=False)
        except ValueError:
            raise HTTPException(400, f'"{req.host}" is not a valid CIDR block') from None
    elif not (_is_ip(host) or HOST_RE.match(host)):
        raise HTTPException(400, f'"{req.host}" is not a host name, *.wildcard, IP address or CIDR block')
    for p in req.ports:
        if not 0 < p < 65536:
            raise HTTPException(400, f"{p} is not a port")
    target = (req.target or "").strip().rstrip(".") or None
    if req.kind == "private_link":
        if not _is_hostname(host):
            raise HTTPException(400, "A private link routes one host name (not a wildcard, IP or CIDR) to its private endpoint")
        if not target:
            raise HTTPException(400, "Enter the private endpoint: its private IP address or DNS name")
        if not (_is_ip(target) or HOST_RE.match(target)):
            raise HTTPException(400, f'"{target}" is not an IP address or DNS name')
        if target.lower() == host:
            raise HTTPException(400, "The private endpoint must differ from the host it routes")
    if req.kind == "agent_proxy":
        if "/" in host or host.startswith("*."):
            raise HTTPException(400, "An agent proxy policy names one host (a host name or IP address), not a wildcard or CIDR block")
        if not req.ports:
            raise HTTPException(400, "List the ports the agent proxy relays (e.g. 5432 for PostgreSQL, 443 for HTTPS)")
        if not target:
            raise HTTPException(400, "Choose the agent")
        import dc_agents

        dc_agents.agent_for_use(target)
        clash = [p for p in _cache["policies"] if p["kind"] == "agent_proxy" and p["enabled"] and p["host"] == host and set(p["ports"]) & set(req.ports)
                 and p["id"] != pid]
        if clash and req.enabled:
            raise HTTPException(409, f"{host} is already relayed on port(s) {sorted(set(clash[0]['ports']) & set(req.ports))} by the policy {clash[0]['name']}")
        return {"host": host, "ports": sorted(set(req.ports)), "target": target}
    return {"host": host, "ports": sorted(set(req.ports)), "target": target if req.kind == "private_link" else None}


@router.get("/policies")
def list_policies() -> list[dict]:
    _require()
    return [_public(p) for p in _rows("SELECT * FROM network_policies ORDER BY created_at")]


@router.post("/policies")
def create_policy(req: PolicyIn) -> dict:
    _require_admin()
    v = _validate(req)
    if req.kind == "private_link" and any(p["kind"] == "private_link" and p["host"] == v["host"] for p in _cache["policies"]):
        raise HTTPException(409, f"{v['host']} already has a private link")
    now = _now()
    pid = uuid.uuid4().hex[:12]
    _exec(
        "INSERT INTO network_policies (id, name, kind, provider, host, ports, target, endpoint_id, description, enabled, created_at, updated_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (pid, req.name.strip(), req.kind, req.provider, v["host"], Jsonb(v["ports"]), v["target"], (req.endpoint_id or "").strip() or None, req.description.strip(), req.enabled, now, now),
    )
    reload()
    return _public(_rows("SELECT * FROM network_policies WHERE id = %s", (pid,))[0])


@router.put("/policies/{pid}")
def update_policy(pid: str, req: PolicyIn) -> dict:
    _require_admin()
    if not _rows("SELECT 1 FROM network_policies WHERE id = %s", (pid,)):
        raise HTTPException(404, "Policy not found")
    v = _validate(req, pid)
    _exec(
        "UPDATE network_policies SET name = %s, kind = %s, provider = %s, host = %s, ports = %s, target = %s, endpoint_id = %s, description = %s, enabled = %s, updated_at = %s WHERE id = %s",
        (req.name.strip(), req.kind, req.provider, v["host"], Jsonb(v["ports"]), v["target"], (req.endpoint_id or "").strip() or None, req.description.strip(), req.enabled, _now(), pid),
    )
    reload()
    return _public(_rows("SELECT * FROM network_policies WHERE id = %s", (pid,))[0])


@router.delete("/policies/{pid}")
def delete_policy(pid: str) -> dict:
    _require_admin()
    _exec("DELETE FROM network_policies WHERE id = %s", (pid,))
    reload()
    return {"deleted": pid}


class SettingsIn(BaseModel):
    enforce_egress: Optional[bool] = None
    enforce_ingress: Optional[bool] = None
    ingress_cidrs: Optional[list[str]] = None
    enforce_listener_ingress: Optional[bool] = None
    listener_cidrs: Optional[list[str]] = None
    trusted_proxies: Optional[list[str]] = None


def _cidrs(values: list[str], what: str) -> list[str]:
    out = []
    for v in values:
        v = v.strip()
        if not v:
            continue
        try:
            out.append(str(ipaddress.ip_network(v, strict=False)))
        except ValueError:
            raise HTTPException(400, f'{what}: "{v}" is not an IP address or CIDR block') from None
    return sorted(set(out))


@router.get("/settings")
def get_settings(request: Request) -> dict:
    _require()
    return {**_cache["settings"], "your_ip": client_ip(request), "routes": len(_cache["routes"])}


@router.put("/settings")
def put_settings(req: SettingsIn, request: Request) -> dict:
    _require_admin()
    s = dict(_cache["settings"])
    for k in ("ingress_cidrs", "listener_cidrs", "trusted_proxies"):
        v = getattr(req, k)
        if v is not None:
            s[k] = _cidrs(v, k.replace("_", " "))
    for k in ("enforce_egress", "enforce_ingress", "enforce_listener_ingress"):
        v = getattr(req, k)
        if v is not None:
            s[k] = v
    ip = client_ip(request)
    if s["enforce_ingress"] and not _loopback(ip) and not _in(ip, s["ingress_cidrs"]):
        raise HTTPException(409, f"Your address {ip} is not in the ingress allowlist — add it first, or you would lock yourself out")
    if s["enforce_egress"] and not _cache["policies"]:
        raise HTTPException(409, "Add at least one egress policy before enforcing egress — otherwise every connection is refused")
    with db._lock, db._connect() as conn:
        for k, v in s.items():
            conn.execute("INSERT INTO network_settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (k, Jsonb(v)))
    reload()
    return get_settings(request)


class CheckIn(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(443, gt=0, lt=65536)


@router.post("/check")
def check(req: CheckIn) -> dict:
    """How a destination is reached: the policy that applies, where traffic goes, and whether a TCP
    connection succeeds."""
    _require()
    host = req.host.strip().lower().rstrip(".")
    p = policy_for(host, req.port)
    target = route_for(host)
    out: dict[str, Any] = {
        "host": host,
        "port": req.port,
        "policy": _public(p) if p else None,
        "route": ("agent_proxy" if p and p.get("kind") == "agent_proxy" else "private_link") if target else "direct",
        "target": target,
        "allowed": bool(p) or not _cache["settings"].get("enforce_egress") or _loopback_name(host),
        "enforced": bool(_cache["settings"].get("enforce_egress")),
    }
    t = time.monotonic()
    try:
        infos = _original_getaddrinfo(target or host, req.port, proto=socket.IPPROTO_TCP)
        out["addresses"] = sorted({i[4][0] for i in infos})
    except OSError as e:
        out.update(reachable=False, error=f"DNS: {e}", ms=round((time.monotonic() - t) * 1000))
        return out
    try:
        with socket.create_connection((out["addresses"][0], req.port), timeout=6):
            out.update(reachable=True, ms=round((time.monotonic() - t) * 1000))
    except OSError as e:
        out.update(reachable=False, error=f"TCP: {e}", ms=round((time.monotonic() - t) * 1000))
    return out
