"""The ground-truth check of a Blu 3.0 engagement (synthetic data only: the fraud was planted, so we know where it is).

After an engagement on the v3 data profile, its tags (GET /api/aip/indikasi?run_id=…) and its quarantine box
(GET /api/aip/karantina?penugasan=…) are compared with testing/blu3/out/kebenaran.parquet, which no agent ever read:
- claims: of the claims the agents tagged, how many carry planted fraud (precision), and how many of the planted fraud
  claims they tagged (recall); the same for the machines (auto-tagger, v3) alone, so the agents' own contribution shows;
- facilities: of the facilities in the box (and at its top, groups A–C), how many have planted fraud;
- modes: an agent's mode tag against the planted scheme's Permenkes family.
The v3 scoring machine alone is the baseline. Aggregates only. Writes data/aip/ml/sistem_terbaru/blu3_evaluasi_<run>.json.

Usage: .venv/Scripts/python.exe testing/blu3_evaluasi.py [run_id]   (default: the newest Blu 3.0 engagement)"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
API = "http://localhost:8300"
OUT = ROOT / "data" / "aip" / "ml" / "sistem_terbaru"
# the machines (not agents) that can support a tag in the ledger (api/aip/indikasi.py agen_pendukung)
MESIN = {"penanda_otomatis", "skoring_v3", "konsensus_ml", "karantina", "deteksi_realtime", "telaah_klinis"}
# a planted scheme's Permenkes family (testing/arsitektur_v2.py FAMILI) and the ledger tags of each family (api/aip/blu3.py)
SKEMA_FAMILI = {"upcoding": "koding", "dx_sekunder": "koding", "prosedur_fiktif": "koding", "kode_tidak_sesuai": "koding",
                "topup_inflasi": "tagihan", "topup_fiktif": "tagihan", "kelas_naik": "tagihan",
                "los_bergeser": "episode", "kloning": "identitas", "kartu_dipinjam": "identitas", "klaim_ganda": "identitas",
                "cincin_kolusi": "jaringan", "cincin_bentuk_baru": "jaringan"}
TAG_FAMILI = {"UPCODING_KEPARAHAN": "koding", "TINDAKAN_TIDAK_DILAKUKAN": "koding", "TIDAK_SESUAI_INDIKASI": "koding", "MANIPULASI_PEMERIKSAAN": "koding",
              "TAGIHAN_MELEBIHI_TARIF": "tagihan", "KELAS_RAWAT": "tagihan", "OBAT_ALKES_FIKTIF": "tagihan", "PENGURANGAN_OBAT": "tagihan",
              "PEMECAHAN_EPISODE": "episode", "LOS_DIPERPANJANG": "episode", "READMISI": "episode",
              "KLONING_KLAIM": "identitas", "KLAIM_FIKTIF": "identitas", "KLAIM_GANDA": "identitas", "RUJUKAN_SEMU": "jaringan", "JARINGAN_FASKES": "jaringan"}


def _token() -> str:
    for line in (ROOT / ".env.local").read_text("utf-8").splitlines():
        m = re.match(r"\s*ADMIN_ACCESS_TOKEN\s*=\s*\"?([^\"\r\n]+)\"?", line)
        if m:
            return m.group(1).strip()
    raise SystemExit("ADMIN_ACCESS_TOKEN not in .env.local")


def get(path: str) -> dict:
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {_token()}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def pr(pred: set, truth: set) -> dict:
    tp = len(pred & truth)
    return {"ditandai": len(pred), "benar": tp, "precision": round(tp / len(pred), 4) if pred else None, "recall": round(tp / len(truth), 4) if truth else None}


def lingkup_metrics(klaim_agen: set, t_klaim: set) -> dict:
    """Blu 3.0's reading scope (api/aip/blu3.py lingkup): how much planted fraud lies outside ML v3's output (the true miss
    rate), what the control sample holds, what the agents tagged in it, and any agent tag outside the scope (0 when enforced)."""
    sys.path.insert(0, str(ROOT / "api"))
    from aip import blu3

    lk = blu3.lingkup()
    kb, ctrl = set(lk["klaim_berisiko"]), {x["klaim_id"] for x in lk["kontrol"]}
    luar = t_klaim - kb
    return {"klaim_berisiko": len(kb), "di_luar": lk["di_luar"], "fraud_di_luar": len(luar),
            "tingkat_terlewat_sebenarnya": round(len(luar) / lk["di_luar"], 6) if lk["di_luar"] else None,
            "sampel_kontrol": len(ctrl), "fraud_di_sampel_kontrol": len(ctrl & t_klaim),
            "agen_di_sampel_kontrol": pr(klaim_agen & ctrl, t_klaim & ctrl),
            "tingkat_terlewat_menurut_agen": round(len(klaim_agen & ctrl) / len(ctrl), 4) if ctrl else None,
            "tag_agen_di_luar_lingkup": len(klaim_agen - kb - ctrl)}


def main() -> None:
    run = sys.argv[1] if len(sys.argv) > 1 else None
    if not run:
        runs = get("/api/aip/konsultan/runs")
        runs = runs if isinstance(runs, list) else runs.get("runs") or []
        run = next((r["id"] for r in runs if str(r.get("versi")) == "3.0"), None)
        if not run:
            raise SystemExit("no Blu 3.0 engagement yet")
    tags, off = [], 0
    while True:
        page = get(f"/api/aip/indikasi?run_id={run}&limit=1000&offset={off}")
        tags += page["tags"]
        off += 1000
        if off >= page["total"]:
            break
    truth = pd.read_parquet(HERE / "blu3" / "out" / "kebenaran.parquet")
    fraud = truth[truth["skema"] != "normal"]
    t_klaim = set(fraud["klaim_id"])
    t_faskes = set(fraud["faskes_profil_id"])
    fam_of = dict(zip(fraud["klaim_id"], fraud["skema"].map(SKEMA_FAMILI)))

    def sources(v: dict) -> set:
        # the ledger lists who supports a tag in agen_pendukung (agents and machines); it has no "sumber" list (fixed 2026-11-12:
        # reading "sumber" made every agent count zero)
        return set(v.get("agen_pendukung") or [])

    klaim_agen = {v["kunci"] for v in tags if v.get("entitas") == "klaim" and sources(v) - MESIN}
    klaim_mesin = {v["kunci"] for v in tags if v.get("entitas") == "klaim" and sources(v) & MESIN}
    faskes_tag = {v["kunci"] for v in tags if v.get("entitas") == "faskes"} | {(v.get("konteks") or {}).get("faskes_profil_id") for v in tags if v.get("entitas") == "klaim"}
    faskes_tag.discard(None)
    # the agents' mode tags on planted claims: the right Permenkes family?
    mode = [(fam_of.get(v["kunci"]), TAG_FAMILI[v["tag"]]) for v in tags if v.get("entitas") == "klaim" and v.get("tag") in TAG_FAMILI
            and sources(v) - MESIN and v["kunci"] in fam_of]
    try:
        box = get(f"/api/aip/karantina?penugasan={run}&limit=2000&ringkas=true")
    except urllib.error.HTTPError as e:  # an engagement before its quarantine phase has no box yet
        if e.code != 404:
            raise
        box = {}
    per_group = {g: {r["faskes_profil_id"] for r in (d.get("faskes") or [])} for g, d in (box.get("kelompok") or {}).items()}
    in_box = set().union(*per_group.values()) if per_group else set()
    top = set().union(*(per_group.get(g, set()) for g in ("A", "B", "C")))
    v3 = pd.read_parquet(HERE / "blu3" / "out" / "skor_risiko_klaim_ml.parquet", columns=["klaim_id", "ditandai", "faskes_profil_id"])
    v3_klaim = set(v3.loc[v3["ditandai"].fillna(False), "klaim_id"])
    out = {"run": run, "tag": len(tags), "klaim_fraud_tanaman": len(t_klaim), "faskes_fraud_tanaman": len(t_faskes),
           "klaim": {"agen": pr(klaim_agen, t_klaim), "mesin": pr(klaim_mesin, t_klaim), "agen_saja_di_luar_v3": pr(klaim_agen - v3_klaim, t_klaim),
                     "v3_saja": pr(v3_klaim, t_klaim)},
           "faskes": {"bertag": pr(faskes_tag, t_faskes), "box": pr(in_box, t_faskes), "box_puncak_abc": pr(top, t_faskes),
                      "per_kelompok": {g: pr(s, t_faskes) for g, s in per_group.items() if s}},
           "lingkup": lingkup_metrics(klaim_agen, t_klaim),
           "modus": {"tag_modus_agen_pada_fraud": len(mode), "keluarga_tepat": sum(a == b for a, b in mode),
                     "akurasi_keluarga": round(sum(a == b for a, b in mode) / len(mode), 4) if mode else None},
           "catatan": "Data sintetis: planted fraud dari generator (12 skema + 2 bentuk collusion ring baru); agen tidak pernah membaca ground truth-nya."}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"blu3_evaluasi_{run}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
