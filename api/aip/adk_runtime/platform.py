"""The platform's API as the run's user (bearer job token), and the run's event stream (stdout, one JSON per line)."""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

import httpx

_out = threading.Lock()


def emit(ev: dict) -> None:
    """One event for the page (aip/runs.py reads stdout)."""
    ev = {"t": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), **ev}
    with _out:
        sys.stdout.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()


class Platform:
    def __init__(self, api: str, token: str):
        self.api = api.rstrip("/")
        self.token = token
        self.client = httpx.Client(base_url=self.api, timeout=120, headers={"Authorization": f"Bearer {token}"} if token else {})

    def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail") or r.text
            except ValueError:
                detail = r.text
            raise RuntimeError(f"{r.status_code}: {str(detail)[:300]}")
        return r.json()

    def _send(self, method: str, path: str, **kw: Any) -> httpx.Response:
        # a pooled keep-alive connection the server closed as it was reused (uvicorn's keep-alive is 5 s; the ML tool polls
        # every 4 s from many threads): "Server disconnected without sending a response", 8 failed tool calls on
        # 2026-10-23 — sent once more on a fresh connection
        for attempt in range(2):
            try:
                return self.client.request(method, path, **kw)
            except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError):
                if attempt:
                    raise
                time.sleep(0.5)
        raise RuntimeError("unreachable")

    def get(self, path: str, **params: Any) -> Any:
        return self._check(self._send("GET", path, params={k: v for k, v in params.items() if v is not None}))

    def post(self, path: str, body: dict) -> Any:
        return self._check(self._send("POST", path, json=body))
