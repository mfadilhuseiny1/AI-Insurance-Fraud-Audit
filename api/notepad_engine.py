"""Notepad widgets, templates, versions, links and exports (Analytics doc 07); notepad.py holds the routes.

Widget blocks ({type: "widget", kind, config, children, locked}):
- object_property / object_card: an object's property (or several) — the object is fixed ({object_type_id, pk}), a
  template input ({input}) or the surrounding generator's object ({generator: true}). With Allow editing, properties
  that have an inline edit action are edited in place; a card can show Action buttons for its object.
- contour_chart: a board of a Contour path with parameter overrides (values, template inputs or a JSON string).
- object_markdown: the Object property Markdown editor — a Markdown property shown as rich text, editable (Allow
  editing) through the property's inline edit action; the value it was read with guards against overwriting a newer one.
- object_media: an object's media property (images, PDFs, video, audio) — the object as for object_property.
- map: the geopoints of an object set (an object type's objects, a template input, or linked to the generator's
  object), with a label property; 5,000 points at most.
- quiver_chart / quiver_dashboard: a Quiver card (transform table, chart, value, Vega plot: data from the server;
  time series plots and cards: drawn by the browser from the analysis) or a dashboard. A dashboard widget embeds a
  published dashboard ({dashboard_item_id, version, auto_update, inputs}: a pinned version, or the latest with
  Auto-update; its inputs — the root object, parameter cards and selector cards — mapped from fixed values, template
  inputs or the generator's object) or, in documents made before, an analysis' dashboard ({analysis_id}).
- code_workbook_chart: a Code Workbook node run with what it needs upstream — its matplotlib figures, or its table.
- solution_diagram: a Solution Designer diagram (read-only; exports list its components and connections).
- vertex_graph: a saved Vertex graph (its objects, links, transactional edges, layers and positions), read-only.
- function: a function's result (plain text or Markdown); inside a generator it can run batched over the
  generator's objects (one call returning {primary key: value}).
- value_embed: a template input's value. latex, user_mention, anchor_link, resource_link: native widgets.
- section_generator / table_row_generator: the children (or a table row) once per object of an object set — a
  template input, or the objects linked to the generator's object (nested one level; 30 / 100 objects; rows 1,000).
- conditional_section: the children when a string input satisfies a rule.

Envelope security (a document setting chosen at creation): the document's own markings are the envelope. Only
ENVELOPE_WIDGETS are allowed, objects whose markings (object type markings, mandatory control values) fall outside the
envelope are refused even for viewers cleared for them — so every viewer sees the same content — and exports carry the
document's markings as their banner.

Locked widgets keep a snapshot of their data ({at, by, data}) instead of reading live data.
"""

from __future__ import annotations

import copy
import io
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

import auth

WIDGET_KINDS = ("object_property", "object_card", "object_markdown", "object_media", "map", "contour_chart", "quiver_chart", "quiver_dashboard", "vertex_graph", "code_workbook_chart", "solution_diagram", "function", "value_embed", "latex", "user_mention", "anchor_link",
                "resource_link", "section_generator", "table_row_generator", "conditional_section")
CONTAINERS = ("section_generator", "conditional_section")
# generation limits: the defaults, and the most an admin can set (Notepad settings)
LIMIT_DEFAULTS = {"top": 30, "nested": 100, "rows": 1000}
LIMIT_MAX = {"top": 500, "nested": 2000, "rows": 10000}


def _settings_path() -> Path:
    import drive

    return drive.LOCAL_DIR.parent / "notepad_settings.json"


def limits() -> dict[str, int]:
    """The generation limits in force: objects per section generator (top level / nested) and table generator rows."""
    try:
        saved = json.loads(_settings_path().read_text("utf-8")).get("limits") or {}
    except (OSError, ValueError):
        saved = {}
    return {k: max(1, min(int(saved.get(k) or v), LIMIT_MAX[k])) for k, v in LIMIT_DEFAULTS.items()}


def save_limits(new: dict) -> dict[str, int]:
    cur = limits()
    for k, v in new.items():
        if k not in LIMIT_DEFAULTS:
            raise HTTPException(400, f"unknown limit {k}")
        if not isinstance(v, int) or not 1 <= v <= LIMIT_MAX[k]:
            raise HTTPException(400, f"{k} is a whole number from 1 to {LIMIT_MAX[k]}")
        cur[k] = v
    _settings_path().write_text(json.dumps({"limits": cur}), "utf-8")
    return cur
AUTOSAVE_SECONDS = 300


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _me() -> dict:
    u = auth.current() or {}
    return {"id": u.get("id"), "name": u.get("display_name") or u.get("username") or "local"}


def walk(blocks: list[dict]):
    """Every block, depth first (children of sections included)."""
    for b in blocks:
        yield b
        if b.get("children"):
            yield from walk(b["children"])


# ------------------------------------------------------------------ objects


ENVELOPE_WIDGETS = ("object_property", "object_card", "object_media", "object_markdown", "latex", "anchor_link", "user_mention")


class Ctx:
    """What a widget is evaluated with: template input values, the generator objects around it (innermost last) and,
    for an envelope-secured document, its envelope (the document's markings)."""

    def __init__(self, inputs: dict, defs: list[dict], objects: Optional[list[dict]] = None, envelope: Optional[set] = None) -> None:
        self.inputs, self.defs, self.objects, self.envelope = inputs, defs, objects or [], envelope

    def child(self, obj: dict) -> "Ctx":
        return Ctx(self.inputs, self.defs, self.objects + [obj], self.envelope)

    def input_def(self, name: str) -> dict:
        d = next((x for x in self.defs if x["name"] == name), None)
        if not d:
            raise HTTPException(400, f"unknown template input {name}")
        return d


def outside_envelope(o: dict, envelope: Optional[set]) -> list[str]:
    """The markings an object carries that the envelope does not (none: the object may be shown)."""
    if envelope is None:
        return []
    import ontology

    t = ontology._object_type(o["object_type_id"])
    need = set(auth.resource_markings("object_type", t["id"]))
    for p in t["properties"]:
        if p.get("mandatory_control"):
            v = o["properties"].get(p["api_name"])
            need |= {str(x) for x in (v if isinstance(v, list) else [v] if v else []) if not str(x).startswith("org:")}
    return sorted(need - envelope)


def _obj(type_id: str, pk: Any) -> dict:
    import ontology

    with ontology._lock:
        t = ontology._object_type(type_id)
        key, o = ontology._find(t, pk)
        pub = ontology._public_object(t, key, o)
    return {**pub, "type_name": t["display_name"],
            "labels": {p["api_name"]: p.get("display_name") or p["api_name"] for p in t["properties"]}}


def object_ref(ref: Any, ctx: Ctx) -> Optional[dict]:
    """An object reference ({object_type_id, pk} | {input} | {generator}) → the object, or None when unset."""
    if not isinstance(ref, dict):
        return None
    if ref.get("generator"):
        if not ctx.objects:
            raise HTTPException(400, "this widget reads the generator's object: put it inside a generator")
        return ctx.objects[-1 if ref.get("generator") is True else -1 - int(ref["generator"])]
    if ref.get("input"):
        d = ctx.input_def(ref["input"])
        v = ctx.inputs.get(d["name"])
        if v in (None, ""):
            return None
        return _obj(d.get("object_type_id") or "", v.get("pk") if isinstance(v, dict) else v)
    if ref.get("object_type_id") and ref.get("pk") not in (None, ""):
        return _obj(ref["object_type_id"], ref["pk"])
    return None


def _match(v: Any, want: Any) -> bool:
    return str(v) == str(want)


def object_set(spec: Any, ctx: Ctx, limit: int) -> list[dict]:
    """A generator's objects: a template input (list of keys, {where: {...}} or "*"), or linked to the generator object."""
    import ontology

    if not isinstance(spec, dict):
        return []
    if spec.get("input"):
        d = ctx.input_def(spec["input"])
        tid, v = d.get("object_type_id") or "", ctx.inputs.get(d["name"])
    elif spec.get("linked"):
        ln = spec["linked"]
        if not ctx.objects:
            raise HTTPException(400, "linked objects need a surrounding generator")
        parent = ctx.objects[-1]
        tid, v = ln["object_type_id"], {"where": {ln["property"]: parent["properties"].get(ln.get("parent_property") or "") if ln.get("parent_property") else parent["primary_key"]}}
    elif spec.get("object_type_id"):
        tid, v = spec["object_type_id"], spec.get("value", "*")
    else:
        return []
    if v in (None, "", []):
        return []
    with ontology._lock:
        t = ontology._object_type(tid)
        objs = {pk: o for pk, o in ontology._objects(tid).items() if ontology._can_see(t, o)}
        if isinstance(v, list):
            keys = [str(x.get("pk") if isinstance(x, dict) else x) for x in v]
        elif isinstance(v, dict) and v.get("where"):
            keys = [pk for pk, o in objs.items() if all(_match((o.get("properties") or {}).get(k), w) for k, w in v["where"].items())]
        else:
            keys = list(objs)
        rows = [ontology._public_object(t, k, objs[k]) for k in keys if k in objs]
    labels = {p["api_name"]: p.get("display_name") or p["api_name"] for p in t["properties"]}
    rows = [{**r, "type_name": t["display_name"], "labels": labels} for r in rows]
    sort = spec.get("sort") or {}
    if sort.get("property"):
        rows = rows[:2000]
        rows.sort(key=lambda r: (r["properties"].get(sort["property"]) is None, r["properties"].get(sort["property"]) if not isinstance(r["properties"].get(sort["property"]), (dict, list)) else str(r["properties"].get(sort["property"]))),
                  reverse=bool(sort.get("desc")))
    hard = max(limits()["rows"], limits()["nested"])
    return rows[: min(int(spec.get("limit") or limit), limit, hard)]


# ------------------------------------------------------------------ text


def fmt(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else f"{v:,.4f}".rstrip("0").rstrip(".")
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def input_text(name: str, ctx: Ctx) -> str:
    d = ctx.input_def(name)
    v = ctx.inputs.get(name)
    if d["type"] == "object" and v not in (None, ""):
        o = object_ref({"input": name}, ctx)
        return o["title"] if o else ""
    if d["type"] == "object_set" and isinstance(v, list):
        return ", ".join(fmt(x) for x in v)
    return fmt(v)


def subst(text: str, ctx: Ctx) -> str:
    """{{input}}, {{object.property}} (the generator's object), {{parent.property}} (the outer generator's)."""
    def one(m: re.Match) -> str:
        head, _, prop = m.group(1).strip().partition(".")
        if head in ("object", "parent") and ctx.objects:
            o = ctx.objects[-1] if head == "object" else (ctx.objects[-2] if len(ctx.objects) > 1 else None)
            if o is None:
                return m.group(0)
            return o["title"] if prop in ("", "title") else (o["primary_key"] if prop == "pk" else fmt(o["properties"].get(prop)))
        if any(d["name"] == head for d in ctx.defs) and not prop:
            return input_text(head, ctx)
        return m.group(0)

    return re.sub(r"\{\{\s*([A-Za-z_][\w.]*)\s*\}\}", one, text or "")


# ------------------------------------------------------------------ widget data


def _param_value(v: Any, ctx: Ctx) -> Any:
    if isinstance(v, dict) and v.get("input"):
        d = ctx.input_def(v["input"])
        val = ctx.inputs.get(d["name"])
        return (val.get("pk") if isinstance(val, dict) else val) if d["type"] == "object" else val
    if isinstance(v, dict) and v.get("object") and ctx.objects:
        o = ctx.objects[-1]
        return o["primary_key"] if v.get("object") is True else o["properties"].get(v["object"])
    return v.get("value") if isinstance(v, dict) and "value" in v else v


def function_inputs(cfg: dict, ctx: Ctx) -> dict:
    return {k: _param_value(v, ctx) for k, v in (cfg.get("inputs") or {}).items()}


def run_function(cfg: dict, inputs: dict) -> Any:
    import functions_registry

    if not cfg.get("function_id"):
        raise HTTPException(400, "choose a function")
    res = functions_registry.execute(cfg["function_id"], inputs, cfg.get("version") or None, resource="notepad")
    if not res.get("ok"):
        raise HTTPException(400, f"the function failed: {res.get('error')}")
    return res.get("value")


def widget_data(b: dict, ctx: Ctx, batched: Optional[dict] = None) -> dict:
    """The data a widget shows, read with the viewer's permissions."""
    c = b.get("config") or {}
    k = b["kind"]
    if ctx.envelope is not None and k not in ENVELOPE_WIDGETS:
        return {"error": "this widget is not supported in an envelope-secured document"}
    if ctx.envelope is not None and k in ("object_property", "object_card", "object_media", "object_markdown"):
        o = object_ref(c.get("object"), ctx)
        if o and outside_envelope(o, ctx.envelope):
            return {"error": "this object's markings are outside the document's envelope"}
    if k in ("object_property", "object_card"):
        o = object_ref(c.get("object"), ctx)
        if not o:
            return {"empty": True}
        import ontology

        base = {"title": o["title"], "object_type_id": o["object_type_id"], "pk": o["primary_key"], "type_name": o["type_name"]}
        t = ontology._object_type(o["object_type_id"])
        inline = {p["api_name"] for p in t["properties"] if p.get("inline_edit_action_id")} if c.get("allow_edit") else set()
        if k == "object_property":
            prop = c.get("property") or ""
            v = o["title"] if not prop else o["properties"].get(prop)
            return {**base, "property": prop, "label": o["labels"].get(prop, "Title") if prop else "Title", "value": fmt(v) if v not in (None, "") else (c.get("empty_text") or ""),
                    "raw": v, "editable": prop in inline}
        props = c.get("properties") or list(o["labels"])[:8]
        acts = []
        for aid in c.get("actions") or []:
            try:
                a = ontology._action_type(aid)
                acts.append({"id": a["id"], "display_name": a.get("display_name") or a["id"]})
            except HTTPException:
                continue  # a deleted action type: no button
        return {**base, "properties": [{"name": p, "label": o["labels"].get(p, p), "value": fmt(o["properties"].get(p)), "raw": o["properties"].get(p),
                                        "editable": p in inline} for p in props], "actions": acts}
    if k == "object_markdown":
        import ontology

        o = object_ref(c.get("object"), ctx)
        if not o or not c.get("property"):
            return {"empty": True}
        t = ontology._object_type(o["object_type_id"])
        prop = next((x for x in t["properties"] if x["api_name"] == c["property"]), None)
        v = o["properties"].get(c["property"])
        return {"title": o["title"], "object_type_id": o["object_type_id"], "pk": o["primary_key"], "property": c["property"],
                "label": o["labels"].get(c["property"], c["property"]), "value": "" if v is None else str(v),
                "editable": bool(c.get("allow_edit")) and bool(prop and prop.get("inline_edit_action_id"))}
    if k == "object_media":
        o = object_ref(c.get("object"), ctx)
        if not o or not c.get("property"):
            return {"empty": True}
        v = o["properties"].get(c["property"])
        refs = [str(x) for x in (v if isinstance(v, list) else [v]) if x not in (None, "")]
        return {"title": o["title"], "object_type_id": o["object_type_id"], "pk": o["primary_key"], "label": o["labels"].get(c["property"], c["property"]), "refs": refs}
    if k == "map":
        import geo

        if not c.get("object_set") or not c.get("property"):
            return {"empty": True}
        objs = object_set(c["object_set"], ctx, 5000)
        points, skipped = [], 0
        for o in objs:
            v = o["properties"].get(c["property"])
            try:
                lat, lon = geo.lat_lon(v)
            except Exception:  # noqa: BLE001 — objects without a usable geopoint are counted, not drawn
                skipped += 1
                continue
            points.append({"lat": lat, "lon": lon, "title": fmt(o["properties"].get(c["label"])) if c.get("label") else o["title"],
                           "pk": o["primary_key"], "object_type_id": o["object_type_id"]})
        return {"points": points, "skipped": skipped, "type_name": objs[0]["type_name"] if objs else ""}
    if k == "contour_chart":
        import contour

        if not (c.get("analysis_id") and c.get("path_id") and c.get("board_id")):
            return {"empty": True}
        item = contour._item(c["analysis_id"])
        a = contour._load(item)
        params = {}
        if c.get("params_json"):
            try:
                params.update(json.loads(subst(c["params_json"], ctx)))
            except ValueError:
                raise HTTPException(400, "the parameter JSON is not valid") from None
        params.update({n: _param_value(v, ctx) for n, v in (c.get("params") or {}).items() if v not in (None, "")})
        path = next((p for p in a["paths"] if p["id"] == c["path_id"]), None)
        board = next((x for x in (path or {}).get("boards") or [] if x["id"] == c["board_id"]), None)
        if not board:
            return {"error": "the board is no longer in the analysis"}
        r = contour.run_path(a, c["path_id"], params)
        return {"analysis": a["title"], "path": path["name"], "board": board, "result": r["boards"].get(board["id"]) or {}, "params": r.get("params") or {}}
    if k in ("quiver_chart", "quiver_dashboard"):
        import quiver_tables
        import ts_derived

        if k == "quiver_dashboard" and c.get("dashboard_item_id"):
            return published_dashboard(c, ctx)
        if not c.get("analysis_id") or (k == "quiver_chart" and not c.get("card_id")):
            return {"empty": True}
        a = ts_derived._analysis(c["analysis_id"])
        tables = {x["id"]: x for x in a.get("object_sets") or [] if x.get("kind") in quiver_tables.TABLE_KINDS}
        if k == "quiver_dashboard":
            return {"analysis": a, "tables": dashboard_tables(a), "client": True}
        if c["card_id"] in tables:
            card = tables[c["card_id"]]
            wanted = {card["id"], *(card.get("tables") or [])}
            return {"analysis_name": a["name"], "card": card, "results": quiver_tables.run_cards(a, wanted, object_rows=quiver_tables.EMBED_OBJECTS)}
        return {"analysis": a, "card_id": c["card_id"], "client": True}
    if k == "code_workbook_chart":
        import code_workbook as cw

        if not (c.get("workbook_id") and c.get("node_id")):
            return {"empty": True}
        item = cw._item(c["workbook_id"])
        w = cw._load(item)
        b = cw._branch(w, c.get("branch") or "master")
        node = next((n for n in b["nodes"] if n["id"] == c["node_id"]), None)
        if not node:
            return {"error": "the node is no longer in the workbook"}
        res = (cw.run_graph(w, b, [node["id"]], preview_rows=50).get("nodes") or {}).get(node["name"]) or {}
        if res.get("error"):
            return {"error": f"{node['name']}: {res['error']}"}
        show = c.get("show") or ("figures" if res.get("figures") else "table")
        out = {"workbook": w.get("title", ""), "node": node["name"], "show": show}
        return {**out, "figures": res.get("figures") or []} if show == "figures" else {**out, "columns": res.get("columns") or [], "rows": res.get("rows") or [], "total": res.get("total")}
    if k == "solution_diagram":
        import solution_designer as sdz

        if not c.get("diagram_id"):
            return {"empty": True}
        d = sdz.get_diagram(c["diagram_id"])
        return {"name": d.get("name") or d.get("title") or "", "graph": d["graph"]}
    if k == "vertex_graph":
        import ontology
        import vertex

        if not c.get("graph_id"):
            return {"empty": True}
        g = vertex._graph(c["graph_id"])
        r = vertex.resolve({"nodes": g.get("nodes") or [], "scenario_id": g.get("scenario_id"), "edge_groups": g.get("edge_groups") or []})
        tids = {n["object_type_id"] for n in r["nodes"]}
        # index: the type's place among all object types (Vertex colors types by it)
        types = [{"id": t["id"], "display_name": t["display_name"], "icon": t.get("icon"), "index": i} for i, t in enumerate(ontology._all("object-types")) if t["id"] in tids]
        keep = ("id", "name", "nodes", "layout", "layers", "edge_styles", "edge_groups", "line_type")
        return {"graph": {x: g.get(x) for x in keep}, "nodes": r["nodes"], "edges": r["edges"], "grouped_edges": r["grouped_edges"], "types": types}
    if k == "function":
        if batched is not None:
            if not ctx.objects:
                return {"value": ""}
            pk = ctx.objects[-1]["primary_key"]
            return {"value": fmt(batched.get(pk, batched.get(f"{ctx.objects[-1]['object_type_id']}:{pk}"))), "markdown": bool(c.get("markdown"))}
        return {"value": fmt(run_function(c, function_inputs(c, ctx))), "markdown": bool(c.get("markdown"))}
    if k == "value_embed":
        return {"value": input_text(c["input"], ctx) if c.get("input") else ""}
    if k == "user_mention":
        u = next((x for x in auth._users() if x["id"] == c.get("user_id")), None)
        return {"name": (u.get("display_name") or u["username"]) if u else c.get("label") or "unknown user"}
    if k == "resource_link":
        import drive

        if not c.get("item_id"):
            return {"empty": True}
        try:
            it = drive._item(c["item_id"])
        except HTTPException:
            return {"error": "you cannot open this resource"}
        return {"name": it["name"], "kind": it["kind"], "content_type": it.get("content_type")}
    if k == "table_row_generator":
        return {"headers": c.get("headers") or [], "rows": generated_rows(b, ctx)}
    if k == "conditional_section":
        return {"shown": condition(c, ctx)}
    if k == "section_generator":
        return {"objects": [o["title"] for o in object_set(c.get("object_set"), ctx, limits()["top"] if not ctx.objects else limits()["nested"])]}
    return {}


def condition(c: dict, ctx: Ctx) -> bool:
    v = fmt(ctx.inputs.get(c.get("input") or "")) if c.get("input") else ""
    want = str(c.get("value") or "")
    op = c.get("op") or "eq"
    return {"eq": v == want, "neq": v != want, "contains": want.lower() in v.lower(), "empty": v == "", "not_empty": v != ""}.get(op, False)


def generated_rows(b: dict, ctx: Ctx) -> list[list[str]]:
    c = b.get("config") or {}
    objs = object_set(c.get("object_set"), ctx, limits()["rows"])
    batched = _batched(c, ctx, objs)
    rows = []
    for o in objs:
        cx = ctx.child(o)
        row = []
        for cell in c.get("cells") or []:
            if isinstance(cell, dict) and cell.get("function"):
                row.append(fmt((batched or {}).get(o["primary_key"])) if batched is not None else fmt(run_function(cell["function"], function_inputs(cell["function"], cx))))
            else:
                row.append(subst(cell if isinstance(cell, str) else cell.get("text", ""), cx))
        rows.append(row)
    return rows


def _batched(c: dict, ctx: Ctx, objs: list[dict]) -> Optional[dict]:
    """A batched function cell: one call over the generator's objects returning {primary key: value}."""
    fn = next((cell["function"] for cell in c.get("cells") or [] if isinstance(cell, dict) and (cell.get("function") or {}).get("batched")), None)
    if not fn or not objs:
        return None
    inputs = function_inputs(fn, ctx)
    inputs[fn.get("set_input") or "objects"] = {"object_type_id": objs[0]["object_type_id"], "primary_keys": [o["primary_key"] for o in objs]}
    v = run_function(fn, inputs)
    if not isinstance(v, dict):
        raise HTTPException(400, "a batched function returns a map of primary keys to values")
    return {str(k).split(":")[-1]: x for k, x in v.items()}


def dashboard_tables(a: dict, selections: Optional[dict] = None) -> dict:
    """An embedded Quiver dashboard's table cards. With a reader's selections in its selector cards they are run with
    those (for this answer only: the analysis and the document keep the saved defaults, which exports show)."""
    import quiver_tables

    if selections:
        a, _ = quiver_tables.apply_selections(a, selections)
    tables = {x["id"] for x in a.get("object_sets") or [] if x.get("kind") in quiver_tables.TABLE_KINDS}
    wanted = {x for x in (a.get("dashboard") or {}).get("cards") or [] if x in tables}
    return quiver_tables.run_cards(a, wanted, object_rows=quiver_tables.EMBED_OBJECTS) if wanted else {}


def run_dashboard(b: dict, ctx: Ctx, selections: dict) -> dict:
    """A Quiver dashboard widget re-run with a reader's selections: {selections applied, tables}."""
    import quiver_tables
    import ts_derived

    if b.get("kind") != "quiver_dashboard":
        raise HTTPException(400, "only a Quiver dashboard widget takes selections")
    if ctx.envelope is not None and b["kind"] not in ENVELOPE_WIDGETS:
        raise HTTPException(400, "this widget is not supported in an envelope-secured document")
    if b.get("locked"):
        raise HTTPException(400, "the widget's data is locked: update its data to change selections")
    if (b.get("config") or {}).get("dashboard_item_id"):
        d = published_dashboard(b["config"], ctx, selections)
        return {"selections": d["reader_selections"], "tables": d["tables"]}
    aid = (b.get("config") or {}).get("analysis_id")
    if not aid:
        raise HTTPException(400, "the widget has no Quiver analysis")
    a = ts_derived._analysis(aid)
    _, applied = quiver_tables.apply_selections(a, selections)
    return {"selections": applied, "tables": dashboard_tables(a, selections)}


# ------------------------------------------------------------------ published Quiver dashboards

# Quiver input type → the Notepad input types that can be mapped to it (the doc's mapping table)
DASHBOARD_INPUT_TYPES = {"Boolean": ("string",), "Number": ("number",), "String": ("string",), "Time": ("timestamp", "date"),
                         "Time Range": ("string",), "Object": ("object",), "Object Set": ("object_set",), "String List": ("string",)}
_PARAM_TYPES = {"param_number": "Number", "param_string": "String", "param_boolean": "Boolean", "param_datetime": "Time",
                "param_range": "Time Range", "param_duration": "String"}
_NUMERIC = ("integer", "long", "short", "byte", "double", "float", "decimal", "number")


def dashboard_version(item_id: str, version: Any = None) -> tuple[dict, dict, dict]:
    """A published dashboard (read with the viewer's permissions on its Files item): (item, its versions file, the
    version — the latest when none is given)."""
    import ts_derived

    item, doc = ts_derived._dashboard_item(item_id)
    if not doc.get("versions"):
        raise HTTPException(404, "the dashboard has no published version")
    if version in (None, ""):
        return item, doc, doc["versions"][-1]
    v = next((x for x in doc["versions"] if x["version"] == int(version)), None)
    if not v:
        raise HTTPException(404, f"version {version} of the dashboard is no longer kept: pick another or turn on Auto-update")
    return item, doc, v


def dashboard_inputs(a: dict) -> list[dict]:
    """A dashboard's inputs: its root object, the parameter cards chosen as dashboard inputs and the selector cards it
    shows — each {key, kind, card_id, title, type (Quiver), accepts (Notepad input types), default, object_type_id}."""
    import ontology
    import quiver_cards

    out: list[dict] = []
    root = a.get("root") or {}
    if root.get("object_type_id"):
        try:
            tname = ontology._object_type(root["object_type_id"])["display_name"]
        except HTTPException:
            tname = root["object_type_id"]
        out.append({"key": "object", "kind": "object", "card_id": None, "title": f"Object ({tname})", "type": "Object",
                    "object_type_id": root["object_type_id"], "default": root.get("primary_key")})
    logic = {x["id"]: x for x in (a.get("logic") or {}).get("cards") or []}
    for cid in (a.get("dashboard") or {}).get("inputs") or []:
        x = logic.get(cid)
        if x is None:
            continue
        out.append({"key": f"param:{cid}", "kind": "param", "card_id": cid, "title": x.get("title") or f"${cid}", "type": _PARAM_TYPES.get(x.get("type"), "String"),
                    "object_type_id": None, "default": (x.get("config") or {}).get("value")})
    sets = {x["id"]: x for x in a.get("object_sets") or []}
    shown = set((a.get("dashboard") or {}).get("cards") or [])
    for x in a.get("object_sets") or []:
        if x.get("kind") not in quiver_cards.SELECTOR_KINDS or x["id"] not in shown:
            continue
        multiple, default, tid = bool(x.get("multiple")), x.get("value"), None
        src = sets.get((x.get("source") or {}).get("card") or "") or {}
        if x["kind"] == "object_selector":
            typ, tid = ("Object Set" if multiple else "Object"), src.get("object_type_id")
        elif multiple:
            typ = "String List"
        elif x["kind"] == "property_select":
            typ = "String"
            try:
                p = next((p for p in ontology._object_type(src.get("object_type_id") or "")["properties"] if p["api_name"] == x.get("property")), None)
                typ = "Number" if p and str(p.get("type")) in _NUMERIC else "String"
            except HTTPException:
                typ = "Number" if isinstance(default, (int, float)) and not isinstance(default, bool) else "String"
        else:
            typ = "Number" if isinstance(default, (int, float)) and not isinstance(default, bool) else "String"
        out.append({"key": f"selector:{x['id']}", "kind": "selector", "card_id": x["id"], "title": x.get("title") or f"${x['id']}", "type": typ,
                    "object_type_id": tid, "default": default})
    for i in out:
        i["accepts"] = list(DASHBOARD_INPUT_TYPES[i["type"]])
    return out


def dashboard_info(item_id: str, version: Any = None) -> dict:
    """What the widget's properties panel needs: the dashboard's versions and a version's inputs."""
    item, doc, v = dashboard_version(item_id, version)
    return {"item_id": item["id"], "name": item["name"].removesuffix(".quiver-dashboard"), "version": v["version"], "latest": doc["versions"][-1]["version"],
            "versions": [{k: x.get(k) for k in ("version", "at", "note")} for x in reversed(doc["versions"])], "inputs": dashboard_inputs(v["analysis"])}


def _source_value(src: Any, ctx: Ctx, accepts: Optional[tuple] = None, title: str = "") -> Any:
    """A mapped input's value on the Notepad side (None: not mapped, the dashboard's default applies): a fixed value,
    a template input (checked against the types the dashboard input accepts) or the generator's object."""
    if src is None or (isinstance(src, dict) and not src.get("input") and not src.get("object") and src.get("value") in (None, "")):
        return None
    if isinstance(src, dict) and src.get("input"):
        d = ctx.input_def(src["input"])
        if accepts and d["type"] not in accepts:
            raise HTTPException(400, f"the template input {d['name']} is a {d['type']}; the dashboard input {title} takes {' or '.join(accepts)}")
        v = ctx.inputs.get(d["name"])
        if v in (None, ""):
            return None
        if d["type"] == "object":
            return v.get("pk") if isinstance(v, dict) else v
        if d["type"] == "object_set":
            return [o["primary_key"] for o in object_set({"input": d["name"]}, ctx, max(limits()["rows"], limits()["nested"]))]
        return v
    return _param_value(src, ctx)


def _quiver_value(typ: str, v: Any, title: str) -> Any:
    """A Notepad value as the Quiver input type takes it (the doc's mapping table; values already converted pass)."""
    def bad(what: str) -> HTTPException:
        return HTTPException(400, f"the dashboard input {title} takes {what}, not {fmt(v)!r}")

    if typ == "Boolean":
        if isinstance(v, bool):
            return v
        s = str(v).strip().lower()
        if s in ("true", "1", "yes"):
            return True
        if s in ("false", "0", "no"):
            return False
        raise bad("true or false")
    if typ == "Number":
        try:
            n = float(v)
        except (TypeError, ValueError):
            raise bad("a number") from None
        return int(n) if n.is_integer() else n
    if typ == "Time Range":
        if isinstance(v, dict) and ("start" in v or "end" in v):
            return {"start": v.get("start"), "end": v.get("end")}
        parts = re.split(r"\s+-\s+|/", str(v).strip(), maxsplit=1)
        if len(parts) != 2 or not all(p.strip() for p in parts):
            raise bad("a range written ISO - ISO")
        return {"start": parts[0].strip(), "end": parts[1].strip()}
    if typ in ("String List", "Object Set"):
        if isinstance(v, list):
            return [str(x.get("pk") if isinstance(x, dict) else x) for x in v]
        s = str(v).strip()
        if s.startswith("["):
            try:
                xs = json.loads(s)
            except ValueError:
                raise bad('a list written ["option_1","option_2"]') from None
            if not isinstance(xs, list):
                raise bad("a list")
            return [str(x) for x in xs]
        if typ == "String List":
            raise bad('a list written ["option_1","option_2"]')
        return [p.strip() for p in s.split(",") if p.strip()]
    if typ == "Object":
        return str(v.get("pk") if isinstance(v, dict) else v)
    if isinstance(v, (dict, list)):
        raise bad("a single value")
    return str(v)  # String, Time (an ISO date / timestamp)


def mapped_inputs(c: dict, a: dict, ctx: Ctx) -> list[dict]:
    """The dashboard's inputs with the values the widget maps to them ({..., value, mapped}); unmapped ones keep the
    dashboard's default."""
    srcs = c.get("inputs") or {}
    out = []
    for i in dashboard_inputs(a):
        raw = _source_value(srcs.get(i["key"]), ctx, tuple(i["accepts"]), i["title"])
        out.append({**i, "mapped": raw is not None, "value": _quiver_value(i["type"], raw, i["title"]) if raw is not None else i["default"]})
    return out


def published_dashboard(c: dict, ctx: Ctx, reader: Optional[dict] = None) -> dict:
    """A published dashboard as the widget shows it: the chosen version (pinned, or the latest with Auto-update) with
    the mapped inputs applied the way Quiver applies them — the root object as when Quiver opens the dashboard for an
    object (ts_derived._for_object), parameter cards' values, selector cards' selections (then a reader's own
    selections on top, for that answer only) — and its table cards computed for the viewer."""
    import quiver_tables
    import ts_derived

    if len(reader or {}) > 200:
        raise HTTPException(400, "at most 200 selections")
    auto = bool(c.get("auto_update")) or c.get("version") in (None, "")
    item, doc, v = dashboard_version(c["dashboard_item_id"], None if auto else c.get("version"))
    a = copy.deepcopy(v["analysis"])
    inputs = mapped_inputs(c, a, ctx)
    root, params, selections = None, {}, {}
    for i in inputs:
        if not i["mapped"]:
            continue
        if i["kind"] == "object":
            import ontology

            ontology._find(ontology._object_type(i["object_type_id"]), i["value"])  # 404 for an object that does not exist
            a, _ = ts_derived._for_object(a, i["object_type_id"], i["value"])
            root = {"object_type_id": i["object_type_id"], "primary_key": i["value"]}
        elif i["kind"] == "param":
            params[i["card_id"]] = i["value"]
            for x in (a.get("logic") or {}).get("cards") or []:
                if x["id"] == i["card_id"]:
                    x["config"] = {**(x.get("config") or {}), "value": i["value"]}
        else:
            selections[i["card_id"]] = i["value"]
    a, _ = quiver_tables.apply_selections(a, selections)
    reader_applied: dict = {}
    if reader:
        a, reader_applied = quiver_tables.apply_selections(a, reader)
    tables = {x["id"] for x in a.get("object_sets") or [] if x.get("kind") in quiver_tables.TABLE_KINDS}
    wanted = {x for x in (a.get("dashboard") or {}).get("cards") or [] if x in tables}
    return {"dashboard": {"item_id": item["id"], "name": item["name"].removesuffix(".quiver-dashboard"), "version": v["version"], "at": v["at"],
                          "latest": doc["versions"][-1]["version"], "auto_update": auto, "analysis_id": doc.get("analysis_id")},
            "analysis": a, "inputs": [{k: i[k] for k in ("key", "kind", "card_id", "title", "type", "value", "mapped")} for i in inputs],
            "root": root, "params": params, "selections": selections, "reader_selections": reader_applied,
            "tables": quiver_tables.run_cards(a, wanted, object_rows=quiver_tables.EMBED_OBJECTS) if wanted else {}}


def dashboard_export_rows(d: dict) -> list[tuple[str, Any, list[str], list[list[str]]]]:
    """A published dashboard widget's cards for DOCX / Markdown: (title, value or None, columns, rows) per table card
    the dashboard shows, in its order (selector cards: their selection)."""
    import quiver_cards

    a = d.get("analysis") or {}
    cards = {x["id"]: x for x in a.get("object_sets") or []}
    out = []
    for cid in (a.get("dashboard") or {}).get("cards") or []:
        r = (d.get("tables") or {}).get(cid)
        if r is None or cid not in cards:
            continue
        card = cards[cid]
        title = card.get("title") or cid
        if r.get("error"):
            out.append((title, f"error: {r['error']}", [], []))
            continue
        if card.get("kind") in quiver_cards.SELECTOR_KINDS:
            out.append((title, ", ".join(fmt(x) for x in card["value"]) if isinstance(card.get("value"), list) else fmt(card.get("value")), [], []))
            continue
        cols, shown, note = quiver_export_rows(r)
        rows = [[_quiver_cell(x.get(col)) if isinstance(x, dict) else "" for col in cols] for x in shown]
        # a table cut short: its "first N of M" note where a value would be
        value = _quiver_cell(r["value"]) if "value" in r and not cols else (note or None)
        out.append((title, value, cols, rows))
    return out


def quiver_export_rows(r: dict) -> tuple[list[str], list[dict], str]:
    """A Quiver card result's (columns, the rows DOCX / Markdown exports show, a "first N of M" note when that is fewer
    than the card holds — "" otherwise): an object set card carries up to quiver_tables.EMBED_OBJECTS objects and all
    of them are exported; a table its first rows."""
    import quiver_tables

    cols = r.get("columns") or r.get("data_columns") or []
    held = r.get("rows") or r.get("data") or []
    rows = held[:quiver_tables.EMBED_OBJECTS]
    total = r.get("total")
    total = int(total) if isinstance(total, (int, float)) and not isinstance(total, bool) and total > len(held) else len(held)
    if total <= len(rows):
        return cols, rows, ""
    if r.get("object_type_id"):
        return cols, rows, f"First {len(rows):,} of {total:,} objects (the card's CSV export in Quiver has every object)."
    return cols, rows, f"First {len(rows):,} of {total:,} rows."


def dashboard_caption(d: dict) -> str:
    m = d["dashboard"]
    ver = f"version {m['version']}" + (" (auto-update)" if m.get("auto_update") else f" (pinned; latest {m['latest']})" if m["latest"] != m["version"] else " (pinned)")
    inputs = ", ".join(f"{i['title']} = {', '.join(fmt(x) for x in i['value']) if isinstance(i['value'], list) else fmt(i['value'])}" for i in d.get("inputs") or [] if i.get("mapped"))
    return f"Quiver dashboard: {m['name']} — {ver}" + (f" — inputs: {inputs}" if inputs else "")


def resolve(blocks: list[dict], ctx: Ctx) -> dict[str, dict]:
    """Data for every widget (locked ones read their snapshot); widgets inside generators wait for generation."""
    out: dict[str, dict] = {}

    def visit(bs: list[dict], inside_generator: bool) -> None:
        for b in bs:
            if b.get("type") != "widget":
                continue
            if b.get("locked"):
                out[b["id"]] = {**b["locked"]["data"], "locked": {"at": b["locked"]["at"], "by": b["locked"].get("by")}}
            elif inside_generator and _uses_generator(b):
                out[b["id"]] = {"generator": True}
            else:
                try:
                    out[b["id"]] = widget_data(b, ctx)
                except HTTPException as e:
                    out[b["id"]] = {"error": str(e.detail)}
            if b.get("children"):
                visit(b["children"], inside_generator or b["kind"] == "section_generator")

    visit(blocks, False)
    return out


def _uses_generator(b: dict) -> bool:
    s = json.dumps(b.get("config") or {})
    return '"generator": true' in s or '"object": true' in s or '"linked"' in s or "{{object" in s or "{{parent" in s


# ------------------------------------------------------------------ template generation


def expand(blocks: list[dict], ctx: Ctx, depth: int = 0) -> list[dict]:
    """A template's blocks for a generated document: inputs and generators resolved into plain blocks and widgets."""
    out: list[dict] = []
    for b in blocks:
        b = copy.deepcopy(b)
        b["id"] = uuid.uuid4().hex
        t = b.get("type")
        if t in ("paragraph", "heading"):
            b["text"] = subst(b["text"], ctx)
            out.append(b)
            continue
        if t == "table":
            b["rows"] = [[subst(x, ctx) for x in r] for r in b["rows"]]
            out.append(b)
            continue
        if t != "widget":
            out.append(b)
            continue
        k, c = b["kind"], b.get("config") or {}
        if k == "value_embed":
            out.append({"id": b["id"], "type": "paragraph", "text": input_text(c["input"], ctx) if c.get("input") else ""})
        elif k == "function":
            v = widget_data(b, ctx)["value"]
            out.append({"id": b["id"], "type": "paragraph", "text": v if c.get("markdown") else _escape_md(v)})
        elif k == "conditional_section":
            if condition(c, ctx):
                out.extend(expand(b.get("children") or [], ctx, depth))
        elif k == "section_generator":
            if depth > 1:
                raise HTTPException(400, "generators nest one level deep at most")
            objs = object_set(c.get("object_set"), ctx, limits()["top"] if depth == 0 else limits()["nested"])
            for o in objs:
                out.extend(expand(b.get("children") or [], ctx.child(o), depth + 1))
        elif k == "table_row_generator":
            rows = generated_rows(b, ctx)
            head = [c.get("headers") or [f"Column {i + 1}" for i in range(len(c.get("cells") or []))]]
            if head[0]:
                out.append({"id": b["id"], "type": "table", "rows": (head + rows)[: limits()["rows"] + 1]})
        else:
            # live widgets: template inputs and generator objects become fixed values
            if k in ("object_property", "object_card", "object_media", "object_markdown"):
                o = object_ref(c.get("object"), ctx)
                c["object"] = {"object_type_id": o["object_type_id"], "pk": o["primary_key"]} if o else None
            elif k == "map" and c.get("object_set"):
                objs = object_set(c["object_set"], ctx, 5000)
                tid = objs[0]["object_type_id"] if objs else (c["object_set"].get("object_type_id") or "")
                c["object_set"] = {"object_type_id": tid, "value": [o["primary_key"] for o in objs]}
            elif k == "contour_chart":
                c["params"] = {n: _param_value(v, ctx) for n, v in (c.get("params") or {}).items()}
                if c.get("params_json"):
                    try:
                        c["params"] = {**json.loads(subst(c.pop("params_json"), ctx)), **c["params"]}
                    except ValueError:
                        raise HTTPException(400, "the parameter JSON is not valid") from None
            elif k == "quiver_dashboard" and c.get("dashboard_item_id"):
                # the dashboard inputs' mapping: template inputs and generator objects become fixed values (the
                # types are checked against the dashboard's inputs, as when the template is previewed)
                auto = bool(c.get("auto_update")) or c.get("version") in (None, "")
                _i, _d, v = dashboard_version(c["dashboard_item_id"], None if auto else c.get("version"))
                accepts = {i["key"]: (tuple(i["accepts"]), i["title"]) for i in dashboard_inputs(v["analysis"])}
                fixed = {}
                for key, src in (c.get("inputs") or {}).items():
                    acc, title = accepts.get(key, (None, key))
                    val = _source_value(src, ctx, acc, title)
                    if val is not None:
                        fixed[key] = {"value": val}
                c["inputs"] = fixed
            elif k == "latex":
                c["tex"] = subst(c.get("tex") or "", ctx)
            b["config"] = c
            b.pop("children", None)
            out.append(b)
    return out


def _escape_md(s: str) -> str:
    return re.sub(r"([*_`#\[\]])", r"\\\1", s)


def input_values(defs: list[dict], given: dict, preview: bool) -> dict:
    out = {}
    for d in defs:
        v = given.get(d["name"], d.get("preview") if preview else None)
        if v in (None, "") and not preview and d.get("required", True):
            raise HTTPException(400, f"the template input {d['name']} needs a value")
        if d["type"] == "number" and v not in (None, ""):
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{d['name']} must be a number") from None
        out[d["name"]] = v
    return out


# ------------------------------------------------------------------ versions


def _versions_file(item_id: str) -> Path:
    import drive

    d = drive.LOCAL_DIR.parent / "notepad_versions"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{item_id}.json"


def versions(item_id: str) -> list[dict]:
    p = _versions_file(item_id)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _write_versions(item_id: str, vs: list[dict]) -> None:
    p = _versions_file(item_id)
    tmp = p.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")  # a temp file per write: concurrent saves never share one
    tmp.write_text(json.dumps(vs[-500:], ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def add_version(item_id: str, document: dict, name: str = "", endorsed: bool = False, auto: bool = False) -> dict:
    vs = versions(item_id)
    v = {"id": uuid.uuid4().hex[:12], "at": _now(), "by": _me(), "name": name, "endorsed": endorsed, "auto": auto, "document": document}
    vs.append(v)
    _write_versions(item_id, vs)
    return v


def autosave(item_id: str, previous: dict) -> Optional[dict]:
    """An autosave version of the content being replaced, at most every 5 minutes."""
    vs = versions(item_id)
    last = vs[-1]["at"] if vs else None
    if last and (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() < AUTOSAVE_SECONDS:
        return None
    return add_version(item_id, previous, auto=True)


def block_text(b: dict) -> str:
    t = b.get("type")
    if t in ("paragraph", "heading"):
        return ("#" * b.get("level", 0) + " " if t == "heading" else "") + b["text"]
    if t == "table":
        return " | ".join(" ; ".join(r) for r in b["rows"])
    if t == "widget":
        return f"[{b['kind']}] " + json.dumps(b.get("config") or {}, sort_keys=True, ensure_ascii=False)
    return f"[{t}]"


def diff(old: dict, new: dict) -> list[dict]:
    """Content changes between two documents (formatting such as image width is ignored)."""
    import difflib

    a = [block_text(b) for b in walk(old.get("blocks") or [])]
    b = [block_text(x) for x in walk(new.get("blocks") or [])]
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op in ("replace", "delete"):
            out += [{"op": "removed", "text": x} for x in a[i1:i2]]
        if op in ("replace", "insert"):
            out += [{"op": "added", "text": x} for x in b[j1:j2]]
    return out


# ------------------------------------------------------------------ links and exports


def links(document: dict) -> dict:
    """Objects and resources a document references (widget links)."""
    objects, resources = {}, {}
    for b in walk(document.get("blocks") or []):
        if b.get("type") != "widget":
            continue
        c = b.get("config") or {}
        o = c.get("object") if isinstance(c.get("object"), dict) else None
        if o and o.get("object_type_id") and o.get("pk") not in (None, ""):
            objects[f"{o['object_type_id']}:{o['pk']}"] = {"object_type_id": o["object_type_id"], "pk": str(o["pk"])}
        for key, kind in (("analysis_id", "quiver" if str(b.get("kind", "")).startswith("quiver") else "contour"), ("item_id", "file"), ("function_id", "function"),
                          ("dashboard_item_id", "quiver_dashboard")):
            if c.get(key):
                resources[c[key]] = {"id": c[key], "kind": kind}
        if b.get("kind") == "user_mention" and c.get("user_id"):
            resources[c["user_id"]] = {"id": c["user_id"], "kind": "user"}
    return {"objects": list(objects.values()), "resources": list(resources.values())}


def mentions(document: dict) -> set[str]:
    return {(b.get("config") or {}).get("user_id") for b in walk(document.get("blocks") or [])
            if b.get("type") == "widget" and b.get("kind") == "user_mention" and (b.get("config") or {}).get("user_id")}


def _plain(md: str) -> str:
    return re.sub(r"(\*\*|__|\*|_|`)", "", md or "")


def to_docx(title: str, document: dict, data: dict[str, dict], banner: Optional[str] = None) -> bytes:
    """DOCX export: text, headings, tables, images, page breaks and widgets as their current data."""
    import base64

    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.shared import Inches

    doc = Document()
    settings = document.get("settings") or {}
    sec = doc.sections[0]
    if settings.get("orientation") == "landscape":
        sec.orientation = WD_ORIENT.LANDSCAPE
        sec.page_width, sec.page_height = sec.page_height, sec.page_width
    if settings.get("header"):
        sec.header.paragraphs[0].text = settings["header"]
    if settings.get("footer"):
        sec.footer.paragraphs[0].text = settings["footer"]
    if banner:
        # envelope security: the document's markings are the banner (custom headers give way)
        sec.header.paragraphs[0].text = banner
        sec.footer.paragraphs[0].text = banner
    doc.add_heading(title, 0)

    def table(rows: list[list[str]]) -> None:
        if not rows or not rows[0]:
            return
        t = doc.add_table(rows=len(rows), cols=len(rows[0]))
        t.style = "Table Grid"
        # the cells read once (t.cell(i, j) walks the whole table each call: minutes for a 1,000-row Quiver table)
        cells, n = t._cells, len(rows[0])
        for i, r in enumerate(rows):
            for j, v in enumerate(r[:n]):
                cells[i * n + j].text = _plain(str(v))

    def emit(blocks: list[dict]) -> None:
        for b in blocks:
            t = b.get("type")
            if t == "heading":
                doc.add_heading(_plain(b["text"]), b["level"])
            elif t == "paragraph":
                for para in (b["text"] or "").split("\n\n"):
                    doc.add_paragraph(_plain(para))
            elif t == "table":
                table(b["rows"])
            elif t == "page_break":
                doc.add_page_break()
            elif t == "rule":
                doc.add_paragraph("―" * 30)
            elif t == "date":
                doc.add_paragraph(b["date"])
            elif t == "image":
                m = re.match(r"data:image/(png|jpeg|gif);base64,(.+)", b["src"])
                if m:
                    try:
                        doc.add_picture(io.BytesIO(base64.b64decode(m.group(2))), width=Inches(6 * b.get("width", 100) / 100))
                    except Exception:  # noqa: BLE001 — an image python-docx cannot read is left out
                        doc.add_paragraph(f"[image: {b.get('alt') or ''}]")
            elif t == "app_link":
                doc.add_paragraph(b.get("label") or b["app"])
            elif t == "widget":
                d = data.get(b["id"]) or {}
                k = b["kind"]
                if d.get("error"):
                    doc.add_paragraph(f"[{k}: {d['error']}]")
                elif k == "object_property":
                    doc.add_paragraph(f"{d.get('label')}: {d.get('value')}" if (b.get("config") or {}).get("show_name") else str(d.get("value") or ""))
                elif k == "object_markdown":
                    for para in [x for x in str(d.get("value") or "").split("\n\n") if x.strip()]:
                        doc.add_paragraph(_plain(para))
                elif k == "object_card":
                    doc.add_paragraph(d.get("title") or "", style="Intense Quote")
                    table([[p["label"], p["value"]] for p in d.get("properties") or []])
                elif k == "contour_chart":
                    r = d.get("result") or {}
                    doc.add_paragraph(f"{d.get('board', {}).get('title') or d.get('board', {}).get('type', '')} — {d.get('analysis', '')} / {d.get('path', '')}", style="Caption")
                    cols = r.get("data_columns") or []
                    table([cols] + [[_cell(x.get(c)) for c in cols] for x in (r.get("data") or [])[:200]])
                elif k == "quiver_chart" and d.get("card"):
                    r = (d.get("results") or {}).get(d["card"]["id"]) or {}
                    doc.add_paragraph(f"{d['card'].get('title', '')} — Quiver: {d.get('analysis_name', '')}", style="Caption")
                    if "value" in r:
                        doc.add_paragraph(_quiver_cell(r["value"]))  # a value card's array as "a, b" (as on screen)
                    cols, shown, note = quiver_export_rows(r)
                    table([cols] + [[_quiver_cell(x.get(c)) for c in cols] for x in shown])
                    if note and cols:
                        doc.add_paragraph(note, style="Caption")
                elif k == "map":
                    doc.add_paragraph(f"Map: {len(d.get('points') or [])} {d.get('type_name', '')} locations", style="Caption")
                    table([["Name", "Latitude", "Longitude"]] + [[str(x["title"]), fmt(x["lat"]), fmt(x["lon"])] for x in (d.get("points") or [])[:200]])
                elif k == "object_media":
                    doc.add_paragraph(f"{d.get('title', '')} · {d.get('label', '')}: {len(d.get('refs') or [])} media item(s)")
                elif k == "code_workbook_chart" and d.get("node"):
                    doc.add_paragraph(f"{d['node']} — Code Workbook: {d.get('workbook', '')}", style="Caption")
                    for fig in d.get("figures") or []:
                        doc.add_picture(io.BytesIO(base64.b64decode(fig)), width=Inches(6))
                    if d.get("columns"):
                        table([d["columns"]] + [[_cell(x.get(c)) for c in d["columns"]] for x in (d.get("rows") or [])[:200]])
                elif k == "solution_diagram" and d.get("graph"):
                    doc.add_paragraph(f"Solution diagram: {d.get('name', '')}", style="Caption")
                    table([["Component", "Kind", "Connects to"]] + _diagram_rows(d)[:200])
                elif k == "vertex_graph" and d.get("graph"):
                    doc.add_paragraph(f"Vertex graph: {d['graph'].get('name', '')} — {len(d.get('nodes') or [])} objects", style="Caption")
                    table([["From", "Link", "To"]] + _graph_rows(d)[:200])
                elif k == "quiver_dashboard" and d.get("dashboard"):
                    doc.add_paragraph(dashboard_caption(d), style="Caption")
                    for ctitle, value, cols, rows in dashboard_export_rows(d):
                        doc.add_paragraph(_plain(ctitle) + (f": {value}" if value is not None else ""), style="Intense Quote" if cols else None)
                        if cols:
                            table([cols] + rows)
                elif k in ("quiver_chart", "quiver_dashboard"):
                    doc.add_paragraph(f"[Quiver {'dashboard' if k == 'quiver_dashboard' else 'time series chart'}: {(d.get('analysis') or {}).get('name', '')} — open the document to view]")
                elif k in ("function", "value_embed"):
                    doc.add_paragraph(_plain(str(d.get("value") or "")))
                elif k == "latex":
                    doc.add_paragraph((b.get("config") or {}).get("tex") or "")
                elif k == "user_mention":
                    doc.add_paragraph("@" + str(d.get("name") or ""))
                elif k == "resource_link":
                    doc.add_paragraph(str(d.get("name") or ""))
                elif k == "anchor_link":
                    doc.add_paragraph((b.get("config") or {}).get("label") or "")
                elif k == "table_row_generator":
                    table([d.get("headers") or []] + (d.get("rows") or []))
                if b.get("children") and k != "section_generator":
                    emit(b["children"])

    emit(document.get("blocks") or [])
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _cell(v: Any) -> str:
    return fmt(v)


def _quiver_cell(v: Any) -> str:
    """A Quiver table cell: an array as "a, b", a struct as "field: value" (as Quiver shows them), else as _cell."""
    if isinstance(v, (list, dict)):
        import quiver_tables

        return quiver_tables.display_text(v)
    return fmt(v)


def _diagram_rows(d: dict) -> list[list[str]]:
    """A Solution Designer diagram's nodes (not groups or text) with where their edges lead."""
    g = d.get("graph") or {}
    title = {n["id"]: n.get("title") or n.get("component") or n["id"] for n in g.get("nodes") or []}
    out = []
    for n in g.get("nodes") or []:
        if n.get("kind") in ("group", "text"):
            continue
        to = [title.get(e["to"], e["to"]) + (f" ({e['label']})" if e.get("label") else "") for e in g.get("edges") or [] if e.get("from") == n["id"]]
        out.append([title[n["id"]], n.get("kind") or "", ", ".join(to)])
    return out


def _graph_rows(d: dict) -> list[list[str]]:
    """A Vertex graph widget's edges as rows (exports): links, then transactional edges with their labels."""
    title = {n["id"]: n.get("title") or n["id"] for n in d.get("nodes") or []}
    rows = [[title.get(e["source"], e["source"]), e.get("label") or "", title.get(e["target"], e["target"])] for e in d.get("edges") or []]
    rows += [[title.get(e["source"], e["source"]), f"{e.get('name', '')}: {fmt(e.get('value'))}", title.get(e["target"], e["target"])] for e in d.get("grouped_edges") or []]
    return rows


def to_markdown(title: str, document: dict, data: dict[str, dict], banner: Optional[str] = None) -> str:
    out = ([f"**{banner}**", ""] if banner else []) + [f"# {title}", ""]

    def emit(blocks: list[dict]) -> None:
        for b in blocks:
            t = b.get("type")
            if t == "heading":
                out.append("#" * (b["level"] + 1) + " " + b["text"])
            elif t == "paragraph":
                out.append(b["text"])
            elif t == "table" and b["rows"]:
                out.append("| " + " | ".join(b["rows"][0]) + " |")
                out.append("|" + "---|" * len(b["rows"][0]))
                out.extend(["| " + " | ".join(r) + " |" for r in b["rows"][1:]])
            elif t in ("rule", "page_break"):
                out.append("---")
            elif t == "date":
                out.append(b["date"])
            elif t == "widget":
                d = data.get(b["id"]) or {}
                if b["kind"] == "contour_chart" and (d.get("result") or {}).get("data_columns"):
                    r = d["result"]
                    out.append("| " + " | ".join(r["data_columns"]) + " |")
                    out.append("|" + "---|" * len(r["data_columns"]))
                    out.extend(["| " + " | ".join(_cell(x.get(c)) for c in r["data_columns"]) + " |" for x in r["data"][:200]])
                elif b["kind"] == "quiver_chart" and d.get("card"):
                    r = (d.get("results") or {}).get(d["card"]["id"]) or {}
                    cols, shown, note = quiver_export_rows(r)
                    out.append(f"**{d['card'].get('title', '')}** (Quiver)")
                    if "value" in r:
                        out.append(_quiver_cell(r["value"]))  # a value card's array as "a, b" (as on screen)
                    if cols:
                        out.append("| " + " | ".join(cols) + " |")
                        out.append("|" + "---|" * len(cols))
                        out.extend(["| " + " | ".join(_quiver_cell(x.get(c)).replace("|", "\\|").replace("\n", " ") for c in cols) + " |" for x in shown])
                        if note:
                            out.extend(["", f"_{note}_"])
                elif b["kind"] == "quiver_dashboard" and d.get("dashboard"):
                    out.append(f"**{dashboard_caption(d)}**")
                    for ctitle, value, cols, rows in dashboard_export_rows(d):
                        out.append("")
                        out.append(f"*{ctitle}*" + (f": {value}" if value is not None else ""))
                        if cols:
                            out.append("")
                            out.append("| " + " | ".join(cols) + " |")
                            out.append("|" + "---|" * len(cols))
                            out.extend(["| " + " | ".join(x.replace("|", "\\|") for x in r) + " |" for r in rows])
                elif b["kind"] == "code_workbook_chart" and d.get("node"):
                    out.append(f"**{d['node']}** (Code Workbook: {d.get('workbook', '')})")
                    out.extend(f"![{d['node']}](data:image/png;base64,{fig})" for fig in d.get("figures") or [])
                    if d.get("columns"):
                        out.append("| " + " | ".join(d["columns"]) + " |")
                        out.append("|" + "---|" * len(d["columns"]))
                        out.extend(["| " + " | ".join(_cell(x.get(c)) for c in d["columns"]) + " |" for x in (d.get("rows") or [])[:200]])
                elif b["kind"] == "solution_diagram" and d.get("graph"):
                    out.append(f"**{d.get('name', '')}** (Solution diagram)")
                    out.append("| Component | Kind | Connects to |")
                    out.append("|---|---|---|")
                    out.extend(["| " + " | ".join(r) + " |" for r in _diagram_rows(d)[:200]])
                elif b["kind"] == "vertex_graph" and d.get("graph"):
                    out.append(f"**{d['graph'].get('name', '')}** (Vertex graph)")
                    out.append("| From | Link | To |")
                    out.append("|---|---|---|")
                    out.extend(["| " + " | ".join(r) + " |" for r in _graph_rows(d)[:200]])
                elif b["kind"] == "map" and d.get("points"):
                    out.append("| Name | Latitude | Longitude |")
                    out.append("|---|---|---|")
                    out.extend([f"| {x['title']} | {fmt(x['lat'])} | {fmt(x['lon'])} |" for x in d["points"][:200]])
                elif b["kind"] == "object_media" and d.get("refs"):
                    out.append(f"{d.get('title', '')} · {d.get('label', '')}: {len(d['refs'])} media item(s)")
                elif b["kind"] == "latex":
                    out.append("$$" + ((b.get("config") or {}).get("tex") or "") + "$$")
                elif b["kind"] == "object_markdown":
                    out.append(str(d.get("value") or ""))
                elif b["kind"] == "object_card":
                    out.append(f"**{d.get('title', '')}**")
                    out.extend([f"- {p['label']}: {p['value']}" for p in d.get("properties") or []])
                elif "value" in d or "name" in d:
                    out.append(str(d.get("value", d.get("name", ""))))
                if b.get("children") and b["kind"] != "section_generator":
                    emit(b["children"])
            out.append("")

    emit(document.get("blocks") or [])
    if banner:
        out += ["", f"**{banner}**"]
    return "\n".join(out)
