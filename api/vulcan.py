"""Vulcan, modelled on Palantir's Vulcan: 3D CAD models from the Ontology, with annotations, measurements and sections.

Vulcan finds what it needs by type classes in the `vulcan` namespace, never by name:
- CAD objects: an object type with a media property classed `vulcan:cad_media_reference` (a file in Files: the meshes
  GLB, GLTF, STL, OBJ, PLY or 3MF, ASCII DXF drawings, LAS point clouds — the format comes from the file name, else
  from the file's first bytes), optionally `vulcan:up_axis` (X, Y, Z) and `vulcan:model_unit` properties;
- annotations, measurements and section planes: object types whose properties carry the classes of the schema
  reference (annotation_id, annotation_title, …, measurement_points, section_plane_position, …) and a link type
  classed `vulcan:cad_object` to the CAD object type;
- the actions Vulcan writes them with: identified by the type classes of their parameters (annotation_title, …,
  cad_object; measurement_points; section_plane_position / section_plane_quaternion).

The schema check lists what is missing. Setup creates the whole schema (object types, link types and rule-based
create actions that set the id, creator and timestamp) for a CAD object type. The viewer (the /vulcan page, three.js)
renders the model with orbit controls, the up axis and unit, normal / x-ray / wireframe styles, part picking and
recoloring, annotations as colored markers (none, primary, success, warning, danger), measurements as polylines
with their length, and a section plane.

DXF drawings and LAS point clouds are read in the browser by loaders written here (web/src/lib/vulcanDxf.ts and
vulcanLas.ts, no packages). The scene says what kind of model it is and, from the file's first bytes, refuses what
cannot be read with the reason: binary DXF, DWG saved as .dxf, LAZ (LASzip-compressed LAS: no decoder is installed)
and LAS point formats above 10. For LAS it also returns the header (version, point format, count, scale, offset,
bounds).

Mounted by server.py under /api/vulcan.
"""

from __future__ import annotations

import re
import struct
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import auth
import ontology
import ontology_model as om
from ontology import _lock

router = APIRouter(prefix="/api/vulcan")

MESH_FORMATS = ("glb", "gltf", "stl", "obj", "ply", "3mf")
DRAWING_FORMATS = ("dxf",)
POINT_FORMATS = ("las", "laz")
FORMATS = MESH_FORMATS + DRAWING_FORMATS + POINT_FORMATS
UP_DEFAULT = {"glb": "Y", "gltf": "Y"}
LAZ_HELP = "Convert it to uncompressed LAS first (for example `pdal translate in.laz out.las` or `las2las -i in.laz -o out.las`)."
HEAD_BYTES = 65536  # the LAS header and its VLRs, or the start of a DXF
SCHEMA = {
    "annotation": {"id": "annotation_id", "props": ["annotation_title", "annotation_content", "part_instance_id", "annotation_attachment_x", "annotation_attachment_y",
                                                   "annotation_attachment_z", "annotation_sphere_size", "annotation_created_by", "annotation_intent", "annotation_timestamp"],
                   "params": ["annotation_title", "annotation_content", "part_instance_id", "annotation_attachment_x", "annotation_attachment_y", "annotation_attachment_z",
                              "annotation_sphere_size", "annotation_intent", "annotation_timestamp", "cad_object"]},
    "measurement": {"id": "measurement_id", "props": ["measurement_points", "measurement_created_by", "measurement_timestamp"], "params": ["measurement_points", "cad_object"]},
    "section_plane": {"id": "section_plane_id", "props": ["section_plane_position", "section_plane_quaternion", "section_plane_created_by", "section_plane_timestamp"],
                      "params": ["section_plane_position", "section_plane_quaternion", "cad_object"]},
}
TYPES = {"annotation_attachment_x": "double", "annotation_attachment_y": "double", "annotation_attachment_z": "double", "annotation_sphere_size": "double",
         "annotation_timestamp": "timestamp", "measurement_points": "double[]", "measurement_timestamp": "timestamp", "section_plane_position": "double[]",
         "section_plane_quaternion": "double[]", "section_plane_timestamp": "timestamp"}
INTENTS = ("none", "primary", "success", "warning", "danger")


def _classes(rec: dict) -> set[str]:
    out = set(rec.get("type_classes") or [])
    if rec.get("type_class"):
        out.add(rec["type_class"])
    return {c.split(":", 1)[1] for c in out if c.startswith("vulcan:")}


def _prop_by_class(t: dict) -> dict[str, str]:
    return {c: p["api_name"] for p in t["properties"] for c in _classes(p)}


# ------------------------------------------------------------------------------------------------
# schema
# ------------------------------------------------------------------------------------------------


def schema() -> dict:
    types = ontology._all("object-types")
    cad = []
    for t in types:
        m = _prop_by_class(t)
        if "cad_media_reference" in m:
            cad.append({"id": t["id"], "display_name": t["display_name"], "media_property": m["cad_media_reference"],
                        "up_axis_property": m.get("up_axis"), "unit_property": m.get("model_unit")})
    links = [lt for lt in ontology._all("link-types") if "cad_object" in _classes(lt)]
    out: dict[str, Any] = {"cad_types": cad, "problems": []}
    for kind, spec in SCHEMA.items():
        best = None
        for t in types:
            m = _prop_by_class(t)
            if spec["id"] in m:
                missing = [c for c in spec["props"] if c not in m]
                best = {"object_type_id": t["id"], "display_name": t["display_name"], "properties": m, "missing": missing}
                break
        if not best:
            out[kind] = None
            out["problems"].append(f"no object type has the vulcan:{spec['id']} type class ({kind}s cannot be saved)")
            continue
        if best["missing"]:
            out["problems"].append(f"{best['display_name']} lacks vulcan:{', vulcan:'.join(best['missing'])}")
        lt = next((x for x in links if best["object_type_id"] in (x["source"]["object_type_id"], x["target"]["object_type_id"])), None)
        best["link_type_id"] = lt["id"] if lt else None
        if not lt:
            out["problems"].append(f"{best['display_name']} has no link type classed vulcan:cad_object")
        action = None
        for a in ontology._all("action-types"):
            pcs = {c: p["id"] for p in a.get("parameters") or [] for c in _classes(p)}
            if all(c in pcs for c in spec["params"]):
                action = {"id": a["id"], "display_name": a["display_name"], "parameters": pcs}
                break
        best["action"] = action
        if not action:
            out["problems"].append(f"no action type has parameters classed {', '.join('vulcan:' + c for c in spec['params'])}")
        out[kind] = best
    return out


@router.get("/schema")
def get_schema() -> dict:
    return schema()


class SetupIn(BaseModel):
    cad_object_type_id: str
    suffix: str = ""  # appended to the display names, e.g. " (demo)"


def _p(api: str, name: str, typ: str, vc: Optional[str] = None, **kw: Any) -> ontology.Property:
    array = typ.endswith("[]")
    return ontology.Property(api_name=api, display_name=name, type=typ.rstrip("[]"), array=array or None, type_classes=[f"vulcan:{vc}"] if vc else None, **kw)


@router.post("/setup")
def setup(req: SetupIn) -> dict:
    """Create the annotation, measurement and section plane object types, their links and create actions."""
    cad = ontology._object_type(req.cad_object_type_id)
    if "cad_media_reference" not in _prop_by_class(cad):
        raise HTTPException(400, f"{cad['display_name']} has no media property classed vulcan:cad_media_reference")
    current = schema()
    made = []
    labels = {"annotation": "Annotation", "measurement": "Measurement", "section_plane": "Section plane"}
    for kind, spec in SCHEMA.items():
        if current.get(kind) and current[kind]["link_type_id"] and current[kind]["action"]:
            continue
        name = f"Vulcan {labels[kind].lower()}{req.suffix}"
        props = [_p(spec["id"], "ID", "string", spec["id"])]
        for c in spec["props"]:
            props.append(_p(c, c.replace("_", " ").capitalize(), TYPES.get(c, "string"), c))
        props.append(_p("cad_object_id", "CAD object", "string"))
        t = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=name, api_name=f"Vulcan{labels[kind].replace(' ', '')}{uuid.uuid4().hex[:6]}", primary_key=spec["id"], title_property=spec["props"][0] if kind == "annotation" else spec["id"],
            generate_primary_key=True, description=f"Vulcan {labels[kind].lower()}s on {cad['display_name']} (written by Vulcan).", properties=props))
        lt = om.create_link_type(om.LinkTypeIn(
            display_name=f"{labels[kind]} of CAD object{req.suffix}", kind="foreign_key", cardinality="many_to_one", foreign_key="cad_object_id", type_classes=["vulcan:cad_object"],
            source=om.LinkSide(object_type_id=t["id"], display_name=f"{labels[kind]}s", plural_display_name=f"{labels[kind]}s"),
            target=om.LinkSide(object_type_id=cad["id"], display_name="CAD object")))
        params = [ontology.Parameter(id="cad", display_name="CAD object", type="object", required=True, object_type_id=cad["id"], type_classes=["vulcan:cad_object"])]
        mapping: dict[str, Any] = {"cad_object_id": {"kind": "object_property", "parameter": "cad", "property": cad["primary_key"]}}
        for c in spec["params"]:
            if c == "cad_object":
                continue
            typ = TYPES.get(c, "string")
            params.append(ontology.Parameter(id=c, display_name=c.replace("_", " ").capitalize(), type=typ.rstrip("[]"), array=typ.endswith("[]") or None, required=True,
                                             type_classes=[f"vulcan:{c}"]))
            mapping[c] = {"kind": "parameter", "parameter": c}
        creator = next(c for c in spec["props"] if c.endswith("created_by"))
        mapping[creator] = {"kind": "current_user"}
        stamp = next(c for c in spec["props"] if c.endswith("timestamp"))
        if stamp not in mapping:
            mapping[stamp] = {"kind": "current_time"}
        ontology.create_action_type(ontology.ActionTypeIn(
            display_name=f"Create {labels[kind].lower()}{req.suffix}", object_type_id=t["id"], kind="rules", status="active", parameters=params,
            rules=[{"kind": "create_object", "object_type_id": t["id"], "properties": mapping}]))
        made.append({"kind": kind, "object_type_id": t["id"], "link_type_id": lt["id"]})
    return {"created": made, "schema": schema()}


# ------------------------------------------------------------------------------------------------
# model files: what kind, and what is refused (from the first bytes)
# ------------------------------------------------------------------------------------------------


def kind_of(fmt: Optional[str]) -> str:
    return "drawing" if fmt in DRAWING_FORMATS else "point_cloud" if fmt in POINT_FORMATS else "mesh"


def sniff(head: bytes) -> Optional[str]:
    """The format from a file's first bytes, for files whose name has no known extension."""
    if head[:4] == b"LASF":
        return "las"
    if head[:4] == b"glTF":
        return "glb"
    if head[:2] == b"PK":
        return "3mf"
    if head[:4] == b"ply\n" or head[:5] == b"ply\r\n":
        return "ply"
    text = head[:2048].lstrip(b"\xef\xbb\xbf")
    if head.startswith(b"AutoCAD Binary DXF") or re.match(rb"\s*(0|999)\s*\r?\n", text):
        return "dxf"
    return None  # OBJ, STL, GLTF or something else: the viewer guesses


def las_header(head: bytes) -> dict:
    """The LAS public header block and the VLRs that matter (LASzip, the coordinate system); raises ValueError."""
    if head[:4] != b"LASF":
        raise ValueError("this is not a LAS file: a LAS file starts with the signature LASF")
    if len(head) < 227:
        raise ValueError("this LAS file is cut short: its header is incomplete")
    major, minor = head[24], head[25]
    header_size, offset_points, vlr_count, raw_format, record_length, count = struct.unpack_from("<HIIBHI", head, 94)
    if (major, minor) >= (1, 4) and header_size >= 375 and len(head) >= 255:
        count = struct.unpack_from("<Q", head, 247)[0] or count
    scale = struct.unpack_from("<3d", head, 131)
    offset = struct.unpack_from("<3d", head, 155)
    mx_x, mn_x, mx_y, mn_y, mx_z, mn_z = struct.unpack_from("<6d", head, 179)
    compressed = bool(raw_format & 0x80)
    crs = None
    at = header_size
    for _ in range(vlr_count):
        if at + 54 > min(len(head), offset_points):
            break
        user = head[at + 2:at + 18].split(b"\0", 1)[0].decode("ascii", "replace").strip().lower()
        record, length = struct.unpack_from("<HH", head, at + 18)
        if user == "laszip encoded" and record == 22204:
            compressed = True
        if user == "lasf_projection":
            crs = "wkt" if record == 2112 else "geotiff" if record == 34735 else crs
        at += 54 + length

    def text(a: int, b: int) -> str:
        return head[a:b].split(b"\0", 1)[0].decode("ascii", "replace").strip()

    return {"version": f"{major}.{minor}", "point_format": raw_format & 0x3F, "record_length": record_length, "point_count": count,
            "scale": list(scale), "offset": list(offset), "min": [mn_x, mn_y, mn_z], "max": [mx_x, mx_y, mx_z], "vlr_count": vlr_count,
            "system_id": text(26, 58), "software": text(58, 90), "compressed": compressed, "crs": crs}


def inspect(head: bytes, fmt: Optional[str]) -> dict:
    """What the viewer will do with a model file: its kind, the refusal (None when it is read) and, for LAS, the header."""
    fmt = fmt or sniff(head)
    out: dict[str, Any] = {"format": fmt, "kind": kind_of(fmt), "refusal": None}
    if fmt == "dxf":
        if head.startswith(b"AutoCAD Binary DXF"):
            out["refusal"] = "This is a binary DXF file: only ASCII DXF is read here. Save it as ASCII DXF (in AutoCAD: Save As → DXF, format ASCII)."
        elif re.match(rb"AC1[0-9.]{3}|MC0\.0|AC2\.", head[:6]):
            out["refusal"] = "This is a DWG file (the name says DXF): DWG is not read here. Export it as ASCII DXF."
        elif head and not re.match(rb"\s*(0|999)\s*\r?\n", head[:2048].lstrip(b"\xef\xbb\xbf")):
            out["refusal"] = "This is not a DXF file: an ASCII DXF starts with group code 0."
    elif fmt in POINT_FORMATS:
        try:
            h = las_header(head)
        except ValueError as e:
            out["refusal"] = f"{str(e)[0].upper()}{str(e)[1:]}."
            return out
        out["las"] = h
        if h["compressed"]:  # by the bytes: a .laz that is plain LAS is read
            out["refusal"] = f"This is a LAZ (LASzip-compressed) point cloud: it is not decoded here, because no LASzip decoder is installed. {LAZ_HELP}"
        elif not head[24] == 1:
            out["refusal"] = f"LAS version {h['version']} is not read here (versions 1.0 to 1.4 are)."
        elif h["point_format"] > 10:
            out["refusal"] = f"Point data format {h['point_format']} is not a LAS format (0 to 10 are)."
    return out


def _model_file(ref: Optional[str]) -> tuple[Optional[dict], Optional[str]]:
    """The Files item of a media reference and its name, when the database is on."""
    if not ref:
        return None, None
    try:
        import db

        item = db.drive_get(str(ref).split("#")[0]) if db.enabled() else None
    except Exception:  # noqa: BLE001 - the viewer guesses the format from the content
        item = None
    return item, (item or {}).get("name")


def _head(item: Optional[dict]) -> bytes:
    if not item or item.get("kind") != "file":
        return b""
    try:
        import drive

        return drive.read_head(item, HEAD_BYTES)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - a missing blob: the viewer reports the load error
        return b""


# ------------------------------------------------------------------------------------------------
# scenes
# ------------------------------------------------------------------------------------------------


@router.get("/cad-objects")
def cad_objects() -> list[dict]:
    out = []
    for c in schema()["cad_types"]:
        t = ontology._object_type(c["id"])
        for pk, o in ontology._objects(t["id"]).items():
            if ontology._can_see(t, o):
                pub = ontology._public_object(t, pk, o)
                out.append({"object_type_id": t["id"], "object_type": t["display_name"], "primary_key": pk, "title": pub["title"]})
    return out


def _linked(kind: str, sch: dict, cad_type: str, pk: str) -> list[dict]:
    spec = sch.get(kind)
    if not spec or not spec.get("link_type_id"):
        return []
    lt = ontology._get("link-types", spec["link_type_id"], "link type")
    direction = "reverse" if lt["target"]["object_type_id"] == cad_type else "forward"
    t = ontology._object_type(spec["object_type_id"])
    objs = ontology._objects(t["id"])
    m = spec["properties"]
    out = []
    for opk in om.linked_map(lt, direction, {pk}).get(pk) or []:
        o = objs.get(opk)
        if not o or not ontology._can_see(t, o):
            continue
        p = o.get("properties") or {}
        out.append({"primary_key": opk, **{c: p.get(prop) for c, prop in m.items()}})
    return out


@router.get("/scene/{type_id}/{pk}")
def scene(type_id: str, pk: str) -> dict:
    sch = schema()
    cad = next((c for c in sch["cad_types"] if c["id"] == type_id), None)
    if not cad:
        raise HTTPException(400, "this object type is not a CAD object type (no vulcan:cad_media_reference property)")
    with _lock:
        t = ontology._object_type(type_id)
        key, obj = ontology._find(t, pk)
        pub = ontology._public_object(t, key, obj)
        ref = pub["properties"].get(cad["media_property"])
        item, name = _model_file(ref)
        fmt = (name or "").rsplit(".", 1)[-1].lower() if name and "." in name else None
        if fmt and fmt not in FORMATS:
            raise HTTPException(400, f"{fmt.upper()} files are not rendered here (meshes: {', '.join(f.upper() for f in MESH_FORMATS)}; drawings: DXF; point clouds: LAS, LAZ)")
        up = pub["properties"].get(cad["up_axis_property"]) if cad["up_axis_property"] else None
        unit = pub["properties"].get(cad["unit_property"]) if cad["unit_property"] else None
    # the first bytes, outside the ontology lock: drawings and point clouds are checked, unnamed files sniffed
    info = inspect(_head(item), fmt) if (fmt is None or fmt not in MESH_FORMATS) and item else {"format": fmt, "kind": kind_of(fmt), "refusal": None}
    fmt = info["format"]
    # the schema reference: m (meter, metre) or mm (millimeter, millimetre); any other value is ignored
    unit = {"m": "m", "meter": "m", "metre": "m", "mm": "mm", "millimeter": "mm", "millimetre": "mm"}.get(str(unit or "").strip().lower())
    with _lock:
        return {"object": pub, "model": {"media": ref, "file_name": name, "format": fmt, "kind": info["kind"], "refusal": info["refusal"], "las": info.get("las"),
                                         "up_axis": up or UP_DEFAULT.get(fmt or "", "Z"), "unit": unit},
                "annotations": _linked("annotation", sch, type_id, key), "measurements": _linked("measurement", sch, type_id, key),
                "section_planes": _linked("section_plane", sch, type_id, key), "problems": sch["problems"]}


class SaveIn(BaseModel):
    cad_object_type_id: str
    cad_primary_key: str
    values: dict[str, Any]  # by Vulcan type class name


@router.post("/{kind}")
def save(kind: str, req: SaveIn) -> dict:
    """Save an annotation, measurement or section plane through the action Vulcan finds by parameter type classes."""
    if kind not in SCHEMA:
        raise HTTPException(404, "unknown Vulcan object")
    spec = schema().get(kind)
    if not spec or not spec.get("action"):
        raise HTTPException(400, f"no action saves {kind.replace('_', ' ')}s: run the Vulcan setup or add type classes")
    v = dict(req.values)
    if kind == "annotation":
        v.setdefault("annotation_intent", "primary")
        if v["annotation_intent"] not in INTENTS:
            raise HTTPException(400, f"the intent is one of {', '.join(INTENTS)}")
        v.setdefault("annotation_timestamp", ontology._now())
        v.setdefault("annotation_sphere_size", 0)
    if kind == "measurement" and (len(v.get("measurement_points") or []) < 6 or len(v["measurement_points"]) % 3):
        raise HTTPException(400, "a measurement has two or more points (x, y, z each)")
    if kind == "section_plane" and (len(v.get("section_plane_position") or []) != 3 or len(v.get("section_plane_quaternion") or []) != 4):
        raise HTTPException(400, "a section plane has a position [x, y, z] and a quaternion [x, y, z, w]")
    params = {}
    for c, pid in spec["action"]["parameters"].items():
        if c == "cad_object":
            params[pid] = req.cad_primary_key
        elif c in v:
            params[pid] = v[c]
    res = ontology.apply_action(spec["action"]["id"], ontology.ApplyAction(parameters=params))
    return {"saved": [e["primary_key"] for e in res.get("edits") or []], "by": auth.actor_id() or "local"}
