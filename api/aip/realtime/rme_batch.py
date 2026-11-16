"""The medical-record rules on a file of claims with their records, offline (no engine, no registry): for the synthetic cardiac
claims and their SATUSEHAT records built in another session (100,000 rows), and for any hospital's export.

Input (one claim with its record per item; testing/uji_rme.py --masuk PATH):
  .jsonl / .ndjson   one JSON object per line: {"klaim": {...}, "rekam_medis": <FHIR Bundle>, "label": {...}}
                     key aliases: klaim | claim; rekam_medis | rme | emr | bundle | fhir; label | truth | kebenaran
  .json              a list of such objects, one such object, or one FHIR Bundle holding an ID Core Claim resource
  a directory        every *.json / *.jsonl in it, read as above
  A FHIR Bundle with a Claim resource (https://fhir.kemkes.go.id/r4/StructureDefinition/id-core-claim) needs no "klaim":
  billablePeriod, diagnosis (ICD-10, sequence 1 = principal), procedure (ICD-9-CM) and total are read from the Claim.

Claim fields (klaim_umum): the realtime contract's names (tgl_datang, tgl_pulang, tingkat_pelayanan, dx_primer_kode, prosedur,
sd_tarif_rp, ...), the hospital submission's (tanggal_masuk, tanggal_pulang, jenis_episode, diagnosis_utama, diagnosis_sekunder,
tindakan, ...) or plain English ones (admission_date, discharge_date, primary_diagnosis, secondary_diagnoses, procedures).
The card holder's sex/birth date may come as klaim.peserta {jk, tgl_lahir} (else the identity check is skipped).

Label (optional): {"fraud": true|false} and/or {"skenario": "..."}; with labels the report gives the detection per scenario
and the false alerts on normal claims.
"""

from __future__ import annotations

import json
import math
import os
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any, Iterator, Optional

from aip.realtime import modus as MO
from aip.realtime import rme as R

AMBANG = (45.0, 75.0)  # the engine's defaults (mesin.DEFAULTS): PERIKSA, TAHAN


def skor(sinyal: list[dict], bobot: Optional[dict] = None, ambang: tuple[float, float] = AMBANG) -> tuple[float, str, list[dict]]:
    """The engine's rule score on the RME findings: 100 x (1 - e^-sum(w * s * (1 - mitigation))), and the decision."""
    tot = 0.0
    out = []
    for s in sinyal:
        w = float((bobot or {}).get(s["kode"], MO.SIGNALS[s["kode"]][2]))
        m = math.prod(1 - x["faktor"] for x in s.get("mitigasi") or [])
        c = round(w * s["s"] * m, 4)
        tot += c
        out.append({"kode": s["kode"], "label": MO.SIGNALS[s["kode"]][3], "modus": MO.SIGNALS[s["kode"]][0], "s": s["s"], "kontribusi": c,
                    "mitigasi": [x["kode"] for x in s.get("mitigasi") or []], "bukti": s["bukti"]})
    sc = round(100 * (1 - math.exp(-tot)), 1)
    return sc, ("TAHAN" if sc >= ambang[1] else "PERIKSA" if sc >= ambang[0] else "LOLOS"), out


# ---------------------------------------------------------------------------------------------------------------------
# reading the input
# ---------------------------------------------------------------------------------------------------------------------
def _pilih(d: dict, *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def _daftar(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [x.strip() for x in v.replace("|", ";").split(";") if x.strip()]
    out = []
    for x in v:
        if isinstance(x, dict):  # {"kode": "37.23", "nama": "..."} / {"code": ..., "display": ...}
            c = _pilih(x, "kode", "code", "icd9", "icd10")
            n = _pilih(x, "nama", "display", "deskripsi", "description")
            out.append(f"{c} - {n}" if (c and n) else str(c or n or ""))
        else:
            out.append(str(x))
    return [x for x in out if x.strip()]


def klaim_umum(d: dict) -> dict:
    """Any of the accepted claim shapes -> the fields rme.periksa reads."""
    ting = _pilih(d, "tingkat_pelayanan", "tingkat")
    ep = str(_pilih(d, "jenis_episode", "episode", "encounter_class", "jenis_rawat") or "").lower()
    if not ting:
        ting = "RITL" if ep in ("ri", "imp", "inpatient", "rawat inap", "ranap") else "RJTL" if ep else None
    d0 = _pilih(d, "tgl_datang", "tanggal_masuk", "admission_date", "tgl_masuk", "start")
    d1 = _pilih(d, "tgl_pulang", "tanggal_pulang", "discharge_date", "tgl_keluar", "end")
    if not ting:
        ting = "RITL" if (d1 and str(d1)[:10] != str(d0)[:10]) else "RJTL"
    top = {}
    for c in ("sa", "sp", "rr", "si", "sd"):
        v = _pilih(d, f"{c}_tarif_rp")
        if v:
            top[c] = int(v)
    if d.get("topup_jenis") and d.get("topup_rp"):
        top[str(d["topup_jenis"])] = int(d["topup_rp"])
    pes = d.get("peserta") if isinstance(d.get("peserta"), dict) else {}
    return {"id": str(_pilih(d, "klaim_id", "kunjungan_fkrtl_id", "id", "claim_id") or ""),
            "tgl_datang": R._tgl(d0), "tgl_pulang": R._tgl(d1), "tingkat": ting,
            "poli": "IGD" if ep == "igd" else _pilih(d, "poli"),
            "dx_utama": _pilih(d, "dx_utama", "diagnosis_utama", "dx_primer_kode", "primary_diagnosis", "dx_primer_icd3"),
            "dx_sekunder": _daftar(_pilih(d, "dx_sekunder", "diagnosis_sekunder", "secondary_diagnoses")),
            "jumlah_dx_sekunder": _pilih(d, "jumlah_dx_sekunder"),
            "tindakan": _daftar(_pilih(d, "tindakan", "prosedur", "procedures")),
            "sd_tarif_rp": top.get("sd", 0), "rr_tarif_rp": top.get("rr", 0), "obat": d.get("obat") or [],
            "inacbg_kode": _pilih(d, "inacbg_kode", "inacbg"), "biaya": _pilih(d, "biaya_tagih_rp", "total", "billed"),
            "hari_icu": _pilih(d, "hari_icu", "lama_icu_hari", "icu_los"), "jam_ventilator": _pilih(d, "jam_ventilator", "ventilator_hour"),
            "status_pulang": _pilih(d, "status_pulang"),
            "peserta": {"jk": _pilih(pes, "jk", "gender") or d.get("jk"), "tgl_lahir": _pilih(pes, "tgl_lahir", "birthDate") or d.get("tgl_lahir")}}


def klaim_dari_fhir(bundle: dict) -> Optional[dict]:
    """The claim from an ID Core Claim resource in the Bundle (none -> None)."""
    cl = next((e.get("resource") for e in bundle.get("entry") or [] if isinstance(e, dict) and (e.get("resource") or {}).get("resourceType") == "Claim"), None)
    if not cl:
        return None
    bp = cl.get("billablePeriod") or {}
    dx = sorted(cl.get("diagnosis") or [], key=lambda x: x.get("sequence") or 99)
    kode = [c.get("code") for x in dx for c in (x.get("diagnosisCodeableConcept") or {}).get("coding") or [] if c.get("code")]
    pr = []
    for x in sorted(cl.get("procedure") or [], key=lambda x: x.get("sequence") or 99):
        for c in (x.get("procedureCodeableConcept") or {}).get("coding") or []:
            if c.get("code"):
                pr.append(f"{c['code']} - {c.get('display') or ''}".strip(" -"))
    sub = " ".join(str(c.get("code") or "") for c in (cl.get("subType") or {}).get("coding") or []).lower()
    a, b = R._tgl(bp.get("start")), R._tgl(bp.get("end"))
    return {"klaim_id": cl.get("id"), "tgl_datang": a, "tgl_pulang": b,
            "tingkat_pelayanan": "RITL" if ("inpatient" in sub or "ri" == sub or (a and b and b > a)) else "RJTL",
            "dx_utama": kode[0] if kode else None, "dx_sekunder": kode[1:], "tindakan": pr, "biaya_tagih_rp": (cl.get("total") or {}).get("value")}


def _item(o: Any) -> Optional[dict]:
    """One input object -> {klaim, rekam_medis, label} or None."""
    if not isinstance(o, dict):
        return None
    if o.get("resourceType") == "Bundle":
        k = klaim_dari_fhir(o)
        return {"klaim": k, "rekam_medis": o, "label": None} if k else None
    k = _pilih(o, "klaim", "claim")
    b = _pilih(o, "rekam_medis", "rme", "emr", "bundle", "fhir")
    if isinstance(b, dict) and not k:
        k = klaim_dari_fhir(b)
    if not isinstance(k, dict):
        return None
    return {"klaim": k, "rekam_medis": b, "label": _pilih(o, "label", "truth", "kebenaran")}


def baca_masukan(path: str | Path) -> Iterator[dict]:
    p = Path(path)
    files = sorted(x for x in p.rglob("*") if x.suffix.lower() in (".json", ".jsonl", ".ndjson")) if p.is_dir() else [p]
    for f in files:
        if f.suffix.lower() in (".jsonl", ".ndjson"):
            with f.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        it = _item(json.loads(line))
                        if it:
                            yield it
        else:
            o = json.loads(f.read_text("utf-8"))
            for x in (o if isinstance(o, list) else [o]):
                it = _item(x)
                if it:
                    yield it


# ---------------------------------------------------------------------------------------------------------------------
# judging
# ---------------------------------------------------------------------------------------------------------------------
def nilai_satu(it: dict, ambang: tuple[float, float] = AMBANG) -> dict:
    k = klaim_umum(it["klaim"])
    lab = it.get("label")
    if isinstance(lab, dict):
        label = {"fraud": lab.get("fraud", lab.get("is_fraud")), "skenario": lab.get("skenario") or lab.get("scenario") or lab.get("jenis")}
    elif isinstance(lab, bool):
        label = {"fraud": lab, "skenario": None}
    elif isinstance(lab, str):
        label = {"fraud": lab not in ("normal", "wajar", "0", "false"), "skenario": lab}
    else:
        label = None
    if it.get("rekam_medis") is None:
        h = R.lewati("tidak ada rekam medis")
    else:
        rme = R.baca(it["rekam_medis"], (k["peserta"] or {}).get("jk"))
        h = R.periksa(k, rme, "", k["peserta"] if (k["peserta"] or {}).get("jk") else None)
    sc, kep, temuan = skor(h["sinyal"], None, ambang)
    return {"id": k["id"], "keputusan": kep, "skor": sc, "temuan": temuan, "hasil": h["hasil"], "label": label,
            "tanggal": str(k["tgl_datang"]) if k["tgl_datang"] else None, "tindakan": k["tindakan"][:6], "dx_utama": k["dx_utama"]}


def ringkas(hasil: Iterator[dict] | list[dict]) -> dict:
    """The report: decisions, findings, and with labels the detection per scenario and the false alerts."""
    n = 0
    kep: Counter = Counter()
    sinyal: Counter = Counter()
    per: dict[str, Counter] = {}
    normal = Counter()
    fraud = Counter()
    sinyal_normal: Counter = Counter()
    contoh_fp: list[dict] = []
    for h in hasil:
        n += 1
        kep[h["keputusan"]] += 1
        alert = h["keputusan"] != "LOLOS"
        for t in h["temuan"]:
            if t["kontribusi"] > 0:
                sinyal[t["kode"]] += 1
        lab = h.get("label")
        if not lab:
            continue
        sk = str(lab.get("skenario") or ("fraud" if lab.get("fraud") else "normal"))
        c = per.setdefault(sk, Counter())
        c["n"] += 1
        c["alert"] += alert
        c["tahan"] += h["keputusan"] == "TAHAN"
        if lab.get("fraud") is False or sk in ("normal", "wajar"):
            normal["n"] += 1
            normal["alert"] += alert
            if alert:
                for t in h["temuan"]:
                    if t["kontribusi"] > 0:
                        sinyal_normal[t["kode"]] += 1
                if len(contoh_fp) < 10:
                    contoh_fp.append({"id": h["id"], "skor": h["skor"], "temuan": [t["bukti"][:300] for t in h["temuan"] if t["kontribusi"] > 0]})
        elif lab.get("fraud"):
            fraud["n"] += 1
            fraud["alert"] += alert
    out = {"klaim": n, "keputusan": dict(kep), "temuan": dict(sinyal.most_common())}
    if per:
        out["per_skenario"] = {k: {"n": v["n"], "ditandai": v["alert"], "ditahan": v["tahan"], "porsi_ditandai": round(v["alert"] / v["n"], 4) if v["n"] else None}
                               for k, v in sorted(per.items())}
        out["fraud"] = {"n": fraud["n"], "ditandai": fraud["alert"], "recall": round(fraud["alert"] / fraud["n"], 4) if fraud["n"] else None}
        out["normal"] = {"n": normal["n"], "ditandai": normal["alert"], "false_alert_rate": round(normal["alert"] / normal["n"], 4) if normal["n"] else None,
                         "temuan_pada_false_alert": dict(sinyal_normal.most_common()), "contoh": contoh_fp}
    return out


def _kerja(args: tuple) -> dict:
    it, ambang = args
    try:
        return nilai_satu(it, ambang)
    except Exception as e:  # noqa: BLE001 - one bad item never stops a 100k run
        return {"id": str((it.get("klaim") or {}).get("klaim_id") or "?"), "keputusan": "GALAT", "skor": None, "temuan": [], "hasil": [],
                "label": None, "galat": f"{type(e).__name__}: {e}"[:300]}


def jalankan(masuk: str | Path, keluar: Optional[str | Path] = None, ambang: tuple[float, float] = AMBANG, proses: int = 0,
             batas: Optional[int] = None) -> dict:
    """Judge every item of the input; per-claim results to `keluar` (JSONL) when given; returns the report."""
    import itertools

    items = baca_masukan(masuk)
    if batas:
        items = itertools.islice(items, batas)
    fh = open(keluar, "w", encoding="utf-8") if keluar else None
    semua: list[dict] = []
    try:
        if proses and proses > 1:
            from multiprocessing import Pool

            with Pool(proses) as pool:
                it_res = pool.imap(_kerja, ((x, ambang) for x in items), chunksize=64)
                for h in it_res:
                    semua.append({k: h[k] for k in ("id", "keputusan", "skor", "temuan", "label") if k in h})
                    if fh:
                        fh.write(json.dumps(h, ensure_ascii=False, default=str) + "\n")
        else:
            for x in items:
                h = _kerja((x, ambang))
                semua.append({k: h[k] for k in ("id", "keputusan", "skor", "temuan", "label") if k in h})
                if fh:
                    fh.write(json.dumps(h, ensure_ascii=False, default=str) + "\n")
    finally:
        if fh:
            fh.close()
    rep = ringkas([h for h in semua if h["keputusan"] != "GALAT"])
    rep["galat"] = sum(1 for h in semua if h["keputusan"] == "GALAT")
    rep["ambang"] = {"periksa": ambang[0], "tahan": ambang[1]}
    rep["versi_aturan"] = R.VERSI
    rep["bobot"] = {k: MO.SIGNALS[k][2] for k in MO.RME_SIGNALS}
    return rep


# ---------------------------------------------------------------------------------------------------------------------
# FHIR Bulk Data (NDJSON) folders: one file per resource type, claims beside them (the other session's cardiac theme set)
# ---------------------------------------------------------------------------------------------------------------------
# what a planted mismatch of the key file should raise (the report only: the rules never read the key)
HARAPAN = {"rm_tidak_ada": {"RME_KUNJUNGAN_TIDAK_ADA"}, "kunjungan_ganda": {"RME_KUNJUNGAN_DIPAKAI_ULANG", "RME_KUNJUNGAN_TIDAK_ADA"},
           "episode_menyatu": {"RME_EPISODE_DIPECAH", "RME_KUNJUNGAN_DIPAKAI_ULANG"}, "prosedur_tidak_ada_di_rm": {"RME_TINDAKAN_TIDAK_TERCATAT"},
           "prosedur_batal": {"RME_TINDAKAN_TIDAK_TERCATAT"}, "tanpa_indikasi_klinis": {"RME_KLINIS_TIDAK_MENDUKUNG", "RME_RAWAT_INAP_TANPA_INDIKASI"},
           "prosedur_tanpa_indikasi": {"RME_KLINIS_TIDAK_MENDUKUNG"}, "dx_sekunder_kurang": {"RME_DIAGNOSIS_TIDAK_TERCATAT"},
           "keparahan_tidak_didukung": {"RME_DIAGNOSIS_TIDAK_TERCATAT", "RME_DIAGNOSIS_TIDAK_DIDUKUNG"}, "dx_utama_berbeda": {"RME_DIAGNOSIS_TIDAK_TERCATAT"},
           "obat_alkes_tidak_ada_di_rm": {"RME_OBAT_ALKES_TIDAK_TERCATAT"}, "kelas_rawat_berbeda": {"RME_KELAS_BERBEDA"},
           "rawat_inap_tanpa_indikasi": {"RME_RAWAT_INAP_TANPA_INDIKASI"}, "boleh_pulang_lebih_awal": {"RME_LOS_TIDAK_SESUAI"},
           "identitas_tidak_cocok": {"RME_PASIEN_BERBEDA"},
           # rules added 2026-11-15 (the stay in the context of the patient's other encounters)
           "readmisi_terencana": {"RME_READMISI_TERENCANA"}, "rujukan_tanpa_indikasi": {"RME_RUJUKAN_TANPA_INDIKASI"},
           "dokter_banyak_rs": {"RME_DOKTER_PASIEN_DIPUTAR"}, "pulang_belum_stabil": {"RME_READMISI_PULANG_DINI"}}
TANPA_JEJAK_RM = {"tidak_terlihat_di_rm"}  # schemes the record cannot show (a bill inflated with a consistent record)
SISTEM_NO_PESERTA = ("jkn", "bpjs", "no-peserta", "nokartu", "no_kartu")


def _nomor(path: Path) -> Optional[str]:
    import re

    m = re.search(r"(\d+)(?!.*\d)", path.stem.replace(".ndjson", ""))
    return m.group(1).lstrip("0") or "0" if m else None


def folder_bulk(folder: str | Path) -> list[dict]:
    """The replicas of a bulk folder: {klaim, rm, kunci, peserta}, matched by their number. klaim/kunci/peserta are either one
    file per replica (replika_00.parquet ...) or one file with a `replika` column (then {"file", "replika"})."""
    f = Path(folder)
    rm = f / "rekam_medis"
    if not rm.is_dir():
        return []
    rm_dirs = {_nomor(d): d for d in rm.iterdir() if d.is_dir()} or ({"0": rm} if any(rm.glob("*.ndjson*")) else {})

    def sumber(sub: str, pilih: tuple[str, ...] = ()) -> dict:
        d = f / sub
        if not d.is_dir():
            return {}
        files = [x for x in d.glob("*") if x.suffix in (".parquet", ".jsonl", ".ndjson")]
        per = {_nomor(x): x for x in files if x.stem.startswith(("replika", "ketidaksesuaian_rm_"))}
        if per:
            return {n: {"file": str(p)} for n, p in per.items()}
        satu = next((x for w in pilih for x in files if w in x.name), None) or next((x for x in files if x.suffix == ".parquet"), None)
        return {n: {"file": str(satu), "replika": int(n)} for n in rm_dirs} if satu else {}

    klaim = sumber("klaim", ("klaim_jantung", "klaim_tema", "klaim_"))
    kunci = sumber("kunci", ("ketidaksesuaian_rm",))
    peserta = sumber("peserta", ("peserta",))
    return [{"n": n, "klaim": klaim[n], "rm": str(rm_dirs[n]), "kunci": kunci.get(n), "peserta": peserta.get(n)}
            for n in sorted(rm_dirs, key=lambda x: int(x)) if n in klaim]


def _baca_tabel(src: Optional[dict]) -> Any:
    """One replica's rows of a table source (a per-replica file, or the rows of one file with that `replika`)."""
    import pandas as pd

    if not src:
        return None
    p = Path(src["file"])
    if "replika" in src:
        df = pd.read_parquet(p, filters=[("replika", "==", src["replika"])]) if p.suffix == ".parquet" else pd.read_json(p, lines=True)
        return df[df["replika"] == src["replika"]] if "replika" in df.columns else df
    return pd.read_parquet(p) if p.suffix == ".parquet" else pd.read_json(p, lines=True)


def _ndjson(d: Path) -> Iterator[dict]:
    import gzip

    for p in sorted(d.glob("*.ndjson*")):
        op = gzip.open if p.suffix == ".gz" else open
        with op(p, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield json.loads(line)


def _subjek(r: dict) -> Optional[str]:
    ref = (r.get("subject") or r.get("patient") or {}).get("reference") if isinstance(r.get("subject") or r.get("patient"), dict) else None
    return ref.split("/", 1)[1] if ref and ref.startswith("Patient/") else None


def nilai_replika(arg: tuple) -> dict:
    """One replica of a bulk folder: every claim of the key file (or every claim whose patient has a record), judged."""
    import pandas as pd

    rep, ambang, keluar = arg
    by_pid: dict[str, list[dict]] = {}
    pasien: dict[str, dict] = {}
    obat: list[dict] = []
    for r in _ndjson(Path(rep["rm"])):
        rt = r.get("resourceType")
        if rt == "Patient":
            pasien[r.get("id")] = r
        elif rt == "Medication":
            obat.append(r)
        else:
            pid = _subjek(r)
            if pid:
                by_pid.setdefault(pid, []).append(r)
    no_ke_pid: dict[str, str] = {}
    for pid, p in pasien.items():
        for i in p.get("identifier") or []:
            if any(w in str(i.get("system") or "").lower() for w in SISTEM_NO_PESERTA) and i.get("value"):
                no_ke_pid[str(i["value"])] = pid
    df = _baca_tabel(rep["klaim"])
    kunci = _baca_tabel(rep.get("kunci"))
    reg = _baca_tabel(rep.get("peserta"))  # the member registry of the replica: sex, age (the identity check)
    registri = {}
    if reg is not None and len(reg):
        cj = next((c for c in ("jk", "jenis_kelamin", "_jk") if c in reg.columns), None)
        cu = next((c for c in ("usia", "usia_tahun", "umur", "_usia") if c in reg.columns), None)
        cl = next((c for c in ("tgl_lahir", "tanggal_lahir") if c in reg.columns), None)
        for r in reg.to_dict("records"):
            registri[str(r.get("peserta_id"))] = {"jk": r.get(cj) if cj else None, "umur": r.get(cu) if cu else None,
                                                  "tgl_lahir": str(r.get(cl))[:10] if cl and r.get(cl) is not None else None}
    if kunci is not None:
        lab = {str(r["kunjungan_fkrtl_id"]): r for r in kunci.to_dict("records")}
        df = df[df["kunjungan_fkrtl_id"].astype(str).isin(lab)]
    else:
        lab = {}
        df = df[df["peserta_id"].astype(str).isin(no_ke_pid)]
    # arrival order: the submission sequence when the export has one (a resubmitted duplicate comes after its original)
    df = df.sort_values([c for c in ("urut",) if c in df.columns] or ["tgl_datang", "kunjungan_fkrtl_id"], kind="stable")
    cache: dict[str, dict] = {}
    dipakai: dict[tuple, str] = {}
    out = []
    fh = open(keluar, "a", encoding="utf-8") if keluar else None
    try:
        for row in df.to_dict("records"):
            row = {k: (None if (isinstance(v, float) and v != v) else v) for k, v in row.items()}
            if row.get("_jk") and "peserta" not in row:
                row["peserta"] = {"jk": row.get("_jk"), "umur": row.get("_usia")}
            k = klaim_umum(row)
            k["kelas_rawat"] = row.get("kelas_rawat")
            k["status_pulang"] = row.get("status_pulang")
            k["topup"] = {c: {"rp": int(row.get(f"{c}_tarif_rp") or 0), "kode": row.get(f"{c}_kode"), "deskripsi": row.get(f"{c}_deskripsi")}
                          for c in R.TOPUP if int(row.get(f"{c}_tarif_rp") or 0) > 0}
            peserta = registri.get(str(row.get("peserta_id"))) or ({"jk": row.get("_jk"), "umur": row.get("_usia")} if row.get("_jk") else None)
            if peserta and not peserta.get("jk"):
                peserta = None
            pid = no_ke_pid.get(str(row.get("peserta_id")))
            if pid and pid not in cache:
                b = {"resourceType": "Bundle", "type": "collection",
                     "entry": [{"resource": x} for x in [pasien[pid], *by_pid.get(pid, []), *obat]]}
                cache[pid] = R.baca(b, (peserta or {}).get("jk"))
            if pid:
                rme = cache[pid]
            else:  # a connected hospital (the folder is its export) with nothing for this patient: no encounter on record
                rme = {**R.baca({"resourceType": "Bundle", "entry": []}), "ok": True, "masalah": []}
            if rme.get("ok") is False and not rme.get("kunjungan"):
                rme = {**rme, "ok": True, "masalah": []}
            fas = str(row.get("faskes_profil") or "")
            h = R.periksa(k, rme, fas, peserta, lambda kc, _p=pid, _f=fas, _id=k["id"]: (_p, _f, kc) in dipakai and dipakai[(_p, _f, kc)] != _id)
            kj = h.get("kunjungan") or {}
            if kj.get("kunci"):
                ek = (pid, fas, kj["kunci"])
                if ek in dipakai and dipakai[ek] != k["id"]:
                    R.dipakai_ulang(h, fas, dipakai[ek])
                else:
                    dipakai.setdefault(ek, k["id"])
            sc, kep, temuan = skor(h["sinyal"], None, ambang)
            lb = lab.get(k["id"])
            label = None
            if lb is not None:
                label = {"fraud": lb.get("skema") != "normal", "skenario": lb.get("skema"), "ketidaksesuaian": lb.get("ketidaksesuaian") or "",
                         "noise": lb.get("noise") or ""}
            res = {"id": k["id"], "replika": rep["n"], "keputusan": kep, "skor": sc, "temuan": temuan, "label": label}
            out.append(res)
            if fh:
                fh.write(json.dumps({**res, "hasil": h["hasil"]}, ensure_ascii=False, default=str) + "\n")
    finally:
        if fh:
            fh.close()
    return {"replika": rep["n"], "hasil": out}


def ringkas_bulk(hasil: list[dict]) -> dict:
    """The report of a labelled bulk set: per scheme, per planted mismatch (caught, and caught by the expected finding), the
    false alerts on normal claims by their documentation noise."""
    base = ringkas(hasil)
    per_k: dict[str, Counter] = {}
    noise: dict[str, Counter] = {}
    kecuali = Counter()
    for h in hasil:
        lab = h.get("label") or {}
        if not lab:
            continue
        alert = h["keputusan"] != "LOLOS"
        kode = {t["kode"] for t in h["temuan"] if t["kontribusi"] > 0}
        ks = [x for x in str(lab.get("ketidaksesuaian") or "").split("|") if x]
        if lab.get("fraud"):
            if set(ks) <= TANPA_JEJAK_RM:
                kecuali["n"] += 1
                kecuali["ditandai"] += alert
            for x in ks:
                c = per_k.setdefault(x, Counter())
                c["n"] += 1
                c["ditandai"] += alert
                c["tepat"] += bool(kode & HARAPAN.get(x, set()))
        else:
            for x in [y for y in str(lab.get("noise") or "").split("|") if y] or ["tanpa_noise"]:
                c = noise.setdefault(x, Counter())
                c["n"] += 1
                c["ditandai"] += alert
    fr = [h for h in hasil if (h.get("label") or {}).get("fraud") and not set(x for x in str(h["label"].get("ketidaksesuaian") or "").split("|") if x) <= TANPA_JEJAK_RM]
    base["fraud_terlihat_di_rm"] = {"n": len(fr), "ditandai": sum(h["keputusan"] != "LOLOS" for h in fr),
                                    "recall": round(sum(h["keputusan"] != "LOLOS" for h in fr) / len(fr), 4) if fr else None}
    base["fraud_tak_terlihat_di_rm"] = {"n": kecuali["n"], "ditandai": kecuali["ditandai"]}
    base["per_ketidaksesuaian"] = {k: {"n": v["n"], "ditandai": v["ditandai"], "temuan_tepat": v["tepat"],
                                       "diharapkan": sorted(HARAPAN.get(k, set())) or ["(tidak ada aturan untuk ini)"]}
                                   for k, v in sorted(per_k.items(), key=lambda x: -x[1]["n"])}
    base["normal_per_noise"] = {k: {"n": v["n"], "ditandai": v["ditandai"], "porsi": round(v["ditandai"] / v["n"], 4) if v["n"] else None}
                                for k, v in sorted(noise.items())}
    return base


def jalankan_bulk(folder: str | Path, keluar: Optional[str | Path] = None, ambang: tuple[float, float] = AMBANG, proses: int = 0,
                  replika: Optional[list[str]] = None) -> dict:
    reps = [r for r in folder_bulk(folder) if not replika or r["n"] in replika]
    if not reps:
        raise ValueError(f"{folder}: tidak ada pasangan klaim/ + rekam_medis/ (FHIR NDJSON) yang bisa dibaca")
    if keluar:
        Path(keluar).write_text("", "utf-8")
    hasil: list[dict] = []
    per_rep = []
    if proses and proses > 1:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=proses) as ex:
            for r in ex.map(nilai_replika, [(x, ambang, None) for x in reps]):
                hasil += r["hasil"]
                per_rep.append({"replika": r["replika"], "klaim": len(r["hasil"])})
        if keluar:
            with open(keluar, "w", encoding="utf-8") as fh:
                for h in hasil:
                    fh.write(json.dumps(h, ensure_ascii=False, default=str) + "\n")
    else:
        for x in reps:
            r = nilai_replika((x, ambang, keluar))
            hasil += r["hasil"]
            per_rep.append({"replika": r["replika"], "klaim": len(r["hasil"])})
    rep = ringkas_bulk(hasil)
    rep.update(replika=[r["n"] for r in reps], ambang={"periksa": ambang[0], "tahan": ambang[1]}, versi_aturan=R.VERSI,
               bobot={k: MO.SIGNALS[k][2] for k in MO.RME_SIGNALS})
    return rep


if __name__ == "__main__":  # pragma: no cover - testing/uji_rme.py is the entry
    print(json.dumps(jalankan(os.sys.argv[1]), ensure_ascii=False, indent=1, default=str))
