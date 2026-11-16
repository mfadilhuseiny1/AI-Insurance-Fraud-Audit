"""The JKN audit pipeline as one spec (demo_jkn_e2e.py): Pipeline Builder content, a sqlite emulation for the first
load, and the lineage the overview page draws — all from the same node list, so they cannot drift apart.

Fourteen sources in six colour groups (plus the core and analytics groups), as BPJS systems export them:

- Faskes: the Aplicares facility register (duplicates, untidy names, lower-case codes) and the geocoded coordinates;
- Dokter: HFIS doctors and SIP practice licences (a second practice: the self-referral signal);
- Klaim bulanan: one monthly claim summary file per month (July, August, September 2026);
- Skrining klaim: claims the screening rules flagged in e-Klaim (hospitals), in P-Care (primary-care referrals, dates
  written DD/MM/YYYY) and late e-Klaim submissions (some claims sent twice);
- Keputusan audit: the audit team's ongoing decisions and the Q2 audits already closed;
- Referensi: the screening rule catalogue (20 subcategories) and ICD-10 diagnoses primary care is competent to treat.

They are cleaned (codes, names, dates, types), unioned, joined and deduplicated into the tables the three core
transforms read (faskes_audit, kasus_berisiko, dokter_audit — the datasets behind the Ontology), and five analytics
branches add detail outputs (claims with rule and ICD-10 context, monthly trends, branch office summary, the
doctor–facility network, doctor ranking).
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Optional

# colour groups of the graph (Pipeline Builder legend)
GROUPS = [
    ("faskes", "Faskes", "#2f855a"),
    ("dokter", "Dokter", "#4c78c4"),
    ("bulanan", "Klaim bulanan", "#2c9c9c"),
    ("skrining", "Skrining klaim", "#dd6b20"),
    ("keputusan", "Keputusan audit", "#805ad5"),
    ("referensi", "Referensi", "#718096"),
    ("ml", "Klaim per SEP (ML)", "#0ea5e9"),
    ("inti", "Skor & kasus (Ontologi)", "#c53030"),
    ("analitik", "Analitik", "#d53f8c"),
]
SPEC_VERSION = 4  # bump to regenerate an existing pipeline file from the spec
REFERRAL_TYPES = ("Rujukan tidak sesuai", "Penyalahgunaan dana kapitasi/nonkapitasi")

SQL_REGISTER = """-- Register Aplicares: kode seragam (huruf besar, tanpa spasi), nama dirapikan, satu baris per faskes
-- (register mengekspor sebagian faskes dua kali).
SELECT UPPER(TRIM(kode)) AS kode,
       MIN(TRIM(REPLACE(REPLACE(nama_faskes, '   ', ' '), '  ', ' '))) AS nama_faskes,
       MIN(jenis) AS jenis, MIN(kepemilikan) AS kepemilikan, MIN(wilayah) AS wilayah, MIN(kantor_cabang) AS kantor_cabang
FROM input
GROUP BY UPPER(TRIM(kode))
ORDER BY kode"""

SQL_BULANAN = """-- Ringkasan klaim bulanan (tiga file bulanan digabung): kode seragam, angka sebagai bilangan.
SELECT UPPER(TRIM(kode_faskes)) AS kode_faskes, bulan,
       CAST(jumlah_klaim AS INT) AS jumlah_klaim, CAST(nilai_klaim AS DOUBLE) AS nilai_klaim,
       CAST(jumlah_rujukan AS INT) AS jumlah_rujukan
FROM input
ORDER BY kode_faskes, bulan"""

SQL_PCARE = """-- P-Care menulis tanggal layanan sebagai DD/MM/YYYY: diseragamkan ke ISO (YYYY-MM-DD) seperti e-Klaim.
SELECT no_sep, no_rujukan,
       SUBSTR(tgl_layanan, 7, 4) || '-' || SUBSTR(tgl_layanan, 4, 2) || '-' || SUBSTR(tgl_layanan, 1, 2) AS tgl_layanan,
       faskes_asal, faskes_tujuan, dokter_perujuk, dokter_dpjp, diagnosa, CAST(nilai_klaim AS DOUBLE) AS nilai_klaim, indikasi, aturan
FROM input"""

SQL_DEDUP = """-- Klaim yang dikirim ulang lewat e-Klaim susulan muncul dua kali: satu baris per SEP (nilai klaim sebagai bilangan).
SELECT no_sep, no_rujukan, tgl_layanan, faskes_asal, faskes_tujuan, dokter_perujuk, dokter_dpjp, diagnosa,
       CAST(nilai_klaim AS DOUBLE) AS nilai_klaim, indikasi, aturan
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY no_sep ORDER BY tgl_layanan) AS urutan
  FROM input
) WHERE urutan = 1
ORDER BY no_sep"""

SQL_DETAIL = """-- Klaim berisiko lengkap: subkategori dan bobot aturan, kompetensi FKTP diagnosis (ICD-10), nama faskes dan dokter,
-- dan apakah perujuk sekaligus DPJP.
SELECT k.no_sep, k.no_rujukan, k.tgl_layanan, k.subkategori, k.aturan, k.bobot,
       SUBSTR(k.diagnosa, 1, INSTR(k.diagnosa, ' ') - 1) AS kode_icd, k.diagnosa,
       COALESCE(i.kompetensi_fktp, 'Tidak') AS kompetensi_fktp,
       k.faskes_asal, a.nama AS nama_faskes_asal, k.faskes_tujuan, t.nama AS nama_faskes_tujuan,
       k.dokter_perujuk, p.nama_dokter AS nama_dokter_perujuk, k.dokter_dpjp, d.nama_dokter AS nama_dokter_dpjp,
       CASE WHEN k.dokter_perujuk = k.dokter_dpjp THEN 'Ya' ELSE 'Tidak' END AS perujuk_sama_dpjp,
       k.nilai_klaim
FROM input k
LEFT JOIN icd10_kompetensi_fktp i ON i.kode_icd = SUBSTR(k.diagnosa, 1, INSTR(k.diagnosa, ' ') - 1)
LEFT JOIN faskes_audit a ON a.kode = k.faskes_asal
LEFT JOIN faskes_audit t ON t.kode = k.faskes_tujuan
LEFT JOIN dokter_bersih p ON p.id_dokter = k.dokter_perujuk
LEFT JOIN dokter_bersih d ON d.id_dokter = k.dokter_dpjp
ORDER BY k.no_sep"""

SQL_TREN = """-- Tren bulanan per faskes: klaim, rujukan dan klaim berisiko (menurut faskes penanggung jawab), dengan rasionya.
WITH flagged AS (
  SELECT CASE WHEN indikasi IN ('Rujukan tidak sesuai', 'Penyalahgunaan dana kapitasi/nonkapitasi')
              THEN faskes_asal ELSE faskes_tujuan END AS kode_faskes,
         SUBSTR(tgl_layanan, 1, 7) AS bulan, COUNT(*) AS klaim_berisiko, SUM(nilai_klaim) AS nilai_berisiko
  FROM klaim_berisiko
  GROUP BY 1, 2
)
SELECT b.kode_faskes, b.bulan, b.jumlah_klaim, b.nilai_klaim, b.jumlah_rujukan,
       ROUND(100.0 * b.jumlah_rujukan / b.jumlah_klaim, 1) AS rasio_rujukan_pct,
       COALESCE(f.klaim_berisiko, 0) AS klaim_berisiko, COALESCE(f.nilai_berisiko, 0.0) AS nilai_berisiko,
       ROUND(100.0 * COALESCE(f.klaim_berisiko, 0) / b.jumlah_klaim, 2) AS porsi_berisiko_pct
FROM input b
LEFT JOIN flagged f ON f.kode_faskes = b.kode_faskes AND f.bulan = b.bulan
ORDER BY b.kode_faskes, b.bulan"""

SQL_KANTOR = """-- Ringkasan per kantor cabang: faskes per status audit, rata-rata skor, potensi kerugian dan dana yang dikembalikan.
SELECT kantor_cabang, COUNT(*) AS faskes,
       SUM(CASE WHEN status_audit = 'Sehat' THEN 1 ELSE 0 END) AS sehat,
       SUM(CASE WHEN status_audit = 'Perlu Pemantauan' THEN 1 ELSE 0 END) AS perlu_pemantauan,
       SUM(CASE WHEN status_audit = 'Ada Indikasi Fraud' THEN 1 ELSE 0 END) AS indikasi_fraud,
       SUM(CASE WHEN status_audit = 'Dalam Investigasi' THEN 1 ELSE 0 END) AS dalam_investigasi,
       SUM(CASE WHEN status_audit = 'Selesai Diaudit' THEN 1 ELSE 0 END) AS selesai_diaudit,
       ROUND(AVG(skor_risiko), 1) AS rata_skor_risiko,
       SUM(potensi_kerugian_rp) AS potensi_kerugian_rp, SUM(pengembalian_rp) AS pengembalian_rp
FROM input
GROUP BY kantor_cabang
ORDER BY kantor_cabang"""

SQL_JEJARING = """-- Jejaring dokter–faskes dari kasus berisiko: siapa merujuk ke mana dan di mana ia menjadi DPJP (untuk analisis graf).
SELECT dokter_perujuk AS id_dokter, nama_dokter_perujuk AS nama_dokter, faskes_tujuan AS kode_faskes,
       nama_faskes_tujuan AS nama_faskes, 'merujuk ke' AS relasi,
       COUNT(*) AS kasus, SUM(jumlah_klaim) AS klaim, SUM(nilai_klaim_rp) AS nilai_klaim_rp
FROM input
GROUP BY 1, 2, 3, 4
UNION ALL
SELECT dokter_dpjp, nama_dokter_dpjp, faskes_tujuan, nama_faskes_tujuan, 'DPJP di',
       COUNT(*), SUM(jumlah_klaim), SUM(nilai_klaim_rp)
FROM input
GROUP BY 1, 2, 3, 4
ORDER BY 1, 5, 3"""

SQL_PERINGKAT = """-- Peringkat dokter menurut nilai klaim kasus berisiko yang melibatkannya (sebagai perujuk atau DPJP).
WITH nilai AS (
  SELECT id, SUM(v) AS nilai_klaim_rp, SUM(n) AS klaim FROM (
    SELECT dokter_perujuk AS id, nilai_klaim_rp AS v, jumlah_klaim AS n FROM kasus_berisiko
    UNION ALL
    SELECT dokter_dpjp, nilai_klaim_rp, jumlah_klaim FROM kasus_berisiko WHERE dokter_dpjp <> dokter_perujuk
  ) GROUP BY id
)
SELECT RANK() OVER (ORDER BY n.nilai_klaim_rp DESC) AS peringkat, d.id_dokter, d.nama, d.spesialisasi, d.nama_faskes,
       d.peran_dalam_kasus, d.jumlah_kasus, n.klaim, n.nilai_klaim_rp
FROM input d
JOIN nilai n ON n.id = d.id_dokter
ORDER BY peringkat, d.id_dokter"""


NUMERIC_ML = ["tarif_rs", "tarif_inacbg", "selisih_tarif", "lama_rawat", "jumlah_obat", "jam_masuk"]

SQL_SEP = """-- Klaim per SEP dari e-Klaim (FKRTL) dan P-Care (FKTP): angka bertipe, selisih tarif, hari dan jam layanan, jenis faskes
-- (lokasi layanan) — masukan model deteksi anomali (Code Repository "Deteksi Anomali JKN demo").
SELECT k.no_sep, k.tgl_layanan, k.kode_faskes, f.jenis AS jenis_faskes, k.id_dokter, k.jenis_rawat, k.disiplin, k.kode_icd,
       k.kode_prosedur, k.kode_inacbg, k.severity, CAST(k.kelas_rawat AS STRING) AS kelas_rawat,
       CAST(k.lama_rawat AS INT) AS lama_rawat, CAST(k.jam_masuk AS INT) AS jam_masuk, CAST(k.jumlah_obat AS INT) AS jumlah_obat,
       CAST(k.tarif_inacbg AS DOUBLE) AS tarif_inacbg, CAST(k.tarif_rs AS DOUBLE) AS tarif_rs,
       CAST(k.tarif_rs AS DOUBLE) - CAST(k.tarif_inacbg AS DOUBLE) AS selisih_tarif,
       CASE dayofweek(k.tgl_layanan) WHEN 1 THEN 'Minggu' WHEN 2 THEN 'Senin' WHEN 3 THEN 'Selasa' WHEN 4 THEN 'Rabu'
            WHEN 5 THEN 'Kamis' WHEN 6 THEN 'Jumat' ELSE 'Sabtu' END AS hari,
       CASE WHEN k.jam_masuk < 6 THEN 'dini hari' WHEN k.jam_masuk < 12 THEN 'pagi' WHEN k.jam_masuk < 18 THEN 'siang' ELSE 'malam' END AS jam_kategori,
       k.dirujuk, COALESCE(NULLIF(k.faskes_perujuk, ''), '-') AS faskes_perujuk
FROM input k
LEFT JOIN faskes_bersih f ON f.kode = k.kode_faskes
ORDER BY k.no_sep"""

SQL_PROFIL = ("""-- Profil numerik per dokter, diagregasi seperti di jurnal (De Meulemeester dkk. 2025): jumlah, rata-rata, median,
-- simpangan baku, minimum dan maksimum tiap variabel numerik klaim, dan jumlah klaim.
SELECT id_dokter,
""" + ",\n".join(f"       SUM({v}) AS {v}_sum, AVG({v}) AS {v}_mean, MEDIAN({v}) AS {v}_median, STDDEV_POP({v}) AS {v}_std, MIN({v}) AS {v}_min, MAX({v}) AS {v}_max"
                  for v in NUMERIC_ML) + """,
       COUNT(*) AS jumlah_klaim
FROM input
GROUP BY id_dokter
ORDER BY id_dokter""")


def spec() -> list[dict]:
    """The nodes: source | sql (one SQL step; other tables it names are read too) | union | join."""
    import demo_jkn_e2e as e

    S = lambda i, n, g, d: {"id": i, "kind": "source", "name": n, "group": g, "doc": d}  # noqa: E731
    return [
        S("s_reg", "faskes_register_aplicares", "faskes", "Register faskes Aplicares (ekspor: duplikat, nama tidak rapi, kode huruf kecil)"),
        S("s_koord", "faskes_koordinat", "faskes", "Koordinat faskes hasil geocoding"),
        {"id": "t_reg", "kind": "sql", "name": "faskes_register_bersih", "group": "faskes", "input": "s_reg", "sql": SQL_REGISTER},
        {"id": "j_faskes", "kind": "join", "name": "faskes_bersih", "group": "faskes", "left": "t_reg", "right": "s_koord", "key": ("kode", "kode"),
         "right_cols": ["latitude", "longitude"]},
        S("s_hfis", "dokter_hfis", "dokter", "Dokter terdaftar di HFIS"),
        S("s_sip", "sip_praktik", "dokter", "Surat izin praktik kedua (praktik lain dokter)"),
        {"id": "j_dokter", "kind": "join", "name": "dokter_bersih", "group": "dokter", "left": "s_hfis", "right": "s_sip", "key": ("id_dokter", "id_dokter"),
         "right_cols": ["praktik_lain"]},
        S("s_b07", "klaim_bulanan_2026_07", "bulanan", "Ringkasan klaim per faskes, Juli 2026"),
        S("s_b08", "klaim_bulanan_2026_08", "bulanan", "Ringkasan klaim per faskes, Agustus 2026"),
        S("s_b09", "klaim_bulanan_2026_09", "bulanan", "Ringkasan klaim per faskes, September 2026"),
        {"id": "u_bulanan", "kind": "union", "name": "klaim_bulanan_gabungan", "group": "bulanan", "inputs": ["s_b07", "s_b08", "s_b09"]},
        {"id": "t_bulanan", "kind": "sql", "name": "klaim_bulanan_bersih", "group": "bulanan", "input": "u_bulanan", "sql": SQL_BULANAN},
        S("s_eklaim", "skrining_eklaim_fkrtl", "skrining", "Klaim FKRTL yang ditandai aturan skrining (e-Klaim)"),
        S("s_pcare", "skrining_pcare_rujukan", "skrining", "Rujukan FKTP yang ditandai aturan skrining (P-Care, tanggal DD/MM/YYYY)"),
        S("s_susulan", "skrining_eklaim_susulan", "skrining", "Klaim susulan e-Klaim (sebagian SEP terkirim dua kali)"),
        {"id": "t_pcare", "kind": "sql", "name": "pcare_tanggal_iso", "group": "skrining", "input": "s_pcare", "sql": SQL_PCARE},
        {"id": "u_skrining", "kind": "union", "name": "skrining_gabungan", "group": "skrining", "inputs": ["s_eklaim", "t_pcare", "s_susulan"]},
        {"id": "t_klaim", "kind": "sql", "name": "klaim_berisiko", "group": "skrining", "input": "u_skrining", "sql": SQL_DEDUP},
        S("s_kep1", "keputusan_audit_berjalan", "keputusan", "Keputusan dan rencana audit yang sedang berjalan"),
        S("s_kep2", "keputusan_audit_q2", "keputusan", "Audit triwulan II yang sudah ditutup (pengembalian dana)"),
        {"id": "u_kep", "kind": "union", "name": "keputusan_audit", "group": "keputusan", "inputs": ["s_kep1", "s_kep2"]},
        S("s_aturan", "aturan_skrining", "referensi", "Katalog aturan skrining: 20 subkategori, bobot"),
        S("s_icd", "icd10_kompetensi_fktp", "referensi", "Diagnosis ICD-10 dan kompetensi FKTP (144 diagnosis)"),
        S("s_sep_rtl", "klaim_sep_eklaim_fkrtl", "ml", "Klaim per SEP dari e-Klaim (RS dan klinik utama), Jul–Sep 2026"),
        S("s_sep_tp", "klaim_sep_pcare_fktp", "ml", "Kunjungan per SEP dari P-Care (puskesmas, klinik pratama, dokter praktik), Jul–Sep 2026"),
        {"id": "u_sep", "kind": "union", "name": "klaim_sep_gabungan", "group": "ml", "inputs": ["s_sep_rtl", "s_sep_tp"]},
        {"id": "t_sep", "kind": "sql", "name": "klaim_sep_bersih", "group": "ml", "input": "u_sep", "sql": SQL_SEP},
        {"id": "t_profil", "kind": "sql", "name": "profil_numerik_dokter", "group": "ml", "input": "t_sep", "sql": SQL_PROFIL},
        {"id": "t_faskes", "kind": "sql", "name": "faskes_audit", "group": "inti", "input": "j_faskes", "sql": e.SQL_FASKES},
        {"id": "t_kasus", "kind": "sql", "name": "kasus_berisiko", "group": "inti", "input": "t_klaim", "sql": e.SQL_KASUS},
        {"id": "t_dokter", "kind": "sql", "name": "dokter_audit", "group": "inti", "input": "j_dokter", "sql": e.SQL_DOKTER},
        {"id": "j_aturan", "kind": "join", "name": "klaim_x_aturan", "group": "analitik", "left": "t_klaim", "right": "s_aturan", "key": ("aturan", "kode_aturan"),
         "right_cols": ["subkategori", "bobot"]},
        {"id": "t_detail", "kind": "sql", "name": "klaim_berisiko_detail", "group": "analitik", "input": "j_aturan", "sql": SQL_DETAIL},
        {"id": "t_tren", "kind": "sql", "name": "tren_klaim_bulanan", "group": "analitik", "input": "t_bulanan", "sql": SQL_TREN},
        {"id": "t_kantor", "kind": "sql", "name": "ringkasan_kantor_cabang", "group": "analitik", "input": "t_faskes", "sql": SQL_KANTOR},
        {"id": "t_jejaring", "kind": "sql", "name": "jejaring_dokter_faskes", "group": "analitik", "input": "t_kasus", "sql": SQL_JEJARING},
        {"id": "t_peringkat", "kind": "sql", "name": "peringkat_dokter", "group": "analitik", "input": "t_dokter", "sql": SQL_PERINGKAT},
    ]


# (output name, node id, backs an object type)
OUTPUTS = [("faskes_audit", "t_faskes", True), ("kasus_berisiko", "t_kasus", True), ("dokter_audit", "t_dokter", True),
           ("klaim_berisiko_detail", "t_detail", False), ("tren_klaim_bulanan", "t_tren", False), ("ringkasan_kantor_cabang", "t_kantor", False),
           ("jejaring_dokter_faskes", "t_jejaring", False), ("peringkat_dokter", "t_peringkat", False),
           ("klaim_sep_bersih", "t_sep", False), ("profil_numerik_dokter", "t_profil", False)]


def table_name(name: str) -> str:
    """Pipeline Builder's SQL table name of a node (web/src/lib/pipeline.ts tableName)."""
    n = re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9_]+", "_", name.lower())) or "table"
    return f"t_{n}" if n[0].isdigit() else n


def deps(nodes: list[dict]) -> dict[str, list[str]]:
    """Each node's upstream nodes: its inputs, and for SQL the other nodes its query names."""
    by_table = {table_name(n["name"]): n["id"] for n in nodes}
    out: dict[str, list[str]] = {}
    for n in nodes:
        if n["kind"] == "source":
            out[n["id"]] = []
        elif n["kind"] == "union":
            out[n["id"]] = list(n["inputs"])
        elif n["kind"] == "join":
            out[n["id"]] = [n["left"], n["right"]]
        else:
            words = set(re.findall(r"[a-z_][a-z0-9_]*", n["sql"].lower()))
            refs = [by_table[w] for w in sorted(words) if w in by_table and by_table[w] != n["id"]]
            out[n["id"]] = [n["input"], *[r for r in refs if r != n["input"]]]
    return out


def order(nodes: list[dict]) -> list[dict]:
    d = deps(nodes)
    done: list[str] = []
    by = {n["id"]: n for n in nodes}

    def visit(i: str, seen: tuple = ()) -> None:
        if i in done:
            return
        if i in seen:
            raise ValueError(f"cycle at {i}")
        for x in d[i]:
            visit(x, (*seen, i))
        done.append(i)

    for n in nodes:
        visit(n["id"])
    return [by[i] for i in done]


def layout(nodes: list[dict]) -> dict[str, tuple[int, int]]:
    """x by depth (longest path from a source), y: sources in their colour bands, derived nodes at the mean height of
    what they read (nudged apart within a column)."""
    d = deps(nodes)
    depth: dict[str, int] = {}
    for n in order(nodes):
        depth[n["id"]] = 0 if not d[n["id"]] else 1 + max(depth[x] for x in d[n["id"]])
    y: dict[str, float] = {}
    cursor = 40.0
    for gid, _, _ in GROUPS:
        members = [n for n in nodes if n["group"] == gid and n["kind"] == "source"]
        for n in members:
            y[n["id"]] = cursor
            cursor += 92
        if members:
            cursor += 40
    taken: dict[int, list[float]] = {}
    for n in order(nodes):
        if n["kind"] == "source":
            continue
        # the main input weighs double: the node sits near the stream it continues
        ups = d[n["id"]]
        main = n.get("input") or n.get("left") or ups[0]
        want = (2 * y[main] + sum(y[u] for u in ups)) / (2 + len(ups))
        col = taken.setdefault(depth[n["id"]], [])
        while any(abs(want - t) < 84 for t in col):
            want += 88
        col.append(want)
        y[n["id"]] = want
    return {i: (60 + depth[i] * 300, int(y[i])) for i in depth}


# ------------------------------------------------------------------------------------------------
# sources (built from demo_jkn_e2e.generate_raw so the core outputs stay exactly what the Ontology shows)
# ------------------------------------------------------------------------------------------------

def rule_codes() -> dict[str, str]:
    import demo_jkn_map as jm

    subs = [*jm.FKTP_RISKS, *jm.FKRTL_RISKS]
    return {s: f"R{i:02d}" for i, s in enumerate(subs, 1)}


def generate_sources(seed: int = 26) -> dict[str, list[dict]]:
    import random

    import demo_jkn_e2e as e
    import demo_jkn_map as jm

    rnd = random.Random(seed + 1)
    raw = e.generate_raw(seed)
    codes = rule_codes()
    faskes = {f["kode"]: f for f in jm.generate()}
    reg = [{k: r[k] for k in ("kode", "nama_faskes", "jenis", "kepemilikan", "wilayah", "kantor_cabang")} for r in raw["faskes_raw"]]
    koord = [{"kode": k, "latitude": float(f["lokasi"].split(",")[0]), "longitude": float(f["lokasi"].split(",")[1])} for k, f in sorted(faskes.items())]
    import demo_jkn_ml as ml

    claims = ml.doctors_and_claims()
    hfis = [{k: d[k] for k in ("id_dokter", "nama_dokter", "spesialisasi", "kode_faskes_utama")} for d in raw["dokter_raw"]] + claims["dokter_tambahan"]
    sip = [{"id_dokter": d["id_dokter"], "praktik_lain": d["praktik_lain"]} for d in raw["dokter_raw"] if d["praktik_lain"]]
    monthly = {m: [r for r in raw["klaim_bulanan_raw"] if r["bulan"] == m] for m in ("2026-07", "2026-08", "2026-09")}
    flagged = [dict(r, aturan=codes[r["indikasi"]]) for r in raw["klaim_berisiko_raw"]]
    pcare = [dict(r, tgl_layanan=f"{r['tgl_layanan'][8:10]}/{r['tgl_layanan'][5:7]}/{r['tgl_layanan'][:4]}") for r in flagged if r["indikasi"] in REFERRAL_TYPES]
    fkrtl = [r for r in flagged if r["indikasi"] not in REFERRAL_TYPES]
    late = [r for i, r in enumerate(fkrtl) if i % 7 == 3]
    eklaim = [r for i, r in enumerate(fkrtl) if i % 7 != 3]
    # some claims of the regular file were sent again with the late batch
    late += [dict(r) for r in rnd.sample(eklaim, 40)]
    kep = raw["keputusan_audit_raw"]
    aturan = [{"kode_aturan": c, "subkategori": s, "tingkat": "FKTP" if s in jm.FKTP_RISKS else "FKRTL",
               "bobot": 3 if s in ("Phantom billing (klaim palsu)", "Cloning (penjiplakan klaim)", "Klaim fiktif obat/alkes", "Self-referral") else 2 if s in REFERRAL_TYPES else 1,
               "deskripsi": f"Aturan skrining {c}: {s}"} for s, c in codes.items()]
    icd = [{"kode_icd": c, "nama": n, "kompetensi_fktp": "Ya"} for c, n in jm.FKTP_DX] + [{"kode_icd": c, "nama": n, "kompetensi_fktp": "Tidak"} for c, n in jm.RS_DX] \
        + [{"kode_icd": c, "nama": n, "kompetensi_fktp": k} for c, n, k in (("J45.9", "Asma", "Ya"), ("K29.7", "Gastritis", "Ya"), ("E78.5", "Hiperlipidemia", "Ya"),
                                                                               ("C50.9", "Kanker payudara", "Tidak"), ("I21.9", "Infark miokard akut", "Tidak"))]
    return {
        "faskes_register_aplicares": reg, "faskes_koordinat": koord, "dokter_hfis": hfis, "sip_praktik": sip,
        "klaim_bulanan_2026_07": monthly["2026-07"], "klaim_bulanan_2026_08": monthly["2026-08"], "klaim_bulanan_2026_09": monthly["2026-09"],
        "skrining_eklaim_fkrtl": eklaim, "skrining_pcare_rujukan": pcare, "skrining_eklaim_susulan": late,
        "keputusan_audit_berjalan": [r for r in kep if r["keputusan"] != "Selesai Diaudit"], "keputusan_audit_q2": [r for r in kep if r["keputusan"] == "Selesai Diaudit"],
        "aturan_skrining": aturan, "icd10_kompetensi_fktp": icd,
        "klaim_sep_eklaim_fkrtl": claims["klaim_fkrtl"], "klaim_sep_pcare_fktp": claims["klaim_fktp"],
    }


def col_type(rows: list[dict], col: str) -> str:
    vals = [r.get(col) for r in rows if r.get(col) is not None]
    if vals and all(isinstance(v, bool) for v in vals):
        return "Boolean"
    if vals and all(isinstance(v, int) and not isinstance(v, bool) for v in vals):
        return "Integer"
    if vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        return "Double"
    return "String"


def schema_of(rows: list[dict], cols: Optional[list[str]] = None) -> list[tuple[str, str]]:
    cols = cols or (list(rows[0]) if rows else [])
    return [(c, col_type(rows, c)) for c in cols]


# ------------------------------------------------------------------------------------------------
# the emulation (sqlite3): every node in dependency order, tables named like Pipeline Builder's SQL step
# ------------------------------------------------------------------------------------------------


def _spark_functions(con: sqlite3.Connection) -> None:
    """The Spark SQL functions Pipeline Builder's SQL step offers that sqlite lacks (computed the same way)."""
    import json as _json
    import math
    from datetime import date

    class Median:
        def __init__(self):
            self.v = []

        def step(self, x):
            if x is not None:
                self.v.append(float(x))

        def finalize(self):
            if not self.v:
                return None
            v = sorted(self.v)
            m = len(v) // 2
            return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2

    class StddevPop:
        def __init__(self):
            self.v = []

        def step(self, x):
            if x is not None:
                self.v.append(float(x))

        def finalize(self):
            if not self.v:
                return None
            mu = sum(self.v) / len(self.v)
            return math.sqrt(sum((x - mu) ** 2 for x in self.v) / len(self.v))

    def json_get(doc, path):
        try:
            v = _json.loads(doc)
            for part in str(path).lstrip("$").strip(".").split("."):
                v = v[part] if part else v
            return _json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v
        except (TypeError, ValueError, KeyError):
            return None

    con.create_aggregate("median", 1, Median)
    con.create_aggregate("stddev_pop", 1, StddevPop)
    con.create_function("dayofweek", 1, lambda s: date.fromisoformat(str(s)[:10]).isoweekday() % 7 + 1 if s else None)
    con.create_function("sqrt", 1, lambda x: math.sqrt(x) if x is not None and x >= 0 else None)
    con.create_function("get_json_object", 2, json_get)


def run(sources: dict[str, list[dict]], nodes: Optional[list[dict]] = None) -> dict[str, list[dict]]:
    """Every node's rows by node name (the audit pipeline's nodes unless others are given)."""
    nodes = nodes or spec()
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    _spark_functions(con)
    out: dict[str, list[dict]] = {}
    cols_of: dict[str, list[str]] = {}

    def load(name: str, rows: list[dict], cols: list[str]) -> None:
        t = table_name(name)
        con.execute(f'DROP TABLE IF EXISTS "{t}"')
        con.execute(f'CREATE TABLE "{t}" ({", ".join(f'"{c}"' for c in cols)})')
        con.executemany(f'INSERT INTO "{t}" VALUES ({", ".join("?" * len(cols))})', [[r.get(c) for c in cols] for r in rows])
        out[name] = rows
        cols_of[name] = cols

    by = {n["id"]: n for n in nodes}
    for n in order(nodes):
        if n["kind"] == "source":
            rows = sources[n["name"]]
            load(n["name"], rows, list(rows[0]) if rows else [])
        elif n["kind"] == "union":
            ins = [by[i]["name"] for i in n["inputs"]]
            cols = cols_of[ins[0]]
            load(n["name"], [{c: r.get(c) for c in cols} for i in ins for r in out[i]], cols)
        elif n["kind"] == "join":
            left, right = by[n["left"]]["name"], by[n["right"]]["name"]
            lk, rk = n["key"]
            index: dict[Any, list[dict]] = {}
            for r in out[right]:
                if r.get(rk) not in (None, ""):
                    index.setdefault(str(r[rk]), []).append(r)
            rows = []
            for r in out[left]:
                hits = index.get(str(r.get(lk))) if r.get(lk) not in (None, "") else None
                for h in hits or [None]:
                    rows.append({**r, **{c: (h or {}).get(c) for c in n["right_cols"]}})
            load(n["name"], rows, [*cols_of[left], *n["right_cols"]])
        else:
            con.execute("DROP VIEW IF EXISTS input")
            con.execute(f'CREATE TEMP VIEW input AS SELECT * FROM "{table_name(by[n["input"]]["name"])}"')
            cur = con.execute(n["sql"].replace("AS STRING)", "AS TEXT)"))
            cols = [c[0] for c in cur.description]
            load(n["name"], [dict(r) for r in cur.fetchall()], cols)
    return out


# ------------------------------------------------------------------------------------------------
# Pipeline Builder content
# ------------------------------------------------------------------------------------------------


def content(source_items: dict[str, str], clean_folder: str, project: str, uid, schedule) -> tuple[dict, dict[str, str]]:
    """The pipeline file: datasets (the sources in Files), nodes with colours and positions, outputs into the clean
    folder with expectations, the legend, canvas notes and the schedule. Returns it and the output ids by name."""
    from datetime import datetime, timezone

    import demo_jkn_map as jm

    now = datetime.now(timezone.utc).isoformat()
    nodes = spec()
    pos = layout(nodes)
    srcs = generate_sources()
    legend = [{"id": f"lg-{g}", "name": name, "hex": hexc} for g, name, hexc in GROUPS]
    datasets, out_nodes = {}, []
    for n in nodes:
        x, y = pos[n["id"]]
        base = {"id": n["id"], "name": n["name"], "x": x, "y": y, "color": f"lg-{n['group']}"}
        if n["kind"] == "source":
            rows = srcs[n["name"]]
            ds = f"ds_{n['id']}"
            datasets[ds] = {"id": ds, "name": n["name"], "origin": f"Files · {project} / raw / {n['name']}.parquet", "createdAt": now, "refreshedAt": now,
                            "columns": [{"name": c, "type": t} for c, t in schema_of(rows)], "rows": rows[:200],
                            "ref": {"kind": "drive", "itemId": source_items[n["name"]]}}
            out_nodes.append({**base, "kind": "source", "datasetId": ds, "description": n["doc"]})
        elif n["kind"] == "union":
            out_nodes.append({**base, "kind": "union", "inputs": n["inputs"], "mode": "union all", "strict": True})
        elif n["kind"] == "join":
            lk, rk = n["key"]
            out_nodes.append({**base, "kind": "join", "left": n["left"], "right": n["right"], "leftKey": lk, "rightKey": rk, "keys": [{"left": lk, "right": rk}],
                              "how": "left", "leftColumns": None, "rightColumns": n["right_cols"]})
        else:
            out_nodes.append({**base, "kind": "transform", "input": n["input"], "steps": [{"id": uid(), "kind": "sql", "params": {"query": n["sql"]}}],
                              **({"checkpoint": True} if n["id"] in ("t_klaim", "t_faskes", "j_dokter") else {})})
    location = {"id": clean_folder, "name": f"{project} / clean"}
    expect = {
        "faskes_audit": [{"id": uid(), "kind": "unique", "columns": ["kode"]}, {"id": uid(), "kind": "notNull", "columns": ["lokasi", "status_audit"]},
                         {"id": uid(), "kind": "oneOf", "column": "status_audit", "values": list(jm.STATUS)}],
        "kasus_berisiko": [{"id": uid(), "kind": "unique", "columns": ["id_kasus"]}, {"id": uid(), "kind": "notNull", "columns": ["faskes_asal", "faskes_tujuan", "dokter_dpjp"]}],
        "dokter_audit": [{"id": uid(), "kind": "unique", "columns": ["id_dokter"]}],
        "klaim_berisiko_detail": [{"id": uid(), "kind": "unique", "columns": ["no_sep"]}, {"id": uid(), "kind": "notNull", "columns": ["subkategori", "aturan"]}],
        "tren_klaim_bulanan": [{"id": uid(), "kind": "unique", "columns": ["kode_faskes", "bulan"]}],
        "ringkasan_kantor_cabang": [{"id": uid(), "kind": "rowCount", "min": 1}],
        "jejaring_dokter_faskes": [{"id": uid(), "kind": "notNull", "columns": ["id_dokter", "kode_faskes"]}],
        "peringkat_dokter": [{"id": uid(), "kind": "unique", "columns": ["id_dokter"]}],
        "klaim_sep_bersih": [{"id": uid(), "kind": "unique", "columns": ["no_sep"]}, {"id": uid(), "kind": "notNull", "columns": ["id_dokter", "tarif_rs", "jenis_faskes"]}],
        "profil_numerik_dokter": [{"id": uid(), "kind": "unique", "columns": ["id_dokter"]}, {"id": uid(), "kind": "rowCount", "min": 100}],
    }
    outputs, out_ids = [], {}
    xmax = max(x for x, _ in pos.values())
    for name, node, backs in OUTPUTS:
        out_ids[name] = f"o_{node}"
        outputs.append({"id": out_ids[name], "name": name, "node": node, "kind": "dataset", "columns": None, "writeMode": "default", "location": location,
                        "expectations": expect[name], "x": xmax + 320, "y": pos[node][1]})
    text = [
        {"id": "note_1", "x": 40, "y": -230, "w": 520, "h": 160, "color": "lg-faskes",
         "text": "1 · SUMBER (Files / raw) — 14 ekspor sistem BPJS dalam 6 kelompok warna: Aplicares, geocoding, HFIS, SIP, ringkasan klaim bulanan, "
                 "skrining e-Klaim / P-Care / susulan, keputusan audit, katalog aturan dan ICD-10."},
        {"id": "note_2", "x": 620, "y": -230, "w": 560, "h": 160, "color": "lg-skrining",
         "text": "2 · PEMBERSIHAN & PENGGABUNGAN — kode & nama dirapikan, register didedup, tanggal P-Care diseragamkan, 3 file bulanan digabung, "
                 "klaim susulan yang terkirim dua kali didedup per SEP, koordinat & izin praktik di-join."},
        {"id": "note_3", "x": 1240, "y": -230, "w": 560, "h": 160, "color": "lg-inti",
         "text": "3 · INTI (mendukung Ontologi) — faskes_audit: skor risiko = 5 + 800 × porsi klaim berisiko + rasio rujukan (%), status dari skor kecuali "
                 "diputuskan tim audit; kasus_berisiko: 1 kasus per surat rujukan; dokter_audit: peran dokter."},
        {"id": "note_4", "x": 1860, "y": -230, "w": 520, "h": 160, "color": "lg-analitik",
         "text": "4 · ANALITIK & OUTPUT — klaim berisiko dengan konteks aturan + ICD-10, tren bulanan, ringkasan kantor cabang, jejaring dokter–faskes, "
                 "peringkat dokter. 8 dataset dengan cek kualitas; 3 dataset inti di-index ulang ke Ontologi tiap build."},
    ]
    body = {
        "type": "batch", "createdAt": now, "updatedAt": now, "datasets": datasets, "nodes": out_nodes, "outputs": outputs, "legend": legend,
        "location": location, "textNodes": text, "schedules": [schedule(list(out_ids.values()))],
        "meta": {"version": SPEC_VERSION, "description": "Demo: pipeline end-to-end audit faskes JKN — 14 sumber data BPJS dibersihkan, digabung dan diolah menjadi "
                                              "dataset faskes, kasus rujukan berisiko dan dokter yang mendukung Ontologi, plus lima cabang analitik."},
    }
    return body, out_ids


def lineage() -> dict:
    """The graph for the overview page: nodes (kind, group, depth, position) and edges, outputs and the legend."""
    nodes = spec()
    d = deps(nodes)
    pos = layout(nodes)
    return {
        "groups": [{"id": g, "name": n, "hex": h} for g, n, h in GROUPS],
        "nodes": [{"id": n["id"], "name": n["name"], "kind": n["kind"], "group": n["group"], "x": pos[n["id"]][0], "y": pos[n["id"]][1], "doc": n.get("doc")} for n in nodes],
        "edges": [[u, n] for n, ups in d.items() for u in ups],
        "outputs": [{"name": name, "node": node, "backs": backs} for name, node, backs in OUTPUTS],
    }
