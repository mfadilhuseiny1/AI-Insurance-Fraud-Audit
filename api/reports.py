"""Reports [Sunset] (Analytics doc 08 "Reports"): parameterized reports of widgets on Foundry data.

A report is a Files item (content type REPORT_MIME): a title, parameters and an ordered list of widgets. Widgets read
live data through the Workshop query engine (workshop.query) when the report is opened, so a report is always up to
date ("Update data automatically"); a widget can be hidden, sized (full / half width, height) and titled with a
parameter's value as prefix.

- Widgets: text (Markdown with {{parameter}} references), table, chart (bar / line / pie of a grouped metric),
  metric, object table (Ontology objects), image, divider and page break. Data widgets take a dataset or an object type
  source, columns, filters whose values are constants or parameters ("$param:<id>"), grouping and a metric.
- Parameters: string / number / date with a default, suggested values from a dataset column or object property; one
  parameter can drive many widgets (merge multiple parameters into one).
- Co-editing: every save is a revision (the last REVISIONS_KEPT are kept beside the Drive data). A save made from an
  older revision is merged three ways (base = the revision the editor loaded, theirs = the stored one, mine = the
  save): changes to different report settings, parameters and widgets (add / remove / move / edit, field by field)
  merge; the same field changed differently, an item edited on one side and deleted on the other, or one widget moved
  to different places come back as conflicts (409) for the editor to settle per conflict (mine / theirs). Without the
  base revision the save is refused as before.
- History: the kept revisions with who / when / a summary of what each changed, a revision read-only, its diff against
  the current one (field by field, as the merge compares), and restore (the revision's content saved as a new
  revision through the normal save, so merges and conflicts apply), and a read-only preview of a whole revision (its
  widgets rendered on today's data). Revisions are kept beside the content: in S3 (reports/revisions/<id>.json) when
  the content is there, so they move with it; ones kept on local disk stay readable.
- Several API processes: a save's revision check, merge and writes run under a lock shared by every process (a
  PostgreSQL advisory lock per report; without a database a lock file with a lease), and local files are replaced
  in one step, so simultaneous saves through different processes never lose an edit or a revision.
- Sharing and export: Files roles; PDF (headless Chrome, report_render.py), PowerPoint (a slide per widget, native
  charts and tables), CSV of a widget's data, the report as Markdown, duplicate, and convert to a Notepad document
  (a snapshot of the current data).

Mounted by server.py under /api/reports.
"""

from __future__ import annotations

import contextlib
import csv
import io
import json
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/reports")
log = logging.getLogger(__name__)

REPORT_MIME = "application/vnd.bluesandai.report+json"
WIDGET_KINDS = ("text", "table", "chart", "metric", "object_table", "image", "divider", "page_break", "contour_board", "quiver_card")
# objects a Quiver object set card widget carries (the Reports export note: a table shows up to 1,000 rows; the widget
# pages through them, a PDF prints them all, the CSV has every object)
REPORT_OBJECTS = 1000


def _item(item_id: str, need: str = "viewer") -> dict:
    import drive

    item = drive._item(item_id, need=need)
    if item.get("kind") != "file" or item.get("content_type") != REPORT_MIME:
        raise HTTPException(404, "report not found")
    return item


def _load(item: dict) -> dict:
    import drive

    try:
        return json.loads(drive.read_bytes(item).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(500, "the report is not readable") from None


def _store(item: dict, rep: dict) -> None:
    import db
    import drive
    import pipeline_datasets

    data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
    if item["stored_in"] == "s3":
        pipeline_datasets._replace_content(item, data, REPORT_MIME)
        return
    # on local disk the new content replaces the old in one step, so another API process reading the report (outside
    # the save lock) never sees a half-written file
    _write_atomic(drive.LOCAL_DIR / item["id"], data)
    db.drive_update(item["id"], drive._now(), size_bytes=len(data), content_type=REPORT_MIME)


def _write_atomic(path, data: bytes) -> None:
    """Write a file through a temporary file and a rename (retried briefly: on Windows a reader holding the file open
    blocks the rename)."""
    import os
    import time

    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_bytes(data)
    try:
        for n in range(50):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if n == 49:
                    raise
                time.sleep(0.02 * (1 + n % 5))
    finally:
        tmp.unlink(missing_ok=True)


def _check(rep: dict) -> None:
    pids = [p["id"] for p in rep.get("parameters") or []]
    if len(set(pids)) != len(pids):
        raise HTTPException(400, "parameter IDs must be unique")
    for w in rep.get("widgets") or []:
        if w.get("kind") not in WIDGET_KINDS:
            raise HTTPException(400, f"unknown widget kind {w.get('kind')}")
        if w["kind"] in ("table", "chart", "metric", "object_table"):
            src = w.get("source") or {}
            if src.get("kind") not in ("dataset", "object_type") or not src.get("id"):
                raise HTTPException(400, f"{w.get('title') or w['kind']}: choose a dataset or an object type")
        for f in [*(w.get("filters") or []), *({"value": v} for v in ((w.get("contour") or {}).get("params") or {}).values())]:
            v = f.get("value")
            if isinstance(v, str) and v.startswith("$param:") and v[7:] not in pids:
                raise HTTPException(400, f"{w.get('title') or w['kind']}: unknown parameter {v[7:]}")


def _view(item: dict, rep: dict) -> dict:
    import drive

    try:
        drive._item(item["id"], need="editor")
        can_edit = True
    except HTTPException:
        can_edit = False
    return {"item": drive._with_path(item), "report": rep, "can_edit": can_edit}


# ------------------------------------------------------------------ data


def _params(rep: dict, given: dict) -> dict:
    out = {}
    for p in rep.get("parameters") or []:
        v = given.get(p["id"], p.get("default"))
        if p.get("type") == "number" and v not in (None, ""):
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{p['name']} must be a number") from None
        out[p["id"]] = v
    return out


def _fill(text: str, rep: dict, params: dict) -> str:
    names = {p["id"]: p for p in rep.get("parameters") or []}
    return re.sub(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}", lambda m: "" if params.get(m.group(1)) in (None, "") else str(params[m.group(1)])
                  if m.group(1) in names else m.group(0), text or "")


def _title(w: dict, rep: dict, params: dict) -> str:
    title = w.get("title") or ""
    pid = w.get("title_prefix_param")
    if pid and params.get(pid) not in (None, ""):
        title = f"{params[pid]} · {title}" if title else str(params[pid])
    return _fill(title, rep, params)


def widget_data(w: dict, params: dict) -> dict:
    """A data widget's rows (table, object table) or groups (chart, metric)."""
    import workshop

    filters = []
    for f in w.get("filters") or []:
        v = f.get("value")
        if isinstance(v, str) and v.startswith("$param:"):
            v = params.get(v[7:])
            if v in (None, ""):
                continue  # an empty parameter does not filter
        filters.append(workshop.Filter(column=f["column"], op=f.get("op") or "eq", value=v))
    src = w["source"]
    kind = w["kind"]
    q = workshop.Query(source=workshop.Source(kind=src["kind"], id=src["id"]), filters=filters,
                       columns=w.get("columns") or [], group_by=w.get("group_by") if kind in ("chart",) else None,
                       bucket=w.get("bucket"), metric=w.get("metric") or "count", metric_column=w.get("metric_column"),
                       sort=w.get("sort"), descending=bool(w.get("descending")),
                       limit=0 if kind == "metric" else int(w.get("limit") or (50 if kind == "chart" else 200)))
    return workshop.query(q)


def _rows_or_groups(rows: list[dict], cols: list[str]) -> dict:
    """A board's data in the shapes reports export: key / value pairs as groups, anything else as rows."""
    if cols[:2] == ["key", "value"] and len(cols) == 2:
        return {"groups": [{"key": r.get("key"), "value": r.get("value"), "count": r.get("value")} for r in rows]}
    return {"columns": [{"name": c} for c in cols], "rows": rows}


def embedded_data(w: dict, params: dict, object_rows: Optional[int] = None) -> dict:
    """A Contour board (parameters from the report's) or a Quiver table-side card (an object set card: its first
    `object_rows` objects, default REPORT_OBJECTS, and how many it holds)."""
    if w["kind"] == "contour_board":
        import contour

        cfg = w.get("contour") or {}
        if not (cfg.get("analysis_id") and cfg.get("path_id") and cfg.get("board_id")):
            raise HTTPException(400, "choose the Contour analysis, path and board")
        a = contour._load(contour._item(cfg["analysis_id"]))
        overrides = {}
        for name, v in (cfg.get("params") or {}).items():
            if isinstance(v, str) and v.startswith("$param:"):
                v = params.get(v[7:])
            if v not in (None, ""):
                overrides[name] = v
        r = contour.run_path(a, cfg["path_id"], overrides)
        res = r["boards"].get(cfg["board_id"]) or {}
        if res.get("error"):
            raise HTTPException(400, res["error"])
        board = next((b for p in a["paths"] if p["id"] == cfg["path_id"] for b in p["boards"] if b["id"] == cfg["board_id"]), None)
        out = _rows_or_groups(res.get("data") or [], res.get("data_columns") or [])
        if board and board["type"] == "calculation" and res.get("data"):
            first = next(iter(res["data"][0].values()), None)
            out = {**out, "value": first} if len(res["data"][0]) == 1 else out
        return {**out, "board": board, "result": res, "source_name": f"{a.get('title', '')} / {next((p['name'] for p in a['paths'] if p['id'] == cfg['path_id']), '')}"}
    import quiver_tables
    import ts_derived

    cfg = w.get("quiver") or {}
    if not (cfg.get("analysis_id") and cfg.get("card_id")):
        raise HTTPException(400, "choose the Quiver analysis and card")
    a = ts_derived._analysis(cfg["analysis_id"])
    card = next((c for c in a.get("object_sets") or [] if c.get("id") == cfg["card_id"]), None)
    if not card or card.get("kind") not in quiver_tables.TABLE_KINDS:
        # time series plots and cards: the browser draws them from the analysis (no rows for CSV / slides)
        if any(x.get("id") == cfg["card_id"] for x in [*(a.get("plots") or []), *((a.get("logic") or {}).get("cards") or [])]):
            return {"analysis": a, "card_id": cfg["card_id"], "client": True, "source_name": a.get("name", "")}
        raise HTTPException(400, "the Quiver card is not in the analysis")
    results = quiver_tables.run_cards(a, {card["id"], *(card.get("tables") or [])}, object_rows=object_rows or REPORT_OBJECTS)
    r = results.get(card["id"]) or {}
    if r.get("error"):
        raise HTTPException(400, r["error"])
    if card["kind"] == "value":
        out: dict = {"value": r.get("value")}
    elif card["kind"] == "chart":
        out = _rows_or_groups(r.get("data") or [], r.get("data_columns") or [])
    elif card["kind"] in quiver_tables.quiver_cards.KINDS:
        # a single card: its value (a number, string, date, array …), or the rows a chart card draws
        # (distribution bins, scatter points, waterfall steps, correlation cells); an object set card's objects
        if card["kind"] in quiver_tables.quiver_cards.OBJECT_SET_KINDS:
            out = {**_rows_or_groups(r.get("rows") or [], r.get("columns") or []), "total": r.get("total")}
        elif "data" in r:
            cols = r.get("data_columns") or list((r["data"] or [{}])[0].keys())
            out = {"columns": [{"name": c} for c in cols], "rows": r["data"] or []}
        else:
            out = {"value": r.get("value")}
    else:
        t = results.get((card.get("tables") or [None])[0]) if card["kind"] == "vega" else r
        out = _rows_or_groups((t or {}).get("rows") or [], (t or {}).get("columns") or [])
    return {**out, "card": card, "results": results, "source_name": a.get("name", "")}


def render_data(rep: dict, given: dict) -> dict:
    params = _params(rep, given)
    out = {}
    for w in rep.get("widgets") or []:
        if w.get("hidden"):
            continue
        entry: dict[str, Any] = {"title": _title(w, rep, params)}
        if w["kind"] == "text":
            entry["text"] = _fill(w.get("text") or "", rep, params)
        elif w["kind"] in ("table", "chart", "metric", "object_table"):
            try:
                entry["data"] = widget_data(w, params)
            except HTTPException as e:
                entry["error"] = str(e.detail)
        elif w["kind"] in ("contour_board", "quiver_card"):
            try:
                entry["data"] = embedded_data(w, params)
            except HTTPException as e:
                entry["error"] = str(e.detail)
        out[w["id"]] = entry
    return {"params": params, "widgets": out}


# ------------------------------------------------------------------ co-editing: revisions and the three-way merge

REVISIONS_KEPT = 50
_save_lock = threading.Lock()  # this process' saves, one at a time (then the lock shared with other API processes)
LOCK_WAIT = 30.0  # seconds a save waits for another process' save of the same report before answering 503
LOCK_LEASE = 60.0  # a lock file older than this is a crashed holder's and may be taken over (lock files only)
_ADVISORY_CLASS = 0x52505254  # "RPRT": the first key of the PostgreSQL advisory locks taken here


class _Busy(HTTPException):
    def __init__(self) -> None:
        super().__init__(503, "the report is being saved by another server process: try again in a moment")


@contextlib.contextmanager
def _report_lock(item_id: str) -> Iterator[None]:
    """Saves of one report one at a time across every API process sharing the storage: this process' lock, then a
    PostgreSQL advisory lock (every process sharing the Files tree shares its database; the lock is held by a session
    of its own, so a crashed process' lock goes with its connection), or without a database a lock file with a lease
    beside the data. The revision check, the merge, the content and the history are written under it."""
    with _save_lock:
        import db

        if db.enabled():
            with _advisory_lock(item_id):
                yield
        else:
            with _file_lock(item_id):
                yield


@contextlib.contextmanager
def _advisory_lock(item_id: str) -> Iterator[None]:
    import time

    import db
    import psycopg

    conn = psycopg.connect(db._url, autocommit=True)
    try:
        deadline = time.monotonic() + LOCK_WAIT
        wait = 0.01
        while not conn.execute("SELECT pg_try_advisory_lock(%s, hashtext(%s))", (_ADVISORY_CLASS, item_id)).fetchone()[0]:
            if time.monotonic() > deadline:
                raise _Busy()
            time.sleep(wait)
            wait = min(wait * 1.5, 0.1)
        try:
            yield
        finally:
            try:
                conn.execute("SELECT pg_advisory_unlock(%s, hashtext(%s))", (_ADVISORY_CLASS, item_id))
            except Exception:  # noqa: BLE001 - closing the session below releases it too
                log.warning("report %s: advisory unlock failed; released with the connection", item_id)
    finally:
        conn.close()


def _lock_path(item_id: str):
    import drive

    d = drive.LOCAL_DIR.parent / "reports" / "locks"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{item_id}.lock"


@contextlib.contextmanager
def _file_lock(item_id: str) -> Iterator[None]:
    """A lock file created exclusively (O_EXCL) holding a token; one older than LOCK_LEASE is taken over. Before
    anything is written the holder checks the file still holds its token (_still_held), so a holder whose lease ran
    out stops instead of writing over a newer save."""
    import os
    import time

    path = _lock_path(item_id)
    token = f"{os.getpid()}:{uuid.uuid4().hex}"
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                f.write(token)
            break
        except FileExistsError:
            try:
                stale = time.time() - path.stat().st_mtime > LOCK_LEASE
            except FileNotFoundError:
                continue
            if stale:
                # take the expired lease over: rename it away first, so only one taker wins
                try:
                    os.replace(path, path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.stale"))
                except OSError:
                    pass
                else:
                    log.warning("report %s: took over an expired save lock", item_id)
                    for p in path.parent.glob(f"{path.name}.*.stale"):
                        p.unlink(missing_ok=True)
                    continue
            if time.monotonic() > deadline:
                raise _Busy() from None
            time.sleep(0.02)
        except PermissionError:  # Windows: the file is being created or removed this instant
            if time.monotonic() > deadline:
                raise _Busy() from None
            time.sleep(0.02)
    _held[item_id] = (path, token)
    try:
        yield
    finally:
        _held.pop(item_id, None)
        try:
            if path.read_text() == token:
                path.unlink()
        except OSError:
            pass


_held: dict[str, tuple[Any, str]] = {}


def _still_held(item_id: str) -> None:
    """With a lock file: refuse to write when the lease ran out and another process took the lock over; otherwise the
    lease is renewed."""
    import os

    if item_id not in _held:
        return
    path, token = _held[item_id]
    try:
        mine = path.read_text() == token
        if mine:
            os.utime(path)
    except OSError:
        mine = False
    if not mine:
        raise _Busy()


class _Missing:
    def __repr__(self) -> str:
        return "<missing>"


MISSING: Any = _Missing()  # a key absent on one side (a field removed, or never set)


def _who() -> str:
    return (auth.current() or {}).get("username") or "local"


def _rev_path(item_id: str):
    import drive

    d = drive.LOCAL_DIR.parent / "reports" / "revisions"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{item_id}.json"


def _rev_key(item_id: str) -> str:
    return f"reports/revisions/{item_id}.json"


def _where(item_id: str) -> str:
    """Where the report's revisions live: beside its content ("s3" when the content is in S3, else "local")."""
    import db
    import storage

    try:
        item = db.drive_get(item_id)
    except Exception:
        item = None
    return "s3" if item and item.get("stored_in") == "s3" and storage.enabled() else "local"


def _read_revisions(item_id: str) -> tuple[list[dict], bool]:
    """(the kept revisions, whether they were read reliably). With the content in S3 they are read from S3; revisions
    kept on this host's disk before (or never copied) are read from there, and move to S3 with the next save."""
    if _where(item_id) == "s3":
        import storage

        try:
            return list(storage.get_json(_rev_key(item_id))), True
        except Exception as e:
            code = str(((getattr(e, "response", None) or {}).get("Error") or {}).get("Code", ""))
            if code not in ("NoSuchKey", "404", "NotFound"):
                log.warning("report %s: revisions not readable from S3 (%s); using this host's copy", item_id, e)
                return _local_revisions(item_id), False
    p = _rev_path(item_id)
    hist = _local_revisions(item_id)
    # an existing history file that could not be read is not "no revisions" (never overwrite it with one)
    return hist, bool(hist) or not p.exists() or _readable(p)


def _readable(p) -> bool:
    try:
        json.loads(p.read_text("utf-8"))
        return True
    except (OSError, ValueError):
        return False


def _local_revisions(item_id: str) -> list[dict]:
    p = _rev_path(item_id)
    for n in range(3):  # Windows: a reader can meet the history file mid-rename; try again
        try:
            return json.loads(p.read_text("utf-8")) if p.exists() else []
        except PermissionError:
            import time

            time.sleep(0.02 * (n + 1))
        except (OSError, ValueError):
            return []
    return []


def _revisions(item_id: str) -> list[dict]:
    return _read_revisions(item_id)[0]


def _record(item_id: str, rep: dict, **meta: Any) -> None:
    """Keep this revision of the report (the base of a later merge), beside the content (S3 or local disk)."""
    rev = int(rep.get("rev") or 0)
    hist, reliable = _read_revisions(item_id)
    if not reliable:
        log.warning("report %s: revision %s not kept (the history in S3 could not be read)", item_id, rev)
        return  # never overwrite the stored history with this host's partial copy
    hist = [h for h in hist if h.get("rev") != rev]
    hist.append({"rev": rev, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "by": _who(), **meta, "report": rep})
    hist.sort(key=lambda h: h["rev"])
    hist = hist[-REVISIONS_KEPT:]
    _still_held(item_id)
    if _where(item_id) == "s3":
        import storage

        storage.put_json(_rev_key(item_id), hist)
    else:
        # replaced in one step: another process listing the history never reads a half-written file
        _write_atomic(_rev_path(item_id), json.dumps(hist, ensure_ascii=False).encode("utf-8"))


def _revision(item_id: str, rev: int) -> Optional[dict]:
    return next((h["report"] for h in _revisions(item_id) if h.get("rev") == rev), None)


def _canon(v: Any) -> str:
    return "\0missing" if v is MISSING else json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)


def _same(a: Any, b: Any) -> bool:
    return _canon(a) == _canon(b)


def _lcs(a: list, b: list) -> list:
    """The longest common subsequence of two id lists (the items that kept their relative order)."""
    n, m = len(a), len(b)
    t = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            t[i][j] = t[i + 1][j + 1] + 1 if a[i] == b[j] else max(t[i + 1][j], t[i][j + 1])
    out, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            out.append(a[i])
            i, j = i + 1, j + 1
        elif t[i + 1][j] >= t[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


class _Merge:
    """base / theirs / mine → the merged report, its conflicts and the conflicts settled by `resolutions`
    ({conflict id: "mine" | "theirs"}). An unsettled conflict keeps mine's value in the (unsaved) result."""

    def __init__(self, resolutions: dict[str, str]):
        self.res = {k: v for k, v in (resolutions or {}).items() if v in ("mine", "theirs")}
        self.conflicts: list[dict] = []
        self.resolved: list[str] = []

    def pick(self, cid: str, entry: dict, mine: Any, theirs: Any) -> Any:
        choice = self.res.get(cid)
        if choice:
            self.resolved.append(cid)
            return mine if choice == "mine" else theirs
        self.conflicts.append({"id": cid, **{k: (None if v is MISSING else v) for k, v in entry.items()}})
        return mine

    def field(self, cid: str, b: Any, t: Any, m: Any, entry: dict) -> Any:
        if _same(m, b):
            return t
        if _same(t, b) or _same(m, t):
            return m
        return self.pick(cid, {**entry, "kind": "field", "base": b, "mine": m, "theirs": t}, m, t)

    def fields(self, scope: str, iid: Optional[str], label: str, b: dict, t: dict, m: dict, skip: tuple = ()) -> dict:
        out = {}
        for k in dict.fromkeys([*m, *t, *b]):
            if k in skip:
                continue
            cid = f"{scope}:{iid}:{k}" if iid else f"{scope}:{k}"
            v = self.field(cid, b.get(k, MISSING), t.get(k, MISSING), m.get(k, MISSING),
                           {"scope": scope, "item_id": iid, "field": k, "label": label})
            if v is not MISSING:
                out[k] = v
        return out

    def items(self, scope: str, bl: list, tl: list, ml: list) -> list:
        """A list of items with ids (widgets, parameters): per item add / delete / edit, then the order."""
        B, T, M = ({x["id"]: x for x in lst if isinstance(x, dict) and x.get("id")} for lst in (bl, tl, ml))
        out: dict[str, dict] = {}
        for i in dict.fromkeys([*M, *T, *B]):
            b, t, m = B.get(i), T.get(i), M.get(i)
            label = _item_label(scope, m or t or b or {})
            entry = {"scope": scope, "item_id": i, "field": None, "label": label}
            if t is not None and m is not None:
                out[i] = self.fields(scope, i, label, b or {}, t, m)
            elif b is None:
                out[i] = t if t is not None else m  # added on one side
            elif t is None and m is None:
                continue  # deleted on both sides
            elif m is None:  # I deleted it
                if not _same(t, b):
                    v = self.pick(f"{scope}:{i}:deleted", {**entry, "kind": "deleted_mine", "base": b, "mine": None, "theirs": t}, None, t)
                    if v is not None:
                        out[i] = v
            elif not _same(m, b):  # they deleted it, I edited it
                v = self.pick(f"{scope}:{i}:deleted", {**entry, "kind": "deleted_theirs", "base": b, "mine": m, "theirs": None}, m, None)
                if v is not None:
                    out[i] = v
        order = self.order(scope, [x for x in B], [x for x in T], [x for x in M], out)
        return [out[i] for i in order]

    def order(self, scope: str, bo: list, to: list, mo: list, out: dict) -> list:
        bs = set(bo)

        def moved(side: list) -> set:
            ss = set(side)
            common = [i for i in bo if i in ss]
            seq = [i for i in side if i in bs]
            keep = set(_lcs(common, seq))
            return {i for i in seq if i not in keep}

        mv_m, mv_t = moved(mo), moved(to)
        place: dict[str, str] = {}
        for i in out:
            if i in mv_m and i in mv_t:
                pm, pt = _neighbours(mo, i), _neighbours(to, i)
                if pm == pt:
                    place[i] = "mine"
                else:
                    label = _item_label(scope, out[i])
                    pos = lambda lst: lst.index(i) + 1  # noqa: E731
                    place[i] = self.pick(f"{scope}:{i}:position", {"scope": scope, "item_id": i, "field": "position", "label": label, "kind": "position",
                                                                   "base": bo.index(i) + 1, "mine": pos(mo), "theirs": pos(to)}, "mine", "theirs")
            elif i in mv_m:
                place[i] = "mine"
            elif i in mv_t:
                place[i] = "theirs"
            elif i not in bs:
                place[i] = "mine" if i in mo else "theirs"
        seq = [i for i in bo if i in out and i not in place]
        for side, lst in (("mine", mo), ("theirs", to)):
            for n, i in enumerate(lst):
                if place.get(i) != side:
                    continue
                prev = next((lst[j] for j in range(n - 1, -1, -1) if lst[j] in seq), None)
                seq.insert(seq.index(prev) + 1 if prev else 0, i)
        return seq


def _neighbours(lst: list, i: str) -> tuple:
    n = lst.index(i)
    return (lst[n - 1] if n > 0 else None, lst[n + 1] if n + 1 < len(lst) else None)


def _item_label(scope: str, x: dict) -> str:
    if scope == "parameter":
        return x.get("name") or x.get("id") or "parameter"
    t = (x.get("title") or "").strip()
    if not t and x.get("kind") == "text":
        t = next((ln.strip("# ").strip() for ln in (x.get("text") or "").splitlines() if ln.strip()), "")[:60]
    return f"{(x.get('kind') or 'widget').replace('_', ' ')}{': ' + t if t else ''}"


def merge_reports(base: dict, theirs: dict, mine: dict, resolutions: Optional[dict[str, str]] = None) -> tuple[dict, list[dict], list[str]]:
    """Three-way merge of report revisions: (merged report, unsettled conflicts, settled conflict ids)."""
    mg = _Merge(resolutions or {})
    out = mg.fields("report", None, "report", base, theirs, mine, skip=("parameters", "widgets", "rev"))
    out["parameters"] = mg.items("parameter", base.get("parameters") or [], theirs.get("parameters") or [], mine.get("parameters") or [])
    out["widgets"] = mg.items("widget", base.get("widgets") or [], theirs.get("widgets") or [], mine.get("widgets") or [])
    return out, mg.conflicts, mg.resolved


# ------------------------------------------------------------------ history: what changed between two revisions


def diff_reports(old: dict, new: dict) -> list[dict]:
    """The changes from one revision to another, field by field as the merge compares them: report settings changed,
    parameters / widgets added, removed, edited (one entry per field) or moved. Entries:
    {scope, item_id, label, kind: added | removed | changed | moved, field, before, after} (None for an absent side)."""
    out: list[dict] = []

    def val(v: Any) -> Any:
        return None if v is MISSING else v

    for k in dict.fromkeys([*old, *new]):
        if k in ("parameters", "widgets", "rev"):
            continue
        b, a = old.get(k, MISSING), new.get(k, MISSING)
        if not _same(b, a):
            out.append({"scope": "report", "item_id": None, "label": "report", "kind": "changed", "field": k, "before": val(b), "after": val(a)})
    for scope, key in (("parameter", "parameters"), ("widget", "widgets")):
        ol = [x for x in old.get(key) or [] if isinstance(x, dict) and x.get("id")]
        nl = [x for x in new.get(key) or [] if isinstance(x, dict) and x.get("id")]
        O, N = {x["id"]: x for x in ol}, {x["id"]: x for x in nl}
        for i, x in N.items():
            if i not in O:
                out.append({"scope": scope, "item_id": i, "label": _item_label(scope, x), "kind": "added", "field": None, "before": None, "after": x})
        for i, x in O.items():
            if i not in N:
                out.append({"scope": scope, "item_id": i, "label": _item_label(scope, x), "kind": "removed", "field": None, "before": x, "after": None})
        for i, x in N.items():
            if i in O and not _same(O[i], x):
                for k in dict.fromkeys([*O[i], *x]):
                    b, a = O[i].get(k, MISSING), x.get(k, MISSING)
                    if not _same(b, a):
                        out.append({"scope": scope, "item_id": i, "label": _item_label(scope, x), "kind": "changed", "field": k, "before": val(b), "after": val(a)})
        common_o = [i for i in O if i in N]
        common_n = [i for i in N if i in O]
        keep = set(_lcs(common_o, common_n))
        for i in common_n:
            if i not in keep:
                out.append({"scope": scope, "item_id": i, "label": _item_label(scope, N[i]), "kind": "moved", "field": "position",
                            "before": [x["id"] for x in ol].index(i) + 1, "after": [x["id"] for x in nl].index(i) + 1})
    return out


def summarize(changes: list[dict], limit: int = 3) -> str:
    """A short line of what changed: "title changed; added chart: Sales; edited text: Intro (text, width)"."""
    if not changes:
        return "no changes"
    parts: list[Any] = []  # text, or (scope, item id) of an edited item, in order
    edited: dict[tuple, list[str]] = {}
    moved = 0
    for ch in changes:
        if ch["scope"] == "report":
            parts.append(f"{ch['field'].replace('_', ' ')} changed")
        elif ch["kind"] in ("added", "removed"):
            parts.append(f"{ch['kind']} {ch['label']}" if ch["scope"] == "widget" else f"{ch['kind']} parameter {ch['label']}")
        elif ch["kind"] == "moved":
            moved += 1
        else:
            key = (ch["scope"], ch["item_id"])
            if key not in edited:
                edited[key] = []
                parts.append(key)
            edited[key].append(ch["label"] if ch["field"] is None else ch["field"].replace("_", " "))
    labels = {(ch["scope"], ch["item_id"]): ch["label"] for ch in changes}
    text = []
    for p in parts:
        if isinstance(p, tuple):
            what = labels[p] if p[0] == "widget" else f"parameter {labels[p]}"
            text.append(f"edited {what} ({', '.join(edited[p])})")
        else:
            text.append(p)
    if moved:
        text.append(f"moved {moved} item{'s' if moved != 1 else ''}")
    more = len(text) - limit
    return "; ".join(text[:limit]) + (f"; and {more} more" if more > 0 else "")


# ------------------------------------------------------------------ routes


class NewIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    parent_id: Optional[str] = None


@router.get("")
def list_reports() -> list[dict]:
    import db
    import drive

    drive._require_db()
    items = db.drive_query("kind = 'file' AND content_type = %s AND trashed_at IS NULL", (REPORT_MIME,), order="updated_at DESC", limit=500)
    return [drive._with_path(i) for i in auth.visible(items)]


def _create(title: str, parent_id: Optional[str], rep: dict) -> dict:
    import drive

    _check(rep)
    name = drive._clean_name(title.strip())[:240] + ".report"
    item = drive.save_bytes(drive._folder_id(parent_id) if parent_id else drive.default_folder("documents"), name,
                            json.dumps(rep, ensure_ascii=False).encode("utf-8"), REPORT_MIME)
    _record(item["id"], rep)
    return _view(drive._item(item["id"]), rep)


@router.post("")
def create_report(req: NewIn) -> dict:
    rep = {"title": req.title.strip(), "description": "", "parameters": [],
           "widgets": [{"id": uuid.uuid4().hex[:8], "kind": "text", "title": "", "text": f"# {req.title.strip()}\n\nWrite the report's introduction here.", "width": "full"}]}
    return _create(req.title, req.parent_id, rep)


@router.get("/{item_id}")
def get_report(item_id: str) -> dict:
    item = _item(item_id)
    rep = _load(item)
    if _revision(item_id, int(rep.get("rev") or 0)) is None:
        try:
            with _report_lock(item_id):
                now = _load(_item(item_id))  # checked again under the lock: another process may have saved meanwhile
                if _revision(item_id, int(now.get("rev") or 0)) is None:
                    _record(item_id, now)  # a report saved before revisions were kept: this one becomes a merge base
        except _Busy:
            pass  # another process is saving it: that save keeps the revision
    return _view(item, rep)


@router.get("/{item_id}/revisions")
def revisions(item_id: str) -> list[dict]:
    """The kept revisions, newest first (who saved, when, whether the save was merged or restored an earlier revision,
    and a short summary of what it changed from the revision before)."""
    _item(item_id)
    hist = _revisions(item_id)
    out = []
    for n, h in enumerate(hist):
        prev = hist[n - 1] if n else None
        if prev is not None:
            changes = diff_reports(prev.get("report") or {}, h.get("report") or {})
            summary = summarize(changes)
        else:
            changes = []
            summary = "created" if not h.get("rev") else "the earliest revision kept"
        out.append({**{k: v for k, v in h.items() if k != "report"}, "summary": summary, "changes": len(changes),
                    "prev_rev": prev.get("rev") if prev else None})
    return out[::-1]


@router.get("/{item_id}/revisions/{rev}")
def revision(item_id: str, rev: int) -> dict:
    _item(item_id)
    rep = _revision(item_id, rev)
    if rep is None:
        raise HTTPException(404, "that revision is not kept")
    return rep


@router.get("/{item_id}/revisions/{rev}/diff")
def revision_diff(item_id: str, rev: int, against: Optional[int] = None) -> dict:
    """What changed from revision `rev` to `against` (default: the current revision), field by field."""
    item = _item(item_id)
    old = _revision(item_id, rev)
    if old is None:
        raise HTTPException(404, "that revision is not kept")
    if against is None:
        new = _load(item)
        against = int(new.get("rev") or 0)
    else:
        new = _revision(item_id, against)
        if new is None:
            raise HTTPException(404, f"revision {against} is not kept")
    changes = diff_reports(old, new)
    return {"from_rev": rev, "to_rev": against, "changes": changes, "summary": summarize(changes)}


class DataIn(BaseModel):
    params: dict[str, Any] = {}


@router.post("/{item_id}/revisions/{rev}/data")
def revision_data(item_id: str, rev: int, req: DataIn) -> dict:
    """A read-only preview of a kept revision: its widgets rendered as that revision laid them out (its parameters,
    filters, titles, text) on today's data, with the revision's who / when."""
    _item(item_id)
    h = next((x for x in _revisions(item_id) if x.get("rev") == rev), None)
    if h is None:
        raise HTTPException(404, "that revision is not kept")
    return {**render_data(h["report"], req.params), "revision": {k: v for k, v in h.items() if k != "report"}}


class RestoreIn(BaseModel):
    # the revision the restoring editor had loaded (default: the current one); saves made since are merged as usual
    base_rev: Optional[int] = None
    # settling the conflicts of that merge, as in a save
    resolutions: dict[str, str] = {}
    resolve_rev: Optional[int] = None


@router.post("/{item_id}/revisions/{rev}/restore")
def restore_revision(item_id: str, rev: int, req: RestoreIn) -> dict:
    """Restore an earlier revision: its content saved as a new revision through the normal save (merged with saves
    made since base_rev, conflicts as a 409), so the history in between is kept."""
    item = _item(item_id, "editor")
    old = _revision(item_id, rev)
    if old is None:
        raise HTTPException(404, "that revision is not kept")
    base = req.base_rev if req.base_rev is not None else int(_load(item).get("rev") or 0)
    return save_report(item_id, SaveIn(report={**json.loads(json.dumps(old)), "rev": base}, restored_from=rev,
                                       resolutions=req.resolutions, resolve_rev=req.resolve_rev))


class SaveIn(BaseModel):
    report: dict
    # settling the conflicts of a merge: {conflict id: "mine" | "theirs"}, valid for the stored revision resolve_rev
    resolutions: dict[str, str] = {}
    resolve_rev: Optional[int] = None
    # the save restores this earlier revision (recorded in the history)
    restored_from: Optional[int] = None


@router.put("/{item_id}")
def save_report(item_id: str, req: SaveIn) -> dict:
    """Every save is a revision. A save from an older revision is merged with the saves made since (three-way, from
    the kept base revision); conflicts come back as 409 {conflicts} until settled. Without the base: refused."""
    item = _item(item_id, "editor")
    rep = req.report
    rep.setdefault("parameters", [])
    rep.setdefault("widgets", [])
    for w in rep["widgets"]:
        if isinstance(w, dict):
            w.setdefault("id", uuid.uuid4().hex[:8])
    with _report_lock(item_id):
        # the stored revision is read under the lock every API process takes, so check-merge-write is atomic
        fresh = _item(item_id, "editor")
        old = _load(fresh)
        cur = int(old.get("rev") or 0)
        merge = None
        if "rev" in rep and int(rep.get("rev") or 0) != cur:
            base_rev = int(rep.get("rev") or 0)
            base = _revision(item_id, base_rev) if base_rev < cur else None
            if base is None:
                raise HTTPException(409, "the report was saved by someone else since you opened it: reload to see their version")
            since = [h for h in _revisions(item_id) if base_rev < h["rev"] <= cur]
            merged, conflicts, resolved = merge_reports(base, old, rep, req.resolutions if req.resolve_rev == cur else {})
            if conflicts:
                raise HTTPException(409, {
                    "message": f"{len(conflicts)} change{'s' if len(conflicts) != 1 else ''} conflict with saves made since you opened the report: choose which to keep",
                    "conflicts": conflicts, "base_rev": base_rev, "theirs_rev": cur,
                    "theirs_by": sorted({h.get("by") or "" for h in since} - {""}), "resolved": resolved})
            rep = merged
            merge = {"base_rev": base_rev, "theirs_rev": cur, "resolved": resolved}
        if _revision(item_id, cur) is None:
            _record(item_id, old)  # the revision being replaced stays available as a base
        rep["rev"] = cur + 1
        _check(rep)
        _still_held(item_id)
        _store(fresh, rep)
        meta: dict[str, Any] = {"merged": merge} if merge else {}
        if req.restored_from is not None:
            meta["restored_from"] = int(req.restored_from)
        _record(item_id, rep, **meta)
    view = _view(_item(item_id), rep)
    if merge:
        view["merge"] = merge
    if req.restored_from is not None:
        view["restored_from"] = int(req.restored_from)
    return view


@router.post("/{item_id}/data")
def report_data(item_id: str, req: DataIn) -> dict:
    """Every visible widget's content for these parameter values (live data)."""
    item = _item(item_id)
    return render_data(_load(item), req.params)


@router.get("/{item_id}/parameters/{param_id}/suggestions")
def suggestions(item_id: str, param_id: str, q: str = "") -> list[Any]:
    """Suggested values of a parameter: the distinct values of its dataset column or object property."""
    import workshop

    rep = _load(_item(item_id))
    p = next((x for x in rep.get("parameters") or [] if x["id"] == param_id), None)
    if not p:
        raise HTTPException(404, "parameter not found")
    if p.get("values"):
        vals = list(p["values"])
    elif (p.get("suggest") or {}).get("source"):
        s = p["suggest"]
        res = workshop.query(workshop.Query(source=workshop.Source(kind=s["source"]["kind"], id=s["source"]["id"]), group_by=s["column"], limit=1000))
        vals = [g["key"] for g in res.get("groups") or [] if g.get("key") is not None]
    else:
        vals = []
    needle = q.lower()
    return [v for v in vals if not needle or needle in str(v).lower()][:200]


@router.post("/{item_id}/duplicate")
def duplicate(item_id: str) -> dict:
    item = _item(item_id)
    rep = _load(item)
    rep["title"] = f"{rep.get('title') or 'Report'} (copy)"
    return _create(rep["title"], item.get("parent_id"), rep)


CSV_POINTS = 20_000


def _series_rows(a: dict, card_id: str) -> dict:
    """A Quiver time series plot or card as rows (time, then a column per series) for CSV: evaluated on the server for
    the analysis' root object and time range, every point up to CSV_POINTS per series."""
    import time as _time

    import ts_engine as E
    import ts_ontology

    logic = a.get("logic") or {"cards": []}
    plot = next((p for p in a.get("plots") or [] if p.get("id") == card_id), None)
    cards = [c for c in (plot.get("cards") if plot else [card_id]) or [] if any(x.get("id") == c for x in logic.get("cards") or [])]
    if not cards:
        raise HTTPException(400, "the plot shows no cards")
    rng = a.get("range") or {}
    if rng.get("last"):
        end = int(_time.time() * 1000)
        start, end = end - E.duration_ms(rng["last"]), end
    else:
        start, end = E.to_ms(rng.get("start")), E.to_ms(rng.get("end"))
    try:
        res = E.run(logic, ts_ontology.Resolver(), a.get("root"), start, end, {}, cards, buckets=CSV_POINTS)
    except E.EngineError as e:
        raise HTTPException(400, str(e)) from None
    title = {c["id"]: (c.get("title") or c.get("label") or c["id"]) for c in logic.get("cards") or []}
    columns, by_t, scalars = ["timestamp"], {}, {}
    for cid in cards:
        r = (res.get("cards") or {}).get(cid) or {}
        name = title.get(cid, cid)
        if r.get("kind") == "series":
            columns.append(name)
            for pt in r.get("points") or []:
                by_t.setdefault(pt["t"], {})[name] = pt.get("value")
        elif r.get("kind") == "error":
            raise HTTPException(400, f"{name}: {r.get('error')}")
        elif "value" in r:
            scalars[name] = r["value"]
    if len(columns) == 1:
        return {"columns": list(scalars), "rows": [scalars]} if scalars else {"columns": [], "rows": []}
    return {"columns": columns, "rows": [{"timestamp": t, **vals} for t, vals in sorted(by_t.items())]}


@router.get("/{item_id}/widgets/{widget_id}/csv")
def widget_csv(item_id: str, widget_id: str, params: str = "{}") -> Response:
    """Export a board's (widget's) data to CSV."""
    rep = _load(_item(item_id))
    w = next((x for x in rep.get("widgets") or [] if x["id"] == widget_id), None)
    if not w or w["kind"] not in ("table", "chart", "metric", "object_table", "contour_board", "quiver_card"):
        raise HTTPException(404, "data widget not found")
    ps = _params(rep, json.loads(params or "{}"))
    # a Quiver object set card: every object (up to a transform table's 50,000), not the 1,000 the widget shows
    data = embedded_data(w, ps, object_rows=50_000) if w["kind"] in ("contour_board", "quiver_card") else widget_data(w, ps)
    if data.get("client"):
        # a Quiver time series plot or card (drawn in the browser): its series computed here
        data = _series_rows(data["analysis"], data["card_id"])
    buf = io.StringIO()
    out = csv.writer(buf)
    if _shape(w, data) == "groups":
        out.writerow([w.get("group_by") or "group", w.get("metric") or "count"])
        for g in data["groups"]:
            out.writerow([_fmt(g.get("key")), _fmt(g.get("value"))])
    elif _shape(w, data) == "rows":
        cols = [c["name"] if isinstance(c, dict) else c for c in data.get("columns") or []]
        out.writerow(cols)
        for r in data["rows"]:
            # arrays / structs as JSON in CSV (machine-readable; an element may hold a comma)
            out.writerow([json.dumps(r.get(c), ensure_ascii=False, default=str) if isinstance(r.get(c), (list, dict)) else _fmt(r.get(c)) for c in cols])
    else:
        out.writerow(["value"])
        v = data.get("value")
        out.writerow([json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (list, dict)) else v])
    name = re.sub(r"[^A-Za-z0-9 _-]", "_", w.get("title") or w["kind"]) or "widget"
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


def _fmt(v: Any) -> str:
    """A value as text: whole floats without ".0", None as empty."""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return str(int(v))
    if isinstance(v, (list, dict)):
        import quiver_tables

        return quiver_tables.display_text(v)  # an array as "a, b", a struct as "field: value" (as on screen)
    return str(v)


def _shape(w: dict, payload: dict) -> str:
    """How a data widget's result reads: groups (chart), a value (metric) or rows (tables)."""
    if w["kind"] == "metric" or ("value" in payload and "groups" not in payload and not payload.get("rows")):
        return "value"
    if "groups" in payload:
        return "groups"
    return "rows" if "rows" in payload else "none"


def _cut_note(payload: dict, shown: int) -> str:
    """"First N of M objects / rows" when an export shows fewer rows than the widget's data holds (an object set
    card's total, a table's total), else ""."""
    import quiver_cards

    total = payload.get("total")
    held = len(payload.get("rows") or [])
    total = total if isinstance(total, (int, float)) and not isinstance(total, bool) and total > held else held
    if total <= shown:
        return ""
    if (payload.get("card") or {}).get("kind") in quiver_cards.OBJECT_SET_KINDS:
        return f"First {shown:,} of {int(total):,} objects (the widget's CSV export has every object)."
    return f"First {shown:,} of {int(total):,} rows."


def _markdown(rep: dict, data: dict) -> str:
    lines = [f"# {rep.get('title') or 'Report'}", ""]
    for w in rep.get("widgets") or []:
        d = data["widgets"].get(w["id"])
        if not d:
            continue
        if w["kind"] == "text":
            lines += [d.get("text") or "", ""]
            continue
        if d.get("title"):
            lines += [f"## {d['title']}", ""]
        payload = d.get("data") or {}
        if _shape(w, payload) == "groups":
            lines += [f"| {w.get('group_by') or 'group'} | {w.get('metric') or 'count'} |", "| --- | --- |"]
            lines += [f"| {_fmt(g.get('key'))} | {_fmt(g.get('value'))} |" for g in payload["groups"]]
        elif _shape(w, payload) == "rows":
            cols = [c["name"] if isinstance(c, dict) else c for c in payload.get("columns") or []]
            lines += ["| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
            rows = payload["rows"][:REPORT_OBJECTS]
            lines += ["| " + " | ".join(_fmt(r.get(c)).replace("|", "\\|").replace("\n", " ") for c in cols) + " |" for r in rows]
            note = _cut_note(payload, len(rows))
            if note:
                lines += ["", f"_{note}_"]
        elif _shape(w, payload) == "value":
            lines.append(f"**{_fmt(payload.get('value'))}**")
        lines.append("")
    return "\n".join(lines)


@router.post("/{item_id}/markdown")
def as_markdown(item_id: str, req: DataIn) -> dict:
    """The report's text (and its data as tables) as Markdown, for copying."""
    rep = _load(_item(item_id))
    return {"markdown": _markdown(rep, render_data(rep, req.params))}


@router.post("/{item_id}/pptx")
def as_pptx(item_id: str, req: DataIn) -> Response:
    """PowerPoint: a title slide, then a slide per widget (text, native table or chart, metric)."""
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches, Pt

    rep = _load(_item(item_id))
    data = render_data(rep, req.params)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = rep.get("title") or "Report"
    s.placeholders[1].text = ", ".join(f"{p['name']}: {data['params'].get(p['id'])}" for p in rep.get("parameters") or [] if data["params"].get(p["id"]) not in (None, ""))
    for w in rep.get("widgets") or []:
        d = data["widgets"].get(w["id"])
        if not d or w["kind"] in ("divider", "page_break", "image"):
            continue
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = d.get("title") or (w["kind"].replace("_", " ").title())
        box = (Inches(0.6), Inches(1.5), Inches(12.1), Inches(5.5))
        payload = d.get("data") or {}
        if payload.get("client"):
            # a Quiver time series plot or card: a native line chart of its series (thinned for the slide)
            try:
                payload = _series_rows(payload["analysis"], payload["card_id"])
            except HTTPException as e:
                payload = {}
                d = {**d, "error": str(e.detail)}
            series = [c for c in payload.get("columns") or [] if c != "timestamp"]
            if series and (payload.get("columns") or [None])[0] == "timestamp" and payload.get("rows"):
                rows = payload["rows"][:: max(1, len(payload["rows"]) // 300)]
                cd = CategoryChartData()
                cd.categories = [str(r["timestamp"])[:16].replace("T", " ") for r in rows]
                for name in series:
                    cd.add_series(name, [None if r.get(name) is None else float(r[name]) for r in rows])
                slide.shapes.add_chart(XL_CHART_TYPE.LINE, *box, cd)
                continue
        if w["kind"] == "text":
            tf = slide.shapes.add_textbox(*box).text_frame
            tf.word_wrap = True
            tf.text = re.sub(r"[#*_`>]", "", d.get("text") or "")[:3000]
        elif _shape(w, payload) == "groups":
            cd = CategoryChartData()
            cd.categories = [str(g.get("key")) for g in payload["groups"]]
            cd.add_series(w.get("metric") or "count", [float(g.get("value") or 0) for g in payload["groups"]])
            kind = {"line": XL_CHART_TYPE.LINE, "pie": XL_CHART_TYPE.PIE}.get(w.get("chart") or "bar", XL_CHART_TYPE.COLUMN_CLUSTERED)
            slide.shapes.add_chart(kind, *box, cd)
        elif _shape(w, payload) == "rows":
            cols = [c["name"] if isinstance(c, dict) else c for c in payload.get("columns") or []][:10]
            rows = payload["rows"][:15]
            if cols:
                tbl = slide.shapes.add_table(len(rows) + 1, len(cols), *box).table
                for j, c in enumerate(cols):
                    tbl.cell(0, j).text = str(c)
                for i, r in enumerate(rows, start=1):
                    for j, c in enumerate(cols):
                        tbl.cell(i, j).text = _fmt(r.get(c))
                        if tbl.cell(i, j).text:
                            tbl.cell(i, j).text_frame.paragraphs[0].runs[0].font.size = Pt(11)
            note = _cut_note(payload, len(rows))
            if note:
                # a slide holds the first rows: say how many there are (below the table's area)
                tf = slide.shapes.add_textbox(Inches(0.6), Inches(7.05), Inches(12.1), Inches(0.35)).text_frame
                tf.text = note
                tf.paragraphs[0].runs[0].font.size = Pt(11)
        elif _shape(w, payload) == "value":
            tf = slide.shapes.add_textbox(*box).text_frame
            tf.text = _fmt(payload.get("value"))
            tf.paragraphs[0].runs[0].font.size = Pt(60)
        elif d.get("error"):
            slide.shapes.add_textbox(*box).text_frame.text = f"Error: {d['error']}"
    buf = io.BytesIO()
    prs.save(buf)
    name = re.sub(r"[^A-Za-z0-9 _-]", "_", rep.get("title") or "report")
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    headers={"Content-Disposition": f'attachment; filename="{name}.pptx"'})


@router.get("/{item_id}/pdf")
def as_pdf(item_id: str) -> Response:
    """PDF: the report page printed by headless Chrome as the requesting user (report_render.py)."""
    import report_render

    item = _item(item_id)
    me = auth.current() or {}
    try:
        pdf = report_render.render(f"/reports/{item_id}?print=1", "pdf", me.get("id"))
    except report_render.RenderError as e:
        raise HTTPException(503, str(e)) from None
    name = re.sub(r"[^A-Za-z0-9 _-]", "_", item["name"].removesuffix(".report"))
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})


# report filter operators → Contour filter board operators
_CONTOUR_OPS = {"eq": "eq", "neq": "neq", "gt": "gt", "gte": "gte", "lt": "lt", "lte": "lte", "contains": "contains", "in": "in",
                "is_null": "is_null", "not_null": "not_null"}


def to_contour(rep: dict) -> dict:
    """A Contour analysis doing what the report does: its parameters, a path per data widget (the widget's filters as a
    filter board, then a table, chart or calculation board) and a dashboard with the boards and the text in order."""
    names: dict[str, str] = {}
    params = []
    for prm in rep.get("parameters") or []:
        name = re.sub(r"\W", "_", prm["id"]) or "p"
        name = f"p_{name}" if name[0].isdigit() else name
        names[prm["id"]] = name
        params.append({"name": name, "type": "number" if prm.get("type") == "number" else "string", "default": prm.get("default"),
                       "label": prm.get("name") or prm["id"]})
    paths, items = [], []

    def value(v: Any) -> Any:
        if isinstance(v, str) and v.startswith("$param:"):
            return "$" + names.get(v[7:], v[7:])
        return v

    for w in rep.get("widgets") or []:
        if w.get("hidden"):
            continue
        width = "half" if w.get("width") == "half" else "full"
        title = w.get("title") or ""
        if w["kind"] == "text":
            text = re.sub(r"\{\{\s*([\w-]+)\s*\}\}", lambda m: "$" + names.get(m.group(1), m.group(1)), w.get("text") or "")
            items.append({"kind": "text", "text": (f"### {title}\n\n" if title else "") + text, "width": width})
            continue
        if w["kind"] == "image" and w.get("src"):
            items.append({"kind": "text", "text": f"![{title}]({w['src']})", "width": width})
            continue
        if w["kind"] in ("contour_board", "quiver_card"):
            items.append({"kind": "text", "text": f"{title or w['kind']}: embedded from another analysis — open it there", "width": width})
            continue
        if w["kind"] not in ("table", "chart", "metric", "object_table") or not w.get("source"):
            continue
        boards = []
        conds = [{"column": f["column"], "op": _CONTOUR_OPS.get(f.get("op") or "eq", "eq"),
                  "values": value(f.get("value")) if isinstance(f.get("value"), list) else [value(f.get("value"))]} for f in w.get("filters") or []]
        if conds:
            boards.append({"id": uuid.uuid4().hex[:8], "type": "filter", "config": {"conditions": conds}})
        metric, col = w.get("metric") or "count", w.get("metric_column")
        if w["kind"] in ("table", "object_table"):
            cfg: dict = {"columns": w.get("columns") or []}
            if w.get("sort"):
                cfg.update(sort=w["sort"], descending=bool(w.get("descending")))
            vis = {"type": "table", "config": cfg}
        elif w["kind"] == "chart":
            vis = {"type": "chart", "config": {"kind": w.get("chart") or "bar", "x": w.get("group_by") or "", "metric": metric, "metric_column": col,
                                               "bucket": w.get("bucket"), "limit": int(w.get("limit") or 50)}}
        else:
            agg = "COUNT(*)" if metric == "count" else f'COUNT(DISTINCT "{col}")' if metric == "distinct" else f'{metric.upper()}("{col}")'
            vis = {"type": "calculation", "config": {"metrics": [{"name": title or metric, "expr": agg}]}}
        vis = {"id": uuid.uuid4().hex[:8], "title": title, **vis}
        boards.append(vis)
        pid = uuid.uuid4().hex[:8]
        paths.append({"id": pid, "name": (title or f"{w['kind']} {len(paths) + 1}")[:120], "source": {"kind": w["source"]["kind"], "id": w["source"]["id"]}, "boards": boards})
        items.append({"kind": "board", "path": pid, "board": vis["id"], "width": width})
    return {"title": rep.get("title") or "Report", "parameters": params, "paths": paths,
            "dashboard": {"tabs": [{"id": "tab1", "name": "Dashboard", "items": items}]}, "saved": {}}


class ConvertIn(BaseModel):
    parent_id: Optional[str] = None


@router.post("/{item_id}/convert-contour")
def convert_contour(item_id: str, req: ConvertIn) -> dict:
    """Convert to a Contour analysis (next to the report unless a folder is given)."""
    import contour

    item = _item(item_id)
    a = to_contour(_load(item))
    if not a["paths"]:
        raise HTTPException(400, "the report has no table, chart, metric or object table widget to convert")
    view = contour.create_analysis(contour.NewIn(title=f"{a['title']} (Contour)", parent_id=req.parent_id or item.get("parent_id")))
    return contour.save_analysis(view["item"]["id"], contour.SaveIn(analysis=a))


@router.post("/{item_id}/convert-notepad")
def convert_notepad(item_id: str, req: DataIn) -> dict:
    """Convert to a Notepad document (Reports' successor): text, headings and the current data as tables."""
    import notepad

    item = _item(item_id)
    rep = _load(item)
    data = render_data(rep, req.params)
    blocks: list[dict] = [{"id": uuid.uuid4().hex[:10], "type": "heading", "level": 1, "text": rep.get("title") or "Report"}]
    for w in rep.get("widgets") or []:
        d = data["widgets"].get(w["id"])
        if not d:
            continue
        if w["kind"] == "page_break":
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "page_break"})
            continue
        if w["kind"] == "divider":
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "rule"})
            continue
        if d.get("title"):
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "heading", "level": 2, "text": d["title"][:4000]})
        payload = d.get("data") or {}
        if w["kind"] == "text":
            for para in [p for p in (d.get("text") or "").split("\n\n") if p.strip()]:
                blocks.append({"id": uuid.uuid4().hex[:10], "type": "paragraph", "text": para[:20000]})
        elif _shape(w, payload) == "groups":
            rows = [[w.get("group_by") or "group", w.get("metric") or "count"]] + [[_fmt(g.get("key")), _fmt(g.get("value"))] for g in payload["groups"][:49]]
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "table", "rows": rows})
        elif _shape(w, payload) == "rows":
            cols = [c["name"] if isinstance(c, dict) else c for c in payload.get("columns") or []][:12]
            rows = [cols] + [[_fmt(r.get(c)) for c in cols] for r in payload["rows"][:49]]
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "table", "rows": rows})
        elif _shape(w, payload) == "value":
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "paragraph", "text": f"**{_fmt(payload.get('value'))}**"})
    doc = notepad.NotepadDocument.model_validate({"schema_version": 1, "blocks": blocks})
    res = notepad.create_document(notepad.CreateDocumentRequest(name=rep.get("title") or "Report", parent_id=item.get("parent_id"), document=doc))
    return {"notepad_id": res["item"]["id"]}
