"""The rules behind the fraud indications, explained: what each one checks, why, on which data, with which threshold and
strength, which Permenkes 16/2019 mode it points to, and how many it found last. One catalogue for the "Aturan
Indikasi" tab of /aip-jkn (GET /api/aip/aturan): the thresholds are read from the code that applies them (indikasi,
karantina, the pipelines), so the explanation cannot drift from what runs.

Layers, in the order a claim meets them:
  fakta      the second pipeline (bpjs_sampel/fakta_pipeline.py): facts on every claim, not verdicts
  skrining   the first pipeline's screening (klaim_berisiko): which claims become Klaim Berisiko objects, their score
  penanda    the automatic tagger (indikasi.autotag): rules over the Nexus objects that write Indikasi Fraud tags
  kerugian   the Box Karantina's estimate of the loss of one tagged claim (karantina.claim_loss)
and the 19 Permenkes modes with what the data can show of each (semantik.MODUS_PERMENKES).
"""

from __future__ import annotations

import threading
import time
from typing import Any, Optional

from aip import indikasi as I
from aip import karantina as K
from aip import semantik as S

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
TTL = 600.0


def _r(id_: str, lapisan: str, nama: str, entitas: str, tag: Optional[str], kondisi: str, kenapa: str, data: str, kekuatan: str = "",
       keterbatasan: str = "", kolom: Optional[str] = None, catatan: str = "") -> dict:
    t = S.TAG.get(tag or "") or {}
    return {"id": id_, "lapisan": lapisan, "nama": nama, "entitas": entitas, "tag": tag, "tag_label": t.get("label"), "modus": t.get("modus"),
            "kondisi": kondisi, "kenapa": kenapa, "data": data, "kekuatan": kekuatan, "keterbatasan": keterbatasan, "kolom": kolom, "catatan": catatan}


def _rules() -> list[dict]:
    rp = lambda v: "Rp" + f"{v:,.0f}".replace(",", ".")  # noqa: E731
    sisa = rp(I.SISA_MIN)
    return [
        # 1 · facts on every claim (pipeline Fakta Klaim)
        _r("fakta_di_luar_tarif", "fakta", "Tagihan di luar tarif INA-CBG", "klaim", "TAGIHAN_MELEBIHI_TARIF",
           f"tagihan − tarif INA-CBG − top-up special CMG > {sisa}",
           "Grouper INA-CBG menetapkan harga klaim: tarif paket + top-up special CMG. Pada hampir semua klaim tagihan persis sama dengan itu; selisih di atasnya "
           "tidak dijelaskan tarif mana pun.",
           "klaim_fkrtl: tarif_inacbg_rp (FKL32), top-up FKL34/37/40/43/46, biaya_tagih_rp (FKL47)",
           keterbatasan=f"Di bawah {sisa} dianggap pembulatan. Klaim skema COVID-19 (tarif per hari) memang di luar tarif INA-CBG: lihat fakta skema COVID.",
           kolom="flag_di_luar_tarif"),
        _r("fakta_skema_covid", "fakta", "Klaim skema COVID-19", "klaim", None, "nomor klaim memuat ICC",
           "Klaim pasien COVID-19 dibayar per hari oleh skema COVID, bukan INA-CBG: tarif dan peer INA-CBG bukan pembandingnya.",
           "klaim_fkrtl: klaim_id", kolom="skema_covid", catatan="Bukan indikasi; pembeda untuk fakta lain."),
        _r("fakta_kelas_di_atas_hak", "fakta", "Rawat inap di kelas lebih baik dari hak", "klaim", "KELAS_RAWAT",
           "rawat inap dan kelas rawat yang ditagih (Kelas 1/2/3) lebih tinggi dari hak kelas peserta (KELAS I/II/III)",
           "Tarif INA-CBG mengikuti kelas (Kelas 1 ≈ 1,14× Kelas 2 dan 1,33× Kelas 3): menagih kelas di atas hak menaikkan pembayaran BPJS.",
           "klaim_fkrtl: kelas_rawat (FKL13); peserta: kelas_rawat (PSTV07)",
           keterbatasan="Hak kelas dari data kepesertaan adalah potret satu waktu: peserta bisa pindah kelas di tengah tahun. Naik kelas atas permintaan "
                        "peserta (selisih dibayar peserta) sah.", kolom="flag_kelas_di_atas_hak"),
        _r("fakta_tumpang_tindih", "fakta", "Rawat inap tumpang tindih", "klaim", "KLAIM_GANDA",
           "ada rawat inap lain peserta yang sama yang mulai sebelum yang ini pulang, sedangkan yang ini mulai sebelum yang lain pulang",
           "Seseorang tidak bisa dirawat inap di dua tempat sekaligus: dua klaim yang tanggalnya bertumpuk adalah klaim ganda, layanan fiktif atau "
           "pemecahan episode.",
           "klaim_fkrtl: peserta_id, tgl_datang, tgl_pulang, rawat_inap",
           keterbatasan="Rawat inap 0 hari di hari yang sama dengan awal rawat inap lain tidak dihitung: itu rujukan (lihat pindah RS).",
           kolom="flag_inap_tumpang_tindih"),
        _r("fakta_hari_sama", "fakta", "Klaim rawat jalan berganda di hari yang sama", "klaim", "PEMECAHAN_EPISODE",
           "lebih dari satu klaim rawat jalan peserta yang sama di profil faskes yang sama pada hari yang sama",
           "Satu kunjungan yang ditagih sebagai beberapa klaim adalah pemecahan episode (unbundling).",
           "klaim_fkrtl: peserta_id, faskes_profil_id, tgl_datang, rawat_inap",
           keterbatasan="Profil faskes bisa memuat beberapa RS (ID faskes dianonimkan); kunjungan ke beberapa poli bisa sah.", kolom="flag_klaim_hari_sama"),
        _r("fakta_readmisi_rs_sama", "fakta", "Readmisi ≤ 30 hari di RS yang sama", "klaim", "READMISI",
           "rawat inap berikutnya peserta yang sama di profil faskes yang sama, 0–30 hari setelah pulang",
           "Pulang lalu dirawat lagi di RS yang sama dalam sebulan, apalagi dengan diagnosis sama, adalah tanda pemulangan dini atau episode yang dipecah.",
           "klaim_fkrtl: peserta_id, faskes_profil_id, tgl_datang, tgl_pulang, dx_primer_icd3",
           keterbatasan="Banyak readmisi wajar (penyakit kronis, komplikasi). Diagnosis sama: kolom flag_readmisi_dx_sama.", kolom="flag_readmisi_rs_sama"),
        _r("fakta_pindah_rs", "fakta", "Pindah ke RS lain dalam ≤ 1 hari", "klaim", None,
           "rawat inap berikutnya di profil faskes lain 0–1 hari setelah pulang",
           "Rujukan antar-RS: dipisahkan dari readmisi supaya readmisi tidak tercampur rujukan.",
           "klaim_fkrtl: peserta_id, faskes_profil_id, tgl_datang, tgl_pulang", kolom="flag_pindah_rs_cepat", catatan="Bukan indikasi; pembeda."),
        # 2 · the first pipeline's screening (which claims become Klaim Berisiko objects)
        _r("skrining_calon_ganda", "skrining", "Calon klaim ganda", "klaim", "KLAIM_GANDA",
           "klaim lain dengan peserta, tanggal datang dan pulang, kode INA-CBG dan biaya tagih yang sama persis",
           "Klaim yang diulang persis sama.", "kunjungan_fkrtl: flag_calon_klaim_ganda",
           keterbatasan="Hanya kecocokan persis; tumpang tindih tanggal ada di fakta tumpang tindih.", kolom="flag_calon_klaim_ganda"),
        _r("skrining_selisih", "skrining", "Klaim dikoreksi verifikator", "klaim", "KOREKSI_BERULANG",
           "biaya verifikasi ≠ biaya tagih", "Verifikator membayar kurang dari tagihan: uangnya sudah diselamatkan, polanya per faskes yang dinilai.",
           "kunjungan_fkrtl: selisih_rp", keterbatasan="Sudah dikoreksi: bukan kerugian; berguna sebagai label model ML.", kolom="flag_selisih_verifikasi"),
        _r("skrining_los_ekstrem", "skrining", "LOS ekstrem", "klaim", "LOS_DIPERPANJANG",
           "lama rawat di atas persentil 99 kode INA-CBG-nya dan lebih dari 3 hari",
           "Rawat inap yang jauh lebih lama dari klaim lain berkode sama.", "kunjungan_fkrtl: los_hari, p99 per inacbg_kode",
           keterbatasan="Persentil 99 menandai ~1% klaim setiap kode apa pun keadaannya (kuota, bukan uji); edisi digabung.", kolom="flag_los_ekstrem"),
        _r("skrining_skor", "skrining", "Skor risiko aturan 0–100", "klaim", None,
           "35·calon ganda + 25·selisih verifikasi + 25·LOS ekstrem + 10·readmisi 30 hari + (rasio biaya peer setarif − 1)·5 (maks. 15)",
           "Mengurutkan klaim berisiko untuk diperiksa.", "klaim_berisiko: skor_risiko",
           keterbatasan="Bukan peluang fraud. Peer setarif = kode INA-CBG, tipe dan kepemilikan RS, regional, kelas rawat, tahun tarif."),
        # 3 · the automatic tagger
        _r("klaim_calon_ganda", "penanda", "Klaim ganda", "klaim", "KLAIM_GANDA", "klaim berisiko dengan flag calon klaim ganda",
           "Tagihan berulang (repeat billing).", "Klaim Berisiko", "sedang bila klaim punya ≥ 2 indikasi, selain itu lemah"),
        _r("klaim_los_ekstrem", "penanda", "Lama rawat diperpanjang", "klaim", "LOS_DIPERPANJANG", "klaim berisiko dengan flag LOS ekstrem",
           "Memperpanjang lama perawatan.", "Klaim Berisiko: los_hari, peer_los_inap_p90", "sedang bila LOS > 2× p90 peer atau ≥ 2 indikasi"),
        _r("klaim_dikoreksi", "penanda", "Pola koreksi", "klaim", "KOREKSI_BERULANG", "klaim yang dikoreksi verifikator", "Bahan pola koreksi per faskes.",
           "Klaim Berisiko: selisih_rp", "sedang bila ≥ 2 indikasi"),
        _r("klaim_readmisi", "penanda", "Readmisi", "klaim", "READMISI", "rawat inap ulang ≤ 30 hari setelah pulang", "Admisi berulang.",
           "Klaim Berisiko: readmisi_30", "lemah", keterbatasan="Readmisi 30 hari di sini termasuk rujukan ke RS lain (lihat fakta pindah RS)."),
        _r("klaim_di_atas_tarif", "penanda", "Tagihan di atas tarif INA-CBG", "klaim", "TAGIHAN_MELEBIHI_TARIF",
           f"sisa di luar tarif INA-CBG + top-up > {sisa}", "Penggelembungan tagihan yang tidak dijelaskan tarif grouper.",
           "Klaim Berisiko: sisa_di_luar_tarif_rp", "sedang bila ≥ 20% tagihan dan bukan skema COVID, selain itu lemah"),
        _r("klaim_topup_khusus", "penanda", "Top-up obat/alkes/prosedur khusus", "klaim", "TAGIHAN_MELEBIHI_TARIF",
           "tagihan ≥ 1,5× median peer setarif (≥ 30 klaim peer) dengan top-up obat, prostesis, prosedur atau investigasi khusus",
           "Penggelembungan tagihan obat dan alkes lewat top-up di luar paket.", "Klaim Berisiko: rasio_biaya_peer, topup_khusus_rp, peer_pct_topup_khusus",
           "sedang bila ≥ 3× peer dan bukan skema COVID"),
        _r("klaim_topup_subakut", "penanda", "Rawat panjang dengan top-up subakut/kronis", "klaim", "LOS_DIPERPANJANG",
           "tagihan ≥ 1,5× median peer setarif karena top-up subakut/kronis", "Tagihan tinggi karena rawat panjang, bukan karena tarif: dinilai sebagai lama rawat.",
           "Klaim Berisiko: rasio_biaya_peer, topup_subakut_rp", "lemah"),
        _r("ml_lolos_verifikasi", "penanda", "Berisiko tetapi lolos verifikasi", "klaim", "LOLOS_VERIFIKASI_BERISIKO",
           "model: 0,1% teratas segmennya dan tidak dikoreksi verifikator", "Kandidat audit ulang.", "Skor ML klaim", "sedang"),
        _r("ml_ditandai", "penanda", "Risiko tinggi menurut model", "klaim", "RISIKO_ML_TINGGI", "model: 0,1% teratas skor segmennya",
           "Pola halus yang tidak tertangkap aturan.", "Skor ML klaim", "sedang bila peringkat ≤ 100 di segmennya",
           keterbatasan="Model belajar apa yang dikoreksi verifikator, bukan fraud terbukti."),
        _r("faskes_koreksi_vs_ekspektasi", "penanda", "Koreksi di atas ekspektasi model", "faskes", "KOREKSI_BERULANG",
           "koreksi aktual ≥ 2× ekspektasi model, ekspektasi ≥ 1", "Faskes yang lebih sering dikoreksi daripada yang wajar untuk profil klaimnya.",
           "Risiko ML faskes", "kuat bila ≥ 4× dan ekspektasi ≥ 2, selain itu sedang"),
        _r("faskes_lolos_verifikasi", "penanda", "Klaim berisiko lolos verifikasi per faskes", "faskes", "LOLOS_VERIFIKASI_BERISIKO",
           "≥ 1 klaim berisiko tinggi menurut model yang lolos verifikasi", "Kandidat audit ulang per faskes.", "Risiko ML faskes",
           "kuat ≥ 10 klaim, sedang ≥ 3, lemah"),
        _r("faskes_outlier_peer", "penanda", "Menyimpang dari faskes setipe", "faskes", "OUTLIER_PEER",
           "risiko per 1.000 klaim di atas persentil 90 faskes setipe (≥ 200 klaim)", "Penyimpangan statistik dari faskes sekelas.", "Risiko ML faskes",
           "kuat ≥ p99, sedang ≥ p97, lemah"),
        _r("faskes_readmisi", "penanda", "Readmisi tinggi", "faskes", "READMISI", "% readmisi 30 hari di atas persentil 95 faskes setipe (≥ 50 rawat inap)",
           "Admisi berulang di tingkat faskes.", "Profil Faskes: pct_readmisi_30", "sedang ≥ p99, lemah"),
        _r("faskes_los_ekstrem", "penanda", "LOS ekstrem tinggi", "faskes", "LOS_DIPERPANJANG", "porsi LOS ekstrem di atas persentil 95 faskes setipe",
           "Lama rawat diperpanjang di tingkat faskes.", "Profil Faskes: los_ekstrem, klaim_inap", "sedang ≥ p99, lemah"),
        _r("faskes_calon_ganda", "penanda", "Calon klaim ganda tinggi", "faskes", "KLAIM_GANDA", "porsi calon klaim ganda di atas persentil 95 faskes setipe (≥ 200 klaim)",
           "Klaim berulang di tingkat faskes.", "Profil Faskes: calon_klaim_ganda", "sedang ≥ p99, lemah"),
        _r("faskes_keparahan_berat", "penanda", "Keparahan III tinggi (upcoding)", "faskes", "UPCODING_KEPARAHAN",
           "% rawat inap keparahan III di atas persentil 95 faskes setipe (≥ 50 rawat inap)",
           "Upcoding memindahkan klaim ke kode atau keparahan lebih mahal; itu terlihat di campuran kasus faskes, bukan pada satu klaim terhadap kodenya sendiri.",
           "Profil Faskes: pct_keparahan_berat", "sedang ≥ p99, lemah", keterbatasan="RS rujukan wajar menangani kasus lebih berat."),
        _r("kabkota_calon_ganda", "penanda", "Konsentrasi calon klaim ganda", "kabkota", "KONSENTRASI_WILAYAH",
           "porsi calon klaim ganda kab/kota di atas persentil 95 (≥ 1.000 klaim)", "Indikasi yang terkumpul di satu wilayah.", "Kab/Kota", "lemah"),
        _r("kabkota_los_ekstrem", "penanda", "Konsentrasi LOS ekstrem", "kabkota", "KONSENTRASI_WILAYAH",
           "porsi LOS ekstrem kab/kota di atas persentil 95 (≥ 500 rawat inap)", "Indikasi yang terkumpul di satu wilayah.", "Kab/Kota", "lemah"),
        _r("kode_los_ekstrem", "penanda", "Kode INA-CBG dengan LOS ekstrem tinggi", "inacbg", "LOS_DIPERPANJANG",
           "% LOS ekstrem kode di atas persentil 99 kode lain (≥ 100 klaim)", "Kode yang sering dirawat terlalu lama.", "Indikator INA-CBG", "lemah"),
        _r("kode_koreksi", "penanda", "Kode INA-CBG yang sering dikoreksi", "inacbg", "KOREKSI_BERULANG",
           "% klaim dikoreksi di atas persentil 99 kode lain (≥ 100 klaim)", "Kode yang sering salah ditagih.", "Indikator INA-CBG", "lemah"),
        _r("rujukan_dx_beda", "penanda", "Rujukan dengan diagnosis jarang sama", "rujukan", "RUJUKAN_SEMU",
           "alur rujukan ≥ 30 rujukan dengan % diagnosis sama di bawah persentil 5", "Rujukan yang tidak sesuai indikasinya.", "Alur Rujukan: pct_dx_sama",
           "lemah", keterbatasan="Diagnosis spesialis wajar berbeda dari diagnosis FKTP."),
        _r("peserta_klaim_berulang", "penanda", "Peserta dengan banyak klaim berisiko", "peserta", "PEMECAHAN_EPISODE", "≥ 3 klaim berisiko pada satu peserta",
           "Episode yang dipecah atau klaim berulang atas nama satu peserta.", "Peserta Klaim Berisiko", "sedang ≥ 6, lemah"),
        _r("peserta_tgl_lahir_pengganti", "penanda", "Tanggal lahir pengganti dengan klaim berisiko", "peserta", "KLAIM_FIKTIF",
           "tanggal lahir pengganti (< 1901) dan ≥ 2 klaim berisiko", "Sinyal lemah klaim atas identitas yang tidak lengkap.", "Peserta Klaim Berisiko", "lemah"),
        _r("klaim_kelas_di_atas_hak", "penanda", "Kelas rawat di atas hak", "klaim", "KELAS_RAWAT", "kelas rawat klaim lebih baik dari hak kelas peserta",
           "Manipulasi kelas perawatan.", "Klaim Berisiko: kelas_rawat; Peserta: kelas_rawat", "lemah",
           catatan="Diperbaiki 27 Okt 2026: aturan dulu mencari \"Kelas 1\" padahal data peserta menulis \"KELAS I\", sehingga tidak pernah cocok. "
                   "Berlaku pada penandaan otomatis berikutnya."),
        _r("klaim_kembar_lintas_peserta", "penanda", "Klaim kembar lintas peserta (cloning)", "klaim", "KLONING_KLAIM",
           "rawat inap identik lintas peserta di faskes dan tahun sama: diagnosis, INA-CBG, prosedur, lama rawat (≥ 2 hari) dan tagihan sama; tagihan bukan tarif paket",
           "Klaim yang disalin dari klaim pasien lain.", "Klaim FKRTL (Data Bersih)", "sedang bila tanpa prosedur dan ≥ 7 hari, atau ≥ 4 peserta sebulan"),
        _r("faskes_klaim_kembar", "penanda", "Faskes dengan klaim kembar", "faskes", "KLONING_KLAIM", "faskes yang punya klaster klaim kembar lintas peserta",
           "Cloning di tingkat faskes.", "klaster klaim kembar", "sedang bila ada klaster kuat atau ≥ 3 klaster"),
        # 4 · the Box Karantina's estimate of one tagged claim
        _r("kerugian_di_atas_tarif", "kerugian", "Tagihan di luar tarif", "klaim", None,
           f"bagian tagihan di luar tarif INA-CBG + top-up (> {sisa}), paling banyak yang dibayar", "Uang yang dibayar tanpa dasar tarif.",
           "Klaim Berisiko: sisa_di_luar_tarif_rp", keterbatasan="Tidak untuk skema COVID-19."),
        _r("kerugian_di_atas_peer", "kerugian", f"Dibayar di atas {str(K.PEER_BAND).replace('.', ',')}× median peer setarif", "klaim", None,
           f"maks(0, dibayar − {str(K.PEER_BAND).replace('.', ',')} × median peer setarif); hanya bila ≥ 30 klaim peer", "Bayaran jauh di atas klaim yang tarif paketnya sama.",
           "Klaim Berisiko: biaya_verifikasi_rp, peer_biaya_p50_rp, peer_klaim", keterbatasan="Tidak untuk skema COVID-19."),
        _r("kerugian_klaim_ganda", "kerugian", "Separuh pembayaran klaim ganda", "klaim", None,
           f"{int(K.DUPLICATE_SHARE * 100)}% yang dibayar, bila bertag klaim ganda atau cloning", "Dari sepasang klaim ganda, satu yang sah.", "tag KLAIM_GANDA / KLONING_KLAIM"),
        _r("kerugian_ekspektasi_model", "kerugian", "Ekspektasi koreksi model ML", "klaim", None,
           "risiko ML × tagihan × rasio koreksi median verifikator", "Perkiraan bagian tagihan yang akan dikoreksi, menurut model.", "Skor ML klaim"),
    ]


def _fact_counts() -> dict[str, int]:
    """Each fact flag's count over every claim (the live type Klaim FKRTL, when it reads the facts dataset)."""
    import ontology
    import ontology_live

    t = next((x for x in ontology._all("object-types") if x["display_name"] == "Klaim FKRTL (BPJS)"), None)
    m = ontology_live.meta(t["id"]) if t else None
    if not m:
        return {}
    have = set(m["columns"].values())
    flags = [r["kolom"] for r in _rules() if r["lapisan"] == "fakta" and r.get("kolom") in have]
    if not flags:
        return {}
    cols = {a: c for c, a in m["columns"].items()}
    row = ontology_live._cur().execute(
        f"SELECT {', '.join(f'count(*) FILTER (WHERE {ontology_live._q(cols[f])})' for f in flags)} FROM {ontology_live._source(m)}").fetchone()
    return dict(zip(flags, (int(x) for x in row)))


def _screen_counts() -> dict[str, int]:
    rows = I._objects(S.T_KLAIM)
    return {"flag_calon_klaim_ganda": sum(1 for r in rows if r.get("flag_calon_klaim_ganda")),
            "flag_selisih_verifikasi": sum(1 for r in rows if r.get("flag_selisih_verifikasi")),
            "flag_los_ekstrem": sum(1 for r in rows if r.get("flag_los_ekstrem"))}


def catalogue() -> dict:
    with _lock:
        hit = _cache.get("all")
        if hit and time.time() - hit[0] < TTL:
            return hit[1]
    rules = _rules()
    state = (I._state().get("otomatis") or {})
    tagged = state.get("aturan") or {}
    try:
        facts = _fact_counts()
    except Exception:  # noqa: BLE001 - the explanation stands without the counts
        facts = {}
    try:
        screen = _screen_counts()
    except Exception:  # noqa: BLE001
        screen = {}
    for r in rules:
        if r["lapisan"] == "penanda":
            r["temuan"] = tagged.get(r["id"], 0) if tagged else None  # a rule that found nothing in the last run: 0
            r["temuan_satuan"] = "objek ditandai"
        elif r["lapisan"] == "fakta" and r.get("kolom") in facts:
            r["temuan"], r["temuan_satuan"] = facts[r["kolom"]], "klaim"
        elif r["lapisan"] == "skrining" and r.get("kolom") in screen:
            r["temuan"], r["temuan_satuan"] = screen[r["kolom"]], "klaim"
    modes = [{"id": m["id"], "no": m["no"], "nama": m["nama"], "deteksi": m["deteksi"], "dasar": m["dasar"], "tag": m["tag"], "fokus": m["fokus"],
              "aturan": [r["id"] for r in rules if r.get("tag") and r["tag"] in (m["tag"] or [])]} for m in S.MODUS_PERMENKES]
    out = {"lapisan": [
        {"id": "fakta", "nama": "Fakta klaim", "arti": "Dihitung pipeline Fakta Klaim untuk setiap klaim. Fakta, bukan putusan."},
        {"id": "skrining", "nama": "Skrining pipeline", "arti": "Menentukan klaim mana yang menjadi objek Klaim Berisiko, dan skornya."},
        {"id": "penanda", "nama": "Penanda otomatis", "arti": "Aturan atas objek Nexus yang menulis tag Indikasi Fraud dengan kekuatan lemah/sedang/kuat."},
        {"id": "kerugian", "nama": "Estimasi kerugian", "arti": "Box Karantina: komponen terbesar per klaim bertag yang belum dikoreksi."}],
        "aturan": rules, "modus": modes, "kekuatan": S.KEKUATAN,
        "penandaan_terakhir": {"pada": state.get("pada"), "tag": state.get("tag"), "dicabut": state.get("dicabut")}}
    with _lock:
        _cache["all"] = (time.time(), out)
    return out
