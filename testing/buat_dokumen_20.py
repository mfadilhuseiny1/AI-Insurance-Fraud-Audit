"""20 synthetic claim documents (PDF) to upload in /testing: 10 ordinary claims and 10 fraud claims (the user, 2026-11-12:
"coba bikin pdf buat contoh dokumen2 yg bisa saya upload di /testing, 10 fraud 10 normal").

An uploaded document carries the patient's name and RM number, so /testing treats the patient as NEW (entity resolution,
no registry, no claim history). The fraud therefore has to show in the document itself, or in a pair of documents of the
same patient (same RM) at the same hospital:
  N01–N10  ordinary inpatient claims (templates: the service's own ordinary examples, /testing/api/contoh?jenis=normal)
  F11–F16  one document each: inflated secondary diagnoses, a top-up that never exists for the code, an inflated top-up,
           a procedure code without any procedure, a rare diagnosis–code pair, a PBI member billed above class
  F17      repeat billing of N01 (the same stay again, another SEP)            upload N01 first
  F18      unbundling: N02's patient back one day after discharge              upload N02 first
  F19      readmission with the same diagnosis six days after N03              upload N03 first
  F20      a stay far longer than its code's norm
The patients, RM, SEP and card numbers are invented; hospitals are named "Contoh" after their city, with the class and
ownership of a stream hospital profile so the upload matches that profile. Writes testing/dokumen_uji/20_klaim/ (PDFs,
harapan.json with the values each file carries and the expected verdict, BACA_DULU.txt). Synthetic data only.

Usage (with /testing running on 8320): .venv/Scripts/python.exe testing/buat_dokumen_20.py"""
from __future__ import annotations

import json
import random
import re
from datetime import date, timedelta
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parent / "dokumen_uji" / "20_klaim"
B = "http://127.0.0.1:8320/testing/api"
W0, W1 = date(2024, 12, 18), date(2024, 12, 31)
rng = random.Random(20261112)

NAMA = ["Siti Rahmawati", "Agus Prasetyo", "Dewi Lestari", "Bambang Suryadi", "Rina Kartika", "Hendra Gunawan", "Yuliani Pratiwi",
        "Joko Santoso", "Nur Aisyah", "Eko Wibowo", "Fitri Handayani", "Rudi Hartono", "Sri Mulyani", "Andi Saputra", "Lina Marlina",
        "Dedi Kurniawan", "Wulan Sari", "Teguh Riyanto", "Maya Anggraini", "Fajar Nugroho"]
JENIS = {"ri": "Rawat Inap", "rj": "Rawat Jalan", "igd": "Gawat Darurat (IGD)"}
CMG = {"sa": "SA (Sub-acute)", "sp": "SP (Special Procedure)", "rr": "RR (Special Prosthesis)", "si": "SI (Special Investigation)", "sd": "SD (Special Drug)"}


def get(path: str, **params) -> dict:
    r = httpx.get(f"{B}{path}", params=params, timeout=180)
    r.raise_for_status()
    return r.json()


def d(s: str) -> date:
    return date.fromisoformat(s[:10])


def kelas_rs(tipe: str) -> str:
    m = re.search(r"(?:Kelas|Type)\s+([A-D])\b", tipe or "")
    return m.group(1) if m else ""


def cocok_rs(rs_list: list[dict], kab: str, kelas: str, milik: str) -> str:
    """ekstrak._cocokkan_rs, for the expected profile of an upload."""
    norm = lambda s: re.sub(r"^(kota|kabupaten|kab\.?)\s+", "", (s or "").lower()).strip()  # noqa: E731
    cands = [r for r in rs_list if norm(r.get("kabkota")) == norm(kab)]

    def skor(r: dict) -> tuple:
        tipe = (r.get("tipe") or "").upper()
        s_k = 2 if kelas and re.search(rf"\bKELAS {kelas}\b", tipe) else 1 if kelas and re.search(rf"\bTYPE {kelas}\b", tipe) else 0
        own = (r.get("kepemilikan") or "").lower()
        m = milik.lower()
        s_m = 1 if m and (own.startswith(m[:6]) or (m.startswith("swasta") and own.startswith("swasta"))) else 0
        return (s_k, s_m, r["klaim"])

    return max(cands, key=skor)["id"] if cands else ""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rs_list = get("/rs")
    rs_by = {r["id"]: r for r in rs_list}

    def rs_doc(rs_id: str) -> dict:
        r = rs_by[rs_id]
        kab = r["kabkota"].title().replace("Kota ", "").replace("Kabupaten ", "")
        jenis = "RSUD" if not (r.get("kepemilikan") or "").lower().startswith("swasta") else "RS"
        return {"nama": f"{jenis} Contoh {kab}", "kelas": kelas_rs(r["tipe"]), "kepemilikan": r["kepemilikan"], "kabkota": r["kabkota"].title(),
                "provinsi": r["provinsi"].title()}

    def contoh(jenis: str) -> dict:
        for _ in range(6):
            k = get("/contoh", jenis=jenis)["klaim"]
            if k:
                return k[-1]
        raise RuntimeError(f"no example for {jenis}")

    normals = []
    while len(normals) < 11:
        f = contoh("normal")
        if f["jenis_episode"] == "ri" and f["tanggal_pulang"] and f["rs_id"] in rs_by and f["peserta_id"] not in {x["peserta_id"] for x in normals}:
            normals.append(f)
    normals.sort(key=lambda f: (d(f["tanggal_pulang"]) - d(f["tanggal_masuk"])).days)
    # the two shortest stays become N02 and N03 (their pairs need room in the 18–31 Dec window); one more template for F20
    urut = [normals[2], normals[0], normals[1], *normals[3:10]]
    tmpl_los = normals[10]

    seq = iter(range(1, 999))
    docs: list[dict] = []

    def pasien(i: int) -> dict:
        return {"nama_pasien": NAMA[i], "no_rm": f"RM-{rng.randint(100000, 999999)}", "no_kartu": f"0000{rng.randint(10**8, 10**9 - 1)}"}

    def tambah(kode: str, label: str, skema: str, modus: list[str], f: dict, p: dict, ket: str, butuh: str | None = None, **ubah) -> dict:
        f = {**f, **ubah}
        rs = rs_doc(f["rs_id"])
        doc = {"file": f"{kode}_{skema}.pdf", "kode": kode, "label": label, "skema": skema, "modus": modus, "keterangan": ket, "unggah_setelah": butuh,
               **p, "no_sep": f"0301R00{rng.randint(10**10, 10**11 - 1)}", "jenis_episode": f.get("jenis_episode") or "ri", "tanggal_masuk": f["tanggal_masuk"],
               "tanggal_pulang": f["tanggal_pulang"] if (f.get("jenis_episode") or "ri") == "ri" else f["tanggal_masuk"], "kelas_rawat": f.get("kelas_rawat") or 3, "hak_kelas": f.get("hak_kelas") or f.get("kelas_rawat") or 3,
               "segmen": f.get("segmen") or "", "status_pulang": f.get("status_pulang") or "Membaik", "diagnosis_utama": f["diagnosis_utama"],
               "diagnosis_sekunder": f.get("diagnosis_sekunder") or [], "tindakan": f.get("tindakan") or [], "inacbg_kode": f["inacbg_kode"],
               "tarif_inacbg_rp": f.get("tarif_inacbg_rp"), "topup_jenis": f.get("topup_jenis") or "", "topup_rp": int(f.get("topup_rp") or 0),
               "biaya_tagih_rp": int(f["biaya_tagih_rp"]), "rs": rs, "rs_id_template": f["rs_id"],
               "rs_id_unggah": cocok_rs(rs_list, rs["kabkota"], rs["kelas"], rs["kepemilikan"])}
        docs.append(doc)
        return doc

    # ---- ten ordinary claims
    P = [pasien(i) for i in range(20)]
    N = []
    for i, f in enumerate(urut):
        ubah = {}
        los = (d(f["tanggal_pulang"]) - d(f["tanggal_masuk"])).days
        if i == 1:  # N02: in on 19 Dec so that the unbundled return fits in the window
            ubah = {"tanggal_masuk": "2024-12-19", "tanggal_pulang": str(date(2024, 12, 19) + timedelta(days=min(los, 5)))}
        if i == 2:  # N03: in on 18 Dec, out by 21 Dec, so the readmission six days later fits too
            ubah = {"tanggal_masuk": "2024-12-18", "tanggal_pulang": str(date(2024, 12, 18) + timedelta(days=min(max(los, 1), 3)))}
        N.append(tambah(f"N{i + 1:02d}", "normal", "normal", [], f, P[i], "Rawat inap biasa: tagihan wajar, kode sesuai diagnosis, kelas sesuai hak.", **ubah))

    # ---- ten fraud claims
    single = [("dx_sekunder", ["M04"], "Diagnosis sekunder jauh lebih banyak dari klaim lain dengan kode yang sama (upcoding)."),
              ("topup_fiktif", ["M17"], "Top-up special CMG yang hampir tidak pernah ada untuk kode ini (obat/alkes fiktif)."),
              ("topup_inflasi", ["M07"], "Top-up special CMG berkali-kali lipat dari yang lazim untuk kode ini (inflated bills)."),
              ("prosedur_fiktif", ["M14"], "Kode INA-CBG kelompok prosedur, tetapi tidak ada satu tindakan pun (phantom procedure)."),
              ("kode_tidak_sesuai", ["M15"], "Kode INA-CBG yang hampir tidak pernah dipakai untuk diagnosis utama ini."),
              ("kelas_naik", ["M13"], "Peserta PBI dengan hak Kelas 3 dirawat dan ditagihkan di Kelas 1.")]
    for j, (sk, md, ket) in enumerate(single):
        f = contoh(sk)
        ubah = {"segmen": "PBI APBN", "hak_kelas": 3, "kelas_rawat": 1} if sk == "kelas_naik" else {}
        tambah(f"F{11 + j}", "fraud", sk, md, f, P[10 + j], ket, **ubah)
    n1, n2, n3 = N[0], N[1], N[2]
    base = lambda n: {k: n[k] for k in ("tanggal_masuk", "tanggal_pulang", "kelas_rawat", "hak_kelas", "segmen", "status_pulang", "diagnosis_utama",  # noqa: E731
                                        "diagnosis_sekunder", "tindakan", "inacbg_kode", "tarif_inacbg_rp", "topup_jenis", "topup_rp", "biaya_tagih_rp")} | {"rs_id": n["rs_id_template"]}
    who = lambda n: {k: n[k] for k in ("nama_pasien", "no_rm", "no_kartu")}  # noqa: E731
    tambah("F17", "fraud", "klaim_ganda", ["M11"], base(n1), who(n1),
           "Rawat inap N01 ditagihkan sekali lagi: pasien, RS, tanggal, kode, dan biaya sama, hanya nomor SEP berbeda (repeat billing).", butuh="N01")
    m2 = d(n2["tanggal_pulang"]) + timedelta(days=1)
    tambah("F18", "fraud", "pemecahan_episode", ["M09"], base(n2), who(n2),
           "Pasien N02 masuk lagi sehari setelah pulang, di RS yang sama, dengan diagnosis yang sama: satu perawatan ditagih dua kali (unbundling).",
           butuh="N02", tanggal_masuk=str(m2), tanggal_pulang=str(m2 + timedelta(days=2)), biaya_tagih_rp=int(round(n2["biaya_tagih_rp"] * 0.9, -2)))
    m3 = d(n3["tanggal_pulang"]) + timedelta(days=6)
    tambah("F19", "fraud", "readmisi", ["M16"], base(n3), who(n3),
           "Pasien N03 dirawat inap lagi enam hari setelah pulang, di RS yang sama, dengan diagnosis yang sama (readmisi).",
           butuh="N03", tanggal_masuk=str(m3), tanggal_pulang=str(min(W1, m3 + timedelta(days=3))))
    los0 = max(1, (d(tmpl_los["tanggal_pulang"]) - d(tmpl_los["tanggal_masuk"])).days)
    tambah("F20", "fraud", "los_panjang", ["M12"], tmpl_los, P[19],
           f"Lama rawat dibuat {min(13, max(4 * los0, 12))} hari, padahal klaim kode ini biasanya {los0} hari (prolonged LOS).",
           tanggal_masuk=str(W0), tanggal_pulang=str(W0 + timedelta(days=min(13, max(4 * los0, 12)))))

    for doc in docs:
        tulis_pdf(doc)
    (OUT / "harapan.json").write_text(json.dumps(docs, ensure_ascii=False, indent=1, default=str), "utf-8")
    baca_dulu(docs)
    for doc in docs:
        print(doc["file"], "·", doc["label"], "·", doc["rs"]["nama"], "·", doc["tanggal_masuk"], "→", doc["tanggal_pulang"], "·", doc["inacbg_kode"],
              "· profil sama:", doc["rs_id_unggah"] == doc["rs_id_template"])


def rp(x) -> str:
    return "-" if x in (None, "") else "Rp" + f"{int(x):,}".replace(",", ".")


def tgl(s: str) -> str:
    return "/".join(reversed(str(s)[:10].split("-")))


def tulis_pdf(v: dict) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    st = ParagraphStyle("isi", fontName="Helvetica", fontSize=9, leading=11.5)
    tb = ParagraphStyle("judul", fontName="Helvetica-Bold", fontSize=13, leading=16)
    kecil = ParagraphStyle("kecil", fontName="Helvetica-Oblique", fontSize=7.5, leading=9, textColor=colors.HexColor("#666666"))
    rs = v["rs"]
    lama = (date.fromisoformat(v["tanggal_pulang"]) - date.fromisoformat(v["tanggal_masuk"])).days

    def blok(judul: str, baris: list[tuple[str, str]]) -> Table:
        data = [[Paragraph(f"<b>{judul}</b>", st), ""]] + [[Paragraph(a, st), Paragraph(b, st)] for a, b in baris]
        t = Table(data, colWidths=[52 * mm, 118 * mm])
        t.setStyle(TableStyle([("SPAN", (0, 0), (1, 0)), ("BACKGROUND", (0, 0), (1, 0), colors.HexColor("#e8eef5")),
                               ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#b8c2cc")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        return t

    isi = [Paragraph(rs["nama"], tb),
           Paragraph(f"Rumah Sakit Kelas {rs['kelas'] or '-'} · {rs['kepemilikan']} · {rs['kabkota']}, {rs['provinsi']}", st), Spacer(1, 4 * mm),
           Paragraph(f"<b>{'RESUME MEDIS' if v['jenis_episode'] == 'ri' else 'CATATAN PELAYANAN'} DAN PENGAJUAN KLAIM INA-CBG</b>", st), Spacer(1, 3 * mm),
           blok("Rumah Sakit", [("Nama Rumah Sakit", rs["nama"]), ("Kelas Rumah Sakit", f"Kelas {rs['kelas'] or '-'}"), ("Kepemilikan", rs["kepemilikan"]),
                                ("Kabupaten/Kota", rs["kabkota"]), ("Provinsi", rs["provinsi"])]),
           Spacer(1, 3 * mm),
           blok("Pasien", [("Nama Pasien", v["nama_pasien"]), ("No. Rekam Medis", v["no_rm"]), ("No. SEP", v["no_sep"]), ("No. Kartu JKN", v["no_kartu"]),
                           ("Segmen Peserta", v["segmen"] or "-"), ("Hak Kelas", f"Kelas {v['hak_kelas']}")]),
           Spacer(1, 3 * mm),
           blok("Episode Perawatan", [("Jenis Rawat", JENIS[v["jenis_episode"]]), ("Tanggal Masuk", tgl(v["tanggal_masuk"])), ("Tanggal Keluar", tgl(v["tanggal_pulang"])),
                                      *([("Lama Rawat", f"{lama} hari"), ("Kelas Rawat", f"Kelas {v['kelas_rawat']}")] if v["jenis_episode"] == "ri" else []),
                                      ("Cara Pulang", v["status_pulang"])]),
           Spacer(1, 3 * mm),
           blok("Diagnosis dan Tindakan", [("Diagnosis Utama (ICD-10)", v["diagnosis_utama"]),
                                           ("Diagnosis Sekunder (ICD-10)", ", ".join(v["diagnosis_sekunder"]) or "-"),
                                           ("Tindakan/Prosedur (ICD-9-CM)", "<br/>".join(v["tindakan"]) or "-")]),
           Spacer(1, 3 * mm),
           blok("Klaim", [("Kode INA-CBG", v["inacbg_kode"]), ("Tarif INA-CBG", rp(v["tarif_inacbg_rp"])),
                          ("Special CMG (top-up)", f"{CMG.get(v['topup_jenis'], v['topup_jenis'])} · {rp(v['topup_rp'])}" if v["topup_rp"] else "Tidak ada"),
                          ("Total Tagihan Rumah Sakit", rp(v["biaya_tagih_rp"]))]),
           Spacer(1, 6 * mm),
           Paragraph(f"Dokumen sintetis untuk uji /testing ({v['kode']}). Nama pasien, nomor RM, SEP, kartu, dan rumah sakit fiktif; "
                     "bukan data pasien nyata.", kecil)]
    SimpleDocTemplate(str(OUT / v["file"]), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=16 * mm, bottomMargin=14 * mm,
                      title=f"Klaim {v['kode']}", author="Dokumen uji sintetis").build(isi)


def baca_dulu(docs: list[dict]) -> None:
    baris = ["Dokumen uji /testing: 10 klaim normal (N01-N10) dan 10 klaim fraud (F11-F20). Semua data fiktif (sintetis).",
             "", "Cara pakai: buka http://localhost:8320/testing, unggah satu PDF, periksa isian, lalu nilai klaimnya.",
             "Unggah N01-N10 dulu, baru F11-F20: F17, F18 dan F19 adalah pasangan N01, N02 dan N03 (pasien dan RS yang sama).",
             "Satu dokumen cukup sekali diunggah: mengunggah dokumen yang sama dua kali memang akan terbaca sebagai klaim ganda.", ""]
    for v in docs:
        baris.append(f"{v['file']:<34} {v['label'].upper():<7} {', '.join(v['modus']) or '-':<5} {v['keterangan']}"
                     + (f" (unggah setelah {v['unggah_setelah']})" if v["unggah_setelah"] else ""))
    (OUT / "BACA_DULU.txt").write_text("\n".join(baris) + "\n", "utf-8")


if __name__ == "__main__":
    main()
