"""The semantic layer of the AIP fraud agents: business terms over the Nexus ontology, the same for every agent.

A hundred agents only add up when they mean the same thing by "klaim berisiko", "koreksi verifikasi" or "faskes
outlier". This module is that shared vocabulary, kept in code (reviewed like code, versioned with it):

- ENTITAS: the business entities (klaim, faskes, wilayah, kode INA-CBG …) and the Nexus object type that holds each;
- DIMENSI: the ways to slice (provinsi, tipe faskes, keparahan …), mapped to the property that carries the dimension on
  every type that has it, so "per provinsi" works on any measure whose type has a provinsi;
- UKURAN: the measures, each one definition (type, aggregation, property, fixed filters), with its unit, what it means
  and what it does not (caveats), so two agents computing "klaim calon ganda" get the same number;
- ISTILAH: the glossary: words auditors use (fraud, upcoding, phantom billing, readmisi …) resolved to the entity,
  measure or tag that answers for them, with the caveat the data imposes (a correction is not proven fraud);
- TAG: the indication tags (aip/indikasi.py), one per fraud mode of Permenkes 16/2019 that this data can show a
  signal of, plus the model's own signals; each with the signals that raise it and what a strong signal looks like.

GET /api/aip/semantik serves it with the type ids resolved for the caller; the Nexus also gets it as object types
(aip/indikasi.py ensure_nexus), so the vocabulary is browsable and the tags link to their definitions.
"""

from __future__ import annotations

import re
from typing import Any, Optional

VERSION = "2026-11-09.1"  # .1: the realtime engine's tags for M01, M02, M03, M14, M15, M17, M18, M20 and JARINGAN_FASKES

# the Nexus object types of the BPJS sample data (display names: resolved to ids per caller)
T_PROV = "Provinsi (BPJS)"
T_KAB = "Kabupaten/Kota (BPJS)"
T_FASKES = "Profil Faskes (BPJS)"
T_KLAIM = "Klaim Berisiko (BPJS)"
T_BULAN = "Klaim Bulanan Provinsi (BPJS)"
T_KLAIM_KAB = "Klaim per Kab/Kota (BPJS)"
T_INDIKATOR = "Indikator INA-CBG (BPJS)"
T_KODE = "Kode INA-CBG (BPJS)"
T_DX = "Diagnosis ICD-10 (BPJS)"
T_ML_KLAIM = "Skor Risiko Klaim ML (BPJS)"
T_ML_FASKES = "Risiko Faskes ML (BPJS)"
T_PESERTA = "Peserta Klaim Berisiko (BPJS)"
T_FKTP = "Kunjungan FKTP Bulanan (BPJS)"
T_RUJUKAN = "Alur Rujukan (BPJS)"
T_INDIKASI = "Indikasi Fraud (AI Agent Swarm)"

PERMENKES = {"rujukan": "Permenkes No. 16 Tahun 2019 tentang Perubahan atas Permenkes No. 36 Tahun 2015 tentang Pencegahan dan Penanganan "
                        "Kecurangan (Fraud) serta Pengenaan Sanksi Administrasi terhadap Kecurangan dalam Pelaksanaan Program Jaminan Kesehatan",
             "url": "https://pasal.id/peraturan/permen/permenkes-no-16-tahun-2019"}

# entity -> the type that holds it, its key, and the types that refer to it by that key
ENTITAS: dict[str, dict[str, Any]] = {
    "klaim": {"label": "Klaim FKRTL", "tipe": T_KLAIM, "kunci": "klaim_id", "juga": [T_ML_KLAIM],
              "arti": "satu kunjungan FKRTL yang ditagihkan ke BPJS; Klaim Berisiko berisi klaim yang lolos skrining aturan dengan >= 1 indikasi, "
                      "Skor Risiko Klaim ML berisi klaim dengan skor model tertinggi per segmen"},
    "faskes": {"label": "Profil faskes", "tipe": T_FASKES, "kunci": "faskes_profil_id", "juga": [T_ML_FASKES, T_KLAIM, T_ML_KLAIM],
               "arti": "profil fasilitas kesehatan (jenis · tipe · kepemilikan · kab/kota); data sampel tidak memuat ID faskes asli"},
    "kabkota": {"label": "Kabupaten/kota", "tipe": T_KAB, "kunci": "kabkota_kode", "juga": [T_KLAIM_KAB, T_KLAIM, T_FASKES], "arti": "wilayah kab/kota"},
    "provinsi": {"label": "Provinsi", "tipe": T_PROV, "kunci": "provinsi_kode", "juga": [T_BULAN, T_KAB, T_FASKES, T_KLAIM, T_ML_FASKES, T_ML_KLAIM],
                 "arti": "wilayah provinsi: 38 provinsi, kode 38 data sampel (kolom *_38; pemekaran Papua 2022 menjadi Papua, Papua Selatan, "
                         "Papua Tengah, Papua Pegunungan, Papua Barat, Papua Barat Daya), lewat kab/kota faskes"},
    "inacbg": {"label": "Kode INA-CBG", "tipe": T_KODE, "kunci": "inacbg_kode", "juga": [T_INDIKATOR, T_KLAIM, T_ML_KLAIM],
               "arti": "kelompok tarif paket INA-CBG (CMG, tipe kasus, keparahan)"},
    "diagnosis": {"label": "Diagnosis ICD-10", "tipe": T_DX, "kunci": "icd3", "juga": [], "arti": "diagnosis primer 3 karakter"},
    "peserta": {"label": "Peserta", "tipe": T_PESERTA, "kunci": "peserta_key", "juga": [T_KLAIM], "arti": "peserta di balik klaim berisiko"},
    "rujukan": {"label": "Alur rujukan", "tipe": T_RUJUKAN, "kunci": "alur_rujukan_id", "juga": [], "arti": "alur rujukan FKTP -> FKRTL antarwilayah"},
}

# dimension -> {type: property}
DIMENSI: dict[str, dict[str, Any]] = {
    "provinsi": {"label": "Provinsi", "properti": {T_PROV: "provinsi", T_KAB: "provinsi", T_FASKES: "provinsi", T_KLAIM: "provinsi", T_BULAN: "provinsi",
                                                   T_KLAIM_KAB: "provinsi", T_ML_KLAIM: "provinsi", T_ML_FASKES: "provinsi", T_FKTP: "provinsi",
                                                   T_RUJUKAN: "provinsi_tujuan", T_PESERTA: "provinsi_tinggal"},
                 "catatan": "nama provinsi dalam HURUF BESAR"},
    "kabkota": {"label": "Kabupaten/kota", "properti": {T_KAB: "kabkota", T_FASKES: "kabkota", T_KLAIM: "kabkota", T_KLAIM_KAB: "kabkota",
                                                        T_ML_FASKES: "kabkota", T_RUJUKAN: "kabkota_tujuan", T_PESERTA: "kabkota_tinggal"}},
    "faskes": {"label": "Profil faskes", "properti": {T_FASKES: "faskes_profil_id", T_KLAIM: "faskes_profil_id", T_ML_KLAIM: "faskes_profil_id",
                                                      T_ML_FASKES: "faskes_profil_id"}},
    "tipe_faskes": {"label": "Tipe faskes (kelas RS)", "properti": {T_FASKES: "tipe", T_KLAIM: "tipe_fkrtl", T_KLAIM_KAB: "tipe_fkrtl", T_INDIKATOR: "tipe_fkrtl",
                                                                   T_ML_KLAIM: "tipe_fkrtl", T_ML_FASKES: "tipe_fkrtl", T_RUJUKAN: "tipe_faskes_tujuan"},
                    "catatan": "mis. RS Kelas A/B/C/D, RS Swasta Setara Type B/C, RS TNI Polri, Khusus …"},
    "jenis_faskes": {"label": "Jenis faskes", "properti": {T_FASKES: "jenis", T_ML_KLAIM: "jenis_fkrtl", T_ML_FASKES: "jenis_fkrtl"},
                     "catatan": "Rumah sakit atau Klinik Utama"},
    "kepemilikan": {"label": "Kepemilikan", "properti": {T_FASKES: "kepemilikan"}},
    "tingkat": {"label": "Tingkat layanan", "properti": {T_FASKES: "tingkat", T_ML_KLAIM: "tingkat_pelayanan"}, "catatan": "FKTP / FKRTL; RITL / RJTL"},
    "inacbg": {"label": "Kode INA-CBG", "properti": {T_KLAIM: "inacbg_kode", T_INDIKATOR: "inacbg_kode", T_KODE: "inacbg_kode", T_ML_KLAIM: "inacbg_kode"}},
    "keparahan": {"label": "Keparahan INA-CBG", "properti": {T_KLAIM: "inacbg_keparahan", T_INDIKATOR: "keparahan", T_KODE: "keparahan", T_ML_KLAIM: "inacbg_keparahan"}},
    "kelas_rawat": {"label": "Kelas rawat", "properti": {T_KLAIM: "kelas_rawat", T_PESERTA: "kelas_rawat"}},
    "bulan": {"label": "Bulan", "properti": {T_KLAIM: "bulan", T_BULAN: "bulan", T_FKTP: "bulan"}},
    "segmen_model": {"label": "Segmen model ML", "properti": {T_ML_KLAIM: "segmen_model", T_ML_FASKES: "segmen_model"}, "catatan": "rumah_sakit / klinik_utama"},
    "diagnosis": {"label": "Diagnosis primer", "properti": {T_KLAIM: "dx_primer_icd3", T_ML_KLAIM: "dx_primer_icd3"}},
    "indikasi_utama": {"label": "Indikasi utama aturan", "properti": {T_KLAIM: "indikasi_utama"}},
    "tag": {"label": "Tag indikasi", "properti": {T_INDIKASI: "tag"}},
    "kekuatan": {"label": "Kekuatan indikasi", "properti": {T_INDIKASI: "kekuatan"}},
}


def _u(label: str, tipe: str, metrik: str, properti: Optional[str], arti: str, satuan: str = "", filter: Optional[list] = None,
       catatan: str = "", tag: Optional[list[str]] = None) -> dict[str, Any]:
    return {"label": label, "tipe": tipe, "metrik": metrik, "properti": properti, "filter": filter or [], "satuan": satuan, "arti": arti,
            "catatan": catatan, "tag": tag or []}


def _eq(prop: str, value: Any) -> dict:
    return {"property": prop, "op": "eq", "value": value}


UKURAN: dict[str, dict[str, Any]] = {
    # screened claims (rules)
    "klaim_berisiko": _u("Klaim berisiko (skrining aturan)", T_KLAIM, "count", None, "klaim dengan >= 1 indikasi aturan (LOS ekstrem, selisih verifikasi, calon klaim ganda)", "klaim"),
    "nilai_tagih_berisiko": _u("Nilai tagihan klaim berisiko", T_KLAIM, "sum", "biaya_tagih_rp", "jumlah tagihan klaim berisiko", "Rp"),
    "selisih_verifikasi_rp": _u("Selisih tagih − verifikasi", T_KLAIM, "sum", "selisih_rp", "rupiah yang dikoreksi verifikator pada klaim berisiko", "Rp",
                                catatan="koreksi = verifikator membayar kurang dari tagihan; bukan fraud terbukti", tag=["KOREKSI_BERULANG"]),
    "klaim_calon_ganda": _u("Klaim calon ganda", T_KLAIM, "count", None, "klaim yang ditandai aturan sebagai calon klaim ganda (pasien, faskes, tanggal sama)",
                            "klaim", [_eq("flag_calon_klaim_ganda", True)], tag=["KLAIM_GANDA"]),
    "klaim_los_ekstrem": _u("Klaim LOS ekstrem", T_KLAIM, "count", None, "klaim rawat inap dengan lama rawat di atas p99 kodenya", "klaim",
                            [_eq("flag_los_ekstrem", True)], tag=["LOS_DIPERPANJANG"]),
    "klaim_dikoreksi": _u("Klaim dikoreksi verifikator", T_KLAIM, "count", None, "klaim yang dibayar kurang dari tagihan", "klaim",
                          [_eq("flag_selisih_verifikasi", True)], tag=["KOREKSI_BERULANG"]),
    "klaim_readmisi_30": _u("Klaim readmisi 30 hari", T_KLAIM, "count", None, "klaim berisiko yang merupakan rawat ulang <= 30 hari", "klaim",
                            [_eq("readmisi_30", True)], tag=["READMISI", "PEMECAHAN_EPISODE"]),
    "klaim_keparahan_berat": _u("Klaim keparahan III", T_KLAIM, "count", None, "klaim berisiko dengan INA-CBG keparahan berat (III)", "klaim",
                                [_eq("inacbg_keparahan", "Berat (rawat inap keparahan 3)")], tag=["UPCODING_KEPARAHAN"]),
    "rasio_biaya_peer": _u("Rasio biaya terhadap peer setarif", T_KLAIM, "avg", "rasio_biaya_peer",
                           "tagihan dibagi median tagihan peer setarif (kode INA-CBG, tipe dan kepemilikan RS, regional, kelas rawat, tahun tarif)", "x",
                           catatan="grouper INA-CBG memberi tarif paket yang sama dalam satu peer setarif: > 1,5 berarti ada top-up special CMG atau tagihan "
                                   "di luar tarif (lihat topup_subakut_rp, topup_khusus_rp, sisa_di_luar_tarif_rp); peer kecil (peer_klaim < 30) kurang andal",
                           tag=["TAGIHAN_MELEBIHI_TARIF"]),
    "nilai_di_luar_tarif": _u("Tagihan di luar tarif INA-CBG", T_KLAIM, "sum", "sisa_di_luar_tarif_rp",
                              "tagihan − tarif INA-CBG − top-up special CMG pada klaim yang melebihinya (> Rp1.000)", "Rp",
                              [{"property": "sisa_di_luar_tarif_rp", "op": "gt", "value": 1000}],
                              catatan="0 pada hampir semua klaim; sebagian besar sisanya klaim skema COVID-19 (tarif per hari, id ICC)", tag=["TAGIHAN_MELEBIHI_TARIF"]),
    "klaim_di_luar_tarif": _u("Klaim di luar tarif INA-CBG", T_KLAIM, "count", None, "klaim berisiko yang tagihannya melebihi tarif INA-CBG + top-up", "klaim",
                              [{"property": "sisa_di_luar_tarif_rp", "op": "gt", "value": 1000}], tag=["TAGIHAN_MELEBIHI_TARIF"]),
    "topup_khusus": _u("Top-up khusus (obat, prostesis, prosedur, investigasi)", T_KLAIM, "sum", "topup_khusus_rp",
                       "top-up special CMG di luar paket INA-CBG pada klaim berisiko", "Rp", tag=["TAGIHAN_MELEBIHI_TARIF"]),
    "skor_risiko_aturan": _u("Skor risiko aturan", T_KLAIM, "avg", "skor_risiko", "skor skrining aturan 0–100", "skor"),
    # facilities
    "klaim_fkrtl_faskes": _u("Klaim FKRTL faskes", T_FASKES, "sum", "klaim_fkrtl", "volume klaim FKRTL", "klaim"),
    "readmisi_faskes": _u("Readmisi 30 hari faskes", T_FASKES, "avg", "pct_readmisi_30", "persentase rawat ulang <= 30 hari", "%", tag=["READMISI"]),
    "los_ekstrem_faskes": _u("LOS ekstrem faskes", T_FASKES, "sum", "los_ekstrem", "klaim LOS ekstrem", "klaim", tag=["LOS_DIPERPANJANG"]),
    "calon_ganda_faskes": _u("Calon klaim ganda faskes", T_FASKES, "sum", "calon_klaim_ganda", "klaim calon ganda", "klaim", tag=["KLAIM_GANDA"]),
    "koreksi_faskes": _u("Klaim dikoreksi faskes", T_FASKES, "sum", "selisih_verifikasi", "klaim yang dikoreksi verifikator", "klaim", tag=["KOREKSI_BERULANG"]),
    "keparahan_berat_faskes": _u("% rawat inap keparahan III faskes", T_FASKES, "avg", "pct_keparahan_berat",
                                 "porsi rawat inap faskes yang berkode keparahan III (berat)", "%",
                                 catatan="bandingkan dengan faskes setipe (RS kelas A wajar lebih berat); jauh di atas p95 setipe = sinyal upcoding",
                                 tag=["UPCODING_KEPARAHAN"]),
    # the model
    "ekspektasi_koreksi_ml": _u("Ekspektasi koreksi (model ML)", T_ML_FASKES, "sum", "ekspektasi_koreksi",
                                "jumlah peluang koreksi semua klaim faskes menurut model (berapa koreksi yang wajar diharapkan)", "klaim"),
    "koreksi_aktual_ml": _u("Koreksi aktual", T_ML_FASKES, "sum", "koreksi_aktual", "klaim faskes yang benar-benar dikoreksi", "klaim", tag=["KOREKSI_BERULANG"]),
    "rasio_aktual_ekspektasi": _u("Rasio koreksi aktual / ekspektasi", T_ML_FASKES, "avg", "rasio_aktual_ekspektasi",
                                  "> 1: lebih sering dikoreksi daripada yang diharapkan dari profil klaimnya", "x",
                                  catatan="tidak stabil bila ekspektasi < 1; pakai bersama ekspektasi_koreksi_ml", tag=["KOREKSI_BERULANG"]),
    "berisiko_lolos_verifikasi": _u("Klaim berisiko lolos verifikasi", T_ML_FASKES, "sum", "berisiko_lolos_verifikasi",
                                    "klaim yang ditandai model tetapi TIDAK dikoreksi verifikator: kandidat audit ulang", "klaim", tag=["LOLOS_VERIFIKASI_BERISIKO"]),
    "klaim_ditandai_ml": _u("Klaim ditandai model", T_ML_FASKES, "sum", "klaim_ditandai", "klaim di 0,1% teratas skor model segmennya", "klaim", tag=["RISIKO_ML_TINGGI"]),
    "risiko_per_1000": _u("Risiko per 1.000 klaim", T_ML_FASKES, "avg", "risiko_per_1000_klaim", "ekspektasi koreksi per 1.000 klaim (intensitas risiko)", "per 1.000",
                          tag=["OUTLIER_PEER"]),
    "klaim_ml_lolos": _u("Klaim ML lolos verifikasi", T_ML_KLAIM, "count", None, "klaim berisiko tinggi menurut model yang lolos verifikasi", "klaim",
                         [_eq("lolos_verifikasi_berisiko", True)], tag=["LOLOS_VERIFIKASI_BERISIKO"]),
    "risiko_klaim_ml": _u("Peluang koreksi klaim (model)", T_ML_KLAIM, "avg", "risiko_pct", "peluang klaim dikoreksi verifikator menurut model", "%"),
    # regions, codes, referrals
    "pct_calon_ganda_kabkota": _u("% calon klaim ganda kab/kota", T_KLAIM_KAB, "avg", "pct_calon_klaim_ganda", "porsi klaim calon ganda per kab/kota × tipe RS", "%",
                                  tag=["KLAIM_GANDA", "KONSENTRASI_WILAYAH"]),
    "readmisi_provinsi": _u("Readmisi 30 hari provinsi", T_PROV, "avg", "pct_readmisi_30", "persentase rawat ulang <= 30 hari", "%", tag=["READMISI"]),
    "klaim_fkrtl_provinsi": _u("Klaim FKRTL provinsi", T_PROV, "sum", "klaim_fkrtl", "volume klaim FKRTL", "klaim"),
    "koreksi_kode": _u("% dikoreksi per kode INA-CBG", T_INDIKATOR, "avg", "pct_selisih_verifikasi", "porsi klaim kode itu yang dikoreksi", "%", tag=["KOREKSI_BERULANG"]),
    "los_ekstrem_kode": _u("% LOS ekstrem per kode", T_INDIKATOR, "avg", "pct_los_ekstrem", "porsi klaim kode itu dengan LOS ekstrem", "%", tag=["LOS_DIPERPANJANG"]),
    "rujukan": _u("Rujukan", T_RUJUKAN, "sum", "rujukan", "jumlah rujukan FKTP -> FKRTL", "rujukan"),
    "rujukan_lintas_provinsi": _u("Rujukan lintas provinsi", T_RUJUKAN, "sum", "rujukan", "rujukan ke FKRTL di provinsi lain", "rujukan",
                                  [_eq("lintas_provinsi", 1)], tag=["RUJUKAN_SEMU"]),
    "dx_sama_rujukan": _u("% diagnosis sama pada rujukan", T_RUJUKAN, "avg", "pct_dx_sama", "porsi rujukan yang diagnosisnya sama di FKTP dan FKRTL", "%",
                          catatan="rendah dapat berarti rujukan tidak sesuai indikasinya", tag=["RUJUKAN_SEMU"]),
    "rujuk_lanjut_fktp": _u("% rujuk lanjut FKTP", T_FKTP, "avg", "pct_rujuk_lanjut", "porsi kunjungan sakit FKTP yang dirujuk", "%", tag=["RUJUKAN_SEMU"]),
    "peserta_berisiko": _u("Peserta dengan klaim berisiko", T_PESERTA, "count", None, "peserta di balik klaim berisiko", "peserta"),
    "peserta_klaim_berulang": _u("Peserta dengan >= 3 klaim berisiko", T_PESERTA, "count", None, "peserta yang muncul di 3 klaim berisiko atau lebih", "peserta",
                                 [{"property": "klaim_berisiko", "op": "gte", "value": 3}], tag=["PEMECAHAN_EPISODE", "KLAIM_FIKTIF"]),
    # the ledger itself
    "indikasi": _u("Indikasi (tag)", T_INDIKASI, "count", None, "tag indikasi fraud dari penanda otomatis dan agen konsultan", "tag"),
}

# kekuatan: what each strength means (the agents and the people deciding read the same text)
KEKUATAN = {"lemah": "satu sinyal, bisa jadi wajar (mis. sedikit di atas peer); tetap dicatat agar tidak hilang",
            "sedang": "beberapa sinyal searah, atau jauh di atas peer (> p95 kelasnya)",
            "kuat": "sinyal dari beberapa sumber yang saling menguatkan (aturan + model + koreksi, atau beberapa agen lintas keluarga model), "
                    "atau penyimpangan ekstrem (> p99) yang tidak dijelaskan kelas atau case-mix"}


def _t(label: str, modus: str, entitas: list[str], sinyal: str, ukuran: list[str], permenkes: bool = True) -> dict[str, Any]:
    return {"label": label, "modus": modus, "entitas": entitas, "sinyal": sinyal, "ukuran": ukuran, "permenkes": permenkes}


TAG: dict[str, dict[str, Any]] = {
    "UPCODING_KEPARAHAN": _t("Upcoding keparahan / kode", "manipulasi diagnosis dan/atau tindakan (upcoding)", ["klaim", "faskes", "inacbg"],
                             "porsi rawat inap keparahan III faskes di atas p95 faskes setipe (upcoding memindahkan klaim ke kode/keparahan lain, "
                             "jadi tidak terlihat dengan membandingkan satu klaim dengan kodenya sendiri)",
                             ["keparahan_berat_faskes", "klaim_keparahan_berat"]),
    "TAGIHAN_MELEBIHI_TARIF": _t("Tagihan di atas tarif INA-CBG / top-up", "penggelembungan tagihan obat dan alkes (inflated bills)", ["klaim", "faskes"],
                                 "sisa_di_luar_tarif_rp > 0 (tagihan melebihi tarif INA-CBG + top-up special CMG), atau top-up obat/prostesis/"
                                 "prosedur/investigasi khusus pada klaim >= 1,5x median peer setarif; top-up subakut/kronis = rawat panjang (LOS_DIPERPANJANG)",
                                 ["nilai_di_luar_tarif", "klaim_di_luar_tarif", "topup_khusus", "rasio_biaya_peer"]),
    "KLAIM_GANDA": _t("Klaim ganda / berulang", "tagihan berulang (repeat billing)", ["klaim", "faskes", "kabkota"],
                      "flag_calon_klaim_ganda (peserta, faskes, tanggal sama); porsi calon ganda di atas peer",
                      ["klaim_calon_ganda", "calon_ganda_faskes", "pct_calon_ganda_kabkota"]),
    # cloning has its own signal since 2026-10-23: on the real claims an inpatient bill is the INA-CBG package for all but
    # 5,372 claims, and among those identical procedure packages (PCI, eye surgery) are common — so it starts weak
    "KLONING_KLAIM": _t("Cloning (penjiplakan klaim)", "penjiplakan klaim (cloning): klaim disalin dari klaim atau rekam medis pasien lain",
                        ["klaim", "faskes"],
                        "klaim rawat inap kembar lintas peserta: faskes dan tahun sama, diagnosis, INA-CBG, prosedur, lama rawat dan tagihan "
                        "identik, tagihan bukan tarif paket; lebih kuat bila tanpa prosedur dengan rawat panjang atau >= 4 peserta sebulan", []),
    "LOS_DIPERPANJANG": _t("Lama rawat diperpanjang", "memperpanjang lama perawatan (prolonged length of stay)", ["klaim", "faskes", "inacbg"],
                           "flag_los_ekstrem (> p99 kodenya); los_hari > peer_los_inap_p90; tagihan >= 1,5x peer setarif karena top-up subakut/kronis",
                           ["klaim_los_ekstrem", "los_ekstrem_faskes", "los_ekstrem_kode"]),
    "READMISI": _t("Readmisi tidak wajar", "admisi berulang (readmisi)", ["klaim", "faskes", "provinsi"], "readmisi_30; pct_readmisi_30 di atas peer",
                   ["klaim_readmisi_30", "readmisi_faskes", "readmisi_provinsi"]),
    "PEMECAHAN_EPISODE": _t("Pemecahan episode", "pemecahan episode pelayanan (services unbundling / fragmentation)", ["klaim", "faskes", "peserta"],
                            "rawat ulang beberapa hari setelah pulang dengan diagnosis sama; peserta dengan banyak klaim berisiko",
                            ["klaim_readmisi_30", "peserta_klaim_berulang"]),
    "RUJUKAN_SEMU": _t("Rujukan semu / tidak sesuai", "rujukan semu (self-referral) dan rujukan yang tidak sesuai tujuan", ["rujukan", "kabkota", "faskes"],
                       "porsi diagnosis sama rendah, rujukan lintas wilayah tidak lazim, rujuk lanjut FKTP tinggi",
                       ["dx_sama_rujukan", "rujukan_lintas_provinsi", "rujuk_lanjut_fktp"]),
    "KELAS_RAWAT": _t("Manipulasi kelas rawat", "memanipulasi kelas perawatan (type of room charge)", ["klaim", "peserta"],
                      "kelas rawat klaim berbeda dari hak kelas peserta", []),
    "KLAIM_FIKTIF": _t("Klaim fiktif (sinyal)", "klaim palsu (phantom billing)", ["klaim", "peserta", "faskes"],
                       "sinyal lemah saja di data ini: peserta dengan tanggal lahir pengganti dan banyak klaim, klaim tanpa pola layanan wajar",
                       ["peserta_klaim_berulang"]),
    "KOREKSI_BERULANG": _t("Pola koreksi verifikasi", "bukan modus Permenkes: pola koreksi verifikator (tagihan dibayar kurang)", ["klaim", "faskes", "inacbg"],
                           "koreksi aktual jauh di atas ekspektasi model (rasio > 2 dengan ekspektasi >= 1); porsi koreksi kode tinggi",
                           ["koreksi_aktual_ml", "rasio_aktual_ekspektasi", "koreksi_kode"], permenkes=False),
    "LOLOS_VERIFIKASI_BERISIKO": _t("Berisiko tetapi lolos verifikasi", "bukan modus: klaim berisiko tinggi menurut model yang tidak dikoreksi (kandidat audit ulang)",
                                    ["klaim", "faskes"], "lolos_verifikasi_berisiko; berisiko_lolos_verifikasi per faskes",
                                    ["berisiko_lolos_verifikasi", "klaim_ml_lolos"], permenkes=False),
    "RISIKO_ML_TINGGI": _t("Risiko tinggi menurut model", "bukan modus: skor model di 0,1% teratas segmennya", ["klaim", "faskes"],
                           "ditandai; risiko_pct tinggi; klaim_ditandai per faskes", ["klaim_ditandai_ml", "risiko_klaim_ml"], permenkes=False),
    "KONSENSUS_TEKNIK_ML": _t("Konsensus teknik ML", "bukan modus: faskes yang diperingkat tinggi oleh banyak teknik ML sekaligus", ["faskes"],
                              "faskes di daftar teratas >= 5 dari 9 teknik (validasi silang out-of-fold)", [], permenkes=False),
    "OUTLIER_PEER": _t("Menyimpang dari peer kelas", "bukan modus: penyimpangan statistik dari faskes sekelas", ["faskes", "kabkota", "provinsi"],
                       "ukuran faskes > p90/p95/p99 faskes setipe", ["risiko_per_1000"], permenkes=False),
    "KONSENTRASI_WILAYAH": _t("Konsentrasi wilayah", "bukan modus: indikasi yang terkumpul di satu wilayah", ["kabkota", "provinsi"],
                              "porsi klaim berisiko / calon ganda wilayah jauh di atas nasional", ["pct_calon_ganda_kabkota"], permenkes=False),
    # the realtime graph (aip/realtime/graf.py, since 2026-11-09): facilities linked by the members they share
    "JARINGAN_FASKES": _t("Jaringan faskes tidak wajar (graf realtime)", "bukan modus tunggal: faskes yang berbagi peserta jauh di atas riwayatnya "
                          "(pasien diputar antarfaskes, kolusi rujukan)", ["faskes", "klaim"],
                          "pasangan faskes dengan peserta bersama di atas ekspektasi Poisson riwayat pasangan itu (p < 0,0001); pasangan yang "
                          "saling terhubung membentuk cincin", [], permenkes=False),
    # the modes the batch screening had no tag for, raised by the realtime engine (aip/realtime/modus.py, 2026-11-09)
    "KAPITASI_TIDAK_WAJAR": _t("Indikasi penyalahgunaan kapitasi (proksi KBK)", "penyalahgunaan dana kapitasi/nonkapitasi FKTP milik pemerintah",
                               ["faskes"], "kontak semu (online/home-visit), angka kontak jauh di bawah riwayat unit, rujukan non-spesialistik naik", []),
    "NONKAPITASI_TIDAK_WAJAR": _t("Klaim nonkapitasi tidak wajar", "manipulasi klaim nonkapitasi", ["faskes"],
                                  "tindakan ganda/berulang di atas ketentuan, tidak cocok dengan peserta, tarif di atas norma tindakan", []),
    "RUJUKAN_TIDAK_SESUAI": _t("Rujukan tidak sesuai ketentuan", "rujukan pasien yang tidak sesuai ketentuan", ["faskes"],
                               "rujukan diagnosis kompetensi FKTP (4A), melompat jenjang ke RS kelas A, rasio rujukan non-spesialistik naik", []),
    "TINDAKAN_TIDAK_DILAKUKAN": _t("Tindakan ditagih tanpa dilakukan", "menagihkan tindakan yang tidak dilakukan", ["klaim", "faskes"],
                                   "kode INA-CBG kelompok prosedur tanpa tindakan tercatat", []),
    "TIDAK_SESUAI_INDIKASI": _t("Tidak sesuai indikasi medis", "tindakan pengobatan tidak sesuai indikasi medis", ["klaim", "faskes"],
                                "diagnosis/kode tidak mungkin untuk jenis kelamin/usia peserta; pasangan diagnosis–kode yang hampir tak pernah ada", []),
    "OBAT_ALKES_FIKTIF": _t("Klaim fiktif obat/alkes/tindakan", "klaim obat, alkes dan/atau tindakan yang tidak diberikan", ["klaim", "faskes"],
                            "top-up special CMG yang hampir tak pernah ada untuk kodenya; obat ditagih tanpa penyerahan (kiriman faskes)", []),
    "PENGURANGAN_OBAT": _t("Pengurangan jumlah obat", "mengurangi jumlah obat yang diserahkan tetapi ditagih sesuai resep", ["klaim", "faskes"],
                           "jumlah diserahkan < jumlah ditagih (baris obat kiriman faskes)", []),
    "MANIPULASI_PEMERIKSAAN": _t("Manipulasi hasil pemeriksaan", "memanipulasi hasil pemeriksaan untuk memenuhi syarat penagihan", ["klaim", "faskes"],
                                 "hasil pemeriksaan di klaim berbeda dari hasil alat/LIS (kiriman faskes)", []),
    # the device-duration findings (aip/realtime/iot.py and rme.py, 2026-11-15): a sub-form of upcoding the procedure (M04),
    # billing a procedure not done in full (M14) or ICU days not spent (M12/M13)
    "DURASI_ALAT_TIDAK_SESUAI": _t("Durasi/mode pemakaian alat tidak sesuai tagihan", "manipulasi tindakan: jam ventilator, mode ventilasi, lama sesi "
                                   "hemodialisis atau hari ICU yang ditagih melebihi yang tercatat alat atau rekam medis", ["klaim", "faskes"],
                                   "ventilasi 96.72 dengan jalan invasif < 96 jam berturut-turut; ventilasi invasif yang di alat non-invasif; sesi "
                                   "hemodialisis < 3 jam ditagih penuh; hari ICU di atas hari bed/monitor ICU menyala atau lokasi ICU di rekam medis", []),
    "LAINNYA": _t("Indikasi lain", "tindakan kecurangan JKN lainnya (jelaskan di bukti)", list(ENTITAS), "pola yang tidak tercakup tag lain", []),
}

# The fraud modes of Permenkes 16/2019 (the list the BPJS team works from, 2026-10-23; items 7 and 19 are the same mode)
# and what the system can see of each in this data: "terdeteksi" (a rule and a measure on the claims), "sinyal" (a weak
# signal that needs the medical record), "aturan" (a rule that found nothing here), "tidak ada data" (the sample does not
# hold what the mode needs). FOKUS: the four the team focuses on.
FOKUS = {"M06": "Phantom Billing", "M04": "Upcoding", "M05": "Cloning", "M11": "Repeat Billing"}


def _m(no: int, nama: str, arti: str, faskes: str, tag: list[str], deteksi: str, dasar: str) -> dict[str, Any]:
    mid = f"M{no:02d}"
    return {"id": mid, "no": no, "nama": nama, "arti": arti, "faskes": faskes, "tag": tag, "deteksi": deteksi, "dasar": dasar,
            "fokus": mid in FOKUS, "fokus_nama": FOKUS.get(mid)}


MODUS_PERMENKES: list[dict[str, Any]] = [
    _m(1, "Penyalahgunaan dana kapitasi/nonkapitasi", "Penyalahgunaan dana kapitasi dan/atau nonkapitasi FKTP milik Pemerintah Pusat/Daerah.", "FKTP",
       ["KAPITASI_TIDAK_WAJAR"], "sinyal", "Penggunaan dana kapitasi tidak ada di data; realtime membaca proksinya (indikator KBK yang bisa "
       "dimainkan: kontak semu, angka kontak rendah, rujukan non-spesialistik naik)."),
    _m(2, "Manipulasi klaim nonkapitasi", "Memanipulasi klaim nonkapitasi.", "FKTP", ["NONKAPITASI_TIDAK_WAJAR"],
       "sinyal", "Klaim nonkapitasi FKTP (tindakan_nonkapitasi): realtime menilai tindakan ganda/berulang, kecocokan dengan peserta, tarif, "
       "tanggal, lonjakan volume."),
    _m(3, "Rujukan tidak sesuai", "Melakukan rujukan pasien yang tidak sesuai ketentuan peraturan perundang-undangan.", "FKTP",
       ["RUJUKAN_SEMU", "RUJUKAN_TIDAK_SESUAI"],
       "sinyal", "Alur rujukan FKTP → FKRTL: kesesuaian diagnosis di kedua ujung, rujukan lintas wilayah, rujuk lanjut."),
    _m(4, "Manipulasi diagnosis dan/atau tindakan (upcoding)", "Memalsukan diagnosis dan/atau tindakan medis untuk meningkatkan besaran klaim.", "FKRTL",
       ["UPCODING_KEPARAHAN", "DURASI_ALAT_TIDAK_SESUAI"], "terdeteksi",
       "Porsi rawat inap keparahan III faskes dibanding faskes setipe; skor model; telaah klinis LLM (/verify) atas diagnosis dan catatan."),
    _m(5, "Cloning (penjiplakan klaim)", "Klaim dibuat dengan menyalin klaim/rekam medis pasien lain (copy-paste).", "FKRTL", ["KLONING_KLAIM"],
       "sinyal", "Klaim rawat inap kembar lintas peserta (diagnosis, INA-CBG, prosedur, lama rawat, tagihan identik; tagihan bukan tarif paket)."),
    _m(6, "Phantom billing (klaim palsu)", "Klaim atas layanan yang tidak pernah diberikan kepada pasien.", "FKRTL", ["KLAIM_FIKTIF"],
       "sinyal", "Peserta dengan tanggal lahir pengganti dan banyak klaim berisiko; memastikan layanan diberikan butuh rekam medis."),
    _m(7, "Inflated bills (penggelembungan tagihan)", "Klaim biaya obat/alkes lebih besar dari biaya sebenarnya (nomor 7 dan 19 di daftar sama).", "FKRTL",
       ["TAGIHAN_MELEBIHI_TARIF"], "sinyal", "Tagihan di atas tarif INA-CBG + top-up special CMG, dan top-up obat/prostesis/prosedur khusus pada "
       "klaim jauh di atas peer setarif; rincian obat dan alkes tidak ada di data."),
    _m(8, "Pemecahan episode (sesuai indikasi, tidak sesuai ketentuan)", "Pemecahan episode pelayanan sesuai indikasi medis tetapi tidak sesuai ketentuan.",
       "FKRTL", ["PEMECAHAN_EPISODE"], "sinyal", "Rawat ulang beberapa hari setelah pulang dengan diagnosis sama; peserta dengan banyak klaim."),
    _m(9, "Services unbundling / fragmentation", "Pemecahan episode yang tidak sesuai indikasi; klaim 2 diagnosis/prosedur yang seharusnya satu paket.",
       "FKRTL", ["PEMECAHAN_EPISODE"], "sinyal", "Dua klaim berdekatan pada peserta dan faskes yang sama; paket INA-CBG yang terbelah."),
    _m(10, "Self-referral (rujukan semu)", "Klaim akibat rujukan ke RS/dokter tertentu tanpa alasan keterbatasan fasilitas.", "FKRTL",
       ["RUJUKAN_SEMU", "JARINGAN_FASKES"],
       "sinyal", "Rujukan berulang ke tujuan yang sama dengan diagnosis jarang sama; rujukan lintas wilayah tidak lazim."),
    _m(11, "Repeat billing (klaim berulang)", "Klaim diulang pada kasus yang sama yang sudah ditagihkan dan dibayarkan.", "FKRTL", ["KLAIM_GANDA"],
       "terdeteksi", "Calon klaim ganda: peserta, faskes dan tanggal sama; porsi calon ganda faskes dan kab/kota di atas peer."),
    _m(12, "Prolonged length of stay", "Klaim lebih besar akibat perpanjangan hari rawat inap bukan karena indikasi medis.", "FKRTL", ["LOS_DIPERPANJANG", "DURASI_ALAT_TIDAK_SESUAI"],
       "terdeteksi", "Lama rawat di atas p99 kodenya; porsi LOS ekstrem faskes, kab/kota dan kode di atas peer."),
    _m(13, "Manipulasi kelas perawatan (room charge)", "Manipulasi kelas perawatan yang menyebabkan klaim tidak sesuai.", "FKRTL", ["KELAS_RAWAT"],
       "aturan", "Kelas rawat klaim di atas hak kelas peserta: aturannya berjalan, tidak ada temuan di data sampel."),
    _m(14, "Menagihkan tindakan yang tidak dilakukan", "Klaim atas diagnosis/tindakan yang tidak dilaksanakan.", "FKRTL", ["TINDAKAN_TIDAK_DILAKUKAN", "DURASI_ALAT_TIDAK_SESUAI"],
       "sinyal", "Kode INA-CBG kelompok prosedur tanpa tindakan tercatat (realtime); memastikan tindakan dilakukan tetap butuh rekam medis."),
    _m(15, "Tindakan pengobatan tidak sesuai indikasi medis", "Klaim atas tindakan pengobatan yang tidak sesuai indikasi medis.", "FKRTL",
       ["TIDAK_SESUAI_INDIKASI"], "sinyal", "Diagnosis/kode tidak mungkin untuk jenis kelamin/usia peserta dan pasangan diagnosis–kode langka "
       "(realtime); telaah klinis LLM per klaim (/verify)."),
    _m(16, "Readmisi (admisi berulang)", "Klaim atas satu episode yang diklaim lebih dari satu kali seolah lebih dari satu episode.", "FKRTL", ["READMISI"],
       "terdeteksi", "Rawat ulang <= 30 hari; porsi readmisi faskes dan provinsi di atas peer."),
    _m(17, "Klaim fiktif obat/alkes/tindakan", "Klaim obat, alkes, dan/atau tindakan yang ditagihkan namun tidak diberikan kepada pasien.", "Obat, alkes & penunjang",
       ["OBAT_ALKES_FIKTIF"], "sinyal", "Top-up special CMG yang hampir tak pernah ada untuk kodenya (realtime); rincian obat dan alkes per klaim "
       "tidak ada di data sampel, baris obat kiriman faskes dinilai bila ada."),
    _m(18, "Pengurangan jumlah obat", "Mengurangi jumlah obat yang diserahkan ke pasien namun ditagihkan sesuai resep.", "Obat, alkes & penunjang",
       ["PENGURANGAN_OBAT"], "tidak ada data", "Data resep dan penyerahan obat tidak ada di data sampel; aturan realtime menilai baris obat kiriman faskes."),
    _m(20, "Manipulasi hasil pemeriksaan", "Memanipulasi hasil pemeriksaan untuk memenuhi syarat penagihan.", "Obat, alkes & penunjang",
       ["MANIPULASI_PEMERIKSAAN"], "tidak ada data", "Hasil laboratorium dan pemeriksaan penunjang tidak ada di data sampel; aturan realtime "
       "membandingkan hasil di klaim dengan hasil alat/LIS kiriman faskes."),
]

ISTILAH: dict[str, dict[str, Any]] = {
    "fraud": {"sinonim": ["kecurangan", "penipuan", "fraud klaim"], "jenis": "konsep",
              "arti": "tindakan sengaja untuk memperoleh keuntungan finansial dari program JKN dengan melanggar ketentuan (Permenkes 16/2019)",
              "catatan": "data ini tidak memuat putusan fraud: yang ada indikasi (tag) dan label 'dikoreksi verifikator'; sebut 'indikasi', bukan 'fraud terbukti'"},
    "indikasi": {"sinonim": ["tag", "tanda", "sinyal", "red flag"], "jenis": "ukuran", "ke": "indikasi",
                 "arti": "tag pada objek (klaim, faskes, wilayah) yang menunjukkan sinyal sebuah modus; lemah, sedang atau kuat", "catatan": "bukan tuduhan"},
    "koreksi verifikasi": {"sinonim": ["dikoreksi", "selisih verifikasi", "klaim dikoreksi", "dibayar kurang"], "jenis": "ukuran", "ke": "klaim_dikoreksi",
                           "arti": "verifikator BPJS membayar kurang dari tagihan (flag_selisih_verifikasi); label model ML",
                           "catatan": "sebagian besar koreksi = rawat inap klinik utama (pola kebijakan verifikasi)"},
    "upcoding": {"sinonim": ["naik kode", "manipulasi diagnosis", "keparahan dinaikkan"], "jenis": "tag", "ke": "UPCODING_KEPARAHAN",
                 "arti": "menaikkan kode diagnosis/tindakan atau keparahan agar tarif lebih tinggi"},
    "phantom billing": {"sinonim": ["klaim fiktif", "klaim palsu", "pasien fiktif"], "jenis": "tag", "ke": "KLAIM_FIKTIF", "arti": "menagih layanan yang tidak diberikan",
                        "catatan": "data sampel hanya memberi sinyal lemah"},
    "klaim ganda": {"sinonim": ["repeat billing", "tagihan berulang", "duplikat", "cloning"], "jenis": "tag", "ke": "KLAIM_GANDA",
                    "arti": "klaim yang ditagih lebih dari sekali untuk layanan yang sama"},
    "los": {"sinonim": ["lama rawat", "length of stay", "los ekstrem", "rawat diperpanjang"], "jenis": "tag", "ke": "LOS_DIPERPANJANG",
            "arti": "lama rawat inap; ekstrem = di atas p99 kodenya"},
    "readmisi": {"sinonim": ["rawat ulang", "admisi berulang", "readmission"], "jenis": "tag", "ke": "READMISI", "arti": "rawat inap ulang <= 30 hari"},
    "unbundling": {"sinonim": ["pemecahan episode", "fragmentasi", "split episode"], "jenis": "tag", "ke": "PEMECAHAN_EPISODE",
                   "arti": "satu episode pelayanan ditagih sebagai beberapa klaim"},
    "rujukan semu": {"sinonim": ["self-referral", "rujukan tidak sesuai", "rujukan berlebih"], "jenis": "tag", "ke": "RUJUKAN_SEMU",
                     "arti": "rujukan yang tidak sesuai indikasi medis untuk keuntungan tertentu"},
    "inflated bills": {"sinonim": ["penggelembungan tagihan", "tagihan berlebih", "markup"], "jenis": "tag", "ke": "TAGIHAN_MELEBIHI_TARIF",
                       "arti": "tagihan di atas tarif INA-CBG + top-up special CMG, atau top-up obat/alkes khusus pada klaim jauh di atas peer setarif"},
    "kelas rawat": {"sinonim": ["naik kelas", "manipulasi kelas"], "jenis": "tag", "ke": "KELAS_RAWAT", "arti": "kelas perawatan yang ditagih tidak sesuai hak"},
    "lolos verifikasi": {"sinonim": ["kandidat audit ulang", "berisiko tidak dikoreksi"], "jenis": "ukuran", "ke": "berisiko_lolos_verifikasi",
                         "arti": "klaim berisiko tinggi menurut model yang tidak dikoreksi verifikator"},
    "ekspektasi koreksi": {"sinonim": ["expected", "ekspektasi"], "jenis": "ukuran", "ke": "ekspektasi_koreksi_ml",
                           "arti": "berapa koreksi yang diharapkan dari profil klaim sebuah faskes menurut model"},
    "peer": {"sinonim": ["sekelas", "pembanding", "faskes sejenis"], "jenis": "dimensi", "ke": "tipe_faskes",
             "arti": "faskes dengan tipe/kelas yang sama; bandingkan dengan peer, bukan dengan rata-rata semua faskes",
             "catatan": "RS kelas A dan RS khusus wajar lebih mahal dan lebih lama rawatnya (negatif sulit)"},
    "faskes": {"sinonim": ["fasilitas kesehatan", "rumah sakit", "rs", "klinik", "provider"], "jenis": "entitas", "ke": "faskes", "arti": ENTITAS["faskes"]["arti"]},
    "klaim": {"sinonim": ["tagihan", "kunjungan fkrtl"], "jenis": "entitas", "ke": "klaim", "arti": ENTITAS["klaim"]["arti"]},
    "wilayah": {"sinonim": ["provinsi", "daerah", "regional"], "jenis": "dimensi", "ke": "provinsi", "arti": "provinsi atau kab/kota"},
    "kapasitas audit": {"sinonim": ["k", "daftar audit"], "jenis": "konsep",
                        "arti": "berapa klaim yang sanggup diperiksa ulang; kartu bukti memakai asumsi 0,1% klaim",
                        "catatan": "asumsi, bukan angka publik"},
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def resolve(term: str) -> list[dict[str, Any]]:
    """What a business term means here: glossary entries, measures, dimensions, tags and entities whose name, label or
    synonyms match it, best first (exact name or synonym, then words in common)."""
    q = _norm(term)
    if not q:
        return []
    words = set(q.split())
    hits: list[tuple[int, dict]] = []

    def score(names: list[str]) -> int:
        ns = [_norm(n) for n in names if n]
        if q in ns:
            return 100
        if any(q in n or n in q for n in ns if len(n) >= 3):
            return 60
        common = max((len(words & set(n.split())) for n in ns), default=0)
        return 20 * common

    for k, v in ISTILAH.items():
        s = score([k, *v.get("sinonim", [])])
        if s:
            hits.append((s + 5, {"nama": k, **v, "jenis": "istilah", "jenis_tujuan": v.get("jenis")}))
    for k, v in UKURAN.items():
        s = score([k, v["label"]])
        if s:
            hits.append((s, {"jenis": "ukuran", "nama": k, **v}))
    for k, v in TAG.items():
        s = score([k, v["label"], v["modus"]])
        if s:
            hits.append((s, {"jenis": "tag", "nama": k, **v}))
    for k, v in DIMENSI.items():
        s = score([k, v["label"]])
        if s:
            hits.append((s, {"jenis": "dimensi", "nama": k, "label": v["label"], "tipe": sorted(v["properti"]), "catatan": v.get("catatan", "")}))
    for k, v in ENTITAS.items():
        s = score([k, v["label"]])
        if s:
            hits.append((s, {"jenis": "entitas", "nama": k, **v}))
    hits.sort(key=lambda x: -x[0])
    return [h for _, h in hits[:8]]


def query(ukuran: str, dimensi: str = "", filters: Optional[list[dict]] = None) -> dict[str, Any]:
    """A measure as a Nexus aggregation: {tipe, aggregate: {metric, property, group_by}, filters} — semantic filters
    ({"dimensi": "provinsi", "op": "eq", "nilai": "JAWA BARAT"}) become the type's own property; raw property filters
    pass through. Raises ValueError naming what is valid when the measure or dimension does not apply."""
    u = UKURAN.get(ukuran)
    if not u:
        near = [h["nama"] for h in resolve(ukuran) if h["jenis"] == "ukuran"]
        raise ValueError(f"ukuran '{ukuran}' tidak ada" + (f"; mungkin: {', '.join(near)}" if near else f"; pilihan: {', '.join(UKURAN)}"))
    tipe = u["tipe"]
    group = None
    if dimensi:
        d = DIMENSI.get(dimensi)
        if not d:
            raise ValueError(f"dimensi '{dimensi}' tidak ada; pilihan: {', '.join(DIMENSI)}")
        group = d["properti"].get(tipe)
        if not group:
            ok = [k for k, v in DIMENSI.items() if tipe in v["properti"]]
            raise ValueError(f"dimensi '{dimensi}' tidak berlaku untuk ukuran {ukuran} ({tipe}); dimensi yang berlaku: {', '.join(ok)}")
    out = list(u["filter"])
    for f in filters or []:
        if f.get("dimensi"):
            d = DIMENSI.get(f["dimensi"])
            prop = d["properti"].get(tipe) if d else None
            if not prop:
                raise ValueError(f"filter dimensi '{f['dimensi']}' tidak berlaku untuk {tipe}")
            out.append({"property": prop, "op": f.get("op") or "eq", "value": f.get("nilai", f.get("value"))})
        elif f.get("property") or f.get("properti"):
            out.append({"property": f.get("property") or f.get("properti"), "op": f.get("op") or "eq", "value": f.get("value", f.get("nilai"))})
    return {"tipe": tipe, "aggregate": {"metric": u["metrik"], "property": u["properti"], "group_by": group}, "filters": out, "ukuran": u}


def catalogue(type_ids: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """The whole layer, with each type name's id for the caller (types they cannot see have none)."""
    ids = type_ids or {}
    return {"versi": VERSION, "permenkes": PERMENKES, "entitas": ENTITAS, "dimensi": DIMENSI, "ukuran": UKURAN, "tag": TAG, "istilah": ISTILAH,
            "kekuatan": KEKUATAN, "tipe_id": {name: ids.get(name) for name in sorted({u["tipe"] for u in UKURAN.values()} | {e["tipe"] for e in ENTITAS.values()})}}
