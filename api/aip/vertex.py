"""The Vertex AI route for open models (Model Garden MaaS, OpenAI-compatible chat completions) and the spend guard in
front of it.

pipeline_ai sends every `vertex/<publisher>/<model>` request through `post`: it reserves the call's worst-case cost
(its prompt plus max_tokens, at the model's list price), refuses the call when that could take today's or this month's
spend past the cap, sends it with a fresh bearer token, and records what an answered call cost. Streamed answers are
recorded by the caller with `record` once their usage arrives. The caps are the deterministic layer that keeps the
Google credit safe whatever a model or an agent asks for:

    BLUESANDAI_VERTEX_DAILY_USD     default 1
    BLUESANDAI_VERTEX_MONTHLY_USD   default 10
    BLUESANDAI_VERTEX_TOTAL_USD     all-time ceiling across every month's ledger; unset = none
    BLUESANDAI_VERTEX_PROJECT       default GOOGLE_CLOUD_PROJECT, else itb-agentic
    BLUESANDAI_VERTEX_LOCATION      default global (the endpoint that answered fastest in tests)

Credentials: the gcloud application-default login (`gcloud auth application-default login`), or the file named by
BLUESANDAI_VERTEX_CREDENTIALS. GOOGLE_APPLICATION_CREDENTIALS is ignored on purpose: in .env.local it names the
Document AI service account, which has no access to the Vertex project.

Spend is kept per month in <data>/aip/vertex_spend/YYYY-MM.json (per day, per model: calls, prompt, cached and output
tokens, USD). GET /api/aip/spend shows it; GET /api/aip/models lists the registry.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from fastapi import APIRouter

from aip import models as aip_models

router = APIRouter(prefix="/api/aip")

URL = "https://{host}/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"

_env: Callable[[str], str] = lambda key: os.environ.get(key, "")
DIR: Path = Path()
log = logging.getLogger("aip.vertex")
_lock = threading.Lock()
_creds_lock = threading.Lock()
_inflight = 0.0  # USD reserved by calls on their way
_creds: Any = None


class BudgetExceeded(RuntimeError):
    """A Vertex call refused because it could take spend past the daily or monthly cap."""


def configure(data_dir: Path, env: Callable[[str], str]) -> None:
    global _env, DIR
    _env = env
    DIR = data_dir / "aip" / "vertex_spend"
    DIR.mkdir(parents=True, exist_ok=True)


def project() -> str:
    return _env("BLUESANDAI_VERTEX_PROJECT") or _env("GOOGLE_CLOUD_PROJECT") or "itb-agentic"


def location() -> str:
    return _env("BLUESANDAI_VERTEX_LOCATION") or "global"


def endpoint() -> str:
    loc = location()
    return URL.format(host="aiplatform.googleapis.com" if loc == "global" else f"{loc}-aiplatform.googleapis.com", project=project(), location=loc)


OFF = ("off", "none", "no", "false")


def caps() -> dict[str, float]:
    """The spend caps in force: daily and monthly by default ($1, $10 on a fresh install), a total when set; a cap set
    to "off" is not checked (the budget owner lifted the caps on 2026-10-23; spend is still booked and shown)."""
    def num(key: str, default: Optional[float]) -> Optional[float]:
        raw = (_env(key) or "").strip().lower()
        if raw in OFF:
            return None
        try:
            return float(raw) if raw else default
        except ValueError:
            return default

    out = {"daily_usd": num("BLUESANDAI_VERTEX_DAILY_USD", 1.0), "monthly_usd": num("BLUESANDAI_VERTEX_MONTHLY_USD", 10.0),
           "total_usd": num("BLUESANDAI_VERTEX_TOTAL_USD", None)}
    return {k: v for k, v in out.items() if v is not None}


# ------------------------------------------------------------------------------------------------
# credentials
# ------------------------------------------------------------------------------------------------


def _credentials_file() -> Path:
    named = _env("BLUESANDAI_VERTEX_CREDENTIALS")
    if named:
        return Path(named)
    base = Path(os.environ["APPDATA"]) / "gcloud" if os.name == "nt" and os.environ.get("APPDATA") else Path.home() / ".config" / "gcloud"
    return base / "application_default_credentials.json"


def token(force: bool = False) -> str:
    global _creds
    import google.auth
    import google.auth.transport.requests

    with _creds_lock:
        if _creds is None:
            path = _credentials_file()
            if not path.is_file():
                raise RuntimeError(f"Vertex AI needs Google credentials: run `gcloud auth application-default login`, or set "
                                   f"BLUESANDAI_VERTEX_CREDENTIALS (looked for {path})")
            _creds, _ = google.auth.load_credentials_from_file(str(path), scopes=[SCOPE], quota_project_id=project())
        if force or not _creds.valid:
            _creds.refresh(google.auth.transport.requests.Request())
        return _creds.token


# ------------------------------------------------------------------------------------------------
# spend: the ledger and the guard
# ------------------------------------------------------------------------------------------------


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _ledger_path(day: str) -> Path:
    return DIR / f"{day[:7]}.json"


def _read(day: str) -> dict:
    try:
        return json.loads(_ledger_path(day).read_text("utf-8"))
    except (OSError, ValueError):
        return {"days": {}}


def _spent(day: str) -> tuple[float, float]:
    """(today's USD, this month's USD) from the ledger."""
    led = _read(day)
    days = led.get("days") or {}
    return float((days.get(day) or {}).get("usd") or 0), sum(float(d.get("usd") or 0) for d in days.values())


def _total() -> float:
    """All-time USD across every month's ledger."""
    total = 0.0
    for f in DIR.glob("*.json"):
        try:
            total += sum(float(d.get("usd") or 0) for d in (json.loads(f.read_text("utf-8")).get("days") or {}).values())
        except (OSError, ValueError):
            pass
    return total


def worst_case(model: str, body: dict) -> float:
    """The most a call can cost: its prompt (about 3 characters a token, rounded up) plus all of max_tokens."""
    sent = json.dumps([body.get("messages"), body.get("tools")], ensure_ascii=False)
    return aip_models.cost(model, {"prompt_tokens": len(sent) // 3 + 1, "completion_tokens": int(body.get("max_tokens") or 4096)})


def _reserve(model: str, body: dict) -> float:
    global _inflight
    if model not in aip_models.MODELS:
        raise BudgetExceeded(f"{model} is not in the AIP model registry, so its cost cannot be bounded")
    need = worst_case(model, body)
    day = _today()
    c = caps()
    with _lock:
        today, month = _spent(day)
        if "daily_usd" in c and today + _inflight + need > c["daily_usd"]:
            raise BudgetExceeded(f"Vertex daily cap reached: ${today:.4f} spent today, ${_inflight:.4f} in flight, this call could cost "
                                 f"${need:.4f}, cap ${c['daily_usd']:.2f} (BLUESANDAI_VERTEX_DAILY_USD)")
        if "monthly_usd" in c and month + _inflight + need > c["monthly_usd"]:
            raise BudgetExceeded(f"Vertex monthly cap reached: ${month:.4f} spent this month, cap ${c['monthly_usd']:.2f} "
                                 "(BLUESANDAI_VERTEX_MONTHLY_USD)")
        if "total_usd" in c:
            total = _total()
            if total + _inflight + need > c["total_usd"]:
                raise BudgetExceeded(f"Vertex budget used up: ${total:.4f} spent in all, cap ${c['total_usd']:.2f} (BLUESANDAI_VERTEX_TOTAL_USD); "
                                     "ask the budget owner before raising it")
        _inflight += need
    return need


def _release(held: float) -> None:
    global _inflight
    with _lock:
        _inflight = max(0.0, _inflight - held)


@contextmanager
def _ledger_lock():
    """The ledger across processes: the API, aip/golden/run.py and aip/optimasi.py book into the same month file. Held
    for one read-modify-write; a lock not had within 30 s is gone on without (a booking never waits forever)."""
    DIR.mkdir(parents=True, exist_ok=True)
    with open(DIR / ".lock", "a+b") as f:
        held = False
        for _ in range(600):
            try:
                if os.name == "nt":
                    import msvcrt

                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except OSError:
                time.sleep(0.05)
        try:
            yield
        finally:
            if held:
                if os.name == "nt":
                    import msvcrt

                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(f, fcntl.LOCK_UN)


def _read_strict(day: str) -> Optional[dict]:
    """The month's ledger for a booking: empty only when there is none yet; None when it exists but cannot be read now
    (another reader holding it on Windows) — then nothing may be written over it."""
    path = _ledger_path(day)
    for _ in range(30):
        if not path.exists():
            return {"days": {}}
        try:
            return json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            time.sleep(0.1)
    return None


def record(model: str, usage: Optional[dict], calls: int = 1) -> float:
    """Book one answered call (or `calls` of them with their usage summed: Blu 1.3's Decisions batches); returns its USD.
    Without usage the call is counted at no cost."""
    usd = aip_models.cost(model, usage)
    day = _today()
    with _lock, _ledger_lock():
        led = _read_strict(day)
        if led is None:  # a ledger that cannot be read is never replaced by one holding only this call
            log.warning("Vertex spend: %s could not be read; %s ($%.6f) not booked", _ledger_path(day).name, model, usd)
            return usd
        d = led.setdefault("days", {}).setdefault(day, {"usd": 0.0, "calls": 0, "models": {}})
        m = d["models"].setdefault(model, {"calls": 0, "prompt": 0, "cached": 0, "output": 0, "usd": 0.0})
        u = usage or {}
        m["calls"] += calls
        m["prompt"] += int(u.get("prompt_tokens") or 0)
        m["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        m["output"] += int(u.get("completion_tokens") or 0)
        m["usd"] = round(m["usd"] + usd, 8)
        d["calls"] += calls
        d["usd"] = round(d["usd"] + usd, 8)
        tmp = _ledger_path(day).with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(led, indent=1), "utf-8")
        for attempt in range(30):  # a reader holding the file (GET /api/aip/spend) makes a replace fail on Windows
            try:
                tmp.replace(_ledger_path(day))
                break
            except PermissionError:
                if attempt == 29:
                    tmp.unlink(missing_ok=True)
                    log.warning("Vertex spend: %s held by a reader; %s ($%.6f) not booked", _ledger_path(day).name, model, usd)
                time.sleep(0.1)
    return usd


_HARMONY_CALL = re.compile(r"to=functions\.([A-Za-z0-9_\-]+).*?<\|message\|>(.*?)(?:<\|call\|>|$)", re.S)


def repair_harmony(text: str, calls: list[dict], may_call: bool) -> tuple[str, list[dict]]:
    """gpt-oss sometimes answers with its raw "harmony" control tokens in the text (`<|channel|>commentary
    to=functions.x <|message|>{…}<|call|>`) instead of a structured tool call. With tools allowed the leaked call
    becomes a structured one; without (tool_choice none) the answer is unusable: ValueError, and the caller asks again."""
    if "<|" not in (text or ""):
        return text, calls
    found = _HARMONY_CALL.findall(text)
    if found and may_call and not calls:
        fixed = []
        for name, raw in found:
            raw = raw.strip()
            try:
                args = json.loads(raw) if raw else {}
            except ValueError:
                args = None
            fixed.append({"provider_id": None, "name": name, "args": args, "raw_args": raw})
        return "", fixed
    clean = re.sub(r"<\|[^|]*\|>", " ", re.sub(r"<\|start\|>.*?(<\|call\|>|<\|end\|>|$)", " ", text, flags=re.S)).strip()
    if found or not clean:
        raise ValueError("the model answered with raw tool-call markup")
    return clean, calls


def post(model: str, body: dict, timeout: float, stream: bool = False) -> requests.Response:
    """Send one chat-completions request for a registry model, inside the spend guard. A non-streamed answer is booked
    here; a streamed one is booked by the caller with `record` once its usage arrives."""
    held = _reserve(model, body)
    try:
        r = requests.post(endpoint(), headers={"Authorization": f"Bearer {token()}"}, json=body, timeout=timeout, stream=stream)
        if r.status_code == 401:
            r.close()
            r = requests.post(endpoint(), headers={"Authorization": f"Bearer {token(force=True)}"}, json=body, timeout=timeout, stream=stream)
        if r.status_code == 200 and not stream:
            try:
                record(model, r.json().get("usage"))
            except ValueError:
                record(model, None)
        return r
    finally:
        _release(held)


_clients: dict[int, Any] = {}


def async_client() -> Any:
    """One pooled httpx.AsyncClient per event loop (connections reused across calls, as the server's lifespan would)."""
    import asyncio

    import httpx

    loop = asyncio.get_running_loop()
    c = _clients.get(id(loop))
    if c is None or c.is_closed:
        c = _clients[id(loop)] = httpx.AsyncClient(timeout=150, limits=httpx.Limits(max_connections=32, max_keepalive_connections=16))
    return c


async def apost(model: str, body: dict, timeout: float) -> Any:
    """post() for asynchronous callers (httpx.AsyncClient: the event loop serves other requests while the model answers),
    inside the same spend guard; the answer is booked here. Returns the httpx response."""
    held = _reserve(model, body)
    try:
        client = async_client()
        r = await client.post(endpoint(), headers={"Authorization": f"Bearer {token()}"}, json=body, timeout=timeout)
        if r.status_code == 401:
            r = await client.post(endpoint(), headers={"Authorization": f"Bearer {token(force=True)}"}, json=body, timeout=timeout)
        if r.status_code == 200:
            try:
                record(model, r.json().get("usage"))
            except ValueError:
                record(model, None)
        return r
    finally:
        _release(held)


def spend() -> dict[str, Any]:
    day = _today()
    led = _read(day)
    days = led.get("days") or {}
    today, month = _spent(day)
    return {"project": project(), "location": location(), "caps": caps(), "total_usd": round(_total(), 6),
            "today": {"day": day, "usd": round(today, 6), **(days.get(day) or {})},
            "month": {"month": day[:7], "usd": round(month, 6), "calls": sum(int(d.get("calls") or 0) for d in days.values())},
            "days": [{"day": k, "usd": v.get("usd"), "calls": v.get("calls")} for k, v in sorted(days.items())]}


@router.get("/models")
def list_models() -> dict:
    return aip_models.catalogue()


@router.get("/spend")
def get_spend() -> dict:
    return spend()
