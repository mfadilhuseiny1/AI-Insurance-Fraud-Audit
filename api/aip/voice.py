"""Voice for AIP JKN (/api/aip/voice): the auditor talks to the same orchestrator the typed questions go to.

    listen ─► end of speech (silence) ─► POST /transcribe ─► POST /api/aip/ask {voice: true}
      ▲                                                                  │
      └── read aloud ◄── POST /speak per sentence ◄── run events: plan, draft, verdict ◄┘

The browser does the listening (microphone level, no model) and follows the run; this module only turns speech into
text and text into speech (openai_audio.py: gpt-transcribe, and gpt-realtime-2.1-mini reading word for word). Spoken
answers are the run's own validated answer, never a separate model's: the voice adds no facts. Every call books into
the OpenAI audio ledger and stops at its monthly cap.
"""

from __future__ import annotations

import re
import threading
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

import openai_audio
from aip import runs as aip_runs

router = APIRouter(prefix="/api/aip/voice")

MAX_AUDIO = 25 * 1024 * 1024  # OpenAI's own limit
TYPES = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
         "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/flac": "flac"}
# words the transcriber mishears without a hint
VOCABULARY = ("BPJS Kesehatan, JKN, INA-CBG, FKRTL, FKTP, faskes, klaim berisiko, readmisi, LOS, ICD-10, kapitasi, rujukan, "
              "selisih verifikasi, Sulawesi Selatan, Jawa Barat, kabupaten, provinsi, peserta, auditor.")
# Indonesian speech: the reader otherwise drifts towards an English accent on short phrases
STYLE = ("Speak Indonesian with a natural Indonesian accent, in a calm conversational tone at a brisk, even pace; keep the "
         "same pitch and voice from start to end; a question rises slightly at the end.")
MAX_SPEAK = 700
CACHE_TEXT = 120  # short phrases (fillers, verdict lines) are kept, so saying them again costs nothing
_cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()
_cache_lock = threading.Lock()


_ONES = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh", "sebelas"]


def terbilang(n: int) -> str:
    """An integer in Indonesian words: 626 → "enam ratus dua puluh enam", 1093 → "seribu sembilan puluh tiga"."""
    def tail(rest: int) -> str:
        return f" {terbilang(rest)}" if rest else ""

    if n < 12:
        return _ONES[n]
    if n < 20:
        return f"{_ONES[n - 10]} belas"
    if n < 100:
        return f"{_ONES[n // 10]} puluh{tail(n % 10)}"
    if n < 200:
        return f"seratus{tail(n - 100)}"
    if n < 1000:
        return f"{_ONES[n // 100]} ratus{tail(n % 100)}"
    if n < 2000:
        return f"seribu{tail(n - 1000)}"
    for size, word in ((10**12, "triliun"), (10**9, "miliar"), (10**6, "juta"), (1000, "ribu")):
        if n >= size:
            head, rest = divmod(n, size)
            return f"{terbilang(head)} {word}{tail(rest)}"
    return str(n)


# a number standing alone (not part of a code like J18.9, I-4-10-I, 2026-10-22 or a claim id): 1.093 · 626 · 17,5
_NUMBER = re.compile(r"(?<![\w.,/-])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?![\w/-]|[.,]\d)(\s?%)?")


def spoken_numbers(text: str) -> str:
    """Numbers in Indonesian words, read as written: the reader garbled "626" (heard back as "enam puluh tiga enam",
    2026-10-22), and an auditor must hear the number the answer gives."""
    def say(m: re.Match) -> str:
        whole = int(m.group(1).replace(".", ""))
        if whole >= 10**15:
            return m.group(0)
        out = terbilang(whole)
        if m.group(2):
            out += " koma " + " ".join(_ONES[int(d)] for d in m.group(2))
        return out + (" persen" if m.group(3) else "")

    return _NUMBER.sub(say, re.sub(r"\bRp\.?\s?(?=\d)", "rupiah ", text))


def _signed_in() -> dict:
    return aip_runs._principal()


def _openai_error(e: Exception) -> HTTPException:
    if isinstance(e, openai_audio.BudgetExceeded):
        return HTTPException(429, str(e))
    if isinstance(e, openai_audio.NotConfigured):
        return HTTPException(503, str(e))
    return HTTPException(502, str(e))


@router.get("/status")
def status() -> dict[str, Any]:
    me = _signed_in()
    return {"configured": openai_audio.configured(), "reader": openai_audio.READER, "transcriber": openai_audio.TRANSCRIBER,
            "voices": [{"name": n, "style": s, "gender": g} for n, s, g in openai_audio.VOICES], "default_voice": openai_audio.DEFAULT_VOICE,
            "vocabulary": VOCABULARY, "spend": openai_audio.spend(me.get("id"))}


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("id"), prompt: str = Form("")) -> dict[str, Any]:
    me = _signed_in()
    data = await audio.read(MAX_AUDIO + 1)
    if not data:
        raise HTTPException(400, "no audio")
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "the recording is too long (max 25 MB)")
    base = (audio.content_type or "").split(";")[0].strip().lower()
    if base not in TYPES:
        raise HTTPException(415, f"unsupported audio format: {base or 'unknown'}")
    try:
        return openai_audio.transcribe(data, f"ucapan.{TYPES[base]}", base, language[:5], (prompt or VOCABULARY)[:800], user=me.get("id"))
    except Exception as e:  # noqa: BLE001
        raise _openai_error(e) from e


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: str = openai_audio.DEFAULT_VOICE


@router.post("/speak")
def speak(body: SpeakIn) -> Response:
    me = _signed_in()
    text = spoken_numbers(" ".join(body.text.split())[:MAX_SPEAK])
    if body.voice not in openai_audio.VOICE_NAMES:
        raise HTTPException(400, f"unknown voice {body.voice}")
    key = (body.voice, text)
    with _cache_lock:
        hit = _cache.get(key)
    meta: dict[str, Any] = {"usd": 0.0, "similarity": 1.0, "cached": True}
    if hit is None:
        try:
            pcm, meta = openai_audio.read_aloud(text, body.voice, style=STYLE, kind="voice", user=me.get("id"))
        except Exception as e:  # noqa: BLE001
            raise _openai_error(e) from e
        hit = openai_audio.wav(pcm)
        if len(text) <= CACHE_TEXT:
            with _cache_lock:
                _cache[key] = hit
                while len(_cache) > 200:
                    _cache.popitem(last=False)
    # what this sentence cost and how faithfully it was read, for the receipts on screen
    return Response(hit, media_type="audio/wav", headers={"Cache-Control": "no-store", "X-Audio-Usd": f"{meta['usd']:.6f}",
                                                         "X-Read-Similarity": f"{meta['similarity']:.3f}", "Access-Control-Expose-Headers": "X-Audio-Usd, X-Read-Similarity"})
