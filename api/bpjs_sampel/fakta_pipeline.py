"""The second pipeline of Data Sampel BPJS: "Fakta Klaim BPJS: Siap Analisis → Fakta Klaim". It reads the claims the
first pipeline leaves ready for analysis (gold klaim_fkrtl, its output kept stable as the contract between the two)
and the participants (silver peserta), and adds, per claim, the facts an audit of fraud indications starts from —
facts, not verdicts: whether a claim is fraud is for the AI Agent Swarm and the people deciding.

  di luar tarif        billed beyond the INA-CBG package + special CMG top-ups (> Rp1.000), and whether the claim is
                       of the COVID-19 per-day scheme (no INA-CBG tariff to be beyond)
  kelas di atas hak    an inpatient stay billed in a better care class than the participant's entitlement (the
                       tariff follows the class: Kelas 1 ≈ 1.14x Kelas 2, 1.33x Kelas 3)
  tumpang tindih       an inpatient stay that starts before another of the same participant has ended
  hari sama            more than one outpatient claim of one participant at one facility profile on one day
  readmisi RS sama     the next inpatient stay at the same facility profile 0–30 days after discharge (and with the
                       same diagnosis); a move to another facility within a day is a transfer, kept apart

Visual nodes only (Join, Window, Conditional column, Formula …), on the DuckDB local engine, like the first pipeline
(builder_pipeline: its Graph, steps and layout). A schedule builds it whenever the first pipeline's klaim_fkrtl was
built. Its output klaim_fkrtl_fakta backs the live Nexus type Klaim FKRTL (BPJS) (nexus.LIVE_TYPES).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from bpjs_sampel import builder_pipeline as bp
from bpjs_sampel.builder_pipeline import (FALSE, NULL, TRUE, Graph, agg, aggregate, all_, c, case, cast, col, date_diff, fill, formula, is_true, keep,
                                          rename, select, val, window)

PIPELINE = "Fakta Klaim BPJS: Siap Analisis → Fakta Klaim"
SPEC_VERSION = 1
SOURCES = [("klaim_fkrtl", "gold", "klaim", "Semua klaim FKRTL siap analisis (output pipeline Data Mentah → Siap Analisis)"),
           ("peserta", "silver", "peserta", "Peserta JKN bersih: hak kelas rawat tiap peserta per edisi")]
OUTPUT = "klaim_fkrtl_fakta"
UPSTREAM_OUTPUT = "o_klaim_fkrtl"  # the first pipeline's output whose builds trigger this one
FAKTA = ["skema_covid", "flag_di_luar_tarif", "kelas_hak", "flag_kelas_di_atas_hak", "flag_inap_tumpang_tindih", "jumlah_tumpang_tindih", "klaim_tumpang_tindih_id",
         "flag_klaim_hari_sama", "jumlah_klaim_hari_sama", "hari_ke_inap_berikut", "flag_readmisi_rs_sama", "flag_readmisi_dx_sama", "flag_pindah_rs_cepat",
         "jumlah_fakta"]

NOTES = {
    "s_klaim_fkrtl": "Semua klaim FKRTL siap analisis, satu baris per klaim (output pipeline pertama). Kontrak antar-pipeline: kolomnya dijaga stabil.",
    "s_peserta": "Peserta JKN bersih per edisi. Hak kelas rawat peserta untuk dibandingkan dengan kelas yang ditagih.",
    "t_hak": "Hak kelas peserta sebagai angka (KELAS I → 1, II → 2, III → 3), peserta_id sebagai teks. Kunci join harus bertipe sama dengan klaim.",
    "j_hak": "Left join klaim ⨝ hak kelas pesertanya (edisi, peserta). Kelas yang ditagih dibandingkan dengan hak peserta.",
    "t_inap": "Rawat inap saja: klaim, peserta, tanggal datang dan pulang.",
    "j_inap_pasangan": "Inner join rawat inap ⨝ rawat inap peserta yang sama (edisi, peserta): setiap pasangan dua rawat inap seorang peserta.",
    "t_tumpang_tindih": "Pasangan yang tumpang tindih: rawat inap lain mulai sebelum yang ini pulang dan yang ini mulai sebelum yang lain pulang (Filter), "
                        "dihitung per klaim (Aggregate). Rawat inap 0 hari di hari yang sama dengan awal rawat inap lain bukan tumpang tindih: itu rujukan.",
    "j_tumpang_tindih": "Left join klaim ⨝ jumlah rawat inap yang tumpang tindih dengannya.",
    "t_fakta": "Fakta tiap klaim: di luar tarif, kelas di atas hak, rawat inap tumpang tindih (Window: maks tanggal pulang sebelumnya, lead tanggal datang), "
               "klaim rawat jalan berganda di hari yang sama (Window: count), readmisi di RS yang sama dan pindah RS dalam sehari (Window: lead), jumlah "
               "fakta (Formula). Fakta, bukan putusan: penilaian fraud oleh AI Agent Swarm dan manusia.",
}
DICTIONARY = {
    "skema_covid": ("Klaim pasien COVID-19 (skema tarif per hari)", "Nomor klaim memuat ICC: dibayar per hari oleh skema COVID, bukan INA-CBG."),
    "flag_di_luar_tarif": ("Tagihan di luar tarif INA-CBG + top-up", "sisa_di_luar_tarif_rp > Rp1.000 (di bawahnya pembulatan)."),
    "kelas_hak": ("Hak kelas rawat peserta", "Dari data kepesertaan (potret satu waktu: peserta bisa pindah kelas di tengah tahun)."),
    "flag_kelas_di_atas_hak": ("Rawat inap di kelas lebih baik dari hak", "Kelas yang ditagih lebih tinggi dari hak peserta; tarif INA-CBG mengikuti kelas."),
    "flag_inap_tumpang_tindih": ("Rawat inap tumpang tindih", "Ada rawat inap lain peserta yang sama yang mulai sebelum yang ini pulang, sedangkan yang ini mulai "
                                                            "sebelum yang lain pulang (rujukan di hari yang sama tidak termasuk)."),
    "jumlah_tumpang_tindih": ("Jumlah rawat inap lain yang tumpang tindih", ""),
    "klaim_tumpang_tindih_id": ("Salah satu klaim yang tumpang tindih", "Yang terkecil menurut kunci klaim."),
    "flag_klaim_hari_sama": ("Lebih dari satu klaim rawat jalan di hari dan faskes yang sama", "Peserta, profil faskes dan tanggal sama (profil faskes bisa memuat beberapa RS)."),
    "jumlah_klaim_hari_sama": ("Klaim rawat jalan peserta di faskes dan hari itu", ""),
    "hari_ke_inap_berikut": ("Hari dari pulang ke rawat inap berikutnya", "Rawat inap berikutnya peserta yang sama, di faskes mana pun."),
    "flag_readmisi_rs_sama": ("Readmisi ≤ 30 hari di RS yang sama", "Rawat inap berikutnya di profil faskes yang sama 0–30 hari setelah pulang."),
    "flag_readmisi_dx_sama": ("Readmisi di RS yang sama dengan diagnosis sama", "Sinyal pemecahan episode."),
    "flag_pindah_rs_cepat": ("Pindah ke RS lain dalam ≤ 1 hari", "Rujukan antar-RS, bukan readmisi: dipisahkan dari readmisi."),
    "jumlah_fakta": ("Jumlah fakta yang benar pada klaim", "di luar tarif + kelas di atas hak + tumpang tindih + hari sama + readmisi RS sama."),
}


def graph(cols: dict[str, list[str]]) -> tuple[Graph, str]:
    """The nodes; cols: each source's columns (the claims' are carried to the output in their order)."""
    g = Graph()
    s = {k: g.source(f"s_{k}", k, f"ds_{k}", grp, doc) for k, _, grp, doc in SOURCES}
    g.stage = 2
    hak = g.transform("t_hak", "hak_kelas_peserta", s["peserta"], [
        cast("peserta_id", "String", "peserta_id_teks"),
        case("kelas_hak_no", [(all_(c("kelas_rawat", "is equal to", val("KELAS I"))), val(1, "Integer")),
                              (all_(c("kelas_rawat", "is equal to", val("KELAS II"))), val(2, "Integer")),
                              (all_(c("kelas_rawat", "is equal to", val("KELAS III"))), val(3, "Integer"))], NULL, "Integer"),
        rename("kelas_rawat", "kelas_hak"), select(["edisi", "peserta_id_teks", "kelas_hak", "kelas_hak_no"]),
    ], "peserta", "Hak kelas rawat peserta sebagai angka.")
    j = g.join("j_hak", "klaim_hak_kelas", s["klaim_fkrtl"], hak, [("edisi", "edisi"), ("peserta_id", "peserta_id_teks")], "klaim", ["kelas_hak", "kelas_hak_no"],
               description="Left join: hak kelas peserta tiap klaim.")
    # tumpang tindih, exactly: every pair of one participant's inpatient stays, kept where each begins before the other ends
    inap_cols = ["klaim_id", "edisi", "peserta_id", "tgl_datang", "tgl_pulang"]
    ti = g.transform("t_inap", "rawat_inap", s["klaim_fkrtl"], [keep(all_(is_true("rawat_inap"))), select(inap_cols)], "klaim", "Rawat inap saja.")
    pairs = g.join("j_inap_pasangan", "pasangan_rawat_inap", ti, ti, ["edisi", "peserta_id"], "klaim", ["klaim_id", "tgl_datang", "tgl_pulang"], how="inner",
                   prefix="lain_", description="Inner join: setiap pasangan rawat inap seorang peserta.")
    tt = g.transform("t_tumpang_tindih", "tumpang_tindih_per_klaim", pairs, [
        keep(all_(c("klaim_id", "is not equal to", col("lain_klaim_id")), c("lain_tgl_datang", "is less than", col("tgl_pulang")),
                  c("tgl_datang", "is less than", col("lain_tgl_pulang")))),
        aggregate(["klaim_id"], [agg("Count", "jumlah_tumpang_tindih"), agg("Min", "klaim_tumpang_tindih_id", "lain_klaim_id")]),
        cast("jumlah_tumpang_tindih", "Integer"),
    ], "klaim", "Rawat inap lain yang tumpang tindih, per klaim.")
    j = g.join("j_tumpang_tindih", "klaim_tumpang_tindih", j, tt, ["klaim_id"], "klaim", ["jumlah_tumpang_tindih", "klaim_tumpang_tindih_id"],
               description="Left join: rawat inap yang tumpang tindih dengan tiap klaim.")
    inap = ["edisi", "peserta_id", "rawat_inap"]  # one participant's stays of one kind, in the order they began (the shorter first)
    order = [("tgl_datang", "asc"), ("tgl_pulang", "asc"), ("klaim_id", "asc")]
    ritl = is_true("rawat_inap")
    fakta = g.transform("t_fakta", "fakta_klaim", j, [
        # di luar tarif ("regex match" matches the whole value)
        case("skema_covid", [(all_(c("klaim_id", "regex match", val(".*ICC.*"))), TRUE)], FALSE, "Boolean"),
        case("flag_di_luar_tarif", [(all_(c("sisa_di_luar_tarif_rp", "is greater than", val(1000, "Double"))), TRUE)], FALSE, "Boolean"),
        # kelas di atas hak
        case("kelas_rawat_no", [(all_(c("kelas_rawat", "is equal to", val("Kelas 1"))), val(1, "Integer")),
                                (all_(c("kelas_rawat", "is equal to", val("Kelas 2"))), val(2, "Integer")),
                                (all_(c("kelas_rawat", "is equal to", val("Kelas 3"))), val(3, "Integer"))], NULL, "Integer"),
        case("flag_kelas_di_atas_hak", [(all_(ritl, c("kelas_rawat_no", "is less than", col("kelas_hak_no"))), TRUE)], FALSE, "Boolean"),
        fill("jumlah_tumpang_tindih", "0"),
        case("flag_inap_tumpang_tindih", [(all_(c("jumlah_tumpang_tindih", "is greater than", val(0, "Long"))), TRUE)], FALSE, "Boolean"),
        # the next stay of the same kind
        window("Lead", "datang_berikut", inap, order, column="tgl_datang"),
        window("Lead", "faskes_berikut", inap, order, column="faskes_profil_id"),
        window("Lead", "dx_berikut", inap, order, column="dx_primer_icd3"),
        # readmisi di RS yang sama; pindah RS dalam sehari (rujukan, bukan readmisi)
        date_diff("hari_ke_inap_berikut", "datang_berikut", "tgl_pulang", "Days"),
        case("hari_ke_inap_berikut", [(all_(c("rawat_inap", "is equal to", FALSE)), NULL)], col("hari_ke_inap_berikut"), "Auto"),
        case("flag_readmisi_rs_sama", [(all_(ritl, c("hari_ke_inap_berikut", "is between", val(0, "Long"), val(30, "Long")),
                                             c("faskes_berikut", "is equal to", col("faskes_profil_id"))), TRUE)], FALSE, "Boolean"),
        case("flag_readmisi_dx_sama", [(all_(is_true("flag_readmisi_rs_sama"), c("dx_berikut", "is equal to", col("dx_primer_icd3"))), TRUE)], FALSE, "Boolean"),
        case("flag_pindah_rs_cepat", [(all_(ritl, c("hari_ke_inap_berikut", "is between", val(0, "Long"), val(1, "Long")),
                                            c("faskes_berikut", "is not equal to", col("faskes_profil_id"))), TRUE)], FALSE, "Boolean"),
        # hari sama: outpatient claims of one participant at one facility profile on one day
        window("Count", "jumlah_klaim_hari_sama", ["edisi", "peserta_id", "faskes_profil_id", "tgl_datang", "rawat_inap"], frame="Whole partition"),
        cast("jumlah_klaim_hari_sama", "Integer"),
        case("flag_klaim_hari_sama", [(all_(c("rawat_inap", "is equal to", FALSE), c("jumlah_klaim_hari_sama", "is greater than", val(1, "Long"))), TRUE)],
             FALSE, "Boolean"),
        formula("jumlah_fakta", "flag_di_luar_tarif + flag_kelas_di_atas_hak + flag_inap_tumpang_tindih + flag_klaim_hari_sama + flag_readmisi_rs_sama"),
        cast("jumlah_fakta", "Integer"),
        select(cols["klaim_fkrtl"] + FAKTA),
    ], "klaim", "Fakta tiap klaim (bukan putusan fraud).", checkpoint=True)
    return g, fakta


def schedule(upstream_pipeline: str) -> dict:
    """Build every time the first pipeline built klaim_fkrtl."""
    return {"id": "s_setelah_siap_analisis", "name": "Setelah Siap Analisis diperbarui", "enabled": True, "outputs": [], "target": "single",
            "trigger": {"id": "root", "kind": "or", "items": [{"id": "job_siap_analisis", "kind": "job", "pipelineId": upstream_pipeline,
                                                                 "pipelineName": bp.PIPELINE, "outputId": UPSTREAM_OUTPUT, "outputName": "klaim_fkrtl"}]}}


def content(sources: dict[str, dict], gold: dict, upstream_pipeline: str, existing: Optional[dict] = None) -> dict:
    """The pipeline file. sources: {key: {item_id, table (its first rows), rows, folder}} for SOURCES; gold: {id, name}
    of the folder the output is written to; upstream_pipeline: the first pipeline's id (the schedule's trigger)."""
    now = datetime.now(timezone.utc).isoformat()
    datasets, cols = {}, {}
    for key, folder, _, _ in SOURCES:
        src = sources[key]
        cols[key] = [f.name for f in src["table"].schema]
        datasets[f"ds_{key}"] = {"id": f"ds_{key}", "name": key, "origin": f"Files · Data Sampel BPJS 2025 / {folder} / {key}", "createdAt": now,
                                 "refreshedAt": now, "columns": [{"name": f.name, "type": bp._type(f.type)} for f in src["table"].schema],
                                 "rows": bp._rows(src["table"]), "totalRows": src["rows"], "ref": {"kind": "drive", "itemId": src["item_id"]}}
    g, node = graph(cols)
    g.output(OUTPUT, node, gold, [{"id": bp._uid(), "kind": "unique", "columns": ["klaim_id"]}, {"id": bp._uid(), "kind": "rowCount", "min": 1},
                                  {"id": bp._uid(), "kind": "notNull", "columns": ["klaim_id"]}])
    for n in g.nodes:
        n["description"] = NOTES[n["id"]] + (f"\nBaris: {bp._id_num(sources[n['name']]['rows'])}" if n["kind"] == "source" else "")
    g.outputs[0]["description"] = ("Semua klaim FKRTL dengan fakta awal audit: di luar tarif, kelas di atas hak, rawat inap tumpang tindih, klaim berganda di "
                                   "hari yang sama, readmisi di RS yang sama. Membacking tipe Nexus live Klaim FKRTL (BPJS).")
    text = bp.layout(g, {
        1: ("note_1", "1 · SIAP ANALISIS — klaim FKRTL siap pakai dari pipeline Data Mentah → Siap Analisis, dan hak kelas peserta."),
        2: ("note_2", "2 · FAKTA KLAIM — per klaim: di luar tarif, kelas di atas hak, rawat inap tumpang tindih, klaim berganda di hari yang sama, readmisi "
                      "di RS yang sama. Fakta, bukan putusan: AI Agent Swarm dan manusia yang menilai indikasi fraud."),
    })
    body = {"type": "batch", "compute": "duckdb", "createdAt": (existing or {}).get("createdAt") or now, "updatedAt": now, "datasets": datasets,
            "nodes": g.nodes, "outputs": g.outputs, "legend": [{"id": f"lg-{k}", "name": n, "hex": h} for k, n, h in bp.GROUPS], "location": gold,
            "textNodes": text, "schedules": [schedule(upstream_pipeline)],
            "dictionary": {k: {"label": a, "note": b, "group": "Fakta Klaim · klaim_fkrtl_fakta", "source": "Dihitung oleh pipeline (node fakta_klaim)"}
                           for k, (a, b) in DICTIONARY.items()},
            "meta": {"version": SPEC_VERSION, "description": "Fakta awal audit indikasi fraud tiap klaim FKRTL, dari data siap analisis (DuckDB lokal)."}}
    return body
