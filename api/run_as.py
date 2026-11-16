"""Background work as the user who set it up (Foundry: a user-scoped schedule "is triggered on behalf of the user who
last edited (or created) the schedule"; an automation's effects run "on behalf of the owner of the automation" and
"will no longer run if the associated user account is disabled or deleted").

A scheduler thread has no request principal: whatever it calls runs as the system, which no marking or Project role
limits. Jobs that act for a user (scheduled builds, automations, scheduled Contour / Logic flow / SQL rebuilds, Foundry
Rules workflows, Workflow Builder runs) take their owner's principal here — their markings, groups and Project roles —
so the same checks a request makes apply. When the owner is missing, deleted or deactivated the job does not run (and
never falls back to the system): `OwnerUnavailable` carries the reason the job records on its run.

Sign-in off: there are no users; jobs run as before (no limits), owner or not.
"""

from __future__ import annotations

import contextlib
from typing import Iterator, Optional

import auth


class OwnerUnavailable(Exception):
    """The job's owner cannot be acted for (none recorded, deleted or deactivated); str(e) is the reason."""


def who(user_id: Optional[str]) -> str:
    """A user's display name (or username) for run records."""
    label = auth.user_label(user_id) or {}
    return label.get("display_name") or label.get("username") or str(user_id or "its owner")


def owner_principal(user_id: Optional[str], what: str = "the schedule") -> Optional[dict]:
    """The owner as a request principal (markings, groups; roles are looked up per Project). None with sign-in off.
    Raises OwnerUnavailable when sign-in is on and there is no such active user."""
    if not auth.enabled():
        return None
    if not user_id or user_id in ("local", "system"):
        raise OwnerUnavailable(f"{what} has no owner it can run as: an Editor must save it again (it then runs as them)")
    p = auth.principal_of(user_id)
    if p is None:
        status = (auth.user_label(user_id) or {}).get("status", "deleted")
        raise OwnerUnavailable(f"{what}'s owner {who(user_id)} is {status}: an Editor must take it over (edit and save it)")
    return p


@contextlib.contextmanager
def acting_as(principal: Optional[dict]) -> Iterator[Optional[dict]]:
    """Run the block as `principal` (None: as the system — only with sign-in off)."""
    token = auth._principal.set(principal)
    try:
        yield principal
    finally:
        auth._principal.reset(token)


@contextlib.contextmanager
def as_owner(user_id: Optional[str], what: str = "the schedule") -> Iterator[Optional[dict]]:
    """owner_principal + acting_as: raises OwnerUnavailable before the block runs."""
    p = owner_principal(user_id, what)
    with acting_as(p):
        yield p


def missing_marking_names(item_id: Optional[str], principal: Optional[dict]) -> list[str]:
    """The names of the markings on an item (its own, inherited, its folders') the principal does not hold."""
    if not auth.enabled() or principal is None or principal.get("service") or not item_id:
        return []
    missing = sorted(auth.missing_markings(auth.effective_markings(item_id), principal.get("markings")))
    return auth._marking_names(missing) if missing else []
