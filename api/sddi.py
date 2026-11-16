"""HyperAuto V1 [Sunset] — Software Defined Data Integration (SDDI, "Bellhop"): the SDDI Cockpit.

An SDDI instance ties a Data Connection source (a database connection: schema metadata from its catalog) to an
automatic pipeline generator Code Repository (sddi_template.py) and three folders (raw, metadata, output). The
Cockpit walks the SDDI flow:

  1. Sync data            source exploration (search, columns with keys, relations, preview) and a shopping cart
                          of tables; "Create syncs and integrate" writes the data dictionary datasets (dd_tables,
                          dd_columns, dd_relations) into the metadata folder, creates (or reuses) a sync per table
                          (snapshot or incremental), copies its current view into the raw folder, and opens a pull
                          request adding the new tables to SourceConfig.yaml / PipelineConfig.yaml
  2. Pipeline generation  table display names, types (OBJECT / METADATA / CUSTOMIZATION), deduplication, batch
                          union components, cleaning libraries and the stage switches, proposed as a pull request
                          (merge it here or in the repository), then a build of every generated transform in stage
                          order (metadata → cleaned → enriched → final → renamed → BUILD)
  3. Ontology changes     a preview of the object types (OBJECT tables, keyed by `primary_key`) and link types
                          (foreign keys between them) to create in bulk, then their creation, backed by the built
                          datasets

Migrating to V2 creates a HyperAuto V2 pipeline (hyperauto.py) from the V1 configuration over the same source and
lists what V2 does not carry over; severing turns the repository into a regular Python transforms repository
(no more automatic pull requests).

"Create syncs and integrate" and the build run in background threads as the user who started them (run_as.py),
never as the system with sign-in on: syncs are created (owned by that user, datasources.py) and run, folders written,
pull requests opened and transforms built with that user's markings and Project roles. What a flow needs is checked
before anything is written — the request is refused with the reason (403): for a sync the connection's markings,
Editor on the raw and metadata folders, running each sync it reuses (or Editor where new syncs are created) and
Editor on the generator repository when a pull request is opened; for a build Editor on the repository, reading the
raw / metadata folders, Editor on the output folder and being allowed to run code. The thread checks again when it
starts ("did not run: ..."). An existing sync the user cannot run is not picked automatically: a new one is created.

Mounted by server.py under /api/sddi.
"""

from __future__ import annotations

import io
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

import pyarrow as pa
import pyarrow.parquet as pq
import yaml
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import auth
import code_repos as cr
import datasources as ds
import db
import drive
import hyperauto
import pipeline_datasets
import run_as
import sddi_template

log = logging.getLogger("bluesandai.sddi")
router = APIRouter(prefix="/api/sddi")

SOURCE_TYPES = ("SAP_ERP", "SALESFORCE", "ORACLE_NETSUITE", "GENERIC")
TYPES = ("OBJECT", "METADATA", "CUSTOMIZATION")
STAGE_ORDER = ("objects", "fields", "links", "diffs", "cleaned", "enriched", "final", "renamed", "BUILD")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sddi_instances (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    source_type   text NOT NULL,
    source        jsonb NOT NULL,
    repo_id       text NOT NULL,
    folders       jsonb NOT NULL,
    syncs         jsonb NOT NULL DEFAULT '{}',
    ontology      jsonb NOT NULL DEFAULT '{}',
    severed       boolean NOT NULL DEFAULT false,
    migrated_to   text,
    status        text NOT NULL DEFAULT 'idle',
    progress      jsonb NOT NULL DEFAULT '[]',
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
    ds._exec("UPDATE sddi_instances SET status = 'failed', error = 'Interrupted by a server restart' WHERE status IN ('syncing', 'building')")


def _row(iid: str) -> dict:
    """The instance's row, unchecked (the background flows and the routes after their check): routes use _instance."""
    rows = ds._rows("SELECT * FROM sddi_instances WHERE id = %s", (iid,))
    if not rows:
        raise HTTPException(404, "SDDI instance not found")
    return rows[0]


def _code_repo(repo_id: str, role: str = "viewer") -> dict:
    """The generator repository with the caller's access checked as /api/code-repos/{id} checks it (its markings and
    `role` on its Project: Viewer reads its configuration, pull requests and builds, Editor changes or builds it, Owner
    changes its settings): 404 when it is missing or the caller cannot see it, 403 when they see it without the role.
    The code-repo functions this module calls directly (branches, commits, pull requests) do no role check of their
    own — only the /api/code-repos URL middleware does — so every route checks here first."""
    rec = cr._repo(repo_id)
    if not auth.visible_resources("code_repo", [rec]):
        raise HTTPException(404, "repository not found")
    auth.check_resource("code_repo", repo_id, role)
    return rec


def _instance(iid: str, role: str = "viewer") -> dict:
    """An instance for a route: the caller needs `role` on its generator repository (a hidden one answers 404 like a
    missing instance would). An instance whose repository is gone shows nothing of it: administrators only."""
    row = _row(iid)
    if cr._read(row["repo_id"], "repo.json", None) is None:
        if not auth._is_admin(auth.current()):
            raise HTTPException(404, "repository not found")
        return row
    _code_repo(row["repo_id"], role)
    return row


def _folder_path(folder_id: str) -> str:
    return "/" + "/".join(p["name"] for p in db.drive_path(folder_id))


def _configs(row: dict, branch: Optional[str] = None) -> tuple[dict, dict]:
    files = cr._branch(cr._repo(row["repo_id"]), branch)["files"]
    try:
        sc = yaml.safe_load(files.get(sddi_template.SOURCE_CONFIG) or "") or {}
        pc = yaml.safe_load(files.get(sddi_template.PIPELINE_CONFIG) or "") or {}
    except yaml.YAMLError as e:
        raise HTTPException(400, f"The repository's configuration files do not parse: {e}") from None
    return sc, pc


def _prs(row: dict) -> list[dict]:
    try:
        return [p for p in cr.list_prs(row["repo_id"]) if str(p.get("source", "")).startswith("sddi/")]
    except HTTPException:
        return []


def _sees_connection(connection_id: Optional[str]) -> bool:
    """Whether the caller holds the source connection's markings (its name and catalog are shown only then)."""
    try:
        auth.check_resource("connection", str(connection_id))
    except HTTPException:
        return False
    return True


def _file_names(folder_id: str) -> set[str]:
    """The dataset names in one of the instance's folders the caller may discover (nothing of a hidden folder)."""
    if not db.drive_get(folder_id) or not auth.can_discover(folder_id):
        return set()
    return {f["name"].rsplit(".", 1)[0] for f in auth.visible(drive.list_files(folder_id))}


def _public(row: dict) -> dict:
    try:
        repo = cr._repo(row["repo_id"])
    except HTTPException:
        repo = None
    sc, pc = _configs(row) if repo else ({}, {})
    conn = ds._rows("SELECT name, kind FROM db_connections WHERE id = %s", (row["source"].get("connection_id"),))
    if conn and not _sees_connection(row["source"].get("connection_id")):
        conn = [{"name": "(no access)", "kind": None}]
    folders = {k: {"id": v, "path": (_folder_path(v) if auth.can_discover(v) else "(no access)") if db.drive_get(v) else "(deleted)"} for k, v in row["folders"].items()}
    tables = [t["tableName"] for t in sc.get("tables") or [] if t.get("tableName")]
    raw = _file_names(row["folders"]["raw"])
    prs = _prs(row)
    open_prs = [p for p in prs if p.get("status") == "open"]
    builds = _last_builds(row) if repo else {}
    return {
        "id": row["id"], "name": row["name"], "source_type": row["source_type"],
        "source": {**row["source"], "connection_name": conn[0]["name"] if conn else "?", "connection_kind": conn[0]["kind"] if conn else None},
        "repo": {"id": row["repo_id"], "name": repo["name"] if repo else "(deleted)", "template": (repo or {}).get("template")},
        "folders": folders, "severed": row["severed"], "migrated_to": row.get("migrated_to"),
        "status": row["status"], "progress": row["progress"], "error": row.get("error"),
        "syncs": row["syncs"], "ontology": row["ontology"],
        "source_config": sc, "pipeline_config": pc,
        "pull_requests": [{"id": p["id"], "title": p["title"], "status": p["status"], "source": p["source"]} for p in prs[-10:]],
        "stages": {
            "sync": {"tables": len(tables), "synced": len([t for t in tables if _dataset(sc, t) in raw]),
                     "dictionary": all(n in _file_names(row["folders"]["metadata"]) for n in ("dd_tables", "dd_columns", "dd_relations"))},
            "pipeline": {"open_pull_requests": len(open_prs), "built": len([b for b in builds.values() if b["status"] == "succeeded"]),
                         "failed": len([b for b in builds.values() if b["status"] != "succeeded"])},
            "ontology": {"object_types": len(row["ontology"].get("object_types") or {}), "link_types": len(row["ontology"].get("link_types") or [])},
        },
        "created_at": ds._iso(row["created_at"]), "updated_at": ds._iso(row["updated_at"]),
    }


def _dataset(sc: dict, table: str) -> str:
    t = next((x for x in sc.get("tables") or [] if x.get("tableName") == table), {})
    return (t.get("datasetTransformsConfig") or {}).get("datasetName") or table


def _last_builds(row: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for b in cr._builds(row["repo_id"]):
        if b.get("branch") == cr._repo(row["repo_id"])["default_branch"]:
            out[b["transform"]] = b
    return out


@router.get("")
def list_instances() -> list[dict]:
    """The instances whose generator repository the caller reads (Viewer, its markings)."""
    ds._require()
    out = []
    for r in ds._rows("SELECT * FROM sddi_instances ORDER BY updated_at DESC"):
        try:
            _instance(r["id"])
        except HTTPException:
            continue
        out.append(_public(r))
    return out


@router.get("/{iid}")
def get_instance(iid: str) -> dict:
    ds._require()
    return _public(_instance(iid))


def _view(iid: str) -> dict:
    """The instance as a route returns it after its own check."""
    return _public(_row(iid))


# --------------------------------------------------------------------------------------------
# initial set up
# --------------------------------------------------------------------------------------------


class NewInstance(BaseModel):
    repository_name: str = Field(min_length=1, max_length=100)
    source_type: Literal["SAP_ERP", "SALESFORCE", "ORACLE_NETSUITE", "GENERIC"] = "GENERIC"
    connection_id: str
    database: str = ""
    schema_: str = Field("", alias="schema")
    # sourceName: prefixes primary and foreign keys
    source_name: Optional[str] = Field(None, max_length=60)
    # where the raw / metadata / output folders go (default: My Project / Datapipeline / <name>)
    parent_id: Optional[str] = None

    model_config = {"populate_by_name": True}


@router.post("")
def create(req: NewInstance) -> dict:
    """A new instance, checked before anything is written: the connection's markings (403), Editor on the folder its
    raw / metadata / output folders go in, Editor on the Project the generator repository goes in."""
    ds._require()
    conn = ds._rows("SELECT id, name FROM db_connections WHERE id = %s", (req.connection_id,))
    if not conn:
        raise HTTPException(404, "Connection not found")
    ds._connection_row(req.connection_id)
    name = req.repository_name.strip()
    if not cr.PATH_OK.match(name) or "/" in name:
        raise HTTPException(400, "a repository name may hold letters, digits, spaces, - _ and .")
    parent = drive._folder_id(req.parent_id) if req.parent_id else drive.default_folder("pipelines")
    if not req.parent_id:
        drive._item(parent, need="editor")
    cr._new_repo_project(None)
    base = drive._insert_container(parent, "folder", drive._free_name(parent, drive._clean_name(drive.BAD_NAME.sub("_", name))))
    folders = {k: drive._insert_container(base, "folder", k) for k in ("raw", "metadata", "output")}
    source_name = re.sub(r"[^A-Za-z0-9_]", "_", (req.source_name or conn[0]["name"]).strip()).upper()[:60] or "SOURCE"
    extra = {"sapContext": {"type": "direct"}} if req.source_type == "SAP_ERP" else {}
    sc = sddi_template.source_config(source_name, f"ri.magritte..source.{req.connection_id}", _folder_path(folders["raw"]), _folder_path(folders["metadata"]), [], extra)
    pc = sddi_template.pipeline_config(source_name, req.source_type, _folder_path(folders["output"]), {})
    repo = cr.create_repo(cr.RepoIn(name=name, description=f"SDDI automatic pipeline generator for {conn[0]['name']}"))
    with cr._lock:
        rec = cr._repo(repo["id"])
        files = sddi_template.files(name, conn[0]["name"], cr.REPO_SETTINGS, sc, pc)
        rec["branches"][rec["default_branch"]]["files"] = files
        iid = uuid.uuid4().hex[:16]
        rec["template"] = {"kind": "sddi", "instance": iid}
        cr._save(rec)
        cr._commit(rec, rec["default_branch"], "SDDI: automatic pipeline generator")
    now = _now()
    ds._exec(
        "INSERT INTO sddi_instances (id, name, source_type, source, repo_id, folders, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (iid, name, req.source_type, Jsonb({"connection_id": req.connection_id, "database": req.database, "schema": req.schema_}), repo["id"], Jsonb(folders), now, now),
    )
    return _view(iid)


@router.delete("/{iid}")
def delete(iid: str) -> dict:
    """Removes the instance; the repository, folders, syncs and ontology stay. Editors of the generator repository."""
    _instance(iid, "editor")
    ds._exec("DELETE FROM sddi_instances WHERE id = %s", (iid,))
    return {"deleted": iid}


# --------------------------------------------------------------------------------------------
# 1. sync data: source exploration and the shopping cart
# --------------------------------------------------------------------------------------------


def _source(row: dict) -> hyperauto.Source:
    s = row["source"]
    return hyperauto.Source(kind="connection", connection_id=s["connection_id"], database=s.get("database") or "", schema=s.get("schema") or "")


class ExploreIn(BaseModel):
    # None: the table list (search panel); names: their columns, keys and relations
    tables: Optional[list[str]] = None


@router.post("/{iid}/explore")
def explore(iid: str, req: ExploreIn) -> dict:
    row = _instance(iid)
    meta = hyperauto.explore(hyperauto.Explore(source=_source(row), tables=req.tables))
    sc, _ = _configs(row)
    configured = {t["tableName"] for t in sc.get("tables") or []}
    raw = _file_names(row["folders"]["raw"])
    for t in meta["tables"]:
        t["configured"] = t["name"] in configured
        t["synced"] = _dataset(sc, t["name"]) in raw
    return meta


@router.get("/{iid}/preview/{table}")
def preview(iid: str, table: str, limit: int = 50) -> dict:
    """A sample of the source table (Dataset Preview in the explorer)."""
    row = _instance(iid)
    s = row["source"]
    try:
        with ds._open(s["connection_id"]) as c:
            columns, rows = c.preview_rows(s.get("database") or "", s.get("schema") or "", table, max(1, min(limit, 200)))
    except HTTPException:
        raise  # the connection's markings (403)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from None
    names = [col["name"] for col in columns]
    return {"columns": columns, "rows": [{n: (v if isinstance(v, (str, int, float, bool)) or v is None else str(v)) for n, v in zip(names, r)} for r in rows]}


class CartTable(BaseModel):
    name: str
    transaction: Literal["snapshot", "incremental"] = "snapshot"
    cursor: Optional[str] = None
    types: list[Literal["OBJECT", "METADATA", "CUSTOMIZATION"]] = Field(default_factory=lambda: ["OBJECT"])


class SyncIn(BaseModel):
    tables: list[CartTable] = Field(min_length=1, max_length=200)


def _progress(iid: str, msg: str) -> None:
    ds._exec("UPDATE sddi_instances SET progress = progress || %s, updated_at = %s WHERE id = %s", (Jsonb([{"at": _now().isoformat(), "message": msg}]), _now(), iid))


def _put_parquet(folder_id: str, name: str, table: pa.Table) -> dict:
    data = pipeline_datasets._parquet_bytes(table)
    existing = next((f for f in drive.list_files(folder_id) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
    if existing:
        pipeline_datasets._replace_content(existing, data)
        return db.drive_get(existing["id"])
    return drive.save_bytes(folder_id, f"{name}.parquet", data, pipeline_datasets.PARQUET)


def _dictionary(meta: dict, previous: dict[str, list[dict]]) -> dict[str, pa.Table]:
    """dd_tables / dd_columns / dd_relations: the catalog metadata of the synced tables (merged with what earlier
    syncs wrote)."""
    tables = {r["table_name"]: r for r in previous.get("dd_tables", [])}
    columns = {(r["table_name"], r["column_name"]): r for r in previous.get("dd_columns", [])}
    relations = {(r["table_name"], r["constraint_name"]): r for r in previous.get("dd_relations", [])}
    for t in meta["tables"]:
        tables[t["name"]] = {"table_name": t["name"], "description": t.get("comment") or "", "primary_key": ",".join(t.get("primary_key") or []),
                             "rows": t.get("rows")}
        for k in [k for k in columns if k[0] == t["name"]]:
            columns.pop(k)
        for i, c in enumerate(t.get("columns") or []):
            columns[(t["name"], c["name"])] = {"table_name": t["name"], "column_name": c["name"], "data_type": c["type"], "description": c.get("comment") or "",
                                               "position": i, "is_key": c["name"] in (t.get("primary_key") or [])}
    for fk in meta.get("foreign_keys") or []:
        relations[(fk["table"], fk["name"])] = {"table_name": fk["table"], "constraint_name": fk["name"], "columns": ",".join(fk["columns"]),
                                                "ref_table": fk["ref_table"], "ref_columns": ",".join(fk["ref_columns"])}
    schemas = {
        "dd_tables": pa.schema([("table_name", pa.string()), ("description", pa.string()), ("primary_key", pa.string()), ("rows", pa.int64())]),
        "dd_columns": pa.schema([("table_name", pa.string()), ("column_name", pa.string()), ("data_type", pa.string()), ("description", pa.string()),
                                 ("position", pa.int64()), ("is_key", pa.bool_())]),
        "dd_relations": pa.schema([("table_name", pa.string()), ("constraint_name", pa.string()), ("columns", pa.string()), ("ref_table", pa.string()),
                                   ("ref_columns", pa.string())]),
    }
    data = {"dd_tables": list(tables.values()), "dd_columns": list(columns.values()), "dd_relations": list(relations.values())}
    return {k: pa.Table.from_pylist(data[k], schema=schemas[k]) for k in schemas}


def _read_folder_table(folder_id: str, name: str) -> list[dict]:
    f = next((f for f in drive.list_files(folder_id) if f["name"] == f"{name}.parquet"), None)
    return pq.read_table(io.BytesIO(drive.read_bytes(f))).to_pylist() if f else []


def _guess_type(t: dict) -> str:
    return "CUSTOMIZATION" if t.get("role") == "enrichment" else "OBJECT"


@router.post("/{iid}/sync")
def sync(iid: str, req: SyncIn) -> dict:
    """Create syncs and integrate (runs in the background; the status summary is the progress list). Viewers of the
    generator repository get this far; _sync_block decides the rest (Editor when a pull request is opened)."""
    row = _instance(iid)
    if row["status"] in ("syncing", "building"):
        raise HTTPException(409, f"The instance is {row['status']}")
    p = hyperauto.requester()
    why = _sync_block(row, req.model_dump(), p)
    if why:
        raise HTTPException(403, f"The sync runs as you and cannot: {why}")
    ds._exec("UPDATE sddi_instances SET status = 'syncing', progress = '[]', error = NULL, updated_at = %s WHERE id = %s", (_now(), iid))
    _in_thread(_sync, p, f"sddi-sync-{iid}", iid, req.model_dump())
    return _view(iid)


# --------------------------------------------------------------------------------------------
# who the background flows run as (run_as.py): the user who started them, never the system with sign-in on
# --------------------------------------------------------------------------------------------


def _in_thread(fn, p: Optional[dict], name: str, *args) -> None:  # noqa: ANN001
    """`fn(*args)` in a background thread acting as `p` (the user who started it)."""
    def run() -> None:
        with run_as.acting_as(p):
            fn(*args)

    threading.Thread(target=run, daemon=True, name=name).start()


def _repo_block(row: dict, p: Optional[dict], w: str) -> Optional[str]:
    """Why `p` may not change or build the generator repository (its markings, Editor on its Project)."""
    try:
        with run_as.acting_as(p):
            auth.check_resource("code_repo", row["repo_id"], "editor")
    except HTTPException as e:
        return f"{w} cannot change the generator repository ({e.detail})"
    return None


def _pick_sync(row: dict, t: dict, p: Optional[dict], w: str) -> tuple[Optional[str], str, Optional[str]]:
    """(sync id, operation, why not) for a cart table — every sync used is run, so `p` must be able to run it: the
    instance's sync of the table (refused when `p` cannot), else the latest existing one `p` can run, else a new one."""
    s = row["source"]
    sid = (row["syncs"].get(t["name"]) or {}).get("id")
    rows = ds._rows("SELECT * FROM data_sources WHERE id = %s", (sid,)) if sid else []
    if rows:
        why = hyperauto.sync_use_block(rows[0], p, w, run=True)
        return (None, "", f"{t['name']}: {why}") if why else (sid, "Up-to-date extract", None)
    for r in ds._rows("SELECT * FROM data_sources WHERE connection_id = %s AND database_name = %s AND schema_name = %s AND table_name = %s ORDER BY updated_at DESC",
                      (s["connection_id"], s.get("database") or "", s.get("schema") or "", t["name"])):
        if not hyperauto.sync_use_block(r, p, w, run=True):
            return r["id"], "Update extract", None
    return None, "Create extract", None


def _sync_block(row: dict, req: dict, p: Optional[dict]) -> Optional[str]:
    """Why "Create syncs and integrate" may not run as `p` (None: it may), before anything is written."""
    if hyperauto._unchecked(p):
        return None
    w = hyperauto.who(p)
    with run_as.acting_as(p):
        why = ds.access_block(p, w, row["source"]["connection_id"], [], [(hyperauto._live(row["folders"]["metadata"]), "the instance's metadata folder"),
                                                                         (hyperauto._live(row["folders"]["raw"]), "the instance's raw folder")])
        if why:
            return why
        for t in req["tables"]:
            sid, _, why = _pick_sync(row, t, p, w)
            if why:
                return why
            if not sid:
                why = hyperauto.new_sync_block(row["source"]["connection_id"], p, w)
                if why:
                    return f"{t['name']} needs a new sync: {why}"
        if not row["severed"]:
            try:
                sc, _ = _configs(row)
            except HTTPException:
                return None  # no repository: the sync fails on it as before
            known = {x.get("tableName") for x in sc.get("tables") or []}
            if any(t["name"] not in known for t in req["tables"]):
                return _repo_block(row, p, w)
    return None


def _build_block(row: dict, p: Optional[dict]) -> Optional[str]:
    """Why a build of the generated transforms may not run as `p` (None: it may), before anything is built."""
    if hyperauto._unchecked(p):
        return None
    w = hyperauto.who(p)
    if not auth.can_run_code(p):
        return f"{w} may not run code on this machine (Control Panel → Security → Code execution)"
    why = _repo_block(row, p, w)
    if why:
        return why
    f = row["folders"]
    return hyperauto.items_block(p, w, [(hyperauto._live(f["raw"]), "the instance's raw folder"), (hyperauto._live(f["metadata"]), "the instance's metadata folder")],
                                 [(hyperauto._live(f["output"]), "the instance's output folder")])


def _acting_check(iid: str, block) -> None:  # noqa: ANN001
    """In a flow's thread: refuse to run as the system with sign-in on, check `block(principal)` again and record
    who the flow runs as in the instance's progress."""
    p = auth.current()
    if auth.enabled() and p is None:
        raise PermissionError("did not run: no user to run as (the SDDI flows never run as the system)")
    why = block(p)
    if why:
        raise PermissionError(f"did not run: {why}")
    if auth.enabled() and p:
        _progress(iid, f"Running as {hyperauto.who(p)}")


def _sync(iid: str, req: dict) -> None:
    """Runs in the thread sync() made, acting as the user who started it."""
    try:
        row = _row(iid)
        _acting_check(iid, lambda p: _sync_block(row, req, p))
        s = row["source"]
        p = auth.current()
        names = [t["name"] for t in req["tables"]]
        _progress(iid, f"Reading the metadata of {len(names)} table{'s' if len(names) > 1 else ''}")
        meta = hyperauto.connection_metadata(s["connection_id"], s.get("database") or "", s.get("schema") or "", names)
        by_name = {t["name"]: t for t in meta["tables"]}
        previous = {k: _read_folder_table(row["folders"]["metadata"], k) for k in ("dd_tables", "dd_columns", "dd_relations")}
        for k, table in _dictionary(meta, previous).items():
            _put_parquet(row["folders"]["metadata"], k, table)
        _progress(iid, "Wrote the data dictionary (dd_tables, dd_columns, dd_relations) into the metadata folder")
        syncs = dict(row["syncs"])
        for t in req["tables"]:
            sid, op, why = _pick_sync({**row, "syncs": syncs}, t, p, hyperauto.who(p))
            if why:
                raise PermissionError(f"did not run: {why}")
            if not sid:
                cursor = t.get("cursor") or by_name[t["name"]].get("ordering") if t["transaction"] == "incremental" else None
                mode = "incremental" if cursor else "snapshot"
                new = ds.create_source(ds.NewSource(name=t["name"], connection_id=s["connection_id"], database=s.get("database") or "", schema=s.get("schema") or "",
                                                    table=t["name"], columns=None, config=ds.IngestConfig(mode=mode, cursor_column=cursor, frequency="daily"), run_now=True))
                sid = new["id"]
                _progress(iid, f"{t['name']}: {op.lower()} ({mode}, daily)")
            else:
                ds.start_run(sid, "sddi")
                _progress(iid, f"{t['name']}: {op.lower()} — running the existing sync")
            syncs[t["name"]] = {"id": sid, "transaction": t["transaction"]}
        _wait(iid, [v["id"] for k, v in syncs.items() if k in names])
        for t in req["tables"]:
            src = ds._source_row(syncs[t["name"]]["id"])
            files = [f for f in (db.drive_get(i) for i in ds._view(src)) if f and not f.get("trashed_at")]
            table = pa.concat_tables([pq.read_table(io.BytesIO(drive.read_bytes(f))) for f in files], promote_options="default")
            _put_parquet(row["folders"]["raw"], t["name"], table)
            _progress(iid, f"{t['name']}: {table.num_rows} rows in the raw folder")
        ds._exec("UPDATE sddi_instances SET syncs = %s WHERE id = %s", (Jsonb(syncs), iid))
        row = _row(iid)
        if row["severed"]:
            _progress(iid, "The repository is severed: add the tables to SourceConfig.yaml and PipelineConfig.yaml yourself")
        else:
            sc, pc = _configs(row)
            known = {x["tableName"] for x in sc.get("tables") or []}
            added = [t for t in req["tables"] if t["name"] not in known]
            if added:
                sc.setdefault("tables", [])
                pc.setdefault("tables", {})
                for t in added:
                    sc["tables"].append({"tableName": t["name"], "datasetTransformsConfig": {"datasetName": t["name"], "deduplicationComparisonColumns": [],
                                                                                         "batchUnionComponents": [], "tableCleaningLibraries": []}})
                    comment = (by_name[t["name"]].get("comment") or "").strip()
                    pc["tables"][t["name"]] = {"displayName": comment[:80] or t["name"], "types": list(t.get("types") or [_guess_type(by_name[t["name"]])])}
                pr = _open_pr(row, sc, pc, f"Add {len(added)} table{'s' if len(added) > 1 else ''} to the SDDI pipeline",
                              "Tables synced from the source: " + ", ".join(t["name"] for t in added))
                _progress(iid, f"Opened pull request #{pr['id']} adding {', '.join(t['name'] for t in added)} to the pipeline configuration")
            else:
                _progress(iid, "The tables are already in the pipeline configuration")
        ds._exec("UPDATE sddi_instances SET status = 'idle', updated_at = %s WHERE id = %s", (_now(), iid))
    except Exception as e:  # noqa: BLE001
        log.exception("SDDI sync %s failed", iid)
        msg = e.detail if isinstance(e, HTTPException) else str(e)
        ds._exec("UPDATE sddi_instances SET status = 'failed', error = %s, updated_at = %s WHERE id = %s", (str(msg)[:2000], _now(), iid))


def _wait(iid: str, source_ids: list[str]) -> None:
    """hyperauto._wait_for_runs reports into a HyperAuto pipeline's progress; this reports into the instance's."""
    import time

    deadline = time.monotonic() + hyperauto.SYNC_WAIT_S
    pending = set(source_ids)
    time.sleep(0.5)
    while pending:
        for sid in list(pending):
            src = ds._source_row(sid)
            if src["status"] == "running":
                continue
            last = ds._rows("SELECT status, error FROM data_source_runs WHERE source_id = %s ORDER BY started_at DESC LIMIT 1", (sid,))
            if last and last[0]["status"] == "running":
                continue
            if last and last[0]["status"] == "failed":
                raise RuntimeError(f'The sync "{src["name"]}" failed: {last[0]["error"]}')
            if not ds._view(src):
                if not last:
                    continue
                raise RuntimeError(f'The sync "{src["name"]}" has no data')
            pending.discard(sid)
        if pending and time.monotonic() > deadline:
            raise RuntimeError("Timed out waiting for the syncs")
        if pending:
            time.sleep(1)


# --------------------------------------------------------------------------------------------
# 2. pipeline generation: configuration through pull requests, builds
# --------------------------------------------------------------------------------------------


def _open_pr(row: dict, sc: dict, pc: dict, title: str, description: str) -> dict:
    if row["severed"]:
        raise HTTPException(409, "The repository is severed from the SDDI template: edit its configuration files and open pull requests yourself")
    repo_id = row["repo_id"]
    # the branch / commit / pull request functions below check no role themselves: Editor of the repository (and its
    # markings), as the caller — the route's user, or the user a background sync runs as
    rec = _code_repo(repo_id, "editor")
    default = rec["default_branch"]
    branch = f"sddi/config-{uuid.uuid4().hex[:6]}"
    cr.create_branch(repo_id, cr.BranchIn(name=branch, source=default))
    files = dict(cr._branch(cr._repo(repo_id), branch)["files"])
    files[sddi_template.SOURCE_CONFIG] = sddi_template.dump(sc)
    files[sddi_template.PIPELINE_CONFIG] = sddi_template.dump(pc)
    cr.save_files(repo_id, cr.FilesPut(branch=branch, files=files))
    cr.commit(repo_id, cr.CommitIn(branch=branch, message=title))
    return cr.create_pr(repo_id, cr.PrIn(source=branch, target=default, title=title, description=f"Opened by the SDDI Cockpit. {description}"))


class TableConfig(BaseModel):
    display_name: Optional[str] = Field(None, max_length=200)
    types: list[Literal["OBJECT", "METADATA", "CUSTOMIZATION"]] = Field(default_factory=lambda: ["OBJECT"])
    deduplication_comparison_columns: list[str] = []
    change_mode_column: Optional[str] = None
    batch_union_components: list[str] = []
    table_cleaning_libraries: list[str] = []
    enforce_unique_primary_keys: bool = False
    spark_profiles: list[str] = []


class PipelineIn(BaseModel):
    tables: dict[str, TableConfig]
    cleaning_libraries: Optional[list[str]] = None
    language_key: Optional[str] = Field(None, max_length=3)
    deployment_semantic_version: Optional[int] = Field(None, ge=0)
    disable_foreign_key_generation: bool = False
    disable_enriched_stage: bool = False
    disable_renamed_stage: bool = False
    # tables left out of `tables` are removed from the pipeline
    remove_missing: bool = False


@router.post("/{iid}/pipeline")
def configure(iid: str, req: PipelineIn) -> dict:
    """Propose a pipeline configuration change as a pull request on the generator repository (its Editors)."""
    row = _instance(iid, "editor")
    if row["severed"]:
        raise HTTPException(409, "The repository is severed from the SDDI template: edit its configuration files and open pull requests yourself")
    sc, pc = _configs(row)
    by_name = {t["tableName"]: t for t in sc.get("tables") or []}
    unknown = [n for n in req.tables if n not in by_name]
    if unknown:
        raise HTTPException(400, f"Not synced into the pipeline yet: {', '.join(unknown)} (sync them first)")
    for n, t in req.tables.items():
        tc = by_name[n].setdefault("datasetTransformsConfig", {"datasetName": n})
        tc["deduplicationComparisonColumns"] = t.deduplication_comparison_columns
        tc["batchUnionComponents"] = t.batch_union_components
        tc["tableCleaningLibraries"] = t.table_cleaning_libraries
        for key, val in (("changeModeColumn", t.change_mode_column), ("enforceUniquePrimaryKeys", t.enforce_unique_primary_keys or None),
                         ("sparkProfiles", {"profiles": t.spark_profiles} if t.spark_profiles else None)):
            if val:
                tc[key] = val
            else:
                tc.pop(key, None)
        pc.setdefault("tables", {})[n] = {"displayName": (t.display_name or n).strip(), "types": t.types or ["OBJECT"]}
    if req.remove_missing:
        sc["tables"] = [t for t in sc.get("tables") or [] if t["tableName"] in req.tables]
        pc["tables"] = {k: v for k, v in (pc.get("tables") or {}).items() if k in req.tables}
    if req.cleaning_libraries is not None:
        sc["cleaningLibraries"] = req.cleaning_libraries
    if req.language_key:
        sc["languageKey"] = req.language_key
    if req.deployment_semantic_version is not None:
        sc["deploymentSemanticVersion"] = req.deployment_semantic_version
    pc["disableForeignKeyGeneration"] = req.disable_foreign_key_generation
    pc["disableEnrichedStage"] = req.disable_enriched_stage
    pc["disableRenamedStage"] = req.disable_renamed_stage
    current = _configs(row)
    if (sc, pc) == current:
        raise HTTPException(400, "Nothing changed")
    pr = _open_pr(row, sc, pc, "Update the SDDI pipeline configuration", f"{len(req.tables)} tables configured.")
    _progress(iid, f"Opened pull request #{pr['id']}: pipeline configuration")
    return {**_view(iid), "pull_request": pr}


@router.post("/{iid}/pulls/{pr_id}/merge")
def merge(iid: str, pr_id: str) -> dict:
    """Merge a pull request of the generator repository (its Editors; branch protection and approvals as in the
    repository)."""
    row = _instance(iid, "editor")
    rec = _code_repo(row["repo_id"], "editor")
    pr = cr.get_pr(row["repo_id"], pr_id)
    if not pr["state"]["can_merge"]:
        raise HTTPException(409, f"The pull request cannot be merged yet: {pr['state'].get('reason') or 'checks or approvals are missing'}")
    cr.merge_pr(row["repo_id"], pr_id, cr.PrMerge(mode=rec["settings"]["merge_modes"][0]))
    _progress(iid, f"Merged pull request #{pr_id}")
    return _view(iid)


def _stage(t: dict) -> int:
    fn = t["function"]
    for i, s in enumerate(STAGE_ORDER):
        if fn.endswith(f"_{s}") or fn.startswith(f"{s}_"):
            return i
    return len(STAGE_ORDER)


@router.post("/{iid}/build")
def build(iid: str) -> dict:
    """Build every generated transform on the default branch, in stage order (in the background). A hidden repository
    answers 404 here; _build_block then needs Editor on it (403)."""
    row = _instance(iid)
    if row["status"] in ("syncing", "building"):
        raise HTTPException(409, f"The instance is {row['status']}")
    p = hyperauto.requester()
    why = _build_block(row, p)
    if why:
        raise HTTPException(403, f"The build runs as you and cannot: {why}")
    ds._exec("UPDATE sddi_instances SET status = 'building', progress = '[]', error = NULL, updated_at = %s WHERE id = %s", (_now(), iid))
    _in_thread(_build, p, f"sddi-build-{iid}", iid)
    return _view(iid)


def _build(iid: str) -> None:
    """Runs in the thread build() made, acting as the user who started it (the builds read and write as them)."""
    try:
        row = _row(iid)
        _acting_check(iid, lambda p: _build_block(row, p))
        rec = cr._repo(row["repo_id"])
        br = cr._branch(rec, None)
        head_files = cr._commit_files(rec["id"], br["head"])
        commit_id = br["head"] if cr._files_hash(head_files) == cr._files_hash(br["files"]) else None
        listed = cr._run(br["files"], {"mode": "list"}, rec)
        if not listed.get("ok"):
            raise RuntimeError(listed.get("error") or "the repository does not load")
        errors = [e for e in listed.get("errors") or [] if not e.get("warning")]
        if errors:
            raise RuntimeError(f"{errors[0]['file']}: {errors[0]['error']}")
        ts = sorted((t for t in listed["transforms"] if t["file"].endswith("pipeline_builder.py")), key=_stage)
        if not ts:
            raise RuntimeError("The pipeline generates no transforms: sync tables and merge their pull request first")
        _progress(iid, f"Building {len(ts)} generated transforms")
        failed = 0
        for t in ts:
            b = cr.build_transform(rec, br["files"], br["name"], t["key"], "manual", commit_id, listed, run_as=auth.actor_id())
            if b["status"] != "succeeded":
                failed += 1
                _progress(iid, f"{t['function']}: failed — {(b.get('error') or '')[-400:]}")
                break
            _progress(iid, f"{t['function']}: built")
        ds._exec("UPDATE sddi_instances SET status = %s, error = %s, updated_at = %s WHERE id = %s",
                 ("failed" if failed else "idle", "A transform failed to build" if failed else None, _now(), iid))
    except Exception as e:  # noqa: BLE001
        log.exception("SDDI build %s failed", iid)
        msg = e.detail if isinstance(e, HTTPException) else str(e)
        ds._exec("UPDATE sddi_instances SET status = 'failed', error = %s, updated_at = %s WHERE id = %s", (str(msg)[:2000], _now(), iid))


# --------------------------------------------------------------------------------------------
# 3. ontology changes
# --------------------------------------------------------------------------------------------


def _output_item(folder_path: str, name: str) -> Optional[dict]:
    """A built output dataset the caller may read (its markings, a role that reads its Project); None otherwise."""
    try:
        item = cr.resolve_dataset(f"{folder_path.rstrip('/')}/{name}")
    except (ValueError, HTTPException):
        return None
    return item if auth.can_access(item["id"]) else None


def _plan(row: dict) -> dict:
    import ontology

    sc, pc = _configs(row)
    out = (pc.get("outputFolder") or "").rstrip("/")
    types = {t: [str(x).upper() for x in (v or {}).get("types") or ["OBJECT"]] for t, v in (pc.get("tables") or {}).items()}
    # object types the caller holds the markings of (a hidden one is neither named nor counted as existing)
    existing = {t["api_name"].lower(): t for t in auth.visible_resources("object_type", ontology._all("object-types"))}
    made = row["ontology"].get("object_types") or {}
    objects, by_table = [], {}
    for t in sc.get("tables") or []:
        n = t["tableName"]
        if "OBJECT" not in types.get(n, ["OBJECT"]):
            continue
        display = (pc.get("tables") or {}).get(n, {}).get("displayName") or n
        renamed = not pc.get("disableRenamedStage")
        item = _output_item(out, f"{display} ({n})") if renamed else _output_item(f"{out}/final", n)
        api = ontology._api_name(display if display != n else n, True)
        cols = []
        if item:
            try:
                cols = [f.name for f in pq.read_schema(io.BytesIO(drive.read_bytes(item)))]
            except Exception:  # noqa: BLE001
                cols = []
        title = next((c for c in cols if re.search(r"(name|title|description|label)", c, re.I) and c != "primary_key"), "primary_key")
        state = "created" if n in made and existing.get(made[n]["api_name"].lower()) else ("exists" if api.lower() in existing else ("ready" if item and "primary_key" in cols else "not built"))
        objects.append({"table": n, "display_name": display, "api_name": api, "dataset": {"id": item["id"], "name": item["name"]} if item else None,
                        "primary_key": "primary_key", "title": title, "properties": len(cols), "state": state,
                        "object_type_id": (made.get(n) or {}).get("id") or (existing.get(api.lower()) or {}).get("id")})
        by_table[n] = cols
    metadata = _output_item(f"{out}/metadata", "links")
    links = []
    if metadata:
        rows = pq.read_table(io.BytesIO(drive.read_bytes(metadata))).to_pylist()
        names = {o["table"] for o in objects}
        for r in rows:
            fk = f"{r['ref_table']}_|_foreign_key"
            if r["table_name"] in names and r["ref_table"] in names and r["table_name"] != r["ref_table"] and fk in by_table.get(r["table_name"], []):
                links.append({"from": r["table_name"], "to": r["ref_table"], "foreign_key": fk, "constraint": r["constraint_name"],
                              "state": "created" if any(x.get("constraint") == r["constraint_name"] for x in row["ontology"].get("link_types") or []) else "ready"})
    return {"object_types": objects, "link_types": links}


@router.get("/{iid}/ontology")
def ontology_preview(iid: str) -> dict:
    return _plan(_instance(iid))


class OntologyIn(BaseModel):
    tables: Optional[list[str]] = None


@router.post("/{iid}/ontology")
def ontology_apply(iid: str, req: OntologyIn) -> dict:
    """Create the previewed object types (backed by the built datasets) and link types in bulk."""
    import ontology
    import ontology_datasources
    import ontology_model

    # it reads the repository's configuration and changes the instance: Editors of the generator repository (the
    # object and link types are checked by the ontology functions themselves)
    row = _instance(iid, "editor")
    plan = _plan(row)
    made = dict(row["ontology"].get("object_types") or {})
    links_made = list(row["ontology"].get("link_types") or [])
    created, skipped = [], []
    for o in plan["object_types"]:
        if req.tables is not None and o["table"] not in req.tables:
            continue
        if o["state"] != "ready":
            skipped.append({"table": o["table"], "reason": o["state"]})
            continue
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=o["display_name"], api_name=o["api_name"], description=f"{o['table']} (SDDI {row['name']})",
            properties=[ontology.Property(api_name="sddiKey", display_name="Primary key", type="string")], primary_key="sddiKey"))
        ontology_datasources.put_datasource(t["id"], ontology_datasources.DatasourceIn(dataset_id=o["dataset"]["id"], columns={"primary_key": "sddiKey"}, map_unmapped=True))
        title_api = next((p["api_name"] for p in ontology._object_type(t["id"])["properties"] if p.get("display_name") and o["title"] != "primary_key"
                          and ontology_datasources._display(o["title"]) == p["display_name"]), None)
        if title_api:
            ontology.update_object_type(t["id"], ontology.ObjectTypeIn(title_property=title_api))
        made[o["table"]] = {"id": t["id"], "api_name": t["api_name"]}
        created.append(t["api_name"])
    for lk in plan["link_types"]:
        if lk["state"] != "ready" or lk["from"] not in made or lk["to"] not in made:
            continue
        src = ontology._object_type(made[lk["from"]]["id"])
        backing = (src.get("backing_dataset") or {}).get("columns") or {}
        fk_prop = backing.get(lk["foreign_key"])
        if not fk_prop:
            continue
        lt = ontology_model.create_link_type(ontology_model.LinkTypeIn(
            kind="foreign_key", cardinality="many_to_one", foreign_key=fk_prop,
            source=ontology_model.LinkSide(object_type_id=made[lk["from"]]["id"]), target=ontology_model.LinkSide(object_type_id=made[lk["to"]]["id"])))
        links_made.append({"id": lt["id"], "constraint": lk["constraint"], "from": lk["from"], "to": lk["to"]})
        created.append(f"{lk['from']} → {lk['to']}")
    ds._exec("UPDATE sddi_instances SET ontology = %s, updated_at = %s WHERE id = %s", (Jsonb({"object_types": made, "link_types": links_made}), _now(), iid))
    if created:
        _progress(iid, f"Ontology: created {', '.join(created)}")
    return {**_plan(_row(iid)), "created": created, "skipped": skipped}


# --------------------------------------------------------------------------------------------
# migrating to V2, severing
# --------------------------------------------------------------------------------------------


@router.get("/{iid}/migration")
def migration_preview(iid: str) -> dict:
    """The HyperAuto V2 configuration a migration creates, and what V2 does not carry over."""
    row = _instance(iid)
    sc, pc = _configs(row)
    types = {t: [str(x).upper() for x in (v or {}).get("types") or ["OBJECT"]] for t, v in (pc.get("tables") or {}).items()}
    tables, notes = [], []
    for t in sc.get("tables") or []:
        n = t["tableName"]
        tc = t.get("datasetTransformsConfig") or {}
        ty = types.get(n, ["OBJECT"])
        if ty == ["METADATA"]:
            notes.append(f"{n}: METADATA-only tables are not inputs in V2 (V2 reads keys and relations from the source catalog)")
            continue
        role = "enrichment" if "CUSTOMIZATION" in ty and "OBJECT" not in ty else "object"
        cmp = list((sc.get("deduplicationConfig") or {}).get("comparisonColumns") or []) + list(tc.get("deduplicationComparisonColumns") or [])
        if len(cmp) > 1:
            notes.append(f"{n}: V2 orders deduplication by one column ({cmp[0]}); {', '.join(cmp[1:])} are dropped")
        if tc.get("batchUnionComponents"):
            notes.append(f"{n}: batch union components ({', '.join(tc['batchUnionComponents'])}) are not supported in V2 — union them upstream and use a folder-based pipeline")
        if tc.get("tableCleaningLibraries"):
            notes.append(f"{n}: custom cleaning functions ({', '.join(tc['tableCleaningLibraries'])}) are not supported in V2 — implement them downstream")
        if tc.get("changeModeColumn") or (sc.get("deduplicationConfig") or {}).get("changeModeColumn"):
            notes.append(f"{n}: change mode deletes are not applied by V2")
        sync_id = (row["syncs"].get(n) or {}).get("id")
        tables.append({"name": n, "role": role, "sync_id": sync_id, "ordering": cmp[0] if cmp else None})
    if [x for x in sc.get("cleaningLibraries") or [] if x != "convert_all_columns_to_clean_types"]:
        notes.append("Global cleaning libraries other than convert_all_columns_to_clean_types are not supported in V2 (V2 applies its own data cleaning)")
    notes.append(f"Keys: V2 does not prefix primary and foreign keys with the source name ({sc.get('sourceName')}) and has no `source` column")
    notes.append("Foreign keys: V2 generates them conservatively (only declared relations to object tables with a key); column names follow V2's renaming")
    if pc.get("workflows"):
        notes.append("Workflows and enrichments of PipelineConfig.yaml are not carried over")
    options = {"automatic_joins": not pc.get("disableEnrichedStage"), "readable_columns": not pc.get("disableRenamedStage"),
               "readable_names": not pc.get("disableRenamedStage"), "foreign_keys": not pc.get("disableForeignKeyGeneration"),
               "primary_keys": True, "deduplicate": True, "cleaning": True, "incremental": False,
               "ontology": False, "language_column": None, "language_value": None}
    return {"name": f"{row['name']} (V2)", "tables": tables, "options": options, "notes": notes}


class MigrateIn(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    ontology: bool = False


@router.post("/{iid}/migrate")
def migrate(iid: str, req: MigrateIn) -> dict:
    """Create a HyperAuto V2 pipeline that replicates this configuration and consumes the same inputs (the V1
    repository keeps running; point consumers at the V2 outputs gradually). Editors of the generator repository."""
    row = _instance(iid, "editor")
    plan = migration_preview(iid)
    if not plan["tables"]:
        raise HTTPException(400, "No tables to migrate")
    cfg = hyperauto.Config(tables=[hyperauto.TableIn(**t) for t in plan["tables"]], options=hyperauto.Options(**{**plan["options"], "ontology": req.ontology}))
    v2 = hyperauto.create(hyperauto.NewHyperAuto(name=req.name or plan["name"], source=_source(row), config=cfg))
    ds._exec("UPDATE sddi_instances SET migrated_to = %s, updated_at = %s WHERE id = %s", (v2["id"], _now(), iid))
    _progress(iid, f"Migration: created the HyperAuto V2 pipeline {v2['name']}")
    return {"v2": v2, "notes": plan["notes"]}


@router.post("/{iid}/sever")
def sever(iid: str) -> dict:
    """Sever the repository from the SDDI template: it becomes a regular Python transforms repository, and the
    Cockpit stops opening pull requests for it. It changes the repository's settings: its Owners."""
    row = _instance(iid, "owner")
    with cr._lock:
        rec = _code_repo(row["repo_id"], "owner")
        rec.pop("template", None)
        cr._save(rec)
    ds._exec("UPDATE sddi_instances SET severed = true, updated_at = %s WHERE id = %s", (_now(), iid))
    _progress(iid, "Severed the repository from the SDDI template")
    return _view(iid)

