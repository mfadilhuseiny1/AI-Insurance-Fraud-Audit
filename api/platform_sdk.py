"""The Foundry platform SDK inside functions (`foundry_sdk.FoundryClient()`): the read-only platform APIs a function's
client may use, matching Foundry's function scopes (api:admin-read, api:functions-read, api:usage:mediasets-read).

- GET  /api/platform-sdk/admin/users/current      the user running the function
- GET  /api/platform-sdk/admin/users/{id}         id, username, given / family name, email, attributes, organization
- GET  /api/platform-sdk/admin/groups/{id}        id, name, description, member count
- POST /api/platform-sdk/language-models/chat     a Palantir-provided model's CreateChatCompletion ({messages} →
                                                  {completion}); the default language model answers

The runtime side is code_functions (module foundry_sdk). Datasets cannot be read through it, like in Foundry (deployed
functions lack api:usage:datasets-read). Mounted by server.py.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/platform-sdk")


def _user_view(u: dict) -> dict:
    return {"id": u["id"], "username": u["username"], "given_name": u.get("first_name") or None, "family_name": u.get("last_name") or None,
            "email": u.get("email") or None, "attributes": u.get("attributes") or {}, "organization": u.get("organization_id"),
            "status": "deactivated" if u.get("disabled") else "active"}


@router.get("/admin/users/current")
def current_user() -> dict:
    me = auth.current()
    if not me or me.get("service"):
        # sign-in off (development): a local user
        return {"id": "local", "username": "local", "given_name": None, "family_name": None, "email": None, "attributes": {}, "organization": None,
                "status": "active"}
    return _user_view(auth._user(me.get("id") or me.get("user_id") or me["username"]))


@router.get("/admin/users/{user_id}")
def get_user(user_id: str) -> dict:
    return _user_view(auth._user(user_id))


@router.get("/admin/groups/{group_id}")
def get_group(group_id: str) -> dict:
    g = next((x for x in auth._groups() if x["id"] == group_id or x.get("name") == group_id), None)
    if not g:
        raise HTTPException(404, "Group not found")
    return {"id": g["id"], "name": g["name"], "description": g.get("description") or "", "member_count": len(g.get("members") or [])}


class ChatIn(BaseModel):
    model: Optional[str] = None
    messages: list[dict] = Field(min_length=1, max_length=200)


@router.post("/language-models/chat")
def chat(req: ChatIn) -> dict:
    import ontology
    import pipeline_ai

    system = "\n".join(str(m.get("content") or "") for m in req.messages if str(m.get("role", "")).lower() == "system")
    rest = [m for m in req.messages if str(m.get("role", "")).lower() != "system"]
    user = "\n\n".join(f"{str(m.get('role') or 'user').lower()}: {m.get('content')}" if len(rest) > 1 else str(m.get("content") or "") for m in rest)
    try:
        text = pipeline_ai.chat(req.model or ontology.DEFAULT_LLM, system, user, None, 0, 2048)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"the language model failed: {e}") from e
    return {"completion": text}
