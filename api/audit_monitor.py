"""Monitoring of audit.3 logs (Security auditing → "Monitor audit logs"): detections, alerts and baselines.

Detections are category-based rules evaluated on every new audit.3 line (audit3.LISTENERS), so they keep working when
new features log with the same categories:
  failed_auth          authenticationCheck that did not succeed, more than `count` for one user within `minutes`
  after_hours_export   dataExport outside business hours (`start_hour`–`end_hour`, weekdays, in `timezone`)
  large_export         dataExport larger than `bytes`
  marked_export        dataExport of a resource carrying markings (sensitive data)
  load_then_export     more than `count` dataLoad / ontologyDataLoad lines by one user, then a dataExport, within `minutes`
  permission_change    managementPermissions / managementMarkings / managementGroups (privilege changes)
  token_burst          more than `count` tokenGeneration lines by one user within `minutes`
A match opens an alert (or adds to the open alert of the same detection and user) and notifies the detection's
recipients (default: administrators) in the inbox, and by email when asked. Alerts are triaged: open →
acknowledged → resolved, with an assignee and notes. A detection can be tried on past logs first ("Test on the last
N days") to tune thresholds against baseline behavior.

Baselines: per user, events per day, login hours, categories, exports, compared with today (activity well above the
user's usual level, and sign-ins at hours never seen before, are flagged).

Mounted under /api/audit (audit3.router's prefix) by server.py.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import audit3
import auth

log = logging.getLogger("bluesandai.audit_monitor")
router = APIRouter(prefix="/api/audit", tags=["audit"])
_lock = threading.RLock()
_windows: dict[tuple[str, str], deque] = defaultdict(deque)
_recent_loads: dict[str, deque] = defaultdict(deque)

DETECTIONS: dict[str, dict] = {
    "failed_auth": {"name": "Failed authentication burst", "severity": "high", "params": {"count": 5, "minutes": 15},
                    "description": "authenticationCheck that did not succeed, more than count times for one user within minutes (credential stuffing, compromised accounts)."},
    "after_hours_export": {"name": "Export outside business hours", "severity": "medium", "params": {"start_hour": 7, "end_hour": 19, "timezone": "Asia/Jakarta"},
                           "description": "dataExport on a weekend or outside start_hour–end_hour in the timezone."},
    "large_export": {"name": "Large export", "severity": "high", "params": {"bytes": 100_000_000},
                     "description": "A dataExport whose downloaded size is above bytes."},
    "marked_export": {"name": "Export of marked data", "severity": "high", "params": {},
                      "description": "A dataExport of a resource that carries markings (sensitive data)."},
    "load_then_export": {"name": "Bulk data load followed by export", "severity": "high", "params": {"count": 50, "minutes": 60},
                         "description": "More than count dataLoad / ontologyDataLoad lines by one user, then a dataExport, within minutes (data exfiltration)."},
    "permission_change": {"name": "Permission change", "severity": "low", "params": {},
                          "description": "managementPermissions, managementMarkings or managementGroups (privilege escalation, permission drift)."},
    "token_burst": {"name": "Token generation burst", "severity": "medium", "params": {"count": 5, "minutes": 60},
                    "description": "More than count tokenGeneration lines by one user within minutes (preparation for bulk access)."},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _path(name: str):
    return audit3.DIR / name


def _config() -> dict:
    saved = audit3._read(_path("detections.json"), {})
    out = {}
    for k, d in DETECTIONS.items():
        s = saved.get(k, {})
        out[k] = {"id": k, **d, "enabled": s.get("enabled", True), "severity": s.get("severity", d["severity"]),
                  "params": {**d["params"], **(s.get("params") or {})}, "recipients": s.get("recipients") or [], "email": bool(s.get("email"))}
    return out


def _alerts() -> list[dict]:
    return audit3._read(_path("alerts.json"), [])


def _save_alerts(rows: list[dict]) -> None:
    audit3._write(_path("alerts.json"), rows[-5000:])


# ------------------------------------------------------------------------------------------------
# evaluating new lines
# ------------------------------------------------------------------------------------------------


def _t(line: dict) -> datetime:
    return datetime.fromisoformat(line["time"].replace("Z", "+00:00"))


def _marked(resources: list) -> list[str]:
    out = []
    for r in resources or []:
        rid = r.get("id") if isinstance(r, dict) else r
        try:
            if rid and auth.effective_markings(str(rid)):
                out.append(str(rid))
        except Exception:  # noqa: BLE001
            pass
    return out


def evaluate(line: dict, cfg: Optional[dict] = None, state: Optional[dict] = None) -> list[tuple[str, str, str]]:
    """The detections a line triggers: [(detection id, user key, detail)]. state: separate windows for a test run."""
    cfg = cfg or _config()
    cats = set(line.get("categories") or [])
    uid = line.get("uid") or "unknown"
    t = _t(line)
    windows = state["windows"] if state is not None else _windows
    loads = state["loads"] if state is not None else _recent_loads
    hits = []

    def burst(key: tuple[str, str], minutes: float, count: int) -> int:
        q = windows[key]
        q.append(t)
        while q and q[0] < t - timedelta(minutes=minutes):
            q.popleft()
        return len(q) if len(q) > count else 0

    on = {k for k, d in cfg.items() if d["enabled"]}
    if "failed_auth" in on and "authenticationCheck" in cats and line.get("result") != "SUCCESS":
        who = ((line.get("requestFields") or {}).get("authenticationCheckTargets") or [None])[0] or uid
        p = cfg["failed_auth"]["params"]
        n = burst(("failed_auth", str(who)), p["minutes"], p["count"])
        if n:
            hits.append(("failed_auth", str(who), f"{n} failed authentication checks for {who} within {p['minutes']} minutes"))
    if "dataExport" in cats and line.get("result") == "SUCCESS":
        res = (line.get("requestFields") or {}).get("downloadedResources") or []
        size = (line.get("resultFields") or {}).get("downloadedSize") or 0
        if "after_hours_export" in on:
            p = cfg["after_hours_export"]["params"]
            local = t.astimezone(ZoneInfo(p.get("timezone") or "UTC"))
            if local.weekday() >= 5 or not (p["start_hour"] <= local.hour < p["end_hour"]):
                hits.append(("after_hours_export", uid, f"export at {local:%a %H:%M} {p.get('timezone')}: {len(res)} resource(s)"))
        if "large_export" in on and size and size > cfg["large_export"]["params"]["bytes"]:
            hits.append(("large_export", uid, f"export of {size:,} bytes"))
        if "marked_export" in on:
            m = _marked(res)
            if m:
                hits.append(("marked_export", uid, f"export of marked resource(s): {', '.join(m[:5])}"))
        if "load_then_export" in on:
            p = cfg["load_then_export"]["params"]
            q = loads[uid]
            while q and q[0] < t - timedelta(minutes=p["minutes"]):
                q.popleft()
            if len(q) > p["count"]:
                hits.append(("load_then_export", uid, f"{len(q)} data loads within {p['minutes']} minutes, then an export"))
    if cats & {"dataLoad", "ontologyDataLoad"} and "load_then_export" in on:
        loads[uid].append(t)
    if "permission_change" in on and cats & {"managementPermissions", "managementMarkings", "managementGroups"}:
        hits.append(("permission_change", uid, f"{line.get('name')}: {json.dumps(line.get('requestFields') or {}, default=str)[:200]}"))
    if "token_burst" in on and "tokenGeneration" in cats:
        p = cfg["token_burst"]["params"]
        n = burst(("token_burst", uid), p["minutes"], p["count"])
        if n:
            hits.append(("token_burst", uid, f"{n} tokens generated within {p['minutes']} minutes"))
    return hits


def _notify(alert: dict, det: dict) -> None:
    try:
        import notify

        recipients = det["recipients"] or [u["id"] for u in auth._users() if u.get("role") == "admin" and not u.get("disabled")]
        for r in recipients:
            notify.deliver(r, f"Security alert: {alert['title']}", alert["detail"], link=f"/security-auditing?alert={alert['id']}",
                           link_label="Open alert", source="security-auditing", email=det["email"])
    except Exception:  # noqa: BLE001
        log.exception("alert notification failed")


def on_line(line: dict) -> None:
    """audit3 listener: opens or extends alerts."""
    if line.get("product") == "audit":
        return
    try:
        with _lock:
            cfg = _config()
            hits = evaluate(line, cfg)
            if not hits:
                return
            rows = _alerts()
            new = []
            for det_id, key, detail in hits:
                det = cfg[det_id]
                cur = next((a for a in rows if a["detection"] == det_id and a["key"] == key and a["status"] != "resolved"
                            and a["last_at"] >= _iso(_now() - timedelta(hours=24))), None)
                if cur:
                    cur.update(last_at=_iso(), count=cur["count"] + 1, detail=detail, events=(cur["events"] + [line["logEntryId"]])[-50:])
                    continue
                a = {"id": "al-" + uuid.uuid4().hex[:10], "detection": det_id, "title": det["name"], "severity": det["severity"], "key": key,
                     "uid": line.get("uid"), "detail": detail, "first_at": _iso(), "last_at": _iso(), "count": 1, "events": [line["logEntryId"]],
                     "status": "open", "assignee": None, "notes": []}
                rows.append(a)
                new.append((a, det))
            _save_alerts(rows)
        for a, det in new:
            _notify(a, det)
    except Exception:  # noqa: BLE001
        log.exception("audit detection failed")


audit3.LISTENERS.append(on_line)


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


@router.get("/detections")
def detections() -> list[dict]:
    auth.require_admin()
    return list(_config().values())


class DetectionIn(BaseModel):
    enabled: Optional[bool] = None
    severity: Optional[str] = Field(None, pattern="^(low|medium|high)$")
    params: Optional[dict[str, Any]] = None
    recipients: Optional[list[str]] = None
    email: Optional[bool] = None


@router.put("/detections/{det_id}")
def update_detection(det_id: str, req: DetectionIn) -> dict:
    auth.require_admin()
    if det_id not in DETECTIONS:
        raise HTTPException(404, "no such detection")
    with _lock:
        saved = audit3._read(_path("detections.json"), {})
        s = saved.setdefault(det_id, {})
        for k in ("enabled", "severity", "recipients", "email"):
            if getattr(req, k) is not None:
                s[k] = getattr(req, k)
        if req.params is not None:
            known = DETECTIONS[det_id]["params"]
            bad = set(req.params) - set(known)
            if bad:
                raise HTTPException(400, f"unknown parameter(s): {', '.join(sorted(bad))}")
            s["params"] = {**(s.get("params") or {}), **req.params}
        audit3._write(_path("detections.json"), saved)
    audit3.emit("AUDIT_UPDATE_DETECTION", ["monitorUpdate"], {"updatedMonitorResources": [{"type": "detection", "id": det_id}],
                                                              "updatedMonitorDescription": json.dumps(req.model_dump(exclude_none=True))}, product="audit")
    return _config()[det_id]


@router.post("/detections/{det_id}/test")
def test_detection(det_id: str, days: int = 7) -> dict:
    """Run one detection over past logs (fresh windows) without opening alerts."""
    auth.require_admin()
    cfg = _config()
    if det_id not in cfg:
        raise HTTPException(404, "no such detection")
    only = {k: {**d, "enabled": k == det_id} for k, d in cfg.items()}
    state = {"windows": defaultdict(deque), "loads": defaultdict(deque)}
    t1 = _now()
    t0 = t1 - timedelta(days=max(1, min(days, 90)))
    lines = sorted(audit3.lines(t0, t1), key=lambda x: x["time"])
    matches = []
    for line in lines:
        for d, key, detail in evaluate(line, only, state):
            matches.append({"time": line["time"], "key": key, "detail": detail, "logEntryId": line["logEntryId"]})
    keys: dict[str, int] = {}
    for m in matches:
        keys[m["key"]] = keys.get(m["key"], 0) + 1
    names = audit3._user_names(set(keys))
    return {"detection": det_id, "scanned": len(lines), "matches": len(matches), "by_user": [{"key": k, "name": names.get(k, k), "count": v} for k, v in
            sorted(keys.items(), key=lambda kv: -kv[1])], "examples": matches[-20:]}


@router.get("/alerts")
def alerts(status: Optional[str] = None) -> list[dict]:
    auth.require_admin()
    rows = [a for a in _alerts() if not status or a["status"] == status]
    names = audit3._user_names({a.get("uid") for a in rows} | {a.get("key") for a in rows} | {a.get("assignee") for a in rows})
    return [{**a, "userName": names.get(a.get("uid")) or names.get(a.get("key")), "assigneeName": names.get(a.get("assignee"))}
            for a in sorted(rows, key=lambda a: a["last_at"], reverse=True)]


class AlertChange(BaseModel):
    status: Optional[str] = Field(None, pattern="^(open|acknowledged|resolved)$")
    assignee: Optional[str] = None
    note: Optional[str] = Field(None, max_length=2000)


@router.patch("/alerts/{alert_id}")
def update_alert(alert_id: str, req: AlertChange) -> dict:
    p = auth.require_admin()
    with _lock:
        rows = _alerts()
        a = next((x for x in rows if x["id"] == alert_id), None)
        if not a:
            raise HTTPException(404, "alert not found")
        if req.status:
            a["status"] = req.status
            a.setdefault("history", []).append({"at": _iso(), "by": p.get("username"), "status": req.status})
        if req.assignee is not None:
            a["assignee"] = req.assignee or None
        if req.note:
            a["notes"].append({"at": _iso(), "by": p.get("username"), "text": req.note})
        _save_alerts(rows)
    return a


@router.get("/baselines")
def baselines(days: int = 14) -> list[dict]:
    """Per user: usual activity over the past days (today excluded) against today's."""
    auth.require_admin()
    now = _now()
    today = now.date().isoformat()
    t0 = now - timedelta(days=max(2, min(days, 90)))
    users: dict[str, dict] = {}
    for x in audit3.lines(t0, now):
        uid = x.get("uid")
        if not uid:
            continue
        u = users.setdefault(uid, {"uid": uid, "days": defaultdict(int), "today": 0, "login_hours": [0] * 24, "today_login_hours": set(),
                                   "categories": defaultdict(int), "exports": 0, "export_bytes": 0, "origins": set(), "failed": 0})
        day = x["time"][:10]
        if day == today:
            u["today"] += 1
        else:
            u["days"][day] += 1
        cats = x.get("categories") or []
        for c in cats:
            u["categories"][c] += 1
        if "userLogin" in cats:
            h = _t(x).hour
            if day == today:
                u["today_login_hours"].add(h)
            else:
                u["login_hours"][h] += 1
        if "authenticationCheck" in cats and x.get("result") != "SUCCESS":
            u["failed"] += 1
        if "dataExport" in cats:
            u["exports"] += 1
            u["export_bytes"] += (x.get("resultFields") or {}).get("downloadedSize") or 0
        if x.get("origin"):
            u["origins"].add(x["origin"])
    names = audit3._user_names(set(users))
    out = []
    span = max(1, (now - t0).days)
    for uid, u in users.items():
        avg = sum(u["days"].values()) / span
        new_hours = sorted(h for h in u["today_login_hours"] if not u["login_hours"][h]) if any(u["login_hours"]) else []
        flags = []
        if u["today"] > max(20, 3 * avg):
            flags.append(f"today {u['today']} events vs about {avg:.0f} a day")
        if new_hours:
            flags.append("sign-in at an unusual hour (UTC): " + ", ".join(f"{h:02d}:00" for h in new_hours))
        if u["failed"] >= 5:
            flags.append(f"{u['failed']} failed authentication checks")
        out.append({"uid": uid, "name": names.get(uid, uid), "avg_per_day": round(avg, 1), "today": u["today"], "login_hours": u["login_hours"],
                    "top_categories": sorted(u["categories"].items(), key=lambda kv: -kv[1])[:6], "exports": u["exports"],
                    "export_bytes": u["export_bytes"], "origins": sorted(u["origins"])[:10], "failed_auth": u["failed"], "flags": flags})
    return sorted(out, key=lambda r: (-len(r["flags"]), -r["today"]))
