"""The API on the IPv6 loopback too: a byte relay from [::1]:<port> to 127.0.0.1:<port>.

uvicorn listens on 0.0.0.0 (IPv4) only. A browser on http://localhost:9300 calls the API at http://localhost:8300, and
`localhost` resolves to ::1 first: every new connection waited for the IPv6 attempt to fail before trying IPv4 — 0.2 s
measured with curl, 0.3 s in Chrome (its happy-eyeballs delay), and uvicorn closes an idle keep-alive connection after
5 s, so the wait came back all day (2026-10-30: "all loading really slow"; 127.0.0.1 answered in 4 ms). The relay only
copies bytes, so the app, its event loop and its background loops never see a second server; a long-lived connection
(server-sent events, a websocket) passes through as it is. If [::1]:<port> cannot be taken, nothing changes.
"""

from __future__ import annotations

import logging
import os
import socket
import threading

log = logging.getLogger("bluesandai.loopback6")
_started = False


def _pipe(src: socket.socket, dst: socket.socket, done: threading.Semaphore, both: list[socket.socket]) -> None:
    """Copy one direction until its end; half-close the other side so a keep-alive request/response still completes;
    the second direction to finish closes both sockets."""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    if not done.acquire(blocking=False):  # the other direction is done too
        for s in both:
            try:
                s.close()
            except OSError:
                pass


def _serve(listener: socket.socket, port: int) -> None:
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        try:
            upstream = socket.create_connection(("127.0.0.1", port), timeout=10)
            upstream.settimeout(None)
        except OSError:
            client.close()
            continue
        for s in (client, upstream):
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        done = threading.Semaphore(1)  # the first direction to finish takes it; the second closes the sockets
        both = [client, upstream]
        threading.Thread(target=_pipe, args=(client, upstream, done, both), daemon=True, name="loopback6-up").start()
        threading.Thread(target=_pipe, args=(upstream, client, done, both), daemon=True, name="loopback6-down").start()


def startup() -> None:
    """Start the relay once, for the API's port (BLUESANDAI_API_PORT, instance.env); off with BLUESANDAI_LOOPBACK6=0."""
    global _started
    if _started or os.environ.get("BLUESANDAI_LOOPBACK6", "1") == "0" or not socket.has_ipv6:
        return
    try:
        port = int(os.environ.get("BLUESANDAI_API_PORT") or 0)
    except ValueError:
        return
    if not port:
        return
    try:
        listener = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        listener.bind(("::1", port))
        listener.listen(256)
    except OSError as e:
        log.info("IPv6 loopback relay not started on [::1]:%s: %s", port, e)
        return
    _started = True
    threading.Thread(target=_serve, args=(listener, port), daemon=True, name="loopback6").start()
    log.info("IPv6 loopback relay: [::1]:%s -> 127.0.0.1:%s", port, port)
