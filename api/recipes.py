"""Recipes [Sunset] (palantir.com/docs/foundry/recipes): monitor a dataset for a condition of interest and notify
recipients (in-app notifications and / or email) with a preview of up to five columns.

- Schedule: time-based (every N hours, or on chosen weekdays at a time in a time zone) or event-based (when the
  dataset updates). Condition: none (always send) or rows matching a filter (column, operator, value; all must hold).
- Recipients (at most 25) get the preview only with Viewer access on the monitored dataset; others get the
  notification with a link only, and the run is a success with exceptions. Each recipient can mute the recipe; owners
  can pause it for all.
- Run history: success, success with exceptions, skipped (condition not met, or everyone muted), failed (with the
  error). The author is notified of failures and exceptions, and before the recipe expires (7 days and 1 day before;
  their preference: email, web or none). An expired recipe stops running until it is resumed / extended.
- Permissions follow the monitored dataset: viewers (and the author) see the recipe, owners (and the author) manage it.

Sources besides datasets:
- object type: its objects (property API names as columns), the same conditions; "when it updates" follows its edits;
- time series (Quiver's "If a sensor ever reaches a certain threshold"): the points of a series in the last N hours as
  rows (timestamp, value), e.g. value > 90;
- report ("Email on a schedule" from Reports → Actions): no condition; the report is rendered as its author sees it
  (report_render.py, headless Chrome) and sent as an attached PDF or an in-email image. Notifications in the app link
  to the report.
"""

from __future__ import annotations

import html as h
import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import pyarrow as pa

import auth
import db
import drive

log = logging.getLogger("bluesandai.recipes")
router = APIRouter(prefix="/api/recipes")
DB_PATH: Optional[Path] = None
_lock = threading.RLock()
MAX_RECIPIENTS = 25
MAX_COLUMNS = 5
PREVIEW_ROWS = 20
OPS = ("=", "!=", "<", "<=", ">", ">=", "contains", "is null", "is not null")


def configure(data_dir: Path) -> None:
    global DB_PATH
    d = data_dir / "recipes"
    d.mkdir(parents=True, exist_ok=True)
    DB_PATH = d / "recipes.sqlite"
    with _db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS runs_by ON runs (recipe_id, at);
            CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY, channel TEXT NOT NULL);
            """
        )


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    if DB_PATH is None:
        raise HTTPException(503, "Recipes is not configured")
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: Optional[datetime] = None) -> str:
    return (t or _now()).isoformat(timespec="seconds")


def _me() -> str:
    return (auth.current() or {}).get("id") or "system"


# ------------------------------------------------------------------------------------------------
# model
# ------------------------------------------------------------------------------------------------


class Filter(BaseModel):
    column: str
    op: Literal["=", "!=", "<", "<=", ">", ">=", "contains", "is null", "is not null"]
    value: Optional[str] = None


class Schedule(BaseModel):
    kind: Literal["hours", "weekly", "on_update"] = "weekly"
    every_hours: int = Field(24, ge=1, le=24 * 7)
    days: list[int] = Field(default_factory=lambda: [1])  # 0 = Monday
    time: str = "09:00"
    timezone: str = "UTC"


class RecipeIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # dataset: a Files item; object_type: an object type id; time_series: a sync id (with series_id); report: a report id
    source: Literal["dataset", "object_type", "time_series", "report"] = "dataset"
    item_id: str
    series_id: Optional[str] = None
    lookback_hours: int = Field(24, ge=1, le=24 * 31)
    attachment: Literal["pdf", "image"] = "pdf"
    message: str = Field("", max_length=4000)
    columns: list[str] = Field(default_factory=list)
    filters: list[Filter] = Field(default_factory=list)
    # always: send on every run; condition: only when rows match the filters
    when: Literal["always", "condition"] = "condition"
    schedule: Schedule = Field(default_factory=Schedule)
    channels: list[Literal["notification", "email"]] = Field(default_factory=lambda: ["notification"])
    recipients: list[str] = Field(default_factory=list)
    expires_in_days: int = Field(90, ge=1, le=365)


def _get(rid: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT record FROM recipes WHERE id = ?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "no such recipe")
    return json.loads(row[0])


def _put(r: dict) -> None:
    with _db() as con:
        con.execute("INSERT OR REPLACE INTO recipes (id, record) VALUES (?, ?)", (r["id"], json.dumps(r)))


def _src(r: dict) -> str:
    return r.get("source") or "dataset"


def _as(principal: Optional[dict], fn):
    """Run a check as another principal (a recipient)."""
    token = auth._principal.set(principal)
    try:
        return fn()
    finally:
        auth._principal.reset(token)


def _source_access(r: dict, p: Optional[dict]) -> bool:
    """Whether a principal may see the monitored resource (and so the preview)."""
    src = _src(r)
    if not auth.enabled() or p is None or p.get("service"):
        return True
    if src == "dataset":
        return auth.can_access(r["item_id"], p)
    if src == "report":
        return True
    try:
        if src == "object_type":
            import sql_studio

            _as(p, lambda: sql_studio._object_type_of(r["item_id"]))
        else:
            import timeseries

            _as(p, lambda: timeseries.check_sync(r["item_id"]))
        return True
    except HTTPException:
        return False


def _can_view(r: dict, principal: Optional[dict] = None) -> bool:
    """The author, its recipients (who may still lack access to the resource) and the resource's viewers."""
    p = principal if principal is not None else auth.current()
    if not auth.enabled() or p is None or p.get("service") or r["author"] == p.get("id") or p.get("id") in r.get("recipients", []):
        return True
    return _source_access(r, p)


def _check_manage(r: dict) -> None:
    p = auth.current()
    if not auth.enabled() or p is None or p.get("service") or r["author"] == p.get("id") or p.get("role") == "admin":
        return
    if _src(r) != "dataset":
        raise HTTPException(403, "only the author (or an administrator) manages this recipe")
    try:
        drive._item(r["item_id"], need="owner")
    except HTTPException:
        raise HTTPException(403, "only the author or Owners of the monitored dataset manage this recipe") from None


def _status(r: dict) -> str:
    if r.get("paused"):
        return "paused"
    if r["expires_at"] <= _iso():
        return "expired"
    return "active"


def _public(r: dict) -> dict:
    me = (auth.current() or {}).get("id")
    item = db.drive_get(r["item_id"])
    with _db() as con:
        runs = [json.loads(x) for (x,) in con.execute("SELECT record FROM runs WHERE recipe_id = ? ORDER BY at DESC LIMIT 20", (r["id"],)).fetchall()]
    can_manage = True
    try:
        _check_manage(r)
    except HTTPException:
        can_manage = False
    soon = _status(r) == "active" and datetime.fromisoformat(r["expires_at"]) - _now() < timedelta(days=7)
    if _src(r) == "dataset":
        resource = {"id": r["item_id"], "name": item["name"] if item else "(deleted)", "path": [p["name"] for p in db.drive_path(item["id"])[:-1]] if item else [],
                    "link": f"/datasets/{r['item_id']}"}
    else:
        resource = {"id": r["item_id"], "name": _source_name(r), "path": [], "link": _link(r)}
    return {**r, "source": _src(r), "status": _status(r), "expiring_soon": soon, "muted_by_me": me in (r.get("muted") or []), "can_manage": can_manage, "runs": runs,
            "resource": resource,
            "recipient_labels": {u: _label(u) for u in [r["author"], *r.get("recipients", [])]}}


def _label(uid: str) -> str:
    try:
        u = auth.user_label(uid) or {}
        return u.get("display_name") or u.get("username") or uid
    except Exception:  # noqa: BLE001
        return uid


def _validate(req: RecipeIn) -> None:
    if req.source == "dataset":
        item = drive._item(req.item_id, need="viewer")
        if item.get("kind") != "file":
            raise HTTPException(400, "recipes monitor a dataset")
    elif req.source == "report":
        if req.when == "condition":
            raise HTTPException(400, "a report recipe sends the report on its schedule (no condition)")
        if req.schedule.kind == "on_update":
            raise HTTPException(400, "a report recipe runs on a schedule")
    elif req.source == "time_series" and not req.series_id:
        raise HTTPException(400, "choose the series to monitor")
    if len(req.columns) > MAX_COLUMNS:
        raise HTTPException(400, f"a preview has at most {MAX_COLUMNS} columns")
    if len(set(req.recipients)) > MAX_RECIPIENTS:
        raise HTTPException(400, f"a recipe has at most {MAX_RECIPIENTS} recipients")
    try:
        ZoneInfo(req.schedule.timezone)
    except Exception:  # noqa: BLE001
        raise HTTPException(400, f"unknown time zone {req.schedule.timezone}") from None
    if req.when == "condition" and not req.filters:
        raise HTTPException(400, "a condition needs at least one filter (or send on every run)")
    if req.source == "report":
        return
    cols = {c["name"] for c in _schema(req.item_id, req.source)}
    bad = [c for c in [*req.columns, *[f.column for f in req.filters]] if c not in cols]
    if bad:
        raise HTTPException(400, f"no column {bad[0]} in the dataset")


def _schema(item_id: str, source: str = "dataset") -> list[dict]:
    if source == "time_series":
        return [{"name": "timestamp", "type": "timestamp"}, {"name": "value", "type": "double"}]
    t = _table({"item_id": item_id, "source": source})
    return [{"name": f.name, "type": str(f.type)} for f in t.schema]


def _table(r: dict) -> pa.Table:
    """The rows a recipe evaluates: a dataset, an object type's objects, or a series' recent points."""
    import sql_studio

    src = _src(r)
    if src == "object_type":
        return sql_studio._object_table(sql_studio._object_type_of(r["item_id"]))
    if src == "time_series":
        import timeseries

        timeseries.check_sync(r["item_id"])
        since = int((_now() - timedelta(hours=int(r.get("lookback_hours") or 24))).timestamp() * 1000)
        pts = timeseries.read_points(r["item_id"], r.get("series_id") or "", since, None)
        return pa.table({"timestamp": pa.array([datetime.fromtimestamp(t / 1000, timezone.utc) for t, _ in pts], pa.timestamp("ms", tz="UTC")),
                         "value": pa.array([float(v) if isinstance(v, (int, float)) else None for _, v in pts], pa.float64())})
    t, _ = sql_studio._data_table(r["item_id"])
    return t


def _source_name(r: dict) -> str:
    src = _src(r)
    try:
        if src == "object_type":
            import ontology

            return ontology._object_type(r["item_id"])["display_name"]
        if src == "time_series":
            import timeseries

            return f"{timeseries.resource_name(r['item_id'])} · {r.get('series_id')}"
        if src == "report":
            return _reports().get(r["item_id"], r["item_id"])
    except Exception:  # noqa: BLE001
        pass
    item = db.drive_get(r["item_id"]) or {}
    return item.get("name") or "(deleted)"


def _link(r: dict) -> str:
    src = _src(r)
    if src == "object_type":
        return f"/object-explorer?type={r['item_id']}"
    if src == "time_series":
        return f"/time-series?sync={r['item_id']}&series={r.get('series_id') or ''}"
    if src == "report":
        return f"/reports/{r['item_id']}"
    return f"/datasets/{r['item_id']}"


def _stamp(r: dict) -> str:
    """Changes when the monitored resource changes ("when it updates" schedules)."""
    src = _src(r)
    try:
        if src == "object_type":
            import ontology

            objs = ontology._objects(r["item_id"])
            return f"{len(objs)}:{max((str((o or {}).get('updated_at') or '') for o in objs.values()), default='')}"
        if src == "time_series":
            import timeseries

            return str(timeseries.series_extent(r["item_id"], r.get("series_id") or ""))
    except Exception:  # noqa: BLE001
        return ""
    return str((db.drive_get(r["item_id"]) or {}).get("updated_at"))


def _reports() -> dict[str, str]:
    """The Reports app's reports (reports.py: Files items) the user can see, by ID."""
    try:
        import reports

        return {i["id"]: i["name"].removesuffix(".report") for i in reports.list_reports()}
    except Exception:  # noqa: BLE001 - Files unavailable
        return {}


# ------------------------------------------------------------------------------------------------
# evaluation
# ------------------------------------------------------------------------------------------------


def _q(n: str) -> str:
    return '"' + n.replace('"', '""') + '"'


def _where(filters: list[dict]) -> tuple[str, list]:
    parts, args = [], []
    for f in filters:
        c = _q(f["column"])
        if f["op"] == "is null":
            parts.append(f"{c} IS NULL")
        elif f["op"] == "is not null":
            parts.append(f"{c} IS NOT NULL")
        elif f["op"] == "contains":
            parts.append(f"contains(lower(CAST({c} AS VARCHAR)), lower(?))")
            args.append(f.get("value") or "")
        else:
            # compare as numbers when both sides are numbers, else as text
            parts.append(f"(CASE WHEN TRY_CAST({c} AS DOUBLE) IS NOT NULL AND TRY_CAST(? AS DOUBLE) IS NOT NULL "
                         f"THEN TRY_CAST({c} AS DOUBLE) {f['op']} TRY_CAST(? AS DOUBLE) ELSE CAST({c} AS VARCHAR) {f['op']} ? END)")
            args += [f.get("value"), f.get("value"), f.get("value")]
    return (" AND ".join(parts) or "TRUE"), args


def evaluate(r: dict) -> dict:
    """{matched, total, columns, rows} of the monitored dataset now."""
    import duckdb

    table = _table(r)
    con = duckdb.connect()
    con.register("t", table)
    where, args = _where(r.get("filters") or []) if r.get("when") == "condition" else ("TRUE", [])
    matched = con.execute(f"SELECT count(*) FROM t WHERE {where}", args).fetchone()[0]
    cols = r.get("columns") or [f.name for f in table.schema][:MAX_COLUMNS]
    res = con.execute(f"SELECT {', '.join(_q(c) for c in cols)} FROM t WHERE {where} LIMIT {PREVIEW_ROWS}", args).fetchall()
    return {"matched": matched, "total": table.num_rows, "columns": cols, "rows": [[None if v is None else str(v) for v in row] for row in res]}


def _channel(uid: str) -> str:
    with _db() as con:
        row = con.execute("SELECT channel FROM preferences WHERE user_id = ?", (uid,)).fetchone()
    return row[0] if row else "web"


def _author_note(r: dict, subject: str, body: str) -> None:
    import notify

    ch = _channel(r["author"])
    if ch != "none":
        notify.deliver(r["author"], subject, body, link=f"/recipes?recipe={r['id']}", link_label="Open the recipe", source="recipes", web=True, email=ch == "email")


def run(rid: str, trigger: str = "schedule") -> dict:
    import notify

    r = _get(rid)
    rec: dict[str, Any] = {"id": "run-" + uuid.uuid4().hex[:10], "recipe_id": rid, "at": _iso(), "trigger": trigger, "status": "failed",
                           "delivered": [], "exceptions": [], "error": None}
    try:
        if _src(r) == "report":
            _run_report(r, rec)
            raise _Sent()
        res = evaluate(r)
        rec.update(matched=res["matched"], total=res["total"])
        active = [u for u in dict.fromkeys(r.get("recipients") or [r["author"]]) if u not in (r.get("muted") or [])]
        if r.get("when") == "condition" and res["matched"] == 0:
            rec.update(status="skipped", reason="the condition was not met")
        elif not active:
            rec.update(status="skipped", reason="every recipient muted the recipe")
        else:
            name = _source_name(r)
            subject = f"Recipe: {r['name']}"
            summary = (f"{res['matched']:,} of {res['total']:,} rows of {name} match the condition."
                       if r.get("when") == "condition" else f"{name} has {res['total']:,} rows.")
            body = "\n".join(x for x in [r.get("message") or "", summary] if x)
            table = "<table style='border-collapse:collapse;font:12px sans-serif'><tr>" + "".join(f"<th style='border:1px solid #ccc;padding:3px 6px'>{h.escape(c)}</th>" for c in res["columns"]) + "</tr>" + \
                "".join("<tr>" + "".join(f"<td style='border:1px solid #ccc;padding:3px 6px'>{h.escape(v) if v is not None else '<i>null</i>'}</td>" for v in row) + "</tr>" for row in res["rows"]) + "</table>"
            text_rows = "\n".join(" | ".join(v if v is not None else "null" for v in row) for row in res["rows"][:10])
            for uid in active:
                principal = auth.principal_of(uid) if auth.enabled() else None
                if auth.enabled() and principal is None:
                    rec["exceptions"].append({"user": uid, "reason": "the user does not exist or is deactivated"})
                    continue
                allowed = _source_access(r, principal)
                link = _link(r)
                if allowed:
                    text = f"{body}\n\n{' | '.join(res['columns'])}\n{text_rows}" if res["rows"] else body
                    html = f"<p>{h.escape(body).replace(chr(10), '<br>')}</p>{table if res['rows'] else ''}"
                else:
                    # no access to the data: a notification with a link only, no preview
                    text, html = f"{r.get('message') or ''}\nOpen the dataset to see what changed (you may need to request access).".strip(), None
                    rec["exceptions"].append({"user": uid, "reason": "no Viewer access to the monitored dataset: sent a link without the preview"})
                got = notify.deliver(uid, subject, text, link=link, link_label="Open", source="recipes",
                                     web="notification" in r.get("channels", []), email="email" in r.get("channels", []), html=html)
                if "email" in r.get("channels", []) and not got["email"]:
                    rec["exceptions"].append({"user": uid, "reason": "no email sent (no address, or email is not configured)"})
                rec["delivered"].append({"user": uid, **got, "preview": allowed})
            rec["status"] = "success_with_exceptions" if rec["exceptions"] else "success"
    except _Sent:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("recipe %s failed", rid)
        rec["error"] = str(getattr(e, "detail", e))[:800]
    with _db() as con:
        con.execute("INSERT INTO runs (id, recipe_id, at, record) VALUES (?, ?, ?, ?)", (rec["id"], rid, rec["at"], json.dumps(rec)))
    with _lock:
        r = _get(rid)
        r["last_run"] = {k: rec.get(k) for k in ("id", "at", "status")}
        r["last_seen_update"] = _stamp(r)
        _put(r)
    if rec["status"] in ("failed", "success_with_exceptions"):
        _author_note(r, f"Recipe {r['name']}: {rec['status'].replace('_', ' ')}", rec.get("error") or "; ".join(x["reason"] for x in rec["exceptions"][:5]))
    return rec


class _Sent(Exception):
    """A report recipe's run finished (its record is filled in)."""


def _run_report(r: dict, rec: dict) -> None:
    """Render the report as the author sees it and send it: an attached PDF, or an in-email image."""
    import notify
    import report_render

    active = [u for u in dict.fromkeys(r.get("recipients") or [r["author"]]) if u not in (r.get("muted") or [])]
    if not active:
        rec.update(status="skipped", reason="every recipient muted the recipe")
        return
    fmt = r.get("attachment") or "pdf"
    data = report_render.render(f"/reports/{r['item_id']}?print=1&theme=light", "pdf" if fmt == "pdf" else "png", r["author"])
    rec["attachment"] = {"format": fmt, "bytes": len(data)}
    title = _source_name(r)
    filename = f"{title}.pdf" if fmt == "pdf" else f"{title}.png"
    body = (r.get("message") or f"{title}, as of {_iso()[:16].replace('T', ' ')} UTC.").strip()
    if fmt == "pdf":
        attachments = [(filename, data, "application/pdf")]
        html = None
    else:
        attachments = [(filename, data, "image/png", "report-image")]
        html = (f"<p>{h.escape(body).replace(chr(10), '<br>')}</p><p><img src='cid:report-image' alt='{h.escape(title)}' style='max-width:100%'></p>"
                f"<p><a href='{auth.web_url()}/reports/{r['item_id']}'>Open the report</a></p>")
    for uid in active:
        if auth.enabled() and auth.principal_of(uid) is None:
            rec["exceptions"].append({"user": uid, "reason": "the user does not exist or is deactivated"})
            continue
        got = notify.deliver(uid, f"Report: {title}", body, link=_link(r), link_label="Open the report", source="recipes",
                             web="notification" in r.get("channels", []), email=True, html=html,
                             attachments=attachments)
        if not got["email"]:
            rec["exceptions"].append({"user": uid, "reason": "no email sent (no address, or email is not configured): the report goes by email"})
        rec["delivered"].append({"user": uid, **got, "preview": True})
    rec["status"] = "success_with_exceptions" if rec["exceptions"] else "success"


def _due(r: dict, now: datetime) -> bool:
    if _status(r) != "active":
        return False
    s = r["schedule"]
    last = datetime.fromisoformat(r["last_run"]["at"]) if r.get("last_run") else None
    if s["kind"] == "on_update":
        stamp = _stamp(r)
        return bool(stamp) and stamp != r.get("last_seen_update")
    if s["kind"] == "hours":
        return not last or now - last >= timedelta(hours=s["every_hours"])
    tz = ZoneInfo(s.get("timezone") or "UTC")
    local = now.astimezone(tz)
    hh, mm = (int(x) for x in (s.get("time") or "09:00").split(":"))
    slot = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if local.weekday() not in (s.get("days") or []) or local < slot:
        return False
    return not last or last < slot.astimezone(timezone.utc)


def tick() -> None:
    now = _now()
    with _db() as con:
        recs = [json.loads(x) for (x,) in con.execute("SELECT record FROM recipes").fetchall()]
    for r in recs:
        # expiry reminders to the author: 7 days and 1 day before
        left = datetime.fromisoformat(r["expires_at"]) - now
        for days in (7, 1):
            key = f"reminded_{days}"
            if timedelta(0) < left <= timedelta(days=days) and not r.get(key):
                _author_note(r, f"Recipe {r['name']} expires in {max(1, left.days)} day(s)", "Extend it from the Recipes application if it is still useful.")
                with _lock:
                    cur = _get(r["id"])
                    cur[key] = _iso()
                    _put(cur)
        if _due(r, now):
            try:
                run(r["id"])
            except Exception:  # noqa: BLE001
                log.exception("recipe %s", r["id"])


_started = {"v": False}


def start() -> None:
    if _started["v"]:
        return
    _started["v"] = True

    def loop() -> None:
        while True:
            time.sleep(60)
            try:
                tick()
            except Exception:  # noqa: BLE001
                log.exception("recipes tick failed")

    threading.Thread(target=loop, daemon=True, name="recipes").start()


# ------------------------------------------------------------------------------------------------
# API
# ------------------------------------------------------------------------------------------------


@router.get("")
def list_recipes(scope: Literal["mine", "all"] = "mine", q: str = "") -> list[dict]:
    me = (auth.current() or {}).get("id")
    with _db() as con:
        recs = [json.loads(x) for (x,) in con.execute("SELECT record FROM recipes").fetchall()]
    out = []
    for r in recs:
        if not _can_view(r):
            continue
        if scope == "mine" and me and r["author"] != me and me not in r.get("recipients", []):
            continue
        if q and q.lower() not in f"{r['name']} {r.get('message', '')}".lower():
            continue
        out.append(_public(r))
    return sorted(out, key=lambda r: r.get("created_at") or "", reverse=True)


@router.get("/columns/{item_id}")
def columns(item_id: str, source: Literal["dataset", "object_type", "time_series"] = "dataset") -> list[dict]:
    if source == "dataset":
        drive._item(item_id)
    return _schema(item_id, source)


@router.get("/sources/{source}")
def sources(source: Literal["object_type", "time_series", "report"]) -> list[dict]:
    """What a recipe can monitor besides datasets: object types, time series (sync + series), reports."""
    if source == "report":
        return [{"id": k, "name": v} for k, v in _reports().items()]
    if source == "object_type":
        import ontology

        return sorted(({"id": t["id"], "name": t["display_name"]} for t in auth.visible_resources("object_type", ontology._all("object-types"))),
                      key=lambda x: x["name"].lower())
    import timeseries

    out = []
    for sy in timeseries.all_syncs("timeseries"):
        try:
            timeseries.check_sync(sy["id"])
        except HTTPException:
            continue
        for se in timeseries.list_series(sy["id"], limit=200):
            out.append({"id": sy["id"], "series_id": se.get("series_id") or se.get("id"), "name": f"{sy.get('name') or sy['id']} · {se.get('series_id') or se.get('id')}"})
    return out


@router.post("")
def create(req: RecipeIn) -> dict:
    _validate(req)
    r = {"id": "recipe-" + uuid.uuid4().hex[:10], **req.model_dump(exclude={"expires_in_days"}), "author": _me(), "created_at": _iso(),
         "expires_at": _iso(_now() + timedelta(days=req.expires_in_days)), "paused": False, "muted": [],
         "last_seen_update": ""}
    r["last_seen_update"] = _stamp(r)
    r["recipients"] = list(dict.fromkeys(r["recipients"] or [r["author"]]))
    _put(r)
    return _public(r)


@router.get("/{rid}")
def get(rid: str) -> dict:
    r = _get(rid)
    if not _can_view(r):
        raise HTTPException(404, "no such recipe")
    return _public(r)


@router.put("/{rid}")
def update(rid: str, req: RecipeIn) -> dict:
    with _lock:
        r = _get(rid)
        _check_manage(r)
        _validate(req)
        r.update(req.model_dump(exclude={"expires_in_days"}))
        r["recipients"] = list(dict.fromkeys(r["recipients"] or [r["author"]]))
        r["updated_at"] = _iso()
        _put(r)
    return _public(r)


class StatusIn(BaseModel):
    action: Literal["mute", "unmute", "pause", "resume", "extend"]
    days: int = Field(90, ge=1, le=365)


@router.post("/{rid}/status")
def status(rid: str, req: StatusIn) -> dict:
    """Mute / unmute (for me), pause / resume for all (managers), extend (or resume an expired recipe)."""
    me = _me()
    with _lock:
        r = _get(rid)
        if not _can_view(r):
            raise HTTPException(404, "no such recipe")
        if req.action == "mute":
            r["muted"] = sorted({*r.get("muted", []), me})
        elif req.action == "unmute":
            r["muted"] = [u for u in r.get("muted", []) if u != me]
        else:
            _check_manage(r)
            if req.action == "pause":
                r["paused"] = True
            elif req.action == "resume":
                r["paused"] = False
                if r["expires_at"] <= _iso():
                    r["expires_at"] = _iso(_now() + timedelta(days=req.days))
            else:
                base = max(_now(), datetime.fromisoformat(r["expires_at"]))
                r["expires_at"] = _iso(base + timedelta(days=req.days))
                r.pop("reminded_7", None)
                r.pop("reminded_1", None)
        _put(r)
    return _public(r)


@router.post("/{rid}/run")
def run_now(rid: str) -> dict:
    r = _get(rid)
    _check_manage(r)
    return run(rid, "manual")


@router.post("/{rid}/test")
def test(rid: str) -> dict:
    """What the recipe would send now (without sending)."""
    r = _get(rid)
    if not _can_view(r):
        raise HTTPException(404, "no such recipe")
    return evaluate(r)


@router.delete("/{rid}")
def delete(rid: str) -> dict:
    r = _get(rid)
    p = auth.current()
    if auth.enabled() and p and not p.get("service") and r["author"] != p.get("id"):
        raise HTTPException(403, "you can only delete recipes you own: mute it instead")
    with _db() as con:
        con.execute("DELETE FROM recipes WHERE id = ?", (rid,))
        con.execute("DELETE FROM runs WHERE recipe_id = ?", (rid,))
    return {"deleted": rid}


class PrefIn(BaseModel):
    channel: Literal["email", "web", "none"]


@router.get("/preferences/me")
def get_pref() -> dict:
    return {"channel": _channel(_me())}


@router.put("/preferences/me")
def set_pref(req: PrefIn) -> dict:
    with _db() as con:
        con.execute("INSERT OR REPLACE INTO preferences (user_id, channel) VALUES (?, ?)", (_me(), req.channel))
    return {"channel": req.channel}


@router.get("/people/all")
def people() -> list[dict]:
    """People who can be recipients (names only)."""
    try:
        users = auth._users()
    except Exception:  # noqa: BLE001
        return []
    return sorted(({"id": u["id"], "label": u.get("display_name") or u["username"]} for u in users if not u.get("disabled")), key=lambda u: u["label"].lower())

