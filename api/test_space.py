"""Test and bug-hunting items, kept apart from demos and real work.

Tests that run against the live app leave their items behind on purpose ("(test)" in the name — the user deletes them
later, they are never removed automatically). Hundreds of them (pipelines, builds, projects, lineage graphs) used to
crowd the default lists and the lineage graph. One rule decides what is a test item, everywhere:

  - its own name, or the name of any folder/project above it, holds the word "test" (e.g. "(test)", "(test 2)",
    "manual (1517, test)", "(test) WFA notepad", "Test") or "(uji)";

Lists hide test items by default and offer them in a separate "Uji & bug" view; nothing is moved or deleted. To keep a
new test item apart, name it — or its project — with "(test)".
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Iterable, Optional

TEST_RE = re.compile(r"\btest\b|\(uji\)", re.IGNORECASE)
_TTL = 60.0
_cache: dict[str, tuple[float, bool]] = {}
_lock = threading.Lock()


def is_test_name(name: Optional[str]) -> bool:
    return bool(name and TEST_RE.search(str(name)))


def is_test_path(path: Optional[Iterable[Any]]) -> bool:
    """path: the folders above an item, as {name} records or names."""
    return any(is_test_name(p.get("name") if isinstance(p, dict) else p) for p in path or [])


def is_test_item(item: dict) -> bool:
    """An item record, with its path when it has one (drive._with_path)."""
    return is_test_name(item.get("name")) or is_test_path(item.get("path"))


def is_test_id(item_id: Optional[str]) -> bool:
    """A Files item (pipeline, dataset, …) by id: its name or a folder above it; cached for a minute."""
    if not item_id:
        return False
    now = time.monotonic()
    with _lock:
        hit = _cache.get(item_id)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    import db

    try:
        path = db.drive_path(item_id)  # root-most first, the item itself last
    except Exception:  # noqa: BLE001 - an item the store cannot place is not hidden
        path = []
    value = is_test_path(path)
    with _lock:
        _cache[item_id] = (now, value)
    return value
