"""Demo: JKN facility risk audit (POST /api/demo/jkn) — a transparent financial audit case for a hospital.

Creates the project "Demo Audit JKN (test)" with fictitious records of one hospital (RSUD Contoh Sejahtera), a
private hospital, a specialist clinic and three primary-care facilities (FKTP) for September 2026, and a Python
transforms repository "Deteksi Risiko JKN (demo)" (demo_jkn_rules.py) whose transforms screen the records for the
20 risk categories of BPJS Kesehatan's "Efisiensi Risiko pada Fasilitas Kesehatan" list, one findings dataset per
category plus temuan_semua. The repository is built once, so the findings, their lineage back to the records and
the build history are in place.

data/  peserta, dokter, faskes, kunjungan (SEP / INA-CBG claims), tarif_inacbg, tarif_prosedur, rujukan, kehadiran
       (attendance and vital signs), log_kamar, log_tindakan, resep, penyerahan_obat, harga_e_katalog, hasil_lab
       (with its edit log), kapitasi, belanja_kapitasi, klaim_nonkapitasi

Every record is generated (no real patient, doctor or facility). Ordinary records are consistent; a few cases per
category are planted (EXPECTED lists them), so each rule has something to find and nothing else to flag.
"""

from __future__ import annotations

import json
import logging
import random
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pyarrow as pa
from fastapi import APIRouter, HTTPException

import code_repos as cr
import db
import drive
import demo_jkn_rules
import pipeline_datasets

log = logging.getLogger("bluesandai.demo_jkn")
router = APIRouter(prefix="/api/demo/jkn")

PROJECT = "Demo Audit JKN (test)"
REPO = "Deteksi Risiko JKN - demo"
STATE: dict[str, Any] = {"status": "none"}
_lock = threading.Lock()
DIR: Path = Path()

CATEGORIES = [
    "Penyalahgunaan dana kapitasi/nonkapitasi", "Manipulasi klaim nonkapitasi", "Rujukan tidak sesuai",
    "Manipulasi diagnosis dan/atau tindakan (upcoding)", "Cloning (penjiplakan klaim)", "Phantom billing (klaim palsu)",
    "Inflated bills (penggelembungan tagihan obat)", "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)",
    "Services unbundling / fragmentation", "Self-referral (rujukan semu)", "Repeat billing (klaim berulang)", "Prolonged length of stay",
    "Manipulasi kelas perawatan (room charge)", "Menagihkan tindakan yang tidak dilakukan", "Tindakan pengobatan tidak sesuai indikasi medis",
    "Readmisi (admisi berulang)", "Klaim fiktif obat/alkes/tindakan", "Pengurangan jumlah obat", "Inflated bills (penggelembungan tagihan alkes)",
    "Manipulasi hasil pemeriksaan",
]
# the planted cases: category → the references its rule must find
EXPECTED: dict[int, set[str]] = {}


def configure(data_dir: Path) -> None:
    global DIR
    DIR = data_dir / "demo-jkn"
    DIR.mkdir(parents=True, exist_ok=True)
    saved = DIR / "state.json"
    if saved.is_file():
        try:
            STATE.update(json.loads(saved.read_text("utf-8")))
            if STATE.get("status") == "creating":
                STATE.update(status="failed", error="Interrupted by a server restart")
        except ValueError:
            pass


def _save() -> None:
    (DIR / "state.json").write_text(json.dumps(STATE, default=str, indent=1), "utf-8")


# --------------------------------------------------------------------------------------------
# the records
# --------------------------------------------------------------------------------------------

FIRST = ["Siti", "Budi", "Dewi", "Agus", "Rina", "Joko", "Ani", "Hendra", "Wati", "Eko", "Sri", "Bambang", "Yuni", "Rudi", "Lestari", "Dian", "Fajar", "Maya", "Iwan", "Nur"]
LAST = ["Rahayu", "Santoso", "Wijaya", "Pratama", "Lestari", "Hidayat", "Saputra", "Kusuma", "Nugroho", "Permata", "Siregar", "Harahap", "Sitompul", "Wibowo"]
# (INA-CBG base code, description, main diagnosis, tariff I / II / III) — tariffs are illustrative
RI_GROUPS = [
    ("J-4-16", "Pneumonia", "J18.9", 3_900_000, 5_200_000, 7_800_000),
    ("K-4-17", "Gastroenteritis dan nyeri abdomen", "A09", 2_850_000, 3_700_000, 5_400_000),
    ("I-4-12", "Gagal jantung", "I50.0", 5_100_000, 6_900_000, 9_600_000),
    ("E-4-10", "Diabetes melitus dengan komplikasi", "E11.6", 3_400_000, 4_600_000, 6_700_000),
    ("A-4-14", "Demam berdarah dengue", "A91", 2_600_000, 3_300_000, 4_900_000),
]
RJ_GROUPS = [("Q-5-44", "Konsultasi poli spesialis", 210_000), ("Q-5-42", "Pemeriksaan penunjang sederhana", 180_000)]
# the caesarean group of the planted case 15 (outside RI_GROUPS: the rules' base-tariff table leaves it out on purpose)
SC_GROUP = ("O-6-10", "Persalinan dengan sectio caesarea", "O82", 6_100_000, 7_300_000, 9_900_000)
OBAT = [("Ceftriaxone 1 g inj", 7_850), ("Omeprazole 40 mg inj", 12_400), ("Paracetamol infus 1 g", 18_900), ("Furosemide 40 mg inj", 3_200),
        ("Insulin glargine 100 IU/mL pen", 92_000)]
ALKES = [("IV catheter 22G", 6_500), ("Infus set dewasa", 9_800), ("Spuit 5 mL", 1_450), ("Kateter urin Foley 16Fr", 14_200)]
PROSEDUR = [("99.18", "Injeksi / infus obat", 150_000), ("87.44", "Foto toraks", 175_000), ("88.72", "Ekokardiografi", 650_000),
            ("74.1", "Sectio caesarea", 6_500_000), ("99.04", "Transfusi PRC", 950_000)]
POLI = ["Penyakit Dalam", "Jantung", "Paru", "Saraf", "Mata", "Rehabilitasi Medik"]


def generate(seed: int = 26) -> dict[str, pa.Table]:
    rnd = random.Random(seed)
    EXPECTED.clear()

    def plant(cat: int, ref: str) -> None:
        EXPECTED.setdefault(cat, set()).add(ref)

    faskes = [
        {"kode": "RS-01", "nama": "RSUD Contoh Sejahtera", "jenis": "FKRTL", "kepemilikan": "pemerintah daerah"},
        {"kode": "RS-02", "nama": "RS Harapan Contoh", "jenis": "FKRTL", "kepemilikan": "swasta"},
        {"kode": "KLU-07", "nama": "Klinik Utama Contoh Medika", "jenis": "FKRTL", "kepemilikan": "swasta"},
        {"kode": "PKM-01", "nama": "Puskesmas Contoh Barat", "jenis": "FKTP", "kepemilikan": "pemerintah daerah"},
        {"kode": "PKM-02", "nama": "Puskesmas Contoh Timur", "jenis": "FKTP", "kepemilikan": "pemerintah daerah"},
        {"kode": "KLP-03", "nama": "Klinik Pratama Contoh", "jenis": "FKTP", "kepemilikan": "swasta"},
    ]
    dokter = [{"id_dokter": f"D-{i:02d}", "nama": f"dr. {rnd.choice(FIRST)} {rnd.choice(LAST)}" + (", Sp.PD" if i <= 4 else ""),
               "faskes": "RS-01" if i <= 4 else ("PKM-01" if i <= 6 else "PKM-02"), "praktik_pribadi": None} for i in range(1, 9)]
    # dr. D-05 (Puskesmas Contoh Barat) also runs Klinik Utama Contoh Medika
    dokter[4]["praktik_pribadi"] = "KLU-07"
    peserta = []
    for i in range(1, 141):
        jk = "P" if i % 2 else "L"
        peserta.append({"no_kartu": f"000{1300000000 + i * 7919:010d}"[-13:], "nama": f"{rnd.choice(FIRST)} {rnd.choice(LAST)}", "jk": jk,
                        "tgl_lahir": date(1950 + rnd.randrange(55), rnd.randrange(1, 13), rnd.randrange(1, 28)), "hak_kelas": rnd.choice([1, 2, 3, 3]),
                        "tgl_meninggal": None})
    kartu = [p["no_kartu"] for p in peserta]
    by_kartu = {p["no_kartu"]: p for p in peserta}
    tarif = [{"kode_dasar": g[0], "deskripsi": g[1], "tarif_i": float(g[3]), "tarif_ii": float(g[4]), "tarif_iii": float(g[5])} for g in RI_GROUPS]
    tarif_prosedur = [{"kode_prosedur": p[0], "nama": p[1], "tarif": float(p[2])} for p in PROSEDUR]
    harga = [{"item": n, "jenis_item": "obat", "harga_e_katalog": float(h)} for n, h in OBAT] + [{"item": n, "jenis_item": "alkes", "harga_e_katalog": float(h)} for n, h in ALKES]
    price = {h["item"]: h for h in harga}

    sep: list[dict] = []
    hadir: list[dict] = []
    kamar: list[dict] = []
    tindakan: list[dict] = []
    resep: list[dict] = []
    serah: list[dict] = []
    lab: list[dict] = []
    seq = [0]

    def new_sep(**kw: Any) -> dict:
        seq[0] += 1
        s = {"no_sep": f"0301R0010926V{seq[0]:06d}", "faskes": "RS-01", "poli": None, "diag_sekunder": "", "prosedur": "", "naik_kelas": False,
             "dokter": "D-01", "cara_pulang": "sembuh", **kw}
        sep.append(s)
        return s

    def ri(no_kartu: str, group: tuple, masuk: date, days: int, severity: int = 1, **kw: Any) -> dict:
        p = by_kartu[no_kartu]
        lvl = ["I", "II", "III"][severity - 1]
        t = float(group[3 + severity - 1])
        s = new_sep(no_kartu=no_kartu, jenis="RI", tgl_masuk=masuk, tgl_pulang=masuk + timedelta(days=days), kelas_rawat=p["hak_kelas"],
                    diag_utama=group[2], severity=lvl, kode_dasar=group[0], kode_inacbg=f"{group[0]}-{lvl}", tarif_inacbg=t,
                    tarif_rs=round(t * rnd.uniform(0.85, 1.15), -3),
                    resume=kw.pop("resume", None) or f"Pasien {p['nama']} ({p['jk']}) dirawat dengan {group[1].lower()}, keluhan "
                    f"{rnd.choice(['demam', 'sesak', 'nyeri', 'lemas', 'mual'])} {rnd.randrange(1, 6)} hari, TD {rnd.randrange(100, 160)}/{rnd.randrange(60, 100)}, "
                    f"terapi sesuai standar, pulang {days} hari kemudian.", **kw)
        for d in range(days + 1):
            hadir.append({"no_sep": s["no_sep"], "tgl": masuk + timedelta(days=d), "tanda_vital": True, "petugas": f"perawat-{rnd.randrange(1, 9):02d}"})
            kamar.append({"no_sep": s["no_sep"], "tgl": masuk + timedelta(days=d), "kelas_aktual": s["kelas_rawat"], "bed": f"{s['kelas_rawat']}-{rnd.randrange(1, 40):02d}"})
        return s

    def rj(no_kartu: str, tgl: date, poli: str, faskes_kode: str = "RS-01", **kw: Any) -> dict:
        g = RJ_GROUPS[0] if poli != "Rehabilitasi Medik" else RJ_GROUPS[1]
        s = new_sep(no_kartu=no_kartu, jenis="RJ", tgl_masuk=tgl, tgl_pulang=tgl, kelas_rawat=3, diag_utama=rnd.choice(["I25.1", "I10", "E11.9", "M54.5"]),
                    severity="0", kode_dasar=g[0], kode_inacbg=f"{g[0]}-0", tarif_inacbg=float(g[2]), tarif_rs=float(g[2]), poli=poli, faskes=faskes_kode,
                    resume=f"Kontrol {poli.lower()} {by_kartu[no_kartu]['nama']}, keadaan stabil, nomor antrean {rnd.randrange(1, 200)}.", **kw)
        hadir.append({"no_sep": s["no_sep"], "tgl": tgl, "tanda_vital": True, "petugas": f"perawat-{rnd.randrange(1, 9):02d}"})
        return s

    def add_proc(s: dict, code: str, logged: bool = True) -> None:
        s["prosedur"] = ",".join([x for x in s["prosedur"].split(",") if x] + [code])
        if logged:
            tindakan.append({"no_sep": s["no_sep"], "kode_prosedur": code, "tgl": s["tgl_masuk"], "operator": s["dokter"]})

    def add_lab(s: dict, test: str, value: float, **kw: Any) -> None:
        lab.append({"no_sep": s["no_sep"], "pemeriksaan": test, "nilai": float(value), "nilai_awal": None, "diubah_at": None, "diubah_oleh": None,
                    "diperiksa_at": datetime.combine(s["tgl_masuk"], datetime.min.time(), timezone.utc) + timedelta(hours=10), **kw})

    nr = [0]

    def add_resep(s: dict, items: list[tuple[str, int]], bill_factor: dict[str, float] | None = None, given: dict[str, int | None] | None = None) -> str:
        nr[0] += 1
        no = f"RSP-0926-{nr[0]:05d}"
        for item, qty in items:
            unit = price[item]["harga_e_katalog"] * (bill_factor or {}).get(item, 1.0)
            resep.append({"no_resep": no, "no_sep": s["no_sep"], "faskes": s["faskes"], "item": item, "jenis_item": price[item]["jenis_item"],
                          "qty_resep": qty, "harga_tagih": round(unit * qty, 2)})
            g = (given or {}).get(item, qty)
            if g is not None:
                serah.append({"no_resep": no, "item": item, "qty_diserahkan": g, "petugas_farmasi": f"apoteker-{rnd.randrange(1, 4)}"})
        return no

    # -- ordinary care: one inpatient stay for some members, outpatient visits for others --
    start = date(2026, 9, 1)
    pool = kartu[:]
    rnd.shuffle(pool)
    # members with no ordinary records carry the planted cases
    inpatients, outpatients, spare = pool[:60], pool[60:110], pool[110:]
    for i, k in enumerate(inpatients):
        g = RI_GROUPS[i % len(RI_GROUPS)]
        s = ri(k, g, start + timedelta(days=rnd.randrange(0, 20)), rnd.randrange(2, 5), dokter=f"D-0{1 + i % 4}")
        add_proc(s, "99.18")
        if g[0] == "J-4-16":
            add_proc(s, "87.44")
        add_lab(s, "Hb", round(rnd.uniform(11, 15), 1))
        add_resep(s, [(OBAT[i % 4][0], rnd.randrange(3, 10)), (ALKES[i % 4][0], rnd.randrange(1, 4))])
    for i, k in enumerate(outpatients):
        rj(k, start + timedelta(days=rnd.randrange(0, 28)), POLI[i % 5], dokter=f"D-0{1 + i % 4}")

    # -- planted cases --
    women = [x for x in spare if by_kartu[x]["jk"] == "P"]
    sp = iter([x for x in spare if x not in women[-2:]])

    # 4 upcoding: anaemia as secondary diagnosis (severity III) with a normal Hb
    s = ri(next(sp), RI_GROUPS[0], date(2026, 9, 9), 3, severity=3, diag_sekunder="D64.9", dokter="D-02")
    add_lab(s, "Hb", 12.6)
    add_proc(s, "99.18")
    plant(4, s["no_sep"])
    # 5 cloning: two patients, the same discharge summary
    text = "Pasien datang dengan demam tinggi 4 hari, trombosit 85.000, diberikan cairan kristaloid, keadaan membaik dan pulang dengan kontrol poli."
    a = ri(next(sp), RI_GROUPS[4], date(2026, 9, 11), 3, dokter="D-03", resume=text)
    b = ri(next(sp), RI_GROUPS[4], date(2026, 9, 12), 3, dokter="D-03", resume=text)
    plant(5, b["no_sep"])
    # 6 phantom billing: no attendance record; a visit after the member's death
    s = ri(next(sp), RI_GROUPS[1], date(2026, 9, 14), 2, dokter="D-04")
    hadir[:] = [h for h in hadir if h["no_sep"] != s["no_sep"]]
    plant(6, s["no_sep"])
    dead = next(sp)
    by_kartu[dead]["tgl_meninggal"] = date(2026, 8, 20)
    s = rj(dead, date(2026, 9, 3), "Jantung")
    plant(6, s["no_sep"])
    # 7 / 19 / 17 / 18: pharmacy
    s = ri(next(sp), RI_GROUPS[3], date(2026, 9, 6), 3, dokter="D-01")
    plant(7, add_resep(s, [("Insulin glargine 100 IU/mL pen", 3)], bill_factor={"Insulin glargine 100 IU/mL pen": 1.6}))
    plant(19, add_resep(s, [("Kateter urin Foley 16Fr", 2)], bill_factor={"Kateter urin Foley 16Fr": 2.5}))
    plant(17, add_resep(s, [("Paracetamol infus 1 g", 6)], given={"Paracetamol infus 1 g": None}))
    plant(18, add_resep(s, [("Ceftriaxone 1 g inj", 10)], given={"Ceftriaxone 1 g inj": 6}))
    # 8 episode splitting: two outpatient SEPs on one day
    k8 = next(sp)
    rj(k8, date(2026, 9, 16), "Penyakit Dalam")
    plant(8, rj(k8, date(2026, 9, 16), "Mata")["no_sep"])
    # 9 unbundling: an outpatient visit during an inpatient stay
    k9 = next(sp)
    ri(k9, RI_GROUPS[2], date(2026, 9, 17), 4, dokter="D-02")
    plant(9, rj(k9, date(2026, 9, 19), "Rehabilitasi Medik")["no_sep"])
    # 11 repeat billing: the same stay claimed under a second SEP
    k11 = next(sp)
    first = ri(k11, RI_GROUPS[1], date(2026, 9, 4), 2, dokter="D-03")
    dup = new_sep(**{**{x: v for x, v in first.items() if x != "no_sep"}})
    hadir.append({"no_sep": dup["no_sep"], "tgl": dup["tgl_masuk"], "tanda_vital": True, "petugas": "perawat-01"})
    kamar.append({"no_sep": dup["no_sep"], "tgl": dup["tgl_masuk"], "kelas_aktual": dup["kelas_rawat"], "bed": "x"})
    plant(11, dup["no_sep"])
    # 12 prolonged stay
    s = ri(next(sp), RI_GROUPS[1], date(2026, 9, 2), 14, dokter="D-04")
    plant(12, s["no_sep"])
    # 13 room charge: class 1 claimed, a class 3 bed occupied
    k13 = next(sp)
    by_kartu[k13]["hak_kelas"] = 3
    s = ri(k13, RI_GROUPS[0], date(2026, 9, 8), 3, dokter="D-01")
    s["kelas_rawat"] = 1
    plant(13, s["no_sep"])
    # 14 a procedure claimed with no procedure log
    s = ri(next(sp), RI_GROUPS[2], date(2026, 9, 10), 3, dokter="D-02")
    add_proc(s, "88.72", logged=False)
    plant(14, s["no_sep"])
    # 15 caesarean without an indication; transfusion with a normal Hb
    s = ri(women[-1], SC_GROUP, date(2026, 9, 13), 3, dokter="D-01")
    s["diag_utama"] = "Z37.0"
    add_proc(s, "74.1")
    plant(15, s["no_sep"])
    s = ri(next(sp), RI_GROUPS[3], date(2026, 9, 18), 3, dokter="D-01")
    add_lab(s, "Hb", 11.2)
    add_proc(s, "99.04")
    plant(15, s["no_sep"])
    # 16 readmission 3 days later with the same diagnosis
    k16 = next(sp)
    a = ri(k16, RI_GROUPS[0], date(2026, 9, 3), 3, dokter="D-02")
    b = ri(k16, RI_GROUPS[0], a["tgl_pulang"] + timedelta(days=3), 3, dokter="D-02")
    plant(16, b["no_sep"])
    # 20 a lab result edited after discharge
    s = ri(next(sp), RI_GROUPS[4], date(2026, 9, 5), 3, dokter="D-03")
    add_lab(s, "Trombosit", 48_000, nilai_awal=152_000.0, diubah_at=datetime(2026, 9, 10, 21, 40, tzinfo=timezone.utc), diubah_oleh="lab-user-07")
    plant(20, s["no_sep"])

    # -- referrals --
    rujukan = []
    for i in range(30):
        rujukan.append({"no_rujukan": f"0301R0020926B{i + 1:06d}", "no_kartu": outpatients[i], "dari_faskes": "PKM-01" if i % 2 else "PKM-02",
                        "ke_faskes": "RS-01", "dokter_perujuk": "D-06" if i % 2 else "D-07", "diagnosa": rnd.choice(["I25.1", "N18.5", "C50.9", "H25.9", "G40.9"]),
                        "alasan_rujuk": "kompetensi spesialis", "tgl": start + timedelta(days=i % 28)})
    rujukan.append({"no_rujukan": "0301R0020926B000901", "no_kartu": outpatients[40], "dari_faskes": "PKM-02", "ke_faskes": "RS-01", "dokter_perujuk": "D-07",
                    "diagnosa": "J06.9", "alasan_rujuk": "permintaan pasien", "tgl": date(2026, 9, 15)})
    plant(3, "0301R0020926B000901")
    rujukan.append({"no_rujukan": "0301R0020926B000902", "no_kartu": outpatients[41], "dari_faskes": "PKM-01", "ke_faskes": "KLU-07", "dokter_perujuk": "D-05",
                    "diagnosa": "I25.1", "alasan_rujuk": "kompetensi spesialis", "tgl": date(2026, 9, 15)})
    plant(10, "0301R0020926B000902")

    # -- capitation and non-capitation (FKTP) --
    kapitasi, belanja = [], []
    for f in ("PKM-01", "PKM-02"):
        for m in ("2026-07", "2026-08"):
            dana = float(rnd.randrange(180, 260) * 1_000_000)
            share = 0.52 if (f, m) == ("PKM-01", "2026-08") else rnd.uniform(0.62, 0.7)
            kapitasi.append({"faskes": f, "bulan": m, "dana_diterima": dana, "jasa_pelayanan": round(dana * share, -3), "operasional": round(dana * (1 - share), -3)})
            for j, (u, kat) in enumerate([("Obat dan BMHP", "obat"), ("Perawatan alat medis", "operasional pelayanan"), ("Bahan habis pakai", "bahan medis habis pakai")]):
                belanja.append({"no_bukti": f"BK-{f}-{m}-{j + 1}", "faskes": f, "tgl": date(int(m[:4]), int(m[5:]), 10 + j), "uraian": u, "kategori": kat,
                                "jumlah": float(rnd.randrange(5, 30) * 1_000_000)})
    plant(1, "PKM-01 2026-08")
    belanja.append({"no_bukti": "BK-PKM-02-2026-08-9", "faskes": "PKM-02", "tgl": date(2026, 8, 28), "uraian": "Perjalanan dinas studi banding kepala puskesmas",
                    "kategori": "perjalanan dinas", "jumlah": 38_500_000.0})
    plant(1, "BK-PKM-02-2026-08-9")
    nonkap = []
    moms = [x for x in kartu if by_kartu[x]["jk"] == "P"][:8]
    for i, m in enumerate(moms):
        nonkap.append({"no_klaim": f"NK-0926-{i + 1:04d}", "faskes": "KLP-03", "no_kartu": m, "jenis_layanan": "persalinan", "tgl": date(2026, 9, 1 + i * 3),
                       "tarif": 1_000_000.0})
    man = next(x for x in kartu if by_kartu[x]["jk"] == "L")
    nonkap.append({"no_klaim": "NK-0926-0101", "faskes": "KLP-03", "no_kartu": man, "jenis_layanan": "persalinan", "tgl": date(2026, 9, 20), "tarif": 1_000_000.0})
    plant(2, "NK-0926-0101")
    # a delivery claimed in May for the first mother: her September delivery comes 122 days later
    nonkap.append({"no_klaim": "NK-0526-0001", "faskes": "KLP-03", "no_kartu": moms[0], "jenis_layanan": "persalinan", "tgl": date(2026, 5, 2), "tarif": 1_000_000.0})
    plant(2, "NK-0926-0001")

    def table(rows: list[dict], schema: list[tuple[str, pa.DataType]]) -> pa.Table:
        return pa.Table.from_pylist(rows, schema=pa.schema(schema))

    s = pa.string()
    out = {
        "faskes": table(faskes, [("kode", s), ("nama", s), ("jenis", s), ("kepemilikan", s)]),
        "dokter": table(dokter, [("id_dokter", s), ("nama", s), ("faskes", s), ("praktik_pribadi", s)]),
        "peserta": table(list(by_kartu.values()), [("no_kartu", s), ("nama", s), ("jk", s), ("tgl_lahir", pa.date32()), ("hak_kelas", pa.int32()), ("tgl_meninggal", pa.date32())]),
        "kunjungan": table(sep, [("no_sep", s), ("no_kartu", s), ("faskes", s), ("jenis", s), ("poli", s), ("tgl_masuk", pa.date32()), ("tgl_pulang", pa.date32()),
                                 ("kelas_rawat", pa.int32()), ("naik_kelas", pa.bool_()), ("dokter", s), ("diag_utama", s), ("diag_sekunder", s), ("prosedur", s),
                                 ("severity", s), ("kode_dasar", s), ("kode_inacbg", s), ("tarif_inacbg", pa.float64()), ("tarif_rs", pa.float64()),
                                 ("cara_pulang", s), ("resume", s)]),
        "tarif_inacbg": table(tarif, [("kode_dasar", s), ("deskripsi", s), ("tarif_i", pa.float64()), ("tarif_ii", pa.float64()), ("tarif_iii", pa.float64())]),
        "tarif_prosedur": table(tarif_prosedur, [("kode_prosedur", s), ("nama", s), ("tarif", pa.float64())]),
        "rujukan": table(rujukan, [("no_rujukan", s), ("no_kartu", s), ("dari_faskes", s), ("ke_faskes", s), ("dokter_perujuk", s), ("diagnosa", s),
                                   ("alasan_rujuk", s), ("tgl", pa.date32())]),
        "kehadiran": table(hadir, [("no_sep", s), ("tgl", pa.date32()), ("tanda_vital", pa.bool_()), ("petugas", s)]),
        "log_kamar": table(kamar, [("no_sep", s), ("tgl", pa.date32()), ("kelas_aktual", pa.int32()), ("bed", s)]),
        "log_tindakan": table(tindakan, [("no_sep", s), ("kode_prosedur", s), ("tgl", pa.date32()), ("operator", s)]),
        "resep": table(resep, [("no_resep", s), ("no_sep", s), ("faskes", s), ("item", s), ("jenis_item", s), ("qty_resep", pa.int32()), ("harga_tagih", pa.float64())]),
        "penyerahan_obat": table(serah, [("no_resep", s), ("item", s), ("qty_diserahkan", pa.int32()), ("petugas_farmasi", s)]),
        "harga_e_katalog": table(harga, [("item", s), ("jenis_item", s), ("harga_e_katalog", pa.float64())]),
        "hasil_lab": table(lab, [("no_sep", s), ("pemeriksaan", s), ("nilai", pa.float64()), ("nilai_awal", pa.float64()), ("diperiksa_at", pa.timestamp("us", tz="UTC")),
                                 ("diubah_at", pa.timestamp("us", tz="UTC")), ("diubah_oleh", s)]),
        "kapitasi": table(kapitasi, [("faskes", s), ("bulan", s), ("dana_diterima", pa.float64()), ("jasa_pelayanan", pa.float64()), ("operasional", pa.float64())]),
        "belanja_kapitasi": table(belanja, [("no_bukti", s), ("faskes", s), ("tgl", pa.date32()), ("uraian", s), ("kategori", s), ("jumlah", pa.float64())]),
        "klaim_nonkapitasi": table(nonkap, [("no_klaim", s), ("faskes", s), ("no_kartu", s), ("jenis_layanan", s), ("tgl", pa.date32()), ("tarif", pa.float64())]),
    }
    return out


# --------------------------------------------------------------------------------------------
# the project, the repository, the build
# --------------------------------------------------------------------------------------------


def _folder(parent: Optional[str], name: str, kind: str = "folder") -> str:
    found = next((c for c in db.drive_list(parent) if c["name"] == name and c["kind"] in drive.CONTAINERS and not c.get("trashed_at")), None)
    return found["id"] if found else drive._insert_container(parent, kind, name)


def _put(folder_id: str, name: str, table: pa.Table) -> None:
    data = pipeline_datasets._parquet_bytes(table)
    existing = next((f for f in drive.list_files(folder_id) if f["name"] == f"{name}.parquet" and not f.get("trashed_at")), None)
    if existing:
        pipeline_datasets._replace_content(existing, data)
    else:
        drive.save_bytes(folder_id, f"{name}.parquet", data, pipeline_datasets.PARQUET)


def _create() -> None:
    try:
        project = _folder(None, PROJECT, "project")
        data = _folder(project, "data")
        _folder(project, "temuan")
        tables = generate()
        for name, t in tables.items():
            _put(data, name, t)
        STATE.update(project_id=project, tables={k: v.num_rows for k, v in tables.items()}, expected={str(k): sorted(v) for k, v in EXPECTED.items()})
        _save()
        repo = next((r for r in cr.list_repos() if r["name"] == REPO), None)
        if not repo:
            repo = cr.create_repo(cr.RepoIn(name=REPO, description="Screening rules for the 20 JKN facility risk categories (demo data)"))
        with cr._lock:
            rec = cr._repo(repo["id"])
            rec["branches"][rec["default_branch"]]["files"] = demo_jkn_rules.files("/" + PROJECT, cr.REPO_SETTINGS)
            cr._save(rec)
            cr._commit(rec, rec["default_branch"], "JKN risk screening rules")
        STATE.update(repo_id=repo["id"])
        _save()
        rec = cr._repo(repo["id"])
        br = cr._branch(rec, None)
        listed = cr._run(br["files"], {"mode": "list"}, rec)
        if not listed.get("ok"):
            raise RuntimeError(listed.get("error") or "the repository does not load")
        errors = [e for e in listed.get("errors") or [] if not e.get("warning")]
        if errors:
            raise RuntimeError(f"{errors[0]['file']}: {errors[0]['error']}")
        keys = sorted((t for t in listed["transforms"]), key=lambda t: (t["function"] == "temuan_semua", t["function"]))
        built = []
        for t in keys:
            b = cr.build_transform(rec, br["files"], br["name"], t["key"], "manual", br["head"], listed)
            built.append({"transform": t["function"], "status": b["status"], "error": (b.get("error") or "")[-500:] or None})
            STATE.update(builds=built)
            _save()
        failed = [b for b in built if b["status"] != "succeeded"]
        STATE.update(status="failed" if failed else "ready", error=f"{failed[0]['transform']}: {failed[0]['error']}" if failed else None,
                     created_at=datetime.now(timezone.utc).isoformat())
    except Exception as e:  # noqa: BLE001
        log.exception("JKN demo failed")
        STATE.update(status="failed", error=str(getattr(e, "detail", e))[:2000])
    _save()


@router.post("")
def create() -> dict:
    drive._require_db()
    with _lock:
        if STATE.get("status") == "creating":
            raise HTTPException(409, "The demo is being created")
        STATE.clear()
        STATE.update(status="creating")
        _save()
    threading.Thread(target=_create, daemon=True, name="demo-jkn").start()
    return get()


def _findings() -> tuple[Optional[dict], list[dict]]:
    if not STATE.get("project_id"):
        return None, []
    try:
        item = cr.resolve_dataset(f"/{PROJECT}/temuan/temuan_semua")
    except (ValueError, HTTPException):
        return None, []
    import io

    import pyarrow.parquet as pq

    return item, pq.read_table(io.BytesIO(drive.read_bytes(item))).to_pylist()


@router.get("")
def get() -> dict:
    item, found = _findings() if STATE.get("status") == "ready" else (None, [])
    summary = []
    for i, name in enumerate(CATEGORIES, 1):
        rows = [f for f in found if f["kategori_no"] == i]
        summary.append({"no": i, "kategori": name, "temuan": len(rows), "nilai_risiko": round(sum(r["nilai_risiko"] for r in rows), 2),
                        "planted": len(STATE.get("expected", {}).get(str(i), []))})
    return {**STATE, "categories": summary, "findings": found, "findings_dataset_id": item["id"] if item else None}
