"""Render a web page of the app to PDF or PNG with headless Chrome / Edge (report recipes: "Email on a schedule").

Chrome runs with a throwaway profile and the DevTools protocol on a free port; the page is opened as a user (a
short-lived session cookie, revoked afterwards) so it shows what that user may see, then printed (Page.printToPDF) or
captured (Page.captureScreenshot). The browser is found in BLUESANDAI_CHROME or the usual install paths.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


class RenderError(RuntimeError):
    pass


def browser() -> Optional[str]:
    env = os.environ.get("BLUESANDAI_CHROME")
    if env and Path(env).exists():
        return env
    for c in CANDIDATES:
        if Path(c).exists():
            return c
    return shutil.which("chrome") or shutil.which("chromium") or shutil.which("msedge")


def render(path: str, fmt: str = "pdf", user_id: Optional[str] = None, wait_s: float = 4.0, width: int = 1280, height: int = 900,
           ready: Optional[str] = None, timeout_s: float = 90, pdf: Optional[dict] = None) -> bytes:
    """The page at web_url + path as PDF or PNG bytes. `ready`: a JavaScript expression polled until it is truthy (the
    page says its data is drawn) instead of the fixed `wait_s`; the value "gagal" fails the render. `pdf`: options for
    Page.printToPDF over the defaults (paper, margins, header and footer)."""
    from websockets.sync.client import connect

    import auth

    exe = browser()
    if not exe:
        raise RenderError("no Chrome or Edge found to render the report (set BLUESANDAI_CHROME)")
    base = auth.web_url()
    token = auth.issue_render_session(user_id) if auth.enabled() and user_id else None
    profile = tempfile.mkdtemp(prefix="bsai-render-")
    proc = subprocess.Popen([exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
                             f"--user-data-dir={profile}", "--remote-debugging-port=0", f"--window-size={width},{height}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        port_file = Path(profile) / "DevToolsActivePort"
        for _ in range(100):
            if port_file.exists() and len(port_file.read_text().splitlines()) >= 2:
                break
            time.sleep(0.1)
        else:
            raise RenderError("the browser did not start")
        port, ws_path = port_file.read_text().splitlines()[:2]
        ids = itertools.count(1)
        with connect(f"ws://127.0.0.1:{port}{ws_path}", max_size=200 * 1024 * 1024, open_timeout=10) as ws:
            def call(method: str, params: Optional[dict] = None, session: Optional[str] = None, timeout: float = 60) -> dict:
                mid = next(ids)
                msg = {"id": mid, "method": method, "params": params or {}}
                if session:
                    msg["sessionId"] = session
                ws.send(json.dumps(msg))
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    m = json.loads(ws.recv(timeout=max(0.1, deadline - time.monotonic())))
                    if m.get("id") == mid:
                        if "error" in m:
                            raise RenderError(f"{method}: {m['error'].get('message')}")
                        return m.get("result") or {}
                raise RenderError(f"{method} timed out")

            target = call("Target.createTarget", {"url": "about:blank"})["targetId"]
            sid = call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            call("Network.enable", session=sid)
            call("Page.enable", session=sid)
            if token:
                call("Network.setCookie", {"name": auth.COOKIE, "value": token, "url": base, "httpOnly": True}, session=sid)
            call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False}, session=sid)
            call("Page.navigate", {"url": base + path}, session=sid)
            # the page loads its data after the first paint: wait for the network to settle, or for the page to say so
            if ready:
                end, state = time.monotonic() + timeout_s, None
                while time.monotonic() < end:
                    state = call("Runtime.evaluate", {"expression": ready, "returnByValue": True}, session=sid).get("result", {}).get("value")
                    if state:
                        break
                    time.sleep(0.5)
                if not state:
                    raise RenderError(f"the page was not ready in {timeout_s:.0f}s")
                if state == "gagal":
                    raise RenderError("the page could not draw its data")
                time.sleep(0.8)  # the last layout and fonts
            else:
                time.sleep(wait_s)
            if fmt == "pdf":
                data = call("Page.printToPDF", {"printBackground": True, "preferCSSPageSize": False, "paperWidth": 11.69, "paperHeight": 8.27,
                                                "marginTop": 0.3, "marginBottom": 0.3, "marginLeft": 0.3, "marginRight": 0.3, **(pdf or {})},
                            session=sid, timeout=180)["data"]
            else:
                data = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True}, session=sid)["data"]
            return base64.b64decode(data)
    finally:
        proc.kill()
        try:
            proc.wait(10)
        except Exception:  # noqa: BLE001
            pass
        if token:
            auth.revoke_render_session(token)
        shutil.rmtree(profile, ignore_errors=True)
