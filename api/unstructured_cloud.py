"""Unstructured Transform API (https://transform.unstructured.io) for the Unstructured tier.

Configuration, from the environment or the repo's .env.local:
    UNSTRUCTURED_API_KEY      API key from the Unstructured platform
    UNSTRUCTURED_SERVER_URL   optional, default https://transform.unstructured.io
    UNSTRUCTURED_PROFILE      optional parse profile (the service default is "balanced")

Each call parses one document (a ≤10-page PDF chunk or an image) as an async job: submitted with
`Prefer: wait=0`, then polled until it finishes, so long documents don't hold one HTTP request
open. Elements come back in unstructured's own shape; page numbers are shifted onto the job's.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Callable

DEFAULT_SERVER_URL = "https://transform.unstructured.io"
POLL_SECONDS = 2.0
TIMEOUT = 1800
DONE = {"completed", "completed_with_warnings"}
FAILED = {"failed", "cancelled"}


def settings(env: Callable[[str], str]) -> dict[str, str]:
    return {
        "api_key": env("UNSTRUCTURED_API_KEY"),
        "server_url": env("UNSTRUCTURED_SERVER_URL") or DEFAULT_SERVER_URL,
        "profile": env("UNSTRUCTURED_PROFILE"),
    }


def is_configured(s: dict[str, str]) -> bool:
    return bool(s["api_key"])


def _client(s: dict[str, str]) -> Any:
    from unstructured_transform_client import TransformClient

    return TransformClient(api_key=s["api_key"], server_url=s["server_url"], timeout_seconds=300)


def process(s: dict[str, str], content: bytes, suffix: str, first_page_number: int, filename: str) -> list[dict]:
    """Parse one document and return element dicts numbered from first_page_number."""
    with _client(s) as client:
        accepted = client.parse.run(
            input=(f"chunk{suffix}", content),
            output="elements",
            include=["table_html"],
            profile=s["profile"] or None,
            wait_seconds=0,
        )
        # a fast document can come back finished (200) instead of accepted (202)
        result = getattr(accepted, "elements", None) is not None and accepted
        deadline = time.monotonic() + TIMEOUT
        while not result:
            if time.monotonic() > deadline:
                raise RuntimeError(f"Unstructured job {accepted.id} did not finish in {TIMEOUT} s")
            time.sleep(POLL_SECONDS)
            job = client.jobs.get(accepted.id, output="elements", include=["table_html"])
            status = str(getattr(job.status, "value", job.status))
            if status in FAILED:
                raise RuntimeError(f"Unstructured job {accepted.id} {status}: {job.error}")
            if status in DONE and job.result is not None:
                result = job.result
    return to_elements([e.to_dict() for e in result.elements], first_page_number, filename, suffix)


def to_elements(raw: list[dict], first_page_number: int, filename: str, suffix: str) -> list[dict]:
    filetype = "application/pdf" if suffix == ".pdf" else f"image/{suffix.lstrip('.')}"
    elements = []
    for seq, e in enumerate(raw):
        meta = e.get("metadata") or {}
        page = (meta.get("page_number") or 1) + first_page_number - 1
        metadata: dict[str, Any] = {"page_number": page, "filename": filename, "filetype": filetype}
        if meta.get("text_as_html"):
            metadata["text_as_html"] = meta["text_as_html"]
        text = e.get("text") or ""
        # ids from the service are per request; make them unique across a job's chunks
        key = f"{filename}|{page}|{seq}|{e.get('type')}|{text}"
        elements.append({
            "type": e.get("type") or "UncategorizedText",
            "element_id": hashlib.sha256(key.encode()).hexdigest()[:32],
            "text": text,
            "metadata": metadata,
        })
    return elements
