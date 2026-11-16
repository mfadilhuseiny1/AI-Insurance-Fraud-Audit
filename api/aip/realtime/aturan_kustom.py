"""User-defined rules for the realtime engine, with AI assistance (the "System Architecture" tab). The contract between this
module, its routes and the page is docs/RULE_ENGINE_KONTRAK.md.

  expression language  `kondisi`: a Python-like boolean expression, parsed with ast and compiled by a whitelist into closures
                       (no eval/exec, no attribute access, subscripts, comprehensions, lambdas or imports; calls only to the
                       functions below, with constant arguments). A missing value is None: any comparison with it is False,
                       arithmetic with it gives None, `not` treats it as False. Length and AST size are capped.
  catalogue            what the engine has for an FKRTL claim at the moment it scores it: the claim (aip/layanan.KlaimIn),
                       derived values, the member registry, the engine's feature row (aip/layanan.features), the engine's
                       references (referensi.Referensi, the codes' stay norms) and the built-in signals already raised
  storage              <realtime data dir>/aturan/: one JSON per custom rule (ak-*.json) and per built-in rule that has a
                       change (bawaan-<KODE>.json), each with its versions; log.jsonl; _stempel (rewritten on every change,
                       so the engine reloads)
  status               draf -> diuji (a backtest of the current version) -> menunggu (submitted) -> aktif | ditolak;
                       nonaktif (an admin switched it off). Every edit is a new version back to draf; an approved version
                       keeps running while a newer one is drafted, tested and approved; rollback re-activates an earlier
                       approved version (admin, logged)
  backtest             the labelled FKRTL events the engine already judged (the simulator's truth table, kebenaran):
                       replayed claims from the replay file (exact), planted ones rebuilt from the stored event; the feature
                       row from the event's stored model inputs (ssl.x); members from the engine's registry
  AI                   DeepSeek V4.1 Flash on OpenRouter (provider data collection denied); it gets the catalogue, the
                       functions, the Permenkes modes and the current rule, never a claim row; every answer is checked by
                       the parser (one retry with the error); it can never activate anything
  engine hook          terapkan(): per FKRTL claim the signals of the active custom rules whose condition holds, the built-in
                       signals switched off, the approved built-in weights (cached, reloaded when the store changes)
"""

from __future__ import annotations

import ast
import difflib
import hashlib
import json
import logging
import math
import operator
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from fastapi import HTTPException

from aip.realtime import modus as MO
from aip.realtime.referensi import TOPUPS

log = logging.getLogger("aip.realtime.aturan")

MAX_PANJANG = 1000  # characters of a condition
MAX_NODE = 400  # AST nodes
MAX_KEDALAMAN = 24  # AST depth
MAX_LIST = 200  # elements of a list literal
MAX_TEKS = 200  # characters of a string literal
BOBOT_MIN, BOBOT_MAX = 0.05, 3.0

DRAF, DIUJI, MENUNGGU, AKTIF, DITOLAK, NONAKTIF = "draf", "diuji", "menunggu", "aktif", "ditolak", "nonaktif"
PBI = ("PBI APBN", "PBI APBD")
ALERT = ("PERIKSA", "TAHAN")
# model and context signals: not a "rule" when counting what else caught a planted claim
NON_ATURAN = {"SKOR_ML", "ANOMALI_SSL", "RISIKO_ASOSIASI"}
KODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,39}$")
ID_RE = re.compile(r"^ak-[0-9a-f]{10}$")
INACBG_RE = re.compile(r"^[A-Z]-[0-9]-[0-9]{2}-[0IV]+$")
DX_RE = re.compile(r"^[A-Z][0-9]{2}$")

# =====================================================================================================================
# the catalogue
# =====================================================================================================================
FIELDS: dict[str, tuple[str, str, str]] = {
    # the claim (aip/layanan.KlaimIn)
    "tingkat_pelayanan": ("teks", "klaim", 'Tingkat pelayanan: "RITL" (rawat inap) atau "RJTL" (rawat jalan).'),
    "kelas_rawat": ("teks", "klaim", 'Kelas rawat yang ditagih: "Kelas 1", "Kelas 2" atau "Kelas 3".'),
    "inacbg_kode": ("teks", "klaim", 'Kode INA-CBG, mis. "J-4-16-I" (CMG-kelompok-nomor-keparahan).'),
    "inacbg_keparahan": ("teks", "klaim", 'Keparahan INA-CBG: "Rawat Jalan", "Ringan (rawat inap keparahan 1)", "Sedang (rawat inap keparahan 2)", '
                                          '"Berat (rawat inap keparahan 3)".'),
    "dx_primer_icd3": ("teks", "klaim", 'Diagnosis primer, kategori ICD-10 tiga karakter, mis. "J18".'),
    "jumlah_dx_sekunder": ("angka", "klaim", "Jumlah diagnosis sekunder."),
    "prosedur": ("teks", "klaim", "Teks semua tindakan/prosedur klaim (kode ICD-9-CM dan nama); kosong bila tidak ada."),
    "los_hari": ("angka", "klaim", "Lama rawat (hari); 0 untuk rawat jalan."),
    "tarif_inacbg_rp": ("angka", "klaim", "Tarif paket INA-CBG (Rp)."),
    "sa_tarif_rp": ("angka", "klaim", "Top-up special CMG subakut (Rp); 0 bila tidak ada."),
    "sp_tarif_rp": ("angka", "klaim", "Top-up special CMG prosedur khusus (Rp); 0 bila tidak ada."),
    "rr_tarif_rp": ("angka", "klaim", "Top-up special CMG prostesis (Rp); 0 bila tidak ada."),
    "si_tarif_rp": ("angka", "klaim", "Top-up special CMG investigasi khusus (Rp); 0 bila tidak ada."),
    "sd_tarif_rp": ("angka", "klaim", "Top-up special CMG obat khusus (Rp); 0 bila tidak ada."),
    "biaya_tagih_rp": ("angka", "klaim", "Biaya yang ditagih faskes (Rp)."),
    "kabkota_fkrtl_kode": ("angka", "klaim", "Kode kab/kota FKRTL (4 digit, mis. 3273 = Kota Bandung)."),
    "jenis_fkrtl": ("teks", "klaim", '"Rumah sakit" atau "Klinik Utama".'),
    "tipe_fkrtl": ("teks", "klaim", 'Tipe FKRTL, mis. "RS Kelas A" sampai "RS Kelas D", "RS Swasta Setara Type C", "RS TNI Polri Kelas II", "Khusus Mata".'),
    "kepemilikan_fkrtl": ("teks", "klaim", 'Kepemilikan: "Swasta", "Pemerintah kab/kota", "Pemerintah provinsi", "Vertikal", "TNI AD", "TNI AL", "TNI AU", '
                                           '"POLRI", "BUMN".'),
    "poli": ("teks", "klaim", 'Kode poli rawat jalan, mis. "INT", "IGD", "OBG", "BED", "ANA", "MAT"; kosong untuk rawat inap.'),
    "status_pulang": ("teks", "klaim", 'Status pulang: "Sehat", "Rujuk", "Meninggal", "Pulang Paksa", "Tidak Tahu".'),
    "tgl_datang": ("tanggal", "klaim", 'Tanggal datang/masuk (bandingkan dengan "YYYY-MM-DD").'),
    "tgl_pulang": ("tanggal", "klaim", "Tanggal pulang; tgl_pulang - tgl_datang = selisih hari."),
    # derived
    "topup_total": ("angka", "turunan", "Jumlah kelima top-up special CMG (Rp)."),
    "ada_prosedur": ("bool", "turunan", "Klaim mencantumkan tindakan/prosedur."),
    "kode_digit": ("angka", "turunan", "Karakter ke-3 kode INA-CBG sebagai angka (kelompok kasus; 1-3 = kelompok prosedur)."),
    "sev": ("teks", "turunan", 'Keparahan di akhir kode INA-CBG: "I", "II", "III" (rawat inap) atau "0" (rawat jalan).'),
    "kelas_angka": ("angka", "turunan", "Kelas rawat yang ditagih sebagai angka 1/2/3 (1 = kelas tertinggi)."),
    # the member registry
    "jk": ("teks", "peserta", 'Jenis kelamin pemegang kartu di registri: "L" atau "P".'),
    "umur": ("angka", "peserta", "Umur pemegang kartu (tahun, desimal) pada tanggal datang."),
    "hak_kelas": ("angka", "peserta", "Hak kelas rawat di registri: 1, 2 atau 3."),
    "segmen": ("teks", "peserta", 'Segmen kepesertaan: "PPU", "PBPU", "PBI APBN", "PBI APBD", "BUKAN PEKERJA".'),
    "pbi": ("bool", "peserta", "Peserta PBI (APBN/APBD), yang tidak boleh naik kelas."),
    "kab_fktp_terdaftar": ("angka", "peserta", "Kode kab/kota FKTP tempat peserta terdaftar."),
    # the engine's feature row (aip/layanan.features)
    "idx_los": ("angka", "fitur", "Lama rawat dibagi median lama rawat kode INA-CBG-nya."),
    "rasio_tagih_tarif": ("angka", "fitur", "Biaya ditagih dibagi (tarif INA-CBG + top-up)."),
    "idx_tarif_kode": ("angka", "fitur", "Tarif INA-CBG dibagi median tarif kode itu."),
    "hari_sejak_sebelumnya": ("angka", "fitur", "Hari sejak kunjungan sebelumnya peserta di faskes yang sama (9999 bila belum pernah)."),
    "kunjungan_peserta": ("angka", "fitur", "Jumlah kunjungan peserta di riwayat, termasuk klaim ini."),
    "kunjungan_peserta_faskes": ("angka", "fitur", "Jumlah kunjungan peserta ke faskes ini, termasuk klaim ini."),
    "kembar": ("angka", "fitur", "Klaim dengan peserta, faskes, tanggal dan kode sama, termasuk klaim ini (1 = tidak ada kembaran)."),
    "frek_kode": ("angka", "fitur", "Jumlah klaim dengan kode INA-CBG ini di data latih (toko fitur)."),
    "frek_dx": ("angka", "fitur", "Jumlah klaim dengan diagnosis primer ini di data latih (toko fitur)."),
    "p_berat_dx": ("angka", "fitur", "Porsi klaim rawat inap diagnosis ini yang berkeparahan berat (0-1)."),
    "p_prosedur_dx": ("angka", "fitur", "Porsi klaim diagnosis ini yang bertipe kasus prosedur (0-1)."),
    # the hospital's electronic medical record (rme.py: SATUSEHAT FHIR sent with the claim); all empty when no record came
    "rme_ada": ("bool", "rme", "Rekam medis elektronik (SATUSEHAT) dikirim bersama klaim dan terbaca."),
    "rme_kunjungan_cocok": ("bool", "rme", "Ada kunjungan di rekam medis yang beririsan dengan tanggal klaim."),
    "rme_los_hari": ("angka", "rme", "Lama rawat inap menurut rekam medis (hari)."),
    "rme_tindakan_tidak_tercatat": ("angka", "rme", "Jumlah tindakan bermakna di klaim yang tidak ada di rekam medis."),
    "rme_tindakan_tanpa_indikasi": ("angka", "rme", "Jumlah kelompok tindakan di klaim tanpa diagnosis/hasil ukur indikasinya di rekam medis."),
    "rme_dx_tidak_tercatat": ("angka", "rme", "Jumlah diagnosis klaim (utama + sekunder) yang tidak ada di rekam medis."),
    "rme_dx_dibantah": ("angka", "rme", "Jumlah diagnosis klaim yang dibantah hasil ukur di rekam medis (mis. gagal napas, saturasi normal)."),
    "rme_obat_alkes_tidak_tercatat": ("angka", "rme", "Jumlah obat/alat yang ditagih tetapi tidak ada di rekam medis."),
    "rme_kunjungan_dipakai_ulang": ("bool", "rme", "Kunjungan rekam medis yang sama sudah ditagih klaim lain."),
    "rme_vital_normal": ("bool", "rme", "Semua tanda vital terukur di rekam medis dalam batas normal."),
    "rme_jumlah_observasi": ("angka", "rme", "Jumlah hasil ukur (tanda vital dan laboratorium) di rekam medis kunjungan ini."),
    "rme_sistolik_min": ("angka", "rme", "Tekanan darah sistolik terendah di rekam medis (mmHg)."),
    "rme_sistolik_maks": ("angka", "rme", "Tekanan darah sistolik tertinggi di rekam medis (mmHg)."),
    "rme_nadi_min": ("angka", "rme", "Denyut nadi terendah di rekam medis (x/menit)."),
    "rme_nadi_maks": ("angka", "rme", "Denyut nadi tertinggi di rekam medis (x/menit)."),
    "rme_napas_maks": ("angka", "rme", "Frekuensi napas tertinggi di rekam medis (x/menit)."),
    "rme_suhu_maks": ("angka", "rme", "Suhu tubuh tertinggi di rekam medis (derajat C)."),
    "rme_spo2_min": ("angka", "rme", "Saturasi oksigen terendah di rekam medis (%)."),
    "rme_hb_min": ("angka", "rme", "Hemoglobin terendah di rekam medis (g/dL)."),
    "rme_troponin_tinggi": ("bool", "rme", "Ada troponin di atas batas normal di rekam medis (kosong bila tidak diperiksa)."),
    "rme_ekg_abnormal": ("bool", "rme", "Ada EKG abnormal di rekam medis (kosong bila tidak ada EKG)."),
}
KLAIM = [k for k, v in FIELDS.items() if v[1] == "klaim"]
FITUR = [k for k, v in FIELDS.items() if v[1] == "fitur"]
RME = [k for k, v in FIELDS.items() if v[1] == "rme"]
TOPUP_KOLOM = list(TOPUPS)
TOPUP_DARI_LABEL = {v: k for k, v in TOPUPS.items()}

# the kinds of event each built-in signal is raised on (mesin.py, graf.py, aturan_rt.py, fktp.py)
_FKRTL_SIG = {"RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP",
              "PEMECAHAN_EPISODE", "EPISODE_HARI_SAMA", "READMISI_DX_SAMA", "CINCIN_FASKES", "KLONING_LINTAS_PESERTA", "LONJAKAN_KEPARAHAN",
              "LOS_FASKES_BERGESER", "RISIKO_ASOSIASI", "KLAIM_SETELAH_MENINGGAL", "MENINGGAL_TERCATAT", "TIDAK_SESUAI_PESERTA", "KARTU_KELUARGA",
              "PASANGAN_KODE_LANGKA", "KODE_PROSEDUR_TANPA_TINDAKAN", "DX_SEKUNDER_BERLEBIH", "KELAS_DI_ATAS_HAK", "TOPUP_TIDAK_LAZIM",
              "TOPUP_DI_ATAS_PEER", "OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "HASIL_PEMERIKSAAN_TIDAK_COCOK", "SKOR_ML", "ANOMALI_SSL",
              "TAGIHAN_MELEBIHI_TARIF", "LOS_DIPERPANJANG", "READMISI", *MO.RME_SIGNALS, *MO.IOT_SIGNALS}


def _jenis_sinyal(kode: str) -> list[str]:
    out = []
    if kode in _FKRTL_SIG:
        out.append("fkrtl")
    if kode in ("RUJUKAN_NON_SPESIALISTIK", "RUJUKAN_LONCAT_JENJANG", "RRNS_FKTP_NAIK", "RRNS_PUSKESMAS_NAIK", "KONSENTRASI_RUJUKAN", "KONTAK_SEMU",
                "MENINGGAL_TERCATAT", "KUNJUNGAN_SETELAH_MENINGGAL", "ANOMALI_SSL"):
        out.append("fktp")
    if kode.startswith("NONKAP_") or kode in ("MENINGGAL_TERCATAT", "KUNJUNGAN_SETELAH_MENINGGAL", "ANOMALI_SSL"):
        out.append("nonkap")
    if kode == "KONTAK_RENDAH":
        out.append("faskes")
    return out


DESKRIPSI_BAWAAN = {
    "RAWAT_INAP_TUMPANG_TINDIH": "Peserta tercatat rawat inap di faskes lain pada malam yang tumpang tindih (kartu dipinjam atau klaim fiktif).",
    "KARTU_BANYAK_FASKES": "Kartu peserta dipakai di 3 faskes atau lebih dalam 3 hari.",
    "KLAIM_GANDA_STREAM": "Peserta, faskes, tanggal masuk dan kode INA-CBG yang sama sudah diklaim dengan id lain di aliran.",
    "KLAIM_GANDA_RIWAYAT": "Klaim kembar di riwayat (peserta, faskes, tanggal, kode sama) atau ditandai calon klaim ganda.",
    "KLAIM_BERULANG_MIRIP": "Rawat inap peserta, faskes dan diagnosis sama dengan tanggal masuk bergeser satu hari.",
    "PEMECAHAN_EPISODE": "Masuk lagi ke faskes yang sama 0-3 hari setelah pulang dengan diagnosis sama (unbundling).",
    "EPISODE_HARI_SAMA": "Rawat jalan dan rawat inap (atau dua rawat jalan) di faskes yang sama pada hari yang sama ditagih terpisah.",
    "READMISI_DX_SAMA": "Rawat inap ulang 4-30 hari di faskes yang sama dengan diagnosis sama.",
    "CINCIN_FASKES": "Faskes berbagi peserta dengan faskes lain jauh di atas ekspektasi Poisson riwayat pasangan itu (cincin).",
    "KLONING_LINTAS_PESERTA": "3 peserta atau lebih dengan klaim rawat inap identik (faskes, tanggal, kode, diagnosis, lama rawat, prosedur, "
                              "tagihan bukan tarif paket).",
    "LONJAKAN_KEPARAHAN": "Porsi keparahan III klaim rawat inap terbaru faskes jauh di atas riwayatnya (uji binomial).",
    "LOS_FASKES_BERGESER": "Rata-rata indeks lama rawat faskes bergeser jauh di atas riwayatnya.",
    "RISIKO_ASOSIASI": "Faskes sudah berada di Box Karantina (risiko karena asosiasi; konteks, tanpa tag).",
    "KLAIM_SETELAH_MENINGGAL": "Registri mencatat peserta meninggal pada tahun sebelum tahun layanan.",
    "MENINGGAL_TERCATAT": "Klaim atau kunjungan sebelumnya di aliran berakhir dengan peserta meninggal.",
    "TIDAK_SESUAI_PESERTA": "Diagnosis/kode tidak mungkin untuk jenis kelamin atau usia pemegang kartu.",
    "KARTU_KELUARGA": "Diagnosis tidak cocok dengan pemegang kartu tetapi cocok dengan anggota keluarganya: kartu kerabat kemungkinan dipakai.",
    "PASANGAN_KODE_LANGKA": "Pasangan diagnosis-kode INA-CBG muncul 3 kali atau kurang dari 1.000+ klaim diagnosis itu.",
    "KODE_PROSEDUR_TANPA_TINDAKAN": "Kode INA-CBG kelompok prosedur (karakter ke-3 kode 1-3) tanpa tindakan tercatat.",
    "DX_SEKUNDER_BERLEBIH": "Jumlah diagnosis sekunder di atas p99 kodenya + 2 (kode dengan 200+ klaim).",
    "KELAS_DI_ATAS_HAK": "Kelas rawat inap di atas hak kelas peserta (PBI kuat; non-PBI dimitigasi).",
    "TOPUP_TIDAK_LAZIM": "Top-up special CMG yang hampir tak pernah dibawa kodenya (2 atau kurang dari 200+ klaim).",
    "TOPUP_DI_ATAS_PEER": "Top-up special CMG di atas 1,5x p95 kode dan jenis top-up itu (20+ klaim).",
    "OBAT_DIKURANGI": "Baris obat kiriman faskes: diserahkan lebih sedikit dari yang ditagih.",
    "OBAT_TIDAK_DISERAHKAN": "Baris obat kiriman faskes: ditagih tetapi tidak diserahkan.",
    "HASIL_PEMERIKSAAN_TIDAK_COCOK": "Hasil pemeriksaan di klaim berbeda dari nilai alat/LIS di luar toleransi.",
    "SKOR_ML": "Peluang model ML produksi di atas ambang segmennya.",
    "ANOMALI_SSL": "Galat rekonstruksi model self-supervised di atas p99,9 (pola tak dikenal).",
    "TAGIHAN_MELEBIHI_TARIF": "Tagihan lebih dari 1,2x tarif INA-CBG + top-up (bukan layanan COVID).",
    "LOS_DIPERPANJANG": "Rawat inap dengan lama rawat lebih dari 2x p90 kodenya.",
    "READMISI": "Rawat inap 30 hari atau kurang setelah kunjungan sebelumnya di faskes yang sama.",
    "RUJUKAN_NON_SPESIALISTIK": "Rujukan FKTP untuk diagnosis kompetensi FKTP (4A).",
    "RUJUKAN_LONCAT_JENJANG": "Rujukan FKTP langsung ke RS kelas A (melompati jenjang).",
    "RRNS_FKTP_NAIK": "Rasio rujukan non-spesialistik FKTP swasta naik dibanding riwayatnya.",
    "RRNS_PUSKESMAS_NAIK": "Rasio rujukan non-spesialistik FKTP pemerintah naik (beban kapitasi dipindah).",
    "KONSENTRASI_RUJUKAN": "Rujukan FKTP memusat ke satu tujuan jauh di atas sebaran riwayatnya.",
    "KONTAK_SEMU": "Lonjakan kontak online/home-visit FKTP dibanding riwayatnya.",
    "KONTAK_RENDAH": "Angka kontak unit kapitasi jauh di bawah riwayatnya (pemantauan periodik).",
    "KUNJUNGAN_SETELAH_MENINGGAL": "Kunjungan atau tindakan setelah peserta meninggal (registri).",
    "NONKAP_GANDA": "Tindakan nonkapitasi yang sama ditagih dua kali.",
    "NONKAP_FREKUENSI": "Pemeriksaan Prolanis/PRB berulang di atas ketentuan.",
    "NONKAP_TIDAK_SESUAI_PESERTA": "Tindakan (KB/ANC/persalinan) tidak cocok dengan jenis kelamin atau usia peserta.",
    "NONKAP_TARIF": "Tarif tindakan nonkapitasi di atas normanya (p95).",
    "NONKAP_TANGGAL": "Tanggal tindakan di luar kunjungan.",
    "NONKAP_LONJAKAN": "Lonjakan volume klaim nonkapitasi faskes.",
    "RME_KUNJUNGAN_TIDAK_ADA": "Rekam medis SATUSEHAT tidak memuat kunjungan yang beririsan dengan tanggal klaim.",
    "RME_JENIS_RAWAT_BERBEDA": "Klaim rawat inap, rekam medis hanya mencatat rawat jalan atau IGD (IGD dimitigasi).",
    "RME_LOS_TIDAK_SESUAI": "Lama rawat klaim 2 hari atau lebih di atas lama rawat Encounter di rekam medis.",
    "RME_PASIEN_BERBEDA": "Jenis kelamin atau tanggal lahir pasien di rekam medis berbeda dari pemegang kartu.",
    "RME_TINDAKAN_TIDAK_TERCATAT": "Tindakan bermakna (operatif, kateterisasi/PCI, ventilator, transfusi ...) ditagih tanpa Procedure di rekam medis.",
    "RME_KLINIS_TIDAK_MENDUKUNG": "Tindakan dari kelompok yang dikenal tanpa diagnosis atau hasil ukur indikasinya di rekam medis (hasil ukur normal = kuat).",
    "RME_DIAGNOSIS_TIDAK_TERCATAT": "Diagnosis utama/sekunder yang ditagih tidak ada di Condition rekam medis.",
    "RME_DIAGNOSIS_TIDAK_DIDUKUNG": "Diagnosis yang bisa diukur (gagal napas, syok, sepsis, infark, anemia, elektrolit ...) dibantah hasil ukur rekam medis.",
    "RME_OBAT_ALKES_TIDAK_TERCATAT": "Top-up obat khusus/prostesis atau baris obat ditagih tanpa catatan obat/alat di rekam medis.",
    "RME_KELAS_BERBEDA": "Kelas rawat yang ditagih di atas kelas layanan Encounter (location serviceClass) di rekam medis.",
    "RME_EPISODE_DIPECAH": "Rawat inap di rekam medis sudah berjalan sebelum tanggal masuk klaim, berlanjut 2+ hari setelah tanggal pulang klaim, "
                           "atau klaim rawat jalan yang di rekam medis adalah awal rawat inap hari itu.",
    "RME_KUNJUNGAN_DIPAKAI_ULANG": "Kunjungan rekam medis yang sama sudah menjadi dasar klaim lain dari faskes yang sama.",
    "RME_RAWAT_INAP_TANPA_INDIKASI": "Rawat inap tanpa tindakan bermakna dengan semua tanda vital dan laboratorium normal sejak masuk (perlu telaah).",
}


class GalatAturan(ValueError):
    """A condition the language refuses (the message is shown to the user and given back to the AI)."""


class Baris:
    """What a condition reads: the field values, the built-in signals raised, the engine's references."""
    __slots__ = ("v", "sinyal", "R", "los")

    def __init__(self, v: dict, sinyal: set, R: Any = None, los: Optional[dict] = None) -> None:
        self.v, self.sinyal, self.R, self.los = v, sinyal, R, los


# ---------------------------------------------------------------------------------------------------------- functions
def _kode(b: Baris, kode: Optional[str]) -> Optional[str]:
    return kode or b.v.get("inacbg_kode")


def _dx(b: Baris, dx: Optional[str]) -> Optional[str]:
    return dx or b.v.get("dx_primer_icd3")


def _f_med_los(b: Baris, kode: Optional[str] = None) -> Optional[float]:
    x = (b.los or {}).get(_kode(b, kode))
    return float(x[0]) if x else None


def _f_p90_los(b: Baris, kode: Optional[str] = None) -> Optional[float]:
    x = (b.los or {}).get(_kode(b, kode))
    return float(x[1]) if x else None


def _f_dx_sek_p99(b: Baris, kode: Optional[str] = None) -> Optional[float]:
    k = b.R.kode.get(_kode(b, kode)) if b.R is not None else None
    return float(k["dx_sek_p99"]) if k else None


def _f_n_kode(b: Baris, kode: Optional[str] = None) -> Optional[int]:
    if b.R is None:
        return None
    k = b.R.kode.get(_kode(b, kode))
    return int(k["n"]) if k else 0


def _f_p95_topup(b: Baris, kolom: str, kode: Optional[str] = None) -> Optional[float]:
    t = b.R.topup.get((_kode(b, kode), kolom)) if b.R is not None else None
    return float(t["p95"]) if t and t["n"] > 0 else None


def _f_n_topup(b: Baris, kolom: str, kode: Optional[str] = None) -> Optional[int]:
    if b.R is None:
        return None
    t = b.R.topup.get((_kode(b, kode), kolom))
    return int(t["n"]) if t else 0


def _f_frek_pasangan(b: Baris, dx: Optional[str] = None, kode: Optional[str] = None) -> Optional[int]:
    if b.R is None:
        return None
    d = _dx(b, dx)
    if b.R.dx_total.get(d, 0) < 1000:
        return None  # the pair table only holds diagnoses with >= 1,000 claims a year
    return int(b.R.pair.get((d, _kode(b, kode)), 0))


def _f_n_dx(b: Baris, dx: Optional[str] = None) -> Optional[int]:
    return int(b.R.dx_total.get(_dx(b, dx), 0)) if b.R is not None else None


def _f_rare_pair(b: Baris, dx: Optional[str] = None, kode: Optional[str] = None) -> Optional[bool]:
    return bool(b.R.rare_pair(_dx(b, dx), _kode(b, kode))) if b.R is not None else None


def _f_sinyal(b: Baris, kode: str) -> bool:
    return kode in b.sinyal


def _f_kosong(b: Baris, field: str) -> bool:
    x = b.v.get(field)
    return x is None or (isinstance(x, str) and not x.strip())


# name -> argument kinds, required count, result type, needs the engine's references, implementation, shown arguments, text
FUNGSI: dict[str, dict[str, Any]] = {
    "med_los": {"arg": ["kode"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_med_los, "argumen": "kode?",
                "deskripsi": "Median lama rawat kode INA-CBG (tanpa argumen: kode klaim ini)."},
    "p90_los": {"arg": ["kode"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_p90_los, "argumen": "kode?",
                "deskripsi": "Persentil 90 lama rawat kode INA-CBG (tanpa argumen: kode klaim ini)."},
    "dx_sek_p99": {"arg": ["kode"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_dx_sek_p99, "argumen": "kode?",
                   "deskripsi": "Persentil 99 jumlah diagnosis sekunder klaim kode itu setahun."},
    "n_kode": {"arg": ["kode"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_n_kode, "argumen": "kode?",
               "deskripsi": "Jumlah klaim setahun dengan kode itu (acuan apakah statistik kodenya cukup)."},
    "p95_topup": {"arg": ["kolom_topup", "kode"], "wajib": 1, "jenis": "angka", "ref": True, "impl": _f_p95_topup, "argumen": "kolom, kode?",
                  "deskripsi": 'Persentil 95 nilai top-up kolom itu (mis. "sd_tarif_rp") pada klaim kode itu yang membawanya; kosong bila tidak pernah ada.'},
    "n_topup": {"arg": ["kolom_topup", "kode"], "wajib": 1, "jenis": "angka", "ref": True, "impl": _f_n_topup, "argumen": "kolom, kode?",
                "deskripsi": "Jumlah klaim kode itu setahun yang membawa top-up kolom tersebut."},
    "frek_pasangan": {"arg": ["dx", "kode"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_frek_pasangan, "argumen": "dx?, kode?",
                      "deskripsi": "Jumlah klaim setahun dengan diagnosis dan kode ini (hanya diagnosis dengan 1.000+ klaim; selain itu kosong)."},
    "n_dx": {"arg": ["dx"], "wajib": 0, "jenis": "angka", "ref": True, "impl": _f_n_dx, "argumen": "dx?",
             "deskripsi": "Jumlah klaim setahun dengan diagnosis primer itu."},
    "rare_pair": {"arg": ["dx", "kode"], "wajib": 0, "jenis": "bool", "ref": True, "impl": _f_rare_pair, "argumen": "dx?, kode?",
                  "deskripsi": "Pasangan diagnosis-kode hampir tak pernah ada (3 kali atau kurang dari 1.000+ klaim diagnosis itu)."},
    "sinyal": {"arg": ["sinyal"], "wajib": 1, "jenis": "bool", "ref": False, "impl": _f_sinyal, "argumen": "KODE",
               "deskripsi": 'Sinyal rule bawaan itu muncul pada klaim ini, mis. sinyal("LOS_DIPERPANJANG").'},
    "kosong": {"arg": ["field"], "wajib": 1, "jenis": "bool", "ref": False, "impl": _f_kosong, "argumen": "nama_field",
               "deskripsi": 'Nilai field itu kosong/tidak tercatat, mis. kosong("prosedur").'},
}

CONTOH = [
    'tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp") and hari_sejak_sebelumnya > 30',
    'tingkat_pelayanan == "RITL" and los_hari > 2 * p90_los() and not sinyal("LOS_DIPERPANJANG")',
    'pbi and tingkat_pelayanan == "RITL" and kelas_angka < hak_kelas',
    'jk == "L" and dx_primer_icd3 >= "O00" and dx_primer_icd3 <= "O99"',
    "kode_digit in [1, 2, 3] and not ada_prosedur",
    'kembar > 1 and biaya_tagih_rp > 10000000',
    'tingkat_pelayanan == "RJTL" and kabkota_fkrtl_kode != kab_fktp_terdaftar and kunjungan_peserta_faskes >= 8',
    'rme_ada and dx_primer_icd3 in ["I20", "I21", "I25"] and rme_troponin_tinggi == False and rme_ekg_abnormal == False and rme_vital_normal',
    'rme_ada and sev == "III" and rme_vital_normal and rme_jumlah_observasi >= 6 and rme_dx_tidak_tercatat >= 1',
]

# =====================================================================================================================
# the expression language
# =====================================================================================================================
_DILARANG = {
    ast.Attribute: "akses atribut (a.b) tidak diizinkan", ast.Subscript: "indeks/potongan (a[...]) tidak diizinkan",
    ast.Lambda: "lambda tidak diizinkan", ast.ListComp: "comprehension tidak diizinkan", ast.SetComp: "comprehension tidak diizinkan",
    ast.DictComp: "comprehension tidak diizinkan", ast.GeneratorExp: "comprehension tidak diizinkan", ast.IfExp: "if-else tidak diizinkan",
    ast.NamedExpr: "operator := tidak diizinkan", ast.Dict: "dict tidak diizinkan", ast.Set: "set tidak diizinkan",
    ast.JoinedStr: "f-string tidak diizinkan", ast.Starred: "argumen * tidak diizinkan", ast.Await: "await tidak diizinkan",
}
_CMP: dict[type, Callable[[Any, Any], bool]] = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le,
                                                ast.Gt: operator.gt, ast.GtE: operator.ge}
_ARIT: dict[type, Callable[[Any, Any], Any]] = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
_OP_NAMA = {ast.Pow: "**", ast.Mod: "%", ast.FloorDiv: "//", ast.BitAnd: "&", ast.BitOr: "|", ast.BitXor: "^", ast.LShift: "<<",
            ast.RShift: ">>", ast.MatMult: "@", ast.Is: "is", ast.IsNot: "is not", ast.Invert: "~"}


class Ekspresi:
    """A compiled condition: fn(Baris) -> bool, the fields and functions it reads, whether it needs the references."""
    __slots__ = ("teks", "fn", "field", "fungsi", "pakai_ref")

    def __init__(self, teks: str, fn: Callable[[Baris], Any], field: list[str], fungsi: list[str], pakai_ref: bool) -> None:
        self.teks, self.fn, self.field, self.fungsi, self.pakai_ref = teks, fn, field, fungsi, pakai_ref

    def __call__(self, b: Baris) -> bool:
        return self.fn(b) is True


def _saran(nama: str, pilihan: Any) -> str:
    m = difflib.get_close_matches(nama, list(pilihan), n=1, cutoff=0.6)
    return f' (maksud Anda "{m[0]}"?)' if m else ""


def _tgl(v: Any) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if hasattr(v, "date") and hasattr(v, "hour"):  # a pandas Timestamp
        try:
            return v.date()
        except Exception:  # noqa: BLE001 - NaT
            return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _tanggal_literal(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise GalatAturan(f'tanggal "{s}" tidak sah: tulis "YYYY-MM-DD"') from None


def _hitung(fn: Callable[[Any, Any], Any], a: Any, b: Any) -> Any:
    if a is None or b is None:
        return None
    try:
        r = fn(a, b)
    except (ZeroDivisionError, OverflowError, TypeError, ValueError):
        return None
    if isinstance(r, float) and (r != r or r in (math.inf, -math.inf)):
        return None
    return r


def _banding(fn: Callable[[Any, Any], bool], a: Any, b: Any) -> bool:
    if a is None or b is None:
        return False
    try:
        return bool(fn(a, b))
    except TypeError:
        return False


class _Kompilator:
    def __init__(self) -> None:
        self.field: set[str] = set()
        self.fungsi: set[str] = set()
        self.ref = False

    # an operand of a comparison: a list literal stays a list, a string constant is kept so a date can be read from it
    def operand(self, n: ast.AST) -> tuple[Optional[Callable], str, Any]:
        if isinstance(n, (ast.List, ast.Tuple)):
            if len(n.elts) > MAX_LIST:
                raise GalatAturan(f"list terlalu panjang (maksimal {MAX_LIST} isi)")
            vals, kinds = [], set()
            for el in n.elts:
                v = self.konstanta(el)
                vals.append(v)
                kinds.add("bool" if isinstance(v, bool) else "angka" if isinstance(v, (int, float)) else "teks")
            if len(kinds) > 1:
                raise GalatAturan("isi list harus sejenis (semua angka atau semua teks)")
            return None, "list:" + (kinds.pop() if kinds else "kosong"), vals
        if isinstance(n, ast.Constant) and isinstance(n.value, str):
            fn, j = self.c(n)
            return fn, j, n.value
        fn, j = self.c(n)
        return fn, j, None

    def konstanta(self, n: ast.AST) -> Any:
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub) and isinstance(n.operand, ast.Constant) \
                and isinstance(n.operand.value, (int, float)) and not isinstance(n.operand.value, bool):
            return -n.operand.value
        if not isinstance(n, ast.Constant):
            raise GalatAturan("isi list hanya boleh konstanta (angka atau teks)")
        v = n.value
        if v is None:
            raise GalatAturan('None tidak boleh dipakai; untuk nilai kosong pakai kosong("field")')
        if isinstance(v, str) and len(v) > MAX_TEKS:
            raise GalatAturan(f"teks terlalu panjang (maksimal {MAX_TEKS} karakter)")
        if not isinstance(v, (bool, int, float, str)):
            raise GalatAturan("konstanta tidak diizinkan")
        return v

    def c(self, n: ast.AST) -> tuple[Callable[[Baris], Any], str]:
        if type(n) in _DILARANG:
            raise GalatAturan(_DILARANG[type(n)])
        if isinstance(n, ast.BoolOp):
            parts = [self.c(v) for v in n.values]
            for _, j in parts:
                if j != "bool":
                    raise GalatAturan(f"and/or butuh nilai benar/salah, bukan {j} (pakai perbandingan, mis. x > 0)")
            fns = tuple(p[0] for p in parts)
            if isinstance(n.op, ast.And):
                return (lambda b: all(f(b) is True for f in fns)), "bool"
            return (lambda b: any(f(b) is True for f in fns)), "bool"
        if isinstance(n, ast.UnaryOp):
            f, j = self.c(n.operand)
            if isinstance(n.op, ast.Not):
                if j != "bool":
                    raise GalatAturan(f"not butuh nilai benar/salah, bukan {j}")
                return (lambda b: f(b) is not True), "bool"
            if isinstance(n.op, (ast.USub, ast.UAdd)):
                if j != "angka":
                    raise GalatAturan(f"tanda minus/plus hanya untuk angka, bukan {j}")
                if isinstance(n.op, ast.USub):
                    return (lambda b: None if (x := f(b)) is None else -x), "angka"
                return f, "angka"
            raise GalatAturan(f"operator {_OP_NAMA.get(type(n.op), type(n.op).__name__)} tidak diizinkan")
        if isinstance(n, ast.BinOp):
            op = type(n.op)
            if op not in _ARIT:
                raise GalatAturan(f"operator {_OP_NAMA.get(op, op.__name__)} tidak diizinkan (hanya + - * /)")
            fa, ja = self.c(n.left)
            fb, jb = self.c(n.right)
            fn = _ARIT[op]
            if ja == "angka" and jb == "angka":
                return (lambda b: _hitung(fn, fa(b), fb(b))), "angka"
            if op is ast.Sub and ja == "tanggal" and jb == "tanggal":
                return (lambda b: None if (x := fa(b)) is None or (y := fb(b)) is None else (x - y).days), "angka"
            raise GalatAturan(f"aritmetika hanya untuk angka (dan selisih dua tanggal), bukan {ja} dan {jb}")
        if isinstance(n, ast.Compare):
            prev = self.operand(n.left)
            if prev[1].startswith("list:"):
                raise GalatAturan("list hanya boleh di sisi kanan in / not in")
            parts = []
            for op, right in zip(n.ops, n.comparators):
                cur = self.operand(right)
                parts.append(self.banding(op, prev, cur))
                prev = cur
            if len(parts) == 1:
                return parts[0], "bool"
            ps = tuple(parts)
            return (lambda b: all(p(b) for p in ps)), "bool"
        if isinstance(n, ast.Name):
            nama = n.id
            if nama.startswith("_"):
                raise GalatAturan(f"nama {nama} tidak diizinkan")
            if nama in FIELDS:
                self.field.add(nama)
                return (lambda b: b.v.get(nama)), FIELDS[nama][0]
            if nama in FUNGSI:
                raise GalatAturan(f"{nama} adalah fungsi: tulis {nama}(...)")
            if nama in ("true", "false", "TRUE", "FALSE"):
                raise GalatAturan(f"tulis True atau False, bukan {nama}")
            raise GalatAturan(f"field tidak dikenal: {nama}{_saran(nama, FIELDS)}")
        if isinstance(n, ast.Constant):
            v = self.konstanta(n)
            if isinstance(v, bool):
                return (lambda b: v), "bool"
            if isinstance(v, (int, float)):
                if isinstance(v, float) and not math.isfinite(v):
                    raise GalatAturan("angka tidak sah")
                return (lambda b: v), "angka"
            return (lambda b: v), "teks"
        if isinstance(n, ast.Call):
            return self.panggil(n)
        if isinstance(n, (ast.List, ast.Tuple)):
            raise GalatAturan("list hanya boleh di sisi kanan in / not in")
        raise GalatAturan(f"bentuk {type(n).__name__} tidak diizinkan")

    def panggil(self, n: ast.Call) -> tuple[Callable[[Baris], Any], str]:
        if not isinstance(n.func, ast.Name):
            raise GalatAturan("hanya fungsi dari daftar yang boleh dipanggil (tanpa titik)")
        nama = n.func.id
        spec = FUNGSI.get(nama)
        if spec is None:
            raise GalatAturan(f"fungsi tidak dikenal: {nama}{_saran(nama, FUNGSI)}")
        if n.keywords:
            raise GalatAturan(f"{nama}(): argumen bernama tidak diizinkan")
        if not spec["wajib"] <= len(n.args) <= len(spec["arg"]):
            raise GalatAturan(f"{nama}({spec['argumen']}): jumlah argumen salah")
        args = []
        for a, kind in zip(n.args, spec["arg"]):
            if not (isinstance(a, ast.Constant) and isinstance(a.value, str)):
                raise GalatAturan(f'{nama}(): argumen harus teks konstanta, mis. {nama}("...")')
            v = a.value
            if kind == "kolom_topup" and v not in TOPUPS:
                raise GalatAturan(f"{nama}(): kolom top-up harus salah satu dari {', '.join(TOPUP_KOLOM)}")
            if kind == "kode" and not INACBG_RE.match(v):
                raise GalatAturan(f'{nama}(): kode INA-CBG "{v}" tidak sah (mis. "J-4-16-I")')
            if kind == "dx" and not DX_RE.match(v):
                raise GalatAturan(f'{nama}(): diagnosis "{v}" harus kategori ICD-10 tiga karakter (mis. "J18")')
            if kind == "sinyal":
                if v not in MO.SIGNALS:
                    raise GalatAturan(f"{nama}(): sinyal bawaan tidak dikenal: {v}{_saran(v, MO.SIGNALS)}")
                if v not in _FKRTL_SIG:
                    raise GalatAturan(f"{nama}(): sinyal {v} tidak pernah muncul pada klaim FKRTL")
            if kind == "field":
                if v not in FIELDS:
                    raise GalatAturan(f"{nama}(): field tidak dikenal: {v}{_saran(v, FIELDS)}")
                self.field.add(v)
            args.append(v)
        self.fungsi.add(nama)
        self.ref = self.ref or spec["ref"]
        impl, targs = spec["impl"], tuple(args)
        return (lambda b: impl(b, *targs)), spec["jenis"]

    def banding(self, op: ast.cmpop, kiri: tuple, kanan: tuple) -> Callable[[Baris], bool]:
        fa, ja, ca = kiri
        fb, jb, cb = kanan
        t = type(op)
        if t in (ast.In, ast.NotIn):
            neg = t is ast.NotIn
            if jb.startswith("list:"):
                el = jb[5:]
                vals = list(cb)
                if ja == "tanggal" and el == "teks":
                    vals = [_tanggal_literal(v) for v in vals]
                elif el != "kosong" and el != ja:
                    raise GalatAturan(f"in: field {ja} dicocokkan dengan list {el}")
                s = frozenset(vals)
                if neg:
                    return lambda b: (x := fa(b)) is not None and x not in s
                return lambda b: (x := fa(b)) is not None and x in s
            if ja == "teks" and jb == "teks":  # a substring of a text
                if neg:
                    return lambda b: _banding(lambda x, y: x not in y, fa(b), fb(b))
                return lambda b: _banding(lambda x, y: x in y, fa(b), fb(b))
            raise GalatAturan("in / not in butuh list [...] di kanan, atau teks di dalam teks")
        if t not in _CMP:
            raise GalatAturan(f"operator {_OP_NAMA.get(t, t.__name__)} tidak diizinkan; untuk nilai kosong pakai kosong(\"field\")")
        fn = _CMP[t]
        # a date against a "YYYY-MM-DD" constant
        if ja == "tanggal" and jb == "teks" and cb is not None:
            d = _tanggal_literal(cb)
            fb, jb = (lambda b: d), "tanggal"
        elif jb == "tanggal" and ja == "teks" and ca is not None:
            d = _tanggal_literal(ca)
            fa, ja = (lambda b: d), "tanggal"
        if ja.startswith("list:") or jb.startswith("list:"):
            raise GalatAturan("list hanya boleh dipakai dengan in / not in")
        if ja != jb:
            raise GalatAturan(f"tipe tidak cocok: {ja} dibandingkan dengan {jb}")
        if ja == "bool" and t not in (ast.Eq, ast.NotEq):
            raise GalatAturan("nilai benar/salah hanya bisa dibandingkan dengan == atau !=")
        return lambda b: _banding(fn, fa(b), fb(b))


def _kedalaman(n: ast.AST, d: int = 0) -> int:
    if d > MAX_KEDALAMAN:
        return d
    return max([d] + [_kedalaman(c, d + 1) for c in ast.iter_child_nodes(n)])


def kompilasi(kondisi: Any) -> Ekspresi:
    """The condition checked and compiled; GalatAturan says why not."""
    if not isinstance(kondisi, str):
        raise GalatAturan("kondisi harus teks")
    teks = kondisi.strip()
    if not teks:
        raise GalatAturan("kondisi kosong")
    if len(teks) > MAX_PANJANG:
        raise GalatAturan(f"kondisi terlalu panjang ({len(teks)} karakter, maksimal {MAX_PANJANG})")
    if "\x00" in teks:
        raise GalatAturan("karakter tidak sah")
    try:
        tree = ast.parse(teks, mode="eval")
    except SyntaxError as e:
        raise GalatAturan(f"sintaks tidak sah (kolom {e.offset or '?'}): {e.msg}") from None
    except (ValueError, RecursionError, MemoryError):
        raise GalatAturan("kondisi tidak bisa dibaca") from None
    n_node = sum(1 for _ in ast.walk(tree))
    if n_node > MAX_NODE:
        raise GalatAturan(f"kondisi terlalu rumit ({n_node} simpul, maksimal {MAX_NODE})")
    if _kedalaman(tree) > MAX_KEDALAMAN:
        raise GalatAturan("kondisi terlalu bersarang")
    k = _Kompilator()
    fn, j = k.c(tree.body)
    if j != "bool":
        raise GalatAturan(f"kondisi harus bernilai benar/salah, bukan {j} (pakai perbandingan, and/or/not, field bool atau fungsi bool)")
    if not k.field and not k.fungsi:
        raise GalatAturan("kondisi tidak membaca field atau fungsi apa pun (selalu benar atau selalu salah)")
    return Ekspresi(teks, fn, sorted(k.field), sorted(k.fungsi), k.ref)


def validasi(kondisi: Any) -> dict:
    try:
        ex = kompilasi(kondisi)
    except GalatAturan as e:
        return {"ok": False, "error": str(e), "field": [], "fungsi": [], "pakai_referensi": False}
    return {"ok": True, "error": None, "field": ex.field, "fungsi": ex.fungsi, "pakai_referensi": ex.pakai_ref}


def katalog() -> dict:
    from aip import semantik as S

    return {"fields": [{"nama": k, "jenis": v[0], "sumber": v[1], "deskripsi": v[2]} for k, v in FIELDS.items()],
            "fungsi": [{"nama": k, "argumen": v["argumen"], "jenis": v["jenis"], "deskripsi": v["deskripsi"]} for k, v in FUNGSI.items()],
            "modus": [{"kode": m["id"], "nama": m["nama"]} for m in S.MODUS_PERMENKES],
            "contoh": list(CONTOH),
            "sinyal": [{"kode": k, "label": MO.SIGNALS[k][3]} for k in MO.SIGNALS if k in _FKRTL_SIG],
            "operator": ["and", "or", "not", "==", "!=", "<", "<=", ">", ">=", "in", "not in", "+", "-", "*", "/"],
            "batas": {"panjang": MAX_PANJANG, "simpul": MAX_NODE, "list": MAX_LIST, "bobot_min": BOBOT_MIN, "bobot_maks": BOBOT_MAX},
            "catatan": "Nilai yang tidak tercatat = kosong: perbandingan dengan nilai kosong selalu salah, aritmetika dengan nilai kosong "
                       "menghasilkan kosong, not menganggapnya salah. Teks dibandingkan persis (huruf besar/kecil berpengaruh). "
                       "Rule dinilai pada setiap klaim FKRTL."}


# =====================================================================================================================
# the row a condition reads: one builder for the engine and the backtest
# =====================================================================================================================
def _bersih(v: Any) -> Any:
    """NaN -> None, numpy scalars -> Python, text stripped ("" -> None)."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s or None
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        return None if v != v else v
    if isinstance(v, int):
        return v
    if hasattr(v, "item") and not hasattr(v, "hour"):  # numpy scalar
        try:
            return _bersih(v.item())
        except (ValueError, TypeError):
            return None
    return v


def _angka(v: Any) -> Optional[float]:
    v = _bersih(v)
    if v is None or isinstance(v, str):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int(v: Any) -> Optional[int]:
    f = _angka(v)
    return int(f) if f is not None else None


def _nilai(k: dict, fitur: dict, p: dict) -> dict:
    """The field values of one FKRTL claim: k = the claim's fields (KlaimIn names; may carry topup_total when the five
    top-ups are not all known), fitur = the engine's feature row, p = the member's registry values."""
    from aip.realtime import aturan_rt as A

    v: dict[str, Any] = {name: _bersih(k.get(name)) for name in KLAIM}
    for name in ("jumlah_dx_sekunder", "los_hari", "tarif_inacbg_rp", "biaya_tagih_rp", "kabkota_fkrtl_kode", *TOPUP_KOLOM):
        x = v[name]
        v[name] = _int(x) if x is not None else None
    v["tgl_datang"], v["tgl_pulang"] = _tgl(v["tgl_datang"]), _tgl(v["tgl_pulang"])
    tops = [v[c] for c in TOPUP_KOLOM]
    tt = k.get("topup_total")
    v["topup_total"] = int(tt) if tt is not None else (sum(tops) if all(t is not None for t in tops) else None)
    v["ada_prosedur"] = bool(v["prosedur"])
    code = v["inacbg_kode"] or ""
    v["kode_digit"] = int(code[2]) if len(code) > 2 and code[2].isdigit() else None
    v["sev"] = code.rsplit("-", 1)[-1] if code.count("-") >= 3 else None
    v["kelas_angka"] = A._kelas(v["kelas_rawat"])
    for name in ("jk", "umur", "hak_kelas", "segmen", "pbi", "kab_fktp_terdaftar"):
        v[name] = p.get(name)
    for name in FITUR:
        v[name] = _angka(fitur.get(name))
    return v


def _peserta_registri(m: Optional[dict], tgl: Any) -> dict:
    """The member's registry row (referensi.anggota_sql) as the language reads it."""
    from aip.realtime import aturan_rt as A

    if not m:
        return {}
    hak = _angka(m.get("hak"))
    seg = _bersih(m.get("segmen"))
    unit = m.get("unit_terdaftar")
    kab = None
    if isinstance(unit, str):
        head = unit.split("|", 1)[0].strip()
        kab = int(head) if head.isdigit() else None
    d = _tgl(tgl)
    born = m.get("tgl_lahir")
    try:
        umur = A._age(born, d) if d is not None and born is not None else None
    except Exception:  # noqa: BLE001 - an unreadable birth date is unknown
        umur = None
    return {"jk": _bersih(m.get("jk")), "umur": umur, "hak_kelas": int(hak) if hak is not None else None, "segmen": seg,
            "pbi": (seg in PBI) if seg else None, "kab_fktp_terdaftar": kab}


def _peserta_tersimpan(a: Optional[dict], tgl: Any) -> dict:
    """The member view a stored event keeps (mesin._member_view): the age from the birth year only, no FKTP unit."""
    if not a:
        return {}
    d = _tgl(tgl)
    th = a.get("tahun_lahir")
    seg = _bersih(a.get("segmen"))
    return {"jk": a.get("jk"), "umur": float(d.year - int(th)) if d and th else None, "hak_kelas": a.get("hak_kelas"), "segmen": seg,
            "pbi": (seg in PBI) if seg else None, "kab_fktp_terdaftar": None}


def _nilai_rme(v: dict, rme: Optional[dict]) -> dict:
    """The electronic-medical-record fields (rme.periksa's `nilai`; all None when no record came with the claim)."""
    r = rme or {}
    for name in RME:
        x = r.get(name)
        v[name] = x if isinstance(x, bool) or x is None else _angka(x)
    if rme is not None and v.get("rme_ada") is None:
        v["rme_ada"] = bool(rme)
    return v


def baris_klaim(c: Any, row: Optional[dict], m: Optional[dict], sigs: list[dict], R: Any, los: Optional[dict], rme: Optional[dict] = None) -> Baris:
    """The engine's view of one FKRTL claim (mesin._fkrtl): the claim object, its feature row, its registry row, the
    built-in signals raised on it, the medical-record values."""
    k = {name: getattr(c, name, None) for name in KLAIM}
    v = _nilai_rme(_nilai(k, row or {}, _peserta_registri(m, getattr(c, "tgl_datang", None))), rme)
    return Baris(v, {s["kode"] for s in sigs if (s.get("s") or 0) > 0}, R, los)


# =====================================================================================================================
# storage
# =====================================================================================================================
_LOCK = threading.RLock()
_UJI_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _dir() -> Path:
    from aip.realtime.store import data_dir

    d = data_dir() / "aturan"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _tulis(path: Path, data: Any) -> None:
    from aip.runs import _write

    _write(path, data)


def _baca(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _stempel() -> None:
    """Every change rewrites the stamp: the engine (this process at once, another one within seconds) reloads."""
    _tulis(_dir() / "_stempel", {"t": _now(), "id": uuid.uuid4().hex})
    _EFEKTIF["cek"] = 0.0
    _EFEKTIF["tanda"] = None


def _log(oleh: str, aksi: str, jenis: str, kunci: str, versi: Optional[int], catatan: str = "") -> None:
    row = {"waktu": _now(), "oleh": oleh, "aksi": aksi, "jenis": jenis, ("id" if jenis == "kustom" else "kode"): kunci, "versi": versi,
           "catatan": (catatan or "")[:1000]}
    with _LOCK, (_dir() / "log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def log_baca(limit: int = 300) -> list[dict]:
    try:
        lines = (_dir() / "log.jsonl").read_text("utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in reversed(lines[-max(1, min(limit, 5000)):]):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def _path(jenis: str, kunci: str) -> Path:
    if jenis == "kustom":
        if not ID_RE.match(kunci or ""):
            raise HTTPException(404, "aturan tidak ada")
        return _dir() / f"{kunci}.json"
    if kunci not in MO.SIGNALS:
        raise HTTPException(404, f"rule bawaan tidak dikenal: {kunci}")
    return _dir() / f"bawaan-{kunci}.json"


def _rec(jenis: str, kunci: str) -> dict:
    r = _baca(_path(jenis, kunci))
    if not r:
        raise HTTPException(404, "aturan tidak ada" if jenis == "kustom" else f"belum ada perubahan untuk rule bawaan {kunci}")
    return r


def _simpan(rec: dict) -> None:
    _tulis(_path(rec["jenis"], rec["id"] if rec["jenis"] == "kustom" else rec["kode"]), rec)
    _stempel()


def _semua(jenis: str) -> list[dict]:
    pola = "ak-*.json" if jenis == "kustom" else "bawaan-*.json"
    out = []
    for p in sorted(_dir().glob(pola)):
        r = _baca(p)
        if r and r.get("jenis") == jenis:
            out.append(r)
    return out


def _ver(rec: dict, n: Optional[int] = None) -> dict:
    n = rec["versi"] if n is None else n
    for v in rec["versi_daftar"]:
        if v["versi"] == n:
            return v
    raise HTTPException(404, f"versi {n} tidak ada")


def _riwayat(rec: dict, status: str, oleh: str, catatan: str = "", versi: Optional[int] = None) -> None:
    rec["status"] = status
    rec["riwayat"].append({"versi": rec["versi"] if versi is None else versi, "status": status, "oleh": oleh, "waktu": _now(), "catatan": catatan})
    rec["diubah_oleh"], rec["diubah"] = oleh, _now()


def _ringkas_uji(u: Optional[dict]) -> Optional[dict]:
    if not u:
        return None
    return {k: u.get(k) for k in ("versi", "waktu", "kena", "laju_normal", "recall", "precision", "beban_per_hari")}


def _lihat(rec: dict) -> dict:
    """The page's view of a custom rule (Aturan) or a built-in change (Perubahan)."""
    v = _ver(rec)
    common = {"status": rec["status"], "versi": rec["versi"], "versi_aktif": rec.get("versi_aktif"), "berjalan": rec.get("versi_aktif") is not None,
              "dibuat_oleh": rec["dibuat_oleh"], "dibuat": rec["dibuat"], "diubah_oleh": rec["diubah_oleh"], "diubah": rec["diubah"],
              "uji": v.get("uji"), "riwayat": rec["riwayat"]}
    if rec["jenis"] == "kustom":
        return {"id": rec["id"], "kode": rec["kode"], "label": v["label"], "deskripsi": v.get("deskripsi") or "", "kondisi": v["kondisi"],
                "modus": v.get("modus") or [], "bobot": v["bobot"], "menggantikan": v.get("menggantikan"), **common,
                "versi_daftar": [{"versi": x["versi"], "label": x["label"], "kondisi": x["kondisi"], "bobot": x["bobot"], "modus": x.get("modus") or [],
                                  "menggantikan": x.get("menggantikan"), "oleh": x["oleh"], "waktu": x["waktu"], "uji": _ringkas_uji(x.get("uji")),
                                  "disetujui": x.get("disetujui")} for x in rec["versi_daftar"]]}
    meta = MO.SIGNALS.get(rec["kode"], ([], None, 0.0, rec["kode"]))
    return {"kode": rec["kode"], "label": meta[3], "aktif": v["aktif"], "bobot": v["bobot"], "catatan": v.get("catatan") or "", "sebelum": v.get("sebelum"),
            **common,
            "versi_daftar": [{"versi": x["versi"], "aktif": x["aktif"], "bobot": x["bobot"], "catatan": x.get("catatan") or "", "oleh": x["oleh"],
                              "waktu": x["waktu"], "uji": _ringkas_uji(x.get("uji")), "disetujui": x.get("disetujui")} for x in rec["versi_daftar"]]}


# ---------------------------------------------------------------------------------------------------------- effective state
class Efektif:
    """What the engine applies: the running custom rules (compiled), the built-ins switched off, approved built-in weights."""
    __slots__ = ("aturan", "nonaktif", "bobot", "pengganti", "mati")

    def __init__(self) -> None:
        self.aturan: list[tuple[dict, Ekspresi]] = []
        self.nonaktif: set[str] = set()
        self.bobot: dict[str, float] = {}
        self.pengganti: dict[str, list[str]] = {}  # built-in -> the running custom rules that replace it
        self.mati: set[str] = set()  # built-ins switched off by an approved change (not by a replacement)

    def kosong(self) -> bool:
        return not (self.aturan or self.nonaktif or self.bobot)


def _hitung_efektif() -> Efektif:
    eff = Efektif()
    for rec in _semua("kustom"):
        n = rec.get("versi_aktif")
        if n is None:
            continue
        try:
            v = _ver(rec, n)
            ex = kompilasi(v["kondisi"])
        except (HTTPException, GalatAturan) as e:
            log.warning("aturan kustom %s v%s tidak dimuat: %s", rec.get("id"), n, e)
            continue
        a = {"id": rec["id"], "kode": rec["kode"], "label": v["label"], "modus": list(v.get("modus") or []), "bobot": float(v["bobot"]),
             "versi": n, "kondisi": v["kondisi"], "menggantikan": v.get("menggantikan")}
        eff.aturan.append((a, ex))
        if a["menggantikan"]:
            eff.nonaktif.add(a["menggantikan"])
            eff.pengganti.setdefault(a["menggantikan"], []).append(rec["id"])
    for rec in _semua("bawaan"):
        n = rec.get("versi_aktif")
        if n is None:
            continue
        try:
            v = _ver(rec, n)
        except HTTPException:
            continue
        if not v["aktif"]:
            eff.nonaktif.add(rec["kode"])
            eff.mati.add(rec["kode"])
        else:
            eff.bobot[rec["kode"]] = float(v["bobot"])
    for k in eff.nonaktif:
        eff.bobot.pop(k, None)
    return eff


_EFEKTIF: dict[str, Any] = {"nilai": None, "tanda": None, "cek": 0.0}
CEK_DETIK = 2.0
_GALAT_TERAKHIR: dict[str, float] = {}


def _tanda() -> Optional[str]:
    try:
        return (_dir() / "_stempel").read_text("utf-8")
    except OSError:
        return ""


def efektif() -> Efektif:
    """Cached; the stamp is read at most every CEK_DETIK seconds (a change in this process clears the cache at once)."""
    now = time.monotonic()
    cur = _EFEKTIF["nilai"]
    if cur is not None and now < _EFEKTIF["cek"]:
        return cur
    with _LOCK:
        t = _tanda()
        if cur is None or t != _EFEKTIF["tanda"]:
            cur = _hitung_efektif()
            _EFEKTIF["nilai"], _EFEKTIF["tanda"] = cur, t
        _EFEKTIF["cek"] = now + CEK_DETIK
    return cur


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return f"{v:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".") if abs(v) < 1e6 else f"{v:,.0f}".replace(",", ".")
    if isinstance(v, int) and not isinstance(v, bool):
        return f"{v:,}".replace(",", ".")
    return str(v)


def terapkan(sigs: list[dict], weights: dict, c: Any, row: Optional[dict], m: Optional[dict], R: Any, los: Optional[dict],
             f: str, rme: Optional[dict] = None) -> tuple[list[dict], dict]:
    """The engine's hook (mesin._fkrtl, after the built-in signals of a claim): a signal for every running custom rule
    whose condition holds, the switched-off built-ins dropped, approved built-in weights merged. The input list is
    never changed in place."""
    from aip.realtime.graf import sig

    eff = efektif()
    if eff.kosong():
        return sigs, weights
    out = list(sigs)
    if eff.aturan:
        b = baris_klaim(c, row, m, sigs, R, los, rme)
        for a, ex in eff.aturan:
            try:
                hit = ex(b)
            except Exception:  # noqa: BLE001 - one rule's failure never stops the others or the claim
                if time.monotonic() - _GALAT_TERAKHIR.get(a["id"], -1e9) > 60:
                    _GALAT_TERAKHIR[a["id"]] = time.monotonic()
                    log.exception("aturan kustom %s gagal dinilai", a["id"])
                continue
            if not hit:
                continue
            nilai = "; ".join(f"{k} = {_fmt(b.v.get(k))}" for k in ex.field[:5])
            s = sig(a["kode"], a["label"], None, 1.0, a["bobot"], ("faskes", f),
                    f"rule kustom v{a['versi']}: {a['kondisi']}" + (f" ({nilai})" if nilai else ""))
            s["bukti"] = s["bukti"][:600]
            s["modus"] = list(a["modus"])
            s["aturan"] = {"id": a["id"], "versi": a["versi"]}
            out.append(s)
    if eff.nonaktif:
        out = [s for s in out if s["kode"] not in eff.nonaktif]
    if eff.bobot:
        weights = {**weights, **eff.bobot}
    return out, weights


def _sinkron_konfig() -> None:
    """The approved built-in weights and switched-off built-ins written into the engine's config (weight 0 = off), so
    the existing scoring applies them to every kind of event; the codes this module manages are remembered, so a
    withdrawn change is taken out again."""
    from aip.realtime import mesin as E

    try:
        eff = _hitung_efektif()
        cfg = E.config()
        bobot = dict(cfg.get("bobot") or {})
        kelola = {**eff.bobot, **{k: 0.0 for k in eff.nonaktif}}
        for k in set(cfg.get("bobot_aturan") or []) - set(kelola):
            bobot.pop(k, None)
        bobot.update(kelola)
        E.set_config(bobot=bobot, bobot_aturan=sorted(kelola), sinyal_nonaktif=sorted(eff.nonaktif))
    except Exception:  # noqa: BLE001 - the engine's own hook still applies the store for FKRTL claims
        log.exception("aturan: konfigurasi mesin tidak diperbarui")


# ---------------------------------------------------------------------------------------------------------- reads
def _bobot_berlaku(kode: str, eff: Efektif, cfg: dict) -> float:
    w0 = MO.SIGNALS[kode][2]
    if kode in eff.bobot:
        return eff.bobot[kode]
    kelola = set(cfg.get("bobot_aturan") or [])
    return float((cfg.get("bobot") or {}).get(kode, w0)) if kode not in kelola else w0


def daftar() -> dict:
    from aip.realtime import aktif as AKT
    from aip.realtime import mesin as E

    model = set(AKT.CODES)  # the 45 signals ML v7 reads as features (frozen: a new signal never joins without retraining)
    eff = _hitung_efektif()
    cfg = E.config()
    per = {r["kode"]: r for r in _semua("bawaan")}
    bawaan = []
    for k, (modes, tag, w0, label) in MO.SIGNALS.items():
        p = _lihat(per[k]) if k in per else None
        bawaan.append({"kode": k, "label": label, "modus": list(modes), "tag": tag, "bobot_default": w0, "bobot": _bobot_berlaku(k, eff, cfg),
                       "aktif": k not in eff.nonaktif, "deskripsi": DESKRIPSI_BAWAAN.get(k, label), "berlaku_untuk": _jenis_sinyal(k),
                       "digantikan_oleh": eff.pengganti.get(k) or [], "masuk_model": k in model,
                       "perubahan_menunggu": p if p and p["status"] in (DRAF, DIUJI, MENUNGGU) else None, "perubahan": p})
    kustom = sorted((_lihat(r) for r in _semua("kustom")), key=lambda a: a["diubah"], reverse=True)
    allrec = list(per.values()) + _semua("kustom")
    return {"bawaan": bawaan, "kustom": kustom,
            "ringkas": {"aktif": sum(r.get("versi_aktif") is not None for r in allrec), "menunggu": sum(r["status"] == MENUNGGU for r in allrec),
                        "draf": sum(r["status"] in (DRAF, DIUJI) for r in allrec)}}


def ambil(rid: str) -> dict:
    return _lihat(_rec("kustom", rid))


# ---------------------------------------------------------------------------------------------------------- writes
def _badan(body: dict, rid: Optional[str]) -> dict:
    """A custom rule's body checked (400/409 with the reason)."""
    kode = str(body.get("kode") or "").strip().upper()
    if not KODE_RE.match(kode):
        raise HTTPException(400, "kode harus huruf besar, angka atau garis bawah, 3-40 karakter, diawali huruf")
    if kode in MO.SIGNALS:
        raise HTTPException(409, f"kode {kode} sudah dipakai sinyal bawaan")
    for r in _semua("kustom"):
        if r["kode"] == kode and r["id"] != rid:
            raise HTTPException(409, f"kode {kode} sudah dipakai aturan {r['id']}")
    label = str(body.get("label") or "").strip()
    if not 3 <= len(label) <= 80:
        raise HTTPException(400, "label 3-80 karakter")
    try:
        ex = kompilasi(body.get("kondisi"))
    except GalatAturan as e:
        raise HTTPException(400, f"kondisi tidak sah: {e}") from None
    modus = [str(x).strip().upper() for x in (body.get("modus") or [])]
    valid = {m["kode"] for m in katalog()["modus"]}
    bad = [x for x in modus if x not in valid]
    if bad or len(modus) > 5:
        raise HTTPException(400, f"modus tidak dikenal atau terlalu banyak: {', '.join(bad) or len(modus)}")
    try:
        bobot = float(body.get("bobot"))
    except (TypeError, ValueError):
        raise HTTPException(400, "bobot harus angka") from None
    if not BOBOT_MIN <= bobot <= BOBOT_MAX:
        raise HTTPException(400, f"bobot {BOBOT_MIN}-{BOBOT_MAX}")
    ganti = body.get("menggantikan") or None
    if ganti is not None:
        ganti = str(ganti).strip().upper()
        if ganti not in MO.SIGNALS:
            raise HTTPException(400, f"menggantikan: sinyal bawaan tidak dikenal: {ganti}")
        if ganti not in _FKRTL_SIG:
            raise HTTPException(400, f"menggantikan: {ganti} bukan sinyal klaim FKRTL (rule kustom hanya dinilai pada klaim FKRTL)")
    return {"kode": kode, "label": label, "deskripsi": str(body.get("deskripsi") or "").strip()[:1000], "kondisi": ex.teks,
            "modus": list(dict.fromkeys(modus)), "bobot": round(bobot, 3), "menggantikan": ganti}


def buat(body: dict, oleh: str) -> dict:
    with _LOCK:
        b = _badan(body, None)
        rid = "ak-" + uuid.uuid4().hex[:10]
        now = _now()
        ver = {"versi": 1, **{k: v for k, v in b.items() if k != "kode"}, "oleh": oleh, "waktu": now, "uji": None, "disetujui": None}
        rec = {"id": rid, "jenis": "kustom", "kode": b["kode"], "status": DRAF, "versi": 1, "versi_aktif": None, "dibuat_oleh": oleh, "dibuat": now,
               "diubah_oleh": oleh, "diubah": now, "versi_daftar": [ver], "riwayat": [{"versi": 1, "status": DRAF, "oleh": oleh, "waktu": now, "catatan": "dibuat"}]}
        _simpan(rec)
        _log(oleh, "buat", "kustom", rid, 1, b["kondisi"])
        return _lihat(rec)


def ubah(rid: str, body: dict, oleh: str) -> dict:
    with _LOCK:
        rec = _rec("kustom", rid)
        b = _badan(body, rid)
        if b["kode"] != rec["kode"]:
            raise HTTPException(400, f"kode aturan tidak bisa diubah (tetap {rec['kode']}); buat aturan baru untuk kode lain")
        n = max(v["versi"] for v in rec["versi_daftar"]) + 1
        rec["versi_daftar"].append({"versi": n, **{k: v for k, v in b.items() if k != "kode"}, "oleh": oleh, "waktu": _now(), "uji": None, "disetujui": None})
        rec["versi"] = n
        jalan = rec.get("versi_aktif")
        _riwayat(rec, DRAF, oleh, f"versi baru{f'; versi {jalan} tetap berjalan sampai versi ini disetujui' if jalan else ''}")
        _simpan(rec)
        _log(oleh, "ubah", "kustom", rid, n, b["kondisi"])
        return _lihat(rec)


def _status_bawaan(kode: str, eff: Optional[Efektif] = None) -> dict:
    from aip.realtime import mesin as E

    eff = eff or _hitung_efektif()
    return {"aktif": kode not in eff.nonaktif, "bobot": _bobot_berlaku(kode, eff, E.config())}


def ubah_bawaan(kode: str, aktif: Optional[bool], bobot: Optional[float], catatan: str, oleh: str) -> dict:
    with _LOCK:
        if kode not in MO.SIGNALS:
            raise HTTPException(404, f"rule bawaan tidak dikenal: {kode}")
        if aktif is None and bobot is None:
            raise HTTPException(400, "isi aktif dan/atau bobot")
        if bobot is not None and not BOBOT_MIN <= float(bobot) <= BOBOT_MAX:
            raise HTTPException(400, f"bobot {BOBOT_MIN}-{BOBOT_MAX}")
        cur = _status_bawaan(kode)
        now = _now()
        rec = _baca(_path("bawaan", kode))
        n = 1 if not rec else max(v["versi"] for v in rec["versi_daftar"]) + 1
        ver = {"versi": n, "aktif": cur["aktif"] if aktif is None else bool(aktif), "bobot": round(float(cur["bobot"] if bobot is None else bobot), 3),
               "catatan": (catatan or "").strip()[:1000], "sebelum": cur, "oleh": oleh, "waktu": now, "uji": None, "disetujui": None}
        if not rec:
            rec = {"id": f"bawaan-{kode}", "jenis": "bawaan", "kode": kode, "status": DRAF, "versi": n, "versi_aktif": None, "dibuat_oleh": oleh,
                   "dibuat": now, "diubah_oleh": oleh, "diubah": now, "versi_daftar": [], "riwayat": []}
        rec["versi_daftar"].append(ver)
        rec["versi"] = n
        _riwayat(rec, DRAF, oleh, ver["catatan"] or "perubahan baru")
        _simpan(rec)
        _log(oleh, "ubah_bawaan", "bawaan", kode, n, f"aktif={ver['aktif']} bobot={ver['bobot']} {ver['catatan']}".strip())
        return _lihat(rec)


def ajukan(jenis: str, kunci: str, oleh: str, catatan: str = "") -> dict:
    with _LOCK:
        rec = _rec(jenis, kunci)
        v = _ver(rec)
        st = rec["status"]
        if st == MENUNGGU:
            raise HTTPException(409, "sudah diajukan, menunggu persetujuan admin")
        if st == AKTIF:
            raise HTTPException(409, "versi ini sudah aktif")
        if st == DITOLAK:
            raise HTTPException(409, "versi ini ditolak: ubah dulu (versi baru), uji, lalu ajukan")
        u = v.get("uji")
        if not u or u.get("versi") != rec["versi"]:
            raise HTTPException(409, f"belum ada uji untuk versi {rec['versi']}: jalankan uji dulu")
        _riwayat(rec, MENUNGGU, oleh, catatan)
        _simpan(rec)
        _log(oleh, "ajukan", jenis, kunci, rec["versi"], catatan)
        return _lihat(rec)


def setujui(jenis: str, kunci: str, oleh: str, catatan: str = "") -> dict:
    with _LOCK:
        rec = _rec(jenis, kunci)
        if rec["status"] != MENUNGGU:
            raise HTTPException(409, f"hanya versi yang diajukan yang bisa disetujui (status sekarang: {rec['status']})")
        v = _ver(rec)
        if not v.get("uji"):
            raise HTTPException(409, "belum ada uji untuk versi ini")
        if jenis == "kustom":
            kompilasi(v["kondisi"])  # a condition the language no longer accepts is never activated
        v["disetujui"] = {"oleh": oleh, "waktu": _now()}
        rec["versi_aktif"] = rec["versi"]
        _riwayat(rec, AKTIF, oleh, catatan)
        _simpan(rec)
        _log(oleh, "setujui", jenis, kunci, rec["versi"], catatan)
        _sinkron_konfig()
        return _lihat(rec)


def tolak(jenis: str, kunci: str, oleh: str, catatan: str) -> dict:
    with _LOCK:
        rec = _rec(jenis, kunci)
        if rec["status"] != MENUNGGU:
            raise HTTPException(409, f"hanya versi yang diajukan yang bisa ditolak (status sekarang: {rec['status']})")
        if not (catatan or "").strip():
            raise HTTPException(400, "alasan penolakan wajib diisi")
        _riwayat(rec, DITOLAK, oleh, catatan)
        _simpan(rec)
        _log(oleh, "tolak", jenis, kunci, rec["versi"], catatan)
        return _lihat(rec)


def nonaktifkan(jenis: str, kunci: str, oleh: str, catatan: str = "") -> dict:
    with _LOCK:
        rec = _rec(jenis, kunci)
        jalan = rec.get("versi_aktif")
        if jalan is None:
            raise HTTPException(409, "tidak ada versi yang sedang berjalan")
        rec["versi_aktif"] = None
        if rec["status"] == AKTIF:
            _riwayat(rec, NONAKTIF, oleh, catatan or f"versi {jalan} dihentikan")
        else:
            rec["riwayat"].append({"versi": jalan, "status": NONAKTIF, "oleh": oleh, "waktu": _now(), "catatan": catatan or f"versi {jalan} dihentikan"})
            rec["diubah_oleh"], rec["diubah"] = oleh, _now()
        _simpan(rec)
        _log(oleh, "nonaktifkan", jenis, kunci, jalan, catatan)
        _sinkron_konfig()
        return _lihat(rec)


def rollback(jenis: str, kunci: str, versi: int, oleh: str, catatan: str = "") -> dict:
    with _LOCK:
        rec = _rec(jenis, kunci)
        v = _ver(rec, int(versi))
        if not v.get("disetujui"):
            raise HTTPException(409, f"versi {versi} belum pernah disetujui: hanya versi yang pernah aktif yang bisa dipulihkan")
        if jenis == "kustom":
            try:
                kompilasi(v["kondisi"])
            except GalatAturan as e:
                raise HTTPException(409, f"versi {versi} tidak lolos pemeriksaan bahasa rule sekarang: {e}") from None
        dari = rec.get("versi_aktif")
        rec["versi"] = int(versi)
        rec["versi_aktif"] = int(versi)
        _riwayat(rec, AKTIF, oleh, catatan or f"rollback ke versi {versi}" + (f" (sebelumnya versi {dari} berjalan)" if dari else ""))
        _simpan(rec)
        _log(oleh, "rollback", jenis, kunci, int(versi), catatan or f"dari versi {dari}")
        _sinkron_konfig()
        return _lihat(rec)


def hapus(rid: str, oleh: str, admin: bool, catatan: str = "") -> dict:
    """Delete a custom rule (the user, 2026-11-15: "rule nya bisa di edit, delete atau add new rule"). A rule with a running
    version is deleted by an admin only, and stops running at once. Nothing is lost for the audit trail: the record moves to
    aturan/_terhapus/ and the log keeps the action. Built-in rules are code (45 of them feed ML v7): they are switched off, never
    deleted."""
    with _LOCK:
        rec = _rec("kustom", rid)
        jalan = rec.get("versi_aktif")
        if jalan is not None and not admin:
            raise HTTPException(403, f"rule {rec['kode']} sedang berjalan (versi {jalan}): hanya admin yang bisa menghapusnya")
        now = _now()
        rec["dihapus"] = {"oleh": oleh, "waktu": now, "catatan": (catatan or "")[:1000], "status_terakhir": rec["status"], "versi_aktif_terakhir": jalan}
        rec["versi_aktif"] = None
        arsip = _dir() / "_terhapus"
        arsip.mkdir(exist_ok=True)
        _tulis(arsip / f"{rid}-{now.replace(':', '').replace('+', '_')}.json", rec)
        _path("kustom", rid).unlink(missing_ok=True)
        _stempel()
        _log(oleh, "hapus", "kustom", rid, rec["versi"], catatan or (f"versi {jalan} berhenti berjalan" if jalan is not None else ""))
        if jalan is not None:
            _sinkron_konfig()
        return {"id": rid, "kode": rec["kode"], "dihapus": True, "berjalan_sebelumnya": jalan is not None}


# =====================================================================================================================
# backtest
# =====================================================================================================================
def _sumber_mesin() -> Optional[dict]:
    """The warm engine's references and registry connection, or None (the engine is off or still loading)."""
    from aip.realtime import mesin as E

    eng = E.ENGINE
    if not eng.ready():
        return None
    return {"R": eng.ref, "los": eng.los_ref, "con": eng.con, "window": eng.window}


def _ribuan(n: int) -> str:
    return f"{int(n):,}".replace(",", ".")


def _r4(x: Optional[float]) -> Optional[float]:
    return None if x is None else round(float(x), 4)


def _ro(path: Path) -> sqlite3.Connection:
    """A read-only connection of its own (the engine's writer keeps its own; WAL lets both run)."""
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=30, check_same_thread=False)


def _profil(kab: Any, kepemilikan: Any, jenis: Any, tipe: Any) -> str:
    """The facility profile key (aip/layanan.profile_id)."""
    parts = ["FKRTL", str(kab) if kab else None, kepemilikan, jenis, tipe]
    return hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()


class _Replay:
    """The replayed claims of the simulator's window (exact claim fields by claim id) and their facilities."""

    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self.idx: dict[str, int] = {}
        self.cols: dict[str, list] = {}
        self.fas: dict[str, dict] = {}
        self.window: Optional[tuple[str, str]] = None
        if path is None:
            return
        import pandas as pd

        want = ["kunjungan_fkrtl_id", "edisi", *KLAIM]
        df = pd.read_parquet(path).reindex(columns=want)
        self.cols = {c: df[c].tolist() for c in KLAIM}
        ids = df["kunjungan_fkrtl_id"].astype(str).tolist()
        ed = df["edisi"].astype(str).tolist()
        self.idx = {f"{e}:{i}": n for n, (e, i) in enumerate(zip(ed, ids))}
        fac = df[["kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl"]].drop_duplicates()
        for kab, kep, jen, tip in fac.itertuples(index=False):
            kab, kep, jen, tip = _int(kab), _bersih(kep), _bersih(jen), _bersih(tip)
            self.fas[_profil(kab, kep, jen, tip)] = {"kepemilikan": kep, "jenis": jen, "tipe": tip}
        m = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})", path.name)
        self.window = (m.group(1), m.group(2)) if m else None

    def klaim(self, key: str) -> Optional[dict]:
        n = self.idx.get(key)
        if n is None:
            return None
        return {c: self.cols[c][n] for c in KLAIM}


def _berkas_replay(src: Optional[dict]) -> Optional[Path]:
    from aip.realtime.store import data_dir

    d = data_dir()
    if src and src.get("window"):
        p = d / f"replay_fkrtl_{src['window'][0]}_{src['window'][1]}.parquet"
        if p.is_file():
            return p
    xs = sorted(d.glob("replay_fkrtl_*.parquet"), key=lambda p: p.stat().st_mtime)
    return xs[-1] if xs else None


_TOPUP_BUKTI = re.compile(r"top-up (subakut|prosedur khusus|prostesis|investigasi khusus|obat khusus) Rp([0-9.]+)")


def _klaim_dari_peristiwa(e: dict, x: dict, fas: dict) -> dict:
    """A planted claim (no replay row) rebuilt from what its event stored: the event's claim fields, the facility, the
    stored model inputs. The five top-ups: all 0 when their total is 0; a column named with its amount in a built-in
    top-up signal's evidence; the rest only when nothing of the total is left, else unknown (None)."""
    gi = e.get("gi") or {}
    lab = (e.get("faskes_label") or "").split(" · ")
    f = fas.get(e.get("faskes") or "") or {}

    def kat(v: Any) -> Any:
        return None if v in (None, "tidak tercatat") else v
    tarif = e.get("tarif")
    total = None
    if gi.get("tarif_total") is not None:
        total = int(gi["tarif_total"]) - int(tarif or 0)
    elif x.get("tarif_tambahan") is not None:
        total = int(x["tarif_tambahan"])
    tops: dict[str, Optional[int]] = {c: None for c in TOPUP_KOLOM}
    if total == 0:
        tops = {c: 0 for c in TOPUP_KOLOM}
    elif total is not None:
        for s in e.get("sinyal") or []:
            if s.get("kode") in ("TOPUP_DI_ATAS_PEER", "TOPUP_TIDAK_LAZIM"):
                m = _TOPUP_BUKTI.search(s.get("bukti") or "")
                if m:
                    tops[TOPUP_DARI_LABEL[m.group(1)]] = int(m.group(2).replace(".", ""))
        sisa = total - sum(v for v in tops.values() if v is not None)
        if sisa == 0:
            tops = {c: (v if v is not None else 0) for c, v in tops.items()}
    return {"tingkat_pelayanan": e.get("tingkat"), "kelas_rawat": kat(x.get("kelas_rawat")), "inacbg_kode": e.get("kode"),
            "inacbg_keparahan": e.get("keparahan"), "dx_primer_icd3": e.get("dx3"), "jumlah_dx_sekunder": x.get("dx_sekunder"),
            "prosedur": gi.get("prosedur"), "los_hari": e.get("los"), "tarif_inacbg_rp": tarif, "biaya_tagih_rp": e.get("biaya"),
            "kabkota_fkrtl_kode": gi.get("kab"), "jenis_fkrtl": kat(x.get("jenis_fkrtl")) or f.get("jenis"), "tipe_fkrtl": gi.get("tipe"),
            "kepemilikan_fkrtl": f.get("kepemilikan") or (lab[1] if len(lab) == 3 else None), "poli": gi.get("poli"),
            "status_pulang": gi.get("status_pulang"), "tgl_datang": e.get("tgl_datang"), "tgl_pulang": e.get("tgl_pulang"), **tops,
            "topup_total": total}


class _DataUji:
    """The labelled events of the given kinds, one at a time (the store holds ~200k events: never all in memory)."""

    def __init__(self, kinds: tuple[str, ...], baris: bool, src: Optional[dict]) -> None:
        from aip.realtime import ssl as SSL
        from aip.realtime.store import data_dir

        self.kinds, self.baris, self.src = kinds, baris, src
        self.path = data_dir() / "realtime.sqlite"
        if not self.path.is_file():
            raise HTTPException(409, "belum ada peristiwa tersimpan: jalankan simulator di tab Realtime Fraud dulu")
        self.cols_x = SSL.FKRTL.base_cols
        self.spek = SSL.FKRTL.key()
        self.replay = _Replay(_berkas_replay(src)) if baris else _Replay(None)
        self.peserta: dict[tuple[str, int], dict] = {}
        self.sumber_peserta = "tidak dipakai"
        self.n = {"replay": 0, "rekonstruksi": 0, "tanpa_fitur": 0}
        if baris:
            self._muat_peserta()

    def _where(self) -> tuple[str, list]:
        w = f"coalesce(json_extract(p.rec, '$.jenis'), 'fkrtl') IN ({','.join('?' * len(self.kinds))})"
        if self.kinds == ("fkrtl",):  # FKTP and non-capitation keys are prefixed: their JSON is never parsed
            w = f"p.klaim NOT LIKE 'fktp:%' AND p.klaim NOT LIKE 'nonkap:%' AND {w}"
        return w, list(self.kinds)

    def _muat_peserta(self) -> None:
        if not (self.src and self.src.get("con") is not None and "fkrtl" in self.kinds):
            self.sumber_peserta = "tampilan peserta tersimpan di peristiwa (umur dari tahun lahir; kab/kota FKTP terdaftar tidak ada)"
            return
        import pandas as pd

        con = _ro(self.path)
        try:
            keys = con.execute("""SELECT DISTINCT json_extract(p.rec, '$.edisi'), json_extract(p.rec, '$.peserta') FROM kebenaran k
                                  JOIN peristiwa p ON p.id = k.peristiwa WHERE coalesce(json_extract(p.rec, '$.jenis'), 'fkrtl') = 'fkrtl'""").fetchall()
        finally:
            con.close()
        keys = [(str(a), int(b)) for a, b in keys if a is not None and b is not None]
        if not keys:
            return
        cur = self.src["con"].cursor()
        try:
            cur.register("cari_aturan", pd.DataFrame({"edisi": [k[0] for k in keys], "peserta_id": [k[1] for k in keys]}))
            rows = cur.execute("""SELECT a.edisi, a.peserta_id, a.jk, a.tgl_lahir, a.hak, a.segmen, a.unit_terdaftar FROM anggota a
                                  JOIN (SELECT DISTINCT edisi, peserta_id FROM cari_aturan) c USING (edisi, peserta_id)""").fetchall()
            cur.unregister("cari_aturan")
        finally:
            cur.close()
        for ed, pid, jk, lahir, hak, seg, unit in rows:
            self.peserta[(str(ed), int(pid))] = {"jk": jk, "tgl_lahir": lahir, "hak": hak, "segmen": seg, "unit_terdaftar": unit}
        self.sumber_peserta = "registri peserta mesin (sama dengan saat klaim dinilai)"

    def __iter__(self) -> Iterator[dict]:
        where, args = self._where()
        con = _ro(self.path)
        try:
            cur = con.execute(f"""SELECT p.id, p.klaim, p.keputusan, k.skenario, p.rec FROM kebenaran k JOIN peristiwa p ON p.id = k.peristiwa
                                  WHERE {where}""", args)
            for pid, klaim, kep, sk, rec in cur:
                e = json.loads(rec)
                item = {"id": pid, "klaim": klaim, "keputusan": kep, "skenario": sk, "jenis": e.get("jenis", "fkrtl"), "tgl": e.get("tgl_datang"),
                        "sinyal": [{"kode": s.get("kode"), "s": s.get("s") or 0.0, "mitigasi": s.get("mitigasi") or []} for s in e.get("sinyal") or []],
                        "b": None}
                if self.baris and item["jenis"] == "fkrtl":
                    item["b"] = self._baris(e)
                yield item
        finally:
            con.close()

    def _baris(self, e: dict) -> Baris:
        ss = e.get("ssl") or {}
        xs = ss.get("x")
        x = dict(zip(self.cols_x, xs)) if xs and ss.get("spek") == self.spek and len(xs) == len(self.cols_x) else {}
        if not x:
            self.n["tanpa_fitur"] += 1
        k = self.replay.klaim(f"{e.get('edisi')}:{e.get('kunjungan')}")
        if k is not None:
            self.n["replay"] += 1
        else:
            self.n["rekonstruksi"] += 1
            k = _klaim_dari_peristiwa(e, x, self.replay.fas)
        if self.src and self.src.get("con") is not None:
            p = _peserta_registri(self.peserta.get((str(e.get("edisi")), int(e.get("peserta") or 0))), e.get("tgl_datang"))
        else:
            p = _peserta_tersimpan(e.get("anggota"), e.get("tgl_datang"))
        v = _nilai_rme(_nilai(k, x, p), (e.get("rme") or {}).get("nilai"))
        sin = {s["kode"] for s in e.get("sinyal") or [] if s.get("kode") in MO.SIGNALS and (s.get("s") or 0) > 0}
        return Baris(v, sin, (self.src or {}).get("R"), (self.src or {}).get("los"))


def _putus(total: float, th: tuple[float, float]) -> str:
    sc = round(100 * (1 - math.exp(-total)), 1)
    return "TAHAN" if sc >= th[1] else "PERIKSA" if sc >= th[0] else "LOLOS"


def _kontribusi(sinyal: list[dict], w: dict[str, float]) -> float:
    """The rule score's sum from the stored built-in signals under the weights w (mitigation as mesin.score). A custom
    rule's stored signal is not in w: the running ones are evaluated again."""
    tot = 0.0
    for s in sinyal:
        wk = w.get(s["kode"], 0.0)
        if wk <= 0:
            continue
        m = 1.0
        for x in s["mitigasi"]:
            m *= 1 - float(x.get("faktor") or 0)
        tot += wk * float(s["s"]) * m
    return tot


class _Hitung:
    """Counters of one backtest."""

    def __init__(self) -> None:
        self.n = {"normal": 0, "fraud": 0}
        self.kena = {"normal": 0, "fraud": 0}
        self.skema: dict[str, list[int]] = {}
        self.unik_rule = self.unik_kep = 0
        self.contoh: dict[str, list[str]] = {"fraud": [], "normal": [], "berubah": []}
        self.hari: set[str] = set()
        self.alert = {"sebelum": {"normal": 0, "fraud": 0}, "sesudah": {"normal": 0, "fraud": 0}}
        self.tahan = {"sebelum": 0, "sesudah": 0}
        self.berubah = {"naik": 0, "turun": 0, "fraud_naik": 0, "fraud_turun": 0}
        self.ada: dict[str, int] = {}

    def tambah(self, it: dict, hit: bool, sebelum: str, sesudah: str) -> None:
        g = "normal" if it["skenario"] == "normal" else "fraud"
        self.n[g] += 1
        if g == "normal" and it["tgl"]:
            self.hari.add(str(it["tgl"])[:10])
        if g == "fraud":
            s = self.skema.setdefault(it["skenario"], [0, 0])
            s[0] += 1
            s[1] += hit
        if hit:
            self.kena[g] += 1
            if len(self.contoh[g]) < 5:
                self.contoh[g].append(it["klaim"])
        a0, a1 = sebelum in ALERT, sesudah in ALERT
        self.alert["sebelum"][g] += a0
        self.alert["sesudah"][g] += a1
        self.tahan["sebelum"] += sebelum == "TAHAN"
        self.tahan["sesudah"] += sesudah == "TAHAN"
        if a1 and not a0:
            self.berubah["naik"] += 1
            self.berubah["fraud_naik"] += g == "fraud"
        elif a0 and not a1:
            self.berubah["turun"] += 1
            self.berubah["fraud_turun"] += g == "fraud"
        if a0 != a1 and len(self.contoh["berubah"]) < 10:
            self.contoh["berubah"].append(it["klaim"])

    def hasil(self, versi: int, data: str, t0: float, contoh_berubah: bool = False) -> dict:
        from aip.realtime.simulator import SCENARIOS

        normal, fraud = self.n["normal"], self.n["fraud"]
        kn, kf = self.kena["normal"], self.kena["fraud"]
        hari = max(1, len(self.hari))

        def blok(x: str) -> dict:
            a = self.alert[x]
            return {"alert": dict(a), "tahan": self.tahan[x], "laju_alert_normal": _r4(a["normal"] / normal) if normal else None,
                    "recall_alert": _r4(a["fraud"] / fraud) if fraud else None,
                    "precision_alert": _r4(a["fraud"] / (a["normal"] + a["fraud"])) if a["normal"] + a["fraud"] else None}
        contoh = (self.contoh["berubah"] if contoh_berubah and self.contoh["berubah"] else self.contoh["fraud"] + self.contoh["normal"])[:10]
        return {"versi": versi, "waktu": _now(), "data": data, "klaim": normal + fraud, "normal": normal, "fraud": fraud,
                "kena": {"normal": kn, "fraud": kf}, "laju_normal": _r4(kn / normal) if normal else None, "recall": _r4(kf / fraud) if fraud else None,
                "precision": _r4(kf / (kn + kf)) if kn + kf else None,
                "per_skema": [{"skema": sk, "label": (SCENARIOS.get(sk) or (sk,))[0], "n": v[0], "kena": v[1]}
                              for sk, v in sorted(self.skema.items(), key=lambda kv: (-kv[1][0], kv[0]))],
                "unik": {"fraud_baru_vs_rule": self.unik_rule, "fraud_baru_vs_keputusan": self.unik_kep},
                "beban_per_hari": round((kn + kf) / hari, 1), "hari": hari, "contoh_kode": contoh,
                "dampak": {"sebelum": blok("sebelum"), "sesudah": blok("sesudah"), "berubah": dict(self.berubah)},
                "detik": round(time.time() - t0, 1)}


def _data_teks(d: _DataUji, h: _Hitung, jenis_teks: str) -> str:
    w = d.replay.window or ((min(h.hari), max(h.hari)) if h.hari else None)
    jendela = f"aliran replay simulator {w[0]}–{w[1]}" if w else "aliran simulator"
    return (f"{jendela}: {_ribuan(h.n['normal'] + h.n['fraud'])} {jenis_teks} berlabel ({_ribuan(h.n['normal'])} normal, "
            f"{_ribuan(h.n['fraud'])} tanam)")


def _bobot_peta(eff: Efektif, cfg: dict) -> dict[str, float]:
    """Every built-in signal's weight as the engine applies it now (0 = switched off)."""
    return {k: (0.0 if k in eff.nonaktif else float(_bobot_berlaku(k, eff, cfg))) for k in MO.SIGNALS}


def _uji_kustom(rec: dict, ver: dict) -> dict:
    from aip.realtime import mesin as E

    t0 = time.time()
    try:
        ex = kompilasi(ver["kondisi"])
    except GalatAturan as e:
        raise HTTPException(400, f"kondisi tidak sah: {e}") from None
    src = _sumber_mesin()
    if ex.pakai_ref and src is None:
        raise HTTPException(409, "mesin realtime belum siap: fungsi referensi (lama rawat kode, p95 top-up, pasangan diagnosis-kode) baru tersedia "
                                 "setelah mesin memuat data; coba lagi setelah mesin siap")
    eff = _hitung_efektif()
    cfg = E.config()
    th = (float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"]))
    lain = [(a, x) for a, x in eff.aturan if a["id"] != rec["id"]]
    lama = next(((a, x) for a, x in eff.aturan if a["id"] == rec["id"]), None)
    w0 = _bobot_peta(eff, cfg)
    ganti = ver.get("menggantikan")
    # after approval: the built-in this version replaces is off; one only the running version replaced comes back on
    w1 = dict(w0)
    lama_ganti = lama[0].get("menggantikan") if lama else None
    if lama_ganti and lama_ganti != ganti and lama_ganti not in {a.get("menggantikan") for a, _ in lain} and lama_ganti not in eff.mati:
        w1[lama_ganti] = float(_bobot_berlaku(lama_ganti, eff, cfg))
    if ganti:
        w1[ganti] = 0.0
    d = _DataUji(("fkrtl",), True, src)
    h = _Hitung()
    tahu = {f: 0 for f in ex.field}
    bobot = float(ver["bobot"])
    for it in d:
        b = it["b"]
        hit = ex(b)
        for f in ex.field:
            tahu[f] += b.v.get(f) is not None
        kena_lain = [a for a, x in lain if x(b)]
        add = sum(a["bobot"] for a in kena_lain)
        before = _kontribusi(it["sinyal"], w0) + add + (lama[0]["bobot"] if lama and lama[1](b) else 0.0)
        after = _kontribusi(it["sinyal"], w1) + add + (bobot if hit else 0.0)
        h.tambah(it, hit, _putus(before, th), _putus(after, th))
        if hit and it["skenario"] != "normal":
            rule = kena_lain or any(s["kode"] not in NON_ATURAN and s["s"] > 0 and w1.get(s["kode"], 0.0) > 0 for s in it["sinyal"])
            h.unik_rule += not rule
            h.unik_kep += it["keputusan"] not in ALERT
    out = h.hasil(ver["versi"], _data_teks(d, h, "klaim FKRTL"), t0)
    n = h.n["normal"] + h.n["fraud"]
    out["cakupan"] = {f: _r4(c / n) if n else None for f, c in tahu.items()}
    out["sumber"] = {"klaim_replay": d.replay.path.name if d.replay.path else None, "klaim_dari_replay": d.n["replay"],
                     "klaim_direkonstruksi": d.n["rekonstruksi"], "tanpa_baris_fitur": d.n["tanpa_fitur"], "peserta": d.sumber_peserta,
                     "referensi": "referensi mesin (sama dengan saat klaim dinilai)" if src else "tidak tersedia (mesin belum siap)"}
    out["catatan"] = ["Klaim normal dibaca dari berkas replay (lengkap); klaim tanam dibangun ulang dari peristiwa tersimpan: lima kolom top-up "
                      "diketahui bila totalnya 0 atau nilainya tercatat di bukti sinyal top-up bawaan, selain itu kosong.",
                      "Fitur mesin dibaca dari baris fitur yang disimpan bersama peristiwa (input model), bukan dihitung ulang.",
                      "dampak: keputusan rule (PERIKSA/TAHAN) dihitung ulang dari sinyal tersimpan dengan bobot yang berlaku sekarang, "
                      "sebelum dan sesudah rule ini aktif.",
                      "Label tanam berasal dari simulator (data sintetis), bukan fraud terbukti."]
    out["peringatan"] = _peringatan(out)
    return out


def _peringatan(u: dict) -> list[str]:
    out = []
    if u["klaim"] == 0:
        out.append("tidak ada klaim berlabel di data uji")
        return out
    if u["kena"]["normal"] + u["kena"]["fraud"] == 0:
        out.append("rule tidak mengenai satu klaim pun di data uji")
    if u.get("laju_normal") and u["laju_normal"] > 0.05:
        out.append(f"rule mengenai {u['laju_normal']:.1%} klaim normal: beban telaah besar".replace(".", ","))
    if u["fraud"] and u["kena"]["fraud"] == 0 and u["kena"]["normal"] > 0:
        out.append("rule hanya mengenai klaim normal di data uji")
    for f, c in (u.get("cakupan") or {}).items():
        if c is not None and c < 0.95:
            out.append(f"field {f} hanya diketahui pada {c:.1%} klaim uji: klaim tanpa nilai dianggap tidak kena".replace(".", ","))
    return out


def _uji_bawaan(rec: dict, ver: dict) -> dict:
    from aip.realtime import mesin as E

    t0 = time.time()
    kode = rec["kode"]
    kinds = tuple(k for k in _jenis_sinyal(kode) if k != "faskes") or ("fkrtl",)
    eff = _hitung_efektif()
    cfg = E.config()
    th = (float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"]))
    w0 = _bobot_peta(eff, cfg)
    on = bool(ver["aktif"]) and kode not in eff.pengganti
    w1 = {**w0, kode: float(ver["bobot"]) if on else 0.0}
    src = _sumber_mesin()
    perlu = bool(eff.aturan) and "fkrtl" in kinds
    d = _DataUji(kinds, perlu, src)
    h = _Hitung()
    for it in d:
        fired = any(s["kode"] == kode and s["s"] > 0 for s in it["sinyal"])
        hit = fired and on
        add = sum(a["bobot"] for a, x in eff.aturan if it["b"] is not None and x(it["b"]))
        before = _kontribusi(it["sinyal"], w0) + add
        after = _kontribusi(it["sinyal"], w1) + add
        dec1 = _putus(after, th)
        h.tambah(it, hit, _putus(before, th), dec1)
        if it["skenario"] != "normal":
            if hit and not (add or any(s["kode"] != kode and s["kode"] not in NON_ATURAN and s["s"] > 0 and w1.get(s["kode"], 0.0) > 0
                                       for s in it["sinyal"])):
                h.unik_rule += 1
            h.unik_kep += dec1 in ALERT and it["keputusan"] not in ALERT
    jenis_teks = "peristiwa " + "/".join({"fkrtl": "FKRTL", "fktp": "FKTP", "nonkap": "nonkapitasi"}[k] for k in kinds)
    out = h.hasil(ver["versi"], _data_teks(d, h, jenis_teks), t0, contoh_berubah=True)
    out["cakupan"] = {}
    out["sumber"] = {"peristiwa": list(kinds)}
    out["catatan"] = [f"kena = peristiwa yang memunculkan sinyal {kode} (tersimpan) dengan pengaturan ini; dimatikan berarti 0.",
                      "dampak: keputusan rule dihitung ulang dari sinyal tersimpan, dengan bobot berlaku sekarang (sebelum) dan dengan perubahan ini (sesudah).",
                      "unik.fraud_baru_vs_keputusan: klaim tanam yang ber-alert sesudah perubahan padahal keputusan tersimpannya LOLOS.",
                      "Label tanam berasal dari simulator (data sintetis), bukan fraud terbukti."]
    if "faskes" in _jenis_sinyal(kode):
        out["catatan"].append("Pemantauan periodik faskes tidak berlabel: tidak ikut diuji.")
    if kode in eff.pengganti and ver["aktif"]:
        out["catatan"].append(f"Sinyal ini sedang digantikan rule kustom {', '.join(eff.pengganti[kode])}: tetap mati selama rule itu berjalan.")
    out["peringatan"] = [] if out["klaim"] else ["tidak ada peristiwa berlabel untuk sinyal ini di data uji"]
    return out


def uji(jenis: str, kunci: str, oleh: str) -> dict:
    if not _UJI_LOCK.acquire(timeout=90):
        raise HTTPException(429, "uji lain sedang berjalan: coba lagi sebentar")
    try:
        rec = _rec(jenis, kunci)
        ver = _ver(rec)
        u = _uji_kustom(rec, ver) if jenis == "kustom" else _uji_bawaan(rec, ver)
        with _LOCK:
            rec = _rec(jenis, kunci)
            if rec["versi"] != ver["versi"]:
                raise HTTPException(409, "aturan diubah selama uji berjalan: uji lagi versi terbaru")
            _ver(rec)["uji"] = u
            if rec["status"] in (DRAF, DIUJI):
                if rec["status"] == DRAF:
                    _riwayat(rec, DIUJI, oleh, f"uji: kena {u['kena']['fraud']} tanam, {u['kena']['normal']} normal")
                else:
                    rec["diubah_oleh"], rec["diubah"] = oleh, _now()
            _simpan(rec)
            _log(oleh, "uji", jenis, kunci, ver["versi"], f"recall {u['recall']}, precision {u['precision']}, laju_normal {u['laju_normal']}")
        return u
    finally:
        _UJI_LOCK.release()


# =====================================================================================================================
# AI assistance (OpenRouter, DeepSeek V4.1 Flash)
# =====================================================================================================================
AI_URL = "https://openrouter.ai/api/v1/chat/completions"
AI_MODEL = "deepseek/deepseek-v4.1-flash"
AI_HARGA = (0.15, 0.60)  # USD per million tokens (input, output): list prices, upper bounds for the worst-case check
AI_BATAS_USD = 0.02  # worst case of one call
AI_MAX_TOKENS = 2000
AI_TIMEOUT = 90.0


def _kunci_ai() -> str:
    v = os.environ.get("OPENROUTER_API_KEY")
    if v and v.strip():
        return v.strip()
    try:
        from mailer import env

        return env("OPENROUTER_API_KEY")
    except Exception:  # noqa: BLE001 - no key: the AI is not configured
        return ""


def _http_post(url: str, headers: dict, body: dict, timeout: float) -> tuple[int, Any]:
    """One HTTP call (replaced in tests). Never logs the headers."""
    import httpx

    r = httpx.post(url, headers=headers, json=body, timeout=timeout)
    try:
        data = r.json()
    except ValueError:
        data = None
    return r.status_code, data


def _panggil_ai(messages: list[dict]) -> tuple[str, float]:
    key = _kunci_ai()
    if not key:
        raise HTTPException(503, "asisten AI belum dikonfigurasi di server (kunci OpenRouter tidak ada)")
    terburuk = len(json.dumps(messages, ensure_ascii=False)) / 3 * AI_HARGA[0] / 1e6 + AI_MAX_TOKENS * AI_HARGA[1] / 1e6
    if terburuk > AI_BATAS_USD:
        raise HTTPException(413, "permintaan terlalu panjang untuk asisten AI")
    body: dict[str, Any] = {"model": AI_MODEL, "messages": messages, "temperature": 0.1, "max_tokens": AI_MAX_TOKENS,
                            "reasoning": {"effort": "low"}, "provider": {"data_collection": "deny", "allow_fallbacks": True},
                            "usage": {"include": True}, "response_format": {"type": "json_object"}}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Title": "AI JKN Synthetic rule engine"}
    last = "?"
    for attempt in range(3):
        try:
            status, data = _http_post(AI_URL, headers, body, AI_TIMEOUT)
        except Exception as e:  # noqa: BLE001 - network: try again
            last = type(e).__name__
            time.sleep(1.5 * (attempt + 1))
            continue
        if status in (429, 500, 502, 503, 504):
            last = f"HTTP {status}"
            time.sleep(2 * (attempt + 1))
            continue
        if status == 400 and "response_format" in body:
            body.pop("response_format")  # a provider without JSON mode: the prompt asks for JSON anyway
            continue
        if status != 200 or not isinstance(data, dict):
            raise HTTPException(502, f"asisten AI menolak permintaan (HTTP {status})")
        msg = ((data.get("choices") or [{}])[0].get("message") or {})
        teks = msg.get("content") or ""
        if not teks.strip() and isinstance(msg.get("reasoning"), str) and "{" in msg["reasoning"]:
            teks = msg["reasoning"]
        usd = float((data.get("usage") or {}).get("cost") or 0.0)
        return teks, usd
    raise HTTPException(502, f"asisten AI tidak menjawab ({last})")


def _json_dari(teks: str) -> Optional[dict]:
    if not teks:
        return None
    teks = re.sub(r"<think>.*?</think>", "", teks, flags=re.S)
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", teks, re.S)
    cand = m.group(1) if m else None
    if cand is None:
        a, b = teks.find("{"), teks.rfind("}")
        cand = teks[a:b + 1] if a >= 0 and b > a else None
    if not cand:
        return None
    for c in (cand, re.sub(r",\s*([}\]])", r"\1", cand)):
        try:
            v = json.loads(c)
            return v if isinstance(v, dict) else None
        except ValueError:
            continue
    return None


def _prompt_sistem() -> str:
    from aip import semantik as S
    from aip.realtime import mesin as E

    cfg = E.config()
    tp, tt = float(cfg["ambang_periksa"]), float(cfg["ambang_tahan"])
    sp, st = -math.log(1 - tp / 100), -math.log(1 - tt / 100)
    fields = "\n".join(f"- {k} | {v[0]} | {v[1]} | {v[2]}" for k, v in FIELDS.items())
    fungsi = "\n".join(f"- {k}({v['argumen']}) -> {v['jenis']}: {v['deskripsi']}" for k, v in FUNGSI.items())
    modus = "\n".join(f"- {m['id']}: {m['nama']}" for m in S.MODUS_PERMENKES)
    sinyal = "\n".join(f"- {k} | {MO.SIGNALS[k][3]} | {','.join(MO.SIGNALS[k][0]) or '-'} | {MO.SIGNALS[k][2]}" for k in MO.SIGNALS if k in _FKRTL_SIG)
    contoh = "\n".join(f"- {c}" for c in CONTOH)
    return f"""Kamu membantu tim anti-fraud BPJS Kesehatan menulis rule untuk mesin fraud realtime (data sintetis). Ubah permintaan dalam bahasa
sehari-hari menjadi SATU rule. Rule dinilai pada setiap klaim FKRTL (rumah sakit/klinik utama); bila kondisinya benar, rule memunculkan sinyal
dengan bobotnya ke skor rule klaim itu.

BAHASA KONDISI
- Ekspresi boolean mirip Python: and, or, not; == != < <= > >= in, not in; + - * /; angka, teks "..." dan list [...]; nama field dari KATALOG;
  fungsi dari daftar FUNGSI (argumen hanya teks konstanta, mis. p95_topup("sd_tarif_rp")).
- Dilarang: atribut (a.b), indeks (a[0]), lambda, comprehension, if-else, import, None, operator ** % //.
- Nilai yang tidak tercatat = kosong: perbandingan dengan nilai kosong selalu salah, aritmetika dengan nilai kosong menghasilkan kosong.
  Untuk memeriksa nilai kosong pakai kosong("field").
- Teks dibandingkan persis (huruf besar/kecil berpengaruh): pakai nilai contoh di katalog. Rentang ICD-10: dx_primer_icd3 >= "O00" and
  dx_primer_icd3 <= "O99". Tanggal dibandingkan dengan "YYYY-MM-DD". Hasil akhir harus benar/salah. Maksimal {MAX_PANJANG} karakter.
- "kode itu" / "kodenya" berarti kode INA-CBG klaim itu sendiri: fungsi referensi tanpa argumen kode memakai kode klaim.

KATALOG FIELD (nama | jenis | sumber | arti)
{fields}

FUNGSI
{fungsi}

CONTOH KONDISI
{contoh}

MODUS FRAUD PERMENKES 16/2019
{modus}

SINYAL RULE BAWAAN PADA KLAIM FKRTL (kode | label | modus | bobot bawaan), untuk sinyal("KODE") dan menggantikan
{sinyal}

BOBOT: skor rule = 100 x (1 - e^(-jumlah bobot sinyal)). PERIKSA mulai skor {tp:.0f} (jumlah bobot {sp:.2f}), TAHAN mulai skor {tt:.0f}
(jumlah bobot {st:.2f}). Rule bawaan berbobot 0,2-1,6. Pilih 0,3-0,6 untuk sinyal lemah, 0,8-1,2 untuk sinyal kuat; batas {BOBOT_MIN}-{BOBOT_MAX}.

JAWABAN: hanya satu objek JSON, tanpa teks lain:
{{"aksi": "aturan_baru", "kode": "KODE_RULE", "label": "...", "deskripsi": "...", "kondisi": "...", "modus": ["M07"], "bobot": 0.8,
  "menggantikan": null, "parameter": null, "penjelasan": "...", "peringatan": ["..."]}}
- kode: huruf besar, angka, garis bawah; 3-40 karakter; diawali huruf; tidak sama dengan kode sinyal bawaan.
- label: ringkas (maksimal 80 karakter), bahasa Indonesia; istilah teknis yang lazim tetap bahasa Inggris (top-up, upcoding, readmission).
- deskripsi: satu-dua kalimat tentang apa yang ditandai.
- modus: kode modus Permenkes yang paling sesuai (boleh lebih dari satu, boleh kosong).
- penjelasan: 1-3 kalimat untuk auditor: bagaimana kondisi menerjemahkan permintaan dan kenapa bobotnya begitu.
- peringatan: asumsi atau batasan (mis. ambang dipilih sendiri, field yang sering kosong); boleh [].
Jangan mengarang field atau fungsi di luar daftar."""


def _konteks_aturan(rec: dict) -> dict:
    v = _ver(rec)
    return {"kode": rec["kode"], "versi": rec["versi"], "label": v["label"], "deskripsi": v.get("deskripsi") or "", "kondisi": v["kondisi"],
            "modus": v.get("modus") or [], "bobot": v["bobot"], "menggantikan": v.get("menggantikan"), "aktif": rec.get("versi_aktif") is not None}


def _kode_bebas(kode: str, rid: Optional[str]) -> str:
    kode = re.sub(r"[^A-Z0-9_]", "_", (kode or "").upper()).strip("_")
    kode = re.sub(r"_+", "_", kode)
    if not kode or not kode[0].isalpha():
        kode = "K_" + kode
    kode = kode[:36]
    if len(kode) < 3:
        kode = (kode + "_RULE")[:36]
    dipakai = {r["kode"] for r in _semua("kustom") if r["id"] != rid} | set(MO.SIGNALS)
    base, n = kode, 2
    while kode in dipakai:
        kode = f"{base[:33]}_{n}"
        n += 1
    return kode


def _rapikan(obj: dict, mode: str, ctx: dict) -> dict:
    """The AI's answer as a Draf, checked; raises GalatAturan with what to fix."""
    peringatan = [str(x)[:300] for x in (obj.get("peringatan") or []) if str(x).strip()][:6] if isinstance(obj.get("peringatan"), list) else []
    aksi = obj.get("aksi") if obj.get("aksi") in ("aturan_baru", "ubah_parameter") else "aturan_baru"
    if mode != "edit_bawaan":
        aksi = "aturan_baru"
    valid_modus = {m["kode"] for m in katalog()["modus"]}
    modus = [str(x).strip().upper() for x in (obj.get("modus") or []) if str(x).strip().upper() in valid_modus][:5] \
        if isinstance(obj.get("modus"), list) else []
    out = {"aksi": aksi, "penjelasan": str(obj.get("penjelasan") or "").strip()[:1500], "peringatan": peringatan, "parameter": None,
           "menggantikan": None, "field_dipakai": [], "fungsi_dipakai": []}
    if aksi == "ubah_parameter":
        p = obj.get("parameter") if isinstance(obj.get("parameter"), dict) else {}
        par: dict[str, Any] = {}
        if isinstance(p.get("aktif"), bool):
            par["aktif"] = p["aktif"]
        if p.get("bobot") is not None:
            try:
                w = float(p["bobot"])
            except (TypeError, ValueError):
                raise GalatAturan("parameter.bobot harus angka") from None
            if not BOBOT_MIN <= w <= BOBOT_MAX:
                raise GalatAturan(f"parameter.bobot harus {BOBOT_MIN}-{BOBOT_MAX}")
            par["bobot"] = round(w, 3)
        if not par:
            raise GalatAturan('ubah_parameter butuh parameter {"aktif": true/false} dan/atau {"bobot": angka}')
        b = ctx["bawaan"]
        out.update(kode=b["kode"], label=b["label"], deskripsi=b["deskripsi"], kondisi="", modus=list(b["modus"]),
                   bobot=par.get("bobot", b["bobot"]), parameter=par)
        return out
    ex = kompilasi(obj.get("kondisi"))
    try:
        bobot = float(obj.get("bobot"))
    except (TypeError, ValueError):
        raise GalatAturan("bobot harus angka") from None
    if not math.isfinite(bobot):
        raise GalatAturan("bobot harus angka")
    if not 0.1 <= bobot <= 2.0:
        peringatan.append(f"bobot {bobot:g} dari AI disesuaikan ke rentang 0,1-2,0")
        bobot = min(2.0, max(0.1, bobot))
    label = str(obj.get("label") or "").strip()[:80]
    if mode in ("edit_kustom", "perbaiki"):
        kode = ctx["aturan"]["kode"]
        ganti = obj.get("menggantikan") if obj.get("menggantikan") is not None else ctx["aturan"].get("menggantikan")
    elif mode == "edit_bawaan":
        kode = str(obj.get("kode") or "").strip().upper()
        if kode == ctx["bawaan"]["kode"]:
            kode += "_KUSTOM"
        kode = _kode_bebas(kode or ctx["bawaan"]["kode"] + "_KUSTOM", None)
        ganti = ctx["bawaan"]["kode"]
    else:
        kode = _kode_bebas(str(obj.get("kode") or label or "RULE_KUSTOM"), None)
        ganti = obj.get("menggantikan")
    if ganti is not None:
        ganti = str(ganti).strip().upper()
        if ganti in ("", "NULL", "NONE", "-"):
            ganti = None
        elif ganti not in _FKRTL_SIG:
            raise GalatAturan(f"menggantikan harus kode sinyal bawaan klaim FKRTL atau null, bukan {ganti}")
    if not modus and ganti:
        modus = list(MO.SIGNALS[ganti][0])
    if len(label) < 3:
        label = kode.replace("_", " ").title()[:80]
    out.update(kode=kode, label=label, deskripsi=str(obj.get("deskripsi") or "").strip()[:500], kondisi=ex.teks, modus=modus,
               bobot=round(bobot, 3), menggantikan=ganti, field_dipakai=ex.field, fungsi_dipakai=ex.fungsi)
    if ex.pakai_ref and _sumber_mesin() is None:
        out["peringatan"].append("rule memakai fungsi referensi: uji baru bisa dijalankan setelah mesin realtime siap")
    return out


def _ai(mode: str, user: str, ctx: dict) -> dict:
    messages = [{"role": "system", "content": _prompt_sistem()}, {"role": "user", "content": user}]
    biaya = 0.0
    galat = None
    for attempt in range(2):
        try:
            teks, usd = _panggil_ai(messages)
        except HTTPException as e:
            if attempt == 0:
                raise
            galat = f"perbaikan kedua gagal: {e.detail}"
            break
        biaya += usd
        obj = _json_dari(teks)
        try:
            if obj is None:
                raise GalatAturan("jawaban bukan satu objek JSON")
            d = _rapikan(obj, mode, ctx)
            d.update(valid=True, error=None, biaya_usd=round(biaya, 6))
            if mode in ("edit_kustom", "edit_bawaan", "perbaiki"):
                d["perubahan"] = str(obj.get("perubahan") or "").strip()[:1000] or _beda(ctx, d)
            return d
        except GalatAturan as e:
            galat = str(e)
            messages += [{"role": "assistant", "content": (teks or "")[:4000]},
                         {"role": "user", "content": f"Jawaban itu tidak sah: {galat}. Perbaiki dan kirim ulang objek JSON lengkap saja."}]
    return {"aksi": "aturan_baru", "kode": None, "label": None, "deskripsi": None, "kondisi": None, "modus": [], "bobot": None, "menggantikan": None,
            "parameter": None, "penjelasan": "", "field_dipakai": [], "fungsi_dipakai": [], "peringatan": [], "valid": False, "error": galat,
            "biaya_usd": round(biaya, 6), **({"perubahan": ""} if mode != "draf" else {})}


def _beda(ctx: dict, d: dict) -> str:
    a = ctx.get("aturan") or ctx.get("bawaan") or {}
    parts = []
    if d.get("parameter"):
        for k, v in d["parameter"].items():
            parts.append(f"{k}: {a.get(k)} -> {v}")
    else:
        if a.get("kondisi") != d.get("kondisi"):
            parts.append("kondisi diubah")
        if a.get("bobot") != d.get("bobot"):
            parts.append(f"bobot {a.get('bobot')} -> {d.get('bobot')}")
    return "; ".join(parts) or "tidak ada perubahan berarti"


def ai_draf(teks: str) -> dict:
    return _ai("draf", f"Permintaan rule baru: {teks.strip()}", {})


def ai_edit(teks: str, rid: Optional[str] = None, kode_bawaan: Optional[str] = None) -> dict:
    if bool(rid) == bool(kode_bawaan):
        raise HTTPException(400, "isi salah satu: id (rule kustom) atau kode_bawaan")
    if rid:
        rec = _rec("kustom", rid)
        a = _konteks_aturan(rec)
        user = (f"Rule kustom yang diubah:\n{json.dumps(a, ensure_ascii=False)}\nPermintaan perubahan: {teks.strip()}\n"
                f'Kembalikan rule lengkap versi baru (aksi "aturan_baru", kode tetap "{a["kode"]}") dan tambahkan field "perubahan": ringkasan '
                "perubahan dalam satu kalimat.")
        d = _ai("edit_kustom", user, {"aturan": a})
        d["sebelum"] = {"kondisi": a["kondisi"], "bobot": a["bobot"], "aktif": a["aktif"]}
        return d
    kode = str(kode_bawaan).strip().upper()
    if kode not in MO.SIGNALS:
        raise HTTPException(404, f"rule bawaan tidak dikenal: {kode}")
    st = _status_bawaan(kode)
    modes, _, w0, label = MO.SIGNALS[kode]
    b = {"kode": kode, "label": label, "deskripsi": DESKRIPSI_BAWAAN.get(kode, label), "modus": list(modes), "bobot_default": w0, "bobot": st["bobot"],
         "aktif": st["aktif"], "berlaku_untuk": _jenis_sinyal(kode)}
    user = (f"Rule bawaan yang diubah (logikanya ada di kode Python, tidak bisa diubah langsung):\n{json.dumps(b, ensure_ascii=False)}\n"
            f"Permintaan: {teks.strip()}\n"
            'Pilih salah satu: (1) aksi "ubah_parameter" bila cukup menyalakan/mematikan atau mengubah bobot: parameter {"aktif": true/false, '
            '"bobot": angka}, kondisi "", kode = kode rule bawaan; atau (2) aksi "aturan_baru": rule kustom pengganti dengan kode baru dan '
            f'"menggantikan": "{kode}" (rule bawaan dimatikan saat pengganti aktif). Tambahkan field "perubahan": ringkasan dalam satu kalimat.')
    if "fkrtl" not in b["berlaku_untuk"]:
        user += '\nRule ini bukan untuk klaim FKRTL: hanya aksi "ubah_parameter" yang mungkin.'
    d = _ai("edit_bawaan", user, {"bawaan": b})
    if d.get("valid") and d["aksi"] == "aturan_baru" and "fkrtl" not in b["berlaku_untuk"]:
        d.update(valid=False, error=f"{kode} bukan sinyal klaim FKRTL: hanya bobot atau aktif yang bisa diubah")
    d["sebelum"] = {"kondisi": None, "bobot": st["bobot"], "aktif": st["aktif"]}
    return d


def ai_perbaiki(rid: str) -> dict:
    rec = _rec("kustom", rid)
    a = _konteks_aturan(rec)
    u = _ver(rec).get("uji")
    if not u:
        raise HTTPException(409, "belum ada uji untuk versi ini: jalankan uji dulu, lalu minta perbaikan")
    agregat = {k: u.get(k) for k in ("klaim", "normal", "fraud", "kena", "laju_normal", "recall", "precision", "per_skema", "unik", "beban_per_hari",
                                      "dampak", "cakupan", "peringatan")}
    user = (f"Rule kustom:\n{json.dumps(a, ensure_ascii=False)}\nHasil uji terakhir pada data sintetis berlabel (agregat, tanpa baris klaim):\n"
            f"{json.dumps(agregat, ensure_ascii=False)}\n"
            "Perbaiki rule: naikkan precision dan turunkan laju_normal tanpa banyak kehilangan recall; bila recall 0, longgarkan kondisi agar "
            f'mengenai skema yang dituju. Kembalikan rule lengkap (aksi "aturan_baru", kode tetap "{a["kode"]}") dan field "perubahan": '
            "ringkasan perubahan dalam satu kalimat.")
    d = _ai("perbaiki", user, {"aturan": a})
    d["sebelum"] = {"kondisi": a["kondisi"], "bobot": a["bobot"], "aktif": a["aktif"]}
    return d
