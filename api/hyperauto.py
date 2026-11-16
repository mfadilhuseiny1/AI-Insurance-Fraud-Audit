"""HyperAuto: software-defined data integration — from a source to cleaned, joined, keyed datasets
(and optionally ontology object types) in one step, as Palantir HyperAuto V2.

A HyperAuto pipeline is created from
  a database connection   (metadata from the catalog: column comments, primary keys, foreign keys)
  or a folder             of Parquet datasets in Files (static extracts: keys are inferred from names)
and a list of input tables, each an *object* table (valuable on its own) or an *enrichment* table
(a lookup / text table that extends object tables).

Generation:
  1. syncs: every table without a data source gets one (an existing one is reused); generation
     waits for their first run
  2. a Pipeline Builder pipeline (a .pipeline file next to its outputs), per object table:
       data cleaning           "" → null in every string column; Decimal → Double
       deduplicate rows        the latest row per primary key (by an ordering column when one is
                               known, e.g. updated_at)
       generate primary keys   a composite key concatenated with "_|_" as `primary_key`
       automatic joins         enrichment tables left-joined onto the object tables they reference
                               (language-filtered and one row per key, so rows never multiply)
       generate foreign keys   per relationship to another object table with a composite key:
                               `col1_col2_|_foreign_key_<table>`
       human-readable columns  `Description_|_original` from column comments
       human-readable names    output datasets named "Description (table)" from table comments
       incremental             incremental syncs and inputs; outputs merge by primary key
                               (Snapshot replace)
     and a dataset output per object table — plus an object type per table and link types for the
     relationships when the ontology option is on
  3. edits go through proposals: changing the configuration regenerates the pipeline on a branch
     with an open proposal; merging it in Pipeline Builder (then deploying) applies it.
Deleting a HyperAuto pipeline releases the pipeline (it can then be edited directly); its syncs and
outputs stay.

Generation runs in a background thread as the user who started it (create, proposal, retry; run_as.py), never as
the system with sign-in on: it reads the connection or folder, creates and runs syncs (they record that user as their
owner, datasources.py) and writes the pipeline with that user's markings and Project roles. What it needs is checked
before anything is written (the request is refused with the reason, 403; a retry that lost access fails with
"did not run: ..."): the connection's markings, Editor on the folder the pipeline goes to (or the pipeline, for a
proposal), Editor where new syncs are created, and for each reused sync reading its dataset (or running it when it
never ran). An existing sync the user cannot use is not picked automatically: a new one is created instead.

Mounted by server.py under /api/hyperauto.
"""

from __future__ import annotations

import io
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import auth
import datasources as ds
import db
import drive
import pipeline_datasets
import run_as
from connectors import ConnectorError

log = logging.getLogger("bluesandai.hyperauto")
router = APIRouter(prefix="/api/hyperauto")

SEP = "_|_"
PREVIEW_ROWS = 5000
SYNC_WAIT_S = 1800
ORDERING_NAME = re.compile(r"(updated|modified|changed|last_?upd|upd_?ts|lastmod|timestamp|_ts$|^ts$|version|seq)", re.I)
LANGUAGE_NAME = re.compile(r"^(lang|language|language_code|locale|spras|langu)$", re.I)

SCHEMA = """
CREATE TABLE IF NOT EXISTS hyperauto_pipelines (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    source        jsonb NOT NULL,
    config        jsonb NOT NULL,
    pending       jsonb,
    folder_id     text,
    pipeline_id   text,
    status        text NOT NULL,
    progress      jsonb NOT NULL DEFAULT '[]',
    summary       jsonb NOT NULL DEFAULT '{}',
    error         text,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL
);
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def startup() -> None:
    if not db.enabled():
        return
    with db._connect() as conn:
        conn.execute(SCHEMA)
    ds._exec("UPDATE hyperauto_pipelines SET status = 'failed', error = 'Interrupted by a server restart' WHERE status = 'generating'")


# --------------------------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------------------------


class Source(BaseModel):
    kind: Literal["connection", "folder"]
    connection_id: Optional[str] = None
    database: str = ""
    schema_: str = Field("", alias="schema")
    folder_id: Optional[str] = None

    model_config = {"populate_by_name": True}


class TableIn(BaseModel):
    name: str
    role: Literal["object", "enrichment"] = "object"
    # an existing data source to read (connection pipelines); None: reuse the latest or create one
    sync_id: Optional[str] = None
    # the column that tells the latest row of a key (deduplication); None: guessed
    ordering: Optional[str] = None


class Options(BaseModel):
    automatic_joins: bool = True
    readable_columns: bool = True
    readable_names: bool = True
    primary_keys: bool = True
    foreign_keys: bool = True
    deduplicate: bool = True
    cleaning: bool = True
    incremental: bool = False
    ontology: bool = False
    # language filtering of enrichment tables (e.g. a text table with one row per language)
    language_column: Optional[str] = None
    language_value: Optional[str] = None


class Config(BaseModel):
    tables: list[TableIn] = Field(min_length=1, max_length=200)
    options: Options = Options()


class NewHyperAuto(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source: Source
    config: Config
    # where the HyperAuto pipeline and its outputs are created (default: My Project / Datapipeline)
    parent_id: Optional[str] = None


def _row(hid: str) -> dict:
    rows = ds._rows("SELECT * FROM hyperauto_pipelines WHERE id = %s", (hid,))
    if not rows:
        raise HTTPException(404, "HyperAuto pipeline not found")
    return rows[0]


def _proposal_state(row: dict) -> Optional[dict]:
    """The open (or just merged / closed) proposal of a pending configuration change."""
    pending = row.get("pending")
    if not pending or not row.get("pipeline_id"):
        return None
    try:
        content = json.loads(drive.read_bytes(drive._item(row["pipeline_id"])))
    except Exception:  # noqa: BLE001
        return None
    prop = next((p for p in (content.get("vc") or {}).get("proposals", []) if p["id"] == pending.get("proposal_id")), None)
    return {"id": pending.get("proposal_id"), "branch": pending.get("branch"), "status": prop["status"] if prop else "missing"}


def _settle(row: dict) -> dict:
    """A merged proposal makes the pending configuration the current one; a closed one drops it."""
    state = _proposal_state(row)
    if state and state["status"] in ("merged", "closed", "missing"):
        if state["status"] == "merged":
            ds._exec("UPDATE hyperauto_pipelines SET config = %s, pending = NULL, summary = %s, updated_at = %s WHERE id = %s",
                     (Jsonb(row["pending"]["config"]), Jsonb(row["pending"].get("summary") or row["summary"]), _now(), row["id"]))
        else:
            ds._exec("UPDATE hyperauto_pipelines SET pending = NULL, updated_at = %s WHERE id = %s", (_now(), row["id"]))
        row = _row(row["id"])
    return row


def _public(row: dict) -> dict:
    row = _settle(row)
    pipeline = db.drive_get(row["pipeline_id"]) if row.get("pipeline_id") else None
    src = row["source"]
    if src["kind"] == "connection":
        conn = ds._rows("SELECT name, kind FROM db_connections WHERE id = %s", (src.get("connection_id"),))
        src = {**src, "connection_name": conn[0]["name"] if conn else "?", "connection_kind": conn[0]["kind"] if conn else None}
    else:
        f = db.drive_get(src.get("folder_id") or "")
        src = {**src, "folder_name": f["name"] if f else "(deleted)"}
    return {
        "id": row["id"],
        "name": row["name"],
        "source": src,
        "config": row["config"],
        "pending": ({**row["pending"], "proposal": _proposal_state(row)} if row.get("pending") else None),
        "pipeline": {"id": pipeline["id"], "name": pipeline["name"], "path": " / ".join(["Files & Projects", *[p["name"] for p in db.drive_path(pipeline["id"])]])} if pipeline and not pipeline.get("trashed_at") else None,
        "status": row["status"],
        "progress": row["progress"],
        "summary": row["summary"],
        "error": row.get("error"),
        "created_at": ds._iso(row["created_at"]),
        "updated_at": ds._iso(row["updated_at"]),
    }


@router.get("")
def list_pipelines() -> list[dict]:
    ds._require()
    return [_public(r) for r in ds._rows("SELECT * FROM hyperauto_pipelines ORDER BY updated_at DESC")]


@router.get("/{hid}")
def get_pipeline(hid: str) -> dict:
    ds._require()
    return _public(_row(hid))


# --------------------------------------------------------------------------------------------
# source metadata
# --------------------------------------------------------------------------------------------


def _pascal(name: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", name)
    out = "".join(p[:1].upper() + p[1:] for p in parts if p)
    return out if out and out[0].isalpha() else f"T{out}"


def _singular(name: str) -> str:
    n = name.lower()
    if n.endswith("ies"):
        return n[:-3] + "y"
    if n.endswith("ses") or n.endswith("xes"):
        return n[:-2]
    return n[:-1] if n.endswith("s") and not n.endswith("ss") else n


def _modules(names: list[str]) -> dict[str, list[str]]:
    """Tables grouped by their name prefix (before the first _), as browsing modules."""
    groups: dict[str, list[str]] = {}
    for n in names:
        key = n.split("_", 1)[0].lower() if "_" in n else "general"
        groups.setdefault(key, []).append(n)
    small = [k for k, v in groups.items() if len(v) == 1 and k != "general"]
    for k in small:
        groups.setdefault("general", []).extend(groups.pop(k))
    return dict(sorted(groups.items()))


def _guess_ordering(columns: list[dict]) -> Optional[str]:
    for c in columns:
        if c["type"] in ("Timestamp", "Date", "Long", "Integer") and ORDERING_NAME.search(c["name"]):
            return c["name"]
    return None


def _enrichment_guess(name: str, comment: Optional[str]) -> bool:
    n = name.lower()
    return bool(re.search(r"(_text|_texts|_txt|_desc|_description|_descriptions|_translation|_translations|_i18n|_lookup|_labels?)$", n)) or (comment or "").lower().startswith("text")


def connection_metadata(conn_id: str, database: str, schema: str, tables: Optional[list[str]] = None) -> dict:
    """{tables: [{name, comment, rows, columns, primary_key, ordering, role}], foreign_keys, modules}."""
    try:
        with ds._open(conn_id) as c:
            listed = c.list_tables(database, schema)
            names = [t["name"] for t in listed if t["kind"] == "table" or tables]
            wanted = names if tables is None else [n for n in tables if n in {t["name"] for t in listed}]
            missing = [] if tables is None else [n for n in tables if n not in {t["name"] for t in listed}]
            if missing:
                raise HTTPException(400, f"Not in {schema}: {', '.join(missing)}")
            info = {t["name"]: t for t in listed}
            out = []
            for n in wanted:
                if tables is None:
                    out.append({"name": n, "comment": info[n].get("comment"), "rows": info[n].get("rows"), "role": "enrichment" if _enrichment_guess(n, info[n].get("comment")) else "object"})
                    continue
                sch = c.get_table_schema(database, schema, n)
                out.append({
                    "name": n,
                    "comment": sch.get("comment") or info[n].get("comment"),
                    "rows": sch.get("rows") or info[n].get("rows"),
                    "columns": [{"name": col["name"], "type": col["type"], "comment": col.get("comment"), "db_type": col.get("db_type"), "cursor": col.get("cursor")} for col in sch["columns"]],
                    "primary_key": sch.get("primary_key") or [],
                })
            fks = c.list_foreign_keys(database, schema)
    except (ConnectorError, ValueError) as e:
        raise HTTPException(400, str(e)) from None
    for t in out:
        if "columns" in t:
            t["ordering"] = _guess_ordering(t["columns"])
            t["role"] = "enrichment" if _enrichment_guess(t["name"], t.get("comment")) else "object"
    return {"tables": out, "foreign_keys": fks, "modules": _modules([t["name"] for t in out])}


def folder_metadata(folder_id: str, tables: Optional[list[str]] = None) -> dict:
    """Parquet datasets of a folder as tables; keys inferred from names: `id` or `<table>_id` with
    unique values is the primary key; `<other table>_id` (or the other table's key name) is a
    foreign key to it."""
    folder = db.drive_get(folder_id)
    if not folder or folder["kind"] == "file":
        raise HTTPException(404, "Folder not found")
    files = {f["name"][: -len(".parquet")]: f for f in drive.list_files(folder_id) if f["name"].lower().endswith(".parquet") and not f.get("trashed_at")}
    names = sorted(files) if tables is None else tables
    missing = [n for n in names if n not in files]
    if missing:
        raise HTTPException(400, f"No Parquet dataset in the folder named {', '.join(missing)}")
    out = []
    for n in names:
        f = files[n]
        if tables is None:
            out.append({"name": n, "comment": None, "rows": None, "role": "enrichment" if _enrichment_guess(n, None) else "object", "item_id": f["id"]})
            continue
        t = pq.read_table(io.BytesIO(drive.read_bytes(f)))
        columns = [{"name": fld.name, "type": pipeline_datasets._column_type(fld.type), "comment": None} for fld in t.schema]
        pk: list[str] = []
        for cand in ("id", f"{_singular(n)}_id", f"{n.lower()}_id"):
            col = next((c["name"] for c in columns if c["name"].lower() == cand), None)
            if col:
                vals = t.column(col)
                if vals.null_count == 0 and len(set(vals.to_pylist())) == t.num_rows:
                    pk = [col]
                    break
        out.append({"name": n, "comment": None, "rows": t.num_rows, "columns": columns, "primary_key": pk, "item_id": f["id"],
                    "ordering": _guess_ordering(columns), "role": "enrichment" if _enrichment_guess(n, None) else "object"})
    fks = []
    if tables is not None:
        keyed = {t["name"]: t["primary_key"][0] for t in out if len(t["primary_key"]) == 1}
        for t in out:
            for c in t["columns"]:
                for other, key in keyed.items():
                    if other == t["name"] or c["name"] in t["primary_key"]:
                        continue
                    lname = c["name"].lower()
                    if lname in (f"{_singular(other)}_id", f"{other.lower()}_id") or (key.lower() != "id" and lname == key.lower()):
                        fks.append({"table": t["name"], "name": f"fk_{t['name']}_{c['name']}", "columns": [c["name"]], "ref_table": other, "ref_columns": [key]})
    return {"tables": out, "foreign_keys": fks, "modules": _modules([t["name"] for t in out])}


class Explore(BaseModel):
    source: Source
    # None: list the tables (names, comments, suggested roles); a list: their full metadata
    tables: Optional[list[str]] = None


@router.post("/explore")
def explore(req: Explore) -> dict:
    """The source's tables (to pick inputs from), or the metadata of chosen tables."""
    ds._require()
    if req.source.kind == "connection":
        if not req.source.connection_id:
            raise HTTPException(400, "Choose a connection")
        meta = connection_metadata(req.source.connection_id, req.source.database, req.source.schema_, req.tables)
        # tables that already have a data source (their latest one is reused)
        syncs = ds._rows(
            "SELECT id, name, table_name, mode, updated_at FROM data_sources WHERE connection_id = %s AND database_name = %s AND schema_name = %s ORDER BY updated_at DESC",
            (req.source.connection_id, req.source.database, req.source.schema_),
        )
        for t in meta["tables"]:
            t["syncs"] = [{"id": s["id"], "name": s["name"], "mode": s["mode"]} for s in syncs if s["table_name"] == t["name"]]
        return meta
    if not req.source.folder_id:
        raise HTTPException(400, "Choose a folder")
    return folder_metadata(req.source.folder_id, req.tables)


class Suggest(BaseModel):
    source: Source
    workflow: str = Field(min_length=3, max_length=2000)


@router.post("/suggest")
def suggest(req: Suggest) -> dict:
    """Input tables relevant to a described workflow, with why: an LLM when one is configured,
    otherwise keyword matching on table and column names and comments."""
    ds._require()
    listing = explore(Explore(source=req.source))["tables"]
    words = {w for w in re.findall(r"[a-z]{3,}", req.workflow.lower())} - {"the", "and", "for", "with", "that", "from", "this", "want", "need", "data", "table", "tables"}
    stems = {w.rstrip("s") for w in words}
    picks = []
    try:
        import pipeline_ai

        if hasattr(pipeline_ai, "complete_json"):
            prompt = (
                "Pick the database tables relevant to this workflow. Answer JSON {\"tables\": [{\"name\": ..., \"why\": ...}]} using only these tables.\n"
                f"Workflow: {req.workflow}\nTables:\n" + "\n".join(f"- {t['name']}: {t.get('comment') or ''}" for t in listing[:400])
            )
            ans = pipeline_ai.complete_json(prompt)
            known = {t["name"] for t in listing}
            picks = [{"name": p["name"], "why": p.get("why", "")} for p in ans.get("tables", []) if p.get("name") in known]
    except Exception:  # noqa: BLE001 — fall back to keywords
        picks = []
    if not picks:
        for t in listing:
            hay = f"{t['name']} {t.get('comment') or ''}".lower().replace("_", " ")
            hits = sorted({s for s in stems if s in hay})
            if hits:
                picks.append({"name": t["name"], "why": f"matches {', '.join(hits)}"})
    return {"tables": picks, "method": "llm" if picks and "matches" not in (picks[0].get("why") or "") else "keywords"}


# --------------------------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------------------------


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _progress(hid: str, msg: str) -> None:
    log.info("hyperauto %s: %s", hid, msg)
    ds._exec(
        "UPDATE hyperauto_pipelines SET progress = progress || %s, updated_at = %s WHERE id = %s",
        (Jsonb([{"at": _now().isoformat(), "msg": msg}]), _now(), hid),
    )


# --------------------------------------------------------------------------------------------
# who generation runs as (run_as.py): the user who started it, never the system with sign-in on
# --------------------------------------------------------------------------------------------


def requester() -> Optional[dict]:
    """The user starting a background flow (HyperAuto generation, an SDDI sync or build): its thread acts as them.
    With sign-in on there is always one; a call without a user (the system) is refused, never run as the system."""
    p = auth.current()
    if auth.enabled() and p is None:
        raise HTTPException(401, "Sign in first: this runs as the user who starts it")
    return p


def who(p: Optional[dict]) -> str:
    return run_as.who(p.get("id")) if p and p.get("id") else "the user who started it"


def _unchecked(p: Optional[dict]) -> bool:
    return not auth.enabled() or p is None or bool(p.get("service"))


def items_block(p: Optional[dict], who: str, reads: list[tuple[Optional[str], str]], writes: list[tuple[Optional[str], str]]) -> Optional[str]:
    """Why `p` may not read `reads` / write `writes` (Files items with how to describe them; None: it may) — as
    datasources.access_block, without a connection: every marking, a role that reads (Viewer) or Editor on their
    Project. Items are described, not named (the progress list is read by everyone who sees the flow)."""
    if _unchecked(p):
        return None
    for item_id, what in [*reads, *writes]:
        if not item_id:
            continue
        names = run_as.missing_marking_names(item_id, p)
        if names:
            return f"{ds._marks(names)} on {what} {'are' if len(names) > 1 else 'is'} not held by {who}"
        if not auth.outside_projects_allowed(item_id, p):
            return f"{what} is outside any Project and was not created by {who}"
    for item_id, what in reads:
        if item_id and not auth.can_access(item_id, p):
            return f"{who} has no role that reads {what} (Viewer on {auth._project_name(auth.project_of(item_id))})"
    for item_id, what in writes:
        project = auth.project_of(item_id) if item_id else None
        if project and auth._rank(auth.role_for(project, p)) < auth._rank("editor"):
            return f"{who} is not an Editor on {auth._project_name(project)}, where {what} is"
    return None


def _live(item_id: Optional[str]) -> Optional[str]:
    f = db.drive_get(item_id) if item_id else None
    return f["id"] if f and not f.get("trashed_at") else None


def sync_use_block(row: dict, p: Optional[dict], who: str, run: bool = False) -> Optional[str]:
    """Why `p` may not use an existing sync: run it (`run`, or it never ran: its first run writes its dataset) or
    read its dataset (the connection's markings, its folder and files)."""
    if _unchecked(p):
        return None
    never = not ds._view(row) and row["status"] != "running" and not ds._rows("SELECT 1 FROM data_source_runs WHERE source_id = %s LIMIT 1", (row["id"],))
    if run or never:
        return ds._sync_block(row, p, who)
    return ds.access_block(p, who, row["connection_id"], [(_live(row.get("folder_id")), "the sync's dataset folder"),
                                                          *((i, "the synced dataset") for i in ds._view(row))], [])


def new_sync_block(connection_id: str, p: Optional[dict], who: str) -> Optional[str]:
    """Why `p` may not create (and run) a new sync of the connection: its markings, Editor where syncs are created."""
    if _unchecked(p):
        return None
    return ds.access_block(p, who, connection_id, [], [(drive.default_folder("sources"), "the folder new syncs are created in")])


def _pick_sync(src: dict, t: dict, p: Optional[dict], w: str) -> tuple[Optional[str], Optional[str]]:
    """(sync id, why not) for a connection table: the chosen sync (refused when `p` cannot use it); else the latest
    existing sync of the table `p` can use; else (None, None): a new one is created."""
    if t.get("sync_id"):
        rows = ds._rows("SELECT * FROM data_sources WHERE id = %s", (t["sync_id"],))
        if not rows:
            return None, f"the sync chosen for {t['name']} no longer exists"
        why = sync_use_block(rows[0], p, w)
        return (None, f"{t['name']}: {why}") if why else (rows[0]["id"], None)
    for row in ds._rows("SELECT * FROM data_sources WHERE connection_id = %s AND database_name = %s AND schema_name = %s AND table_name = %s ORDER BY updated_at DESC",
                        (src["connection_id"], src.get("database") or "", src.get("schema") or "", t["name"])):
        if not sync_use_block(row, p, w):
            return row["id"], None
    return None, None


def _block(src: dict, cfg: dict, p: Optional[dict], folder_id: Optional[str] = None, pipeline_id: Optional[str] = None) -> Optional[str]:
    """Why generation may not run as `p` (None: it may), checked before anything is written: the source (connection
    markings, or reading the folder and its datasets), every sync it reads, creates or runs, and Editor where the
    pipeline is written (its folder; the pipeline itself for a proposal)."""
    if _unchecked(p):
        return None
    w = who(p)
    writes = [(pipeline_id, "the generated pipeline")] if pipeline_id else [(_live(folder_id), "the folder the pipeline is created in")]
    with run_as.acting_as(p):
        if src["kind"] == "folder":
            files = {f["name"][: -len(".parquet")]: f["id"] for f in drive.list_files(src["folder_id"]) if f["name"].lower().endswith(".parquet") and not f.get("trashed_at")}
            reads = [(_live(src["folder_id"]), "the source folder"), *((files.get(t["name"]), f"the dataset of {t['name']}") for t in cfg["tables"])]
            return items_block(p, w, reads, writes)
        why = ds.access_block(p, w, src["connection_id"], [], writes)
        if why:
            return why
        for t in cfg["tables"]:
            sid, why = _pick_sync(src, t, p, w)
            if why:
                return why
            if not sid:
                why = new_sync_block(src["connection_id"], p, w)
                if why:
                    return f"{t['name']} needs a new sync: {why}"
    return None


def _start(hid: str, p: Optional[dict], proposal: bool = False) -> None:
    """Generation in a background thread acting as `p` (the user who started it)."""
    def run() -> None:
        with run_as.acting_as(p):
            _generate(hid, proposal)

    threading.Thread(target=run, daemon=True, name=f"hyperauto-{hid}").start()


def _wait_for_runs(hid: str, source_ids: list[str]) -> None:
    deadline = time.monotonic() + SYNC_WAIT_S
    pending = set(source_ids)
    while pending:
        for sid in list(pending):
            row = ds._source_row(sid)
            if row["status"] == "running":
                continue
            last = ds._rows("SELECT status, error FROM data_source_runs WHERE source_id = %s ORDER BY started_at DESC LIMIT 1", (sid,))
            if last and last[0]["status"] == "failed":
                raise RuntimeError(f'The sync "{row["name"]}" failed: {last[0]["error"]}')
            if not ds._view(row):
                if not last:
                    ds.start_run(sid, "hyperauto")
                    continue
                raise RuntimeError(f'The sync "{row["name"]}" has no data')
            pending.discard(sid)
        if pending:
            if time.monotonic() > deadline:
                raise RuntimeError("The syncs' first runs did not finish within 30 minutes")
            time.sleep(1.5)


def _syncs(hid: str, src: dict, cfg: dict, meta: dict) -> dict[str, dict]:
    """Table → {ref, rows, columns}: the dataset each input is read from."""
    out: dict[str, dict] = {}
    by_name = {t["name"]: t for t in meta["tables"]}
    if src["kind"] == "folder":
        for t in cfg["tables"]:
            m = by_name[t["name"]]
            item = db.drive_get(m["item_id"])
            table = pq.read_table(io.BytesIO(drive.read_bytes(item)))
            payload = pipeline_datasets.table_payload(table.slice(0, PREVIEW_ROWS), item["name"])
            out[t["name"]] = {"ref": {"kind": "drive", "itemId": item["id"]}, "name": item["name"], "columns": payload["columns"], "rows": payload["rows"],
                              "origin": f"HyperAuto · folder dataset {item['name']}"}
        return out
    incremental = cfg["options"].get("incremental")
    created, used = [], {}
    p = auth.current()  # the user generation runs as (_start)
    for t in cfg["tables"]:
        m = by_name[t["name"]]
        sid, why = _pick_sync(src, t, p, who(p))
        if why:
            raise PermissionError(f"did not run: {why}")
        if sid and not t.get("sync_id"):
            _progress(hid, f"{t['name']}: using the existing sync")
        if not sid:
            cursor = None
            if incremental:
                cursor = t.get("ordering") or m.get("ordering") or next((c["name"] for c in m["columns"] if c.get("cursor") and c["type"] in ("Timestamp", "Long", "Integer")), None)
            mode = "incremental" if cursor else "snapshot"
            new = ds.create_source(ds.NewSource(
                name=f"{t['name']}",
                connection_id=src["connection_id"],
                database=src["database"],
                schema=src["schema"],
                table=t["name"],
                columns=None,
                config=ds.IngestConfig(mode=mode, cursor_column=cursor, frequency="daily"),
                run_now=True,
            ))
            sid = new["id"]
            created.append(sid)
            _progress(hid, f"{t['name']}: created a {mode} sync (daily)")
        used[t["name"]] = sid
    if used:
        _progress(hid, f"Waiting for the first run of {len(used)} sync{'s' if len(used) > 1 else ''}…")
        _wait_for_runs(hid, list(used.values()))
    for name, sid in used.items():
        row = ds._source_row(sid)
        payload = ds.source_table(sid)
        out[name] = {"ref": {"kind": "datasource", "id": sid}, "name": row["name"], "columns": payload["columns"], "rows": payload["rows"][:PREVIEW_ROWS],
                     "origin": f"HyperAuto · data source {row['name']} ({row['mode']})", "mode": row["mode"]}
    return out


def _step(kind: str, **params: Any) -> dict:
    return {"id": _uid(), "kind": kind, "params": {k: v for k, v in params.items() if v is not None}}


def generate_content(name: str, cfg: dict, meta: dict, inputs: dict[str, dict], location: Optional[dict] = None) -> tuple[dict, dict]:
    """The pipeline (nodes, datasets, outputs) and a summary of what it does."""
    opts = cfg["options"]
    by_name = {t["name"]: t for t in meta["tables"]}
    roles = {t["name"]: t.get("role", "object") for t in cfg["tables"]}
    ordering_of = {t["name"]: t.get("ordering") for t in cfg["tables"]}
    objects = [t["name"] for t in cfg["tables"] if roles[t["name"]] == "object"]
    enrich = [t["name"] for t in cfg["tables"] if roles[t["name"]] == "enrichment"]
    fks = [fk for fk in meta.get("foreign_keys", []) if fk["table"] in roles and fk["ref_table"] in roles]
    nodes: list[dict] = []
    datasets: dict[str, dict] = {}
    outputs: list[dict] = []
    summary: dict[str, Any] = {"objects": [], "enrichment": enrich, "joins": [], "foreign_keys": [], "links": [], "outputs": []}
    now = _now().isoformat()
    incremental = bool(opts.get("incremental"))
    lang_col, lang_val = opts.get("language_column"), opts.get("language_value")

    def cleaning_steps(table: str) -> list[dict]:
        steps = []
        cols = by_name[table]["columns"]
        if opts.get("cleaning", True):
            for c in cols:
                if c["type"] == "String":
                    steps.append(_step("clean_string", column=c["name"], emptyToNull="true", collapse="false", trim="false"))
                elif c["type"] == "Decimal":
                    steps.append(_step("cast", column=c["name"], type="Double"))
        return steps

    def key_of(table: str) -> list[str]:
        return by_name[table].get("primary_key") or []

    def dedupe_steps(table: str, keys: list[str]) -> list[dict]:
        if not opts.get("deduplicate", True) or not keys:
            return []
        ordering = ordering_of.get(table) or by_name[table].get("ordering")
        if ordering:
            return [_step("top_rows", partition=keys, sort=json.dumps([{"column": ordering, "direction": "desc"}]), n="1")]
        return [_step("dedupe", columns=keys)]

    # sources and enrichment cleaning
    src_node: dict[str, str] = {}
    y = 0
    for i, t in enumerate(cfg["tables"]):
        name = t["name"]
        inp = inputs[name]
        did = _uid()
        datasets[did] = {"id": did, "name": inp["name"], "origin": inp["origin"], "createdAt": now, "columns": inp["columns"], "rows": inp["rows"], "ref": inp["ref"]}
        nid = _uid()
        node = {"id": nid, "kind": "source", "name": name, "datasetId": did, "x": 40, "y": 40 + i * 120}
        if incremental and inp.get("mode") == "incremental":
            node["mode"] = "incremental"
        nodes.append(node)
        src_node[name] = nid
    clean_node: dict[str, str] = {}
    for i, name in enumerate(enrich):
        steps = cleaning_steps(name)
        cols = {c["name"] for c in by_name[name]["columns"]}
        lc = lang_col if lang_col in cols else next((c for c in cols if LANGUAGE_NAME.match(c)), None)
        if lc and lang_val:
            steps.append(_step("filter", mode="Keep rows", filter=json.dumps({"id": "r", "match": "all", "items": [
                {"id": "c", "left": {"kind": "column", "column": lc}, "op": "is equal to", "right": {"kind": "value", "type": "String", "value": lang_val}}]})))
        # one row per referenced key, so a join never multiplies object rows
        refs = [fk for fk in fks if fk["table"] == name and roles.get(fk["ref_table"]) == "object"]
        if refs:
            steps.append(_step("dedupe", columns=refs[0]["columns"]))
        nid = _uid()
        nodes.append({"id": nid, "kind": "transform", "name": f"Clean {name}", "input": src_node[name], "steps": steps, "x": 340, "y": 40 + (len(cfg["tables"]) + i) * 120})
        clean_node[name] = nid

    object_out: dict[str, str] = {}
    final_node: dict[str, str] = {}
    key_column: dict[str, str] = {}
    for i, name in enumerate(objects):
        y = 40 + i * 160
        keys = key_of(name)
        steps = cleaning_steps(name) + dedupe_steps(name, keys)
        if opts.get("primary_keys", True) and len(keys) > 1:
            steps.append(_step("concat", separator=SEP, columns=keys, nullIfAny="true", output="primary_key"))
            key_column[name] = "primary_key"
        elif keys:
            key_column[name] = keys[0]
        nid = _uid()
        nodes.append({"id": nid, "kind": "transform", "name": f"Clean {name}", "input": src_node[name], "steps": steps, "x": 340, "y": y})
        current = nid
        comments: dict[str, Optional[str]] = {c["name"]: c.get("comment") for c in by_name[name]["columns"]}
        # automatic joins: enrichment tables referencing this object table
        if opts.get("automatic_joins", True):
            for fk in fks:
                if fk["ref_table"] != name or fk["table"] not in enrich:
                    continue
                e = fk["table"]
                ecols = [c["name"] for c in by_name[e]["columns"] if c["name"] not in fk["columns"]]
                prefix = f"{e}_"
                jid = _uid()
                nodes.append({
                    "id": jid, "kind": "join", "name": f"{name} + {e}", "left": current, "right": clean_node[e],
                    "leftKey": fk["ref_columns"][0], "rightKey": fk["columns"][0],
                    "keys": [{"left": lc, "right": rc, "op": "="} for lc, rc in zip(fk["ref_columns"], fk["columns"])],
                    "how": "left", "leftColumns": None, "rightColumns": ecols, "rightPrefix": prefix,
                    "x": 640, "y": y,
                })
                for c in by_name[e]["columns"]:
                    if c["name"] in ecols:
                        comments[prefix + c["name"]] = c.get("comment")
                summary["joins"].append({"object": name, "enrichment": e, "on": list(zip(fk["ref_columns"], fk["columns"]))})
                current = jid
        # foreign keys to other object tables
        final_steps: list[dict] = []
        links: list[dict] = []
        for fk in fks:
            if fk["table"] != name or fk["ref_table"] not in objects:
                continue
            ref_keys = key_of(fk["ref_table"])
            if opts.get("foreign_keys", True) and len(ref_keys) > 1 and opts.get("primary_keys", True):
                col = f"{'_'.join(fk['columns'])}{SEP}foreign_key_{fk['ref_table']}"
                final_steps.append(_step("concat", separator=SEP, columns=fk["columns"], nullIfAny="true", output=col))
                summary["foreign_keys"].append({"table": name, "column": col, "references": fk["ref_table"]})
                link_key = col
            elif len(ref_keys) == 1:
                link_key = fk["columns"][0]
            else:
                continue  # a composite key without its foreign key column cannot be linked
            links.append({"from": name, "to": fk["ref_table"], "key": link_key})
        # human-readable column names (Description_|_original)
        renames: dict[str, str] = {}
        if opts.get("readable_columns", True):
            taken = set(comments)
            for col, comment in comments.items():
                if comment and col not in ("primary_key",) and col not in keys:
                    new = f"{comment.strip()[:80]}{SEP}{col}"
                    if new not in taken:
                        final_steps.append(_step("rename", column=col, to=new))
                        renames[col] = new
                        taken.add(new)
        # links read the final column names
        summary["links"].extend({**lk, "key": renames.get(lk["key"], lk["key"])} for lk in links)
        if final_steps:
            fid = _uid()
            nodes.append({"id": fid, "kind": "transform", "name": f"Prepare {name}", "input": current, "steps": final_steps, "x": 940, "y": y})
            current = fid
        final_node[name] = current
        comment = by_name[name].get("comment")
        out_name = f"{comment.strip()[:80]} ({name})" if opts.get("readable_names", True) and comment else name
        oid = _uid()
        out: dict[str, Any] = {"id": oid, "name": out_name, "node": current, "kind": "dataset", "columns": None, "x": 1240, "y": y}
        if location:
            out["location"] = location
        if incremental and key_column.get(name):
            out.update(writeMode="snapshotReplace", primaryKey=[key_column[name]])
        else:
            out["writeMode"] = "default"
        outputs.append(out)
        summary["outputs"].append({"table": name, "output": out_name, "key": key_column.get(name)})
        summary["objects"].append({"table": name, "key": key_column.get(name), "renamed": len(renames)})
        # ontology: an object type per object table with a single key
        if opts.get("ontology") and key_column.get(name):
            string_cols = [c["name"] for c in by_name[name]["columns"] if c["type"] == "String"]
            title = next((c for c in string_cols if re.search(r"(name|title|description|label)", c, re.I)), None) or key_column[name]
            otid = _uid()
            outputs.append({
                "id": otid, "name": f"{out_name} objects", "node": current, "kind": "objectType", "columns": None, "x": 1540, "y": y,
                **({"location": location} if location else {}),
                "objectType": {"apiName": _pascal(name), "pluralName": _pascal(name) + "s", "description": comment or f"{name} (HyperAuto)",
                               "primaryKey": key_column[name], "titleProperty": renames.get(title, title), "properties": None},
            })
            object_out[name] = otid
    if opts.get("ontology"):
        for link in summary["links"]:
            a, b = link["from"], link["to"]
            if a in object_out and b in object_out:
                outputs.append({
                    "id": _uid(), "name": f"{a} → {b} link", "node": final_node[a], "kind": "linkType", "columns": None, "x": 1840, "y": 40,
                    **({"location": location} if location else {}),
                    "linkType": {"from": object_out[a], "to": object_out[b], "cardinality": "many-to-one", "fromKey": link["key"], "toKey": key_column[b],
                                 "apiName": _pascal(b)[:1].lower() + _pascal(b)[1:], "reverseApiName": _pascal(a)[:1].lower() + _pascal(a)[1:] + "s"},
                })
    content = {
        "type": "batch",
        "createdAt": now,
        "updatedAt": now,
        "nodes": nodes,
        "datasets": datasets,
        "outputs": outputs,
        "legend": [],
        "meta": {"description": f"Generated by HyperAuto ({name}). Edit the configuration through a proposal in HyperAuto."},
    }
    return content, summary


def _location(folder_id: str) -> dict:
    f = db.drive_get(folder_id)
    return {"id": folder_id, "name": f["name"] if f else ""}


def _generate(hid: str, proposal: bool = False) -> None:
    """Runs in the thread _start made: acting as the user who started it (auth.current())."""
    row = _row(hid)
    try:
        src = row["source"]
        cfg = row["pending"]["config"] if proposal else row["config"]
        p = auth.current()
        if auth.enabled():
            if p is None:
                raise PermissionError("did not run: no user to run as (generation never runs as the system)")
            why = _block(src, cfg, p, row.get("folder_id"), row.get("pipeline_id") if proposal else None)
            if why:
                raise PermissionError(f"did not run: {why}")
            _progress(hid, f"Running as {who(p)}")
        names = [t["name"] for t in cfg["tables"]]
        _progress(hid, f"Reading metadata of {len(names)} table{'s' if len(names) > 1 else ''}")
        meta = connection_metadata(src["connection_id"], src["database"], src["schema"], names) if src["kind"] == "connection" else folder_metadata(src["folder_id"], names)
        for t in cfg["tables"]:
            if t.get("role", "object") == "object" and not next(m for m in meta["tables"] if m["name"] == t["name"]).get("primary_key"):
                _progress(hid, f"{t['name']}: no primary key — keys, deduplication and objects are skipped for it")
        inputs = _syncs(hid, src, cfg, meta)
        _progress(hid, "Generating the pipeline")
        if proposal:
            _propose(hid, row, cfg, meta, inputs)
            return
        # the HyperAuto folder holds the pipeline file; outputs are written next to it
        created = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=row["name"], parent_id=row.get("folder_id"), content={}))
        location = _location(created["parent_id"])
        content, summary = generate_content(row["name"], cfg, meta, inputs, location)
        content["managedBy"] = {"kind": "hyperauto", "id": hid, "name": row["name"]}
        pipeline_datasets.save_pipeline(created["id"], pipeline_datasets.PipelineFileChange(content=content))
        ds._exec(
            "UPDATE hyperauto_pipelines SET pipeline_id = %s, status = 'ready', summary = %s, error = NULL, updated_at = %s WHERE id = %s",
            (created["id"], Jsonb(summary), _now(), hid),
        )
        _progress(hid, f"Done: {len(summary['outputs'])} output datasets, {len(summary['joins'])} automatic joins — deploy the pipeline to build them")
    except Exception as e:  # noqa: BLE001
        msg = str(e.detail) if isinstance(e, HTTPException) else str(e)
        log.exception("hyperauto %s failed", hid)
        _progress(hid, f"Failed: {msg}")
        if proposal:
            ds._exec("UPDATE hyperauto_pipelines SET status = 'ready', pending = NULL, error = %s, updated_at = %s WHERE id = %s", (f"Proposal failed: {msg}"[:2000], _now(), hid))
        else:
            ds._exec("UPDATE hyperauto_pipelines SET status = 'failed', error = %s, updated_at = %s WHERE id = %s", (msg[:2000], _now(), hid))


def _propose(hid: str, row: dict, cfg: dict, meta: dict, inputs: dict) -> None:
    """Regenerates onto a branch of the pipeline with an open proposal to main."""
    item = drive._item(row["pipeline_id"])
    current = json.loads(drive.read_bytes(item))
    location = _location(item["parent_id"]) if item.get("parent_id") else None
    content, summary = generate_content(row["name"], cfg, meta, inputs, location)
    vc = dict(current.get("vc") or {})
    n = len([b for b in (vc.get("branches") or {}) if b.startswith("hyperauto-")]) + 1
    branch = f"hyperauto-{n}"
    now = _now().isoformat()
    branch_content = {k: v for k, v in content.items() if k not in ("datasets", "createdAt", "updatedAt")}
    branch_content["managedBy"] = {"kind": "hyperauto", "id": hid, "name": row["name"]}
    vc["branches"] = {**(vc.get("branches") or {}), branch: {"name": branch, "kind": "pipeline", "createdAt": now, "author": "HyperAuto", "from": "main", "content": branch_content}}
    pid = uuid.uuid4().hex[:8]
    old = {t["name"] for t in row["config"]["tables"]}
    new = {t["name"] for t in cfg["tables"]}
    desc = [f"HyperAuto regenerated the pipeline for its new configuration."]
    if new - old:
        desc.append(f"Added inputs: {', '.join(sorted(new - old))}.")
    if old - new:
        desc.append(f"Removed inputs: {', '.join(sorted(old - new))}.")
    changed = [k for k, v in cfg["options"].items() if row["config"]["options"].get(k) != v]
    if changed:
        desc.append(f"Changed options: {', '.join(changed)}.")
    desc.append("Merge, then deploy main to update the outputs.")
    vc["proposals"] = [*(vc.get("proposals") or []), {
        "id": pid, "title": "HyperAuto configuration change", "description": " ".join(desc), "from": branch, "to": "main", "status": "open",
        "author": "HyperAuto", "createdAt": now, "updatedAt": now, "reviewed": [], "approvals": [], "comments": [],
    }]
    # datasets are shared by every branch: new inputs are added next to main's
    current["datasets"] = {**(current.get("datasets") or {}), **content["datasets"]}
    current["vc"] = vc
    pipeline_datasets.save_pipeline(item["id"], pipeline_datasets.PipelineFileChange(content=current))
    pending = {**row["pending"], "branch": branch, "proposal_id": pid, "summary": summary}
    ds._exec("UPDATE hyperauto_pipelines SET status = 'ready', pending = %s, error = NULL, updated_at = %s WHERE id = %s", (Jsonb(pending), _now(), hid))
    _progress(hid, f"Proposal created on branch {branch} — review and merge it in Pipeline Builder, then deploy main")


def _check(req_source: Source, cfg: Config) -> dict:
    names = [t.name for t in cfg.tables]
    if len(set(names)) != len(names):
        raise HTTPException(400, "Each table can be selected once")
    if not any(t.role == "object" for t in cfg.tables):
        raise HTTPException(400, "Select at least one object table (enrichment tables extend object tables)")
    if cfg.options.incremental and req_source.kind != "connection":
        raise HTTPException(400, "Incremental processing needs a database connection (folder pipelines read static extracts)")
    src = {"kind": req_source.kind}
    if req_source.kind == "connection":
        if not req_source.connection_id:
            raise HTTPException(400, "Choose a connection")
        ds._connection_row(req_source.connection_id)
        src.update(connection_id=req_source.connection_id, database=req_source.database, schema=req_source.schema_)
    else:
        if not req_source.folder_id or not db.drive_get(req_source.folder_id):
            raise HTTPException(400, "Choose the folder with the datasets")
        src["folder_id"] = req_source.folder_id
    return src


@router.post("")
def create(req: NewHyperAuto) -> dict:
    ds._require()
    p = requester()
    src = _check(req.source, req.config)
    parent = drive._folder_id(req.parent_id) if req.parent_id else drive.default_folder("pipelines")
    # generation runs as this user: refused now, before anything is written, when they cannot do all of it
    why = _block(src, req.config.model_dump(), p, parent)
    if why:
        raise HTTPException(403, f"HyperAuto runs as you and cannot: {why}")
    now = _now()
    hid = uuid.uuid4().hex[:16]
    ds._exec(
        "INSERT INTO hyperauto_pipelines (id, name, source, config, folder_id, status, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, 'generating', %s, %s)",
        (hid, req.name.strip(), Jsonb(src), Jsonb(req.config.model_dump()), parent, now, now),
    )
    _start(hid, p)
    return get_pipeline(hid)


@router.post("/{hid}/proposal")
def propose(hid: str, cfg: Config) -> dict:
    """Edit the configuration: regenerates the pipeline on a branch with an open proposal."""
    ds._require()
    row = _settle(_row(hid))
    if row["status"] == "generating":
        raise HTTPException(409, "HyperAuto is generating — wait for it to finish")
    if not row.get("pipeline_id"):
        raise HTTPException(409, "The pipeline was never generated — retry the generation first")
    if row.get("pending"):
        raise HTTPException(409, "A proposal is already open — merge or close it in Pipeline Builder first")
    p = requester()
    _check(Source(**{**row["source"], "schema": row["source"].get("schema", "")}), cfg)
    why = _block(row["source"], cfg.model_dump(), p, row.get("folder_id"), row["pipeline_id"])
    if why:
        raise HTTPException(403, f"HyperAuto runs as you and cannot: {why}")
    ds._exec("UPDATE hyperauto_pipelines SET status = 'generating', pending = %s, updated_at = %s WHERE id = %s", (Jsonb({"config": cfg.model_dump()}), _now(), hid))
    _start(hid, p, True)
    return get_pipeline(hid)


@router.post("/{hid}/retry")
def retry(hid: str) -> dict:
    ds._require()
    row = _row(hid)
    if row["status"] != "failed":
        raise HTTPException(409, "Only a failed generation can be retried")
    p = requester()
    why = _block(row["source"], row["config"], p, row.get("folder_id"))
    if why:
        raise HTTPException(403, f"HyperAuto runs as you and cannot: {why}")
    ds._exec("UPDATE hyperauto_pipelines SET status = 'generating', error = NULL, progress = '[]', updated_at = %s WHERE id = %s", (_now(), hid))
    _start(hid, p)
    return get_pipeline(hid)


@router.delete("/{hid}")
def delete(hid: str) -> dict:
    """Removes the HyperAuto pipeline and releases its pipeline for direct edits (syncs, the
    pipeline and its outputs stay)."""
    ds._require()
    row = _row(hid)
    if row["status"] == "generating":
        raise HTTPException(409, "HyperAuto is generating — wait for it to finish")
    if row.get("pipeline_id") and db.drive_get(row["pipeline_id"]):
        try:
            item = drive._item(row["pipeline_id"])
            content = json.loads(drive.read_bytes(item))
            content.pop("managedBy", None)
            pipeline_datasets.save_pipeline(item["id"], pipeline_datasets.PipelineFileChange(content=content))
        except Exception:  # noqa: BLE001
            log.exception("could not release pipeline %s", row["pipeline_id"])
    ds._exec("DELETE FROM hyperauto_pipelines WHERE id = %s", (hid,))
    return {"deleted": hid}
