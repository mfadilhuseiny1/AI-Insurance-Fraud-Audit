"""Governance Center (Security & Governance → Governance Center): one Project's data protection, end to end.

Every security and governance application of the platform already manages one control; this page reads them all for
one Project and lays them out as the path data takes, so an owner can see what protects the Project's data and what is
missing:

  1. Discover    Sensitive Data Scanner scans that cover the Project: what they found (NIK, BPJS numbers, names…)
  2. Classify    Markings on the Project's items (applied directly, inherited down the lineage, or from folders)
  3. Protect     Cipher channels and licenses kept in the Project (pseudonymisation, hashing, who may decrypt)
  4. Restrict    object and property security policies of the object types backed by the Project's datasets
  5. Justify     Checkpoints that ask for a purpose before exports, decisions or decryption (Project or organisation)
  6. Retain      Data Lifetime deletion policies applied to the Project's datasets
  7. Account     the audit.3 trail of the Project's items (who loaded, exported, decided, decrypted), and Approvals

Each control comes with its live numbers, a posture check (in place / missing, with what to do) and a link to the
application that manages it. Read-only: changes are made in those applications.

Mounted by server.py under /api/governance-center.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException

import auth

router = APIRouter(prefix="/api/governance-center")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _subtree(project_id: str) -> list[dict]:
    import db

    return db.drive_subtree(project_id) if db.enabled() else []


def _is_dataset(it: dict) -> bool:
    return str(it.get("name") or "").lower().endswith(".parquet")


def _marking_view(ids) -> list[dict]:
    info = auth._marking_info()
    return [{"id": i, "name": (info.get(i) or {}).get("name", i), "color": (info.get(i) or {}).get("color") or "#64748b"} for i in sorted(ids)]


def discover(ids: set[str]) -> dict:
    """Sensitive Data Scanner scans that include the Project (or a folder / dataset in it)."""
    import sds

    scans = []
    found: dict[str, dict] = {}
    for s in sds._scans():
        if not set(s.get("include") or []) & ids:
            continue
        results = [r for r in s.get("results") or [] if r.get("id") in ids]
        matched = [r for r in results if r.get("matches")]
        for r in matched:
            for m in r["matches"]:
                f = found.setdefault(r["id"], {"id": r["id"], "name": r.get("name"), "conditions": []})
                f["conditions"].append({"name": m.get("condition_name"), "columns": m.get("columns") or [], "count": m.get("count")})
        last = (s.get("runs") or [{}])[0]
        scans.append({"id": s["id"], "name": s["name"], "schedule": s.get("schedule"), "active": s.get("active"), "scanned": len(results),
                      "matched": len(matched), "last_run": last.get("finished_at") or last.get("started_at"), "status": last.get("status"),
                      "conditions": [c["name"] for c in sds._conditions() if c["id"] in (s.get("conditions") or [])],
                      "actions": [{"name": a["name"], "kind": a["kind"]} for a in sds._actions() if a["id"] in (s.get("actions") or [])]})
    return {"scans": scans, "findings": list(found.values())}


def classify(items: list[dict]) -> dict:
    """Markings on the Project's items: per marking, the items that carry it directly and in total."""
    per: dict[str, dict] = {}
    marked = 0
    for it in items:
        own, inherited = auth._item_row(it["id"])
        eff = auth.effective_markings(it["id"])
        if eff:
            marked += 1
        for m in eff:
            row = per.setdefault(m, {"direct": [], "inherited": [], "total": 0})
            row["total"] += 1
            if m in own:
                row["direct"].append({"id": it["id"], "name": it["name"]})
            elif m in inherited:
                row["inherited"].append({"id": it["id"], "name": it["name"]})
    info = auth._marking_info()
    members: dict[str, int] = {}
    for u in auth._users():
        for m in auth.user_markings(u):
            members[m] = members.get(m, 0) + 1
    out = []
    for m, row in per.items():
        mi = info.get(m) or {}
        if mi.get("kind") == "organization":
            continue
        out.append({"id": m, "name": mi.get("name", m), "color": mi.get("color") or "#64748b", "description": mi.get("description", ""),
                    "members": members.get(m, 0), "direct": row["direct"][:20], "inherited": row["inherited"][:20], "total": row["total"]})
    return {"markings": sorted(out, key=lambda x: -x["total"]), "marked_items": marked, "items": len(items)}


def protect(ids: set[str]) -> dict:
    """Cipher channels and licenses stored in the Project."""
    import cipher

    channels = [c for c in cipher._channels() if c.get("item_id") in ids]
    cids = {c["id"] for c in channels}
    licenses = [r for r in cipher._all() if r.get("item_id") in ids or r.get("channel_id") in cids]
    return {"channels": [{"id": c["id"], "name": c["name"], "algorithm": c["algorithm"], "description": c.get("description", ""), "item_id": c.get("item_id"),
                          "licenses": sum(1 for r in licenses if r.get("channel_id") == c["id"])} for c in channels],
            "licenses": [{"id": r["id"], "rid": cipher.RID + r["id"], "name": r["name"], "kind": r.get("kind"), "operations": r.get("operations"),
                          "channel": next((c["name"] for c in channels if c["id"] == r.get("channel_id")), None), "rate_limit": r.get("rate_limit"),
                          "bypass_checkpoints": r.get("bypass_checkpoints"), "expires_at": r.get("expires_at")} for r in licenses]}


def restrict(ids: set[str]) -> dict:
    """Object types backed by the Project's datasets, with their object / property security policies."""
    import ontology

    out = []
    for t in ontology.list_object_types():
        full = ontology._object_type(t["id"])
        sources = [(full.get("backing_dataset") or {}).get("dataset_id")] + [d.get("dataset_id") for d in full.get("additional_datasources") or []]
        if not set(filter(None, sources)) & ids:
            continue
        sec = full.get("security") or {}
        op = sec.get("object_policy")
        names = {p["api_name"]: p.get("display_name") or p["api_name"] for p in full.get("properties") or []}
        out.append({"id": t["id"], "name": t["display_name"], "objects": t.get("object_count"),
                    "object_policy": bool(op), "object_markings": _marking_view((op or {}).get("markings") or []),
                    "row_level": bool((op or {}).get("granular")),
                    "property_policies": [{"name": pp.get("name"), "properties": [names.get(p, p) for p in pp.get("properties") or []],
                                           "markings": _marking_view(pp.get("markings") or [])} for pp in sec.get("property_policies") or []]})
    return {"object_types": sorted(out, key=lambda x: (not (x["object_policy"] or x["property_policies"]), x["name"]))}


def justify(project_id: str, org: Optional[str]) -> dict:
    """Checkpoints scoped to the Project, and to the organisation (they apply here too), with recent justifications."""
    import checkpoints

    cfgs = []
    for c in checkpoints._configs():
        sc = c.get("scope") or {}
        if not ((sc.get("kind") == "project" and sc.get("id") == project_id) or (sc.get("kind") == "organization" and (not org or sc.get("id") == org))):
            continue
        cfgs.append({"id": c["id"], "name": c["name"], "enabled": c.get("enabled", True), "scope": sc.get("kind"),
                     "types": [checkpoints.TYPES[t][0] for t in c.get("types") or [] if t in checkpoints.TYPES],
                     "justification": (c.get("justification") or {}).get("kind"), "title": c.get("title"),
                     "options": (c.get("justification") or {}).get("options") or []})
    since = (_now() - timedelta(days=30)).isoformat()
    ids = {c["id"] for c in cfgs}
    recs = [r for r in checkpoints._records() if r.get("created_at", "") >= since and (project_id in (r.get("projects") or []) or r.get("config_id") in ids)]
    recent = [{"at": r.get("created_at"), "user": r.get("username") or r.get("user_id"), "type": checkpoints.TYPES.get(r.get("type"), (r.get("type"),))[0],
               "justification": _justification_text(r)} for r in reversed(recs[-12:])]
    return {"configs": cfgs, "records_30d": len(recs), "recent": recent}


def _justification_text(r: dict) -> str:
    j = r.get("justification") or {}
    return (j.get("response") or ", ".join(j.get("selected") or []) or ("disetujui" if j.get("acknowledged") else j.get("kind") or ""))[:200]


def retain(ids: set[str]) -> dict:
    """Data Lifetime deletion policies applied to the Project's datasets."""
    import data_lifetime as dl

    apps = dl._apps()
    pols = {p["id"]: p for p in dl._policies()}
    used: dict[str, dict] = {}
    for item_id, a in apps.items():
        if item_id in ids and a.get("policy") in pols:
            p = pols[a["policy"]]
            row = used.setdefault(p["id"], {"id": p["id"], "name": p["name"], "type": p["type"], "deletion_date": p.get("deletion_date"),
                                            "description": p.get("description", ""), "datasets": []})
            row["datasets"].append(item_id)
    return {"policies": list(used.values())}


def account(ids: set[str], days: int = 7) -> dict:
    """The audit.3 trail of the Project's items over the last days: by category, and the latest events."""
    import audit3

    t1 = _now() + timedelta(minutes=1)
    t0 = t1 - timedelta(days=days)
    by_cat: dict[str, int] = {}
    latest: list[dict] = []
    for line in audit3.lines(t0, t1):
        ents = {e.get("id") for e in line.get("entities") or []}
        if not ents & ids:
            continue
        for c in line.get("categories") or []:
            by_cat[c] = by_cat.get(c, 0) + 1
        latest.append(line)
    latest.sort(key=lambda x: x["time"], reverse=True)
    names = audit3._user_names({x.get("uid") for x in latest[:25]})
    return {"days": days, "events": sum(by_cat.values()) and len(latest), "by_category": dict(sorted(by_cat.items(), key=lambda kv: -kv[1])),
            "latest": [{"time": x["time"], "name": x.get("name"), "product": x.get("product"), "categories": x.get("categories"),
                        "user": names.get(x.get("uid")) or x.get("uid"), "result": x.get("result")} for x in latest[:25]]}


def approvals_pending(marking_ids: set[str]) -> dict:
    import approvals

    rows = []
    for r in approvals._all():
        if r.get("status") not in ("open", "pending"):
            continue
        blob = json.dumps(r, default=str)
        if any(m in blob for m in marking_ids):
            rows.append({"id": r.get("id"), "title": r.get("title") or r.get("name"), "status": r.get("status"), "created_at": r.get("created_at")})
    return {"pending": rows}


def posture(sections: dict) -> list[dict]:
    """In place / missing, per control, with what to do next."""
    d, c, p, r, j, t, a = (sections[k] for k in ("discover", "classify", "protect", "restrict", "justify", "retain", "account"))
    checks = [
        ("discover", "Data sensitif dipindai", bool(d["scans"]), f"{len(d['scans'])} pemindaian · {len(d['findings'])} dataset berisi data sensitif",
         "Buat pemindaian Sensitive Data Scanner yang mencakup Project ini.", "/sensitive-data-scanner"),
        ("classify", "Data sensitif diberi penanda", bool(c["markings"]) and all(f["id"] in {i["id"] for m in c["markings"] for i in m["direct"] + m["inherited"]} for f in d["findings"]),
         f"{len(c['markings'])} penanda · {c['marked_items']} dari {c['items']} item bertanda",
         "Terapkan penanda (markings) pada dataset yang ditemukan pemindai — lewat aksi pemindai atau manual.", "/files"),
        ("protect", "Identitas dipseudonimkan", bool(p["channels"]), f"{len(p['channels'])} kanal Cipher · {len(p['licenses'])} lisensi",
         "Buat kanal Cipher dan pseudonimkan kolom identitas sebelum dipakai analis.", "/cipher"),
        ("restrict", "Kebijakan objek & properti", any(o["object_policy"] or o["property_policies"] for o in r["object_types"]),
         f"{sum(1 for o in r['object_types'] if o['object_policy'] or o['property_policies'])} dari {len(r['object_types'])} tipe objek berkebijakan",
         "Sembunyikan properti sensitif dengan kebijakan keamanan properti di Nexus Manager.", "/object-permissioning"),
        ("justify", "Alasan diminta untuk aksi sensitif", bool(j["configs"]), f"{len(j['configs'])} checkpoint · {j['records_30d']} alasan tercatat (30 hari)",
         "Tambahkan Checkpoints untuk ekspor, keputusan dan dekripsi.", "/checkpoints"),
        ("retain", "Retensi data ditetapkan", bool(t["policies"]), f"{len(t['policies'])} kebijakan penghapusan",
         "Tetapkan kebijakan Data Lifetime pada dataset mentah yang berisi data pribadi.", "/data-lifetime"),
        ("account", "Jejak audit tercatat", a["events"] > 0, f"{a['events']} peristiwa audit.3 ({a['days']} hari)",
         "Aktivitas pada item Project akan tercatat otomatis di audit.3.", "/security-auditing"),
    ]
    return [{"key": k, "label": lab, "ok": ok, "detail": det, "todo": todo, "link": link} for k, lab, ok, det, todo, link in checks]


def overview(project_id: str) -> dict:
    import db

    project = db.drive_get(project_id) if db.enabled() else None
    if not project:
        raise HTTPException(404, "Project tidak ditemukan")
    if not auth.can_access(project_id):
        raise HTTPException(403, "Anda tidak dapat melihat Project ini")
    items = _subtree(project_id)
    ids = {it["id"] for it in items}
    me = auth.current() or {}
    org = (auth._user(me["id"]) or {}).get("organization_id") if me.get("id") and me.get("id") != "local" else None
    sections = {"discover": discover(ids), "classify": classify([it for it in items if _is_dataset(it) or it["id"] == project_id]),
                "protect": protect(ids), "restrict": restrict(ids), "justify": justify(project_id, org), "retain": retain(ids), "account": account(ids)}
    sections["approvals"] = approvals_pending({m["id"] for m in sections["classify"]["markings"]})
    return {"project": {"id": project_id, "name": project["name"]}, "datasets": sum(1 for it in items if _is_dataset(it)),
            "posture": posture(sections), **sections}


@router.get("/projects")
def projects() -> list[dict]:
    """The Projects the caller can see, for the picker."""
    import db

    auth.require_user()
    rows = db.drive_query("parent_id IS NULL AND kind = 'project' AND trashed_at IS NULL", (), "name ASC", 500) if db.enabled() else []
    return [{"id": r["id"], "name": r["name"]} for r in rows if auth.can_access(r["id"])]


@router.get("/projects/{project_id}")
def project_overview(project_id: str) -> dict:
    auth.require_user()
    return overview(project_id)
