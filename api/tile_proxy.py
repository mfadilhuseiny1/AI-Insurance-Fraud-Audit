"""Tile proxy for map layers: vector tiles (MVT), raster tiles, TileJSON and style documents fetched by the platform
for tile servers that do not send CORS headers. Served by geospatial.py as GET /api/geo/tile-proxy?url=<upstream URL>.

A server-side fetch of a user-supplied URL is an SSRF risk, so every request goes through these checks:
  1. URL shape: http / https only, at most 2,048 characters, no whitespace or control characters, no credentials
     (user:pass@), no IPv6 zone ids, a valid port; the host is lower-cased and IDNA-encoded.
  2. Numeric-host tricks: a host whose last label is a number (decimal 2130706433, octal 0177.1, hex 0x7f.1,
     short forms 127.1) must be a canonical dotted quad, else refused — the resolver would read it as an address.
  3. Allow-list: the host (and port) must match an entry an administrator configured (data/geo/sources.json
     `tile_proxy_hosts`, edited in the Map admin page) or the BSAI_TILE_PROXY_HOSTS environment variable. Entries are
     `host`, `*.domain` (sub-domains only) or an IP literal, optionally `:port`; without a port only the scheme's
     default port (80 / 443) is allowed.
  4. Resolution: the host is resolved and EVERY address must be public: loopback, private (RFC 1918, ULA), link-local,
     shared (100.64/10), multicast, reserved, unspecified, documentation and other non-global ranges are refused, also
     inside IPv4-mapped / 6to4 / Teredo / NAT64 IPv6 addresses; cloud metadata addresses (169.254.169.254,
     fd00:ec2::254, 100.100.100.200, 168.63.129.16) always are. The platform's egress policies apply too.
  5. The connection goes to the checked address (the URL's host is sent as Host and as the TLS SNI / certificate
     name), so a DNS answer cannot change between the check and the connection (DNS rebinding).
  6. Redirects are not followed by the HTTP client: each Location goes through checks 1–5 again, at most 3 hops.
  7. Responses: at most 5 MB (decoded), 10 s per read / 5 s to connect / 20 s in all, and only tile, TileJSON or style
     content types (MVT / protobuf / octet-stream, PNG / JPEG / WebP, JSON); anything else is refused.
  8. Nothing of the user's request is forwarded: no cookies, no Authorization, no client headers; the HTTP client
     ignores proxy environment variables and .netrc (trust_env off) and keeps no cookies between requests.
  9. Each request is logged (user, host, path without query values, status, bytes, cache, time, refusal reason) and
     kept in a short in-memory log for administrators.
Successful answers are cached in memory (by URL, at most 64 MB) with an ETag; a client's If-None-Match gets a 304.
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import re
import socket
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional
from urllib.parse import parse_qsl, urljoin, urlsplit

import httpx

log = logging.getLogger("bluesandai.tile_proxy")

ENV_HOSTS = "BSAI_TILE_PROXY_HOSTS"
MAX_URL = 2048
MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 3
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DEADLINE = 20.0
CACHE_BYTES = 64 * 1024 * 1024
CACHE_TTL = 3600  # seconds, when the tile server says nothing (bounded by its max-age, 60 s .. 1 day)
EMPTY_TTL = 300  # 204 / 404 (empty tiles)
USER_AGENT = "BluesandAI-TileProxy/1.0"

# content types a tile / TileJSON / style answer may have (parameters such as charset ignored)
CONTENT_TYPES = {
    "application/vnd.mapbox-vector-tile",
    "application/x-protobuf",
    "application/protobuf",
    "application/vnd.google.protobuf",
    "application/x-mvt",
    "application/octet-stream",
    "binary/octet-stream",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/json",
}

# cloud instance metadata services: never reachable, whatever else is configured
METADATA_NETS = [ipaddress.ip_network(n) for n in ("169.254.169.254/32", "fd00:ec2::254/128", "100.100.100.200/32", "168.63.129.16/32")]
NAT64 = ipaddress.ip_network("64:ff9b::/96")
# tests only (set in-process, never from configuration): networks treated as public, e.g. a local tile server
TEST_ALLOWED_NETS: list = []

Resolver = Callable[[str, int], list[str]]


class Refused(Exception):
    """The request is not allowed (or the answer not acceptable): status for the client and a reason."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


# ------------------------------------------------------------------------------------------------ allow-list


_LABEL = r"[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?"
_HOST_RE = re.compile(rf"^(\*\.)?{_LABEL}(\.{_LABEL})*$")
_NUMERIC_LABEL = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")


@dataclass(frozen=True)
class Entry:
    host: str  # lower-case IDNA host, "*.domain" or an IP address (IPv6 without brackets)
    port: Optional[int]

    def matches(self, host: str, port: int, default_port: int) -> bool:
        if self.port is None and port != default_port:
            return False
        if self.port is not None and port != self.port:
            return False
        if self.host.startswith("*."):
            return host.endswith(self.host[1:]) and host != self.host[2:]
        return host == self.host


def parse_entry(text: str) -> Entry:
    """One allow-list entry: host, *.domain or an IP literal ([v6] with a port), optionally :port."""
    s = text.strip().lower().rstrip("/")
    if "://" in s:
        s = s.split("://", 1)[1].split("/", 1)[0]
    port: Optional[int] = None
    m = re.fullmatch(r"\[([0-9a-f:.]+)\](?::(\d{1,5}))?", s)
    if m:
        host, port = m.group(1), int(m.group(2)) if m.group(2) else None
    elif s.count(":") > 1:
        host = s  # a bare IPv6 address
    else:
        host, _, p = s.partition(":")
        if p:
            if not p.isdigit():
                raise ValueError(f"{text}: the port must be a number")
            port = int(p)
    host = host.rstrip(".")
    if port is not None and not 0 < port < 65536:
        raise ValueError(f"{text}: the port must be between 1 and 65535")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        why = address_refusal(str(ip))
        if why:
            raise ValueError(f"{text}: {why}")
        return Entry(str(ip), port)
    try:
        host = host.encode("idna").decode("ascii") if not host.startswith("*.") else "*." + host[2:].encode("idna").decode("ascii")
    except UnicodeError:
        raise ValueError(f"{text}: not a valid host name") from None
    if not _HOST_RE.match(host):
        raise ValueError(f"{text}: not a host name, *.domain or IP address")
    labels = host.split(".")
    if _NUMERIC_LABEL.match(labels[-1]):
        raise ValueError(f"{text}: a host ending in a number must be a canonical IP address")
    if host.startswith("*.") and len(labels) < 3:
        raise ValueError(f"{text}: a wildcard needs a domain of at least two labels (*.example.com)")
    if host in ("localhost", "localhost.localdomain") or host.endswith(".localhost") or host.endswith(".internal") or host == "metadata":
        raise ValueError(f"{text}: local and metadata host names cannot be allowed")
    return Entry(host, port)


def parse_entries(items: Iterable[str]) -> tuple[list[Entry], list[str]]:
    """Entries and the errors of the ones that are not valid."""
    out, errors = [], []
    for t in items:
        if not str(t).strip():
            continue
        try:
            out.append(parse_entry(str(t)))
        except ValueError as e:
            errors.append(str(e))
    return out, errors


def env_entries() -> list[Entry]:
    entries, errors = parse_entries(os.environ.get(ENV_HOSTS, "").replace(";", ",").split(","))
    for e in errors:
        log.warning("%s: %s (ignored)", ENV_HOSTS, e)
    return entries


def entry_text(e: Entry) -> str:
    h = f"[{e.host}]" if ":" in e.host else e.host
    return f"{h}:{e.port}" if e.port else h


# ------------------------------------------------------------------------------------------------ address checks


def _embedded_v4(a: ipaddress.IPv6Address) -> list[ipaddress.IPv4Address]:
    out = []
    if a.ipv4_mapped:
        out.append(a.ipv4_mapped)
    if a.sixtofour:
        out.append(a.sixtofour)
    if a.teredo:
        out.extend(a.teredo)
    if a in NAT64:
        out.append(ipaddress.IPv4Address(int(a) & 0xFFFFFFFF))
    # IPv4-compatible (deprecated ::a.b.c.d)
    if int(a) >> 32 == 0 and int(a) > 1:
        out.append(ipaddress.IPv4Address(int(a) & 0xFFFFFFFF))
    return out


def address_refusal(ip: str) -> Optional[str]:
    """Why this address may not be reached (None: a public address)."""
    if "%" in ip:
        return f"{ip} is a scoped (link-local) address"
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return f"{ip} is not an IP address"
    if any(a in n for n in METADATA_NETS if n.version == a.version):
        return f"{a} is a cloud metadata address"
    if a.version == 6:
        for v4 in _embedded_v4(a):
            why = address_refusal(str(v4))
            if why:
                return f"{a} embeds {v4}: {why}"
    if any(a in n for n in TEST_ALLOWED_NETS if n.version == a.version):
        return None
    for test, what in (
        ("is_unspecified", "unspecified"),
        ("is_loopback", "a loopback address"),
        ("is_link_local", "a link-local address"),
        ("is_multicast", "a multicast address"),
        ("is_private", "a private address"),
        ("is_reserved", "a reserved address"),
    ):
        if getattr(a, test):
            return f"{a} is {what}"
    if getattr(a, "is_site_local", False):
        return f"{a} is a site-local address"
    if not a.is_global:
        return f"{a} is not a public address"
    return None


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


# ------------------------------------------------------------------------------------------------ URL checks


@dataclass
class Target:
    url: str
    scheme: str
    host: str  # IDNA, lower case, no brackets
    port: int
    path: str  # path + ?query, as sent
    address: str  # the checked IP the connection goes to

    @property
    def host_header(self) -> str:
        h = f"[{self.host}]" if ":" in self.host else self.host
        return h if self.port == (443 if self.scheme == "https" else 80) else f"{h}:{self.port}"

    @property
    def pinned_url(self) -> str:
        a = f"[{self.address}]" if ":" in self.address else self.address
        return f"{self.scheme}://{a}:{self.port}{self.path}"


def check_url(url: str, allow: list[Entry], resolver: Optional[Resolver] = None, *, egress: bool = True, resolve: bool = True) -> Optional[Target]:
    """Checks 1–5 for one URL (see the module docstring); raises Refused. resolve=False: checks 1–3 and the egress policies only (None back)."""
    if not isinstance(url, str) or not url:
        raise Refused(400, "a tile URL is needed")
    if len(url) > MAX_URL:
        raise Refused(400, f"the URL is longer than {MAX_URL} characters")
    if any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in url) or "\\" in url:
        raise Refused(400, "the URL contains whitespace, control characters or backslashes")
    u = urlsplit(url)
    scheme = u.scheme.lower()
    if scheme not in ("http", "https"):
        raise Refused(400, "only http and https URLs can be proxied")
    if "@" in u.netloc or u.username is not None or u.password is not None:
        raise Refused(400, "URLs with credentials (user:password@) cannot be proxied")
    if "%" in u.netloc:
        raise Refused(400, "percent-encoded or scoped host names cannot be proxied")
    try:
        port = u.port or (443 if scheme == "https" else 80)
    except ValueError:
        raise Refused(400, "the URL's port is not valid") from None
    raw = (u.hostname or "").rstrip(".")
    if not raw:
        raise Refused(400, "the URL has no host")
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        ip = None
    if ip is not None:
        host = str(ip)
    else:
        try:
            host = raw.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise Refused(400, "the URL's host name is not valid") from None
        if not _HOST_RE.match(host) or host.startswith("*."):
            raise Refused(400, "the URL's host name is not valid")
        if _NUMERIC_LABEL.match(host.split(".")[-1]):
            # 2130706433, 0x7f.1, 0177.0.0.1, 127.1 ...: resolvers read these as addresses
            raise Refused(403, f"{raw} is a non-canonical IP address")
    if not any(e.matches(host, port, 443 if scheme == "https" else 80) for e in allow):
        raise Refused(403, f"{host}:{port} is not on the tile proxy's allow-list (Map admin → Tile proxy)")
    # egress policies (Data Connection → Network) also on a cache hit (resolve=False), so a policy change takes effect at once
    if egress:
        try:
            import network

            network.check_egress(host, port, "The tile proxy")
        except ImportError:
            pass
        except Exception as e:  # network.EgressDenied
            if type(e).__name__ == "EgressDenied":
                raise Refused(403, str(e)) from None
            raise
    if not resolve:
        return None
    if ip is not None:
        addresses = [host]
    else:
        try:
            addresses = (resolver or system_resolver)(host, port)
        except (OSError, UnicodeError) as e:
            raise Refused(502, f"{host} could not be resolved: {e}") from None
        if not addresses:
            raise Refused(502, f"{host} could not be resolved")
    for a in addresses:
        why = address_refusal(a)
        if why:
            raise Refused(403, f"{host} resolves to a refused address: {why}")
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    return Target(url=url, scheme=scheme, host=host, port=port, path=path, address=addresses[0])


# ------------------------------------------------------------------------------------------------ fetching


@dataclass
class Answer:
    status: int  # 200, 204, 304 (revalidated), 404
    body: bytes = b""
    content_type: str = ""
    upstream_etag: Optional[str] = None
    max_age: Optional[int] = None
    no_store: bool = False
    hops: list[str] = field(default_factory=list)


def _cache_control(v: str) -> tuple[Optional[int], bool]:
    max_age, no_store = None, False
    for part in v.lower().split(","):
        k, _, val = part.strip().partition("=")
        if k in ("no-store", "private"):
            no_store = True
        elif k in ("max-age", "s-maxage") and val.strip().isdigit():
            max_age = int(val.strip())
    return max_age, no_store


def _content_type(v: str) -> str:
    return v.split(";", 1)[0].strip().lower()


def fetch(url: str, allow: list[Entry], *, resolver: Optional[Resolver] = None, if_none_match: Optional[str] = None,
          transport: Optional[httpx.BaseTransport] = None, egress: bool = True) -> Answer:
    """GET url through checks 1–8; redirects re-checked on every hop. Raises Refused."""
    deadline = time.monotonic() + DEADLINE
    hops: list[str] = []
    current = url
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=TIMEOUT, transport=transport) as client:
        for hop in range(MAX_REDIRECTS + 1):
            if time.monotonic() > deadline:
                raise Refused(504, f"the tile server took longer than {DEADLINE:.0f} s")
            t = check_url(current, allow, resolver, egress=egress)
            assert t is not None
            hops.append(f"{t.host}:{t.port}")
            headers = {
                "Host": t.host_header,
                "User-Agent": USER_AGENT,
                "Accept": "application/vnd.mapbox-vector-tile, application/x-protobuf, application/json, image/webp, image/png, image/jpeg, */*;q=0.1",
                "Accept-Encoding": "gzip, deflate",
            }
            if if_none_match and hop == 0:
                headers["If-None-Match"] = if_none_match
            ext = {"sni_hostname": t.host} if t.scheme == "https" else {}
            client.cookies.clear()
            try:
                with client.stream("GET", t.pinned_url, headers=headers, extensions=ext) as r:
                    if r.status_code in (301, 302, 303, 307, 308):
                        loc = r.headers.get("location")
                        if not loc:
                            raise Refused(502, f"the tile server redirected (HTTP {r.status_code}) without a Location")
                        if hop == MAX_REDIRECTS:
                            raise Refused(502, f"more than {MAX_REDIRECTS} redirects")
                        current = urljoin(current, loc.strip())
                        continue
                    if r.status_code == 304:
                        max_age, no_store = _cache_control(r.headers.get("cache-control", ""))
                        return Answer(304, upstream_etag=r.headers.get("etag") or if_none_match, max_age=max_age, no_store=no_store, hops=hops)
                    if r.status_code in (204, 404):
                        return Answer(r.status_code, hops=hops)
                    if r.status_code != 200:
                        raise Refused(502, f"the tile server answered HTTP {r.status_code}")
                    ctype = _content_type(r.headers.get("content-type", ""))
                    if ctype not in CONTENT_TYPES:
                        raise Refused(415, f"the tile server answered {ctype or 'without a content type'}, not a tile, TileJSON or style")
                    length = r.headers.get("content-length")
                    if length and length.isdigit() and int(length) > MAX_BYTES and not r.headers.get("content-encoding"):
                        raise Refused(413, f"the answer is larger than {MAX_BYTES // (1024 * 1024)} MB")
                    chunks, size = [], 0
                    for chunk in r.iter_bytes():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise Refused(413, f"the answer is larger than {MAX_BYTES // (1024 * 1024)} MB")
                        if time.monotonic() > deadline:
                            raise Refused(504, f"the tile server took longer than {DEADLINE:.0f} s")
                        chunks.append(chunk)
                    max_age, no_store = _cache_control(r.headers.get("cache-control", ""))
                    return Answer(200, b"".join(chunks), ctype, r.headers.get("etag"), max_age, no_store, hops)
            except httpx.TimeoutException:
                raise Refused(504, "the tile server did not answer in time") from None
            except httpx.HTTPError as e:
                raise Refused(502, f"the tile server could not be reached: {type(e).__name__}") from None
    raise Refused(502, f"more than {MAX_REDIRECTS} redirects")  # pragma: no cover


# ------------------------------------------------------------------------------------------------ cache, log


@dataclass
class Cached:
    status: int
    body: bytes
    content_type: str
    etag: str
    upstream_etag: Optional[str]
    expires: float


class Cache:
    def __init__(self, max_bytes: int = CACHE_BYTES):
        self.max_bytes = max_bytes
        self.items: OrderedDict[str, Cached] = OrderedDict()
        self.size = 0
        self.lock = threading.Lock()

    def get(self, key: str) -> Optional[Cached]:
        with self.lock:
            c = self.items.get(key)
            if c:
                self.items.move_to_end(key)
            return c

    def put(self, key: str, c: Cached) -> None:
        with self.lock:
            old = self.items.pop(key, None)
            if old:
                self.size -= len(old.body)
            if len(c.body) > self.max_bytes:
                return
            self.items[key] = c
            self.size += len(c.body)
            while self.size > self.max_bytes and self.items:
                _, gone = self.items.popitem(last=False)
                self.size -= len(gone.body)

    def clear(self) -> None:
        with self.lock:
            self.items.clear()
            self.size = 0


CACHE = Cache()
LOG: deque = deque(maxlen=200)


def redact(url: str) -> str:
    """host + path, query parameter names only (tile servers' API keys travel in the query)."""
    try:
        u = urlsplit(url)
        q = "&".join(f"{k}=…" for k, _ in parse_qsl(u.query, keep_blank_values=True))
        return f"{u.scheme}://{u.hostname or ''}{':' + str(u.port) if u.port else ''}{u.path[:300]}{'?' + q if q else ''}"
    except ValueError:
        return url[:80] + "…"


def record(user: str, url: str, status: int, size: int, cache: str, ms: float, reason: str = "", hops: Optional[list[str]] = None) -> None:
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "user": user, "url": redact(url), "status": status, "bytes": size,
             "cache": cache, "ms": round(ms, 1), **({"reason": reason} if reason else {}), **({"hops": hops} if hops and len(hops) > 1 else {})}
    LOG.append(entry)
    (log.warning if status >= 400 else log.info)("tile proxy %s %s -> %s %sB cache=%s %.0fms%s", user, entry["url"], status, size, cache, ms,
                                                  f" refused: {reason}" if reason else "")


def _etag(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest()[:32] + '"'


def get(url: str, allow: list[Entry], *, user: str = "", resolver: Optional[Resolver] = None, transport: Optional[httpx.BaseTransport] = None,
        egress: bool = True) -> tuple[Cached, str]:
    """A tile through the cache: (the answer, "hit" / "revalidated" / "miss"). Refusals are logged and re-raised.
    The URL is checked against the allow-list even on a cache hit, so taking a host off it takes effect at once."""
    t0 = time.monotonic()
    try:
        check_url(url, allow, resolver, egress=egress, resolve=False)
        hit = CACHE.get(url)
        if hit and hit.expires > time.time():
            record(user, url, hit.status, len(hit.body), "hit", (time.monotonic() - t0) * 1000)
            return hit, "hit"
        a = fetch(url, allow, resolver=resolver, transport=transport, egress=egress,
                  if_none_match=hit.upstream_etag if hit and hit.status == 200 else None)
        ttl = a.max_age if a.max_age is not None else CACHE_TTL
        ttl = max(60, min(ttl, 86400))
        if a.status == 304 and hit:
            c = Cached(hit.status, hit.body, hit.content_type, hit.etag, a.upstream_etag or hit.upstream_etag, time.time() + ttl)
            state = "revalidated"
        elif a.status == 304:
            raise Refused(502, "the tile server answered 304 to an unconditional request")
        elif a.status in (204, 404):
            c = Cached(a.status, b"", "", '"empty"', None, time.time() + EMPTY_TTL)
            state = "miss"
        else:
            c = Cached(200, a.body, a.content_type, _etag(a.body), a.upstream_etag, time.time() + ttl)
            state = "miss"
        if not a.no_store:
            CACHE.put(url, c)
        record(user, url, c.status, len(c.body), state, (time.monotonic() - t0) * 1000, hops=a.hops)
        return c, state
    except Refused as e:
        record(user, url, e.status, 0, "-", (time.monotonic() - t0) * 1000, e.reason)
        raise
