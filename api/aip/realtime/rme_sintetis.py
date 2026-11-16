"""Synthetic electronic medical records (SATUSEHAT FHIR R4 Bundles) for a claim: for the /testing examples, the simulator's
planted scenarios and the tests. SYNTHETIC DATA ONLY: patient numbers, KFA codes and every value are generated.

bundel(klaim, varian) builds the record the hospital would hold for the claim's episode:
  sesuai              consistent with the claim: the encounter's dates and class, every diagnosis and procedure, vital signs twice
                      a day, the laboratory the diagnoses call for (abnormal where the diagnosis says so: respiratory failure has
                      low saturations on admission, an MI a high troponin), the medicines and devices. `derau` adds the
                      documentation gaps real records have (a chronic secondary diagnosis not coded on the encounter, a day of
                      vital signs missing, a sibling procedure code, discharge recorded the next morning)
  tindakan_fiktif     the billed significant procedures are absent; the patient came for something minor; vital signs and
                      laboratory normal (the BPJS example: cardiac catheterisation billed, nothing in the record, BP and SpO2 normal)
  dx_tidak_didukung   the measurable diagnoses (respiratory failure, sepsis, MI ...) are absent and their measurements normal
  los                 the encounter ended `kurang` days before the billed discharge
  kunjungan_fiktif    no encounter in the billed period (one outpatient visit weeks earlier)
  rawat_jalan         billed inpatient, the record has an outpatient visit that day
  pasien_berbeda      the record's patient has the other sex and a birth date decades apart
  kerangka            Patient and Encounter only (no clinical data)
"""

from __future__ import annotations

import hashlib
import random
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Optional

from aip.realtime import rme as R

VARIAN = ("sesuai", "tindakan_fiktif", "dx_tidak_didukung", "los", "kunjungan_fiktif", "rawat_jalan", "pasien_berbeda", "kerangka")
ORG = "10000004"
# synthetic KFA-style codes (not real KFA entries)
OBAT_UMUM = [("92000101", "Parasetamol 1 g infus"), ("92000102", "Seftriakson 1 g injeksi"), ("92000103", "Omeprazol 40 mg injeksi"),
             ("92000104", "Natrium klorida 0,9% infus 500 mL"), ("92000105", "Ondansetron 4 mg injeksi")]
OBAT_JANTUNG = [("92000201", "Asam asetilsalisilat 80 mg tablet"), ("92000202", "Klopidogrel 75 mg tablet"), ("92000203", "Heparin 5.000 IU injeksi"),
                ("92000204", "Atorvastatin 40 mg tablet"), ("92000205", "Nitrogliserin 5 mg/mL injeksi")]
OBAT_KHUSUS = {"jantung": ("92000301", "Streptokinase 1,5 juta IU injeksi"), "lain": ("92000302", "Albumin manusia 20% 100 mL infus")}
RINGAN = [("K30", "Dispepsia fungsional"), ("M54.5", "Nyeri punggung bawah"), ("J06.9", "Infeksi saluran napas atas akut"), ("R51", "Nyeri kepala"),
          ("A09", "Diare dan gastroenteritis")]
NAMA_DX = {"I20": "Angina pektoris", "I21": "Infark miokard akut", "I25": "Penyakit jantung iskemik kronik", "I50": "Gagal jantung",
           "J96": "Gagal napas", "A41": "Sepsis", "I10": "Hipertensi esensial", "E11": "Diabetes melitus tipe 2", "J18": "Pneumonia",
           "N18": "Penyakit ginjal kronik", "D64": "Anemia", "I48": "Fibrilasi atrium", "I44": "Blok atrioventrikular"}
NAMA_LOINC = {"8480-6": "Systolic blood pressure", "8462-4": "Diastolic blood pressure", "8867-4": "Heart rate", "9279-1": "Respiratory rate",
              "8310-5": "Body temperature", "59408-5": "Oxygen saturation in Arterial blood by Pulse oximetry", "9269-2": "Glasgow coma score total",
              "89579-7": "Troponin I.cardiac [Mass/volume] in Serum or Plasma by High sensitivity method", "718-7": "Hemoglobin [Mass/volume] in Blood",
              "777-3": "Platelets [#/volume] in Blood", "6690-2": "Leukocytes [#/volume] in Blood", "2160-0": "Creatinine [Mass/volume] in Serum or Plasma",
              "2951-2": "Sodium [Moles/volume] in Serum or Plasma", "2823-3": "Potassium [Moles/volume] in Serum or Plasma",
              "2345-7": "Glucose [Mass/volume] in Serum or Plasma", "2524-7": "Lactate [Moles/volume] in Blood", "11524-6": "EKG study",
              "34552-0": "Cardiac 2D echo panel", "3151-8": "Inhaled oxygen flow rate"}
UNIT = {"8480-6": ("mmHg", "mm[Hg]"), "8462-4": ("mmHg", "mm[Hg]"), "8867-4": ("beats/minute", "/min"), "9279-1": ("breaths/minute", "/min"),
        "8310-5": ("C", "Cel"), "59408-5": ("%", "%"), "9269-2": ("{score}", "{score}"), "89579-7": ("ng/L", "ng/L"), "718-7": ("g/dL", "g/dL"),
        "777-3": ("10*3/uL", "10*3/uL"), "6690-2": ("10*3/uL", "10*3/uL"), "2160-0": ("mg/dL", "mg/dL"), "2951-2": ("mmol/L", "mmol/L"),
        "2823-3": ("mmol/L", "mmol/L"), "2345-7": ("mg/dL", "mg/dL"), "2524-7": ("mmol/L", "mmol/L"), "3151-8": ("L/min", "L/min")}
LOINC_OF = {p: sorted(v[4])[0] for p, v in R.PARAM.items()}
LOINC_OF.update({"sistolik": "8480-6", "diastolik": "8462-4", "nadi": "8867-4", "napas": "9279-1", "suhu": "8310-5", "spo2": "59408-5",
                 "troponin": "89579-7", "hb": "718-7", "trombosit": "777-3", "leukosit": "6690-2", "kreatinin": "2160-0", "natrium": "2951-2",
                 "kalium": "2823-3", "glukosa": "2345-7", "laktat": "2524-7", "gcs": "9269-2", "ekg": "11524-6", "ekokardiografi": "34552-0"})


def _d(v: Any) -> Optional[date]:
    if v is None or isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _uid(rng: random.Random) -> str:
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def _ihs(seed: str) -> str:
    return "P" + str(int(hashlib.md5(seed.encode()).hexdigest()[:10], 16))[:11].rjust(11, "0")


def _normal(rng: random.Random, p: str, umur: Optional[float] = None) -> float:
    """A normal value of a parameter (adult, or a child's range)."""
    lo, hi = R.rentang(p, None, umur)
    mid = {"sistolik": 118, "diastolik": 76, "nadi": 80, "napas": 17, "suhu": 36.8, "spo2": 98, "gcs": 15, "hb": 13.8, "trombosit": 260,
           "leukosit": 7.5, "kreatinin": 0.9, "natrium": 139, "kalium": 4.1, "glukosa": 110, "laktat": 1.1, "troponin": 4.0}.get(p, 0)
    if umur is not None and umur < 12 and p in ("nadi", "napas", "sistolik", "diastolik") and lo is not None:
        mid = (lo + hi) / 2
    sd = {"sistolik": 7, "diastolik": 5, "nadi": 7, "napas": 1.2, "suhu": 0.25, "spo2": 1.0, "gcs": 0, "hb": 0.9, "trombosit": 50, "leukosit": 1.5,
          "kreatinin": 0.15, "natrium": 2, "kalium": 0.3, "glukosa": 15, "laktat": 0.3, "troponin": 2.0}.get(p, 0)
    v = rng.gauss(mid, sd)
    if p == "troponin":
        return round(max(0.5, min(12.0, v)), 1)
    if lo is not None and hi is not None:
        v = min(max(v, lo + 0.05 * (hi - lo)), hi - 0.05 * (hi - lo))
    return round(v) if p in ("sistolik", "diastolik", "nadi", "napas", "spo2", "gcs", "trombosit", "natrium") else round(v, 1)


# what each measurable diagnosis looks like on admission (param -> value), for a consistent record
ABNORMAL_DX: dict[str, dict[str, float]] = {
    "J96": {"spo2": 86, "napas": 30}, "J80": {"spo2": 84, "napas": 32}, "R57": {"sistolik": 80, "laktat": 4.2}, "R652": {"sistolik": 78, "laktat": 4.8},
    "A41": {"suhu": 38.9, "nadi": 118, "napas": 26, "leukosit": 17.5, "laktat": 2.8}, "I21": {"troponin": 260.0, "ekg": 1}, "I22": {"troponin": 190.0, "ekg": 1},
    "I200": {"ekg": 1}, "I50": {"ekokardiografi": 1, "spo2": 91, "napas": 25}, "I48": {"ekg": 1, "nadi": 128}, "I44": {"ekg": 1, "nadi": 42},
    "R001": {"nadi": 48}, "R000": {"nadi": 116}, "I16": {"sistolik": 196, "diastolik": 122}, "D62": {"hb": 7.4}, "D64": {"hb": 8.6}, "D50": {"hb": 9.1},
    "D696": {"trombosit": 72}, "E871": {"natrium": 127}, "E876": {"kalium": 2.9}, "E875": {"kalium": 6.2}, "N17": {"kreatinin": 2.6},
    "E162": {"glukosa": 52}, "R402": {"gcs": 7}, "R50": {"suhu": 38.6},
}
# what each procedure group's indication looks like, when the claim's diagnoses do not already carry it
ABNORMAL_GRUP: dict[str, dict[str, float]] = {
    "kateterisasi_jantung": {"ekg": 1}, "pci": {"ekg": 1, "troponin": 120.0}, "cabg": {"ekg": 1}, "pacu_jantung": {"nadi": 41, "ekg": 1},
    "ablasi_ep": {"nadi": 168, "ekg": 1}, "katup_jantung": {"ekokardiografi": 1}, "ventilasi_mekanik": {"spo2": 84, "napas": 33},
    "transfusi": {"hb": 6.9}, "hemodialisis": {"kreatinin": 8.4, "kalium": 6.3}, "apendektomi": {"leukosit": 15.2},
}
TEKS_EKG = {1: "Irama sinus, ST elevasi V1-V4 (iskemia anterior)", 0: "Irama sinus normal, tidak ada kelainan ST-T"}
TEKS_EKO = {1: "Fraksi ejeksi rendah (EF 32%), hipokinetik anterior", 0: "Dalam batas normal, EF 64%"}


class _B:
    """A Bundle under construction."""

    def __init__(self, rng: random.Random, org: str) -> None:
        self.rng, self.org, self.entry = rng, org, []

    def add(self, r: dict) -> str:
        rid = r.get("id") or _uid(self.rng)
        r["id"] = rid
        r.setdefault("meta", {"profile": [R.PROFIL + {"MedicationRequest": "medication-request", "MedicationAdministration": "medication-administration",
                                                     "DiagnosticReport": "diagnostic-report"}.get(r["resourceType"], r["resourceType"].lower())]})
        self.entry.append({"fullUrl": f"urn:uuid:{rid}", "resource": r})
        return rid


def _t(d: date, jam: int) -> str:
    return datetime(d.year, d.month, d.day, jam, 0).strftime("%Y-%m-%dT%H:%M:%S+07:00")


def bundel(k: dict, varian: str = "sesuai", rng: Optional[random.Random] = None, pasien: Optional[dict] = None, derau: float = 0.0,
           kurang: Optional[int] = None, org: str = ORG) -> dict:
    """The SATUSEHAT Bundle of the claim's episode. k: klaim fields as rme.klaim_dari returns them (tgl_datang, tgl_pulang,
    tingkat, poli, dx_utama, dx_sekunder, tindakan, sd_tarif_rp, rr_tarif_rp)."""
    if varian not in VARIAN:
        raise ValueError(f"varian tidak dikenal: {varian}")
    rng = rng or random.Random()
    B = _B(rng, org)
    pasien = pasien or {}
    d0 = _d(k.get("tgl_datang")) or date(2024, 12, 20)
    ritl = k.get("tingkat") == "RITL"
    d1 = (_d(k.get("tgl_pulang")) or d0) if ritl else d0
    jk = pasien.get("jk") or rng.choice(["L", "P"])
    lahir = _d(pasien.get("tgl_lahir")) or (d0 - timedelta(days=int(365.25 * rng.randint(25, 70))))
    umur = (d0 - lahir).days / 365.25
    if varian == "pasien_berbeda":
        jk = "P" if jk == "L" else "L"
        lahir = lahir - timedelta(days=int(365.25 * (25 if umur < 50 else -25)))
    pid = B.add({"resourceType": "Patient", "identifier": [{"use": "official", "system": R.SYS_IHS, "value": _ihs(str(pasien.get("seed") or k.get("id") or rng.random()))}],
                 "active": True, "name": [{"use": "official", "text": "PASIEN SINTETIS"}], "gender": "male" if jk == "L" else "female",
                 "birthDate": str(lahir), "multipleBirthBoolean": False})
    # ---- the encounter
    kelas = "IMP" if ritl else ("EMER" if k.get("poli") == "IGD" else "AMB")
    e0, e1 = d0, d1
    if varian == "los":
        los = (d1 - d0).days
        e1 = d0 + timedelta(days=max(1, los - (kurang if kurang is not None else max(2, los // 2))))
    elif varian == "kunjungan_fiktif":
        e0 = e1 = d0 - timedelta(days=rng.randint(25, 60))
        kelas = "AMB"
    elif varian == "rawat_jalan":
        e1, kelas = d0, "AMB"
    elif varian == "sesuai" and derau and ritl and rng.random() < derau / 3:
        e1 = d1 + timedelta(days=1)  # discharge recorded the next morning
    enc = B.add({"resourceType": "Encounter", "identifier": [{"system": f"http://sys-ids.kemkes.go.id/encounter/{org}", "value": f"ENC{rng.randint(10**7, 10**8 - 1)}"}],
                 "status": "finished", "class": {"system": R.SYS_ACT, "code": kelas, "display": {"IMP": "inpatient encounter", "AMB": "ambulatory",
                                                                                                   "EMER": "emergency"}[kelas]},
                 "subject": {"reference": f"Patient/{pid}"}, "period": {"start": _t(e0, 8), "end": _t(e1, 11 if e1 > e0 else 12)},
                 "statusHistory": [{"status": "arrived", "period": {"start": _t(e0, 7), "end": _t(e0, 8)}},
                                   {"status": "in-progress", "period": {"start": _t(e0, 8), "end": _t(e1, 10)}},
                                   {"status": "finished", "period": {"start": _t(e1, 10), "end": _t(e1, 11)}}],
                 "serviceProvider": {"reference": f"Organization/{org}"},
                 "location": [{"location": {"reference": f"Location/{_uid(rng)}", "display": "Ruang rawat inap" if kelas == "IMP" else "Poliklinik"},
                               "period": {"start": _t(e0, 8)}}]})
    ref_enc = {"reference": f"Encounter/{enc}"}
    if varian == "kerangka":
        return {"resourceType": "Bundle", "type": "collection", "entry": B.entry}
    # ---- diagnoses
    dxs = [x for x in [k.get("dx_utama"), *(k.get("dx_sekunder") or [])] if R.icd10(x)]
    tind = [x for x in k.get("tindakan") or [] if R.icd9(x)]
    grup = {R.grup_tindakan(R.icd9(x)) for x in tind} - {None}
    if varian == "tindakan_fiktif":
        dx_rec = [rng.choice(RINGAN)[0]] + [x for x in dxs[1:] if not any(R._mulai(R.icd10(x), TINDAKAN_KLINIS_DX(g)) for g in grup)][:2]
    elif varian == "dx_tidak_didukung":
        dx_rec = [x for x in dxs if not R.dx_klinis(R.icd10(x))] or [rng.choice(RINGAN)[0]]
    else:
        dx_rec = list(dxs)
        if varian == "sesuai" and derau and len(dx_rec) > 1 and rng.random() < derau:
            dx_rec.pop(rng.randrange(1, len(dx_rec)))  # a chronic secondary diagnosis not coded on this encounter
    cond_ids = []
    for n, x in enumerate(dx_rec):
        c = R.icd10(x)
        cond_ids.append(B.add({"resourceType": "Condition", "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active"}]},
                               "verificationStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-ver-status", "code": "confirmed"}]},
                               "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": "encounter-diagnosis"}]}],
                               "code": {"coding": [{"system": R.SYS_ICD10, "code": R.icd10_tampil(c), "display": NAMA_DX.get(c[:3], R.icd10_tampil(c))}]},
                               "subject": {"reference": f"Patient/{pid}"}, "encounter": ref_enc, "recordedDate": _t(e0, 9)}))
    for B_e in B.entry:
        if B_e["resource"]["resourceType"] == "Encounter":
            B_e["resource"]["diagnosis"] = [{"condition": {"reference": f"Condition/{cid}"}, "use": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                                                                                                            "code": "DD"}]}, "rank": i + 1}
                                            for i, cid in enumerate(cond_ids)]
            B_e["resource"]["reasonCode"] = [{"coding": [{"system": R.SYS_ICD10, "code": R.icd10_tampil(R.icd10(dx_rec[0]))}]}] if dx_rec else []
    # ---- procedures
    if varian not in ("tindakan_fiktif", "kunjungan_fiktif", "rawat_jalan"):
        for x in tind:
            c = R.icd9(x)
            g = R.grup_tindakan(c)
            if varian == "sesuai" and derau and g and rng.random() < derau / 2:
                sib = [s for s in TINDAKAN_KLINIS_KODE(g) if s != c and len(s) == 4]
                c = rng.choice(sib) if sib else c  # coded with a sibling code of the same group
            nama = str(x).split("-", 1)[1].strip() if "-" in str(x) else R.icd9_tampil(c)
            pr = {"resourceType": "Procedure", "identifier": [{"system": f"http://sys-ids.kemkes.go.id/procedure/{org}", "value": str(rng.randint(10**6, 10**7))}],
                  "status": "completed", "code": {"coding": [{"system": R.SYS_ICD9, "code": R.icd9_tampil(c), "display": nama[:120]}]},
                  "subject": {"reference": f"Patient/{pid}"}, "encounter": ref_enc,
                  "performedPeriod": {"start": _t(e0 + timedelta(days=min(1, (e1 - e0).days)), 9), "end": _t(e0 + timedelta(days=min(1, (e1 - e0).days)), 11)},
                  "note": [{"text": f"Tindakan {nama[:80]} dilakukan sesuai prosedur."}]}
            if g == "pci":
                pr["focalDevice"] = [{"manipulated": {"display": "Drug-eluting coronary stent 3.0 x 28 mm"}}]
            B.add(pr)
    # ---- measurements: twice a day for an inpatient stay (at most 7 days), once for a visit
    hari = [e0 + timedelta(days=i) for i in range(min(7, (e1 - e0).days + 1))] if kelas == "IMP" else [e0]
    abn: dict[str, float] = {}
    if varian in ("sesuai", "los", "pasien_berbeda"):
        for x in dxs:
            key = R.dx_klinis(R.icd10(x))
            if key:
                abn.update(ABNORMAL_DX.get(key, {}))
        for g in grup:
            G_dx = TINDAKAN_KLINIS_DX(g)
            if not any(R._mulai(R.icd10(x), G_dx) for x in dxs):
                abn.update(ABNORMAL_GRUP.get(g, {}))
        if kelas == "IMP" and not abn and not grup:  # an admission has a clinical reason on arrival, by the diagnosis's chapter
            bab = (R.icd10(dxs[0]) or "R")[:1] if dxs else "R"
            abn.update({"I": {"sistolik": 164, "nadi": 106}, "J": {"suhu": 38.4, "napas": 24}, "A": {"suhu": 38.6, "nadi": 104},
                        "B": {"suhu": 38.5, "nadi": 102}, "N": {"kreatinin": 1.7, "suhu": 38.1}, "K": {"nadi": 104, "suhu": 37.9},
                        "E": {"glukosa": 286}}.get(bab, {"nadi": 104, "suhu": 38.0}))
    # a day of vital signs missing (never the admission day: admission measurements are always recorded)
    skip_hari = rng.randrange(1, len(hari)) if (varian == "sesuai" and derau and len(hari) > 2 and rng.random() < derau / 2) else None
    for i, h in enumerate(hari):
        if i == skip_hari:
            continue
        for jam in ((6, 18) if kelas == "IMP" else (9,)):
            pertama = i == 0 and jam == (6 if kelas == "IMP" else 9)
            vals = {p: (abn[p] if (pertama and p in abn) else _normal(rng, p, umur)) for p in ("sistolik", "diastolik", "nadi", "napas", "suhu", "spo2")}
            if pertama and "gcs" in abn:
                vals["gcs"] = abn["gcs"]
            t = _t(h, jam)
            B.add({"resourceType": "Observation", "status": "final",
                   "category": [{"coding": [{"system": R.SYS_OBSCAT, "code": "vital-signs", "display": "Vital Signs"}]}],
                   "code": {"coding": [{"system": R.SYS_LOINC, "code": "85354-9", "display": "Blood pressure panel with all children optional"}]},
                   "subject": {"reference": f"Patient/{pid}"}, "encounter": ref_enc, "effectiveDateTime": t,
                   "component": [{"code": {"coding": [{"system": R.SYS_LOINC, "code": c, "display": NAMA_LOINC[c]}]},
                                  "valueQuantity": {"value": vals[p], "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}}
                                 for p, c in (("sistolik", "8480-6"), ("diastolik", "8462-4"))]})
            for p in ("nadi", "napas", "suhu", "spo2", "gcs"):
                if p not in vals:
                    continue
                c = LOINC_OF[p]
                u = UNIT[c]
                B.add({"resourceType": "Observation", "status": "final",
                       "category": [{"coding": [{"system": R.SYS_OBSCAT, "code": "vital-signs", "display": "Vital Signs"}]}],
                       "code": {"coding": [{"system": R.SYS_LOINC, "code": c, "display": NAMA_LOINC[c]}]}, "subject": {"reference": f"Patient/{pid}"},
                       "encounter": ref_enc, "effectiveDateTime": t,
                       "valueQuantity": {"value": vals[p], "unit": u[0], "system": "http://unitsofmeasure.org", "code": u[1]}})
    # laboratory and studies: the abnormal ones, plus a routine panel; the cardiac ones when the claim is cardiac
    lab = {p: v for p, v in abn.items() if p not in VITAL_SET}
    rutin = ["hb", "leukosit", "trombosit", "kreatinin", "natrium", "kalium", "glukosa"]
    jantung = bool(grup & {"kateterisasi_jantung", "pci", "cabg", "pacu_jantung", "ablasi_ep", "katup_jantung"}) or \
        any(R.icd10(x)[:3] in ("I20", "I21", "I22", "I24", "I25", "I48", "I50", "R07") for x in dxs)
    if jantung:
        rutin += ["troponin", "ekg"]
    if varian == "sesuai" and any(R.dx_klinis(R.icd10(x)) == "I50" for x in dxs):
        rutin.append("ekokardiografi")
    for p in dict.fromkeys(list(lab) + rutin):
        if p in ("ekg", "ekokardiografi"):
            flag = 1 if lab.get(p) else 0
            c = LOINC_OF[p]
            B.add({"resourceType": "Observation", "status": "final",
                   "category": [{"coding": [{"system": R.SYS_OBSCAT, "code": "procedure" if p == "ekg" else "imaging"}]}],
                   "code": {"coding": [{"system": R.SYS_LOINC, "code": c, "display": NAMA_LOINC[c]}]}, "subject": {"reference": f"Patient/{pid}"},
                   "encounter": ref_enc, "effectiveDateTime": _t(e0, 9),
                   "valueCodeableConcept": {"text": (TEKS_EKG if p == "ekg" else TEKS_EKO)[flag]},
                   "interpretation": [{"coding": [{"system": R.SYS_INTERP, "code": "A" if flag else "N"}]}]})
            continue
        n_ukur = 2 if p == "troponin" else 1
        for j in range(n_ukur):
            v = lab[p] if (p in lab and j == 0) else (_normal(rng, p, umur) if p not in lab else round(lab[p] * 0.85, 1))
            c = LOINC_OF[p]
            u = UNIT.get(c, ("", ""))
            hi = 14.0 if p == "troponin" else None
            obs = {"resourceType": "Observation", "status": "final",
                   "category": [{"coding": [{"system": R.SYS_OBSCAT, "code": "laboratory", "display": "Laboratory"}]}],
                   "code": {"coding": [{"system": R.SYS_LOINC, "code": c, "display": NAMA_LOINC.get(c, c)}]}, "subject": {"reference": f"Patient/{pid}"},
                   "encounter": ref_enc, "effectiveDateTime": _t(e0, 7 + 6 * j),
                   "valueQuantity": {"value": v, "unit": u[0], "system": "http://unitsofmeasure.org", "code": u[1]}}
            if hi:
                obs["referenceRange"] = [{"high": {"value": hi, "unit": u[0]}}]
            B.add(obs)
    if varian == "sesuai" and abn.get("spo2") is not None and abn["spo2"] < 92:
        B.add({"resourceType": "Observation", "status": "final", "category": [{"coding": [{"system": R.SYS_OBSCAT, "code": "vital-signs"}]}],
               "code": {"coding": [{"system": R.SYS_LOINC, "code": "3151-8", "display": NAMA_LOINC["3151-8"]}]}, "subject": {"reference": f"Patient/{pid}"},
               "encounter": ref_enc, "effectiveDateTime": _t(e0, 7), "valueQuantity": {"value": 10, "unit": "L/min", "system": "http://unitsofmeasure.org", "code": "L/min"}})
    # medicines
    meds = rng.sample(OBAT_UMUM, 3) + (rng.sample(OBAT_JANTUNG, 3) if jantung and varian != "tindakan_fiktif" else [])
    if k.get("sd_tarif_rp") and varian not in ("tindakan_fiktif",):
        meds.append(OBAT_KHUSUS["jantung" if jantung else "lain"])
    for kode, nama in meds:
        for rt, extra in (("MedicationRequest", {"status": "completed", "intent": "order", "encounter": ref_enc, "authoredOn": _t(e0, 9)}),
                          ("MedicationAdministration", {"status": "completed", "context": ref_enc, "effectiveDateTime": _t(e0, 10)})):
            B.add({"resourceType": rt, **extra, "medicationCodeableConcept": {"coding": [{"system": R.SYS_KFA, "code": kode, "display": nama}]},
                   "subject": {"reference": f"Patient/{pid}"}})
    if varian not in ("tindakan_fiktif", "kunjungan_fiktif", "rawat_jalan"):
        if "pci" in grup or k.get("rr_tarif_rp"):
            B.add({"resourceType": "Device", "status": "active", "deviceName": [{"name": "Drug-eluting coronary stent" if ("pci" in grup or jantung) else "Implan prostesis",
                                                                                 "type": "user-friendly-name"}], "type": {"text": "implant"}})
        if "pacu_jantung" in grup:
            B.add({"resourceType": "Device", "status": "active", "deviceName": [{"name": "Permanent pacemaker dual chamber", "type": "user-friendly-name"}]})
        if "ventilasi_mekanik" in grup:
            B.add({"resourceType": "Device", "status": "active", "deviceName": [{"name": "Ventilator ICU", "type": "user-friendly-name"}]})
    return {"resourceType": "Bundle", "type": "collection", "entry": B.entry}


VITAL_SET = {"sistolik", "diastolik", "nadi", "napas", "suhu", "spo2", "gcs"}


def TINDAKAN_KLINIS_DX(g: str) -> tuple:
    return R.TINDAKAN_KLINIS[g]["dx"]


def TINDAKAN_KLINIS_KODE(g: str) -> tuple:
    return R.TINDAKAN_KLINIS[g]["kode"]
