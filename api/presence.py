"""Editing presence: who else has a document open (Reports, Notepad, Fusion editors), from heartbeats.

An editor sends a heartbeat every ~15 seconds while a document is open ({editing: true} while it is in edit mode;
`at`: where in the document they are — a Fusion cell, a Notepad block — for live cursors, sent every few seconds);
viewers of the same document see everyone seen in the last 45 seconds. Kept in memory: a restart forgets it, which
only drops the indicators for one heartbeat. A document is named by its Files item id, so the caller must be able to
open that item.

Mounted by server.py under /api/presence.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/presence")
TTL_S = 45
_lock = threading.Lock()
# item id -> user id -> {name, editing, at}
_seen: dict[str, dict[str, dict]] = {}


class BeatIn(BaseModel):
    editing: bool = False
    # where in the document (e.g. "<sheet id>!B4", a block id)
    at: Optional[str] = Field(None, max_length=200)


def _who() -> tuple[str, str]:
    me = auth.current() or {}
    return me.get("id") or "local", me.get("display_name") or me.get("username") or "local"


def _others(item_id: str, me: str) -> list[dict]:
    now = time.time()
    with _lock:
        live = {u: v for u, v in (_seen.get(item_id) or {}).items() if now - v["at"] <= TTL_S}
        if live:
            _seen[item_id] = live
        else:
            _seen.pop(item_id, None)
    return [{"user_id": u, "name": v["name"], "editing": v["editing"], "at": v.get("where"), "seconds_ago": int(now - v["at"])} for u, v in sorted(live.items()) if u != me]


@router.post("/{item_id}")
def beat(item_id: str, req: BeatIn) -> dict:
    """I have the document open (editing or viewing); returns the others who have it open."""
    import drive

    drive._item(item_id)
    uid, name = _who()
    with _lock:
        _seen.setdefault(item_id, {})[uid] = {"name": name, "editing": req.editing, "where": req.at, "at": time.time()}
    return {"others": _others(item_id, uid)}


@router.delete("/{item_id}")
def leave(item_id: str) -> dict:
    uid, _ = _who()
    with _lock:
        (_seen.get(item_id) or {}).pop(uid, None)
    return {"left": item_id}


def editors(item_id: str, exclude: Optional[str] = None) -> list[dict]:
    """Who is editing the item now (for other modules)."""
    return [x for x in _others(item_id, exclude or "") if x["editing"]]
