"""End-to-end check of the /testing API: every example preset scored (LLM off unless --llm), plus form validation errors.
Usage: .venv/Scripts/python.exe testing/uji_api.py [--llm normal,ganda] [--ulang 2]"""
import argparse
import json
import time

import httpx

B = "http://127.0.0.1:8320/testing/api"
ap = argparse.ArgumentParser()
ap.add_argument("--llm", default="")
ap.add_argument("--ulang", type=int, default=1)
ap.add_argument("--jenis", default="normal,ganda,kartu_dipinjam,kelas_naik,dx_sekunder,topup_fiktif,topup_inflasi,prosedur_fiktif,kode_tidak_sesuai,setelah_meninggal,kloning,upcoding,los_bergeser,ring")
a = ap.parse_args()
llm_for = set(x for x in a.llm.split(",") if x)
c = httpx.Client(timeout=600)
for rep in range(a.ulang):
    for j in a.jenis.split(","):
        ex = c.get(f"{B}/contoh", params={"jenis": j}).json()
        t0 = time.time()
        r = c.post(f"{B}/nilai", json={"klaim": ex["klaim"], "llm": j in llm_for})
        if r.status_code != 200:
            print(f"{j:18s} HTTP {r.status_code} {r.text[:300]}")
            continue
        hs = r.json()["hasil"]
        last = hs[-1]
        if "galat" in last:
            print(f"{j:18s} galat {last}")
            continue
        flagged = sum(1 for h in hs if h.get("terdeteksi"))
        p = last.get("penjelasan") or {}
        sig = [s["kode"] for s in last["engine"]["sinyal"]][:4]
        print(f"{j:18s} n={len(hs):2d} flagged={flagged:2d} last: det={last['terdeteksi']!s:5s} p={last['peluang']:.3f} m1={last['model1']:.3f} m2={last['model2']:.3f} "
              f"alert={last['alert_ring']!s:5s} rule={last['engine']['keputusan']}/{last['engine']['skor']} ent={last['entitas']['aturan']} sig={sig} "
              f"ring7={last['ring']['w7']['peserta_lain_berbagi_maks']} graf={len(last['graf']['nodes'])}n {time.time() - t0:.1f}s")
        if p.get("jenis_fraud"):
            print(f"{'':18s} -> {p.get('sumber')} ${p.get('biaya_usd', 0)}: {p['jenis_fraud']} | {p.get('keyakinan')} | {p.get('ringkasan')}")
            if j in llm_for:
                print(json.dumps({k: p.get(k) for k in ("alasan", "graph", "perbaikan", "catatan", "jenis_lain")}, ensure_ascii=False, indent=1))

# form validation: each bad field comes back as {field, pesan}
ex = c.get(f"{B}/contoh", params={"jenis": "normal"}).json()["klaim"][0]
for field, val in [("inacbg_kode", "Z-9-99-I"), ("diagnosis_utama", "abc"), ("rs_id", "nope-nope"), ("tanggal_pulang", "2020-01-01")]:
    r = c.post(f"{B}/nilai", json={"klaim": [dict(ex, **{field: val})], "llm": False})
    print("validasi", field, r.status_code, r.json().get("detail"))
r = c.post(f"{B}/nilai", json={"klaim": [dict(ex, pasien_mode="baru", nama_pasien="", no_rm="")], "llm": False})
print("validasi pasien baru kosong", r.status_code, r.json().get("detail"))
r = c.post(f"{B}/nilai", json={"klaim": [dict(ex, biaya_tagih_rp=None)], "llm": False})
print("validasi biaya kosong", r.status_code, str(r.json().get("detail"))[:200])
r = c.post(f"{B}/nilai", json={"klaim": [dict(ex, pasien_mode="baru", nama_pasien="Budi Santoso Uji", no_rm="RM-UJI-0001", no_sep="0301R0011124V000123")], "llm": False})
h = r.json()["hasil"][0] if r.status_code == 200 else r.text
print("pasien baru", r.status_code, h["entitas"] if isinstance(h, dict) else h, h.get("terdeteksi") if isinstance(h, dict) else "")
r = c.post(f"{B}/nilai", json={"klaim": [dict(ex, pasien_mode="baru", nama_pasien="Budi Santoso Uji", no_rm="RM-UJI-0001", no_sep="0301R0011124V000124")], "llm": False})
h = r.json()["hasil"][0] if r.status_code == 200 else r.text
print("pasien baru lagi (RM sama)", r.status_code, h["entitas"] if isinstance(h, dict) else h)
print("riwayat", len(c.get(f"{B}/riwayat").json()))
