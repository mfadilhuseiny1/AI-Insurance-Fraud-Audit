"""Text to speech (Platform app "Text to Speech", /api/tts): plain text or markdown, read by OpenAI.

Configuration, from the environment or the repo's .env.local:
    OPENAI_API_KEY             the OpenAI key (openai_audio.py: models, voices, prices, the monthly cap)
    GOOGLE_AI_STUDIO_API_KEY   only to finish jobs made earlier with Gemini TTS

The markdown is turned into plain spoken text (headings, lists and tables read as sentences; code blocks,
images and link targets left out), split into chunks at paragraph and sentence boundaries, and each chunk is
read by an OpenAI realtime model (openai_audio.read_aloud: word for word, checked against the model's own
transcript). It returns 24 kHz 16-bit mono PCM; the chunks are joined and served as one WAV file.

Synthesis runs as a job (POST /jobs, poll GET /jobs/{id}, then GET /jobs/{id}/audio), since a long document takes
many model calls. Chunks are read WORKERS at a time and each one is saved as it arrives (data/tts/<job>/), so a job
survives an API restart: running jobs resume from the chunks they still need when the API starts, and a failed job
can be retried (POST /jobs/{id}/retry) without paying again for the chunks already read. A job records what it cost
and which chunks the model did not read word for word. Voice samples live only as long as the API process.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import openai_audio
from mailer import env

DIR = Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parent.parent / "data")) / "tts"
WORKERS = 4
KEEP = 20


def _resume_on_startup() -> None:
    _load()
    for job in list(_jobs.values()):
        if job["status"] == "running":
            _start(job["id"])


router = APIRouter(prefix="/api/tts", on_startup=[_resume_on_startup])

API = "https://generativelanguage.googleapis.com/v1beta"
MODELS = list(openai_audio.READERS)
DEFAULT_MODEL = openai_audio.READER
RATE = openai_audio.RATE
# a realtime model reads a shorter chunk more faithfully (about 95 s of speech); Gemini took 2,500
CHUNK_CHARS = {"openai": 1200, "gemini": 2500}
MAX_CHARS = 200_000
TIMEOUT = 180
SAMPLE_TEXT = "Halo, ini contoh suara saya. Hello, this is a sample of my voice."

# The prebuilt voices of Gemini TTS, for jobs made before the switch to OpenAI: (name, character, gender)
GEMINI_VOICES = [
    ("Zephyr", "Bright", "female"), ("Puck", "Upbeat", "male"), ("Charon", "Informative", "male"),
    ("Kore", "Firm", "female"), ("Fenrir", "Excitable", "male"), ("Leda", "Youthful", "female"),
    ("Orus", "Firm", "male"), ("Aoede", "Breezy", "female"), ("Callirrhoe", "Easy-going", "female"),
    ("Autonoe", "Bright", "female"), ("Enceladus", "Breathy", "male"), ("Iapetus", "Clear", "male"),
    ("Umbriel", "Easy-going", "male"), ("Algieba", "Smooth", "male"), ("Despina", "Smooth", "female"),
    ("Erinome", "Clear", "female"), ("Algenib", "Gravelly", "male"), ("Rasalgethi", "Informative", "male"),
    ("Laomedeia", "Upbeat", "female"), ("Achernar", "Soft", "female"), ("Alnilam", "Firm", "male"),
    ("Schedar", "Even", "male"), ("Gacrux", "Mature", "female"), ("Pulcherrima", "Forward", "female"),
    ("Achird", "Friendly", "male"), ("Zubenelgenubi", "Casual", "male"), ("Vindemiatrix", "Gentle", "female"),
    ("Sadachbia", "Lively", "male"), ("Sadaltager", "Knowledgeable", "male"), ("Sulafat", "Warm", "female"),
]
_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_samples: dict[tuple[str, str], bytes] = {}


def _provider(model: str) -> str:
    if model in openai_audio.READERS:
        return "openai"
    if re.fullmatch(r"gemini-[\w.-]+", model):
        return "gemini"
    raise HTTPException(400, f"Unknown model {model}")


def _voices(provider: str) -> list[tuple[str, str, str]]:
    return openai_audio.VOICES if provider == "openai" else GEMINI_VOICES


def _key(provider: str = "openai") -> str:
    if provider == "openai":
        try:
            return openai_audio.key()
        except openai_audio.NotConfigured as e:
            raise HTTPException(503, str(e)) from e
    key = env("GOOGLE_AI_STUDIO_API_KEY")
    if not key or key.lower().startswith("your"):
        raise HTTPException(503, "GOOGLE_AI_STUDIO_API_KEY is not set in .env.local")
    return key


# --- markdown → spoken text ------------------------------------------------------------------------------

_INLINE = [
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),  # images → alt text
    (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),  # links → their text
    (re.compile(r"\[([^\]]+)\]\[[^\]]*\]"), r"\1"),  # reference links
    (re.compile(r"<https?://[^>]+>"), ""),  # autolinks
    (re.compile(r"<[^>\n]+>"), ""),  # html tags
    (re.compile(r"`([^`]+)`"), r"\1"),  # inline code
    (re.compile(r"(\*\*|__)(.+?)\1"), r"\2"),  # bold
    (re.compile(r"(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])"), r"\1"),  # italics
    (re.compile(r"~~(.+?)~~"), r"\1"),  # strikethrough
    (re.compile(r"\[\^[^\]]+\]"), ""),  # footnote markers
]


def _inline(text: str) -> str:
    for pattern, repl in _INLINE:
        text = pattern.sub(repl, text)
    return re.sub(r"\s+", " ", text).strip()


def _sentence(text: str) -> str:
    """End a heading, list item or table row with a stop so the voice pauses after it."""
    return text if not text or text[-1] in ".!?:;…" else text + "."


def markdown_to_text(markdown: str) -> str:
    """Plain text to read aloud, one paragraph per line."""
    out: list[str] = []
    para: list[str] = []
    fence: Optional[str] = None

    def flush() -> None:
        if para:
            out.append(_inline(" ".join(para)))
            para.clear()

    lines = markdown.replace("\r\n", "\n").split("\n")
    if lines and lines[0].strip() == "---":  # front matter
        end = next((i for i, l in enumerate(lines[1:], 1) if l.strip() in ("---", "...")), None)
        if end:
            lines = lines[end + 1 :]
    for raw in lines:
        line = raw.strip()
        if fence:
            if line.startswith(fence):
                fence = None
            continue
        m = re.match(r"(`{3,}|~{3,})", line)
        if m:
            flush()
            fence = m.group(1)
            continue
        if not line or re.fullmatch(r"([-*_])( *\1){2,}", line):
            flush()
            continue
        if re.fullmatch(r"\|?[\s:|-]+\|?", line) and "-" in line and "|" in line:  # table separator row
            continue
        if line.startswith("|") or (line.count("|") >= 2 and not para):
            flush()
            cells = [_inline(c) for c in line.strip("|").split("|")]
            out.append(_sentence(", ".join(c for c in cells if c)))
            continue
        heading = re.match(r"#{1,6}\s+(.*?)\s*#*$", line)
        item = re.match(r"(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)", line)
        quote = re.match(r">+\s?(.*)", line)
        if heading:
            flush()
            out.append(_sentence(_inline(heading.group(1))))
        elif item:
            flush()
            para.append(item.group(1))
            out.append(_sentence(_inline(" ".join(para))))
            para.clear()
        elif quote:
            para.append(quote.group(1))
        elif re.fullmatch(r"=+|-+", line) and out:  # setext heading underline
            out[-1] = _sentence(out[-1])
        else:
            para.append(line)
    flush()
    return "\n".join(p for p in out if p)


def chunk_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Split at paragraphs, then sentences, then words, so each chunk stays under `limit` characters."""
    pieces: list[str] = []
    for para in text.split("\n"):
        if len(para) <= limit:
            pieces.append(para)
            continue
        for sentence in re.split(r"(?<=[.!?…])\s+", para):
            while len(sentence) > limit:
                cut = sentence.rfind(" ", 0, limit)
                cut = cut if cut > 0 else limit
                pieces.append(sentence[:cut])
                sentence = sentence[cut:].strip()
            pieces.append(sentence)
    chunks: list[str] = []
    for piece in filter(None, (p.strip() for p in pieces)):
        if chunks and len(chunks[-1]) + 1 + len(piece) <= limit:
            chunks[-1] += "\n" + piece
        else:
            chunks.append(piece)
    return chunks


# --- reading a chunk -------------------------------------------------------------------------------------


def _synthesize(text: str, voice: str, model: str, style: str, user: Optional[str] = None) -> tuple[bytes, dict[str, Any]]:
    """Raw PCM of one chunk and what it took (OpenAI: cost, word similarity, readings), on the user's share."""
    if _provider(model) == "openai":
        try:
            return openai_audio.read_aloud(text, voice, model, style, kind="tts", user=user)
        except openai_audio.NotConfigured as e:
            raise HTTPException(503, str(e)) from e
    return _gemini(text, voice, model, style), {}


def _gemini(text: str, voice: str, model: str, style: str) -> bytes:
    """Raw PCM of one chunk read by Gemini TTS. Retries rate limits and transient errors."""
    # "<style>: <text>" makes the model read the style aloud, and the TTS models take no system instruction
    style = style.strip().rstrip(".:")
    prompt = f"{style}. Speak only the transcript below, not these instructions.\n\n### TRANSCRIPT\n{text}" if style else text
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    for attempt in range(5):
        r = requests.post(f"{API}/models/{model}:generateContent", json=body, headers={"x-goog-api-key": _key("gemini")}, timeout=TIMEOUT)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 4:
            delay = 2 ** attempt * 3
            m = re.search(r'"retryDelay":\s*"(\d+)', r.text)
            time.sleep(max(delay, int(m.group(1)) + 1) if m else delay)
            continue
        if not r.ok:
            try:
                message = r.json()["error"]["message"]
            except Exception:
                message = r.text[:300]
            raise RuntimeError(f"Gemini TTS {r.status_code}: {message}")
        parts = (r.json().get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        audio = next((p["inlineData"]["data"] for p in parts if "inlineData" in p), None)
        if audio:
            return base64.b64decode(audio)
        if attempt < 4:  # the model occasionally answers with text instead of audio
            continue
    raise RuntimeError("Gemini TTS returned no audio")


_wav = openai_audio.wav


def _silence(seconds: float) -> bytes:
    return b"\x00\x00" * int(RATE * seconds)


def _dir(job_id: str) -> Path:
    return DIR / job_id


def _chunk_file(job_id: str, i: int) -> Path:
    return _dir(job_id) / f"chunk-{i:04d}.pcm"


def _meta_file(job_id: str, i: int) -> Path:
    return _dir(job_id) / f"chunk-{i:04d}.json"


def _tally(job: dict[str, Any]) -> None:
    """The job's cost and the chunks not read word for word, from what its chunks recorded."""
    usd, drift = 0.0, []
    for i in range(len(job["chunks"])):
        try:
            meta = json.loads(_meta_file(job["id"], i).read_text("utf-8"))
        except (OSError, ValueError):
            continue
        usd += meta.get("usd", 0.0)
        if meta.get("similarity") is not None and meta["similarity"] < openai_audio.VERBATIM:
            drift.append({"chunk": i + 1, "similarity": meta["similarity"]})
    job["usd"] = round(usd, 6)
    job["drift"] = drift


def _save(job: dict[str, Any]) -> None:
    d = _dir(job["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f"job.json.{uuid.uuid4().hex[:8]}.tmp"  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    tmp.replace(d / "job.json")


def _load() -> None:
    """The jobs saved on disk (once per process)."""
    if not DIR.exists():
        return
    with _lock:
        for f in DIR.glob("*/job.json"):
            try:
                job = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            _jobs.setdefault(job["id"], job)


def _run(job_id: str) -> None:
    job = _jobs[job_id]
    todo = [i for i in range(len(job["chunks"])) if not _chunk_file(job_id, i).exists()]

    def one(i: int) -> None:
        if job["status"] != "running":
            return
        pcm, meta = _synthesize(job["chunks"][i], job["voice"], job["model"], job["style"], job.get("user_id"))
        _meta_file(job_id, i).write_text(json.dumps(meta), "utf-8")
        _chunk_file(job_id, i).write_bytes(pcm)
        with _lock:
            job["done"] = sum(_chunk_file(job_id, k).exists() for k in range(len(job["chunks"])))
            _tally(job)
            _save(job)

    try:
        with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix=f"tts-{job_id}") as pool:
            for future in [pool.submit(one, i) for i in todo]:
                future.result()  # the first failure stops the job; the chunks read so far stay on disk
        if job["status"] != "running":
            return
        pcm = b"".join(_chunk_file(job_id, i).read_bytes() + _silence(0.4) for i in range(len(job["chunks"])))
        audio = _wav(pcm)
        (_dir(job_id) / "audio.wav").write_bytes(audio)
        with _lock:
            _tally(job)
        for i in range(len(job["chunks"])):
            _chunk_file(job_id, i).unlink(missing_ok=True)
            _meta_file(job_id, i).unlink(missing_ok=True)
        with _lock:
            job.update(status="completed", done=len(job["chunks"]), seconds=round((len(audio) - 44) / 2 / RATE, 1), finished_at=time.time(), error=None)
            _save(job)
    except Exception as e:  # noqa: BLE001
        with _lock:
            if job["status"] == "running":
                job.update(status="failed", error=str(e), finished_at=time.time())
            _save(job)


def _start(job_id: str) -> None:
    threading.Thread(target=_run, args=(job_id,), daemon=True, name=f"tts-{job_id}").start()


def _public(job: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in job.items() if k not in ("audio", "chunks", "text")} | {"chunks": len(job["chunks"])}


# --- routes ----------------------------------------------------------------------------------------------


class PrepareRequest(BaseModel):
    markdown: str = Field(max_length=MAX_CHARS * 2)
    model: str = DEFAULT_MODEL


class JobRequest(PrepareRequest):
    voice: str = openai_audio.DEFAULT_VOICE
    style: str = Field("", max_length=500)
    title: str = Field("", max_length=200)


class SampleRequest(BaseModel):
    voice: str
    model: str = DEFAULT_MODEL


@router.get("/status")
def status() -> dict[str, Any]:
    return {"configured": openai_audio.configured(), "provider": "OpenAI", "models": MODELS, "default": DEFAULT_MODEL,
            "spend": openai_audio.spend(_me().get("id")), **({} if openai_audio.configured() else {"error": "Isi OPENAI_API_KEY di .env.local."})}


@router.get("/voices")
def voices(model: str = DEFAULT_MODEL) -> list[dict[str, str]]:
    return [{"name": n, "style": s, "gender": g} for n, s, g in _voices(_provider(model))]


def _check_voice(voice: str, model: str) -> str:
    provider = _provider(model)
    if voice not in {v[0] for v in _voices(provider)}:
        raise HTTPException(400, f"Unknown voice {voice} for {model}")
    return provider


@router.post("/prepare")
def prepare(req: PrepareRequest) -> dict[str, Any]:
    text = markdown_to_text(req.markdown)
    provider = _provider(req.model)
    est = openai_audio.estimate(len(text), req.model) if provider == "openai" else {}
    return {"text": text, "characters": len(text), "chunks": len(chunk_text(text, CHUNK_CHARS[provider])), "estimate": est}


@router.post("/sample")
def sample(req: SampleRequest) -> Response:
    _check_voice(req.voice, req.model)
    cache = (req.voice, req.model)
    if cache not in _samples:
        try:
            _samples[cache] = _wav(_synthesize(SAMPLE_TEXT, req.voice, req.model, "", _me().get("id"))[0])
        except (RuntimeError, ValueError) as e:
            raise HTTPException(429 if isinstance(e, openai_audio.BudgetExceeded) else 502, str(e)) from e
    return Response(_samples[cache], media_type="audio/wav")


@router.post("/jobs")
def create_job(req: JobRequest) -> dict[str, Any]:
    me = _me()
    provider = _check_voice(req.voice, req.model)
    if provider != "openai":
        raise HTTPException(400, "New jobs are read by OpenAI; Gemini TTS only finishes jobs made before the switch")
    _key(provider)
    try:
        openai_audio.check_budget(me.get("id"))
    except openai_audio.BudgetExceeded as e:
        raise HTTPException(429, str(e)) from e
    text = markdown_to_text(req.markdown)
    if not text:
        raise HTTPException(400, "Nothing to read: the markdown has no text")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f"The text is {len(text):,} characters; the limit is {MAX_CHARS:,}")
    # a job the remaining budget cannot finish is refused now, not stopped halfway after paying for half
    est, s = openai_audio.estimate(len(text), req.model), openai_audio.spend(me.get("id"))
    lefts = [c - u for c, u in ((s["cap_usd"], s["usd"]), (s.get("user_cap_usd"), s.get("user_usd", 0.0))) if c is not None]
    left = min(lefts) if lefts else None
    if left is not None and est["usd"] > left:
        raise HTTPException(429, f"Reading this costs about ${est['usd']:.2f}; ${max(left, 0):.2f} of this month's OpenAI audio budget is left")
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id, "title": req.title.strip() or "Untitled", "voice": req.voice, "model": req.model, "style": req.style,
        "status": "running", "done": 0, "chunks": chunk_text(text, CHUNK_CHARS[provider]), "text": text, "characters": len(text),
        "created_at": time.time(), "error": None, "usd": 0.0, "estimate": openai_audio.estimate(len(text), req.model),
        "user_id": me.get("id"), "username": me.get("username"),
    }
    _load()
    with _lock:
        mine = [j for j in _jobs.values() if j.get("user_id") == me.get("id")]
        for old in sorted(mine, key=lambda j: j["created_at"])[: -(KEEP - 1)]:  # keep each user's latest
            if old["status"] != "running":
                _jobs.pop(old["id"], None)
                shutil.rmtree(_dir(old["id"]), ignore_errors=True)
        _jobs[job_id] = job
        _save(job)
    _start(job_id)
    return _public(job)


@router.get("/jobs")
def list_jobs() -> list[dict[str, Any]]:
    _load()
    me = _me()
    return [_public(j) for j in sorted(_jobs.values(), key=lambda j: -j["created_at"]) if _visible(j, me)]


def _me() -> dict[str, Any]:
    import auth

    p = auth.current()
    return p if p and auth.enabled() else {"id": "local", "username": "local", "role": "admin"}


def _visible(job: dict[str, Any], me: dict[str, Any]) -> bool:
    """A job's text and audio are its owner's (and administrators'); jobs from before owners were kept: administrators."""
    return me.get("role") == "admin" or (job.get("user_id") is not None and job.get("user_id") == me.get("id"))


def _job(job_id: str) -> dict[str, Any]:
    _load()
    job = _jobs.get(job_id)
    if not job or not _visible(job, _me()):
        raise HTTPException(404, "Job not found")
    return job


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    return _public(_job(job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    job = _job(job_id)
    if job["status"] == "running":
        with _lock:
            job["status"] = "cancelled"
            _save(job)
    return _public(job)


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str) -> dict[str, Any]:
    """Continue a failed or cancelled job from the chunks it still needs."""
    job = _job(job_id)
    if job["status"] in ("running", "completed"):
        raise HTTPException(409, f"The job is {job['status']}")
    _key(_provider(job["model"]))
    with _lock:
        job.update(status="running", error=None)
        _save(job)
    _start(job_id)
    return _public(job)


@router.get("/jobs/{job_id}/audio")
def job_audio(job_id: str) -> Response:
    job = _job(job_id)
    if job["status"] != "completed":
        raise HTTPException(409, f"The job is {job['status']}")
    name = re.sub(r"[^\w.-]+", "-", job["title"]).strip("-") or "speech"
    path = _dir(job_id) / "audio.wav"
    if not path.exists():
        raise HTTPException(410, "The audio file is gone")
    return Response(path.read_bytes(), media_type="audio/wav", headers={"Content-Disposition": f'inline; filename="{name}.wav"'})
