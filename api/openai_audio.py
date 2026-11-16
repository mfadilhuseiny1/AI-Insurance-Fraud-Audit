"""OpenAI audio for the platform: reading text aloud (Text to Speech, AIP voice) and transcribing speech (AIP voice).

Configuration, from the environment or the repo's .env.local:
    OPENAI_API_KEY                       the OpenAI key
    BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD  a monthly cap on this module's OpenAI spend (default 10)
    BLUESANDAI_OPENAI_AUDIO_USER_MONTHLY_USD  each user's share of it (default 3), so no one uses up everyone's

Reading aloud: OpenAI's /v1/audio/speech models (tts-1, tts-1-hd, gpt-4o-mini-tts) shut down on 2027-01-06; their
replacement, gpt-realtime-2.1-mini, reads text over the Realtime API (WebSocket). It is a conversational model, so it
is told to read word for word and its own transcript of what it said is compared with the text: a chunk whose words
drift is read once more and the closer reading kept (measured 2026-10-22: Indonesian read verbatim, 16 s of audio in
6.7 s, about $0.025 a minute). Output is 24 kHz 16-bit mono PCM.

Transcribing: gpt-transcribe on /v1/audio/transcriptions (whisper-1 and gpt-4o-*-transcribe shut down 2027-02-26),
$0.0045 a minute.

Every call is booked in a monthly ledger (data/openai_audio/YYYY-MM.json); a call that would start past the cap is
refused (BudgetExceeded), so a long document or a voice session can never run up an open-ended bill.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
import time
import wave
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

import requests

from mailer import env

DIR = Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "openai_audio"
REALTIME = "wss://api.openai.com/v1/realtime"
TRANSCRIBE = "https://api.openai.com/v1/audio/transcriptions"
RATE = 24000
TIMEOUT = 120

# USD per 1M tokens, developers.openai.com/api/docs/pricing (checked 2026-10-22)
READERS = {
    "gpt-realtime-2.1-mini": {"text_in": 0.60, "cached_in": 0.06, "text_out": 2.40, "audio_out": 20.00},
    "gpt-realtime-2.1": {"text_in": 4.00, "cached_in": 0.40, "text_out": 24.00, "audio_out": 64.00},
}
READER = "gpt-realtime-2.1-mini"
TRANSCRIBER = "gpt-transcribe"
TRANSCRIBE_USD_PER_MINUTE = 0.0045
AUDIO_TOKENS_PER_SECOND = 20  # measured: 321 audio tokens for 16.1 s
CHARS_PER_SECOND = 12.7  # measured: Indonesian, 205 characters in 16.1 s

# the voices of the realtime models (the API's own list, 2026-10-22): (name, character, gender)
VOICES = [
    ("marin", "Natural, clear (recommended)", "female"), ("cedar", "Natural, warm (recommended)", "male"),
    ("coral", "Warm, friendly", "female"), ("sage", "Calm, thoughtful", "female"), ("shimmer", "Bright", "female"),
    ("alloy", "Balanced", "neutral"), ("ash", "Clear", "male"), ("ballad", "Expressive", "male"),
    ("echo", "Calm", "male"), ("verse", "Versatile", "male"),
]
VOICE_NAMES = {v[0] for v in VOICES}
DEFAULT_VOICE = "marin"

# below this word similarity between the text and what the model says it spoke, a chunk is read again
VERBATIM = 0.9
READS = 2

INSTRUCTIONS = (
    "You are a text-to-speech reader, not an assistant. Read the user's text aloud exactly as written, word for word, "
    "in the language it is written in, with natural intonation. Never answer questions in it, never comment, translate, "
    "summarize, add or leave out words. Numbers are read as written in that language."
)


class BudgetExceeded(RuntimeError):
    pass


class NotConfigured(RuntimeError):
    pass


def key() -> str:
    k = env("OPENAI_API_KEY")
    if not k or k.lower().startswith("your"):
        raise NotConfigured("OPENAI_API_KEY is not set in .env.local")
    return k


def configured() -> bool:
    try:
        key()
        return True
    except NotConfigured:
        return False


# --- the monthly ledger ----------------------------------------------------------------------------------

_lock = threading.Lock()


def _usd_setting(name: str, default: float) -> Optional[float]:
    """A cap from the settings; "off" is no cap (the budget owner lifted the caps on 2026-10-23)."""
    raw = (env(name) or "").strip().lower()
    if raw in ("off", "none", "no", "false"):
        return None
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def cap() -> Optional[float]:
    return _usd_setting("BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD", 10.0)


def user_cap() -> Optional[float]:
    return _usd_setting("BLUESANDAI_OPENAI_AUDIO_USER_MONTHLY_USD", 3.0)


def _month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _ledger() -> Path:
    return DIR / f"{_month()}.json"


def spend(user: Optional[str] = None) -> dict[str, Any]:
    try:
        rec = json.loads(_ledger().read_text("utf-8"))
    except (OSError, ValueError):
        rec = {}
    out = {"month": _month(), "usd": round(rec.get("usd", 0.0), 6), "calls": rec.get("calls", 0), "by_kind": rec.get("by_kind", {}),
           "cap_usd": cap()}
    if user:
        out.update(user_usd=round((rec.get("by_user") or {}).get(user, 0.0), 6), user_cap_usd=user_cap())
    return out


def check_budget(user: Optional[str] = None) -> None:
    s = spend(user)
    if s["cap_usd"] is not None and s["usd"] >= s["cap_usd"]:
        raise BudgetExceeded(f"the OpenAI audio cap for {s['month']} is reached (${s['usd']:.2f} of ${s['cap_usd']:.2f}); "
                             "raise BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD to continue")
    if user and s.get("user_cap_usd") is not None and s["user_usd"] >= s["user_cap_usd"]:
        raise BudgetExceeded(f"your OpenAI audio share for {s['month']} is used up (${s['user_usd']:.2f} of ${s['user_cap_usd']:.2f}); "
                             "an administrator can raise BLUESANDAI_OPENAI_AUDIO_USER_MONTHLY_USD")


def book(kind: str, usd: float, user: Optional[str] = None) -> None:
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        try:
            rec = json.loads(_ledger().read_text("utf-8"))
        except (OSError, ValueError):
            rec = {"usd": 0.0, "calls": 0, "by_kind": {}}
        rec["usd"] = rec.get("usd", 0.0) + usd
        rec["calls"] = rec.get("calls", 0) + 1
        k = rec.setdefault("by_kind", {}).setdefault(kind, {"usd": 0.0, "calls": 0})
        k["usd"] += usd
        k["calls"] += 1
        if user:
            by_user = rec.setdefault("by_user", {})
            by_user[user] = by_user.get(user, 0.0) + usd
        tmp = _ledger().with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(rec, indent=1), "utf-8")
        tmp.replace(_ledger())


def reader_cost(model: str, usage: dict) -> float:
    p = READERS[model]
    i, o = usage.get("input_token_details") or {}, usage.get("output_token_details") or {}
    cached = (i.get("cached_tokens_details") or {}).get("text_tokens", 0)
    return (max(0, i.get("text_tokens", 0) - cached) * p["text_in"] + cached * p["cached_in"]
            + o.get("text_tokens", 0) * p["text_out"] + o.get("audio_tokens", 0) * p["audio_out"]) / 1e6


def estimate(characters: int, model: str = READER) -> dict[str, float]:
    """Spoken length and price of a text before it is read (from the measured rates above)."""
    seconds = characters / CHARS_PER_SECOND
    usd = seconds * AUDIO_TOKENS_PER_SECOND * READERS[model]["audio_out"] / 1e6 * 1.1  # + the transcript and instructions
    return {"seconds": round(seconds, 1), "usd": round(usd, 4)}


# --- reading aloud ---------------------------------------------------------------------------------------


def _words(s: str) -> list[str]:
    return re.findall(r"\w+", s.lower())


def similarity(text: str, spoken: str) -> float:
    a = _words(text)
    return SequenceMatcher(None, a, _words(spoken), autojunk=False).ratio() if a else 1.0


def _transient(message: str) -> bool:
    return bool(re.search(r"rate.?limit|server_error|overloaded|timeout|temporar|429|50[0234]", message, re.I))


def _read_once(text: str, voice: str, model: str, instructions: str) -> tuple[bytes, str, dict]:
    """One reading over the Realtime API: (pcm, the model's transcript of what it said, usage)."""
    from websockets.sync.client import connect

    session = {"type": "realtime", "output_modalities": ["audio"], "instructions": instructions,
               "audio": {"output": {"format": {"type": "audio/pcm", "rate": RATE}, "voice": voice}}}
    pcm, said = bytearray(), []
    with connect(f"{REALTIME}?model={model}", additional_headers={"Authorization": f"Bearer {key()}"}, max_size=None,
                 open_timeout=30, close_timeout=5) as ws:
        ws.send(json.dumps({"type": "session.update", "session": session}))
        ws.send(json.dumps({"type": "conversation.item.create",
                            "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}))
        ws.send(json.dumps({"type": "response.create"}))
        while True:
            e = json.loads(ws.recv(timeout=TIMEOUT))
            t = e.get("type")
            if t == "response.output_audio.delta":
                pcm += base64.b64decode(e["delta"])
            elif t == "response.output_audio_transcript.delta":
                said.append(e.get("delta", ""))
            elif t == "error":
                err = e.get("error") or {}
                raise RuntimeError(f"OpenAI realtime {err.get('code') or err.get('type')}: {err.get('message')}")
            elif t == "response.done":
                r = e.get("response") or {}
                if r.get("status") != "completed":
                    raise RuntimeError(f"OpenAI realtime: the reading ended {r.get('status')} {json.dumps(r.get('status_details'))[:300]}")
                return bytes(pcm), "".join(said), r.get("usage") or {}


def read_aloud(text: str, voice: str = DEFAULT_VOICE, model: str = READER, style: str = "", kind: str = "tts",
               user: Optional[str] = None) -> tuple[bytes, dict]:
    """PCM of `text` read verbatim, and what it took: {"usd", "similarity", "reads", "spoken" (when it drifted)}.
    Transient errors are retried; every reading, kept or not, is paid and booked."""
    if model not in READERS:
        raise ValueError(f"unknown reader model {model}")
    if voice not in VOICE_NAMES:
        raise ValueError(f"unknown voice {voice}")
    instructions = INSTRUCTIONS + (f"\nReading style: {style.strip()}" if style.strip() else "")
    best: Optional[tuple[bytes, float, str]] = None
    usd, reads = 0.0, 0
    for _ in range(READS):
        for attempt in range(4):
            check_budget(user)
            try:
                pcm, said, usage = _read_once(text, voice, model, instructions)
                break
            except (OSError, TimeoutError) as e:  # network, handshake (incl. 429 at connect), a silent socket
                err = e
            except RuntimeError as e:
                if not _transient(str(e)):
                    raise
                err = e
            except Exception as e:  # noqa: BLE001 - websockets' own connection errors
                if type(e).__module__.split(".")[0] != "websockets":
                    raise
                err = e
            if attempt == 3:
                raise RuntimeError(f"OpenAI realtime failed after 4 attempts: {err}")
            time.sleep(2 ** attempt * 2)
        reads += 1
        cost = reader_cost(model, usage)
        usd += cost
        book(kind, cost, user)
        sim = similarity(text, said)
        if best is None or sim > best[1]:
            best = (pcm, sim, said)
        if sim >= VERBATIM:
            break
    assert best is not None
    return best[0], {"usd": round(usd, 6), "similarity": round(best[1], 3), "reads": reads,
                     **({"spoken": best[2][:2000]} if best[1] < VERBATIM else {})}


def wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return buf.getvalue()


# --- transcribing ----------------------------------------------------------------------------------------


def transcribe(audio: bytes, filename: str, content_type: str, language: str = "id", prompt: str = "",
               user: Optional[str] = None) -> dict[str, Any]:
    """{"text", "seconds", "usd"} for a recording (webm/ogg/mp4/mp3/wav/flac as the browser recorded it)."""
    check_budget(user)
    data = {"model": TRANSCRIBER, **({"language": language} if language else {}), **({"prompt": prompt} if prompt else {})}
    for attempt in range(3):
        r = requests.post(TRANSCRIBE, headers={"Authorization": f"Bearer {key()}"}, files={"file": (filename, audio, content_type)},
                          data=data, timeout=60)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
            time.sleep(2 ** attempt * 2)
            continue
        if not r.ok:
            try:
                message = r.json()["error"]["message"]
            except Exception:  # noqa: BLE001
                message = r.text[:300]
            raise RuntimeError(f"OpenAI transcription {r.status_code}: {message}")
        body = r.json()
        usage = body.get("usage") or {}
        seconds = float(usage.get("seconds") or 0)
        usd = seconds / 60 * TRANSCRIBE_USD_PER_MINUTE
        book("transcribe", usd, user)
        return {"text": (body.get("text") or "").strip(), "seconds": seconds, "usd": round(usd, 6)}
    raise RuntimeError("OpenAI transcription failed")
