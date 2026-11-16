"""Ontology SQL functions (palantir.com/docs/foundry/sql-warehousing/sql-functions): a saved object mode worksheet
published as a read-only query function of the functions registry (functions_registry.py).

    DECLARE @animalParam STRING = 'dog', @animals `ri.ontology.main.object-type.<id>`;
    SELECT * FROM @animals WHERE animaltype = @animalParam;

Literal variables become inputs of their type (their value is the default used when testing in the editor); an
object set variable becomes an object set input (the objects passed, or every object of the type when it is left
empty). The function returns a list of structs whose fields are the selected columns, or a list of the column's type
when one column is selected. Each Publish is a new release of the function (1.0.0, 1.1.0, …; a changed signature is
checked for breaking changes like any other function); it can then be used wherever functions are: Workshop, Actions,
Automate and the API gateway (/api/functions/queries/<apiName>/execute). It reads with the caller's permissions.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth

router = APIRouter(prefix="/api/sql")
REPO_PREFIX = "sqlws-"
LITERAL_TYPES = {"string": "string", "varchar": "string", "char": "string", "int": "integer", "integer": "integer", "smallint": "integer",
                 "tinyint": "integer", "bigint": "long", "long": "long", "double": "double", "float": "double", "real": "double",
                 "decimal": "double", "boolean": "boolean", "bool": "boolean", "date": "date", "timestamp": "timestamp"}
ARROW_TO_TYPE = (("int", "long"), ("uint", "long"), ("double", "double"), ("float", "double"), ("decimal", "double"), ("bool", "boolean"),
                 ("date", "date"), ("timestamp", "timestamp"), ("string", "string"), ("large_string", "string"))


def declarations(sql: str) -> tuple[list[dict], str]:
    """The DECLARE variables of an Ontology SQL query ({name, sql_type, type, default, object_type}) and the query
    after the DECLARE statement."""
    m = re.match(r"^\s*DECLARE\s+(.+?);", sql, re.S | re.I)
    if not m:
        return [], sql
    out = []
    for part in _split(m.group(1)):
        v = re.match(r"^\s*@([A-Za-z0-9_]+)\s+(`[^`]+`|[A-Za-z]+(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)\s*(?:=\s*(.+?))?\s*$", part, re.S)
        if not v:
            raise HTTPException(400, f"cannot read the declaration {part.strip()!r} (write @name TYPE = value)")
        name, typ, value = v.group(1), v.group(2), v.group(3)
        if typ.startswith("`"):
            out.append({"name": name, "object_type": typ.strip("`"), "sql_type": None, "type": None, "default": None})
        else:
            base = typ.lower().split("(")[0]
            if base not in LITERAL_TYPES:
                raise HTTPException(400, f"@{name}: parameters hold literal values ({', '.join(sorted(set(LITERAL_TYPES)))}), not {typ}")
            out.append({"name": name, "sql_type": typ, "type": LITERAL_TYPES[base], "default": value.strip() if value else None, "object_type": None})
    return out, sql[m.end():]


def _split(text: str) -> list[str]:
    parts, cur, depth, quote = [], "", 0, None
    for ch in text:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += ch
    parts.append(cur)
    return [p for p in parts if p.strip()]


def _literal(v: Any, typ: str) -> str:
    if v is None:
        return "NULL"
    if typ in ("integer", "long"):
        return str(int(v))
    if typ == "double":
        return repr(float(v))
    if typ == "boolean":
        return "TRUE" if (v is True or str(v).lower() in ("true", "1", "yes")) else "FALSE"
    return "'" + str(v).replace("'", "''") + "'"


def _object_type(ref: str) -> dict:
    import sql_studio

    return sql_studio._object_type_of(ref)


def bind(sql: str, values: dict, decls: Optional[list[dict]] = None) -> str:
    """The query with the inputs in place of the DECLARE defaults (object sets narrowed to the objects passed)."""
    decls = declarations(sql)[0] if decls is None else decls
    _, body = declarations(sql)
    parts = []
    for d in decls:
        v = values.get(d["name"])
        if d["object_type"]:
            pks = None
            if isinstance(v, dict):
                pks = (v.get("__object_set__") or v).get("primary_keys")
            elif isinstance(v, list):
                pks = v
            if pks:
                ot = _object_type(d["object_type"])
                keys = ", ".join(_literal(str(k), "string") for k in pks)
                body = re.sub(rf"@{d['name']}\b", lambda _m, ot=ot, keys=keys: f"(SELECT * FROM `{d['object_type']}` WHERE CAST(`{ot['primary_key']}` AS STRING) IN ({keys}))", body)
            else:
                parts.append(f"@{d['name']} `{d['object_type']}`")
        else:
            value = _literal(v, d["type"]) if d["name"] in values else (d["default"] or "NULL")
            parts.append(f"@{d['name']} {d['sql_type']} = {value}")
    return (f"DECLARE {', '.join(parts)};\n" if parts else "") + body


def _output(columns: list[dict]) -> str:
    def t(arrow: str) -> str:
        a = arrow.lower()
        return next((v for k, v in ARROW_TO_TYPE if a.startswith(k)), "any")

    if len(columns) == 1:
        return f"array<{t(columns[0]['type'])}>"
    return "array<struct<" + ",".join(f"{c['name']}:{t(c['type'])}" for c in columns) + ">>"


def invoke(sig: dict, args: dict) -> dict:
    import sql_studio

    try:
        res = sql_studio.run(bind(sig["sql"], args or {}), "object", sql_studio.PREVIEW_LIMITS[1])
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail), "category": "invalid_inputs" if e.status_code == 400 else None}
    names = [c["name"] for c in res["columns"]]
    if len(names) == 1:
        value = [r[0] for r in res["rows"]]
    else:
        value = [dict(zip(names, r)) for r in res["rows"]]
    return {"ok": True, "value": value, "logs": f"{res['row_count']} rows in {res['ms']} ms" + (" (truncated)" if res.get("truncated") else "")}


class PublishIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    api_name: str = Field(min_length=1, max_length=100)
    description: str = Field("", max_length=2000)


@router.post("/worksheets/{ws_id}/publish-function")
def publish(ws_id: str, req: PublishIn) -> dict:
    """Publish the saved worksheet's query as an Ontology SQL function (a new release each time)."""
    import functions_registry as F
    import sql_studio

    ws = sql_studio._ws(ws_id, "write")
    if not ws.get("item_id"):
        raise HTTPException(400, "save the worksheet to a Project before publishing a function")
    if ws.get("mode") != "object":
        raise HTTPException(400, "functions are written in object mode (Ontology SQL)")
    sql = (ws.get("sql") or "").strip()
    if not sql:
        raise HTTPException(400, "the worksheet is empty")
    if not re.fullmatch(r"[a-z][A-Za-z0-9]{0,98}", req.api_name):
        raise HTTPException(400, "an API name is lowerCamelCase, under 100 characters")
    decls, _ = declarations(sql)
    test = sql_studio.run(sql, "object")  # runs with the defaults: the query must work as published
    repo_id = REPO_PREFIX + ws_id
    fid = F.fid_of(repo_id, "worksheet.sql", "query")
    inputs = []
    for d in decls:
        if d["object_type"]:
            ot = _object_type(d["object_type"])
            inputs.append({"name": d["name"], "type": f"object_set:{ot['api_name']}", "required": False})
        else:
            inputs.append({"name": d["name"], "type": d["type"], "required": d["default"] is None,
                           **({"default": _default_value(d)} if d["default"] is not None else {})})
    fn = {"id": fid, "name": req.name.strip(), "file": "worksheet.sql", "doc": req.description.strip() or f"Ontology SQL function published from {ws['name']}",
          "line": 0, "inputs": inputs, "output": _output(test["columns"]), "api_name": req.api_name, "edits": None, "sources": [], "errors": [],
          "kind": "query", "source": "sql", "sql": sql, "worksheet_id": ws_id}
    with F._lock:
        clash = [g for g in F.all_functions() if g.get("api_name") == req.api_name and g["id"] != fid]
        if clash:
            raise HTTPException(409, f"the API name {req.api_name} is used by {clash[0]['name']}")
        d = F._repo_data(repo_id)
        prev = max(d["releases"], key=lambda r: F.parse(r["version"]), default=None)
        version = "1.0.0" if prev is None else "{}.{}.0".format(*F.parse(prev["version"])[:1], F.parse(prev["version"])[1] + 1)
        breaking = F.compatibility(prev["functions"], [fn]) if prev else []
        if breaking:
            version = f"{F.parse(prev['version'])[0] + 1}.0.0"
        d["releases"].append({"version": version, "commit": "", "at": F._now(), "by": (auth.current() or {}).get("username") or "local",
                              "functions": [fn], "breaking": breaking, "warning": False})
        d["worksheet_id"] = ws_id
        F._save_repo(repo_id, d)
    return {"function_id": fid, "version": version, "rid": f"ri.function-registry.main.function.{fid[3:]}", "output": fn["output"], "inputs": inputs,
            "breaking": breaking}


def _default_value(d: dict) -> Any:
    raw = (d["default"] or "").strip()
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    try:
        return int(raw) if d["type"] in ("integer", "long") else float(raw) if d["type"] == "double" else raw.lower() == "true" if d["type"] == "boolean" else raw
    except ValueError:
        return raw


@router.get("/worksheets/{ws_id}/function")
def published(ws_id: str) -> dict:
    """The function published from a worksheet, if any."""
    import functions_registry as F
    import sql_studio

    sql_studio._ws(ws_id, "read")
    d = F._repo_data(REPO_PREFIX + ws_id)
    if not d["releases"]:
        return {"function": None}
    last = max(d["releases"], key=lambda r: F.parse(r["version"]))
    f = last["functions"][0]
    return {"function": {"id": f["id"], "name": f["name"], "api_name": f["api_name"], "version": last["version"], "output": f["output"], "inputs": f["inputs"],
                         "at": last["at"], "releases": len(d["releases"])}}


def visible(repo_id: str) -> Optional[dict]:
    """The pseudo repository of a worksheet's function when the caller can open the worksheet."""
    import sql_studio

    try:
        ws = sql_studio._ws(repo_id[len(REPO_PREFIX):], "read")
    except HTTPException:
        return None
    return {"id": repo_id, "name": f"SQL worksheet {ws['name']}"}
