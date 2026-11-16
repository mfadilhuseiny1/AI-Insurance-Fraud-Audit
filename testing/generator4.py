"""Generator 4: an independent fourth synthetic FKRTL claim generator for ML v7's final out-of-distribution test (synthetic data only).

WRITTEN BLIND
-------------
This module was written without seeing the model under test, its features, its training or evaluation code, the realtime
rule engine, any analysis of what the model misses, the criteria files, or the fraud-injection code of generators 1-3
(for generator 3 only its scheme NAMES were listed, to avoid reusing them). Every fraud mechanic here was designed from
the JKN fraud typology (Permenkes 36/2015 and 16/2019) and from what dishonest hospitals, doctors and members plausibly do,
with parameters fixed from claim volumes alone, before any end-to-end run. Nothing was tuned against a detector.

NORMAL CLAIMS
-------------
The normal-claim world is generator 3's fitted world, imported and used as is (testing/generator3.py: `dunia()`,
`_populasi`, `episode`, `_klaim`, the journey and episode helpers): semi-Markov member journeys from 2024 silver history,
episode-level clinical derivation, tariffs from the real INA-CBG tariff table. Generator 4 changes two things only:
1. Members are split into the 8 chunks by its own hash (seed GEN4_GARAM), and training/validation members (bersih.peran
   'latih' / 'validasi') and the runner's `kecuali` are excluded. The pool is generator 3's (roles uji_c / gen2_baru,
   without the replay stream's and data v2's members).
2. None of generator 3's fraud or quality steps run. All fraud below is generator 4's own.

FRAUD: 20 schemes in five families
----------------------------------
Who commits it: mostly hospitals acting on their own claims (a fixed set of dishonest hospitals, chosen once per seed,
running a scheme on a share of their eligible claims in every chunk), plus scattered single acts by many hospitals,
same-owner hospital pairs, one operator working at three hospitals, a patient broker, and members (deceased member's card,
duplicate enrolment, drug collecting). Subtlety varies: some schemes move a claim one severity level or one class up;
others are blatant (septicemia coded on a short stay, ventilator >= 96 h on a 2-day stay, a cluster of elderly strangers).

  name                      family     mode  who (rate)                              ~/chunk  mechanic (one line)
  komorbid_titipan          koding     M01   12 hospitals (60 %)                       8     +1-3 padded secondary dx, severity one level up (I->II, II->III; 12 % I->III)
  sepsis_dikodekan          koding     M01   2 hospitals (50 %) + scattered (7 %)      3.5   infection admission recoded as septicemia A41 (A-4-10/14, II/III); admission dx kept
  tindakan_ditempel_ri      koding     M16   5 hospitals (35 %) + scattered (1.2 %)    3     medical admission lifted into a procedural CBG of the same CMG; procedure not done
  rajal_naik_prosedur       koding     M11   4 hospitals (15 %)                        5     outpatient consult (case type 5) billed as a significant outpatient procedure (type 3)
  rawat_inap_ringan         koding     M13   5 hospitals (30 %) + scattered (0.6 %)    8.5   outpatient-type complaint (fever, back pain, dyspepsia, URTI, vertigo...) admitted 1-3 days
  kelas_penuh_dalih         tagihan    M09   6 hospitals (50 %, x1.5 on 24-27 Dec)     6     class 3/2 entitlement billed one class higher ("the ward was full")
  mri_ditagihkan            tagihan    M16   3 hospitals (25 %) + scattered (0.15 %)   3     MRI special-investigation top-up (+ MRI line) on neuro/ortho/rehab/surgery outpatient visits
  jam_ventilator_digenapkan tagihan    M14   scattered (50 % of 9671 claims)           2     ventilation < 96 h (9671) billed as >= 96 h (9672) -> J-1-02; LOS stretched (70 %) or not
  kemo_batal_ditagih        tagihan    M10   scattered (70 % of due cycles)            3     a chemo/radiotherapy cycle that did not take place billed for a patient in active treatment
  poli_dipecah_sehari       episode    M05   4 general hospitals (18 %)                3.5   one outpatient visit split: a second claim the same day at another clinic of the hospital
  pindah_ruang_jadi_admisi  episode    M05   5 hospitals (60 % of stays >= 3 d)        6     ward transfer billed as discharge + new admission the same day (both claims labelled)
  kontrol_tambahan          episode    M11   6 hospitals (25 % of regular patients)    3     an unnecessary control visit 4-9 days later for the hospital's own regular patients
  admisi_ulang_kronis       episode    M17   3 hospitals (60 %) + scattered (12 %)     1     chronic patient readmitted 4-12 days after discharge (in the window or just before it)
  kartu_almarhum            identitas  M21   members, 4-6 per chunk                    5     a deceased member's card used by a relative (clinical content fits the relative's age/sex)
  nik_ganda_bergantian      identitas  M21   members, 3-5 per chunk                    4     duplicate enrolment: a second ID (same sex, kab, age +-2 y) carries an early repeat visit
  obat_lintas_rs            identitas  M26   members, 2-3 per chunk                    4.5   drug collecting: 2-3 extra outpatient visits at other hospitals within days, same chronic dx
  resume_disalin            identitas  M02   4 busy hospitals (one 3-day block)        4     cloning: the priciest outpatient record of a few days copied onto 2-4 other patients
  calo_katarak              jaringan   M18   broker + 2 eye hospitals (85 % chunks)    9     6-10 elderly from one kab brought to a distant hospital for cataract surgery; 30 % 2nd eye
  rs_satu_pemilik           jaringan   M06   3 same-owner pairs (60 % of stays >= 2 d) 6     patient discharged "Rujuk" from A after 1-2 days, admitted at sister B the same day (both)
  operator_dua_rs           jaringan   M04   1 operator at 3 hospitals                 1     orthopaedic operator: hip/knee implant top-ups, admissions -> procedures, visits -> injections

Fraud is about 1.6-2.0 % of a chunk (chunks 0-3 of seed gen4-v1: 1.65-1.92 %, mean 1.78 %): about 60 % from the ~70 dishonest
hospitals' systematic schemes, 20 % scattered single acts, 15 % member acts.

Mode codes are this module's own numbering (MODUS4): Permenkes 36/2015 Pasal 3 (5) FKRTL items a-t = M01-M20, Pasal 3 (2)
member items a-g = M21-M27. A claim carries at most one scheme. Where a scheme alters an existing claim, that claim is
labelled; where it adds a claim, the added claim is labelled (and, for splits and transfers, the shortened first claim
too). The name pulang_dini is not used (reserved downstream for a quality issue).

Interface (for testing/uji_gen2.py with GEN4=1): buat(c, kecuali) -> chunk c's claims (KlaimIn fields + _sk, _varian,
_m, _urut); N_CHUNK, SPECIALS, BARU, kecuali_latih(); SKEMA4, MODUS4, PARAM4; adalah_fraud(sk).
CLI:  python testing/generator4.py contoh <c>   one chunk: counts per scheme and family, fraud share, KlaimIn validation
"""
from __future__ import annotations

import copy
import hashlib
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import bersih  # noqa: E402
import generator3 as G3  # noqa: E402  (the normal-claim world only)

N_CHUNK = 8
BARU = True
SPECIALS = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
GARAM = os.environ.get("GEN4_GARAM") or "gen4-v1"
W0, W1, NDAY = G3.W0, G3.W1, G3.NDAY
PUNCAK = {date(2024, 12, 24), date(2024, 12, 25), date(2024, 12, 26), date(2024, 12, 27)}  # Christmas / cuti bersama peak

# ------------------------------------------------------------------------------------------------------------------
# modes, schemes, parameters (fixed before any end-to-end run, from claim volumes only)
# ------------------------------------------------------------------------------------------------------------------
MODUS4 = {
    "M01": "FKRTL a: penulisan kode diagnosis yang berlebihan (upcoding)",
    "M02": "FKRTL b: penjiplakan klaim dari pasien lain (cloning)",
    "M03": "FKRTL c: klaim palsu (phantom billing)",
    "M04": "FKRTL d: penggelembungan tagihan obat dan alkes (inflated bills)",
    "M05": "FKRTL e: pemecahan episode pelayanan (services unbundling or fragmentation)",
    "M06": "FKRTL f: rujukan semu (self-referral)",
    "M07": "FKRTL g: tagihan berulang (repeat billing)",
    "M08": "FKRTL h: memperpanjang lama perawatan (prolonged length of stay)",
    "M09": "FKRTL i: memanipulasi kelas perawatan (type of room charge)",
    "M10": "FKRTL j: membatalkan tindakan yang wajib dilakukan (cancelled services)",
    "M11": "FKRTL k: melakukan tindakan yang tidak perlu (no medical value)",
    "M12": "FKRTL l: penyimpangan terhadap standar pelayanan (standard of care)",
    "M13": "FKRTL m: tindakan pengobatan yang tidak sesuai dengan indikasi (unnecessary treatment)",
    "M14": "FKRTL n: menambah panjang waktu penggunaan ventilator",
    "M15": "FKRTL o: tidak melakukan visitasi yang seharusnya (phantom visit)",
    "M16": "FKRTL p: tidak melakukan prosedur yang seharusnya (phantom procedures)",
    "M17": "FKRTL q: admisi yang berulang (readmisi)",
    "M18": "FKRTL r: rujukan pasien yang tidak sesuai dengan tujuan untuk memperoleh keuntungan tertentu",
    "M19": "FKRTL s: meminta cost sharing tidak sesuai ketentuan",
    "M20": "FKRTL t: tindakan kecurangan JKN lainnya",
    "M21": "Peserta a: pernyataan tidak benar dalam hal eligibilitas (status kepesertaan)",
    "M22": "Peserta b: memanfaatkan hak untuk pelayanan yang tidak perlu dengan memalsukan kondisi kesehatan",
    "M23": "Peserta c: gratifikasi kepada pemberi pelayanan",
    "M24": "Peserta d: memanipulasi penghasilan",
    "M25": "Peserta e: kerja sama dengan pemberi pelayanan untuk mengajukan klaim palsu",
    "M26": "Peserta f: memperoleh obat dan/atau alat kesehatan yang diresepkan untuk dijual kembali",
    "M27": "Peserta g: tindakan kecurangan JKN lainnya",
}

SKEMA4: dict[str, dict[str, Any]] = {
    # koding / klinis
    "komorbid_titipan": {"famili": "koding", "mode": "M01", "pelaku": "rumah sakit", "kehalusan": "halus",
                         "deskripsi": "Padded secondary diagnoses (anaemia, hypokalaemia, hypoalbuminaemia...) lift the INA-CBG severity one level; LOS and care unchanged."},
    "sepsis_dikodekan": {"famili": "koding", "mode": "M01", "pelaku": "rumah sakit + sebaran", "kehalusan": "kasar",
                         "deskripsi": "A local infection admission (pneumonia, diarrhoea, UTI, cellulitis, typhoid...) is coded as septicemia A41 (A-4-10/A-4-14, severity II/III); the admission diagnosis still names the local infection."},
    "tindakan_ditempel_ri": {"famili": "koding", "mode": "M16", "pelaku": "rumah sakit + sebaran", "kehalusan": "sedang",
                             "deskripsi": "A medical admission (case type 4) gets a procedure that was not done, which groups it into a procedural CBG (case type 1) of the same CMG."},
    "rajal_naik_prosedur": {"famili": "koding", "mode": "M11", "pelaku": "rumah sakit", "kehalusan": "halus",
                            "deskripsi": "An outpatient consultation (case type 5) is billed as a significant outpatient procedure (case type 3: nebulisation, echo, USG, injection...)."},
    "rawat_inap_ringan": {"famili": "koding", "mode": "M13", "pelaku": "rumah sakit + sebaran", "kehalusan": "sedang",
                          "deskripsi": "An outpatient-type complaint (fever, back pain, abdominal pain, dyspepsia, URTI, vertigo, hypertension) is admitted for 1-3 days instead of treated as an outpatient."},
    # tagihan
    "kelas_penuh_dalih": {"famili": "tagihan", "mode": "M09", "pelaku": "rumah sakit", "kehalusan": "halus",
                          "deskripsi": "A class-3/class-2 entitled patient is billed one class higher (\"the entitled ward was full\"), more often over the Christmas peak."},
    "mri_ditagihkan": {"famili": "tagihan", "mode": "M16", "pelaku": "rumah sakit + sebaran", "kehalusan": "sedang",
                       "deskripsi": "An MRI special-investigation top-up (and an MRI procedure line) is billed on neurology/orthopaedic/rehabilitation/surgery outpatient visits without the scan."},
    "jam_ventilator_digenapkan": {"famili": "tagihan", "mode": "M14", "pelaku": "sebaran", "kehalusan": "kasar",
                                  "deskripsi": "Ventilation under 96 hours (9671) is billed as 96 hours or more (9672), regrouping into long-term ventilation J-1-02; a short stay is stretched to fit (70 %) or left as is."},
    "kemo_batal_ditagih": {"famili": "tagihan", "mode": "M10", "pelaku": "sebaran", "kehalusan": "sedang",
                           "deskripsi": "A patient in active chemotherapy/radiotherapy misses (or is deferred from) a scheduled cycle; the hospital bills the session anyway, copied from the last one."},
    # episode
    "poli_dipecah_sehari": {"famili": "episode", "mode": "M05", "pelaku": "rumah sakit", "kehalusan": "halus",
                            "deskripsi": "One outpatient visit is split: a second claim the same day at another clinic of the same hospital, for another of the patient's conditions."},
    "pindah_ruang_jadi_admisi": {"famili": "episode", "mode": "M05", "pelaku": "rumah sakit", "kehalusan": "sedang",
                                 "deskripsi": "An internal ward/department transfer is billed as a discharge and a new admission the same day, so one stay earns two CBGs."},
    "kontrol_tambahan": {"famili": "episode", "mode": "M11", "pelaku": "rumah sakit", "kehalusan": "halus",
                         "deskripsi": "The hospital's own regular patients are called back for a control visit 4-9 days later that has no medical need."},
    "admisi_ulang_kronis": {"famili": "episode", "mode": "M17", "pelaku": "rumah sakit + sebaran", "kehalusan": "sedang",
                            "deskripsi": "A chronic patient (heart failure, COPD, CKD, diabetes, stroke, TB...) is readmitted 4-12 days after discharge for the same diagnosis (revolving door); the first admission may be just before the window."},
    # identitas
    "kartu_almarhum": {"famili": "identitas", "mode": "M21", "pelaku": "peserta", "kehalusan": "kasar",
                       "deskripsi": "A deceased member's card is used by a relative; the clinical content fits the relative's age and sex, not the card holder's."},
    "nik_ganda_bergantian": {"famili": "identitas", "mode": "M21", "pelaku": "peserta", "kehalusan": "halus",
                             "deskripsi": "Duplicate enrolment: a second member ID of the same sex, kab and age (+-2 y) carries an early repeat visit that the first ID could not claim."},
    "obat_lintas_rs": {"famili": "identitas", "mode": "M26", "pelaku": "peserta", "kehalusan": "sedang",
                       "deskripsi": "A member collects drugs for resale: 2-3 extra outpatient visits at other hospitals within a few days for the same chronic diagnosis."},
    "resume_disalin": {"famili": "identitas", "mode": "M02", "pelaku": "rumah sakit", "kehalusan": "sedang",
                       "deskripsi": "Cloning: a hospital copies the most expensive outpatient record of a few days (diagnosis, code, procedures, top-ups) onto 2-4 other patients of those days."},
    # jaringan
    "calo_katarak": {"famili": "jaringan", "mode": "M18", "pelaku": "calo + rumah sakit", "kehalusan": "sedang",
                     "deskripsi": "A broker brings 5-9 elderly people from one kab to a distant eye hospital for cataract surgery within 1-3 days; 30 % come back for the second eye."},
    "rs_satu_pemilik": {"famili": "jaringan", "mode": "M06", "pelaku": "pasangan rumah sakit", "kehalusan": "sedang",
                        "deskripsi": "Two hospitals of one owner: A discharges an inpatient as 'Rujuk' after 1-2 days and sister hospital B admits them the same day for the same condition."},
    "operator_dua_rs": {"famili": "jaringan", "mode": "M04", "pelaku": "dokter lintas rumah sakit", "kehalusan": "sedang",
                        "deskripsi": "An orthopaedic operator practising at three hospitals of one province bills hip/knee implant top-ups, upgrades his musculoskeletal/injury admissions to procedures and his outpatient visits to injections."},
}

# rs = dishonest hospitals running the scheme systematically, porsi = share of their eligible claims, p = scattered rate
# per eligible claim at any other hospital. Rates were set once from the claim volumes per chunk (a hospital sees about
# 1/200 of its yearly pool volume in one chunk) so that fraud is about 2 % of a chunk; no detector was consulted.
PARAM4: dict[str, dict[str, Any]] = {
    "komorbid_titipan": {"rs": 12, "porsi": 0.60, "p_lompat": 0.12},
    "sepsis_dikodekan": {"rs": 2, "porsi": 0.50, "p": 0.07},
    "tindakan_ditempel_ri": {"rs": 5, "porsi": 0.35, "p": 0.012},
    "rajal_naik_prosedur": {"rs": 4, "porsi": 0.15},
    "rawat_inap_ringan": {"rs": 5, "porsi": 0.30, "p": 0.006},
    "kelas_penuh_dalih": {"rs": 6, "porsi": 0.50, "puncak": 1.5, "p_dua_kelas": 0.12},
    "mri_ditagihkan": {"rs": 3, "porsi": 0.25, "p": 0.0015},
    "jam_ventilator_digenapkan": {"p": 0.50, "p_los": 0.70},
    "kemo_batal_ditagih": {"p": 0.70, "maks_hari": 150},
    "poli_dipecah_sehari": {"rs": 4, "porsi": 0.18},
    "pindah_ruang_jadi_admisi": {"rs": 5, "porsi": 0.60},
    "kontrol_tambahan": {"rs": 6, "porsi": 0.25},
    "admisi_ulang_kronis": {"rs": 3, "porsi": 0.60, "p": 0.12},
    "kartu_almarhum": {"n": (4, 6), "p_kedua": 0.40, "p_beda": 0.65},
    "nik_ganda_bergantian": {"n": (3, 5), "p_kedua": 0.35},
    "obat_lintas_rs": {"n": (2, 3), "ekstra": (2, 3)},
    "resume_disalin": {"rs": 4, "p_hari": 0.85, "n_hari": 1, "salinan": (2, 4)},
    "calo_katarak": {"rs": 2, "p_kejadian": 0.85, "ukuran": (6, 10), "p_mata_kedua": 0.30},
    "rs_satu_pemilik": {"pasang": 3, "porsi": 0.60},
    "operator_dua_rs": {"rs": 3, "porsi_implan": 0.80, "porsi_naik": 0.60, "porsi_rajal": 0.60},
}

# clinical vocabularies (ICD-10 3-character)
INFEKSI = ("J18", "J15", "J22", "J20", "A09", "A04", "A01", "N39", "N10", "L03", "L08", "K65")
KRONIS = ("I50", "J44", "N18", "E11", "E14", "E10", "I11", "I12", "I13", "I20", "I25", "I48", "K74", "J47", "D61", "D64", "I63", "I64",
          "J45", "A15", "A16")
OBAT = ("F20", "F25", "F31", "F32", "F33", "F41", "F06", "G40", "G43", "E11", "I10", "M54", "M17", "K21")
TANPA_KONTROL = set(G3.RUTIN)  # routine series (dialysis, physiotherapy, rehabilitation, wound care) are not 'control' visits
PROSEDUR_RJ = {"J": "J-3-13-0", "I": "I-3-13-0", "K": "Z-3-23-0", "N": "Z-3-23-0", "R": "Z-3-23-0", "E": "Z-3-23-0", "M": "M-3-11-0",
               "L": "L-3-12-0", "H": "H-3-12-0", "O": "Z-3-25-0"}  # dx chapter -> a common significant outpatient procedure group
BUKAN_TARGET_RJ = ("N-3-15-0", "C-3-")  # dialysis and chemo/radiotherapy are never invented for a consult
MRI = {"SAR": "8891 - Magnetic resonance imaging of brain and brain stem", "ORT": "8893 - Magnetic resonance imaging of spinal canal",
       "IRM": "8893 - Magnetic resonance imaging of spinal canal", "BED": "8894 - Magnetic resonance imaging of musculoskeletal structures"}
V71 = "9671 - Continuous mechanical ventilation for less than 96 consecutive hours"
V72 = "9672 - Continuous mechanical ventilation for 96 consecutive hours or more"
RS_BESAR = ("RS Kelas A", "RS Kelas B", "RS Swasta Setara Type A", "RS Swasta Setara Type B")
RS_BEDAH = RS_BESAR + ("RS Kelas C", "RS Swasta Setara Type C")
IMPLAN = {"M-1-04": None, "M-1-20": "RR-04-III-HIP", "M-1-70": "RR-04-III-KNEE"}  # bases where a hip/knee implant is plausible


def adalah_fraud(sk: str) -> bool:
    return sk != "normal" and sk in SKEMA4


# ------------------------------------------------------------------------------------------------------------------
# small helpers (hashlib only: deterministic across processes)
# ------------------------------------------------------------------------------------------------------------------
def _h(s: str) -> int:
    return int(hashlib.md5(s.encode("utf-8")).hexdigest()[:8], 16)


def _rng(*parts: Any) -> np.random.Generator:
    key = "|".join(str(p) for p in (GARAM, "gen4") + parts)
    return np.random.default_rng(int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], 16))


def chunk_of(pid: int) -> int:
    return _h(f"{int(pid)}|{GARAM}|chunk4") % N_CHUNK


def _gabung(a: Optional[str], b: Optional[str]) -> Optional[str]:
    """Merge two procedure lists ('code - name;...'), unique items sorted by code as the claims list them."""
    items = {}
    for s in (a, b):
        for it in (s or "").split(";"):
            it = it.strip()
            if it:
                items.setdefault(it.split(" ", 1)[0], it)
    return ";".join(items[k] for k in sorted(items)) or None


def _snap(e: dict, keys=("kode", "basis", "sev", "tarif", "topup", "bill", "_b85", "kelas", "los", "p", "status", "dx", "dxk",
                         "masuk", "dxs", "prosedur", "poli")) -> dict:
    return {k: (dict(e[k]) if isinstance(e.get(k), dict) else e.get(k)) for k in keys}


def _kode_untung(D, e: dict, kode: str, rng, topup_baru: bool = False) -> bool:
    """Re-code e to `kode` (same hospital/class) only when the tariff key exists and the tariff rises."""
    if kode == e["kode"]:
        return False
    old = _snap(e)
    if not G3._set_kode(D, e, kode, rng, topup_baru=topup_baru):
        return False
    if e["tarif"] <= old["tarif"]:
        e.update(old)
        return False
    return True


def _set_los(e: dict, los: int) -> None:
    e["los"] = int(los)
    e["p"] = e["d"] + timedelta(days=int(los))


def _w(t) -> np.ndarray:
    return np.diff(np.concatenate([[0.0], t.c]))


def _pilih(rng, opts: list[tuple[Any, float]]):
    p = np.array([max(float(w), 0.0) for _, w in opts])
    if not len(p) or p.sum() <= 0:
        return None
    return opts[int(rng.choice(len(opts), p=p / p.sum()))][0]


def _na(x) -> bool:
    try:
        return x is None or bool(x != x) or str(x) == "<NA>"
    except (TypeError, ValueError):
        return str(x) == "<NA>"


def _rek(r: dict) -> dict:
    """A history record with missing values as None (NaN is truthy and would leak into a continuation)."""
    return {k: (None if _na(v) else v) for k, v in r.items()}


# ------------------------------------------------------------------------------------------------------------------
# the world: generator 3's fitted world, generator 4's member split, its dishonest hospitals, a few indexes
# ------------------------------------------------------------------------------------------------------------------
class Dunia4:
    def __init__(self) -> None:
        import pandas as pd

        D = G3.dunia()
        self.D = D
        a = D.anggota
        peran = bersih.peran_array(a.pid.values)
        a = a[~np.isin(peran, ["latih", "validasi"])].copy()
        a["chunk"] = np.array([chunk_of(p) for p in a.pid.values], dtype=np.int64)
        self.D4 = copy.copy(D)  # shallow: the same fitted tables, generator 4's chunk column
        self.D4.anggota = a
        h = pd.read_parquet(G3.OUT / "riwayat.parquet")
        h["d"] = pd.to_datetime(h.d).dt.date
        h["p"] = pd.to_datetime(h.p).dt.date
        km = h[h.kode.str.match(r"^C-3-|^C-4-13-")].sort_values(["pid", "d", "p", "id"], kind="mergesort")
        self.kemo = {int(pid): [_rek(r) for r in g.to_dict("records")] for pid, g in km.groupby("pid", sort=True)}
        self.vol_katarak = h[h.kode == "H-2-36-0"].groupby("f").size().to_dict()
        self.vol_ort = h[h.poli == "ORT"].groupby("f").size().to_dict()
        # outpatient-type complaints: diagnoses mostly treated as outpatients (inpatient share 3-45 %), enough volume
        tot: dict[str, list] = defaultdict(lambda: [0.0, 0.0])
        for (dx, tk), t in D.M["basis_dx"].items():
            tot[dx][0 if tk == "RITL" else 1] += t.n()
        self.ringan = sorted(dx for dx, (ri, rj) in tot.items() if ri + rj >= 2000 and 0.03 <= ri / (ri + rj) <= 0.45
                             and dx[0] not in "ZOP" and dx not in ("H25", "H26", "H52", "K04"))
        self.rs4 = self._pilih_rs()

    def _pilih_rs(self) -> dict[str, list]:
        D, R = self.D, self.D.rs
        dipakai: set[str] = set()
        rngs: dict[str, np.random.Generator] = {}

        def ambil(cands: list[tuple[str, float]], k: int, nama: str) -> list[str]:
            """k hospitals without replacement, weighted; each scheme draws from its own stream; a hospital runs one scheme."""
            rng = rngs.setdefault(nama, _rng("rumah-sakit", nama))
            c = [(x, float(w)) for x, w in cands if x not in dipakai and w > 0]
            out = []
            for _ in range(k):
                if not c:
                    break
                i = int(rng.choice(len(c), p=np.array([w for _, w in c]) / sum(w for _, w in c)))
                out.append(c[i][0])
                dipakai.add(c[i][0])
                c.pop(i)
            return out

        def rs(r):
            return r["jenis"] == "Rumah sakit"

        def sw(r):  # private hospitals are somewhat over-represented among dishonest ones
            return 1.5 if r["kep"] == "Swasta" else 1.0

        # weights follow volume (a chunk sees a hospital's claims in proportion to it); thresholds keep the largest
        # hospitals from being exhausted
        ri = sorted((f, float(r["n_ri"] or 0) * sw(r)) for f, r in R.items() if rs(r) and float(r["n_ri"] or 0) >= 250)
        rj = sorted((f, float(r["n"]) * sw(r)) for f, r in R.items() if rs(r) and r["n"] >= 2500)
        umum = [(f, w) for f, w in rj if R[f]["hg"] == "Umum"]  # general hospitals (many clinics)
        P = PARAM4
        out: dict[str, Any] = {}
        # cloning needs a hospital busy enough to see several outpatients of the chunk within a few days
        out["resume_disalin"] = ambil([(f, w) for f, w in rj if R[f]["n"] >= 6000], P["resume_disalin"]["rs"], "resume_disalin")
        out["komorbid_titipan"] = ambil(ri, P["komorbid_titipan"]["rs"], "komorbid_titipan")
        out["kelas_penuh_dalih"] = ambil(ri, P["kelas_penuh_dalih"]["rs"], "kelas_penuh_dalih")
        out["pindah_ruang_jadi_admisi"] = ambil(ri, P["pindah_ruang_jadi_admisi"]["rs"], "pindah_ruang_jadi_admisi")
        out["tindakan_ditempel_ri"] = ambil([(f, w) for f, w in ri if R[f]["tipe"] in RS_BEDAH], P["tindakan_ditempel_ri"]["rs"], "tindakan_ditempel_ri")
        out["sepsis_dikodekan"] = ambil(ri, P["sepsis_dikodekan"]["rs"], "sepsis_dikodekan")
        out["admisi_ulang_kronis"] = ambil(ri, P["admisi_ulang_kronis"]["rs"], "admisi_ulang_kronis")
        out["rajal_naik_prosedur"] = ambil(rj, P["rajal_naik_prosedur"]["rs"], "rajal_naik_prosedur")
        out["poli_dipecah_sehari"] = ambil(umum, P["poli_dipecah_sehari"]["rs"], "poli_dipecah_sehari")
        out["kontrol_tambahan"] = ambil(rj, P["kontrol_tambahan"]["rs"], "kontrol_tambahan")
        out["rawat_inap_ringan"] = ambil(umum, P["rawat_inap_ringan"]["rs"], "rawat_inap_ringan")
        out["mri_ditagihkan"] = ambil([(f, w) for f, w in rj if R[f]["tipe"] in RS_BESAR], P["mri_ditagihkan"]["rs"], "mri_ditagihkan")
        # the broker's eye hospitals: hospitals doing many outpatient cataract operations
        kat = sorted((f, float(n)) for f, n in self.vol_katarak.items() if f in R and n >= 3)
        out["calo_katarak"] = ambil(kat, P["calo_katarak"]["rs"], "calo_katarak")
        # same-owner pairs: a private A and a private sister B in the same kab/kota (else the same province)
        pairs = []
        for _ in range(3 * P["rs_satu_pemilik"]["pasang"]):
            if len(pairs) >= P["rs_satu_pemilik"]["pasang"]:
                break
            a = ambil([(f, w) for f, w in ri if R[f]["kep"] == "Swasta"], 1, "rs_satu_pemilik")
            if not a:
                break
            A = a[0]
            sis = [(f, float(r["n_ri"] or 0)) for f, r in sorted(R.items()) if rs(r) and r["kep"] == "Swasta" and float(r["n_ri"] or 0) >= 50
                   and r["kab"] == R[A]["kab"]]
            if not sis:
                sis = [(f, float(r["n_ri"] or 0)) for f, r in sorted(R.items()) if rs(r) and r["kep"] == "Swasta"
                       and float(r["n_ri"] or 0) >= 50 and int(r["kab"]) // 100 == int(R[A]["kab"]) // 100]
            b = ambil(sis, 1, "rs_satu_pemilik")
            if b:
                pairs.append((A, b[0]))
        out["rs_satu_pemilik"] = pairs
        # one orthopaedic operator at three general hospitals of one province that all run an orthopaedic clinic
        ort = sorted((f, float(r["n"])) for f, r in R.items() if rs(r) and r["hg"] == "Umum" and r["tipe"] in RS_BEDAH and r["n"] >= 4000
                     and self.vol_ort.get(f, 0) >= 10)
        grp: list[str] = []
        for _ in range(6):
            a = ambil(ort, 1, "operator_dua_rs")
            if not a:
                break
            pv = int(R[a[0]]["kab"]) // 100
            bc = [(f, float(r["n"])) for f, r in sorted(R.items()) if rs(r) and r["hg"] == "Umum" and r["n"] >= 2000
                  and self.vol_ort.get(f, 0) >= 5 and int(r["kab"]) // 100 == pv]
            b = ambil(bc, P["operator_dua_rs"]["rs"] - 1, "operator_dua_rs")
            if len(b) == P["operator_dua_rs"]["rs"] - 1:
                grp = [a[0]] + b
                break
        out["operator_dua_rs"] = grp
        return out


_W: dict[str, Dunia4] = {}


def dunia4() -> Dunia4:
    if GARAM not in _W:
        _W[GARAM] = Dunia4()
    return _W[GARAM]


def kecuali_latih() -> set[int]:
    """Members of the earlier training data sets (data v2); already outside the pool, returned for the runner's union."""
    out: set[int] = set()
    for pola in ("data_v2/fitur_*.npz", "data_v2_bersih/fitur_*.npz"):
        try:
            out |= bersih._peserta_npz(pola)
        except Exception:  # noqa: BLE001
            pass
    return out


# ------------------------------------------------------------------------------------------------------------------
# the chunk under construction (generator 3's Ctx: episodes, members, reserve, overlap checks) + generator 4 helpers
# ------------------------------------------------------------------------------------------------------------------
class Konteks(G3.Ctx):
    def __init__(self, W: Dunia4, pop: dict, c: int) -> None:
        super().__init__(W.D, pop, _rng(c, "konteks"))
        self.W, self.c = W, int(c)

    def r(self, nama: str) -> np.random.Generator:
        return _rng(self.c, "skema", nama)

    def daftar(self, m: dict, sumber: str) -> None:
        m["sumber"] = sumber
        self.members[m["pid"]] = m
        self.terpakai.add(m["pid"])

    def ubah_los(self, e: dict, los: int) -> bool:
        old = (e["los"], e["p"])
        _set_los(e, los)
        if not self.bebas(e["pid"], e):
            e["los"], e["p"] = old
            return False
        return True

    def ganti(self, e: dict, baru: dict) -> None:
        """Replace an episode's content in place (its arrival sequence is kept)."""
        seq = e["_seq"]
        e.clear()
        e.update(baru)
        e["_seq"] = seq


def _tandai(e: dict, sk: str, var: str) -> dict:
    return G3._tandai(e, sk, var)


# ---------------------------------------------------------------------------------------------------------- koding
def s_komorbid_titipan(K: Konteks) -> None:
    nm = "komorbid_titipan"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["f"] in H and e["tk"] == "RITL" and e["sev"] in ("I", "II")):
        if K.m(e["pid"])["ab"] < 1 or rng.random() >= P["porsi"]:
            continue
        if e["sev"] == "I":
            if rng.random() < P["p_lompat"]:
                target, tambah, var = "III", 3, "I_ke_III"
            else:
                target, tambah, var = "II", int(rng.integers(1, 3)), "I_ke_II"
        else:
            target, tambah, var = "III", int(rng.integers(2, 4)), "II_ke_III"
        if _kode_untung(D, e, f"{e['basis']}-{target}", rng):
            e["dxs"] = min(int(e["dxs"]) + tambah, 25)
            _tandai(e, nm, var)


def s_sepsis_dikodekan(K: Konteks) -> None:
    nm = "sepsis_dikodekan"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    tdxk = D.M["dxk"].get("A41")
    for e in K.normal(lambda e: e["tk"] == "RITL" and e["dx"] in INFEKSI and e["status"] != "Meninggal"):
        di_rs = e["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        basis = "A-4-10" if rng.random() < 0.7 else "A-4-14"
        sevs = ("II", "III") if rng.random() < 0.6 else ("III", "II")
        if not any(_kode_untung(D, e, f"{basis}-{sv}", rng) for sv in sevs):
            continue
        e["dx"] = "A41"
        e["dxk"] = tdxk.pick(rng) if tdxk is not None else "A419"
        e["dxs"] = min(int(e["dxs"]) + 1, 25)  # the local infection becomes a secondary diagnosis; 'masuk' still names it
        _tandai(e, nm, "rs" if di_rs else "sebaran")


def s_tindakan_ditempel_ri(K: Konteks) -> None:
    nm = "tindakan_ditempel_ri"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["tk"] == "RITL" and e["kode"][2] == "4"):
        di_rs = e["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        t = D.basis_grup.get((e["kode"][0], "1", "RITL"))
        if t is None:
            continue
        ok = False
        for _ in range(8):
            if _kode_untung(D, e, f"{t.pick(rng)}-{e['sev']}", rng):
                ok = True
                break
        if not ok:
            continue
        e["prosedur"] = _gabung(e.get("prosedur"), G3._pros(D, e["kode"], rng, wajib=True))
        if rng.random() < 0.4:
            K.ubah_los(e, e["los"] + 1)
        _tandai(e, nm, "rs" if di_rs else "sebaran")


def s_rajal_naik_prosedur(K: Konteks) -> None:
    nm = "rajal_naik_prosedur"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["f"] in H and e["tk"] == "RJTL" and e["kode"][2] == "5" and e.get("poli") != "IGD"):
        if rng.random() >= P["porsi"]:
            continue
        opts: list[tuple[str, float]] = []
        tdx = D.M["basis_dx"].get((e["dx"], "RJTL"))
        if tdx is not None:  # significant procedures this diagnosis really groups to
            opts += [(b + "-0", w) for b, w in zip(tdx.v, _w(tdx)) if b[2] == "3"]
        opts = [(k, w) for k, w in opts if not k.startswith(BUKAN_TARGET_RJ)]
        if not opts:
            opts = [(PROSEDUR_RJ.get(e["dx"][0], "Z-3-23-0"), 1.0)]
        ok = False
        for _ in range(4):
            k = _pilih(rng, opts)
            if k and _kode_untung(D, e, k, rng):
                ok = True
                break
        if not ok:
            continue
        e["prosedur"] = _gabung(e.get("prosedur"), G3._pros(D, e["kode"], rng, wajib=True))
        _tandai(e, nm, e["kode"])


def s_rawat_inap_ringan(K: Konteks) -> None:
    nm = "rawat_inap_ringan"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    ringan = set(K.W.ringan)

    def keluhan(e: dict) -> Optional[str]:
        """The outpatient-type complaint of a visit: its primary dx, or for a follow-up visit (Z..) the condition it follows."""
        if e["dx"] in ringan:
            return e["dx"]
        if e["dx"][0] == "Z" and e.get("masuk") and str(e["masuk"])[:3] in ringan:
            return str(e["masuk"])[:3]
        return None

    for e in K.normal(lambda e: e["tk"] == "RJTL" and e.get("poli") not in ("HDL", "IRM") and keluhan(e) is not None):
        di_rs = e["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        m = K.m(e["pid"])
        dx = keluhan(e)
        n = G3.episode(D, m, e["f"], "RITL", e["d"], rng, dx=dx, rho=0.5)
        if n is None or n["dx"] != dx:
            continue
        if n["sev"] != "I":
            G3._set_kode(D, n, f"{n['basis']}-I", rng)
        _set_los(n, int(rng.choice([1, 2, 2, 3])))
        n["status"] = "Sehat"
        n["_menit"] = e["_menit"]
        if not K.bebas(e["pid"], n, abaikan=(e,)):
            continue
        K.ganti(e, n)
        _tandai(e, nm, "rs" if di_rs else "sebaran")


# --------------------------------------------------------------------------------------------------------- tagihan
def s_kelas_penuh_dalih(K: Konteks) -> None:
    nm = "kelas_penuh_dalih"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    naik = {"Kelas 3": "Kelas 2", "Kelas 2": "Kelas 1"}
    for e in K.normal(lambda e: e["f"] in H and e["tk"] == "RITL"):
        hak = G3._hak(K.m(e["pid"]))
        if e["kelas"] != hak or hak not in naik:
            continue
        if rng.random() >= min(P["porsi"] * (P["puncak"] if e["d"] in PUNCAK else 1.0), 0.9):
            continue
        baru = "Kelas 1" if (hak == "Kelas 3" and rng.random() < P["p_dua_kelas"]) else naik[hak]
        old = _snap(e)
        e["kelas"] = baru
        if not G3._isi_biaya(D, e, rng, topup_baru=False) or e["tarif"] <= old["tarif"]:
            e.update(old)
            continue
        _tandai(e, nm, f"{hak[-1]}_ke_{baru[-1]}")


def s_mri_ditagihkan(K: Konteks) -> None:
    nm = "mri_ditagihkan"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["tk"] == "RJTL" and e.get("poli") in MRI and "si" not in e["topup"]):
        di_rs = e["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        amt = D.topup_amt("si", "II-02-III", e["f"])
        if amt <= 0:
            continue
        e["topup"] = dict(e["topup"])
        e["topup"]["si"] = ("II-02-III", "MRI", amt)
        G3._tagih(D, e)
        e["prosedur"] = _gabung(e.get("prosedur"), MRI[e["poli"]])
        _tandai(e, nm, ("rs_" if di_rs else "sebaran_") + e["poli"])


def s_jam_ventilator_digenapkan(K: Konteks) -> None:
    nm = "jam_ventilator_digenapkan"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    for e in K.normal(lambda e: e["tk"] == "RITL" and "9671 " in (e.get("prosedur") or "")):
        if rng.random() >= P["p"]:
            continue
        sev = e["sev"] if e["sev"] in ("II", "III") else "II"
        if not any(_kode_untung(D, e, f"J-1-02-{sv}", rng) for sv in dict.fromkeys((sev, "III", "II"))):
            continue
        items = [V72 if it.startswith("9671 ") else it for it in e["prosedur"].split(";")]
        e["prosedur"] = _gabung(";".join(items), None)
        if e["los"] >= 4:
            var = "los_cukup"
        elif rng.random() < P["p_los"] and K.ubah_los(e, int(rng.integers(5, 9))):
            var = "los_disesuaikan"
        else:
            var = "los_tetap"
        _tandai(e, nm, var)


def s_kemo_batal_ditagih(K: Konteks) -> None:
    nm = "kemo_batal_ditagih"; P = PARAM4[nm]; rng = K.r(nm); D = K.D; W = K.W
    for m in list(K.cad_h):
        rows = W.kemo.get(int(m["pid"]))
        if not rows or m["pid"] in K.terpakai:
            continue
        last = rows[-1]
        if (W0 - last["d"]).days > P["maks_hari"] or last["f"] not in D.rs:
            continue
        radio = last["kode"] == "C-3-10-0"
        siklus = 7 if radio else int(rng.choice([21, 21, 21, 14, 28]))
        d = last["d"]
        while d < W0:
            d = d + timedelta(days=siklus)
        if d > W1 or rng.random() >= P["p"]:
            continue
        d = G3._kalender(D, last["tk"], d, rng)
        if d > W1:
            continue
        prev = {"f": last["f"], "kode": last["kode"], "prosedur": last["prosedur"], "poli": last["poli"], "dx": last["dx"], "dxk": last["dxk"]}
        e = G3.episode(D, m, last["f"], last["tk"], d, rng, dx=last["dx"], basis=last["basis"], prev=prev)
        if e is None:
            continue
        if e["kode"] != last["kode"] and not G3._set_kode(D, e, last["kode"], rng, topup_baru=True):
            continue
        e["prosedur"] = last["prosedur"] or e["prosedur"]  # the last session's lines, copied
        if last["tk"] == "RITL":
            _set_los(e, max(int(last["los"] or 1), 1))
        e["status"] = "Sehat"
        K.daftar(m, "cadangan")
        K.tambah(_tandai(e, nm, "radioterapi" if radio else "kemoterapi"))


# --------------------------------------------------------------------------------------------------------- episode
def s_poli_dipecah_sehari(K: Konteks) -> None:
    nm = "poli_dipecah_sehari"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["f"] in H and e["tk"] == "RJTL" and e.get("poli") not in ("IGD", "HDL") and int(e["dxs"]) >= 1):
        if rng.random() >= P["porsi"]:
            continue
        m = K.m(e["pid"])
        n, var = None, "baru"
        g = D.riwayat.get(int(e["pid"]))
        if g is not None:  # another condition this patient was treated for at another clinic of this hospital
            rr = [r for r in map(_rek, g.to_dict("records")) if r["f"] == e["f"] and r["tk"] == "RJTL" and r["poli"] and r["poli"] != e.get("poli")]
            if rr:
                r = rr[-1]
                n = G3.episode(D, m, e["f"], "RJTL", e["d"], rng, dx=r["dx"], basis=r["basis"], prev=r)
                var = "riwayat"
        if n is None or n.get("poli") == e.get("poli") or n["kode"] == e["kode"]:
            n, var = None, "baru"
            for _ in range(6):
                x = G3.episode(D, m, e["f"], "RJTL", e["d"], rng)
                if x is not None and x.get("poli") not in (e.get("poli"), "IGD", "HDL") and x["kode"] != e["kode"]:
                    n = x
                    break
        if n is None:
            continue
        n["_menit"] = min(1439, int(e["_menit"]) + int(rng.integers(20, 180)))
        K.tambah(_tandai(n, nm, var))


def s_pindah_ruang_jadi_admisi(K: Konteks) -> None:
    nm = "pindah_ruang_jadi_admisi"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["f"] in H and e["tk"] == "RITL" and e["los"] >= 3 and e["status"] != "Meninggal"):
        if rng.random() >= P["porsi"]:
            continue
        los = int(e["los"])
        k = int(rng.integers(max(1, los // 3), los - 1))
        m = K.m(e["pid"])
        d2 = e["d"] + timedelta(days=k)
        if d2 > W1:  # the second claim would fall outside the window's data
            continue
        terkait = rng.random() < 0.6
        n = G3.episode(D, m, e["f"], "RITL", d2, rng, dx=G3._dx_terkait(D, m, e, e["f"], rng) if terkait else None)
        if n is None:
            continue
        _set_los(n, max(1, los - k + int(rng.integers(0, 2))))
        n["status"] = e["status"]
        old = _snap(e)
        _set_los(e, k)
        e["status"] = "Sehat"
        if not K.bebas(e["pid"], n, abaikan=(e,)):
            e.update(old)
            continue
        _tandai(e, nm, "awal")
        K.tambah(_tandai(n, nm, "lanjutan_" + ("dx_terkait" if terkait else "dx_lain")))


def s_kontrol_tambahan(K: Konteks) -> None:
    nm = "kontrol_tambahan"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    for e in K.normal(lambda e: e["f"] in H and e["status"] != "Meninggal" and e["kode"] not in TANPA_KONTROL
                      and e.get("poli") not in ("HDL", "IRM", "IGD") and e["f"] in K.m(e["pid"])["rs_set"]):
        if rng.random() >= P["porsi"]:
            continue
        base = e["p"] if e["tk"] == "RITL" else e["d"]
        d2 = G3._kalender(D, "RJTL", base + timedelta(days=int(rng.integers(4, 10))), rng)
        if d2 > W1:
            continue
        m = K.m(e["pid"])
        lb = D.M["lanjut_basis"].get(f"{e['basis']}|RJTL")
        n = G3.episode(D, m, e["f"], "RJTL", d2, rng, dx=e["dx"], basis=lb.pick(rng) if lb is not None else None, prev=e)
        if n is None or not K.bebas(e["pid"], n):
            continue
        K.tambah(_tandai(n, nm, "pasca_ri" if e["tk"] == "RITL" else "pasca_rj"))


def s_admisi_ulang_kronis(K: Konteks) -> None:
    nm = "admisi_ulang_kronis"; P = PARAM4[nm]; rng = K.r(nm); H = set(K.W.rs4[nm]); D = K.D
    # 1. the index admission is in the window
    for e in K.normal(lambda e: e["tk"] == "RITL" and e["dx"] in KRONIS and e["status"] == "Sehat"):
        di_rs = e["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        d2 = e["p"] + timedelta(days=int(rng.integers(4, 13)))
        if d2 > W1:
            continue
        n = G3.episode(D, K.m(e["pid"]), e["f"], "RITL", d2, rng, dx=e["dx"], basis=e["basis"])
        if n is None or not K.bebas(e["pid"], n):
            continue
        K.tambah(_tandai(n, nm, ("rs" if di_rs else "sebaran") + "_jendela"))
    # 2. the index admission is the member's last claim before the window (reserve members with no window claim, and
    #    members whose window claims leave room for the readmission)
    kandidat = [(m, True) for m in K.cad_h] + [(m, False) for m in list(K.members.values()) if m.get("sumber") == "perjalanan"]
    for m, cadangan in kandidat:
        st = m.get("last")
        if (cadangan and m["pid"] in K.terpakai) or not st or st["tk"] != "RITL" or st["dx"] not in KRONIS or st["f"] not in D.rs:
            continue
        if (m.get("riwayat_rs", {}).get(st["f"]) or {}).get("status") != "Sehat":
            continue
        d2 = st["p"] + timedelta(days=int(rng.integers(4, 13)))
        if not (W0 <= d2 <= W1):
            continue
        di_rs = st["f"] in H
        if rng.random() >= (P["porsi"] if di_rs else P["p"]):
            continue
        n = G3.episode(D, m, st["f"], "RITL", d2, rng, dx=st["dx"], basis=st["basis"])
        if n is None or (not cadangan and not K.bebas(m["pid"], n)):
            continue
        if cadangan:
            K.daftar(m, "cadangan")
        K.tambah(_tandai(n, nm, ("rs" if di_rs else "sebaran") + "_pasca_riwayat"))


# ------------------------------------------------------------------------------------------------------- identitas
def _mati_lama(r) -> bool:
    if bool(getattr(r, "mati_hist", False)):
        return True
    t = getattr(r, "thn_mati", None)
    return (not _na(t)) and int(t) <= 2023


def s_kartu_almarhum(K: Konteks) -> None:
    nm = "kartu_almarhum"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    mati = [r for r in K.mati if _mati_lama(r) and int(r.pid) not in K.terpakai]
    n = min(int(rng.integers(P["n"][0], P["n"][1] + 1)), len(mati))
    if n <= 0:
        return
    for i in sorted(rng.choice(len(mati), size=n, replace=False).tolist()):
        m = G3._anggota(D, mati[i])
        if rng.random() < P["p_beda"]:  # a relative of another generation and possibly the other sex
            var = "kerabat_beda"
            ab = int(rng.choice([x for x in (1, 2, 3, 4) if x != m["ab"]]))
            jk = "L" if rng.random() < 0.5 else "P"
        else:  # a sibling or spouse of a similar age
            var = "kerabat_mirip"
            ab = m["ab"]
            jk = m["jk"] or ("L" if rng.random() < 0.5 else "P")
        f = m["rs"] if (m["rs"] and rng.random() < 0.3) else G3._rs_lain(D, m, None, rng, lama=False)
        tk = "RITL" if rng.random() < 0.25 else "RJTL"
        d = G3._kalender(D, tk, W0 + timedelta(days=int(rng.integers(0, NDAY))), rng)
        if d > W1:
            continue
        e = G3.episode(D, m, f, tk, d, rng, ab=ab, jk=jk)
        if e is None:
            continue
        K.daftar(m, "almarhum")
        K.tambah(_tandai(e, nm, var))
        if rng.random() < P["p_kedua"]:
            d2 = G3._kalender(D, "RJTL", e["p"] + timedelta(days=int(rng.integers(5, 11))), rng)
            if d2 <= W1:
                e2 = G3.episode(D, m, f, "RJTL", d2, rng, dx=e["dx"], prev=e, ab=ab, jk=jk)
                if e2 is not None and K.bebas(m["pid"], e2):
                    K.tambah(_tandai(e2, nm, var + "_kontrol"))


def s_nik_ganda_bergantian(K: Konteks) -> None:
    nm = "nik_ganda_bergantian"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    idx: dict[tuple, list] = defaultdict(list)  # dormant reserve members (no 2024 claim) by sex, residence and age
    for r in K.cad_b:
        if not _na(r.kab) and not _na(r.usia) and r.jk:
            idx[(r.jk, int(r.kab), int(r.usia))].append(r)
    cands = []
    for e in K.normal(lambda e: e["tk"] == "RJTL" and e["d"] <= W1 - timedelta(days=3)):
        m = K.m(e["pid"])
        if m.get("kab") is None or m.get("usia") is None or not m.get("jk"):
            continue
        cands.append(e)
    n = int(rng.integers(P["n"][0], P["n"][1] + 1))
    done = 0
    for i in rng.permutation(len(cands)).tolist():
        if done >= n:
            break
        e = cands[i]
        if e["_sk"] != "normal":
            continue
        m = K.m(e["pid"])
        u = int(m["usia"])
        pool = [r for a in range(u - 2, u + 3) for r in idx.get((m["jk"], int(m["kab"]), a), []) if int(r.pid) not in K.terpakai]
        if not pool:
            continue
        m2 = G3._anggota(D, pool[int(rng.integers(len(pool)))])
        d2 = G3._kalender(D, "RJTL", e["d"] + timedelta(days=int(rng.integers(2, 7))), rng)
        if d2 > W1:
            continue
        e2 = G3.episode(D, m2, e["f"], "RJTL", d2, rng, dx=e["dx"], basis=e["basis"], prev=e)
        if e2 is None:
            continue
        K.daftar(m2, "identitas_ganda")
        K.tambah(_tandai(e2, nm, "id_kedua"))
        done += 1
        if rng.random() < P["p_kedua"]:
            d3 = G3._kalender(D, "RJTL", d2 + timedelta(days=int(rng.integers(3, 8))), rng)
            if d3 <= W1:
                e3 = G3.episode(D, m2, e["f"], "RJTL", d3, rng, dx=e["dx"], basis=e["basis"], prev=e2)
                if e3 is not None and K.bebas(m2["pid"], e3):
                    K.tambah(_tandai(e3, nm, "id_kedua_ulang"))


def s_obat_lintas_rs(K: Konteks) -> None:
    nm = "obat_lintas_rs"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    cands = K.normal(lambda e: e["tk"] == "RJTL" and e["dx"] in OBAT and e["d"] <= W1 - timedelta(days=4))
    n = int(rng.integers(P["n"][0], P["n"][1] + 1))
    pids: set[int] = set()
    for i in rng.permutation(len(cands)).tolist():
        if len(pids) >= n:
            break
        e = cands[i]
        if e["pid"] in pids or e["_sk"] != "normal":
            continue
        m = K.m(e["pid"])
        used, d, got = {e["f"]}, e["d"], 0
        for j in range(int(rng.integers(P["ekstra"][0], P["ekstra"][1] + 1))):
            d = d + timedelta(days=int(rng.integers(1, 5)))
            if d > W1:
                break
            f2 = None
            for _ in range(8):
                x = G3._rs_lain(D, m, None, rng, lama=False)
                if x not in used:
                    f2 = x
                    break
            if f2 is None:
                continue
            n2 = G3.episode(D, m, f2, "RJTL", d, rng, dx=e["dx"])
            if n2 is None or n2["dx"] != e["dx"] or not K.bebas(e["pid"], n2):
                continue
            used.add(f2)
            got += 1
            K.tambah(_tandai(n2, nm, f"kunjungan_{got + 1}"))
        if got:
            pids.add(e["pid"])


def s_resume_disalin(K: Konteks) -> None:
    nm = "resume_disalin"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    for f in K.W.rs4[nm]:
        eps_f = sorted(K.normal(lambda e: e["f"] == f and e["tk"] == "RJTL"), key=lambda e: (e["d"], e["_seq"]))
        # a template is reused for the outpatients of a few days (a 3-day block starting on an anchor day)
        blok = {d: [e for e in eps_f if d <= e["d"] <= d + timedelta(days=2)] for d in sorted({e["d"] for e in eps_f})}
        days = sorted(d for d, lst in blok.items() if len(lst) >= 3)
        for d in sorted(rng.permutation(days)[:P["n_hari"]].tolist()) if days else []:
            if rng.random() >= P["p_hari"]:
                continue
            lst = [e for e in blok[d] if e["_sk"] == "normal"]
            if len(lst) < 3:
                continue
            tpl = max(lst, key=lambda e: (e["bill"], -e["_seq"]))
            lain = [e for e in lst if e is not tpl and e["kode"] != tpl["kode"]]
            if not lain:
                continue
            k = min(len(lain), int(rng.integers(P["salinan"][0], P["salinan"][1] + 1)))
            for i in sorted(rng.choice(len(lain), size=k, replace=False).tolist()):
                e = lain[i]
                old = _snap(e)
                for key in ("dx", "dxk", "masuk", "basis", "kode", "sev", "dxs", "prosedur", "poli"):
                    e[key] = tpl[key]
                e["topup"] = dict(tpl["topup"])
                e["_b85"] = None
                if not G3._isi_biaya(D, e, rng, topup_baru=False):
                    e.update(old)
                    continue
                _tandai(e, nm, "salinan")


# -------------------------------------------------------------------------------------------------------- jaringan
def s_calo_katarak(K: Konteks) -> None:
    nm = "calo_katarak"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    H = K.W.rs4[nm]
    if not H or rng.random() >= P["p_kejadian"]:
        return
    f = H[K.c % len(H)]
    kab_rs = int(D.rs[f]["kab"])
    # elderly people with no claim this window (dormant or reserve members), by residence kab
    lansia: dict[int, list] = defaultdict(list)
    for r in K.cad_b:
        if not _na(r.usia) and r.usia >= 55 and not _na(r.kab) and int(r.pid) not in K.terpakai:
            lansia[int(r.kab)].append(("b", r))
    for m in K.cad_h:
        if m.get("usia") is not None and m["usia"] >= 55 and m.get("kab") is not None and m["pid"] not in K.terpakai:
            lansia[int(m["kab"])].append(("h", m))
    size = int(rng.integers(P["ukuran"][0], P["ukuran"][1] + 1))
    prov = [k for k in sorted(lansia) if k // 100 == kab_rs // 100 and k != kab_rs and len(lansia[k]) >= size]
    kabs = prov or [k for k in sorted(lansia) if len(lansia[k]) >= size]
    if not kabs:
        return
    kab = kabs[int(rng.integers(len(kabs)))]
    grup = lansia[kab]
    s0 = W0 + timedelta(days=int(rng.integers(0, NDAY - 3)))
    for i in sorted(rng.choice(len(grup), size=size, replace=False).tolist()):
        jenis, x = grup[i]
        m = G3._anggota(D, x) if jenis == "b" else x
        d = G3._kalender(D, "RJTL", s0 + timedelta(days=int(rng.integers(0, 3))), rng)
        if d > W1:
            continue
        e = G3.episode(D, m, f, "RJTL", d, rng, dx="H25" if rng.random() < 0.8 else "H26", basis="H-2-36")
        if e is None:
            continue
        if e["kode"] != "H-2-36-0":
            if not G3._set_kode(D, e, "H-2-36-0", rng, topup_baru=True):
                continue
            e["prosedur"] = G3._pros(D, "H-2-36-0", rng, wajib=True)
        e["poli"] = "MAT"
        K.daftar(m, "calo")
        K.tambah(_tandai(e, nm, "mata_1"))
        if rng.random() < P["p_mata_kedua"]:
            d2 = G3._kalender(D, "RJTL", d + timedelta(days=int(rng.integers(7, 13))), rng)
            if d2 <= W1:
                e2 = G3.episode(D, m, f, "RJTL", d2, rng, dx=e["dx"], basis="H-2-36", prev=e)
                if e2 is not None and (e2["kode"] == "H-2-36-0" or G3._set_kode(D, e2, "H-2-36-0", rng, topup_baru=True)) \
                        and K.bebas(m["pid"], e2):
                    e2["poli"] = "MAT"
                    K.tambah(_tandai(e2, nm, "mata_2"))


def s_rs_satu_pemilik(K: Konteks) -> None:
    nm = "rs_satu_pemilik"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    ke = {a: b for a, b in K.W.rs4[nm]}
    for e in K.normal(lambda e: e["f"] in ke and e["tk"] == "RITL" and e["los"] >= 2 and e["status"] != "Meninggal"):
        if rng.random() >= P["porsi"]:
            continue
        los = int(e["los"])
        k = int(rng.integers(1, min(3, los)))
        d2 = e["d"] + timedelta(days=k)
        if d2 > W1:  # the transfer would fall outside the window's data
            continue
        n = G3.episode(D, K.m(e["pid"]), ke[e["f"]], "RITL", d2, rng, dx=e["dx"], basis=e["basis"])
        if n is None:
            continue
        _set_los(n, max(1, los - k + int(rng.integers(0, 3))))
        n["status"] = e["status"]
        old = _snap(e)
        _set_los(e, k)
        e["status"] = "Rujuk"
        if not K.bebas(e["pid"], n, abaikan=(e,)):
            e.update(old)
            continue
        _tandai(e, nm, "asal_dirujuk")
        K.tambah(_tandai(n, nm, "penerima"))


def s_operator_dua_rs(K: Konteks) -> None:
    nm = "operator_dua_rs"; P = PARAM4[nm]; rng = K.r(nm); D = K.D
    G = set(K.W.rs4[nm])

    def pasien(e: dict) -> bool:  # the operator's caseload: musculoskeletal and injury patients at his hospitals
        if e["f"] not in G:
            return False
        ms = e["dx"][0] in "MS" or (e["dx"][0] == "Z" and str(e.get("masuk") or " ")[0] in "MS")  # incl. follow-ups of such conditions
        if e["tk"] == "RITL":
            return e["kode"][0] == "M" or ms
        return e.get("poli") == "ORT" or (ms and e.get("poli") in ("BED", "IRM"))

    for e in K.normal(pasien):
        ct = e["kode"][2]
        if e["tk"] == "RITL" and ct == "1" and e["basis"] in IMPLAN and "rr" not in e["topup"]:
            if rng.random() >= P["porsi_implan"]:
                continue
            tk_rr = IMPLAN[e["basis"]] or ("RR-04-III-HIP" if rng.random() < 0.5 else "RR-04-III-KNEE")
            amt = D.topup_amt("rr", tk_rr, e["f"])
            if amt <= 0:
                continue
            e["topup"] = dict(e["topup"])
            e["topup"]["rr"] = (tk_rr, "HIP IMPLANT/ KNEE IMPLANT", amt)
            G3._tagih(D, e)
            _tandai(e, nm, "implan")
        elif e["tk"] == "RITL" and ct == "4":
            if rng.random() >= P["porsi_naik"]:
                continue
            t = D.basis_grup.get((e["kode"][0], "1", "RITL"))
            if t is None or not any(_kode_untung(D, e, f"{t.pick(rng)}-{e['sev']}", rng) for _ in range(6)):
                continue
            e["prosedur"] = _gabung(e.get("prosedur"), G3._pros(D, e["kode"], rng, wajib=True))
            _tandai(e, nm, "naik_prosedur")
        elif e["tk"] == "RJTL" and ct == "5":
            if rng.random() >= P["porsi_rajal"] or not _kode_untung(D, e, "M-3-11-0", rng):
                continue
            e["prosedur"] = _gabung(e.get("prosedur"), G3._pros(D, "M-3-11-0", rng, wajib=True))
            _tandai(e, nm, "injeksi_rajal")


# order: hospital back-office alterations first, then added claims, then members and networks (a claim carries one scheme)
URUTAN4 = (s_resume_disalin, s_komorbid_titipan, s_sepsis_dikodekan, s_tindakan_ditempel_ri, s_jam_ventilator_digenapkan, s_kelas_penuh_dalih,
           s_operator_dua_rs, s_rajal_naik_prosedur, s_mri_ditagihkan, s_rawat_inap_ringan, s_pindah_ruang_jadi_admisi, s_rs_satu_pemilik,
           s_poli_dipecah_sehari, s_kontrol_tambahan, s_admisi_ulang_kronis, s_kemo_batal_ditagih, s_calo_katarak, s_kartu_almarhum,
           s_nik_ganda_bergantian, s_obat_lintas_rs)
assert {fn.__name__[2:] for fn in URUTAN4} == set(SKEMA4) == set(PARAM4)
assert "pulang_dini" not in SKEMA4


# ------------------------------------------------------------------------------------------------------------------
# a chunk
# ------------------------------------------------------------------------------------------------------------------
def buat(c: int, kecuali: set[int]) -> list[dict]:
    """Chunk c (0-7): about 5,000 claims of 18-31 Dec 2024 in arrival order, each a KlaimIn dict plus _sk (scheme or
    'normal'), _varian, _m (the member: pid, rs = hospital profile of the last claim before the window or None, ...),
    _urut. Members are split between chunks by generator 4's own hash, so chunks never share a member."""
    if not 0 <= int(c) < N_CHUNK:
        raise ValueError(f"chunk {c} di luar 0..{N_CHUNK - 1}")
    W = dunia4()
    D = W.D
    pop = G3._populasi(W.D4, int(c), {int(x) for x in (kecuali or set())}, _rng(c, "populasi"))
    K = Konteks(W, pop, int(c))
    for fn in URUTAN4:
        fn(K)
    eps = [e for e in K.eps if e.get("pid") is not None]
    eps.sort(key=lambda e: (e["d"], e["_menit"], e["_seq"]))
    dup = Counter((e["pid"], e["d"], e["kode"]) for e in eps)  # the silver duplicate flag: same member, date and code
    rid = _rng(c, "id")
    ids = ["SYN" + "".join(x) for x in G3._ALFA[rid.integers(0, 36, size=(len(eps), 13))]]
    out = []
    for i, (e, kid) in enumerate(zip(eps, ids)):
        k = G3._klaim(D, e, kid)
        k["flag_calon_klaim_ganda"] = dup[(e["pid"], e["d"], e["kode"])] > 1
        m = K.members[e["pid"]]
        k["_sk"], k["_varian"], k["_urut"] = e["_sk"], e["_varian"], i
        k["_m"] = {"pid": m["pid"], "rs": m["rs"], "n_riwayat": m["n_hist"], "rs_riwayat": list(m["rs_set"]), "jk": m["jk"],
                   "usia": None if m["usia"] is None else round(m["usia"], 1), "segmen_registri": m["segmen_reg"], "hak_kelas": m["hak"],
                   "sumber": m.get("sumber", "perjalanan"), "chunk": int(c)}
        out.append(k)
    return out


# ------------------------------------------------------------------------------------------------------------------
# contoh: one chunk's counts per scheme and family, fraud share and KlaimIn validation (aggregates only)
# ------------------------------------------------------------------------------------------------------------------
def contoh(c: int) -> int:
    sys.path.insert(0, str(ROOT / "api"))
    os.environ.setdefault("BLUESANDAI_AUTH", "off")
    from aip import layanan as L

    t0 = time.time()
    ks = buat(c, set())
    dt = time.time() - t0
    sk = Counter(k["_sk"] for k in ks)
    nf = sum(v for s, v in sk.items() if s != "normal")
    print(f"chunk {c}: {len(ks)} claims, fraud {nf} ({nf / len(ks):.2%}), {dt:.1f} s, seed {GARAM}")
    fam = Counter()
    for s, v in sorted(sk.items()):
        if s != "normal":
            fam[SKEMA4[s]["famili"]] += v
            print(f"  {s:28s} {SKEMA4[s]['famili']:10s} {SKEMA4[s]['mode']}  {v}")
    print("  families:", dict(fam))
    bad = 0
    for b in ks:
        x = {k: v for k, v in b.items() if k in L.KlaimIn.model_fields}
        for k in SPECIALS:
            x[k] = int(x.get(k) or 0)
        x = {k: v for k, v in x.items() if v is not None or k in ("tipe_fkrtl", "prosedur")}
        try:
            L.KlaimIn.model_validate(x)
        except Exception:  # noqa: BLE001
            bad += 1
    print(f"  KlaimIn invalid: {bad}")
    return 0 if bad == 0 and ks else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "contoh":
        sys.exit(contoh(int(sys.argv[2])))
    print(__doc__)
