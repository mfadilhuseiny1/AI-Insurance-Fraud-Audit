"""Demo Grid: lapisan konteks Jawa Barat untuk visualisasi — dimensi wilayah dan fakta siap-peta/diagram yang
menempel ke data demo yang sudah ada (dipanggil demo_grid_e2e.build, langkah "konteks").

Kenapa lapisan ini ada: data demo tersebar di banyak dataset (aset, susut, AMI, sensor, temuan). Agar mudah
divisualisasikan (peta, choropleth per wilayah, diagram per ULP/penyulang), modul ini menulis tabel bintang:

  raw/konteks/dim_wilayah_grid_jabar     — 1 baris per ULP: kabupaten/kota, kecamatan, karakter wilayah, kawasan
                                           industri acuan, iklim normal sintetis (konteks, bukan pengukuran).
  clean/visualisasi/fakta_gardu_visual   — 1 baris per gardu distribusi: wilayah + koordinat + kapasitas + beban
                                           puncak + estimasi TL + jumlah pelanggan/temuan (siap titik peta & warna).
  clean/visualisasi/fakta_penyulang_visual — 1 baris per penyulang: wilayah + panjang + gardu/pelanggan/kVA.
  clean/visualisasi/fakta_ulp_visual     — rollup per ULP untuk diagram batang/donat.
  clean/visualisasi/sampel_pelanggan_visual — sampel pelanggan TANPA identitas (tanpa nama/NIK/alamat/telepon;
                                           koordinat dibulatkan ±100 m) untuk scatter/heatmap demo.

Panduan yang dijaga: aset transmisi nyata dari OSM hanya konteks (tanpa angka demo); gardu/pelanggan fiktif dan
berlabel "(demo)"; wilayah administratif memakai nama nyata di sekitar Cikarang, Kabupaten Bekasi, Jawa Barat —
tempat GI demo berada — sedangkan kecamatan per gardu adalah penugasan sintetis deterministik untuk demo.
Tidak ada kunci jawaban pola (ground truth evaluasi) yang ditulis ke tabel visual ini.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone

WILAYAH: dict[str, dict] = {
    "ULP-KWS": {"nama_ulp": "ULP Demo Kawasan Industri", "kabupaten_kota": "Kabupaten Bekasi", "kota_acuan": "Cikarang",
                "karakter": "Kawasan industri", "kecamatan": ["Cikarang Pusat", "Cikarang Barat", "Cikarang Selatan"],
                "kawasan_industri_acuan": "MM2100, Delta Silicon, EJIP, Jababeka (konteks OSM, tanpa angka demo)",
                "profil_beban": "Industri 3 shift, puncak siang hari kerja"},
    "ULP-KTU": {"nama_ulp": "ULP Demo Cikarang Utara", "kabupaten_kota": "Kabupaten Bekasi", "kota_acuan": "Cikarang",
                "karakter": "Perkotaan & permukiman", "kecamatan": ["Cikarang Utara", "Tambun Selatan", "Babelan", "Tarumajaya"],
                "kawasan_industri_acuan": "-", "profil_beban": "Rumah tangga & bisnis, puncak malam"},
    "ULP-KTS": {"nama_ulp": "ULP Demo Cikarang Selatan", "kabupaten_kota": "Kabupaten Bekasi", "kota_acuan": "Cikarang",
                "karakter": "Campuran industri-permukiman", "kecamatan": ["Cikarang Selatan", "Serang Baru", "Setu", "Cibarusah"],
                "kawasan_industri_acuan": "Lippo Cikarang, Delta Silicon (konteks OSM, tanpa angka demo)",
                "profil_beban": "Campuran, puncak sore-malam"},
}
IKLIM = {"suhu_rata_c": 28.5, "kelembaban_rata_pct": 78, "curah_hujan_mm_tahun": 1850,
         "catatan_iklim": "Normal iklim sintetis dataran rendah pesisir utara Jawa Barat (konteks demo, bukan stasiun ukur)"}


def _e():
    import demo_grid_e2e as e

    return e


def _st() -> dict:
    return _e().STATE.setdefault("konteks", {})


def _kecamatan(kode_ulp: str, key: str) -> str:
    kec = WILAYAH.get(kode_ulp, {}).get("kecamatan") or ["-"]
    return kec[int(hashlib.md5(key.encode()).hexdigest(), 16) % len(kec)]


def dim_wilayah() -> list[dict]:
    return [{"kode_ulp": k, "nama_ulp": v["nama_ulp"], "provinsi": "Jawa Barat", "kabupaten_kota": v["kabupaten_kota"],
             "kota_acuan": v["kota_acuan"], "karakter_wilayah": v["karakter"],
             "kecamatan_demo": ", ".join(v["kecamatan"]), "kawasan_industri_acuan": v["kawasan_industri_acuan"],
             "profil_beban": v["profil_beban"], **IKLIM, "sumber": "Konteks wilayah demo (nama administratif nyata, angka sintetis)"}
            for k, v in sorted(WILAYAH.items())]


def _temuan_per_gardu() -> dict[str, int]:
    import ontology

    t = _e()._type("temuan")
    if not t:
        return {}
    out: dict[str, int] = {}
    for o in ontology._objects(t["id"]).values():
        p = o.get("properties") or {}
        dt = p.get("kode_gardu") or p.get("kode_dt")
        if dt:
            out[dt] = out.get(dt, 0) + 1
    return out


def fakta_gardu() -> list[dict]:
    import demo_grid_data as gd
    import demo_grid_sensor_gardu as sg

    cust = gd.customers()
    per_dt: dict[str, dict[str, int]] = {}
    for c in cust:
        a = per_dt.setdefault(c.get("kode_dt") or "-", {"pelanggan": 0, "ami": 0, "tm": 0})
        a["pelanggan"] += 1
        a["ami"] += 1 if c.get("ami") else 0
        a["tm"] += 1 if c.get("tegangan") == "TM" else 0
    temuan = _temuan_per_gardu()
    net = {d["kode_dt"]: d for d in gd.network()["dts"]}
    out = []
    for g in sg.gardu():
        d = net.get(g["kode_dt"]) or {}
        w = WILAYAH.get(g["kode_ulp"]) or {}
        tl = sg.tl_jam(g, g["k_puncak"] * g["kva"], [g["k_puncak"] * g["kva"] * 2.5 / 3] * 3)
        beban_pct = round(g["k_puncak"] * 100, 1)
        a = per_dt.get(g["kode_dt"]) or {}
        out.append({"kode_dt": g["kode_dt"], "nama_gardu": d.get("nama"), "kode_penyulang": g["kode_penyulang"],
                    "kode_ulp": g["kode_ulp"], "kabupaten_kota": w.get("kabupaten_kota"), "kecamatan_demo": _kecamatan(g["kode_ulp"], g["kode_dt"]),
                    "latitude": d.get("lat"), "longitude": d.get("lon"),
                    "lokasi": f"{d['lat']:.6f},{d['lon']:.6f}" if d.get("lat") else None,
                    "kva": g["kva"], "tahun_pasang": d.get("tahun_pasang"), "beban_puncak_pct_rata": beban_pct,
                    "status_beban_sintetis": "Overload" if beban_pct >= 100 else ("Beban tinggi" if beban_pct >= 85 else "Normal"),
                    "estimasi_tl_kwh_hari": round(tl["tl_kwh"] * 24, 2),
                    "jumlah_pelanggan": a.get("pelanggan", 0), "pelanggan_ami": a.get("ami", 0), "pelanggan_tm": a.get("tm", 0),
                    "jumlah_temuan_terbuka": temuan.get(g["kode_dt"], 0), "label": "Gardu fiktif (demo), wilayah konteks Jawa Barat"})
    return sorted(out, key=lambda r: (r["kode_ulp"], r["kode_dt"]))


def fakta_penyulang(gardu_rows: list[dict]) -> list[dict]:
    import demo_grid_data as gd

    net = gd.network()
    per_fdr: dict[str, dict[str, int]] = {}
    for c in gd.customers():
        a = per_fdr.setdefault(c.get("kode_penyulang") or "-", {"pelanggan": 0, "tm": 0})
        a["pelanggan"] += 1
        a["tm"] += 1 if c.get("tegangan") == "TM" else 0
    out = []
    for f in net["feeders"]:
        gs = [r for r in gardu_rows if r["kode_penyulang"] == f["kode"]]
        pts = f.get("pts") or []
        km = sum(_km(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) if len(pts) > 1 else 0.0
        w = WILAYAH.get(f["kode_ulp"]) or {}
        a = per_fdr.get(f["kode"]) or {}
        out.append({"kode_penyulang": f["kode"], "nama_penyulang": f.get("nama"), "kode_gi": f["kode_gi"], "kode_ulp": f["kode_ulp"],
                    "kabupaten_kota": w.get("kabupaten_kota"), "karakter_wilayah": w.get("karakter"),
                    "panjang_km": round(km, 2), "jumlah_gardu": len(gs), "total_kva": sum(r["kva"] for r in gs),
                    "jumlah_pelanggan": a.get("pelanggan", 0), "pelanggan_tm_langsung": a.get("tm", 0),
                    "rata_beban_puncak_pct": round(sum(r["beban_puncak_pct_rata"] for r in gs) / len(gs), 1) if gs else None,
                    "estimasi_tl_kwh_hari": round(sum(r["estimasi_tl_kwh_hari"] for r in gs), 1)})
    return out


def fakta_ulp(gardu_rows: list[dict]) -> list[dict]:
    out = []
    for ulp, w in sorted(WILAYAH.items()):
        gs = [r for r in gardu_rows if r["kode_ulp"] == ulp]
        out.append({"kode_ulp": ulp, "nama_ulp": w["nama_ulp"], "kabupaten_kota": w["kabupaten_kota"], "karakter_wilayah": w["karakter"],
                    "jumlah_gardu": len(gs), "total_kva": sum(r["kva"] for r in gs), "jumlah_pelanggan": sum(r["jumlah_pelanggan"] for r in gs),
                    "pelanggan_ami": sum(r["pelanggan_ami"] for r in gs), "gardu_overload_sintetis": sum(1 for r in gs if r["status_beban_sintetis"] == "Overload"),
                    "gardu_beban_tinggi": sum(1 for r in gs if r["status_beban_sintetis"] == "Beban tinggi"),
                    "estimasi_tl_kwh_hari": round(sum(r["estimasi_tl_kwh_hari"] for r in gs), 1),
                    "jumlah_temuan_terbuka": sum(r["jumlah_temuan_terbuka"] for r in gs),
                    "keterangan": "Pelanggan TM langsung di penyulang; tanpa gardu distribusi demo" if not gs else ""})
    return out


def sampel_pelanggan(limit: int = 1500) -> list[dict]:
    import demo_grid_data as gd

    cs = sorted(gd.customers(), key=lambda c: c["id_pelanggan"])
    step = max(1, len(cs) // limit)
    out = []
    for c in cs[::step][:limit]:
        w = WILAYAH.get(c["kode_ulp"]) or {}
        out.append({"id_pelanggan": c["id_pelanggan"], "segmen": c.get("segmen"), "tarif": c.get("tarif"), "daya_va": c.get("daya_va"),
                    "tegangan": c.get("tegangan"), "jenis_meter": c.get("jenis_meter"), "ami": "Ya" if c.get("ami") else "Tidak",
                    "kode_dt": c.get("kode_dt"), "kode_penyulang": c.get("kode_penyulang"), "kode_ulp": c.get("kode_ulp"),
                    "kabupaten_kota": w.get("kabupaten_kota"), "kecamatan_demo": _kecamatan(c["kode_ulp"], c["id_pelanggan"]),
                    "latitude": round(c["lat"], 3), "longitude": round(c["lon"], 3),
                    "lokasi": f"{c['lat']:.3f},{c['lon']:.3f}", "label": "Pelanggan fiktif tanpa identitas (demo)"})
    return out


def _km(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def build(state: dict, save) -> dict:
    e = _e()
    st = state.setdefault("konteks", {})
    project = e._folder(None, e.PROJECT, "project")
    raw_konteks = e._folder(e._folder(project, "raw"), "konteks")
    visual = e._folder(e._folder(project, "clean"), "visualisasi")
    gardu_rows = fakta_gardu()
    data = {"dim_wilayah_grid_jabar": (raw_konteks, dim_wilayah()),
            "fakta_gardu_visual": (visual, gardu_rows),
            "fakta_penyulang_visual": (visual, fakta_penyulang(gardu_rows)),
            "fakta_ulp_visual": (visual, fakta_ulp(gardu_rows)),
            "sampel_pelanggan_visual": (visual, sampel_pelanggan())}
    ids = {name: e._put(folder, name, rows) for name, (folder, rows) in data.items()}
    st.update(datasets=ids, baris={name: len(rows) for name, (_, rows) in data.items()},
              pada=datetime.now(timezone.utc).isoformat())
    save()
    return {"datasets": ids, "baris": st["baris"]}


def overview_numbers() -> dict:
    st = _e().STATE.get("konteks") or {}
    return {"datasets": st.get("datasets"), "baris": st.get("baris")}
