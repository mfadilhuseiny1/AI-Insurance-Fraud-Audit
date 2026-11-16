"""IoT verification layer of the AI Agent Swarm Branch audit: medical-device USAGE against what the claim bills.

The user (2026-11-15), with the infographic "Generative AIoT for Intelligent Claim Verification": a current clamp on a medical
device's power cable (the device is never opened) records WHEN the device is on, for how long, and its STATE from the power draw
(ventilator jalan / siaga / mati, dialysis machine jalan / idle, ICU bed monitor nyala / mati, infusion pump jalan / idle) -> AIoT
platform -> automatic check of the claim against the device -> a tamper-proof log (Merkle root per episode, anchored before the
claim) -> the BPJS verifier decides. No patient parameter is measured: no SpO2, blood pressure or vitals. The layer answers one
question per claim: was the device running for the hours the claim bills? A clamp cannot tell a tube from a mask (the user,
2026-11-15: the IoT layer drops that distinction), so a ventilator is only "jalan" (giving breaths), "siaga" (standby) or "mati".

INA-CBG pays very differently for invasive ventilation of >= 96 consecutive hours and < 96 hours (generator sample, regional 5,
class 3, median): ICD-9-CM 96.72 groups to J-1-02-x "VENTILASI MEKANIKAL LONG TERM TANPA TRAKEOSTOMI" (I 26.4 / II 45.6 / III 65.0
million rupiah), 96.71 to J-1-20-x "PROSEDUR SISTEM PERNAFASAN NON KOMPLEKS" (I 16.5 / II 22.9 / III 33.5 million). Per hospital the
tariff comes from the generator's tariff table (code x regional x hospital type x ownership x class), see Tarif.

Two parts, so real inputs go through the same checks (format: docs/IOT_FORMAT_MASUKAN.md):
  generate(set_name, out_dir=None, kc=None, seed=SEED) -> dict
        SYNTHETIC. For a run's branch: IoT coverage at the ICU-capable hospitals (fixed seed), a device fleet (ventilators,
        dialysis machines, ICU bed monitors, infusion pumps, one gateway per hospital), device-use sessions bound to a patient and
        a visit (binding), readings every 5-10 minutes while bound (hourly otherwise) with sesi_id, seq and a sha256 per reading,
        and one Merkle root per visit over its readings and binding events, anchored before the claim. Ventilator readings are
        jalan / siaga / mati only. Honest usage for every device-billing claim at a covered hospital (96.7x, 93.90, dialysis),
        plus 12 planted fraud patients (all usage time) and a few alert-only events (offline gateway,
        revoked device key, readings with no bound patient, evidence altered after anchoring, a late anchor). Writes the input
        folder (default data/aip/cabang/iot/<set>/masukan) and the ground truth kunci_benar.json NEXT TO it (never inside it).
        gen3 runs carry no procedure codes and KC Makassar has no ventilator-group claim, so the ventilated stays are SYNTHETIC
        additions to existing inpatient claims (klaim_alat.json, sumber "tambahan_sintetis"); a fraud claim that bills 96.72 /
        96.71 is grouped as the hospital's grouper would group it (J-1-02-II / J-1-20-II, keeping the claim's severity III) and the
        run's own code and tariff stay in `klaim_asli`. Honest ventilated claims keep their run code (the sample also groups
        96.71/96.72 claims by diagnosis: I-4-24, A-4-14, P-8-08 ...). ML/swarm results are never touched.
  periksa(set_name, iot_dir=None, kc=None) -> dict
        The CHECKER: reads ANY folder in the input format plus the run's claims, never the ground truth (an older folder with the
        iot-1 ventilator modes invasif / noninvasif / standby is read as jalan / jalan / siaga after its hashes are checked), and writes
        data/aip/cabang/iot/<set>/{bukti.json, alat.json, ringkasan.json, monitoring.json}. Deterministic rules, white-box: every
        result says what was billed, what was measured, the rule, the numbers and the tariff difference. Missing readings count
        in the claim's favour; an offline gateway gives "tanpa_bukti", never an accusation.

Rules (aturan): vent_run_96 (96.72 billed, the ventilator's longest uninterrupted "jalan" run < 96 h), vent_standby (ventilation
billed, the ventilator only on "siaga", never ran), vent_hours (more ventilation hours billed than it ran), binding_tumpang (the
device was bound to another patient at the same hours), no_device_trace (device use billed, no session or reading while the
hospital's gateway was online), hd_short (< 3 h of dialysis billed as a full session), hd_phantom (machine ran no session),
icu_days (ICU days billed above the ICU bed monitor's on-time + 1 day), anchor_mismatch (readings no longer hash to the anchored
root), faskes_offline (no reading because the gateway was offline). Alerts only: late_anchor, kunci_dicabut, tanpa_pasien, offline.

CLI:
  .venv/Scripts/python.exe testing/iot_cabang.py generate --set gen3_kc2 --kc sul-7371 [--seed N] [--keluar DIR]
  .venv/Scripts/python.exe testing/iot_cabang.py periksa --set gen3_kc2 --kc sul-7371 [--iot DIR]
  .venv/Scripts/python.exe testing/iot_cabang.py --set gen3_kc2 --kc sul-7371            (both: generate, then periksa)
Synthetic data only; patients appear as P-xxxx (the report's pseudonym)."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "api"))

SEED = 20261115
FORMAT = "iot-cabang/1"
LEDGER = "sha256-merkle/1"
BASE = datetime(2020, 1, 1)
SENSOR = "sensor clamp pada kabel daya (tanpa membuka alat): waktu nyala & status jalan/siaga/mati"
# per device type: id prefix, name, the states the clamp tells apart (from the power draw), which of them count as "in use", the
# current band (A) of each state, and the reading cadence while bound to a patient (minutes). A ventilator: jalan (giving breaths)
# or siaga (standby, powered, no breaths); the clamp cannot tell how the patient is ventilated
JENIS = {
    "ventilator": {"pfx": "VNT", "nama": "Ventilator ICU", "label": "Ventilator", "mode": ("jalan", "siaga"),
                   "aktif": ("jalan",), "arus": {"jalan": (0.9, 2.3), "siaga": (0.12, 0.3), "mati": (0.0, 0.0)},
                   "batas": ((0.05, "mati"), (0.5, "siaga"), (99.0, "jalan")), "cad": 10},
    "hemodialisis": {"pfx": "HDM", "nama": "Mesin hemodialisis", "label": "Mesin hemodialisis", "mode": ("jalan", "idle"), "aktif": ("jalan",),
                     "arus": {"jalan": (5.5, 8.5), "idle": (0.4, 0.9), "mati": (0.0, 0.0)}, "batas": ((0.1, "mati"), (2.0, "idle"), (99.0, "jalan")), "cad": 5},
    "monitor_icu": {"pfx": "ICU", "nama": "Monitor bed ICU", "label": "Monitor bed ICU", "mode": ("nyala", "mati"), "aktif": ("nyala",),
                    "arus": {"nyala": (0.25, 0.45), "mati": (0.0, 0.0)}, "batas": ((0.1, "mati"), (99.0, "nyala")), "cad": 10},
    "pompa_infus": {"pfx": "INF", "nama": "Pompa infus", "label": "Pompa infus", "mode": ("jalan", "idle"), "aktif": ("jalan",),
                    "arus": {"jalan": (0.08, 0.16), "idle": (0.02, 0.05), "mati": (0.0, 0.0)}, "batas": ((0.01, "mati"), (0.06, "idle"), (99.0, "jalan")), "cad": 10},
}
GATEWAY = "gateway"
CAD_IDLE = 60
HD_STANDAR_MENIT = 240  # a standard dialysis session: 4 hours
HD_MIN_MENIT = 180      # under 3 hours is not a full session
AMBANG_VENT = 96
# diagnoses a ventilated / ICU stay fits (ICD-10, first characters): pneumonia, bronchitis, asthma/COPD, respiratory failure,
# ischaemic heart disease, heart failure / arrest, stroke, sepsis and severe infections, dengue, TB, CNS infection / seizures,
# neonatal respiratory distress, peritonitis / obstruction, brain tumour, head injury, poisoning
DX_VENT = ("J1", "J2", "J4", "J8", "J9", "I2", "I4", "I5", "I6", "A4", "A16", "A9", "B34", "G0", "G4", "G6", "G9", "P2", "K65", "K56", "D33", "S06", "T")
KATEGORI_ICU = ("Kelas A", "Kelas B", "Type A", "Type B", "Khusus Jantung", "Kelas II")
KATEGORI_C = ("Kelas C", "Type C")
NAMA_MODE = {"jalan": "jalan", "siaga": "siaga", "idle": "siaga", "nyala": "menyala", "mati": "mati"}
# an iot-1 input's ventilator modes (before 2026-11-15) -> the clamp's states; applied after each reading's hash is checked
MODE_LAMA = {"invasif": "jalan", "noninvasif": "jalan", "non_invasif": "jalan", "standby": "siaga"}
PROSEDUR = {"96.72": "ventilasi mekanik ≥ 96 jam berturut-turut", "96.71": "ventilasi mekanik < 96 jam berturut-turut",
            "96.70": "ventilasi mekanik (durasi tidak disebut)", "93.90": "ventilasi mekanik kode 93.90 (tanpa syarat jam)", "39.95": "hemodialisis"}
GRUP_VENT = {"96.72": "J-1-02", "96.71": "J-1-20"}  # the sample's grouping of the ventilation procedures (see the docstring)
# the 12 planted fraud patients (the user, 2026-11-15: "make it 12 — for IoT based"), all usage time: rule and its variant (the two
# tube-vs-mask cases of before became a sixth short run and a 96.72 bill on a ventilator that only stood by)
# every planted case shows the device switched on, for fewer hours than billed (the user, 2026-11-15: "ventilator dinyalain tapi jam nya
# ga sesuai, bukan 0 dan ga dinyalain sama sekali"): ventilators run 38-94 h on a 96.72 bill, one run 5 h then left on standby billed as
# 96.72, one run 8 h billed as ~45 h of 96.71, a patient ventilated a few hours on their own device then billed on a device serving
# another patient, ICU days above the monitor's on-time, and two short dialysis sessions (95 and 70 min) billed as full ones
FRAUD_SPEK = [("binding_tumpang", "96.71"), ("vent_run_96", 38), ("vent_run_96", 52), ("vent_run_96", 63), ("vent_run_96", 71), ("vent_run_96", 88),
              ("vent_run_96", 94), ("vent_sebagian", "96.72"), ("vent_sebagian", "96.71"), ("icu_days", 6), ("hd_short", 95), ("hd_short", 70)]
JALAN_SEBAGIAN = {"96.72": 5.0, "96.71": 8.0}  # hours a "vent_sebagian" ventilator ran before it was left on standby
JUDUL_ATURAN = {
    "vent_run_96": "Kode 96.72 (≥ 96 jam) ditagih, ventilator tidak pernah jalan 96 jam berturut-turut",
    "vent_standby": "Ventilasi ditagih, ventilator hanya siaga (standby) dan tidak pernah jalan",
    "vent_hours": "Jam ventilasi ditagih melebihi jam ventilator jalan",
    "binding_tumpang": "Alat yang sama terikat ke pasien lain pada jam yang sama: pemakaian ditagih dua kali",
    "no_device_trace": "Pemakaian alat ditagih tanpa satu pun sesi atau pembacaan alat",
    "hd_short": "Sesi hemodialisis di bawah 3 jam ditagih sebagai sesi penuh",
    "hd_phantom": "Hemodialisis ditagih, mesin tidak menjalankan sesi",
    "icu_days": "Hari ICU ditagih melebihi waktu monitor bed ICU menyala",
    "anchor_mismatch": "Pembacaan alat tidak cocok dengan jangkar bukti (diubah setelah dijangkarkan)",
    "faskes_offline": "Tidak ada pembacaan: gateway RS sedang offline",
    "vent_sesuai": "Ventilasi yang ditagih didukung catatan ventilator",
    "hd_sesuai": "Sesi hemodialisis yang ditagih didukung catatan mesin",
    "icu_sesuai": "Hari ICU yang ditagih didukung catatan monitor ICU",
}
LANGKAH = {
    "vent_run_96": ["Minta log ventilator (jam pasang, jam lepas, jam jalan dan siaga) dan lembar observasi ICU untuk seluruh masa ventilasi.",
                    "Cocokkan jam ventilasi di E-Klaim dengan sesi alat: 96.72 hanya sah bila ventilator jalan ≥ 96 jam tanpa putus.",
                    "Bila tidak didukung, koreksi prosedur ke 96.71 (grup < 96 jam) dan tagih kembali selisih tarifnya."],
    "vent_standby": ["Minta lembar observasi ventilator (jam pasang, jam lepas, setelan tiap shift) dan log ventilator.",
                     "Sensor clamp mencatat alat hanya siaga (standby): menyala tetapi tidak pernah jalan memberi napas.",
                     "Bila ventilasi tidak terjadi, koreksi klaim ke grup tanpa ventilasi mekanik dan tagih kembali selisihnya."],
    "vent_hours": ["Minta log ventilator dan lembar observasi ICU.", "Koreksi jam ventilasi di E-Klaim ke jam ventilator jalan yang tercatat alat."],
    "binding_tumpang": ["Minta jadwal pemakaian ventilator dan daftar pasien ICU pada jam yang sama.",
                        "Satu alat hanya bisa dipakai satu pasien: pastikan pasien mana yang benar memakainya.",
                        "Koreksi klaim yang menagih pemakaian alat yang sedang dipakai pasien lain."],
    "no_device_trace": ["Minta catatan pemakaian alat (lembar tindakan, catatan perawat) untuk hari layanan.",
                        "Gateway RS online saat itu, jadi ketiadaan pembacaan bukan gangguan jaringan.",
                        "Bila layanan tidak terjadi, tolak klaim dan laporkan ke tim pencegahan kecurangan."],
    "hd_short": ["Minta lembar tindakan hemodialisis (jam mulai, jam selesai, alasan berhenti).",
                 "Sesi di bawah 3 jam bukan sesi penuh; bila dihentikan karena alasan klinis, alasan itu harus tercatat.",
                 "Bila tidak ada alasan klinis, koreksi pembayaran sesi itu."],
    "hd_phantom": ["Minta lembar tindakan hemodialisis.", "Mesin menyala tanpa menjalankan sesi: pastikan sesi benar terjadi.",
                   "Bila tidak terjadi, tolak klaim sesi itu."],
    "icu_days": ["Minta catatan pindah ruang (ICU ke bangsal) dan lembar observasi ICU harian.",
                 "Cocokkan hari ICU di E-Klaim dengan jam monitor bed ICU menyala.", "Koreksi hari ICU ke yang tercatat dan hitung ulang tagihannya."],
    "anchor_mismatch": ["Minta RS mengirim ulang data alat langsung dari gateway, bukan salinan.",
                        "Bukti yang tidak cocok dengan jangkarnya tidak bisa dipakai: putuskan dari dokumen klinis.",
                        "Laporkan perubahan data setelah dijangkarkan ke tim pencegahan kecurangan."],
    "faskes_offline": ["Minta RS mengirim data alat setelah gateway tersambung kembali.", "Bukan tuduhan: tidak ada pembacaan karena jaringan RS terputus."],
    "sesuai": ["Tidak perlu tindakan untuk pemakaian alat: catatan alat mendukung tagihan."],
}
CATATAN_ATURAN = {
    "vent_run_96": "Bisa wajar bila ventilator dipindah atau sensor terlepas sementara; pembacaan yang hilang sudah dihitung menguntungkan klaim.",
    "vent_standby": "Status jalan/siaga dibaca dari pola arus listrik; bisa wajar bila ventilator lain yang belum bersensor yang dipakai: minta bukti alat itu.",
    "binding_tumpang": "Bisa wajar bila salah pilih alat saat mengikat pasien; jadwal ruang ICU menunjukkan alat yang benar.",
    "no_device_trace": "Bisa wajar bila layanan memakai alat yang belum terpasang sensor; minta bukti alat itu.",
    "hd_short": "Bisa wajar bila sesi dihentikan karena alasan klinis (hipotensi, masalah akses); alasan itu harus tercatat.",
    "icu_days": "Bisa wajar bila monitor dimatikan saat pasien masih di ICU (mis. dipindah ke bed lain tanpa sensor).",
}


# ======================================================================================================== shared helpers
def sha(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def merkle_root(daun: list[str]) -> str:
    """Sorted-pair sha256 Merkle root over hex leaves (synthetic-iomt's scheme)."""
    if not daun:
        return "0x" + "00" * 32
    lap = [hashlib.sha256(bytes.fromhex(h)).digest() for h in daun]
    while len(lap) > 1:
        nxt = []
        for i in range(0, len(lap), 2):
            if i + 1 < len(lap):
                a, b = lap[i], lap[i + 1]
                nxt.append(hashlib.sha256(a + b if a <= b else b + a).digest())
            else:
                nxt.append(lap[i])
        lap = nxt
    return "0x" + lap[0].hex()


def menit(s: str) -> int:
    """'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM[:SS]' (WIB) -> minutes since 2020-01-01."""
    s = str(s).strip().replace(" ", "T")
    d = datetime.strptime(s[:16], "%Y-%m-%dT%H:%M") if len(s) >= 16 else datetime.strptime(s[:10], "%Y-%m-%d")
    return int((d - BASE).total_seconds() // 60)


def iso(m: float) -> str:
    return (BASE + timedelta(minutes=int(m))).strftime("%Y-%m-%dT%H:%M")


def tanggal(m: float) -> str:
    return iso(m)[:10]


def jam(v: float, n: int = 1) -> float:
    return round(float(v), n)


def angka(v: float, n: int = 0) -> str:
    return f"{float(v):,.{n}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def rp(v: float) -> str:
    v = float(v)
    return f"Rp {angka(v / 1e6, 1)} jt" if abs(v) >= 1e6 else f"Rp {angka(v)}"


def jam_teks(h: float) -> str:
    h = float(h)
    if h < 3 and abs(h * 60 - round(h * 60)) < 1e-6 and h * 60 % 60:
        j, m = divmod(int(round(h * 60)), 60)
        return f"{j} jam {m} menit" if j else f"{m} menit"
    return f"{angka(h, 1 if h % 1 else 0)} jam"


def samaran(peserta: str) -> str:
    return f"P-{str(peserta)[-4:]}"  # = laporan_cabang (the case file's member pseudonym)


def id_kasus(kunci: str) -> str:
    return "KLM-" + hashlib.md5(str(kunci).encode()).hexdigest()[:8].upper()  # = laporan_cabang's case id


def kunci_acak(seed: int, *x) -> str:
    return hashlib.md5("|".join(str(v) for v in (seed, *x)).encode()).hexdigest()


def basis_iot() -> Path:
    return Path(os.environ.get("CABANG_BASIS") or ROOT / "data" / "aip" / "cabang") / "iot"


def kanon_baca(r: dict) -> str:
    return f"{r['device_id']}|{r.get('sesi_id') or ''}|{r['ts']}|{int(r['seq'])}|{int(r['interval_s'])}|{float(r['arus_a']):.2f}|{r['mode']}"


def kanon_ikat(s: dict) -> list[str]:
    """The binding events of a session, as the Merkle chain holds them: BIND when the device is attached, UNBIND when released."""
    out = [f"BIND|{s['sesi_id']}|{s['device_id']}|{s['peserta']}|{s['kunjungan']}|{s['mulai']}"]
    if s.get("selesai"):
        out.append(f"UNBIND|{s['sesi_id']}|{s['selesai']}|{s.get('alasan_selesai') or ''}")
    return out


def potong_segmen(baris) -> list[tuple[int, int, str]]:
    """Mode runs of a session from its readings [(minute, interval minutes, mode)] in sequence order: a new run where the mode
    changes; a run ends at its last reading's end. The generator and the checker cut sessions the same way."""
    out, cur = [], None
    for m, iv, mode in baris:
        if cur and mode == cur[2]:
            cur[1] = int(m) + int(iv)
        else:
            if cur:
                out.append(tuple(cur))
            cur = [int(m), int(m) + int(iv), mode]
    if cur:
        out.append(tuple(cur))
    return out


JENIS_MESIN = {"ventilator": "ventilator", "hemodialisis": "hemodialisis", "monitor_icu": "icu", "pompa_infus": "infus"}
MODE_MESIN = {"noninvasif": "non_invasif"}  # an iot-1 input's record name for its anchor (the engine reads either as "jalan")


def rekaman_mesin(s: dict, jenis: str, segmen: list, ikat_lain: bool = False, aktif: str | None = None) -> list[dict]:
    """A binding session as the realtime engine's session records (api/aip/realtime/iot.py `sesi`): one record per mode run, "mati"
    left out. A binding with no reading of its own because the device was serving another patient at the time (ikat_lain) is one
    record over the binding in the device's active mode (`aktif`, default "jalan": what the hospital bound and billed). These
    records are what a visit's anchor covers (merkle_root = iot.akar_sesi over them), so they keep the mode names the readings
    were anchored with (an iot-1 input: invasif / non_invasif / standby)."""
    if jenis not in JENIS_MESIN:
        return []
    seg = [x for x in segmen if x[2] != "mati"]
    if not segmen and ikat_lain:
        a = menit(s["mulai"])
        seg = [(a, menit(s["selesai"]) if s.get("selesai") else a, aktif or JENIS[jenis]["aktif"][0])]
    return [{"sesi_id": f"{s['sesi_id']}#{n}", "device_id": str(s["device_id"]), "jenis": JENIS_MESIN[jenis], "peserta": str(s["peserta"]),
             "kunjungan": str(s["kunjungan"]), "mulai": iso(x0) + ":00+07:00", "selesai": iso(x1) + ":00+07:00", "mode": MODE_MESIN.get(m, m)}
            for n, (x0, x1, m) in enumerate(seg)]


def mesin_iot():
    """The realtime engine's IoT module (its anchor scheme and rules), or None when it is not there."""
    try:
        from aip.realtime import iot as RT

        return RT
    except Exception:  # noqa: BLE001
        return None


def tulis_json(p: Path, d: object) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, default=_py), "utf-8")
    tmp.replace(p)


def _py(o):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, (set, tuple)):
        return list(o)
    raise TypeError(type(o))


# ======================================================================================================== the run's claims
def klaim_run(set_name: str, kc: str | None = None) -> dict:
    """The branch's claims of a run, as laporan_cabang reads them (claim key <set>:<chunk>:<row>), with the hospital profiles and
    the branch map. A theme set (testing/jalan_kc_tema.py) also carries the visit id, replica and the dataset's procedure codes."""
    import laporan_cabang as LC

    SET = LC.SET_ROOT / set_name
    files = sorted(SET.glob("hasil_[0-9][0-9].npz"))
    if not files:
        raise SystemExit(f"{SET}: tidak ada hasil_NN.npz (set {set_name})")
    if LC.RIIL:
        rs = json.loads(Path(LC.RIIL_RS).read_text("utf-8"))
    else:
        import generator3 as G

        rs = G.dunia().rs
    P = LC.bagi_kc(rs)
    raw = [(int(f.stem.split("_")[1]), dict(np.load(f, allow_pickle=False))) for f in files]
    if not kc:  # the branch of the set's report, else the branch with the most claims
        ada = sorted((LC.BASIS / set_name).glob("kc_*.json"))
        if len(ada) == 1:
            kc = ada[0].stem[3:]
        else:
            n = Counter(P["kab_kc"][rs[str(fk)]["kab"]] for _, r in raw for fk in r["faskes"] if str(fk) in rs)
            kc = n.most_common(1)[0][0]
    zona: dict[str, str] = {}
    zf = LC.KERJA / f"zona_{set_name}.npz"
    if zf.exists():  # the generator prefers claims the model let pass for its planted cases (the checker never reads this)
        z = np.load(zf, allow_pickle=False)
        for k, t, g in zip(z["kunci"], z["tahan"], z["ragu"]):
            zona[str(k)] = "TAHAN" if t else "RAGU" if g else "LOLOS"
    rows = []
    for c, r in raw:
        n = len(r["kode"])
        for i in range(n):
            fk = str(r["faskes"][i])
            if fk not in rs or P["kab_kc"].get(rs[fk]["kab"]) != kc:
                continue
            k = f"{set_name}:{c}:{i}"
            rows.append({"kunci": k, "c": c, "i": i, "faskes": fk, "peserta": str(r["peserta"][i]), "kode": str(r["kode"][i]),
                         "dx": str(r["dx"][i]) if "dx" in r else "", "los": int(r["los"][i]), "tgl": str(r["tgl"][i]), "tingkat": str(r["tingkat"][i]),
                         "kelas": str(r["kelas"][i]), "tarif": int(r["tarif"][i]), "biaya": int(r["biaya"][i]), "topup": int(r["topup"][i]),
                         "kunjungan": str(r["kunjungan"][i]) if "kunjungan" in r else k, "replika": int(r["replika"][i]) if "replika" in r else 0,
                         "y": int(r["y"][i]) if "y" in r else 0, "zona": zona.get(k, "LOLOS"), "di_zona": (k in zona) if zona else True, "prosedur": []})
    # a theme dataset's procedure codes (klaim_semua.parquet `prosedur`: "9671 - Continuous ...;3995 - Hemodialysis")
    rep = SET / "replika.json"
    if rep.exists() and rows and rows[0]["kunjungan"] != rows[0]["kunci"]:
        data = Path(str(json.loads(rep.read_text("utf-8")).get("data") or ""))
        pq = data / "klaim" / "klaim_semua.parquet"
        if pq.exists():
            import duckdb

            ids = sorted({r["kunjungan"] for r in rows})
            con = duckdb.connect()
            con.register("ids", __import__("pandas").DataFrame({"k": ids}))
            pro = dict(con.execute(f"SELECT kunjungan_fkrtl_id, prosedur FROM read_parquet('{pq.as_posix()}') JOIN ids ON k = kunjungan_fkrtl_id "
                                   "WHERE prosedur IS NOT NULL").fetchall())
            for r in rows:
                p = pro.get(r["kunjungan"]) or ""
                r["prosedur"] = [f"{x.strip()[:2]}.{x.strip()[2:4]}" for x in (s.split(" - ")[0] for s in p.split(";")) if len(x.strip()) >= 3]
    nama = LC.nama_rs(rs)
    return {"set": set_name, "kc": P["kc"][kc], "rows": rows, "rs": rs, "nama_rs": nama, "LC": LC}


# ======================================================================================================== tariffs
class Tarif:
    """INA-CBG tariffs for a code at a hospital and ward class: the generator's tariff table (all of 2024's sample, code x regional
    x hospital type x ownership x class, with its sibling rule), else the sample's median for the code at the same regional + type +
    class, + class, regional, the code alone; for a real run (no generator) the run's own median for the code. The source is
    kept with every number."""

    def __init__(self, rows: list[dict]) -> None:
        self.D = self.con = None
        try:
            import generator3 as G

            self.D = G.dunia()
            self.con = G._con()
        except Exception:  # noqa: BLE001 - a real run has no generator world
            pass
        self.rs = self.D.rs if self.D else {}
        med: dict[str, list] = defaultdict(list)
        for r in rows:
            med[r["kode"]].append(r["tarif"])
        self.run_med = {k: int(np.median(v)) for k, v in med.items()}
        self._lv: dict[str, dict] = {}
        self._grup: dict[tuple, str | None] = {}
        self.desk: dict[str, str] = {}

    def _level(self, kode: str) -> dict:
        if kode not in self._lv:
            d: dict = {}
            if self.con is not None:
                q = self.con.execute("""SELECT regional_tarif, tipe_fkrtl, kelas_rawat, tarif_inacbg_rp, inacbg_deskripsi FROM s WHERE inacbg_kode = ?""", [kode]).fetchall()
                for reg, tipe, kls, t, des in q:
                    self.desk.setdefault(kode, des)
                    for key in ((reg, tipe, kls), (reg, None, kls), (reg, None, None), (None, None, None)):
                        d.setdefault(key, []).append(float(t))
                minimal = {0: 5, 1: 5, 2: 3, 3: 1}
                d = {k: int(np.median(v)) for k, v in d.items() if len(v) >= minimal[sum(x is None for x in k)]}
            self._lv[kode] = d
        return self._lv[kode]

    def kandidat(self, kode: str, faskes: str, kelas: str) -> list[tuple[int, int, str]]:
        """(level, tariff, source) from the most specific level down."""
        out = []
        r = self.rs.get(faskes) or {}
        if self.D is not None and r:
            t = self.D.tarif_of(kode, faskes, kelas)
            if t:
                out.append((0, int(t), "tabel tarif INA-CBG sampel (kode × regional × tipe RS × kepemilikan × kelas)"))
        lv = self._level(kode)
        reg, tipe = r.get("regional"), r.get("tipe")
        for n, (key, src) in enumerate((((reg, tipe, kelas), "median sampel: kode × regional × tipe RS × kelas (≥ 5 klaim)"),
                                        ((reg, None, kelas), "median sampel: kode × regional × kelas (≥ 5 klaim)"),
                                        ((reg, None, None), "median sampel: kode × regional (≥ 3 klaim)"), ((None, None, None), "median sampel nasional untuk kode ini")), 1):
            if key in lv:
                out.append((n, lv[key], src))
        if kode in self.run_med:
            out.append((9, self.run_med[kode], "median tarif kode ini di run"))
        return out

    def tarif(self, kode: str, faskes: str, kelas: str) -> tuple[int | None, str]:
        k = self.kandidat(kode, faskes, kelas)
        return (k[0][1], k[0][2]) if k else (None, "tarif tidak ditemukan")

    def pasangan(self, a: str, b: str, faskes: str, kelas: str) -> tuple[int | None, int | None, str]:
        """Both tariffs at the most specific level where both exist (a difference across levels would compare unlike tables)."""
        ka, kb = {lv: (t, s) for lv, t, s in self.kandidat(a, faskes, kelas)}, {lv: (t, s) for lv, t, s in self.kandidat(b, faskes, kelas)}
        for lv in sorted(set(ka) & set(kb)):
            return ka[lv][0], kb[lv][0], ka[lv][1]
        ta, sa = self.tarif(a, faskes, kelas)
        tb, _ = self.tarif(b, faskes, kelas)
        return ta, tb, sa

    def lawan(self, a: str, tarif_a: int, b: str, faskes: str, kelas: str) -> tuple[int | None, str]:
        """b's tariff at the table level where a's tariff equals the billed one (so the difference compares one table); else the
        most specific common level."""
        kb = {lv: (t, s) for lv, t, s in self.kandidat(b, faskes, kelas)}
        for lv, t, s in self.kandidat(a, faskes, kelas):
            if int(t) == int(tarif_a) and lv in kb:
                return kb[lv][0], kb[lv][1]
        _, tb, src = self.pasangan(a, b, faskes, kelas)
        return tb, src

    def grup_medis(self, dx3: str, sev: str) -> str | None:
        """The diagnosis's most common inpatient group without a procedure (type 4) at that severity in the sample: what a claim
        whose ventilation is not supported would be grouped to."""
        key = (dx3, sev)
        if key not in self._grup:
            g = None
            if self.con is not None and dx3:
                q = self.con.execute("""SELECT inacbg_kode, count(*) n FROM s WHERE dx_primer_icd3 = ? AND tingkat_pelayanan = 'RITL'
                                        AND substr(inacbg_kode, 3, 1) = '4' GROUP BY 1 ORDER BY (inacbg_kode LIKE ?) DESC, n DESC, inacbg_kode LIMIT 1""",
                                     [dx3, f"%-{sev}"]).fetchall()
                g = q[0][0] if q else None
            self._grup[key] = g
        return self._grup[key]

    def deskripsi(self, kode: str) -> str:
        if kode not in self.desk:
            self._level(kode)
        return self.desk.get(kode, "")


def sev_of(kode: str) -> str:
    s = kode.rsplit("-", 1)[-1]
    return s if s in ("I", "II", "III") else "I"


# ======================================================================================================== GENERATOR (synthetic)
def _tier(r: dict) -> str:
    t = f"{r.get('tipe') or ''}"
    if "Kelas A" in t or "Type A" in t:
        return "A"
    if any(x in t for x in KATEGORI_ICU):
        return "B"
    return "C"


class _Bangun:
    """One synthetic IoT world for a branch: coverage, fleet, plans, sessions, readings, anchors."""

    def __init__(self, K: dict, seed: int) -> None:
        self.K, self.seed = K, seed
        self.rng = np.random.default_rng(seed)
        self.rows = K["rows"]
        self.T = Tarif(self.rows)
        self.alat: dict[str, dict] = {}            # device_id -> device
        self.sibuk: dict[tuple, list] = defaultdict(list)  # (device, replica) -> [(start, end)]
        self.sesi: list[dict] = []
        self.seg: dict[tuple, list] = defaultdict(list)    # (device, replica) -> [(start, end, mode, sesi_id)]
        self.rencana: dict[str, dict] = {}         # claim key -> plan
        self.kebenaran: dict[str, dict] = {}       # ground truth per claim
        self.peringatan_tanam: list[dict] = []
        self.offline: dict[tuple, list] = defaultdict(list)  # (faskes, replica) -> [(start, end)]
        self.n_sesi = 0
        self.nomor: Counter = Counter()

    def u(self, a: float, b: float) -> float:
        return float(self.rng.uniform(a, b))

    def urut(self, xs: list[dict], *extra) -> list[dict]:
        return sorted(xs, key=lambda r: kunci_acak(self.seed, r["kunci"], *extra))

    # ---------------------------------------------------------------- coverage and fleet
    def pilih_rs(self) -> None:
        n = Counter(r["faskes"] for r in self.rows)
        rs = self.K["rs"]
        ab = [f for f in n if (rs[f].get("jenis") == "Rumah sakit") and _tier(rs[f]) in "AB" and (n[f] >= 30 or "Jantung" in (rs[f].get("tipe") or ""))]
        c = sorted([f for f in n if rs[f].get("jenis") == "Rumah sakit" and any(x in (rs[f].get("tipe") or "") for x in KATEGORI_C) and n[f] >= 40],
                   key=lambda f: (-n[f], f))[:2]
        self.cakup = sorted(set(ab) | set(c), key=lambda f: (-n[f], f))
        self.hd_rs = {r["faskes"] for r in self.rows if r["kode"] == "N-3-15-0"}
        per = {"A": {"ventilator": 3, "monitor_icu": 3, "pompa_infus": 2, "hemodialisis": 3},
               "B": {"ventilator": 2, "monitor_icu": 2, "pompa_infus": 1, "hemodialisis": 2},
               "C": {"ventilator": 1, "monitor_icu": 1, "pompa_infus": 0, "hemodialisis": 1}}
        for f in self.cakup:
            t = _tier(rs[f])
            for j in ("ventilator", "monitor_icu", "pompa_infus", "hemodialisis"):
                if j == "hemodialisis" and f not in self.hd_rs:
                    continue
                for _ in range(per[t][j]):
                    self.alat_baru(f, j)
            self.alat_baru(f, GATEWAY)

    def alat_baru(self, f: str, jenis: str) -> str:
        kab = self.K["rs"][f]["kab"]
        pfx = "GW" if jenis == GATEWAY else JENIS[jenis]["pfx"]
        self.nomor[(pfx, kab)] += 1
        did = f"{pfx}-{kab}-{self.nomor[(pfx, kab)]:02d}"
        self.alat[did] = {"device_id": did, "jenis": jenis, "nama": "Gateway IoT RS" if jenis == GATEWAY else JENIS[jenis]["nama"], "faskes_profil_id": f,
                          "rs": self.K["nama_rs"][f], "sensor": "gateway (heartbeat)" if jenis == GATEWAY else SENSOR,
                          "kunci_publik": "ed25519:" + sha(f"kunci|{self.seed}|{did}")[:44], "dicabut_pada": "", "dipasang": ""}
        return did

    def ambil_alat(self, f: str, jenis: str, a: int, b: int, rep: int, kecuali: set | None = None) -> str:
        """A free device of the hospital for [a, b) (a new one when all are busy): one device, one patient at a time."""
        for did in sorted(d for d, x in self.alat.items() if x["faskes_profil_id"] == f and x["jenis"] == jenis):
            if kecuali and did in kecuali:
                continue
            if all(b <= s or a >= e for s, e in self.sibuk[(did, rep)]):
                self.sibuk[(did, rep)].append((a, b))
                return did
        did = self.alat_baru(f, jenis)
        self.sibuk[(did, rep)].append((a, b))
        return did

    # ---------------------------------------------------------------- plans
    def cocok_vent(self, r: dict) -> bool:
        return r["tingkat"] == "RITL" and r["faskes"] in self.cakup and r["dx"].startswith(DX_VENT) and r["kode"][:1] not in ("O",)

    def rencanakan(self) -> None:
        rows = [r for r in self.rows if r["faskes"] in self.cakup]
        pakai_pes: set[str] = set()
        fr_rs: Counter = Counter()
        vent_native = [r for r in rows if r["tingkat"] == "RITL" and (r["kode"].startswith(("J-1-02", "J-1-20")) or any(p in ("96.71", "96.72", "96.70") for p in r["prosedur"]))]
        pool = [r for r in rows if self.cocok_vent(r)]
        hd = [r for r in rows if r["kode"] == "N-3-15-0" or "39.95" in r["prosedur"]]

        def pref(r: dict) -> tuple:
            return (r["zona"] != "LOLOS", r["y"] == 1)

        def pilih(cands: list[dict], tag: str, syarat=lambda r: True) -> dict | None:
            # a planted case only on a claim the run scored (in its zone file), so the report can show it
            ok = [r for r in cands if r["kunci"] not in self.rencana and r["peserta"] not in pakai_pes and r["di_zona"] and syarat(r)]
            if not ok:
                return None
            ok.sort(key=lambda r: (pref(r), fr_rs[r["faskes"]], kunci_acak(self.seed, tag, r["kunci"])))
            return ok[0]

        def ambil(r: dict, plan: dict, fraud: bool) -> None:
            self.rencana[r["kunci"]] = plan
            if fraud:
                pakai_pes.add(r["peserta"])
                fr_rs[r["faskes"]] += 1

        # 1. binding overlap: two stays at one hospital overlapping >= 2 days; A honest on the ventilator, B billed on the same device
        calon = []
        for b in pool:
            if b["los"] < 2 or not b["di_zona"]:
                continue
            for a in pool:
                if (a["kunci"] == b["kunci"] or a["faskes"] != b["faskes"] or a["peserta"] == b["peserta"] or a["los"] < 3 or a["replika"] != b["replika"]
                        or not 0 <= menit(b["tgl"]) - menit(a["tgl"]) <= 1440):  # B arrives while A is still ventilated
                    continue
                calon.append((pref(b), pref(a), kunci_acak(self.seed, "ikat", b["kunci"], a["kunci"]), a, b))
        calon.sort(key=lambda x: x[:3])
        pasang = (calon[0][3], calon[0][4]) if calon else None
        if pasang:
            a, b = pasang
            ambil(a, {"jenis": "vent", "skenario": "honest", "mode": "jalan", "prosedur": "96.71", "pasangan_ikat": b["kunci"]}, False)
            ambil(b, {"jenis": "vent", "skenario": "binding_tumpang", "mode": "ikat", "prosedur": "96.71", "pasangan_ikat": a["kunci"]}, True)
            pakai_pes.add(a["peserta"])
        # 2. the other planted frauds
        runs = sorted(v for s, v in FRAUD_SPEK if s == "vent_run_96")
        native96 = [r for r in vent_native if r["kode"].startswith("J-1-02") or "96.72" in r["prosedur"]]
        lama = [r for r in pool if r["los"] >= 4]
        pilihan = []
        for _ in runs:
            r = pilih(native96, "v96") or pilih(lama, "v96")
            if r is None:
                break
            ambil(r, {}, True)
            pilihan.append(r)
        for r, run in zip(sorted(pilihan, key=lambda r: (r["los"], r["kunci"])), runs):  # the longest run goes to the longest stay
            self.rencana[r["kunci"]] = {"jenis": "vent", "skenario": "vent_run_96", "mode": "jalan", "prosedur": "96.72", "run": run}
        for s, v in FRAUD_SPEK:
            if s == "vent_sebagian":  # 96.72: a stay long enough for the 96 hours billed; 96.71: any ventilated stay
                r = (pilih(native96 if v == "96.72" else vent_native, "sb" + v, lambda r: r["los"] >= (5 if v == "96.72" else 2))
                     or pilih(lama if v == "96.72" else pool, "sb" + v, lambda r: r["los"] >= (5 if v == "96.72" else 2)))
                if r:
                    ambil(r, {"jenis": "vent", "skenario": s, "mode": "jalan", "prosedur": v, "run": JALAN_SEBAGIAN[v]}, True)
            elif s == "icu_days":
                r = pilih(pool, "icu", lambda r: r["los"] >= 4)
                if r:
                    ambil(r, {"jenis": "icu", "skenario": s}, True)
            elif s == "hd_short":  # the second at another hospital
                lain = {x["faskes"] for x in hd if self.rencana.get(x["kunci"], {}).get("skenario") == "hd_short"}
                r = pilih(hd, "ndt", lambda r: r["faskes"] not in lain) if lain else pilih(hd, "hds")
                if r:
                    ambil(r, {"jenis": "hd", "skenario": s, "menit": v}, True)
        # 3. honest device use: every native ventilated / dialysis claim at a covered hospital (96.7x; a 93.90 stay too: the ventilator
        # ran, no hour threshold); for a run without procedures a few synthetic ventilated (96.72 once, 96.71, 93.90) and ICU-only stays
        for r in vent_native:
            if r["kunci"] not in self.rencana:
                p = "96.72" if "96.72" in r["prosedur"] else "96.71" if set(r["prosedur"]) & {"96.71", "96.70"} else "96.72" if r["kode"].startswith("J-1-02") else "96.71"
                self.rencana[r["kunci"]] = {"jenis": "vent", "skenario": "honest", "mode": "jalan", "prosedur": p}
        for r in rows:
            if r["tingkat"] == "RITL" and "93.90" in r["prosedur"] and r["kunci"] not in self.rencana:
                self.rencana[r["kunci"]] = {"jenis": "vent", "skenario": "honest", "mode": "jalan", "prosedur": "93.90"}
        if not vent_native:
            for tag, n, plan, syarat in (("h96", 1, {"prosedur": "96.72", "mode": "jalan"}, lambda r: r["los"] >= 5),
                                         ("h71", 5, {"prosedur": "96.71", "mode": "jalan"}, lambda r: r["los"] >= 2),
                                         ("h9390", 2, {"prosedur": "93.90", "mode": "jalan"}, lambda r: r["los"] >= 2)):
                for _ in range(n):
                    r = pilih(pool, tag, syarat)
                    if r:
                        ambil(r, {"jenis": "vent", "skenario": "honest", **plan}, False)
                        pakai_pes.add(r["peserta"])
            for _ in range(6):
                r = pilih(pool, "hicu", lambda r: r["los"] >= 2)
                if r:
                    ambil(r, {"jenis": "icu", "skenario": "honest"}, False)
                    pakai_pes.add(r["peserta"])
        for r in hd:
            if r["kunci"] not in self.rencana:
                self.rencana[r["kunci"]] = {"jenis": "hd", "skenario": "honest"}
        # 4. alert-only events on honest claims: evidence altered after anchoring (a ventilated stay), a late anchor and an
        # offline gateway (dialysis sessions at a hospital with no planted dialysis fraud)
        by = {r["kunci"]: r for r in self.rows}
        jujur_v = sorted([k for k, p in self.rencana.items() if p["jenis"] == "vent" and p["skenario"] == "honest" and p["prosedur"] == "96.71"
                          and "pasangan_ikat" not in p], key=lambda k: kunci_acak(self.seed, "am", k))
        if jujur_v:
            self.rencana[jujur_v[0]]["ubah_setelah_jangkar"] = True
        hd_fraud_rs = {by[k]["faskes"] for k, p in self.rencana.items() if p["jenis"] == "hd" and p["skenario"] != "honest"}
        jujur_h = sorted([k for k, p in self.rencana.items() if p["jenis"] == "hd" and p["skenario"] == "honest"], key=lambda k: kunci_acak(self.seed, "hd", k))
        off = next((k for k in jujur_h if by[k]["faskes"] not in hd_fraud_rs), None)
        if off:
            self.rencana[off]["offline"] = True
        late = next((k for k in jujur_h if k != off and by[k]["faskes"] != (by[off]["faskes"] if off else None)), None)
        if late:
            self.rencana[late]["jangkar_terlambat"] = True

    # ---------------------------------------------------------------- times and sessions
    def tambah_sesi(self, did: str, r: dict, a: int, b: int, alasan: str, segmen: list[tuple[int, int, str]], ikat_saja: bool = False) -> dict:
        self.n_sesi += 1
        sid = f"S-{self.K['kc']['id'].split('-')[-1]}-{self.n_sesi:05d}"
        b = max(b, a + 10)  # a session always ends after it starts
        segmen = [(x0, x1, m) for x0, x1, m in segmen if x1 > x0]
        s = {"sesi_id": sid, "device_id": did, "peserta": r["peserta"], "kunjungan": r["kunjungan"], "kunci": r["kunci"], "replika": r["replika"],
             "mulai": iso(a), "selesai": iso(b), "alasan_selesai": alasan, "_ikat_lain": ikat_saja}
        self.sesi.append(s)
        if not ikat_saja:
            for x0, x1, mode in segmen:
                self.seg[(did, r["replika"])].append((x0, x1, mode, sid))
        return s

    def waktu_rawat(self, r: dict, p: dict) -> tuple[int, int]:
        d0 = menit(r["tgl"])
        if r["tingkat"] != "RITL":
            a = d0 + int(self.u(7, 13)) * 60 + int(self.u(0, 6)) * 10
            return a, a + 5 * 60
        long = p.get("skenario") == "vent_run_96" or p.get("prosedur") == "96.72"
        h0 = self.u(1, 4) if long else self.u(7, 21)  # a long ventilation uses the stay's whole calendar window
        h1 = self.u(17, 21) if long else self.u(8, 14)
        a = d0 + int(h0 * 6) * 10
        b = d0 + max(0, r["los"]) * 1440 + int(h1 * 6) * 10
        return a, max(b, a + 6 * 60)

    def bangun(self) -> None:
        by = {r["kunci"]: r for r in self.rows}
        urut = sorted(self.rencana, key=lambda k: (self.rencana[k].get("skenario") == "binding_tumpang", by[k]["tgl"], k))
        self.rawat: dict[str, tuple[int, int]] = {}
        self.ditagih: dict[str, dict] = {}
        self.vent_sesi: dict[str, dict] = {}
        for k in urut:  # every stay's times first: the binding pair's honest partner is ventilated across the other's stay
            self.rawat[k] = self.waktu_rawat(by[k], self.rencana[k])
        for k in urut:
            r, p = by[k], self.rencana[k]
            getattr(self, f"bangun_{p['jenis']}")(r, p, *self.rawat[k])
        self.tanpa_pasien()
        self.cabut_kunci()

    def icu(self, r: dict, a: int, b: int, akhir: int | None = None, durasi: float | None = None) -> dict:
        i0 = a + int(self.u(1, 3) * 60)
        i1 = akhir if akhir is not None else i0 + int((durasi or (b - i0) / 60 * self.u(0.45, 0.8)) * 60)
        i1 = max(min(i1, b - 30), i0 + 60)  # at least an hour in the ICU bed
        alasan = "pulang" if b - i1 <= 60 else "pindah"
        did = self.ambil_alat(r["faskes"], "monitor_icu", i0, i1, r["replika"])
        s = self.tambah_sesi(did, r, i0, i1, alasan, [(i0, i1, "nyala")])
        if self.u(0, 1) < 0.65 and i1 - i0 > 8 * 60:  # an infusion pump for part of the ICU stay (no billing rule: usage context)
            p0, p1 = i0 + 60, i1 - 90
            pid = self.ambil_alat(r["faskes"], "pompa_infus", p0, p1, r["replika"])
            seg, t = [], p0
            while t < p1:
                j = min(p1, t + int(self.u(5, 10) * 60))
                seg.append((t, j, "jalan"))
                k2 = min(p1, j + int(self.u(0.5, 2) * 60))
                if k2 > j:
                    seg.append((j, k2, "idle"))
                t = k2
            self.tambah_sesi(pid, r, p0, p1, "dilepas", seg)
        return s

    def bangun_vent(self, r: dict, p: dict, a: int, b: int) -> None:
        sk = p["skenario"]
        S = (b - a) / 60
        v0 = a + int(self.u(1.5, 3) * 60)
        prep = int(self.u(20, 40))
        seg: list[tuple[int, int, str]] = [(v0, v0 + prep, "siaga")]
        t = v0 + prep
        if sk == "binding_tumpang":
            A = self.vent_sesi.get(p["pasangan_ikat"])
            if A is None:  # the honest partner was not built (should not happen): bill a ventilator that ran for nobody
                A = {"device_id": self.ambil_alat(r["faskes"], "ventilator", v0, v0 + 1, r["replika"]), "a0": v0, "a1": v0 + 36 * 60}
            # the patient's own ventilator first: it ran a few hours (the device was on, the hours do not match the bill)
            o0 = a + int(self.u(3.5, 4.5) * 60)
            own = self.u(5, 8)
            o1 = o0 + prep + int(own * 60)
            did_b = self.ambil_alat(r["faskes"], "ventilator", o0, o1 + 30, r["replika"])
            self.tambah_sesi(did_b, r, o0, o1 + 30, "dilepas", [(o0, o0 + prep, "siaga"), (o0 + prep, o1, "jalan"), (o1, o1 + 30, "siaga")])
            lo, hi = max(A["a0"] + 4 * 60, a + 2 * 60, o1 + 60), min(A["a1"] - 3 * 60, b - 4 * 60)
            b0 = lo
            b1 = min(hi, b0 + int(self.u(30, 44) * 60))
            if b1 - b0 < 12 * 60:
                b1 = b0 + 12 * 60
            self.icu(r, a, b, akhir=max(b1 + int(self.u(4, 10) * 60), a + 24 * 60))
            s = self.tambah_sesi(A["device_id"], r, b0, b1, "dilepas", [], ikat_saja=True)  # bound, but the device was serving A
            jam_t = round(own + (b1 - b0) / 60)
            self.ditagih[r["kunci"]] = {"prosedur": [p["prosedur"]], "jam_ventilator": jam_t}
            self.kebenaran_klaim(r, p, fakta={"device_id": A["device_id"], "sesi_lain": A["sesi_id"], "peserta_lain": samaran(A["peserta"]),
                                              "jam_ditagih": jam_t, "jam_terukur_pasien_ini": jam(own), "alat_sendiri": did_b})
            return
        if sk == "vent_run_96":
            run = float(p["run"])
            seg.append((t, t + int(run * 60), "jalan"))
            t += int(run * 60)
            if run <= 75:  # weaned off, the ventilator then kept on standby beside the bed for a while
                sb = int(self.u(12, 24) * 60)
                seg.append((t, t + sb, "siaga"))
                t += sb
            room = (b - 4 * 60 - v0) / 60
            billed = max(96.0, min(room, run + self.u(25, 45)))
            billed = float(round(max(96.0, billed)))
            jam_jl = run
        elif sk == "vent_sebagian":  # switched on and run a few hours, then left on standby beside the bed; billed as if it ran throughout
            lama = max(8.0, min(S - 8, self.u(100, 130))) if p["prosedur"] == "96.72" else max(8.0, min(S - 8, self.u(40, 55)))
            run = min(float(p["run"]), lama - 3)
            seg.append((t, t + int(run * 60), "jalan"))
            t += int(run * 60)
            sb = max(60, int((lama - run) * 60) - prep)
            seg.append((t, t + sb, "siaga"))
            t += sb
            billed = float(max(96, round(lama - 1))) if p["prosedur"] == "96.72" else float(max(1, round(min(95, lama - 1))))
            jam_jl = run
        else:  # honest
            mode = p["mode"]
            if p["prosedur"] == "96.72":  # honest >= 96 h; a stay too short for it (a data inconsistency) gets the longest run it holds
                run = max(4.0, min(S - 6, self.u(105, 140)), min(S - 6, 97.0))
            elif p["prosedur"] == "93.90":
                run = max(4.0, min(S - 8, self.u(14, 50)))
            else:
                run = max(4.0, min(S - 8, self.u(20, 80), 92.0))
            if p.get("pasangan_ikat"):  # A of the binding pair: ventilated across B's stay
                B0 = self.rawat[p["pasangan_ikat"]][0]
                run = max(run, min(90.0, (B0 + 44 * 60 - t) / 60, S - 8))
            seg.append((t, t + int(run * 60), mode))
            t += int(run * 60)
            billed = float(round(run + (self.u(-1.5, 1.5) if run > 6 else 0)))
            jam_jl = run if mode == "jalan" else 0.0
        wean = int(self.u(30, 90))
        seg.append((t, t + wean, "siaga"))
        v1 = t + wean
        icu = self.icu(r, a, b, akhir=min(b - 60, v1 + int(self.u(3, 20) * 60)))
        i0 = menit(icu["mulai"])
        if i0 >= v0:  # the ventilator was attached inside the ICU
            shift = i0 + 30 - v0
            seg = [(x + shift, y + shift, m) for x, y, m in seg]
            v0, v1 = v0 + shift, v1 + shift
            icu["selesai"] = iso(max(menit(icu["selesai"]), v1 + 120))
            self.seg[(icu["device_id"], r["replika"])] = [(x, (max(y, v1 + 120) if s_ == icu["sesi_id"] else y), m, s_)
                                                          for x, y, m, s_ in self.seg[(icu["device_id"], r["replika"])]]
        did = self.ambil_alat(r["faskes"], "ventilator", v0, v1, r["replika"])
        s = self.tambah_sesi(did, r, v0, v1, "dilepas", seg)
        self.vent_sesi[r["kunci"]] = {"device_id": did, "a0": v0, "a1": v1, "sesi_id": s["sesi_id"], "peserta": r["peserta"]}
        icu_hari = span_hari(menit(icu["mulai"]), menit(icu["selesai"]))
        self.ditagih[r["kunci"]] = {"prosedur": [p["prosedur"]], "jam_ventilator": billed if p["prosedur"] != "93.90" else None, "hari_icu": icu_hari}
        self.kebenaran_klaim(r, p, fakta={"device_id": did, "jam_jalan": jam(jam_jl), "jam_berturut_maks": jam(run if p.get("mode") == "jalan" or sk == "vent_run_96" else 0),
                                          "jam_ditagih": billed, "mode": p.get("mode")})
        if sk == "honest" and p["prosedur"] == "96.72" and run < AMBANG_VENT:  # a claim in the >= 96 h group whose stay cannot hold 96 h
            self.kebenaran[r["kunci"]].update({"harapan": "tidak_sesuai", "catatan": f"masa rawat {jam(S)} jam tidak memuat 96 jam ventilasi: inkonsistensi data klaim, bukan kasus tanam"})

    def bangun_icu(self, r: dict, p: dict, a: int, b: int) -> None:
        if p["skenario"] == "icu_days":
            h = self.u(40, 60)
            s = self.icu(r, a, b, durasi=h)
            billed = max(r["los"], span_hari(menit(s["mulai"]), menit(s["selesai"])) + 2)
            self.ditagih[r["kunci"]] = {"hari_icu": int(billed)}
            self.kebenaran_klaim(r, p, fakta={"jam_icu": jam((menit(s["selesai"]) - menit(s["mulai"])) / 60), "hari_ditagih": int(billed)})
        else:
            s = self.icu(r, a, b)
            self.ditagih[r["kunci"]] = {"hari_icu": span_hari(menit(s["mulai"]), menit(s["selesai"]))}
            self.kebenaran_klaim(r, p, fakta={"jam_icu": jam((menit(s["selesai"]) - menit(s["mulai"])) / 60)})

    def bangun_hd(self, r: dict, p: dict, a: int, b: int) -> None:
        sk = p["skenario"]
        self.ditagih[r["kunci"]] = {"sesi_hd": 1}
        if sk == "no_device_trace":
            self.kebenaran_klaim(r, p, fakta={"menit_dialisis": 0, "sesi": 0})
            return
        prep = int(self.u(15, 30))
        jalan = int(p["menit"]) if sk == "hd_short" else int(self.u(240, 290)) // 5 * 5
        idle2 = int(self.u(10, 20))
        h0 = a
        h1 = h0 + prep + jalan + idle2
        did = self.ambil_alat(r["faskes"], "hemodialisis", h0, h1, r["replika"])
        self.tambah_sesi(did, r, h0, h1, "dilepas", [(h0, h0 + prep, "idle"), (h0 + prep, h0 + prep + jalan, "jalan"), (h0 + prep + jalan, h1, "idle")])
        if p.get("offline"):
            o0 = h0 - int(self.u(8, 12) * 60)
            self.offline[(r["faskes"], r["replika"])].append((o0, h1 + int(self.u(10, 14) * 60)))
            self.peringatan_tanam.append({"jenis": "offline", "faskes": r["faskes"], "rs": self.K["nama_rs"][r["faskes"]], "mulai": iso(o0), "klaim": id_kasus(r["kunci"])})
        self.kebenaran_klaim(r, p, fakta={"menit_dialisis": jalan, "device_id": did})

    def kebenaran_klaim(self, r: dict, p: dict, fakta: dict) -> None:
        sk = p["skenario"]
        self.kebenaran[r["kunci"]] = {"klaim_id": id_kasus(r["kunci"]), "peserta": samaran(r["peserta"]), "rs": self.K["nama_rs"][r["faskes"]], "skenario": sk,
                                      "fraud": sk != "honest", "harapan": "tidak_sesuai" if sk != "honest" else ("tanpa_bukti" if p.get("offline") or p.get("ubah_setelah_jangkar") else "sesuai"),
                                      "rencana": {k: v for k, v in p.items() if k != "jenis"}, "jenis": p["jenis"], "fakta": fakta}

    def tanpa_pasien(self) -> None:
        """Readings with no bound patient: a ventilator at a covered hospital running ("jalan") for ~14 h, no session (alert only)."""
        vs = sorted(d for d, x in self.alat.items() if x["jenis"] == "ventilator")
        if not vs:
            return
        did = vs[int(kunci_acak(self.seed, "tp")[:6], 16) % len(vs)]
        t0 = min(a for a, _ in self.rawat.values()) + 2 * 1440
        rep = self.rows[0]["replika"]
        while not all(t0 + 15 * 60 <= s or t0 >= e for s, e in self.sibuk[(did, rep)]):
            t0 += 6 * 60
        self.sibuk[(did, rep)].append((t0, t0 + 14 * 60))
        self.seg[(did, rep)].append((t0, t0 + 14 * 60, "jalan", ""))
        self.peringatan_tanam.append({"jenis": "tanpa_pasien", "device_id": did, "mulai": iso(t0), "jam": 14})

    def cabut_kunci(self) -> None:
        """A device key revoked mid-period that keeps sending (alert only): an infusion pump with no session after the revocation."""
        ps = sorted(d for d, x in self.alat.items() if x["jenis"] == "pompa_infus")
        if not ps:
            return
        mid = int(np.median([a for a, _ in self.rawat.values()]))
        for did in sorted(ps, key=lambda d: kunci_acak(self.seed, "cabut", d)):
            if all(e <= mid for rep_busy in [v for (d, _), v in self.sibuk.items() if d == did] for _, e in rep_busy):
                self.alat[did]["dicabut_pada"] = iso(mid)
                self.peringatan_tanam.append({"jenis": "kunci_dicabut", "device_id": did, "dicabut_pada": iso(mid)})
                return

    # ---------------------------------------------------------------- readings, anchors, files
    def pembacaan(self) -> list[dict]:
        a_all = [a for a, _ in self.rawat.values()] or [0]
        b_all = [b for _, b in self.rawat.values()] or [0]
        self.w0 = min(menit(min(r["tgl"] for r in self.rows)), min(a_all)) // 1440 * 1440
        self.w1 = (max(max(b_all), max(menit(max(r["tgl"] for r in self.rows)) + 1440, *[e for v in self.seg.values() for _, e, _, _ in v])) // 60 + 2) * 60
        reps = sorted({r["replika"] for r in self.rows})
        satu = len(reps) == 1 and (self.w1 - self.w0) <= 45 * 1440
        out: list[dict] = []
        for did in sorted(self.alat):
            x = self.alat[did]
            x["dipasang"] = iso(self.w0 - 30 * 1440)
            for rep in reps:
                seq = 0
                off = self.offline.get((x["faskes_profil_id"], rep), [])
                if x["jenis"] == GATEWAY:
                    cad = 60 if satu else 1440
                    for t in range(self.w0, self.w1, cad):
                        seq += 1
                        if any(o0 <= t < o1 for o0, o1 in off):
                            continue
                        out.append({"ts": iso(t), "device_id": did, "sesi_id": "", "seq": seq, "interval_s": cad * 60, "arus_a": 0.0, "mode": "online", "replika": rep})
                    continue
                J = JENIS[x["jenis"]]
                segs = sorted(self.seg.get((did, rep), []))
                titik: list[tuple[int, int, str, str]] = []
                t = self.w0
                for s0, s1, mode, sid in segs:
                    if satu and s0 > t:
                        titik += [(u, min(CAD_IDLE, s0 - u), "mati", "") for u in range(t, s0, CAD_IDLE)]
                    cad = J["cad"]
                    titik += [(u, min(cad, s1 - u), mode, sid) for u in range(s0, s1, cad)]
                    t = max(t, s1)
                if satu and t < self.w1:
                    titik += [(u, min(CAD_IDLE, self.w1 - u), "mati", "") for u in range(t, self.w1, CAD_IDLE)]
                for u, iv, mode, sid in titik:
                    seq += 1
                    if any(o0 <= u < o1 for o0, o1 in off):
                        continue  # lost while the gateway was offline: the sequence number shows the gap
                    lo, hi = J["arus"][mode]
                    out.append({"ts": iso(u), "device_id": did, "sesi_id": sid, "seq": seq, "interval_s": int(iv) * 60,
                                "arus_a": round(self.u(lo, hi), 2) if hi else 0.0, "mode": mode, "replika": rep})
        for r_ in out:
            r_["reading_hash"] = sha(kanon_baca(r_))
        return out

    def jangkar(self, baca: list[dict]) -> list[dict]:
        by = {r["kunci"]: r for r in self.rows}
        per_sesi: dict[str, list] = defaultdict(list)
        for r_ in baca:
            if r_["sesi_id"]:
                per_sesi[r_["sesi_id"]].append(r_)
        per_kj: dict[str, list] = defaultdict(list)
        for s in self.sesi:
            per_kj[s["kunci"]].append(s)
        out = []
        self.diajukan: dict[str, str] = {}
        for k in sorted(self.rencana):
            r = by[k]
            a, b = self.rawat[k]
            aju = tanggal(b + int(self.u(2, 6)) * 1440)
            self.diajukan[k] = aju
            ss = per_kj.get(k, [])
            if not ss:
                continue
            daun_r = sorted((x for s in ss for x in per_sesi.get(s["sesi_id"], [])), key=lambda x: (x["ts"], x["device_id"], x["seq"]))
            daun = [x["reading_hash"] for x in daun_r] + [sha(e) for s in sorted(ss, key=lambda s: s["sesi_id"]) for e in kanon_ikat(s)]
            # the engine's scheme (api/aip/realtime/iot.akar_sesi): the visit's session records, one per mode run, cut from its readings
            rek = []
            for s in ss:
                rows = sorted(per_sesi.get(s["sesi_id"], []), key=lambda x: x["seq"])
                rek += rekaman_mesin(s, self.alat[s["device_id"]]["jenis"], potong_segmen((menit(x["ts"]), x["interval_s"] // 60, x["mode"]) for x in rows), s.get("_ikat_lain", False))
            RT = mesin_iot()
            akar_mesin = RT.akar_sesi(rek) if RT and rek else None
            akhir = max(menit(s["selesai"]) for s in ss)
            waktu = akhir + int(self.u(15, 90))
            if self.rencana[k].get("jangkar_terlambat"):
                waktu = menit(aju) + 1440 + int(self.u(2, 8)) * 60
                self.peringatan_tanam.append({"jenis": "jangkar_terlambat", "klaim": id_kasus(k), "dijangkarkan": iso(waktu), "diajukan": aju})
            root_baca = merkle_root(daun)
            root = akar_mesin or root_baca
            out.append({"episode_id": "EP-" + hashlib.md5(k.encode()).hexdigest()[:10].upper(), "kunjungan": r["kunjungan"], "replika": r["replika"],
                        "sesi": sorted(s["sesi_id"] for s in ss), "merkle_root": root, "skema": "akar_sesi" if akar_mesin else LEDGER,
                        "sesi_mesin": len(rek), "merkle_root_pembacaan": root_baca, "jumlah_daun": len(daun), "jumlah_pembacaan": len(daun_r),
                        "waktu": iso(waktu), "tx": "0x" + sha(f"jangkar|{root}|{iso(waktu)}"), "ledger": LEDGER})
            if self.rencana[k].get("ubah_setelah_jangkar"):  # altered AFTER anchoring: standby tail flipped to running, row hashes recomputed
                ekor = [x for x in daun_r if x["mode"] in ("siaga", "mati") and self.alat[x["device_id"]]["jenis"] == "ventilator"][-6:]
                for x in ekor:
                    x["mode"], x["arus_a"] = "jalan", round(self.u(1.7, 2.1), 2)
                    x["reading_hash"] = sha(kanon_baca(x))
                self.peringatan_tanam.append({"jenis": "jangkar_tidak_cocok", "klaim": id_kasus(k), "pembacaan_diubah": len(ekor)})
                self.kebenaran[k]["fakta"]["pembacaan_diubah"] = len(ekor)
        return out

    def klaim_alat(self) -> list[dict]:
        """What each claim billed for device use (the E-Klaim fields the run's claim table does not carry): procedure codes,
        ventilator hours, ICU days, dialysis sessions, the stay's times, the submission date, and for a fraud whose billing
        changes the INA-CBG group the group as billed with the claim's run values in `klaim_asli`."""
        by = {r["kunci"]: r for r in self.rows}
        out = []
        for k in sorted(self.rencana):
            r, p = by[k], self.rencana[k]
            d = {"kunci": k, "kunjungan": r["kunjungan"], "replika": r["replika"], "peserta": r["peserta"], "faskes_profil_id": r["faskes"],
                 "masuk": iso(self.rawat[k][0]), "pulang": iso(self.rawat[k][1]), "diajukan": self.diajukan.get(k), **{x: v for x, v in self.ditagih.get(k, {}).items() if v is not None}}
            asli_vent = r["kode"].startswith(("J-1-02", "J-1-20")) or bool(set(r["prosedur"]) & {"96.71", "96.72", "96.70"})
            if p["jenis"] == "vent" and p["skenario"] != "honest" and not asli_vent and p.get("prosedur") in GRUP_VENT:
                sev = "III" if sev_of(r["kode"]) == "III" else "II"
                kode = f"{GRUP_VENT[p['prosedur']]}-{sev}"
                t02, t20, src = self.T.pasangan(f"J-1-02-{sev}", f"J-1-20-{sev}", r["faskes"], r["kelas"])  # one table level for both groups
                t = t02 if kode.startswith("J-1-02") else t20
                if t:
                    d.update({"inacbg": kode, "tarif_rp": int(t), "biaya_rp": int(t) + r["topup"], "sumber_tarif": src, "inacbg_tanpa_ventilasi": r["kode"],
                              "tarif_tanpa_ventilasi_rp": r["tarif"], "klaim_asli": {"inacbg": r["kode"], "tarif_rp": r["tarif"], "biaya_rp": r["biaya"]}})
                    self.kebenaran[k]["selisih_benar_rp"] = None
            d["sumber"] = "tambahan_sintetis" if not asli_vent and p["jenis"] in ("vent", "icu") else "data_klaim+tambahan_sintetis"
            out.append(d)
        return out


def span_hari(a: int, b: int) -> int:
    """Days as a ward clerk counts them: calendar days touched."""
    if b <= a:
        return 0
    return (b - 1) // 1440 - a // 1440 + 1


def generate(set_name: str, out_dir: str | Path | None = None, kc: str | None = None, seed: int = SEED) -> dict:
    """Write a SYNTHETIC IoT input folder for a run's branch (docs/IOT_FORMAT_MASUKAN.md) and its ground truth beside it."""
    t0 = time.time()
    K = klaim_run(set_name, kc)
    B = _Bangun(K, seed)
    B.pilih_rs()
    B.rencanakan()
    B.bangun()
    baca = B.pembacaan()
    anch = B.jangkar(baca)
    ka = B.klaim_alat()
    out = Path(out_dir) if out_dir else basis_iot() / set_name / "masukan"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*"):
        if f.is_file():
            f.unlink()
    kol_alat = ["device_id", "jenis", "nama", "faskes_profil_id", "rs", "sensor", "kunci_publik", "dipasang", "dicabut_pada"]
    with (out / "alat.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, kol_alat)
        w.writeheader()
        for d in sorted(B.alat):
            w.writerow({k: B.alat[d].get(k, "") for k in kol_alat})
    kol_sesi = ["sesi_id", "device_id", "peserta", "kunjungan", "replika", "mulai", "selesai", "alasan_selesai"]
    with (out / "sesi.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, kol_sesi)
        w.writeheader()
        for s in sorted(B.sesi, key=lambda s: s["sesi_id"]):
            w.writerow({k: s.get(k, "") for k in kol_sesi})
    import pandas as pd

    pd.DataFrame(baca, columns=["ts", "device_id", "sesi_id", "seq", "interval_s", "arus_a", "mode", "replika", "reading_hash"]).to_parquet(out / "pembacaan.parquet", index=False)
    tulis_json(out / "jangkar.json", {"ledger": LEDGER, "jangkar": anch})
    tulis_json(out / "klaim_alat.json", {"catatan": "Isian E-Klaim untuk pemakaian alat (prosedur, jam ventilator, hari ICU, sesi HD) yang tidak ada di tabel klaim run. "
                                         "SINTETIS: ventilasi dan ICU pada run gen3 adalah tambahan lapisan IoT.", "klaim": ka})
    periode = {"mulai": min(r["tgl"] for r in K["rows"]), "akhir": max(r["tgl"] for r in K["rows"])}
    tulis_json(out / "manifest.json", {"format": FORMAT, "run": set_name, "kc": {"id": K["kc"]["id"], "nama": K["kc"]["nama"]}, "periode": periode,
                                       "jendela": {"mulai": iso(B.w0), "akhir": iso(B.w1)}, "zona_waktu": "WIB (UTC+7)", "sintetis": True, "seed": seed,
                                       "dibuat": time.strftime("%Y-%m-%d %H:%M"), "berkas": ["alat.csv", "sesi.csv", "pembacaan.parquet", "jangkar.json", "klaim_alat.json"]})
    for s in B.sesi:  # a session inside a gateway outage leaves no reading: the claim is expected "tanpa_bukti", not accused
        f = B.alat[s["device_id"]]["faskes_profil_id"]
        for o0, o1 in B.offline.get((f, s["replika"]), []):
            if o0 <= menit(s["mulai"]) and menit(s["selesai"]) <= o1 and s["kunci"] in B.kebenaran and not B.kebenaran[s["kunci"]]["fraud"]:
                B.kebenaran[s["kunci"]]["harapan"] = "tanpa_bukti"
    fr = {k: v for k, v in B.kebenaran.items() if v["fraud"]}
    tulis_json(out.parent / "kunci_benar.json", {
        "run": set_name, "kc": K["kc"]["id"], "seed": seed, "dibuat": time.strftime("%Y-%m-%d %H:%M"),
        "catatan": "KUNCI JAWABAN dunia IoT sintetis. Tidak pernah dibaca pemeriksa (periksa); hanya untuk menilai hasilnya.",
        "fraud": len(fr), "klaim": B.kebenaran, "peringatan_tanam": B.peringatan_tanam,
        "rs_tercakup": [{"id": f, "nama": K["nama_rs"][f]} for f in B.cakup]})
    hasil = {"masukan": str(out), "rs": len(B.cakup), "alat": sum(1 for x in B.alat.values() if x["jenis"] != GATEWAY), "sesi": len(B.sesi), "pembacaan": len(baca),
             "jangkar": len(anch), "klaim": len(ka), "fraud": len(fr), "detik": round(time.time() - t0, 1)}
    print(f"iot generate {set_name} {K['kc']['id']}: {json.dumps(hasil, ensure_ascii=False)}")
    return hasil


# ======================================================================================================== CHECKER
def _baca_tabel(d: Path, nama: str) -> list[dict]:
    for ext in ("json", "csv", "parquet"):
        f = d / f"{nama}.{ext}"
        if not f.exists():
            continue
        if ext == "json":
            x = json.loads(f.read_text("utf-8"))
            return x if isinstance(x, list) else next((v for v in x.values() if isinstance(v, list)), [])
        if ext == "csv":
            with f.open(encoding="utf-8") as fh:
                return list(csv.DictReader(fh))
        import pandas as pd

        return pd.read_parquet(f).to_dict("records")
    return []


def _mode_dari_arus(jenis: str, arus: float) -> str:
    for b, m in JENIS[jenis]["batas"]:
        if arus < b:
            return m
    return JENIS[jenis]["batas"][-1][1]


class _Periksa:
    def __init__(self, K: dict, d: Path) -> None:
        self.K, self.d = K, d
        self.man = json.loads((d / "manifest.json").read_text("utf-8")) if (d / "manifest.json").exists() else {}
        self.alat = {str(a["device_id"]): a for a in _baca_tabel(d, "alat")}
        self.sesi = _baca_tabel(d, "sesi")
        for s in self.sesi:
            s["replika"] = int(s.get("replika") or 0)
            s["selesai"] = s.get("selesai") or ""
        self.ka = {}
        for x in _baca_tabel(d, "klaim_alat"):
            self.ka[(str(x.get("kunjungan") or x.get("kunci")), int(x.get("replika") or 0))] = x
        jj = json.loads((d / "jangkar.json").read_text("utf-8")) if (d / "jangkar.json").exists() else {}
        self.jangkar = {(str(a["kunjungan"]), int(a.get("replika") or 0)): a for a in (jj.get("jangkar") if isinstance(jj, dict) else jj) or []}
        import pandas as pd

        f = d / "pembacaan.parquet"
        df = pd.read_parquet(f) if f.exists() else pd.read_csv(d / "pembacaan.csv", dtype={"sesi_id": str}, keep_default_na=False)
        if "replika" not in df:
            df["replika"] = 0
        df["sesi_id"] = df["sesi_id"].fillna("").astype(str)
        df["mode"] = df["mode"].fillna("").astype(str) if "mode" in df else ""
        jenis = df["device_id"].map(lambda x: (self.alat.get(str(x)) or {}).get("jenis", ""))
        kosong = df["mode"] == ""
        if kosong.any():  # no edge classification: the mode from the current, by the device type's bands
            df.loc[kosong, "mode"] = [_mode_dari_arus(j, a) if j in JENIS else "online" for j, a in zip(jenis[kosong], df.loc[kosong, "arus_a"])]
        df["jenis"] = jenis
        df["m"] = [menit(t) for t in df["ts"]]
        self.df = df.sort_values(["device_id", "replika", "seq"]).reset_index(drop=True)
        # row hashes and revoked keys: a reading that fails its own hash or comes from a revoked key is inadmissible
        self.df["hash_ok"] = [sha(kanon_baca(r)) == r["reading_hash"] for r in self.df[["device_id", "sesi_id", "ts", "seq", "interval_s", "arus_a", "mode", "reading_hash"]].to_dict("records")]
        cab = {did: menit(a["dicabut_pada"]) for did, a in self.alat.items() if str(a.get("dicabut_pada") or "").strip()}
        self.df["dicabut"] = [did in cab and m >= cab[did] for did, m in zip(self.df["device_id"], self.df["m"])]
        self.cab = cab
        # an iot-1 input's ventilator modes (invasif / noninvasif / standby) -> the clamp's states (jalan / siaga), after the hash
        # check; mode_asli keeps the anchored name for the anchor's session records
        self.df["mode_asli"] = self.df["mode"]
        vent = self.df["jenis"] == "ventilator"
        self.mode_lama = bool(vent.any() and self.df.loc[vent, "mode_asli"].isin(list(MODE_LAMA)).any())
        if self.mode_lama:
            self.df.loc[vent, "mode"] = self.df.loc[vent, "mode_asli"].map(lambda x: MODE_LAMA.get(x, x))
        self.T = Tarif(K["rows"])
        self.by_sesi = {k: g for k, g in self.df[self.df.sesi_id != ""].groupby("sesi_id")}
        self.by_alat = {k: g for k, g in self.df.groupby(["device_id", "replika"])}
        self.sesi_kj: dict[tuple, list] = defaultdict(list)
        self.sesi_alat: dict[tuple, list] = defaultdict(list)
        for s in self.sesi:
            self.sesi_kj[(str(s["kunjungan"]), s["replika"])].append(s)
            self.sesi_alat[(str(s["device_id"]), s["replika"])].append(s)
        self.rs_alat: dict[str, list] = defaultdict(list)
        for did, a in self.alat.items():
            self.rs_alat[str(a["faskes_profil_id"])].append(did)
        self.gw = {str(a["faskes_profil_id"]): did for did, a in self.alat.items() if a["jenis"] == GATEWAY}
        self.peringatan: list[dict] = []

    # ---------------------------------------------------------------- measurements
    def ukur(self, s: dict) -> dict:
        """One session's readings: hours per mode, longest unbroken run per mode (a sequence gap between two readings of the same
        mode counts as that mode: missing readings in the claim's favour), missing readings, per-day hours."""
        did, rep = str(s["device_id"]), s["replika"]
        j = (self.alat.get(did) or {}).get("jenis", "")
        g = self.by_sesi.get(s["sesi_id"])
        a0, a1 = menit(s["mulai"]), menit(s["selesai"]) if s["selesai"] else None
        out = {"jenis": j, "mode_jam": Counter(), "run_maks": Counter(), "hilang": 0, "pembacaan": 0, "harian": defaultdict(Counter), "segmen": [], "segmen_asli": [],
               "ditolak": 0}
        if g is None or g.empty:
            return out
        g = g[(g.replika == rep)]
        ok = g[g.hash_ok & ~g.dicabut]
        out["ditolak"] = int(len(g) - len(ok))
        out["pembacaan"] = int(len(ok))
        prev = None
        cur_mode, cur_len, seg0 = None, 0.0, None
        cad = JENIS[j]["cad"] if j in JENIS else 10
        for m, iv, mode, seq in zip(ok["m"], ok["interval_s"], ok["mode"], ok["seq"]):
            h = float(iv) / 3600
            out["mode_jam"][mode] += h
            gap = 0 if prev is None else int(seq) - prev[1] - 1
            out["hilang"] += max(0, gap)
            if mode == cur_mode and (prev is None or gap >= 0):
                cur_len += h + max(0, gap) * cad / 60
            else:
                if cur_mode is not None:
                    out["segmen"].append((seg0, prev[0] + prev[2], cur_mode))
                cur_mode, cur_len, seg0 = mode, h, m
            out["run_maks"][mode] = max(out["run_maks"][mode], cur_len)
            # per day (a reading's interval split at midnight)
            t, sisa = m, float(iv) / 60
            while sisa > 0:
                ujung = (t // 1440 + 1) * 1440
                bag = min(sisa, ujung - t)
                out["harian"][tanggal(t)][mode] += bag / 60
                t += bag
                sisa -= bag
            prev = (m, int(seq), float(iv) / 60)
        if cur_mode is not None:
            out["segmen"].append((seg0, prev[0] + prev[2], cur_mode))
        # the stretches under the names the readings were anchored with (an iot-1 input: invasif / noninvasif / standby)
        out["segmen_asli"] = (potong_segmen(zip(ok["m"], ok["interval_s"] // 60, ok["mode_asli"])) if self.mode_lama else list(out["segmen"]))
        return out

    def gateway_online(self, f: str, rep: int, a: int, b: int) -> tuple[float, int]:
        """(share of the hours in [a, b) with a gateway heartbeat, hours offline)."""
        gw = self.gw.get(f)
        if not gw:
            return 0.0, int((b - a) / 60)
        g = self.by_alat.get((gw, rep))
        if g is None or g.empty:
            return 0.0, int((b - a) / 60)
        cad = int(g["interval_s"].iloc[0]) // 60 or 60
        ada = set(int(m) // cad for m in g["m"] if a - cad <= m < b)
        slot = list(range(a // cad, (b - 1) // cad + 1))
        on = sum(1 for x in slot if x in ada)
        return on / max(1, len(slot)), int((len(slot) - on) * cad / 60)

    def rantai(self, kj: str, rep: int, ss: list[dict], rek: list[dict] | None = None) -> dict:
        """The visit's evidence against its anchor: merkle_root in the engine's scheme (iot.akar_sesi over the session records cut
        from the readings, `skema` "akar_sesi") and merkle_root_pembacaan over every reading hash + binding event; both must match."""
        a = self.jangkar.get((kj, rep))
        if not a:
            return {"ada": False, "ok": False, "jumlah": 0}
        rows = []
        for s in ss:
            g = self.by_sesi.get(s["sesi_id"])
            if g is not None:
                rows += g[g.replika == rep][["ts", "device_id", "seq", "reading_hash", "hash_ok"]].to_dict("records")
        rows.sort(key=lambda x: (x["ts"], x["device_id"], int(x["seq"])))
        daun = [x["reading_hash"] for x in rows] + [sha(e) for s in sorted(ss, key=lambda s: s["sesi_id"]) for e in kanon_ikat(s)]
        root = merkle_root(daun)
        bad = sum(1 for x in rows if not x["hash_ok"])
        ok_baca = root == (a.get("merkle_root_pembacaan") or a["merkle_root"]) if (a.get("merkle_root_pembacaan") or a.get("skema") != "akar_sesi") else True
        ok_mesin = True
        if a.get("skema") == "akar_sesi":
            RT = mesin_iot()
            ok_mesin = bool(RT) and RT.akar_sesi(rek or []) == a["merkle_root"]
            root = RT.akar_sesi(rek or []) if RT else root
        return {"ada": True, "ok": ok_baca and ok_mesin and not bad and int(a.get("jumlah_pembacaan", len(rows))) == len(rows), "root": a["merkle_root"], "tx": a.get("tx"),
                "skema": a.get("skema") or LEDGER,
                "root_hitung": root, "waktu": a["waktu"], "jumlah": len(rows), "jumlah_jangkar": int(a.get("jumlah_pembacaan", len(rows))), "rusak": bad}

    # ---------------------------------------------------------------- one claim
    def klaim(self, r: dict) -> dict | None:
        kj, rep = r["kunjungan"], r["replika"]
        ka = self.ka.get((kj, rep)) or {}
        pro = [str(p) for p in (ka.get("prosedur") or r["prosedur"] or [])]
        if not pro and r["kode"].startswith("J-1-02"):
            pro = ["96.72"]
        sesi_hd = int(ka.get("sesi_hd") or (1 if (r["kode"] == "N-3-15-0" or "39.95" in pro) else 0))
        hari_icu = int(ka.get("hari_icu") or 0)
        vent = [p for p in pro if p in ("96.70", "96.71", "96.72", "93.90")] if r["tingkat"] == "RITL" else []  # ventilation: inpatient stays
        if not (vent or sesi_hd or hari_icu):
            return None
        if r["faskes"] not in self.rs_alat:
            return None  # no IoT at this hospital: outside the layer's reach
        ss = sorted(self.sesi_kj.get((kj, rep), []), key=lambda s: s["mulai"])
        masuk = menit(ka["masuk"]) if ka.get("masuk") else menit(r["tgl"])
        pulang = menit(ka["pulang"]) if ka.get("pulang") else menit(r["tgl"]) + max(1, r["los"]) * 1440 - 1
        U = {s["sesi_id"]: self.ukur(s) for s in ss}
        inacbg = ka.get("inacbg") or r["kode"]
        tarif = int(ka.get("tarif_rp") or r["tarif"])
        cek: list[dict] = []
        on_share, off_jam = self.gateway_online(r["faskes"], rep, masuk, max(pulang, masuk + 60))

        def sesi_j(j: str) -> list[dict]:
            return [s for s in ss if (self.alat.get(str(s["device_id"])) or {}).get("jenis") == j]

        def konflik(s: dict) -> dict | None:
            """Another patient's session on the same device, started earlier and overlapping this one: the device was serving them."""
            a0, a1 = menit(s["mulai"]), menit(s["selesai"]) if s["selesai"] else 10**12
            for o in self.sesi_alat.get((str(s["device_id"]), rep), []):
                if o["sesi_id"] == s["sesi_id"] or str(o["peserta"]) == str(s["peserta"]):
                    continue
                b0, b1 = menit(o["mulai"]), menit(o["selesai"]) if o["selesai"] else 10**12
                if b0 <= a0 and b1 > a0 and a1 > b0:
                    return o
            return None

        def tarif_tanpa_vent() -> tuple[str, int | None]:
            if ka.get("inacbg_tanpa_ventilasi"):
                return str(ka["inacbg_tanpa_ventilasi"]), int(ka.get("tarif_tanpa_ventilasi_rp") or self.T.tarif(ka["inacbg_tanpa_ventilasi"], r["faskes"], r["kelas"])[0] or 0)
            if inacbg.startswith(("J-1-02", "J-1-20")):
                g = self.T.grup_medis(r["dx"], sev_of(inacbg)) or f"J-1-20-{sev_of(inacbg)}"
                if g.startswith("J-1-20") and inacbg.startswith("J-1-20"):
                    return inacbg, tarif
                return g, self.T.tarif(g, r["faskes"], r["kelas"])[0]
            return inacbg, tarif  # the claim's own (medical) group: the ventilation did not change its tariff

        # ---- ventilation
        if vent:
            p = "96.72" if "96.72" in vent else "96.71" if "96.71" in vent else "96.70" if "96.70" in vent else "93.90"
            jam_t = float(ka.get("jam_ventilator") or (AMBANG_VENT if p == "96.72" else 0))
            vs = sesi_j("ventilator")
            jl = sum(U[s["sesi_id"]]["mode_jam"]["jalan"] for s in vs)   # running: giving breaths
            sb = sum(U[s["sesi_id"]]["mode_jam"]["siaga"] for s in vs)   # standby: powered, no breaths
            run = max([U[s["sesi_id"]]["run_maks"]["jalan"] for s in vs] or [0.0])
            hil = sum(U[s["sesi_id"]]["hilang"] for s in vs) * 10 / 60
            kon = [(s, konflik(s)) for s in vs]
            c = {"jenis": "vent", "prosedur": p, "jam_ditagih": jam_t, "sesi": vs, "jl": jl, "sb": sb, "run": run, "hilang_jam": hil}
            if not vs:
                c.update(self._tanpa_jejak(on_share, off_jam))
            elif any(o is not None for _, o in kon):  # a session on a device serving another patient at the same hours (any overlap, as the realtime engine)
                o = next(o for _, o in kon if o is not None)
                c.update({"hasil": "tidak_sesuai", "aturan": "binding_tumpang", "lain": o})
            elif jl == 0:
                c.update({"hasil": "tidak_sesuai", "aturan": "vent_standby" if sb > 0 else "no_device_trace"})
            elif p == "93.90":  # no hour threshold: the ventilator ran
                c.update({"hasil": "sesuai", "aturan": "vent_sesuai"})
            elif p == "96.72" and run < AMBANG_VENT:
                c.update({"hasil": "tidak_sesuai", "aturan": "vent_run_96"})
            elif jam_t > (jl + hil) * 1.15 + 6:
                c.update({"hasil": "tidak_sesuai", "aturan": "vent_hours"})
            else:
                c.update({"hasil": "sesuai", "aturan": "vent_run_96" if p == "96.72" else "vent_sesuai"})
            # the tariff the device supports
            if c["hasil"] == "tidak_sesuai":
                sendiri = c["aturan"] == "binding_tumpang" and jl > 0  # ventilated on their own device for part of the stay: under 96 h
                if c["aturan"] == "vent_run_96" or (sendiri and p == "96.72"):
                    sev = sev_of(inacbg)
                    kb = f"J-1-20-{sev}" if inacbg.startswith("J-1-02") else inacbg
                    tb, src = self.T.lawan(inacbg, tarif, kb, r["faskes"], r["kelas"]) if inacbg.startswith("J-1-02") else (tarif, "")
                    c["seharusnya"] = (kb, tb if tb is not None else tarif)
                    c["sumber_tarif"] = src
                elif c["aturan"] == "vent_hours" or sendiri:
                    c["seharusnya"] = (inacbg, tarif)
                else:
                    c["seharusnya"] = tarif_tanpa_vent()
            cek.append(c)
        # ---- ICU days
        if hari_icu:
            ms = sesi_j("monitor_icu")
            on = sum(U[s["sesi_id"]]["mode_jam"]["nyala"] for s in ms)
            hil = sum(U[s["sesi_id"]]["hilang"] for s in ms) * 10 / 60
            hari_t = math.ceil((on + hil) / 24 - 1e-9) if on + hil > 0 else 0
            c = {"jenis": "icu", "hari_ditagih": hari_icu, "jam_nyala": on, "hari_terukur": hari_t, "sesi": ms, "hilang_jam": hil}
            if not ms:
                c.update(self._tanpa_jejak(on_share, off_jam))
            elif hari_icu > hari_t + 1:
                c.update({"hasil": "tidak_sesuai", "aturan": "icu_days"})
            else:
                c.update({"hasil": "sesuai", "aturan": "icu_sesuai"})
            if c["hasil"] == "tidak_sesuai":
                dukung = min(hari_icu, hari_t + 1) if c["aturan"] == "icu_days" else 0
                v = tarif * (hari_icu - dukung) / max(r["los"], hari_icu, 1)
                c["seharusnya"] = (inacbg, int(round(tarif - v, -2)))
                c["dukung_hari"] = dukung
            cek.append(c)
        # ---- dialysis
        if sesi_hd:
            hs = sesi_j("hemodialisis")
            jl = sum(U[s["sesi_id"]]["mode_jam"]["jalan"] for s in hs) * 60
            hil = sum(U[s["sesi_id"]]["hilang"] for s in hs) * JENIS["hemodialisis"]["cad"]
            n_baca = sum(U[s["sesi_id"]]["pembacaan"] for s in hs)
            c = {"jenis": "hd", "menit": jl, "sesi": hs, "hilang_menit": hil}
            if not hs:
                c.update(self._tanpa_jejak(on_share, off_jam))
            elif n_baca == 0 or (hil > jl and on_share < 0.5):
                c.update({"hasil": "tanpa_bukti", "aturan": "faskes_offline", "offline_jam": off_jam})
            elif jl == 0:
                c.update({"hasil": "tidak_sesuai", "aturan": "hd_phantom"})
            elif jl + hil < HD_MIN_MENIT:
                c.update({"hasil": "tidak_sesuai", "aturan": "hd_short"})
            else:
                c.update({"hasil": "sesuai", "aturan": "hd_sesuai"})
            if c["hasil"] == "tidak_sesuai":
                if c["aturan"] == "hd_short":
                    c["seharusnya"] = (inacbg, int(round(tarif * min(1.0, (jl + hil) / HD_STANDAR_MENIT), -2)))
                else:
                    c["seharusnya"] = (inacbg, 0)
            cek.append(c)
        # ---- the evidence chain
        rek = [x for s in ss for x in rekaman_mesin(s, (self.alat.get(str(s["device_id"])) or {}).get("jenis", ""), U[s["sesi_id"]]["segmen_asli"], konflik(s) is not None,
                                                    "invasif" if self.mode_lama and (self.alat.get(str(s["device_id"])) or {}).get("jenis") == "ventilator" else None)]
        ch = self.rantai(kj, rep, ss, rek) if ss else {"ada": False, "ok": False, "jumlah": 0}
        aju = ka.get("diajukan")
        telat = bool(ch.get("ada") and aju and menit(ch["waktu"]) > menit(aju) + 1440 - 1)
        if ss and ch.get("ada") and not ch["ok"]:
            for c in cek:
                if c["hasil"] == "sesuai":
                    c.update({"hasil": "tanpa_bukti", "aturan": "anchor_mismatch"})
        # ---- the result: the worst check; among mismatches the one with the largest tariff difference
        for c in cek:
            c["selisih"] = max(0, tarif - int(c["seharusnya"][1] or 0)) if c.get("seharusnya") else 0
        urut = {"tidak_sesuai": 0, "tanpa_bukti": 1, "sesuai": 2}
        cek.sort(key=lambda c: (urut[c["hasil"]], -c["selisih"]))
        u = cek[0]
        b = self.blok(r, ka, ss, U, cek, u, ch, telat, masuk, pulang, inacbg, tarif, on_share, off_jam)
        rt = self.silang_realtime(r, ka, ss, U, masuk, pulang, inacbg, rek, self.jangkar.get((kj, rep)))
        if rt is not None:  # agreement on the usage rules and the evidence chain (mismatch, late anchor)
            usage = {"vent_run_96", "vent_standby", "vent_hours", "binding_tumpang", "no_device_trace", "hd_short", "hd_phantom", "icu_days",
                     "anchor_mismatch", "late_anchor"}
            mine = ({c["aturan"] for c in cek if c["hasil"] == "tidak_sesuai"} | ({"anchor_mismatch"} if ch.get("ada") and not ch["ok"] else set())
                    | ({"late_anchor"} if telat else set())) & usage
            rt["sepakat"] = None if "galat" in rt else mine == (set(rt["aturan"]) & usage)
            b["mesin_realtime"] = rt
        return b

    # ---------------------------------------------------------------- second opinion: the realtime engine's IoT rules
    def silang_realtime(self, r: dict, ka: dict, ss: list[dict], U: dict, masuk: int, pulang: int, inacbg: str, rek: list[dict] | None = None,
                        jangkar: dict | None = None) -> dict | None:
        """The realtime engine's pure IoT rules (api/aip/realtime/iot.periksa_iot) on the same evidence, as a cross-check: this
        checker's sessions cut into one session per mode run (the engine's shape), other patients' sessions on the same devices as
        context (its binding check), the gateway's silent windows as its offline windows. Its anchors hash session records, not
        readings, so the chain check stays here (jangkar not passed). Returns its fired rule ids, or None when it is unavailable."""
        try:
            from aip.realtime import iot as RT
        except Exception:  # noqa: BLE001 - the engine module is optional for this offline checker
            return None
        jn = JENIS_MESIN
        sesi = [dict(x) for x in (rek or [])]  # the same records the visit's anchor covers
        alat_ids = {x["device_id"] for x in sesi} | {str(s["device_id"]) for s in ss if (self.alat.get(str(s["device_id"])) or {}).get("jenis") in jn}
        for did in sorted(alat_ids):  # other patients on the same devices
            for o in self.sesi_alat.get((did, r["replika"]), []):
                if str(o["kunjungan"]) == r["kunjungan"] or not o["selesai"]:
                    continue
                j = (self.alat.get(did) or {}).get("jenis")
                sesi.append({"sesi_id": o["sesi_id"], "device_id": did, "jenis": jn[j], "peserta": str(o["peserta"]), "kunjungan": str(o["kunjungan"]),
                             "mulai": o["mulai"] + ":00+07:00", "selesai": o["selesai"] + ":00+07:00", "mode": JENIS[j]["aktif"][0],
                             "_konteks": True})
        gw = self.gw.get(r["faskes"])
        off = []
        g = self.by_alat.get((gw, r["replika"])) if gw else None
        if g is not None and len(g):
            cad = int(g["interval_s"].iloc[0]) // 60 or 60
            ms = sorted(int(m) for m in g["m"])
            off = [{"mulai": iso(x + cad) + ":00+07:00", "selesai": iso(y) + ":00+07:00"} for x, y in zip(ms, ms[1:]) if y - x >= max(180, 3 * cad)]
        perangkat = {did: {"jenis": jn.get((a.get("jenis") or ""), a.get("jenis")), "kunci": "dicabut" if str(a.get("dicabut_pada") or "").strip() else "aktif",
                           "dicabut_pada": (str(a["dicabut_pada"]) + ":00+07:00") if str(a.get("dicabut_pada") or "").strip() else None}
                     for did, a in self.alat.items() if str(a.get("faskes_profil_id")) == r["faskes"] and a.get("jenis") in jn}
        klaim = {"kunjungan": r["kunjungan"], "peserta": r["peserta"], "tgl_masuk": iso(masuk)[:10], "tgl_pulang": iso(pulang)[:10], "inacbg_kode": inacbg,
                 "tindakan": [str(x) for x in (ka.get("prosedur") or r["prosedur"] or [])] + (["39.95"] if ka.get("sesi_hd") else []),
                 "hari_icu": ka.get("hari_icu"), "jam_ventilator": ka.get("jam_ventilator"), "sesi_hd": ka.get("sesi_hd"), "diajukan": ka.get("diajukan")}
        try:
            ja = ({"akar": jangkar["merkle_root"], "waktu": str(jangkar["waktu"]) + ":00+07:00"} if jangkar and jangkar.get("skema") == "akar_sesi" else None)
            res = RT.periksa_iot(klaim, sesi, ja, {"tercakup": True, "cakupan": sorted({v["jenis"] for v in perangkat.values()}), "perangkat": perangkat,
                                                   "gateway_offline": off})
        except Exception as e:  # noqa: BLE001 - a cross-check never stops the checker
            return {"galat": str(e)[:200]}
        # a finding the engine mitigated by a gateway offline window is its "perlu klarifikasi" (this checker's tanpa_bukti), not a finding
        sig = res.get("sinyal") or []
        redam = {x["kode"] for x in sig if any(str((m or {}).get("kode")) == "GATEWAY_OFFLINE" for m in x.get("mitigasi") or [])}
        return {"versi": res.get("versi"), "sinyal": sorted({x["kode"] for x in sig}),
                "aturan": sorted(RT.ATURAN_ID.get(k_, k_) for k_ in {x["kode"] for x in sig} - redam),
                "klarifikasi": sorted(RT.ATURAN_ID.get(k_, k_) for k_ in redam)}

    def _tanpa_jejak(self, on_share: float, off_jam: int) -> dict:
        if on_share < 0.5:
            return {"hasil": "tanpa_bukti", "aturan": "faskes_offline", "offline_jam": off_jam}
        return {"hasil": "tidak_sesuai", "aturan": "no_device_trace"}

    # ---------------------------------------------------------------- the white-box block (the report's contract)
    def blok(self, r, ka, ss, U, cek, u, ch, telat, masuk, pulang, inacbg, tarif, on_share, off_jam) -> dict:
        nama = self.K["nama_rs"][r["faskes"]]
        a = u["aturan"]
        lama_jam = max(1.0, (pulang - masuk) / 60)
        alat = []
        for s in ss:
            did = str(s["device_id"])
            x = self.alat.get(did) or {}
            on = sum(v for k, v in U[s["sesi_id"]]["mode_jam"].items() if k != "mati")
            alat.append({"id": did, "jenis": x.get("jenis"), "nama": x.get("nama"), "sensor": x.get("sensor") or SENSOR, "rs": x.get("rs") or nama,
                         "jam_nyala": jam(on), "utilisasi_pct": jam(100 * on / lama_jam)})
        seen, alat_u = set(), []
        for x in alat:  # one row per device (a device bound twice in a visit adds its hours)
            if x["id"] in seen:
                y = next(z for z in alat_u if z["id"] == x["id"])
                y["jam_nyala"] = jam(y["jam_nyala"] + x["jam_nyala"])
                y["utilisasi_pct"] = jam(100 * y["jam_nyala"] / lama_jam)
                continue
            seen.add(x["id"])
            alat_u.append(x)
        # what was billed and what the device measured, for the main check
        J = u["jenis"]
        if J == "vent":
            p = u["prosedur"]
            ditagih = {"prosedur": p, "keterangan": PROSEDUR.get(p, p), "jam": jam(u["jam_ditagih"]), "inacbg": inacbg, "tarif_rp": tarif}
            mj = Counter()
            for s in u["sesi"]:
                mj.update(U[s["sesi_id"]]["mode_jam"])
            mode_jam = {k: jam(mj[k]) for k in JENIS["ventilator"]["mode"]}
            terukur = {"jam_total": jam(mj["jalan"] + mj["siaga"]), "jam_berturut_maks": jam(u["run"]), "mode_jam": mode_jam}
            ambang = AMBANG_VENT if p == "96.72" else None
            dev_jenis, mode_pakai = "ventilator", ("jalan",)
        elif J == "icu":
            ditagih = {"prosedur": "ICU", "keterangan": f"rawat ICU {u['hari_ditagih']} hari", "jam": u["hari_ditagih"] * 24, "inacbg": inacbg, "tarif_rp": tarif}
            mj = Counter()
            for s in u["sesi"]:
                mj.update(U[s["sesi_id"]]["mode_jam"])
            terukur = {"jam_total": jam(mj["nyala"]), "jam_berturut_maks": jam(max([U[s["sesi_id"]]["run_maks"]["nyala"] for s in u["sesi"]] or [0])),
                       "mode_jam": {"nyala": jam(mj["nyala"]), "mati": jam(mj["mati"])}, "hari": u["hari_terukur"]}
            ambang = (u["hari_ditagih"] - 1) * 24
            dev_jenis, mode_pakai = "monitor_icu", ("nyala",)
        else:
            ditagih = {"prosedur": "39.95", "keterangan": f"1 sesi hemodialisis (standar {HD_STANDAR_MENIT // 60} jam)", "jam": HD_STANDAR_MENIT / 60, "inacbg": inacbg, "tarif_rp": tarif}
            mj = Counter()
            for s in u["sesi"]:
                mj.update(U[s["sesi_id"]]["mode_jam"])
            terukur = {"jam_total": jam(mj["jalan"] + mj["idle"], 2), "jam_berturut_maks": jam(max([U[s["sesi_id"]]["run_maks"]["jalan"] for s in u["sesi"]] or [0]), 2),
                       "mode_jam": {"jalan": jam(mj["jalan"], 2), "idle": jam(mj["idle"], 2)}}
            ambang = HD_MIN_MENIT / 60
            dev_jenis, mode_pakai = "hemodialisis", ("jalan",)
        terukur["sesi"] = [{"mulai": iso(x0), "selesai": iso(x1), "mode": m, "device_id": str(s["device_id"])}
                           for s in u["sesi"] for x0, x1, m in U[s["sesi_id"]]["segmen"] if m != "mati"]
        terukur["pembacaan_hilang"] = int(sum(U[s["sesi_id"]]["hilang"] for s in u["sesi"]))
        # per day of the stay: hours used (in the billed mode), hours on, hours billed
        harian = []
        hari0, hari1 = masuk // 1440, max(masuk, pulang - 1) // 1440
        if J == "hd":
            hari0 = hari1 = (menit(u["sesi"][0]["mulai"]) if u["sesi"] else masuk) // 1440
        tagih_hari: dict[str, float] = defaultdict(float)
        if J == "vent" and ditagih["jam"]:
            t = menit(u["sesi"][0]["mulai"]) if u["sesi"] else masuk + 120
            sisa = float(ditagih["jam"]) * 60
            while sisa > 0:
                ujung = (t // 1440 + 1) * 1440
                bag = min(sisa, ujung - t)
                tagih_hari[tanggal(t)] += bag / 60
                t += bag
                sisa -= bag
        elif J == "icu":
            for k_ in range(u["hari_ditagih"]):
                tagih_hari[tanggal((hari0 + k_) * 1440)] = 24.0
        else:
            tagih_hari[tanggal(hari0 * 1440)] = ditagih["jam"]
        for h in range(hari0, hari1 + 1):
            tg = tanggal(h * 1440)
            pakai = sum(U[s["sesi_id"]]["harian"][tg][m] for s in u["sesi"] for m in mode_pakai)
            nyala = sum(v for s in u["sesi"] for k_, v in U[s["sesi_id"]]["harian"][tg].items() if k_ != "mati")
            harian.append({"tanggal": tg, "jam_dipakai": jam(pakai), "jam_nyala": jam(nyala), "jam_ditagih": jam(tagih_hari.get(tg, 0.0))})
        # the tariff
        if u.get("seharusnya"):
            ks, ts = u["seharusnya"]
            tarif_b = {"ditagih_rp": tarif, "seharusnya_rp": int(ts or 0), "kode_seharusnya": ks, "selisih_rp": int(max(0, tarif - int(ts or 0)))}
        else:
            tarif_b = {"ditagih_rp": tarif, "seharusnya_rp": tarif, "kode_seharusnya": inacbg, "selisih_rp": 0}
        tarif_b["dasar"] = self.dasar(u, tarif, tarif_b)
        if u.get("sumber_tarif"):
            tarif_b["sumber_tarif"] = u["sumber_tarif"]
        elif ka.get("sumber_tarif"):
            tarif_b["sumber_tarif"] = ka["sumber_tarif"]
        # the chain
        if ch.get("ada"):
            cat = ("jangkar sebelum klaim" if not telat else "jangkar SETELAH klaim diajukan: perlu penjelasan RS")
            if not ch["ok"]:
                cat = (f"root yang dihitung ulang dari {ch['jumlah']} pembacaan tidak sama dengan root di ledger"
                       + (f"; {ch['rusak']} pembacaan gagal hash" if ch["rusak"] else "") + ": data diubah setelah dijangkarkan")
            bukti = {"pembacaan": ch["jumlah"], "merkle_root": ch["root"], "dijangkarkan": ch["waktu"], "klaim_diajukan": ka.get("diajukan"), "rantai_ok": bool(ch["ok"]),
                     "jangkar_sebelum_klaim": not telat, "catatan": cat, "tx": ch.get("tx")}
            if not ch["ok"]:
                bukti["merkle_root_hitung"] = ch["root_hitung"]
        else:
            bukti = {"pembacaan": 0, "merkle_root": None, "dijangkarkan": None, "klaim_diajukan": ka.get("diajukan"), "rantai_ok": False, "jangkar_sebelum_klaim": None,
                     "catatan": "tidak ada sesi alat, jadi tidak ada jangkar bukti untuk kunjungan ini"}
        if on_share < 1 and off_jam:
            bukti["gateway_offline_jam"] = off_jam
        hasil = u["hasil"]
        judul = self.judul(u, ditagih, terukur, r)
        kode_jenis = {"ventilator": next((c["prosedur"] for c in cek if c["jenis"] == "vent"), None), "hemodialisis": "39.95" if any(c["jenis"] == "hd" for c in cek) else None}
        out = {"hasil": hasil, "aturan": a, "judul": judul, "alat": alat_u, "rawat": {"masuk": iso(masuk), "pulang": iso(pulang)}, "ditagih": ditagih,
               "terukur": terukur, "ambang_jam": ambang, "tarif": tarif_b, "bukti": bukti,
               "langkah": LANGKAH.get(a, LANGKAH["sesuai"]) if hasil != "sesuai" else LANGKAH["sesuai"], "sintetis": bool(self.man.get("sintetis", True)),
               "harian": harian,
               "sesi": [{"sesi_id": s["sesi_id"], "device_id": str(s["device_id"]), "jenis": (self.alat.get(str(s["device_id"])) or {}).get("jenis"), "peserta": samaran(s["peserta"]),
                         "kunjungan": id_kasus(r["kunci"]), "mulai": s["mulai"], "selesai": s["selesai"] or None, "alasan_selesai": s.get("alasan_selesai") or None,
                         "kode": kode_jenis.get((self.alat.get(str(s["device_id"])) or {}).get("jenis")),
                         "jam": jam(sum(v for k_, v in U[s["sesi_id"]]["mode_jam"].items() if k_ != "mati"))} for s in ss],
               "alat_utama": str(u["sesi"][0]["device_id"]) if u.get("sesi") else None, "sesi_utama": u["sesi"][0]["sesi_id"] if u.get("sesi") else None,
               "cek": [{"jenis": c["jenis"], "aturan": c["aturan"], "hasil": c["hasil"], "selisih_rp": int(c["selisih"])} for c in cek],
               "tagihan_jenis": {c["jenis"]: jam(c.get("jam_ditagih") or (c.get("hari_ditagih") or 0) * 24 or (HD_STANDAR_MENIT / 60 if c["jenis"] == "hd" else 0)) for c in cek},
               "klaim_id": id_kasus(r["kunci"]), "peserta": samaran(r["peserta"]), "rs": nama, "faskes_profil_id": r["faskes"]}
        if CATATAN_ATURAN.get(a) and hasil == "tidak_sesuai":
            out["catatan"] = CATATAN_ATURAN[a]
        if ka.get("klaim_asli"):
            out["klaim_asli"] = ka["klaim_asli"]
            out["augmentasi"] = (f"SINTETIS: data run mencatat klaim ini sebagai {ka['klaim_asli']['inacbg']} ({rp(ka['klaim_asli']['tarif_rp'])}); lapisan IoT menambahkan "
                                 f"ventilasi {ditagih.get('prosedur')} sehingga klaim ditagih {inacbg} ({rp(tarif)}). Skor model dan swarm dihitung atas klaim run.")
        if u["aturan"] == "binding_tumpang" and u.get("lain"):
            o = u["lain"]
            out["sesi_lain"] = {"sesi_id": o["sesi_id"], "device_id": str(o["device_id"]), "peserta": samaran(o["peserta"]), "mulai": o["mulai"], "selesai": o["selesai"] or None}
        return out

    def dasar(self, u: dict, tarif: int, tb: dict) -> str:
        a = u["aturan"]
        if not tb["selisih_rp"]:
            return "tidak ada selisih tarif" if u["hasil"] != "tidak_sesuai" else "tidak ada selisih tarif INA-CBG (paket yang sama)"
        if a == "vent_run_96":
            return f"tarif {tb['kode_seharusnya'][:-len(sev_of(tb['kode_seharusnya'])) - 1]} (ventilasi < 96 jam, keparahan sama) menggantikan grup ≥ 96 jam"
        if a in ("vent_standby", "binding_tumpang") or (a == "no_device_trace" and u["jenis"] == "vent"):
            return "tarif grup tanpa ventilasi mekanik menggantikan grup ventilasi yang ditagih"
        if a == "hd_short":
            return f"porsi tarif sesi untuk menit dialisis yang tidak berjalan (sesi standar {HD_STANDAR_MENIT} menit)"
        if a in ("hd_phantom", "no_device_trace"):
            return "seluruh tarif layanan (alat tidak mencatat pemakaian)"
        if a == "icu_days":
            return f"porsi tarif paket untuk hari ICU di atas yang didukung alat ({u.get('dukung_hari')} hari = terukur + 1 hari toleransi hitung kalender)"
        return "selisih tarif"

    def judul(self, u: dict, d: dict, t: dict, r: dict) -> str:
        a, h = u["aturan"], u["hasil"]
        if u["jenis"] == "vent":
            p = d["prosedur"]
            if a == "vent_run_96" and h == "tidak_sesuai":
                return f"Kode 96.72 ditagih (≥ 96 jam), ventilator paling lama jalan {jam_teks(t['jam_berturut_maks'])} berturut-turut"
            if a == "vent_run_96":
                return f"Kode 96.72 ditagih (≥ 96 jam), ventilator jalan {jam_teks(t['jam_berturut_maks'])} berturut-turut: sesuai"
            if a == "vent_standby":
                return f"Ventilasi ({p}) ditagih {jam_teks(d['jam'])}, ventilator hanya siaga (standby) {jam_teks(t['mode_jam']['siaga'])} dan tidak pernah jalan"
            if a == "vent_hours":
                return f"{jam_teks(d['jam'])} ventilasi ditagih ({p}), ventilator hanya jalan {jam_teks(t['mode_jam']['jalan'])}"
            if a == "binding_tumpang":
                o = u.get("lain") or {}
                jl_sendiri = float((t.get("mode_jam") or {}).get("jalan") or 0)
                if jl_sendiri > 0:
                    return (f"Ventilasi {jam_teks(d['jam'])} ditagih, ventilator pasien ini hanya jalan {jam_teks(jl_sendiri)}; sisanya memakai "
                            f"{o.get('device_id', 'ventilator')} yang pada jam yang sama terikat ke pasien {samaran(o.get('peserta', ''))}")
                return (f"Ventilasi {jam_teks(d['jam'])} ditagih memakai {o.get('device_id', 'ventilator')}, padahal pada jam yang sama alat itu terikat ke pasien "
                        f"{samaran(o.get('peserta', ''))}")
            if a == "no_device_trace":
                return f"Ventilasi ({p}) ditagih, tidak ada satu pun sesi ventilator untuk pasien ini; gateway RS online"
            if a == "faskes_offline":
                return f"Ventilasi ditagih, tidak ada pembacaan: gateway RS offline {u.get('offline_jam', 0)} jam saat layanan"
            if a == "anchor_mismatch":
                return "Catatan ventilator tidak cocok dengan jangkar bukti di ledger: data diubah setelah dijangkarkan"
            if p == "93.90":
                return f"Ventilasi (93.90) ditagih, ventilator jalan {jam_teks(t['mode_jam']['jalan'])}: sesuai"
            return f"Ventilasi {jam_teks(d['jam'])} ditagih ({p}), ventilator jalan {jam_teks(t['mode_jam']['jalan'])}: sesuai"
        if u["jenis"] == "icu":
            if a == "icu_days":
                return f"{u['hari_ditagih']} hari ICU ditagih, monitor bed ICU hanya menyala {jam_teks(t['mode_jam']['nyala'])} ({u['hari_terukur']} hari)"
            if a == "no_device_trace":
                return f"{u['hari_ditagih']} hari ICU ditagih, tidak ada sesi monitor ICU untuk pasien ini; gateway RS online"
            if a == "faskes_offline":
                return f"Hari ICU ditagih, tidak ada pembacaan: gateway RS offline {u.get('offline_jam', 0)} jam"
            if a == "anchor_mismatch":
                return "Catatan monitor ICU tidak cocok dengan jangkar bukti di ledger: data diubah setelah dijangkarkan"
            return f"{u['hari_ditagih']} hari ICU ditagih, monitor bed ICU menyala {jam_teks(t['mode_jam']['nyala'])} ({u['hari_terukur']} hari): sesuai"
        mnt = int(round(u.get("menit", 0)))
        if a == "hd_short":
            return f"Satu sesi hemodialisis penuh ditagih (standar {HD_STANDAR_MENIT // 60} jam), mesin hanya berjalan {mnt // 60} jam {mnt % 60} menit"
        if a == "hd_phantom":
            return "Satu sesi hemodialisis ditagih, mesin menyala tetapi tidak menjalankan dialisis"
        if a == "no_device_trace":
            return "Satu sesi hemodialisis ditagih, tidak ada sesi mesin dialisis untuk pasien ini; gateway RS online"
        if a == "faskes_offline":
            return f"Sesi hemodialisis ditagih, tidak ada pembacaan: gateway RS offline {u.get('offline_jam', 0)} jam saat sesi"
        if a == "anchor_mismatch":
            return "Catatan mesin dialisis tidak cocok dengan jangkar bukti di ledger: data diubah setelah dijangkarkan"
        return f"Satu sesi hemodialisis ditagih, mesin berjalan {mnt // 60} jam {mnt % 60} menit: sesuai"

    # ---------------------------------------------------------------- the fleet, the dashboard
    def armada(self, bukti: dict[str, dict]) -> tuple[list[dict], dict]:
        """Per device over the observation window: hours on per mode and per day, sessions, status at the window's end; and the
        dashboard (monitoring.json)."""
        jendela = self.man.get("jendela") or {}
        w0 = menit(jendela["mulai"]) if jendela.get("mulai") else int(self.df["m"].min())
        w1 = menit(jendela["akhir"]) if jendela.get("akhir") else int(self.df["m"].max()) + 60
        lebar = max(1.0, (w1 - w0) / 60)
        per = (self.man.get("periode") or {}).get("akhir")
        acuan = min(w1, menit(per) + 1439) if per else w1  # the dashboard's "now": the end of the batch period
        self.acuan = acuan
        hasil_sesi: dict[str, tuple] = {}
        for k, b in bukti.items():
            for s in b["sesi"]:
                hasil_sesi[s["sesi_id"]] = (b["klaim_id"], b["hasil"], b)
        alat_out = []
        for did in sorted(self.alat):
            a = self.alat[did]
            if a["jenis"] == GATEWAY:
                g = self.df[self.df.device_id == did]
                per_hari = Counter()
                for m, iv in zip(g["m"], g["interval_s"]):
                    per_hari[tanggal(m)] += iv / 3600
                on = float(g["interval_s"].sum()) / 3600
                sampai = g[g["m"] <= acuan]
                status = "online" if len(sampai) and int(sampai["m"].max()) >= acuan - 180 else "offline"
                alat_out.append({"id": did, "jenis": GATEWAY, "nama": a["nama"], "rs_id": str(a["faskes_profil_id"]), "rs": self.K["nama_rs"].get(str(a["faskes_profil_id"]), a.get("rs")),
                                 "sensor": a.get("sensor") or "gateway (heartbeat)", "status": status, "jam_nyala": jam(on), "utilisasi_pct": jam(100 * on / lebar), "sesi": 0,
                                 "mode_jam": {"online": jam(on)}, "terakhir": str(sampai["ts"].iloc[-1]) if len(sampai) else None, "kunci_dicabut": False, "dicabut_pada": None,
                                 "harian": [{"tanggal": tanggal(h * 1440), "jam": jam(per_hari.get(tanggal(h * 1440), 0.0)), "mode_jam": {"online": jam(per_hari.get(tanggal(h * 1440), 0.0))}}
                                            for h in range(w0 // 1440, (w1 - 1) // 1440 + 1)]})
                continue
            g = self.df[(self.df.device_id == did) & self.df.hash_ok]
            mj = Counter()
            per_hari: dict[str, Counter] = defaultdict(Counter)
            for m, iv, mode in zip(g["m"], g["interval_s"], g["mode"]):
                mj[mode] += iv / 3600
                per_hari[tanggal(m)][mode] += iv / 3600
            modes = JENIS[a["jenis"]]["mode"]
            on = sum(v for k_, v in mj.items() if k_ != "mati")
            n_sesi = sum(1 for s in self.sesi if str(s["device_id"]) == did)
            sampai = g[g["m"] <= acuan]
            akhir = sampai.iloc[-1] if len(sampai) else None
            gw = self.gw.get(str(a["faskes_profil_id"]))
            gwg = self.df[(self.df.device_id == gw) & (self.df["m"] <= acuan)] if gw else None
            if akhir is None:
                status = "offline"
            elif gwg is not None and len(gwg) and int(gwg["m"].max()) < acuan - 180:
                status = "offline"
            elif akhir["mode"] in ("jalan", "nyala") and str(akhir["sesi_id"]):
                status = "dipakai"
            elif akhir["mode"] == "mati":
                status = "mati"
            else:
                status = "siaga"
            hari = []
            for h in range(w0 // 1440, (w1 - 1) // 1440 + 1):
                tg = tanggal(h * 1440)
                c = per_hari.get(tg, Counter())
                hari.append({"tanggal": tg, "jam": jam(sum(v for k_, v in c.items() if k_ != "mati")), "mode_jam": {k_: jam(c[k_]) for k_ in modes}})
            alat_out.append({"id": did, "jenis": a["jenis"], "nama": a["nama"], "rs_id": str(a["faskes_profil_id"]), "rs": self.K["nama_rs"].get(str(a["faskes_profil_id"]), a.get("rs")),
                             "sensor": a.get("sensor") or SENSOR, "status": status, "jam_nyala": jam(on), "utilisasi_pct": jam(100 * on / lebar), "sesi": n_sesi,
                             "mode_jam": {k_: jam(mj[k_]) for k_ in modes}, "terakhir": str(akhir["ts"]) if akhir is not None else None,
                             "kunci_dicabut": did in self.cab, "dicabut_pada": a.get("dicabut_pada") or None, "harian": hari})
        # sessions for the dashboard: each session's result is its own device's check on the claim (an ICU monitor session of a
        # ventilation-fraud claim is itself consistent); a device kind the claim does not bill (an infusion pump) is "sesuai". The
        # billed hours, the billed code and the tariff difference sit on the visit's first session of that device kind
        cek_jenis = {"ventilator": "vent", "monitor_icu": "icu", "hemodialisis": "hd"}
        sesi_out, sudah_tagih = [], set()
        for s in sorted(self.sesi, key=lambda s: (s["mulai"], s["sesi_id"])):
            u = self.ukur(s)
            kid, hs, b = hasil_sesi.get(s["sesi_id"], (None, "tanpa_klaim", None))
            jenis = (self.alat.get(str(s["device_id"])) or {}).get("jenis")
            ditagih, selisih, kode, jg = None, 0, None, None
            if b:
                c = next((c for c in b["cek"] if c["jenis"] == cek_jenis.get(jenis)), None)
                hs = c["hasil"] if c else "sesuai"
                ditagih = 0.0
                kode = next((x.get("kode") for x in b["sesi"] if x["sesi_id"] == s["sesi_id"]), None)
                kunci_t = (kid, jenis)
                if c and kunci_t not in sudah_tagih:
                    sudah_tagih.add(kunci_t)
                    ditagih = float(b["tagihan_jenis"].get(cek_jenis[jenis]) or 0)
                    selisih = int(c["selisih_rp"]) if c["hasil"] == "tidak_sesuai" else 0
                bk = b["bukti"]
                if bk.get("merkle_root"):
                    jg = {"status": "tidak_cocok" if not bk["rantai_ok"] else "terlambat" if bk.get("jangkar_sebelum_klaim") is False else "ok",
                          "root": bk["merkle_root"], "waktu": bk["dijangkarkan"], "tx": bk.get("tx")}
            sesi_out.append({"sesi_id": s["sesi_id"], "device_id": str(s["device_id"]), "jenis": jenis, "peserta": samaran(s["peserta"]), "kunjungan": kid or str(s["kunjungan"]),
                             "klaim_id": kid, "mulai": s["mulai"], "selesai": s["selesai"] or None, "alasan_selesai": s.get("alasan_selesai") or None,
                             "jam": jam(sum(v for k_, v in u["mode_jam"].items() if k_ != "mati")), "mode_jam": {k_: jam(u["mode_jam"][k_]) for k_ in (JENIS.get(jenis) or {}).get("mode", ())},
                             "jam_ditagih": ditagih, "kode": kode, "selisih_rp": selisih, "jangkar": jg, "hasil": hs})
        return alat_out, {"sesi": sesi_out, "w0": w0, "w1": w1}

    def alarm(self, bukti: dict[str, dict]) -> list[dict]:
        """Alerts for the dashboard, each on the device whose readings contradict the claim (a missing session: the hospital's gateway,
        whose heartbeats show it was online), with its hospital, session and time window: IoT mismatches, a device bound to two
        patients at once (both patients, the overlap), readings in an active mode with no bound patient, anchor mismatches and late
        anchors, gateways offline, readings from a revoked key. One plain sentence each, with its numbers."""
        out = []
        by_sesi = {s["sesi_id"]: s for s in self.sesi}

        def rs_of(did: str | None, f: str | None = None) -> tuple[str | None, str | None]:
            f = f or str((self.alat.get(str(did)) or {}).get("faskes_profil_id") or "") or None
            return f, (self.K["nama_rs"].get(f) if f else None)

        for k, b in sorted(bukti.items(), key=lambda x: x[1]["klaim_id"]):
            f = b["faskes_profil_id"]
            utama = b.get("sesi_utama")
            su = by_sesi.get(utama) if utama else None
            if b["hasil"] == "tidak_sesuai":
                if b["aturan"] == "binding_tumpang" and b.get("sesi_lain"):
                    o = b["sesi_lain"]
                    mine = next((x for x in b["sesi"] if x["device_id"] == o["device_id"]), None) or {}
                    m0 = max(mine.get("mulai") or o["mulai"], o["mulai"])
                    m1 = min(mine.get("selesai") or o["selesai"] or m0, o["selesai"] or mine.get("selesai") or m0)
                    out.append({"waktu": m0, "mulai": m0, "selesai": m1, "jenis": "binding_tumpang", "device_id": o["device_id"], "sesi_id": mine.get("sesi_id"),
                                "sesi_lain": o["sesi_id"], "peserta": [b["peserta"], o["peserta"]], "klaim_id": b["klaim_id"], "rs_id": f, "rs": b["rs"],
                                "judul": f"{o['device_id']} terikat ke {b['peserta']} ({b['klaim_id']}) dan {o['peserta']} pada jam yang sama "
                                         f"({m0.replace('T', ' ')} s/d {m1.replace('T', ' ')}); pemakaian {jam_teks(b['ditagih']['jam'] or 0)} ditagih dua kali, selisih {rp(b['tarif']['selisih_rp'])}.",
                                "selisih_rp": b["tarif"]["selisih_rp"]})
                else:
                    did = b.get("alat_utama") or self.gw.get(f)
                    out.append({"waktu": (su or {}).get("mulai") or b["rawat"]["masuk"], "mulai": (su or {}).get("mulai") or b["rawat"]["masuk"],
                                "selesai": (su or {}).get("selesai") or b["rawat"]["pulang"], "jenis": "iot.tidak_sesuai", "device_id": did, "sesi_id": utama,
                                "peserta": [b["peserta"]], "klaim_id": b["klaim_id"], "rs_id": f, "rs": b["rs"],
                                "judul": f"{b['klaim_id']} ({b['peserta']}): {b['judul']}; selisih {rp(b['tarif']['selisih_rp'])}.", "selisih_rp": b["tarif"]["selisih_rp"]})
            if b["bukti"].get("merkle_root") and not b["bukti"]["rantai_ok"]:
                out.append({"waktu": b["bukti"]["dijangkarkan"], "mulai": (su or {}).get("mulai"), "selesai": (su or {}).get("selesai"), "jenis": "jangkar_tidak_cocok",
                            "device_id": b.get("alat_utama"), "sesi_id": utama, "peserta": [b["peserta"]], "klaim_id": b["klaim_id"], "rs_id": f, "rs": b["rs"],
                            "judul": f"Bukti {b['klaim_id']}: {b['bukti']['catatan']}.", "selisih_rp": 0})
            if b["bukti"].get("jangkar_sebelum_klaim") is False:
                out.append({"waktu": b["bukti"]["dijangkarkan"], "mulai": (su or {}).get("mulai"), "selesai": (su or {}).get("selesai"), "jenis": "jangkar_terlambat",
                            "device_id": b.get("alat_utama"), "sesi_id": utama, "peserta": [b["peserta"]], "klaim_id": b["klaim_id"], "rs_id": f, "rs": b["rs"],
                            "judul": f"Bukti {b['klaim_id']} dijangkarkan {b['bukti']['dijangkarkan'].replace('T', ' ')}, setelah klaim diajukan {b['bukti']['klaim_diajukan']}.",
                            "selisih_rp": 0})
        # readings in an active mode with no bound patient: one alert per unbroken stretch of an hour or more
        for (did, rep), g in sorted(self.by_alat.items()):
            a = self.alat.get(did) or {}
            if a.get("jenis") not in JENIS:
                continue
            f, nama = rs_of(did)
            aktif = g[(g.sesi_id == "") & g["mode"].isin(JENIS[a["jenis"]]["aktif"])]
            blok, cur = [], None
            for m, iv, mode, seq in zip(aktif["m"], aktif["interval_s"], aktif["mode"], aktif["seq"]):
                if cur and int(seq) == cur["seq"] + 1:
                    cur.update({"akhir": int(m) + int(iv) // 60, "seq": int(seq), "jam": cur["jam"] + iv / 3600})
                else:
                    cur = {"awal": int(m), "akhir": int(m) + int(iv) // 60, "seq": int(seq), "jam": iv / 3600, "mode": mode}
                    blok.append(cur)
            for x in blok:
                if x["jam"] >= 1:
                    out.append({"waktu": iso(x["awal"]), "mulai": iso(x["awal"]), "selesai": iso(x["akhir"]), "jenis": "tanpa_pasien", "device_id": did, "sesi_id": None,
                                "peserta": None, "klaim_id": None, "rs_id": f, "rs": nama,
                                "judul": f"{did} {NAMA_MODE.get(x['mode'], x['mode'])} {jam_teks(x['jam'])} ({iso(x['awal']).replace('T', ' ')} s/d "
                                         f"{iso(x['akhir']).replace('T', ' ')}) tanpa pasien yang terikat.", "selisih_rp": 0})
            dc = g[g.dicabut]
            if len(dc):
                out.append({"waktu": str(dc["ts"].iloc[0]), "mulai": a.get("dicabut_pada") or str(dc["ts"].iloc[0]), "selesai": str(dc["ts"].iloc[-1]), "jenis": "kunci_dicabut",
                            "device_id": did, "sesi_id": None, "peserta": None, "klaim_id": None, "rs_id": f, "rs": nama,
                            "judul": f"{did} masih mengirim {len(dc)} pembacaan setelah kuncinya dicabut {str(a.get('dicabut_pada') or '').replace('T', ' ')}: pembacaan itu tidak sah.",
                            "selisih_rp": 0})
        # gateways silent for 3 hours or more
        for f, gw in sorted(self.gw.items()):
            for (did, rep), g in self.by_alat.items():
                if did != gw:
                    continue
                cad = int(g["interval_s"].iloc[0]) // 60 or 60
                ms = sorted(int(m) for m in g["m"])
                for x, y in zip(ms, ms[1:]):
                    if y - x >= max(180, 3 * cad):
                        out.append({"waktu": iso(x + cad), "mulai": iso(x + cad), "selesai": iso(y), "jenis": "offline", "device_id": gw, "sesi_id": None, "peserta": None,
                                    "klaim_id": None, "rs_id": f, "rs": self.K["nama_rs"].get(f),
                                    "judul": f"Gateway {self.K['nama_rs'].get(f)} offline {jam_teks((y - x - cad) / 60)} ({iso(x + cad).replace('T', ' ')} s/d {iso(y).replace('T', ' ')}): "
                                             f"pembacaan alat RS ini hilang, klaim pada jam itu tidak dituduh.", "selisih_rp": 0})
        out.sort(key=lambda x: (x["waktu"] or "", x["jenis"]))
        return out

def periksa(set_name: str, iot_dir: str | Path | None = None, kc: str | None = None) -> dict:
    """Check a run's branch claims against an IoT input folder (never the ground truth) and write bukti.json, alat.json,
    ringkasan.json and monitoring.json to data/aip/cabang/iot/<set>/. Returns the summary (ringkasan)."""
    t0 = time.time()
    d = Path(iot_dir) if iot_dir else basis_iot() / set_name / "masukan"
    if not (d / "alat.csv").exists() and not (d / "alat.json").exists():
        raise SystemExit(f"{d}: bukan folder masukan IoT (tidak ada alat.csv / alat.json); lihat docs/IOT_FORMAT_MASUKAN.md")
    man = json.loads((d / "manifest.json").read_text("utf-8")) if (d / "manifest.json").exists() else {}
    K = klaim_run(set_name, kc or ((man.get("kc") or {}).get("id")))
    P = _Periksa(K, d)
    bukti: dict[str, dict] = {}
    for r in sorted(K["rows"], key=lambda r: r["kunci"]):
        b = P.klaim(r)
        if b is not None:
            bukti[r["kunci"]] = b
    alat_out, mon = P.armada(bukti)
    alat_med = [a for a in alat_out if a["jenis"] != GATEWAY]  # the counts are medical devices; gateways are listed for their status
    alarm = P.alarm(bukti)
    rs_iot = sorted({str(a["faskes_profil_id"]) for a in P.alat.values()})
    n = Counter(b["hasil"] for b in bukti.values())
    per_aturan: dict[str, list] = defaultdict(lambda: [0, 0])
    for b in bukti.values():
        if b["hasil"] == "tidak_sesuai":
            per_aturan[b["aturan"]][0] += 1
            per_aturan[b["aturan"]][1] += b["tarif"]["selisih_rp"]
    selisih = sum(b["tarif"]["selisih_rp"] for b in bukti.values() if b["hasil"] == "tidak_sesuai")
    sint = bool(man.get("sintetis", True))
    rt = [b["mesin_realtime"] for b in bukti.values() if b.get("mesin_realtime") and b["mesin_realtime"].get("sepakat") is not None]
    ringkas = {"rs_dengan_iot": len(rs_iot), "alat": len(alat_med), "mesin_realtime": {"klaim": len(rt), "sepakat": sum(1 for x in rt if x["sepakat"])} if rt else None, "klaim_dengan_alat": len(bukti), "sesuai": n["sesuai"], "tidak_sesuai": n["tidak_sesuai"],
               "tanpa_bukti": n["tanpa_bukti"], "selisih_rp": int(selisih),
               "aturan": [{"aturan": a, "judul": JUDUL_ATURAN.get(a, a), "klaim": v[0], "selisih_rp": int(v[1])} for a, v in sorted(per_aturan.items(), key=lambda x: -x[1][1])],
               "sintetis": sint}
    OUT = basis_iot() / set_name
    meta = {"run": set_name, "kc": {"id": K["kc"]["id"], "nama": K["kc"]["nama"]}, "dibuat": time.strftime("%Y-%m-%d %H:%M"), "masukan": str(d), "format": man.get("format", FORMAT),
            "sintetis": sint}
    tulis_json(OUT / "bukti.json", {**meta, "klaim": bukti})
    tulis_json(OUT / "alat.json", {**meta, "alat": alat_out})
    jangkar_ok = sum(1 for b in bukti.values() if b["bukti"].get("merkle_root") and b["bukti"]["rantai_ok"])
    jangkar_n = sum(1 for b in bukti.values() if b["bukti"].get("merkle_root"))
    periode = man.get("periode") or {"mulai": min(r["tgl"] for r in K["rows"]), "akhir": max(r["tgl"] for r in K["rows"])}
    jenis_alat = []
    for j, x in JENIS.items():
        al = [a for a in alat_out if a["jenis"] == j]
        if al:
            jenis_alat.append({"jenis": j, "nama": x["label"], "alat": len(al), "jam": jam(sum(a["jam_nyala"] for a in al)),
                               "utilisasi_pct": jam(sum(a["utilisasi_pct"] for a in al) / len(al))})
    rs_out = []
    for f in rs_iot:
        al = [a for a in alat_med if a["rs_id"] == f]
        bs = [b for b in bukti.values() if b["faskes_profil_id"] == f]
        rs_out.append({"id": f, "nama": K["nama_rs"].get(f, f), "kabkota": " ".join(w.capitalize() for w in str(K["rs"][f]["kab_nama"]).split()), "alat": len(al),
                       "jam": jam(sum(a["jam_nyala"] for a in al)), "utilisasi_pct": jam(sum(a["utilisasi_pct"] for a in al) / max(1, len(al))),
                       "klaim_dengan_alat": len(bs), "tidak_sesuai": sum(1 for b in bs if b["hasil"] == "tidak_sesuai"),
                       "selisih_rp": int(sum(b["tarif"]["selisih_rp"] for b in bs if b["hasil"] == "tidak_sesuai"))})
    rs_out.sort(key=lambda x: (-x["selisih_rp"], -x["alat"], x["nama"]))
    monitoring = {"run": set_name, "kc": meta["kc"], "periode": {"mulai": periode["mulai"], "akhir": periode["akhir"]}, "sintetis": sint,
                  "jendela": {"mulai": iso(mon["w0"]), "akhir": iso(mon["w1"])}, "status_per": iso(P.acuan),
                  "ringkas": {"rs": len(rs_iot), "alat": len(alat_med), "alat_aktif": sum(1 for a in alat_med if a["status"] == "dipakai"), "sesi": len(mon["sesi"]),
                              "jam_total": jam(sum(a["jam_nyala"] for a in alat_med)), "gateway": len(alat_out) - len(alat_med),
                              "gateway_offline": sum(1 for a in alat_out if a["jenis"] == GATEWAY and a["status"] == "offline"), "klaim_dengan_alat": len(bukti), "sesuai": n["sesuai"], "tidak_sesuai": n["tidak_sesuai"],
                              "tanpa_bukti": n["tanpa_bukti"], "selisih_rp": int(selisih), "jangkar": jangkar_n, "jangkar_ok": jangkar_ok, "peringatan": len(alarm)},
                  "jenis_alat": jenis_alat, "rs": rs_out, "alat": alat_out, "sesi": mon["sesi"], "peringatan": alarm}
    tulis_json(OUT / "monitoring.json", monitoring)
    tulis_json(OUT / "ringkasan.json", {**meta, **ringkas, "periode": monitoring["periode"], "jangkar": jangkar_n, "jangkar_ok": jangkar_ok, "peringatan": len(alarm),
                                        "tarif_ventilasi": tabel_tarif_ventilasi(P.T, K, rs_iot)})
    print(f"iot periksa {set_name} {K['kc']['id']}: {len(bukti)} klaim beralat · sesuai {n['sesuai']} · tidak sesuai {n['tidak_sesuai']} · tanpa bukti {n['tanpa_bukti']} · "
          f"selisih {rp(selisih)} · {len(alarm)} peringatan · {time.time() - t0:.0f} s -> {OUT}")
    return ringkas


def tabel_tarif_ventilasi(T: Tarif, K: dict, rs_iot: list[str]) -> list[dict]:
    """The ventilation tariffs the layer prices with: >= 96 h (J-1-02) against < 96 h (J-1-20), same severity, per covered hospital
    (class 3) and the sample's medians, with their sources: the documentation of the difference."""
    out = []
    for sev in ("I", "II", "III"):
        a, b = f"J-1-02-{sev}", f"J-1-20-{sev}"
        row = {"keparahan": sev, "kode_96_jam_atau_lebih": a, "deskripsi_96": T.deskripsi(a), "kode_kurang_96_jam": b, "deskripsi_kurang_96": T.deskripsi(b),
               "nasional_median_rp": [T._level(a).get((None, None, None)), T._level(b).get((None, None, None))], "rs": []}
        for f in rs_iot:
            ta, tb, src = T.pasangan(a, b, f, "Kelas 3")
            row["rs"].append({"rs": K["nama_rs"].get(f, f), "tarif_96_rp": ta, "tarif_kurang_96_rp": tb, "selisih_rp": (ta - tb) if ta and tb else None, "sumber": src})
        out.append(row)
    return out


def baca_bukti(set_name: str) -> dict | None:
    """The checker's output for a run (laporan_cabang / graf_cabang), or None when the run has no IoT layer."""
    f = basis_iot() / set_name / "bukti.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("perintah", nargs="?", default="semua", choices=["generate", "periksa", "semua"])
    ap.add_argument("--set", default="gen3_kc2")
    ap.add_argument("--kc", default="", help="branch id (e.g. sul-7371); default: the branch of the set's report")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--keluar", default="", help="generate: the input folder to write (default data/aip/cabang/iot/<set>/masukan)")
    ap.add_argument("--iot", default="", help="periksa: the input folder to read (default data/aip/cabang/iot/<set>/masukan)")
    a = ap.parse_args()
    if a.perintah in ("generate", "semua"):
        generate(a.set, a.keluar or None, a.kc or None, a.seed)
    if a.perintah in ("periksa", "semua"):
        periksa(a.set, a.iot or a.keluar or None, a.kc or None)


if __name__ == "__main__":
    main()
