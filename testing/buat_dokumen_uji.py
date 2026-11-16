"""Synthetic claim documents for testing the upload autofill: a resume PDF, a SEP + bill DOCX and a SEP image (PNG).
Values come from an example claim of the running service (a stream hospital, a real INA-CBG code of the reference);
the patient is invented. Writes testing/dokumen_uji/ and prints the values each file carries (the expected autofill).
Usage: .venv/Scripts/python.exe testing/buat_dokumen_uji.py"""
import json
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parent / "dokumen_uji"
OUT.mkdir(exist_ok=True)
B = "http://127.0.0.1:8320/testing/api"
ex = httpx.get(f"{B}/contoh", params={"jenis": "normal"}, timeout=120).json()["klaim"][0]
rs = next(r for r in httpx.get(f"{B}/rs", timeout=60).json() if r["id"] == ex["rs_id"])
kelas_rs = (rs.get("tipe") or "").replace("RS Kelas ", "").replace("Kelas ", "").strip()[:1] or "C"
pasien = {"nama": "Sri Wahyuningsih (FIKTIF)", "rm": "RM-778812", "sep": "0301R0021224V004417", "kartu": "0001234567890"}
v = {"nama_pasien": pasien["nama"], "no_rm": pasien["rm"], "no_sep": pasien["sep"], "tanggal_masuk": ex["tanggal_masuk"], "tanggal_pulang": ex["tanggal_pulang"],
     "kelas_rawat": ex["kelas_rawat"] or 3, "hak_kelas": ex["kelas_rawat"] or 3, "status_pulang": ex["status_pulang"] or "Membaik",
     "diagnosis_utama": ex["diagnosis_utama"], "diagnosis_sekunder": ex["diagnosis_sekunder"][:3] or ["I10"], "tindakan": ex["tindakan"][:3],
     "inacbg_kode": ex["inacbg_kode"], "tarif_inacbg_rp": ex["tarif_inacbg_rp"], "biaya_tagih_rp": ex["biaya_tagih_rp"],
     "rs": f"RSUD Contoh {rs['kabkota'].title()}", "kelas_rs": kelas_rs, "kepemilikan": rs["kepemilikan"], "kabkota": rs["kabkota"], "provinsi": rs["provinsi"],
     "rs_id": rs["id"]}
rp = lambda x: "Rp" + f"{int(x):,}".replace(",", ".")  # noqa: E731
tgl = lambda s: "/".join(reversed(s.split("-")))  # noqa: E731  dd/mm/yyyy, as Indonesian forms write it

baris = [
    ("Nama Rumah Sakit", f"{v['rs']} (Kelas {v['kelas_rs']}, {v['kepemilikan']})"), ("Kabupaten/Kota", f"{v['kabkota']}, {v['provinsi']}"),
    ("Nama Pasien", v["nama_pasien"]), ("No. Rekam Medis", v["no_rm"]), ("No. SEP", v["no_sep"]), ("No. Kartu JKN", pasien["kartu"]),
    ("Jenis Rawat", "Rawat Inap"), ("Tanggal Masuk", tgl(v["tanggal_masuk"])), ("Tanggal Keluar", tgl(v["tanggal_pulang"])),
    ("Kelas Rawat", f"Kelas {v['kelas_rawat']}"), ("Hak Kelas", f"Kelas {v['hak_kelas']}"), ("Cara Pulang", v["status_pulang"]),
    ("Diagnosis Utama", v["diagnosis_utama"]), ("Diagnosis Sekunder", ", ".join(v["diagnosis_sekunder"])),
    ("Tindakan/Prosedur", "; ".join(v["tindakan"]) or "-"), ("Kode INA-CBG", v["inacbg_kode"]),
    ("Tarif INA-CBG", rp(v["tarif_inacbg_rp"] or 0)), ("Total Tagihan Rumah Sakit", rp(v["biaya_tagih_rp"])),
]

# 1. resume PDF
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

c = canvas.Canvas(str(OUT / "resume_medis.pdf"), pagesize=A4)
y = 800
c.setFont("Helvetica-Bold", 14); c.drawString(50, y, "RESUME MEDIS PASIEN PULANG (DOKUMEN SINTETIS)"); y -= 30
c.setFont("Helvetica", 10)
for k, val in baris:
    c.drawString(50, y, f"{k}"); c.drawString(220, y, f": {val}"); y -= 18
c.drawString(50, y - 20, "Dokter Penanggung Jawab: dr. Contoh, Sp.PD (fiktif)")
c.save()

# 2. SEP + bill DOCX
import docx  # noqa: E402

d = docx.Document()
d.add_heading("SURAT ELIGIBILITAS PESERTA DAN RINCIAN BIAYA (SINTETIS)", 1)
t = d.add_table(rows=0, cols=2)
for k, val in baris:
    r = t.add_row().cells; r[0].text = k; r[1].text = str(val)
d.save(OUT / "sep_rincian.docx")

# 3. SEP image (PNG)
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

img = Image.new("RGB", (1100, 40 + 34 * (len(baris) + 2)), "white")
dr = ImageDraw.Draw(img)
try:
    f1 = ImageFont.truetype("arial.ttf", 22); f2 = ImageFont.truetype("arialbd.ttf", 24)
except OSError:
    f1 = f2 = ImageFont.load_default()
dr.text((30, 20), "SURAT ELIGIBILITAS PESERTA (SINTETIS)", fill="black", font=f2)
for i, (k, val) in enumerate(baris):
    dr.text((30, 70 + 34 * i), k, fill="black", font=f1); dr.text((380, 70 + 34 * i), f": {val}", fill="black", font=f1)
img.save(OUT / "sep_foto.png")

(OUT / "harapan.json").write_text(json.dumps(v, ensure_ascii=False, indent=1), "utf-8")
print(json.dumps(v, ensure_ascii=False))
print("ditulis:", [p.name for p in OUT.iterdir()])
