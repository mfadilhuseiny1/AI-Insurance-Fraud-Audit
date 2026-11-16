"""Synthetic medical records (rekam medis) for the theme claims of testing/gen_tema.py, in FHIR R4 on the FHIR Indonesia
(SATUSEHAT) ID Core profiles (the user, 2026-11-14: "selain bikin data claim, bikin juga data rekam medik masing-masing
pasien ... rule engine-nya bisa terintegrasi sama rekam medik, jadi kita bisa lihat ada beberapa klaim yang gak sinkron:
ada klaim kateter jantung padahal di rekam mediknya nggak ada operasi tersebut, tekanan darah normal, semuanya normal").

What is written comes from the TRUE episode: the claim as it was before a fraud scheme changed it (gen_tema keeps the changed
fields in `_asli`). An honest claim therefore gets a record that supports it, and a claim a scheme touched gets a record that
contradicts it in that scheme's own way:

  scheme                     what the record shows (key file: ketidaksesuaian)
  klaim_fiktif, sesi_rutin   no visit at all (rm_tidak_ada)
  klaim_berulang             no visit of its own: the service is the earlier claim's visit (kunjungan_ganda)
  pemecahan_episode          one continuous stay covering both claims (episode_menyatu)
  tindakan_fiktif            the billed procedure is absent, vitals and labs normal (prosedur_tidak_ada_di_rm, tanpa_indikasi_klinis)
  operasi_batal_ditagih      the procedure recorded with status not-done (prosedur_batal)
  tidak_sesuai_indikasi      the procedure done, but nothing in the record indicates it (prosedur_tanpa_indikasi)
  upcoding_keparahan,        fewer secondary diagnoses than claimed, the claimed severity unsupported by vitals/labs
  geser_bertahap             (dx_sekunder_kurang, keparahan_tidak_didukung)
  diagnosis_utama_diganti    another primary diagnosis (dx_utama_berbeda)
  obat_alkes_fiktif          the topped-up drug/device/investigation absent (obat_alkes_tidak_ada_di_rm)
  naik_kelas                 the ward class the patient was entitled to (kelas_rawat_berbeda)
  rawat_inap_tanpa_indikasi  an inpatient stay with all-normal vitals and labs (rawat_inap_tanpa_indikasi)
  readmisi_direncanakan      the earlier discharge plans the readmission; normal vitals on readmission (readmisi_terencana)
  pulang_dini(_readmisi)     discharged with abnormal vitals (pulang_belum_stabil)
  los_diperpanjang           "boleh pulang" days before the billed discharge (boleh_pulang_lebih_awal)
  kartu_dipinjam             the treated person's sex/age differ from the card holder (identitas_tidak_cocok)
  kloning                    vitals, labs and summary copied from another patient's visit (rm_salinan)
  rujukan_semu               a referral with no clinical reason (rujukan_tanpa_indikasi)
  dokter_tiga_rs             the same doctor at three hospitals (dokter_banyak_rs)
  tagihan_gelembung,         the record is consistent: these are visible only in the bill (tidak_terlihat_di_rm)
  topup_gelembung
Honest claims carry ordinary documentation noise at small rates (tanda_vital_tidak_lengkap, obat_tidak_tercatat,
resume_tidak_ada), listed in the key file as noise, so a rule engine meets realistic false positives.

Clinical content: vitals by diagnosis group (hypertension, acute coronary syndrome, chronic ischaemic heart disease, heart
failure, arrhythmia, stroke, other vascular), care level, severity and discharge status; labs supporting each secondary
diagnosis (diabetes -> glucose/HbA1c, CKD -> creatinine, anaemia -> Hb, ...); ECG and LVEF; drugs by diagnosis (ATC coded).
Codes: ICD-10 (Condition), ICD-9-CM (Procedure, as the claim), LOINC (Observation, Composition), UCUM units, ATC (Medication;
the KFA code is left empty: no KFA catalogue was available). Identifiers are synthetic (patient IHS "P" + digits, no NIK).
Synthetic data only.

Usage: .venv/Scripts/python.exe testing/rekam_medis.py [--folder "Data Sintetis/tema_jantung_kc_sul-7371"] [--proses 4]"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
P = "https://fhir.kemkes.go.id/r4/StructureDefinition/"
LOINC, UCUM, ICD10, ICD9 = "http://loinc.org", "http://unitsofmeasure.org", "http://hl7.org/fhir/sid/icd-10", "http://hl7.org/fhir/sid/icd-9-cm"
ATC = "http://www.whocc.no/atc"
CMG = "urn:sintetis:inacbg:special-cmg"  # the special CMG top-up codes of the claim (no published FHIR code system)
OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category"
INTERP = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"
ORG_PUSAT = "100000000"  # the synthetic catalogue organisation (Medication identifiers)
WIB = "+08:00"  # KC Makassar: WITA

# ---------------------------------------------------------------------------------------------------- clinical tables
def grup_dx(dx: str, kode: str) -> str:
    """The diagnosis group a cardiology claim belongs to (ICD-10, or the INA-CBG group for a Z follow-up code)."""
    dx = (dx or "").upper()
    if dx[:1] == "I" and dx[1:3].isdigit():
        n = int(dx[1:3])
        if 10 <= n <= 15:
            return "hipertensi"
        if n in (21, 22, 24):
            return "sindrom_koroner_akut"
        if n == 20:
            return "angina"
        if n == 25:
            return "jantung_koroner_kronis"
        if n == 50 or n == 42 or n == 11:
            return "gagal_jantung"
        if 44 <= n <= 49:
            return "aritmia"
        if 60 <= n <= 69:
            return "stroke"
        if 5 <= n <= 9 or 34 <= n <= 38:
            return "katup"
        return "vaskular_lain"
    if kode.startswith("G-"):
        return "stroke"
    return "jantung_koroner_kronis" if kode.startswith("I-") else "hipertensi"


# (systolic, diastolic, heart rate, respiratory rate, temperature, SpO2) ranges per group when ill; normal otherwise
VITAL_NORMAL = ((110, 132), (68, 84), (62, 88), (14, 19), (36.3, 37.1), (96, 99))
VITAL_SAKIT = {
    "hipertensi": ((150, 195), (92, 118), (70, 100), (16, 22), (36.4, 37.2), (95, 99)),
    "sindrom_koroner_akut": ((95, 165), (55, 100), (88, 118), (18, 26), (36.4, 37.4), (91, 97)),
    "angina": ((130, 165), (80, 98), (72, 98), (16, 22), (36.4, 37.2), (95, 99)),
    "jantung_koroner_kronis": ((124, 150), (74, 92), (64, 92), (15, 20), (36.3, 37.1), (95, 99)),
    "gagal_jantung": ((100, 170), (60, 100), (92, 122), (22, 30), (36.3, 37.3), (86, 93)),
    "aritmia": ((100, 155), (60, 95), (110, 160), (18, 24), (36.4, 37.2), (93, 98)),
    "stroke": ((158, 215), (90, 122), (70, 104), (16, 24), (36.5, 37.6), (93, 98)),
    "katup": ((100, 150), (60, 92), (80, 112), (18, 26), (36.4, 37.3), (92, 97)),
    "vaskular_lain": ((120, 160), (72, 96), (66, 96), (15, 21), (36.4, 37.4), (95, 99)),
}
VITAL_KODE = [("8480-6", "Systolic blood pressure", "mm[Hg]"), ("8462-4", "Diastolic blood pressure", "mm[Hg]"),
              ("8867-4", "Heart rate", "/min"), ("9279-1", "Respiratory rate", "/min"), ("8310-5", "Body temperature", "Cel"),
              ("59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", "%")]
# labs: LOINC, name, unit, normal range, abnormal range (when the condition is present)
LAB = {
    "troponin": ("10839-9", "Troponin I.cardiac [Mass/volume] in Serum or Plasma", "ng/mL", (0.0, 0.03), (0.3, 18.0)),
    "ckmb": ("13969-1", "Creatine kinase.MB [Mass/volume] in Serum or Plasma", "ng/mL", (0.5, 4.5), (12.0, 160.0)),
    "ntprobnp": ("33762-6", "Natriuretic peptide.B prohormone N-Terminal [Mass/volume] in Serum or Plasma", "pg/mL", (20, 120), (900, 14000)),
    "kreatinin": ("2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "mg/dL", (0.6, 1.2), (2.1, 6.5)),
    "glukosa": ("2345-7", "Glucose [Mass/volume] in Serum or Plasma", "mg/dL", (75, 125), (190, 340)),
    "hba1c": ("4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", "%", (4.6, 5.9), (7.4, 11.5)),
    "hb": ("718-7", "Hemoglobin [Mass/volume] in Blood", "g/dL", (12.2, 15.8), (7.0, 9.8)),
    "kalium": ("2823-3", "Potassium [Moles/volume] in Serum or Plasma", "mmol/L", (3.6, 5.0), (2.6, 3.2)),
    "natrium": ("2951-2", "Sodium [Moles/volume] in Serum or Plasma", "mmol/L", (136, 144), (122, 131)),
    "leukosit": ("6690-2", "Leukocytes [#/volume] in Blood by Automated count", "10*3/uL", (4.5, 10.5), (13.0, 22.0)),
    "ldl": ("13457-7", "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation", "mg/dL", (70, 125), (165, 240)),
    "inr": ("6301-6", "INR in Platelet poor plasma by Coagulation assay", "{INR}", (0.9, 1.2), (2.0, 3.0)),
}
# secondary diagnoses with the lab that supports each (the true count comes from the episode)
KOMORBID = [("E11.9", "Type 2 diabetes mellitus without complications", ["glukosa", "hba1c"]), ("N18.4", "Chronic kidney disease, stage 4", ["kreatinin"]),
            ("D64.9", "Anaemia, unspecified", ["hb"]), ("E78.5", "Hyperlipidaemia, unspecified", ["ldl"]), ("E87.6", "Hypokalaemia", ["kalium"]),
            ("E87.1", "Hypo-osmolality and hyponatraemia", ["natrium"]), ("J18.9", "Pneumonia, unspecified", ["leukosit"]),
            ("N39.0", "Urinary tract infection, site not specified", ["leukosit"]), ("I48.9", "Atrial fibrillation and atrial flutter, unspecified", ["inr"]),
            ("E66.9", "Obesity, unspecified", [])]
GRUP_LAB = {"sindrom_koroner_akut": ["troponin", "ckmb"], "gagal_jantung": ["ntprobnp"], "aritmia": [], "stroke": ["glukosa"], "hipertensi": ["kreatinin"],
            "angina": ["troponin"], "jantung_koroner_kronis": ["ldl"], "katup": ["ntprobnp"], "vaskular_lain": []}
EKG = {"sindrom_koroner_akut": "ST elevasi V1-V4 (infark anterior)", "angina": "Depresi segmen ST di V4-V6", "gagal_jantung": "Sinus takikardia, LVH",
       "aritmia": "Fibrilasi atrium, respon ventrikel cepat", "hipertensi": "Irama sinus, LVH (kriteria Sokolow)", "jantung_koroner_kronis": "Irama sinus, Q patologis inferior",
       "katup": "Irama sinus, pembesaran atrium kiri", "stroke": "Irama sinus", "vaskular_lain": "Irama sinus"}
EKG_NORMAL = "Irama sinus normal, tidak ada perubahan iskemik"
# drugs per group: (ATC, name, form, daily dose text, quantity per outpatient month)
OBAT = {
    "C08CA01": ("Amlodipine 10 mg tablet", "TAB", "1 x 10 mg"), "C09CA06": ("Candesartan 16 mg tablet", "TAB", "1 x 16 mg"),
    "C07AB07": ("Bisoprolol 5 mg tablet", "TAB", "1 x 5 mg"), "C03AA03": ("Hydrochlorothiazide 25 mg tablet", "TAB", "1 x 25 mg"),
    "B01AC06": ("Acetylsalicylic acid 80 mg tablet", "TAB", "1 x 80 mg"), "B01AC04": ("Clopidogrel 75 mg tablet", "TAB", "1 x 75 mg"),
    "C10AA05": ("Atorvastatin 20 mg tablet", "TAB", "1 x 20 mg"), "C01DA08": ("Isosorbide dinitrate 5 mg tablet", "TAB", "3 x 5 mg"),
    "B01AB05": ("Enoxaparin 60 mg/0,6 mL injeksi", "INJ", "2 x 60 mg SC"), "N02AA01": ("Morphine 10 mg/mL injeksi", "INJ", "2-4 mg IV k/p"),
    "C03CA01": ("Furosemide 40 mg tablet", "TAB", "1 x 40 mg"), "C03DA01": ("Spironolactone 25 mg tablet", "TAB", "1 x 25 mg"),
    "C09AA05": ("Ramipril 5 mg tablet", "TAB", "1 x 5 mg"), "C01AA05": ("Digoxin 0,25 mg tablet", "TAB", "1 x 0,25 mg"),
    "B01AF01": ("Rivaroxaban 20 mg tablet", "TAB", "1 x 20 mg"), "B01AA03": ("Warfarin 2 mg tablet", "TAB", "1 x 2 mg"),
    "N06BX06": ("Citicoline 500 mg injeksi", "INJ", "2 x 500 mg IV"), "B05BC01": ("Mannitol 20% infus", "INF", "4 x 125 mL"),
    "A10BA02": ("Metformin 500 mg tablet", "TAB", "2 x 500 mg"), "C03CA01_IV": ("Furosemide 10 mg/mL injeksi", "INJ", "2 x 40 mg IV"),
    "B01AD01": ("Streptokinase 1.500.000 IU injeksi", "INJ", "1,5 juta IU IV dalam 60 menit"),
}
GRUP_OBAT = {
    "hipertensi": ["C08CA01", "C09CA06", "C03AA03"], "sindrom_koroner_akut": ["B01AC06", "B01AC04", "C10AA05", "B01AB05", "C07AB07"],
    "angina": ["B01AC06", "C10AA05", "C01DA08", "C07AB07"], "jantung_koroner_kronis": ["B01AC06", "C10AA05", "C07AB07"],
    "gagal_jantung": ["C03CA01", "C03DA01", "C09AA05", "C07AB07"], "aritmia": ["C07AB07", "B01AF01", "C01AA05"],
    "stroke": ["N06BX06", "B01AC06", "C10AA05"], "katup": ["C03CA01", "B01AA03"], "vaskular_lain": ["B01AC06", "C10AA05"],
}
KOMORBID_OBAT = {"E11.9": "A10BA02"}
KELAS = {"Kelas 1": "1", "Kelas 2": "2", "Kelas 3": "3", "VIP": "vip", "VVIP": "vvip"}
PULANG = {"Sehat": ("home", "Home"), "Rujuk": ("oth-hosp", "Other healthcare facility"), "Meninggal": ("exp", "Expired"),
          "APS": ("aadvice", "Left against advice"), "Lain-lain": ("other", "Other")}


def _rng(*a) -> np.random.Generator:
    return np.random.default_rng(int(hashlib.md5("|".join(map(str, a)).encode()).hexdigest()[:12], 16))


def _u(rng, ab, nd=0):
    v = float(rng.uniform(ab[0], ab[1]))
    return round(v, nd) if nd else int(round(v))


def icd9(kode: str) -> str:
    k = str(kode).strip()
    return f"{k[:2]}.{k[2:]}" if len(k) > 2 and "." not in k else k


def prosedur(s) -> list[tuple[str, str]]:
    if not s or (isinstance(s, float) and s != s):
        return []
    out = []
    for x in str(s).split(";"):
        kode, _, nama = x.partition(" - ")
        if kode.strip():
            out.append((icd9(kode), nama.strip()))
    return out


def dt(d, jam: int = 9, menit: int = 0) -> str:
    d = d if isinstance(d, date) else pd.Timestamp(d).date()
    return f"{d.isoformat()}T{jam:02d}:{menit:02d}:00{WIB}"


def ref(t: str, i: str) -> dict:
    return {"reference": f"{t}/{i}"}


def kc(system: str, code: str, display: str | None = None) -> dict:
    c = {"system": system, "code": code}
    if display:
        c["display"] = display
    return {"coding": [c]}


def ihs(prefix: str, *a, n: int = 11) -> str:
    return prefix + str(int(hashlib.md5("|".join(map(str, a)).encode()).hexdigest()[:14], 16))[:n].rjust(n, "0")


# ---------------------------------------------------------------------------------------------------- one replica
class Penulis:
    """Collects one replica's resources per type (ids prefixed with the replica: replicas are independent years)."""

    def __init__(self, r: int) -> None:
        self.r = r
        self.res: dict[str, list[dict]] = defaultdict(list)
        self.seen: set[str] = set()

    def tambah(self, x: dict) -> dict:
        k = f"{x['resourceType']}/{x['id']}"
        if k not in self.seen:
            self.seen.add(k)
            self.res[x["resourceType"]].append(x)
        return x


def organisasi(W: Penulis, f: str, label: str, kab: str) -> str:
    oid = f"org-{f[:12]}"
    W.tambah({"resourceType": "Organization", "id": oid, "meta": {"profile": [P + "id-core-organization"]},
              "identifier": [{"use": "official", "system": f"http://sys-ids.kemkes.go.id/organization/{ORG_PUSAT}", "value": ihs("1", f, n=9)}],
              "active": True, "type": [kc("http://terminology.hl7.org/CodeSystem/organization-type", "prov", "Healthcare Provider")],
              "name": f"{label} (sintetis {f[:6]})", "address": [{"use": "work", "city": kab, "country": "ID"}]})
    return oid


def dokter(W: Penulis, f: str, grup: str, rng, bersama: str | None = None) -> str:
    sp = {"stroke": "Sp.N"}.get(grup, "Sp.JP" if grup != "hipertensi" or rng.random() < 0.5 else "Sp.PD")
    if bersama:
        pid = f"prac-{bersama[:12]}"
        nama = f"dr. Sintetis {int(bersama[:4], 16) % 97:02d}, {sp}"
    else:
        k = int(rng.integers(0, 4))
        pid = f"prac-{f[:10]}-{sp.replace('.', '').lower()}{k}"
        nama = f"dr. Sintetis {int(f[:4], 16) % 89 + k:02d}, {sp}"
    W.tambah({"resourceType": "Practitioner", "id": pid, "meta": {"profile": [P + "id-core-practitioner"]},
              "identifier": [{"use": "official", "system": "https://fhir.kemkes.go.id/id/nakes-his-number", "value": ihs("N", pid, n=10)}],
              "name": [{"use": "official", "text": nama}], "qualification": [{"code": {"text": sp}}]})
    return pid


def pasien(W: Penulis, r: int, k: dict, pinjam: bool, rng) -> str:
    pid = int(k["peserta_id"])
    jk = k.get("_jk") or ""
    usia = k.get("_usia")
    if pinjam:  # the person treated is not the card holder: the record holds who was there
        jk = {"L": "P", "P": "L"}.get(jk, "P") if rng.random() < 0.6 else jk
        usia = max(18.0, (usia or 50) + float(rng.choice([-1, 1])) * float(rng.uniform(18, 35)))
    gid = f"r{r:02d}-{pid}" + ("-x" if pinjam else "")
    lahir = date(2024, 12, 18) - timedelta(days=int(round((usia if usia is not None else 55) * 365.25)) + int(rng.integers(0, 200)))
    W.tambah({"resourceType": "Patient", "id": gid, "meta": {"profile": [P + "id-core-patient"]},
              "identifier": [{"use": "official", "system": "https://fhir.kemkes.go.id/id/patient-ihs-number", "value": ihs("P", r, pid, pinjam)},
                             {"use": "usual", "system": "urn:sintetis:jkn:no-peserta", "value": str(pid)}],
              "active": True, "name": [{"use": "official", "text": f"Pasien Sintetis P-{str(pid)[-4:]}" + (" (pemakai kartu)" if pinjam else "")}],
              "gender": {"L": "male", "P": "female"}.get(jk, "unknown"), "birthDate": lahir.isoformat(), "multipleBirthBoolean": False,
              "address": [{"use": "home", "country": "ID", "city": k.get("kabkota_fkrtl"), "extension": [{"url": P + "id-core-administrative-code",
                          "extension": [{"url": "province", "valueCode": str(k["kabkota_fkrtl_kode"])[:2]}, {"url": "city", "valueCode": str(k["kabkota_fkrtl_kode"])}]}]}],
              "communication": [{"language": kc("urn:ietf:bcp:47", "id-ID", "Indonesian"), "preferred": True}]})
    return gid


def obs(W, oid, kat, kode, nama, subj, enc, waktu, prac, **nilai) -> dict:
    x = {"resourceType": "Observation", "id": oid, "meta": {"profile": [P + "id-core-observation"]}, "status": "final",
         "category": [kc(OBS_CAT, kat, {"vital-signs": "Vital Signs", "laboratory": "Laboratory", "procedure": "Procedure", "exam": "Exam"}[kat])],
         "code": kc(LOINC, kode, nama), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "effectiveDateTime": waktu,
         "issued": waktu, "performer": [ref("Practitioner", prac)]}
    x.update(nilai)
    return W.tambah(x)


def tanda_vital(W, enc, subj, prac, waktu, nilai: list, tag: str) -> list:
    """Vital signs: blood pressure as a panel, the rest one Observation each."""
    sbp, dbp, hr, rr, t, spo2 = nilai
    out = [obs(W, f"{enc}-{tag}-td", "vital-signs", "85354-9", "Blood pressure panel with all children optional", subj, enc, waktu, prac,
               component=[{"code": kc(LOINC, "8480-6", "Systolic blood pressure"), "valueQuantity": {"value": sbp, "unit": "mm[Hg]", "system": UCUM, "code": "mm[Hg]"}},
                          {"code": kc(LOINC, "8462-4", "Diastolic blood pressure"), "valueQuantity": {"value": dbp, "unit": "mm[Hg]", "system": UCUM, "code": "mm[Hg]"}}])]
    for (kode, nama, unit), v, s in zip(VITAL_KODE[2:], (hr, rr, t, spo2), ("nadi", "napas", "suhu", "spo2")):
        out.append(obs(W, f"{enc}-{tag}-{s}", "vital-signs", kode, nama, subj, enc, waktu, prac, valueQuantity={"value": v, "unit": unit, "system": UCUM, "code": unit}))
    return out


def lab(W, enc, subj, prac, waktu, nama_lab: str, abnormal: bool, rng) -> dict:
    kode, nama, unit, normal, sakit = LAB[nama_lab]
    nd = 2 if nama_lab in ("troponin", "inr", "kalium") else 1 if unit in ("g/dL", "%", "mg/dL") and nama_lab != "glukosa" else 0
    v = _u(rng, sakit if abnormal else normal, nd) if nd else _u(rng, sakit if abnormal else normal)
    tinggi = v > normal[1]
    rendah = v < normal[0]
    return obs(W, f"{enc}-lab-{nama_lab}", "laboratory", kode, nama, subj, enc, waktu, prac,
               valueQuantity={"value": v, "unit": unit, "system": UCUM, "code": unit},
               interpretation=[kc(INTERP, "H" if tinggi else "L" if rendah else "N", "High" if tinggi else "Low" if rendah else "Normal")],
               referenceRange=[{"low": {"value": normal[0], "unit": unit, "system": UCUM, "code": unit}, "high": {"value": normal[1], "unit": unit, "system": UCUM, "code": unit}}])


def obat(W, enc, subj, prac, waktu, atc: str, idx: int, rawat_inap: bool, ada_serah: bool, alasan: str | None) -> None:
    nama, bentuk, dosis = OBAT[atc]
    mid = f"med-{atc.lower()}"
    W.tambah({"resourceType": "Medication", "id": mid, "meta": {"profile": [P + "id-core-medication"]},
              "identifier": [{"use": "official", "system": f"http://sys-ids.kemkes.go.id/medication/{ORG_PUSAT}", "value": atc}],
              "code": {"coding": [{"system": ATC, "code": atc.split("_")[0], "display": nama}], "text": nama}, "status": "active",
              "form": {"text": bentuk},
              "extension": [{"url": P + "id-core-medication-type", "valueCodeableConcept": kc("http://terminology.kemkes.go.id/CodeSystem/medication-type", "NC", "Non-compound")}]})
    jumlah = {"TAB": 30, "INJ": 6, "INF": 8}.get(bentuk, 10) if not rawat_inap else {"TAB": 10, "INJ": 8, "INF": 8}.get(bentuk, 6)
    rid = f"{enc}-resep-{idx}"
    W.tambah({"resourceType": "MedicationRequest", "id": rid, "meta": {"profile": [P + "id-core-medication-request"]}, "status": "completed", "intent": "order",
              "category": [kc("http://terminology.hl7.org/CodeSystem/medicationrequest-category", "inpatient" if rawat_inap else "outpatient")],
              "medicationReference": ref("Medication", mid), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "authoredOn": waktu,
              "requester": ref("Practitioner", prac), **({"reasonCode": [kc(ICD10, alasan)]} if alasan else {}),
              "dosageInstruction": [{"text": dosis}], "dispenseRequest": {"quantity": {"value": jumlah, "unit": bentuk}}})
    if ada_serah:
        W.tambah({"resourceType": "MedicationDispense", "id": f"{enc}-serah-{idx}", "meta": {"profile": [P + "id-core-medication-dispense"]}, "status": "completed",
                  "medicationReference": ref("Medication", mid), "subject": ref("Patient", subj), "context": ref("Encounter", enc),
                  "authorizingPrescription": [ref("MedicationRequest", rid)], "quantity": {"value": jumlah, "unit": bentuk}, "whenHandedOver": waktu})


def satu_klaim(W: Penulis, k: dict, ctx: dict, rng) -> dict:
    """The record of one theme claim; returns its key-file row (planted mismatches and noise)."""
    sk, var = k["_sk"], k["_varian"] or ""
    asli = json.loads(k["_asli"] or "{}")
    cid = k["kunjungan_fkrtl_id"]
    flag, noise = [], []
    if sk in ("klaim_fiktif", "sesi_rutin_fiktif"):
        return {"rm_ada": False, "ketidaksesuaian": ["rm_tidak_ada"], "noise": []}
    if sk == "klaim_berulang":
        return {"rm_ada": False, "ketidaksesuaian": ["kunjungan_ganda"], "noise": []}
    lanjut = ctx["gabung"].get(cid)  # pemecahan_episode: this claim's stay is the earlier claim's (one encounter)
    if lanjut:
        return {"rm_ada": False, "ketidaksesuaian": ["episode_menyatu"], "noise": [], "encounter": lanjut}
    # the true episode: the claim with the fields a scheme changed put back
    kode = asli.get("kode", k["inacbg_kode"])
    dx_icd3 = asli.get("dx", k["dx_primer_icd3"])
    dxk = asli.get("dxk", k["dx_primer_kode"]) or dx_icd3
    dxs = int(asli.get("dxs", k["jumlah_dx_sekunder"]) or 0)
    tk = asli.get("tk", k["tingkat_pelayanan"])
    kelas = asli.get("kelas", k["kelas_rawat"])
    d0 = pd.Timestamp(asli.get("d", k["tgl_datang"])).date()
    d1 = pd.Timestamp(asli["p"]).date() if "p" in asli and asli["p"] else pd.Timestamp(k["tgl_pulang"] or k["tgl_datang"]).date()
    pros_benar = prosedur(asli["prosedur"]) if "prosedur" in asli else prosedur(k["prosedur"])
    pros_klaim = prosedur(k["prosedur"])
    status = asli.get("status", k["status_pulang"]) or "Sehat"
    if "los" in asli and sk == "los_diperpanjang":
        d1 = pd.Timestamp(k["tgl_pulang"]).date()  # the stay was billed long; the record says when the patient could go home
    grup = grup_dx(dx_icd3, kode)
    ri = tk == "RITL"
    sev = kode.rsplit("-", 1)[-1]
    f = k["faskes_profil"]
    org = organisasi(W, f, ctx["label_rs"].get(f, f"RS {f[:6]}"), k.get("kabkota_fkrtl") or "")
    prac = dokter(W, f, grup, rng, bersama=ctx["dokter_bersama"].get(cid))
    subj = pasien(W, ctx["r"], k, sk == "kartu_dipinjam", rng)
    if sk == "kartu_dipinjam":
        flag.append("identitas_tidak_cocok")
    enc = f"enc-{cid}"
    akhir = ctx["perpanjang"].get(cid, d1)  # pemecahan_episode: the first claim's encounter runs to the end of the second
    if akhir != d1:
        flag.append("episode_menyatu")
    jam = int(rng.integers(7, 20))
    tanpa_indikasi = sk in ("tindakan_fiktif", "rawat_inap_tanpa_indikasi", "tidak_sesuai_indikasi", "readmisi_direncanakan", "rujukan_semu")
    keparahan_palsu = sk in ("upcoding_keparahan", "geser_bertahap")
    # ---- conditions: the true primary and the true secondary diagnoses
    dx_utama = dxk if "." in str(dxk) else (f"{dxk[:3]}.9" if len(str(dxk)) == 3 else str(dxk))
    nama_utama = ctx["dx_nama"].get(dxk) or ctx["dx_nama"].get(dx_icd3) or k.get("dx_primer_nama") or dx_icd3
    if sk == "diagnosis_utama_diganti" and "dx" in asli:
        flag.append("dx_utama_berbeda")
    cond = [{"id": f"{enc}-dx0", "code": dx_utama, "nama": nama_utama}]
    pilih = list(rng.permutation(len(KOMORBID)))[:min(dxs, len(KOMORBID))]
    komorbid = [KOMORBID[i] for i in pilih]
    for j, (c, n, _l) in enumerate(komorbid):
        cond.append({"id": f"{enc}-dx{j + 1}", "code": c, "nama": n})
    if keparahan_palsu or (sk != "normal" and int(k["jumlah_dx_sekunder"] or 0) > dxs):
        if int(k["jumlah_dx_sekunder"] or 0) > dxs:
            flag.append("dx_sekunder_kurang")
        flag.append("keparahan_tidak_didukung")
    for c in cond:
        W.tambah({"resourceType": "Condition", "id": c["id"], "meta": {"profile": [P + "id-core-condition"]},
                  "clinicalStatus": kc("http://terminology.hl7.org/CodeSystem/condition-clinical", "active", "Active"),
                  "category": [kc("http://terminology.hl7.org/CodeSystem/condition-category", "encounter-diagnosis", "Encounter Diagnosis")],
                  "code": kc(ICD10, c["code"], c["nama"]), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "recordedDate": dt(d0, jam)})
    # ---- encounter
    kelas_rm = kelas
    if sk == "naik_kelas" and "kelas" in asli:
        flag.append("kelas_rawat_berbeda")
    disp = PULANG.get(status, PULANG["Sehat"])
    e = {"resourceType": "Encounter", "id": enc, "meta": {"profile": [P + "id-core-encounter"]},
         "identifier": [{"system": f"http://sys-ids.kemkes.go.id/encounter/{ihs('1', f, n=9)}", "value": cid}], "status": "finished",
         "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "IMP" if ri else ("EMER" if k.get("poli") == "IGD" else "AMB"),
                   "display": "inpatient encounter" if ri else ("emergency" if k.get("poli") == "IGD" else "ambulatory")},
         "statusHistory": [{"status": "arrived", "period": {"start": dt(d0, jam), "end": dt(d0, jam, 20)}},
                           {"status": "in-progress", "period": {"start": dt(d0, jam, 20), "end": dt(akhir, 11 if ri else jam + 1)}},
                           {"status": "finished", "period": {"start": dt(akhir, 11 if ri else jam + 1), "end": dt(akhir, 11 if ri else jam + 1)}}],
         "subject": {**ref("Patient", subj), "display": f"P-{str(k['peserta_id'])[-4:]}"},
         "participant": [{"type": [kc("http://terminology.hl7.org/CodeSystem/v3-ParticipationType", "ATND", "attender")]}],
         "period": {"start": dt(d0, jam), "end": dt(akhir, 11 if ri else jam + 1)},
         "diagnosis": [{"condition": ref("Condition", c["id"]), "use": kc("http://terminology.hl7.org/CodeSystem/diagnosis-role", "DD", "Discharge diagnosis"), "rank": i + 1}
                       for i, c in enumerate(cond)],
         "serviceProvider": ref("Organization", org)}
    e["participant"][0]["individual"] = ref("Practitioner", prac)
    if ri:
        e["hospitalization"] = {"dischargeDisposition": kc("http://terminology.hl7.org/CodeSystem/discharge-disposition", disp[0], disp[1])}
        W.tambah({"resourceType": "Location", "id": f"{org}-bangsal", "meta": {"profile": [P + "id-core-location"]}, "status": "active",
                  "name": "Bangsal rawat inap", "mode": "instance", "physicalType": kc("http://terminology.hl7.org/CodeSystem/location-physical-type", "wa", "Ward"),
                  "managingOrganization": ref("Organization", org)})
        e["location"] = [{"location": {"reference": f"Location/{org}-bangsal", "display": f"Bangsal {kelas_rm or ''}".strip()},
                          "extension": [{"url": P + "id-core-service-class", "valueCodeableConcept": kc("http://terminology.kemkes.go.id/CodeSystem/locationServiceClass-Inpatient", KELAS.get(kelas_rm, "3"), kelas_rm or "Kelas 3")}]}]
        if sk == "readmisi_direncanakan":
            e["hospitalization"]["reAdmission"] = kc("http://terminology.hl7.org/CodeSystem/v2-0092", "R", "Re-admission")
            flag.append("readmisi_terencana")
    if sk == "rujukan_semu":
        e["hospitalization"] = {**e.get("hospitalization", {}), "admitSource": kc("http://terminology.hl7.org/CodeSystem/admit-source", "hosp-trans", "Transferred from other hospital")}
        flag.append("rujukan_tanpa_indikasi")
    if sk == "dokter_tiga_rs":
        flag.append("dokter_banyak_rs")
    W.tambah(e)
    # ---- clinical state: vitals and labs
    sumber = ctx["salin"].get(cid)  # kloning: another patient's visit, copied
    sakit = not tanpa_indikasi and (ri or rng.random() < 0.55)
    if keparahan_palsu:
        sakit = ri and sev in ("II", "III") and rng.random() < 0.25  # mild at most: the claimed severity is not there
    rng_v = _rng(sumber) if sumber else rng
    rentang = VITAL_SAKIT[grup] if sakit else VITAL_NORMAL
    nilai = [_u(rng_v, rentang[0]), _u(rng_v, rentang[1]), _u(rng_v, rentang[2]), _u(rng_v, rentang[3]), _u(rng_v, rentang[4], 1), _u(rng_v, rentang[5])]
    if tanpa_indikasi:
        flag.append({"tindakan_fiktif": "tanpa_indikasi_klinis", "rawat_inap_tanpa_indikasi": "rawat_inap_tanpa_indikasi",
                     "tidak_sesuai_indikasi": "prosedur_tanpa_indikasi"}.get(sk, "tanpa_indikasi_klinis"))
    if sumber:
        flag.append("rm_salinan")
    hilang_vital = sk == "normal" and rng.random() < 0.03
    if hilang_vital:
        noise.append("tanda_vital_tidak_lengkap")
    else:
        tanda_vital(W, enc, subj, prac, dt(d0, jam, 30), nilai, "masuk")
    if ri:
        pulang_buruk = sk in ("pulang_dini", "pulang_dini_readmisi") or (status == "APS" and rng.random() < 0.5)
        n_pulang = [_u(rng, (r[0] + 6, r[1] + 6)) if i < 3 else (_u(rng, r, 1) if i == 4 else _u(rng, r)) for i, r in enumerate(VITAL_SAKIT[grup])] if pulang_buruk else \
                   [_u(rng, VITAL_NORMAL[0]), _u(rng, VITAL_NORMAL[1]), _u(rng, VITAL_NORMAL[2]), _u(rng, VITAL_NORMAL[3]), _u(rng, VITAL_NORMAL[4], 1), _u(rng, VITAL_NORMAL[5])]
        if pulang_buruk:
            flag.append("pulang_belum_stabil")
        if status != "Meninggal":
            tanda_vital(W, enc, subj, prac, dt(akhir, 9), n_pulang, "pulang")
    # labs: the group's own markers (raised when ill), each true secondary diagnosis's marker (raised); claimed-only diagnoses: none
    lab_ok = ri or rng.random() < 0.35
    if lab_ok:
        sudah = set()
        for nm in GRUP_LAB.get(grup, []):
            lab(W, enc, subj, prac, dt(d0, jam + 1), nm, sakit and not (nm == "troponin" and grup == "angina"), _rng(sumber, nm) if sumber else rng)
            sudah.add(nm)
        for c, _n, labs in komorbid:
            for nm in labs:
                if nm not in sudah:
                    lab(W, enc, subj, prac, dt(d0, jam + 1), nm, True, rng)
                    sudah.add(nm)
        if keparahan_palsu and "kreatinin" not in sudah:
            lab(W, enc, subj, prac, dt(d0, jam + 1), "kreatinin", False, rng)
    # ECG for every cardiology visit except plain vascular; LVEF for inpatient heart failure / coronary / valve
    if grup not in ("vaskular_lain",) and (ri or rng.random() < 0.6):
        obs(W, f"{enc}-ekg", "procedure", "11524-6", "EKG study", subj, enc, dt(d0, jam, 45), prac, valueString=EKG[grup] if sakit else EKG_NORMAL)
    if ri and grup in ("gagal_jantung", "sindrom_koroner_akut", "katup", "jantung_koroner_kronis"):
        ef = _u(rng, (22, 38)) if (sakit and grup in ("gagal_jantung", "katup")) else _u(rng, (42, 50)) if sakit else _u(rng, (55, 68))
        obs(W, f"{enc}-ef", "procedure", "10230-1", "Left ventricular Ejection fraction", subj, enc, dt(d0 + timedelta(days=1 if ri else 0), 10), prac,
            valueQuantity={"value": ef, "unit": "%", "system": UCUM, "code": "%"})
    # ---- procedures: the true ones done; the billed-only ones absent (tindakan_fiktif) or not-done (operasi_batal_ditagih)
    benar = {c for c, _ in pros_benar}
    for i, (c, n) in enumerate(pros_klaim):
        if c in benar or sk not in ("tindakan_fiktif", "operasi_batal_ditagih"):
            status_p, alasan_p = "completed", None
        elif sk == "operasi_batal_ditagih":
            status_p, alasan_p = "not-done", "Tindakan dibatalkan (kondisi pasien/jadwal); tidak dilakukan"
        else:
            continue
        x = {"resourceType": "Procedure", "id": f"{enc}-tind{i}", "meta": {"profile": [P + "id-core-procedure"]}, "status": status_p,
             "code": kc(ICD9, c, n), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc),
             "performedPeriod": {"start": dt(d0 + timedelta(days=1 if ri and akhir > d0 else 0), 10), "end": dt(d0 + timedelta(days=1 if ri and akhir > d0 else 0), 11)},
             "performer": [{"actor": ref("Practitioner", prac)}]}
        if alasan_p:
            x["statusReason"] = {"text": alasan_p}
        elif sk != "tidak_sesuai_indikasi":
            x["reasonCode"] = [kc(ICD10, dx_utama)]
        W.tambah(x)
    for c, n in pros_benar:  # true procedures the claim does not list
        if c not in {x for x, _ in pros_klaim}:
            W.tambah({"resourceType": "Procedure", "id": f"{enc}-tindb-{c.replace('.', '')}", "meta": {"profile": [P + "id-core-procedure"]}, "status": "completed",
                      "code": kc(ICD9, c, n), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "performedDateTime": dt(d0, 10),
                      "performer": [{"actor": ref("Practitioner", prac)}], "reasonCode": [kc(ICD10, dx_utama)]})
    if sk == "tindakan_fiktif" and any(c not in benar for c, _ in pros_klaim) or (sk == "tindakan_fiktif" and not pros_klaim):
        flag.append("prosedur_tidak_ada_di_rm")
    if sk == "operasi_batal_ditagih":
        flag.append("prosedur_batal")
    # ---- special CMG top-ups: what the hospital really gave (absent when the scheme invented it)
    topup_benar = asli.get("topup") if "topup" in asli else None
    for col in ("sp", "rr", "si", "sd", "sa"):
        kode_t = k.get(f"{col}_kode")
        if not kode_t or (isinstance(kode_t, float) and kode_t != kode_t):
            continue
        ada = True
        if sk == "obat_alkes_fiktif" and topup_benar is not None and col not in topup_benar:
            ada = False
        if not ada:
            flag.append("obat_alkes_tidak_ada_di_rm")
            continue
        desk = k.get(f"{col}_deskripsi") or kode_t
        if col == "sd":
            W.tambah({"resourceType": "MedicationDispense", "id": f"{enc}-sd", "meta": {"profile": [P + "id-core-medication-dispense"]}, "status": "completed",
                      "medicationCodeableConcept": {"coding": [{"system": CMG, "code": kode_t, "display": desk}], "text": f"{desk} (special CMG {kode_t})"}, "subject": ref("Patient", subj), "context": ref("Encounter", enc),
                      "quantity": {"value": 1, "unit": "paket"}, "whenHandedOver": dt(d0, 12)})
        elif col == "si":
            W.tambah({"resourceType": "DiagnosticReport", "id": f"{enc}-si", "meta": {"profile": [P + "id-core-diagnostic-report"]}, "status": "final",
                      "code": {"coding": [{"system": CMG, "code": kode_t, "display": desk}], "text": f"{desk} (special CMG {kode_t})"},
                      "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "effectiveDateTime": dt(d0, 13), "issued": dt(d0, 15), "performer": [ref("Practitioner", prac)], "conclusion": "Hasil terlampir"})
        else:
            W.tambah({"resourceType": "Procedure", "id": f"{enc}-{col}", "meta": {"profile": [P + "id-core-procedure"]}, "status": "completed",
                      "code": {"coding": [{"system": CMG, "code": kode_t, "display": desk}], "text": f"{desk} (special CMG {kode_t})"},
                      "subject": ref("Patient", subj), "encounter": ref("Encounter", enc), "performedDateTime": dt(d0, 11), "performer": [{"actor": ref("Practitioner", prac)}]})
    if sk == "obat_alkes_fiktif" and "obat_alkes_tidak_ada_di_rm" not in flag:
        flag.append("obat_alkes_tidak_ada_di_rm")
    # ---- drugs: by group and true comorbidities; a dispense can be missing (noise)
    daftar = list(GRUP_OBAT.get(grup, []))[: 2 + int(ri) + int(sakit)]
    if grup == "gagal_jantung" and ri:
        daftar[0] = "C03CA01_IV"
    if grup == "stroke" and ri and dx_icd3 in ("I61", "I62"):
        daftar.append("B05BC01")
    daftar += [KOMORBID_OBAT[c] for c, _n, _l in komorbid if c in KOMORBID_OBAT]
    for i, atc in enumerate(dict.fromkeys(daftar)):
        serah = not (sk == "normal" and rng.random() < 0.05 and i == 0)
        if not serah:
            noise.append("obat_tidak_tercatat")
        obat(W, enc, subj, prac, dt(d0, jam + 1), atc, i, ri, serah, dx_utama)
    # ---- discharge summary (inpatient): diagnosis, procedures, therapy, condition at discharge, follow-up plan
    if ri:
        if sk == "normal" and rng.random() < 0.04:
            noise.append("resume_tidak_ada")
        else:
            boleh = akhir
            rencana = "Kontrol poli jantung 7 hari setelah pulang."
            kondisi = "Keadaan umum baik, tanda vital stabil." if "pulang_belum_stabil" not in flag else "Pulang dengan keluhan masih ada; tanda vital belum stabil."
            if sk == "los_diperpanjang" and "los" in asli:
                boleh = d0 + timedelta(days=int(asli["los"]))
                flag.append("boleh_pulang_lebih_awal")
                kondisi = f"Kondisi stabil, pasien boleh pulang sejak {boleh.isoformat()}."
            if ctx["rencana_masuk"].get(cid):
                rencana = f"Rencana masuk kembali tanggal {ctx['rencana_masuk'][cid]} untuk tindakan lanjutan (terjadwal)."
            if tanpa_indikasi and sk == "rawat_inap_tanpa_indikasi":
                kondisi = "Observasi; tidak ditemukan kegawatan. Keadaan umum baik sejak masuk."
            teks_tind = ", ".join(f"{c} {n}" for c, n in pros_benar) or "Tidak ada tindakan operatif."
            sek = [("Diagnosis", "; ".join(f"{c['code']} {c['nama']}" for c in cond), [ref("Condition", c["id"]) for c in cond]),
                   ("Tindakan", teks_tind, []), ("Terapi", ", ".join(OBAT[a][0] for a in dict.fromkeys(daftar)), []),
                   ("Kondisi saat pulang", kondisi, []), ("Rencana tindak lanjut", rencana, [])]
            if sumber:  # copied summary: another patient's text
                sek[3] = ("Kondisi saat pulang", ctx["teks_salin"].get(sumber, kondisi), [])
            W.tambah({"resourceType": "Composition", "id": f"{enc}-resume", "meta": {"profile": [P + "id-core-composition"]}, "status": "final",
                      "type": kc(LOINC, "18842-5", "Discharge summary"), "subject": ref("Patient", subj), "encounter": ref("Encounter", enc),
                      "date": dt(akhir, 10), "author": [ref("Practitioner", prac)], "title": "Resume Medis Rawat Inap",
                      "section": [{"title": t, "text": {"status": "generated", "div": f"<div xmlns=\"http://www.w3.org/1999/xhtml\">{v}</div>"}, **({"entry": en} if en else {})}
                                  for t, v, en in sek]})
            ctx["teks_klaim"][cid] = kondisi
    if sk in ("tagihan_gelembung", "topup_gelembung"):
        flag.append("tidak_terlihat_di_rm")
    return {"rm_ada": True, "ketidaksesuaian": list(dict.fromkeys(x for x in flag if x)), "noise": noise, "encounter": enc}


def konteks(df: pd.DataFrame, r: int, label_rs: dict, dx_nama: dict) -> dict:
    """Links between claims a scheme creates: split episodes, planned readmissions, copied records, the shared doctor."""
    ctx = {"r": r, "label_rs": label_rs, "dx_nama": dx_nama, "gabung": {}, "perpanjang": {}, "rencana_masuk": {}, "salin": {}, "teks_salin": {},
           "teks_klaim": {}, "dokter_bersama": {}}
    df = df.sort_values(["peserta_id", "tgl_datang", "urut"])
    for _pid, g in df.groupby("peserta_id"):
        rows = g.to_dict("records")
        for i, b in enumerate(rows):
            if b["_sk"] != "pemecahan_episode":
                continue
            var = b["_varian"] or ""
            if var.endswith("_2"):  # an inpatient stay split in two: part 2 is part 1's stay (one encounter to part 2's discharge)
                a = next((x for x in reversed(rows[:i]) if x["_sk"] == "pemecahan_episode" and (x["_varian"] or "").endswith("_1")
                          and x["faskes_profil"] == b["faskes_profil"]), None)
                if a:
                    ctx["gabung"][b["kunjungan_fkrtl_id"]] = f"enc-{a['kunjungan_fkrtl_id']}"
                    ctx["perpanjang"][a["kunjungan_fkrtl_id"]] = pd.Timestamp(b["tgl_pulang"] or b["tgl_datang"]).date()
            elif var == "rj_ri_hari_sama":  # the outpatient visit billed apart is where the same-day admission began
                a = next((x for x in rows if x is not b and x["tingkat_pelayanan"] == "RITL" and x["faskes_profil"] == b["faskes_profil"]
                          and pd.Timestamp(x["tgl_datang"]).date() == pd.Timestamp(b["tgl_datang"]).date()), None)
                if a:
                    ctx["gabung"][b["kunjungan_fkrtl_id"]] = f"enc-{a['kunjungan_fkrtl_id']}"
        for a, b in zip(rows, rows[1:]):
            if b["_sk"] == "readmisi_direncanakan" and a["tingkat_pelayanan"] == "RITL":
                ctx["rencana_masuk"][a["kunjungan_fkrtl_id"]] = str(pd.Timestamp(b["tgl_datang"]).date())
    # a cloned claim copies the record of another patient's visit at the same hospital with the same code
    donor = {}
    for row in df[df._sk != "kloning"].itertuples(index=False):
        donor.setdefault((row.faskes_profil, row.inacbg_kode), row.kunjungan_fkrtl_id)
    for row in df[df._sk == "kloning"].itertuples(index=False):
        d = donor.get((row.faskes_profil, row.inacbg_kode))
        if d:
            ctx["salin"][row.kunjungan_fkrtl_id] = d
    for row in df[df._sk == "dokter_tiga_rs"].itertuples(index=False):
        ctx["dokter_bersama"][row.kunjungan_fkrtl_id] = hashlib.md5(f"{r}|dokter_tiga_rs".encode()).hexdigest()
    return ctx


def tulis_replika(arg: tuple) -> dict:
    f_klaim, folder, label_rs, dx_nama = arg
    t = time.time()
    df = pd.read_parquet(f_klaim)
    r = int(df.replika.iloc[0])
    tema = df[df.rs_di_kc & (df.tema == "I")].copy()
    W = Penulis(r)
    ctx = konteks(tema, r, label_rs, dx_nama)
    # copied records need the donor written first: donors before clones
    urut = pd.concat([tema[tema._sk != "kloning"], tema[tema._sk == "kloning"]])
    kunci = []
    for k in urut.to_dict("records"):
        rng = _rng(r, k["kunjungan_fkrtl_id"])
        if ctx["salin"].get(k["kunjungan_fkrtl_id"]):
            ctx["teks_salin"].setdefault(ctx["salin"][k["kunjungan_fkrtl_id"]], ctx["teks_klaim"].get(ctx["salin"][k["kunjungan_fkrtl_id"]], "Keadaan umum baik, tanda vital stabil."))
        hasil = satu_klaim(W, k, ctx, rng)
        kunci.append({"kunjungan_fkrtl_id": k["kunjungan_fkrtl_id"], "replika": r, "skema": k["_sk"], "varian": k["_varian"], "encounter": hasil.get("encounter"),
                      "rm_ada": hasil["rm_ada"], "ketidaksesuaian": "|".join(hasil["ketidaksesuaian"]), "noise": "|".join(hasil["noise"])})
    out = Path(folder) / "rekam_medis" / f"replika_{r:02d}"
    out.mkdir(parents=True, exist_ok=True)
    n = {}
    for tipe, xs in W.res.items():
        with gzip.open(out / f"{tipe}.ndjson.gz", "wt", encoding="utf-8") as fh:
            for x in xs:
                fh.write(json.dumps(x, ensure_ascii=False, separators=(",", ":")) + "\n")
        n[tipe] = len(xs)
    pd.DataFrame(kunci).to_parquet(Path(folder) / "kunci" / f"ketidaksesuaian_rm_{r:02d}.parquet", index=False)
    return {"replika": r, "klaim_tema": len(tema), "sumber_daya": n, "detik": round(time.time() - t, 1)}


def main(folder: Path, proses: int) -> None:
    import os

    os.environ.setdefault("GEN3_W1", "2025-12-17")
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(ROOT / "api"))
    import generator3 as G
    import laporan_cabang as LC

    D = G.dunia()
    label_rs = {f: LC.label_rs(r) for f, r in D.rs.items()}
    dx_nama = {k: v for k, v in (D.M.get("dxk_nama") or {}).items() if v}
    files = sorted((folder / "klaim").glob("replika_*.parquet"))
    t0 = time.time()
    from concurrent.futures import ProcessPoolExecutor

    hasil = []
    with ProcessPoolExecutor(max_workers=proses) as ex:
        for h in ex.map(tulis_replika, [(str(f), str(folder), label_rs, dx_nama) for f in files]):
            hasil.append(h)
            print(f"replica {h['replika']:02d}: {h['klaim_tema']} theme claims -> {sum(h['sumber_daya'].values()):,} resources ({h['detik']} s)", flush=True)
    tot = defaultdict(int)
    for h in hasil:
        for k, v in h["sumber_daya"].items():
            tot[k] += v
    (folder / "ringkasan_rekam_medis.json").write_text(json.dumps({"dibuat": time.strftime("%Y-%m-%d %H:%M"), "replika": len(hasil), "sumber_daya": dict(tot),
                                                                  "per_replika": sorted(hasil, key=lambda x: x["replika"]), "detik": round(time.time() - t0)}, ensure_ascii=False, indent=1), "utf-8")
    print(f"{len(hasil)} replicas, {sum(tot.values()):,} FHIR resources: {dict(tot)}; {time.time() - t0:.0f} s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default=str(ROOT / "Data Sintetis" / "tema_jantung_kc_sul-7371"))
    ap.add_argument("--proses", type=int, default=4)
    a = ap.parse_args()
    main(Path(a.folder), a.proses)
