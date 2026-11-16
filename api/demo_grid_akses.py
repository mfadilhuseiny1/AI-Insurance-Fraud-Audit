"""Demo Grid: access per account — demo accounts, the rules that limit what each sees, built into the data pipeline and
visible in Data Lineage (Permissions colouring, View as an account: blue = can view, red = no access).

The loss data is cut along service units (ULP). "Pipeline akses per ULP grid (demo)" reads the loss pipeline's outputs
and writes akses/<name>_per_ulp — every finding, customer, distribution transformer and feeder with its ULP. Those
datasets stay in the grid Project, where the demo accounts have no role; each is shared through a restricted view in
the Project "Portal Susut per ULP (demo)", whose row policy lets a user see the rows of their own ULP (user attribute
kode_ulp), every row for the UP3 team (group), and — for transformers and feeders — every row for loss analysts and
network operations (groups). The Pelanggan and Temuan Susut object types get the same row policy, so Object Explorer,
the map, Vertex and the Workshop cockpit show each account its own ULP.

Accounts (password PASSWORD; no change asked at first sign-in):
  demo.grid.manajer           UP3 manager: every ULP, findings with their evidence (investigation marking)
  demo.grid.analis            loss analyst: every transformer and feeder, customers and findings of no ULP
  demo.grid.p2tl.utara        P2TL team ULP Cikarang Utara: its ULP only; PII (addresses for the visit), evidence
  demo.grid.p2tl.selatan      P2TL team ULP Cikarang Selatan: its ULP only
  demo.grid.p2tl.tm           UP3 TM team: the industrial estate's ULP (TM customers)
  demo.grid.dispatcher        network operations: every feeder and transformer, the SCADA model (critical infrastructure)
  demo.grid.auditor           internal auditor: every row, no identity
  demo.grid.tamu              guest: the portal only — the row policies leave them nothing (asked to join the analysts)

Synthetic data only; idempotent. State in demo_grid_e2e.STATE["akses"]. Mounted under /api/demo/grid/akses.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter(prefix="/api/demo/grid/akses")

PORTAL = "Portal Susut per ULP (demo)"
PIPELINE = "Pipeline akses per ULP grid (demo)"
WORKSHOP = "Portal susut per ULP (demo)"
GRAPH_ID = "gridakses"
GRAPH_NAME = "Lineage akses per akun grid (demo)"
PASSWORD = "GridDemo-Susut26!"
G_UP3 = "Tim UP3 Demo — akses semua ULP (grid demo)"
G_ANALIS = "Analis Susut Grid (demo)"
G_P2TL = "Tim P2TL per ULP (grid demo)"
G_OPS = "Operasi Jaringan Grid (demo)"
CP_EXPORT = "Ekspor data portal susut per ULP (demo)"

# username, display name, role, attributes, markings (keys of the grid markings), groups (keys)
ACCOUNTS = [
    ("demo.grid.manajer", "Bambang — Manajer UP3 Demo (demo)", "Manajer UP3: semua ULP, temuan dengan buktinya", {}, ["inv"], ["up3"]),
    ("demo.grid.analis", "Laras — Analis Susut (demo)", "Analis susut: semua gardu dan penyulang; pelanggan dan temuan tidak", {}, [], ["analis"]),
    ("demo.grid.p2tl.utara", "Asep — Tim P2TL Cikarang Utara (demo)", "Tim P2TL: hanya ULP Cikarang Utara; alamat untuk kunjungan (PII)",
     {"kode_ulp": "ULP-KTU"}, ["pii", "inv"], ["p2tl"]),
    ("demo.grid.p2tl.selatan", "Euis — Tim P2TL Cikarang Selatan (demo)", "Tim P2TL: hanya ULP Cikarang Selatan", {"kode_ulp": "ULP-KTS"}, ["pii", "inv"], ["p2tl"]),
    ("demo.grid.p2tl.tm", "Gilang — Tim P2TL TM UP3 (demo)", "Tim TM: hanya kawasan industri (pelanggan TM)", {"kode_ulp": "ULP-KWS"}, ["pii", "inv"], ["p2tl"]),
    ("demo.grid.dispatcher", "Rudi — Dispatcher Operasi Jaringan (demo)", "Operasi jaringan: semua penyulang & gardu, model SCADA (infrastruktur kritis)",
     {}, ["ceii"], ["ops"]),
    ("demo.grid.auditor", "Nur — Auditor Internal (demo)", "Auditor internal: semua baris, tanpa identitas pelanggan", {}, ["inv"], ["up3"]),
    ("demo.grid.tamu", "Tamu — Pengamat (demo)", "Tamu: hanya portal — kebijakan baris tidak memberinya data apa pun", {}, [], []),
]
SOURCES = ["temuan_susut", "pelanggan_status", "gardu_distribusi_status", "penyulang_status"]
SQL = {
    "temuan_per_ulp": """-- Temuan susut dengan ULP pemiliknya (keamanan baris per ULP).
SELECT id_temuan, kode_objek, jenis_objek, kelompok_susut, kode_pola_dugaan, judul, skor, bukti, kwh_hilang_bulan, nilai_rp_bulan,
       nilai_harapan_rp, prioritas, status_temuan, segmen, tegangan, kode_dt, kode_penyulang, kode_ulp
FROM temuan_susut""",
    "pelanggan_per_ulp": """-- Pelanggan (tanpa identitas) dengan ULP, golongan, pemakaian, temuan dan P2TL terakhir.
SELECT id_pelanggan, golongan, segmen, tegangan, jenis_meter, ami, kode_dt, kode_penyulang, kode_ulp, kwh_bulan_q2, kwh_bulan_q3,
       perubahan_pct, pola_dugaan, skor_aturan, nilai_harapan_rp, prioritas, p2tl_terakhir, golongan_pelanggaran_lalu, latitude, longitude
FROM pelanggan_status""",
    "gardu_per_ulp": """-- Gardu distribusi dengan ULP, neraca Jul–Sep dan status.
SELECT kode_dt, nama, kode_penyulang, kode_ulp, kva, tahun_pasang, jumlah_pelanggan, susut_pct, susut_teknis_pct, susut_non_teknis_pct,
       beban_puncak_pct, jumlah_temuan, nilai_harapan_rp, status_gardu, latitude, longitude
FROM gardu_distribusi_status""",
    "penyulang_per_ulp": """-- Penyulang dengan ULP, neraca Jul–Sep, keandalan dan temuan.
SELECT kode_penyulang, nama, kode_gi, kode_ulp, jenis, mwh_kirim_q3, susut_pct, susut_teknis_pct, susut_non_teknis_pct, saidi_menit, saifi_kali,
       jumlah_temuan, nilai_harapan_rp, tingkat_susut
FROM penyulang_status""",
}
TRANSFORMS = [("t_temuan", "temuan_per_ulp", "s_temuan_susut"), ("t_pelanggan", "pelanggan_per_ulp", "s_pelanggan_status"),
              ("t_gardu", "gardu_per_ulp", "s_gardu_distribusi_status"), ("t_penyulang", "penyulang_per_ulp", "s_penyulang_status")]
# restricted views: name, output, groups that see every row
VIEWS = [("Temuan susut per ULP (demo)", "temuan_per_ulp", ["up3"]), ("Pelanggan per ULP (demo)", "pelanggan_per_ulp", ["up3"]),
         ("Gardu distribusi per ULP (demo)", "gardu_per_ulp", ["up3", "analis", "ops"]),
         ("Penyulang per ULP (demo)", "penyulang_per_ulp", ["up3", "analis", "ops"])]


def _state() -> dict:
    import demo_grid_e2e as e

    return e.STATE.setdefault("akses", {})


def policy(groups: list[str]) -> dict:
    return {"kind": "or", "children": [
        {"kind": "condition", "op": "intersects", "left": {"kind": "user_attribute", "attribute": "kode_ulp"}, "right": {"kind": "property", "property": "kode_ulp"}},
        {"kind": "condition", "op": "intersects", "left": {"kind": "user_groups"}, "right": {"kind": "static", "value": groups}},
    ]}


def nodes() -> list[dict]:
    out = [{"id": f"s_{n}", "kind": "source", "name": n, "group": "sumber", "doc": f"Keluaran pipeline neraca energi & susut: susut/{n}"} for n in SOURCES]
    out += [{"id": tid, "kind": "sql", "name": name, "group": "akses", "input": src, "sql": SQL[name]} for tid, name, src in TRANSFORMS]
    return out


def _group(name: str, description: str) -> dict:
    import auth

    g = next((x for x in auth._groups() if x["name"] == name), None)
    return g or auth.create_group(auth.GroupIn(name=name, description=description), None)


def _accounts(markings: dict[str, str], groups: dict[str, str]) -> dict[str, str]:
    import auth

    out = {}
    by_name = {u["username"]: u for u in auth._users()}
    for username, display, desc, attrs, mks, _g in ACCOUNTS:
        u = by_name.get(username)
        want = sorted(markings[k] for k in mks if k in markings)
        if not u:
            made = auth.create_user(auth.UserIn(username=username, password=PASSWORD, must_change_password=False, display_name=display,
                                                attributes={**attrs, "peran_demo": desc}, markings=want), None)
            u = auth._user(made["id"])
        else:
            u["display_name"] = display
            u["attributes"] = {**(u.get("attributes") or {}), **attrs, "peran_demo": desc}
            u["markings"] = sorted(set(u.get("markings") or []) | set(want))
            auth._save_user(u)
        out[username] = u["id"]
    for key, gid in groups.items():
        g = next(x for x in auth._groups() if x["id"] == gid)
        members = set(g.get("members") or []) | {out[un] for un, *_r in ACCOUNTS if key in _r[4]}
        if members != set(g.get("members") or []):
            g["members"] = sorted(members)
            auth._put_record("groups", g)
    return out


def _grant(project_id: str, ids: list[str], role: str = "viewer", kind: str = "user") -> None:
    import auth

    have = {(r["principal_type"], r["principal_id"]) for r in auth.project_roles(project_id)}
    add = [(kind, x) for x in ids if (kind, x) not in have]
    if add:
        with auth._lock, auth._db() as con:
            for k, x in add:
                con.execute("INSERT INTO project_roles (project_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)", (project_id, k, x, role))
        auth._project_cache.clear()
        auth._roles_cache.clear()


def _pipeline_body(project: str, items: dict[str, str], previews: dict[str, list[dict]], folder: str) -> tuple[dict, dict[str, str]]:
    import demo_jkn_pipeline as dp

    import demo_grid_e2e as e

    now = datetime.now(timezone.utc).isoformat()
    uid = lambda: uuid.uuid4().hex[:8]  # noqa: E731
    datasets, out_nodes = {}, []
    for i, n in enumerate(nodes()):
        b = {"id": n["id"], "name": n["name"], "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = previews[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {project} / susut / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in dp.schema_of(rows)], "rows": rows[:200], "ref": {"kind": "drive", "itemId": items[n["name"]]}}
            out_nodes.append({**b, "kind": "source", "datasetId": ds, "description": n["doc"], "x": 60, "y": 60 + 170 * i})
        else:
            j = [t[0] for t in TRANSFORMS].index(n["id"])
            out_nodes.append({**b, "kind": "transform", "input": n["input"], "x": 460, "y": 60 + 170 * j,
                              "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}]})
    location = {"id": folder, "name": f"{project} / akses"}
    out_ids = {name: f"o_{tid}" for tid, name, _ in TRANSFORMS}
    outputs = [{"id": out_ids[name], "name": name, "node": tid, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                "expectations": [{"id": uid(), "kind": "notNull", "columns": ["kode_ulp"]}], "x": 860, "y": 60 + 170 * j}
               for j, (tid, name, _) in enumerate(TRANSFORMS)]
    text = [{"id": "note_akses", "x": 40, "y": -200, "w": 860, "h": 140, "color": "lg-akses",
             "text": "AKSES PER ULP — setiap temuan, pelanggan, gardu dan penyulang membawa ULP pemiliknya. Keluaran akses/*_per_ulp tidak dibagikan "
                     "langsung: tiap akun membacanya lewat restricted view di Project portal — baris ULP-nya sendiri (atribut kode_ulp), semua baris bagi "
                     "tim UP3, gardu & penyulang bagi analis dan operasi jaringan."}]
    body = {"type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs, "location": location,
            "legend": [{"id": "lg-sumber", "name": "Keluaran pipeline susut", "hex": "#64748b"}, {"id": "lg-akses", "name": "Tag ULP (keamanan baris)", "hex": "#2f7fd6"}],
            "textNodes": text, "schedules": [e._schedule("akses", list(out_ids.values()))],
            "meta": {"version": 1, "description": "Demo: data susut per ULP untuk akses per akun."}}
    return body, out_ids


def build(state_root: dict, save) -> dict:
    """Accounts, groups, the access pipeline, the portal Project with restricted views, object row policies, the portal
    Workshop, an access request, an export checkpoint, the lineage graph in Permissions mode; returns the matrix."""
    import io

    import auth
    import checkpoints as cpk
    import db
    import drive
    import governance_model
    import lineage
    import pipeline_datasets
    import pipeline_runtime as rt
    import pyarrow.parquet as pq
    import restricted_views

    import demo_grid_e2e as e
    import demo_jkn_pipeline as dp

    st = _state()
    me = auth.current() or {}
    out: dict[str, Any] = {}
    project = e._folder(None, e.PROJECT, "project")
    susut = e._folder(project, "susut")
    akses = e._folder(project, "akses")

    # 1 · markings (from the governance step), groups, accounts; the owner keeps seeing everything (UP3 group)
    gm = e.STATE.get("gov_markings") or {}
    groups = {"up3": _group(G_UP3, "Melihat data susut semua ULP (grid demo).")["id"],
              "analis": _group(G_ANALIS, "Gardu dan penyulang semua ULP; pelanggan & temuan tidak (grid demo).")["id"],
              "p2tl": _group(G_P2TL, "Tim P2TL: baris ULP-nya sendiri (atribut kode_ulp) (grid demo).")["id"],
              "ops": _group(G_OPS, "Operasi jaringan: penyulang & gardu semua ULP, model SCADA (grid demo).")["id"]}
    if me.get("id") and me["id"] != "local":
        g = next(x for x in auth._groups() if x["id"] == groups["up3"])
        if me["id"] not in (g.get("members") or []):
            g["members"] = sorted(set(g.get("members") or []) | {me["id"]})
            auth._put_record("groups", g)
        auth._principal.set({**me, **(auth.principal_of(me["id"]) or {})})
    users = _accounts(gm, groups)
    st.update(groups=groups, users=users)
    save()
    out["accounts"] = len(users)

    # 2 · the access pipeline (first load emulated; later builds by its data trigger)
    items, rows = {}, {}
    for n in SOURCES:
        f = next(x for x in drive.list_files(susut) if x["name"] == f"{n}.parquet" and not x.get("trashed_at"))
        items[n] = f["id"]
        rows[n] = [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()}
                   for r in pq.read_table(io.BytesIO(drive.read_bytes(drive._item(f["id"])))).to_pylist()]
    results = dp.run(rows, nodes())
    ids = {name: e._put(akses, name, results[name]) for _, name, _ in TRANSFORMS}
    pid = st.get("pipeline_id")
    if not pid or not db.drive_get(pid):
        body, out_ids = _pipeline_body(e.PROJECT, items, rows, akses)
        pid = pipeline_datasets.create_pipeline(pipeline_datasets.NewPipelineFile(name=PIPELINE, parent_id=e._folder(project, "pipelines"), content=body))["id"]
        for name, oid in out_ids.items():
            rt.set_state(pid, f"output:{oid}", {"itemId": ids[name], "parentId": akses, "version": 0, "rows": len(results[name]),
                                                "path": f"{e.PROJECT} / akses / {name}.parquet"})
        st["pipeline_id"] = pid
        save()
    out["pipeline"] = {"id": pid, "rows": {name: len(results[name]) for _, name, _ in TRANSFORMS}}

    # 3 · the portal Project: every demo account a Viewer (and the groups, for the access-request form)
    portal = st.get("portal_id")
    if not portal or not db.drive_get(portal):
        existing = next((i for i in db.drive_list(None) if i.get("kind") == "project" and i["name"] == PORTAL and not i.get("trashed_at")), None)
        portal = existing["id"] if existing else governance_model.create_project(governance_model.NewProjectIn(name=PORTAL), None)["id"]
        st["portal_id"] = portal
        save()
    _grant(portal, list(users.values()))
    cats = {"up3": "Tim UP3", "analis": "Analis susut", "p2tl": "Tim P2TL", "ops": "Operasi jaringan"}
    for key, gid in groups.items():
        _grant(portal, [gid], "viewer", "group")
        g = next(x for x in auth._groups() if x["id"] == gid)
        g["attributes"] = {**(g.get("attributes") or {}), "access-request:Peran": cats[key]}
        if me.get("id") and me["id"] != "local":
            g["managers"] = sorted(set(g.get("managers") or []) | {me["id"]})
        auth._put_record("groups", g)
    # the manager, the auditor and the dispatcher may open the grid Project's datasets too (Viewer; markings still apply)
    _grant(project, [users["demo.grid.manajer"], users["demo.grid.auditor"], users["demo.grid.dispatcher"]])

    # 4 · restricted views
    views = {}
    for name, output, extra in VIEWS:
        rv = next((v for v in restricted_views._all() if v["name"] == name), None)
        pol = policy([groups[k] for k in extra])
        if not rv:
            rv = restricted_views.create_view(restricted_views.ViewIn(name=name, description="Demo: baris ULP sendiri; tim UP3 semua baris.",
                                                                      project_id=portal, backing_item_id=ids[output], policy=pol), None)
        elif rv.get("policy") != pol:
            restricted_views.update_view(rv["id"], restricted_views.ViewChange(policy=pol), None)
        views[output] = {"id": rv["id"], "rid": restricted_views.RID + rv["id"], "name": name}
    st["views"] = views
    save()

    # 5a · the SCADA network model (CEII) is read by its own pipeline only (markings follow a pipeline's inputs to every
    # output); as a safety net the business object types also stop inheriting CEII from their datasources — only the
    # SCADA measuring points keep it (dispatchers)
    st["ceii_stopped"] = stop_ceii(gm.get("ceii"))
    # 5 · object row policies per ULP, the same as the restricted views (property policies kept)
    object_policies(groups)
    st["types"] = {k: (e._type(k) or {}).get("id") for k in ("pelanggan", "temuan", "gardu", "penyulang")}

    # 6 · the portal Workshop
    portal_workshop(st, portal, save)

    # 7 · governance: the guest's access request (Approvals), an export checkpoint for P2TL teams and analysts
    out["request"] = _request(users, groups)
    st["request"] = out["request"]
    if not any(c["name"] == CP_EXPORT for c in cpk._configs()):
        try:
            cpk.create_config(cpk.ConfigIn(
                name=CP_EXPORT, description="Demo: tim P2TL dan analis menyebut tujuan sebelum menyimpan data dari portal susut.",
                types=["frontend_export"], scope=cpk.Scope(kind="organization", id="*"),
                conditions=[cpk.Condition(kind="user", ids=[groups["p2tl"], groups["analis"]])],
                title="Untuk apa data ini diunduh?", prompt="Data susut per ULP memuat dugaan pelanggaran pelanggan. Pilih tujuan pengunduhan.",
                justification=cpk.Justification(kind="dropdown", options=["Operasi P2TL terjadwal", "Laporan susut bulanan ULP", "Permintaan UP3"],
                                                free_text="optional")))
        except Exception as ex:  # noqa: BLE001
            out["checkpoint_error"] = str(getattr(ex, "detail", ex))[:300]

    # 8 · the lineage graph, coloured by data permissions (View as a P2TL team, every account compared)
    out["lineage"] = _lineage_graph(lineage)
    st["built_at"] = datetime.now(timezone.utc).isoformat()
    save()
    out["views"] = {k: v["name"] for k, v in views.items()}
    m = matrix()
    out["matrix"] = {a["username"]: {r: v["status"] for r, v in a["access"].items()} for a in m["accounts"]}
    return out


def portal_workshop(st: dict, portal: str, save) -> None:  # noqa: ANN001
    """The portal Workshop, on the Nexus types under their per-ULP object policies (a restricted view's rows are read
    with the backing dataset's Project role here, which the P2TL teams do not hold: the views serve the analysts'
    Contour and SQL instead). Created, or moved off restricted views."""
    import workshop

    tsrc = {"kind": "object_type", "id": st["types"]["temuan"]}
    psrc = {"kind": "object_type", "id": st["types"]["pelanggan"]}
    gsrc = {"kind": "object_type", "id": st["types"]["gardu"]}
    w = [
        {"id": "w1", "type": "text", "title": "", "x": 0, "y": 0, "w": 12, "h": 2, "config": {
            "text": "**Portal susut per ULP (demo)** — objek Nexus di sini disaring kebijakan baris per ULP: tim P2TL hanya melihat ULP-nya, tim UP3 semua, "
                    "analis & operasi jaringan hanya gardu/penyulang, tamu tidak melihat apa pun. Coba masuk dengan akun demo lain."}},
        {"id": "w2", "type": "metric", "title": "Temuan yang terlihat", "x": 0, "y": 2, "w": 3, "h": 3, "config": {"source": tsrc, "metric": "count", "label": "temuan"}},
        {"id": "w3", "type": "metric", "title": "Pelanggan yang terlihat", "x": 3, "y": 2, "w": 3, "h": 3, "config": {"source": psrc, "metric": "count", "label": "pelanggan"}},
        {"id": "w4", "type": "metric", "title": "Gardu yang terlihat", "x": 6, "y": 2, "w": 3, "h": 3, "config": {"source": gsrc, "metric": "count", "label": "gardu"}},
        {"id": "w5", "type": "bar", "title": "Temuan per ULP", "x": 9, "y": 2, "w": 3, "h": 6, "config": {"source": tsrc, "group_by": "kode_ulp", "metric": "count"}},
        {"id": "w6", "type": "table", "title": "Temuan (ULP Anda)", "x": 0, "y": 5, "w": 9, "h": 6, "config": {
            "source": tsrc, "sort": "nilai_harapan_rp", "descending": True, "limit": 100,
            "columns": ["kode_ulp", "id_temuan", "kode_objek", "kode_pola_dugaan", "prioritas", "nilai_harapan_rp", "status_temuan"]}},
        {"id": "w7", "type": "table", "title": "Gardu distribusi (ULP Anda)", "x": 0, "y": 11, "w": 12, "h": 6, "config": {
            "source": gsrc, "sort": "susut_pct", "descending": True, "limit": 102,
            "columns": ["kode_ulp", "kode_dt", "status_gardu", "susut_pct", "susut_non_teknis_pct", "beban_puncak_pct", "jumlah_temuan"]}},
    ]
    spec = workshop.ModuleIn(name=WORKSHOP, widgets=w, folder_id=portal,
                             description="Demo: yang dilihat tiap akun dari data susut, lewat kebijakan baris per ULP pada objek Nexus.")
    have = next((x for x in workshop.list_modules() if x.get("name") == WORKSHOP), None)
    if not have:
        have = workshop.create_module(spec)
    elif any(((x.get("config") or {}).get("source") or {}).get("kind") == "restricted_view" for x in workshop._module(have["id"]).get("widgets") or []):
        workshop.save_module(have["id"], workshop.ModuleIn(**spec.model_dump(exclude_unset=True), version_note="Sumber: objek Nexus dengan kebijakan per ULP"))
    st["workshop_id"] = have["id"]
    save()


def object_policies(groups: dict[str, str]) -> None:
    """Row policies on the Nexus types, as on the restricted views: customers and findings per ULP (UP3 all), transformers
    and feeders per ULP (UP3, analysts and network operations all)."""
    import ontology
    import ontology_security as osec

    import demo_grid_e2e as e

    for key, extra in (("pelanggan", ["up3"]), ("temuan", ["up3"]), ("gardu", ["up3", "analis", "ops"]), ("penyulang", ["up3", "analis", "ops"])):
        t = e._type(key)
        if not t:
            continue
        sec = ontology._object_type(t["id"]).get("security") or {}
        op = {**(sec.get("object_policy") or {"markings": []}), "granular": policy([groups[k] for k in extra])}
        if (sec.get("object_policy") or {}).get("granular") != op["granular"]:
            osec.set_security(t["id"], osec.SecurityIn(object_policy=op, property_policies=sec.get("property_policies") or []))


def stop_ceii(ceii: Optional[str]) -> list[str]:
    """Object types (except the SCADA measuring points) stop inheriting the CEII marking of their datasources."""
    import ontology
    import ontology_security as osec

    import demo_grid_e2e as e

    done = []
    if not ceii:
        return done
    for key in e.T:
        t = e._type(key)
        if not t or key == "titik":
            continue
        cur = set((ontology._object_type(t["id"]).get("datasource_markings") or {}).get("stop_inheriting") or [])
        if ceii not in cur:
            osec.set_datasource_markings(t["id"], osec.InheritIn(stop_inheriting=sorted(cur | {ceii})))
        done.append(key)
    return done


def _request(users: dict[str, str], groups: dict[str, str]) -> Any:
    import approvals
    import auth

    tamu = users["demo.grid.tamu"]
    open_ = [r for r in approvals._all() if r["created_by"] == tamu and r["status"] in approvals.OPEN_STATES]
    if open_:
        return open_[0]["id"]
    tok = auth._principal.set(auth.principal_of(tamu))
    try:
        r = approvals.create_request(approvals.RequestIn(
            title="Bergabung dengan Analis Susut Grid (demo)",
            description="Saya ditugaskan menyusun laporan susut gardu bulan ini (contoh permintaan akses dari akun tamu: setelah disetujui, restricted view "
                        "gardu dan penyulang memperlihatkan semua baris kepadanya).",
            tasks=[approvals.TaskIn(kind="group_membership", params={"group_id": groups["analis"], "users": [tamu]})]))
        return r["id"]
    finally:
        auth._principal.reset(tok)


def _lineage_graph(lineage) -> dict:  # noqa: ANN001
    import demo_grid_e2e as e

    st = _state()
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

    seeds = {f"pipeline:{st['pipeline_id']}"} if st.get("pipeline_id") else set()
    seeds |= {f"restricted_view:{v['id']}" for v in (st.get("views") or {}).values()}
    seeds = {s for s in seeds if s in g.nodes}
    keep = walk(seeds, up, 4) | walk(seeds, down, 3)
    for tid in (st.get("types") or {}).values():
        n = f"object_type:{tid}"
        if n in g.nodes:
            keep |= {n} | walk({n}, up, 1)
    if f"module:{st.get('workshop_id')}" in g.nodes:
        keep.add(f"module:{st['workshop_id']}")
    for k in ("raw", "pseudo"):
        item = (e.STATE.get("gov_items") or {}).get(k)
        if item and f"dataset:{item}" in g.nodes:
            keep |= walk({f"dataset:{item}"}, down, 1) | walk({f"dataset:{item}"}, up, 1)
    keep = {n for n in keep if g.nodes[n]["kind"] != "connection"}
    users = st.get("users") or {}
    perms = {"view_as": users.get("demo.grid.p2tl.utara"), "compare": [users[un] for un, *_ in ACCOUNTS if un in users], "type": "read"}
    rec = lineage.save_graph(lineage.SavedGraph(name=GRAPH_NAME, nodes=sorted(keep), color_by="permissions", permissions=perms), id=GRAPH_ID)
    return {"graph": rec["id"], "nodes": len(keep)}


def matrix() -> dict:
    """Each demo account against the demo's resources: Data Lineage's permission status (view, no_access, no_data)."""
    import auth
    import db
    import lineage
    import ontology
    import restricted_views

    import demo_grid_e2e as e

    st = _state()
    ids = [f"restricted_view:{v['id']}" for v in (st.get("views") or {}).values()]
    ids += [f"object_type:{t}" for t in (st.get("types") or {}).values() if t]
    gi = e.STATE.get("gov_items") or {}
    ids += [f"dataset:{gi[k]}" for k in ("raw", "pseudo") if gi.get(k)]
    raw = e._folder(e._folder(None, e.PROJECT, "project"), "raw")
    import drive

    scada = next((f["id"] for f in drive.list_files(raw) if f["name"] == "scada_titik_ukur_nusagrid.parquet" and not f.get("trashed_at")), None)
    if scada:
        ids.append(f"dataset:{scada}")
    nodes: dict[str, dict] = {}
    for nid in ids:
        kind, rid = nid.split(":", 1)
        if kind == "dataset":
            it = db.drive_get(rid) or {}
            nodes[nid] = {"kind": "dataset", "item_id": rid, "size": it.get("size_bytes"), "missing": not it or bool(it.get("trashed_at")), "name": it.get("name", rid)}
        elif kind == "restricted_view":
            nodes[nid] = {"kind": kind, "name": (restricted_views._read(rid) or {}).get("name", rid)}
        else:
            nodes[nid] = {"kind": kind, "name": (ontology._read(ontology._path("object-types", rid)) or {}).get("display_name", rid)}
    accounts = []
    cache: dict = {}
    for un, display, desc, *_ in ACCOUNTS:
        uid = (st.get("users") or {}).get(un)
        p = auth.principal_of(uid) if uid else None
        if not p:
            continue
        accounts.append({"username": un, "user_id": uid, "name": display, "role": desc,
                         "access": {nid: dict(zip(("status", "detail"), lineage.access_of(nid, nodes[nid], p, "read", cache))) for nid in ids}})
    return {"resources": [{"id": nid, "name": nodes[nid]["name"], "kind": nodes[nid]["kind"]} for nid in ids], "accounts": accounts,
            "portal_id": st.get("portal_id"), "pipeline_id": st.get("pipeline_id"), "views": st.get("views") or {}, "graph": GRAPH_ID,
            "lineage": f"/lineage?graph={GRAPH_ID}", "portal_module": st.get("workshop_id"), "request": st.get("request"), "password": PASSWORD}


@router.get("")
def overview() -> dict:
    """Administrators and the UP3 team see every account's access."""
    import auth
    from fastapi import HTTPException

    me = auth.require_user()
    st = _state()
    if not auth._is_admin(me) and (st.get("groups") or {}).get("up3") not in set(me.get("groups") or []):
        raise HTTPException(403, "Only administrators and the UP3 team see the access of every account")
    return {"built_at": st.get("built_at"), **(matrix() if st.get("views") else {})}
