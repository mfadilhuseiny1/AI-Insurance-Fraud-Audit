"""White-box explanation of each case file in the AI Agent Swarm Branch report (the user, 2026-11-14: "tiap klaim yang indikasi
fraud ada penjelasan 1 paragraf, reasoning kenapa ini terindikasi fraud, coba lihat /testing" and "jadi semuanya whitebox, ga ada
blackbox"). Written by code from the facts the decision rested on, no LLM, so every sentence traces to one fact the case file and
its claim network show:

  a tie in the claim network (the same claim filed twice, an overlapping stay, a readmission, the card at another hospital, a
  clone-like bill), a rule finding with the claim's value and the rule's threshold, a finding against the hospital's own medical
  record (SATUSEHAT: a billed procedure absent, normal measurements against a billed diagnosis, ...) with the record's numbers when
  the caller passes the signal's evidence (ctx['bukti_sinyal'] or ctx['rme']['sinyal']), the claim's figures against its INA-CBG
  code's medians, the model's score against its zone thresholds with its strongest SHAP drivers, and the swarm's scores against tau.

Two parts per claim:
  paragraf  one paragraph: what is odd, why that is a fraud sign (the Permenkes 16/2019 mode), how the system reached its decision
            (numbers against thresholds) and where to see it in the claim network (shapes as GrafKlaim draws them);
  jejak     the decision trail, one step per system: rule engine findings, review rules (value vs threshold), the model (score,
            zone, drivers by block: the claim itself, its graph neighbours, the fraud-mechanism features), the swarm (each agent,
            the combination against tau) and the decision.
Synthetic data only."""
from __future__ import annotations

import re
from typing import Any

import penjelas as PJ


def label_temuan(t: dict) -> str:
    """A rule finding named in plain words: its signal's label from the engine's table, else its text cut at a word."""
    try:
        from aip.realtime.modus import SIGNALS
        lab = (SIGNALS.get(str(t.get("kode") or "")) or (None, None, None, ""))[3]
    except Exception:  # noqa: BLE001 - the engine not on the path: the finding's own text below
        lab = ""
    if lab:
        return lab[:1].lower() + lab[1:]
    x = str(t.get("teks") or "").split(" -> ")[0]
    return x if len(x) <= 140 else x[:x.rfind(" ", 0, 139)].rstrip(" ,;:(") + "…"

BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"]


def tgl(s: str) -> str:
    y, m, d = str(s)[:10].split("-")
    return f"{int(d)} {BULAN[int(m) - 1]} {y}"


def rp(v: float) -> str:
    return "Rp" + f"{int(round(float(v))):,}".replace(",", ".")


def des(x: float, n: int = 2) -> str:
    return f"{float(x):.{n}f}".replace(".", ",")


def persen(x: float) -> str:
    v = 100 * float(x)
    return (f"{v:.1f}" if v < 99.95 else f"{min(v, 99.99):.2f}").replace(".", ",") + "%"


# ---- what ties a neighbour to the claim (testing/graf_cabang.tanda), as a finding
TANDA_URUT = ["sama_persis", "tumpang_tindih", "mirip_kloning", "readmisi_dekat", "beda_rs_dekat"]
TANDA_MODUS = {"sama_persis": ("ganda", "Repeat billing (klaim berulang)"), "tumpang_tindih": ("tumpang", "Phantom billing (klaim palsu)"),
               "mirip_kloning": ("kloning", "Cloning (penjiplakan klaim)"), "readmisi_dekat": ("readmisi", "Readmisi (admisi berulang)"),
               "beda_rs_dekat": ("kartu", "Phantom billing (klaim palsu)")}
# the engine signals a tie already explains (not repeated as a second finding)
TANDA_SINYAL = {"sama_persis": {"KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP"}, "tumpang_tindih": {"RAWAT_INAP_TUMPANG_TINDIH"},
                "mirip_kloning": {"KLONING_LINTAS_PESERTA"}, "readmisi_dekat": {"READMISI", "READMISI_DX_SAMA", "PEMECAHAN_EPISODE"},
                "beda_rs_dekat": {"KARTU_BANYAK_FASKES"}}
# the claim against the hospital's own electronic medical record (SATUSEHAT FHIR, api/aip/realtime/rme.py): one kind per finding,
# because the reason, the documents to ask for and the innocent explanation differ for each. The Permenkes mode is the engine's own
# (modus.SIGNALS, read by modus_dari): visit missing / another patient M06, visit billed twice M11, inpatient billed for an outpatient
# visit M04 (and M06), procedure missing M14, procedure or admission without indication M15, diagnosis missing or contradicted M04,
# drug/implant missing M17, ward class M13, length of stay M12, one stay billed as several M08 (and M09)
RME_JENIS = {"RME_KUNJUNGAN_TIDAK_ADA": "rme_kunjungan", "RME_PASIEN_BERBEDA": "rme_pasien", "RME_KUNJUNGAN_DIPAKAI_ULANG": "rme_ganda",
             "RME_JENIS_RAWAT_BERBEDA": "rme_jenis_rawat", "RME_TINDAKAN_TIDAK_TERCATAT": "rme_tindakan", "RME_DIAGNOSIS_TIDAK_DIDUKUNG": "rme_dx_dibantah",
             "RME_KLINIS_TIDAK_MENDUKUNG": "rme_indikasi", "RME_OBAT_ALKES_TIDAK_TERCATAT": "rme_obat", "RME_KELAS_BERBEDA": "rme_kelas",
             "RME_LOS_TIDAK_SESUAI": "rme_los", "RME_EPISODE_DIPECAH": "rme_episode", "RME_DIAGNOSIS_TIDAK_TERCATAT": "rme_dx_hilang",
             "RME_RAWAT_INAP_TANPA_INDIKASI": "rme_rawat_inap"}
JENIS_RME = set(RME_JENIS.values())
# the engine's findings, strongest kind first; the reason key of each. A medical-record finding is a document contradicting the claim,
# so it comes before the statistical findings, right after the identity and duplicate ones: the visit itself (missing, another patient,
# billed twice, another care type), then what was billed inside it (procedure, diagnosis, indication, drugs, class, stay, episode), the
# order rme.periksa checks them in. An admission whose every measurement is normal is a review finding, not proof (rme.py marks it
# PERLU_TELAAH): it stays with the coding findings
SINYAL_URUT = ["KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP", "RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES", "KARTU_KELUARGA",
               "MENINGGAL_TERCATAT", "KLAIM_SETELAH_MENINGGAL",
               "RME_KUNJUNGAN_TIDAK_ADA", "RME_PASIEN_BERBEDA", "RME_KUNJUNGAN_DIPAKAI_ULANG", "RME_JENIS_RAWAT_BERBEDA", "RME_TINDAKAN_TIDAK_TERCATAT",
               "RME_VENTILASI_TIDAK_SESUAI", "RME_DIAGNOSIS_TIDAK_DIDUKUNG", "RME_KLINIS_TIDAK_MENDUKUNG", "RME_OBAT_ALKES_TIDAK_TERCATAT", "RME_OBAT_JUMLAH_KURANG",
               "RME_KELAS_BERBEDA", "RME_LOS_TIDAK_SESUAI", "RME_HARI_ICU_LEBIH",
               "RME_EPISODE_DIPECAH", "RME_READMISI_PULANG_DINI", "RME_READMISI_TERENCANA", "RME_DIAGNOSIS_TIDAK_TERCATAT",
               "IOT_JANGKAR_TIDAK_COCOK", "IOT_VENTILASI_KURANG_96", "IOT_HD_SESI_SINGKAT", "IOT_HARI_ICU_LEBIH", "IOT_MODE_NONINVASIF", "IOT_VENTILATOR_STANDBY",
               "IOT_HD_TANPA_SESI", "IOT_TANPA_JEJAK", "IOT_BINDING_TUMPANG", "IOT_JANGKAR_TERLAMBAT", "IOT_KUNCI_DICABUT",
               "KLONING_LINTAS_PESERTA", "PEMECAHAN_EPISODE", "EPISODE_HARI_SAMA", "READMISI_DX_SAMA", "READMISI",
               "CINCIN_FASKES", "TAGIHAN_MELEBIHI_TARIF", "TOPUP_TIDAK_LAZIM", "TOPUP_DI_ATAS_PEER", "KELAS_DI_ATAS_HAK", "RME_RAWAT_INAP_TANPA_INDIKASI", "RME_RUJUKAN_TANPA_INDIKASI", "RME_DOKTER_PASIEN_DIPUTAR",
               "DX_SEKUNDER_BERLEBIH", "KODE_PROSEDUR_TANPA_TINDAKAN", "PASANGAN_KODE_LANGKA", "LONJAKAN_KEPARAHAN", "LOS_DIPERPANJANG", "LOS_FASKES_BERGESER",
               "IOT_TANPA_PASIEN", "ANOMALI_SSL", "SKOR_ML"]
SINYAL_JENIS = {"KLAIM_GANDA_STREAM": "ganda", "KLAIM_GANDA_RIWAYAT": "ganda", "KLAIM_BERULANG_MIRIP": "ganda", "RAWAT_INAP_TUMPANG_TINDIH": "tumpang",
                "KARTU_BANYAK_FASKES": "kartu", "KARTU_KELUARGA": "kartu", "MENINGGAL_TERCATAT": "fiktif", "KLAIM_SETELAH_MENINGGAL": "fiktif",
                "KLONING_LINTAS_PESERTA": "kloning", "PEMECAHAN_EPISODE": "episode", "EPISODE_HARI_SAMA": "episode", "READMISI_DX_SAMA": "readmisi",
                "READMISI": "readmisi", "CINCIN_FASKES": "jaringan", "TAGIHAN_MELEBIHI_TARIF": "tagihan", "TOPUP_TIDAK_LAZIM": "tagihan",
                "TOPUP_DI_ATAS_PEER": "tagihan", "KELAS_DI_ATAS_HAK": "kelas", "DX_SEKUNDER_BERLEBIH": "koding", "KODE_PROSEDUR_TANPA_TINDAKAN": "koding",
                "PASANGAN_KODE_LANGKA": "koding", "LONJAKAN_KEPARAHAN": "koding", "LOS_DIPERPANJANG": "los", "LOS_FASKES_BERGESER": "los", **RME_JENIS}
# the claim against the hospital's device evidence (api/aip/realtime/iot.py: a current clamp on the power cable, the device never
# opened: on-time, duration and state jalan / siaga / mati): one kind per finding; the medical record's ventilation and ICU findings
# read as the same kinds. iot_mode = a mode the ventilator itself reported (never clamp data)
SINYAL_JENIS.update({"IOT_VENTILASI_KURANG_96": "iot_vent", "IOT_MODE_NONINVASIF": "iot_mode", "IOT_VENTILATOR_STANDBY": "iot_siaga", "IOT_HD_SESI_SINGKAT": "iot_hd",
                     "IOT_HD_TANPA_SESI": "iot_hd", "IOT_HARI_ICU_LEBIH": "iot_icu", "IOT_TANPA_JEJAK": "iot_jejak", "IOT_BINDING_TUMPANG": "iot_binding",
                     "IOT_TANPA_PASIEN": "iot_tanpa_pasien", "IOT_JANGKAR_TIDAK_COCOK": "iot_integritas", "IOT_JANGKAR_TERLAMBAT": "iot_integritas",
                     "IOT_KUNCI_DICABUT": "iot_integritas"})
RME_BARU = {"RME_VENTILASI_TIDAK_SESUAI": "rme_vent", "RME_HARI_ICU_LEBIH": "rme_icu", "RME_OBAT_JUMLAH_KURANG": "rme_obat", "RME_READMISI_PULANG_DINI": "readmisi",
            "RME_READMISI_TERENCANA": "readmisi", "RME_RUJUKAN_TANPA_INDIKASI": "jaringan", "RME_DOKTER_PASIEN_DIPUTAR": "jaringan"}
RME_JENIS.update(RME_BARU)
SINYAL_JENIS.update(RME_BARU)
JENIS_IOT = {"iot_vent", "iot_siaga", "iot_mode", "iot_hd", "iot_icu", "iot_jejak", "iot_binding", "iot_tanpa_pasien", "iot_integritas"}
JENIS_RME |= JENIS_IOT  # a device or record finding gives its own reason
RME_TELAAH = {"RME_RAWAT_INAP_TANPA_INDIKASI", "RME_RUJUKAN_TANPA_INDIKASI", "RME_DOKTER_PASIEN_DIPUTAR"}  # review level, not direct evidence
# proof (a measured duration or a hash) vs review (a mode read from the current pattern, or an absence): iot.JENIS_BUKTI
IOT_BUKTI = {"IOT_VENTILASI_KURANG_96", "IOT_HD_SESI_SINGKAT", "IOT_HARI_ICU_LEBIH", "IOT_JANGKAR_TIDAK_COCOK"}
try:
    from aip.realtime import iot as _IOT

    IOT_BUKTI = {k for k, v in _IOT.JENIS_BUKTI.items() if v == "bukti"}
except Exception:  # noqa: BLE001 - the engine module is optional here
    pass
# why each kind is a fraud sign (one clause, for "Ini tanda fraud karena ...")
ALASAN = {
    "ganda": "satu pelayanan yang ditagihkan dua kali membuat BPJS membayar dua kali untuk satu kunjungan",
    "kloning": "klaim yang menyalin klaim pasien lain (kode, lama rawat dan tagihan hampir sama) menagih pelayanan yang belum tentu terjadi",
    "tumpang": "satu orang tidak mungkin dirawat inap di dua RS pada malam yang sama, jadi salah satu klaim memakai kartu orang lain atau pelayanannya tidak terjadi",
    "kartu": "kartu yang sama dipakai di RS lain hampir bersamaan bisa berarti kartu dipinjam orang lain atau pelayanannya tidak terjadi",
    "fiktif": "pelayanan setelah peserta tercatat meninggal tidak mungkin terjadi",
    "episode": "satu episode perawatan yang dipecah menjadi beberapa klaim dibayar lebih dari satu paket INA-CBG",
    "readmisi": "pasien yang dipulangkan lalu dirawat lagi untuk masalah yang sama membuat satu episode dibayar dua kali",
    "jaringan": "peserta yang sama diputar di beberapa RS yang sama dalam waktu berdekatan menandakan rujukan semu",
    "tagihan": "tagihan atau top-up yang jauh di atas klaim lain dengan kode sama menandakan biaya yang digelembungkan",
    "kelas": "kelas rawat di atas hak peserta menaikkan tagihan tanpa dasar",
    "koding": "diagnosis atau keparahan yang ditambah membuat tarif paket INA-CBG lebih tinggi dari pelayanan sebenarnya",
    "los": "lama rawat yang dipanjangkan atau dipendekkan dari kebiasaan kode ini bisa menggeser tarif atau memecah episode",
    "ml": "pola klaim ini sangat mirip klaim bermasalah di data latih walau tidak satu modus pun berdiri sendiri",
    # the medical record is the hospital's own account of the care: a claim it contradicts bills care the hospital itself did not record
    "rme_kunjungan": "rekam medis adalah catatan rumah sakit sendiri, jadi klaim tanpa kunjungan di catatan itu menagih pelayanan yang tampaknya tidak pernah terjadi",
    "rme_pasien": "pasien yang dilayani bukan pemilik kartu berarti kartu dipakai orang lain, sehingga BPJS membayar pelayanan untuk orang yang tidak berhak",
    "rme_ganda": "satu kunjungan yang menjadi dasar dua klaim membuat BPJS membayar dua kali untuk satu pelayanan",
    "rme_jenis_rawat": "kunjungan rawat jalan yang ditagih sebagai rawat inap dibayar dengan paket rawat inap yang jauh lebih mahal dari pelayanan yang diterima pasien",
    "rme_tindakan": "tindakan yang ditagih tetapi tidak ada di catatan medis rumah sakit sendiri kemungkinan tidak dilakukan, padahal tindakan itulah yang menaikkan tarif paket",
    "rme_dx_dibantah": "diagnosis berat yang dibantah hasil pemeriksaan pasien sendiri menaikkan keparahan dan tarif paket INA-CBG tanpa kondisi yang sebenarnya",
    "rme_indikasi": "tindakan tanpa alasan medis di catatan rumah sakit sendiri bisa berarti tindakan itu tidak perlu atau tidak dilakukan, tetapi tetap menaikkan tarif paket",
    "rme_obat": "obat atau alat yang ditagih tetapi tidak tercatat diberikan membuat BPJS membayar barang yang tidak diterima pasien",
    "rme_kelas": "kelas rawat yang ditagih lebih tinggi dari kamar yang tercatat menaikkan tarif tanpa pelayanan yang sebenarnya",
    "rme_los": "hari rawat yang ditagih melebihi catatan rumah sakit sendiri membuat BPJS membayar hari rawat yang tidak dijalani pasien",
    "rme_episode": "satu kali rawat inap yang ditagih sebagai beberapa klaim membuat BPJS membayar lebih dari satu paket untuk satu perawatan",
    "rme_dx_hilang": "diagnosis yang ditagih tetapi tidak ditulis dokter di rekam medis bisa jadi ditambahkan hanya untuk menaikkan tarif paket",
    "rme_rawat_inap": "pasien yang semua hasil pemeriksaannya normal biasanya cukup dirawat jalan, sehingga rawat inap ini bisa jadi ditagih tanpa kebutuhan medis",
    # the device evidence (the engine agent's texts)
    "iot_vent": "ventilasi ≥ 96 jam berturut-turut dibayar jauh lebih mahal, padahal sensor clamp pada kabel daya ventilator mencatat alat itu tidak pernah jalan selama itu tanpa putus",
    "rme_vent": "ventilasi ≥ 96 jam berturut-turut dibayar jauh lebih mahal, padahal rekam medis rumah sakit sendiri mencatat ventilasi yang lebih pendek",
    "rme_icu": "hari ICU dibayar jauh lebih mahal dari bangsal biasa, padahal rekam medis mencatat pasien lebih sedikit hari di ICU",
    "iot_siaga": "ventilasi dibayar, padahal sensor clamp pada kabel daya mencatat ventilator hanya menyala siaga dan tidak pernah jalan memberi napas",
    "iot_mode": "mode ventilasi yang ditagih berbeda dari mode yang dilaporkan ventilator itu sendiri (bukan dari sensor clamp), dan mode yang ditagih masuk grup tarif yang lebih mahal",
    "iot_hd": "sesi cuci darah dibayar penuh, padahal mesinnya jalan kurang dari 3 jam atau tidak jalan sama sekali",
    "iot_icu": "hari ICU dibayar jauh lebih mahal dari bangsal biasa, padahal bed/monitor ICU pasien ini tidak menyala selama itu",
    "iot_jejak": "pemakaian alat yang ditagih tidak meninggalkan jejak apa pun di sensor alat rumah sakit yang sudah terpasang sensor",
    "iot_binding": "satu alat tidak dapat dipakai dua pasien sekaligus, jadi salah satu tagihan pemakaian alat itu tidak benar",
    "iot_tanpa_pasien": "alat yang jalan tanpa pasien terikat bisa dipakai kemudian untuk membenarkan tagihan pasien lain",
    "iot_integritas": "catatan alat yang berubah setelah dikunci, dikunci setelah klaim diajukan, atau ditandatangani kunci yang dicabut tidak dapat membuktikan pemakaian alat",
}
JENIS_MODUS = {"ganda": "Repeat billing (klaim berulang)", "kloning": "Cloning (penjiplakan klaim)", "tumpang": "Phantom billing (klaim palsu)",
               "kartu": "Phantom billing (klaim palsu)", "fiktif": "Phantom billing (klaim palsu)", "episode": "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)",
               "readmisi": "Readmisi (admisi berulang)", "jaringan": "Self-referral (rujukan semu)", "tagihan": "Inflated bills (penggelembungan tagihan)",
               "kelas": "Manipulasi kelas perawatan (room charge)", "koding": "Manipulasi diagnosis dan/atau tindakan (upcoding)", "los": "Prolonged length of stay",
               "ml": "Pola tidak lazim (perlu telaah)",
               "rme_kunjungan": "Phantom billing (klaim palsu)", "rme_pasien": "Phantom billing (klaim palsu)", "rme_ganda": "Repeat billing (klaim berulang)",
               "rme_jenis_rawat": "Manipulasi diagnosis dan/atau tindakan (upcoding)", "rme_tindakan": "Menagihkan tindakan yang tidak dilakukan",
               "rme_dx_dibantah": "Manipulasi diagnosis dan/atau tindakan (upcoding)", "rme_indikasi": "Tindakan pengobatan tidak sesuai indikasi medis",
               "rme_obat": "Klaim fiktif obat/alkes/tindakan", "rme_kelas": "Manipulasi kelas perawatan (room charge)", "rme_los": "Prolonged length of stay",
               "rme_episode": "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)", "rme_dx_hilang": "Manipulasi diagnosis dan/atau tindakan (upcoding)",
               "rme_rawat_inap": "Tindakan pengobatan tidak sesuai indikasi medis",
               "iot_vent": "Manipulasi diagnosis dan/atau tindakan (upcoding)", "rme_vent": "Manipulasi diagnosis dan/atau tindakan (upcoding)",
               "rme_icu": "Prolonged length of stay", "iot_mode": "Manipulasi diagnosis dan/atau tindakan (upcoding)",
               "iot_siaga": "Menagihkan tindakan yang tidak dilakukan",
               "iot_hd": "Menagihkan tindakan yang tidak dilakukan", "iot_icu": "Prolonged length of stay", "iot_jejak": "Menagihkan tindakan yang tidak dilakukan",
               "iot_binding": "Phantom billing (klaim palsu)", "iot_tanpa_pasien": "Pola tidak lazim (perlu telaah)", "iot_integritas": "Manipulasi hasil pemeriksaan"}
FAMILI_JENIS = {"koding": "koding", "tagihan": "tagihan", "episode": "episode", "identitas": "kartu", "jaringan": "jaringan"}
# the IoT layer (testing/iot_cabang.py): a current clamp on the device's power cable says when it ran, how long and in which state.
# A mismatch with the bill is a measurement, so it leads the explanation: its Permenkes mode, why it is a fraud sign, and (from the
# case's own iot block) the verifier's steps and the innocent explanation
IOT_KODE = {"vent_run_96": "M04", "vent_hours": "M04", "vent_standby": "M14", "no_device_trace": "M14", "hd_phantom": "M14",
            "binding_tumpang": "M11", "hd_short": "M07", "icu_days": "M07"}
IOT_ALASAN = {
    "vent_run_96": "ventilasi ≥ 96 jam berturut-turut dibayar jauh lebih mahal, padahal sensor clamp pada kabel daya ventilator mencatat alat itu tidak pernah jalan selama itu tanpa putus",
    "vent_hours": "jam ventilasi yang ditagih melebihi jam ventilator jalan menagih pelayanan yang tidak diberikan",
    "vent_standby": "ventilator yang hanya siaga tidak memberi napas, jadi ventilasi yang ditagih tidak pernah dilakukan",
    "no_device_trace": "pemakaian alat yang ditagih tanpa satu pun catatan alat, sementara jaringan RS online, berarti layanan itu kemungkinan tidak dilakukan",
    "hd_phantom": "mesin yang tidak menjalankan dialisis berarti sesi yang ditagih tidak dilakukan",
    "binding_tumpang": "satu alat hanya bisa dipakai satu pasien pada satu waktu, jadi pemakaian yang sama ditagih dua kali",
    "hd_short": "sesi dialisis yang dihentikan jauh sebelum waktu standar tetapi ditagih penuh membuat BPJS membayar pelayanan yang tidak diberikan",
    "icu_days": "hari ICU yang ditagih melebihi waktu monitor ICU menyala membuat BPJS membayar perawatan intensif yang tidak dijalani pasien",
}


def iot_teks(b: dict) -> str:
    """The IoT finding in plain words, with the case's numbers (billed, measured, the threshold, the tariff difference)."""
    a, d, t, tr = b["aturan"], b["ditagih"], b["terukur"], b["tarif"]
    mj = t.get("mode_jam") or {}
    siaga = mj.get("siaga", mj.get("standby", 0))  # an older block named the ventilator's standby "standby"
    j = lambda v: f"{des(v, 1).rstrip('0').rstrip(',')} jam"  # noqa: E731
    selisih = f"; selisih tarif {d['inacbg']} ke {tr['kode_seharusnya']} {rp(tr['selisih_rp'])}" if tr.get("selisih_rp") else ""
    jenis = "hemodialisis" if a.startswith("hd_") or d["prosedur"] == "39.95" else "monitor_icu" if a == "icu_days" or d["prosedur"] == "ICU" else "ventilator"
    alat = b.get("alat_utama") or ", ".join(x["id"] for x in b.get("alat") or [] if x.get("jenis") == jenis)
    if a == "vent_run_96":
        return (f"ventilator {alat} paling lama jalan {j(t['jam_berturut_maks'])} berturut-turut, padahal kode 96.72 yang ditagih ({j(d['jam'])}) butuh ≥ 96 jam "
                f"tanpa putus{selisih}")
    if a == "vent_standby":
        return f"ventilasi ({d['prosedur']}) ditagih {j(d['jam'])}, tetapi ventilator {alat} hanya siaga (standby) {j(siaga)} dan tidak pernah jalan memberi napas{selisih}"
    if a == "binding_tumpang":
        o = b.get("sesi_lain") or {}
        return (f"ventilasi {j(d['jam'])} ditagih memakai {o.get('device_id', 'ventilator')}, padahal pada jam yang sama alat itu terikat ke pasien {o.get('peserta', 'lain')}"
                f"{selisih}")
    if a == "hd_short":
        m = round(float(mj.get("jalan", 0)) * 60)
        return f"satu sesi hemodialisis penuh ditagih (standar 4 jam), tetapi mesin {alat} hanya berjalan {m // 60} jam {m % 60} menit{selisih.replace(d['inacbg'] + ' ke ' + tr['kode_seharusnya'], 'sesi')}"
    if a == "icu_days":
        return (f"{round(float(d['jam']) / 24)} hari ICU ditagih, tetapi monitor bed ICU {alat} hanya menyala {j(mj.get('nyala', 0))} ({t.get('hari', 0)} hari)"
                + (f"; selisih {rp(tr['selisih_rp'])}" if tr.get("selisih_rp") else ""))
    if a in ("no_device_trace", "hd_phantom"):
        return b["judul"][:1].lower() + b["judul"][1:] + (f"; seluruh tarif {rp(tr['selisih_rp'])} tidak didukung alat" if tr.get("selisih_rp") else "")
    return b["judul"][:1].lower() + b["judul"][1:] + selisih


def aturan_teks(nama: str, x4: dict, ctx: dict) -> tuple[str, str]:
    """A review rule that fired, with the claim's value and the rule's threshold; and its reason key."""
    a = ctx["aturan_v4"].get(nama)
    if a:
        v, amb = float(x4.get(a["fitur"], 0)), a["ambang"]
        teks = {
            "KLON_MIRIP": (f"{int(v)} klaim peserta lain di RS ini dengan kode, lama rawat dan tagihan hampir sama dalam ±3 hari (aturan menyala pada ≥ {amb:g})", "kloning"),
            "KLON_MIRIP_14H": (f"{int(v)} klaim peserta lain di RS ini dengan kode, lama rawat dan tagihan hampir sama dalam ±14 hari (aturan menyala pada ≥ {amb:g})", "kloning"),
            "KARTU_DI_RS_LAIN_HARI_SAMA": (f"kartu peserta ini tercatat di {int(v)} klaim RS lain pada hari yang sama (aturan menyala pada ≥ {amb:g})", "kartu"),
            "TOPUP_JAUH_DI_ATAS_KODE": (f"top-up {des(v, 1)}× top-up biasa (median) untuk kode ini (aturan menyala pada ≥ {des(amb, 1)}×)", "tagihan"),
            "DX_SEKUNDER_DI_ATAS_P90": (f"{int(v)} diagnosis sekunder lebih banyak dari batas 90% klaim dengan kode sama (aturan menyala pada ≥ {amb:g})", "koding"),
        }.get(nama)
        if teks:
            return teks
    if nama == "network rule":
        return (f"peserta ini berbagi RS dengan {ctx['xr3']} peserta lain dalam ±3 hari (aturan jaringan menyala pada ≥ {ctx['rj_ambang']:g})", "jaringan")
    t_awam = PJ.TEMUAN_AWAM.get(nama)
    if t_awam:
        return (kecil(t_awam) + " (sinyal spesifik yang hampir tidak pernah muncul pada klaim normal)", SINYAL_JENIS.get(nama, "ml"))
    return (nama.replace("_", " ").lower(), "ml")


def temuan_tanda(t: str, v: dict, f: dict) -> str:
    beda = abs(int(v["tgl"].replace("-", "")) - int(f["tgl"].replace("-", "")))
    if t == "sama_persis":
        bayar = f"tagihan sama {rp(v['biaya'])}" if v["biaya"] == f["biaya"] else f"tagihan {rp(v['biaya'])} vs {rp(f['biaya'])}"
        return (f"klaim lain milik peserta {f['peserta']} yang sama, di RS yang sama, dengan kode {f['kode']} dan tanggal masuk {tgl(f['tgl'])} yang sama "
                f"({bayar}) sudah diajukan lebih dulu" + (f" ({v['kasus']['id']})" if v.get("kasus") else ""))
    if t == "tumpang_tindih":
        return (f"peserta {f['peserta']} juga tercatat dirawat inap di {v['rs']} pada {tgl(v['tgl'])}–{tgl(v['pulang'])}, beririsan dengan rawat inap klaim ini "
                f"({tgl(f['tgl'])}–{tgl(f['pulang'])})")
    if t == "mirip_kloning":
        return (f"peserta lain ({v['peserta']}) di RS yang sama punya klaim {v['kode']} dengan lama rawat {v['los']} hari dan tagihan {rp(v['biaya'])} pada "
                f"{tgl(v['tgl'])}, hampir sama dengan klaim ini ({f['los']} hari, {rp(f['biaya'])})")
    if t == "readmisi_dekat":
        jeda = beda if v["pulang"] == v["tgl"] else abs(int(f["tgl"].replace("-", "")) - int(v["pulang"].replace("-", "")))
        return f"peserta {f['peserta']} baru pulang dari RS yang sama pada {tgl(v['pulang'])}, {jeda} hari sebelum klaim ini masuk"
    return f"kartu peserta {f['peserta']} juga dipakai di {v['rs']} pada {tgl(v['tgl'])}, {beda} hari dari klaim ini"


def tunjuk_tanda(t: str, v: dict, f: dict) -> str:
    """Where the tie sits in the claim network (GrafKlaim: a tie is a document ringed red, with a red dashed link to this claim)."""
    dok = "dokumen bercincin merah yang ditarik garis putus-putus merah dari klaim ini"
    if t in ("sama_persis", "readmisi_dekat"):
        return f"klaim itu adalah {dok}; keduanya terhubung ke lingkaran peserta {f['peserta']} dan kotak RS yang sama"
    if t == "mirip_kloning":
        return f"klaim itu adalah {dok}; ia terhubung ke kotak RS yang sama tetapi ke lingkaran peserta lain ({v['peserta']})"
    return f"klaim itu adalah {dok}; ia terhubung ke lingkaran peserta {f['peserta']} yang sama tetapi ke kotak RS lain ({v['rs']})"


def blok(asli: str) -> str:
    return "tetangga graph" if asli.startswith("tetangga") else "mekanisme fraud" if asli.startswith("v4:") else "klaim sendiri"


def temuan_angka(f: dict, x4: dict, ref: dict, sudah: set[str]) -> list[tuple[str, str]]:
    """The claim's own figures against its code's medians, when they stand out (and no rule already said so)."""
    out = []
    tr = float(x4.get("v4: topup_rasio_median_kode", 0))
    if "tagihan" not in sudah and tr >= 2 and f.get("topup"):
        out.append((f"top-up {rp(f['topup'])}, {des(tr, 1)}× top-up biasa untuk kode ini", "tagihan"))
    br = float(x4.get("v4: biaya_rasio_median_kode", 0))
    if "tagihan" not in sudah and br >= 1.5:
        out.append((f"tagihan {rp(f['biaya'])}, {des(br, 1)}× tagihan biasa (median) untuk kode ini", "tagihan"))
    lm = ref.get("los_median")
    if f["tingkat"] == "RITL" and lm and "los" not in sudah:
        if f["los"] >= 2 * max(1, lm):
            out.append((f"lama rawat {f['los']} hari, padahal biasanya {lm:g} hari untuk kode ini", "los"))
        elif float(x4.get("v4: los_di_bawah_p10", 0)) >= 1 and lm >= 3:
            out.append((f"lama rawat hanya {f['los']} hari, padahal biasanya {lm:g} hari untuk kode ini", "los"))
    dx = float(x4.get("v4: dx_sekunder_di_atas_p90", 0))
    if "koding" not in sudah and dx >= 1:
        out.append((f"{int(dx)} diagnosis sekunder lebih banyak dari batas 90% klaim dengan kode sama", "koding"))
    return out


# Permenkes 16/2019 mode per kind of evidence (a signal finding takes the engine's own mapping, aip.realtime.modus)
JENIS_KODE = {"ganda": "M11", "kloning": "M05", "tumpang": "M06", "kartu": "M06", "fiktif": "M06", "episode": "M08", "readmisi": "M16",
              "jaringan": "M10", "tagihan": "M07", "kelas": "M13", "koding": "M04", "los": "M12", "ml": "-",
              "rme_kunjungan": "M06", "rme_pasien": "M06", "rme_ganda": "M11", "rme_jenis_rawat": "M04", "rme_tindakan": "M14", "rme_dx_dibantah": "M04",
              "rme_indikasi": "M15", "rme_obat": "M17", "rme_kelas": "M13", "rme_los": "M12", "rme_episode": "M08", "rme_dx_hilang": "M04", "rme_rawat_inap": "M15",
              "iot_vent": "M04", "rme_vent": "M04", "rme_icu": "M12", "iot_siaga": "M14", "iot_mode": "M04", "iot_hd": "M14", "iot_icu": "M12", "iot_jejak": "M14", "iot_binding": "M06", "iot_tanpa_pasien": "-",
              "iot_integritas": "M20"}
# what the verifier does, per kind ({lain} = the other claim's case id or a description, {tgl} = this claim's date)
LANGKAH = {
    "ganda": ["Minta berkas {lain} dan klaim ini, lalu cocokkan identitas peserta, tanggal masuk, tanggal pulang, kode layanan dan rincian tagihan.",
              "Periksa rekam medis: apakah ada dua kunjungan berbeda pada {tgl}, atau satu kunjungan yang ditagih dua kali.",
              "Bila terbukti ganda, batalkan salah satu klaim dan ajukan pengembalian kelebihan bayar."],
    "kloning": ["Bandingkan resume medis klaim ini dengan {lain}: diagnosis, tindakan, lama rawat dan rincian tagihan.",
                "Pastikan kedua pasien benar dirawat (SEP, catatan perawat, tanda tangan pasien).",
                "Bila isi berkas hasil salinan, tolak klaim dan laporkan ke tim pencegahan kecurangan."],
    "tumpang": ["Minta SEP dan catatan rawat inap dari kedua RS untuk tanggal yang beririsan.", "Cocokkan identitas pasien (NIK, foto, tanda tangan) di kedua berkas.",
                "Bila satu klaim memakai kartu orang lain atau pelayanannya tidak terjadi, tolak klaim itu."],
    "kartu": ["Minta SEP dan bukti identitas pasien dari kedua RS.", "Pastikan orang yang dilayani adalah pemilik kartu (NIK, foto, sidik jari bila ada).",
              "Bila kartu dipakai orang lain, tolak klaim dan laporkan."],
    "fiktif": ["Cek tanggal meninggal peserta di registri kependudukan.", "Minta bukti pelayanan (SEP, tanda tangan, catatan medis).",
               "Bila pelayanan tidak terjadi, tolak klaim dan laporkan."],
    "episode": ["Minta resume medis semua klaim peserta ini di sekitar {tgl}.", "Pastikan apakah klaim-klaim itu satu episode perawatan yang dipecah.",
                "Bila satu episode, gabungkan menjadi satu klaim dan koreksi pembayarannya."],
    "readmisi": ["Minta resume pulang episode sebelumnya dan alasan pasien masuk kembali.", "Periksa apakah pasien dipulangkan terlalu cepat atau masih satu episode.",
                 "Bila masih satu episode, klaim kedua dibayar sebagai lanjutan, bukan episode baru."],
    "jaringan": ["Lihat daftar peserta bersama di bagian jaringan RS pada graph.", "Periksa surat rujukan dan alasan pasien pindah RS.",
                 "Bila pola rujukan diatur, laporkan ke tim pencegahan kecurangan untuk audit RS."],
    "tagihan": ["Minta rincian tagihan dan bukti pemakaian obat/alat (untuk top-up).", "Bandingkan dengan tarif INA-CBG dan tagihan biasa untuk kode ini.",
                "Koreksi bagian tagihan yang tidak didukung bukti."],
    "kelas": ["Cek hak kelas peserta dan surat pernyataan naik kelas.", "Koreksi selisih tarif bila kelas rawat di atas hak tanpa dasar."],
    "koding": ["Minta resume medis dan hasil penunjang untuk setiap diagnosis sekunder.", "Periksa apakah diagnosis dan tingkat keparahan didukung bukti klinis.",
               "Bila tidak didukung, turunkan kode atau keparahan dan koreksi tarifnya."],
    "los": ["Minta catatan perkembangan pasien (CPPT) selama dirawat.", "Periksa apakah lama rawat sesuai kondisi klinis.", "Koreksi klaim bila lama rawat tidak didukung."],
    "ml": ["Buka klaim pembanding di graph, terutama yang ditahan atau diperiksa.", "Minta resume medis dan rincian tagihan klaim ini.",
           "Putuskan berdasarkan dokumen; skor sistem hanya penanda, bukan bukti."],
    # medical-record findings: the documents that settle what the record and the claim disagree on
    "rme_kunjungan": ["Minta SEP, bukti kehadiran pasien (sidik jari atau foto wajah) dan catatan pendaftaran rumah sakit untuk {tgl}.",
                      "Minta rumah sakit mengirim ulang rekam medis kunjungan itu, untuk memastikan catatannya memang tidak ada dan bukan belum terkirim.",
                      "Bila kunjungan tidak pernah terjadi, tolak klaim dan laporkan ke tim pencegahan kecurangan."],
    "rme_pasien": ["Minta identitas pasien di rekam medis (NIK, tanggal lahir, jenis kelamin) dan SEP yang diverifikasi sidik jari atau wajah.",
                   "Cocokkan dengan data pemilik kartu di kepesertaan.", "Bila yang dilayani orang lain, tolak klaim dan laporkan penyalahgunaan kartu."],
    "rme_ganda": ["Minta berkas {lain} dan klaim ini, lalu cocokkan keduanya dengan kunjungan yang sama di rekam medis.",
                  "Pastikan apakah ada dua kunjungan berbeda atau satu kunjungan yang ditagih dua kali.",
                  "Bila satu kunjungan, batalkan klaim yang kedua dan ajukan pengembalian kelebihan bayar."],
    "rme_jenis_rawat": ["Minta catatan IGD atau poli, surat perintah rawat inap dan catatan perawat harian sejak {tgl}.",
                        "Pastikan pasien benar dirawat inap (ada lembar observasi dan catatan dokter setiap hari), bukan hanya rawat jalan atau IGD.",
                        "Bila hanya rawat jalan, koreksi klaim ke tarif rawat jalan."],
    "rme_tindakan": ["Minta laporan tindakan yang ditandatangani dokter pelaksana, jadwal ruang tindakan atau kamar operasi, dan bahan habis pakai yang dipakai.",
                     "Minta lembar observasi selama dirawat, lalu cocokkan dengan rekam medis elektronik yang dikirim rumah sakit.",
                     "Bila tindakan tidak terbukti dilakukan, koreksi ke paket tanpa tindakan itu dan ajukan pengembalian kelebihan bayar."],
    "rme_dx_dibantah": ["Minta resume medis dan hasil pemeriksaan (laboratorium, tanda vital, pencitraan) yang menegakkan diagnosis yang ditagih.",
                        "Minta lembar observasi sepanjang rawat dan bandingkan dengan hasil pemeriksaan di rekam medis.",
                        "Bila diagnosis tidak didukung, hapus diagnosis itu, turunkan keparahan dan koreksi tarifnya."],
    "rme_indikasi": ["Minta dasar keputusan tindakan: hasil EKG, laboratorium atau pencitraan sebelum tindakan dan catatan dokter yang memutuskannya.",
                     "Minta laporan tindakan dan lembar observasi selama dirawat.",
                     "Bila alasan medis tidak ada, minta telaah tim kendali mutu dan kendali biaya (TKMKB) sebelum klaim dikoreksi atau ditolak."],
    "rme_obat": ["Minta resep, catatan pemberian obat oleh perawat, dan nomor seri atau stiker alat yang dipasang.",
                 "Cocokkan dengan faktur pembelian dan catatan obat di rekam medis.", "Koreksi biaya obat atau alat yang tidak terbukti diberikan."],
    "rme_kelas": ["Cek hak kelas peserta, kelas kamar yang tercatat di rekam medis, dan surat pernyataan naik kelas bila ada.",
                  "Pastikan kamar yang ditempati sesuai kelas yang ditagih.", "Bila tidak ada dasar, koreksi tarif ke kelas yang tercatat."],
    "rme_los": ["Minta resume medis, catatan perkembangan pasien (CPPT) dan lembar observasi sampai hari pulang.",
                "Cocokkan tanggal pulang di klaim dengan tanggal pulang atau tanggal boleh pulang di rekam medis.",
                "Koreksi lama rawat ke yang tercatat dan hitung ulang tarifnya."],
    "rme_episode": ["Minta rekam medis seluruh rawat inap itu, dari tanggal masuk sampai tanggal pulang yang sebenarnya.",
                    "Cari klaim lain peserta ini di rumah sakit yang sama pada rentang tanggal itu.",
                    "Bila satu episode, gabungkan menjadi satu klaim dan koreksi pembayarannya."],
    "rme_dx_hilang": ["Minta resume medis dan daftar diagnosis yang ditulis dokter yang merawat.",
                      "Minta hasil pemeriksaan yang mendukung setiap diagnosis yang ditagih.",
                      "Bila diagnosis tidak tercatat dan tidak didukung, hapus dari klaim dan koreksi keparahan serta tarifnya."],
    "rme_rawat_inap": ["Minta catatan IGD atau poli saat masuk, alasan dokter merawat inap, dan lembar observasi harian.",
                       "Bandingkan dengan kriteria rawat inap di pedoman verifikasi klaim.",
                       "Temuan ini perlu telaah medis, bukan bukti sendiri: bila alasan rawat inap tidak ada, koreksi klaim ke rawat jalan."],
    # the device evidence: the documents and device records that settle what the bill and the device disagree on
    "rme_vent": ["Minta lembar observasi ventilator (jam pasang dan jam lepas) dan catatan tindakan ventilasi di rekam medis.",
                 "Cocokkan lama ventilasi berturut-turut di rekam medis dengan kode yang ditagih (96.72 = 96 jam atau lebih, 96.71 = kurang dari 96 jam).",
                 "Bila kurang dari 96 jam berturut-turut, koreksi ke 96.71 dan hitung ulang tarifnya."],
    "rme_icu": ["Minta catatan pindah ruang (masuk dan keluar ICU) dari rekam medis.",
                "Cocokkan jumlah hari di ICU menurut rekam medis dengan hari ICU yang ditagih.",
                "Koreksi hari ICU ke yang tercatat di rekam medis."],
    "iot_vent": ["Minta lembar observasi ventilator (jam pasang, jam lepas, setelan tiap shift) dan log ventilator untuk seluruh masa ventilasi.",
                 "Cocokkan jam ventilasi di E-Klaim dengan sesi alat: 96.72 hanya sah bila ventilator jalan 96 jam atau lebih tanpa putus; di bawah itu 96.71.",
                 "Bila tidak didukung, koreksi prosedur ke 96.71, hitung ulang tarif paketnya dan tagih kembali selisihnya."],
    "iot_siaga": ["Minta lembar observasi ventilator (jam pasang, jam lepas, setelan tiap shift) dan log ventilator.",
                  "Sensor clamp mencatat ventilator hanya siaga: menyala tanpa memberi napas; pastikan ventilasi benar dilakukan.",
                  "Bila ventilasi tidak dilakukan, koreksi klaim ke kode tanpa ventilasi mekanik dan hitung ulang tarifnya."],
    "iot_mode": ["Minta log mode ventilator yang diunduh dari alat itu sendiri dan lembar observasi tiap shift.",
                 "Bandingkan mode yang ditagih dengan mode yang dilaporkan ventilator (bukan sensor clamp).",
                 "Bila mode yang ditagih tidak didukung, koreksi kode ventilasi dan hitung ulang tarifnya."],
    "iot_hd": ["Minta lembar tindakan hemodialisis tiap sesi (jam mulai, jam selesai, alasan berhenti, paraf perawat).",
               "Cocokkan jumlah dan lama sesi yang ditagih dengan sesi mesin dialisis: sesi di bawah 3 jam bukan sesi penuh.",
               "Bila sesi tidak terjadi atau dihentikan tanpa alasan klinis tercatat, koreksi pembayaran sesi itu."],
    "iot_icu": ["Minta catatan pindah ruang (masuk dan keluar ICU) dan lembar observasi ICU harian.",
                "Cocokkan hari ICU di E-Klaim dengan jam bed/monitor ICU pasien ini menyala.",
                "Koreksi hari ICU ke yang tercatat dan hitung ulang tagihannya."],
    "iot_jejak": ["Tanyakan ke RS alat mana yang dipakai (nomor alat) dan minta catatan pemakaiannya untuk tanggal layanan.",
                  "Minta log gateway IoT RS pada tanggal itu untuk memastikan gateway online dan alat itu bersensor.",
                  "Bila pemakaian alat tidak terbukti, tolak bagian tagihan pemakaian alat itu."],
    "iot_binding": ["Minta catatan serah terima alat (jam lepas dari pasien pertama, jam pasang ke pasien kedua) dan jadwal ruang ICU.",
                    "Pastikan pasien mana yang benar memakai alat pada jam yang beririsan.",
                    "Koreksi tagihan pasien yang tidak memakai alat itu pada jam tersebut."],
    "iot_tanpa_pasien": ["Minta RS menjelaskan pemakaian alat pada jam tanpa pasien terikat (uji alat, pembersihan, atau pasien yang lupa diikat).",
                         "Periksa apakah ada klaim pasien lain di RS ini yang menagih alat itu pada jam yang sama.",
                         "Catat sebagai temuan tingkat faskes untuk perbaikan pencatatan, bukan tuduhan atas klaim ini."],
    "iot_integritas": ["Minta RS mengirim ulang sesi alat, log gateway dan jangkar bukti langsung dari sistemnya.",
                       "Hitung ulang akar Merkle dari sesi yang dikirim dan bandingkan dengan jangkar di ledger; periksa waktu jangkar dan status kunci perangkat.",
                       "Bukti yang tidak cocok tidak dipakai: putuskan dari dokumen klinis, dan laporkan perubahan data ke tim pencegahan kecurangan."],
}
CATATAN = {
    "ganda": "Klaim ini bisa wajar bila memang ada dua kunjungan berbeda pada hari yang sama (mis. kontrol pagi dan gawat darurat malam) atau ada salah entri tanggal.",
    "kloning": "Bisa wajar untuk layanan yang memang seragam di satu RS (mis. paket persalinan normal atau operasi katarak).",
    "tumpang": "Bisa wajar bila pasien dirujuk antar-RS dan tanggal pulang di salah satu klaim salah tulis.",
    "kartu": "Bisa wajar bila pasien memang dirujuk ke RS lain pada hari yang sama.",
    "fiktif": "Bisa wajar bila tanggal meninggal di registri keliru.",
    "episode": "Bisa wajar bila pasien memang datang dua kali untuk masalah yang berbeda.",
    "readmisi": "Bisa wajar bila ada komplikasi baru atau kontrol yang sudah direncanakan.",
    "jaringan": "Bisa wajar di wilayah dengan sedikit RS rujukan, tempat banyak pasien memang berpindah ke RS yang sama.",
    "tagihan": "Bisa wajar untuk kasus berat atau obat/alat khusus yang memang dipakai.",
    "kelas": "Bisa wajar bila peserta menandatangani pernyataan naik kelas atas biaya sendiri.",
    "koding": "Bisa wajar untuk pasien dengan banyak penyakit penyerta yang tercatat di rekam medis.",
    "los": "Bisa wajar bila kondisi klinis pasien memang memerlukannya.",
    "ml": "Sistem bisa keliru pada pola yang jarang; keputusan tetap pada verifikator berdasarkan dokumen.",
    "rme_kunjungan": "Bisa wajar bila rumah sakit belum mengirim seluruh rekam medis kunjungan itu atau tanggal kunjungannya salah tulis.",
    "rme_pasien": "Bisa wajar bila tanggal lahir atau jenis kelamin di rekam medis salah ketik.",
    "rme_ganda": "Bisa wajar bila ada dua kunjungan berbeda pada hari yang sama tetapi rumah sakit mengirim rekam medis yang sama untuk keduanya.",
    "rme_jenis_rawat": "Bisa wajar bila pasien dari IGD lalu dirawat inap tetapi perpindahannya belum tercatat di rekam medis elektronik.",
    "rme_tindakan": "Bisa wajar bila laporan tindakan belum dikirim ke rekam medis elektronik; laporan tindakan yang ditandatangani dokter menyelesaikannya.",
    "rme_dx_dibantah": "Bisa wajar bila pasien sudah mendapat pengobatan (mis. oksigen) sehingga hasil pemeriksaannya tampak normal.",
    "rme_indikasi": "Bisa wajar untuk tindakan terencana yang alasan medisnya tercatat di kunjungan sebelumnya.",
    "rme_obat": "Bisa wajar bila catatan pemberian obat atau nomor seri alat belum dikirim ke rekam medis elektronik.",
    "rme_kelas": "Bisa wajar bila pasien pindah kamar atau naik kelas atas permintaan sendiri dan membayar selisihnya.",
    "rme_los": "Bisa wajar bila tanggal pulang di rekam medis belum diperbarui atau pasien masih menunggu rujukan.",
    "rme_episode": "Bisa wajar bila pasien memang pulang lalu masuk lagi untuk masalah lain dan tanggalnya salah tercatat.",
    "rme_dx_hilang": "Bisa wajar bila dokter menulis diagnosis di catatan kertas yang belum masuk rekam medis elektronik.",
    "rme_rawat_inap": "Keputusan rawat inap juga bergantung pada penilaian dokter (mis. pasien perlu diamati); temuan ini perlu telaah medis, bukan bukti.",
    "rme_vent": "Bisa wajar bila pencatatan ventilasi di rekam medis tidak lengkap (mis. hanya waktu tindakan, bukan lamanya); minta lembar observasi.",
    "rme_icu": "Bisa wajar bila catatan pindah ruang belum lengkap di rekam medis; minta catatan ruang rawat.",
    "iot_vent": "Bisa wajar bila sensor atau gateway sempat mati, atau pasien dipindah ke ventilator lain yang belum bersensor; minta bukti alat itu.",
    "iot_siaga": "Status jalan/siaga dibaca dari pola arus listrik, jadi perlu dikonfirmasi lembar observasi; bisa wajar bila ventilator lain yang belum bersensor yang dipakai.",
    "iot_mode": "Bisa wajar bila pasien dipindah ke ventilator lain yang belum terhubung; minta log alat itu.",
    "iot_hd": "Bisa wajar bila sesi dihentikan karena alasan klinis (hipotensi, masalah akses) yang tercatat, atau mesin cadangan tanpa sensor dipakai.",
    "iot_icu": "Bisa wajar bila monitor dimatikan atau sensor terlepas saat pasien masih di ICU, atau pasien dipindah ke bed ICU yang belum bersensor.",
    "iot_jejak": "Bisa wajar bila alat yang dipakai belum terpasang sensor atau gateway sedang mati; minta bukti alat itu.",
    "iot_binding": "Bisa wajar pada serah terima alat yang singkat atau salah pilih alat saat mengikat pasien; jadwal ruang dan catatan serah terima menunjukkan yang benar.",
    "iot_tanpa_pasien": "Bisa wajar saat alat diuji, dibersihkan, atau dipakai sebelum pasien sempat diikat ke alat di sistem.",
    "iot_integritas": "Bisa wajar bila gateway offline lalu mengirim data tertunda, atau kunci perangkat diganti saat alat diservis; minta penjelasan teknis RS.",
}


# why a finding is a fraud sign, by its Permenkes code (a signal's own mode can differ from its kind; e.g. a rare code-diagnosis pair is M15)
ALASAN_M = {
    "M04": ALASAN["koding"], "M05": ALASAN["kloning"], "M07": ALASAN["tagihan"], "M08": ALASAN["episode"],
    "M09": "satu perawatan yang dipecah menjadi beberapa tagihan terpisah dibayar lebih mahal daripada satu paket",
    "M10": ALASAN["jaringan"], "M11": ALASAN["ganda"], "M12": ALASAN["los"], "M13": ALASAN["kelas"],
    "M14": "tindakan yang ditagih tanpa bukti dilakukan menaikkan tarif paket tanpa pelayanan yang sebenarnya",
    "M15": "kode paket yang hampir tidak pernah dipakai untuk diagnosis seperti ini bisa berarti tindakan yang ditagih tidak sesuai kebutuhan medis pasien",
    "M16": ALASAN["readmisi"],
    "M17": "obat atau alat khusus yang hampir tidak pernah dipakai untuk kasus seperti ini bisa jadi ditagih tanpa benar-benar diberikan",
    "M18": "obat yang diserahkan kurang dari yang ditagih membuat BPJS membayar obat yang tidak diterima pasien",
    "M20": "hasil pemeriksaan yang tidak cocok dengan alatnya bisa berarti hasil diubah untuk membenarkan tagihan",
}
# the swarm's terse notes in plain words
_ISTILAH = [(r"\bLOS\b", r"lama rawat"), (r"\bstream ?", r""), (r"\bp100\b", r"persis sama"), (r"\bp50\b", r"di tengah"), (r"\bp(\d{2})\b", r"peringkat \1%"), (r"\bdx\b", r"diagnosis"), (r"\bsev(?:erity)? ?III\b", r"keparahan berat"), (r"\bRITL\b", r"rawat inap"), (r"\bRJTL\b", r"rawat jalan")]


def awam(t: str) -> str:
    for a, b in _ISTILAH:
        t = re.sub(a, b, t, flags=re.I)
    return " ".join(t.split())


def kecil(t: str) -> str:
    """First letter lower-case, unless the first word is an acronym (LOS, RS, INA-CBG)."""
    return t if len(t) > 1 and t[1].isupper() else t[:1].lower() + t[1:]


def besar(t: str) -> str:
    return t[:1].upper() + t[1:]


def modus_dari(t: dict) -> tuple[str, str]:
    """(code, name) of a finding's Permenkes 16/2019 mode: an engine signal by the engine's own mapping, else by its kind."""
    daftar = PJ.modus_daftar()
    if t.get("iot"):
        k = IOT_KODE.get(t["iot"]["aturan"], "M07")
        return k, daftar.get(k, "Pola tidak lazim (perlu telaah)")
    if t.get("sinyal"):
        _, sigs = PJ._modes()
        for m in (sigs.get(t["sinyal"]) or [[]])[0]:
            m = "M07" if m == "M19" else m
            if m in daftar:
                return m, daftar[m]
    k = JENIS_KODE.get(t["jenis"], "-")
    return k, daftar.get(k, "Pola tidak lazim (perlu telaah)")


def banding(nilai: float, biasa: float, teks_biasa: str, kata: tuple[str, str] = ("di atas", "di bawah")) -> str:
    """A figure against the usual one for the code, in words: about the same, x% above/below, or n times."""
    if not biasa:
        return ""
    r = nilai / biasa
    if 0.9 <= r <= 1.1:
        return f"sekitar sama dengan biasanya untuk kode ini ({teks_biasa})"
    if r >= 2:
        return f"{des(r, 1)}× biasanya untuk kode ini ({teks_biasa})"
    if r <= 0.5:
        return f"jauh {kata[1]} biasanya untuk kode ini ({teks_biasa})"
    return f"{abs(round(100 * (r - 1)))}% {kata[0] if r > 1 else kata[1]} biasanya untuk kode ini ({teks_biasa})"


# ---- medical-record findings in plain words, with the numbers of the evidence the engine's signal carries (rme.periksa writes
# it; e.g. "Klaim menagih 4 tindakan yang tidak ada di rekam medis kunjungan IMP 2024-12-20 s.d. 2024-12-23: ... (37.23): tidak ada
# Procedure ..."). Codes, record-format words and ISO dates stay out of the executive text; the raw evidence goes to the trail.
_ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_T = r"(\d{4}-\d{2}-\d{2})"
KELAS_KUNJUNGAN = {"AMB": "rawat jalan", "EMER": "gawat darurat (IGD)", "IMP": "rawat inap", "ACUTE": "rawat inap", "NONAC": "rawat inap",
                   "SS": "rawat sehari", "OBSENC": "observasi", "VR": "kunjungan jarak jauh", "HH": "kunjungan rumah", "PRENC": "pra-kunjungan"}
JK = {"L": "laki-laki", "P": "perempuan", "male": "laki-laki", "female": "perempuan"}
KATA_KEPARAHAN = {"II": "sedang", "III": "berat"}
_RME_ISTILAH = [(r"\s*\((?:\d{2}\.\d{1,2}|[A-Z]\d{2}(?:\.\d{1,4})?)\)", ""), (r"\bx/menit\b", "kali/menit"), (r"\bEncounter(?:\.location)?\b", "kunjungan"),
                (r"\bProcedure(?:-nya)?\b", "laporan tindakan"), (r"\bServiceRequest\b", "permintaan tindakan"), (r"\bCondition\b", "diagnosis"),
                (r"\bMedication\w*(?:/\w+)*", "catatan obat"), (r"\bspecial CMG\b", "khusus"), (r"\bclassHistory\b", "riwayat kunjungan"),
                (r"\b(" + "|".join(KELAS_KUNJUNGAN) + r")\b(?= \d)", lambda m: KELAS_KUNJUNGAN[m.group(1)])]
_UKUR = re.compile(r"(?P<lab>[A-Za-z][\w/ ]*?) (?P<v>\d+(?:,\d+)?(?:–\d+(?:,\d+)?)?) ?(?P<u>[^\s(;]*) \((?P<n>\d+) pengukuran, (?P<st>[^)]*)\)")
_BENTUK = re.compile(r"(?P<lab>EKG|ekokardiografi) (?P<n>\d+) kali, (?P<st>semua normal|\d+ abnormal)")
URUT_UKUR = ("tekanan darah", "saturasi oksigen", "troponin", "EKG", "ekokardiografi", "denyut nadi", "frekuensi napas")


def tgl_r(a: str, b: str | None = None) -> str:
    """A date span in words: '20–23 Des 2024', '28 Des 2024–2 Jan 2025', or one date."""
    if not b or b[:10] == a[:10]:
        return tgl(a)
    (ya, ma, da), (yb, mb, db) = a[:10].split("-"), b[:10].split("-")
    if (ya, ma) == (yb, mb):
        return f"{int(da)}–{int(db)} {BULAN[int(mb) - 1]} {yb}"
    return f"{int(da)} {BULAN[int(ma) - 1]}–{tgl(b)}" if ya == yb else f"{tgl(a)}–{tgl(b)}"


def daftar(xs: list[str]) -> str:
    """'a', 'a dan b', 'a, b dan c'."""
    xs = [x for x in xs if x]
    if len(xs) <= 1:
        return "".join(xs)
    return ", ".join(xs[:-1]) + " dan " + xs[-1]


def rapi_rme(t: str) -> str:
    """What is left of a record's evidence after the parsers, in plain words: no codes in brackets, record-format words or ISO dates."""
    t = _ISO.sub(lambda m: tgl(m.group(0)), t)
    for a, b in _RME_ISTILAH:
        t = re.sub(a, b, t)
    return " ".join(t.split())


def keparahan(kode: str) -> str:
    s = str(kode or "").rsplit("-", 1)[-1]
    return s if s in ("I", "II", "III") else ""


def _rme_modul() -> Any:
    """The engine's clinical knowledge (procedure groups, measurable diagnoses), for their plain names; None outside the repo."""
    try:
        from aip.realtime import rme as R

        return R
    except ImportError:
        return None


def ukur_awam(fakta: str, maks: int = 4) -> tuple[str, bool, int]:
    """Measurements as rme._Ukur.ringkas writes them ('tekanan darah sistolik 109–122 mmHg (8 pengukuran, semua normal); ...') in a
    short plain list: ('tekanan darah 109–122/67–82 mmHg, saturasi oksigen 97–100% dan EKG normal', all normal, most measurements)."""
    xs: list[dict] = []
    for part in fakta.split("; "):
        m = _BENTUK.search(part)
        if m:
            ok = m["st"] == "semua normal"
            xs.append({"lab": m["lab"], "teks": f"{m['lab']} " + ("normal" if ok else m["st"].replace(" abnormal", " kali abnormal")), "n": int(m["n"]), "normal": ok})
            continue
        m = _UKUR.search(part)
        if m:
            xs.append({"lab": m["lab"].strip(), "v": m["v"], "u": m["u"].replace("x/menit", "kali/menit"), "n": int(m["n"]), "normal": m["st"] == "semua normal"})
    sis = next((x for x in xs if x["lab"] == "tekanan darah sistolik" and "v" in x), None)
    dia = next((x for x in xs if x["lab"] == "tekanan darah diastolik" and "v" in x), None)
    if sis and dia:  # one blood pressure, as a doctor writes it
        xs = [{"lab": "tekanan darah", "v": f"{sis['v']}/{dia['v']}", "u": "mmHg", "n": max(sis["n"], dia["n"]), "normal": sis["normal"] and dia["normal"]}] + \
             [x for x in xs if x is not sis and x is not dia]
    for x in xs:
        if "teks" not in x:
            x["teks"] = f"{x['lab']} {x['v']}{'' if x['u'] in ('%', '°C') else ' '}{x['u']}".rstrip()
    xs.sort(key=lambda x: next((i for i, p in enumerate(URUT_UKUR) if x["lab"].startswith(p)), len(URUT_UKUR)))
    return daftar([x["teks"] for x in xs[:maks]]), bool(xs) and all(x["normal"] for x in xs), max((x["n"] for x in xs), default=0)


def _kali_ukur(n: int, ritl: bool) -> str:
    return f" dalam {n} kali pengukuran" + (" sepanjang rawat" if ritl else "") if n >= 2 else ""


def nama_tindakan(nama: str) -> str:
    """A procedure group's name without its second wording ('kateterisasi jantung / angiografi koroner' -> 'kateterisasi jantung'),
    unless that leaves one word ('operasi / penggantian katup jantung' stays) or the alternative is in brackets."""
    depan = re.split(r" / (?![^(]*\))", nama, maxsplit=1)[0]
    return depan if " " in depan else nama


def _rme_kunjungan(b: str, f: dict, c: dict) -> str | None:
    m = re.search(rf"menagih (rawat inap|rawat jalan) {_T}(?: s\.d\. {_T})?", b)
    if not m:
        return None
    ada = re.search(r"kunjungan yang tercatat: (.*)\)\.?\s*$", b)
    lain = [f"{KELAS_KUNJUNGAN.get(k[1], 'kunjungan')} {tgl_r(k[2], k[3])}" for x in (ada[1].split(", ") if ada else [])
            for k in [re.match(rf"(\S+) {_T}(?: s\.d\. {_T})?$", x.strip())] if k]
    t = f"klaim menagih {m[1]} {tgl_r(m[2], m[3])}, tetapi rekam medis rumah sakit tidak mencatat kunjungan apa pun pada tanggal itu"
    return t + (f" (yang tercatat hanya {daftar(lain[:3])})" if lain else " (tidak ada satu kunjungan pun yang tercatat)" if "tidak ada kunjungan" in b else "")


def _rme_pasien(b: str, f: dict, c: dict) -> str | None:
    why = []
    m = re.search(r"jenis kelamin di rekam medis (\S+), di kepesertaan (\S+?)[;.]", b)
    if m:
        why.append(f"rekam medis mencatat pasien {JK.get(m[1], m[1])}, sedangkan pemilik kartu {JK.get(m[2], m[2])}")
    m = re.search(r"tanggal lahir berbeda (\d+) tahun", b)
    if m:
        why.append(f"tanggal lahirnya berselisih {m[1]} tahun")
    return ("pasien di rekam medis tampaknya bukan pemilik kartu (" + "; ".join(why) + ")") if why else None


def _rme_ganda(b: str, f: dict, c: dict) -> str | None:
    m = re.search(rf"Kunjungan rekam medis (\S*) ?{_T}(?: s\.d\. {_T})? sudah menjadi dasar klaim lain \(([^,)]*)(?:, ([^)]*))?\)", b)
    if not m:
        return None
    jenis = KELAS_KUNJUNGAN.get(m[1], "")
    t = f"kunjungan {jenis + ' ' if jenis else ''}{tgl_r(m[2], m[3])} di rekam medis sudah menjadi dasar klaim lain"
    return t + (f" (masuk {tgl(m[5].strip())})" if m[5] and _ISO.match(m[5].strip()) else "") + ", jadi satu kunjungan ditagih dua kali"


def _rme_jenis_rawat(b: str, f: dict, c: dict) -> str | None:
    m = re.search(rf"rawat inap {_T} s\.d\. {_T} \((\d+) hari\), tetapi rekam medis mencatat kunjungan (gawat darurat|rawat jalan) \((\S*) ?{_T}", b)
    if not m:
        return None
    jenis = "gawat darurat (IGD)" if m[4] == "gawat darurat" else "rawat jalan"
    return f"klaim ditagih sebagai rawat inap {m[3]} hari ({tgl_r(m[1], m[2])}), tetapi rekam medis hanya mencatat kunjungan {jenis} pada {tgl(m[6])}, tanpa rawat inap"


def _rme_tindakan(b: str, f: dict, c: dict) -> str | None:
    item = re.findall(r"([^:;]+?) \((\d{2}(?:\.\d{1,2})?)\): (tidak ada Procedure[^;]*|rekam medis mencatat[^;]*|hanya ada permintaan[^;]*)", b)
    if not item:
        return None
    R = _rme_modul()
    berat, ringan = [], []
    for label, kode, _ in item:
        k = kode.replace(".", "")
        g = R.grup_tindakan(k) if R else None
        nama = nama_tindakan(R.TINDAKAN_KLINIS[g]["nama"]) if g else label.strip()
        sisi = berat if (not R or R.bermakna(k)) else ringan
        if nama not in sisi:
            sisi.append(nama)
    t = f"tindakan {daftar((berat or ringan)[:3])} ditagih tetapi tidak tercatat di rekam medis rumah sakit"
    if any("TIDAK JADI" in x[2] for x in item):
        t += ", bahkan tercatat tidak jadi dilakukan"
    elif any(x[2].startswith("hanya ada permintaan") for x in item):
        t += "; yang ada hanya permintaan tindakan, tanpa laporan bahwa tindakan itu selesai"
    if "tercatat di rekam medis: tidak ada" in b:
        t += " (rekam medis kunjungan itu tidak memuat satu tindakan pun)"
    return t


def _rme_indikasi(b: str, f: dict, c: dict) -> str | None:
    m = re.search(r"dasar medis untuk (.+?): tidak ada diagnosis indikasinya", b)
    if not m:
        return None
    nama = daftar([nama_tindakan(x) for x in m[1].split(" dan ")])
    t = f"rekam medis tidak memuat diagnosis yang menjadi alasan {nama}"
    n = re.search(r"hasil ukur justru normal: (.*?)\.?$", b)
    if n:
        u, _, k = ukur_awam(n[1])
        kali = f"; diukur hingga {k} kali" + (" sepanjang rawat" if f.get("tingkat") == "RITL" else "") if k >= 2 else ""
        return t + (f", dan hasil pemeriksaannya justru normal ({u}{kali})" if u else "")
    if "tidak ada hasil pemeriksaan yang mendukung" in b:
        return t + " maupun hasil pemeriksaan yang mendukungnya"
    n = re.search(r"hasil ukur yang ada: (.*?)\.?$", b)
    u = ukur_awam(n[1])[0] if n else ""
    return t + (f"; hasil pemeriksaan yang ada: {u}" if u else "")


def _rme_dx_dibantah(b: str, f: dict, c: dict) -> str | None:
    ekor = b.split(": ", 1)[1] if ": " in b else ""
    dx = r"[a-zA-Z][^;:()]*? \([A-Z]\d{2}(?:\.\d+)?\) padahal "
    item = re.findall(r"([a-zA-Z][^;:()]*?) \([A-Z]\d{2}(?:\.\d+)?\) padahal (.+?)(?=; " + dx + r"|\.?$)", ekor)
    if not item:
        return None
    ritl, nama, fakta_ = f.get("tingkat") == "RITL", [], []
    for dx_, fakta in item[:2]:
        u, normal, k = ukur_awam(fakta)
        if not u:
            continue
        nama.append(dx_.strip())
        hasil = (", semuanya normal" if (" dan " in u or ", " in u) else " normal") if normal else ""
        fakta_.append(f"{u}{hasil}{_kali_ukur(k, ritl) if not fakta_ else ''}")
    if not nama:
        return None
    sev = keparahan(f.get("kode"))
    return (f"klaim memuat diagnosis {daftar(nama)}, padahal {', dan '.join(fakta_)}"
            + (f"; hasil ini tidak sesuai dengan tingkat keparahan {KATA_KEPARAHAN[sev]} yang ditagih" if sev in KATA_KEPARAHAN else ""))


def _rme_obat(b: str, f: dict, c: dict) -> str | None:
    ekor = b.split(": ", 1)[1].rstrip(". ") if ": " in b else ""
    item = []
    for x in ekor.split("; "):
        m = re.match(r"top-up (subakut|prosedur khusus|prostesis|investigasi khusus|obat khusus) \S+(?: (.*?))? \((Rp[\d.]+)\) ditagih", x)
        if m:
            item.append(f"{m[1]}{' ' + m[2] if m[2] and not re.fullmatch(r'[A-Z0-9.-]+', m[2]) else ''} senilai {m[3]}")
            continue
        m = re.match(r"(obat khusus|prostesis/implan) \(top-up[^)]*?(Rp[\d.]+)\) ditagih", x)
        if m:
            item.append(f"{m[1]} senilai {m[2]}")
            continue
        m = re.match(r"(.+?) ditagih ([\d.,]+), tidak ada di catatan obat", x)
        if m:
            item.append(f"obat {m[1]} ({m[2]} unit)")
    return f"{daftar(item[:3])} ditagih, tetapi tidak tercatat diberikan di rekam medis rumah sakit" if item else None


def _rme_kelas(b: str, f: dict, c: dict) -> str | None:
    m = re.search(r"rawat inap (VIP|Kelas \d+), tetapi kelas layanan di rekam medis.*?(VIP|Kelas \d+)\.?$", b)
    return f"klaim menagih rawat inap {m[1]}, tetapi rekam medis mencatat pasien dirawat di {m[2]}" if m else None


def _rme_los(b: str, f: dict, c: dict) -> str | None:
    m = re.search(rf"menagih rawat inap (\d+) hari \({_T} s\.d\. {_T}\); (.*): (\d+) hari lebih panjang", b)
    if not m:
        return None
    r = re.match(rf"rekam medis mencatat rawat inap (\d+) hari \({_T} s\.d\. {_T}\)", m[4])
    if r:
        catat = f"pasien hanya dirawat {r[1]} hari, {tgl_r(r[2], r[3])}"
    else:
        r = re.match(rf"resume medis: pasien boleh pulang sejak {_T}", m[4])
        if not r:
            return None
        catat = f"resume medis menyatakan pasien sudah boleh pulang sejak {tgl(r[1])}"
    return f"klaim menagih rawat inap {m[1]} hari ({tgl_r(m[2], m[3])}), {m[5]} hari lebih lama dari catatan rekam medis ({catat})"


def _rme_episode(b: str, f: dict, c: dict) -> str | None:
    m = re.search(rf"Klaim rawat jalan {_T}, tetapi rekam medis pada hari itu hanya mencatat (?:awal )?rawat inap \((\S*) ?{_T}(?: s\.d\. {_T})?\)", b)
    if m:
        return f"klaim rawat jalan {tgl(m[1])} ditagih terpisah, padahal rekam medis mencatat hari itu sebagai bagian dari rawat inap {tgl_r(m[3], m[4])}"
    m = re.search(r"ditagih terpisah: (.*?)\.?$", b)
    return f"satu kali rawat inap di rekam medis tampaknya ditagih sebagai lebih dari satu klaim ({rapi_rme(m[1])})" if m else None


def _rme_dx_hilang(b: str, f: dict, c: dict) -> str | None:
    m = re.search(r"tidak tercatat di rekam medis: (.*?)\. Diagnosis di rekam medis: (.*?)\.?$", b)
    if not m:
        return None
    R = _rme_modul()

    def nama(k: str) -> str | None:  # a measurable diagnosis of the knowledge base has a plain name (gagal napas, infark miokard akut)
        key = R.dx_klinis(R.icd10(k) or "") if R else None
        return R.DX_KLINIS[key]["nama"] if key else None

    utama = re.search(r"([A-Z]\d{2}(?:\.\d+)?) \(utama\)", m[1])
    sek = re.findall(r"([A-Z]\d{2}(?:\.\d+)?) \(sekunder\)", m[1])
    n = re.search(r"(\d+) dari \d+ diagnosis sekunder", m[1])
    n_sek = len(sek) + (int(n[1]) if n else 0)
    bag = []
    if utama:
        x = nama(utama[1])
        bag.append("diagnosis utama" + (f" ({x})" if x else ""))
    if n_sek:
        xs = [y for y in (nama(k) for k in sek) if y]
        bag.append(f"{n_sek} diagnosis tambahan" + (f" ({daftar(xs[:3])})" if xs else ""))
    if not bag:
        return None
    n_ada = len(re.findall(r"[A-Z]\d{2}(?:\.\d+)?", m[2]))
    t = f"{daftar(bag)} yang ditagih tidak tercatat di rekam medis rumah sakit" + (
        ", yang tidak memuat diagnosis apa pun" if m[2].strip() == "tidak ada" else f" (rekam medis mencatat {n_ada} diagnosis lain)" if n_ada else "")
    sev = keparahan(f.get("kode"))
    return t + (f"; diagnosis tambahan itulah yang menentukan tingkat keparahan {KATA_KEPARAHAN[sev]} yang ditagih" if n_sek and sev in KATA_KEPARAHAN else "")


def _rme_rawat_inap(b: str, f: dict, c: dict) -> str | None:
    m = re.search(r"Rawat inap (\d+) hari tanpa tindakan bermakna, dan seluruh hasil ukur di rekam medis normal sejak masuk: (.*?)\.?$", b)
    if not m:
        return None
    u = ukur_awam(m[2])[0]
    return f"pasien dirawat inap {m[1]} hari tanpa tindakan berarti, padahal seluruh hasil pemeriksaannya di rekam medis normal sejak masuk" + (f" ({u})" if u else "")


RME_TEKS = {"RME_KUNJUNGAN_TIDAK_ADA": _rme_kunjungan, "RME_PASIEN_BERBEDA": _rme_pasien, "RME_KUNJUNGAN_DIPAKAI_ULANG": _rme_ganda,
            "RME_JENIS_RAWAT_BERBEDA": _rme_jenis_rawat, "RME_TINDAKAN_TIDAK_TERCATAT": _rme_tindakan, "RME_DIAGNOSIS_TIDAK_DIDUKUNG": _rme_dx_dibantah,
            "RME_KLINIS_TIDAK_MENDUKUNG": _rme_indikasi, "RME_OBAT_ALKES_TIDAK_TERCATAT": _rme_obat, "RME_KELAS_BERBEDA": _rme_kelas,
            "RME_LOS_TIDAK_SESUAI": _rme_los, "RME_EPISODE_DIPECAH": _rme_episode, "RME_DIAGNOSIS_TIDAK_TERCATAT": _rme_dx_hilang,
            "RME_RAWAT_INAP_TANPA_INDIKASI": _rme_rawat_inap}


def bukti_sinyal(ctx: dict) -> dict[str, dict]:
    """The evidence each engine signal carries, when the caller has it: ctx['bukti_sinyal'] ({code: text, or the signal dict
    {'bukti', 's', 'mitigasi'}}) and/or ctx['rme']['sinyal'] (rme.periksa's signals). Batch runs keep only the codes: {}."""
    out: dict[str, dict] = {}
    src = list(((ctx.get("rme") or {}).get("sinyal") or [])) + [{"kode": k, **(v if isinstance(v, dict) else {"bukti": v})}
                                                                 for k, v in (ctx.get("bukti_sinyal") or {}).items()]
    for s in src:
        if not isinstance(s, dict) or not s.get("kode") or not s.get("bukti"):
            continue
        sisa = float(s["s"]) if s.get("s") is not None else 1.0  # strength after its mitigations (rme.py: kerangka ×0,5, IGD ×0,6, elektif ×0,8)
        for mt in s.get("mitigasi") or []:
            sisa *= 1 - float((mt.get("faktor") if isinstance(mt, dict) else 0) or 0)
        out[str(s["kode"])] = {"bukti": str(s["bukti"]), "lemah": sisa < 0.5}
    return out


def temuan_rme(s: str, info: dict | None, f: dict, c: dict) -> tuple[str, str | None, bool]:
    """A medical-record finding: (plain sentence with the evidence's numbers, the other claim's id for the verifier, direct evidence).
    Without the evidence text (a batch run keeps only the codes) the plain finding of penjelas.TEMUAN_AWAM. An admission whose every
    measurement is normal, or a finding the engine weakened (record without clinical data, procedure only requested), is not direct."""
    b = (info or {}).get("bukti") or ""
    teks = None
    if b:
        try:
            teks = RME_TEKS[s](b, f, c)
        except (AttributeError, IndexError, KeyError, TypeError, ValueError):  # the evidence worded otherwise than rme.py writes it today
            teks = None
    lain = None
    if s == "RME_KUNJUNGAN_DIPAKAI_ULANG":
        m = re.search(r"dasar klaim lain \(([^,)]+)", b)
        lain = f"klaim {m[1].strip()}" if m else "klaim lain yang memakai kunjungan yang sama"
    return (teks or kecil(PJ.TEMUAN_AWAM[s])), lain, s not in RME_TELAAH and not (info or {}).get("lemah")


def jelaskan(c: dict, g: dict, ctx: dict) -> dict:
    """The case file's explanation for a reader without technical background, every sentence from one fact; and the technical trail."""
    f, klaim = g["fokus"], g["klaim"]
    x4 = ctx["x4"]
    temuan: list[dict] = []  # {teks, jenis, tunjuk, kuat (direct evidence), sinyal, lain}
    tertutup: set[str] = set()
    for t in TANDA_URUT:  # 1. ties in the claim network, strongest kind first (one per kind)
        v = next((v for v in klaim.values() if t in v["tanda"]), None)
        if v:
            temuan.append({"teks": temuan_tanda(t, v, f), "jenis": TANDA_MODUS[t][0], "tunjuk": tunjuk_tanda(t, v, f), "kuat": True,
                           "lain": (v.get("kasus") or {}).get("id") or f"klaim pembanding {tgl(v['tgl'])} di {v['rs']}"})
            tertutup |= TANDA_SINYAL[t]
    bukti_rme = bukti_sinyal(ctx)
    for s in [s for s in SINYAL_URUT if s in ctx["sinyal"]] + [s for s in ctx["sinyal"] if s not in SINYAL_URUT]:  # 2. rule engine
        awam_t = PJ.TEMUAN_AWAM.get(s)
        if awam_t and s not in tertutup and s not in ("ANOMALI_SSL", "SKOR_ML"):
            if s in RME_JENIS:  # against the medical record: the evidence's own numbers when the caller passed them
                teks, lain, kuat = temuan_rme(s, bukti_rme.get(s), f, c)
                temuan.append({"teks": teks, "jenis": RME_JENIS[s], "tunjuk": None, "kuat": kuat, "sinyal": s, **({"lain": lain} if lain else {})})
                continue
            if s.startswith("IOT_") and (c.get("iot") or {}).get("hasil") == "tidak_sesuai":
                continue  # the IoT layer's own finding (the case's iot block) already says it, with its numbers
            temuan.append({"teks": kecil(awam_t), "jenis": SINYAL_JENIS.get(s, "ml"), "tunjuk": None, "kuat": s in IOT_BUKTI if s.startswith("IOT_") else True,
                           "sinyal": s})
    for r in c.get("rule") or []:  # 3. review rules with value and threshold
        if r in ctx["sinyal"] or r in tertutup:
            continue
        teks, jenis = aturan_teks(r, x4, ctx)
        temuan.append({"teks": teks, "jenis": jenis, "tunjuk": None, "kuat": False})
    for teks, jenis in temuan_angka(f, x4, ctx["ref"], {t["jenis"] for t in temuan}):  # 4. figures against the code
        temuan.append({"teks": teks, "jenis": jenis, "tunjuk": None, "kuat": False})
    iot = c.get("iot") if (c.get("iot") or {}).get("hasil") == "tidak_sesuai" else None
    if iot:  # 0. the device contradicts the bill (testing/iot_cabang.py): a measurement leads
        temuan.insert(0, {"teks": iot_teks(iot), "jenis": "iot", "tunjuk": None, "kuat": bool(iot["bukti"].get("rantai_ok")), "iot": iot})
    if not temuan:
        fam = FAMILI_JENIS.get((c.get("keputusan_ai") or {}).get("famili") or "", "ml")
        temuan.append({"teks": "tidak ada satu temuan aturan yang berdiri sendiri, tetapi gabungan ciri klaim ini dan klaim-klaim di sekitarnya mirip klaim bermasalah",
                       "jenis": fam, "tunjuk": None, "kuat": False})
    kep = c["keputusan"]
    t0 = temuan[0]
    kode, modus = modus_dari(t0)
    layanan = "rawat inap" if f["tingkat"] == "RITL" else "rawat jalan"
    desk = (c.get("deskripsi") or "").strip().capitalize()
    pembuka = f"Klaim {layanan} {c.get('inacbg') if c.get('iot') else f['kode']}" + (f" ({desk})" if desk else "") + f" di {f['rs']} ini"
    naik_iot = bool(iot) and c.get("keputusan_asal") not in ("TAHAN", "PERIKSA")  # queued by the IoT mismatch alone
    q = ctx["q"]
    hakim = awam(tanpa_kode(((c.get("agen") or {}).get("hakim") or {}).get("alasan") or ""))
    # ---- the paragraph: what is odd, why it is a fraud sign, how the system decided (in words), where to see it
    kal = [f"{pembuka} {'terindikasi' if kep != 'DIBERSIHKAN' else 'sempat ditandai sebagai'} {modus.lower()}: {t0['teks']}."]
    if len(temuan) > 1:
        kal.append(f"Selain itu, {temuan[1]['teks']}.")
    # a medical-record finding gives its own reason (the record contradicts the bill); any other, the reason of its Permenkes mode
    alasan = (ALASAN.get(t0["jenis"]) if t0["jenis"] in JENIS_RME else ALASAN_M.get(kode)) or ALASAN.get(t0["jenis"], ALASAN["ml"])
    if t0.get("iot"):
        alasan = IOT_ALASAN.get(t0["iot"]["aturan"], alasan)
    kal.append(f"Ini tanda kecurangan (fraud) karena {alasan}." if kep != "DIBERSIHKAN" else f"Pola seperti ini perlu diwaspadai karena {alasan}.")
    if naik_iot:
        semula = {"DIBERSIHKAN": "tim agen AI semula membersihkannya", "BELUM_DIBACA": "tim agen AI belum membacanya"}.get(c.get("keputusan_asal"), "model semula meloloskannya")
        kal.append(f"Sistem menilai klaim ini lebih berisiko daripada {persen(q)} klaim normal dan {semula}; verifikasi IoT lalu mencocokkan tagihan dengan catatan alat "
                   "medis (sensor clamp pada kabel daya, bukti dijangkarkan sebelum klaim diajukan), menemukan ketidaksesuaian itu, dan memasukkan klaim ke antrean verifikator.")
    elif kep == "TAHAN":
        kal.append(f"Sistem menilai klaim ini lebih berisiko daripada {persen(q)} klaim normal, cukup tinggi untuk langsung ditahan tanpa menunggu tim agen AI.")
    elif kep == "PERIKSA":
        kal.append(f"Sistem menilai klaim ini lebih berisiko daripada {persen(q)} klaim normal; tim agen AI (tiga spesialis dan satu hakim) lalu membaca berkasnya "
                   "dan menyimpulkan klaim ini perlu diperiksa verifikator.")
    else:
        kal.append(f"Sistem sempat ragu (lebih berisiko daripada {persen(q)} klaim normal), tetapi tim agen AI membaca berkasnya dan menilai buktinya belum cukup"
                   + (f" ({kecil(hakim)})" if hakim else "") + ", sehingga klaim tidak masuk antrean.")
    jl = ctx.get("jalur") or {}
    lewat_aturan = jl.get("jalur") == "bukti_aturan"
    if lewat_aturan:  # the rule-evidence lane: the judge accepted a verified rule finding, which lifted the claim over tau
        diterima = list(dict.fromkeys(label_temuan(t) for t in c.get("temuan_aturan") or []
                                      if isinstance(t, dict) and str(t.get("id")) in {str(i) for i in jl.get("hakim_terima") or []}))
        kal.append("Klaim ini masuk antrean lewat jalur bukti aturan: hakim menerima temuan " + ("; ".join(x for x in diterima[:2] if x) or "aturan")
                   + f" dan temuan itu terverifikasi, (hakim {des(ctx.get('p') or 0)} + kekuatan temuan {des(jl.get('k_aturan') or 0)})/2 = "
                   f"{des(jl.get('f_aturan') or 0)} ≥ {des(ctx['tau'])}.")
    tunjuk = next((t["tunjuk"] for t in temuan if t["tunjuk"]), None)
    if tunjuk:
        kal.append(f"Di graph, {tunjuk}.")
    else:
        n = len(klaim)
        berat = sum(1 for v in klaim.values() if (v["keputusan"] if v["asal"] == "batch" else v["keputusan_mesin"]) in ("TAHAN", "PERIKSA"))
        kal.append(f"Di graph, ikuti garis dari dokumen klaim ini ke lingkaran peserta {f['peserta']} dan kotak RS-nya; {n} dokumen di sekitarnya adalah klaim "
                   "pembanding yang dibaca sistem" + (f", {berat} di antaranya ditahan atau diperiksa." if berat else "."))
    # ---- the modes (one per Permenkes code, strongest first) with their confidence
    jenis_fraud, ada = [], set()
    for t in temuan:
        k, nama = modus_dari(t)
        if k in ada or len(jenis_fraud) >= 3:
            continue
        ada.add(k)
        yakin = ("rendah" if kep == "DIBERSIHKAN" or t["jenis"] == "ml" else
                 "tinggi" if t["kuat"] and (kep == "TAHAN" or ctx["f"] >= ctx["tau"] + 0.05 or t.get("iot")) else "sedang")
        jenis_fraud.append({"kode": k, "nama": nama, "keyakinan": yakin, "bukti": besar(t["teks"]) + "."})
    # ---- the evidence, one fact per line, each against what is usual
    bukti = [besar(t["teks"]) + "." for t in temuan[:4]]
    ref = ctx["ref"]
    bb = banding(f["biaya"], ref.get("biaya_median") or 0, rp(ref.get("biaya_median") or 0))
    if iot and iot.get("klaim_asli"):  # the run's own row describes the claim before the synthetic ventilation billing: not compared here
        bb, ref = "", {}
    if bb and not any("tagihan" in x.lower() and "biasa" in x.lower() for x in bukti):
        bukti.append(f"Tagihan {rp(f['biaya'])}, {bb}.")
    lm = ref.get("los_median")
    if f["tingkat"] == "RITL" and lm and not any("lama rawat" in x.lower() for x in bukti):
        bukti.append(f"Lama rawat {f['los']} hari, {banding(f['los'], lm, f'{lm:g} hari', ('lebih lama dari', 'lebih pendek dari'))}.")
    if iot:  # the device evidence and its anchor, in plain words
        bk = iot["bukti"]
        bukti.insert(1, f"Bukti alat: {bk.get('pembacaan') or 0} pembacaan sensor dan ikatan alat ke pasien, dirangkum dalam satu Merkle root yang dijangkarkan "
                        f"{tgl(bk['dijangkarkan'])}, {'sebelum' if bk.get('jangkar_sebelum_klaim') else 'setelah'} klaim diajukan {tgl(bk['klaim_diajukan'])}."
                     if bk.get("merkle_root") and bk.get("klaim_diajukan") else "Bukti alat: tidak ada satu pun sesi atau pembacaan alat untuk kunjungan ini, sementara gateway RS online.")
    bukti.append(f"Sistem menilai klaim ini lebih berisiko daripada {persen(q)} klaim normal yang dipakai sebagai pembanding.")
    if hakim and kep != "TAHAN":
        bukti.append(f"Kesimpulan hakim tim agen AI: {kecil(hakim)}.")
    # ---- what the verifier does, and when the claim could still be fine
    j0 = t0["jenis"]
    lain = next((t.get("lain") for t in temuan if t.get("lain")), "klaim pembanding di graph")
    langkah = [x.format(lain=lain, tgl=tgl(f["tgl"])) for x in LANGKAH.get(j0, LANGKAH["ml"])] if not t0.get("iot") else list(t0["iot"].get("langkah") or [])
    langkah.append("Catat hasil verifikasi (terbukti bermasalah, sesuai, atau perlu investigasi) di berkas ini.")
    # ---- the decision path in words (as /testing's score panel) and what pushed the model's score up, per block
    d = ctx["dorongan"]
    sig_awam = [PJ.TEMUAN_AWAM.get(s, s) for s in ctx["sinyal"] if s not in ("SKOR_ML",)]
    alur = [{"label": "Pemeriksaan otomatis", "nilai": f"{len(sig_awam)} temuan", "nyala": bool(sig_awam)},
            {"label": "Klaim sendiri", "nilai": persen(d["klaim"])}, {"label": "Tetangga graph", "nilai": persen(d["graph"])},
            {"label": "Mekanisme fraud", "nilai": persen(d["mekanisme"])},
            {"label": ctx["model"], "nilai": persen(ctx["s"]), "nyala": bool(ctx["zona_tahan"] or ctx["zona_ragu"])},
            {"label": "Tim agen AI", "nilai": "tidak dipanggil" if kep == "TAHAN" or not c.get("agen") else
             ("perlu diperiksa" if kep == "PERIKSA" else "bukti belum cukup"), "nyala": kep == "PERIKSA"},
            {"label": "Keputusan", "nilai": {"TAHAN": "ditahan", "PERIKSA": "diperiksa", "DIBERSIHKAN": "dibersihkan"}[kep], "nyala": kep != "DIBERSIHKAN"}]
    if lewat_aturan:  # the rule-evidence lane before the decision
        alur.insert(len(alur) - 1, {"label": "Jalur bukti aturan", "nilai": f"(p + k)/2 = {des(jl.get('f_aturan') or 0)}", "nyala": True})
    if iot:  # the IoT check before the decision
        alur.insert(len(alur) - 1, {"label": "Verifikasi IoT alat medis", "nilai": "tidak sesuai", "nyala": True})
        if naik_iot:
            alur[-3].update({"nilai": "bukti belum cukup" if c.get("agen") else "tidak dipanggil", "nyala": False})
    return {"paragraf": " ".join(kal), "modus": {"kode": kode, "nama": modus}, "jenis_fraud": jenis_fraud, "bukti": bukti, "langkah": langkah,
            "catatan": (iot.get("catatan") or CATATAN["ml"]) if t0.get("iot") else CATATAN.get(j0, CATATAN["ml"]), "alur": alur, "dorongan": d, "pemeriksaan": sig_awam,
            "skor": {"model": round(float(ctx["s"]), 4), "di_atas_normal": round(float(q), 4), "ambang_ragu": round(float(ctx["ambang"]["ragu"]), 4),
                     "ambang_tahan": round(float(ctx["ambang"]["tahan"]), 4),
                     **({"f_ml": jl.get("f_ml"), "f_aturan": jl.get("f_aturan"), "k": jl.get("k_aturan"), "jalur": jl.get("jalur")} if jl else {})},
            "jejak": jejak(c, g, ctx, temuan)}

def jejak(c: dict, g: dict, ctx: dict, temuan: list[dict]) -> list[dict]:
    """The decision trail: one step per system, each with its numbers and threshold."""
    model, a, s, q = ctx["model"], ctx["ambang"], ctx["s"], ctx["q"]
    kep = c["keputusan"]
    langkah = []
    sig = [PJ.TEMUAN_AWAM.get(x, x) for x in ctx["sinyal"] if x not in ("SKOR_ML",)]
    bk = bukti_sinyal(ctx)  # a medical-record finding shows the record's evidence as the engine wrote it (technical trail)
    rinci = [PJ.TEMUAN_AWAM.get(x, x) + (f". Bukti rekam medis: {bk[x]['bukti']}" if x in RME_JENIS and x in bk else "") for x in ctx["sinyal"] if x not in ("SKOR_ML",)]
    langkah.append({"tahap": "Rule engine", "hasil": f"{len(sig)} temuan · skor {des(ctx['skor_rule'], 1)}/100", "nyala": bool(sig),
                    "rinci": rinci or ["Tidak ada temuan pemeriksaan otomatis."]})
    rr = [aturan_teks(r, ctx["x4"], ctx)[0] for r in c.get("rule") or []]
    langkah.append({"tahap": "Aturan telaah", "hasil": f"{len(rr)} menyala" if rr else "tidak ada", "nyala": bool(rr),
                    "rinci": [x[:1].upper() + x[1:] + "." for x in rr] or ["Tidak ada aturan telaah yang menyala (nilai klaim di bawah setiap ambang)."]})
    zona = "TAHAN" if ctx["zona_tahan"] else "RAGU" if ctx["zona_ragu"] else "LOLOS"
    shap = (c.get("keputusan_ai") or {}).get("shap") or []
    langkah.append({"tahap": model, "hasil": f"skor {des(s)} · zona {zona}", "nyala": zona != "LOLOS",
                    "rinci": [f"Skor {des(s)} lebih tinggi dari {persen(q)} klaim normal validasi.",
                              f"Zona: TAHAN bila skor ≥ {des(a['tahan'])}; RAGU bila skor ≥ {des(a['ragu'])} atau ada aturan telaah yang menyala; selain itu LOLOS.",
                              *[f"Pendorong: {x['fitur']} ({blok(x.get('asli', ''))}), +{des(x['kontribusi'])} log-odds." for x in shap[:5]]]})
    ag = c.get("agen")
    iot = c.get("iot") if (c.get("iot") or {}).get("hasil") == "tidak_sesuai" else None
    asal = c.get("keputusan_asal")
    if iot and not ag and asal not in ("TAHAN", "PERIKSA"):  # the model let it pass: the swarm was not asked
        langkah.append({"tahap": "AI Agent Swarm", "hasil": "tidak dipanggil", "nyala": False,
                        "rinci": [f"Skor model di bawah ambang ragu {des(a['ragu'])} dan tidak ada aturan telaah yang menyala: klaim semula LOLOS tanpa dibaca swarm."]})
    elif kep == "TAHAN" or not ag:
        langkah.append({"tahap": "AI Agent Swarm", "hasil": "tidak dipanggil", "nyala": False,
                        "rinci": [f"Skor model sudah di atas ambang tahan {des(a['tahan'])}: klaim ditahan tanpa dibaca swarm."]})
    else:
        nama = {"koding": "Spesialis koding & klinis", "tagihan": "Spesialis tagihan", "episode": "Spesialis episode & jaringan", "hakim": "Hakim"}
        rinci = [f"{nama[k]}: skor {des(ag[k]['p'])}" + (f" · {awam(tanpa_kode(ag[k].get('alasan') or ''))}" if ag[k].get("alasan") else "") for k in nama if k in ag]
        gab = (f"Gabungan = (hakim {des(ctx['p'])} + peringkat skor model {des(q)})/2 = {des(ctx['f'])}" if ctx["pilihan"] != "V5a" else f"Skor akhir = hakim {des(ctx['f'])}")
        rinci.append(f"{gab}; ambang τ {des(ctx['tau'])} (dipilih di data validasi, lalu dibekukan).")
        langkah.append({"tahap": "AI Agent Swarm", "hasil": f"hakim {des(ctx['p'])} · gabungan {des(ctx['f'])}", "nyala": kep == "PERIKSA", "rinci": rinci})
    putus = {"TAHAN": "TAHAN: skor model di atas ambang tahan.", "PERIKSA": f"PERIKSA: gabungan ≥ τ {des(ctx['tau'])}; masuk antrean verifikator.",
             "DIBERSIHKAN": f"DIBERSIHKAN: gabungan < τ {des(ctx['tau'])}; tidak masuk antrean."}[kep]
    if iot:  # the IoT check: billed against measured, the rule, the evidence chain
        bk, tr = iot["bukti"], iot["tarif"]
        langkah.append({"tahap": "Verifikasi IoT alat medis", "hasil": f"tidak sesuai · {iot['aturan']}", "nyala": True,
                        "rinci": [besar(iot_teks(iot)) + ".",
                                  f"Ditagih: {iot['ditagih']['prosedur']} · {iot['ditagih']['keterangan']} · {iot['ditagih']['inacbg']} {rp(tr['ditagih_rp'])}.",
                                  f"Terukur: {des(iot['terukur']['jam_total'], 1)} jam alat menyala, terpanjang {des(iot['terukur']['jam_berturut_maks'], 1)} jam berturut-turut"
                                  + (f" (ambang {iot['ambang_jam']:g} jam)" if iot.get("ambang_jam") else "") + ".",
                                  f"Tarif yang didukung alat: {tr['kode_seharusnya']} {rp(tr['seharusnya_rp'])}; selisih {rp(tr['selisih_rp'])} ({tr.get('dasar') or ''}).",
                                  f"Rantai bukti: Merkle root {str(bk.get('merkle_root') or '—')[:18]}…, dijangkarkan {str(bk.get('dijangkarkan') or '—').replace('T', ' ')}; {bk.get('catatan') or ''}."]})
        if asal not in ("TAHAN", "PERIKSA"):
            putus = f"PERIKSA: verifikasi IoT tidak sesuai ({iot['aturan']}); keputusan model/swarm semula {asal}. Masuk antrean verifikator."
    rinci = [putus]
    if c.get("prioritas") and iot:
        rinci.append(f"Prioritas {c['prioritas']}: indeks = maks(skor risiko {des(c['skor_risiko'])} × tagihan {rp(c['biaya_rp'])}; selisih tarif IoT "
                     f"{rp(iot['tarif']['selisih_rp'])}) (P1 = 20% teratas antrean).")
    elif c.get("prioritas"):
        rinci.append(f"Prioritas {c['prioritas']}: skor risiko {des(c['skor_risiko'])} × tagihan {rp(c['biaya_rp'])} (P1 = 20% teratas antrean).")
    if c.get("estimasi_kerugian_rp"):
        rinci.append(f"Estimasi kerugian {rp(c['estimasi_kerugian_rp'])}: {c.get('dasar_kerugian') or ''}.")
    langkah.append({"tahap": "Keputusan", "hasil": kep, "nyala": kep != "DIBERSIHKAN", "rinci": rinci})
    return langkah


_KODE = re.compile(r"\b[A-Z]{4,}(?:_[A-Z]{2,})+\b")


def tanpa_kode(t: Any) -> Any:
    """No internal codes on the page (the /testing rule): what is left after PJ.ganti_kode, as plain words."""
    if isinstance(t, list):
        return [tanpa_kode(x) for x in t]
    if isinstance(t, dict):
        return {k: tanpa_kode(v) for k, v in t.items()}
    return _KODE.sub(lambda m: m.group(0).replace("_", " ").lower(), PJ.ganti_kode(t)) if isinstance(t, str) else t
