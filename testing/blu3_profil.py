"""The data profile of the AI Agent Swarm's Nexus types: "cart" (the synthetic CART copy of Data Sampel BPJS, the baseline) or
"v3" (the Blu 3.0 package of testing/blu3_data.py: synthetic FKRTL claims scored by architecture v3). The user, 2026-11-12:
"source data AI agent swarm pake synthetic data dulu aja, nanti kalau saya run terus hasilnya bagus, saya bisa coba ganti ke
data bpjs asli" — so the source is one switch, and the real data later is a third profile through the same pipeline.

Only the claim-level types change (Klaim Berisiko, Skor Risiko Klaim ML, Risiko Faskes ML, Peserta Klaim Berisiko): the
facility profiles, provinces, regencies and peer tables are the same synthetic universe (the same facility ids). Each v3
dataset is stored as a new Files item beside the original and the type is pointed at it (ontology_datasources.put_datasource,
which re-indexes); the original dataset ids are kept in testing/blu3/profil.json, and `kembalikan` points the types back.

Run in-process as the data's owner, from PowerShell (Bash hangs on `import server`):
    .venv\\Scripts\\python.exe testing\\blu3_profil.py status | pasang | kembalikan"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = HERE / "blu3" / "profil.json"
SKEMA = json.loads((HERE / "blu3" / "skema_cart.json").read_text("utf-8"))
OWNER = "u-075eb58af4"  # the data's owner (api/bpjs_sampel/nexus.py)
DATASETS = {"Klaim Berisiko (BPJS)": "klaim_berisiko.parquet", "Skor Risiko Klaim ML (BPJS)": "skor_risiko_klaim_ml.parquet",
            "Risiko Faskes ML (BPJS)": "risiko_faskes_ml.parquet", "Peserta Klaim Berisiko (BPJS)": "peserta_klaim_berisiko.parquet"}


def _init() -> None:
    os.chdir(ROOT / "api")
    sys.path.insert(0, str(ROOT / "api"))
    import auth
    import db
    import server

    db.init(server._env("BLUESANDAI_DATABASE_URL"))
    server._init_storage()
    auth._principal.set(auth.principal_of(OWNER))


def _state() -> dict:
    return json.loads(STATE.read_text("utf-8")) if STATE.exists() else {"aktif": "cart", "cart": {k: v["dataset_id"] for k, v in SKEMA.items() if k in DATASETS}, "v3": {}}


def _point(type_name: str, dataset_id: str) -> dict:
    import ontology_datasources as ods

    t = SKEMA[type_name]
    return ods.put_datasource(t["id"], ods.DatasourceIn(dataset_id=dataset_id, columns=t.get("kolom"), map_unmapped=True))


def pasang() -> dict:
    """The v3 package behind the four types (stored anew each time, so a rebuilt package is what the swarm reads)."""
    import db
    import drive

    st = _state()
    out = {}
    for name, fname in DATASETS.items():
        src = HERE / "blu3" / "out" / fname
        orig = db.drive_get(st["cart"][name])
        data = src.read_bytes()
        item = drive._store(orig.get("parent_id"), fname.replace(".parquet", "_v3.parquet"), io.BytesIO(data), len(data), "application/vnd.apache.parquet")
        st["v3"][name] = item["id"]
        r = _point(name, item["id"])
        out[name] = {"dataset": item["id"], "objek": (r or {}).get("count") or (r or {}).get("objects") or (r or {}).get("indexed")}
        print(f"  {name}: v3 dataset {item['id']} ({len(data) / 1e6:.1f} MB)", out[name], flush=True)
    st["aktif"] = "v3"
    STATE.write_text(json.dumps(st, indent=1, ensure_ascii=False), "utf-8")
    return out


def kembalikan() -> dict:
    st = _state()
    out = {}
    for name in DATASETS:
        r = _point(name, st["cart"][name])
        out[name] = st["cart"][name]
        print(f"  {name}: back to {st['cart'][name]}", (r or {}).get("count") or "", flush=True)
    st["aktif"] = "cart"
    STATE.write_text(json.dumps(st, indent=1, ensure_ascii=False), "utf-8")
    return out


def status() -> dict:
    import ontology

    st = _state()
    types = {x["display_name"]: x for x in ontology._all("object-types")}
    now = {name: ((types.get(name) or {}).get("backing_dataset") or {}).get("dataset_id") for name in DATASETS}
    aktif = "v3" if all(now[n] == st["v3"].get(n) for n in DATASETS) else "cart" if all(now[n] == st["cart"][n] for n in DATASETS) else "campuran"
    print(json.dumps({"aktif": aktif, "dataset": now}, indent=1, ensure_ascii=False))
    return {"aktif": aktif, "dataset": now}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    _init()
    {"pasang": pasang, "kembalikan": kembalikan, "status": status}[cmd]()
    os._exit(0)
