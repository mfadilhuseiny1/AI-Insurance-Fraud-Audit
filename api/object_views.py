"""Configured Object Views, versions and comments, modelled on Palantir's Object Views docs.

Every object type has a default Object View (prominent properties, or every non-hidden one, and its links). A
configured Object View replaces it: tabs — properties (a chosen list), linked objects (one link type, with a count
badge), a timeline of date / timestamp properties of the object and its linked objects, edit history, comments, a
form embedded for the object (prefilled from it; a Conditional Form picks the form by a property; or a Create linked
object form: a new object linked to it, prefilled from the last linked object), an embedded
Workshop module or a link — in an order, each optionally visible only when a property of the viewed object
equals (or does not equal) a value, or when the viewer can see a linked object type; a panel view (the properties a
compact panel shows, and for object sets the aggregated properties); the applications sidebar (links to other apps
with the object); and the header properties.

Widget tabs over linked objects (the legacy Object View widgets): a linked objects tab can carry filters (chosen
properties of the linked type, shown as value lists that narrow the table); a chart tab groups the linked objects by
a property (count, or sum / avg / min / max of a numeric property; bars or a pie); a linked object view tab shows
each linked object as a card of its properties (a linked object's view inside this one). A Quiver dashboard tab shows
a published dashboard opened for the viewed object (ts_derived.get_dashboard with the object).

Widget tabs over the object itself (also legacy widgets): a map tab draws the object's geopoint / geoshape property
and, optionally, the linked objects of one link type from a geo property of theirs; a time series tab charts time
series properties of the object (and its linked sensors' series), or of the linked objects of one link type, over a
default range; an HTML tab shows author-written HTML with {{property}} placeholders. The HTML is made safe here:
the values are escaped, then the whole document goes through an allow-list sanitizer (no scripts, no event handler
attributes, only http(s) / mailto / relative links) — and the page shows it in a sandboxed frame without scripts.

Versions: saving makes a new version (author, time, description). With "Automatically publish new versions" a save
publishes it; otherwise Publish makes a saved version the one users see. Any earlier version can be restored (saved
again as the newest) or published.

Comments: anyone who can see an object can comment on it, mention users with @username (they are notified in their
inbox) and attach files from the Files tab; authors delete their own comments.

Records: data/ontology/object-views/<type>.json and data/ontology/object-comments/<type>.json. Mounted by server.py
under /api/ontology.
"""

from __future__ import annotations

import html as html_lib
import re
import uuid
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import auth
import ontology
import ontology_model as om
from ontology import _lock, _now, _read, _write

router = APIRouter(prefix="/api/ontology")
TAB_KINDS = ("properties", "links", "chart", "linked_view", "map", "timeseries", "html", "timeline", "edit_history", "comments", "form", "workshop", "quiver_dashboard", "url")
LINKED_KINDS = ("links", "chart", "linked_view")
GEO_TYPES = ("geopoint", "geoshape")
MAP_LINKED = 2000  # linked objects a map tab draws
TS_LINKED = 12  # linked objects a time series tab charts
TS_BUCKETS = 300
TS_UNITS = {"h": 3600, "d": 86400, "w": 604800, "mo": 2592000, "y": 31536000}
TS_RANGE_RE = re.compile(r"^(\d{1,4})(h|d|w|mo|y)$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}")
HTML_BUILTINS = ("title", "primary_key", "objectId", "objectTypeId")
CHART_GROUPS = 30
LINKED_VIEWS = 20
VERSIONS_KEPT = 100


def configure() -> None:
    for name in ("object-views", "object-comments"):
        (ontology.DIR / name).mkdir(parents=True, exist_ok=True)


def _who() -> str:
    return auth.actor_id() or (auth.current() or {}).get("username") or "local"


def _views_path(tid: str):
    return ontology._path("object-views", tid)


def _comments_path(tid: str):
    return ontology._path("object-comments", tid)


# ------------------------------------------------------------------------------------------------
# configuration
# ------------------------------------------------------------------------------------------------


class Tab(BaseModel):
    id: str = Field(default_factory=lambda: f"tab-{uuid.uuid4().hex[:6]}")
    title: str = Field(min_length=1, max_length=100)
    kind: Literal["properties", "links", "chart", "linked_view", "map", "timeseries", "html", "timeline", "edit_history", "comments", "form", "workshop", "quiver_dashboard", "url"]
    properties: list[str] = []
    # map: a geopoint / geoshape property of the viewed object, and / or (with link_type_id + direction) one of the
    # linked objects; label_property: the linked objects' label on the map (default: their title)
    geo_property: Optional[str] = None
    linked_geo_property: Optional[str] = None
    label_property: Optional[str] = None
    # timeseries: time series properties of the viewed object (none: all of them), with its linked sensors' series;
    # or (ts_source linked, with link_type_id + direction) of the linked objects. ts_range: the default range, the
    # last N h / d / w / mo / y (none: everything)
    ts_source: Literal["object", "linked"] = "object"
    ts_properties: list[str] = Field([], max_length=12)
    ts_sensors: bool = False
    ts_range: Optional[str] = None
    # html: author-written HTML; {{property}}, {{title}} and {{primary_key}} are replaced by the object's values
    html: Optional[str] = Field(None, max_length=50000)
    # map, timeseries, html: the height of the widget in pixels
    height: int = Field(320, ge=120, le=1200)
    # links: properties of the linked type to filter the table by
    filters: list[str] = Field([], max_length=6)
    # chart: the linked objects grouped by a property of theirs
    group_by: Optional[str] = None
    metric: Literal["count", "sum", "avg", "min", "max"] = "count"
    value_property: Optional[str] = None
    chart: Literal["bar", "pie"] = "bar"
    # linked_view: the linked type's properties on each card (default: its prominent ones)
    linked_properties: list[str] = []
    link_type_id: Optional[str] = None
    direction: Literal["forward", "reverse"] = "forward"
    module_id: Optional[str] = None
    # quiver_dashboard: a published Quiver dashboard (its Files item), opened for the viewed object
    dashboard_id: Optional[str] = None
    # form: a form (its Files item) embedded for the viewed object (an Edit object form when it writes this type);
    # form_prefill: field ID → a value, static or {{property}} of the object; form_conditions: [{property, op: eq|neq,
    # value, form_id}], the first that holds picks another form (a Conditional Form); form_no_header hides its title
    form_id: Optional[str] = None
    form_prefill: dict[str, str] = Field({}, max_length=100)
    form_conditions: list[dict] = Field([], max_length=20)
    form_no_header: bool = False
    # form_mode create_linked (a Create linked object form): the form creates an object linked to the viewed one through
    # link_type_id + direction — a foreign key the new object holds (its field is prefilled with this object's key) or a
    # join table (linked after the submission, POST …/linked-form). {{last.property}} in form_prefill and form_copy_last
    # (every field the last linked object has a value for) prefill from the last linked object: the one with the
    # greatest form_last_sort, by default the most recently created
    form_mode: Literal["object", "create_linked"] = "object"
    form_copy_last: bool = False
    form_last_sort: Optional[str] = None
    url: Optional[str] = None
    # {kind: property, property, op: eq|neq, value} | {kind: link, link_type_id}
    visibility: Optional[dict] = None


class ViewConfig(BaseModel):
    tabs: list[Tab] = Field([], max_length=30)
    header_properties: list[str] = []
    panel_properties: list[str] = []
    set_panel_aggregates: list[dict] = []  # [{property, metric: count|sum|avg|min|max}]
    sidebar: list[dict] = []  # [{label, app: object-explorer|vertex|map|workshop|url, url?, module_id?}]


def default_config(t: dict) -> dict:
    visible = [p["api_name"] for p in t["properties"] if p.get("visibility") != "hidden" and p["type"] not in ("vector",)]
    prominent = [p["api_name"] for p in t["properties"] if p.get("visibility") == "prominent"]
    tabs = [{"id": "tab-properties", "title": "Properties", "kind": "properties", "properties": prominent or visible, "visibility": None}]
    for lt, direction in om.links_of(t["id"]):
        reach = om.side_of(lt, direction)[1]
        tabs.append({"id": f"tab-{lt['id']}-{direction}", "title": reach.get("plural_display_name") or reach.get("display_name") or lt.get("display_name") or "Links",
                     "kind": "links", "link_type_id": lt["id"], "direction": direction, "properties": [], "visibility": None})
    tabs.append({"id": "tab-history", "title": "Edit history", "kind": "edit_history", "properties": [], "visibility": None})
    tabs.append({"id": "tab-comments", "title": "Comments", "kind": "comments", "properties": [], "visibility": None})
    return {"tabs": tabs, "header_properties": (t.get("object_view") or {}).get("header_properties") or prominent[:4],
            "panel_properties": (prominent or visible)[:6], "set_panel_aggregates": [], "sidebar": []}


def _other(t: dict, tab: dict) -> dict:
    """The object type a tab's link type reaches from t (400 when the link type does not start from t)."""
    if not tab.get("link_type_id"):
        raise HTTPException(400, f"tab {tab['title']}: pick the link type")
    lt = ontology._get("link-types", tab["link_type_id"], "link type")
    if om.side_of(lt, tab["direction"])[0]["object_type_id"] != t["id"]:
        raise HTTPException(400, f"tab {tab['title']}: the link type does not start from {t['display_name']}")
    return ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])


def _check(t: dict, cfg: dict) -> None:
    names = {p["api_name"] for p in t["properties"]}
    for k in ("header_properties", "panel_properties"):
        bad = [p for p in cfg[k] if p not in names]
        if bad:
            raise HTTPException(400, f"{t['display_name']} has no properties {', '.join(bad)}")
    # tab ids are unique (?tab=, a Create linked object form's link call find a tab by it): a repeated id gets a new one
    seen: set = set()
    for tab in cfg["tabs"]:
        while tab["id"] in seen:
            tab["id"] = f"tab-{uuid.uuid4().hex[:6]}"
        seen.add(tab["id"])
    for tab in cfg["tabs"]:
        bad = [p for p in tab.get("properties") or [] if p not in names]
        if bad:
            raise HTTPException(400, f"tab {tab['title']}: unknown properties {', '.join(bad)}")
        if tab["kind"] in LINKED_KINDS:
            lt = ontology._get("link-types", tab.get("link_type_id") or "", "link type")
            if om.side_of(lt, tab["direction"])[0]["object_type_id"] != t["id"]:
                raise HTTPException(400, f"tab {tab['title']}: the link type does not start from {t['display_name']}")
            other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])
            theirs = {p["api_name"]: p for p in other["properties"]}
            bad = [p for p in (tab.get("filters") or []) + (tab.get("linked_properties") or []) if p not in theirs]
            if bad:
                raise HTTPException(400, f"tab {tab['title']}: {other['display_name']} has no properties {', '.join(bad)}")
            if tab["kind"] == "chart":
                if tab.get("group_by") not in theirs:
                    raise HTTPException(400, f"tab {tab['title']}: pick the property of {other['display_name']} to group by")
                if tab.get("metric", "count") != "count" and (theirs.get(tab.get("value_property") or "") or {}).get("type") not in ("integer", "long", "double", "float", "decimal", "short", "byte"):
                    raise HTTPException(400, f"tab {tab['title']}: {tab['metric']} needs a numeric property of {other['display_name']}")
        if tab["kind"] == "map":
            mine = {p["api_name"]: p for p in t["properties"]}
            if tab.get("geo_property") and (mine.get(tab["geo_property"]) or {}).get("type") not in GEO_TYPES:
                raise HTTPException(400, f"tab {tab['title']}: {tab['geo_property']} is not a geopoint or geoshape property of {t['display_name']}")
            if tab.get("link_type_id"):
                other = _other(t, tab)
                theirs = {p["api_name"]: p for p in other["properties"]}
                if (theirs.get(tab.get("linked_geo_property") or "") or {}).get("type") not in GEO_TYPES:
                    raise HTTPException(400, f"tab {tab['title']}: pick the geopoint or geoshape property of {other['display_name']}"
                                             + (f" ({tab['linked_geo_property']} is not one)" if tab.get("linked_geo_property") else ""))
                if tab.get("label_property") and tab["label_property"] not in theirs:
                    raise HTTPException(400, f"tab {tab['title']}: {other['display_name']} has no property {tab['label_property']}")
            elif not tab.get("geo_property"):
                raise HTTPException(400, f"tab {tab['title']}: pick a geopoint or geoshape property of {t['display_name']}, or a link type and a geo property of the linked objects")
        if tab["kind"] == "timeseries":
            import ts_ontology

            if tab.get("ts_range") and not TS_RANGE_RE.match(tab["ts_range"]):
                raise HTTPException(400, f"tab {tab['title']}: the default range is a number and h, d, w, mo or y (e.g. 7d), or empty for everything")
            src = _other(t, tab) if tab.get("ts_source") == "linked" else t
            tsps = ts_ontology._ts_cfg(src)["properties"]
            bad = [p for p in tab.get("ts_properties") or [] if p not in tsps]
            if bad:
                raise HTTPException(400, f"tab {tab['title']}: {', '.join(bad)} {'is not a time series property' if len(bad) == 1 else 'are not time series properties'} of {src['display_name']}")
            if tab.get("ts_source") == "linked" and not tab.get("ts_properties"):
                raise HTTPException(400, f"tab {tab['title']}: pick the time series properties of {src['display_name']} to chart")
            if tab.get("ts_source") != "linked" and not tsps and not tab.get("ts_sensors"):
                raise HTTPException(400, f"tab {tab['title']}: {src['display_name']} has no time series properties (chart its linked sensors, or the linked objects of a link type)")
        if tab["kind"] == "html":
            if not (tab.get("html") or "").strip():
                raise HTTPException(400, f"tab {tab['title']}: write the HTML")
            bad = sorted({m for m in PLACEHOLDER_RE.findall(tab["html"]) if m not in names and m not in HTML_BUILTINS})
            if bad:
                raise HTTPException(400, f"tab {tab['title']}: {t['display_name']} has no properties {', '.join(bad)} (placeholders are {{{{property}}}}, {{{{title}}}} and {{{{primary_key}}}})")
        if tab["kind"] == "quiver_dashboard":
            import ts_derived

            if not tab.get("dashboard_id"):
                raise HTTPException(400, f"tab {tab['title']}: pick the published Quiver dashboard")
            ts_derived._dashboard_item(tab["dashboard_id"])
        if tab["kind"] == "form":
            _check_form(t, tab, names)
        if tab["kind"] == "workshop" and not tab.get("module_id"):
            raise HTTPException(400, f"tab {tab['title']}: pick the Workshop module")
        if tab["kind"] == "url" and not (tab.get("url") or "").startswith(("http://", "https://", "/")):
            raise HTTPException(400, f"tab {tab['title']}: give a link")
        v = tab.get("visibility")
        if v:
            if v.get("kind") == "property" and (v.get("property") not in names or v.get("op") not in ("eq", "neq")):
                raise HTTPException(400, f"tab {tab['title']}: a property condition needs a property and eq / neq")
            if v.get("kind") == "link":
                ontology._get("link-types", v.get("link_type_id") or "", "link type")
    for a in cfg["set_panel_aggregates"]:
        if a.get("metric") not in ("count", "sum", "avg", "min", "max") or (a.get("metric") != "count" and a.get("property") not in names):
            raise HTTPException(400, "an object set panel aggregate is count, or sum / avg / min / max of a property")


def _form_def(form_id: str, title: str) -> Optional[dict]:
    """The form's published definition (None while it has none); 400 when the form does not exist."""
    import forms

    try:
        item = forms._form_item(form_id)
    except HTTPException:
        raise HTTPException(400, f"tab {title}: the form {form_id} does not exist") from None
    form = forms._load(item)
    return next((v["definition"] for v in form.get("versions") or [] if v["n"] == form.get("published")), None)


def _form_fields(defn: dict) -> list[dict]:
    return [f for s in defn.get("sheets") or [] for f in s.get("fields") or []]


def _linked_target(t: dict, tab: dict) -> tuple[dict, dict]:
    """(link type, linked object type) of a Create linked object form; 400 when the new object cannot be linked by it:
    a foreign key must be held by the linked type (the new object), object backed links are not created by a form."""
    other = _other(t, tab)
    lt = ontology._get("link-types", tab["link_type_id"], "link type")
    if lt["kind"] == "object_backed":
        raise HTTPException(400, f"tab {tab['title']}: an object backed link is made by its backing object; pick a foreign key or join table link type")
    if lt["kind"] == "foreign_key" and om.side_of(lt, tab["direction"])[1] is not lt["source"]:
        raise HTTPException(400, f"tab {tab['title']}: the foreign key {lt.get('foreign_key')} is held by {t['display_name']}, so a new "
                                 f"{other['display_name']} cannot be linked by the form; pick a link whose key {other['display_name']} holds, or a join table")
    return lt, other


def _check_form(t: dict, tab: dict, names: set) -> None:
    """A form tab: the forms exist, prefilled values name fields of the form (when it is published) and placeholders
    name properties of the viewed object; conditions name properties with eq / neq. A Create linked object form: the
    link type starts from this type and can link a new object, the forms write the linked type (and its foreign key),
    {{last.property}} placeholders and the sort property name properties of the linked type."""
    title = tab["title"]
    if not tab.get("form_id"):
        raise HTTPException(400, f"tab {title}: pick the form")
    linked = tab.get("form_mode") == "create_linked"
    lt, other = _linked_target(t, tab) if linked else (None, None)
    theirs = {p["api_name"] for p in other["properties"]} if other else set()
    defn = _form_def(tab["form_id"], title)
    if defn:
        fields = {f["id"] for f in _form_fields(defn)}
        bad = [k for k in tab.get("form_prefill") or {} if k not in fields]
        if bad:
            raise HTTPException(400, f"tab {title}: the form has no fields {', '.join(bad)}")
    holders = set()
    for m in {m for v in (tab.get("form_prefill") or {}).values() for m in PLACEHOLDER_RE.findall(str(v))}:
        if m.startswith("last.") and linked:
            if m[5:] not in theirs:
                raise HTTPException(400, f"tab {title}: {other['display_name']} has no property {m[5:]} ({{{{last.property}}}} is a property of the last linked object)")
        elif m not in names:
            holders.add(m)
    if holders:
        last = " or {{last.property}} of the last linked object" if linked else ""
        raise HTTPException(400, f"tab {title}: {t['display_name']} has no properties {', '.join(sorted(holders))} (prefilled values are text or {{{{property}}}}{last})")
    for c in tab.get("form_conditions") or []:
        if c.get("property") not in names or c.get("op", "eq") not in ("eq", "neq") or not c.get("form_id"):
            raise HTTPException(400, f"tab {title}: a conditional form needs a property of {t['display_name']}, eq / neq and a form")
        _form_def(c["form_id"], title)
    if not linked:
        return
    if tab.get("form_last_sort") and tab["form_last_sort"] not in theirs:
        raise HTTPException(400, f"tab {title}: {other['display_name']} has no property {tab['form_last_sort']} to find the last linked object by")
    for fid in [tab["form_id"], *[c["form_id"] for c in tab.get("form_conditions") or []]]:
        d = _form_def(fid, title)
        if not d:
            continue  # checked again once it is published: a form without a published version is not shown
        dest = d.get("destination") or {}
        if dest.get("kind") != "object_type" or dest.get("object_type_id") != other["id"]:
            raise HTTPException(400, f"tab {title}: the form {d.get('title') or fid} must write {other['display_name']} objects to create a linked one")
        if lt["kind"] == "foreign_key" and not _fk_fields(d, lt["foreign_key"]):
            raise HTTPException(400, f"tab {title}: the form {d.get('title') or fid} has no field for {lt['foreign_key']}, the key that links a {other['display_name']} to {t['display_name']}")


def _form_tab(tab: dict, props: dict) -> dict:
    """The form a form tab shows for this object (the first condition that holds, else the default one), with its
    name and whether it is published; form_error when the viewer cannot open it."""
    import forms

    form_id = tab.get("form_id")
    for c in tab.get("form_conditions") or []:
        if _visible({"visibility": {"kind": "property", "property": c.get("property"), "op": c.get("op", "eq"), "value": c.get("value")}}, props):
            form_id = c.get("form_id")
            break
    out: dict = {"form_id": form_id, "form_name": None, "form_published": False}
    try:
        item = forms._respondent_item(form_id or "", None)
        out.update(form_name=item.get("name"), form_published=bool(forms._load(item).get("published")))
    except HTTPException as e:
        out["form_error"] = "the form does not exist" if e.status_code == 404 else "you cannot open this form"
    return out


def _fk_fields(defn: dict, fk: str) -> list[dict]:
    """The stored fields of a form that write a foreign key property."""
    import forms

    return [f for f in _form_fields(defn) if (f.get("column") or f["id"]) == fk and f["type"] not in forms.NOT_STORED]


def _last_linked(rows: list[dict], sort: Optional[str]) -> Optional[dict]:
    """The last of the linked objects: the greatest value of the sort property (objects without one never win; among
    equal values the most recently created), by default the most recently created (then the most recently stored)."""
    newest = lambda x: (x[1].get("created_at") or "", x[0])  # noqa: E731
    if sort:
        rows = [r for r in rows if r["properties"].get(sort) not in (None, "")]
        if not rows:
            return None
        try:
            return max(enumerate(rows), key=lambda x: (x[1]["properties"][sort], *newest(x)))[1]
        except TypeError:  # mixed value types: compare as text
            return max(enumerate(rows), key=lambda x: (str(x[1]["properties"][sort]), *newest(x)))[1]
    return max(enumerate(rows), key=newest)[1] if rows else None


def _last_value(text: str, last: Optional[dict]):
    """A prefilled value with {{last.property}} taken from the last linked object (a whole placeholder keeps the value's
    type; none when there is no last object); other placeholders are left for the form ({{property}} of the object)."""
    pattern = r"\{\{\s*last\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}"
    if not re.search(pattern, text):
        return text
    if not last:
        return None
    whole = re.fullmatch(pattern, text)
    if whole:
        return last["properties"].get(whole.group(1))
    return re.sub(pattern, lambda m: _text(last["properties"].get(m.group(1))), text)


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, list):
        return ", ".join(_text(x) for x in v)
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


COPY_SKIP = ("primary_key", "created_at", "created_by", "attachments", "calculation", "template")


def _create_linked(t: dict, key: str, tab: dict, form_id: Optional[str]) -> dict:
    """A Create linked object form for one object: the prefilled values (the foreign key, the last linked object's
    values, the tab's own), the last linked object and the link."""
    import forms

    lt = _read(ontology._path("link-types", tab.get("link_type_id") or ""))
    if not lt:
        return {"form_error": "its link type no longer exists"}
    other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])
    objs = ontology._objects(other["id"])
    pks = om.linked_map(lt, tab["direction"], {key}).get(key) or []
    rows = [ontology._public_object(other, x, objs[x]) for x in pks if x in objs and ontology._can_see(other, objs[x])]
    last = _last_linked(rows, tab.get("form_last_sort"))
    defn = None
    try:
        defn = forms._published(forms._load(forms._respondent_item(form_id or "", None)))
    except HTTPException:
        pass
    prefill: dict = {}
    if defn and tab.get("form_copy_last") and last and (defn.get("destination") or {}).get("object_type_id") == other["id"]:
        for f in _form_fields(defn):
            col = f.get("column") or f["id"]
            v = last["properties"].get(col)
            if f["type"] in forms.READ_ONLY or f["type"] in COPY_SKIP or col == other["primary_key"] or v in (None, "", []):
                continue
            prefill[f["id"]] = v
    if defn and lt["kind"] == "foreign_key":
        for f in _fk_fields(defn, lt["foreign_key"]):
            prefill[f["id"]] = key
    for fid, v in (tab.get("form_prefill") or {}).items():
        v = _last_value(str(v), last)
        if v not in (None, "", []):
            prefill[fid] = v
    return {"form_prefill": prefill,
            "form_last": {"primary_key": last["primary_key"], "title": last["title"]} if last else None,
            "form_link": {"link_type_id": lt["id"], "direction": tab["direction"], "kind": lt["kind"], "object_type_id": other["id"],
                          "object_type": other["display_name"], "count": len(rows)}}


def _store(tid: str) -> dict:
    return _read(_views_path(tid), None) or {"versions": [], "published": None, "auto_publish": True}


@router.get("/object-types/{type_id}/views")
def get_views(type_id: str) -> dict:
    t = ontology._object_type(type_id)
    st = _store(type_id)
    pub = next((v for v in st["versions"] if v["version"] == st["published"]), None)
    return {"auto_publish": st["auto_publish"], "published": st["published"], "configured": bool(st["versions"]),
            "versions": [{k: v.get(k) for k in ("version", "at", "author", "description")} | {"is_published": v["version"] == st["published"],
                                                                                             "was_published": bool(v.get("published_at"))} for v in reversed(st["versions"])],
            "latest": st["versions"][-1]["config"] if st["versions"] else default_config(t),
            "config": pub["config"] if pub else default_config(t)}


class SaveIn(BaseModel):
    config: ViewConfig
    description: str = Field("", max_length=500)
    auto_publish: Optional[bool] = None


@router.post("/object-types/{type_id}/views")
def save_view(type_id: str, req: SaveIn) -> dict:
    """Save a new version (published at once when automatic publishing is on)."""
    with _lock:
        t = ontology._object_type(type_id)
        om.require_role(t.get("ontology_id"), "editor", t, "configure Object Views")
        cfg = req.config.model_dump()
        _check(t, cfg)
        st = _store(type_id)
        if req.auto_publish is not None:
            st["auto_publish"] = req.auto_publish
        n = (st["versions"][-1]["version"] if st["versions"] else 0) + 1
        v = {"version": n, "at": _now(), "author": _who(), "description": req.description or f"Version {n}", "config": cfg}
        if st["auto_publish"]:
            v["published_at"] = v["at"]
            st["published"] = n
        st["versions"] = (st["versions"] + [v])[-VERSIONS_KEPT:]
        _write(_views_path(type_id), st)
        if st["published"] == n:
            _mirror(t, cfg)
    return get_views(type_id)


def _mirror(t: dict, cfg: dict) -> None:
    """Keep the header properties in the object type's own Object View settings (Object Explorer reads them)."""
    t = ontology._object_type(t["id"])
    t["object_view"] = {**(t.get("object_view") or {}), "header_properties": cfg["header_properties"]}
    ontology._put("object-types", t)


class PublishIn(BaseModel):
    version: int


@router.post("/object-types/{type_id}/views/publish")
def publish(type_id: str, req: PublishIn) -> dict:
    with _lock:
        t = ontology._object_type(type_id)
        om.require_role(t.get("ontology_id"), "editor", t, "publish Object Views")
        st = _store(type_id)
        v = next((x for x in st["versions"] if x["version"] == req.version), None)
        if not v:
            raise HTTPException(404, "version not found")
        v.setdefault("published_at", _now())
        st["published"] = req.version
        _write(_views_path(type_id), st)
        _mirror(t, v["config"])
    return get_views(type_id)


@router.post("/object-types/{type_id}/views/restore")
def restore(type_id: str, req: PublishIn) -> dict:
    """Save an earlier version again as the newest one."""
    st = _store(type_id)
    v = next((x for x in st["versions"] if x["version"] == req.version), None)
    if not v:
        raise HTTPException(404, "version not found")
    return save_view(type_id, SaveIn(config=ViewConfig(**v["config"]), description=f"Restored version {req.version}"))


# ------------------------------------------------------------------------------------------------
# rendering
# ------------------------------------------------------------------------------------------------


def _visible(tab: dict, props: dict) -> bool:
    v = tab.get("visibility")
    if not v:
        return True
    if v.get("kind") == "property":
        same = str(props.get(v["property"]) if props.get(v["property"]) is not None else "") == str(v.get("value") if v.get("value") is not None else "")
        return same if v.get("op") == "eq" else not same
    if v.get("kind") == "link":
        lt = _read(ontology._path("link-types", v.get("link_type_id") or ""))
        if not lt:
            return False
        for side in (lt["source"], lt["target"]):
            try:
                ontology._object_type(side["object_type_id"])
            except HTTPException:
                return False
        return True
    return True


def _timeline(t: dict, pk: str, pub: dict) -> list[dict]:
    """Dated properties of the object and of its linked objects, newest first."""
    out = []
    for p in t["properties"]:
        if p["type"] in ("date", "timestamp") and pub["properties"].get(p["api_name"]):
            out.append({"at": str(pub["properties"][p["api_name"]]), "label": p["display_name"], "object_type_id": t["id"], "primary_key": pk, "title": pub["title"]})
    for lt, direction in om.links_of(t["id"]):
        other = ontology._object_type(om.side_of(lt, direction)[1]["object_type_id"])
        dated = [p for p in other["properties"] if p["type"] in ("date", "timestamp")]
        if not dated:
            continue
        objs = ontology._objects(other["id"])
        for opk in (om.linked_map(lt, direction, {pk}).get(pk) or [])[:200]:
            o = objs.get(opk)
            if not o or not ontology._can_see(other, o):
                continue
            op = ontology._public_object(other, opk, o)
            for p in dated[:2]:
                if op["properties"].get(p["api_name"]):
                    out.append({"at": str(op["properties"][p["api_name"]]), "label": f"{other['display_name']} · {p['display_name']}",
                                "object_type_id": other["id"], "primary_key": opk, "title": op["title"]})
    return sorted(out, key=lambda e: e["at"], reverse=True)[:300]


def _chart(tab: dict, rows: list[dict]) -> list[dict]:
    """The linked objects grouped by a property: [{label, value, count}], largest first."""
    groups: dict[str, list[dict]] = {}
    for r in rows:
        v = r["properties"].get(tab["group_by"])
        for label in (v if isinstance(v, list) else [v]):
            groups.setdefault("—" if label in (None, "") else str(label), []).append(r)
    out = []
    for label, rs in groups.items():
        if tab.get("metric", "count") == "count":
            out.append({"label": label, "value": len(rs), "count": len(rs)})
            continue
        nums = []
        for r in rs:
            try:
                nums.append(float(r["properties"].get(tab["value_property"])))
            except (TypeError, ValueError):
                pass
        m = tab["metric"]
        val = None if not nums else sum(nums) if m == "sum" else sum(nums) / len(nums) if m == "avg" else min(nums) if m == "min" else max(nums)
        out.append({"label": label, "value": None if val is None else round(val, 4), "count": len(rs)})
    return sorted(out, key=lambda g: (-(g["value"] or 0), g["label"]))[:CHART_GROUPS]


def _facets(tab: dict, other: dict, rows: list[dict]) -> list[dict]:
    """The filters of a linked objects tab: each property's values among the linked objects, with counts."""
    names = {p["api_name"]: p["display_name"] for p in other["properties"]}
    out = []
    for prop in tab.get("filters") or []:
        if prop not in names:
            continue
        counts: dict[str, int] = {}
        for r in rows:
            v = r["properties"].get(prop)
            for x in (v if isinstance(v, list) else [v]):
                key = "" if x is None else str(x)
                counts[key] = counts.get(key, 0) + 1
        out.append({"property": prop, "display_name": names[prop], "values": [{"value": k, "count": n} for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:50]]})
    return out


def _geo_feature(ptype: str, value) -> Optional[dict]:
    """A geopoint as {kind: point, lat, lon}, a geoshape as {kind: shape, geometry} with its bounds; None when the
    value is empty or not usable."""
    import geo

    if value in (None, ""):
        return None
    try:
        if ptype == "geopoint":
            lat, lon = geo.lat_lon(value)
            return {"kind": "point", "lat": lat, "lon": lon, "bounds": [lon, lat, lon, lat]}
        g = geo.parse_geojson(value)
        if g.get("type") == "Feature":
            g = g.get("geometry") or {}
        if g.get("type") not in geo.GEOSHAPE_TYPES:
            return None
        pos = [(float(p[0]), float(p[1])) for p in geo._positions(g.get("coordinates")) if len(p) >= 2]
        if not pos:
            return None
        return {"kind": "shape", "geometry": {"type": g["type"], "coordinates": g["coordinates"]},
                "bounds": [min(p[0] for p in pos), min(p[1] for p in pos), max(p[0] for p in pos), max(p[1] for p in pos)]}
    except (geo.GeoError, TypeError, ValueError):
        return None


def _map(tab: dict, t: dict, key: str, pub: dict) -> dict:
    """A map tab: the viewed object's geo property and the linked objects' (the ones the caller can see), with the
    bounds of everything drawn. Objects without a usable location are counted, not drawn."""
    by = {p["api_name"]: p for p in t["properties"]}
    features, skipped = [], 0
    if tab.get("geo_property") in by:
        f = _geo_feature(by[tab["geo_property"]]["type"], pub["properties"].get(tab["geo_property"]))
        if f:
            features.append({**f, "role": "object", "object_type_id": t["id"], "primary_key": key, "title": pub["title"]})
        else:
            skipped += 1
    out: dict = {}
    lt = _read(ontology._path("link-types", tab["link_type_id"])) if tab.get("link_type_id") else None
    if lt:
        try:
            other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])
        except HTTPException:
            other = None  # the caller cannot see the linked object type: only the object itself is drawn
        ptype = next((p["type"] for p in (other or {}).get("properties", []) if p["api_name"] == tab.get("linked_geo_property")), None)
        if other and ptype:
            objs = ontology._objects(other["id"])
            rows = [ontology._public_object(other, x, objs[x]) for x in (om.linked_map(lt, tab["direction"], {key}).get(key) or []) if x in objs and ontology._can_see(other, objs[x])]
            out.update(object_type_id=other["id"], object_type=other["display_name"], count=len(rows))
            for r in rows[:MAP_LINKED]:
                f = _geo_feature(ptype, r["properties"].get(tab["linked_geo_property"]))
                if not f:
                    skipped += 1
                    continue
                label = r["properties"].get(tab["label_property"]) if tab.get("label_property") else None
                features.append({**f, "role": "linked", "object_type_id": other["id"], "primary_key": r["primary_key"], "title": r["title"] if label in (None, "") else str(label)})
    bs = [f["bounds"] for f in features]
    out.update(features=features, skipped=skipped, bounds=[min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)] if bs else None)
    return out


def ts_range_start(rng: Optional[str]) -> Optional[str]:
    """The start of "the last N units" as ISO text (None: everything)."""
    m = TS_RANGE_RE.match(rng or "")
    if not m:
        return None
    return (datetime.now(timezone.utc) - timedelta(seconds=int(m.group(1)) * TS_UNITS[m.group(2)])).isoformat()


def _timeseries(tab: dict, t: dict, key: str) -> dict:
    """A time series tab: the series it charts ({object, property} as the series route takes them) with their
    points over the default range, read as the caller."""
    import ts_ontology

    wanted = tab.get("ts_properties") or []
    refs: list[dict] = []
    out: dict = {}
    if tab.get("ts_source") == "linked":
        lt = _read(ontology._path("link-types", tab.get("link_type_id") or ""))
        try:
            other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"]) if lt else None
        except HTTPException:
            other = None
        if other:
            objs = ontology._objects(other["id"])
            names = {p["api_name"]: p["display_name"] for p in other["properties"]}
            rows = [ontology._public_object(other, x, objs[x]) for x in (om.linked_map(lt, tab["direction"], {key}).get(key) or []) if x in objs and ontology._can_see(other, objs[x])]
            out.update(object_type_id=other["id"], object_type=other["display_name"], count=len(rows))
            for r in rows[:TS_LINKED]:
                for p in wanted:
                    if p in names and r["properties"].get(p) not in (None, ""):
                        refs.append({"object_type_id": other["id"], "primary_key": r["primary_key"], "property": p, "source": "linked",
                                     "label": f"{r['title']} · {names[p]}" if len(wanted) > 1 else r["title"]})
    else:
        try:
            tsps = ts_ontology.object_tsps(t["id"], key)
        except Exception as e:  # noqa: BLE001 - the engine's own errors: shown on the tab
            return {"ts_series": [], "ts_error": str(e)}
        for s in tsps:
            if (s["source"] == "property" and (not wanted or s["key"] in wanted)) or (s["source"] == "sensor" and tab.get("ts_sensors")):
                refs.append({"object_type_id": t["id"], "primary_key": key, "property": s["key"], "label": s["label"], "source": s["source"]})
    start = ts_range_start(tab.get("ts_range"))
    series = []
    for ref in refs:
        item = {**ref, "key": f"{ref['object_type_id']}:{ref['primary_key']}:{ref['property']}", "unit": None, "categorical": False, "points": []}
        try:
            res = ts_ontology.object_series(ref["object_type_id"], ref["primary_key"], property=ref["property"], start=start, end=None, buckets=TS_BUCKETS,
                                            resource="object-view", rolling=None, aggregation="mean", raw=False)
            item.update(unit=res.get("unit"), categorical=bool(res.get("categorical")), points=res.get("points") or [])
        except HTTPException as e:
            item["error"] = str(e.detail)
        series.append(item)
    out.update(ts_series=series, ts_start=start)
    return out


# -- free-form HTML ------------------------------------------------------------------------------

HTML_TAGS = frozenset(
    "a abbr article b blockquote br caption code col colgroup dd details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img li mark "
    "ol p pre s section small span strong style sub summary sup table tbody td tfoot th thead time tr u ul".split())
HTML_VOID = frozenset(("br", "hr", "img", "col"))
# elements dropped with everything inside them (other unknown elements are dropped but their text is kept)
HTML_DROPPED = frozenset("script iframe object embed noscript template svg math frame frameset applet head title textarea select button form audio video canvas".split())
HTML_ATTRS = frozenset(("class", "id", "style", "title", "colspan", "rowspan", "align", "valign", "width", "height", "alt", "open", "datetime", "span"))
# anything that loads a resource (url(), src(), image-set(), @import, @font-face), runs script (expression(), behavior,
# -moz-binding, -o-link, javascript:) or hides one of these behind an escape or a comment
CSS_BAD_RE = re.compile(r"url\s*\(|src\s*\(|image(-set)?\s*\(|expression|@import|@font-face|@namespace|javascript:|vbscript:|behavio[u]?r\s*:|-moz-binding|-o-link|\\|/\*|</", re.I)
URL_OK_RE = re.compile(r"^(https?://|mailto:|/(?![/\\])|#)", re.I)
IMG_DATA_RE = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$", re.I)


def _safe_url(value: Optional[str], image: bool = False) -> Optional[str]:
    """The URL when it is http(s), mailto, a path of this site or a fragment (an image: also inline png / jpeg / gif /
    webp data); None otherwise (javascript:, data:text/html, vbscript:, protocol-relative …)."""
    # as a browser reads it: surrounding controls and spaces go, tabs / newlines anywhere go; any other control
    # character left makes the URL unusable
    url = re.sub(r"[\t\n\r]+", "", (value or "").strip("".join(map(chr, range(0x21)))))
    if re.search(r"[\x00-\x1f\x7f]", url):
        return None
    if URL_OK_RE.match(url) and not (image and url.lower().startswith("mailto:")):
        return url
    if image and IMG_DATA_RE.match(url):
        return url
    return None


class _Sanitizer(HTMLParser):
    """Rebuilds HTML from an allow-list: known tags and attributes only, every text and attribute value escaped again
    on the way out. Scripts, frames, forms, SVG and the like go with their content; on* attributes, unknown
    attributes and unsafe URLs are left out; CSS that could load something or break out of its element is dropped."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.dropping: list[str] = []  # open elements whose content is dropped
        self.in_style = False
        self.removed: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if self.dropping:
            if tag in HTML_DROPPED and tag not in ("embed", "frame"):
                self.dropping.append(tag)
            return
        if tag in HTML_DROPPED:
            self.removed.append(f"<{tag}>")
            if tag not in ("embed", "frame"):  # these two have no content and no end tag
                self.dropping.append(tag)
            return
        if tag not in HTML_TAGS:
            self.removed.append(f"<{tag}>")
            return
        kept = []
        for name, value in attrs:
            name = (name or "").lower()
            value = "" if value is None else value
            if name == "href" and tag == "a":
                url = _safe_url(value)
                if url is None:
                    self.removed.append(f"{tag} href")
                    continue
                kept.append(("href", url))
            elif name == "src" and tag == "img":
                url = _safe_url(value, image=True)
                if url is None:
                    self.removed.append(f"{tag} src")
                    continue
                kept.append(("src", url))
            elif name == "style":
                if CSS_BAD_RE.search(value):
                    self.removed.append(f"{tag} style")
                    continue
                kept.append(("style", value))
            elif name in HTML_ATTRS:
                kept.append((name, value))
            else:
                self.removed.append(f"{tag} {name}")
        if tag == "a":
            kept += [("target", "_blank"), ("rel", "noopener noreferrer")]
        self.out.append(f"<{tag}" + "".join(f' {n}="{html_lib.escape(v, quote=True)}"' for n, v in kept) + ">")
        if tag == "style":
            self.in_style = True

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in HTML_VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.dropping:
            if tag == self.dropping[-1]:
                self.dropping.pop()
            return
        if tag == "style":
            self.in_style = False
        if tag in HTML_TAGS and tag not in HTML_VOID:
            self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self.dropping:
            return
        if self.in_style:
            # a style sheet is raw text: kept as written unless it could load something or close its element
            if CSS_BAD_RE.search(data) or "<" in data:
                self.removed.append("style sheet")
            else:
                self.out.append(data)
            return
        self.out.append(html_lib.escape(data, quote=False))

    # comments, doctypes, processing instructions and CDATA sections are left out
    def handle_comment(self, data: str) -> None:
        pass

    def handle_decl(self, decl: str) -> None:
        pass

    def handle_pi(self, data: str) -> None:
        pass

    def unknown_decl(self, data: str) -> None:
        pass


def sanitize_html(text: str) -> tuple[str, list[str]]:
    """(safe HTML, what was removed) — see _Sanitizer."""
    s = _Sanitizer()
    s.feed(text or "")
    s.close()
    return "".join(s.out), list(dict.fromkeys(s.removed))[:50]


def _html_value(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (list, tuple)):
        return ", ".join(_html_value(x) for x in v)
    if isinstance(v, dict):
        import json

        return json.dumps(v, ensure_ascii=False)
    return str(v)


def render_html(template: str, pub: dict, type_id: str = "") -> tuple[str, list[str]]:
    """The template with {{property}} / {{title}} / {{primary_key}} (also {{objectId}} / {{objectTypeId}}, as in the
    Markdown widget) replaced by the object's values (as the caller sees them), each escaped; then sanitized as a
    whole, so a value cannot add markup, an attribute or a script URL."""
    values = {**pub["properties"], "title": pub["title"], "primary_key": pub["primary_key"], "objectId": pub["primary_key"], "objectTypeId": type_id}
    # a property named title / primary_key wins over the built-in of the same name
    for k in HTML_BUILTINS:
        if k in pub["properties"]:
            values[k] = pub["properties"][k]
    # whitespace too becomes a character reference, so a value in an unquoted attribute stays that attribute's value
    filled = PLACEHOLDER_RE.sub(lambda m: re.sub(r"[\t\n\f\r ]", lambda w: f"&#{ord(w.group())};", html_lib.escape(_html_value(values.get(m.group(1))), quote=True)), template or "")
    return sanitize_html(filled)


@router.get("/object-views/{type_id}/{pk}")
def render(type_id: str, pk: str, version: Optional[int] = None) -> dict:
    """The configured (published, or a given version for previews) Object View of one object: visible tabs with content."""
    with _lock:
        t = ontology._object_type(type_id)
        key, obj = ontology._find(t, pk)
        pub = ontology._public_object(t, key, obj)
        st = _store(type_id)
        chosen = next((v for v in st["versions"] if v["version"] == (version or st["published"])), None)
        cfg = chosen["config"] if chosen else default_config(t)
        tabs = []
        for tab in cfg["tabs"]:
            if not _visible(tab, pub["properties"]):
                continue
            item = {**tab}
            if tab["kind"] in LINKED_KINDS:
                lt = _read(ontology._path("link-types", tab["link_type_id"]))
                if not lt:
                    continue
                other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])
                objs = ontology._objects(other["id"])
                pks = om.linked_map(lt, tab["direction"], {key}).get(key) or []
                shown = [p for p in other["properties"] if p.get("visibility") != "hidden" and p["type"] != "vector"]
                item.update(object_type_id=other["id"], object_type=other["display_name"])
                if tab["kind"] == "chart":
                    # every linked object counts in a chart, not only the first 200 a table shows
                    rows = [ontology._public_object(other, x, objs[x]) for x in pks if x in objs and ontology._can_see(other, objs[x])]
                    item.update(count=len(rows), series=_chart(tab, rows))
                    tabs.append(item)
                    continue
                rows = [ontology._public_object(other, x, objs[x]) for x in pks[:200] if x in objs and ontology._can_see(other, objs[x])]
                if tab["kind"] == "linked_view":
                    names = tab.get("linked_properties") or [p["api_name"] for p in shown if p.get("visibility") == "prominent"] or [p["api_name"] for p in shown[:8]]
                    by = {p["api_name"]: p for p in other["properties"]}
                    item.update(count=len(rows), views=[{"primary_key": r["primary_key"], "title": r["title"],
                                                         "fields": [{"api_name": n, "display_name": by[n]["display_name"], "type": by[n]["type"], "value": r["properties"].get(n)} for n in names if n in by]}
                                                        for r in rows[:LINKED_VIEWS]])
                    tabs.append(item)
                    continue
                item.update(count=len(rows), objects=rows, facets=_facets(tab, other, rows), columns=[p["api_name"] for p in shown][:6])
            elif tab["kind"] == "map":
                item.update(_map(tab, t, key, pub))
            elif tab["kind"] == "timeseries":
                item.update(_timeseries(tab, t, key))
            elif tab["kind"] == "html":
                # the page only ever gets the sanitized result, never the template
                item["html"] = None
                item["html_rendered"], item["html_removed"] = render_html(tab.get("html") or "", pub, t["id"])
            elif tab["kind"] == "form":
                item.update(_form_tab(tab, pub["properties"]))
                if tab.get("form_mode") == "create_linked" and not item.get("form_error"):
                    item.update(_create_linked(t, key, tab, item["form_id"]))
            elif tab["kind"] == "timeline":
                item["events"] = _timeline(t, key, pub)
            elif tab["kind"] == "edit_history":
                item["history"] = om.object_history(type_id, key)
            elif tab["kind"] == "comments":
                item["count"] = len(comments_of(type_id, key))
            tabs.append(item)
    return {"object": pub, "object_type": {"id": t["id"], "display_name": t["display_name"], "properties": t["properties"]},
            "version": chosen["version"] if chosen else None, "configured": bool(chosen), "header_properties": cfg["header_properties"],
            "panel_properties": cfg["panel_properties"], "sidebar": cfg["sidebar"], "tabs": tabs,
            "urls": {"full": f"/ontology/objects/{type_id}/{key}", "panel": f"/ontology/objects/{type_id}/{key}?panel=1"}}


class LinkedFormIn(BaseModel):
    tab_id: str
    response_id: str
    version: Optional[int] = None


@router.post("/object-views/{type_id}/{pk}/linked-form")
def link_created(type_id: str, pk: str, req: LinkedFormIn) -> dict:
    """After a Create linked object form's submission: the objects the response created are linked to this object
    (a join table link is added; a foreign key link was written by the form and is checked). Only the person who
    submitted the response, from this object's view, can link it; linking twice changes nothing."""
    import forms

    with _lock:
        t = ontology._object_type(type_id)
        key, obj = ontology._find(t, pk)
        props = ontology._public_object(t, key, obj)["properties"]
        st = _store(type_id)
        chosen = next((v for v in st["versions"] if v["version"] == (req.version or st["published"])), None)
        cfg = chosen["config"] if chosen else default_config(t)
        tab = next((x for x in cfg["tabs"] if x.get("id") == req.tab_id and x["kind"] == "form" and x.get("form_mode") == "create_linked"), None)
        if not tab or not _visible(tab, props):
            raise HTTPException(404, "this view has no Create linked object form tab " + req.tab_id)
        form_id = _form_tab(tab, props)["form_id"]
        lt = ontology._get("link-types", tab.get("link_type_id") or "", "link type")
        other = ontology._object_type(om.side_of(lt, tab["direction"])[1]["object_type_id"])
    response = next((r for r in forms._responses(form_id or "") if r["id"] == req.response_id), None)
    if not response:
        raise HTTPException(404, "the form has no response " + req.response_id)
    if response.get("by") != forms._me()["username"]:
        raise HTTPException(403, "only the person who submitted the response can link what it created")
    src = response.get("source") or {}
    if src.get("object_type") != type_id or str(src.get("pk")) != str(key):
        raise HTTPException(400, f"the response was not submitted from this {t['display_name']}'s view")
    created = [str(w["primary_key"]) for w in response.get("written") or [] if w.get("object_type_id") == other["id"]]
    if not created:
        raise HTTPException(400, f"the response created no {other['display_name']}")
    with _lock:
        have = set(om.linked_map(lt, tab["direction"], {key}).get(key) or [])
    added, missing = [], []
    for c in created:
        if c in have:
            continue
        if lt["kind"] == "join_table":
            source, target = (key, c) if tab["direction"] == "forward" else (c, key)
            om.edit_link(lt["id"], om.LinkEditIn(op="add", source=source, target=target))
            added.append(c)
        else:
            missing.append(c)  # a foreign key the form did not write (or wrote another key into)
    return {"link_type_id": lt["id"], "kind": lt["kind"], "object_type_id": other["id"], "created": created, "added": added, "not_linked": missing}


class SetPanelIn(BaseModel):
    primary_keys: list[str] = Field(min_length=1, max_length=5000)


@router.post("/object-views/{type_id}/set-panel")
def set_panel(type_id: str, req: SetPanelIn) -> dict:
    """An object set panel: the configured aggregates over the given objects."""
    t = ontology._object_type(type_id)
    cfg = _store(type_id)
    pubv = next((v for v in cfg["versions"] if v["version"] == cfg["published"]), None)
    aggs = (pubv["config"] if pubv else default_config(t))["set_panel_aggregates"] or [{"metric": "count"}]
    objs = ontology._objects(type_id)
    rows = [ontology._public_object(t, pk, objs[pk])["properties"] for pk in req.primary_keys if pk in objs and ontology._can_see(t, objs[pk])]
    out = []
    for a in aggs:
        if a["metric"] == "count":
            out.append({"label": "Objects", "value": len(rows)})
            continue
        nums = []
        for r in rows:
            try:
                nums.append(float(r.get(a["property"])))
            except (TypeError, ValueError):
                pass
        val = None if not nums else sum(nums) if a["metric"] == "sum" else sum(nums) / len(nums) if a["metric"] == "avg" else min(nums) if a["metric"] == "min" else max(nums)
        out.append({"label": f"{a['metric']} {a['property']}", "value": val})
    return {"objects": len(rows), "aggregates": out}


# ------------------------------------------------------------------------------------------------
# comments
# ------------------------------------------------------------------------------------------------


def comments_of(tid: str, pk: str) -> list[dict]:
    return (_read(_comments_path(tid), {}) or {}).get(str(pk), [])


@router.get("/object-types/{type_id}/objects/{pk}/comments")
def list_comments(type_id: str, pk: str) -> list[dict]:
    """The object's comments; each attachment the reader can open comes with its file name."""
    import drive

    ontology.get_object(type_id, pk)
    out = []
    for c in comments_of(type_id, pk):
        files = []
        for fid in c.get("attachments") or []:
            try:
                files.append({"id": fid, "name": drive._item(fid)["name"]})
            except HTTPException:
                continue  # deleted, or not shared with this reader
        out.append({**c, "files": files})
    return out


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    attachments: list[str] = Field([], max_length=10)  # Files item ids
    reply_to: Optional[str] = None


def _mentions(text: str) -> list[dict]:
    names = set(re.findall(r"@([A-Za-z0-9_.-]+)", text))
    if not names:
        return []
    try:
        users = auth._users()
    except Exception:  # noqa: BLE001 - no user store (sign-in off): mentions stay text
        return [{"username": n, "user_id": None} for n in sorted(names)]
    by = {u["username"]: u for u in users}
    return [{"username": n, "user_id": by[n]["id"] if n in by else None} for n in sorted(names)]


@router.post("/object-types/{type_id}/objects/{pk}/comments")
def add_comment(type_id: str, pk: str, req: CommentIn) -> dict:
    obj = ontology.get_object(type_id, pk)
    t = ontology._object_type(type_id)
    c = {"id": f"cmt-{uuid.uuid4().hex[:10]}", "at": _now(), "user": _who(), "text": req.text.strip(), "attachments": req.attachments,
         "reply_to": req.reply_to, "mentions": _mentions(req.text)}
    with _lock:
        data = _read(_comments_path(type_id), {}) or {}
        data.setdefault(str(pk), []).append(c)
        _write(_comments_path(type_id), data)
    import notify

    for m in c["mentions"]:
        if m["user_id"] and m["user_id"] != c["user"]:
            notify.deliver(m["user_id"], f"{c['user']} mentioned you on {obj['title']}", c["text"][:500],
                           link=f"/ontology/objects/{type_id}/{pk}?tab=tab-comments", link_label=f"Open {t['display_name']}", source="object-comments")
    return c


@router.delete("/object-types/{type_id}/objects/{pk}/comments/{cid}")
def delete_comment(type_id: str, pk: str, cid: str) -> dict:
    with _lock:
        data = _read(_comments_path(type_id), {}) or {}
        items = data.get(str(pk), [])
        c = next((x for x in items if x["id"] == cid), None)
        if not c:
            raise HTTPException(404, "comment not found")
        if c["user"] != _who() and auth.enabled():
            raise HTTPException(403, "only the author deletes a comment")
        data[str(pk)] = [x for x in items if x["id"] != cid]
        _write(_comments_path(type_id), data)
    return {"deleted": cid}


def summary(type_id: str) -> dict:
    st = _store(type_id)
    return {"configured": bool(st["versions"]), "published": st["published"], "versions": len(st["versions"])}


@router.get("/object-views-overview")
def overview() -> list[dict]:
    return [{"object_type_id": t["id"], "display_name": t["display_name"], **summary(t["id"]),
             "comments": sum(len(v) for v in (_read(_comments_path(t["id"]), {}) or {}).values())} for t in ontology._all("object-types")]
