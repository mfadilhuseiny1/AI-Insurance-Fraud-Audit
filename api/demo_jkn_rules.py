"""The detection rules of the JKN audit demo (demo_jkn.py), as the files of a Python transforms repository.

One transform per risk category of BPJS Kesehatan's "Efisiensi Risiko pada Fasilitas Kesehatan" list writes the
findings ("temuan") of that category: kategori_no, kategori, referensi (the SEP / claim / document), faskes,
nilai_risiko (Rp, an estimate of the amount at risk), alasan (why it was flagged). A last transform unions them
into temuan_semua. Every rule is a screening heuristic over the claim, service and finance records: a finding is a
case for a verifier (medical record review), not a conclusion.
"""

from __future__ import annotations

COMMON = r'''"""Shared helpers of the JKN audit rules."""

import pandas as pd

ROOT = "{root}"
DATA = ROOT + "/data"
OUT = ROOT + "/temuan"
COLUMNS = ["kategori_no", "kategori", "referensi", "faskes", "nilai_risiko", "alasan"]


def path(name):
    return DATA + "/" + name


def findings(no, kategori, rows):
    df = pd.DataFrame(rows, columns=["referensi", "faskes", "nilai_risiko", "alasan"])
    df.insert(0, "kategori", kategori)
    df.insert(0, "kategori_no", no)
    df["nilai_risiko"] = df["nilai_risiko"].astype(float)
    return df[COLUMNS]


def los(df):
    return (pd.to_datetime(df["tgl_pulang"]) - pd.to_datetime(df["tgl_masuk"])).dt.days
'''

RULES = r'''"""Detection rules: one transform per risk category (Efisiensi Risiko pada Fasilitas Kesehatan, Program JKN)."""

import pandas as pd
from transforms.api import Input, Output, transform_pandas

from jkn_audit.common import OUT, findings, los, path

# Diagnoses FKTP must treat themselves (a sample of the 144 non-specialist diagnoses)
NON_SPESIALISTIK = {"A09", "J00", "J06.9", "K29.7", "I10", "E11.9", "M79.1", "L30.9", "K30", "R51"}
# capitation spending that may be charged to the capitation fund
BELANJA_BOLEH = {"jasa pelayanan", "obat", "alkes", "bahan medis habis pakai", "operasional pelayanan"}
# indications for a caesarean section (ICD-10 O-codes, by prefix)
INDIKASI_SC = ("O32", "O33", "O34", "O36", "O41", "O42", "O60", "O63", "O64", "O65", "O68", "O69", "O82")
# secondary diagnoses and the lab result that must support them
PENUNJANG = {"D64.9": ("Hb", lambda v: v < 10), "E87.6": ("Kalium", lambda v: v < 3.5), "N39.0": ("Leukosit urin", lambda v: v > 10)}


@transform_pandas(Output(OUT + "/01_kapitasi"), kapitasi=Input(path("kapitasi")), belanja=Input(path("belanja_kapitasi")))
def r01_kapitasi(kapitasi, belanja):
    """1. Penyalahgunaan dana kapitasi/nonkapitasi: jasa pelayanan below 60% of the fund, spending outside the allowed uses."""
    rows = []
    for _, k in kapitasi.iterrows():
        share = k["jasa_pelayanan"] / k["dana_diterima"]
        if share < 0.6:
            rows.append((f"{k['faskes']} {k['bulan']}", k["faskes"], k["dana_diterima"] * 0.6 - k["jasa_pelayanan"],
                         f"Jasa pelayanan {share:.0%} dari dana kapitasi (minimal 60%)"))
    for _, b in belanja.iterrows():
        if b["kategori"] not in BELANJA_BOLEH:
            rows.append((b["no_bukti"], b["faskes"], b["jumlah"], f"Belanja '{b['uraian']}' ({b['kategori']}) tidak termasuk penggunaan dana kapitasi"))
    return findings(1, "Penyalahgunaan dana kapitasi/nonkapitasi", rows)


@transform_pandas(Output(OUT + "/02_nonkapitasi"), klaim=Input(path("klaim_nonkapitasi")), peserta=Input(path("peserta")))
def r02_nonkapitasi(klaim, peserta):
    """2. Manipulasi klaim nonkapitasi: deliveries claimed for men, or twice for one woman within 270 days."""
    df = klaim.merge(peserta[["no_kartu", "jk"]], on="no_kartu", how="left")
    rows = []
    persalinan = df[df["jenis_layanan"] == "persalinan"].sort_values("tgl")
    for _, r in persalinan[persalinan["jk"] == "L"].iterrows():
        rows.append((r["no_klaim"], r["faskes"], r["tarif"], "Klaim persalinan untuk peserta laki-laki"))
    for kartu, g in persalinan[persalinan["jk"] == "P"].groupby("no_kartu"):
        d = pd.to_datetime(g["tgl"])
        for (_, r), gap in zip(g.iloc[1:].iterrows(), (d.diff().dt.days.iloc[1:])):
            if gap < 270:
                rows.append((r["no_klaim"], r["faskes"], r["tarif"], f"Persalinan kedua {int(gap)} hari setelah persalinan sebelumnya"))
    return findings(2, "Manipulasi klaim nonkapitasi", rows)


@transform_pandas(Output(OUT + "/03_rujukan"), rujukan=Input(path("rujukan")))
def r03_rujukan(rujukan):
    """3. Rujukan tidak sesuai: a non-specialist diagnosis referred without a facility or special-condition reason."""
    rows = [(r["no_rujukan"], r["dari_faskes"], 0, f"Diagnosis {r['diagnosa']} termasuk 144 diagnosis FKTP; alasan rujuk: {r['alasan_rujuk']}")
            for _, r in rujukan.iterrows() if r["diagnosa"] in NON_SPESIALISTIK and r["alasan_rujuk"] not in ("keterbatasan sarana", "kondisi khusus")]
    return findings(3, "Rujukan tidak sesuai", rows)


@transform_pandas(Output(OUT + "/04_upcoding"), sep=Input(path("kunjungan")), lab=Input(path("hasil_lab")), tarif=Input(path("tarif_inacbg")))
def r04_upcoding(sep, lab, tarif):
    """4. Upcoding: a secondary diagnosis raising the severity level that the lab results do not support."""
    rows = []
    base = {t["kode_dasar"]: t for _, t in tarif.iterrows()}
    for _, s in sep[sep["jenis"] == "RI"].iterrows():
        sekunder = [d for d in str(s["diag_sekunder"] or "").split(",") if d]
        for d in sekunder:
            if d not in PENUNJANG:
                continue
            test, ok = PENUNJANG[d]
            vals = lab[(lab["no_sep"] == s["no_sep"]) & (lab["pemeriksaan"] == test)]["nilai"]
            if not len(vals) or not any(ok(v) for v in vals):
                t = base.get(s["kode_dasar"])
                lower = float(t["tarif_i"]) if t is not None else s["tarif_inacbg"]
                rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"] - lower,
                             f"Diagnosis sekunder {d} (severity {s['severity']}) tanpa hasil {test} yang mendukung" + ("" if len(vals) else " (tidak diperiksa)")))
    return findings(4, "Manipulasi diagnosis dan/atau tindakan (upcoding)", rows)


@transform_pandas(Output(OUT + "/05_cloning"), sep=Input(path("kunjungan")))
def r05_cloning(sep):
    """5. Cloning: the same discharge summary text for different patients."""
    df = sep.copy()
    df["_resume"] = df["resume"].str.lower().str.replace(r"\s+", " ", regex=True).str.strip()
    rows = []
    for text, g in df.groupby("_resume"):
        if g["no_kartu"].nunique() > 1 and len(text) > 40:
            for _, s in g.iloc[1:].iterrows():
                rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], f"Resume medis identik dengan {g.iloc[0]['no_sep']} (pasien lain, dokter {s['dokter']})"))
    return findings(5, "Cloning (penjiplakan klaim)", rows)


@transform_pandas(Output(OUT + "/06_phantom"), sep=Input(path("kunjungan")), hadir=Input(path("kehadiran")), peserta=Input(path("peserta")))
def r06_phantom(sep, hadir, peserta):
    """6. Phantom billing: no attendance / vital-sign record for the visit, or a visit after the patient's death."""
    seen = set(hadir["no_sep"])
    died = dict(zip(peserta["no_kartu"], peserta["tgl_meninggal"]))
    rows = []
    for _, s in sep.iterrows():
        dead = died.get(s["no_kartu"])
        if dead is not None and not pd.isna(dead) and pd.Timestamp(s["tgl_masuk"]) > pd.Timestamp(dead):
            rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], f"Pelayanan tanggal {s['tgl_masuk']} setelah peserta meninggal ({dead})"))
        elif s["no_sep"] not in seen:
            rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], "Tidak ada catatan kehadiran / tanda vital untuk kunjungan ini"))
    return findings(6, "Phantom billing (klaim palsu)", rows)


def _inflated(resep, harga, jenis):
    df = resep[resep["jenis_item"] == jenis].merge(harga, on="item", how="left")
    rows = []
    for _, r in df.iterrows():
        unit = r["harga_tagih"] / r["qty_resep"]
        if pd.notna(r["harga_e_katalog"]) and unit > r["harga_e_katalog"] * 1.0001:
            rows.append((r["no_resep"], r["faskes"], (unit - r["harga_e_katalog"]) * r["qty_resep"],
                         f"{r['item']}: Rp{unit:,.0f}/unit ditagihkan, harga e-katalog Rp{r['harga_e_katalog']:,.0f}"))
    return rows


@transform_pandas(Output(OUT + "/07_inflated_obat"), resep=Input(path("resep")), harga=Input(path("harga_e_katalog")))
def r07_inflated_obat(resep, harga):
    """7. Inflated bills (obat): drugs billed above their e-catalogue price."""
    return findings(7, "Inflated bills (penggelembungan tagihan obat)", _inflated(resep, harga, "obat"))


@transform_pandas(Output(OUT + "/08_pemecahan_episode"), sep=Input(path("kunjungan")))
def r08_pemecahan(sep):
    """8. Pemecahan episode: several outpatient SEPs for one patient on one day at one facility."""
    rj = sep[sep["jenis"] == "RJ"]
    rows = []
    for (kartu, tgl, faskes), g in rj.groupby(["no_kartu", "tgl_masuk", "faskes"]):
        if len(g) > 1:
            for _, s in g.sort_values("no_sep").iloc[1:].iterrows():
                rows.append((s["no_sep"], faskes, s["tarif_inacbg"], f"{len(g)} SEP rawat jalan pada {tgl} (poli {', '.join(g['poli'])})"))
    return findings(8, "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)", rows)


@transform_pandas(Output(OUT + "/09_unbundling"), sep=Input(path("kunjungan")))
def r09_unbundling(sep):
    """9. Unbundling: an outpatient claim during the same patient's inpatient stay (part of the inpatient package)."""
    ri, rj = sep[sep["jenis"] == "RI"], sep[sep["jenis"] == "RJ"]
    rows = []
    for _, s in rj.iterrows():
        stay = ri[(ri["no_kartu"] == s["no_kartu"]) & (ri["faskes"] == s["faskes"]) & (ri["tgl_masuk"] <= s["tgl_masuk"]) & (ri["tgl_pulang"] >= s["tgl_masuk"])]
        if len(stay):
            rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], f"Klaim rawat jalan selama rawat inap {stay.iloc[0]['no_sep']} (seharusnya satu paket)"))
    return findings(9, "Services unbundling / fragmentation", rows)


@transform_pandas(Output(OUT + "/10_self_referral"), rujukan=Input(path("rujukan")), dokter=Input(path("dokter")))
def r10_self_referral(rujukan, dokter):
    """10. Self-referral: a referral to the referring doctor's own practice."""
    own = dict(zip(dokter["id_dokter"], dokter["praktik_pribadi"]))
    rows = [(r["no_rujukan"], r["dari_faskes"], 0, f"Dirujuk ke {r['ke_faskes']}, tempat praktik pribadi dokter perujuk {r['dokter_perujuk']}")
            for _, r in rujukan.iterrows() if own.get(r["dokter_perujuk"]) and own.get(r["dokter_perujuk"]) == r["ke_faskes"]]
    return findings(10, "Self-referral (rujukan semu)", rows)


@transform_pandas(Output(OUT + "/11_repeat_billing"), sep=Input(path("kunjungan")))
def r11_repeat(sep):
    """11. Repeat billing: the same patient, admission date, INA-CBG code, facility and clinic claimed under two SEPs
    (visits to different clinics on one day are rule 8)."""
    rows = []
    df = sep.assign(_poli=sep["poli"].fillna(""))
    for _, g in df.groupby(["no_kartu", "tgl_masuk", "kode_inacbg", "faskes", "_poli"]):
        if len(g) > 1:
            first = g.sort_values("no_sep").iloc[0]
            for _, s in g.sort_values("no_sep").iloc[1:].iterrows():
                rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], f"Sama dengan {first['no_sep']} (peserta, tanggal, kode {s['kode_inacbg']})"))
    return findings(11, "Repeat billing (klaim berulang)", rows)


@transform_pandas(Output(OUT + "/12_prolonged_los"), sep=Input(path("kunjungan")))
def r12_los(sep):
    """12. Prolonged length of stay: more than twice (and at least 3 days over) the median stay of the INA-CBG group."""
    ri = sep[sep["jenis"] == "RI"].copy()
    ri["los"] = los(ri)
    med = ri.groupby("kode_dasar")["los"].median()
    rows = []
    for _, s in ri.iterrows():
        m = med.get(s["kode_dasar"])
        if m is not None and s["los"] > 2 * m and s["los"] >= m + 3:
            rows.append((s["no_sep"], s["faskes"], s["tarif_rs"] * (s["los"] - m) / max(s["los"], 1), f"Lama rawat {s['los']} hari, median kelompok {s['kode_dasar']} {m:g} hari"))
    return findings(12, "Prolonged length of stay", rows)


@transform_pandas(Output(OUT + "/13_kelas_rawat"), sep=Input(path("kunjungan")), bed=Input(path("log_kamar")), peserta=Input(path("peserta")))
def r13_kelas(sep, bed, peserta):
    """13. Room charge: the class claimed is higher than the bed actually occupied (or the member's entitlement)."""
    actual = bed.groupby("no_sep")["kelas_aktual"].max()
    hak = dict(zip(peserta["no_kartu"], peserta["hak_kelas"]))
    rows = []
    for _, s in sep[sep["jenis"] == "RI"].iterrows():
        a = actual.get(s["no_sep"])
        # class 1 is the highest: a smaller number is a better class
        if a is not None and s["kelas_rawat"] < a:
            rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"] * 0.1 * (a - s["kelas_rawat"]), f"Diklaim kelas {s['kelas_rawat']}, log kamar kelas {a}"))
        elif s["kelas_rawat"] < hak.get(s["no_kartu"], s["kelas_rawat"]) and not s["naik_kelas"]:
            rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"] * 0.1, f"Kelas {s['kelas_rawat']} melebihi hak kelas {hak[s['no_kartu']]} tanpa naik kelas"))
    return findings(13, "Manipulasi kelas perawatan (room charge)", rows)


@transform_pandas(Output(OUT + "/14_tindakan_tidak_dilakukan"), sep=Input(path("kunjungan")), log=Input(path("log_tindakan")), tarif=Input(path("tarif_prosedur")))
def r14_tindakan(sep, log, tarif):
    """14. Procedures claimed that no procedure / operating-room log records."""
    done = set(zip(log["no_sep"], log["kode_prosedur"]))
    price = dict(zip(tarif["kode_prosedur"], tarif["tarif"]))
    rows = []
    for _, s in sep.iterrows():
        for p in [p for p in str(s["prosedur"] or "").split(",") if p]:
            if (s["no_sep"], p) not in done:
                rows.append((s["no_sep"], s["faskes"], price.get(p, 0), f"Prosedur {p} diklaim tanpa catatan di log tindakan / kamar operasi"))
    return findings(14, "Menagihkan tindakan yang tidak dilakukan", rows)


@transform_pandas(Output(OUT + "/15_tidak_sesuai_indikasi"), sep=Input(path("kunjungan")), lab=Input(path("hasil_lab")), tarif=Input(path("tarif_prosedur")))
def r15_indikasi(sep, lab, tarif):
    """15. Treatment without a medical indication: caesarean without an indication code, transfusion with Hb >= 8."""
    price = dict(zip(tarif["kode_prosedur"], tarif["tarif"]))
    rows = []
    for _, s in sep.iterrows():
        procs = [p for p in str(s["prosedur"] or "").split(",") if p]
        diags = [s["diag_utama"], *[d for d in str(s["diag_sekunder"] or "").split(",") if d]]
        if "74.1" in procs and not any(d.startswith(INDIKASI_SC) for d in diags):
            rows.append((s["no_sep"], s["faskes"], price.get("74.1", 0), f"Sectio caesarea tanpa diagnosis indikasi (diagnosis: {', '.join(diags)})"))
        if "99.04" in procs:
            hb = lab[(lab["no_sep"] == s["no_sep"]) & (lab["pemeriksaan"] == "Hb")]["nilai"]
            if len(hb) and hb.min() >= 8:
                rows.append((s["no_sep"], s["faskes"], price.get("99.04", 0), f"Transfusi dengan Hb terendah {hb.min():g} g/dL"))
    return findings(15, "Tindakan pengobatan tidak sesuai indikasi medis", rows)


@transform_pandas(Output(OUT + "/16_readmisi"), sep=Input(path("kunjungan")))
def r16_readmisi(sep):
    """16. Readmission: the same patient admitted again within 7 days with the same diagnosis group (one episode)."""
    ri = sep[sep["jenis"] == "RI"].sort_values("tgl_masuk")
    rows = []
    for kartu, g in ri.groupby("no_kartu"):
        g = g.reset_index(drop=True)
        for i in range(1, len(g)):
            prev, s = g.iloc[i - 1], g.iloc[i]
            gap = (pd.Timestamp(s["tgl_masuk"]) - pd.Timestamp(prev["tgl_pulang"])).days
            if 0 < gap <= 7 and s["diag_utama"][:3] == prev["diag_utama"][:3]:
                rows.append((s["no_sep"], s["faskes"], s["tarif_inacbg"], f"Dirawat lagi {gap} hari setelah {prev['no_sep']} dengan diagnosis {s['diag_utama'][:3]} yang sama"))
    return findings(16, "Readmisi (admisi berulang)", rows)


@transform_pandas(Output(OUT + "/17_klaim_fiktif_obat"), resep=Input(path("resep")), serah=Input(path("penyerahan_obat")))
def r17_fiktif(resep, serah):
    """17. Drugs / devices billed that the pharmacy never handed over."""
    given = set(zip(serah["no_resep"], serah["item"]))
    rows = [(r["no_resep"], r["faskes"], r["harga_tagih"], f"{r['item']} ditagihkan tanpa catatan penyerahan")
            for _, r in resep.iterrows() if (r["no_resep"], r["item"]) not in given]
    return findings(17, "Klaim fiktif obat/alkes/tindakan", rows)


@transform_pandas(Output(OUT + "/18_pengurangan_obat"), resep=Input(path("resep")), serah=Input(path("penyerahan_obat")))
def r18_pengurangan(resep, serah):
    """18. Fewer units handed over than prescribed and billed."""
    df = resep.merge(serah, on=["no_resep", "item"], how="inner")
    rows = [(r["no_resep"], r["faskes"], r["harga_tagih"] / r["qty_resep"] * (r["qty_resep"] - r["qty_diserahkan"]),
             f"{r['item']}: diresepkan/ditagihkan {r['qty_resep']}, diserahkan {r['qty_diserahkan']}")
            for _, r in df.iterrows() if r["qty_diserahkan"] < r["qty_resep"]]
    return findings(18, "Pengurangan jumlah obat", rows)


@transform_pandas(Output(OUT + "/19_inflated_alkes"), resep=Input(path("resep")), harga=Input(path("harga_e_katalog")))
def r19_inflated_alkes(resep, harga):
    """19. Inflated bills (alkes): medical devices billed above their e-catalogue price."""
    return findings(19, "Inflated bills (penggelembungan tagihan alkes)", _inflated(resep, harga, "alkes"))


@transform_pandas(Output(OUT + "/20_manipulasi_hasil"), lab=Input(path("hasil_lab")), sep=Input(path("kunjungan")))
def r20_hasil(lab, sep):
    """20. Lab results edited after discharge to cross a billing threshold."""
    pulang = dict(zip(sep["no_sep"], sep["tgl_pulang"]))
    faskes = dict(zip(sep["no_sep"], sep["faskes"]))
    tarif = dict(zip(sep["no_sep"], sep["tarif_inacbg"]))
    rows = []
    for _, r in lab[lab["nilai_awal"].notna() & (lab["nilai_awal"] != lab["nilai"])].iterrows():
        after = pd.Timestamp(r["diubah_at"]).date() > pd.Timestamp(pulang.get(r["no_sep"])).date()
        rows.append((r["no_sep"], faskes.get(r["no_sep"], ""), tarif.get(r["no_sep"], 0) * (0.3 if after else 0.1),
                     f"{r['pemeriksaan']} diubah dari {r['nilai_awal']:g} menjadi {r['nilai']:g} oleh {r['diubah_oleh']}"
                     + (" setelah pasien pulang" if after else "")))
    return findings(20, "Manipulasi hasil pemeriksaan", rows)


_ALL = [f"{OUT}/{name}" for name in (
    "01_kapitasi", "02_nonkapitasi", "03_rujukan", "04_upcoding", "05_cloning", "06_phantom", "07_inflated_obat", "08_pemecahan_episode",
    "09_unbundling", "10_self_referral", "11_repeat_billing", "12_prolonged_los", "13_kelas_rawat", "14_tindakan_tidak_dilakukan",
    "15_tidak_sesuai_indikasi", "16_readmisi", "17_klaim_fiktif_obat", "18_pengurangan_obat", "19_inflated_alkes", "20_manipulasi_hasil")]


@transform_pandas(Output(OUT + "/temuan_semua"), **{f"t{i:02d}": Input(p) for i, p in enumerate(_ALL, 1)})
def temuan_semua(**parts):
    """Every finding, with the category number, ordered by the amount at risk."""
    df = pd.concat([parts[k] for k in sorted(parts)], ignore_index=True)
    return df.sort_values(["kategori_no", "nilai_risiko"], ascending=[True, False]).reset_index(drop=True)
'''

PIPELINE = '''from transforms.api import Pipeline

from jkn_audit import rules

my_pipeline = Pipeline()
my_pipeline.discover_transforms(rules)
'''

SETUP = '''#!/usr/bin/env python
import os
from setuptools import find_packages, setup

setup(
    name=os.environ.get("PKG_NAME", "jkn-audit"),
    version=os.environ.get("PKG_VERSION", "0.0.0"),
    description="JKN facility risk screening rules (demo)",
    packages=find_packages(exclude=["contrib", "docs", "test"]),
    entry_points={"transforms.pipelines": ["root = jkn_audit.pipeline:my_pipeline"]},
)
'''

README = """# Deteksi Risiko JKN (demo)

Screening rules for the 20 risk categories of *Efisiensi Risiko pada Fasilitas Kesehatan* (Program JKN), over the
synthetic records of the demo project. Each rule is a transform in `transforms-python/src/jkn_audit/rules.py`
writing one findings dataset into `temuan/`; `temuan_semua` unions them. A finding is a case to verify against the
medical record, not a conclusion. The data is fictitious.
"""


def files(root: str, settings: str) -> dict[str, str]:
    base = "transforms-python"
    return {
        "README.md": README,
        "repoSettings.json": settings,
        f"{base}/build.gradle": "apply plugin: 'bluesandai.python'\napply plugin: 'bluesandai.python-defaults'\n",
        f"{base}/conda_recipe/meta.yaml": 'package:\n  name: "{{ PACKAGE_NAME }}"\n  version: "{{ PACKAGE_VERSION }}"\n\nrequirements:\n  run:\n    - python 3.12.*\n    - transforms {{ PYTHON_TRANSFORMS_VERSION }}\n    - pandas\n',
        f"{base}/src/setup.py": SETUP,
        f"{base}/src/jkn_audit/__init__.py": "",
        f"{base}/src/jkn_audit/common.py": COMMON.replace("{root}", root),
        f"{base}/src/jkn_audit/rules.py": RULES,
        f"{base}/src/jkn_audit/pipeline.py": PIPELINE,
    }
