"""Demo JKN: Fraud Intelligence — menutup 6 pain point investigasi fraud klaim.

Melengkapi demo audit yang sudah ada (20 aturan skrining di demo_jkn_rules.py,
skor ML di demo_jkn_ml.py, ruang kerja di demo_jkn_workbench.py) dengan lapisan
yang selama ini hilang:

  1. Alert -> investigation case: setiap alert otomatis menjadi kasus berisi
     kronologi, bukti pendukung, relasi pihak terkait, rekomendasi langkah.
  2. Graph-based detection: graf provider-beneficiary-dokter-lab-apotek-
     perusahaan untuk menemukan pola kolusi banyak pihak.
  3. Validasi billing: klaim x rekam medis x diagnosis x prosedur x tarif
     kontrak x aturan manfaat (duplicate, upcoding, phantom, unnecessary,
     unsupported) sebelum pembayaran.
  4. Risk scoring explainable dengan peer benchmark (spesialisasi, prosedur,
     volume, riwayat provider) untuk menekan false positive.
  5. Pre-payment screening real-time: jalur otomatis risiko rendah, review
     khusus risiko tinggi, hold untuk hard-stop.
  6. Unified claims intelligence: registry aturan berversi, lineage,
     audit trail, dan status konektor sistem sumber.

Data sintetis deterministik (seed tetap), tanpa dependensi database platform:
demo selalu bisa dibuka. Mounted di /api/demo/jkn/fraud.
"""

from __future__ import annotations

import json
import math
import random
import threading
import time
import uuid
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/demo/jkn/fraud", tags=["demo-jkn-fraud"])

# ---------------------------------------------------------------------------
# Master data sintetis
# ---------------------------------------------------------------------------

PROVIDERS = [
    {"id": "RS-01", "nama": "RSUD Contoh Sejahtera", "jenis": "Rumah Sakit", "kelas": "B", "kantor_cabang": "KC Contoh Kota"},
    {"id": "RS-02", "nama": "RS Swasta Contoh Medika", "jenis": "Rumah Sakit", "kelas": "C", "kantor_cabang": "KC Contoh Kota"},
    {"id": "KL-01", "nama": "Klinik Utama Contoh Farma", "jenis": "Klinik", "kelas": "-", "kantor_cabang": "KC Contoh Kota"},
    {"id": "FKTP-01", "nama": "Puskesmas Contoh Barat", "jenis": "FKTP", "kelas": "-", "kantor_cabang": "KC Contoh Kabupaten"},
    {"id": "FKTP-02", "nama": "Puskesmas Contoh Timur", "jenis": "FKTP", "kelas": "-", "kantor_cabang": "KC Contoh Kabupaten"},
    {"id": "LAB-01", "nama": "Lab Contoh Diagnostika", "jenis": "Laboratorium", "kelas": "-", "kantor_cabang": "KC Contoh Kota"},
    {"id": "APT-01", "nama": "Apotek Contoh Sehat", "jenis": "Apotek", "kelas": "-", "kantor_cabang": "KC Contoh Kota"},
    {"id": "PT-01", "nama": "PT Contoh Medika Grup", "jenis": "Perusahaan Induk", "kelas": "-", "kantor_cabang": "Nasional"},
]

DOCTORS = [
    {"id": "D-01", "nama": "dr. Contoh Satu, Sp.PD", "spesialisasi": "Penyakit Dalam", "faskes": "RS-01"},
    {"id": "D-02", "nama": "dr. Contoh Dua, Sp.B", "spesialisasi": "Bedah", "faskes": "RS-01"},
    {"id": "D-03", "nama": "dr. Contoh Tiga, Sp.OT", "spesialisasi": "Ortopedi", "faskes": "RS-02"},
    {"id": "D-04", "nama": "dr. Contoh Empat", "spesialisasi": "Umum", "faskes": "FKTP-01"},
    {"id": "D-05", "nama": "dr. Contoh Lima", "spesialisasi": "Umum", "faskes": "FKTP-02"},
    {"id": "D-06", "nama": "dr. Contoh Enam, Sp.OG", "spesialisasi": "Obstetri", "faskes": "RS-02"},
    {"id": "D-07", "nama": "dr. Contoh Tujuh, Sp.PD", "spesialisasi": "Penyakit Dalam", "faskes": "KL-01"},
    {"id": "D-08", "nama": "dr. Contoh Delapan", "spesialisasi": "Umum", "faskes": "KL-01"},
]

# tarif kontrak per prosedur: (nama, tarif_kontrak_rp, butuh_indikasi_dx_prefix)
PROCEDURES = {
    "47.09": ("Appendektomi", 7_500_000, ("K35", "K36")),
    "81.54": ("Total knee replacement", 48_000_000, ("M17", "S72")),
    "74.1": ("Sectio caesarea", 6_500_000, ("O32", "O33", "O34", "O60", "O82")),
    "99.04": ("Transfusi darah", 1_800_000, ("D64", "O72")),
    "39.95": ("Hemodialisis", 1_100_000, ("N18",)),
    "87.44": ("Foto thorax", 350_000, ("J18", "J06", "R05")),
    "NONE": ("Tanpa prosedur khusus", 0, ()),
}

BASE = date(2026, 9, 1)


def _claim(no: int, **kw: Any) -> dict:
    c = {
        "no_sep": f"SEP-2026-{no:04d}",
        "peserta": "PES-000",
        "faskes": "RS-01",
        "dokter": "D-01",
        "diagnosa": "I10",
        "prosedur": "NONE",
        "severity_diklaim": 1,
        "severity_didukung": 1,
        "tarif_klaim": 3_000_000,
        "tanggal": BASE,
        "status_bayar": "belum_dibayar",
        "dokumen": {"resume_medis": True, "hasil_lab": True, "log_tindakan": True, "kehadiran": True},
        "rujukan_dari": None,
    }
    c.update(kw)
    return c


def _generate_claims() -> list[dict]:
    claims: list[dict] = []
    n = 0

    def add(**kw: Any) -> dict:
        nonlocal n
        n += 1
        claims.append(_claim(n, **kw))
        return claims[-1]

    # --- klaim normal (peer baseline) ---
    rng = random.Random(42)
    normal_specs = [
        ("RS-01", "D-01", "I10", "NONE", 3_200_000),
        ("RS-01", "D-01", "J18.9", "87.44", 3_800_000),
        ("RS-01", "D-02", "K35.8", "47.09", 7_400_000),
        ("RS-02", "D-06", "O82", "74.1", 6_400_000),
        ("FKTP-01", "D-04", "J06.9", "NONE", 180_000),
        ("FKTP-02", "D-05", "I10", "NONE", 175_000),
        ("RS-01", "D-01", "N18.5", "39.95", 1_050_000),
        ("RS-02", "D-03", "M17.1", "81.54", 47_000_000),
    ]
    for i in range(24):
        f, d, dx, proc, tarif = normal_specs[i % len(normal_specs)]
        add(peserta=f"PES-{100 + i:03d}", faskes=f, dokter=d, diagnosa=dx, prosedur=proc,
            tarif_klaim=int(tarif * rng.uniform(0.95, 1.0)), tanggal=BASE + timedelta(days=i % 20),
            status_bayar="sudah_dibayar" if i % 3 else "belum_dibayar")

    # --- P3: duplicate billing (klaim sama 2x) ---
    dup = add(peserta="PES-201", faskes="RS-01", dokter="D-02", diagnosa="K35.8", prosedur="47.09",
              tarif_klaim=7_500_000, tanggal=BASE + timedelta(days=3))
    add(peserta="PES-201", faskes="RS-01", dokter="D-02", diagnosa="K35.8", prosedur="47.09",
        tarif_klaim=7_500_000, tanggal=BASE + timedelta(days=3))

    # --- P3: upcoding (severity diklaim III, lab hanya mendukung I) ---
    add(peserta="PES-202", faskes="RS-01", dokter="D-01", diagnosa="J18.9", prosedur="87.44",
        severity_diklaim=3, severity_didukung=1, tarif_klaim=9_800_000, tanggal=BASE + timedelta(days=4))
    add(peserta="PES-203", faskes="KL-01", dokter="D-07", diagnosa="I10", prosedur="NONE",
        severity_diklaim=3, severity_didukung=1, tarif_klaim=8_900_000, tanggal=BASE + timedelta(days=5))

    # --- P3: phantom billing (tanpa kehadiran & log tindakan) ---
    add(peserta="PES-204", faskes="RS-02", dokter="D-03", diagnosa="M17.1", prosedur="81.54",
        tarif_klaim=48_000_000, tanggal=BASE + timedelta(days=6),
        dokumen={"resume_medis": True, "hasil_lab": False, "log_tindakan": False, "kehadiran": False})

    # --- P3: unnecessary (SC tanpa indikasi) + unsupported (dokumen hilang) ---
    add(peserta="PES-205", faskes="RS-02", dokter="D-06", diagnosa="O80", prosedur="74.1",
        tarif_klaim=6_500_000, tanggal=BASE + timedelta(days=7))
    add(peserta="PES-206", faskes="RS-01", dokter="D-01", diagnosa="D64.9", prosedur="99.04",
        tarif_klaim=2_600_000, tanggal=BASE + timedelta(days=8),
        dokumen={"resume_medis": False, "hasil_lab": False, "log_tindakan": True, "kehadiran": True})

    # --- P2: jaringan kolusi RS-02 -> LAB-01 -> APT-01 (pasien & dokter sama berulang) ---
    for i in range(6):
        add(peserta=f"PES-30{i}", faskes="RS-02", dokter="D-03", diagnosa="M17.1", prosedur="81.54",
            tarif_klaim=48_000_000, tanggal=BASE + timedelta(days=10 + i), rujukan_dari="KL-01",
            severity_diklaim=2, severity_didukung=2)
    # self-referral: dokter KL-01 merujuk ke praktik sendiri
    for i in range(3):
        add(peserta=f"PES-31{i}", faskes="KL-01", dokter="D-08", diagnosa="J06.9", prosedur="87.44",
            tarif_klaim=900_000, tanggal=BASE + timedelta(days=12 + i), rujukan_dari="KL-01")
    return claims


CLAIMS = _generate_claims()
PROVIDER_BY_ID = {p["id"]: p for p in PROVIDERS}
DOCTOR_BY_ID = {d["id"]: d for d in DOCTORS}

# ---------------------------------------------------------------------------
# P3 + P4: validasi billing & risk scoring explainable dengan peer benchmark
# ---------------------------------------------------------------------------

HARD_STOP = {"phantom_billing", "duplicate_billing"}


def validate_billing(c: dict) -> list[dict]:
    """Klaim x rekam medis x diagnosis x prosedur x tarif kontrak x manfaat."""
    issues: list[dict] = []
    proc = PROCEDURES.get(c["prosedur"], PROCEDURES["NONE"])
    nama_proc, tarif_kontrak, indikasi = proc
    if c["prosedur"] != "NONE" and tarif_kontrak and c["tarif_klaim"] > tarif_kontrak:
        issues.append({"jenis": "over_tariff", "label": "Tagihan di atas tarif kontrak",
                       "detail": f"{nama_proc}: klaim Rp{c['tarif_klaim']:,} vs kontrak Rp{tarif_kontrak:,}",
                       "nilai_risiko": c["tarif_klaim"] - tarif_kontrak})
    if c["severity_diklaim"] > c["severity_didukung"]:
        issues.append({"jenis": "upcoding", "label": "Upcoding severity",
                       "detail": f"Severity diklaim {c['severity_diklaim']}, didukung dokumen {c['severity_didukung']}",
                       "nilai_risiko": int(c["tarif_klaim"] * 0.35)})
    if not c["dokumen"]["kehadiran"] or not c["dokumen"]["log_tindakan"]:
        issues.append({"jenis": "phantom_billing", "label": "Phantom billing",
                       "detail": "Tidak ada catatan kehadiran / log tindakan untuk layanan yang ditagihkan",
                       "nilai_risiko": c["tarif_klaim"]})
    if indikasi and not any(c["diagnosa"].startswith(p) for p in indikasi):
        issues.append({"jenis": "unnecessary_service", "label": "Layanan tanpa indikasi medis",
                       "detail": f"Prosedur {nama_proc} untuk diagnosis {c['diagnosa']} di luar indikasi {', '.join(indikasi)}",
                       "nilai_risiko": c["tarif_klaim"]})
    missing = [k for k, v in c["dokumen"].items() if not v]
    if missing and not any(i["jenis"] == "phantom_billing" for i in issues):
        issues.append({"jenis": "unsupported_documentation", "label": "Tidak didukung dokumentasi klinis",
                       "detail": f"Dokumen hilang: {', '.join(missing)}", "nilai_risiko": int(c["tarif_klaim"] * 0.5)})
    return issues


def _duplicate_seps() -> set[str]:
    seen: dict[tuple, str] = {}
    dups: set[str] = set()
    for c in CLAIMS:
        key = (c["peserta"], c["prosedur"], str(c["tanggal"]), c["faskes"])
        if c["prosedur"] != "NONE" and key in seen:
            dups.add(c["no_sep"])
        seen.setdefault(key, c["no_sep"])
    return dups


DUP_SEPS = _duplicate_seps()


_BILLING_CACHE: Optional[list] = None


def billing_checks() -> list[dict]:
    """Hasil validasi billing, dihitung sekali lalu di-cache (Tahap 1 plan skalabilitas)."""
    global _BILLING_CACHE
    if _BILLING_CACHE is not None:
        return _BILLING_CACHE
    out = []
    for c in CLAIMS:
        issues = validate_billing(c)
        if c["no_sep"] in DUP_SEPS:
            issues = [{"jenis": "duplicate_billing", "label": "Duplicate billing",
                       "detail": "Pasien, prosedur, tanggal, dan faskes sama dengan klaim sebelumnya",
                       "nilai_risiko": c["tarif_klaim"]}, *issues]
        if issues:
            out.append({"no_sep": c["no_sep"], "peserta": c["peserta"], "faskes": c["faskes"],
                        "nama_faskes": PROVIDER_BY_ID[c["faskes"]]["nama"], "dokter": c["dokter"],
                        "diagnosa": c["diagnosa"], "prosedur": c["prosedur"],
                        "tanggal": str(c["tanggal"]), "status_bayar": c["status_bayar"],
                        "tarif_klaim": c["tarif_klaim"], "issues": issues,
                        "nilai_risiko": sum(i["nilai_risiko"] for i in issues),
                        "verdict": "hold" if any(i["jenis"] in HARD_STOP for i in issues) else "review"})
    _BILLING_CACHE = sorted(out, key=lambda x: -x["nilai_risiko"])
    return _BILLING_CACHE


CLAIM_BY_SEP = {c["no_sep"]: c for c in CLAIMS}


def _paginate(items: list, limit: int, offset: int) -> tuple[list, dict]:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    return items[offset:offset + limit], {"total": len(items), "limit": limit, "offset": offset}


def _peer_stats() -> dict[tuple, dict]:
    """Benchmark per (spesialisasi dokter, prosedur): rata-rata & std tarif peer."""
    groups: dict[tuple, list[int]] = defaultdict(list)
    for c in CLAIMS:
        groups[(DOCTOR_BY_ID[c["dokter"]]["spesialisasi"], c["prosedur"])].append(c["tarif_klaim"])
    stats = {}
    for k, vals in groups.items():
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / max(len(vals) - 1, 1)
        stats[k] = {"mean": mean, "std": math.sqrt(var) or 1.0, "n": len(vals)}
    return stats


PEER = _peer_stats()
PROVIDER_HISTORY = {pid: len([c for c in billing_checks() if c["faskes"] == pid]) for pid in PROVIDER_BY_ID}


def risk_score(c: dict) -> dict:
    """Skor 0-100 explainable: setiap faktor disebut, bukan skor hitam."""
    issues = validate_billing(c)
    if c["no_sep"] in DUP_SEPS:
        issues = [{"jenis": "duplicate_billing"}, *issues]
    factors: list[dict] = []
    score = 0.0
    if issues:
        w = min(45, 15 + 10 * len(issues))
        score += w
        factors.append({"faktor": "Anomali billing", "kontribusi": round(w, 1),
                        "penjelasan": ", ".join(sorted({i['jenis'] for i in issues}))})
    key = (DOCTOR_BY_ID[c["dokter"]]["spesialisasi"], c["prosedur"])
    peer = PEER.get(key)
    if peer and peer["n"] >= 3:
        z = (c["tarif_klaim"] - peer["mean"]) / peer["std"]
        if z > 1:
            w = min(20, 6 * z)
            score += w
            factors.append({"faktor": "Peer benchmark", "kontribusi": round(w, 1),
                            "penjelasan": f"Tarif z={z:.1f} di atas rata-rata {peer['n']} peer ({key[0]} / {key[1]})"})
    hist = PROVIDER_HISTORY.get(c["faskes"], 0)
    if hist:
        w = min(20, 4 * hist)
        score += w
        factors.append({"faktor": "Riwayat provider", "kontribusi": round(w, 1),
                        "penjelasan": f"{PROVIDER_BY_ID[c['faskes']]['nama']} punya {hist} klaim terflag dalam periode ini"})
    vol = len([x for x in CLAIMS if x["dokter"] == c["dokter"]])
    if vol >= 8:
        score += 10
        factors.append({"faktor": "Volume dokter", "kontribusi": 10,
                        "penjelasan": f"{DOCTOR_BY_ID[c['dokter']]['nama']}: {vol} klaim dalam periode (outlier volume)"})
    if c.get("rujukan_dari") and c["rujukan_dari"] == c["faskes"]:
        score += 15
        factors.append({"faktor": "Self-referral", "kontribusi": 15, "penjelasan": "Rujukan ke faskes sendiri"})
    score = min(100, round(score, 1))
    tier = "Kritis" if score >= 70 else "Tinggi" if score >= 50 else "Sedang" if score >= 30 else "Rendah"
    return {"no_sep": c["no_sep"], "skor": score, "tier": tier, "factors": factors,
            "peer": {"spesialisasi": key[0], "prosedur": key[1], "peer_n": peer["n"] if peer else 0,
                     "peer_mean": round(peer["mean"]) if peer else None}}


# ---------------------------------------------------------------------------
# P2: graf banyak pihak + deteksi jaringan kolusi
# ---------------------------------------------------------------------------

def build_graph() -> dict:
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def node(nid: str, label: str, jenis: str) -> None:
        nodes.setdefault(nid, {"id": nid, "label": label, "jenis": jenis})

    for p in PROVIDERS:
        node(p["id"], p["nama"], p["jenis"])
    for d in DOCTORS:
        node(d["id"], d["nama"], "Dokter")
        edges.append({"source": d["id"], "target": d["faskes"], "jenis": "praktik_di"})
    edges.append({"source": "RS-02", "target": "PT-01", "jenis": "dimiliki_oleh"})
    edges.append({"source": "KL-01", "target": "PT-01", "jenis": "dimiliki_oleh"})
    edges.append({"source": "LAB-01", "target": "PT-01", "jenis": "dimiliki_oleh"})
    edges.append({"source": "APT-01", "target": "PT-01", "jenis": "dimiliki_oleh"})
    shared: Counter = Counter()
    for c in CLAIMS:
        node(c["peserta"], c["peserta"], "Peserta")
        edges.append({"source": c["peserta"], "target": c["faskes"], "jenis": "klaim_di", "no_sep": c["no_sep"]})
        edges.append({"source": c["dokter"], "target": c["peserta"], "jenis": "melayani", "no_sep": c["no_sep"]})
        if c["rujukan_dari"]:
            edges.append({"source": c["rujukan_dari"], "target": c["faskes"], "jenis": "merujuk", "no_sep": c["no_sep"]})
            shared[(c["rujukan_dari"], c["faskes"])] += 1
        if c["faskes"] in ("RS-02", "KL-01") and c["prosedur"] != "NONE":
            edges.append({"source": c["faskes"], "target": "LAB-01", "jenis": "order_lab", "no_sep": c["no_sep"]})
            edges.append({"source": c["faskes"], "target": "APT-01", "jenis": "resep_ke", "no_sep": c["no_sep"]})
    # posisi deterministik untuk SVG frontend
    ordered = sorted(nodes.values(), key=lambda x: (x["jenis"], x["id"]))
    for i, nd in enumerate(ordered):
        ang = 2 * math.pi * i / max(len(ordered), 1)
        nd["x"] = round(0.5 + 0.42 * math.cos(ang), 4)
        nd["y"] = round(0.5 + 0.42 * math.sin(ang), 4)
    networks = []
    for (a, b), cnt in shared.items():
        if cnt >= 3:
            networks.append({"id": f"NET-{a}-{b}", "pola": "Jalur rujukan terkonsentrasi",
                             "anggota": [a, b, "PT-01"], "kekuatan": cnt,
                             "penjelasan": f"{cnt} rujukan {a} -> {b} dalam 1 periode, keduanya di bawah PT-01"})
    networks.append({"id": "NET-RING-01", "pola": "Ring kolusi provider-lab-apotek satu grup",
                     "anggota": ["RS-02", "KL-01", "LAB-01", "APT-01", "PT-01"], "kekuatan": 9,
                     "penjelasan": "RS, klinik perujuk, lab, dan apotek dimiliki PT-01; pasien berputar di dalam grup dengan prosedur bernilai tinggi berulang"})
    return {"nodes": list(nodes.values()), "edges": edges, "networks": networks}


GRAPH = build_graph()

# ---------------------------------------------------------------------------
# P1: alert -> investigation case
# ---------------------------------------------------------------------------

def build_cases() -> list[dict]:
    checks = {b["no_sep"]: b for b in billing_checks()}
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for sep, b in checks.items():
        groups[(b["faskes"], b["issues"][0]["jenis"])].append(CLAIM_BY_SEP[sep])
    cases = []
    for idx, ((faskes, jenis), claims) in enumerate(sorted(groups.items(), key=lambda kv: -len(kv[1])), 1):
        first = claims[0]
        b0 = checks[first["no_sep"]]
        total = sum(checks[c["no_sep"]]["nilai_risiko"] for c in claims)
        score = max(risk_score(c)["skor"] for c in claims)
        kronologi = sorted(
            [{"tanggal": str(c["tanggal"]), "kejadian": f"Klaim {c['no_sep']} diajukan ({c['diagnosa']}/{c['prosedur']}) Rp{c['tarif_klaim']:,}",
              "sumber": "e-Klaim"} for c in claims]
            + [{"tanggal": str(first["tanggal"]), "kejadian": f"Alert {jenis} terbit dari validasi billing", "sumber": "Fraud engine"}],
            key=lambda x: x["tanggal"])
        bukti = [{"jenis": i["label"], "detail": i["detail"], "sumber": "Klaim x rekam medis x tarif kontrak"}
                 for c in claims for i in checks[c["no_sep"]]["issues"]]
        relasi = [n for n in GRAPH["networks"] if faskes in n["anggota"]]
        if not relasi:
            tetangga = sorted({e["target"] if e["source"] == faskes else e["source"]
                               for e in GRAPH["edges"] if faskes in (e["source"], e["target"])})[:6]
            relasi = [{"id": f"REL-{faskes}", "pola": "Relasi langsung di graf", "anggota": [faskes, *tetangga],
                       "kekuatan": len(tetangga),
                       "penjelasan": f"{faskes} terhubung langsung ke {', '.join(tetangga) or '-'} (dokter praktik, peserta, rujukan)"}]
        cases.append({
            "id": f"INV-2026-{idx:03d}", "judul": f"{b0['issues'][0]['label']} — {PROVIDER_BY_ID[faskes]['nama']}",
            "status": "Baru" if idx > 2 else "Dalam Investigasi", "prioritas": "P1" if score >= 70 else "P2" if score >= 50 else "P3",
            "skor_risiko": score, "faskes": faskes, "nama_faskes": PROVIDER_BY_ID[faskes]["nama"],
            "kantor_cabang": PROVIDER_BY_ID[faskes].get("kantor_cabang", ""),
            "jenis_temuan": jenis, "jumlah_klaim": len(claims), "estimasi_kerugian_rp": total,
            "klaim": [c["no_sep"] for c in claims], "kronologi": kronologi, "bukti": bukti,
            "relasi_jaringan": relasi,
            "rekomendasi": [
                "Tahan pembayaran klaim terkait sampai telaah rekam medis selesai",
                "Minta rekam medis lengkap & log tindakan asli dari faskes",
                "Bandingkan pola dengan peer benchmark spesialisasi/prosedur yang sama",
                "Periksa relasi kepemilikan & rujukan di graf jaringan sebelum eskalasi",
                "Eskalasi ke tim investigasi bila bukti pendukung tidak diserahkan 14 hari",
            ],
            "sla_jam": 72 if score >= 70 else 168,
            "dibuat_dari": "Alert otomatis fraud engine (bukan temuan manual)",
        })
    return sorted(cases, key=lambda x: -x["skor_risiko"])


CASES = build_cases()

# ---------------------------------------------------------------------------
# P6: registry aturan berversi, konektor, lineage, audit trail
# ---------------------------------------------------------------------------

RULES_REGISTRY = [
    {"id": "R-04", "nama": "Upcoding severity vs lab pendukung", "pain_point": 3, "versi_aktif": "2.1.0",
     "versi": [{"versi": "2.1.0", "tanggal": "2026-09-01", "perubahan": "Ambang severity didukung diturunkan, tambah cek Hb/Kalium", "status": "aktif"},
               {"versi": "2.0.0", "tanggal": "2026-06-15", "perubahan": "Rilis mayor: gabung klaim + hasil lab", "status": "arsip"}],
     "owner": "Tim Verifikasi Medis", "hit_rate": 0.08, "false_positive_rate": 0.12},
    {"id": "R-06", "nama": "Phantom billing (kehadiran & log tindakan)", "pain_point": 3, "versi_aktif": "1.4.0",
     "versi": [{"versi": "1.4.0", "tanggal": "2026-08-10", "perubahan": "Hard-stop pre-payment untuk phantom", "status": "aktif"}],
     "owner": "Tim Fraud", "hit_rate": 0.03, "false_positive_rate": 0.04},
    {"id": "R-11", "nama": "Duplicate / repeat billing", "pain_point": 3, "versi_aktif": "1.2.0",
     "versi": [{"versi": "1.2.0", "tanggal": "2026-07-01", "perubahan": "Kunci duplikat tambah poli & tanggal layanan", "status": "aktif"}],
     "owner": "Tim Fraud", "hit_rate": 0.02, "false_positive_rate": 0.02},
    {"id": "R-G01", "nama": "Ring kolusi provider-lab-apotek satu grup", "pain_point": 2, "versi_aktif": "0.9.0",
     "versi": [{"versi": "0.9.0", "tanggal": "2026-09-10", "perubahan": "Deteksi ring berbasis graf: kepemilikan + rujukan + pasien bersama", "status": "aktif"}],
     "owner": "Tim Investigasi", "hit_rate": 0.01, "false_positive_rate": 0.18},
    {"id": "R-S01", "nama": "Risk scoring peer-benchmark", "pain_point": 4, "versi_aktif": "3.0.0",
     "versi": [{"versi": "3.0.0", "tanggal": "2026-09-05", "perubahan": "Benchmark per spesialisasi x prosedur, penjelasan per faktor wajib", "status": "aktif"}],
     "owner": "Data Science", "hit_rate": 0.15, "false_positive_rate": 0.09},
]

CONNECTORS = [
    {"sistem": "e-Klaim (INA-CBG)", "status": "terhubung", "latensi_ms": 240, "sync_terakhir": "2026-09-30 08:15", "baris": 128400},
    {"sistem": "VClaim / SEP", "status": "terhubung", "latensi_ms": 180, "sync_terakhir": "2026-09-30 08:15", "baris": 128400},
    {"sistem": "Rekam medis (resume, lab, log tindakan)", "status": "terhubung", "latensi_ms": 620, "sync_terakhir": "2026-09-30 08:10", "baris": 96400},
    {"sistem": "Tarif kontrak & benefit policy", "status": "terhubung", "latensi_ms": 95, "sync_terakhir": "2026-09-30 07:00", "baris": 1840},
    {"sistem": "Register faskes & kepemilikan (HFIS/Aplicares)", "status": "degradasi", "latensi_ms": 2100, "sync_terakhir": "2026-09-30 06:40", "baris": 3120},
]

AUDIT_TRAIL: list[dict] = [
    {"waktu": "2026-09-01 09:00", "aktor": "Tim Verifikasi Medis", "aksi": "Aktivasi aturan R-04 v2.1.0", "detail": "Menggantikan v2.0.0; berlaku untuk klaim sejak 2026-09-01"},
    {"waktu": "2026-09-10 11:30", "aktor": "Tim Investigasi", "aksi": "Publikasi aturan graf R-G01 v0.9.0", "detail": "Mode monitoring dulu, hard-stop dimatikan"},
]


# ---------------------------------------------------------------------------
# Tahap 2: persistensi — store JSON di data/demo-jkn-fraud/store.json
# (pola state.json demo lain; di produksi diganti dataset platform, Tahap 2 plan)
# ---------------------------------------------------------------------------

STORE_DIR = Path("data/demo-jkn-fraud")
_store_lock = threading.Lock()
FEEDBACK: list[dict] = []          # verdict investigator per SEP: fraud | legit
DECISION_LOG: list[dict] = []      # setiap keputusan pre-payment (Tahap 4)
JOBS: dict[str, dict] = {}         # job async batch scoring / deteksi ring (Tahap 3)
MATERIALIZED: dict[str, Any] = {}  # hasil batch terakhir (skor & ring ter-materialisasi)
_IDEMPOTENCY: dict[str, dict] = {}
_RATE: dict[str, list[float]] = {}
RATE_LIMIT_PER_MIN = 60


def _store_file() -> Path:
    return STORE_DIR / "store.json"


def _save_store() -> None:
    with _store_lock:
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"rules": RULES_REGISTRY, "audit_trail": AUDIT_TRAIL,
                   "case_status": {c["id"]: c["status"] for c in CASES},
                   "feedback": FEEDBACK, "decision_log": DECISION_LOG[-500:], "materialized": MATERIALIZED}
        tmp = _store_file().with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_store_file())


def _load_store() -> None:
    f = _store_file()
    if not f.exists():
        return
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return
    if data.get("rules"):
        RULES_REGISTRY.clear()
        RULES_REGISTRY.extend(data["rules"])
    if data.get("audit_trail"):
        AUDIT_TRAIL.clear()
        AUDIT_TRAIL.extend(data["audit_trail"])
    for cid, status in (data.get("case_status") or {}).items():
        for c in CASES:
            if c["id"] == cid:
                c["status"] = status
    FEEDBACK.extend(data.get("feedback") or [])
    DECISION_LOG.extend(data.get("decision_log") or [])
    MATERIALIZED.update(data.get("materialized") or {})


def configure(data_dir: Optional[Path] = None) -> None:
    """Dipanggil server.py dengan DATA platform; default relatif untuk test mandiri."""
    global STORE_DIR
    if data_dir is not None:
        STORE_DIR = Path(data_dir) / "demo-jkn-fraud"
    _load_store()


_load_store()


def _audit(aktor: str, aksi: str, detail: str) -> dict:
    entry = {"waktu": time.strftime("%Y-%m-%d %H:%M"), "aktor": aktor, "aksi": aksi, "detail": detail}
    AUDIT_TRAIL.append(entry)
    _save_store()
    return entry


class ActivateRule(BaseModel):
    rule_id: str
    versi: str


class RuleVersion(BaseModel):
    rule_id: str
    versi: str
    perubahan: str
    aktor: str = "Tim Fraud"


class CaseDecision(BaseModel):
    status: str  # Dalam Investigasi | Menunggu Bukti | Eskalasi | Selesai - Terbukti | Selesai - Tidak Terbukti
    aktor: str = "Investigator"
    catatan: str = ""


class Feedback(BaseModel):
    no_sep: str
    verdict: str  # fraud | legit
    aktor: str = "Investigator"


class ScreenClaim(BaseModel):
    peserta: str = "PES-999"
    faskes: str = "RS-01"
    dokter: str = "D-01"
    diagnosa: str = "I10"
    prosedur: str = "NONE"
    severity_diklaim: int = 1
    severity_didukung: int = 1
    tarif_klaim: int = 3_000_000
    dokumen_lengkap: bool = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/overview")
def overview() -> dict:
    checks = billing_checks()
    belum = [c for c in CLAIMS if c["status_bayar"] == "belum_dibayar"]
    return {
        "pain_points": [
            {"no": 1, "judul": "Alert menjadi investigation case", "status": "selesai", "bukti": f"{len(CASES)} kasus otomatis dengan kronologi, bukti, relasi, rekomendasi"},
            {"no": 2, "judul": "Fraud banyak pihak (graf)", "status": "selesai", "bukti": f"{len(GRAPH['nodes'])} node, {len(GRAPH['edges'])} relasi, {len(GRAPH['networks'])} jaringan mencurigakan"},
            {"no": 3, "judul": "Billing tidak sesuai layanan", "status": "selesai", "bukti": f"{len(checks)} klaim terflag: duplicate, upcoding, phantom, unnecessary, unsupported, over-tariff"},
            {"no": 4, "judul": "False positive & skor explainable", "status": "selesai", "bukti": "Skor per faktor + peer benchmark spesialisasi x prosedur; FP rate per aturan terpantau"},
            {"no": 5, "judul": "Pre-payment screening", "status": "selesai", "bukti": f"{len(belum)} klaim belum dibayar masuk jalur otomatis/review/hold sebelum bayar"},
            {"no": 6, "judul": "Integrasi & aturan berversi", "status": "selesai", "bukti": f"{len(RULES_REGISTRY)} aturan berversi, {len(CONNECTORS)} konektor, audit trail tercatat"},
        ],
        "kpi": {"total_klaim": len(CLAIMS), "klaim_terflag": len(checks), "kasus_investigasi": len(CASES),
                "jaringan_kolusi": len(GRAPH["networks"]),
                "estimasi_kerugian_rp": sum(c["nilai_risiko"] for c in checks),
                "klaim_belum_dibayar": len(belum)},
        "charts": {
            "distribusi_tier": dict(Counter(risk_score(c)["tier"] for c in CLAIMS)),
            "distribusi_temuan": dict(Counter(i["jenis"] for c in checks for i in c["issues"])),
            "risiko_per_faskes": [{"faskes": pid, "nama": p["nama"], "terflag": PROVIDER_HISTORY.get(pid, 0),
                                   "nilai_risiko": sum(c["nilai_risiko"] for c in checks if c["faskes"] == pid)}
                                  for pid, p in PROVIDER_BY_ID.items() if pid in {c["faskes"] for c in checks}],
            "kantor_cabang": sorted({p.get("kantor_cabang", "") for p in PROVIDERS} - {""}),
        },
        "tahap_plan": {"tahap_2_persistensi": "aktif (store JSON persisten)", "tahap_3_batch_async": "aktif (/jobs)",
                       "tahap_4_operasional": "aktif (rate-limit, idempotency, feedback, akses KC)"},
    }


@router.get("/cases")
def cases(limit: int = 50, offset: int = 0, kantor_cabang: str = "") -> dict:
    items = [c for c in CASES if not kantor_cabang or c.get("kantor_cabang") == kantor_cabang]
    page, meta = _paginate(items, limit, offset)
    return {"cases": page, "pagination": meta}


@router.get("/cases/{case_id}")
def case_detail(case_id: str) -> dict:
    for c in CASES:
        if c["id"] == case_id:
            return c
    raise HTTPException(404, f"Kasus {case_id} tidak ditemukan")


@router.post("/cases/{case_id}/decision")
def case_decision(case_id: str, payload: CaseDecision) -> dict:
    allowed = {"Dalam Investigasi", "Menunggu Bukti", "Eskalasi", "Selesai - Terbukti", "Selesai - Tidak Terbukti"}
    if payload.status not in allowed:
        raise HTTPException(400, f"Status tidak valid; pilihan: {sorted(allowed)}")
    for c in CASES:
        if c["id"] == case_id:
            old = c["status"]
            c["status"] = payload.status
            entry = _audit(payload.aktor, f"Keputusan kasus {case_id}: {old} -> {payload.status}", payload.catatan or "-")
            return {"ok": True, "case": c, "audit": entry}
    raise HTTPException(404, f"Kasus {case_id} tidak ditemukan")


@router.get("/graph")
def graph(max_edges: int = 1000) -> dict:
    return {**GRAPH, "edges": GRAPH["edges"][:max(0, max_edges)], "edges_total": len(GRAPH["edges"])}


@router.get("/graph/subgraph")
def subgraph(node: str, depth: int = 1) -> dict:
    """Subgraf sekitar satu node (Tahap 3: tidak pernah full-graph untuk query analitik)."""
    depth = max(1, min(depth, 2))
    keep = {node}
    frontier = {node}
    for _ in range(depth):
        nxt = set()
        for e in GRAPH["edges"]:
            if e["source"] in frontier:
                nxt.add(e["target"])
            if e["target"] in frontier:
                nxt.add(e["source"])
        frontier = nxt - keep
        keep |= nxt
    nodes = [n for n in GRAPH["nodes"] if n["id"] in keep]
    edges = [e for e in GRAPH["edges"] if e["source"] in keep and e["target"] in keep]
    if not nodes:
        raise HTTPException(404, f"Node {node} tidak ditemukan di graf")
    return {"nodes": nodes, "edges": edges, "pusat": node, "kedalaman": depth}


@router.get("/billing-checks")
def get_billing_checks(limit: int = 50, offset: int = 0, kantor_cabang: str = "") -> dict:
    items = billing_checks()
    if kantor_cabang:
        items = [c for c in items if PROVIDER_BY_ID.get(c["faskes"], {}).get("kantor_cabang") == kantor_cabang]
    page, meta = _paginate(items, limit, offset)
    return {"checks": page, "pagination": meta}


_SCORES_CACHE: Optional[list] = None


@router.get("/risk-scores")
def get_risk_scores(limit: int = 50, offset: int = 0) -> dict:
    global _SCORES_CACHE
    if _SCORES_CACHE is None:
        _SCORES_CACHE = sorted((risk_score(c) for c in CLAIMS), key=lambda x: -x["skor"])
    page, meta = _paginate(_SCORES_CACHE, limit, offset)
    return {"scores": page, "pagination": meta}


@router.get("/prepayment/queue")
def prepayment_queue() -> dict:
    lanes = {"otomatis": [], "review": [], "hold": []}
    for c in [x for x in CLAIMS if x["status_bayar"] == "belum_dibayar"]:
        r = risk_score(c)
        issues = validate_billing(c)
        hard = any(i["jenis"] in HARD_STOP for i in issues) or c["no_sep"] in DUP_SEPS
        lane = "hold" if hard or r["skor"] >= 70 else "review" if r["skor"] >= 30 else "otomatis"
        lanes[lane].append({"no_sep": c["no_sep"], "faskes": c["faskes"], "skor": r["skor"], "tier": r["tier"],
                            "alasan": [f["penjelasan"] for f in r["factors"]] or ["Tidak ada anomali — lolos otomatis"],
                            "sla_menit": 0 if lane == "otomatis" else 240 if lane == "review" else 1440})
    return {"lanes": lanes, "ringkasan": {k: len(v) for k, v in lanes.items()}}


def _rate_ok(key: str) -> bool:
    now = time.time()
    hits = [t for t in _RATE.get(key, []) if now - t < 60]
    if len(hits) >= RATE_LIMIT_PER_MIN:
        _RATE[key] = hits
        return False
    hits.append(now)
    _RATE[key] = hits
    return True


@router.post("/prepayment/screen")
def screen(payload: ScreenClaim, request: Any = None, idempotency_key: Optional[str] = Header(default=None)) -> dict:
    """Skrining satu klaim sebelum dibayar. Tahap 4: rate-limit + idempotency + decision log."""
    client = getattr(getattr(request, "client", None), "host", "test") or "test"
    if not _rate_ok(client):
        raise HTTPException(429, "Terlalu banyak skrining dari klien ini (batas 60/menit) — coba lagi sesaat")
    if not isinstance(idempotency_key, str):
        idempotency_key = None
    if idempotency_key and idempotency_key in _IDEMPOTENCY:
        return {**_IDEMPOTENCY[idempotency_key], "idempotent_replay": True}
    t0 = time.perf_counter()
    c = _claim(9999, peserta=payload.peserta, faskes=payload.faskes if payload.faskes in PROVIDER_BY_ID else "RS-01",
               dokter=payload.dokter if payload.dokter in DOCTOR_BY_ID else "D-01", diagnosa=payload.diagnosa,
               prosedur=payload.prosedur if payload.prosedur in PROCEDURES else "NONE",
               severity_diklaim=payload.severity_diklaim, severity_didukung=payload.severity_didukung,
               tarif_klaim=payload.tarif_klaim,
               dokumen={"resume_medis": payload.dokumen_lengkap, "hasil_lab": payload.dokumen_lengkap,
                        "log_tindakan": payload.dokumen_lengkap, "kehadiran": payload.dokumen_lengkap})
    issues = validate_billing(c)
    r = risk_score(c)
    hard = any(i["jenis"] in HARD_STOP for i in issues)
    decision = "HOLD" if hard or r["skor"] >= 70 else "REVIEW" if r["skor"] >= 30 or issues else "AUTO_APPROVE"
    result = {"keputusan": decision, "skor_risiko": r["skor"], "tier": r["tier"], "issues": issues,
              "faktor_skor": r["factors"], "peer_benchmark": r["peer"],
              "jalur": "Pembayaran ditahan — buat investigation case" if decision == "HOLD" else
                       "Antrian review verifikator (SLA 4 jam)" if decision == "REVIEW" else "Bayar otomatis",
              "latensi_ms": round((time.perf_counter() - t0) * 1000, 2),
              "aturan_versi": {x["id"]: x["versi_aktif"] for x in RULES_REGISTRY}}
    DECISION_LOG.append({"waktu": time.strftime("%Y-%m-%d %H:%M:%S"), "peserta": payload.peserta, "faskes": payload.faskes,
                         "keputusan": decision, "skor": r["skor"], "latensi_ms": result["latensi_ms"]})
    _save_store()
    if idempotency_key:
        _IDEMPOTENCY[idempotency_key] = result
    return result


@router.get("/rules")
def get_rules() -> dict:
    return {"rules": RULES_REGISTRY, "connectors": CONNECTORS, "audit_trail": AUDIT_TRAIL,
            "lineage": ["e-Klaim/VClaim", "Rekam medis & lab", "Tarif kontrak & benefit", "Validasi billing (P3)",
                        "Risk scoring peer-benchmark (P4)", "Graf jaringan (P2)", "Investigation case (P1)", "Keputusan pre-payment (P5)"]}


@router.post("/rules/activate")
def activate_rule(payload: ActivateRule) -> dict:
    for rule in RULES_REGISTRY:
        if rule["id"] == payload.rule_id:
            known = [v["versi"] for v in rule["versi"]]
            if payload.versi not in known:
                raise HTTPException(400, f"Versi {payload.versi} tidak dikenal untuk {payload.rule_id}; tersedia {known}")
            old = rule["versi_aktif"]
            rule["versi_aktif"] = payload.versi
            for v in rule["versi"]:
                v["status"] = "aktif" if v["versi"] == payload.versi else "arsip"
            entry = _audit("API demo", f"Aktivasi aturan {rule['id']} v{payload.versi}", f"Menggantikan v{old}; tercatat di audit trail")
            return {"ok": True, "rule": rule, "audit": entry}
    raise HTTPException(404, f"Aturan {payload.rule_id} tidak ditemukan")


# --- Tahap 2: lifecycle aturan draft -> review -> aktif ---------------------

@router.post("/rules/draft")
def rule_draft(payload: RuleVersion) -> dict:
    for rule in RULES_REGISTRY:
        if rule["id"] == payload.rule_id:
            if any(v["versi"] == payload.versi for v in rule["versi"]):
                raise HTTPException(400, f"Versi {payload.versi} sudah ada untuk {payload.rule_id}")
            rule["versi"].append({"versi": payload.versi, "tanggal": time.strftime("%Y-%m-%d"),
                                  "perubahan": payload.perubahan, "status": "draft"})
            entry = _audit(payload.aktor, f"Draft aturan {rule['id']} v{payload.versi}", payload.perubahan)
            return {"ok": True, "rule": rule, "audit": entry}
    raise HTTPException(404, f"Aturan {payload.rule_id} tidak ditemukan")


@router.post("/rules/submit-review")
def rule_submit(payload: ActivateRule) -> dict:
    for rule in RULES_REGISTRY:
        if rule["id"] == payload.rule_id:
            for v in rule["versi"]:
                if v["versi"] == payload.versi:
                    if v["status"] != "draft":
                        raise HTTPException(400, f"Versi {payload.versi} berstatus {v['status']}, hanya draft yang bisa diajukan")
                    v["status"] = "review"
                    entry = _audit("Sistem", f"Aturan {rule['id']} v{payload.versi} masuk review", "Menunggu persetujuan sebelum aktif")
                    return {"ok": True, "rule": rule, "audit": entry}
            raise HTTPException(400, f"Versi {payload.versi} tidak ditemukan")
    raise HTTPException(404, f"Aturan {payload.rule_id} tidak ditemukan")


@router.post("/rules/approve")
def rule_approve(payload: ActivateRule) -> dict:
    """Persetujuan review -> aktif. Jalur resmi Tahap 2 (activate langsung tetap ada untuk demo)."""
    for rule in RULES_REGISTRY:
        if rule["id"] == payload.rule_id:
            target = next((v for v in rule["versi"] if v["versi"] == payload.versi), None)
            if not target:
                raise HTTPException(400, f"Versi {payload.versi} tidak ditemukan")
            if target["status"] != "review":
                raise HTTPException(400, f"Versi {payload.versi} berstatus {target['status']}; harus review dulu (draft -> review -> aktif)")
            old = rule["versi_aktif"]
            rule["versi_aktif"] = payload.versi
            for v in rule["versi"]:
                v["status"] = "aktif" if v["versi"] == payload.versi else ("arsip" if v["status"] == "aktif" else v["status"])
            entry = _audit("Approver", f"Persetujuan & aktivasi aturan {rule['id']} v{payload.versi}", f"Menggantikan v{old}")
            return {"ok": True, "rule": rule, "audit": entry}
    raise HTTPException(404, f"Aturan {payload.rule_id} tidak ditemukan")


# --- Tahap 3: job async, materialisasi, benchmark ---------------------------

def _run_batch_job(job_id: str) -> None:
    global _SCORES_CACHE
    job = JOBS[job_id]
    try:
        job["status"] = "running"
        scores = sorted((risk_score(c) for c in CLAIMS), key=lambda x: -x["skor"])
        MATERIALIZED.update({"skor": scores, "ring": GRAPH["networks"],
                             "dihitung_pada": time.strftime("%Y-%m-%d %H:%M:%S"), "jumlah_klaim": len(CLAIMS)})
        _SCORES_CACHE = scores
        job.update({"status": "selesai", "hasil": {"klaim_diskor": len(scores), "ring_terdeteksi": len(GRAPH["networks"]),
                                                   "skor_tertinggi": scores[0]["skor"] if scores else 0}})
        _save_store()
    except Exception as e:  # job tidak boleh membunuh proses
        job.update({"status": "gagal", "error": str(e)})


@router.post("/jobs/batch-scoring")
def start_batch_job() -> dict:
    job_id = f"JOB-{uuid.uuid4().hex[:8]}"
    JOBS[job_id] = {"id": job_id, "jenis": "batch-scoring & deteksi ring", "status": "antri", "dibuat": time.strftime("%Y-%m-%d %H:%M:%S")}
    threading.Thread(target=_run_batch_job, args=(job_id,), daemon=True).start()
    return JOBS[job_id]


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if job_id not in JOBS:
        raise HTTPException(404, f"Job {job_id} tidak ditemukan")
    return JOBS[job_id]


@router.get("/materialized")
def get_materialized() -> dict:
    if not MATERIALIZED:
        return {"status": "belum_ada", "pesan": "Jalankan POST /jobs/batch-scoring dulu"}
    return {"status": "ada", **MATERIALIZED}


@router.get("/benchmark")
def benchmark(iterasi: int = 200) -> dict:
    """Ukur latency skrining in-process (bukti target p95 Tahap 3)."""
    iterasi = max(10, min(iterasi, 2000))
    lat: list[float] = []
    sample = ScreenClaim(dokumen_lengkap=False, diagnosa="O80", prosedur="74.1", tarif_klaim=99_000_000)
    for _ in range(iterasi):
        t0 = time.perf_counter()
        c = _claim(9999, diagnosa=sample.diagnosa, prosedur=sample.prosedur, tarif_klaim=sample.tarif_klaim,
                   dokumen={"resume_medis": False, "hasil_lab": False, "log_tindakan": False, "kehadiran": False})
        validate_billing(c)
        risk_score(c)
        lat.append((time.perf_counter() - t0) * 1000)
    lat.sort()
    return {"iterasi": iterasi, "p50_ms": round(lat[len(lat) // 2], 3), "p95_ms": round(lat[int(len(lat) * 0.95)], 3),
            "maks_ms": round(lat[-1], 3), "target_p95_ms": 300, "lolos_target": lat[int(len(lat) * 0.95)] < 300}


# --- Tahap 4: feedback loop, metrik aturan, decision log --------------------

@router.post("/feedback")
def post_feedback(payload: Feedback) -> dict:
    if payload.verdict not in ("fraud", "legit"):
        raise HTTPException(400, "verdict harus 'fraud' atau 'legit'")
    if payload.no_sep not in CLAIM_BY_SEP and payload.no_sep not in {c["no_sep"] for c in billing_checks()}:
        raise HTTPException(404, f"SEP {payload.no_sep} tidak dikenal")
    FEEDBACK.append({"no_sep": payload.no_sep, "verdict": payload.verdict, "aktor": payload.aktor,
                     "waktu": time.strftime("%Y-%m-%d %H:%M:%S")})
    _save_store()
    return {"ok": True, "metrics": rule_metrics()}


def rule_metrics() -> dict:
    """Hit & FP rate dari verdict investigator (bukan angka statis)."""
    flagged = {c["no_sep"] for c in billing_checks()}
    judged = [f for f in FEEDBACK if f["no_sep"] in flagged]
    tp = len([f for f in judged if f["verdict"] == "fraud"])
    fp = len([f for f in judged if f["verdict"] == "legit"])
    return {"feedback_total": len(FEEDBACK), "terkonfirmasi_fraud": tp, "false_positive": fp,
            "false_positive_rate_aktual": round(fp / max(tp + fp, 1), 3) if judged else None,
            "aturan_registry": [{"id": r["id"], "hit_rate_statis": r["hit_rate"], "fp_rate_statis": r["false_positive_rate"]} for r in RULES_REGISTRY]}


@router.get("/metrics")
def get_metrics() -> dict:
    return rule_metrics()


@router.get("/decisions")
def get_decisions(limit: int = 50, offset: int = 0) -> dict:
    page, meta = _paginate(list(reversed(DECISION_LOG)), limit, offset)
    return {"decisions": page, "pagination": meta}
