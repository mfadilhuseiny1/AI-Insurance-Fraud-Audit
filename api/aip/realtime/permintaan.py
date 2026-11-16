"""Requests for supporting documents, auditor → hospital: the hospital-side view of the realtime engine.

The hospital never sees a score, a decision or which rule fired (no tipping-off: integrasi.py). What it can get is what a
verifier already sends for a pending claim — a request for specific supporting documents — written by the auditor, who
starts from a draft:

  - fields the self-supervised model could not reconstruct (ssl.Model.explain: what this claim has vs claims like it), each
    with the document that settles it (resume medis for a long stay, rincian biaya for a high bill, ...); facility-profile
    features are left out (they describe the facility, not the claim);
  - claim-level rule signals with the document that settles them (curated wording, never the rule's evidence text, which
    can name internal thresholds, other members or the box).

The auditor edits the draft (or writes items by hand) before it is sent; the hospital's system (ai-jkn) shows it with the
claim's processing status and sends the reply back.
"""

from __future__ import annotations

from typing import Any, Optional

# SSL fields → (what to say about it, the document that settles it). None: not a claim-level question (facility profile).
DOKUMEN: dict[str, Optional[str]] = {
    "los": "resume medis dan catatan perkembangan pasien terintegrasi (CPPT) harian",
    "idx_los": "resume medis dan catatan perkembangan pasien terintegrasi (CPPT) harian",
    "ranap_hari": "resume medis dan catatan perkembangan rawat inap",
    "biaya_tagih": "rincian biaya per komponen layanan",
    "biaya": "rincian biaya dan bukti pelaksanaan tindakan",
    "rasio_tagih_tarif": "rincian biaya per komponen layanan dan dasar selisih tagihan dengan tarif INA-CBG",
    "rasio_median": "rincian biaya dan bukti pelaksanaan tindakan",
    "tarif_tambahan": "dasar pengajuan top-up special CMG (resep/protokol obat khusus, bukti prostesis, laporan prosedur khusus)",
    "tarif_inacbg": "dasar pengodean INA-CBG (diagnosis dan prosedur yang menentukan grup)",
    "idx_tarif_kode": "dasar pengodean INA-CBG (diagnosis dan prosedur yang menentukan grup)",
    "inacbg_tipe_kasus": "dasar pengodean INA-CBG (diagnosis dan prosedur yang menentukan grup)",
    "frek_kode": "dasar pengodean INA-CBG untuk kode yang jarang dipakai",
    "frek_dx": "dasar penegakan diagnosis (hasil pemeriksaan dan penunjang)",
    "kembar": "bukti bahwa layanan pada tanggal yang sama adalah episode terpisah (SEP, jam layanan, petugas)",
    "kunjungan_peserta": "riwayat kunjungan peserta dan alasan medis kunjungan ulang",
    "kunjungan_peserta_faskes": "riwayat kunjungan peserta di faskes ini dan alasan medis kunjungan ulang",
    "hari_sejak_sebelumnya": "alasan medis kunjungan ulang (rencana kontrol atau rujukan balik)",
    "dx_sekunder": "hasil pemeriksaan penunjang yang mendukung diagnosis sekunder",
    "p_berat_dx": "catatan klinis dan hasil penunjang yang mendukung tingkat keparahan",
    "inacbg_keparahan": "catatan klinis dan hasil penunjang yang mendukung tingkat keparahan",
    "p_prosedur_dx": "laporan tindakan atau operasi",
    "ada_prosedur": "laporan tindakan atau operasi",
    "kelas_rawat": "bukti hak kelas peserta atau surat persetujuan naik kelas",
    "tingkat_pelayanan": "dasar indikasi rawat inap atau rawat jalan",
    "jenis_fkrtl": None,
    # FKTP and non-capitation
    "rujuk_nonspes": "dasar medis rujukan (kriteria TACC: time, age, complication, comorbidity)",
    "rujuk_kelas": "dasar pemilihan tujuan rujukan (rujukan berjenjang)",
    "rujuk_luar_kab": "dasar pemilihan tujuan rujukan di luar kab/kota",
    "pmi_rujuk_dx": "dasar medis rujukan (kriteria TACC)",
    "pmi_poli_dx": "catatan pemeriksaan pada kunjungan ini",
    "pmi_jk_dx": "catatan pemeriksaan dan identitas peserta pada kunjungan ini",
    "pmi_umur_dx": "catatan pemeriksaan dan identitas peserta pada kunjungan ini",
    "poli": "catatan pemeriksaan pada kunjungan ini",
    "unit_sama": "dasar pelayanan peserta yang terdaftar di FKTP lain",
    "pmi_jk_tindakan": "identitas peserta dan bukti pelaksanaan tindakan",
    "pmi_umur_tindakan": "identitas peserta dan bukti pelaksanaan tindakan",
    "pmi_dx_tindakan": "dasar medis tindakan (diagnosis dan hasil pemeriksaan)",
    "f_tindakan": "bukti pelaksanaan tindakan",
    "hari_tindakan": "bukti tanggal pelaksanaan tindakan",
    "luar_kunjungan": "bukti tanggal pelaksanaan tindakan",
    "tindakan_ke": "riwayat tindakan peserta (urutan kunjungan)",
}
# claim-level rule signals → (the question, the document). Facility- and network-level signals are not asked of one claim.
SINYAL: dict[str, tuple[str, str]] = {
    "LOS_DIPERPANJANG": ("lama rawat di atas kebiasaan kodenya", "resume medis dan catatan perkembangan pasien terintegrasi (CPPT) harian"),
    "TAGIHAN_MELEBIHI_TARIF": ("biaya ditagih di atas tarif INA-CBG", "rincian biaya per komponen layanan"),
    "READMISI": ("rawat ulang dalam 30 hari", "resume medis episode sebelumnya dan alasan rawat ulang"),
    "READMISI_DX_SAMA": ("rawat ulang dengan diagnosis yang sama", "resume medis episode sebelumnya dan alasan rawat ulang"),
    "PEMECAHAN_EPISODE": ("episode berdekatan dengan episode sebelumnya", "bukti bahwa kedua episode terpisah (resume medis keduanya)"),
    "EPISODE_HARI_SAMA": ("lebih dari satu episode pada hari yang sama", "bukti bahwa layanan pada hari yang sama adalah episode terpisah"),
    "KLAIM_GANDA_STREAM": ("klaim lain untuk layanan yang sama", "bukti bahwa klaim ini bukan pengulangan klaim lain (SEP, jam layanan)"),
    "KLAIM_GANDA_RIWAYAT": ("klaim lain untuk layanan yang sama", "bukti bahwa klaim ini bukan pengulangan klaim lain (SEP, jam layanan)"),
    "KLAIM_BERULANG_MIRIP": ("klaim yang mirip dengan klaim sebelumnya", "bukti bahwa klaim ini bukan pengulangan klaim lain (SEP, jam layanan)"),
    "KODE_PROSEDUR_TANPA_TINDAKAN": ("kode prosedur tanpa tindakan tercatat", "laporan tindakan atau operasi"),
    "DX_SEKUNDER_BERLEBIH": ("jumlah diagnosis sekunder", "hasil pemeriksaan penunjang yang mendukung diagnosis sekunder"),
    "KELAS_DI_ATAS_HAK": ("kelas rawat di atas hak peserta", "bukti hak kelas peserta atau surat persetujuan naik kelas"),
    "TOPUP_TIDAK_LAZIM": ("top-up special CMG", "dasar pengajuan top-up special CMG"),
    "TOPUP_DI_ATAS_PEER": ("besaran top-up special CMG", "dasar pengajuan top-up special CMG"),
    "PASANGAN_KODE_LANGKA": ("pasangan diagnosis dan kode INA-CBG", "dasar pengodean INA-CBG"),
    "OBAT_DIKURANGI": ("obat yang diserahkan", "bukti penyerahan obat"),
    "OBAT_TIDAK_DISERAHKAN": ("obat yang diserahkan", "bukti penyerahan obat"),
    "HASIL_PEMERIKSAAN_TIDAK_COCOK": ("hasil pemeriksaan", "hasil pemeriksaan asli dari alat"),
    "NONKAP_TARIF": ("biaya tindakan nonkapitasi", "rincian biaya dan bukti pelaksanaan tindakan"),
    "NONKAP_TANGGAL": ("tanggal tindakan", "bukti tanggal pelaksanaan tindakan"),
    "RUJUKAN_NON_SPESIALISTIK": ("rujukan diagnosis kompetensi FKTP", "dasar medis rujukan (kriteria TACC)"),
    # against the electronic medical record (rme.py): the hospital is asked for the record behind the claim, never told what differed
    "RME_KUNJUNGAN_TIDAK_ADA": ("kunjungan pada tanggal layanan", "rekam medis kunjungan pada tanggal layanan dan bukti kehadiran pasien (SEP terverifikasi)"),
    "RME_JENIS_RAWAT_BERBEDA": ("jenis rawat", "surat perintah rawat inap, catatan perkembangan pasien terintegrasi (CPPT) harian"),
    "RME_LOS_TIDAK_SESUAI": ("lama rawat", "resume medis dengan tanggal masuk dan pulang, CPPT seluruh hari rawat"),
    "RME_PASIEN_BERBEDA": ("identitas pasien", "identitas pasien di rekam medis dan SEP terverifikasi (sidik jari/face recognition)"),
    "RME_TINDAKAN_TIDAK_TERCATAT": ("tindakan yang ditagih", "laporan tindakan/operasi yang ditandatangani operator, jadwal kamar tindakan, BHP yang dipakai"),
    "RME_KLINIS_TIDAK_MENDUKUNG": ("dasar medis tindakan", "dasar indikasi tindakan (hasil EKG, laboratorium, pencitraan) sebelum tindakan"),
    "RME_DIAGNOSIS_TIDAK_TERCATAT": ("diagnosis yang ditagih", "resume medis dan lembar diagnosis yang ditandatangani DPJP"),
    "RME_DIAGNOSIS_TIDAK_DIDUKUNG": ("dasar diagnosis", "hasil pemeriksaan penunjang yang menegakkan diagnosis (tanda vital, laboratorium, analisis gas darah)"),
    "RME_OBAT_ALKES_TIDAK_TERCATAT": ("obat dan alat yang ditagih", "resep, bukti pemberian obat, nomor seri dan stiker implan/alat"),
    "RME_KELAS_BERBEDA": ("kelas rawat", "bukti ruang rawat yang ditempati (register bangsal) dan surat pernyataan naik kelas bila ada"),
    "RME_EPISODE_DIPECAH": ("episode rawat inap", "resume medis dan CPPT yang menunjukkan kedua episode terpisah"),
    "RME_KUNJUNGAN_DIPAKAI_ULANG": ("kunjungan yang ditagih", "SEP dan rekam medis kunjungan untuk masing-masing klaim"),
    "RME_RAWAT_INAP_TANPA_INDIKASI": ("indikasi rawat inap", "catatan IGD/poli saat masuk dan dasar keputusan rawat inap (kriteria rawat inap)"),
}
PESAN = ("Untuk melengkapi verifikasi klaim ini, mohon kirimkan dokumen pendukung berikut. Permintaan ini bagian dari verifikasi "
         "rutin dan belum merupakan keputusan atas klaim.")
# one item per topic: the SSL field and the rule that ask the same question (a high bill, a duplicate, ...) become one request
TOPIK: dict[str, str] = {
    **dict.fromkeys(["biaya_tagih", "rasio_tagih_tarif", "biaya", "rasio_median", "TAGIHAN_MELEBIHI_TARIF", "NONKAP_TARIF"], "biaya"),
    **dict.fromkeys(["los", "idx_los", "ranap_hari", "LOS_DIPERPANJANG", "RME_LOS_TIDAK_SESUAI"], "lama_rawat"),
    **dict.fromkeys(["kembar", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP", "EPISODE_HARI_SAMA", "PEMECAHAN_EPISODE"], "ganda"),
    **dict.fromkeys(["tarif_tambahan", "TOPUP_TIDAK_LAZIM", "TOPUP_DI_ATAS_PEER"], "topup"),
    **dict.fromkeys(["tarif_inacbg", "idx_tarif_kode", "inacbg_tipe_kasus", "frek_kode", "PASANGAN_KODE_LANGKA"], "kode"),
    **dict.fromkeys(["dx_sekunder", "DX_SEKUNDER_BERLEBIH", "RME_DIAGNOSIS_TIDAK_DIDUKUNG"], "dx_sekunder"),
    **dict.fromkeys(["p_berat_dx", "inacbg_keparahan"], "keparahan"),
    **dict.fromkeys(["p_prosedur_dx", "ada_prosedur", "KODE_PROSEDUR_TANPA_TINDAKAN", "RME_TINDAKAN_TIDAK_TERCATAT"], "prosedur"),
    **dict.fromkeys(["kelas_rawat", "KELAS_DI_ATAS_HAK"], "kelas"),
    **dict.fromkeys(["kunjungan_peserta", "kunjungan_peserta_faskes", "hari_sejak_sebelumnya", "READMISI", "READMISI_DX_SAMA"], "kunjungan_ulang"),
    **dict.fromkeys(["rujuk_nonspes", "pmi_rujuk_dx", "RUJUKAN_NON_SPESIALISTIK"], "rujukan_medis"),
    **dict.fromkeys(["hari_tindakan", "luar_kunjungan", "NONKAP_TANGGAL"], "tanggal_tindakan"),
    **dict.fromkeys(["OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "RME_OBAT_ALKES_TIDAK_TERCATAT"], "obat"),
}


def draft(e: dict) -> dict:
    """The default request for an event: items from the SSL explanation and the claim-level rule signals, de-duplicated by
    document; the auditor edits it before it is sent."""
    items: list[dict] = []
    seen: set[str] = set()

    def add(key: str, medan: str, isi: str, dok: str, asal: str) -> None:
        # one item per topic (else per document); the SSL field comes first: it carries this claim's numbers
        t = TOPIK.get(key, dok)
        if t in seen or dok in seen:
            return
        seen.update((t, dok))
        items.append({"medan": medan, "isi": isi, "dokumen": dok, "asal": asal})

    for a in ((e.get("ssl") or {}).get("alasan") or []):
        dok = DOKUMEN.get(a["fitur"])
        if not dok:
            continue
        if a.get("arah"):
            isi = f"{a['label']}: {a['nilai']}; klaim serupa umumnya {a['pola']}"
        else:
            isi = f"{a['label']}: {a['nilai']} (klaim serupa umumnya {a['pola']})"
        add(a["fitur"], a["label"], isi, dok, "self-supervised")
    for s in e.get("sinyal") or []:
        q = SINYAL.get(s["kode"])
        if q and s.get("kontribusi", 0) > 0:
            add(s["kode"], q[0], q[0], q[1], "aturan")
    return {"pesan": PESAN, "butir": items[:6]}


def for_hospital(r: dict) -> dict:
    """What the hospital sees of a request (not who wrote it, not where its items came from)."""
    return {"id": r["id"], "dibuat": r["dibuat"], "status": r["status"], "pesan": r["pesan"],
            "butir": [{"medan": b.get("medan"), "isi": b.get("isi"), "dokumen": b.get("dokumen")} for b in r["butir"]],
            "balasan": r.get("balasan"), "dibalas": r.get("dibalas")}


def status_for_hospital(receipt: Optional[dict], event: Optional[dict]) -> str:
    """diterima (queued) → diproses (the engine decided; the hospital is not told what) | ditolak (with the receipt's reason)."""
    if not receipt:
        return "tidak dikenal"
    if receipt["status"] != "diterima":
        return receipt["status"]
    return "diproses" if event else "diterima"


def receipt_of_event(store: Any, e: dict) -> Optional[dict]:
    rid = e.get("tanda_terima")
    if not rid:
        return None
    r = store.rows("SELECT id, sumber, klaim, versi, pada, status FROM tanda_terima WHERE id = ?", (rid,))
    return dict(zip(("id", "sumber", "klaim", "versi", "pada", "status"), r[0])) if r else None
