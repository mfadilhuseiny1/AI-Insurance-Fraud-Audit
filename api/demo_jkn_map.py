"""Demo: the facilities the JKN audit team has to look at, on a map (POST /api/demo/jkn/map).

Fictitious facilities (no real hospital or clinic) placed inland in Central Java, each with an audit status:

- Sehat — no anomaly in the claims;
- Perlu Pemantauan — light anomalies, watched next period;
- Ada Indikasi Fraud — screening found one of the 20 risk subcategories, an audit is to be scheduled;
- Dalam Investigasi — priority, the investigation team is on it;
- Selesai Diaudit — audited, the overpayment is being recovered.

The six facilities of the JKN demo (demo_jkn.py: RSUD Contoh Sejahtera, Puskesmas Contoh Barat, …) are among them,
with the status their planted cases imply. Object type "Faskes Audit JKN (demo)" and the map "Demo: Peta audit faskes
JKN" with one layer per status.

The flow behind the statuses, for Vertex: "Dokter Audit JKN (demo)" (the doctors of the flagged facilities; the JKN
demo's D-01 … D-08 among them) and "Kasus Rujukan Berisiko JKN (demo)" (a referral or claim case from one facility to
another: rujukan tidak sesuai from a puskesmas to a hospital, self-referral by a doctor who also runs the receiving
clinic, upcoding / phantom billing by the receiving DPJP …), linked to the facilities and doctors. Vertex graphs:
"Demo: Alur kasus berisiko faskes JKN" (facility → case → facility, referring doctor → case → DPJP), "Demo: Aliran
rujukan berisiko antar faskes" (the cases drawn as edges between facilities) and the template "Demo: Telusuri faskes
audit JKN" (a facility → its cases → the other facilities and the doctors), which the map runs for a clicked facility.

Seeded and idempotent: what exists is kept, and nothing is ever deleted.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any, Optional

from fastapi import APIRouter

import geospatial
import ontology

router = APIRouter(prefix="/api/demo/jkn/map")

FASKES = "Faskes Audit JKN (demo)"
MAP = "Demo: Peta audit faskes JKN"
DOKTER = "Dokter Audit JKN (demo)"
KASUS = "Kasus Rujukan Berisiko JKN (demo)"
# link types: (name, source type, foreign key, target type, arrow from the target to the source)
L_ASAL, L_TUJUAN, L_PERUJUK, L_DPJP, L_PRAKTIK = ("Kasus dari faskes (demo)", "Kasus ke faskes (demo)", "Dokter perujuk kasus (demo)",
                                                  "DPJP kasus (demo)", "Dokter praktik di faskes (demo)")
G_ALUR = "Demo: Alur kasus berisiko faskes JKN"
G_ALIRAN = "Demo: Aliran rujukan berisiko antar faskes"
G_TEMPLATE = "Demo: Telusuri faskes audit JKN"
TODAY = date(2026, 10, 10)

# status → (layer colour, risk score range, share of the generated facilities)
STATUS = {
    "Sehat": ("#22c55e", (5, 30), 0.50),
    "Perlu Pemantauan": ("#facc15", (31, 55), 0.22),
    "Ada Indikasi Fraud": ("#f97316", (56, 79), 0.15),
    "Dalam Investigasi": ("#ef4444", (80, 98), 0.06),
    "Selesai Diaudit": ("#a78bfa", (40, 75), 0.07),
}
# the 20 subcategories of "Efisiensi Risiko pada Fasilitas Kesehatan", split by where they occur
FKRTL_RISKS = ["Manipulasi diagnosis dan/atau tindakan (upcoding)", "Cloning (penjiplakan klaim)", "Phantom billing (klaim palsu)",
               "Inflated bills (penggelembungan tagihan obat)", "Pemecahan episode", "Unbundling / fragmentation", "Self-referral",
               "Repeat billing", "Prolonged length of stay", "Manipulasi kelas perawatan", "Menagihkan tindakan yang tidak dilakukan",
               "Tindakan tidak sesuai indikasi medis", "Readmisi", "Klaim fiktif obat/alkes", "Manipulasi hasil pemeriksaan penunjang"]
FKTP_RISKS = ["Penyalahgunaan dana kapitasi/nonkapitasi", "Manipulasi klaim nonkapitasi", "Rujukan tidak sesuai",
              "Pengurangan jumlah obat", "Inflated bills obat/alkes"]
# the JKN demo's facilities (demo_jkn.py) and what their planted cases make them
KNOWN = [
    ("RS-01", "RSUD Contoh Sejahtera", "RS Tipe B", "pemerintah daerah", "Dalam Investigasi", "Manipulasi diagnosis dan/atau tindakan (upcoding)", -6.985, 110.405),
    ("RS-02", "RS Harapan Contoh", "RS Tipe C", "swasta", "Sehat", "", -7.020, 110.460),
    ("KLU-07", "Klinik Utama Contoh Medika", "Klinik Utama", "swasta", "Ada Indikasi Fraud", "Self-referral", -7.005, 110.430),
    ("PKM-01", "Puskesmas Contoh Barat", "Puskesmas", "pemerintah daerah", "Ada Indikasi Fraud", "Penyalahgunaan dana kapitasi/nonkapitasi", -7.060, 110.330),
    ("PKM-02", "Puskesmas Contoh Timur", "Puskesmas", "pemerintah daerah", "Perlu Pemantauan", "Rujukan tidak sesuai", -7.050, 110.520),
    ("KLP-03", "Klinik Pratama Contoh", "Klinik Pratama", "swasta", "Sehat", "", -7.090, 110.410),
]
# fictitious regencies, each a box of land (lat0, lat1, lon0, lon1) and its BPJS branch office
WILAYAH = [
    ("Kota Contoh", (-7.10, -6.98, 110.32, 110.52), "KC Contoh Kota"),
    ("Kabupaten Contoh Utara", (-7.30, -7.12, 110.20, 110.55), "KC Contoh Kabupaten"),
    ("Kabupaten Contoh Selatan", (-7.70, -7.45, 110.25, 110.60), "KC Contoh Kabupaten"),
    ("Kota Contoh Raya", (-7.62, -7.50, 110.75, 110.88), "KC Contoh Raya"),
    ("Kabupaten Contoh Timur", (-7.45, -7.15, 110.65, 110.98), "KC Contoh Raya"),
]
JENIS = [("RS Tipe A", 0.03), ("RS Tipe B", 0.08), ("RS Tipe C", 0.17), ("RS Tipe D", 0.12), ("Klinik Utama", 0.10),
         ("Puskesmas", 0.30), ("Klinik Pratama", 0.15), ("Dokter Praktik Perorangan", 0.05)]
NAMA = ["Husada", "Medika", "Mitra Sehat", "Bakti", "Permata", "Sentosa", "Kasih Ibu", "Harapan Bunda", "Amanah", "Sejahtera",
        "Nusantara", "Mulia", "Santo Contoh", "Islam Contoh", "Bhakti Wiyata", "Pelita", "Cahaya", "Asih", "Prima", "Lestari"]
# the map draws the last layer on top: the most urgent last
LAYER_ORDER = ["Sehat", "Selesai Diaudit", "Perlu Pemantauan", "Ada Indikasi Fraud", "Dalam Investigasi"]
AUDITOR = ["Tim Audit A (KC Contoh Kota)", "Tim Audit B (KC Contoh Kabupaten)", "Tim Audit C (KC Contoh Raya)", "Tim Investigasi Kedeputian Wilayah"]


def _type(name: str) -> Optional[dict]:
    return next((t for t in ontology._all("object-types") if t["display_name"] == name), None)


def _p(api: str, name: str, typ: str = "string", **kw: Any) -> ontology.Property:
    return ontology.Property(api_name=api, display_name=name, type=typ, **kw)


def _pick(rnd: random.Random, weighted: list[tuple[str, float]]) -> str:
    return rnd.choices([k for k, _ in weighted], weights=[w for _, w in weighted])[0]


def _row(rnd: random.Random, kode: str, nama: str, jenis: str, milik: str, status: str, indikasi: str, lat: float, lon: float,
         wilayah: str, kc: str) -> dict:
    rs = jenis.startswith("RS") or jenis == "Klinik Utama"
    lo, hi = STATUS[status][1]
    skor = rnd.randint(lo, hi)
    if status != "Sehat" and not indikasi:
        indikasi = rnd.choice(FKRTL_RISKS if rs else FKTP_RISKS)
    klaim = rnd.randint(1800, 9000) if jenis in ("RS Tipe A", "RS Tipe B") else rnd.randint(500, 2500) if rs else rnd.randint(150, 900)
    share = {"Sehat": 0.0, "Perlu Pemantauan": 0.01, "Ada Indikasi Fraud": 0.04, "Dalam Investigasi": 0.08, "Selesai Diaudit": 0.03}[status]
    berisiko = int(klaim * share * rnd.uniform(0.6, 1.4)) + (0 if status == "Sehat" else 1)
    rata = rnd.uniform(4.5e6, 9e6) if rs else rnd.uniform(1.2e5, 3.5e5)
    nilai = round(klaim * rata, -5)
    potensi = round(berisiko * rata * rnd.uniform(0.4, 0.9), -4) if status != "Sehat" else 0.0
    plan = {"Sehat": "", "Perlu Pemantauan": (TODAY + timedelta(days=rnd.randint(45, 90))).isoformat(),
            "Ada Indikasi Fraud": (TODAY + timedelta(days=rnd.randint(5, 30))).isoformat(),
            "Dalam Investigasi": (TODAY - timedelta(days=rnd.randint(3, 20))).isoformat(),
            "Selesai Diaudit": (TODAY - timedelta(days=rnd.randint(30, 90))).isoformat()}[status]
    return {
        "kode": kode, "nama": nama, "judul": f"{nama} · {status}", "lokasi": f"{lat:.5f},{lon:.5f}", "jenis": jenis,
        "tingkat": "FKRTL" if rs else "FKTP", "kepemilikan": milik, "wilayah": wilayah, "kantor_cabang": kc,
        "status_audit": status, "skor_risiko": skor,
        "prioritas": "P1 — segera" if status == "Dalam Investigasi" else "P2 — jadwalkan audit" if status == "Ada Indikasi Fraud"
                     else "P3 — pantau" if status == "Perlu Pemantauan" else "-",
        "indikasi_utama": indikasi, "klaim_3_bulan": klaim, "klaim_berisiko": berisiko, "nilai_klaim_rp": nilai,
        "potensi_kerugian_rp": potensi,
        "pengembalian_rp": round(potensi * rnd.uniform(0.5, 1.0), -4) if status == "Selesai Diaudit" else 0.0,
        "tim_audit": "" if status == "Sehat" else AUDITOR[3] if status == "Dalam Investigasi" else rnd.choice(AUDITOR[:3]),
        "tanggal_audit": plan,
    }


def generate(seed: int = 26) -> list[dict]:
    rnd = random.Random(seed)
    rows = [_row(rnd, k, n, j, m, s, i, la, lo, "Kota Contoh", "KC Contoh Kota") for k, n, j, m, s, i, la, lo in KNOWN]
    statuses = [(s, v[2]) for s, v in STATUS.items()]
    used: set[str] = {r["nama"] for r in rows}
    for n in range(1, 55):
        wil, (la0, la1, lo0, lo1), kc = WILAYAH[n % len(WILAYAH)]
        jenis = _pick(rnd, JENIS)
        prefix = {"Puskesmas": "Puskesmas", "Klinik Pratama": "Klinik Pratama", "Klinik Utama": "Klinik Utama",
                  "Dokter Praktik Perorangan": "dr. Praktik"}.get(jenis, "RSUD" if rnd.random() < 0.35 else "RS")
        nama = f"{prefix} {rnd.choice(NAMA)} {wil.split()[-1]}"
        while nama in used:
            nama = f"{prefix} {rnd.choice(NAMA)} {wil.split()[-1]} {rnd.randint(2, 9)}"
        used.add(nama)
        milik = "pemerintah daerah" if prefix in ("Puskesmas", "RSUD") else "swasta"
        code = {"Puskesmas": "PKM", "Klinik Pratama": "KLP", "Klinik Utama": "KLU", "Dokter Praktik Perorangan": "DPP"}.get(jenis, "RS")
        rows.append(_row(rnd, f"{code}-{100 + n}", nama, jenis, milik, _pick(rnd, statuses), "", rnd.uniform(la0, la1), rnd.uniform(lo0, lo1), wil, kc))
    return rows


def _ensure_type() -> tuple[dict, bool]:
    t = _type(FASKES)
    if t:
        return t, False
    return ontology.create_object_type(ontology.ObjectTypeIn(
        display_name=FASKES, plural_name=FASKES, api_name="FaskesAuditJknDemo", primary_key="kode", title_property="nama",
        icon="alert", color="#ef4444",
        description="Demo: fasilitas kesehatan fiktif dengan koordinat dan status audit JKN (Sehat, Perlu Pemantauan, Ada Indikasi "
                    "Fraud, Dalam Investigasi, Selesai Diaudit) dari skrining 20 subkategori Efisiensi Risiko pada Fasilitas Kesehatan.",
        properties=[_p("kode", "Kode faskes", render_hints=["searchable", "identifier"]), _p("nama", "Nama", render_hints=["searchable"]),
                    _p("judul", "Judul", render_hints=["searchable"]), _p("lokasi", "Koordinat", "geopoint"),
                    _p("jenis", "Jenis faskes", render_hints=["searchable", "selectable"]), _p("tingkat", "FKTP / FKRTL", render_hints=["selectable"]),
                    _p("kepemilikan", "Kepemilikan", render_hints=["selectable"]), _p("wilayah", "Kabupaten/kota", render_hints=["searchable", "selectable"]),
                    _p("kantor_cabang", "Kantor cabang", render_hints=["selectable"]),
                    _p("status_audit", "Status audit", render_hints=["searchable", "selectable"]), _p("skor_risiko", "Skor risiko (0–100)", "integer"),
                    _p("prioritas", "Prioritas", render_hints=["selectable"]), _p("indikasi_utama", "Indikasi utama", render_hints=["searchable", "selectable"]),
                    _p("klaim_3_bulan", "Jumlah klaim (3 bulan)", "integer"), _p("klaim_berisiko", "Klaim berisiko", "integer"),
                    _p("nilai_klaim_rp", "Nilai klaim (Rp)", "double"), _p("potensi_kerugian_rp", "Potensi kerugian (Rp)", "double"),
                    _p("pengembalian_rp", "Pengembalian dana (Rp)", "double"), _p("tim_audit", "Tim audit", render_hints=["selectable"]),
                    _p("tanggal_audit", "Tanggal audit (rencana / mulai / selesai)", "date")])), True


# ------------------------------------------------------------------------------------------------
# the flow behind the statuses: doctors and risky referral / claim cases between facilities (Vertex)
# ------------------------------------------------------------------------------------------------

FIRST = ["Andi", "Budi", "Citra", "Dewi", "Eko", "Fajar", "Gita", "Hendra", "Indah", "Joko", "Kartika", "Lukman", "Maya", "Nanda",
         "Oki", "Putri", "Rizal", "Sari", "Teguh", "Wulan", "Yoga", "Zahra"]
LAST = ["Contoh", "Pratama", "Santoso", "Wijaya", "Lestari", "Nugroho", "Rahayu", "Saputra", "Kusuma", "Hidayat", "Permana", "Utami"]
SPESIALIS = ["Sp.PD", "Sp.B", "Sp.JP", "Sp.OG", "Sp.A", "Sp.S", "Sp.M", "Sp.THT-KL"]
# diagnoses a puskesmas is competent to treat (the 144 FKTP diagnoses), referred anyway
FKTP_DX = [("J06.9", "ISPA"), ("K30", "Dispepsia"), ("I10", "Hipertensi esensial tanpa komplikasi"), ("E11.9", "DM tipe 2 tanpa komplikasi"),
           ("A09", "Diare dan gastroenteritis"), ("L30.9", "Dermatitis"), ("H10.9", "Konjungtivitis")]
RS_DX = [("I25.1", "Penyakit jantung aterosklerotik"), ("N18.5", "Gagal ginjal kronik stadium 5"), ("J18.9", "Pneumonia"),
         ("K35.8", "Apendisitis akut"), ("O82", "Persalinan dengan seksio sesarea"), ("I63.9", "Infark serebral")]
TEMUAN = {
    "Rujukan tidak sesuai": "Diagnosis termasuk 144 kompetensi FKTP tetapi dirujuk ke FKRTL; pola berulang dari dokter perujuk yang sama.",
    "Self-referral": "Dokter perujuk adalah juga DPJP / pemilik praktik di faskes tujuan: pasien dirujuk ke praktiknya sendiri.",
    "Penyalahgunaan dana kapitasi/nonkapitasi": "Peserta kapitasi dirujuk tanpa indikasi sehingga beban layanan berpindah ke FKRTL.",
}
FKTP_JENIS = ("Puskesmas", "Klinik Pratama", "Dokter Praktik Perorangan")


def _is_rs(f: dict) -> bool:
    return f["jenis"] not in FKTP_JENIS


def generate_flow(faskes: Optional[list[dict]] = None, seed: int = 26) -> tuple[list[dict], list[dict], dict[str, dict]]:
    """(doctors, cases, per facility {dokter_terkait, jumlah_kasus}) from the facilities of generate()."""
    import demo_jkn

    rnd = random.Random(seed)
    faskes = faskes or generate()
    by = {f["kode"]: f for f in faskes}
    doctors: dict[str, dict] = {}
    staff: dict[str, list[str]] = {}

    def add_doc(did: str, nama: str, kode: str, spes: str, lain: str = "") -> str:
        doctors[did] = {"id_dokter": did, "nama": nama, "spesialisasi": spes, "faskes_utama": kode, "nama_faskes": by[kode]["nama"],
                        "praktik_lain": by[lain]["nama"] if lain else "", "jumlah_kasus": 0, "peran_dalam_kasus": ""}
        staff.setdefault(kode, []).append(did)
        return did

    # the JKN demo's doctors (D-05 of Puskesmas Contoh Barat also runs Klinik Utama Contoh Medika)
    for d in demo_jkn.generate()["dokter"].to_pylist():
        add_doc(d["id_dokter"], d["nama"], d["faskes"], "Spesialis penyakit dalam" if "Sp." in d["nama"] else "Dokter umum", d.get("praktik_pribadi") or "")
    staff.setdefault("KLU-07", []).append("D-05")

    def doc(kode: str) -> str:
        if not staff.get(kode):
            f = by[kode]
            for _ in range(2):
                n = len(doctors) + 1
                sp = rnd.choice(SPESIALIS) if _is_rs(f) else ""
                add_doc(f"D-{n:02d}", f"dr. {rnd.choice(FIRST)} {rnd.choice(LAST)}" + (f", {sp}" if sp else ""), kode,
                        f"Spesialis ({sp})" if sp else "Dokter umum")
        return rnd.choice(staff[kode])

    cases: list[dict] = []

    def case(asal: str, tujuan: str, jenis: str, perujuk: str, dpjp: str, status: str) -> None:
        rs_case = jenis not in TEMUAN
        code, dx = rnd.choice(RS_DX if rs_case else FKTP_DX)
        n = rnd.randint(3, 25) if rs_case else rnd.randint(4, 40)
        nilai = round(n * (rnd.uniform(4e6, 12e6) if rs_case else rnd.uniform(1.5e6, 4e6)), -5)
        cid = f"KRB-{len(cases) + 1:03d}"
        a, t = by[asal], by[tujuan]
        cases.append({
            "id_kasus": cid, "judul": f"{cid} · {jenis}", "jenis_kasus": jenis, "alur": f"{a['nama']} → {t['nama']}",
            "faskes_asal": asal, "nama_faskes_asal": a["nama"], "faskes_tujuan": tujuan, "nama_faskes_tujuan": t["nama"],
            "dokter_perujuk": perujuk, "nama_dokter_perujuk": doctors[perujuk]["nama"], "dokter_dpjp": dpjp, "nama_dokter_dpjp": doctors[dpjp]["nama"],
            "diagnosa": f"{code} {dx}", "jumlah_klaim": n, "nilai_klaim_rp": nilai, "periode": "Jul–Sep 2026",
            "status_kasus": status, "temuan": TEMUAN.get(jenis, f"Klaim di {t['nama']} terindikasi {jenis.lower()} oleh DPJP; perlu verifikasi rekam medis."),
        })

    # the JKN demo's story
    case("PKM-01", "KLU-07", "Self-referral", "D-05", "D-05", "Ada Indikasi Fraud")
    case("PKM-01", "RS-01", "Rujukan tidak sesuai", "D-06", "D-01", "Ada Indikasi Fraud")
    case("PKM-02", "RS-01", "Rujukan tidak sesuai", "D-07", "D-02", "Perlu Pemantauan")
    case("KLP-03", "RS-01", "Manipulasi diagnosis dan/atau tindakan (upcoding)", doc("KLP-03"), "D-03", "Dalam Investigasi")
    case("PKM-02", "RS-01", "Phantom billing (klaim palsu)", "D-08", "D-04", "Dalam Investigasi")
    case("KLU-07", "RS-01", "Self-referral", "D-05", "D-01", "Ada Indikasi Fraud")
    many = {"Perlu Pemantauan": 1, "Ada Indikasi Fraud": 2, "Dalam Investigasi": 3, "Selesai Diaudit": 1}
    known = {k for k, *_ in KNOWN}
    for f in faskes:
        if f["kode"] in known or f["status_audit"] == "Sehat":
            continue
        same = [g for g in faskes if g["kantor_cabang"] == f["kantor_cabang"] and g["kode"] != f["kode"]]
        for _ in range(many[f["status_audit"]]):
            if _is_rs(f):
                asal = rnd.choice([g for g in same if not _is_rs(g)] or [g for g in faskes if not _is_rs(g)])
                jenis = f["indikasi_utama"]
                dpjp = doc(f["kode"])
                perujuk = dpjp if jenis == "Self-referral" else doc(asal["kode"])
                if jenis == "Self-referral" and not doctors[dpjp]["praktik_lain"]:
                    doctors[dpjp]["praktik_lain"] = asal["nama"]
                case(asal["kode"], f["kode"], jenis, perujuk, dpjp, f["status_audit"])
            else:
                rs = [g for g in same if _is_rs(g)] or [g for g in faskes if _is_rs(g)]
                tujuan = rnd.choice(sorted(rs, key=lambda g: -g["skor_risiko"])[:4])
                jenis = f["indikasi_utama"] if f["indikasi_utama"] in TEMUAN else "Rujukan tidak sesuai"
                case(f["kode"], tujuan["kode"], jenis, doc(f["kode"]), doc(tujuan["kode"]), f["status_audit"])
    per: dict[str, dict] = {}
    for c in cases:
        for role, did in (("perujuk", c["dokter_perujuk"]), ("DPJP", c["dokter_dpjp"])):
            d = doctors[did]
            d["jumlah_kasus"] += 1
            d["peran_dalam_kasus"] = ", ".join(sorted(set(filter(None, d["peran_dalam_kasus"].split(", "))) | {role}))
        for kode in (c["faskes_asal"], c["faskes_tujuan"]):
            p = per.setdefault(kode, {"names": [], "jumlah_kasus": 0})
            p["jumlah_kasus"] += 1
            for nm in (c["nama_dokter_perujuk"], c["nama_dokter_dpjp"]):
                if nm not in p["names"]:
                    p["names"].append(nm)
    return list(doctors.values()), cases, {k: {"dokter_terkait": "; ".join(v["names"]), "jumlah_kasus": v["jumlah_kasus"]} for k, v in per.items()}


def _link(name: str, src: dict, fk: str, tgt: dict, src_name: str, tgt_name: str, arrow_to_source: bool = False) -> dict:
    import ontology_model as om

    lt = next((x for x in ontology._all("link-types") if x.get("display_name") == name), None)
    if lt:
        return lt
    return om.create_link_type(om.LinkTypeIn(
        display_name=name, kind="foreign_key", cardinality="many_to_one", foreign_key=fk,
        source=om.LinkSide(object_type_id=src["id"], display_name=src_name, plural_display_name=src_name,
                           type_classes=["vertex:link_primary_direction"] if arrow_to_source else []),
        target=om.LinkSide(object_type_id=tgt["id"], display_name=tgt_name)))


def _ensure_flow(fk: dict) -> dict:
    """Doctors, cases and their links; the facilities get dokter_terkait / jumlah_kasus."""
    made: list[str] = []
    doctors, cases, per = generate_flow()
    rec = ontology._object_type(fk["id"])
    extra = [_p("dokter_terkait", "Dokter terkait", render_hints=["searchable", "long_text"]), _p("jumlah_kasus", "Kasus rujukan/klaim berisiko", "integer")]
    missing = [e for e in extra if not any(q["api_name"] == e.api_name for q in rec["properties"])]
    # the facility's name is its title (the map and Vertex colour the status; the first version titled "name · status")
    if missing or rec["title_property"] == "judul":
        rec["properties"] += [e.model_dump(exclude_none=True) for e in missing]
        rec["title_property"] = "nama"
        ontology._put("object-types", rec)
    dk = _type(DOKTER)
    if not dk:
        dk = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=DOKTER, plural_name=DOKTER, api_name="DokterAuditJknDemo", primary_key="id_dokter", title_property="nama", icon="info", color="#38bdf8",
            description="Demo: dokter fiktif di faskes yang diaudit, dengan perannya (perujuk / DPJP) dalam kasus rujukan dan klaim berisiko.",
            properties=[_p("id_dokter", "ID dokter", render_hints=["searchable", "identifier"]), _p("nama", "Nama dokter", render_hints=["searchable"]),
                        _p("spesialisasi", "Spesialisasi", render_hints=["selectable"]), _p("faskes_utama", "Faskes utama (kode)", render_hints=["searchable"]),
                        _p("nama_faskes", "Faskes utama", render_hints=["searchable", "selectable"]), _p("praktik_lain", "Praktik lain", render_hints=["searchable"]),
                        _p("jumlah_kasus", "Jumlah kasus terkait", "integer"), _p("peran_dalam_kasus", "Peran dalam kasus", render_hints=["selectable"])]))
        made.append(DOKTER)
    ks = _type(KASUS)
    if not ks:
        ks = ontology.create_object_type(ontology.ObjectTypeIn(
            display_name=KASUS, plural_name=KASUS, api_name="KasusRujukanBerisikoJknDemo", primary_key="id_kasus", title_property="judul", icon="alert", color="#f97316",
            description="Demo: kasus rujukan / klaim berisiko dari satu faskes ke faskes lain (rujukan tidak sesuai, self-referral, upcoding, "
                        "phantom billing …), dengan dokter perujuk dan DPJP.",
            properties=[_p("id_kasus", "ID kasus", render_hints=["searchable", "identifier"]), _p("judul", "Judul", render_hints=["searchable"]),
                        _p("jenis_kasus", "Jenis kasus (20 subkategori)", render_hints=["searchable", "selectable"]), _p("alur", "Alur", render_hints=["searchable"]),
                        _p("faskes_asal", "Faskes asal (kode)"), _p("nama_faskes_asal", "Faskes asal", render_hints=["searchable", "selectable"]),
                        _p("faskes_tujuan", "Faskes tujuan (kode)"), _p("nama_faskes_tujuan", "Faskes tujuan", render_hints=["searchable", "selectable"]),
                        _p("dokter_perujuk", "Dokter perujuk (ID)"), _p("nama_dokter_perujuk", "Dokter perujuk", render_hints=["searchable"]),
                        _p("dokter_dpjp", "DPJP (ID)"), _p("nama_dokter_dpjp", "DPJP (dokter penanggung jawab)", render_hints=["searchable"]),
                        _p("diagnosa", "Diagnosis (ICD-10)", render_hints=["searchable"]), _p("jumlah_klaim", "Jumlah klaim", "integer"),
                        _p("nilai_klaim_rp", "Nilai klaim (Rp)", "double"), _p("periode", "Periode"),
                        _p("status_kasus", "Status kasus", render_hints=["selectable"]), _p("temuan", "Temuan", render_hints=["long_text"])]))
        made.append(KASUS)
    links = {
        "asal": _link(L_ASAL, ks, "faskes_asal", fk, "Kasus keluar", "Faskes asal", arrow_to_source=True),
        "tujuan": _link(L_TUJUAN, ks, "faskes_tujuan", fk, "Kasus masuk", "Faskes tujuan"),
        "perujuk": _link(L_PERUJUK, ks, "dokter_perujuk", dk, "Kasus yang dirujuk", "Dokter perujuk", arrow_to_source=True),
        "dpjp": _link(L_DPJP, ks, "dokter_dpjp", dk, "Kasus sebagai DPJP", "DPJP"),
        "praktik": _link(L_PRAKTIK, dk, "faskes_utama", fk, "Dokter", "Faskes utama"),
    }
    edits = []
    for t, rows, key in ((dk, doctors, "id_dokter"), (ks, cases, "id_kasus")):
        have = ontology.stored_objects(t["id"])
        edits += [{"op": "create", "object_type_id": t["id"], "primary_key": r[key], "properties": r} for r in rows if r[key] not in have]
    fobjs = ontology.stored_objects(fk["id"])
    edits += [{"op": "modify", "object_type_id": fk["id"], "primary_key": k, "properties": v} for k, v in per.items()
              if k in fobjs and not (fobjs[k].get("properties") or {}).get("dokter_terkait")]
    if edits:
        ontology.apply_edits(edits, source="demo-jkn-map")
    return {"dokter": ontology._object_type(dk["id"]), "kasus": ontology._object_type(ks["id"]), "links": links, "cases": cases, "made": made, "edits": len(edits)}


def _ensure_vertex(fk: dict, flow: dict) -> list[str]:
    import vertex

    dk, ks, lk, cases = flow["dokter"], flow["kasus"], flow["links"], flow["cases"]
    layers = {
        fk["id"]: {"color": "#22c55e", "label_property": "nama", "size_property": "skor_risiko",
                   "rules": [{"property": "status_audit", "op": "eq", "value": s, "color": STATUS[s][0]} for s in STATUS if s != "Sehat"]},
        ks["id"]: {"color": "#f97316", "label_property": "jenis_kasus", "size_property": "nilai_klaim_rp",
                   "rules": [{"property": "status_kasus", "op": "eq", "value": "Dalam Investigasi", "color": "#ef4444"}]},
        dk["id"]: {"color": "#38bdf8", "label_property": "nama"},
    }
    edge_styles = {lk["perujuk"]["id"]: {"color": "#38bdf8", "dashed": True}, lk["dpjp"]["id"]: {"color": "#38bdf8", "dashed": True},
                   lk["praktik"]["id"]: {"color": "#64748b", "dashed": True}}
    graphs = {g["name"] for g in vertex.list_graphs()}
    made = []
    if G_ALUR not in graphs:
        story = [c for c in cases if {c["faskes_asal"], c["faskes_tujuan"]} & {"RS-01", "KLU-07"}]
        nodes, seen = [], set()
        for c in story:
            for tid, pk in ((fk["id"], c["faskes_asal"]), (ks["id"], c["id_kasus"]), (fk["id"], c["faskes_tujuan"]),
                            (dk["id"], c["dokter_perujuk"]), (dk["id"], c["dokter_dpjp"])):
                if (tid, pk) not in seen:
                    seen.add((tid, pk))
                    nodes.append({"object_type_id": tid, "primary_key": pk})
        vertex.create_graph(vertex.GraphIn(
            name=G_ALUR, layout="hierarchy_lr", layers=layers, edge_styles=edge_styles, nodes=nodes,
            description="Demo: alur kasus berisiko di sekitar RSUD Contoh Sejahtera — faskes asal → kasus → faskes tujuan, dokter perujuk → "
                        "kasus → DPJP. Klik kasus untuk jenis temuan, diagnosis, nilai klaim dan nama dokter; klik faskes untuk dokter terkait."))
        made.append(G_ALUR)
    if G_ALIRAN not in graphs:
        kodes = sorted({c["faskes_asal"] for c in cases} | {c["faskes_tujuan"] for c in cases})
        vertex.create_graph(vertex.GraphIn(
            name=G_ALIRAN, layout="hierarchy_lr", layers=layers, nodes=[{"object_type_id": fk["id"], "primary_key": k} for k in kodes],
            edge_groups=[{"id": "kasus", "name": "Kasus rujukan berisiko", "object_type_id": ks["id"], "links": [lk["asal"]["id"], lk["tujuan"]["id"]],
                          "label": "count", "width": "sum:nilai_klaim_rp"}],
            description="Demo: semua faskes dengan kasus berisiko; tiap panah = kasus dari faskes asal ke faskes tujuan (tebal = nilai klaim). "
                        "Klik panah untuk daftar kasusnya."))
        made.append(G_ALIRAN)
    if G_TEMPLATE not in graphs:
        a, t, p, d, pr = lk["asal"]["id"], lk["tujuan"]["id"], lk["perujuk"]["id"], lk["dpjp"]["id"], lk["praktik"]["id"]
        chains = [[(a, "reverse"), (t, "forward")], [(t, "reverse"), (a, "forward")], [(a, "reverse"), (p, "forward")], [(a, "reverse"), (d, "forward")],
                  [(t, "reverse"), (p, "forward")], [(t, "reverse"), (d, "forward")], [(pr, "reverse")]]
        vertex.create_graph(vertex.GraphIn(
            name=G_TEMPLATE, layout="hierarchy_lr", layers=layers, edge_styles=edge_styles,
            description="Demo: pilih faskes → kasus berisiko yang keluar / masuk → faskes lawan, dokter perujuk dan DPJP, dan dokter faskes itu.",
            template={"parameters": [{"id": "faskes", "name": "Faskes", "object_type_id": fk["id"],
                                      "search_arounds": [{"steps": [{"link_type_id": x, "direction": dr} for x, dr in ch]} for ch in chains]}]}))
        made.append(G_TEMPLATE)
    return made


@router.post("")
def build() -> dict:
    """Build (or complete) the demo; nothing existing is changed or deleted."""
    with ontology._lock:
        t, made = _ensure_type()
        t = ontology._object_type(t["id"])
        have = ontology.stored_objects(t["id"])
        edits = [{"op": "create", "object_type_id": t["id"], "primary_key": r["kode"], "properties": r} for r in generate() if r["kode"] not in have]
        if edits:
            ontology.apply_edits(edits, source="demo-jkn-map")
        flow = _ensure_flow(t)
        graphs = _ensure_vertex(ontology._object_type(t["id"]), flow)
    m = next((m for m in geospatial.list_maps() if m.get("name") == MAP), None)
    if not m:
        layers = [geospatial.Layer(name=f"Faskes — {s}", kind="objects", color=STATUS[s][0], opacity=1.0,
                                   config={"object_type_id": t["id"], "property": "lokasi",
                                           "filters": [{"property": "status_audit", "op": "eq", "value": s}]})
                  for s in LAYER_ORDER]
        m = geospatial.create_map(geospatial.MapIn(
            name=MAP, basemap="streets", view={"lat": -7.3, "lon": 110.6, "zoom": 9}, layers=layers,
            description="Demo (data fiktif): faskes yang harus diaudit tim JKN, diwarnai menurut status audit — hijau Sehat, kuning Perlu "
                        "Pemantauan, oranye Ada Indikasi Fraud, merah Dalam Investigasi, ungu Selesai Diaudit. Klik faskes untuk skor "
                        "risiko, indikasi utama (20 subkategori), klaim berisiko, potensi kerugian dan tim audit."))
    return {"map_id": m["id"], "faskes_type_id": t["id"], "created": ([FASKES] if made else []) + flow["made"] + graphs,
            "objects_added": len(edits), "flow_edits": flow["edits"]}


@router.get("")
def status() -> dict:
    rows = generate()
    t = _type(FASKES)
    m = next((m for m in geospatial.list_maps() if m.get("name") == MAP), None)
    return {"map_id": m and m["id"], "faskes_type_id": t and t["id"],
            "per_status": {s: sum(1 for r in rows if r["status_audit"] == s) for s in STATUS},
            "potensi_kerugian_rp": sum(r["potensi_kerugian_rp"] for r in rows)}
