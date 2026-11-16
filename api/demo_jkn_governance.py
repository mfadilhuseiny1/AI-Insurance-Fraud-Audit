"""Demo JKN: security and governance of the audit data, end to end, on the platform's own controls.

Claims carry the identity of BPJS Kesehatan members (NIK, card number, name, phone, date of birth). The demo shows how
that identity is protected from the moment it lands to the moment someone decides on it, each step done by an existing
application of the platform (Security & governance):

  1. a raw membership extract per SEP lands in raw/ (peserta_klaim_raw: NIK, BPJS card number, name, birth date, phone);
  2. Sensitive Data Scanner finds the NIK and BPJS numbers and names, applies the marking "PHI Peserta JKN (demo)" and
     opens issues — only holders of the marking can open the dataset from then on;
  3. a Python transform pseudonymises it with Cipher (AES-256-SIV: the same card always gives the same pseudonym, so
     analysts can still count and join; SHA-256 with a pepper for the NIK), drops the direct identifiers, and stops the
     PHI marking from propagating (stop_propagating — only an administrator may build such a transform), so analysts
     work on governance/peserta_klaim_pseudonim without seeing who anyone is;
  4. an Operational Cipher license lets marked staff decrypt a single pseudonym in the applications, behind a checkpoint
     and a rate limit — every value decrypted is audited;
  5. object and property security policies hide what only investigators should see: the audit plan of a facility, the
     anomaly reasons of a doctor (marking "Investigasi Fraud JKN (demo)"), and the member identity on claims (PHI);
  6. Checkpoints ask for a purpose before exporting the Project's data or the audit queue, before deciding on a
     facility (escalation, closing an audit) or an IoT finding, and before decrypting an identity;
  7. Data Lifetime deletes the raw identity extract and the raw meter readings on their retention dates (lineage-aware);
  8. audit.3 records every load, export, decision, justification and decryption — the Governance Center reads it all.

Synthetic data only; idempotent (what exists is kept). Mounted by server.py under /api/demo/jkn/governance.
"""

from __future__ import annotations

import random
import re
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import APIRouter

router = APIRouter(prefix="/api/demo/jkn/governance")

PROJECT = "JKN Healthcare System Intelligence"
PHI = "PHI Peserta JKN (demo)"
INV = "Investigasi Fraud JKN (demo)"
RAW = "peserta_klaim_raw"
PSEUDO = "peserta_klaim_pseudonim"
CH_AES = "Pseudonim peserta JKN (demo)"
CH_SHA = "Hash NIK peserta JKN (demo)"
LIC_ADMIN_AES = "Transform pseudonimisasi — enkripsi (Admin, demo)"
LIC_ADMIN_SHA = "Transform pseudonimisasi — hash NIK (Admin, demo)"
LIC_DM = "Pipeline & Contour — enkripsi kolom (Data Manager, demo)"
LIC_OP = "Investigator — buka identitas peserta (Operational, demo)"
REPO = "Pseudonimisasi peserta JKN demo"
SCAN = "Data identitas peserta JKN (demo)"
COND_NAME = "Nama peserta JKN (kolom, demo)"
ACT_MARK = "Tandai PHI peserta JKN (demo)"
ACT_ISSUE = "Isu data identitas peserta JKN (demo)"
CP_EXPORT = "Ekspor data audit JKN (demo)"
CP_QUEUE = "Ekspor antrean audit JKN (demo)"
CP_DECIDE = "Keputusan audit JKN (demo)"
CP_DECRYPT = "Buka identitas peserta JKN (demo)"
DL_RAW = "Retensi identitas peserta mentah (demo)"
DL_IOT = "Retensi bacaan meter IoT mentah (demo)"
DECISION_ACTIONS = ["Eskalasi ke tim investigasi (demo)", "Tutup audit dan catat pengembalian (demo)", "Verifikasi temuan IoT (demo)"]
PURPOSES = ["Audit lapangan / klarifikasi ke faskes", "Permintaan Kantor Pusat atau Kedeputian Wilayah", "Permintaan aparat penegak hukum (surat resmi)",
            "Analisis internal data agregat"]
# downloads only: copies made to rebuild or test the demo (the decision checkpoints keep the four purposes above)
EXPORT_PURPOSES = [*PURPOSES, "Pengujian / pembangunan ulang demo (test)"]

FIRST = ["Siti", "Budi", "Dewi", "Agus", "Rina", "Joko", "Ani", "Hendra", "Maya", "Rudi", "Lestari", "Bambang", "Wulan", "Eko", "Fitri", "Andi", "Nur",
         "Yanti", "Teguh", "Sri", "Dian", "Bayu", "Ratna", "Imam", "Putri"]
LAST = ["Santoso", "Wijaya", "Lestari", "Pratama", "Hidayat", "Saputra", "Kusuma", "Rahayu", "Nugroho", "Utami", "Siregar", "Harahap", "Wibowo",
        "Susanto", "Purnomo", "Halim", "Gunawan", "Setiawan"]


# ------------------------------------------------------------------------------------------------
# the raw identity extract
# ------------------------------------------------------------------------------------------------


def generate(claims: list[dict], faskes: list[dict], seed: int = 2026) -> list[dict]:
    """One row per SEP: the member behind it (NIK, BPJS card, name, sex, birth date, phone, regency). Members come back
    (about two SEPs each); the NIK follows its format (region, birth date with +40 for women, sequence)."""
    rnd = random.Random(seed)
    where = {f["kode"]: (f.get("wilayah") or "") for f in faskes}
    members: dict[str, list[dict]] = {}
    out = []
    for c in sorted(claims, key=lambda c: c["no_sep"]):
        fk = c.get("kode_faskes") or ""
        pool = members.setdefault(fk, [])
        if pool and rnd.random() < 0.5:
            m = rnd.choice(pool)
        else:
            sex = rnd.choice("LP")
            born = date(1950, 1, 1) + timedelta(days=rnd.randint(0, 26000))
            region = f"{rnd.randint(11, 94):02d}{rnd.randint(1, 30):02d}{rnd.randint(1, 30):02d}"
            dd = born.day + (40 if sex == "P" else 0)
            m = {"nik": f"{region}{dd:02d}{born.month:02d}{born.year % 100:02d}{rnd.randint(1, 9999):04d}",
                 "no_kartu": f"000{rnd.randint(10**9, 10**10 - 1)}", "nama_peserta": f"{rnd.choice(FIRST)} {rnd.choice(LAST)}",
                 "jenis_kelamin": sex, "tgl_lahir": born.isoformat(), "no_hp": f"08{rnd.randint(11, 99)}{rnd.randint(10**7, 10**8 - 1)}"}
            pool.append(m)
        out.append({"no_sep": c["no_sep"], "tgl_layanan": c.get("tgl_layanan"), "kode_faskes": fk, "kabupaten": where.get(fk, ""), **m})
    return out


TRANSFORM = '''import pandas as pd
from transforms.api import transform, Input, Output
from bellaso_python_lib.encryption.encrypter_input import EncrypterInput
from bellaso_python_lib.encryption.hasher_input import HasherInput


@transform.using(
    peserta=Input("{base}/raw/{raw}", stop_propagating=["{phi}"]),
    pseudonim=Output("{base}/governance/{pseudo}"),
    enkripsi=EncrypterInput("{aes}"),
    hash_nik=HasherInput("{sha}"),
)
def pseudonimisasi(peserta, pseudonim, enkripsi, hash_nik):
    """Identitas peserta → pseudonim. Nomor kartu dienkripsi deterministik (AES-256-SIV: kartu yang sama selalu jadi
    pseudonim yang sama, jadi analis tetap bisa menghitung dan menggabungkan), NIK di-hash dengan pepper (SHA-256),
    nama, nomor HP dan tanggal lahir dibuang; umur dijadikan kelompok. Penanda PHI tidak diturunkan ke keluaran
    (stop_propagating) — hanya administrator yang boleh membangun transform ini."""
    df = peserta.pandas()
    out = df[["no_sep", "tgl_layanan", "kode_faskes", "kabupaten", "jenis_kelamin"]].copy()
    out["id_peserta_pseudonim"] = enkripsi.encrypt_column(df["no_kartu"].astype(str))
    out["nik_hash"] = hash_nik.hash_column(df["nik"].astype(str))
    umur = (pd.to_datetime(df["tgl_layanan"]) - pd.to_datetime(df["tgl_lahir"])).dt.days // 365
    out["kelompok_umur"] = pd.cut(umur, [-1, 17, 39, 59, 200], labels=["0-17", "18-39", "40-59", "60+"]).astype(str)
    pseudonim.write_pandas(out)
'''


# ------------------------------------------------------------------------------------------------
# build
# ------------------------------------------------------------------------------------------------


def _marking(name: str, description: str, color: str, uid: Optional[str]) -> dict:
    import auth

    m = next((x for x in auth._markings() if x["name"] == name), None)
    if not m:
        m = auth.create_marking(auth.MarkingIn(name=name, description=description, color=color, managers=[uid] if uid else []))
    return m


def _channel(name: str, folder: str, algorithm: str, description: str) -> dict:
    import cipher

    c = next((x for x in cipher._channels() if x["name"] == name), None)
    return c or cipher.create_channel(cipher.ChannelIn(name=name, folder_id=folder, algorithm=algorithm, description=description))


def _license(channel: dict, name: str, kind: str, ops: list[str], **kw: Any) -> dict:
    import cipher

    r = next((x for x in cipher._all() if x["name"] == name and x.get("channel_id") == channel["id"]), None)
    if r:
        return cipher._public(r)
    return cipher.issue_license(channel["id"], cipher.LicenseIssue(name=name, kind=kind, operations=ops, **kw))


def build(state: dict, save) -> dict:
    import auth
    import checkpoints as cpk
    import cipher
    import code_repos
    import data_lifetime as dl
    import demo_jkn_e2e as e
    import demo_jkn_map as jm
    import demo_jkn_pipeline as dp
    import demo_jkn_workbench as wb
    import drive
    import ontology
    import ontology_security as osec
    import sds

    out: dict = {}
    me = auth.current() or {}
    uid = me.get("id")
    user = auth._user(uid) if uid and uid != "local" else {}
    org = (user or {}).get("organization_id")
    project = e._folder(None, PROJECT, "project")
    raw_folder = e._folder(project, "raw")
    gov = e._folder(project, "governance")

    # 1 · the raw identity extract
    claims = wb._clean_file("clean", "klaim_sep_bersih")
    faskes = wb._clean_file("clean", "faskes_audit")
    rows = generate(claims, faskes)
    raw_id = e._put(raw_folder, RAW, e._arrow(rows, dp.schema_of(rows)), replace=False)
    out["raw"] = {"rows": len(rows), "members": len({r["no_kartu"] for r in rows})}

    # 2 · markings (the creator holds them; access requests go to the user through Approvals)
    phi = _marking(PHI, "Identitas peserta JKN: NIK, nomor kartu BPJS, nama, tanggal lahir, nomor HP. Hanya petugas yang berwenang.", "#dc2626", uid)
    inv = _marking(INV, "Berkas investigasi kecurangan JKN: rencana audit, alasan anomali, keputusan sebelum final.", "#ea580c", uid)
    state["gov_markings"] = {"phi": phi["id"], "inv": inv["id"]}

    # 3 · Cipher: channels and licenses in governance/
    aes = _channel(CH_AES, gov, "AES_SIV", "Pseudonim deterministik nomor kartu BPJS peserta: kartu yang sama → pseudonim yang sama (bisa dihitung & digabung).")
    sha = _channel(CH_SHA, gov, "SHA256", "Hash NIK peserta dengan pepper rahasia: bisa dicocokkan, tidak bisa dibalik.")
    l_aes = _license(aes, LIC_ADMIN_AES, "admin", ["encrypt"], description="Untuk transform pseudonimisasi (kunci diberikan ke transform).")
    l_sha = _license(sha, LIC_ADMIN_SHA, "admin", ["encrypt"], description="Untuk transform pseudonimisasi (hash NIK).")
    _license(aes, LIC_DM, "data_manager", ["encrypt"], description="Enkripsi kolom di Pipeline Builder dan Contour.")
    l_op = _license(aes, LIC_OP, "operational", ["decrypt"], rate_limit={"count": 20, "minutes": 60},
                    description="Membuka satu pseudonim di Object Explorer / Workshop — dengan alasan (checkpoint), maks 20 per jam, setiap nilai diaudit.")
    # the decrypting license itself needs the PHI marking to be seen (and so used)
    try:
        if phi["id"] not in auth._item_row(l_op["item_id"])[0]:
            auth.set_item_markings(l_op["item_id"], auth.ItemMarkingsIn(markings=[phi["id"]]))
    except Exception as ex:  # noqa: BLE001
        out["license_marking_error"] = str(getattr(ex, "detail", ex))
    state["gov_cipher"] = {"aes": aes["id"], "sha": sha["id"], "op_license": l_op["id"]}
    save()

    # 4 · Sensitive Data Scanner: find identity in raw/, mark it PHI, open issues
    cond = next((c for c in sds._conditions() if c["name"] == COND_NAME), None) or sds.create_condition(sds.ConditionIn(
        name=COND_NAME, kind="regex", column_regex=r"(?i)^nama_(peserta|pasien)$", logic="column", description="Kolom nama peserta / pasien."))
    a_mark = next((a for a in sds._actions() if a["name"] == ACT_MARK), None) or sds.create_action(sds.ActionIn(name=ACT_MARK, kind="apply_markings", markings=[phi["id"]]))
    a_issue = next((a for a in sds._actions() if a["name"] == ACT_ISSUE), None) or sds.create_action(sds.ActionIn(
        name=ACT_ISSUE, kind="create_issues", severity="high", label="data-pribadi",
        issue_text="Pemindai menemukan {condition} pada kolom {column} di {dataset}: pastikan hanya pemegang penanda PHI yang dapat membuka, dan pakai dataset pseudonim untuk analisis."))
    scan = next((s for s in sds._scans() if s["name"] == SCAN), None)
    if not scan:
        scan = sds.create_scan(sds.ScanIn(name=SCAN, description="Identitas peserta (NIK, kartu BPJS, nama) pada data mentah demo JKN.", include=[raw_folder],
                                          strategy="all", schedule="daily", initial_scan=False, conditions=["builtin-nik", "builtin-bpjs", cond["id"]],
                                          actions=[a_mark["id"], a_issue["id"]]))
    res = sds.run_scan(scan["id"], trigger="initial")
    out["scan"] = {"id": scan["id"], "matched": [r.get("name") for r in (res.get("results") if isinstance(res, dict) else None) or [] if r.get("matches")]}
    if phi["id"] not in auth.effective_markings(raw_id):  # the scanner's action did not land: apply it the same way
        auth.set_item_markings(raw_id, auth.ItemMarkingsIn(markings=sorted(set(auth._item_row(raw_id)[0]) | {phi["id"]})))

    # 5 · the pseudonymisation transform (Cipher in Python, stop_propagating PHI)
    files_src = TRANSFORM.format(base=f"/{PROJECT}", raw=RAW, pseudo=PSEUDO, phi=phi["id"], aes=l_aes["rid"], sha=l_sha["rid"])
    repo = next((r for r in code_repos.list_repos() if r["name"] == REPO), None)
    if not repo:
        repo = code_repos.create_repo(code_repos.RepoIn(name=REPO, template="python", description="Demo: pseudonimisasi identitas peserta JKN dengan Cipher."))
    rec = code_repos._repo(repo["id"])
    b = code_repos._branch(rec, None)
    files = dict(b["files"])
    main = next((p for p in sorted(files) if p.endswith(".py") and "/src/" in p and not p.endswith("__init__.py") and "test" not in p), None)
    folder = main.rsplit("/", 1)[0] if main else "transforms-python/src/myproject/datasets"
    path = f"{folder}/pseudonimisasi.py"
    built_status = "kept"
    if files.get(path) != files_src:
        files[path] = files_src
        code_repos.save_files(repo["id"], code_repos.FilesPut(files=files))
        code_repos.commit(repo["id"], code_repos.CommitIn(message="Pseudonimisasi identitas peserta: Cipher AES-SIV + SHA-256, stop_propagating PHI"))
        state.pop("gov_pseudo_built", None)
    if not state.get("gov_pseudo_built"):
        rec = code_repos._repo(repo["id"])
        b = code_repos._branch(rec, None)
        try:
            built = code_repos.build_transform(rec, b["files"], b["name"], f"{path}::pseudonimisasi", "demo", b.get("head"))
            built_status = built["status"]
            if built["status"] != "succeeded":
                out["transform_error"] = (built.get("error") or "")[-800:]
        except Exception as ex:  # noqa: BLE001
            built_status, out["transform_error"] = "failed", str(ex)[:800]
        if built_status != "succeeded":
            # the same pseudonyms, written here (the transform's own build failed — see transform_error)
            enc = cipher.run(cipher._find(l_aes["rid"]), "encrypt", [r["no_kartu"] for r in rows])
            hsh = cipher.run(cipher._find(l_sha["rid"]), "encrypt", [r["nik"] for r in rows])

            def group(r: dict) -> str:
                age = (date.fromisoformat(r["tgl_layanan"]) - date.fromisoformat(r["tgl_lahir"])).days // 365
                return "0-17" if age <= 17 else "18-39" if age <= 39 else "40-59" if age <= 59 else "60+"

            pseudo_rows = [{"no_sep": r["no_sep"], "tgl_layanan": r["tgl_layanan"], "kode_faskes": r["kode_faskes"], "kabupaten": r["kabupaten"],
                            "jenis_kelamin": r["jenis_kelamin"], "id_peserta_pseudonim": enc[i], "nik_hash": hsh[i], "kelompok_umur": group(r)}
                           for i, r in enumerate(rows)]
            e._put(gov, PSEUDO, e._arrow(pseudo_rows, dp.schema_of(pseudo_rows)), replace=True)
            built_status = "written"
        state["gov_pseudo_built"] = built_status
        save()
    out["transform"] = {"repo": repo["id"], "status": built_status}
    pseudo_item = next((x for x in drive.list_files(gov) if x["name"] == f"{PSEUDO}.parquet" and not x.get("trashed_at")), None)

    # 6 · object and property security policies
    def secure(type_name: str, policy_name: str, props: list[str], marking: str) -> Optional[str]:
        t = jm._type(type_name)
        if not t:
            return None
        full = ontology._object_type(t["id"])
        have = {p["api_name"] for p in full.get("properties") or []}
        props = [p for p in props if p in have and p != full["primary_key"]]
        sec = full.get("security") or {}
        pps = [pp for pp in sec.get("property_policies") or [] if pp.get("name") != policy_name and not set(pp.get("properties") or []) & set(props)]
        if any(pp.get("name") == policy_name for pp in sec.get("property_policies") or []) or not props:
            return t["id"]
        osec.set_security(t["id"], osec.SecurityIn(object_policy=sec.get("object_policy") or {"granular": None, "markings": []},
                                                    property_policies=[*pps, {"name": policy_name, "properties": props, "granular": None, "markings": [marking]}]))
        return t["id"]

    policies = {
        "faskes": secure(jm.FASKES, "Rencana audit (Investigasi)", ["tim_audit", "tanggal_audit"], inv["id"]),
        "dokter": secure(jm.DOKTER, "Penjelasan anomali (Investigasi)", ["alasan_anomali", "status_klarifikasi"], inv["id"]),
        "klaim": secure("Klaim JKN (demo)", "Identitas peserta (PHI)", ["nama_peserta", "no_kartu", "resume"], phi["id"]),
    }
    state["gov_policies"] = policies

    # 7 · checkpoints
    cfgs = {c["name"]: c for c in cpk._configs()}
    made_cp = []

    def checkpoint(name: str, **kw: Any) -> None:
        if name in cfgs:
            # an existing checkpoint gains purposes added since (its other settings stay as configured)
            have, want = cfgs[name].get("justification") or {}, kw.get("justification")
            if want and have.get("kind") == "dropdown" and set(want.options) - set(have.get("options") or []):
                opts = list(have.get("options") or [])
                opts += [o for o in want.options if o not in opts]
                cpk.update_config(cfgs[name]["id"], cpk.ConfigIn(**{**{k: v for k, v in cfgs[name].items() if k in cpk.ConfigIn.model_fields},
                                                                    "justification": {**have, "options": opts}}))
                made_cp.append(f"{name}: purposes")
            return
        try:
            cpk.create_config(cpk.ConfigIn(name=name, **kw))
            made_cp.append(name)
        except Exception as ex:  # noqa: BLE001
            out.setdefault("checkpoint_errors", {})[name] = str(getattr(ex, "detail", ex))

    dropdown = cpk.Justification(kind="dropdown", options=PURPOSES, free_text="optional", recent=True)
    checkpoint(CP_EXPORT, description="Setiap unduhan data dari Project demo JKN dicatat dengan tujuannya.", types=["dataset_export", "compass_export", "contour_export"],
               scope=cpk.Scope(kind="project", id=project), title="Untuk apa data ini diunduh?",
               prompt="Data audit JKN memuat informasi faskes, dokter dan klaim yang **rahasia**. Pilih tujuan pengunduhan; tujuan dicatat di log audit.",
               justification=cpk.Justification(kind="dropdown", options=EXPORT_PURPOSES, free_text="optional", recent=True))
    if org:
        fk = jm._type(jm.FASKES)
        checkpoint(CP_QUEUE, description="Ekspor antrean audit (CSV) dari Ruang Kerja Audit.", types=["object_set_export"], scope=cpk.Scope(kind="organization", id=org),
                   conditions=[cpk.Condition(kind="object_type", ids=[fk["id"]])] if fk else [], title="Untuk apa antrean audit diekspor?",
                   prompt="Antrean audit berisi prioritas dan indikasi kecurangan faskes. Pilih tujuan ekspor.", justification=dropdown)
        acts = [a["id"] for a in (e._action(n) for n in DECISION_ACTIONS) if a]
        if acts:
            checkpoint(CP_DECIDE, description="Keputusan audit yang berdampak (eskalasi, menutup audit, verifikasi temuan IoT) disertai dasar keputusan.",
                       types=["submit_action"], scope=cpk.Scope(kind="organization", id=org), conditions=[cpk.Condition(kind="action_type", ids=acts)],
                       title="Dasar keputusan", prompt="Keputusan ini mengubah status faskes atau temuan dan tercatat permanen. Tuliskan dasarnya (minimal 15 karakter), mis. nomor berita acara.",
                       justification=cpk.Justification(kind="response", validation=r"^[\s\S]{15,}$"))
        checkpoint(CP_DECRYPT, description="Membuka pseudonim menjadi nomor kartu peserta.", types=["cipher_decrypt"], scope=cpk.Scope(kind="organization", id=org),
                   title="Mengapa identitas peserta perlu dibuka?", prompt="Membuka identitas peserta hanya untuk keperluan yang sah. Tuliskan nomor surat tugas atau alasannya.",
                   justification=cpk.Justification(kind="response", validation=r"^[\s\S]{10,}$"))
    else:
        out["checkpoint_note"] = "the user has no organization: organisation-wide checkpoints were not created"
    out["checkpoints_made"] = made_cp

    # 8 · Data Lifetime
    pols = {p["name"]: p for p in dl._policies()}

    def lifetime(name: str, deletion: str, description: str, dataset_id: Optional[str]) -> None:
        p = pols.get(name) or dl.create_policy(dl.PolicyIn(name=name, description=description, type="fixed", deletion_date=deletion))
        if dataset_id and dl._apps().get(dataset_id, {}).get("policy") != p["id"]:
            try:
                dl.apply_policy(p["id"], dl.ApplyIn(dataset_id=dataset_id))
            except Exception as ex:  # noqa: BLE001
                out.setdefault("lifetime_errors", {})[name] = str(getattr(ex, "detail", ex))

    lifetime(DL_RAW, "2028-12-31", "Ekstrak identitas mentah dihapus setelah masa pemeriksaan; analisis memakai dataset pseudonim.", raw_id)
    iot_raw = next((x["id"] for x in drive.list_files(e._folder(raw_folder, "iot")) if x["name"] == "daya_listrik_alat_iot.parquet" and not x.get("trashed_at")), None)
    lifetime(DL_IOT, "2031-12-31", "Bacaan meter 2 menit mentah disimpan 5 tahun; ringkasan harian tetap.", iot_raw)

    state["gov_items"] = {"raw": raw_id, "pseudo": pseudo_item["id"] if pseudo_item else None, "scan": scan["id"], "repo": repo["id"], "folder": gov}
    save()
    out["items"] = state["gov_items"]
    return out


# ------------------------------------------------------------------------------------------------
# the export of the audit queue is a checkpointed interaction (Object set export, Faskes Audit)
# ------------------------------------------------------------------------------------------------


def _queue_export_ctx(req, p, body):  # noqa: ANN001
    import checkpoints as cpk
    import demo_jkn_map as jm

    t = jm._type(jm.FASKES)
    return cpk._ctx([], object_types=[t["id"]] if t else [], detail="antrean audit faskes (CSV)")


def install_bindings() -> None:
    import checkpoints as cpk

    pat = re.compile(r"^/api/demo/jkn/workbench/export\.csv$")
    if not any(b[1].pattern == pat.pattern for b in cpk.BINDINGS):
        cpk.BINDINGS.append(({"GET"}, pat, "object_set_export", _queue_export_ctx))


install_bindings()


# ------------------------------------------------------------------------------------------------
# the overview the audit workspace shows
# ------------------------------------------------------------------------------------------------

PERSONAS = [
    ("analis", "Analis data", "Menyusun laporan & model dari data agregat", []),
    ("auditor", "Auditor investigasi", "Menindaklanjuti faskes dan dokter berisiko", ["inv"]),
    ("petugas", "Petugas data peserta", "Mengelola data kepesertaan", ["phi"]),
    ("inti", "Tim audit inti", "Memutuskan kasus dan membuka identitas bila sah", ["phi", "inv"]),
]


def _matrix(state: dict) -> dict:
    import auth
    import ontology
    import ontology_security as osec

    mk = state.get("gov_markings") or {}
    items = state.get("gov_items") or {}
    pol = state.get("gov_policies") or {}
    rows = []

    def ds(label: str, why: str, item_id: Optional[str], kind: str) -> None:
        need = auth.effective_markings(item_id) if item_id else set()
        rows.append({"label": label, "why": why, "kind": kind, "item_id": item_id,
                     "needs": [m["name"] for m in auth._marking_info().values() if m["id"] in need and m.get("kind") == "marking"],
                     "access": {pid: need <= {mk[k] for k in ks if k in mk} for pid, _, _, ks in PERSONAS}})

    ds("Data identitas peserta (mentah)", "NIK, nomor kartu, nama, tanggal lahir, HP — ditandai PHI oleh pemindai", items.get("raw"), "dataset")
    ds("Data peserta pseudonim", "Kartu dienkripsi, NIK di-hash, identitas langsung dibuang — penanda PHI tidak diturunkan", items.get("pseudo"), "dataset")

    def prop(label: str, why: str, type_id: Optional[str], props: list[str]) -> None:
        if not type_id:
            return
        t = ontology._object_type(type_id)
        pk = next(iter(ontology.stored_objects(type_id)), None)
        access = {}
        for pid, _, _, ks in PERSONAS:
            r = osec.test_security(type_id, osec.TestIn(user=osec.TestUser(id=f"persona-{pid}", markings=[mk[k] for k in ks if k in mk]), primary_key=pk))
            vis = {p["api_name"]: p["visible"] for p in r["properties"]}
            access[pid] = all(vis.get(p, True) for p in props)
        names = [next((x.get("display_name") or x["api_name"] for x in t["properties"] if x["api_name"] == p), p) for p in props]
        pp = next((pp for pp in (t.get("security") or {}).get("property_policies") or [] if set(pp["properties"]) & set(props)), None)
        rows.append({"label": label, "why": why, "kind": "property", "type_id": type_id, "properties": names,
                     "needs": [auth._marking_info().get(m, {}).get("name", m) for m in (pp or {}).get("markings") or []], "access": access})

    prop("Rencana audit faskes", "Tim dan tanggal audit — agar faskes tidak tahu lebih dulu", pol.get("faskes"), ["tim_audit", "tanggal_audit"])
    prop("Alasan anomali dokter", "Penjelasan model & klarifikasi — belum tentu fraud, tidak untuk umum", pol.get("dokter"), ["alasan_anomali"])
    prop("Identitas peserta pada klaim", "Nama & nomor kartu pada objek klaim", pol.get("klaim"), ["nama_peserta", "no_kartu"])
    lic = (state.get("gov_cipher") or {}).get("op_license")
    if lic:
        import cipher

        try:
            item = cipher._find(lic).get("item_id")
            need = auth.effective_markings(item)
        except Exception:  # noqa: BLE001
            item, need = None, set()
        rows.append({"label": "Membuka pseudonim → nomor kartu", "why": "Lisensi Cipher Operational: dengan alasan (checkpoint), maks 20 per jam, diaudit",
                     "kind": "cipher", "item_id": item, "needs": [m["name"] for m in auth._marking_info().values() if m["id"] in need and m.get("kind") == "marking"],
                     "access": {pid: need <= {mk[k] for k in ks if k in mk} for pid, _, _, ks in PERSONAS}, "checkpoint": True})
    return {"personas": [{"id": pid, "name": n, "role": d, "markings": [{"phi": PHI, "inv": INV}[k] for k in ks]} for pid, n, d, ks in PERSONAS], "rows": rows}


@router.get("")
def overview() -> dict:
    import auth
    import demo_jkn_e2e as e
    import drive
    import governance_center as gc

    auth.require_user()
    state = e.STATE
    project = e._folder(None, PROJECT, "project")
    base = gc.overview(project)
    items = state.get("gov_items") or {}
    ready = bool(items.get("raw"))
    raw = drive.list_files(e._folder(project, "raw"))
    sample = None
    if items.get("pseudo"):
        try:
            import demo_jkn_workbench as wb

            ps = wb._clean_file("governance", PSEUDO)
            rw = {r["no_sep"]: r for r in wb._clean_file("raw", RAW)} if auth.can_access(items.get("raw")) else {}
            sample = [{"no_sep": p["no_sep"], "pseudonim": p.get("id_peserta_pseudonim"), "nik_hash": p.get("nik_hash"), "kelompok_umur": p.get("kelompok_umur"),
                       "kabupaten": p.get("kabupaten"), "asli": ({"nama": rw[p["no_sep"]]["nama_peserta"], "no_kartu": rw[p["no_sep"]]["no_kartu"], "nik": rw[p["no_sep"]]["nik"]}
                                                            if p["no_sep"] in rw else None)} for p in ps[:4]]
        except Exception:  # noqa: BLE001
            sample = None
    return {**base, "ready": ready, "demo": {"items": items, "markings": state.get("gov_markings"), "cipher": state.get("gov_cipher"),
                                             "transform": state.get("gov_pseudo_built"), "raw_datasets": sum(1 for x in raw if x["name"].endswith(".parquet"))},
            "matrix": _matrix(state) if ready else None, "sample": sample}
