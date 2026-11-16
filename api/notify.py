"""Deliver a notification to a user: the in-app inbox (/api/notifications, ontology_actions.py stores it per user)
and, when asked and email is configured, an email (mailer.py)."""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("bluesandai.notify")
_lock = threading.Lock()


# what users can tune (Account → Notifications): source prefix → label
SOURCES = {"approvals": "Approvals (requests to review, decisions, comments)", "groups": "Group memberships (expiry reminders and ended memberships)", "object-monitors": "Object monitors", "automation": "Automations",
           "sensitive-data-scanner": "Sensitive Data Scanner", "workflow-builder": "Workflow Builder", "recipes": "Recipes", "other": "Everything else"}


def source_key(source: str) -> str:
    s = (source or "").split(":")[0]
    return s if s in SOURCES else "other"


def preference(user_id: str, source: str) -> Optional[dict]:
    """{web, email} the user chose for this source, or None (the sender decides)."""
    try:
        import auth

        u = auth._user(user_id) if auth.enabled() else None
    except Exception:  # noqa: BLE001 - a deleted user
        return None
    return ((u or {}).get("notification_settings") or {}).get(source_key(source))


def deliver(user_id: str, subject: str, body: str, link: Optional[str] = None, link_label: str = "Open", source: str = "",
            web: bool = True, email: bool = False, html: Optional[str] = None, attachments: Optional[list] = None) -> dict:
    """{web: bool, email: bool} — what was delivered."""
    import auth
    import ontology

    out = {"web": False, "email": False}
    # the user's notification settings (Account → Notifications): per source, in the app and / or by email
    pref = preference(user_id, source)
    if pref is not None:
        web = web and pref.get("web", True)
        email = pref.get("email", email)
    note = {"id": "ntf-" + uuid.uuid4().hex[:12], "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "subject": subject[:300], "body": body[:4000],
            "link": link, "link_label": link_label, "source": source, "read": False}
    if web:
        with _lock:
            path = ontology.DIR / "notifications" / f"{re.sub(r'[^A-Za-z0-9_-]', '_', user_id)}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                rows = json.loads(path.read_text("utf-8")) if path.exists() else []
            except ValueError:
                rows = []
            rows.append(note)
            path.write_text(json.dumps(rows[-300:]), "utf-8")
        out["web"] = True
    if email:
        try:
            import mailer

            u = auth._user(user_id) if auth.enabled() else None
            addr = (u or {}).get("email")
            if addr and mailer.configured():
                mailer.send(addr, subject, body + (f"\n\n{auth.web_url()}{link}" if link else ""),
                            html or mailer.html_message(subject, [body], (link_label, auth.web_url() + link) if link else None), attachments=attachments)
                out["email"] = True
        except Exception as e:  # noqa: BLE001 - email is best effort
            log.warning("email to %s failed: %s", user_id, e)
    return out
