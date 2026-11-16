"""Demo JKN: access per account — demo accounts, the rules that limit what each sees, built into the data pipeline and
visible in Data Lineage ("Node color options → Permissions", View as an account: blue = can view the data, red = no
access).

The audit data is cut along BPJS branch offices (Kantor Cabang). A pipeline after the audit pipeline,
"Pipeline akses berlapis JKN (demo)", tags every facility, case, claim and monthly trend with the branch office that
owns it (cases and claims inherit it from the facility) and writes akses/<name>_per_kc. Those datasets stay in the
audit Project, where the demo accounts have no role; each is shared through a restricted view in the Project
"Portal Audit per Kantor Cabang (demo)" whose row policy lets a user see the rows of their own branch office (user
attribute kantor_cabang), every row for the national investigation team (group), and — for the facility and trend
views only — every row for data analysts (group). The Faskes Audit object type gets the same row policy and a
property policy that hides money values from accounts without the marking "Nilai Keuangan Audit JKN (demo)", so the
Workshop cockpit, Object Explorer and the map show each account its own branch office.

Accounts (password from BLUESANDAI_DEMO_PASSWORD, else BLUESANDAI_GOLDEN_PASSWORD, in the environment or .env.local;
no change asked at the first sign-in):
  demo.kc.kota / demo.kc.kabupaten / demo.kc.raya  auditors of one branch office (attribute, investigation and
                                                   money markings) — only their office's rows
  demo.kedeputian                                  national investigation team: every row, Viewer on the audit
                                                   Project too
  demo.analis                                      data analyst: every facility and trend row, no cases or claims,
                                                   money values hidden
  demo.verifikator                                 member-data officer: the PHI marking and the audit Project (raw
                                                   identity data), the rows of KC Contoh Kota
  demo.tamu                                        guest: the portal only — every row policy leaves them nothing

Synthetic data only; idempotent. State in data/demo-jkn-akses/state.json. Mounted under /api/demo/jkn/akses.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter

log = logging.getLogger("bluesandai.demo_jkn_akses")
router = APIRouter(prefix="/api/demo/jkn/akses")
DIR = Path("data/demo-jkn-akses")
STATE: dict = {}

PROJECT = "JKN Healthcare System Intelligence"
PORTAL = "Portal Audit per Kantor Cabang (demo)"
PIPELINE = "Pipeline akses berlapis JKN (demo)"
WORKSHOP = "Portal audit kantor cabang (demo)"
GRAPH_ID = "jknakses"
GRAPH_NAME = "Lineage akses per akun JKN (demo)"
def _password() -> str:
    """The demo accounts' password: never in the code (the repository is public), always from the environment or .env.local."""
    import auth

    for key in ("BLUESANDAI_DEMO_PASSWORD", "BLUESANDAI_GOLDEN_PASSWORD"):
        v = os.environ.get(key) or auth._env_local(key)
        if v:
            return v
    raise RuntimeError("Set BLUESANDAI_DEMO_PASSWORD in .env.local before creating the demo accounts.")


FIN = "Nilai Keuangan Audit JKN (demo)"
G_NASIONAL = "Tim Investigasi Kedeputian — akses nasional (demo)"
G_ANALIS = "Analis Data JKN (demo)"
G_KC = "Auditor Kantor Cabang JKN (demo)"
KC = ["KC Contoh Kota", "KC Contoh Kabupaten", "KC Contoh Raya"]

# username, display name, role description, attributes, markings (keys), groups (keys), roles on the audit Project
ACCOUNTS = [
    ("demo.kc.kota", "Rina — Auditor KC Contoh Kota (demo)", "Auditor kantor cabang: hanya faskes, kasus dan klaim KC Contoh Kota",
     {"kantor_cabang": "KC Contoh Kota"}, ["inv", "fin"], ["kc"], False),
    ("demo.kc.kabupaten", "Bayu — Auditor KC Contoh Kabupaten (demo)", "Auditor kantor cabang: hanya KC Contoh Kabupaten",
     {"kantor_cabang": "KC Contoh Kabupaten"}, ["inv", "fin"], ["kc"], False),
    ("demo.kc.raya", "Sari — Auditor KC Contoh Raya (demo)", "Auditor kantor cabang: hanya KC Contoh Raya",
     {"kantor_cabang": "KC Contoh Raya"}, ["inv", "fin"], ["kc"], False),
    ("demo.kedeputian", "Hendra — Tim Investigasi Kedeputian (demo)", "Tim investigasi nasional: semua kantor cabang, juga dataset bersih Project audit",
     {}, ["inv", "fin"], ["nasional"], True),
    ("demo.analis", "Maya — Analis Data JKN (demo)", "Analis: semua faskes dan tren, tanpa kasus/klaim, nilai rupiah disembunyikan",
     {}, [], ["analis"], False),
    ("demo.verifikator", "Dewi — Verifikator Data Peserta (demo)", "Petugas data peserta: penanda PHI (identitas mentah), baris KC Contoh Kota",
     {"kantor_cabang": "KC Contoh Kota"}, ["phi"], [], True),
    ("demo.tamu", "Tamu — Pengamat (demo)", "Tamu: hanya portal — kebijakan baris tidak memberinya data apa pun",
     {}, [], [], False),
]

# the pipeline: sources (the audit pipeline's outputs in clean/), transforms, outputs (in akses/)
SOURCES = ["faskes_audit", "kasus_berisiko", "klaim_berisiko_detail", "tren_klaim_bulanan"]
SQL_FASKES = """SELECT kode, nama, jenis, tingkat, wilayah, kantor_cabang, status_audit, skor_risiko, indikasi_utama,
       klaim_berisiko, nilai_klaim_rp, potensi_kerugian_rp, pengembalian_rp, latitude, longitude
FROM faskes_audit"""
SQL_KASUS = """SELECT k.id_kasus, k.jenis_kasus, k.alur, k.faskes_asal, k.nama_faskes_asal, k.faskes_tujuan, k.nama_faskes_tujuan,
       k.diagnosa, k.jumlah_klaim, k.nilai_klaim_rp, k.status_kasus,
       fa.kantor_cabang AS kantor_cabang, ft.kantor_cabang AS kantor_cabang_tujuan
FROM kasus_berisiko k
LEFT JOIN faskes_audit fa ON fa.kode = k.faskes_asal
LEFT JOIN faskes_audit ft ON ft.kode = k.faskes_tujuan"""
SQL_KLAIM = """SELECT d.no_sep, d.tgl_layanan, d.subkategori, d.aturan, d.kode_icd, d.diagnosa, d.faskes_asal, d.nama_faskes_asal,
       d.faskes_tujuan, d.nama_faskes_tujuan, d.nama_dokter_dpjp, d.nilai_klaim, f.kantor_cabang AS kantor_cabang
FROM klaim_berisiko_detail d
LEFT JOIN faskes_audit f ON f.kode = d.faskes_tujuan"""
SQL_TREN = """SELECT t.kode_faskes, f.nama AS nama_faskes, f.kantor_cabang AS kantor_cabang, t.bulan, t.jumlah_klaim, t.nilai_klaim,
       t.jumlah_rujukan, t.rasio_rujukan_pct, t.klaim_berisiko, t.nilai_berisiko, t.porsi_berisiko_pct
FROM tren_klaim_bulanan t
JOIN faskes_audit f ON f.kode = t.kode_faskes"""
TRANSFORMS = [("t_faskes_kc", "faskes_per_kc", "s_faskes_audit", SQL_FASKES), ("t_kasus_kc", "kasus_per_kc", "s_kasus_berisiko", SQL_KASUS),
              ("t_klaim_kc", "klaim_per_kc", "s_klaim_berisiko_detail", SQL_KLAIM), ("t_tren_kc", "tren_per_kc", "s_tren_klaim_bulanan", SQL_TREN)]
# restricted views: name, output, who besides the own branch office sees every row
VIEWS = [("Faskes per kantor cabang (demo)", "faskes_per_kc", ["nasional", "analis"]),
         ("Kasus berisiko per kantor cabang (demo)", "kasus_per_kc", ["nasional"]),
         ("Klaim berisiko per kantor cabang (demo)", "klaim_per_kc", ["nasional"]),
         ("Tren klaim per kantor cabang (demo)", "tren_per_kc", ["nasional", "analis"])]
MONEY = ["nilai_klaim_rp", "potensi_kerugian_rp", "pengembalian_rp"]


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "demo-jkn-akses"
    DIR.mkdir(parents=True, exist_ok=True)
    try:
        STATE.update(json.loads((DIR / "state.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass


def _save() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    (DIR / "state.json").write_text(json.dumps(STATE, indent=1, default=str), encoding="utf-8")


def policy(groups: list[str]) -> dict:
    """The row policy: the user's branch office is the row's, or the user is in one of the groups."""
    return {"kind": "or", "children": [
        {"kind": "condition", "op": "intersects", "left": {"kind": "user_attribute", "attribute": "kantor_cabang"}, "right": {"kind": "property", "property": "kantor_cabang"}},
        {"kind": "condition", "op": "intersects", "left": {"kind": "user_groups"}, "right": {"kind": "static", "value": groups}},
    ]}


def nodes() -> list[dict]:
    out = [{"id": f"s_{n}", "kind": "source", "name": n, "group": "sumber", "doc": f"Keluaran pipeline audit faskes JKN: clean/{n}"} for n in SOURCES]
    out += [{"id": tid, "kind": "sql", "name": name, "group": "akses", "input": src, "sql": sql} for tid, name, src, sql in TRANSFORMS]
    return out


# ------------------------------------------------------------------------------------------------
# accounts, groups, markings
# ------------------------------------------------------------------------------------------------


def _marking(name: str, description: str, color: str) -> dict:
    import auth

    m = next((x for x in auth._markings() if x["name"] == name), None)
    if m:
        return m
    return auth.create_marking(auth.MarkingIn(name=name, description=description, color=color))


def _group(name: str, description: str) -> dict:
    import auth

    g = next((x for x in auth._groups() if x["name"] == name), None)
    if g:
        return g
    return auth.create_group(auth.GroupIn(name=name, description=description), None)


def _accounts(markings: dict[str, str], groups: dict[str, str]) -> dict[str, str]:
    """Create the demo accounts (kept if they exist; their attributes, markings and groups are brought up to date)."""
    import auth

    out = {}
    by_name = {u["username"]: u for u in auth._users()}
    for username, display, desc, attrs, mks, grps, _ in ACCOUNTS:
        u = by_name.get(username)
        want_marks = sorted(markings[k] for k in mks)
        if not u:
            made = auth.create_user(auth.UserIn(username=username, password=_password(), must_change_password=False, display_name=display,
                                                attributes={**attrs, "peran_demo": desc}, markings=want_marks), None)
            u = auth._user(made["id"])
        else:
            u["display_name"] = display
            u["attributes"] = {**(u.get("attributes") or {}), **attrs, "peran_demo": desc}
            u["markings"] = sorted(set(u.get("markings") or []) | set(want_marks))
            auth._save_user(u)
        out[username] = u["id"]
    # group memberships
    for key, gid in groups.items():
        g = next(x for x in auth._groups() if x["id"] == gid)
        members = set(g.get("members") or []) | {out[un] for un, *_r in ACCOUNTS if key in _r[4]}
        if members != set(g.get("members") or []):
            g["members"] = sorted(members)
            auth._put_record("groups", g)
    return out


# ------------------------------------------------------------------------------------------------
# the build
# ------------------------------------------------------------------------------------------------


def _clean_rows(folder: str, name: str) -> tuple[str, list[dict]]:
    import io

    import drive
    import pyarrow.parquet as pq

    item = next(f for f in drive.list_files(folder) if f["name"] == f"{name}.parquet" and not f.get("trashed_at"))
    rows = pq.read_table(io.BytesIO(drive.read_bytes(drive._item(item["id"])))).to_pylist()
    return item["id"], [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()} for r in rows]


def _pipeline_body(items: dict[str, str], previews: dict[str, list[dict]], folder: str) -> tuple[dict, dict[str, str]]:
    import demo_jkn_pipeline as dp

    now = datetime.now(timezone.utc).isoformat()
    uid = lambda: uuid.uuid4().hex[:8]  # noqa: E731
    datasets, out_nodes = {}, []
    for i, n in enumerate(nodes()):
        base = {"id": n["id"], "name": n["name"], "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {PROJECT} / clean / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:200], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            out_nodes.append({**base, "kind": "source", "datasetId": ds, "description": n["doc"], "x": 60, "y": 60 + 170 * i})
        else:
            j = [t[0] for t in TRANSFORMS].index(n["id"])
            out_nodes.append({**base, "kind": "transform", "input": n["input"], "x": 460, "y": 60 + 170 * j,
                              "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": folder, "name": f"{PROJECT} / akses"}
    out_ids = {name: f"o_{tid}" for tid, name, _, _ in TRANSFORMS}
    outputs = [{"id": out_ids[name], "name": name, "node": tid, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": [{"id": uid(), "kind": "notNull", "columns": ["kantor_cabang"]}], "x": 860, "y": 60 + 170 * j}
               for j, (tid, name, _, _) in enumerate(TRANSFORMS)]
    sched = {"id": "jkn-akses-data", "name": "Bangun ulang saat keluaran audit berubah (demo)", "enabled": True, "enabledAt": now, "target": "single",
             "outputs": list(out_ids.values()), "trigger": {"id": "root", "kind": "or", "items": [{"id": "data", "kind": "data"}]},
             "retries": {"count": 1, "delayMinutes": 5}}
    text = [{"id": "note_akses", "x": 40, "y": -200, "w": 860, "h": 140, "color": "lg-akses",
             "text": "AKSES BERLAPIS — setiap baris diberi kantor cabang pemiliknya (kasus dari faskes asal, klaim dari faskes yang menagih). Keluaran "
                     "akses/*_per_kc tidak dibagikan langsung: tiap akun membacanya lewat restricted view di Project portal, yang hanya memperlihatkan baris "
                     "kantor cabangnya (atribut kantor_cabang), semua baris bagi tim nasional, dan faskes/tren bagi analis."}]
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs, "location": location,
            "legend": [{"id": "lg-sumber", "name": "Keluaran pipeline audit", "hex": "#64748b"}, {"id": "lg-akses", "name": "Tag kantor cabang (keamanan baris)", "hex": "#2f7fd6"}],
            "textNodes": text, "schedules": [sched], "meta": {"version": 1, "description": "Demo: data audit per kantor cabang untuk akses per akun."}}
    return body, out_ids


def build() -> dict:
    """Build (or complete) the demo: accounts, rules, pipeline, restricted views, object policy, portal, lineage graph."""
    import auth
    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import demo_jkn_pipeline as dp
    import governance_model
    import lineage
    import ontology
    import ontology_security as osec
    import pipeline_datasets
    import pipeline_runtime as rt
    import restricted_views
    import workshop

    me = auth.current() or {}
    out: dict[str, Any] = {}
    project = e._folder(None, PROJECT, "project")
    clean = e._folder(project, "clean")
    akses = e._folder(project, "akses")

    # 1 · markings and groups
    gm = e.STATE.get("gov_markings") or {}
    fin = _marking(FIN, "Nilai rupiah audit (potensi kerugian, pengembalian, nilai klaim): hanya auditor dan tim investigasi.", "#0ea5e9")
    markings = {"inv": gm.get("inv"), "phi": gm.get("phi"), "fin": fin["id"]}
    markings = {k: v for k, v in markings.items() if v}
    groups = {"nasional": _group(G_NASIONAL, "Melihat data audit semua kantor cabang (demo).")["id"],
              "analis": _group(G_ANALIS, "Melihat faskes dan tren semua kantor cabang, tanpa kasus/klaim (demo).")["id"],
              "kc": _group(G_KC, "Auditor kantor cabang: baris kantor cabangnya sendiri (atribut kantor_cabang) (demo).")["id"]}
    # the owner keeps seeing everything: they join the national group, and hold the money marking
    if me.get("id") and me["id"] != "local":
        g = next(x for x in auth._groups() if x["id"] == groups["nasional"])
        if me["id"] not in (g.get("members") or []):
            g["members"] = sorted(set(g.get("members") or []) | {me["id"]})
            auth._put_record("groups", g)
        u = auth._user(me["id"])
        if fin["id"] not in (u.get("markings") or []):
            u["markings"] = sorted(set(u.get("markings") or []) | {fin["id"]})
            auth._save_user(u)
    users = _accounts(markings, groups)
    STATE.update(markings=markings, groups=groups, users=users)
    _save()
    out["accounts"] = len(users)

    # 2 · the pipeline (first load emulated, like the audit pipeline; later builds by its data trigger)
    items, rows = {}, {}
    for n in SOURCES:
        items[n], rows[n] = _clean_rows(clean, n)
    results = dp.run(rows, nodes())
    ids = {name: e._put(akses, name, e._arrow(results[name], dp.schema_of(results[name])), replace=True) for _, name, _, _ in TRANSFORMS}
    pid = STATE.get("pipeline_id")
    if not pid or not any(p["id"] == pid for p in pipeline_datasets.list_pipelines()):
        body, out_ids = _pipeline_body(items, rows, akses)
        made = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))
        pid = made["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": akses, "version": 0, "rows": len(results[name]),
                                                "path": f"{PROJECT} / akses / {name}.parquet"})
        STATE["pipeline_id"] = pid
        _save()
    out["pipeline"] = {"id": pid, "rows": {name: len(results[name]) for _, name, _, _ in TRANSFORMS}}

    # 3 · the portal Project: every demo account a Viewer; the national team and the member-data officer on the audit Project too
    pid_portal = STATE.get("portal_id")
    import db

    if not pid_portal or not db.drive_get(pid_portal):
        existing = next((i for i in db.drive_list(None) if i.get("kind") == "project" and i["name"] == PORTAL and not i.get("trashed_at")), None)
        pid_portal = existing["id"] if existing else governance_model.create_project(governance_model.NewProjectIn(name=PORTAL), None)["id"]
        STATE["portal_id"] = pid_portal
        _save()

    def grant(project_id: str, user_ids: list[str], role: str = "viewer", kind: str = "user") -> None:
        rows_ = list(auth.project_roles(project_id))
        have = {(r["principal_type"], r["principal_id"]) for r in rows_}
        add = [{"principal_type": kind, "principal_id": u, "role": role} for u in user_ids if (kind, u) not in have]
        if add:
            with auth._lock, auth._db() as con:
                for r in add:
                    con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)",
                                (project_id, r["principal_type"], r["principal_id"], r["role"]))
            auth._project_cache.clear()
            auth._roles_cache.clear()

    grant(pid_portal, list(users.values()))
    grant(project, [users[un] for un, *r in ACCOUNTS if r[5]])

    # 4 · restricted views on the pipeline's outputs (in the portal)
    views = {}
    for name, output, extra in VIEWS:
        rv = next((v for v in restricted_views._all() if v["name"] == name), None)
        pol = policy([groups[k] for k in extra])
        if not rv:
            rv = restricted_views.create_view(restricted_views.ViewIn(name=name, description="Demo: baris kantor cabang sendiri; tim nasional semua baris.",
                                                                      project_id=pid_portal, backing_item_id=ids[output], policy=pol), None)
        elif rv.get("policy") != pol:
            restricted_views.update_view(rv["id"], restricted_views.ViewChange(policy=pol), None)
        views[output] = {"id": rv["id"], "rid": restricted_views.RID + rv["id"], "name": name}
    STATE["views"] = views
    _save()

    # 5 · the Faskes Audit object type: the same row policy, money values behind the marking
    fk = jm._type(jm.FASKES)
    if fk:
        t = ontology._object_type(fk["id"])
        sec = t.get("security") or {}
        have = {p["api_name"] for p in t["properties"]}
        money = [p for p in MONEY if p in have]
        pps = [pp for pp in sec.get("property_policies") or [] if pp.get("name") != "Nilai keuangan (demo)" and not set(pp.get("properties") or []) & set(money)]
        if money:
            pps.append({"name": "Nilai keuangan (demo)", "properties": money, "granular": None, "markings": [fin["id"]]})
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": policy([groups["nasional"], groups["analis"]])}
        osec.set_security(fk["id"], osec.SecurityIn(object_policy=op, property_policies=pps))
        STATE["faskes_type"] = fk["id"]
        _save()

    # 5b · the claims' object policy (demo_jkn_ontology) named a group "jkn-tim-investigasi" that never existed, so no one
    # passed its "under investigation" branch: it names the national investigation team now
    kl = next((t for t in ontology._all("object-types") if t.get("display_name") == "Klaim JKN (demo)"), None)
    if kl and "jkn-tim-investigasi" in json.dumps((kl.get("security") or {}).get("object_policy") or {}):
        sec = kl["security"]
        op = json.loads(json.dumps(sec["object_policy"]).replace('"jkn-tim-investigasi"', json.dumps(groups["nasional"])))
        osec.set_security(kl["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))
        out["klaim_policy_group"] = G_NASIONAL

    # 6 · the portal's Workshop module (each account sees its own rows in it)
    if not any(m.get("name") == WORKSHOP for m in workshop.list_modules()):
        fsrc = {"kind": "restricted_view", "id": views["faskes_per_kc"]["rid"]}
        ksrc = {"kind": "restricted_view", "id": views["kasus_per_kc"]["rid"]}
        csrc = {"kind": "restricted_view", "id": views["klaim_per_kc"]["rid"]}
        w = [
            {"id": "w1", "type": "text", "title": "", "x": 0, "y": 0, "w": 12, "h": 1, "config": {
                "text": "**Portal audit per kantor cabang (demo)** — data yang Anda lihat di sini sudah disaring oleh restricted view: auditor KC hanya "
                        "melihat kantor cabangnya, tim nasional melihat semua, tamu tidak melihat apa pun. Coba masuk dengan akun demo lain."}},
            {"id": "w2", "type": "metric", "title": "Faskes yang terlihat", "x": 0, "y": 1, "w": 3, "h": 2, "config": {"source": fsrc, "metric": "count", "label": "Faskes"}},
            {"id": "w3", "type": "metric", "title": "Kasus berisiko yang terlihat", "x": 3, "y": 1, "w": 3, "h": 2, "config": {"source": ksrc, "metric": "count", "label": "Kasus"}},
            {"id": "w4", "type": "metric", "title": "Klaim berisiko yang terlihat", "x": 6, "y": 1, "w": 3, "h": 2, "config": {"source": csrc, "metric": "count", "label": "Klaim"}},
            {"id": "w5", "type": "bar", "title": "Faskes per kantor cabang", "x": 9, "y": 1, "w": 3, "h": 5, "config": {"source": fsrc, "group_by": "kantor_cabang", "metric": "count"}},
            {"id": "w6", "type": "table", "title": "Faskes (restricted view)", "x": 0, "y": 3, "w": 9, "h": 6, "config": {
                "source": fsrc, "sort": "skor_risiko", "descending": True, "limit": 100,
                "columns": ["kantor_cabang", "nama", "jenis", "status_audit", "skor_risiko", "indikasi_utama", "potensi_kerugian_rp"]}},
            {"id": "w7", "type": "table", "title": "Kasus berisiko (restricted view)", "x": 0, "y": 9, "w": 12, "h": 6, "config": {
                "source": ksrc, "sort": "nilai_klaim_rp", "descending": True, "limit": 100,
                "columns": ["kantor_cabang", "id_kasus", "jenis_kasus", "nama_faskes_asal", "nama_faskes_tujuan", "jumlah_klaim", "nilai_klaim_rp", "status_kasus"]}},
        ]
        if fk:
            w.append({"id": "w8", "type": "table", "title": "Objek Faskes Audit (kebijakan objek & properti)", "x": 0, "y": 15, "w": 12, "h": 6, "config": {
                "source": {"kind": "object_type", "id": fk["id"]}, "sort": "skor_risiko", "descending": True, "limit": 100, "security_markings": "full",
                "columns": ["kantor_cabang", "nama", "status_audit", "skor_risiko", "potensi_kerugian_rp", "pengembalian_rp", "tim_audit"]}})
        m = workshop.create_module(workshop.ModuleIn(name=WORKSHOP, widgets=w, folder_id=pid_portal,
                                                     description="Demo: yang dilihat tiap akun dari data audit, lewat restricted view dan kebijakan objek."))
        STATE["workshop_id"] = m["id"]
        _save()

    # 7 · governance around the accounts: how access is asked for, granted, bounded and reviewed
    out["governance"] = _governance(pid_portal, groups, users, views, grant)

    # 8 · the lineage graph: raw → audit pipeline → clean → access pipeline → akses → restricted views → portal module
    out["lineage"] = _lineage_graph(lineage)
    # 9 · the audit demo's own lineage graph gets the access layer and opens on data permissions, several accounts at once
    out["audit_graph"] = _audit_graph(lineage)
    STATE["built_at"] = datetime.now(timezone.utc).isoformat()
    _save()
    out["views"] = {k: v["name"] for k, v in views.items()}
    out["matrix"] = matrix()
    return out


SPACE = "Ruang Audit Kantor Cabang JKN (demo)"
CP_EXPORT = "Ekspor data portal kantor cabang (demo)"
PRODUCT = "Kebijakan baris per kantor cabang JKN (demo)"
CONTACT = "investigasi.kedeputian@contoh-bpjs.test"


def _governance(portal: str, groups: dict[str, str], users: dict[str, str], views: dict[str, dict], grant) -> dict:  # noqa: ANN001
    """The rest of Security & Governance around the demo accounts (idempotent):
    - request access: the groups have roles on the portal and an access-request category (Peran), so the Request access
      form offers them; the guest has asked to join the data analysts (a pending request in Approvals);
    - the national group: temporary memberships (90 days at most), two approvals from its reviewers to join, an email
      contact — and it is the portal's point of contact in Compass;
    - the cases view is protected: its policy changes only through a global branch and a review;
    - a checkpoint asks branch auditors and analysts why before they save data out of the portal (frontend exports,
      object sets);
    - the portal sits in its own space with a custom space role for the national team;
    - the branch row policy is published in the Marketplace for other regions to install."""
    import approvals
    import auth
    import checkpoints as cpk
    import compass
    import governance_model as gm
    import marketplace
    import restricted_views

    owner = (auth.current() or {}).get("id")
    out: dict[str, Any] = {}
    cats = {"kc": "Auditor kantor cabang", "nasional": "Tim investigasi nasional", "analis": "Analis data"}
    for key, gid in groups.items():
        grant(portal, [gid], "viewer", "group")
        g = next(x for x in auth._groups() if x["id"] == gid)
        g["attributes"] = {**(g.get("attributes") or {}), "access-request:Peran": cats[key]}
        if owner and owner != "local":
            g["managers"] = sorted(set(g.get("managers") or []) | {owner})
        if key == "nasional":
            g["expiry_policy"] = {"max_days": 90}
            g["approval_policy"] = {"min_approvals": 2, "reviewers": [f"user:{owner}", f"user:{users['demo.kedeputian']}"]}
            g["contact"] = {"kind": "email", "value": CONTACT}
        auth._put_record("groups", g)
    out["request_form"] = sorted(cats.values())

    # the guest's request to join the data analysts (one open request at a time)
    tamu = users["demo.tamu"]
    open_ = [r for r in approvals._all() if r["created_by"] == tamu and r["status"] in approvals.OPEN_STATES]
    if not open_:
        tok = auth._principal.set(auth.principal_of(tamu))
        try:
            r = approvals.create_request(approvals.RequestIn(
                title="Bergabung dengan Analis Data JKN (demo)",
                description="Saya ditugaskan menyusun laporan tren klaim bulan ini (contoh permintaan akses dari akun tamu: setelah disetujui, "
                            "restricted view faskes dan tren memperlihatkan semua baris kepadanya).",
                tasks=[approvals.TaskIn(kind="group_membership", params={"group_id": groups["analis"], "users": [tamu]})]))
            out["request"] = r["id"]
        finally:
            auth._principal.reset(tok)
    else:
        out["request"] = open_[0]["id"]
    STATE["request_id"] = out["request"]

    # point of contact, protected view
    try:
        compass.update_project(portal, compass.ProjectIn(point_of_contact=f"group:{groups['nasional']}",
                                                         description="Portal demo: data audit JKN per kantor cabang, disaring per akun oleh restricted view."))
    except Exception as e:  # noqa: BLE001
        out["contact_error"] = str(getattr(e, "detail", e))
    rec = restricted_views._read(views["kasus_per_kc"]["id"])
    if rec and not rec.get("protected"):
        rec["protected"] = True
        restricted_views._write(rec)
    out["protected_view"] = views["kasus_per_kc"]["name"]

    # checkpoint on exports out of the portal
    if not any(c["name"] == CP_EXPORT for c in cpk._configs()):
        cpk.create_config(cpk.ConfigIn(
            name=CP_EXPORT, description="Demo: auditor kantor cabang dan analis menyebutkan tujuan sebelum menyimpan data dari portal.",
            types=["frontend_export"], scope=cpk.Scope(kind="organization", id="*"),
            conditions=[cpk.Condition(kind="user", ids=[groups["kc"], groups["analis"]])],
            title="Untuk apa data ini diunduh?", prompt="Data audit per kantor cabang bersifat terbatas. Pilih tujuan pengunduhan.",
            justification=cpk.Justification(kind="dropdown", options=["Laporan bulanan kantor cabang", "Klarifikasi ke faskes", "Permintaan Kedeputian Wilayah"],
                                            free_text="optional")))
    out["checkpoint"] = CP_EXPORT

    # the portal's space, with a custom space role
    sp = next((s for s in gm.spaces() if s["name"] == SPACE), None)
    if not sp:
        sp = gm.create_space(gm.SpaceIn(name=SPACE, description="Project portal audit per kantor cabang (demo).",
                                        editors=[f"group:{groups['nasional']}"]), None)
    if not any(r["name"] == "Koordinator portal (demo)" for r in sp.get("custom_roles") or []):
        gm.create_space_role(sp["id"], gm.SpaceRoleIn(name="Koordinator portal (demo)", workflows=["view_space", "manage_portfolios", "manage_templates"],
                                                      grants=[f"group:{groups['nasional']}"]), None)
    if gm.project_record(portal).get("space_id") != sp["id"]:
        gm.move_project(portal, gm.MoveIn(space_id=sp["id"]), None)
    out["space"] = SPACE

    # the row policy as a Marketplace product
    if not any(p["name"] == PRODUCT for p in marketplace.list_products()):
        try:
            marketplace.publish(marketplace.PublishIn(kind="bluesandai.restricted-view.product", resource_id=views["kasus_per_kc"]["id"], name=PRODUCT,
                                                      description="Kebijakan baris per kantor cabang (atribut kantor_cabang + kelompok nasional), siap dipasang di wilayah lain."))
        except Exception as e:  # noqa: BLE001
            out["product_error"] = str(getattr(e, "detail", e))
    out["product"] = PRODUCT
    STATE["governance"] = out
    _save()
    return out


def _lineage_graph(lineage) -> dict:  # noqa: ANN001
    g = lineage.build_graph()
    down: dict[str, set] = {}
    up: dict[str, set] = {}
    for ed in g.edges.values():
        down.setdefault(ed["from"], set()).add(ed["to"])
        up.setdefault(ed["to"], set()).add(ed["from"])

    def walk(start: set[str], nbrs: dict[str, set], depth: int) -> set[str]:
        seen, frontier = set(start), set(start)
        for _ in range(depth):
            frontier = {w for v in frontier for w in nbrs.get(v, ())} - seen
            seen |= frontier
        return seen

    seeds = {f"pipeline:{STATE['pipeline_id']}"} if STATE.get("pipeline_id") else set()
    seeds |= {f"restricted_view:{v['id']}" for v in (STATE.get("views") or {}).values()}
    seeds = {s for s in seeds if s in g.nodes}
    keep = walk(seeds, up, 4) | walk(seeds, down, 3)
    # the Faskes Audit objects (object and property policies) and the portal module
    for extra in (f"object_type:{STATE.get('faskes_type')}", f"module:{STATE.get('workshop_id')}"):
        if extra in g.nodes:
            keep |= {extra} | walk({extra}, up, 1)
    # the identity data and its pseudonymisation (PHI: blue only for the member-data officer)
    import demo_jkn_e2e as e

    for k in ("raw", "pseudo"):
        item = (e.STATE.get("gov_items") or {}).get(k)
        if item and f"dataset:{item}" in g.nodes:
            keep |= walk({f"dataset:{item}"}, down, 1) | walk({f"dataset:{item}"}, up, 1)
    keep = {n for n in keep if g.nodes[n]["kind"] not in ("connection",)}
    rec = lineage.save_graph(lineage.SavedGraph(name=GRAPH_NAME, nodes=sorted(keep), color_by="permissions"), id=GRAPH_ID)
    return {"graph": rec["id"], "nodes": len(keep)}


def _audit_graph(lineage) -> dict:  # noqa: ANN001
    """'Lineage audit faskes JKN (demo)' (demo_jkn_e2e.LINEAGE_GRAPH): its nodes plus the access layer (the access
    pipeline and its outputs, the restricted views, the portal module, the identity data and its pseudonymisation),
    coloured by data permissions viewed as a branch auditor, every demo account compared on each node."""
    import demo_jkn_e2e as e

    try:
        cur = lineage.get_graph(e.LINEAGE_GRAPH)
    except Exception:  # noqa: BLE001 - the audit graph is made by the e2e build's lineage step
        return {"skipped": "no audit lineage graph yet"}
    g = lineage.build_graph()
    down: dict[str, set] = {}
    up: dict[str, set] = {}
    for ed in g.edges.values():
        down.setdefault(ed["from"], set()).add(ed["to"])
        up.setdefault(ed["to"], set()).add(ed["from"])
    add: set[str] = set()
    pid = f"pipeline:{STATE.get('pipeline_id')}"
    if pid in g.nodes:
        add |= {pid} | down.get(pid, set()) | up.get(pid, set())
    for v in (STATE.get("views") or {}).values():
        rv = f"restricted_view:{v['id']}"
        if rv in g.nodes:
            add |= {rv} | up.get(rv, set()) | {w for w in down.get(rv, set()) if g.nodes[w]["kind"] == "module"}
    gi = e.STATE.get("gov_items") or {}
    for k in ("raw", "pseudo"):
        d = f"dataset:{gi.get(k)}"
        if d in g.nodes:
            add |= {d} | {w for w in up.get(d, set()) | down.get(d, set()) if g.nodes[w]["kind"] == "transform"}
    nodes = sorted(set(cur.get("nodes") or []) | {n for n in add if n in g.nodes})
    users = STATE.get("users") or {}
    perms = {"view_as": users.get("demo.kc.kota"), "compare": [users[un] for un, *_ in ACCOUNTS if un in users], "type": "read"}
    rec = lineage.save_graph(lineage.SavedGraph(name=cur["name"], nodes=nodes, colors=cur.get("colors") or {}, color_by="permissions", permissions=perms),
                             id=e.LINEAGE_GRAPH)
    return {"graph": rec["id"], "nodes": len(nodes), "added": len(nodes) - len(cur.get("nodes") or []), "compared": len(perms["compare"])}


def matrix() -> dict:
    """Each demo account against the resources of the demo: Data Lineage's permission status (view, no_access,
    no_data) with its detail (rows or objects visible)."""
    import auth
    import lineage

    import db

    ids = [f"restricted_view:{v['id']}" for v in (STATE.get("views") or {}).values()]
    if STATE.get("faskes_type"):
        ids.append(f"object_type:{STATE['faskes_type']}")
    import demo_jkn_e2e as e

    clean = (e.STATE.get("clean") or {})
    ids += [f"dataset:{clean[k]}" for k in ("faskes_audit", "kasus_berisiko") if clean.get(k)]
    gi = e.STATE.get("gov_items") or {}
    ids += [f"dataset:{gi[k]}" for k in ("raw",) if gi.get(k)]
    nodes: dict[str, dict] = {}
    for nid in ids:
        kind, rid = nid.split(":", 1)
        if kind == "dataset":
            it = db.drive_get(rid) or {}
            nodes[nid] = {"kind": "dataset", "item_id": rid, "size": it.get("size_bytes"), "missing": not it or bool(it.get("trashed_at")), "name": it.get("name", rid)}
        elif kind == "restricted_view":
            import restricted_views

            nodes[nid] = {"kind": kind, "name": (restricted_views._read(rid) or {}).get("name", rid)}
        else:
            import ontology

            nodes[nid] = {"kind": kind, "name": (ontology._read(ontology._path("object-types", rid)) or {}).get("display_name", rid)}
    accounts = []
    cache: dict = {}
    for un, display, desc, *_ in ACCOUNTS:
        uid = (STATE.get("users") or {}).get(un)
        p = auth.principal_of(uid) if uid else None
        if not p:
            continue
        accounts.append({"username": un, "user_id": uid, "name": display, "role": desc,
                         "access": {nid: dict(zip(("status", "detail"), lineage.access_of(nid, nodes[nid], p, "read", cache))) for nid in ids}})
    return {"resources": [{"id": nid, "name": nodes[nid]["name"], "kind": nodes[nid]["kind"]} for nid in ids], "accounts": accounts,
            "governance": STATE.get("governance") or {}, "portal_id": STATE.get("portal_id"), "pipeline_id": STATE.get("pipeline_id"),
            "views": STATE.get("views") or {}, "graph": GRAPH_ID,
            "lineage": f"/lineage?graph={GRAPH_ID}", "portal_module": STATE.get("workshop_id"), "password": _password()}


@router.post("")
def build_route() -> dict:
    import auth

    auth.require_admin()
    return build()


@router.get("")
def overview() -> dict:
    """Administrators and the national investigation team see every account's access."""
    import auth

    me = auth.require_user()
    if not auth._is_admin(me) and (STATE.get("groups") or {}).get("nasional") not in set(me.get("groups") or []):
        from fastapi import HTTPException

        raise HTTPException(403, "Only administrators and the national investigation team see the access of every account")
    return {"built_at": STATE.get("built_at"), **(matrix() if STATE.get("views") else {})}
