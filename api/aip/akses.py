"""Keamanan & Akses: who may open which data of the BPJS sample, per role — the "Keamanan & Akses" tab of /aip-jkn.

The scheme rests on the platform's own controls, in the order they are checked:
  peran Project       "Data Sampel BPJS 2025": the data stewards are Editors (every stage); the other roles Discoverers
                      (they see that the data and its lineage exist, not the rows)
  peran folder/berkas role grants on folders and files (auth.granted_operations), the stages being folders of one
                      Project: Data Bersih (silver) to the model developers, Siap Analisis (gold) and the model and Swarm
                      outputs (ml) to them and the national investigation team; the participant lane (kepesertaan →
                      peserta → profil peserta) to the member-data officer
  kebijakan baris     Project "Portal Data BPJS per Peran (demo)": restricted views over Siap Analisis whose row policy
                      gives a branch-office auditor the rows of their own province (user attribute provinsi_kode),
                      analysts the aggregates of every province, the national team every row
  penanda             Indikasi Fraud · Internal on the AI Agent Swarm's outputs, and "Data Individu BPJS (demo)" on the
                      record-level Nexus types (a claim, a participant) — Nexus objects are guarded by markings, not by
                      the Project of their data
and the access roles (PERAN_AKSES) that carry the last two: groups holding a marking, or named in every portal row
policy. Access past a marking or a row policy is given by membership (POST /api/aip/akses/peran/{key}/anggota), and
for each closed item the matrix names the role that alone would open it (checked by running the same check for the
account as a member).

GET /api/aip/akses: the scheme and what each demo account can open per stage, computed by the platform's own check
(lineage.access_of: the one behind Data Lineage → Permissions). POST /api/aip/akses/bangun (administrators) applies it;
idempotent, nothing is taken away from anyone, the administrators keep everything. State in data/aip/akses.json.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/aip/akses")
STATE_FILE = Path(os.environ.get("BLUESANDAI_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data")) / "aip" / "akses.json"

PROJECT = "Data Sampel BPJS 2025"
PORTAL = "Portal Data BPJS per Peran (demo)"
# (until 2026-10-29 the tab kept a copy of that graph plus the portal views as "bpjsakses", "Akses per peran: Data Sampel BPJS (demo)"; the
# portal views now join the data's own graph, and the tab links to it)
# the lineage graph of the data (nexus.LINEAGE_GRAPH): its nodes are the demo graph's, plus the portal's views
MAIN_GRAPH = "Data Sampel BPJS: Arsip Sumber → Data Mentah → Data Bersih → Siap Analisis"

G_PENGELOLA = "Pengelola Data & Nexus JKN (demo)"
G_PENGEMBANG = "Pengembang Fungsi & Model JKN (demo)"
G_NASIONAL = "Tim Investigasi Kedeputian — akses nasional (demo)"
G_ANALIS = "Analis Data JKN (demo)"
G_KC = "Auditor Kantor Cabang JKN (demo)"
INDIKASI = "Indikasi Fraud · Internal"
INDIVIDU = "Data Individu BPJS (demo)"
# access roles: groups that carry an access, so it is given and taken back by membership (markings held by the group,
# row policies naming the group) — never granted to one person. key, name, what it opens, markings it holds, named in
# every portal view's every-row list, its first members (later changes in the tab stand)
G_TEMUAN = "Peran · Temuan Fraud Swarm (demo)"
G_INDIVIDU = "Peran · Data Individu BPJS (demo)"
G_PROVINSI = "Peran · Semua Provinsi (demo)"
PERAN_AKSES = [
    ("temuan", G_TEMUAN, "Keluaran AI Agent Swarm: indikasi fraud dan karantina faskes (dataset dan tipe Nexus)", [INDIKASI], False,
     ["demo.kedeputian", "demo.pengelola.data", "demo.pengembang"]),
    ("individu", G_INDIVIDU, "Data per klaim dan per peserta di Nexus: Klaim FKRTL, Klaim Berisiko, Peserta Klaim Berisiko, Skor Risiko Klaim ML, Tag Indikasi Fraud",
     [INDIVIDU], False, ["demo.kedeputian", "demo.pengelola.data", "demo.pengembang"]),
    ("provinsi", G_PROVINSI, "Semua baris di setiap restricted view portal, semua provinsi (termasuk klaim berisiko)", [], True,
     ["demo.kedeputian"]),
]

# the stages, in the order the data passes them (user-facing names: Arsip Sumber / Data Mentah / Data Bersih / Siap
# Analisis), then what is built on them
TAHAP = [
    ("arsip", "Arsip Sumber", "salinan asli berkas BPJS (.dta)"),
    ("mentah", "Data Mentah", "berkas dibaca apa adanya, plus katalog dan label kode"),
    ("bersih", "Data Bersih", "dibersihkan dan diseragamkan per edisi"),
    ("siap", "Siap Analisis", "tabel analisis: klaim, profil faskes, agregat wilayah"),
    ("model", "Model & AI Agent Swarm", "skor model ML, indikasi dan karantina dari Swarm"),
    ("logika", "Logika pipeline", "pipeline dan kode transformasi"),
    ("portal", "Portal per wilayah", "restricted view: baris sesuai peran dan provinsi"),
    ("nexus", "Nexus", "objek operasional (ontologi)"),
]
FOLDER_TAHAP = {"raw": "arsip", "bronze": "mentah", "silver": "bersih", "gold": "siap", "ml": "model", "pipelines": "logika"}

# role: (username, judul, tugas, attributes added, markings added (names), portal Viewer)
PERAN = [
    ("demo.pengelola.data", "Pengelola Data & Nexus", "Membangun dan merawat pipeline: semua tahap dari Arsip Sumber, Editor di Project data.",
     {}, [], False),
    ("demo.pengembang", "Pengembang Fungsi & Model", "Melatih model: Data Bersih, Siap Analisis dan keluaran model; tidak menyentuh arsip dan data mentah.",
     {}, [], False),
    ("demo.kedeputian", "Tim Investigasi Kedeputian", "Investigasi nasional: Siap Analisis semua provinsi, objek klaim di Nexus, temuan AI Agent Swarm.",
     {}, [], True),
    ("demo.analis", "Analis Data", "Agregat semua provinsi lewat portal; tanpa data klaim atau peserta per orang.",
     {}, [], True),
    ("demo.kc.kota", "Auditor Kantor Cabang · DKI Jakarta", "Baris provinsinya sendiri lewat portal: faskes, klaim berisiko, tren.",
     {"provinsi_kode": "31", "provinsi": "DKI JAKARTA"}, [], True),
    ("demo.kc.kabupaten", "Auditor Kantor Cabang · Jawa Barat", "Baris provinsinya sendiri lewat portal.",
     {"provinsi_kode": "32", "provinsi": "JAWA BARAT"}, [], True),
    ("demo.kc.raya", "Auditor Kantor Cabang · Jawa Timur", "Baris provinsinya sendiri lewat portal.",
     {"provinsi_kode": "35", "provinsi": "JAWA TIMUR"}, [], True),
    ("demo.verifikator", "Verifikator Data Peserta", "Jalur data peserta saja, di setiap tahap: kepesertaan → peserta → profil peserta.",
     {}, [], False),
    ("demo.tamu", "Tamu", "Hanya portal: kebijakan baris tidak memberinya satu baris pun.",
     {}, [], True),
]

# role grants on folders and files of the data Project: path below the Project -> [(principal kind, group name or
# username, role)]
GRANTS: list[tuple[str, list[tuple[str, str, str]]]] = [
    ("silver", [("group", G_PENGEMBANG, "viewer")]),
    ("gold", [("group", G_PENGEMBANG, "viewer"), ("group", G_NASIONAL, "viewer")]),
    ("ml", [("group", G_PENGEMBANG, "viewer"), ("group", G_NASIONAL, "viewer")]),
    ("pipelines", [("group", G_PENGEMBANG, "viewer")]),
    # the participant lane, for the member-data officer
    ("raw/kepesertaan", [("user", "demo.verifikator", "viewer")]),
    ("bronze/kepesertaan.parquet", [("user", "demo.verifikator", "viewer")]),
    ("bronze/_meta/katalog_kepesertaan.parquet", [("user", "demo.verifikator", "viewer")]),
    ("bronze/_meta/label_nilai_kepesertaan.parquet", [("user", "demo.verifikator", "viewer")]),
    ("silver/peserta.parquet", [("user", "demo.verifikator", "viewer")]),
    ("gold/profil_peserta.parquet", [("user", "demo.verifikator", "viewer")]),
    ("gold/peserta_klaim_berisiko.parquet", [("user", "demo.verifikator", "viewer")]),
]
# roles on the data Project itself (added; existing ones are kept)
PROJECT_ROLES = [("group", G_PENGELOLA, "editor"), ("group", G_PENGEMBANG, "discoverer"), ("group", G_NASIONAL, "discoverer"),
                 ("group", G_ANALIS, "discoverer"), ("group", G_KC, "discoverer"), ("user", "demo.verifikator", "discoverer")]

# the portal's restricted views: name, gold dataset, groups that see every row (others: an auditor of a branch office
# sees the rows of their own province), what it is
VIEWS = [
    ("Profil faskes per provinsi (demo)", "profil_faskes.parquet", [G_NASIONAL, G_ANALIS], "faskes per provinsi"),
    ("Klaim bulanan per provinsi (demo)", "klaim_bulanan_provinsi.parquet", [G_NASIONAL, G_ANALIS], "agregat bulanan"),
    ("Klaim per kabupaten/kota (demo)", "klaim_kabkota.parquet", [G_NASIONAL, G_ANALIS], "agregat kab/kota"),
    ("Klaim berisiko per provinsi (demo)", "klaim_berisiko.parquet", [G_NASIONAL], "klaim per klaim: analis tidak"),
]
# Nexus types that hold one record per claim or participant
INDIVIDU_TYPES = ["Klaim FKRTL (BPJS)", "Klaim Berisiko (BPJS)", "Peserta Klaim Berisiko (BPJS)", "Skor Risiko Klaim ML (BPJS)", "Tag Indikasi Fraud (Semantik)"]

_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}
TTL = 120.0


def _state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(s: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s, indent=1, ensure_ascii=False), encoding="utf-8")


def _project_id(name: str) -> Optional[str]:
    import db

    return next((i["id"] for i in db.drive_list(None) if i.get("kind") == "project" and i["name"] == name and not i.get("trashed_at")), None)


def _at(project: str, path: str) -> Optional[str]:
    """The id of the item at `path` below a Project (a/b/c), or None."""
    import db

    cur = project
    for part in path.split("/"):
        cur = next((i["id"] for i in db.drive_list(cur) if i["name"] == part and not i.get("trashed_at")), None)
        if not cur:
            return None
    return cur


def _ids() -> dict[str, dict[str, str]]:
    import auth

    return {"group": {g["name"]: g["id"] for g in auth._groups()}, "user": {u["username"]: u["id"] for u in auth._users()},
            "marking": {m["name"]: m["id"] for m in auth._markings()}}


# ------------------------------------------------------------------------------------------------
# applying the scheme
# ------------------------------------------------------------------------------------------------


def _grant_rows(table: str, key: str, item_id: str, rows: list[tuple[str, str, str]]) -> list[str]:
    """Add role grants (a principal's existing role is kept as it is)."""
    import auth

    with auth._db() as con:
        have = {(t, i) for t, i in con.execute(f"SELECT principal_type, principal_id FROM {table} WHERE {key} = ?", (item_id,)).fetchall()}
    add = [(t, i, r) for t, i, r in rows if (t, i) not in have]
    if add:
        with auth._lock, auth._db() as con:
            for t, i, r in add:
                con.execute(f"INSERT INTO {table} ({key}, principal_type, principal_id, role) VALUES (?, ?, ?, ?)", (item_id, t, i, r))
        auth._roles_cache.clear()
        auth._project_cache.clear()
        auth._grants_reset()
    return [f"{t}:{i}={r}" for t, i, r in add]


def bangun() -> dict:
    """Apply the scheme (idempotent). Adds roles, grants, attributes, markings and the portal; takes nothing away."""
    import auth
    import governance_model
    import lineage
    import restricted_views

    me = auth.require_admin()
    out: dict[str, Any] = {}
    data = _project_id(PROJECT)
    if not data:
        raise HTTPException(404, f"Project {PROJECT} tidak ditemukan")
    ids = _ids()
    missing = [n for n in (G_PENGELOLA, G_PENGEMBANG, G_NASIONAL, G_ANALIS, G_KC) if n not in ids["group"]]
    missing += [u for u, *_ in PERAN if u not in ids["user"]]
    if missing:
        raise HTTPException(409, f"Belum ada: {', '.join(missing)} (akun dan grup demo JKN)")

    # 1 · the record-level marking; the administrators hold it before anything carries it
    if INDIVIDU not in ids["marking"]:
        auth.create_marking(auth.MarkingIn(name=INDIVIDU, color="#7c5cff",
                                           description="Data per klaim atau per peserta di Nexus (bukan agregat): tim investigasi nasional, pengelola data, pengembang model."))
        ids = _ids()
    mk = ids["marking"]
    holders = {u["id"] for u in auth._users() if u.get("role") == "admin" and not u.get("disabled")}
    changed_users = []
    for u in auth._users():
        role = next((r for r in PERAN if r[0] == u["username"]), None)
        want = set(mk[m] for m in role[4]) if role else set()
        if u["id"] in holders:
            want.add(mk[INDIVIDU])
        attrs = role[3] if role else {}
        rec = auth._user(u["id"])
        if (want - set(rec.get("markings") or [])) or any((rec.get("attributes") or {}).get(k) != v for k, v in attrs.items()):
            rec["markings"] = sorted(set(rec.get("markings") or []) | want)
            rec["attributes"] = {**(rec.get("attributes") or {}), **attrs}
            auth._save_user(rec)
            changed_users.append(u["username"])
    out["akun"] = changed_users

    # 1b · the access roles (groups holding the markings, named by the row policies); the markings a demo account held
    # itself (given by the first version of this scheme) move to the roles, so leaving a role takes the access back
    out["peran_akses"] = {}
    for key, name, opens, marks, _rows, first in PERAN_AKSES:
        want_marks = sorted(mk[m] for m in marks)
        g = next((x for x in auth._groups() if x["name"] == name), None)
        if not g:
            g = auth.create_group(auth.GroupIn(name=name, description=f"Peran akses (demo): {opens}.",
                                               members=[ids["user"][u] for u in first], markings=want_marks), None)
            out["peran_akses"][key] = "dibuat"
        elif set(want_marks) - set(g.get("markings") or []):
            auth.update_group(g["id"], auth.GroupIn(name=name, description=g.get("description") or "", members=g.get("members") or [],
                                                    markings=sorted(set(g.get("markings") or []) | set(want_marks))), None)
            out["peran_akses"][key] = "penanda ditambah"
    ids = _ids()
    moved = {mk[INDIKASI], mk[INDIVIDU]}
    for u in auth._users():
        if u["username"].startswith("demo.") and u.get("role") != "admin":
            rec = auth._user(u["id"])
            if moved & set(rec.get("markings") or []):
                rec["markings"] = sorted(set(rec.get("markings") or []) - moved)
                auth._save_user(rec)
                out.setdefault("penanda_pindah_ke_peran", []).append(u["username"])

    # 2 · roles on the data Project, and on its stage folders and participant files
    pr = [(t, ids[t][n], r) for t, n, r in PROJECT_ROLES]
    out["project"] = _grant_rows("project_roles", "project_id", data, pr)
    out["grants"] = {}
    for path, rows in GRANTS:
        item = _at(data, path)
        if not item:
            out["grants"][path] = "tidak ditemukan"
            continue
        added = _grant_rows("item_roles", "item_id", item, [(t, ids[t][n], r) for t, n, r in rows])
        if added:
            out["grants"][path] = added
    auth.audit("aip_akses_applied", None, f"{PROJECT}: roles {out['project']}, grants {sorted(out['grants'])}")

    # 3 · the portal: a Project of restricted views over Siap Analisis
    st = _state()
    portal = _project_id(PORTAL)
    if not portal:
        portal = governance_model.create_project(governance_model.NewProjectIn(name=PORTAL), None)["id"]
    # Viewers: the national team, analysts and branch-office auditors (groups), and the guest — whom no row policy gives
    # a row: access to the portal is not access to its data
    viewers = [("group", ids["group"][g], "viewer") for g in (G_NASIONAL, G_ANALIS, G_KC)] + [("user", ids["user"]["demo.tamu"], "viewer")]
    out["portal"] = _grant_rows("project_roles", "project_id", portal, viewers)
    views = {}
    for name, file, all_rows, _what in VIEWS:
        backing = _at(data, f"gold/{file}")
        if not backing:
            continue
        pol = {"kind": "or", "children": [
            {"kind": "and", "children": [
                {"kind": "condition", "op": "intersects", "left": {"kind": "user_groups"}, "right": {"kind": "static", "value": [ids["group"][G_KC]]}},
                {"kind": "condition", "op": "intersects", "left": {"kind": "user_attribute", "attribute": "provinsi_kode"}, "right": {"kind": "property", "property": "provinsi_kode"}},
            ]},
            {"kind": "condition", "op": "intersects", "left": {"kind": "user_groups"},
             "right": {"kind": "static", "value": [ids["group"][g] for g in [*all_rows, G_PROVINSI]]}},
        ]}
        rv = next((v for v in restricted_views._all() if v["name"] == name and v.get("project_id") == portal), None)
        if not rv:
            rv = restricted_views.create_view(restricted_views.ViewIn(
                name=name, project_id=portal, backing_item_id=backing, policy=pol,
                description="Demo akses per peran: auditor kantor cabang melihat baris provinsinya (atribut provinsi_kode); "
                            "tim nasional" + (" dan analis" if G_ANALIS in all_rows else "") + " melihat semua baris."), None)
        elif rv.get("policy") != pol:
            restricted_views.update_view(rv["id"], restricted_views.ViewChange(policy=pol), None)
        views[file] = rv["id"]
    out["views"] = len(views)

    # 4 · the record-level Nexus types carry the marking
    import ontology

    marked = []
    for t in ontology._all("object-types"):
        if t.get("display_name") in INDIVIDU_TYPES:
            rid = f"object_type:{t['id']}"
            own, _inh = auth._item_row(rid)
            if mk[INDIVIDU] not in own:
                auth.set_item_markings(rid, auth.ItemMarkingsIn(markings=sorted(set(own) | {mk[INDIVIDU]})))
                marked.append(t["display_name"])
    out["nexus"] = marked

    # 5 · the lineage: the portal's views join the data's own graph (the user, 2026-10-29: the tab's lineage link must
    # open the real Data Lineage, not a copy of it — a separate graph "Akses per peran" was kept until then); it keeps
    # its colouring and its choices, and switched to Permissions it lists the JKN accounts only (the grid and other
    # demos' accounts are not about this data)
    main = next((g for g in lineage.list_graphs() if g.get("name") == MAIN_GRAPH), None)
    uids = [ids["user"][u] for u, *_ in PERAN]
    perms = {"view_as": ids["user"]["demo.kedeputian"], "compare": uids[:8], "type": "read", "accounts": uids}
    if main:
        nodes = sorted(set(main.get("nodes") or []) | {f"restricted_view:{v}" for v in views.values()})
        mp = main.get("permissions") or {}
        lineage.save_graph(lineage.SavedGraph(**{k: main[k] for k in ("name", "colors", "color_by", "positions") if k in main}, nodes=nodes,
                                              permissions={**perms, **{k: v for k, v in mp.items() if k in ("view_as", "compare", "type") and v}, "accounts": uids}),
                           id=main["id"])
    # the views are new nodes: the next lineage is built afresh
    lineage._built.clear()
    st.update(portal=portal, views=views, data_project=data, graph=(main or {}).get("id"), built_at=datetime.now(timezone.utc).isoformat(), built_by=me.get("id"))
    _save(st)
    _cache.clear()
    out["graph"] = (main or {}).get("id")
    return out


# ------------------------------------------------------------------------------------------------
# the matrix: what each role can open, per stage
# ------------------------------------------------------------------------------------------------


def _tahap(n: dict, data_name: str) -> Optional[str]:
    kind = n.get("kind")
    if kind == "restricted_view":
        return "portal"
    if kind == "object_type":
        return "nexus"
    if kind == "transform" or (kind == "pipeline" and n.get("item_id")):
        return "logika"
    path = n.get("path") or []
    if kind == "dataset" and len(path) > 1 and path[0] == data_name:
        return FOLDER_TAHAP.get(path[1])
    return None


def matriks(force: bool = False) -> dict:
    import auth
    import db
    import lineage

    me = auth.require_user()
    admin = auth._is_admin(me)
    key = "admin" if admin else f"u:{me.get('id')}"
    hit = _cache.get(key)
    if hit and not force and time.monotonic() - hit[0] < TTL:
        return hit[1]
    st = _state()
    g = lineage.cached_graph(False)
    # the data's own lineage graph, the portal's views among its nodes (bangun step 5): the matrix and the link are of it
    saved = next((x for x in lineage.list_graphs() if x.get("name") == MAIN_GRAPH), {"nodes": []})
    nodes = [(nid, g.nodes[nid]) for nid in saved.get("nodes") or [] if nid in g.nodes]
    nodes = [(nid, n, t) for nid, n in nodes if (t := _tahap(n, PROJECT))]
    users = {u["username"]: u for u in auth._users()}
    peran = [r for r in PERAN if r[0] in users]
    if not admin:
        # others see their own access only (as in Data Lineage → Permissions)
        peran = [r for r in peran if users[r[0]]["id"] == me.get("id")] or [(me.get("username"), "Akun Anda", "", {}, [], False)]
    rows = []
    cache: dict = {}
    ids = _ids()
    groups = {gr["name"]: gr for gr in auth._groups()}
    # each access role as the change it makes to a principal: its markings, its group
    roles = [(k, groups[name]["id"], set(groups[name].get("markings") or [])) for k, name, *_ in PERAN_AKSES if name in groups]

    def opens(nid: str, n: dict, p: dict, detail: str) -> list[str]:
        """The access roles that alone would open a closed item to this account: checked, not guessed — the same check
        run for the account as a member of that role. A role grants markings and row-policy membership, never a role on
        a Project, so only those reasons are tried."""
        if not (detail.startswith(("missing", "the row policy", "the object policy")) or n.get("kind") == "object_type"):
            return []
        out = []
        for k, gid, marks in roles:
            if gid in (p.get("groups") or []) and marks <= set(p.get("markings") or []):
                continue
            q = {**p, "markings": sorted(set(p.get("markings") or []) | marks), "groups": sorted(set(p.get("groups") or []) | {gid})}
            try:
                if lineage.access_of(nid, n, q, "read", cache)[0] in ("view", "no_data"):
                    out.append(k)
            except HTTPException:
                pass
        return out

    # one matrix at a time: it reads every restricted view's rows once, for all the roles
    with _lock, db.drive_path_memo():
        for username, judul, tugas, *_rest in peran:
            u = users.get(username) or {}
            p = auth.principal_of(u.get("id")) if u else me
            if p is None:
                continue
            sel: dict[str, dict] = {k: {"view": 0, "no_access": 0, "no_data": 0, "unknown": 0, "items": []} for k, *_ in TAHAP}
            for nid, n, t in nodes:
                try:
                    status, detail = lineage.access_of(nid, n, p, "read", cache)
                except HTTPException as e:
                    status, detail = "unknown", str(e.detail)
                c = sel[t]
                c[status] += 1
                c["items"].append({"id": nid, "nama": n.get("name"), "status": status, "alasan": detail,
                                   **({"buka": opens(nid, n, p, detail)} if status == "no_access" else {})})
            rows.append({"username": username, "id": u.get("id") or me.get("id"), "nama": u.get("display_name") or username, "judul": judul, "tugas": tugas,
                         "atribut": {k: v for k, v in (u.get("attributes") or {}).items() if k in ("provinsi_kode", "provinsi")},
                         "tahap": sel})
    out = {
        "tahap": [{"id": k, "nama": nama, "isi": isi} for k, nama, isi in TAHAP],
        "peran": rows,
        "graf": saved.get("id"),
        "dibangun": st.get("built_at"),
        "bisa_bangun": admin,
        # the access roles: what each opens and who is in it (members: the demo roles' accounts, by username)
        "peran_akses": [{"key": k, "id": (groups.get(name) or {}).get("id"), "nama": name, "membuka": what, "ada": name in groups,
                         "penanda": marks, "semua_baris": every,
                         "anggota": sorted(un for un, uid in ids["user"].items() if uid in ((groups.get(name) or {}).get("members") or []))}
                        for k, name, what, marks, every, _first in PERAN_AKSES],
        "lapisan": [
            {"id": "project", "nama": "Peran pada Project", "arti": f"Project {PROJECT}: Pengelola Data jadi Editor (semua tahap); peran lain Discoverer — tahu datanya ada dan silsilahnya, tanpa membaca baris.",
             "aturan": [f"{n} → {r}" for _t, n, r in PROJECT_ROLES]},
            {"id": "folder", "nama": "Peran pada folder & berkas", "arti": "Tiap tahap adalah folder di Project yang sama; peran yang diberikan pada folder menambah akses untuk isinya, tidak pernah mengurangi.",
             "aturan": [f"{path}: " + ", ".join(f"{n} → {r}" for _t, n, r in rows_) for path, rows_ in GRANTS]},
            {"id": "baris", "nama": "Kebijakan baris (portal)", "arti": f"Project {PORTAL}: restricted view atas Siap Analisis. Auditor kantor cabang melihat baris provinsinya (atribut provinsi_kode); tim nasional semua; analis hanya agregat.",
             "aturan": [f"{name}: semua baris untuk {', '.join([*all_rows, G_PROVINSI])}; auditor KC baris provinsinya" for name, _f, all_rows, _w in VIEWS]},
            {"id": "penanda", "nama": "Penanda (marking)", "arti": "Syarat wajib yang ikut ke data turunannya; peran apa pun tidak bisa melewatinya. Objek Nexus dijaga penanda, bukan oleh Project datanya.",
             "aturan": [f"{INDIKASI}: keluaran AI Agent Swarm (indikasi, karantina) — dipegang lewat {G_TEMUAN}",
                        f"{INDIVIDU}: tipe Nexus per klaim/peserta ({', '.join(INDIVIDU_TYPES)}) — dipegang lewat {G_INDIVIDU} (dan administrator)"]},
        ],
    }
    _cache[key] = (time.monotonic(), out)
    return out


@router.get("")
def get_akses(segar: bool = False) -> dict:
    """The access scheme of the BPJS data and what each role can open per stage (the platform's own checks)."""
    return matriks(force=segar)


class AnggotaIn(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    ikut: bool = True  # true: join the role, false: leave it


@router.post("/peran/{key}/anggota")
def set_member(key: str, req: AnggotaIn) -> dict:
    """Add an account to an access role, or take it out (administrators): the access the role carries follows at once
    (its markings, its rows in the portal) and the matrix is computed anew."""
    import auth

    auth.require_admin()
    role = next((r for r in PERAN_AKSES if r[0] == key), None)
    if not role:
        raise HTTPException(404, "peran akses tidak dikenal")
    g = next((x for x in auth._groups() if x["name"] == role[1]), None)
    u = next((x for x in auth._users() if x["username"] == req.username), None)
    if not g:
        raise HTTPException(409, f"{role[1]} belum ada: terapkan skema dulu")
    if not u:
        raise HTTPException(404, "akun tidak ditemukan")
    members = set(g.get("members") or [])
    members = members | {u["id"]} if req.ikut else members - {u["id"]}
    auth.update_group(g["id"], auth.GroupIn(name=g["name"], description=g.get("description") or "", members=sorted(members),
                                            markings=g.get("markings") or []), None)
    _cache.clear()
    return {"peran": key, "username": req.username, "ikut": req.ikut, "anggota": len(members)}


@router.post("/bangun")
def post_bangun() -> dict:
    """Apply the scheme (administrators; idempotent)."""
    with _lock:
        out = bangun()
    return out
