"""Demo Grid: security and governance of the grid data, on the platform's own controls (called by demo_grid_e2e.build).

1. AP2T's identity export lands in raw/ (ap2t_pelanggan_identitas: name, NIK, address, phone, meter number, parcel
   coordinates); Sensitive Data Scanner finds NIK, names, addresses and phone numbers, marks the dataset
   "PII Pelanggan Listrik (demo)" and opens issues.
2. A Python transform pseudonymises it with Cipher — the meter number encrypted deterministically (AES-256-SIV: the same
   meter, the same pseudonym, so P2TL teams can still join), the NIK hashed with a pepper (SHA-256), name, phone and
   street address dropped, the parcel coordinates kept only as the sub-district — and stops the PII marking from
   propagating (stop_propagating: only an administrator may build it) → governance/pelanggan_identitas_pseudonim.
3. An Operational Cipher license lets the P2TL team decrypt one meter number at a time behind a checkpoint and a rate
   limit (for the field visit), every value audited.
4. "Infrastruktur Kritis Grid (demo)" (critical energy infrastructure, CEII-like) marks NUSAGRID SCADA's equipment model
   and point list in raw/: control points and protection settings reach only the grid-operations team; the marking
   propagates to the SCADA points the pipeline derives.
5. Property policies: the parcel location of customers (PII) and the evidence and notes of loss findings
   ("Investigasi Susut Grid (demo)") — a finding is an allegation until P2TL confirms it.
6. Checkpoints: a purpose before exporting the Project's data, a basis before targeting / escalating a finding or
   recording a P2TL result, a reason before decrypting a meter number.
7. Data Lifetime: the raw identity export and the raw hourly AMR readings are deleted on their retention dates.

Synthetic data only; idempotent.
"""

from __future__ import annotations

from typing import Any, Optional

PII = "PII Pelanggan Listrik (demo)"
CEII = "Infrastruktur Kritis Grid (demo)"
INV = "Investigasi Susut Grid (demo)"
RAW = "ap2t_pelanggan_identitas"
PSEUDO = "pelanggan_identitas_pseudonim"
CH_AES = "Pseudonim nomor meter pelanggan (demo)"
CH_SHA = "Hash NIK pelanggan listrik (demo)"
LIC_ADMIN_AES = "Transform pseudonimisasi pelanggan — enkripsi (Admin, demo)"
LIC_ADMIN_SHA = "Transform pseudonimisasi pelanggan — hash NIK (Admin, demo)"
LIC_OP = "Tim P2TL — buka nomor meter (Operational, demo)"
REPO = "Pseudonimisasi pelanggan grid demo"
SCAN = "Data identitas pelanggan listrik (demo)"
COND_NAME = "Nama, alamat, telepon pelanggan (kolom, demo)"
# identity columns: "nama" alone also names substations, feeders and equipment, so only the PII export's own columns count
COND_REGEX = r"(?i)^(alamat|telepon|no_hp|nik|latitude_persil|longitude_persil)$"
IDENTITY_FILES = ("ap2t_pelanggan_identitas.parquet",)
ACT_MARK = "Tandai PII pelanggan listrik (demo)"
ACT_ISSUE = "Isu data identitas pelanggan listrik (demo)"
CP_EXPORT = "Ekspor data grid (demo)"
CP_DECIDE = "Keputusan susut & P2TL (demo)"
CP_DECRYPT = "Buka nomor meter pelanggan (demo)"
DL_RAW = "Retensi identitas pelanggan mentah (demo)"
DL_AMR = "Retensi beban per jam AMR mentah (demo)"
DECISION_ACTIONS = ["Jadikan target P2TL (demo)", "Eskalasi temuan bernilai besar (demo)", "Catat hasil P2TL (demo)"]
PURPOSES = ["Operasi P2TL / pemeriksaan lapangan", "Perencanaan teknis (susut teknis, perbaikan jaringan)", "Permintaan manajemen UP3 / UID",
            "Permintaan aparat penegak hukum (surat resmi)", "Analisis internal data agregat"]
EXPORT_PURPOSES = [*PURPOSES, "Pengujian / pembangunan ulang demo (test)"]

TRANSFORM = '''from transforms.api import transform, Input, Output
from bellaso_python_lib.encryption.encrypter_input import EncrypterInput
from bellaso_python_lib.encryption.hasher_input import HasherInput


@transform.using(
    identitas=Input("{base}/raw/{raw}", stop_propagating=["{pii}"]),
    pseudonim=Output("{base}/governance/{pseudo}"),
    enkripsi=EncrypterInput("{aes}"),
    hash_nik=HasherInput("{sha}"),
)
def pseudonimisasi(identitas, pseudonim, enkripsi, hash_nik):
    """Identitas pelanggan → pseudonim. Nomor meter dienkripsi deterministik (AES-256-SIV: meter yang sama selalu jadi
    pseudonim yang sama), NIK di-hash dengan pepper (SHA-256), nama, telepon dan alamat jalan dibuang, koordinat persil
    hanya disisakan sebagai kecamatan. Penanda PII tidak diturunkan (stop_propagating) — hanya administrator yang boleh
    membangun transform ini."""
    df = identitas.pandas()
    out = df[["id_pelanggan"]].copy()
    out["no_meter_pseudonim"] = enkripsi.encrypt_column(df["no_meter"].astype(str))
    out["nik_hash"] = hash_nik.hash_column(df["nik"].fillna("").astype(str))
    out["kecamatan"] = df["alamat"].str.extract(r"Kec\\. ([^,]+)")[0]
    out["punya_telepon"] = df["telepon"].fillna("").str.len().gt(0)
    pseudonim.write_pandas(out)
'''


def _marking(name: str, description: str, color: str, uid: Optional[str]) -> dict:
    import auth

    m = next((x for x in auth._markings() if x["name"] == name), None)
    return m or auth.create_marking(auth.MarkingIn(name=name, description=description, color=color, managers=[uid] if uid else []))


def build(state: dict, save) -> dict:
    import re
    from datetime import datetime, timezone

    import auth
    import checkpoints as cpk
    import cipher
    import code_repos
    import data_lifetime as dl
    import drive
    import ontology
    import ontology_security as osec
    import sds

    import demo_grid_data as gd
    import demo_grid_e2e as e
    import demo_jkn_governance as jg

    out: dict[str, Any] = {}
    me = auth.current() or {}
    uid = me.get("id")
    user = auth._user(uid) if uid and uid != "local" else {}
    org = (user or {}).get("organization_id")
    project = e._folder(None, e.PROJECT, "project")
    raw_folder = e._folder(project, "raw")
    gov = e._folder(project, "governance")

    # 1 · the raw identity export (PII), and the markings
    rows = gd.generate()[RAW]
    raw_id = e._put(raw_folder, RAW, rows, replace=False)
    pii = _marking(PII, "Identitas pelanggan listrik: nama, NIK, alamat, telepon, nomor meter, koordinat persil. Hanya petugas berwenang.", "#dc2626", uid)
    ceii = _marking(CEII, "Infrastruktur ketenagalistrikan kritis: model jaringan SCADA, titik kontrol (CMD/SETPOINT), proteksi dan kanal komunikasi. "
                          "Hanya tim operasi jaringan.", "#7c2d12", uid)
    inv = _marking(INV, "Berkas investigasi susut: bukti dan catatan temuan sebelum P2TL mengonfirmasi — dugaan, bukan putusan.", "#ea580c", uid)
    state["gov_markings"] = {"pii": pii["id"], "ceii": ceii["id"], "inv": inv["id"]}
    # whoever creates a marking holds it: the request's principal was formed before, so take it again
    if uid and uid != "local":
        p = auth.principal_of(uid)
        if p:
            auth._principal.set({**(auth.current() or {}), **p})

    # 2 · Cipher channels and licenses in governance/
    aes = jg._channel(CH_AES, gov, "AES_SIV", "Pseudonim deterministik nomor meter: meter yang sama → pseudonim yang sama (bisa digabung).")
    sha = jg._channel(CH_SHA, gov, "SHA256", "Hash NIK pelanggan dengan pepper rahasia: bisa dicocokkan, tidak bisa dibalik.")
    l_aes = jg._license(aes, LIC_ADMIN_AES, "admin", ["encrypt"], description="Untuk transform pseudonimisasi pelanggan.")
    l_sha = jg._license(sha, LIC_ADMIN_SHA, "admin", ["encrypt"], description="Untuk transform pseudonimisasi pelanggan (hash NIK).")
    l_op = jg._license(aes, LIC_OP, "operational", ["decrypt"], rate_limit={"count": 30, "minutes": 60},
                       description="Membuka satu nomor meter untuk kunjungan P2TL — dengan alasan (checkpoint), maks 30 per jam, setiap nilai diaudit.")
    try:
        if pii["id"] not in auth._item_row(l_op["item_id"])[0]:
            auth.set_item_markings(l_op["item_id"], auth.ItemMarkingsIn(markings=[pii["id"]]))
    except Exception as ex:  # noqa: BLE001
        out["license_marking_error"] = str(getattr(ex, "detail", ex))
    state["gov_cipher"] = {"aes": aes["id"], "sha": sha["id"], "op_license": l_op["id"]}
    save()

    # 3 · Sensitive Data Scanner on raw/
    want = sds.ConditionIn(name=COND_NAME, kind="regex", column_regex=COND_REGEX, logic="column", description="Kolom alamat, telepon, NIK dan koordinat persil pelanggan.")
    cond = next((c for c in sds._conditions() if c["name"] == COND_NAME), None)
    if not cond:
        cond = sds.create_condition(want)
    elif cond.get("column_regex") != COND_REGEX:
        cond = sds.update_condition(cond["id"], want)
    a_mark = next((a for a in sds._actions() if a["name"] == ACT_MARK), None) or sds.create_action(sds.ActionIn(name=ACT_MARK, kind="apply_markings", markings=[pii["id"]]))
    a_issue = next((a for a in sds._actions() if a["name"] == ACT_ISSUE), None) or sds.create_action(sds.ActionIn(
        name=ACT_ISSUE, kind="create_issues", severity="high", label="data-pribadi",
        issue_text="Pemindai menemukan {condition} pada kolom {column} di {dataset}: hanya pemegang penanda PII yang boleh membuka; analisis memakai dataset pseudonim."))
    scan = next((s for s in sds._scans() if s["name"] == SCAN), None)
    if not scan:
        scan = sds.create_scan(sds.ScanIn(name=SCAN, description="Identitas pelanggan listrik (NIK, nama, alamat, telepon) pada data mentah demo grid.",
                                          include=[raw_folder], strategy="all", schedule="daily", initial_scan=False, conditions=["builtin-nik", cond["id"]],
                                          actions=[a_mark["id"], a_issue["id"]]))
    # an earlier, too broad condition marked files that only name assets: they carry no identity
    for f in drive.list_files(raw_folder):
        if f.get("trashed_at") or f["name"] in IDENTITY_FILES:
            continue
        own = set(auth._item_row(f["id"])[0])
        if pii["id"] in own:
            auth.set_item_markings(f["id"], auth.ItemMarkingsIn(markings=sorted(own - {pii["id"]})))
            out.setdefault("pii_unmarked", []).append(f["name"])
    res = sds.run_scan(scan["id"], trigger="initial")
    out["scan"] = {"id": scan["id"], "matched": [r.get("name") for r in (res.get("results") if isinstance(res, dict) else None) or [] if r.get("matches")]}
    if pii["id"] not in auth.effective_markings(raw_id):
        auth.set_item_markings(raw_id, auth.ItemMarkingsIn(markings=sorted(set(auth._item_row(raw_id)[0]) | {pii["id"]})))

    # 4 · critical infrastructure: NUSAGRID's model and point list
    marked = []
    for f in drive.list_files(raw_folder):
        if f["name"] in ("scada_peralatan_nusagrid.parquet", "scada_titik_ukur_nusagrid.parquet") and not f.get("trashed_at"):
            if ceii["id"] not in auth.effective_markings(f["id"]):
                auth.set_item_markings(f["id"], auth.ItemMarkingsIn(markings=sorted(set(auth._item_row(f["id"])[0]) | {ceii["id"]})))
                marked.append(f["name"])
    out["ceii_marked"] = marked

    # 5 · the pseudonymisation transform (Cipher, stop_propagating PII)
    src = TRANSFORM.format(base=f"/{e.PROJECT}", raw=RAW, pseudo=PSEUDO, pii=pii["id"], aes=l_aes["rid"], sha=l_sha["rid"])
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="python", description="Demo: pseudonimisasi identitas pelanggan listrik dengan Cipher."))
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    files = dict(b["files"])
    main = next((p for p in sorted(files) if p.endswith(".py") and "/src/" in p and not p.endswith("__init__.py") and "test" not in p), None)
    folder = main.rsplit("/", 1)[0] if main else "transforms-python/src/myproject/datasets"
    path = f"{folder}/pseudonimisasi.py"
    status = "kept"
    if files.get(path) != src:
        files[path] = src
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="Pseudonimisasi identitas pelanggan: Cipher AES-SIV + SHA-256, stop_propagating PII"))
        state.pop("gov_pseudo_built", None)
    if not state.get("gov_pseudo_built"):
        rec = code_repos._repo(repo["id"])
        b = code_repos._branch(rec, None)
        try:
            built = code_repos.build_transform(rec, b["files"], b["name"], f"{path}::pseudonimisasi", "demo", b.get("head"))
            status = built["status"]
            if status != "succeeded":
                out["transform_error"] = (built.get("error") or "")[-800:]
        except Exception as ex:  # noqa: BLE001
            status, out["transform_error"] = "failed", str(ex)[:800]
        if status != "succeeded":
            enc = cipher.run(cipher._find(l_aes["rid"]), "encrypt", [r["no_meter"] for r in rows])
            hsh = cipher.run(cipher._find(l_sha["rid"]), "encrypt", [r["nik"] or "" for r in rows])
            pseudo_rows = [{"id_pelanggan": r["id_pelanggan"], "no_meter_pseudonim": enc[i], "nik_hash": hsh[i],
                            "kecamatan": (re.search(r"Kec\. ([^,]+)", r["alamat"]) or [None, None])[1], "punya_telepon": bool(r["telepon"])}
                           for i, r in enumerate(rows)]
            e._put(gov, PSEUDO, pseudo_rows, replace=True)
            status = "written"
        state["gov_pseudo_built"] = status
        save()
    out["transform"] = {"repo": repo["id"], "status": status}
    pseudo_item = next((x for x in drive.list_files(gov) if x["name"] == f"{PSEUDO}.parquet" and not x.get("trashed_at")), None)

    # 6 · property policies
    def secure(key: str, policy: str, props: list[str], marking: str) -> Optional[str]:
        t = e._type(key)
        if not t:
            return None
        full = ontology._object_type(t["id"])
        have = {p["api_name"] for p in full.get("properties") or []}
        props = [p for p in props if p in have and p != full["primary_key"]]
        sec = full.get("security") or {}
        if any(pp.get("name") == policy for pp in sec.get("property_policies") or []) or not props:
            return t["id"]
        pps = [pp for pp in sec.get("property_policies") or [] if not set(pp.get("properties") or []) & set(props)]
        osec.set_security(t["id"], osec.SecurityIn(object_policy=sec.get("object_policy") or {"granular": None, "markings": []},
                                                    property_policies=[*pps, {"name": policy, "properties": props, "granular": None, "markings": [marking]}]))
        return t["id"]

    state["gov_policies"] = {
        "pelanggan": secure("pelanggan", "Lokasi persil (PII)", ["lokasi", "latitude", "longitude"], pii["id"]),
        "temuan": secure("temuan", "Bukti & catatan investigasi", ["bukti", "catatan_tindak_lanjut", "tim_p2tl", "tanggal_rencana"], inv["id"]),
    }

    # 7 · checkpoints
    cfgs = {c["name"]: c for c in cpk._configs()}
    made = []

    def checkpoint(name: str, **kw: Any) -> None:
        if name in cfgs:
            return
        try:
            cpk.create_config(cpk.ConfigIn(name=name, **kw))
            made.append(name)
        except Exception as ex:  # noqa: BLE001
            out.setdefault("checkpoint_errors", {})[name] = str(getattr(ex, "detail", ex))

    checkpoint(CP_EXPORT, description="Setiap unduhan data dari Project demo grid dicatat dengan tujuannya.", types=["dataset_export", "compass_export", "contour_export"],
               scope=cpk.Scope(kind="project", id=project), title="Untuk apa data jaringan ini diunduh?",
               prompt="Data grid memuat infrastruktur kritis dan data pelanggan. Pilih tujuan pengunduhan; tujuan dicatat di log audit.",
               justification=cpk.Justification(kind="dropdown", options=EXPORT_PURPOSES, free_text="optional", recent=True))
    if org:
        acts = [a["id"] for a in (e._action(n) for n in DECISION_ACTIONS) if a]
        if acts:
            checkpoint(CP_DECIDE, description="Penetapan target P2TL, eskalasi temuan bernilai besar dan pencatatan hasil P2TL disertai dasar keputusan.",
                       types=["submit_action"], scope=cpk.Scope(kind="organization", id=org), conditions=[cpk.Condition(kind="action_type", ids=acts)],
                       title="Dasar keputusan", prompt="Keputusan ini menyasar pelanggan dan tercatat permanen. Tuliskan dasarnya (min. 15 karakter), mis. nomor surat tugas / berita acara.",
                       justification=cpk.Justification(kind="response", validation=r"^[\s\S]{15,}$"))
        checkpoint(CP_DECRYPT, description="Membuka pseudonim menjadi nomor meter pelanggan.", types=["cipher_decrypt"], scope=cpk.Scope(kind="organization", id=org),
                   title="Mengapa nomor meter perlu dibuka?", prompt="Hanya untuk kunjungan P2TL yang sah. Tuliskan nomor surat tugas atau alasannya.",
                   justification=cpk.Justification(kind="response", validation=r"^[\s\S]{10,}$"))
    else:
        out["checkpoint_note"] = "the user has no organization: organisation-wide checkpoints were not created"
    out["checkpoints_made"] = made

    # 8 · Data Lifetime
    pols = {p["name"]: p for p in dl._policies()}

    def lifetime(name: str, deletion: str, description: str, dataset_id: Optional[str]) -> None:
        p = pols.get(name) or dl.create_policy(dl.PolicyIn(name=name, description=description, type="fixed", deletion_date=deletion))
        if dataset_id and dl._apps().get(dataset_id, {}).get("policy") != p["id"]:
            try:
                dl.apply_policy(p["id"], dl.ApplyIn(dataset_id=dataset_id))
            except Exception as ex:  # noqa: BLE001
                out.setdefault("lifetime_errors", {})[name] = str(getattr(ex, "detail", ex))

    lifetime(DL_RAW, "2028-12-31", "Ekspor identitas pelanggan mentah dihapus setelah masa pemeriksaan; analisis memakai dataset pseudonim.", raw_id)
    amr = next((x["id"] for x in drive.list_files(e._folder(raw_folder, "iot")) if x["name"] == "amr_daya_tm_per_jam.parquet" and not x.get("trashed_at")), None)
    lifetime(DL_AMR, "2031-12-31", "Beban per jam AMR mentah disimpan 5 tahun; ringkasan harian tetap.", amr)
    state["gov_items"] = {"raw": raw_id, "pseudo": pseudo_item["id"] if pseudo_item else None, "scan": scan["id"], "repo": repo["id"], "folder": gov,
                          "built_at": datetime.now(timezone.utc).isoformat()}
    save()
    out["items"] = state["gov_items"]
    return out
