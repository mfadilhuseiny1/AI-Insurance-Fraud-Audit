"""Rekam medis elektronik (RME) against the claim: the electronic medical record a hospital keeps in SATUSEHAT (FHIR R4,
Kemenkes ID Core Implementation Guide 0.3.16, https://ig.fhir-indonesia.org) read as evidence for the claim it bills.

The BPJS request (2026-11-14): the rule engine did not read the hospital's medical record at all. A claim can bill a cardiac
catheterisation that the record never mentions, while every blood pressure and oxygen saturation in that record is normal.
This module is the cross-check.

  contract   one FHIR R4 Bundle per claim (`rekam_medis`, any Bundle.type: collection, document, transaction, searchset),
             SATUSEHAT ID Core resources: Patient, Encounter, Condition, Procedure, Observation, ServiceRequest,
             DiagnosticReport, MedicationRequest / MedicationDispense / MedicationAdministration, Medication, Device. Codes as the
             IG binds them: ICD-10 (http://hl7.org/fhir/sid/icd-10) for diagnoses, ICD-9-CM (http://hl7.org/fhir/sid/icd-9-cm)
             for procedures, LOINC (http://loinc.org) for vital signs and laboratory, KFA for medicines. json_schema() is the
             machine-readable form (docs/rme_satusehat_bundle.schema.json, GET /api/aip/realtime/v1/rme/skema).
  read       baca(): the Bundle -> a compact clinical summary (encounters, diagnoses, procedures, measured values with their
             normal/abnormal flag, medicines, devices) plus structural problems. Nothing outside the summary is kept, and no
             NIK or name: the patient's sex and birth date only, for the identity check.
  rules      periksa(): the claim against the summary. Every finding is a signal of the engine (modus.SIGNALS, RME_*) with its
             evidence in plain words and numbers, and one row per checked item for the auditor's table (white box):
               RME_KUNJUNGAN_TIDAK_ADA        no encounter in the record overlaps the billed stay              (M06)
               RME_JENIS_RAWAT_BERBEDA        billed as inpatient, the record has an outpatient/ER visit only  (M04, M06)
               RME_LOS_TIDAK_SESUAI           billed stay longer than the recorded encounter                    (M12)
               RME_PASIEN_BERBEDA             the record's patient is another sex / birth date than the card    (M06)
               RME_TINDAKAN_TIDAK_TERCATAT    a billed significant procedure is not in the record               (M14)
               RME_KLINIS_TIDAK_MENDUKUNG     a billed procedure without its medical indication in the record   (M15)
               RME_DIAGNOSIS_TIDAK_TERCATAT   a billed diagnosis is not in the record                           (M04)
               RME_DIAGNOSIS_TIDAK_DIDUKUNG   a billed diagnosis contradicted by the record's measurements      (M04)
               RME_OBAT_ALKES_TIDAK_TERCATAT  billed drugs / implants (special CMG top-up, lines) not in record  (M17)
               RME_KELAS_BERBEDA              billed ward class above the encounter's service class             (M13)
               RME_EPISODE_DIPECAH            the recorded stay began before / ran past the billed one          (M09)
               RME_RAWAT_INAP_TANPA_INDIKASI  an inpatient stay whose every measurement is normal, no procedure (M15)
               RME_KUNJUNGAN_DIPAKAI_ULANG    one recorded encounter billed by two claims (needs state: the
                                              engine and rme_batch keep which claim used each encounter)        (M11)
             added 2026-11-15 (the record's own times, quantities and the stay in its context):
               RME_VENTILASI_TIDAK_SESUAI     96.72 / >= 96 ventilator hours billed, the record's ventilation
                                              (Procedure.performedPeriod, DeviceUseStatement) < 96 h or 96.71    (M04, M14)
               RME_HARI_ICU_LEBIH             ICU days billed > the ICU periods of Encounter.location           (M12, M13)
               RME_OBAT_JUMLAH_KURANG         drug quantity billed > MedicationDispense quantity / administrations (M18)
               RME_READMISI_TERENCANA         a planned readmission (reAdmission, or the earlier discharge
                                              summary's plan) with no significant procedure and normal values    (M16)
               RME_READMISI_PULANG_DINI       admitted again <= 7 days after a discharge with unstable vitals    (M09, M16)
               RME_RUJUKAN_TANPA_INDIKASI     transferred in from another hospital, no reason, normal values     (M10)
               RME_DOKTER_PASIEN_DIPUTAR      the same doctor treating this patient at other hospitals <= 30 d   (M10)
             The last four read the patient's other encounters: those in the Bundle, and those the engine kept from
             earlier claims' records (jejak, `riwayat`). Review findings (PERLU_TELAAH), not proof.
  knowledge  TINDAKAN_KLINIS (procedure groups, cardiac first: catheterisation, PCI, CABG, pacemaker/ICD, EP/ablation,
             valve; then ventilation, transfusion, dialysis, caesarean, appendectomy) with the diagnoses, measurements and
             devices that indicate each; DX_KLINIS (diagnoses that a measurement confirms or contradicts: respiratory failure,
             shock, sepsis, acute MI, anaemia, electrolytes, AKI, hypertensive crisis ...). A working clinical subset written
             for this demonstration, to be reviewed by BPJS's medical advisers (TKMKB) before any use on real claims.

A missing record raises nothing: hospitals not yet connected to SATUSEHAT are not penalised. A record with no clinical data
at all (encounter only) mitigates the absence findings: it shows poor documentation, not by itself a fictitious service.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional

VERSI = "rme-1"
IG = "Kemenkes ID Core FHIR IG 0.3.16 (SATUSEHAT), FHIR R4 4.0.1"
PROFIL = "https://fhir.kemkes.go.id/r4/StructureDefinition/id-core-"
SYS_ICD10 = "http://hl7.org/fhir/sid/icd-10"
SYS_ICD9 = "http://hl7.org/fhir/sid/icd-9-cm"
SYS_LOINC = "http://loinc.org"
SYS_SNOMED = "http://snomed.info/sct"
SYS_IHS = "https://fhir.kemkes.go.id/id/patient-ihs-number"
SYS_NIK = "https://fhir.kemkes.go.id/id/nik"
SYS_KFA = "http://sys-ids.kemkes.go.id/kfa"
SYS_ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
SYS_OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category"
SYS_INTERP = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"
MAKS_ENTRI = 3000
MAKS_OBS = 2000
DIBACA = ("Patient", "Encounter", "Condition", "Procedure", "Observation", "ServiceRequest", "DiagnosticReport", "MedicationRequest",
          "MedicationDispense", "MedicationAdministration", "Medication", "Device", "DeviceUseStatement", "Composition")
BATAL = {"cancelled", "entered-in-error"}

# =====================================================================================================================
# measured parameters: LOINC codes, unit, adult normal range (sex/age adjusted below)
# =====================================================================================================================
# name -> (label, unit, normal low, normal high, LOINC codes)
PARAM: dict[str, tuple[str, str, Optional[float], Optional[float], frozenset]] = {
    "sistolik": ("tekanan darah sistolik", "mmHg", 90, 139, frozenset({"8480-6", "8459-0", "8460-8"})),
    "diastolik": ("tekanan darah diastolik", "mmHg", 60, 89, frozenset({"8462-4", "8453-3", "8454-1"})),
    "nadi": ("denyut nadi", "x/menit", 60, 100, frozenset({"8867-4", "8889-8", "76282-3"})),
    "napas": ("frekuensi napas", "x/menit", 12, 20, frozenset({"9279-1"})),
    "suhu": ("suhu tubuh", "°C", 36.0, 37.5, frozenset({"8310-5", "8331-1", "8328-7", "8332-9"})),
    "spo2": ("saturasi oksigen", "%", 95, 100, frozenset({"59408-5", "2708-6", "20564-1", "59417-6"})),
    "gcs": ("GCS", "", 15, 15, frozenset({"9269-2"})),
    "troponin": ("troponin", "", None, None, frozenset({"10839-9", "6598-7", "89579-7", "67151-1", "49563-0", "42757-5", "16255-2", "48425-3"})),
    "hb": ("hemoglobin", "g/dL", 12.0, 17.5, frozenset({"718-7", "20509-6", "30313-1"})),
    "trombosit": ("trombosit", "rb/µL", 150, 450, frozenset({"777-3", "26515-7", "778-1"})),
    "leukosit": ("leukosit", "rb/µL", 4.0, 11.0, frozenset({"6690-2", "26464-8", "804-5"})),
    "kreatinin": ("kreatinin", "mg/dL", 0.5, 1.3, frozenset({"2160-0", "38483-4"})),
    "ureum": ("ureum/BUN", "mg/dL", 7, 20, frozenset({"3094-0", "6299-2"})),
    "natrium": ("natrium", "mmol/L", 135, 145, frozenset({"2951-2", "2947-0"})),
    "kalium": ("kalium", "mmol/L", 3.5, 5.0, frozenset({"2823-3", "6298-4"})),
    "po2": ("pO2 arteri", "mmHg", 80, 100, frozenset({"2703-7"})),
    "pco2": ("pCO2 arteri", "mmHg", 35, 45, frozenset({"2019-8"})),
    "laktat": ("laktat", "mmol/L", 0.5, 2.0, frozenset({"2524-7", "32693-4"})),
    "glukosa": ("glukosa darah", "mg/dL", 70, 200, frozenset({"2345-7", "2339-0", "41653-7"})),
    "prokalsitonin": ("prokalsitonin", "ng/mL", 0, 0.5, frozenset({"33959-8", "75241-0"})),
    "ekg": ("EKG", "", None, None, frozenset({"11524-6", "34534-8", "8601-7", "18844-1", "28010-7"})),
    "ekokardiografi": ("ekokardiografi", "", None, None, frozenset({"34552-0", "42148-7", "59282-4", "18106-5"})),
    "fio2": ("oksigen tambahan (FiO2/aliran)", "", None, None, frozenset({"3150-0", "3151-8", "19994-3"})),
}
LOINC_PARAM = {code: name for name, v in PARAM.items() for code in v[4]}
VITAL = ("sistolik", "diastolik", "nadi", "napas", "suhu", "spo2")
BENTUK = ("ekg", "ekokardiografi")  # findings read as normal/abnormal, not as a number
# BP panels (85354-9, 55284-4) carry systolic/diastolic as components; read from the components
PANEL_TD = {"85354-9", "55284-4", "35094-2"}
# hospital-side device states (ai-jkn lib/faskes/fhir.ts: urn:ai-jkn:iomt-metric, valueBoolean)
STATUS_ALAT = {"ventilation_active": "ventilator", "dialysis_active": "dialisis"}
# troponin upper reference limit by unit, when the record gives neither a reference range nor an interpretation
TROPONIN_ULN = {"ng/l": 14.0, "pg/ml": 14.0, "ng/ml": 0.04, "ug/l": 0.04, "µg/l": 0.04, "mcg/l": 0.04}
KATA_ABNORMAL = ("abnormal", "elevas", "depres", "iskemi", "infark", "stemi", "blok", "block", "fibrilasi", "fibrillation", "takikardi",
                 "tachycard", "bradikardi", "bradycard", "flutter", "q patologis", "lbbb", "rbbb", "stenosis", "regurgitasi", "hipokinetik",
                 "ef rendah", "reduced ejection")
KATA_NORMAL = ("normal", "dalam batas normal", "sinus rhythm", "irama sinus", "tidak ada kelainan", "within normal")
_NEGASI = re.compile(r"\b(?:tidak (?:ada|tampak|didapatkan|ditemukan|terdapat)|tak ada|tanpa|bukan|no|without|negatif|negative)\b")
_KLAUSA = re.compile(r"[,;.\n]|\bdan\b|\band\b")


def teks_abn(t: str) -> Optional[str]:
    """A finding written in words -> 'A' (abnormal), 'N' (normal) or None, clause by clause and aware of negation: "irama sinus
    normal, tidak ada perubahan iskemik" is normal (a negated abnormal word), "EKG tidak normal" is abnormal. Before 2026-11-15
    the abnormal words were matched on the whole text, so that normal ECG read as ischaemic and gave a procedure an indication."""
    t = (t or "").lower()
    abn = norm = False
    for c in _KLAUSA.split(t):
        if not c.strip():
            continue
        kata_abn = any(w in c for w in KATA_ABNORMAL)
        if re.search(r"\b(?:tidak|tak|bukan|not)\s+(?:normal|stabil)\b|\bbelum stabil\b", c):  # "EKG tidak normal"
            abn = True
            continue
        if _NEGASI.search(c):
            if kata_abn or "kelainan" in c:
                norm = True
            elif "normal" in c or "stabil" in c:
                abn = True
            continue
        if kata_abn:
            abn = True
        elif any(w in c for w in KATA_NORMAL):
            norm = True
    return "A" if abn else "N" if norm else None


def rentang(param: str, jk: Optional[str] = None, umur: Optional[float] = None) -> tuple[Optional[float], Optional[float]]:
    """The normal range of a parameter for this patient (children's vital signs differ; haemoglobin by sex)."""
    _, _, lo, hi, _ = PARAM[param]
    if umur is not None and umur < 1:
        lo, hi = {"nadi": (100, 160), "napas": (30, 60), "sistolik": (65, 100), "diastolik": (35, 65)}.get(param, (lo, hi))
    elif umur is not None and umur < 12:
        lo, hi = {"nadi": (70, 130), "napas": (18, 30), "sistolik": (80, 120), "diastolik": (50, 80), "hb": (11.0, 15.5)}.get(param, (lo, hi))
    elif param == "hb":
        lo = 12.0 if jk == "P" else 13.0
    return lo, hi


# =====================================================================================================================
# clinical knowledge: procedure groups and the evidence that indicates them
# =====================================================================================================================
# kriteria: (param, ">"/"<", threshold) a measurement that indicates; "abn" for EKG/echo/troponin = flagged abnormal / above ULN
JANTUNG_DX = ("I20", "I21", "I22", "I23", "I24", "I25")
TINDAKAN_KLINIS: dict[str, dict[str, Any]] = {
    "kateterisasi_jantung": {
        "nama": "kateterisasi jantung / angiografi koroner",
        "kode": ("3721", "3722", "3723", "8852", "8853", "8854", "8855", "8856", "8857"),
        "dx": JANTUNG_DX + ("I34", "I35", "I42", "I50", "I51", "Q20", "Q21", "Q22", "Q23", "Q24", "Q25", "R07", "R943", "Z034", "Z035"),
        "kriteria": [("troponin", "abn", None), ("ekg", "abn", None), ("ekokardiografi", "abn", None)],
        "kontra": ("sistolik", "diastolik", "nadi", "spo2", "troponin", "ekg"),
        "dokumen": "laporan tindakan kateterisasi (cath lab report) dan hasil angiografi; EKG, troponin dan dasar indikasi sebelum tindakan",
    },
    "pci": {
        "nama": "intervensi koroner perkutan (PCI / pemasangan stent)",
        "kode": ("0066", "3601", "3602", "3605", "3606", "3607", "3609", "0045", "0046", "0047", "0048"),
        "dx": JANTUNG_DX,
        "kriteria": [("troponin", "abn", None), ("ekg", "abn", None)],
        "kontra": ("sistolik", "diastolik", "nadi", "spo2", "troponin", "ekg"),
        "alat": ("stent",),
        "dokumen": "laporan PCI dan hasil angiografi (lesi, persen stenosis), nomor seri dan stiker stent, EKG dan troponin",
    },
    "cabg": {
        "nama": "bedah pintas arteri koroner (CABG)",
        "kode": ("3610", "3611", "3612", "3613", "3614", "3615", "3616", "3617", "3619"),
        "dx": JANTUNG_DX,
        "kriteria": [("troponin", "abn", None), ("ekg", "abn", None), ("ekokardiografi", "abn", None)],
        "kontra": ("troponin", "ekg"),
        "dokumen": "laporan operasi, hasil angiografi pra-bedah, catatan anestesi dan ICU",
    },
    "pacu_jantung": {
        "nama": "pemasangan alat pacu jantung / ICD",
        "kode": ("3770", "3771", "3772", "3773", "3774", "3776", "3778", "3780", "3781", "3782", "3783", "3785", "3786", "3787", "3794",
                 "3795", "3796", "0050", "0051"),
        "dx": ("I44", "I45", "I46", "I47", "I49", "I42", "I50", "R001", "R55"),
        "kriteria": [("nadi", "<", 50), ("nadi", ">", 150), ("ekg", "abn", None)],
        "kontra": ("nadi", "ekg"),
        "alat": ("pacemaker", "pacu", "icd", "defibrilator", "defibrillator"),
        "dokumen": "EKG/Holter yang menunjukkan bradiaritmia atau aritmia, laporan pemasangan, nomor seri alat",
    },
    "ablasi_ep": {
        "nama": "studi elektrofisiologi / ablasi",
        "kode": ("3726", "3727", "3734"),
        "dx": ("I47", "I48", "I49", "I456"),
        "kriteria": [("nadi", ">", 120), ("ekg", "abn", None)],
        "kontra": ("nadi", "ekg"),
        "dokumen": "EKG/Holter aritmia, laporan studi elektrofisiologi",
    },
    "katup_jantung": {
        "nama": "operasi / penggantian katup jantung",
        "kode": ("350", "351", "352", "3596", "3597"),
        "dx": ("I05", "I06", "I07", "I08", "I33", "I34", "I35", "I36", "I37", "I38", "I39", "Q22", "Q23"),
        "kriteria": [("ekokardiografi", "abn", None)],
        "kontra": ("ekokardiografi",),
        "dokumen": "hasil ekokardiografi, laporan operasi",
    },
    "ventilasi_mekanik": {
        "nama": "ventilasi mekanik / intubasi",
        "kode": ("9670", "9671", "9672", "9604", "9390", "9391"),
        "dx": ("J96", "J80", "J81", "R092", "I46", "R402", "P22", "P28", "T71", "J46", "J441", "G934", "I50", "R57", "I21", "I22", "I60", "I61",
               "I62", "I63"),
        "kriteria": [("spo2", "<", 90), ("napas", ">", 30), ("napas", "<", 8), ("gcs", "<", 9), ("po2", "<", 60), ("pco2", ">", 50)],
        # no contradiction from normal saturation or breathing: on a ventilator they are normal because of it
        "kontra": (),
        "pasca_bedah": True,
        "alat": ("ventilator",),
        "dokumen": "lembar observasi ventilator (setting, jam pasang dan lepas), analisis gas darah, catatan ICU",
    },
    "transfusi": {
        "nama": "transfusi darah",
        "kode": ("9903", "9904", "9905", "9906", "9907"),
        "dx": ("D5", "D60", "D61", "D62", "D63", "D64", "D65", "D66", "D67", "D68", "D69", "K92", "K25", "K26", "K27", "K28", "O72", "O46",
               "O67", "O44", "N18", "B50", "B51", "B52", "B53", "B54", "A91", "C"),
        "kriteria": [("hb", "<", 8), ("trombosit", "<", 50)],
        "kontra": ("hb", "trombosit"),
        "pasca_bedah": True,  # perioperative blood loss
        "dokumen": "hasil hemoglobin/trombosit pra-transfusi, formulir permintaan darah, label kantong darah",
    },
    "hemodialisis": {
        "nama": "hemodialisis",
        "kode": ("3995", "5498"),
        "dx": ("N17", "N18", "N19", "E875", "T56", "T39"),
        "kriteria": [("kreatinin", ">", 4.0), ("kalium", ">", 6.0), ("ureum", ">", 80)],
        "kontra": ("kreatinin",),
        "alat": ("dialisis", "dialysis", "hemodialisis"),
        "dokumen": "hasil kreatinin/ureum/kalium, lembar tindakan hemodialisis",
    },
    "operasi_sesar": {
        "nama": "seksio sesarea",
        "kode": ("740", "741", "742", "744", "7499"),
        "dx": ("O", "Z37", "Z38"),
        "kriteria": [],
        "kontra": (),
        "dokumen": "laporan operasi, partograf, indikasi sesar",
    },
    "apendektomi": {
        "nama": "apendektomi",
        "kode": ("470",),
        "dx": ("K35", "K36", "K37", "K38", "R10"),
        "kriteria": [("leukosit", ">", 11.0)],
        "kontra": (),
        "dokumen": "laporan operasi, hasil patologi anatomi",
    },
}
# non-operative procedures that change the claim (the rest of ICD-9-CM 87-99 is diagnostics and minor therapy that SATUSEHAT
# records as Observation / DiagnosticReport / ImagingStudy rather than Procedure: not checked for absence)
NONOP_BERMAKNA = ("9670", "9671", "9672", "9604", "9390", "9391", "9903", "9904", "9905", "9906", "9907", "9925", "922", "8852", "8853",
                  "8854", "8855", "8856", "8857", "9962", "9960")
OKSIGEN = ("9396", "9394")  # oxygen therapy (ICD-9-CM 93.96 / 93.94)

# diagnoses a measurement confirms or contradicts: kriteria (as above) indicate; contradicted when every measurement of the
# listed parameters is normal (with at least `min` measurements)
DX_KLINIS: dict[str, dict[str, Any]] = {
    "J96": {"nama": "gagal napas", "kriteria": [("spo2", "<", 92), ("napas", ">", 24), ("po2", "<", 60), ("pco2", ">", 50)],
            "kontra": ("spo2", "napas"), "min": 3, "oksigen": True},
    "J80": {"nama": "ARDS", "kriteria": [("spo2", "<", 92), ("po2", "<", 60)], "kontra": ("spo2",), "min": 3, "oksigen": True},
    "R57": {"nama": "syok", "kriteria": [("sistolik", "<", 90), ("laktat", ">", 2.0)], "kontra": ("sistolik",), "min": 3},
    "R652": {"nama": "syok septik", "kriteria": [("sistolik", "<", 90), ("laktat", ">", 2.0)], "kontra": ("sistolik",), "min": 3},
    "A41": {"nama": "sepsis", "kriteria": [("suhu", ">", 38.0), ("suhu", "<", 36.0), ("nadi", ">", 90), ("napas", ">", 20), ("leukosit", ">", 12.0),
                                           ("leukosit", "<", 4.0), ("prokalsitonin", ">", 0.5), ("laktat", ">", 2.0)],
            "kontra": ("suhu", "nadi", "napas", "leukosit"), "min": 4, "min_kriteria": 2},  # SIRS: at least two criteria
    "I21": {"nama": "infark miokard akut", "kriteria": [("troponin", "abn", None), ("ekg", "abn", None)], "kontra": ("troponin",), "min": 2},
    "I22": {"nama": "infark miokard berulang", "kriteria": [("troponin", "abn", None), ("ekg", "abn", None)], "kontra": ("troponin",), "min": 2},
    # unstable angina is a clinical diagnosis: troponin is normal by definition and the resting ECG often is (2026-11-15: once the
    # ECG parser read "tidak ada perubahan iskemik" as normal, this contradicted 32 honest claims of the tuning replicas)
    "I200": {"nama": "angina tidak stabil", "kriteria": [("troponin", "abn", None), ("ekg", "abn", None)], "kontra": (), "min": 1},
    "I50": {"nama": "gagal jantung", "kriteria": [("ekokardiografi", "abn", None), ("spo2", "<", 92), ("napas", ">", 24)],
            "kontra": ("ekokardiografi",), "min": 1},
    # paroxysmal AF and intermittent AV block are invisible between episodes: one normal ECG is a weak contradiction (min 2)
    "I48": {"nama": "fibrilasi atrium", "kriteria": [("ekg", "abn", None), ("nadi", ">", 110)], "kontra": ("ekg",), "min": 2},
    "I44": {"nama": "blok atrioventrikular", "kriteria": [("ekg", "abn", None), ("nadi", "<", 50)], "kontra": ("ekg",), "min": 2},
    "R001": {"nama": "bradikardia", "kriteria": [("nadi", "<", 60)], "kontra": ("nadi",), "min": 3},
    "R000": {"nama": "takikardia", "kriteria": [("nadi", ">", 100)], "kontra": ("nadi",), "min": 3},
    "I16": {"nama": "krisis hipertensi", "kriteria": [("sistolik", ">", 179), ("diastolik", ">", 119)], "kontra": ("sistolik", "diastolik"), "min": 2,
            "batas_kontra": {"sistolik": 160, "diastolik": 100}},
    "D62": {"nama": "anemia pascaperdarahan akut", "kriteria": [("hb", "<", None)], "kontra": ("hb",), "min": 1},
    "D64": {"nama": "anemia", "kriteria": [("hb", "<", None)], "kontra": ("hb",), "min": 1},
    "D50": {"nama": "anemia defisiensi besi", "kriteria": [("hb", "<", None)], "kontra": ("hb",), "min": 1},
    "D696": {"nama": "trombositopenia", "kriteria": [("trombosit", "<", 150)], "kontra": ("trombosit",), "min": 1},
    "E871": {"nama": "hiponatremia", "kriteria": [("natrium", "<", 135)], "kontra": ("natrium",), "min": 1},
    "E876": {"nama": "hipokalemia", "kriteria": [("kalium", "<", 3.5)], "kontra": ("kalium",), "min": 1},
    "E875": {"nama": "hiperkalemia", "kriteria": [("kalium", ">", 5.0)], "kontra": ("kalium",), "min": 1},
    "N17": {"nama": "gangguan ginjal akut", "kriteria": [("kreatinin", ">", 1.3)], "kontra": ("kreatinin",), "min": 1},
    "E162": {"nama": "hipoglikemia", "kriteria": [("glukosa", "<", 70)], "kontra": ("glukosa",), "min": 2},
    "R402": {"nama": "koma", "kriteria": [("gcs", "<", 9)], "kontra": ("gcs",), "min": 2},
    "R50": {"nama": "demam", "kriteria": [("suhu", ">", 37.5)], "kontra": ("suhu",), "min": 3},
}


# =====================================================================================================================
# codes
# =====================================================================================================================
def icd10(s: Any) -> Optional[str]:
    """'J18.9', 'j189', 'J18' -> 'J189' / 'J18' (no dot, upper case), or None."""
    m = re.match(r"^\s*([A-Za-z])\s*(\d{2})\.?\s*([0-9A-Za-z]{0,4})", str(s or ""))
    return (m.group(1) + m.group(2) + m.group(3)).upper() if m else None


def icd10_tampil(k: str) -> str:
    return k[:3] + ("." + k[3:] if len(k) > 3 else "")


def icd9(s: Any) -> Optional[str]:
    """An ICD-9-CM procedure code from '37.23', '3723', '3723 - Combined right and left heart ...', '96.04 Intubasi' -> '3723'."""
    m = re.match(r"^\s*(\d{2})(?:\.?(\d{1,2}))?(?=\D|$)", str(s or ""))
    return (m.group(1) + (m.group(2) or "")) if m else None


def icd9_tampil(k: str) -> str:
    return k[:2] + ("." + k[2:] if len(k) > 2 else "")


def _mulai(kode: str, awalan: Iterable[str]) -> bool:
    return any(kode.startswith(a) for a in awalan)


def grup_tindakan(kode: str) -> Optional[str]:
    for g, d in TINDAKAN_KLINIS.items():
        if _mulai(kode, d["kode"]):
            return g
    return None


def bermakna(kode: str) -> bool:
    """A procedure that changes the claim (operative ICD-9-CM 01-86, or a significant non-operative one)."""
    return bool(grup_tindakan(kode)) or (kode[:2].isdigit() and 1 <= int(kode[:2]) <= 86) or _mulai(kode, NONOP_BERMAKNA)


def dx_klinis(kode: str) -> Optional[str]:
    """The DX_KLINIS key of a diagnosis code (the longest matching prefix)."""
    best = None
    for k in DX_KLINIS:
        if kode.startswith(k) and (best is None or len(k) > len(best)):
            best = k
    return best


# =====================================================================================================================
# read a Bundle
# =====================================================================================================================
def _tgl(v: Any) -> Optional[date]:
    try:
        return date.fromisoformat(str(v)[:10]) if v else None
    except ValueError:
        return None


_KATA_ICU = re.compile(r"\b(?:ICU|ICCU|HCU|NICU|PICU|CVCU|IMCU|INTENSIF|INTENSIVE)\b", re.I)


def _icu(teks: str) -> bool:
    return bool(_KATA_ICU.search(teks or ""))


def _dtm(v: Any) -> Optional[datetime]:
    """An ISO 8601 date-time -> an aware datetime (no offset: WIB), or None."""
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone(timedelta(hours=7)))


def _waktu(r: dict) -> Optional[str]:
    for k in ("effectiveDateTime", "effectiveInstant", "performedDateTime", "authoredOn", "whenHandedOver", "onsetDateTime", "recordedDate",
              "issued", "occurrenceDateTime"):
        if r.get(k):
            return str(r[k])[:19]
    for k in ("effectivePeriod", "performedPeriod", "occurrencePeriod", "onsetPeriod"):
        p = r.get(k) or {}
        if p.get("start"):
            return str(p["start"])[:19]
    return None


def _codings(cc: Any) -> list[dict]:
    if isinstance(cc, dict):
        return [c for c in cc.get("coding") or [] if isinstance(c, dict)]
    return []


def _kode_sistem(cc: Any, sistem: str) -> Optional[dict]:
    return next((c for c in _codings(cc) if c.get("system") == sistem and c.get("code")), None)


def _teks(cc: Any) -> str:
    if not isinstance(cc, dict):
        return ""
    return str(cc.get("text") or next((c.get("display") for c in _codings(cc) if c.get("display")), "") or "")[:200]


def _ref(r: dict, *keys: str) -> Optional[dict]:
    for k in keys:
        v = r.get(k)
        if isinstance(v, dict):
            return v
    return None


def _abn_interp(r: dict) -> Optional[str]:
    """'H', 'L', 'A' (abnormal) or 'N' from Observation.interpretation, else None."""
    for cc in r.get("interpretation") or []:
        for c in _codings(cc):
            code = str(c.get("code") or "").upper()
            if code in ("H", "HH", "HU", "H>"):
                return "H"
            if code in ("L", "LL", "LU", "L<"):
                return "L"
            if code in ("A", "AA", "POS", "DET"):
                return "A"
            if code in ("N", "NEG", "ND"):
                return "N"
        t = _teks(cc).lower()
        if t:
            return teks_abn(t)
    return None


def _abn_rr(r: dict, v: Optional[float]) -> Optional[str]:
    if v is None:
        return None
    for rr in r.get("referenceRange") or []:
        lo = (rr.get("low") or {}).get("value")
        hi = (rr.get("high") or {}).get("value")
        if hi is not None and v > float(hi):
            return "H"
        if lo is not None and v < float(lo):
            return "L"
        if lo is not None or hi is not None:
            return "N"
    return None


def _uln(r: dict) -> Optional[float]:
    for rr in r.get("referenceRange") or []:
        hi = (rr.get("high") or {}).get("value")
        if hi:
            return float(hi)
    return None


def _satuan(param: str, v: float, unit: str) -> float:
    """Convert the common alternative units to the catalogue's (g/L Hb, µmol/L creatinine, mmol/L glucose, /µL platelets)."""
    u = (unit or "").lower().replace(" ", "")
    if param == "hb" and (u in ("g/l",) or v > 30):
        return v / 10
    if param == "kreatinin" and ("umol" in u or "µmol" in u or v > 20):
        return v / 88.4
    if param == "glukosa" and "mmol" in u:
        return v * 18
    if param in ("trombosit", "leukosit") and v > 2000:
        return v / 1000
    if param == "suhu" and v > 50:  # Fahrenheit
        return (v - 32) * 5 / 9
    return v


def _nilai_obs(r: dict) -> tuple[Optional[float], str]:
    q = r.get("valueQuantity")
    if isinstance(q, dict) and q.get("value") is not None:
        try:
            return float(q["value"]), str(q.get("unit") or q.get("code") or "")
        except (TypeError, ValueError):
            return None, ""
    if r.get("valueInteger") is not None:
        return float(r["valueInteger"]), ""
    return None, ""


def _obs_baris(r: dict, code: str, nama: str, t: Optional[str], enc: Optional[str], jk: Optional[str], umur: Optional[float]) -> Optional[dict]:
    """One measured value: its parameter, the value in the catalogue's unit and its flag (interpretation, then the record's
    reference range, then the catalogue's normal range)."""
    p = LOINC_PARAM.get(code)
    v, unit = _nilai_obs(r)
    flag = _abn_interp(r)
    if p in BENTUK:
        if flag is None:
            t2 = (_teks(r.get("valueCodeableConcept")) + " " + str(r.get("valueString") or "")).lower()
            flag = teks_abn(t2)
        return {"p": p, "loinc": code, "nama": nama or PARAM[p][0], "v": None, "u": "", "t": t, "enc": enc, "abn": flag}
    if p == "fio2":
        return {"p": p, "loinc": code, "nama": nama or PARAM[p][0], "v": v, "u": unit, "t": t, "enc": enc, "abn": "A"}
    if p == "troponin" and v is not None:
        uln = _uln(r) or TROPONIN_ULN.get(unit.lower().replace(" ", ""), None)
        if flag is None and uln:
            flag = "H" if v > uln else "N"
        return {"p": p, "loinc": code, "nama": nama or "troponin", "v": v, "u": unit, "t": t, "enc": enc, "abn": flag, "uln": uln}
    if p and v is not None:
        v = round(_satuan(p, v, unit), 3)
        src = "interp" if flag else None
        if flag is None:
            flag = _abn_rr(r, v)
            src = "rr" if flag else None
        if flag is None:  # the catalogue's range: re-evaluated with the patient's age when the claim is checked (_Ukur)
            lo, hi = rentang(p, jk, umur)
            flag = "H" if (hi is not None and v > hi) else "L" if (lo is not None and v < lo) else "N"
            src = "rentang"
        return {"p": p, "loinc": code, "nama": nama or PARAM[p][0], "v": v, "u": PARAM[p][1] or unit, "t": t, "enc": enc, "abn": flag, "src": src}
    if p is None and (v is not None or flag):
        return {"p": None, "loinc": code, "nama": nama, "v": v, "u": unit, "t": t, "enc": enc, "abn": flag}
    return None


def baca(bundle: Any, jk_peserta: Optional[str] = None, umur_peserta: Optional[float] = None) -> dict:
    """A FHIR R4 Bundle (SATUSEHAT) -> the clinical summary periksa() reads, with the structural problems found. Never raises
    on content: an unusable record comes back with ok=False and the reason."""
    out: dict[str, Any] = {"versi": VERSI, "ok": False, "masalah": [], "peringatan": [], "jumlah": {}, "pasien": {}, "kunjungan": [],
                           "diagnosis": [], "tindakan": [], "permintaan": [], "observasi": [], "obat": [], "alat": [], "laporan": [], "resume": [],
                           "kode_lain": []}
    if not isinstance(bundle, dict) or bundle.get("resourceType") != "Bundle":
        out["masalah"].append("bukan FHIR Bundle (resourceType harus 'Bundle')")
        return out
    entries = bundle.get("entry") or []
    if not isinstance(entries, list):
        out["masalah"].append("Bundle.entry harus berupa daftar")
        return out
    if len(entries) > MAKS_ENTRI:
        out["masalah"].append(f"Bundle memuat {len(entries)} entri, batasnya {MAKS_ENTRI} per klaim")
        return out
    res: list[tuple[str, dict]] = []
    for e in entries:
        r = (e or {}).get("resource") if isinstance(e, dict) else None
        if isinstance(r, dict) and r.get("resourceType"):
            res.append((str(e.get("fullUrl") or ""), r))
    jumlah: dict[str, int] = {}
    loc_nama: dict[str, str] = {}
    for url, r in res:
        jumlah[r["resourceType"]] = jumlah.get(r["resourceType"], 0) + 1
        if r["resourceType"] == "Location":  # an ICU is named, typed or physically typed as one
            t = " ".join([str(r.get("name") or ""), str(r.get("description") or ""), _teks(r.get("physicalType")),
                          *(_teks(x) + " " + " ".join(str(c.get("code") or "") for c in _codings(x)) for x in r.get("type") or [])])
            for key in (f"Location/{r.get('id')}", url):
                if key:
                    loc_nama[key] = t
    out["jumlah"] = jumlah
    # references: "Type/id", the fullUrl, and identifier values (the hospital-side export links by identifier)
    enc_key: dict[str, str] = {}
    meds: dict[str, dict] = {}
    for url, r in res:
        rid = r.get("id")
        keys = [k for k in (f"{r['resourceType']}/{rid}" if rid else None, url) if k]
        if r["resourceType"] == "Encounter":
            name = rid or url or f"enc{len(enc_key)}"
            for k in keys + [str(i.get("value")) for i in r.get("identifier") or [] if isinstance(i, dict) and i.get("value")]:
                enc_key[k] = name
        if r["resourceType"] == "Medication":
            for k in keys:
                meds[k] = r

    def enc_of(r: dict) -> Optional[str]:
        ref = _ref(r, "encounter", "context")
        if not ref:
            return None
        if ref.get("reference"):
            return enc_key.get(str(ref["reference"]), str(ref["reference"]))
        val = (ref.get("identifier") or {}).get("value")
        return enc_key.get(str(val), str(val)) if val else None

    # the patient first: sex and age adjust the normal ranges
    jk, lahir = jk_peserta, None
    for _, r in res:
        if r["resourceType"] == "Patient":
            g = str(r.get("gender") or "").lower()
            jk_rme = "L" if g == "male" else "P" if g == "female" else None
            lahir = _tgl(r.get("birthDate"))
            ihs = next((str(i.get("value")) for i in r.get("identifier") or [] if isinstance(i, dict) and i.get("system") == SYS_IHS), None)
            nik = any(isinstance(i, dict) and i.get("system") == SYS_NIK for i in r.get("identifier") or [])
            out["pasien"] = {"ihs": ihs, "nik_ada": nik, "jk": jk_rme, "tgl_lahir": str(lahir) if lahir else None}
            jk = jk_rme or jk
            if not ihs:
                out["peringatan"].append("Patient tanpa identifier IHS SATUSEHAT (https://fhir.kemkes.go.id/id/patient-ihs-number)")
            break
    for url, r in res:
        rt = r["resourceType"]
        if rt in ("Procedure", "MedicationRequest", "MedicationDispense", "MedicationAdministration", "DiagnosticReport", "Device", "ServiceRequest",
                  "Observation") and len(out["kode_lain"]) < 3000:
            cc = r.get("code") or r.get("medicationCodeableConcept") or r.get("type") or {}
            mref = (r.get("medicationReference") or {}).get("reference")
            if not _codings(cc) and mref and mref in meds:
                cc = meds[mref].get("code") or {}
            for c in _codings(cc):
                out["kode_lain"].append({"kode": str(c.get("code")), "teks": (_teks(cc) or "")[:120], "enc": enc_of(r), "t": _waktu(r)})
        if rt == "Encounter":
            cls = r.get("class") or {}
            kelas = str(cls.get("code") or next((c.get("code") for c in _codings(cls)), "") or "").upper() or None
            per = r.get("period") or {}
            mulai, selesai = _tgl(per.get("start")), _tgl(per.get("end"))
            if mulai is None:
                hist = [h.get("period") or {} for h in r.get("statusHistory") or [] if isinstance(h, dict)]
                starts = [_tgl(p.get("start")) for p in hist if _tgl(p.get("start"))]
                ends = [_tgl(p.get("end")) for p in hist if _tgl(p.get("end"))]
                mulai, selesai = (min(starts) if starts else None), (max(ends) if ends else selesai)
            kelas_riwayat = [str((h.get("class") or {}).get("code") or "").upper() for h in r.get("classHistory") or [] if isinstance(h, dict)]
            kelas_layanan = None
            for l in r.get("location") or []:
                for x in (l or {}).get("extension") or [] if isinstance(l, dict) else []:
                    if str(x.get("url") or "").endswith("id-core-service-class"):
                        kelas_layanan = kelas_angka(_teks(x.get("valueCodeableConcept")) or next((c.get("code") for c in _codings(x.get("valueCodeableConcept"))), None))
            lokasi = " ".join(str((l.get("location") or {}).get("display") or "") for l in r.get("location") or [] if isinstance(l, dict)).upper()
            # each location with its period (ICU days: RME_HARI_ICU_LEBIH)
            per_lok = []
            for l in r.get("location") or []:
                if not isinstance(l, dict):
                    continue
                lr_ = l.get("location") or {}
                nm_l = (str(lr_.get("display") or "") + " " + loc_nama.get(str(lr_.get("reference") or ""), "")).upper()
                pl = l.get("period") or {}
                per_lok.append({"icu": _icu(nm_l), "mulai": str(pl["start"])[:25] if pl.get("start") else None,
                                "selesai": str(pl["end"])[:25] if pl.get("end") else None, "nama": " ".join(nm_l.split())[:60]})
            hos = r.get("hospitalization") or {}
            sp = r.get("serviceProvider") or {}
            dokter = []
            for p_ in r.get("participant") or []:
                ind = (p_ or {}).get("individual") or {} if isinstance(p_, dict) else {}
                v_ = ind.get("reference") or (ind.get("identifier") or {}).get("value")
                if v_:
                    dokter.append(str(v_))
            if mulai is None:
                out["masalah"].append(f"Encounter {r.get('id') or url or '?'} tanpa period.start: tidak dapat dicocokkan dengan tanggal klaim")
            if not kelas:
                out["peringatan"].append(f"Encounter {r.get('id') or url or '?'} tanpa class (IMP/AMB/EMER)")
            dxs = []
            for d in r.get("diagnosis") or []:
                cref = (d.get("condition") or {}).get("reference") if isinstance(d, dict) else None
                if cref:
                    dxs.append(str(cref))
            out["kunjungan"].append({"id": enc_key.get(f"Encounter/{r.get('id')}", r.get("id") or url), "kelas": kelas, "kelas_riwayat": kelas_riwayat,
                                     "status": r.get("status"), "mulai": str(mulai) if mulai else None, "selesai": str(selesai) if selesai else None,
                                     "icu": _icu(lokasi) or any(x["icu"] for x in per_lok), "dx_ref": dxs, "kelas_layanan": kelas_layanan,
                                     "ident": [str(i.get("value")) for i in r.get("identifier") or [] if isinstance(i, dict) and i.get("value")][:3],
                                     "waktu_mulai": str(per.get("start"))[:25] if per.get("start") else None,
                                     "waktu_selesai": str(per.get("end"))[:25] if per.get("end") else None, "lokasi": per_lok[:20],
                                     "org": str(sp.get("reference") or (sp.get("identifier") or {}).get("value") or "") or None, "dokter": dokter[:6],
                                     "masuk_dari": next((str(c.get("code")) for c in _codings(hos.get("admitSource")) if c.get("code")), None),
                                     "readmisi": bool(hos.get("reAdmission")),
                                     "pulang_ke": next((str(c.get("code")) for c in _codings(hos.get("dischargeDisposition")) if c.get("code")), None),
                                     "alasan": bool(r.get("reasonCode") or r.get("reasonReference") or r.get("basedOn"))})
        elif rt == "Condition":
            vs = " ".join(c.get("code", "") for c in _codings(r.get("verificationStatus"))).lower()
            if any(w in vs for w in ("refuted", "entered-in-error")):
                continue
            c = _kode_sistem(r.get("code"), SYS_ICD10) or next((x for x in _codings(r.get("code")) if icd10(x.get("code"))), None)
            k = icd10(c.get("code")) if c else None
            if not k:
                out["peringatan"].append(f"Condition {r.get('id') or ''} tanpa kode ICD-10 ({SYS_ICD10})".replace("  ", " "))
                continue
            if c.get("system") != SYS_ICD10:
                out["peringatan"].append(f"Condition {icd10_tampil(k)} memakai sistem kode '{c.get('system')}', bukan {SYS_ICD10}")
            out["diagnosis"].append({"kode": k, "teks": _teks(r.get("code")), "enc": enc_of(r), "t": _waktu(r),
                                     "kategori": ",".join(x.get("code", "") for cc in r.get("category") or [] for x in _codings(cc))})
        elif rt in ("Procedure", "ServiceRequest"):
            c = _kode_sistem(r.get("code"), SYS_ICD9) or next((x for x in _codings(r.get("code")) if icd9(x.get("code"))), None)
            k = icd9(c.get("code")) if c else None
            if rt == "Procedure" and k and c.get("system") not in (SYS_ICD9, None):
                out["peringatan"].append(f"Procedure {icd9_tampil(k)} memakai sistem kode '{c.get('system')}', bukan {SYS_ICD9}")
            if rt == "Procedure" and not k:
                if _kode_sistem(r.get("code"), SYS_SNOMED) and "oxygen" in _teks(r.get("code")).lower():
                    k = "9396"
                else:
                    out["peringatan"].append(f"Procedure {r.get('id') or ''} tanpa kode ICD-9-CM ({SYS_ICD9})".replace("  ", " "))
                    continue
            if not k:
                continue
            row = {"kode": k, "teks": _teks(r.get("code")), "status": r.get("status"), "enc": enc_of(r), "t": _waktu(r)}
            pp = r.get("performedPeriod") or {}
            if pp.get("start") and pp.get("end"):  # a duration (ventilation hours: RME_VENTILASI_TIDAK_SESUAI)
                row.update(mulai=str(pp["start"])[:25], selesai=str(pp["end"])[:25])
            out["tindakan" if rt == "Procedure" else "permintaan"].append(row)
            for d in r.get("focalDevice") or []:
                nm = _teks(((d or {}).get("manipulated") or {})) or str(((d or {}).get("manipulated") or {}).get("display") or "")
                if nm:
                    out["alat"].append({"nama": nm[:120], "enc": enc_of(r)})
        elif rt == "Observation":
            if len(out["observasi"]) >= MAKS_OBS:
                continue
            t, enc = _waktu(r), enc_of(r)
            code_cc = r.get("code")
            lc = _kode_sistem(code_cc, SYS_LOINC)
            local = next((c.get("code") for c in _codings(code_cc) if c.get("code") in STATUS_ALAT), None)
            if local and r.get("valueBoolean") is True:
                out["alat"].append({"nama": STATUS_ALAT[local], "enc": enc, "t": t})
                continue
            code = str(lc.get("code")) if lc else ""
            if code in PANEL_TD or r.get("component"):
                for comp in r.get("component") or []:
                    cl = _kode_sistem((comp or {}).get("code"), SYS_LOINC)
                    if cl:
                        b = _obs_baris(comp, str(cl.get("code")), _teks(comp.get("code")), t, enc, jk, None)
                        if b:
                            out["observasi"].append(b)
                if code in PANEL_TD:
                    continue
            if code:
                b = _obs_baris(r, code, _teks(code_cc), t, enc, jk, None)
                if b:
                    out["observasi"].append(b)
        elif rt == "DiagnosticReport":
            lc = _kode_sistem(r.get("code"), SYS_LOINC)
            code = str(lc.get("code")) if lc else ""
            concl = (str(r.get("conclusion") or "") + " " + " ".join(_teks(cc) for cc in r.get("conclusionCode") or [])).strip()
            p = LOINC_PARAM.get(code)
            if p in BENTUK:
                tl = concl.lower()
                flag = teks_abn(tl)
                out["observasi"].append({"p": p, "loinc": code, "nama": _teks(r.get("code")) or PARAM[p][0], "v": None, "u": "", "t": _waktu(r),
                                         "enc": enc_of(r), "abn": flag, "teks": concl[:160]})
            out["laporan"].append({"loinc": code, "nama": _teks(r.get("code"))[:120], "kesimpulan": concl[:200], "enc": enc_of(r), "t": _waktu(r)})
        elif rt in ("MedicationRequest", "MedicationDispense", "MedicationAdministration", "MedicationStatement"):
            cc = r.get("medicationCodeableConcept")
            mref = (r.get("medicationReference") or {}).get("reference")
            if not cc and mref and mref in meds:
                cc = meds[mref].get("code")
            kfa = _kode_sistem(cc, SYS_KFA)
            any_c = kfa or next(iter(_codings(cc)), None)
            jenis = {"MedicationRequest": "resep", "MedicationDispense": "serah", "MedicationAdministration": "beri"}.get(rt, "catat")
            q = r.get("quantity") if rt == "MedicationDispense" else None
            try:
                jml = float(q["value"]) if isinstance(q, dict) and q.get("value") is not None else None
            except (TypeError, ValueError):
                jml = None
            out["obat"].append({"kode": str(any_c.get("code")) if any_c else None, "sistem": any_c.get("system") if any_c else None,
                                "nama": (_teks(cc) or (str(any_c.get("display")) if any_c else ""))[:160], "jenis": jenis, "status": r.get("status"),
                                "enc": enc_of(r), "t": _waktu(r), "jumlah": jml})
        elif rt == "Composition":
            teks = " ".join(str(((sec or {}).get("text") or {}).get("div") or "") for sec in r.get("section") or [] if isinstance(sec, dict))
            polos = re.sub(r"<[^>]+>", " ", teks)
            m = re.search(r"boleh pulang\D{0,40}?(\d{4}-\d{2}-\d{2})", polos, re.I)
            rm_ = re.search(r"(?:masuk|rawat) (?:kembali|ulang)\D{0,60}?(\d{4}-\d{2}-\d{2})", polos, re.I)
            tdk = re.search(r"\b(?:belum|tidak) stabil\b", polos, re.I)
            if m or rm_ or tdk:
                out["resume"].append({"boleh_pulang": m.group(1) if m else None, "rencana_masuk": rm_.group(1) if rm_ else None,
                                      "belum_stabil": bool(tdk), "enc": enc_of(r), "t": _waktu(r)})
        elif rt in ("Device", "DeviceUseStatement"):
            nm = " ".join(str(d.get("name") or "") for d in r.get("deviceName") or [] if isinstance(d, dict)) + " " + _teks(r.get("type"))
            if rt == "DeviceUseStatement":
                nm += " " + str(((r.get("device") or {}).get("display")) or "")
            if nm.strip():
                row_a = {"nama": nm.strip()[:120], "enc": enc_of(r), "t": _waktu(r)}
                tp = r.get("timingPeriod") or {}
                if tp.get("start") and tp.get("end"):
                    row_a.update(mulai=str(tp["start"])[:25], selesai=str(tp["end"])[:25])
                out["alat"].append(row_a)
    if not out["kunjungan"]:
        out["masalah"].append("tidak ada Encounter: rekam medis tidak dapat dicocokkan dengan klaim")
    out["ok"] = bool(out["kunjungan"]) and any(k["mulai"] for k in out["kunjungan"])
    out["masalah"] = out["masalah"][:20]
    out["peringatan"] = sorted(set(out["peringatan"]))[:20]
    return out


# =====================================================================================================================
# the claim against the record
# =====================================================================================================================
def klaim_dari(c: Any, meta: Optional[dict] = None) -> dict:
    """The claim fields the cross-check needs, from the engine's claim (aip/layanan.KlaimIn) and the submission's codes
    (meta['klaim_kode']: the diagnosis and procedure codes the claim contract keeps only as a count and a text)."""
    meta = meta or {}
    kk = meta.get("klaim_kode") or {}
    tind = kk.get("tindakan")
    if tind is None:
        tind = [p.strip() for p in str(getattr(c, "prosedur", None) or "").split(";") if p.strip() and p.strip() != "None"]
    return {"id": getattr(c, "kunjungan_fkrtl_id", None), "tgl_datang": getattr(c, "tgl_datang", None), "tgl_pulang": getattr(c, "tgl_pulang", None),
            "tingkat": getattr(c, "tingkat_pelayanan", None), "poli": getattr(c, "poli", None), "inacbg_kode": getattr(c, "inacbg_kode", None),
            "dx_utama": kk.get("dx_utama") or getattr(c, "dx_primer_kode", None) or getattr(c, "dx_primer_icd3", None),
            "dx_sekunder": list(kk.get("dx_sekunder") or []), "jumlah_dx_sekunder": getattr(c, "jumlah_dx_sekunder", None), "tindakan": list(tind),
            "sd_tarif_rp": int(getattr(c, "sd_tarif_rp", 0) or 0), "rr_tarif_rp": int(getattr(c, "rr_tarif_rp", 0) or 0), "obat": list(meta.get("obat") or []),
            "kelas_rawat": getattr(c, "kelas_rawat", None), "status_pulang": getattr(c, "status_pulang", None),
            # device duration billed (the hospital submission's E-Klaim fields): ICU days, ventilator hours
            "hari_icu": kk.get("lama_icu_hari"), "jam_ventilator": kk.get("jam_ventilator"),
            "topup": {col: {"rp": int(getattr(c, f"{col}_tarif_rp", 0) or 0), "kode": getattr(c, f"{col}_kode", None), "deskripsi": getattr(c, f"{col}_deskripsi", None)}
                      for col in TOPUP if int(getattr(c, f"{col}_tarif_rp", 0) or 0) > 0}}


TOPUP = {"sa": "subakut", "sp": "prosedur khusus", "rr": "prostesis", "si": "investigasi khusus", "sd": "obat khusus"}


def kelas_angka(v: Any) -> Optional[int]:
    """'Kelas 1', '1', 'kelas-2', 'VIP' -> 1, 1, 2, 0 (0 = above class 1)."""
    t = str(v or "").strip().upper()
    if not t:
        return None
    if "VIP" in t:
        return 0
    m = re.search(r"([123])\s*$", t) or re.search(r"([123])", t)
    return int(m.group(1)) if m else None


def _rp(v: Any) -> str:
    return "Rp" + f"{int(v):,}".replace(",", ".")


def _angka(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".") if abs(v) < 100 else f"{v:.0f}"
    return s.replace(".", ",")


def _sig(kode: str, s: float, f: str, bukti: str, mitigasi: Optional[list] = None) -> dict:
    from aip.realtime.graf import sig

    return sig(kode, "", None, s, 0, ("faskes", f), bukti[:900], [], mitigasi or [])


class _Ukur:
    """The measured values of the matched encounter, per parameter."""

    def __init__(self, obs: list[dict], jk: Optional[str], umur: Optional[float]) -> None:
        self.jk, self.umur = jk, umur
        self.by: dict[str, list[dict]] = {}
        for o in obs:
            if o.get("p"):
                if o.get("src") == "rentang" and o.get("v") is not None:  # the flag from the catalogue: for this patient's sex and age
                    lo, hi = rentang(o["p"], jk, umur)
                    o = {**o, "abn": "H" if (hi is not None and o["v"] > hi) else "L" if (lo is not None and o["v"] < lo) else "N"}
                self.by.setdefault(o["p"], []).append(o)

    def n(self, p: str) -> int:
        return len(self.by.get(p, []))

    def nilai(self, p: str) -> list[float]:
        return [o["v"] for o in self.by.get(p, []) if o.get("v") is not None]

    def abnormal(self, p: str) -> bool:
        return any(o.get("abn") in ("H", "L", "A") for o in self.by.get(p, []))

    def normal_semua(self, p: str, batas: Optional[dict] = None) -> bool:
        xs = self.by.get(p, [])
        if not xs:
            return False
        if batas and p in batas:
            lim = batas[p]
            return all(o.get("v") is not None and o["v"] < lim for o in xs)
        return all(o.get("abn") == "N" for o in xs)

    def kriteria(self, p: str, op: str, th: Optional[float]) -> Optional[str]:
        """The first measurement meeting the criterion, in words, or None."""
        for o in self.by.get(p, []):
            if op == "abn":
                if o.get("abn") in ("H", "A"):
                    return f"{o.get('nama') or PARAM[p][0]} abnormal" + (f" ({_angka(o['v'])} {o.get('u') or ''})".rstrip() if o.get("v") is not None else "")
                continue
            v = o.get("v")
            if v is None:
                continue
            lim = th
            if lim is None:  # the patient's own normal range
                lo, hi = rentang(p, self.jk, self.umur)
                lim = lo if op == "<" else hi
            if lim is not None and ((op == "<" and v < lim) or (op == ">" and v > lim)):
                return f"{PARAM[p][0]} {_angka(v)} {PARAM[p][1]}".rstrip()
        return None

    def ringkas(self, p: str) -> Optional[str]:
        """'saturasi oksigen 96–99% (6 pengukuran, semua normal)'."""
        xs = self.by.get(p, [])
        if not xs:
            return None
        lab, unit = PARAM[p][0], PARAM[p][1]
        if p in BENTUK:
            ab = sum(1 for o in xs if o.get("abn") in ("H", "L", "A"))
            return f"{lab} {len(xs)} kali, {'semua normal' if ab == 0 and all(o.get('abn') == 'N' for o in xs) else f'{ab} abnormal'}"
        vs = self.nilai(p)
        if not vs:
            return None
        lo, hi = min(vs), max(vs)
        rng = _angka(lo) if lo == hi else f"{_angka(lo)}–{_angka(hi)}"
        sp = "" if unit in ("%", "°C") else " "
        ab = sum(1 for o in xs if o.get("abn") in ("H", "L", "A"))
        return f"{lab} {rng}{sp}{unit if p != 'troponin' else (xs[0].get('u') or '')}".rstrip() + \
            f" ({len(vs)} pengukuran, {'semua normal' if ab == 0 else f'{ab} di luar normal'})"

    def ringkas_dict(self) -> dict:
        out = {}
        for p, xs in self.by.items():
            vs = [o["v"] for o in xs if o.get("v") is not None]
            out[p] = {"label": PARAM[p][0], "satuan": PARAM[p][1] or (xs[0].get("u") or ""), "n": len(xs), "min": min(vs) if vs else None,
                      "maks": max(vs) if vs else None, "abnormal": sum(1 for o in xs if o.get("abn") in ("H", "L", "A")),
                      "normal_semua": all(o.get("abn") == "N" for o in xs)}
        return out


def _jendela(enc: dict) -> tuple[Optional[date], Optional[date]]:
    return _tgl(enc.get("mulai")), _tgl(enc.get("selesai")) or _tgl(enc.get("mulai"))


def _dalam(t: Optional[str], a: date, b: date) -> bool:
    d = _tgl(t)
    return d is None or (a - timedelta(days=1) <= d <= b + timedelta(days=1))


def _umur(lahir: Any, pada: Optional[date]) -> Optional[float]:
    # always through the ISO date: a pandas Timestamp (or datetime) is a `date` subclass, and `date - Timestamp` raised a
    # TypeError, so the claims without any record (the fictitious ones) lost their medical-record check (2026-11-15)
    d = _tgl(lahir)
    if d is None or pada is None:
        return None
    return (pada - d).days / 365.25


def kunci_kunjungan(e: dict) -> str:
    """The encounter's key for the "billed twice" state: its first identifier value, else its id."""
    return (e.get("ident") or [None])[0] or e["id"]


# clinical instability at discharge: Halm et al. (JAMA 2002) criteria (temperature > 37.8 °C, pulse > 100/min, respiratory rate
# > 24/min, systolic <= 90 mmHg, saturation < 90 %) and severe hypertension (>= 180 / >= 120 mmHg, ACC/AHA 2017)
INSTABIL = (("suhu", ">", 37.8), ("nadi", ">", 100), ("napas", ">", 24), ("sistolik", "<=", 90), ("spo2", "<", 90), ("sistolik", ">=", 180),
            ("diastolik", ">=", 120))
# acute findings that justify an (unplanned or planned) admission by themselves; chronic comorbidity labs (glucose of a
# diabetic, creatinine of a CKD patient) are not among them unless extreme
AKUT = (("spo2", "<", 92), ("napas", ">", 24), ("nadi", ">", 110), ("nadi", "<", 50), ("sistolik", "<", 90), ("sistolik", ">", 179), ("diastolik", ">", 119),
        ("suhu", ">", 38.0), ("gcs", "<", 13), ("kalium", ">", 6.0), ("kalium", "<", 3.0), ("natrium", "<", 125), ("natrium", ">", 155),
        ("glukosa", "<", 70), ("glukosa", ">", 400), ("hb", "<", 8.0), ("laktat", ">", 2.0), ("troponin", "abn", None), ("ekg", "abn", None))
KELAS_INAP = ("IMP", "ACUTE", "NONAC", "SS")
PULANG_PINDAH = ("hosp", "other-hcf", "oth-hosp", "long", "snf", "rehab", "psy", "exp")  # transferred or died: no early-discharge finding
ADMIT_ANTAR_RS = ("hosp-trans",)
VENT_PERIODE_MIN_JAM = 6.0


def _banding(v: float, op: str, th: float) -> bool:
    return {"<": v < th, ">": v > th, "<=": v <= th, ">=": v >= th}[op]


def _pulang_tidak_stabil(rme: dict, e: dict) -> list[str]:
    """The criteria of instability met by the last vital-sign set of an inpatient encounter (taken on its last day, and a set
    distinct from the admission one), plus a discharge summary that says so."""
    out: list[str] = []
    vs = [o for o in rme.get("observasi") or [] if o.get("enc") == e["id"] and o.get("p") in VITAL and o.get("v") is not None and o.get("t")]
    waktu_set = sorted({o["t"][:16] for o in vs})
    akhir = _tgl(e.get("selesai"))
    if len(waktu_set) >= 2 and akhir and _tgl(waktu_set[-1]) and _tgl(waktu_set[-1]) >= akhir - timedelta(days=1):
        last = [o for o in vs if o["t"][:16] == waktu_set[-1]]
        for p, op, th in INSTABIL:
            hit = next((o for o in last if o["p"] == p and _banding(o["v"], op, th)), None)
            if hit:
                out.append(f"{PARAM[p][0]} {_angka(hit['v'])}{'' if PARAM[p][1] in ('%', '°C') else ' '}{PARAM[p][1]}".rstrip())
    if any(x.get("belum_stabil") and x.get("enc") == e["id"] for x in rme.get("resume") or []):
        out.append("resume medis menyebut kondisi belum stabil saat pulang")
    return out


def jejak(rme: dict) -> list[dict]:
    """Each encounter of a record in brief: the context the stay-in-context rules read (planned readmission, readmission after
    an unstable discharge, the referral, the doctor across hospitals). The engine keeps these per member across claims."""
    out = []
    for e in rme.get("kunjungan") or []:
        if not e.get("mulai") or e.get("status") in BATAL:
            continue
        dx3 = sorted({d["kode"][:3] for d in rme.get("diagnosis") or [] if d.get("enc") == e["id"]})
        rencana = sorted({x["rencana_masuk"] for x in rme.get("resume") or [] if x.get("enc") == e["id"] and x.get("rencana_masuk")})
        inap = e.get("kelas") in KELAS_INAP or "IMP" in (e.get("kelas_riwayat") or [])
        out.append({"id": e["id"], "kelas": e.get("kelas"), "inap": inap, "mulai": e["mulai"], "selesai": e.get("selesai"), "org": e.get("org"),
                    "dokter": list(e.get("dokter") or []), "dx3": dx3, "pulang_ke": e.get("pulang_ke"), "readmisi": bool(e.get("readmisi")),
                    "masuk_dari": e.get("masuk_dari"), "alasan": bool(e.get("alasan")), "rencana_masuk": rencana,
                    "tidak_stabil": _pulang_tidak_stabil(rme, e) if (inap and e.get("selesai")) else []})
    return out


def periksa(k: dict, rme: dict, f: str = "", peserta: Optional[dict] = None, terpakai: Any = None, riwayat: Optional[list[dict]] = None) -> dict:
    """The claim `k` (klaim_dari) against the summary `rme` (baca). Returns the signals, one row per checked item (the
    auditor's table), the measured values in brief and the values the custom-rule language reads (nilai).
    terpakai: a set of encounter keys (or a callable key -> bool) already billed by other claims: when several encounters fit
    the claim, one not yet billed is preferred (two same-day visits are two encounters, not one billed twice).
    riwayat: the member's encounters known from other claims' records (jejak(); the engine keeps them), read with the record's
    own encounters by the stay-in-context rules. Only encounters that started before this claim's admission count."""
    rows: list[dict] = []
    sigs: list[dict] = []
    nilai: dict[str, Any] = {"rme_ada": True}

    def row(aspek: str, klaim: str, rme_: str, status: str, catatan: str = "") -> None:
        rows.append({"aspek": aspek, "klaim": klaim, "rme": rme_, "status": status, "catatan": catatan})

    if not rme.get("ok"):
        row("Rekam medis", "klaim ini", "; ".join(rme.get("masalah") or ["tidak dapat dibaca"]), "tidak_dicek")
        return {"versi": VERSI, "sinyal": [], "hasil": rows, "ringkas": {}, "nilai": {**nilai, "rme_ada": False}, "kunjungan": None}
    d0: Optional[date] = k.get("tgl_datang") if isinstance(k.get("tgl_datang"), date) else _tgl(k.get("tgl_datang"))
    d1: Optional[date] = k.get("tgl_pulang") if isinstance(k.get("tgl_pulang"), date) else _tgl(k.get("tgl_pulang"))
    d1 = d1 or d0
    ritl = k.get("tingkat") == "RITL"
    los_klaim = (d1 - d0).days if (ritl and d0 and d1) else 0
    peserta = peserta or {}
    jk = (rme.get("pasien") or {}).get("jk") or peserta.get("jk")
    umur = _umur((rme.get("pasien") or {}).get("tgl_lahir") or peserta.get("tgl_lahir"), d0)
    hidup = [e for e in rme.get("kunjungan") or [] if e.get("mulai") and e.get("status") not in BATAL]
    # ---- 1. the encounter --------------------------------------------------------------------------------------------
    cocok = []
    for e in hidup:
        a, b = _jendela(e)
        if d0 and a and a <= d1 + timedelta(days=1) and d0 <= b + timedelta(days=1):
            cocok.append(e)
    klaim_tgl = f"{'rawat inap' if ritl else 'rawat jalan'} {d0}{f' s.d. {d1}' if ritl and d1 != d0 else ''}"
    if not cocok:
        lain = ", ".join(f"{e.get('kelas') or '?'} {e['mulai']}{(' s.d. ' + e['selesai']) if e.get('selesai') and e['selesai'] != e['mulai'] else ''}"
                         for e in sorted(hidup, key=lambda x: x["mulai"])[:4]) or "tidak ada kunjungan yang sah"
        sigs.append(_sig("RME_KUNJUNGAN_TIDAK_ADA", 1.0, f,
                         f"Klaim menagih {klaim_tgl}, tetapi rekam medis elektronik tidak memuat kunjungan pada tanggal itu (kunjungan yang tercatat: {lain})."))
        row("Kunjungan", klaim_tgl, f"tidak ada; yang tercatat: {lain}", "tidak_ada")
        nilai.update(rme_kunjungan_cocok=False)
        return {"versi": VERSI, "sinyal": sigs, "hasil": rows, "ringkas": {"jumlah": rme.get("jumlah")}, "nilai": nilai, "kunjungan": None}
    imp = [e for e in cocok if e.get("kelas") in ("IMP", "ACUTE", "NONAC", "SS") or "IMP" in (e.get("kelas_riwayat") or [])]

    def dipakai(e: dict) -> bool:
        if not terpakai:
            return False
        return bool(terpakai(kunci_kunjungan(e))) if callable(terpakai) else kunci_kunjungan(e) in terpakai

    def urutan(e: dict) -> tuple:
        a_, b_ = _jendela(e)
        kelas_ok = (e in imp) if ritl else (e.get("kelas") in ("AMB", "EMER") and e not in imp)
        return (dipakai(e), not kelas_ok, abs((a_ - d0).days), abs((b_ - d1).days), e["mulai"])

    enc = min(cocok, key=urutan)
    if ritl and imp and enc not in imp:
        enc = min(imp, key=urutan)
    a, b = _jendela(enc)
    # an outpatient claim whose only recorded visit is an inpatient stay running that day: one episode billed twice (M08)
    rj_dalam_ri = ((not ritl) and enc in imp and a <= d0 <= b
                   and not any(e.get("kelas") in ("AMB", "EMER") and e not in imp for e in cocok))
    enc_ids = {e["id"] for e in cocok}
    a_all = min(_jendela(e)[0] for e in cocok)
    b_all = max(_jendela(e)[1] for e in cocok)
    nilai["rme_kunjungan_cocok"] = True
    imp = imp if ritl else []
    enc_teks = f"{enc.get('kelas') or '?'} {enc['mulai']}{(' s.d. ' + enc['selesai']) if enc.get('selesai') and enc['selesai'] != enc['mulai'] else ''}"
    if rj_dalam_ri:
        sigs.append(_sig("RME_EPISODE_DIPECAH", 1.0, f,
                         f"Klaim rawat jalan {d0}, tetapi rekam medis pada hari itu hanya mencatat {'awal ' if d0 == a else ''}rawat inap ({enc_teks}): "
                         "layanan rawat jalan yang berlanjut atau terjadi di dalam rawat inap adalah bagian dari episode rawat inap itu dan tidak "
                         "ditagih terpisah."))
        row("Episode", f"rawat jalan {d0}", f"bagian dari rawat inap {enc_teks}", "tidak_ada", "rawat jalan yang berlanjut rawat inap di hari yang sama")
    if ritl and not imp:
        emer = any(e.get("kelas") == "EMER" for e in cocok)
        mit = [{"kode": "IGD_LANJUT", "label": "kunjungan IGD dapat berlanjut ke rawat inap (cek classHistory)", "faktor": 0.4}] if emer else []
        sigs.append(_sig("RME_JENIS_RAWAT_BERBEDA", 1.0, f,
                         f"Klaim ditagih sebagai rawat inap {d0} s.d. {d1} ({los_klaim} hari), tetapi rekam medis mencatat kunjungan "
                         f"{'gawat darurat' if emer else 'rawat jalan'} ({enc_teks}) tanpa rawat inap.", mit))
        row("Jenis rawat", f"rawat inap {los_klaim} hari", f"{'IGD' if emer else 'rawat jalan'} ({enc_teks})", "tidak_ada")
    else:
        row("Kunjungan", klaim_tgl, enc_teks, "cocok")
    # ---- 2. the length of stay (the encounter's end, or the discharge summary's "may go home" when earlier) -------------
    los_rme = None
    if ritl and imp:
        boleh = min((_tgl(x["boleh_pulang"]) for x in rme.get("resume") or [] if x.get("enc") in {e["id"] for e in imp} and _tgl(x["boleh_pulang"])),
                    default=None)
        if enc.get("selesai"):
            akhir = min(b, boleh) if boleh else b
            los_rme = (akhir - a).days
            nilai["rme_los_hari"] = los_rme
            beda = los_klaim - los_rme
            luar = d1 > akhir + timedelta(days=1)
            sumber = (f"resume medis: pasien boleh pulang sejak {boleh} (Encounter selesai {b})" if boleh and boleh < b
                      else f"rekam medis mencatat rawat inap {los_rme} hari ({a} s.d. {akhir})")
            if beda >= 2 or (luar and beda >= 1):
                sigs.append(_sig("RME_LOS_TIDAK_SESUAI", min(1.0, max(beda, 1) / 3), f,
                                 f"Klaim menagih rawat inap {los_klaim} hari ({d0} s.d. {d1}); {sumber}: {beda} hari lebih panjang dari yang tercatat."))
                row("Lama rawat", f"{los_klaim} hari", f"{los_rme} hari ({sumber})", "tidak_ada", f"selisih {beda} hari")
            else:
                row("Lama rawat", f"{los_klaim} hari", f"{los_rme} hari", "cocok")
        else:
            row("Lama rawat", f"{los_klaim} hari", "waktu pulang belum tercatat (period.end kosong)", "tidak_dicek")
        # one recorded stay billed as more than one episode: it began before this claim's admission or ran past its discharge
        awal_lebih = (d0 - a).days
        akhir_lebih = (b - d1).days if enc.get("selesai") else 0
        if awal_lebih >= 1 or akhir_lebih >= 2:
            bagian = []
            if awal_lebih >= 1:
                bagian.append(f"rawat inap di rekam medis sudah berjalan sejak {a}, {awal_lebih} hari sebelum tanggal masuk klaim {d0}")
            if akhir_lebih >= 2:
                bagian.append(f"rekam medis mencatat pasien masih dirawat sampai {b}, {akhir_lebih} hari setelah tanggal pulang klaim {d1}")
            sigs.append(_sig("RME_EPISODE_DIPECAH", 1.0 if max(awal_lebih, akhir_lebih - 1) >= 2 else 0.6, f,
                             "Satu episode rawat inap tampaknya ditagih terpisah: " + "; ".join(bagian) + "."))
            row("Episode", f"rawat inap {d0} s.d. {d1}", f"satu rawat inap {a} s.d. {b}", "tidak_ada", "; ".join(bagian))
    # ---- ward class: billed against the encounter's service class (Encounter.location.extension id-core-service-class)
    kb, kr = kelas_angka(k.get("kelas_rawat")), next((e.get("kelas_layanan") for e in imp if e.get("kelas_layanan") is not None), None) if ritl else None
    if ritl and kb is not None and kr is not None:
        nm = lambda x: "VIP" if x == 0 else f"Kelas {x}"  # noqa: E731
        if kb < kr:
            sigs.append(_sig("RME_KELAS_BERBEDA", 1.0, f,
                             f"Klaim menagih rawat inap {nm(kb)}, tetapi kelas layanan di rekam medis (Encounter.location) {nm(kr)}."))
            row("Kelas rawat", nm(kb), nm(kr), "tidak_ada")
        else:
            row("Kelas rawat", nm(kb), nm(kr), "cocok")
    # ---- 3. the patient -------------------------------------------------------------------------------------------------
    pr = rme.get("pasien") or {}
    if pr and peserta:
        beda_jk = pr.get("jk") and peserta.get("jk") and pr["jk"] != peserta["jk"]
        lr, lp = _tgl(pr.get("tgl_lahir")), _tgl(peserta.get("tgl_lahir"))
        beda_th = abs((lr - lp).days) / 365.25 if (lr and lp) else None
        if beda_th is None and lr and peserta.get("umur") is not None and d0:
            beda_th = abs(_umur(lr, d0) - float(peserta["umur"]))
        if beda_jk or (beda_th is not None and beda_th > 2):
            why = []
            if beda_jk:
                why.append(f"jenis kelamin di rekam medis {pr['jk']}, di kepesertaan {peserta['jk']}")
            if beda_th is not None and beda_th > 2:
                why.append(f"tanggal lahir berbeda {beda_th:.0f} tahun")
            sigs.append(_sig("RME_PASIEN_BERBEDA", 1.0 if beda_jk else 0.7, f,
                             "Pasien di rekam medis tampaknya bukan pemegang kartu: " + "; ".join(why) + "."))
            row("Identitas pasien", "pemegang kartu", "; ".join(why), "tidak_ada")
        else:
            row("Identitas pasien", "pemegang kartu", "jenis kelamin dan tanggal lahir sesuai", "cocok")
    # the encounter's clinical data: resources linked to it, or unlinked ones dated inside its window
    def milik(x: dict) -> bool:
        return x.get("enc") in enc_ids or (x.get("enc") is None and _dalam(x.get("t"), a_all, b_all)) or \
            (x.get("enc") is not None and x.get("enc") not in {e["id"] for e in rme.get("kunjungan") or []} and _dalam(x.get("t"), a_all, b_all))

    obs = [o for o in rme.get("observasi") or [] if milik(o)]
    U = _Ukur(obs, jk, umur)
    dx_rme = {d["kode"] for d in rme.get("diagnosis") or [] if milik(d) or "problem-list" in (d.get("kategori") or "")}
    dx3_rme = {x[:3] for x in dx_rme}
    tind = [t for t in rme.get("tindakan") or [] if milik(t)]
    tind_ok = {t["kode"] for t in tind if t.get("status") not in ("not-done", "entered-in-error")}
    tind_batal = {t["kode"] for t in tind if t.get("status") == "not-done"}
    minta = {t["kode"] for t in rme.get("permintaan") or [] if milik(t)}
    obat = [o for o in rme.get("obat") or [] if milik(o)]
    alat = " ".join(x["nama"].lower() for x in rme.get("alat") or [] if milik(x))
    klinis = len(obs) + len(dx_rme) + len(tind) + len(obat)
    kerangka = [{"kode": "RME_KERANGKA", "label": "rekam medis hanya memuat kunjungan tanpa data klinis (kemungkinan belum lengkap dikirim)",
                 "faktor": 0.5}] if klinis == 0 else []
    oksigen = U.n("fio2") > 0 or bool(tind_ok & set(OKSIGEN)) or any("oksigen" in (o["nama"] or "").lower() or "oxygen" in (o["nama"] or "").lower() for o in obat)
    vital_ringkas = [s for s in (U.ringkas(p) for p in VITAL) if s]
    vital_normal = bool(vital_ringkas) and all(U.normal_semua(p) for p in VITAL if U.n(p))
    nilai.update(rme_vital_normal=vital_normal if vital_ringkas else None, rme_jumlah_observasi=len(obs),
                 rme_sistolik_min=min(U.nilai("sistolik"), default=None), rme_sistolik_maks=max(U.nilai("sistolik"), default=None),
                 rme_nadi_maks=max(U.nilai("nadi"), default=None), rme_nadi_min=min(U.nilai("nadi"), default=None),
                 rme_napas_maks=max(U.nilai("napas"), default=None), rme_suhu_maks=max(U.nilai("suhu"), default=None),
                 rme_spo2_min=min(U.nilai("spo2"), default=None), rme_hb_min=min(U.nilai("hb"), default=None),
                 rme_troponin_tinggi=(U.abnormal("troponin") if U.n("troponin") else None), rme_ekg_abnormal=(U.abnormal("ekg") if U.n("ekg") else None))
    if vital_ringkas:
        row("Tanda vital", "—", "; ".join(vital_ringkas), "info", "semua dalam batas normal" if vital_normal else "ada nilai di luar normal")
    # ---- 4. procedures ----------------------------------------------------------------------------------------------------
    # one signal per kind of finding (several codes of one PCI must not count three times), every code in its evidence
    tidak_tercatat, catatan_tt, mit_tt, s_tt_max = [], [], list(kerangka), 0.0
    grup_dicek: list[str] = []
    for raw in k.get("tindakan") or []:
        code = icd9(raw)
        if not code:
            continue
        nama = re.sub(r"^\s*\d{2}\.?\d{0,2}\s*[-–:]?\s*", "", str(raw)).strip() or icd9_tampil(code)
        label = f"{nama} ({icd9_tampil(code)})"
        g = grup_tindakan(code)
        ada = any(code == x or code.startswith(x) or x.startswith(code) or (g and grup_tindakan(x) == g) for x in tind_ok)
        lewat_alat = bool(not ada and g and any(w in alat for w in TINDAKAN_KLINIS[g].get("alat", ())))
        minor = not bermakna(code)
        if g and g not in grup_dicek:
            grup_dicek.append(g)
        if ada or lewat_alat:
            row("Tindakan", label, "tercatat di rekam medis" if ada else "tercatat lewat data alat (" + ", ".join(
                w for w in TINDAKAN_KLINIS[g]["alat"] if w in alat) + "), Procedure-nya tidak ada", "cocok" if ada else "info")
            continue
        catat = "tidak ada Procedure dengan kode ini di rekam medis"
        batal = any(code == x or code.startswith(x) for x in tind_batal)
        if batal:  # explicitly not done: strong whatever the procedure
            catat = "rekam medis mencatat tindakan ini TIDAK JADI dilakukan (status not-done)"
        elif any(code == x or code.startswith(x) or x.startswith(code) for x in minta):
            if not any(m_["kode"] == "RME_DIMINTA" for m_ in mit_tt):
                mit_tt.append({"kode": "RME_DIMINTA", "label": "tindakan diminta (ServiceRequest) tetapi belum dilaporkan selesai", "faktor": 0.5})
            catat = "hanya ada permintaan tindakan (ServiceRequest), tanpa laporan tindakan selesai"
        s_tt_max = max(s_tt_max, 1.0 if (batal or not minor) else 0.4)  # a minor examination missing weighs less
        tidak_tercatat.append(label)
        catatan_tt.append(f"{label}: {catat}")
        row("Tindakan", label, catat, "tidak_ada", "pemeriksaan/tindakan minor: bobot lebih ringan" if (minor and not batal) else "")
    if tidak_tercatat:
        sigs.append(_sig("RME_TINDAKAN_TIDAK_TERCATAT", s_tt_max, f,
                         f"Klaim menagih {len(tidak_tercatat)} tindakan yang tidak ada di rekam medis kunjungan {enc_teks}: " + "; ".join(catatan_tt[:5])
                         + f". Tindakan yang tercatat di rekam medis: {', '.join(icd9_tampil(x) for x in sorted(tind_ok)[:6]) or 'tidak ada'}.", mit_tt))
    # the indication of each known procedure group (once per group; one signal, the measurements stated once)
    tanpa_indikasi, dx_ind_all, kontra_all, s_ti, elektif = [], [], [], 0.0, False
    for g in grup_dicek:
        G = TINDAKAN_KLINIS[g]
        dx_ind = sorted(x for x in dx_rme if _mulai(x, G["dx"]))
        kr = [s_ for s_ in (U.kriteria(p, op, th) for p, op, th in G["kriteria"]) if s_]
        if G.get("pasca_bedah"):  # the course after an operation in the same stay indicates it
            ops = sorted(x for x in tind_ok if x[:2].isdigit() and 1 <= int(x[:2]) <= 86 and grup_tindakan(x) != g)
            if ops:
                kr.append(f"pasca operasi {icd9_tampil(ops[0])}")
        if dx_ind or kr:
            why = ", ".join([f"diagnosis {icd10_tampil(x)}" for x in dx_ind[:3]] + kr[:3])
            row("Indikasi", G["nama"], f"ada: {why}", "cocok")
            continue
        kontra_ada = [p for p in G["kontra"] if U.n(p)]
        dibantah = bool(kontra_ada) and all(U.normal_semua(p) for p in kontra_ada)
        fakta = "; ".join(s_ for s_ in (U.ringkas(p) for p in kontra_ada) if s_)
        dx_ind_all += [x[:3] for x in G["dx"] if len(x) >= 3 and x[:3] not in dx_ind_all]
        kontra_all += [p for p in kontra_ada if p not in kontra_all]
        s_ti = max(s_ti, 1.0 if dibantah else 0.35)  # no indication found but nothing measured against it: weak (absence of evidence)
        elektif = elektif or (dibantah and g in ("kateterisasi_jantung", "pci", "cabg", "katup_jantung"))
        tanpa_indikasi.append(G["nama"])
        row("Indikasi", G["nama"], ("tidak ada; hasil ukur normal: " + fakta) if dibantah and fakta else "tidak ada diagnosis/hasil pemeriksaan yang mendukung",
            "tanpa_indikasi", "dokumen yang diminta: " + G["dokumen"])
    if tanpa_indikasi:
        normal_all = bool(kontra_all) and all(U.normal_semua(p) for p in kontra_all)
        fakta = "; ".join(s_ for s_ in (U.ringkas(p) for p in kontra_all) if s_)
        teks = (f"Rekam medis tidak memuat dasar medis untuk {' dan '.join(tanpa_indikasi)}: tidak ada diagnosis indikasinya "
                f"({', '.join(dx_ind_all[:10])}{', dst.' if len(dx_ind_all) > 10 else ''})"
                + (f", dan hasil ukur justru normal: {fakta}" if normal_all and fakta else
                   f"; hasil ukur yang ada: {fakta}" if fakta else "; tidak ada hasil pemeriksaan yang mendukung") + ".")
        mit = list(kerangka)
        if elektif:
            mit.append({"kode": "ELEKTIF", "label": "tindakan elektif dapat berjalan dengan tanda vital normal; yang menentukan adalah diagnosis indikasinya",
                        "faktor": 0.2})
        sigs.append(_sig("RME_KLINIS_TIDAK_MENDUKUNG", s_ti, f, teks, mit))
    nilai.update(rme_tindakan_tidak_tercatat=len(tidak_tercatat), rme_tindakan_tanpa_indikasi=len(tanpa_indikasi))
    tidak_tercatat_bermakna = [x for x in tidak_tercatat if bermakna(icd9(x.rsplit("(", 1)[-1]) or "00")]
    # ---- 5. diagnoses ------------------------------------------------------------------------------------------------------
    dx_klaim = []
    du = icd10(k.get("dx_utama"))
    if du:
        dx_klaim.append((du, True))
    for x in k.get("dx_sekunder") or []:
        c = icd10(x)
        if c and c not in [y for y, _ in dx_klaim]:
            dx_klaim.append((c, False))
    hilang, dibantah_dx, teks_db, mit_db, s_db = [], [], [], [], 0.0
    s_hilang = 0.0
    sev = str(k.get("inacbg_kode") or "").rsplit("-", 1)[-1] if str(k.get("inacbg_kode") or "").count("-") >= 3 else ""
    bobot_sek = 0.7 if sev in ("II", "III") else 0.35  # severity II/III comes from the secondary diagnoses: a missing one may be the upcoding
    for code, utama in dx_klaim:
        label = f"{icd10_tampil(code)} ({'utama' if utama else 'sekunder'})"
        ada = code[:3] in dx3_rme
        key = dx_klinis(code)
        if not ada:
            hilang.append(label)
            s_hilang += 1.0 if utama else bobot_sek
            row("Diagnosis", label, "tidak ada di rekam medis", "tidak_ada")
        else:
            row("Diagnosis", label, "tercatat di rekam medis", "cocok")
        if key:
            D = DX_KLINIS[key]
            hit = [(p, s_) for p, op, th in D["kriteria"] for s_ in [U.kriteria(p, op, th)] if s_]
            kr = [s_ for _, s_ in hit] if len({p for p, _ in hit}) >= D.get("min_kriteria", 1) else []
            kontra_ada = [p for p in D["kontra"] if U.n(p)]
            n_ukur = sum(U.n(p) for p in kontra_ada)
            normal = bool(kontra_ada) and all(U.normal_semua(p, D.get("batas_kontra")) for p in kontra_ada)
            if not kr and normal and n_ukur >= 1:
                fakta = "; ".join(s_ for s_ in (U.ringkas(p) for p in kontra_ada) if s_)
                if D.get("oksigen") and oksigen and not any(m_["kode"] == "TERAPI_OKSIGEN" for m_ in mit_db):
                    mit_db.append({"kode": "TERAPI_OKSIGEN", "label": "pasien mendapat oksigen tambahan: saturasi normal bisa karena terapi", "faktor": 0.5})
                s_db = max(s_db, 1.0 if n_ukur >= D.get("min", 1) else 0.5)
                dibantah_dx.append(label)
                teks_db.append(f"{D['nama']} ({icd10_tampil(code)}) padahal {fakta}")
                row("Dasar diagnosis", f"{D['nama']} ({icd10_tampil(code)})", f"dibantah hasil ukur: {fakta}", "dibantah")
            elif kr:
                row("Dasar diagnosis", f"{D['nama']} ({icd10_tampil(code)})", "didukung: " + "; ".join(kr[:3]), "cocok")
    if dibantah_dx:
        sigs.append(_sig("RME_DIAGNOSIS_TIDAK_DIDUKUNG", s_db, f,
                         "Klaim memuat diagnosis yang tidak ditunjukkan hasil ukur di rekam medis: " + "; ".join(teks_db[:4]) + ".", mit_db))
    n_klaim_sek = int(k.get("jumlah_dx_sekunder") or 0)
    if not k.get("dx_sekunder") and n_klaim_sek > 0:
        enc_dx = {d["kode"][:3] for d in rme.get("diagnosis") or [] if d.get("enc") in enc_ids}
        n_rme_sek = len(enc_dx - ({du[:3]} if du else set()))
        kurang = n_klaim_sek - n_rme_sek
        if kurang >= 1:
            hilang.append(f"{kurang} dari {n_klaim_sek} diagnosis sekunder")
            s_hilang += min(1.0, bobot_sek * kurang)
            row("Diagnosis sekunder", f"{n_klaim_sek} diagnosis (kode tidak dikirim)", f"{n_rme_sek} diagnosis sekunder di rekam medis", "tidak_ada",
                (f"keparahan {sev} kode INA-CBG ditentukan diagnosis sekunder: " + ("tanda vital semua normal" if vital_normal else "periksa hasil penunjangnya"))
                if sev in ("II", "III") else "keparahan I: tidak mengubah tarif")
        else:
            row("Diagnosis sekunder", f"{n_klaim_sek} diagnosis (kode tidak dikirim)", f"{n_rme_sek} diagnosis sekunder di rekam medis", "cocok")
    if hilang:
        mit = list(kerangka)
        if not rme.get("diagnosis"):
            mit.append({"kode": "RME_TANPA_CONDITION", "label": "rekam medis tidak memuat Condition sama sekali (celah dokumentasi)", "faktor": 0.5})
        sigs.append(_sig("RME_DIAGNOSIS_TIDAK_TERCATAT", min(1.0, s_hilang), f,
                         f"Diagnosis yang ditagih tidak tercatat di rekam medis: {', '.join(hilang)}. Diagnosis di rekam medis: "
                         f"{', '.join(icd10_tampil(x) for x in sorted(dx_rme)[:8]) or 'tidak ada'}.", mit))
    nilai.update(rme_dx_tidak_tercatat=len(hilang), rme_dx_dibantah=len(dibantah_dx))
    # ---- 6. drugs and implants ------------------------------------------------------------------------------------------
    alkes = []
    topup_kode = {col for col, t in (k.get("topup") or {}).items() if str(t.get("kode") or "").strip().lower() not in ("", "none", "nan")}
    if k.get("sd_tarif_rp") and "sd" not in topup_kode:
        if not obat:
            alkes.append(f"obat khusus (top-up special CMG {_rp(k['sd_tarif_rp'])}) ditagih, rekam medis tidak memuat obat apa pun")
            row("Obat", f"top-up obat khusus {_rp(k['sd_tarif_rp'])}", "tidak ada MedicationRequest/Dispense/Administration", "tidak_ada")
        else:
            row("Obat", f"top-up obat khusus {_rp(k['sd_tarif_rp'])}", f"{len(obat)} catatan obat", "cocok")
    if k.get("rr_tarif_rp") and "rr" not in topup_kode:
        implan = any(w in alat for w in ("stent", "pacemaker", "pacu", "katup", "valve", "implan", "implant", "prostesis", "prosthesis", "icd"))
        if not implan and not tind_ok:
            alkes.append(f"prostesis/implan (top-up {_rp(k['rr_tarif_rp'])}) ditagih, rekam medis tidak memuat alat implan maupun tindakan")
            row("Alat/implan", f"top-up prostesis {_rp(k['rr_tarif_rp'])}", "tidak ada Device/implan atau tindakan", "tidak_ada")
        else:
            row("Alat/implan", f"top-up prostesis {_rp(k['rr_tarif_rp'])}", "ada" if implan else "ada tindakan, alat implan tidak dirinci", "cocok" if implan else "info")
    kode_rme = [x for x in rme.get("kode_lain") or [] if milik(x)]
    kode_set = {x["kode"].upper() for x in kode_rme}
    teks_rme = (" ".join(x["teks"].lower() for x in kode_rme) + " " + alat + " " + " ".join((o.get("nama") or "").lower() for o in obat))
    for col, t in (k.get("topup") or {}).items():
        kode_t = str(t.get("kode") or "").strip()
        if not kode_t or kode_t.lower() in ("none", "nan"):
            continue
        desk = str(t.get("deskripsi") or "").strip()
        kata = [w for w in re.split(r"[^a-z0-9]+", desk.lower()) if len(w) >= 5][:3]
        ada = kode_t.upper() in kode_set or (kata and all(w in teks_rme for w in kata))
        label = f"top-up {TOPUP.get(col, col)} {kode_t}{(' ' + desk) if desk and desk != kode_t else ''} ({_rp(t.get('rp') or 0)})"
        if ada:
            row("Obat/alat top-up", label, "tercatat di rekam medis", "cocok")
        else:
            alkes.append(f"{label} ditagih, tidak ada di rekam medis")
            row("Obat/alat top-up", label, "tidak ada (kode special CMG maupun nama item)", "tidak_ada")
    names = " ".join((o.get("nama") or "").lower() for o in obat)
    codes = {str(o.get("kode")) for o in obat if o.get("kode")}
    for ln in k.get("obat") or []:
        if float(ln.get("ditagih") or 0) <= 0:
            continue
        nm = str(ln.get("nama") or ln.get("kode") or "obat")
        first = re.split(r"[\s(]", nm.lower().strip())[0] if nm.strip() else ""
        if not ((ln.get("kode") and str(ln["kode"]) in codes) or (first and len(first) >= 4 and first in names)):
            alkes.append(f"{nm} ditagih {float(ln.get('ditagih')):g}, tidak ada di catatan obat rekam medis")
            row("Obat", nm, "tidak ada di rekam medis", "tidak_ada")
    if alkes:
        sigs.append(_sig("RME_OBAT_ALKES_TIDAK_TERCATAT", min(1.0, 0.6 + 0.2 * (len(alkes) - 1)) if not k.get("sd_tarif_rp") or obat else 1.0, f,
                         "Obat/alat yang ditagih tidak ada di rekam medis: " + "; ".join(alkes[:4]) + ".", list(kerangka)))
    nilai["rme_obat_alkes_tidak_tercatat"] = len(alkes)
    # ---- 6b. drug quantities: billed against what the record says was handed over (MedicationDispense.quantity) or given
    # (MedicationAdministration, one per administration)
    kurang_obat, mit_ok = [], []
    for ln in k.get("obat") or []:
        tagih = float(ln.get("ditagih") or 0)
        nm = str(ln.get("nama") or ln.get("kode") or "obat")
        first = re.split(r"[\s(]", nm.lower().strip())[0] if nm.strip() else ""
        cocok_o = [o for o in obat if (ln.get("kode") and str(ln["kode"]) == str(o.get("kode"))) or (first and len(first) >= 4 and first in (o.get("nama") or "").lower())]
        if tagih <= 0 or not cocok_o:
            continue
        serah = [o for o in cocok_o if o["jenis"] == "serah" and o.get("jumlah") is not None and o.get("status") not in ("cancelled", "entered-in-error", "declined")]
        beri = [o for o in cocok_o if o["jenis"] == "beri" and o.get("status") not in ("not-done", "entered-in-error", "stopped")]
        if serah:
            tercatat, cara = sum(o["jumlah"] for o in serah), "diserahkan (MedicationDispense)"
        elif beri:
            tercatat, cara = float(len(beri)), "kali diberikan (MedicationAdministration)"
            if not any(m_["kode"] == "SATUAN_PEMBERIAN" for m_ in mit_ok):
                mit_ok.append({"kode": "SATUAN_PEMBERIAN", "label": "dihitung dari jumlah pemberian: satuan tagihan bisa berbeda (mis. per ampul vs per dosis)",
                               "faktor": 0.3})
        else:
            continue
        if tagih - tercatat >= max(1.0, 0.1 * tagih):
            kurang_obat.append((nm, tagih, tercatat, cara))
            row("Jumlah obat", f"{nm} {_angka(tagih)}", f"{_angka(tercatat)} {cara}", "tidak_ada", f"kurang {_angka(tagih - tercatat)}")
        else:
            row("Jumlah obat", f"{nm} {_angka(tagih)}", f"{_angka(tercatat)} {cara}", "cocok")
    if kurang_obat:
        porsi = max((t - c) / t for _, t, c, _ in kurang_obat)
        sigs.append(_sig("RME_OBAT_JUMLAH_KURANG", min(1.0, 0.5 + porsi), f,
                         "Jumlah obat yang ditagih lebih banyak dari yang tercatat di rekam medis: "
                         + "; ".join(f"{nm} ditagih {_angka(t)}, tercatat {_angka(c)} {cara}" for nm, t, c, cara in kurang_obat[:4]) + ".", mit_ok))
    # ---- 6c. device duration in the record: ventilation hours and ICU days billed against the record's own times ----------
    kode_klaim = {icd9(x) for x in k.get("tindakan") or []} - {None}
    try:
        jam_vent = float(k.get("jam_ventilator")) if k.get("jam_ventilator") not in (None, "") else None
    except (TypeError, ValueError):
        jam_vent = None
    if "9672" in kode_klaim or (jam_vent is not None and jam_vent >= 96):
        from aip.realtime import iot as IOT

        sesi_v = []
        for t in tind:
            if t["kode"][:3] == "967" and t.get("status") not in ("not-done", "entered-in-error") and t.get("mulai"):
                a_, b_ = _dtm(t["mulai"]), _dtm(t.get("selesai"))
                # a period shorter than VENT_PERIODE_MIN_JAM is the time the act was charted (intubation), not how long the
                # patient was ventilated: not read as a duration (on the cardiac set every Procedure carries a one-hour period)
                if a_ and b_ and (b_ - a_).total_seconds() >= VENT_PERIODE_MIN_JAM * 3600:
                    sesi_v.append({"mulai": a_, "selesai": b_, "sesi_id": f"Procedure {icd9_tampil(t['kode'])}", "device_id": ""})
        for x in rme.get("alat") or []:
            if milik(x) and "ventilator" in (x.get("nama") or "").lower() and x.get("mulai"):
                a_, b_ = _dtm(x["mulai"]), _dtm(x.get("selesai"))
                if a_ and b_ and b_ > a_:
                    sesi_v.append({"mulai": a_, "selesai": b_, "sesi_id": "DeviceUseStatement ventilator", "device_id": ""})
        kode_v = sorted(t["kode"] for t in tind if t["kode"][:3] == "967" and t.get("status") not in ("not-done", "entered-in-error"))
        tagih_v = "ventilasi mekanik invasif ≥ 96 jam berturut-turut (96.72)" + (f"; jam ventilator di klaim {_angka(jam_vent)} jam" if jam_vent else "")
        if sesi_v:
            runs = IOT._gabung(sesi_v, 60)
            lr = max(r["jam"] for r in runs)
            tot = IOT._jam_total(sesi_v)
            nilai["rme_ventilasi_jam_terpanjang"] = round(lr, 1)
            if lr < 96 or (jam_vent and jam_vent - tot >= max(24.0, 0.25 * jam_vent)):
                r0 = max(runs, key=lambda r: r["jam"])
                sigs.append(_sig("RME_VENTILASI_TIDAK_SESUAI", 1.0 if lr < 72 else 0.7, f,
                                 f"Klaim menagih {tagih_v}, tetapi rekam medis mencatat ventilasi paling lama {_angka(lr)} jam berturut-turut "
                                 f"({r0['mulai'].strftime('%Y-%m-%d %H:%M')} s.d. {r0['selesai'].strftime('%Y-%m-%d %H:%M')}; total {_angka(tot)} jam dalam "
                                 f"{len(runs)} rangkaian)" + (f", kurang {_angka(96 - lr)} jam dari syarat 96 jam" if lr < 96 else "") + "."))
                row("Durasi ventilasi", tagih_v, f"terpanjang {_angka(lr)} jam, total {_angka(tot)} jam", "tidak_ada")
            else:
                row("Durasi ventilasi", tagih_v, f"terpanjang {_angka(lr)} jam", "cocok")
        elif kode_v and "9672" not in kode_v and "9671" in kode_v:
            sigs.append(_sig("RME_VENTILASI_TIDAK_SESUAI", 1.0, f,
                             f"Klaim menagih {tagih_v}, tetapi rekam medis sendiri mengode ventilasi sebagai 96.71 (kurang dari 96 jam berturut-turut)."))
            row("Durasi ventilasi", tagih_v, "rekam medis: 96.71 (< 96 jam)", "tidak_ada")
        else:
            row("Durasi ventilasi", tagih_v, "rekam medis tidak memuat lama ventilasi (periode Procedure/DeviceUseStatement ≥ "
                f"{VENT_PERIODE_MIN_JAM:g} jam)", "tidak_dicek")
    try:
        hari_icu = int(float(k.get("hari_icu"))) if k.get("hari_icu") not in (None, "") else 0
    except (TypeError, ValueError):
        hari_icu = 0
    if ritl and hari_icu > 0:
        from aip.realtime import iot as IOT

        lok = [l_ for e in (imp or [enc]) for l_ in e.get("lokasi") or [] if l_.get("mulai")]
        if lok:
            akhir_enc = _dtm(enc.get("waktu_selesai"))
            sesi_i = []
            for l_ in lok:
                a_, b_ = _dtm(l_["mulai"]), _dtm(l_.get("selesai")) or akhir_enc
                if l_["icu"] and a_ and b_ and b_ > a_:
                    sesi_i.append({"mulai": a_, "selesai": b_, "sesi_id": l_.get("nama") or "ICU", "device_id": ""})
            hari_tgl, hari_jam, tot = IOT._hari_nyala(sesi_i) if sesi_i else (0, 0, 0.0)
            hari = max(hari_tgl, hari_jam)
            nilai["rme_hari_icu"] = hari
            if hari_icu - hari >= 1:
                sigs.append(_sig("RME_HARI_ICU_LEBIH", min(1.0, (hari_icu - hari) / 2), f,
                                 f"Klaim menagih {hari_icu} hari ICU, tetapi lokasi pasien di rekam medis (Encounter.location) mencatat "
                                 + (f"ICU {_angka(tot)} jam pada {hari_tgl} hari kalender (dihitung {hari} hari)" if sesi_i else "tidak ada periode di ICU sama sekali")
                                 + f": {hari_icu - hari} hari ICU lebih banyak dari yang tercatat."))
                row("Hari ICU", f"{hari_icu} hari", f"{hari} hari di lokasi ICU", "tidak_ada", f"lebih {hari_icu - hari} hari")
            else:
                row("Hari ICU", f"{hari_icu} hari", f"{hari} hari di lokasi ICU", "cocok")
        else:
            row("Hari ICU", f"{hari_icu} hari", "rekam medis tidak memuat periode lokasi (Encounter.location.period)", "tidak_dicek")
    # ---- 8. the stay in its context: the patient's other encounters (this record's, and the engine's `riwayat`) -----------
    jj = {j["id"]: j for j in (riwayat or []) if isinstance(j, dict) and j.get("id")}
    jj.update({j["id"]: j for j in jejak(rme)})
    sendiri = jj.get(enc["id"]) or {}
    lain = [j for i, j in jj.items() if i != enc["id"] and _tgl(j.get("mulai")) and _tgl(j["mulai"]) <= d0]
    du3 = (icd10(k.get("dx_utama")) or "")[:3]
    akut = [s_ for s_ in (U.kriteria(p, op, th) for p, op, th in AKUT) if s_]
    op_bermakna = sorted(x for x in tind_ok if bermakna(x))
    n_vital = sum(U.n(p) for p in VITAL)
    # measured, and nothing acute: a referral or an admission is justified by an acute finding, not by a borderline value
    vital_ok = n_vital >= 4
    fakta_vital = "; ".join(s_ for s_ in (U.ringkas(p) for p in VITAL) if s_)
    meninggal = str(k.get("status_pulang") or "").lower() == "meninggal"
    rencana_ok = False
    nilai.update(rme_temuan_akut=len(akut))
    # 8a. a planned readmission (Encounter.hospitalization.reAdmission, or the earlier discharge summary planning this date)
    # with nothing to do in it: no significant procedure, normal measurements, no acute finding
    if ritl and imp:
        org = sendiri.get("org")
        rencana = [j for j in lain if j.get("selesai") and _tgl(j["selesai"]) and _tgl(j["selesai"]) <= d0 and (not org or not j.get("org") or j["org"] == org)
                   and any(_tgl(r) and abs((_tgl(r) - d0).days) <= 3 for r in j.get("rencana_masuk") or [])]
        if sendiri.get("readmisi") or rencana:
            dasar = (f"resume pulang rawat sebelumnya ({rencana[-1]['mulai']} s.d. {rencana[-1]['selesai']}) merencanakan masuk kembali "
                     f"{rencana[-1]['rencana_masuk'][-1]}" if rencana else "kunjungan ini dicatat sebagai rawat ulang (Encounter.hospitalization.reAdmission)")
            if vital_ok and not akut and not op_bermakna and not enc.get("icu") and not meninggal:
                rencana_ok = True
                sigs.append(_sig("RME_READMISI_TERENCANA", 1.0, f,
                                 f"Rawat inap {d0} s.d. {d1} adalah rawat ulang terencana ({dasar}), tetapi selama rawat ini tidak ada tindakan bermakna "
                                 f"dan tidak ada temuan akut; hasil ukur: {fakta_vital}. Rawat ulang yang dijadwalkan tanpa kebutuhan klinis "
                                 "menagih episode baru untuk kontrol yang cukup dilayani rawat jalan.",
                                 [{"kode": "PERLU_TELAAH", "label": "rawat ulang terencana sah bila ada tindakan lanjutan atau perburukan; perlu telaah, bukan bukti",
                                   "faktor": 0.0}]))
                row("Rawat ulang terencana", f"rawat inap {d0}", f"{dasar}; tanpa tindakan bermakna dan tanpa temuan akut", "tanpa_indikasi",
                    "dokumen yang diminta: resume pulang sebelumnya, alasan dan rencana tindakan rawat ulang")
            else:
                why = [f"tindakan {icd9_tampil(x)}" for x in op_bermakna[:2]] + akut[:2]
                row("Rawat ulang terencana", f"rawat inap {d0}", dasar + (f"; ada {', '.join(why)}" if why else ""), "info")
    # 8b. an admission days after an inpatient discharge whose last vital signs were unstable: one episode cut short and billed
    # as two (M09/M16)
    if ritl and imp:
        prev = [j for j in lain if j.get("inap") and j.get("selesai") and _tgl(j["selesai"]) and 0 <= (d0 - _tgl(j["selesai"])).days <= 7
                and j.get("tidak_stabil") and j.get("pulang_ke") not in PULANG_PINDAH]
        if prev:
            p0 = max(prev, key=lambda j: j["selesai"])
            jeda = (d0 - _tgl(p0["selesai"])).days
            sama_dx = bool(du3 and du3 in (p0.get("dx3") or []))
            mit = []
            if p0.get("pulang_ke") == "aadvice":
                mit.append({"kode": "PULANG_APS", "label": "rawat sebelumnya pulang atas permintaan sendiri (APS): bukan keputusan rumah sakit", "faktor": 0.7})
            if p0.get("org") and sendiri.get("org") and p0["org"] != sendiri["org"]:
                mit.append({"kode": "RS_LAIN", "label": "rawat sebelumnya di rumah sakit lain: temuan menunjuk rumah sakit pertama", "faktor": 0.5})
            sigs.append(_sig("RME_READMISI_PULANG_DINI", 1.0 if sama_dx else 0.7, f,
                             f"Pasien masuk rawat inap lagi {jeda} hari setelah dipulangkan dari rawat inap {p0['mulai']} s.d. {p0['selesai']} dalam keadaan "
                             f"belum stabil ({'; '.join(p0['tidak_stabil'][:4])})" + (f", dengan diagnosis yang sama ({icd10_tampil(du3)})" if sama_dx else "")
                             + ": satu episode yang dipotong lalu ditagih sebagai dua rawat inap.", mit))
            row("Pulang dini lalu masuk lagi", f"rawat inap {d0}", f"pulang {p0['selesai']} belum stabil: {'; '.join(p0['tidak_stabil'][:3])}", "tidak_ada",
                f"jeda {jeda} hari")
    # 8c. a transfer in from another hospital with no reason in the record and nothing a referral would be for
    if sendiri.get("masuk_dari") in ADMIT_ANTAR_RS:
        if not sendiri.get("alasan") and vital_ok and not akut and not op_bermakna and not enc.get("icu"):
            mit = [{"kode": "PERLU_TELAAH", "label": "alasan rujukan bisa tertulis di surat rujukan kertas; perlu telaah, bukan bukti", "faktor": 0.0}]
            if tind_ok:
                mit.append({"kode": "PENUNJANG_DI_RS_TUJUAN", "label": "rujukan bisa untuk pemeriksaan penunjang yang tidak ada di rumah sakit asal "
                            f"({', '.join(icd9_tampil(x) for x in sorted(tind_ok)[:3])})", "faktor": 0.3})
            sigs.append(_sig("RME_RUJUKAN_TANPA_INDIKASI", 1.0, f,
                             f"Pasien tercatat dirujuk dari rumah sakit lain (Encounter.hospitalization.admitSource), tetapi rekam medis tidak memuat alasan "
                             f"rujukan (reasonCode/basedOn kosong), tidak ada tindakan bermakna, dan tidak ada temuan akut; hasil ukur: {fakta_vital}.", mit))
            row("Rujukan masuk", "dari rumah sakit lain", "tanpa alasan rujukan; tanpa temuan akut; tanpa tindakan bermakna", "tanpa_indikasi",
                "dokumen yang diminta: surat rujukan dan alasan rujukan dari rumah sakit asal")
        else:
            row("Rujukan masuk", "dari rumah sakit lain", "ada alasan rujukan" if sendiri.get("alasan") else "ada temuan klinis/tindakan", "cocok")
    # 8d. the same doctor treating this patient at other hospitals within 30 days: the patient follows the doctor (M10)
    dok = set(sendiri.get("dokter") or [])
    if dok and sendiri.get("org"):
        dulu = [j for j in lain if set(j.get("dokter") or []) & dok and j.get("org") and j["org"] != sendiri["org"] and 0 <= (d0 - _tgl(j["mulai"])).days <= 30]
        rs = {j["org"] for j in dulu} | {sendiri["org"]}
        if len(rs) >= 2:
            sama = [j for j in dulu if du3 and du3 in (j.get("dx3") or [])]
            dekat = [j for j in sama if (d0 - _tgl(j["mulai"])).days <= 14]
            mit = [{"kode": "SIP_GANDA", "label": "dokter boleh berpraktik di sampai tiga tempat; yang perlu ditelaah adalah pasien yang berpindah rumah sakit "
                    "mengikuti dokternya", "faktor": 0.0}]
            if not sama:
                mit.append({"kode": "DX_BERBEDA", "label": "diagnosis di rumah sakit lain berbeda", "faktor": 0.5})
            sigs.append(_sig("RME_DOKTER_PASIEN_DIPUTAR", 1.0 if len(rs) >= 3 else 0.8 if dekat else 0.6, f,
                             f"Dokter yang menangani kunjungan ini juga menangani pasien yang sama di {len(rs) - 1} rumah sakit lain dalam 30 hari terakhir ("
                             + "; ".join(f"{j['mulai']}" + (f", diagnosis {', '.join(icd10_tampil(x) for x in j['dx3'][:2])}" if j.get("dx3") else "")
                                         for j in sorted(dulu, key=lambda x: x["mulai"])[:4])
                             + f"): pasien berpindah ke {len(rs)} rumah sakit mengikuti satu dokter.", mit))
            row("Dokter lintas RS", "dokter kunjungan ini", f"menangani pasien ini di {len(rs)} rumah sakit dalam 30 hari", "tidak_ada")
    nilai.update(rme_rawat_ulang_terencana=rencana_ok)
    # ---- 7. an inpatient stay whose record shows no reason to admit: every measurement normal, no significant procedure,
    # no abnormal study, not intensive care, not a death (admission criteria of the verification guidelines). A planned
    # readmission already said so (8a): not twice
    if ritl and imp and not rencana_ok and not grup_dicek and not tidak_tercatat_bermakna and not any(bermakna(x) for x in tind_ok):
        n_vital = sum(U.n(p) for p in VITAL)
        lab_p = [p for p in U.by if p not in VITAL and p not in ("fio2",)]
        semua_normal = n_vital >= 4 and all(U.normal_semua(p) for p in VITAL if U.n(p)) and all(U.normal_semua(p) for p in lab_p)
        if semua_normal and not enc.get("icu") and str(k.get("status_pulang") or "").lower() != "meninggal" and not U.n("fio2"):
            fakta = "; ".join(s_ for s_ in (U.ringkas(p) for p in [*VITAL, *lab_p]) if s_)
            sigs.append(_sig("RME_RAWAT_INAP_TANPA_INDIKASI", 1.0, f,
                             f"Rawat inap {los_klaim} hari tanpa tindakan bermakna, dan seluruh hasil ukur di rekam medis normal sejak masuk: {fakta}.",
                             [{"kode": "PERLU_TELAAH", "label": "kriteria rawat inap juga ditentukan penilaian klinis DPJP; perlu telaah, bukan bukti", "faktor": 0.0}]))
            row("Indikasi rawat inap", f"rawat inap {los_klaim} hari", "tidak tampak: semua hasil ukur normal, tanpa tindakan bermakna", "tanpa_indikasi",
                "dokumen yang diminta: catatan IGD/poli saat masuk dan kriteria rawat inap")
    return {"versi": VERSI, "sinyal": sigs, "hasil": rows, "kunjungan": {"id": enc["id"], "kelas": enc.get("kelas"), "mulai": enc["mulai"],
                                                                          "selesai": enc.get("selesai"), "icu": enc.get("icu"),
                                                                          "kunci": None if rj_dalam_ri else kunci_kunjungan(enc)},
            "ringkas": {"jumlah": rme.get("jumlah"), "ukur": U.ringkas_dict(), "diagnosis": sorted(icd10_tampil(x) for x in dx_rme)[:20],
                        "tindakan": sorted(icd9_tampil(x) for x in tind_ok)[:20], "obat": len(obat), "data_klinis": klinis},
            "nilai": nilai}


def dipakai_ulang(hasil: dict, f: str, klaim_lain: str, tgl_lain: Any = None) -> None:
    """Add the finding that the matched encounter was already billed by another claim (state kept by the caller)."""
    kj = hasil.get("kunjungan") or {}
    hasil["sinyal"].append(_sig("RME_KUNJUNGAN_DIPAKAI_ULANG", 1.0, f,
                                f"Kunjungan rekam medis {kj.get('kelas') or ''} {kj.get('mulai')}{(' s.d. ' + kj['selesai']) if kj.get('selesai') else ''} "
                                f"sudah menjadi dasar klaim lain ({klaim_lain}{', ' + str(tgl_lain) if tgl_lain else ''}): satu kunjungan ditagih dua kali."))
    hasil["hasil"].append({"aspek": "Kunjungan", "klaim": "kunjungan klaim ini", "rme": f"kunjungan yang sama sudah ditagih klaim {klaim_lain}",
                           "status": "tidak_ada", "catatan": ""})
    hasil.setdefault("nilai", {})["rme_kunjungan_dipakai_ulang"] = True


def lewati(alasan: str) -> dict:
    """The result when no record came with the claim (nothing is raised)."""
    return {"versi": VERSI, "sinyal": [], "hasil": [{"aspek": "Rekam medis", "klaim": "klaim ini", "rme": alasan, "status": "tidak_dicek", "catatan": ""}],
            "ringkas": {}, "nilai": {"rme_ada": False}, "kunjungan": None}


def dari_meta(c: Any, meta: dict, m: Optional[dict], f: str, terpakai: Any = None, riwayat: Optional[list[dict]] = None) -> Optional[dict]:
    """The engine's entry (mesin._fkrtl): the record that came with the claim (meta['rme']: a summary from baca(), or
    meta['rekam_medis']: a raw Bundle), checked against the claim. None when no record came. riwayat: the member's encounters
    from earlier claims' records (jejak), kept by the engine."""
    rme = meta.get("rme")
    if rme is None and meta.get("rekam_medis") is not None:
        rme = baca(meta["rekam_medis"], (m or {}).get("jk"))
    if rme is None:
        return None
    peserta = {"jk": (m or {}).get("jk"), "tgl_lahir": (m or {}).get("tgl_lahir")} if m else None
    h = periksa(klaim_dari(c, meta), rme, f, peserta, terpakai, riwayat)
    h["jejak"] = jejak(rme) if rme.get("ok") else []
    return h


def untuk_peristiwa(hasil: dict) -> dict:
    """What a stored event keeps of the cross-check (the table, the measurements in brief, the custom-rule values)."""
    return {"versi": hasil["versi"], "hasil": hasil["hasil"][:40], "ringkas": hasil.get("ringkas") or {}, "nilai": hasil.get("nilai") or {},
            "kunjungan": hasil.get("kunjungan")}


# =====================================================================================================================
# the contract: structural validation (for a hospital) and the JSON Schema
# =====================================================================================================================
def validasi(bundle: Any) -> dict:
    """What a hospital may be told about its Bundle: whether it is readable and what is missing. Never a cross-check result,
    a score or a decision."""
    r = baca(bundle)
    return {"diterima": r["ok"], "versi_kontrak": VERSI, "ig": IG, "jumlah_resource": r["jumlah"], "masalah": r["masalah"], "peringatan": r["peringatan"],
            "terbaca": {"kunjungan": len(r["kunjungan"]), "diagnosis": len(r["diagnosis"]), "tindakan": len(r["tindakan"]),
                        "observasi": len(r["observasi"]), "obat": len(r["obat"]), "alat": len(r["alat"])}}


def json_schema() -> dict:
    """The accepted Bundle as JSON Schema (draft 2020-12): the subset of the SATUSEHAT ID Core profiles the cross-check reads.
    Permissive on everything it does not read (additionalProperties), strict on what it does."""
    coding = {"type": "object", "properties": {"system": {"type": "string"}, "code": {"type": "string"}, "display": {"type": "string"}},
              "required": ["code"]}
    cc = {"type": "object", "properties": {"coding": {"type": "array", "items": {"$ref": "#/$defs/Coding"}}, "text": {"type": "string"}}}

    def cc_sys(system: str) -> dict:
        return {"type": "object", "properties": {"coding": {"type": "array", "contains": {"type": "object", "properties": {"system": {"const": system}},
                                                                                       "required": ["system", "code"]}}},
                "required": ["coding"]}

    ref = {"type": "object", "properties": {"reference": {"type": "string"}, "identifier": {"type": "object"}, "display": {"type": "string"}}}
    dt = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}"}
    period = {"type": "object", "properties": {"start": dt, "end": dt}}
    qty = {"type": "object", "properties": {"value": {"type": "number"}, "unit": {"type": "string"}, "system": {"type": "string"}, "code": {"type": "string"}},
           "required": ["value"]}

    def res(name: str, props: dict, required: list[str], desc: str) -> dict:
        return {"type": "object", "description": f"{desc} Profil: {PROFIL}{re.sub(r'(?<!^)(?=[A-Z])', '-', name).lower()}",
                "properties": {"resourceType": {"const": name}, "id": {"type": "string"}, **props}, "required": ["resourceType", *required]}

    defs = {
        "Coding": coding, "CodeableConcept": cc,
        "Patient": res("Patient", {"identifier": {"type": "array", "contains": {"type": "object", "properties": {"system": {"const": SYS_IHS}}}},
                                   "gender": {"enum": ["male", "female", "other", "unknown"]}, "birthDate": dt}, ["identifier"],
                       "Pasien. Dibaca: gender dan birthDate (cek identitas terhadap kepesertaan). NIK dan nama tidak disimpan."),
        "Encounter": res("Encounter", {"status": {"type": "string"},
                                       "class": {"type": "object", "properties": {"system": {"const": SYS_ACT}, "code": {"enum": ["IMP", "AMB", "EMER", "HH", "VR", "ACUTE", "NONAC", "SS"]}},
                                                 "required": ["code"]},
                                       "period": {**period, "required": ["start"]}, "subject": ref, "diagnosis": {"type": "array"},
                                       "classHistory": {"type": "array"}, "statusHistory": {"type": "array"}, "location": {"type": "array"}},
                         ["status", "class", "period"], "Kunjungan yang ditagih. period.start/end = tanggal masuk/pulang; class IMP = rawat inap."),
        "Condition": res("Condition", {"code": cc_sys(SYS_ICD10), "encounter": ref, "category": {"type": "array"}, "verificationStatus": cc},
                         ["code"], f"Diagnosis, kode ICD-10 ({SYS_ICD10}). Condition dengan verificationStatus refuted/entered-in-error diabaikan."),
        "Procedure": res("Procedure", {"code": cc_sys(SYS_ICD9), "status": {"type": "string"}, "encounter": ref, "performedDateTime": dt,
                                       "performedPeriod": period, "focalDevice": {"type": "array"}},
                         ["code", "status"], f"Tindakan, kode ICD-9-CM ({SYS_ICD9}). status not-done = tidak jadi dilakukan."),
        "Observation": res("Observation", {"code": cc_sys(SYS_LOINC), "status": {"type": "string"}, "encounter": ref, "effectiveDateTime": dt,
                                           "effectivePeriod": period, "valueQuantity": qty, "valueCodeableConcept": cc, "valueBoolean": {"type": "boolean"},
                                           "interpretation": {"type": "array"}, "referenceRange": {"type": "array"}, "component": {"type": "array"}},
                           ["code"], "Tanda vital dan laboratorium, kode LOINC (lihat x-loinc). Tekanan darah boleh panel 85354-9 dengan komponen 8480-6/8462-4."),
        "ServiceRequest": res("ServiceRequest", {"code": cc, "encounter": ref}, ["code"], "Permintaan tindakan (ICD-9-CM) atau pemeriksaan."),
        "DiagnosticReport": res("DiagnosticReport", {"code": cc, "encounter": ref, "conclusion": {"type": "string"}, "conclusionCode": {"type": "array"}},
                                ["code"], "Hasil pemeriksaan penunjang (EKG 11524-6, ekokardiografi 34552-0, angiografi) dengan kesimpulan."),
        "MedicationRequest": res("MedicationRequest", {"medicationCodeableConcept": cc, "medicationReference": ref, "encounter": ref}, [],
                                 f"Resep. Kode obat KFA ({SYS_KFA})."),
        "MedicationDispense": res("MedicationDispense", {"medicationCodeableConcept": cc, "medicationReference": ref, "context": ref}, [], "Penyerahan obat."),
        "MedicationAdministration": res("MedicationAdministration", {"medicationCodeableConcept": cc, "medicationReference": ref, "context": ref}, [],
                                        "Pemberian obat."),
        "Medication": res("Medication", {"code": cc}, [], f"Obat yang dirujuk medicationReference; code KFA ({SYS_KFA})."),
        "Device": res("Device", {"deviceName": {"type": "array"}, "type": cc}, [], "Alat/implan (stent, pacu jantung, ventilator)."),
    }
    kinds = ["Patient", "Encounter", "Condition", "Procedure", "Observation", "ServiceRequest", "DiagnosticReport", "MedicationRequest",
             "MedicationDispense", "MedicationAdministration", "Medication", "Device"]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://bluesandai.local/schema/rme-satusehat-bundle.json",
        "title": "Rekam medis elektronik per klaim (FHIR R4 Bundle, SATUSEHAT ID Core)",
        "description": (f"Kontrak {VERSI}: satu Bundle per klaim, dikirim di field `rekam_medis` pada POST /api/aip/realtime/v1/faskes/klaim. {IG}. "
                        "Resource lain boleh ada dan diabaikan. Batas " + str(MAKS_ENTRI) + " entri."),
        "type": "object",
        "properties": {"resourceType": {"const": "Bundle"}, "type": {"enum": ["collection", "document", "transaction", "searchset", "batch"]},
                       "entry": {"type": "array", "maxItems": MAKS_ENTRI, "contains": {"type": "object", "properties": {"resource": {"$ref": "#/$defs/Encounter"}}},
                                 "items": {"type": "object", "properties": {"fullUrl": {"type": "string"}, "resource": {
                                     "type": "object", "properties": {"resourceType": {"type": "string"}}, "required": ["resourceType"],
                                     "allOf": [{"if": {"properties": {"resourceType": {"const": k}}}, "then": {"$ref": f"#/$defs/{k}"}} for k in kinds]}},
                                           "required": ["resource"]}}},
        "required": ["resourceType", "entry"],
        "$defs": defs,
        "x-loinc": {p: {"label": v[0], "satuan": v[1], "normal": [v[2], v[3]], "loinc": sorted(v[4])} for p, v in PARAM.items()},
        "x-sistem-kode": {"icd10": SYS_ICD10, "icd9cm": SYS_ICD9, "loinc": SYS_LOINC, "kfa": SYS_KFA, "ihs": SYS_IHS, "nik": SYS_NIK,
                          "kelas_kunjungan": SYS_ACT},
    }


def katalog_klinis() -> dict:
    """The knowledge base in readable form (internal users: the System Architecture tab, the contract document)."""
    return {"tindakan": [{"grup": g, "nama": d["nama"], "kode_icd9cm": [icd9_tampil(x) for x in d["kode"]],
                          "diagnosis_indikasi": [icd10_tampil(x) if len(x) >= 3 else x + "*" for x in d["dx"]],
                          "pemeriksaan_indikasi": [f"{PARAM[p][0]} {'abnormal' if op == 'abn' else op + ' ' + str(th if th is not None else 'normal')}"
                                                   for p, op, th in d["kriteria"]],
                          "alat": list(d.get("alat", ())), "dokumen": d["dokumen"]} for g, d in TINDAKAN_KLINIS.items()],
            "diagnosis": [{"kode": icd10_tampil(k) if len(k) > 3 else k, "nama": d["nama"],
                           "pemeriksaan_pendukung": [f"{PARAM[p][0]} {'abnormal' if op == 'abn' else op + ' ' + str(th if th is not None else 'normal')}"
                                                     for p, op, th in d["kriteria"]],
                           "dibantah_bila_normal": [PARAM[p][0] for p in d["kontra"]], "minimal_pengukuran": d.get("min", 1)} for k, d in DX_KLINIS.items()],
            "parameter": {p: {"label": v[0], "satuan": v[1], "normal_dewasa": [v[2], v[3]], "loinc": sorted(v[4])} for p, v in PARAM.items()}}
