"""Data Sampel BPJS Kesehatan Edisi 2025 — the silver column specification, shared by the platform transforms
(myproject.datasets) and the local runner (api/bpjs_sampel/silver.py). No platform imports here."""

import re

import pandas as pd

# (source column, silver name, kind). kind: id (number), key (text id), date, int, float, money, label (→ _kode + text),
# text, flag (0/1 → boolean), icd3 (3-digit code; the name comes from the ICD-10 reference)
PESERTA = [("PSTV01", "peserta_id", "id"), ("PSTV02", "keluarga_id", "id")]
SPEC: dict[str, list[tuple[str, str, str]]] = {
    "kepesertaan": PESERTA + [
        ("PSTV01_A", "peserta_ibu_id", "id"), ("PSTV03", "tgl_lahir", "date"), ("PSTV04", "hubungan_keluarga", "label"),
        ("PSTV05", "jenis_kelamin", "label"), ("PSTV06", "status_kawin", "label"), ("PSTV07", "kelas_rawat", "label"),
        ("PSTV08", "segmen", "label"), ("PSTV09", "provinsi_tinggal", "label"), ("PSTV09_NEW", "provinsi_tinggal_38", "label"),
        ("PSTV10", "kabkota_tinggal", "label"), ("PSTV11", "kepemilikan_fktp_terdaftar", "label"), ("PSTV12", "jenis_fktp_terdaftar", "label"),
        ("PSTV13", "provinsi_fktp_terdaftar", "label"), ("PSTV13_NEW", "provinsi_fktp_terdaftar_38", "label"),
        ("PSTV14", "kabkota_fktp_terdaftar", "label"), ("PSTV15", "bobot", "float"), ("PSTV16", "tahun_sampel", "int"),
        ("PSTV17", "status_kepesertaan", "label"), ("PSTV18", "tahun_meninggal", "int"), ("PSTV21", "status_vaksin", "label"),
        ("PSTV22", "status_komorbid", "label")],
    "fktpkapitasi": PESERTA + [
        ("PSTV01_A", "peserta_ibu_id", "id"), ("PSTV15", "bobot", "float"), ("FKP02", "kunjungan_fktp_id", "key"),
        ("FKP03", "tgl_datang", "date"), ("FKP04", "tgl_pulang", "date"), ("FKP05", "provinsi_fktp", "label"),
        ("FKP05_NEW", "provinsi_fktp_38", "label"), ("FKP06", "kabkota_fktp", "label"), ("FKP07", "kepemilikan_fktp", "label"),
        ("FKP08", "jenis_fktp", "label"), ("FKP09", "tipe_fktp", "label"), ("FKP10", "tingkat_pelayanan", "label"),
        ("FKP11", "poli", "label"), ("FKP12", "segmen", "label"), ("FKP13", "status_pulang", "label"), ("FKP14A", "dx_icd3", "icd3"),
        ("FKP15A", "dx_nama_rinci", "text"), ("FKP16", "provinsi_rujukan", "label"), ("FKP16_NEW", "provinsi_rujukan_38", "label"),
        ("FKP17", "kabkota_rujukan", "label"), ("FKP18", "kepemilikan_rujukan", "label"), ("FKP19", "jenis_faskes_rujukan", "label"),
        ("FKP20", "tipe_faskes_rujukan", "label"), ("FKP21", "poli_rujukan", "label"), ("FKP22", "jenis_kunjungan", "label"),
        ("FKP23", "layanan_covid", "flag")],
    "fkrtl": PESERTA + [
        ("PSTV01_A", "peserta_ibu_id", "id"), ("PSTV15", "bobot", "float"), ("FKL02", "kunjungan_fkrtl_id", "key"),
        ("FKP02", "rujukan_fktp_id", "key"), ("FKL03", "tgl_datang", "date"), ("FKL04", "tgl_pulang", "date"),
        ("FKL05", "provinsi_fkrtl", "label"), ("FKL05_NEW", "provinsi_fkrtl_38", "label"), ("FKL06", "kabkota_fkrtl", "label"),
        ("FKL07", "kepemilikan_fkrtl", "label"), ("FKL08", "jenis_fkrtl", "label"), ("FKL09", "tipe_fkrtl", "label"),
        ("FKL10", "tingkat_pelayanan", "label"), ("FKL11", "poli", "label"), ("FKL12", "segmen", "label"), ("FKL13", "kelas_rawat", "label"),
        ("FKL14", "status_pulang", "label"), ("FKL15A", "dx_masuk_icd3", "icd3"), ("FKL16", "dx_masuk_kode", "key"),
        ("FKL16A", "dx_masuk_nama", "text"), ("FKL17A", "dx_primer_icd3", "icd3"), ("FKL18", "dx_primer_kode", "key"),
        ("FKL18A", "dx_primer_nama", "text"), ("FKL19", "inacbg_kode", "key"), ("FKL19A", "inacbg_deskripsi", "text"),
        ("FKL20", "inacbg_cmg", "label"), ("FKL21", "inacbg_tipe_kasus", "label"), ("FKL22", "inacbg_spesifikasi", "int"),
        ("FKL23", "inacbg_keparahan", "label"), ("FKL25", "provinsi_perujuk", "label"), ("FKL25_NEW", "provinsi_perujuk_38", "label"),
        ("FKL26", "kabkota_perujuk", "label"), ("FKL27", "kepemilikan_perujuk", "label"), ("FKL28", "jenis_perujuk", "label"),
        ("FKL29", "tipe_perujuk", "label"), ("FKL30", "prosedur", "text"), ("FKL31", "regional_tarif", "label"),
        ("FKL32", "tarif_inacbg_rp", "money"), ("FKL33", "sa_kode", "key"), ("FKL34", "sa_tarif_rp", "money"),
        ("FKL35", "sp_kode", "key"), ("FKL36", "sp_deskripsi", "text"), ("FKL37", "sp_tarif_rp", "money"),
        ("FKL38", "rr_kode", "key"), ("FKL39", "rr_deskripsi", "text"), ("FKL40", "rr_tarif_rp", "money"),
        ("FKL41", "si_kode", "key"), ("FKL42", "si_deskripsi", "text"), ("FKL43", "si_tarif_rp", "money"),
        ("FKL44", "sd_kode", "key"), ("FKL45", "sd_deskripsi", "text"), ("FKL46", "sd_tarif_rp", "money"),
        ("FKL47", "biaya_tagih_rp", "money"), ("FKL48", "biaya_verifikasi_rp", "money"), ("FKL49", "layanan_covid", "flag")],
    "nonkapitasi": PESERTA + [
        ("PSTV15", "bobot", "float"), ("PNK02", "kunjungan_id", "key"), ("PNK03", "tgl_kunjungan", "date"),
        ("PNK04", "tgl_tindakan", "date"), ("PNK05", "tgl_pulang", "date"), ("PNK06", "provinsi_faskes", "label"),
        ("PNK06_NEW", "provinsi_faskes_38", "label"), ("PNK07", "kabkota_faskes", "label"), ("PNK08", "kepemilikan_faskes", "label"),
        ("PNK09", "jenis_faskes", "label"), ("PNK10", "tipe_faskes", "label"), ("PNK11", "tingkat_layanan", "label"),
        ("PNK12", "segmen", "label"), ("PNK13A", "dx_icd3", "icd3"), ("PNK14", "dx_kode", "key"), ("PNK15", "dx_nama", "text"),
        ("PNK16", "tindakan", "text"), ("PNK17", "biaya_tagih_rp", "money"), ("PNK18", "biaya_verifikasi_rp", "money"),
        ("PNK19", "gdp_1", "float"), ("PNK20", "gdp_2", "float"), ("PNK21", "layanan_covid", "flag")],
    "diagnosissekunder": [("FKL02", "kunjungan_fkrtl_id", "key"), ("FKL24", "dx_kode", "key"), ("FKL24A", "dx_icd3", "icd3"),
                          ("FKL49", "layanan_covid", "flag")],
}
SILVER_NAME = {"kepesertaan": "peserta", "fktpkapitasi": "kunjungan_fktp", "fkrtl": "kunjungan_fkrtl",
               "nonkapitasi": "tindakan_nonkapitasi", "diagnosissekunder": "diagnosis_sekunder"}

# Source defect (found 2026-10-20): in some long-text columns the letters "go" were deleted from every word ("goitre" →
# "itre"). Only these reviewed words are restored; the original text stays in bronze and the row is flagged.
GO_REPAIR = {
    "narthrosis": "gonarthrosis", "itre": "goitre", "vitili": "vitiligo", "pruri": "prurigo", "impeti": "impetigo",
    "laryntracheitis": "laryngotracheitis", "pemphiid": "pemphigoid", "nococcal": "gonococcal", "sphinlipid": "sphingolipid",
    "menincoccal": "meningococcal", "menincoccaemia": "meningococcaemia", "antanists": "antagonists",
    "otorhinolarynlogical": "otorhinolaryngological", "laryncele": "laryngocele", "enrgement": "engorgement",
    "funides": "fungoides", "zymycoses": "zygomycoses",
}
REPAIR_COLS = {"FKL16A", "FKL18A"}


def repair_sql(expr: str) -> str:
    for bad, good in GO_REPAIR.items():
        for b, g in ((bad, good), (bad.capitalize(), good.capitalize())):
            expr = f"regexp_replace({expr}, '\\b{b}\\b', '{g}', 'g')"
    return expr


def select_sql(tabel: str, cols: set[str]) -> tuple[str, str]:
    """The SELECT list and the label joins of one fact table."""
    sel, joins = ["t.edisi"], []
    for src, name, kind in SPEC[tabel]:
        if src not in cols:
            sel.append(f"NULL AS {name}" if kind != "label" else f"NULL::INTEGER AS {name}_kode, NULL::VARCHAR AS {name}")
            continue
        c = f"t.{src}"
        if kind == "id":
            sel.append(f"TRY_CAST({c} AS BIGINT) AS {name}")
        elif kind == "key":
            sel.append(f"NULLIF(NULLIF(trim({c}::VARCHAR), ''), 'NONE') AS {name}")
        elif kind == "date":
            sel.append(f"CAST({c} AS DATE) AS {name}")
        elif kind in ("int", "money"):
            sel.append(f"TRY_CAST({c} AS BIGINT) AS {name}")
        elif kind == "float":
            sel.append(f"TRY_CAST({c} AS DOUBLE) AS {name}")
        elif kind == "flag":
            sel.append(f"CASE WHEN {c} IS NULL THEN NULL ELSE {c} = 1 END AS {name}")
        elif kind == "icd3":
            # the ICD-10 category: the first three characters when they are one (FKL24A holds "code-name" in the dm and
            # KIA editions; the placeholder 9999 has none)
            first = f"left(upper(trim({c}::VARCHAR)), 3)"
            sel.append(f"CASE WHEN regexp_full_match({first}, '[A-Z][0-9][0-9A-Z]') THEN {first} END AS {name}")
        elif kind == "text":
            txt = f"NULLIF(NULLIF(trim({c}::VARCHAR), ''), 'NONE')"
            if src in REPAIR_COLS:
                fixed = f"{repair_sql(txt)}"
                # a restored word at the start ("narthrosis …" → "gonarthrosis …") takes the capital the source text had
                sel.append(f"CASE WHEN ({fixed}) IS DISTINCT FROM {txt} THEN upper(left({fixed}, 1)) || substr({fixed}, 2) ELSE {txt} END AS {name}")
                sel.append(f"({repair_sql(txt)}) IS DISTINCT FROM {txt} AS flag_{name}_diperbaiki")
            else:
                sel.append(f"{txt} AS {name}")
        elif kind == "label":
            a = f"l_{src.lower()}"
            joins.append(f"LEFT JOIN lab {a} ON {a}.edisi = t.edisi AND {a}.tabel = '{tabel}' AND {a}.kolom = '{src}' AND {a}.kode = {c}")
            sel.append(f"TRY_CAST({c} AS INTEGER) AS {name}_kode")
            # code 9 "MISSING" is the source's way of saying unknown: the code stays, the text is NULL
            sel.append(f"CASE WHEN upper(trim({a}.label)) IN ('MISSING', 'TIDAK TERDEFINISI') THEN NULL ELSE {a}.label END AS {name}")
    return ",\n  ".join(sel), "\n".join(joins)




def icd10_reference(workbooks) -> pd.DataFrame:
    """The ICD-10 code books (xlsx: ICD10_Code, ICD10_Text) → one clean name per 3-digit code (the most frequent across
    the editions' 2022/2023/2024 books). `workbooks`: (name, file object or path) pairs."""
    rows = []
    for name, f in workbooks:
        for df in pd.read_excel(f, sheet_name=None).values():
            for code, text in zip(df["ICD10_Code"].astype(str), df["ICD10_Text"].astype(str)):
                code = code.strip().upper()
                rows.append({"icd3": code, "nama": re.sub(rf"^{re.escape(code)}\s+", "", text.strip()), "sumber": name})
    ref = pd.DataFrame(rows)
    best = ref.groupby(["icd3", "nama"]).size().reset_index(name="n").sort_values(["icd3", "n"], ascending=[True, False])
    out = best.drop_duplicates("icd3")[["icd3", "nama"]].copy()
    out["bab"] = out["icd3"].str[0]
    return out.reset_index(drop=True)
