"""Kab/kota boundaries and SYNTHETIC hospital coordinates for the branch report's map (the user, 2026-11-14: "can you make audit
report like this" (the national report, with its province map) "so we can add synthetic data for hospital coordinate").

  boundaries   geoBoundaries IDN ADM2 (BPS, WFP, OCHA ROAP; CC BY 3.0 IGO; simplified release, downloaded to .tmp/geo_unduh/),
               each shape placed in its province by point-in-polygon on web/public/geo/provinsi.json and matched by name to the
               BPJS kab/kota code within that province; rings simplified (Douglas-Peucker) -> web/public/geo/kabkota/<province code>.json
  coordinates  the sample has no hospital location (a hospital is a profile: kab/kota + ownership + kind + type). Each profile
               gets a synthetic point: a fixed-seed random point inside its own kab/kota, drawn around the area's centre (a city
               tighter than a regency) -> data/aip/cabang/rs_koordinat.json. Not a real address.

Usage: .venv/Scripts/python.exe testing/geo_rs.py [--geojson .tmp/geo_unduh/adm2.geojson]"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))
SUMBER = "geoBoundaries IDN ADM2 2020 (BPS, WFP, OCHA ROAP; CC BY 3.0 IGO), disederhanakan; dicocokkan ke kode kab/kota BPJS"


# geoBoundaries name -> BPJS name, where the regency was renamed (Mamuju Utara became Pasangkayu in 2017)
ALIAS = {"PASANGKAYU": "MAMUJU UTARA"}


def norm(s: str) -> str:
    s = s.upper().replace("KABUPATEN ", "").replace("KAB. ", "").replace(" DAN ", " ")
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    return " ".join(s.split())


def dalam(x: float, y: float, ring: list) -> bool:
    """Ray casting: is (x, y) inside the ring?"""
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def dalam_rings(x: float, y: float, rings: list) -> bool:
    return any(dalam(x, y, r) for r in rings)


def luas(ring: list) -> float:
    return abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1] for i in range(len(ring)))) / 2


def dp(pts: list, tol: float) -> list:
    """Douglas-Peucker simplification of a ring."""
    if len(pts) < 5:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    n = np.linalg.norm(ab)
    d = [abs(np.cross(ab, np.array(p) - a)) / n if n > 0 else np.linalg.norm(np.array(p) - a) for p in pts[1:-1]]
    i = int(np.argmax(d)) + 1
    if d[i - 1] > tol:
        return dp(pts[: i + 1], tol)[:-1] + dp(pts[i:], tol)
    return [pts[0], pts[-1]]


def rings_of(geom: dict) -> list:
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [p[0] for p in polys]  # exterior rings only (holes are rare at this scale)


def main(geojson: Path) -> None:
    import generator3 as G

    D = G.dunia()
    prov = json.loads((ROOT / "web" / "public" / "geo" / "provinsi.json").read_text("utf-8"))["provinsi"]
    # the BPJS kab/kota table (every kab/kota a hospital profile sits in)
    kab: dict[int, dict] = {}
    for r in D.rs.values():
        kab.setdefault(int(r["kab"]), {"nama": r["kab_nama"], "prov": int(r["kab"]) // 100})
    feats = json.loads(geojson.read_text("utf-8"))["features"]
    out, tak, luar = {}, [], []
    for f in feats:
        rs = [[(round(x, 5), round(y, 5)) for x, y in r] for r in rings_of(f["geometry"])]
        big = max(rs, key=luas)
        cx, cy = float(np.mean([p[0] for p in big])), float(np.mean([p[1] for p in big]))
        pk = next((p["kode"] for p in prov if dalam_rings(cx, cy, p["rings"])), None)
        nm = norm(f["properties"]["shapeName"])
        nm = ALIAS.get(nm, nm)
        calon = {k: v for k, v in kab.items() if pk is None or v["prov"] == pk}
        cocok = [k for k, v in calon.items() if norm(v["nama"]) == nm]
        if not cocok:
            m = difflib.get_close_matches(nm, [norm(v["nama"]) for v in calon.values()], n=1, cutoff=0.72)
            cocok = [k for k, v in calon.items() if m and norm(v["nama"]) == m[0]]
        if not cocok:
            # the 2022 Papua provinces (the shape's point falls in a new province, BPJS keeps the old code): a name that is
            # unique in the whole country
            semua = [k for k, v in kab.items() if norm(v["nama"]) == nm]
            cocok = semua if len(semua) == 1 else []
        tol = 0.004 if luas(big) < 0.5 else 0.008
        simp = [dp(list(map(list, r)), tol) for r in rs if luas(r) > 2e-5]
        simp = [[[round(x, 4), round(y, 4)] for x, y in r] for r in simp if len(r) >= 4]
        if not cocok:
            # no hospital profile there (or a lake): drawn dim as context in its province, never shaded (kode 0)
            tak.append(f"{f['properties']['shapeName']} (prov {pk})")
            if pk is not None:
                luar.append({"kode": 0, "nama": f["properties"]["shapeName"], "provinsi": pk, "titik": [round(cx, 4), round(cy, 4)], "rings": simp})
            continue
        k = cocok[0]
        if k in out:  # two shapes for one BPJS code: keep both
            out[k]["rings"] += simp
            continue
        # a representative point inside: the centre of the largest ring if it is inside, else the nearest inside point of a grid
        titik = [round(cx, 4), round(cy, 4)]
        if not dalam_rings(cx, cy, simp):
            xs, ys = [p[0] for p in big], [p[1] for p in big]
            grid = [(x, y) for x in np.linspace(min(xs), max(xs), 25) for y in np.linspace(min(ys), max(ys), 25) if dalam(x, y, big)]
            if grid:
                gx, gy = min(grid, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)
                titik = [round(float(gx), 4), round(float(gy), 4)]
        out[k] = {"kode": k, "nama": kab[k]["nama"], "provinsi": kab[k]["prov"], "titik": titik, "rings": simp}
    hilang = sorted(set(kab) - set(out))
    # one file per province (a branch area lies in one province; the whole country is 1.9 MB)
    d_out = ROOT / "web" / "public" / "geo" / "kabkota"
    d_out.mkdir(parents=True, exist_ok=True)
    for pk in sorted({v["provinsi"] for v in out.values()}):
        isi = [v for v in out.values() if v["provinsi"] == pk] + [v for v in luar if v["provinsi"] == pk]
        (d_out / f"{pk}.json").write_text(json.dumps({"sumber": SUMBER, "kabkota": isi}, separators=(",", ":")), "utf-8")
    print(f"{len(out)} kab/kota matched of {len(kab)} BPJS codes; geoBoundaries shapes without a match: {len(tak)} {tak[:8]}; BPJS codes without a shape: {len(hilang)} {[kab[k]['nama'] for k in hilang[:8]]}")
    # synthetic hospital points
    koord = {}
    for fid, r in D.rs.items():
        k = out.get(int(r["kab"]))
        if not k:
            continue
        rng = np.random.default_rng(int(hashlib.md5(f"rs-koordinat|{fid}".encode()).hexdigest()[:12], 16))
        big = max(k["rings"], key=luas)
        xs, ys = [p[0] for p in big], [p[1] for p in big]
        skala = math.sqrt((max(xs) - min(xs)) * (max(ys) - min(ys))) * (0.12 if str(r["kab_nama"]).upper().startswith("KOTA") else 0.2)
        titik = k["titik"]
        for _ in range(400):
            x, y = titik[0] + rng.normal(0, skala), titik[1] + rng.normal(0, skala)
            if dalam_rings(x, y, k["rings"]):
                titik = [round(float(x), 5), round(float(y), 5)]
                break
        koord[fid] = {"lon": titik[0], "lat": titik[1], "kab": int(r["kab"])}
    f = ROOT / "data" / "aip" / "cabang" / "rs_koordinat.json"
    f.write_text(json.dumps({"keterangan": "KOORDINAT SINTETIS: titik acak (benih tetap per profil RS) di dalam batas kab/kota, mengumpul di sekitar pusat wilayah. "
                                           "Bukan alamat RS nyata.", "batas": SUMBER, "rs": koord}, ensure_ascii=False), "utf-8")
    print(f"{len(koord)} of {len(D.rs)} hospital profiles placed -> {f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--geojson", default=str(ROOT / ".tmp" / "geo_unduh" / "adm2.geojson"))
    main(Path(ap.parse_args().geojson))
