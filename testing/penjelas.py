"""What the /testing page shows and what the LLM reads: claim, entity resolution, engine signals, Model 1 reasons,
Model 2 ring detail, the graph around the claim, and example claims built the way the simulator plants each scheme.
The simulator's own truth (`kebenaran`) and the shadow model trained on it (`adaptif`) are never shown nor sent."""
from __future__ import annotations

import hashlib
import logging
import json
import random
import re
from datetime import date, timedelta
from typing import Any, Optional

import numpy as np

import llm as LLM

log = logging.getLogger("testing.penjelas")
SEV3 = "Berat (rawat inap keparahan 3)"
UMUM_SEKUNDER = ["I10", "E11.9", "E78.5", "N18.9", "J44.9", "D64.9", "K21.9", "E87.6", "I50.9", "R50.9", "B37.0", "L03.9", "M54.5", "E66.9",
                 "F41.9", "J18.9", "N39.0", "K59.0", "R51", "G47.0", "I25.1", "E03.9", "K29.7", "H52.4", "J30.4", "M17.9", "E55.9", "D50.9",
                 "R05", "R10.4", "K76.0", "I48.9", "N40", "E87.1", "R53", "B34.9", "J06.9", "L30.9", "M79.1", "R42", "E83.5", "K80.2", "G43.9",
                 "I95.9", "Z99.2"]


def _modes() -> tuple[dict, dict]:
    from aip.realtime import modus as M

    return M.MODES, M.SIGNALS


# ----------------------------------------------------------------------------------------------------------------------
# small views
# ----------------------------------------------------------------------------------------------------------------------
def samar(pid: Any) -> str:
    s = str(pid)
    return f"P-{hashlib.md5(s.encode()).hexdigest()[:5].upper()}"


def label_rs(x: Optional[str]) -> Optional[str]:
    """'A (A)' (a name equal to its profile label, from earlier test claims) shown once."""
    m = re.match(r"^(.*) \((.*)\)$", x or "")
    return m.group(1) if m and m.group(1) == m.group(2) else x


def ringkas(e: dict) -> dict:
    ditandai = e.get("keputusan") in ("TAHAN", "PERIKSA")
    modes, _ = _modes()
    return {"tgl": (e.get("tgl_datang") or "")[:10], "rs": label_rs(e.get("faskes_label")) or e.get("faskes"), "faskes": e.get("faskes"),
            "kode": e.get("kode"), "dx": e.get("dx3"), "biaya": e.get("biaya"), "keputusan": e.get("keputusan"), "peserta": e.get("peserta"),
            "tingkat": e.get("tingkat"), "los": e.get("los"),
            "modus": [f"{m} {modes.get(m, {}).get('nama', '')}".strip() for m in e.get("modus") or []] if ditandai else [],
            "alasan": alasan_rule(e) if ditandai else []}


def alasan_rule(e: dict, n: int = 3) -> list[dict]:
    """Why the automatic check held or flagged a stream claim: its strongest findings in plain words, with their Permenkes
    modes. Long digit runs in the evidence (possible member numbers) keep only their last four digits."""
    _, sigs = _modes()
    out = []
    for s in sorted(e.get("sinyal") or [], key=lambda s: -float(s.get("kontribusi") or 0))[:n]:
        kode = s.get("kode")
        out.append({"temuan": TEMUAN_AWAM.get(kode) or s.get("label") or "temuan pemeriksaan otomatis",
                    "modus": list(s.get("modus") or (sigs.get(kode) or [[]])[0]),
                    "bukti": re.sub(r"\d{3,}(\d{4})\b", r"…\1", s.get("bukti") or "")[:240], "dimitigasi": bool(s.get("mitigasi"))})
    return out


def daftar_rs(rp: Any) -> list[dict]:
    """Hospital profiles of the stream (the engine's own profile key), most claims first."""
    cols = ["kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl"]
    g = rp.groupby(cols, dropna=False).agg(n=("kunjungan_fkrtl_id", "size"), kabkota=("kabkota_fkrtl", "first"), provinsi=("provinsi_fkrtl", "first"),
                                             regional=("regional_tarif", "first")).reset_index().sort_values("n", ascending=False)
    out = []
    for r in g.itertuples(index=False):
        parts = ["FKRTL", str(int(r.kabkota_fkrtl_kode)) if r.kabkota_fkrtl_kode == r.kabkota_fkrtl_kode else None, r.kepemilikan_fkrtl, r.jenis_fkrtl,
                 r.tipe_fkrtl if isinstance(r.tipe_fkrtl, str) else None]
        pid = hashlib.md5("|".join(p for p in parts if p is not None).encode("utf-8")).hexdigest()
        label = " · ".join(x for x in (r.tipe_fkrtl if isinstance(r.tipe_fkrtl, str) else r.jenis_fkrtl, r.kepemilikan_fkrtl, r.kabkota) if x)
        out.append({"id": pid, "label": label, "kabkota_kode": int(r.kabkota_fkrtl_kode), "kabkota": r.kabkota, "provinsi": r.provinsi,
                    "kepemilikan": r.kepemilikan_fkrtl, "jenis": r.jenis_fkrtl, "tipe": r.tipe_fkrtl if isinstance(r.tipe_fkrtl, str) else None,
                    "regional": r.regional if isinstance(r.regional, str) else None, "klaim": int(r.n)})
    return out


def engine_info(rec: dict) -> dict:
    modes, sigs = _modes()
    sinyal = []
    for s in rec.get("sinyal") or []:
        sinyal.append({"kode": s.get("kode"), "label": s.get("label") or (sigs.get(s.get("kode")) or [None, None, None, s.get("kode")])[3],
                       "bukti": s.get("bukti"), "kontribusi": round(float(s.get("kontribusi") or 0), 3),
                       "modus": [f"{m} {modes.get(m, {}).get('nama', '')}".strip() for m in (sigs.get(s.get("kode")) or [[]])[0]],
                       "temuan": TEMUAN_AWAM.get(s.get("kode")) or s.get("label"), "dimitigasi": bool(s.get("mitigasi"))})
    return {"keputusan": rec.get("keputusan"), "skor": rec.get("skor"), "sinyal": sinyal,
            "modus": [f"{m} {modes.get(m, {}).get('nama', '')}".strip() for m in rec.get("modus") or []],
            "model_produksi_pct": (rec.get("ml") or {}).get("risiko_pct")}


def entitas_info(ent: dict, f: Any) -> dict:
    out = {"mode": f.pasien_mode, "peserta": samar(ent.get("peserta_id")), "aturan": ent.get("aturan") or ent.get("rule"),
           "skor": ent.get("skor") or ent.get("score"), "entitas": ent.get("entitas"), "catatan": ent.get("catatan") or ent.get("flags") or []}
    if f.pasien_mode == "baru":
        out["nama_tersamar"] = (f.nama_pasien[:1] + "***") if f.nama_pasien else ""
        out["no_rm"] = f.no_rm
    return out


def klaim_info(rec: dict, k: Any) -> dict:
    from aip.realtime import mesin as E

    los_ref = E.ENGINE.los_ref.get(k.inacbg_kode)
    tarif_ref = E.ENGINE.tarif_ref.get(k.inacbg_kode)
    return {"rs": label_rs(rec.get("faskes_label")), "kode": k.inacbg_kode, "deskripsi_kode": k.inacbg_deskripsi, "keparahan": k.inacbg_keparahan,
            "dx": k.dx_primer_kode or k.dx_primer_icd3, "tingkat": k.tingkat_pelayanan, "tgl_datang": str(k.tgl_datang),
            "tgl_pulang": str(k.tgl_pulang) if k.tgl_pulang else None, "los": k.los_hari, "los_median_kode": los_ref[0] if los_ref else None,
            "los_p90_kode": los_ref[1] if los_ref else None, "biaya": k.biaya_tagih_rp, "tarif": k.tarif_inacbg_rp, "tarif_median_kode": tarif_ref,
            "kelas_rawat": k.kelas_rawat, "status_pulang": k.status_pulang, "dx_sekunder": k.jumlah_dx_sekunder, "prosedur": k.prosedur,
            "topup": {c: getattr(k, c) for c in ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp") if getattr(k, c)}}


# ML v7's mechanism features (testing/fitur_v4.py NAMES) in plain words
NAMA_X4 = {
    "v4: domisili_fktp_jarak": "jarak FKTP terdaftar peserta ke RS", "v4: domisili_tinggal_jarak": "jarak domisili peserta ke RS",
    "v4: ganda_dekat": "klaim peserta yang sama di RS dan kode sama (±3 hari)", "v4: ganda_dekat_biaya_mirip": "klaim hampir identik (±1 hari, tagihan ±5%)",
    "v4: peserta_hari_sama_rs_lain": "klaim peserta di RS lain pada hari berdekatan", "v4: klon_mirip_3h": "klaim kembar peserta lain di RS sama (±3 hari)",
    "v4: klon_mirip_14h": "klaim kembar peserta lain di RS sama (±14 hari)", "v4: los_rasio_median_kode": "lama rawat dibanding biasanya untuk kode ini",
    "v4: los_di_bawah_p10": "lama rawat sangat pendek untuk kode ini", "v4: los_di_bawah_p25": "lama rawat pendek untuk kode ini",
    "v4: readmisi_setelah_rawat_pendek": "masuk lagi setelah rawat pendek", "v4: readmisi_jeda_hari": "jeda masuk lagi (hari)",
    "v4: readmisi_rs_sama": "masuk lagi di RS yang sama", "v4: readmisi_dx_sama": "masuk lagi dengan diagnosis sama",
    "v4: rs_los_rasio_drift": "lama rawat RS bergeser dari biasanya", "v4: rs_sev3_drift": "porsi keparahan III RS bergeser dari biasanya",
    "v4: rs_rawat_pendek_drift": "porsi rawat pendek RS bergeser dari biasanya", "v4: rs_n_rawat_inap_jendela": "jumlah rawat inap RS di periode ini (log)",
    "v4: topup_rasio_median_kode": "top-up dibanding biasanya untuk kode ini", "v4: topup_kode_jarang": "seberapa lazim top-up pada kode ini",
    "v4: dx_sekunder_di_atas_p90": "diagnosis sekunder di atas kebiasaan kode", "v4: biaya_rasio_median_kode": "tagihan dibanding biasanya untuk kode ini",
}


def _nama_fitur(n: str) -> str:
    if n in NAMA_X4:
        return NAMA_X4[n]
    _, sigs = _modes()
    m = re.match(r"^(tetangga [^:]+: )?(.*)$", n)
    pre, base = (m.group(1) or ""), m.group(2)
    if base.startswith("s:"):
        code = base[2:]
        base = "sinyal rule " + (sigs.get(code) or [None, None, None, code])[3]
    else:
        base = {"ml_log_risiko": "skor model produksi (log)", "ml_kelipatan": "kelipatan risiko model produksi", "log_biaya": "biaya (log)",
                "skor_aturan": "skor rule engine", "skor_tanpa_mitigasi": "skor rule sebelum mitigasi", "mitigasi_n": "jumlah mitigasi"}.get(base, base)
    return (pre + base).replace("tetangga ", "rata-rata tetangga ")


def alasan_model1(contrib: np.ndarray, x: np.ndarray, names: list[str], top: int = 8) -> list[dict]:
    c = contrib[:-1]
    idx = np.argsort(-c)[:top]
    return [{"fitur": _nama_fitur(names[i]), "nilai": None if not np.isfinite(x[i]) else round(float(x[i]), 3), "kontribusi": round(float(c[i]), 3)}
            for i in idx if c[i] > 0]


def ring_info(st: Any, i: int, labels: dict) -> dict:
    out = {}
    for W in (7, 14, 30):
        rs, co, nh, inter = st.ring_detail(i, W)
        out[f"w{W}"] = {"peserta_lain_berbagi_maks": rs, "peserta_lain_berbagi_total": co, "rs_lain_dikunjungi": nh,
                        "rs": sorted([{"rs": labels.get(g, g), "faskes": g, "berbagi": len(v), "peserta": [samar(p) for p in sorted(v, key=str)[:12]]}
                                      for g, v in inter.items()], key=lambda r: -r["berbagi"])[:8]}
    return out


# ----------------------------------------------------------------------------------------------------------------------
# the LLM's explanation of a flagged claim
# ----------------------------------------------------------------------------------------------------------------------
def modus_daftar() -> dict[str, str]:
    """The 20 modes of Permenkes 16/2019 as the engine numbers them (M19 inflated bills = M07)."""
    modes, _ = _modes()
    out = {k: v.get("nama", k) for k, v in sorted(modes.items())}
    out.setdefault("M19", "Inflated bills (sama dengan M07)")
    return dict(sorted(out.items()))


POLA_LAIN = {"kode": "-", "nama": "Pola tidak lazim (perlu telaah)"}
# signal findings in words a lay reader follows (the engine's own labels stay in the technical view)
TEMUAN_AWAM = {
    "ANOMALI_SSL": "Pola klaim ini jarang ditemui dibanding klaim sejenis",
    "SKOR_ML": "Model risiko menilai klaim ini jauh lebih berisiko dari biasanya",
    "CINCIN_FASKES": "Banyak peserta yang sama berobat di beberapa RS yang sama dalam waktu berdekatan",
    "KLAIM_GANDA_STREAM": "Klaim yang sama (peserta, RS, tanggal, dan kode) sudah pernah diajukan",
    "KLAIM_GANDA_RIWAYAT": "Klaim yang sama sudah ada di riwayat klaim",
    "KLAIM_BERULANG_MIRIP": "Klaim yang hampir sama diajukan lagi dengan tanggal digeser",
    "READMISI": "Pasien masuk lagi ke RS yang sama tak lama setelah pulang",
    "READMISI_DX_SAMA": "Pasien dirawat lagi untuk diagnosis yang sama tak lama setelah pulang",
    "RAWAT_INAP_TUMPANG_TINDIH": "Pasien tercatat dirawat inap di dua RS pada hari yang sama",
    "KARTU_BANYAK_FASKES": "Kartu peserta dipakai di beberapa RS dalam waktu berdekatan",
    "MENINGGAL_TERCATAT": "Ada klaim baru setelah peserta tercatat meninggal",
    "KLAIM_SETELAH_MENINGGAL": "Ada klaim baru setelah peserta tercatat meninggal",
    "KUNJUNGAN_SETELAH_MENINGGAL": "Ada kunjungan setelah peserta tercatat meninggal",
    "KARTU_KELUARGA": "Kartu anggota keluarga lain tampaknya dipakai",
    "TIDAK_SESUAI_PESERTA": "Diagnosis tidak cocok dengan jenis kelamin atau umur peserta",
    "KELAS_DI_ATAS_HAK": "Pasien dirawat di kelas yang lebih tinggi dari haknya",
    "DX_SEKUNDER_BERLEBIH": "Jumlah diagnosis tambahan jauh di atas kebiasaan untuk kasus ini",
    "LONJAKAN_KEPARAHAN": "RS ini tiba-tiba banyak menagih kasus berat (keparahan III)",
    "TOPUP_TIDAK_LAZIM": "Ada tambahan biaya obat/alat khusus yang hampir tidak pernah ada untuk kasus ini",
    "TOPUP_DI_ATAS_PEER": "Tambahan biaya obat/alat khusus jauh lebih mahal dari RS lain",
    "TAGIHAN_MELEBIHI_TARIF": "Tagihan RS jauh melebihi tarif paket INA-CBG",
    "KODE_PROSEDUR_TANPA_TINDAKAN": "Kode yang dipakai adalah paket tindakan, tetapi tidak ada tindakan yang tercatat",
    "PASANGAN_KODE_LANGKA": "Kode paket hampir tidak pernah dipakai untuk diagnosis seperti ini",
    "KLONING_LINTAS_PESERTA": "Klaim yang sama persis muncul pada beberapa peserta berbeda",
    "PEMECAHAN_EPISODE": "Satu perawatan tampaknya dipecah menjadi dua klaim",
    "EPISODE_HARI_SAMA": "Ada rawat jalan dan rawat inap di hari yang sama",
    "LOS_DIPERPANJANG": "Lama rawat jauh lebih panjang dari biasanya untuk kasus ini",
    "LOS_FASKES_BERGESER": "Lama rawat di RS ini memanjang dibanding biasanya",
    "KONSENTRASI_RUJUKAN": "Rujukan dari FKTP terkumpul ke satu RS secara tidak wajar",
    # against the hospital's electronic medical record (SATUSEHAT)
    "RME_KUNJUNGAN_TIDAK_ADA": "Rekam medis rumah sakit tidak mencatat kunjungan pasien pada tanggal yang ditagih",
    "RME_JENIS_RAWAT_BERBEDA": "Ditagih sebagai rawat inap, padahal rekam medis hanya mencatat rawat jalan atau IGD",
    "RME_LOS_TIDAK_SESUAI": "Lama rawat yang ditagih lebih panjang dari yang tercatat di rekam medis",
    "RME_PASIEN_BERBEDA": "Pasien di rekam medis berbeda dari pemilik kartu (jenis kelamin atau tanggal lahir)",
    "RME_TINDAKAN_TIDAK_TERCATAT": "Tindakan yang ditagih tidak tercatat di rekam medis rumah sakit",
    "RME_KLINIS_TIDAK_MENDUKUNG": "Rekam medis tidak memuat alasan medis untuk tindakan yang ditagih",
    "RME_DIAGNOSIS_TIDAK_TERCATAT": "Diagnosis yang ditagih tidak tercatat di rekam medis rumah sakit",
    "RME_DIAGNOSIS_TIDAK_DIDUKUNG": "Diagnosis yang ditagih dibantah hasil pemeriksaan di rekam medis",
    "RME_OBAT_ALKES_TIDAK_TERCATAT": "Obat atau alat yang ditagih tidak tercatat di rekam medis",
    "RME_KELAS_BERBEDA": "Kelas rawat yang ditagih lebih tinggi dari kelas yang tercatat di rekam medis",
    "RME_EPISODE_DIPECAH": "Satu kali rawat inap di rekam medis ditagih sebagai beberapa klaim",
    "RME_KUNJUNGAN_DIPAKAI_ULANG": "Kunjungan yang sama di rekam medis sudah ditagih oleh klaim lain",
    "RME_RAWAT_INAP_TANPA_INDIKASI": "Pasien dirawat inap padahal semua hasil pemeriksaannya normal sejak masuk",
    "RME_VENTILASI_TIDAK_SESUAI": "Ventilasi 96 jam atau lebih ditagih, padahal rekam medis mencatat ventilasi kurang dari 96 jam",
    "RME_HARI_ICU_LEBIH": "Hari ICU yang ditagih lebih banyak dari hari pasien tercatat di ICU dalam rekam medis",
    "RME_OBAT_JUMLAH_KURANG": "Jumlah obat yang ditagih lebih banyak dari yang tercatat diserahkan atau diberikan di rekam medis",
    "RME_READMISI_TERENCANA": "Pasien dirawat ulang secara terencana tanpa kebutuhan klinis yang tercatat di rekam medis",
    "RME_READMISI_PULANG_DINI": "Pasien masuk lagi tak lama setelah dipulangkan dalam keadaan yang belum stabil menurut rekam medis",
    "RME_RUJUKAN_TANPA_INDIKASI": "Pasien dirujuk dari RS lain tanpa alasan klinis yang tercatat di rekam medis",
    "RME_DOKTER_PASIEN_DIPUTAR": "Pasien berpindah RS mengikuti satu dokter yang sama",
    # against the hospital's device evidence (current clamp on the power cable, the device never opened: on-time, duration, state
    # jalan / siaga / mati; api/aip/realtime/iot.py). IOT_MODE_NONINVASIF only from a mode the ventilator itself reported
    "IOT_VENTILASI_KURANG_96": "Ventilasi ≥ 96 jam berturut-turut ditagih, padahal sensor clamp pada kabel daya ventilator tidak pernah mencatat alat jalan 96 jam tanpa putus",
    "IOT_MODE_NONINVASIF": "Mode ventilasi yang ditagih berbeda dari mode yang dilaporkan ventilator itu sendiri (bukan dari sensor clamp)",
    "IOT_VENTILATOR_STANDBY": "Ventilasi ditagih, padahal sensor clamp mencatat ventilator hanya menyala siaga dan tidak pernah jalan memberi napas",
    "IOT_HD_SESI_SINGKAT": "Sesi cuci darah ditagih penuh, padahal mesin hemodialisis berjalan kurang dari 3 jam",
    "IOT_HD_TANPA_SESI": "Sesi cuci darah ditagih lebih banyak dari sesi yang dijalankan mesin hemodialisis",
    "IOT_HARI_ICU_LEBIH": "Hari ICU yang ditagih lebih banyak dari hari bed/monitor ICU pasien ini menyala",
    "IOT_TANPA_JEJAK": "Pemakaian alat ditagih, padahal alat bersensor di RS ini tidak mencatat sesi apa pun untuk pasien ini",
    "IOT_BINDING_TUMPANG": "Satu alat tercatat terikat ke dua pasien pada jam yang sama",
    "IOT_TANPA_PASIEN": "Ada alat di RS ini yang berjalan lama tanpa pasien yang terikat",
    "IOT_JANGKAR_TIDAK_COCOK": "Catatan alat yang dikirim tidak cocok dengan catatan yang dikunci (dijangkarkan) sebelumnya",
    "IOT_JANGKAR_TERLAMBAT": "Catatan alat baru dikunci (dijangkarkan) setelah klaim diajukan",
    "IOT_KUNCI_DICABUT": "Catatan alat ditandatangani kunci perangkat yang sudah dicabut",
}
LEGENDA_GRAPH = (
    "Cara graph digambar di layar: klaim yang dinilai = ikon dokumen dengan garis tepi merah (klaim ini); klaim lain = ikon "
    "dokumen (abu-abu = lolos pemeriksaan otomatis, oranye = perlu diperiksa, merah = ditahan); peserta = lingkaran berikon orang "
    "(kode samaran P-xxxxx); rumah sakit = kotak biru bertanda plus; kode INA-CBG = belah ketupat ungu. Garis menghubungkan klaim ke "
    "pesertanya, ke RS-nya, dan ke kodenya. Tombol 'Model 1' menyorot klaim pembanding; tombol 'Jaringan RS' menyorot RS lain yang "
    "dikunjungi peserta dalam 14 hari dan peserta lain yang berbagi RS-RS itu.")


def llm_siap() -> bool:
    return LLM.siap()


def _nama_modus(kode_sinyal: str) -> list[str]:
    _, sigs = _modes()
    daftar = modus_daftar()
    return [daftar["M07" if m == "M19" else m] for m in (sigs.get(kode_sinyal) or [[]])[0] if ("M07" if m == "M19" else m) in daftar]


def temuan(s: dict) -> str:
    return TEMUAN_AWAM.get(s.get("kode"), s.get("label") or "")


def ganti_kode(teks: Any) -> Any:
    """Internal signal codes (CINCIN_FASKES, KLAIM_GANDA_STREAM ...) in a text, replaced by the JKN mode or the plain finding."""
    if isinstance(teks, list):
        return [ganti_kode(x) for x in teks]
    if isinstance(teks, dict):
        return {k: ganti_kode(v) for k, v in teks.items()}
    if not isinstance(teks, str):
        return teks
    _, sigs = _modes()

    def kecil(x: str, awal: bool) -> str:
        return x if awal else x[:1].lower() + x[1:]

    def ganti(m: re.Match) -> str:
        k = m.group(0)
        awal = m.start() == 0 or m.string[max(0, m.start() - 2):m.start()].strip() in (".", ":", "")
        if k in TEMUAN_AWAM:
            return kecil(TEMUAN_AWAM[k], awal)
        if k in sigs:
            n = _nama_modus(k)
            return kecil(n[0], awal) if n else k.replace("_", " ").lower()
        return k

    # a code: one word of 4+ capitals, or 3+ capitals joined by underscores (RME_TINDAKAN_TIDAK_TERCATAT has a 3-letter head)
    kode = r"(?:[A-Z]{4,}(?:_[A-Z]{2,})*|[A-Z]{3}(?:_[A-Z]{2,})+)"
    t = re.sub(r"\b(?i:sinyal|signal)\s+(?i:rule\s+)?(?=" + kode + r"\b)", "", teks)
    return re.sub(r"\b" + kode + r"\b", ganti, t)


# modes that need a hard finding (a rule finding mapped to the mode, or for M10 members shared by the hospitals); the
# others (upcoding, inflated bills, length of stay, indication ...) may be read from the claim's own figures
BUTUH_TEMUAN = {"M05", "M06", "M10", "M11", "M13", "M14", "M16", "M17", "M18", "M20"}


def bukti_jaringan(h: dict) -> bool:
    w7, w14 = h["ring"]["w7"], h["ring"]["w14"]
    return bool(h["alert_ring"]) or w7["peserta_lain_berbagi_maks"] >= 3 or w14["peserta_lain_berbagi_maks"] >= 4


def modus_berbukti(h: dict) -> set[str]:
    """The modes the rule findings and the hospital network support."""
    _, sigs = _modes()
    out = {("M07" if m == "M19" else m) for s in h["engine"]["sinyal"] for m in (sigs.get(s["kode"]) or [[]])[0]}
    if bukti_jaringan(h):
        out.add("M10")
    return out


def kandidat_modus(h: dict) -> list[dict]:
    """Modes the evidence points to: the rule findings' modes (by weight), M10 when the hospital network stands out."""
    _, sigs = _modes()
    daftar = modus_daftar()
    out: list[dict] = []
    for s in sorted(h["engine"]["sinyal"], key=lambda s: -s["kontribusi"]):
        for m in (sigs.get(s["kode"]) or [[]])[0]:
            m = "M07" if m == "M19" else m
            if m in daftar and all(x["kode"] != m for x in out):
                out.append({"kode": m, "nama": daftar[m], "dari": temuan(s)})
    w7 = h["ring"]["w7"]
    if bukti_jaringan(h) and all(x["kode"] != "M10" for x in out):
        out.append({"kode": "M10", "nama": daftar["M10"], "dari": f"{w7['peserta_lain_berbagi_maks']} peserta lain berobat di RS-RS yang sama dalam 7 hari"})
    lp = _los_pembanding(h)  # a hospital-wide stretch of stays (M12), even when this claim alone looks ordinary
    salinan = any(s["kode"] in ("KLONING_LINTAS_PESERTA", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP") for s in h["engine"]["sinyal"])
    if not salinan and (lp.get("rasio_terhadap_biasanya") or 0) >= 1.5 and lp["klaim_rs_kode_sama"] >= 3 and all(x["kode"] != "M12" for x in out):
        out.append({"kode": "M12", "nama": daftar["M12"], "dari": f"{lp['klaim_rs_kode_sama']} klaim lain di RS ini dengan kode sama rata-rata dirawat "
                                                                  f"{lp['rata_rata_hari']} hari, biasanya {lp['biasanya_untuk_kode_ini_median']} hari"})
    return out


def _konteks(h: dict) -> dict:
    g = h["graf"]
    ring_klaim = [n for n in g["nodes"] if n["tipe"] == "klaim" and "model2" in (n.get("sorot") or [])]
    fokus = next((n for n in g["nodes"] if n.get("fokus")), {})
    jaringan = {"simpul": {t: sum(1 for n in g["nodes"] if n["tipe"] == t) for t in ("klaim", "peserta", "rs", "kode")},
                "klaim_ini": {k: fokus.get(k) for k in ("tgl", "kode", "rs", "peserta", "keputusan")},
                "klaim_lain_peserta_ini": [{k: n.get(k) for k in ("tgl", "kode", "rs", "keputusan", "biaya")} for n in g["nodes"]
                                           if n["tipe"] == "klaim" and not n.get("fokus") and n.get("peserta") == fokus.get("peserta")][:12],
                "klaim_ditahan_di_graph": sum(1 for n in g["nodes"] if n["tipe"] == "klaim" and n.get("keputusan") == "TAHAN"),
                "klaim_jaringan_rs_14_hari": [{k: n.get(k) for k in ("tgl", "kode", "rs", "peserta", "keputusan")} for n in ring_klaim[:20]],
                "rs_lain_dalam_jaringan": [{"rs": r["rs"], "peserta_lain_yang_sama": r["berbagi"]} for r in h["ring"]["w14"]["rs"][:5]]}
    en = h["engine"]
    pemeriksaan = {"keputusan": {"TAHAN": "ditahan", "PERIKSA": "perlu diperiksa", "LOLOS": "lolos"}.get(en["keputusan"], en["keputusan"]),
                   "temuan": [{"temuan": temuan(s), "modus": _nama_modus(s["kode"]), "detail": ganti_kode(s.get("bukti") or ""),
                               "bobot": s["kontribusi"]} for s in en["sinyal"]]}
    k = h["klaim"]
    klaim = {**{x: k.get(x) for x in ("rs", "kode", "deskripsi_kode", "keparahan", "dx", "tingkat", "tgl_datang", "tgl_pulang", "los", "biaya",
                                       "tarif", "kelas_rawat", "status_pulang", "dx_sekunder", "topup")},
             "los_biasanya_untuk_kode_ini": {"median": k.get("los_median_kode"), "p90": k.get("los_p90_kode")}, "tarif_biasanya_untuk_kode_ini": k.get("tarif_median_kode")}
    return {"klaim": klaim, "entity_resolution": h["entitas"],
            "keputusan_model": {"peluang_fraud": h["peluang"], "ambang": h["ambang_peluang"], "model1_pembanding": h["model1"],
                                "model2_jaringan_rs": h.get("model2"), "alert_jaringan_rs": h["alert_ring"],
                                # architecture v2: which layer saw it (rule, Permenkes-family specialists, graph, ring) and the rule route
                                "lapisan_yang_menandai": [LAPISAN_AWAM.get(k, k) for k, v in (h.get("lapisan") or {}).items() if v >= 0.5],
                                "rute_rule_sinyal_baru": bool(h.get("rute_rule")),
                                # ML v7: one model; its tier and how much of its push came from the claim itself, its graph
                                # neighbours (the comparison claims) and the fraud-mechanism features
                                "arsitektur": h.get("arsitektur"), "tingkat_model": h.get("tier"), "ambang_tahan": h.get("ambang_tahan"),
                                "porsi_dorongan_model": h.get("blok")},
            "kandidat_modus": kandidat_modus(h), "pemeriksaan_otomatis": pemeriksaan, "rekam_medis": _rme_konteks(h),
            "alasan_model1": [ganti_kode(a["fitur"]) for a in h["alasan_model1"][:6]], "jaringan_rs_model2": h["ring"],
            "klaim_pembanding_model1": h.get("tetangga", [])[:24], "lama_rawat_pembanding": _los_pembanding(h),
            "graph_di_layar": jaringan, "legenda_graph": LEGENDA_GRAPH}


def _rme_konteks(h: dict) -> dict:
    """The claim against the hospital's electronic medical record (SATUSEHAT), for the explanation: each checked item."""
    r = h.get("rme") or {}
    if not r.get("hasil"):
        return {"dikirim": False, "catatan": "rumah sakit tidak mengirim rekam medis elektronik untuk klaim ini"}
    st = {"cocok": "sesuai", "tidak_ada": "TIDAK ADA di rekam medis", "dibantah": "DIBANTAH hasil pemeriksaan", "tanpa_indikasi": "TANPA alasan medis",
          "info": "keterangan", "tidak_dicek": "tidak dicocokkan"}
    return {"dikirim": True, "kunjungan_di_rekam_medis": r.get("kunjungan"),
            "pencocokan": [{"aspek": x["aspek"], "di_klaim": x["klaim"], "di_rekam_medis": x["rme"], "hasil": st.get(x["status"], x["status"])}
                           for x in r["hasil"]][:30],
            "rule_rekam_medis": {"menandai_sendiri": bool((r.get("rute") or {}).get("aktif")), "tingkat": (r.get("rute") or {}).get("tingkat")}}


def _los_pembanding(h: dict) -> dict:
    """The stays of the same hospital's earlier claims with the same INA-CBG code (Model 1's "RS + kode" neighbours) against the
    usual stay of the code: a hospital-wide stretch of stays (M12) shows here even when this one claim looks ordinary."""
    los = [t["lama_rawat"] for t in h.get("tetangga", []) if t.get("relasi", "").startswith("RS + kode") and t.get("lama_rawat") is not None]
    k = h.get("klaim", {})
    out = {"klaim_rs_kode_sama": len(los), "rata_rata_hari": round(sum(los) / len(los), 1) if los else None,
           "biasanya_untuk_kode_ini_median": k.get("los_median_kode"), "p90": k.get("los_p90_kode")}
    if los and (k.get("los_median_kode") or 0) >= 1:  # inpatient codes only (an outpatient code's usual stay is 0)
        out["rasio_terhadap_biasanya"] = round(out["rata_rata_hari"] / max(1e-9, float(k["los_median_kode"])), 2)
    return out


LAPISAN_AWAM = {"rule": "pemeriksaan otomatis (rule)", "koding": "spesialis coding diagnosis dan tindakan (M04, M14, M15, M20)",
                "tagihan": "spesialis tagihan, kelas rawat dan obat/alkes (M07, M13, M17, M18)", "episode": "spesialis episode dan lama rawat (M08, M09, M12, M16)",
                "identitas": "spesialis identitas peserta dan duplikasi (M05, M06, M11)", "model1": "perbandingan dengan klaim tetangga di graph",
                "model2": "pola jaringan RS (M10)"}


def _sistem() -> str:
    daftar = modus_daftar()
    return (
        "Kamu verifikator senior BPJS Kesehatan (JKN) yang menjelaskan klaim rumah sakit (FKRTL) yang ditandai sistem deteksi fraud. "
        "Datanya SINTETIS. Gunakan HANYA bukti di konteks. Jangan mengarang fakta.\n"
        "BAHASA: Indonesia sederhana yang dipahami orang awam. Jangan menulis kode internal (huruf besar bergaris bawah, mis. KLAIM_GANDA_STREAM), "
        "nama fitur, SHAP, VIME, 'galat rekonstruksi', persentil ('p99'), atau skor mentah tanpa arti. Setiap angka dijelaskan maknanya "
        "dibanding yang biasa, mis. 'lama rawat 9 hari, padahal biasanya 3 hari untuk kasus ini' atau 'tagihan Rp4,7 juta, sekitar 25% di atas biasanya'. "
        "Sebut jenis fraud dengan nama modus JKN di bawah.\n"
        "JENIS FRAUD: pilih 1 sampai 4 modus dari daftar Permenkes 16/2019 (kode: nama): "
        + "; ".join(f"{k}: {v}" for k, v in daftar.items()) + ". M19 sama dengan M07, pakai M07. "
        "Mulai dari kandidat_modus bila buktinya ada; tambah modus lain hanya dengan bukti konkret. M10 hanya bila PESERTA LAIN yang sama "
        "juga muncul di RS-RS yang sama (jaringan_rs_model2: peserta_lain_berbagi_maks), bukan karena satu peserta berobat di beberapa RS. "
        "M11 hanya bila pemeriksaan otomatis menemukan klaim yang sama; klaim lain dengan kode sama di RS yang sama adalah hal biasa. M05, M06, M13, M14, M16, M17 hanya bila ada temuan pemeriksaan otomatis yang sesuai. M12 juga boleh bila lama_rawat_pembanding.klaim_rs_kode_sama >= 3 dan rasio_terhadap_biasanya >= 1,5 (lama rawat klaim RS ini dengan kode yang sama jauh di atas biasanya, walau klaim ini sendiri tampak biasa), tetapi tidak bila klaim pembanding itu salinan klaim ini (klaim ganda atau kloning). Bila hanya model yang menandai tanpa modus yang cocok, pakai {\"kode\": \"-\", \"nama\": \"Pola tidak lazim (perlu telaah)\"}. "
        "Urutkan dari yang paling kuat.\n"
        "REKAM MEDIS: bila rekam_medis.dikirim, itu bukti terkuat. Tindakan klaim yang TIDAK ADA di rekam medis = M14; tindakan TANPA alasan medis = M15; "
        "diagnosis yang tidak ada atau DIBANTAH hasil pemeriksaan = M04; tidak ada kunjungan atau pasien berbeda = M06; lama rawat lebih panjang dari rekam medis = M12; "
        "obat/alat tidak ada = M17. Sebut angka hasil pemeriksaan yang membantah (mis. 'saturasi oksigen 97-99%, normal, padahal ditagih gagal napas'; "
        "'tekanan darah dan saturasi normal, troponin normal, tidak ada diagnosis jantung, padahal ditagih kateterisasi jantung'). "
        "Rekam medis yang tidak lengkap bukan bukti fraud sendirian: sebut sebagai kemungkinan wajar di catatan.\n"
        "Jawab HANYA satu objek JSON: {\"jenis_fraud\": [{\"kode\": \"Mxx\", \"nama\": nama dari daftar, \"keyakinan\": \"tinggi\"|\"sedang\"|\"rendah\", "
        "\"bukti\": satu kalimat sederhana}], \"ringkasan\": satu kalimat, "
        "\"penjelasan_awam\": SATU paragraf 3-4 kalimat pendek, paling banyak 80 kata: apa yang janggal, kenapa itu tanda fraud, dan apa yang bisa dilihat di graph untuk membuktikannya "
        "(sebut bentuk dan warna seperti di legenda_graph, mis. 'dokumen bergaris merah', 'lingkaran peserta P-xxxxx', 'kotak RS', 'dokumen merah'), "
        "\"alasan\": [3-5 kalimat bukti sederhana, masing-masing satu fakta dengan angka yang dijelaskan maknanya; jangan menyebut skor model atau peluang], "
        "\"perbaikan\": [3-5 langkah sederhana untuk verifikator: dokumen yang diminta, hal yang dicek, koreksi klaim bila terbukti], "
        "\"catatan\": satu kalimat tentang kemungkinan klaim ini sebenarnya wajar (false positive)}.\n"
        "Hasil ini untuk verifikator internal; jangan menulis kalimat yang ditujukan ke rumah sakit.")


def _rapikan_jenis(raw: Any, h: dict) -> list[dict]:
    """The modes checked against the list: canonical names, M19 to M07, no duplicates, at most four."""
    daftar = modus_daftar()
    items = raw if isinstance(raw, list) else ([raw] if raw else [])
    out: list[dict] = []
    for it in items:
        if isinstance(it, str):
            m = re.match(r"\s*(M\d{2})", it)
            it = {"kode": m.group(1) if m else "-", "nama": it}
        if not isinstance(it, dict):
            continue
        kode = str(it.get("kode") or "-").strip().upper()
        kode = "M07" if kode == "M19" else kode
        if kode not in daftar:
            kode = "-"
        if any(x["kode"] == kode for x in out):
            continue
        out.append({"kode": kode, "nama": daftar.get(kode, POLA_LAIN["nama"]), "keyakinan": str(it.get("keyakinan") or "sedang").lower(),
                    "bukti": ganti_kode(str(it.get("bukti") or "").strip())})
    ada = modus_berbukti(h)
    out = [x for x in out if x["kode"] not in BUTUH_TEMUAN or x["kode"] in ada]  # the evidence gate
    if not out:
        out = [{"kode": c["kode"], "nama": c["nama"], "keyakinan": "sedang", "bukti": c["dari"]} for c in kandidat_modus(h)[:3]] \
            or [{**POLA_LAIN, "keyakinan": "rendah", "bukti": ""}]
    return out[:4]


def _alasan_awam(h: dict) -> list[str]:
    """The evidence in plain sentences without the LLM."""
    k, w14 = h["klaim"], h["ring"]["w14"]
    out = [temuan(s) + "." for s in sorted(h["engine"]["sinyal"], key=lambda s: -s["kontribusi"]) if s["kontribusi"] > 0][:4]
    for x in ((h.get("rme") or {}).get("hasil") or []):
        if x["status"] in ("tidak_ada", "dibantah", "tanpa_indikasi") and len(out) < 8:
            out.append(f"{x['aspek']}: di klaim {x['klaim']}; di rekam medis {x['rme']}.")
    if k.get("los") and k.get("los_median_kode") and k["los"] >= 2 * max(1, k["los_median_kode"]):
        out.append(f"Lama rawat {k['los']} hari, padahal biasanya {k['los_median_kode']:g} hari untuk kasus ini.")
    if k.get("biaya") and k.get("tarif_median_kode") and k["biaya"] > 1.3 * k["tarif_median_kode"]:
        out.append(f"Tagihan {_rp(k['biaya'])}, sekitar {round(100 * (k['biaya'] / k['tarif_median_kode'] - 1))}% di atas biasanya untuk kode ini.")
    if h["alert_ring"] or w14["peserta_lain_berbagi_maks"] >= 3:
        out.append(f"Dalam dua minggu, peserta ini juga berobat di {w14['rs_lain_dikunjungi']} RS lain, dan {w14['peserta_lain_berbagi_maks']} peserta lain "
                   "berobat di RS-RS yang sama.")
    if not out:
        out.append("Klaim ini sangat mirip dengan klaim-klaim yang sebelumnya terbukti bermasalah.")
    return out


def _rp(v: Any) -> str:
    return "Rp" + f"{int(v):,}".replace(",", ".")


def _awam_cadangan(h: dict, jenis: list[dict]) -> str:
    """A plain paragraph without the LLM, from the same facts."""
    w14 = h["ring"]["w14"]
    kal = [f"Klaim ini (dokumen bergaris merah di graph) ditandai dengan peluang fraud {round(100 * h['peluang'])}%, "
           f"jenisnya mengarah ke {', '.join(j['nama'] for j in jenis)}."]
    top = [s for s in h["engine"]["sinyal"] if s["kontribusi"] > 0][:2]
    if top:
        kal.append("Yang ditemukan: " + "; ".join(temuan(s).lower() for s in top) + ".")
    if h["alert_ring"] or w14["peserta_lain_berbagi_maks"] >= 3:
        kal.append(f"Di graph, peserta yang sama terhubung ke {w14['rs_lain_dikunjungi']} RS lain dalam dua minggu, dan {w14['peserta_lain_berbagi_maks']} peserta "
                   "lain juga muncul di RS-RS yang sama: pola peserta yang diputar antar-RS (tekan tombol Jaringan RS untuk melihatnya).")
    else:
        kal.append("Di graph, ikuti garis dari klaim ini ke lingkaran pesertanya dan ke kotak RS-nya; klaim lain di sekitarnya adalah pembanding "
                   "yang dipakai model (dokumen merah = ditahan).")
    return " ".join(kal)


def _cadangan(h: dict, alasan: str) -> dict:
    """Without the LLM: the modes from the rule findings and the hospital network, the evidence in plain sentences."""
    log.warning("testing: plain explanation without AI (%s)", alasan)
    jenis = _rapikan_jenis(None, h)
    return {"status": "terdeteksi", "sumber": "aturan", "jenis_fraud": jenis, "keyakinan": jenis[0]["keyakinan"],
            "ringkasan": f"Klaim ditandai (peluang {h['peluang']:.0%}).", "penjelasan_awam": _awam_cadangan(h, jenis), "alasan": _alasan_awam(h),
            "perbaikan": _perbaikan(h),
            "catatan": "Penjelasan AI belum tersedia untuk klaim ini; ini ringkasan otomatis dari pemeriksaan sistem."}


def _perbaikan(h: dict) -> list[str]:
    rme = [x for x in ((h.get("rme") or {}).get("hasil") or []) if x["status"] in ("tidak_ada", "dibantah", "tanpa_indikasi")]
    if not rme:
        return ["Minta resume medis dan SEP klaim ini.", "Cocokkan dengan klaim lain dari peserta dan RS yang sama (lihat graph).",
                "Bila terbukti, koreksi atau batalkan klaim sesuai hasil verifikasi."]
    out = []
    if any(x["aspek"] in ("Tindakan", "Indikasi") for x in rme):
        out.append("Minta laporan tindakan/operasi yang ditandatangani operator dan dasar indikasinya (EKG, laboratorium, pencitraan), "
                   "lalu cocokkan dengan rekam medis SATUSEHAT.")
    if any(x["aspek"] in ("Diagnosis", "Dasar diagnosis") for x in rme):
        out.append("Minta resume medis dan hasil pemeriksaan yang menegakkan diagnosis yang ditagih.")
    if any(x["aspek"] in ("Kunjungan", "Jenis rawat", "Lama rawat", "Identitas pasien") for x in rme):
        out.append("Cocokkan tanggal masuk-pulang, jenis rawat dan identitas pasien di rekam medis dengan SEP terverifikasi.")
    out.append("Bila rekam medis tidak memuat yang ditagih, koreksi klaim ke layanan yang tercatat atau tolak bagian yang tidak terbukti.")
    return out


def jelaskan(h: dict, pakai_llm: bool = True) -> dict:
    if not pakai_llm:
        return _cadangan(h, "tidak diminta")
    if not LLM.siap():
        return _cadangan(h, "AI belum dikonfigurasi")
    msgs = [{"role": "system", "content": _sistem()},
            {"role": "user", "content": "Konteks klaim yang ditandai (JSON):\n" + json.dumps(_konteks(h), ensure_ascii=False, default=str)}]
    d, r = None, None
    for coba in range(2):
        try:
            r = LLM.panggil(msgs, LLM.TEKS, max_tokens=4500, reasoning="low", json_mode=True)
        except RuntimeError as e:
            return _cadangan(h, str(e))
        d = LLM.json_dari(r["teks"])
        if d and "jenis_fraud" in d:
            break
        msgs = msgs + [{"role": "assistant", "content": (r["teks"] or "")[:4000]},
                       {"role": "user", "content": "Jawaban tadi bukan satu objek JSON yang valid. Kirim ulang HANYA objek JSON sesuai format, tanpa teks lain."}]
    if not d or "jenis_fraud" not in d:
        return _cadangan(h, "jawaban AI tidak berbentuk JSON")
    d = ganti_kode(d)
    d["jenis_fraud"] = _rapikan_jenis(d.get("jenis_fraud"), h)
    d["keyakinan"] = d["jenis_fraud"][0]["keyakinan"]
    if not str(d.get("penjelasan_awam") or "").strip():
        d["penjelasan_awam"] = _awam_cadangan(h, d["jenis_fraud"])
    d["penjelasan_awam"] = _ringkas_paragraf(str(d["penjelasan_awam"]))
    d.update(status="terdeteksi", sumber=r["model"], biaya_usd=round(r["usd"], 5), detik=r["detik"])
    for k in ("alasan", "perbaikan"):
        if not isinstance(d.get(k), list):
            d[k] = [d[k]] if d.get(k) else []
    return d


def _ringkas_paragraf(t: str, maks_kata: int = 100, maks_kalimat: int = 4) -> str:
    """The plain paragraph kept short: whole sentences only, at most four, about a hundred words."""
    t = " ".join(t.split())
    if len(t.split()) <= maks_kata:
        return t
    kal = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", t)
    out = []
    for k in kal:
        if out and (len(out) >= maks_kalimat or len(" ".join(out + [k]).split()) > maks_kata):
            break
        out.append(k)
    return " ".join(out)


def nama_jenis(p: dict) -> str:
    """A short label of the modes (history list)."""
    j = (p or {}).get("jenis_fraud")
    if isinstance(j, list) and j:
        return j[0]["nama"] + (f" +{len(j) - 1}" if len(j) > 1 else "")
    return j if isinstance(j, str) else ""


# ----------------------------------------------------------------------------------------------------------------------
# example claims, built the way the simulator plants each scheme
# ----------------------------------------------------------------------------------------------------------------------
def _icd(k: Optional[str], icd3: Optional[str]) -> str:
    k = (k or icd3 or "").upper().replace(".", "")
    return k[:3] + ("." + k[3:] if len(k) > 3 else "")


def _rs_id(row: dict) -> str:
    parts = ["FKRTL", str(int(row["kabkota_fkrtl_kode"])), row.get("kepemilikan_fkrtl"), row.get("jenis_fkrtl"),
             row.get("tipe_fkrtl") if isinstance(row.get("tipe_fkrtl"), str) else None]
    return hashlib.md5("|".join(p for p in parts if p).encode("utf-8")).hexdigest()


def _ints(xs: Optional[list]) -> list[int]:
    out = []
    for x in xs or []:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            pass
    return out


def _kelas(row: dict) -> Optional[int]:
    k = str(row.get("kelas_rawat") or "")
    return int(k[-1]) if row.get("tingkat_pelayanan") == "RITL" and k[-1:].isdigit() else None


def _d(v: Any) -> date:
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def form_dari(row: dict, **ubah: Any) -> dict:
    ri = row.get("tingkat_pelayanan") == "RITL"
    n_sek = int(row.get("jumlah_dx_sekunder") or 0)
    top = next(((c[:2], int(row.get(c) or 0)) for c in ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp") if int(row.get(c) or 0) > 0), ("", 0))
    kelas = str(row.get("kelas_rawat") or "")
    f = {"pasien_mode": "terdaftar", "peserta_id": int(row["peserta_id"]), "nama_pasien": "", "no_rm": "", "no_sep": "",
         "segmen": row.get("segmen") if isinstance(row.get("segmen"), str) else None, "rs_id": _rs_id(row),
         "jenis_episode": "ri" if ri else ("igd" if row.get("poli") == "IGD" else "rj"), "tanggal_masuk": str(_d(row["tgl_datang"])),
         "tanggal_pulang": str(_d(row["tgl_pulang"])) if ri and row.get("tgl_pulang") is not None else str(_d(row["tgl_datang"])),
         "kelas_rawat": int(kelas[-1]) if kelas[-1:].isdigit() else None, "status_pulang": row.get("status_pulang") if isinstance(row.get("status_pulang"), str) else None,
         "diagnosis_utama": _icd(row.get("dx_primer_kode"), row.get("dx_primer_icd3")), "diagnosis_sekunder": UMUM_SEKUNDER[:min(n_sek, 10)],
         "tindakan": [p.strip() for p in str(row.get("prosedur") or "").split(";") if p.strip() and p.strip() != "None"][:20],
         "inacbg_kode": row["inacbg_kode"], "tarif_inacbg_rp": int(row["tarif_inacbg_rp"]) if row.get("tarif_inacbg_rp") == row.get("tarif_inacbg_rp") and row.get("tarif_inacbg_rp") is not None else None,
         "topup_jenis": top[0], "topup_rp": top[1], "biaya_tagih_rp": int(row["biaya_tagih_rp"] or 0), "templat": str(row.get("kunjungan_fkrtl_id") or "")}
    f.update(ubah)
    return f


def _anggota(eng: Any, sql: str, args: list) -> list[dict]:
    cur = eng.con.cursor()
    try:
        return cur.execute(sql, args).df().to_dict("records")
    finally:
        cur.close()


def _mirip(eng: Any, pid: int, rng: random.Random, hindari: Optional[list] = None, kelas: Optional[int] = None, fac: Optional[str] = None) -> int:
    """A member for a copied claim with an ordinary journey: a patient of the same hospital (a visit there in the history
    before the stream window), the same sex, an age within three years of the template's member, alive, an entitlement
    that allows the ward class, and no claim in the stream (so no overlap with another stay). Falls back step by step."""
    import pandas as pd

    from aip.realtime import mesin as E

    me = _anggota(eng, "SELECT jk, tgl_lahir FROM anggota WHERE edisi = ? AND peserta_id = ? LIMIT 1", [E.REPLAY_EDISI, pid])
    if not me:
        return pid
    cur = eng.con.cursor()
    try:
        cur.register("hindari", pd.DataFrame({"peserta_id": _ints(hindari) or [-1]}))
        for umur, pakai_rs in ((1095, True), (1825, True), (1095, False), (3650, False)):
            asal = ("(SELECT DISTINCT peserta_id FROM peserta WHERE edisi = ? AND faskes_profil_id = ?)" if (pakai_rs and fac) else
                    "(SELECT DISTINCT peserta_id FROM peserta WHERE edisi = ?)")
            args = [E.REPLAY_EDISI] + ([fac] if (pakai_rs and fac) else []) + [E.REPLAY_EDISI, me[0]["jk"], me[0]["tgl_lahir"], umur, pid] + ([kelas] if kelas else [])
            rows = cur.execute(f"""SELECT a.peserta_id FROM anggota a JOIN {asal} h USING (peserta_id)
                                   WHERE a.edisi = ? AND a.jk = ? AND abs(date_diff('day', a.tgl_lahir, ?::DATE)) < ? AND a.tahun_meninggal IS NULL
                                   AND a.peserta_id <> ? AND a.peserta_id NOT IN (SELECT peserta_id FROM hindari)
                                   {'AND (a.hak IS NULL OR a.hak <= ?)' if kelas else ''} ORDER BY random() LIMIT 100""", args).df().to_dict("records")
            if rows:
                dipilih = int(rng.choice(rows)["peserta_id"])
                if isinstance(hindari, list):  # a batch example never gives two copies the same member (it would be a real repeat claim)
                    hindari.append(dipilih)
                return dipilih
    finally:
        cur.close()
    return pid


def klaim_rme(f: dict) -> dict:
    """The form's claim as the medical-record cross-check sees it (aip/realtime/rme.klaim_dari)."""
    ri = f.get("jenis_episode") == "ri"
    top = {f"{f['topup_jenis']}_tarif_rp": int(f.get("topup_rp") or 0)} if f.get("topup_jenis") else {}
    return {"id": f.get("templat") or "UJI", "tgl_datang": _d(f["tanggal_masuk"]), "tgl_pulang": _d(f.get("tanggal_pulang") or f["tanggal_masuk"]),
            "tingkat": "RITL" if ri else "RJTL", "poli": "IGD" if f.get("jenis_episode") == "igd" else None, "dx_utama": f.get("diagnosis_utama"),
            "dx_sekunder": list(f.get("diagnosis_sekunder") or []), "tindakan": list(f.get("tindakan") or []),
            "sd_tarif_rp": top.get("sd_tarif_rp", 0), "rr_tarif_rp": top.get("rr_tarif_rp", 0), "obat": []}


def pasien_rme(eng: Any, f: dict) -> dict:
    """The card holder's sex and birth date from the registry (a registered member), for a record that belongs to them."""
    from aip.realtime import mesin as E

    pid = f.get("peserta_id")
    if f.get("pasien_mode") != "terdaftar" or pid is None:
        return {"seed": f.get("no_rm") or f.get("nama_pasien") or "baru"}
    rows = _anggota(eng, "SELECT jk, tgl_lahir FROM anggota WHERE edisi = ? AND peserta_id = ? LIMIT 1", [E.REPLAY_EDISI, int(pid)])
    if not rows:
        return {"seed": str(pid)}
    lahir = rows[0].get("tgl_lahir")
    return {"jk": rows[0].get("jk"), "tgl_lahir": str(lahir)[:10] if lahir is not None and lahir == lahir else None, "seed": str(pid)}


def _dengan_rme(eng: Any, f: dict, varian: str, rng: random.Random, **kv: Any) -> dict:
    from aip.realtime import rme_sintetis as RS

    f["rekam_medis"] = RS.bundel(klaim_rme(f), varian, rng, pasien_rme(eng, f), **kv)
    return f


KATETER = ("3721", "3722", "3723", "0066", "3606", "3607", "8855", "8856", "8857")


def _episode_baru(t: dict, eng: Any, rng: random.Random, recent: list, **ubah: Any) -> dict:
    """A new episode from a stream template, as the "normal" example builds it: another similar member, the admission moved
    a few days inside the stream window and the bill varied a little. A copy with the template's own dates is, to ML v7, a
    claim cloned onto another member (same hospital, code and dates) — not what a medical-record example should test."""
    d0, d1 = _d(t["tgl_datang"]), _d(t["tgl_pulang"] or t["tgl_datang"])
    w0, w1 = eng.window if getattr(eng, "window", None) else (d0, d0)
    shift = rng.choice([s_ for s_ in range(-5, 6) if s_ and w0 <= d0 + timedelta(days=s_) <= w1] or [0])
    tagih = int(round(int(t["biaya_tagih_rp"] or 0) * rng.uniform(0.93, 1.07), -2))
    return form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), tanggal_masuk=str(d0 + timedelta(days=shift)),
                     tanggal_pulang=str(d1 + timedelta(days=shift)), biaya_tagih_rp=tagih, **ubah)
JUDUL = {"normal": "Klaim wajar", "ganda": "Klaim ganda", "kartu_dipinjam": "Kartu dipinjam", "upcoding": "Upcoding (satu RS, 10 klaim)", "kelas_naik": "Kelas di atas hak",
         "dx_sekunder": "Diagnosis sekunder berlebih", "topup_fiktif": "Top-up fiktif", "setelah_meninggal": "Klaim setelah meninggal",
         "ring": "Collusion ring (15 klaim)", "topup_inflasi": "Top-up digelembungkan", "prosedur_fiktif": "Prosedur tanpa tindakan",
         "kode_tidak_sesuai": "Kode tidak sesuai diagnosis", "los_bergeser": "Lama rawat diperpanjang (satu RS)", "kloning": "Kloning klaim (4 peserta)",
         "rme_sesuai": "Klaim + rekam medis sesuai", "rme_kateter_fiktif": "Kateterisasi jantung tanpa jejak di rekam medis",
         "rme_dx_tidak_didukung": "Gagal napas ditagih, saturasi normal", "rme_los": "Lama rawat klaim lebih panjang dari rekam medis",
         "rme_kunjungan_fiktif": "Rawat inap tanpa kunjungan di rekam medis"}


def contoh(jenis: str, rp: Any, rs_list: list[dict], eng: Any, recent: Optional[list] = None) -> dict:
    from aip.realtime import mesin as E

    rng = random.Random()
    recent = list(recent or [])  # our own copy: _mirip adds every member it picks, so a batch never repeats a member
    ritl = rp[rp.tingkat_pelayanan == "RITL"]
    rows = lambda df: df.sample(1, random_state=rng.randint(0, 10**6)).iloc[0].to_dict()  # noqa: E731
    klaim, ket = [], ""
    if jenis == "normal":
        # a new ordinary stay, not a copy: a typical inpatient claim as template, another recently seen member, the
        # admission moved a few days and the bill varied a little (an exact copy with another member is claim cloning)
        t = rows(ritl[(ritl.status_pulang == "Sehat") & (ritl.jumlah_dx_sekunder <= 3)])
        d0, d1 = _d(t["tgl_datang"]), _d(t["tgl_pulang"])
        w0, w1 = eng.window if getattr(eng, "window", None) else (d0, d0)
        shift = rng.choice([s_ for s_ in range(-5, 6) if s_ and w0 <= d0 + timedelta(days=s_) <= w1] or [0])
        tagih = int(round(int(t["biaya_tagih_rp"] or 0) * rng.uniform(0.93, 1.07), -2))
        klaim = [form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), tanggal_masuk=str(d0 + timedelta(days=shift)),
                           tanggal_pulang=str(d1 + timedelta(days=shift)), biaya_tagih_rp=tagih)]
        ket = "Rawat inap biasa: peserta lain yang mirip (jenis kelamin, umur, hak kelas), tanggal digeser beberapa hari, tagihan sedikit berbeda."
    elif jenis == "ganda":
        klaim = [form_dari(rows(ritl))]
        ket = "Klaim yang sama persis dengan klaim yang sudah ada di aliran: peserta, RS, tanggal, dan biaya sama."
    elif jenis == "kartu_dipinjam":
        t0 = rows(ritl[ritl.los_hari >= 4])
        prov = int(t0["kabkota_fkrtl_kode"]) // 100
        o = rows(ritl[(ritl.kabkota_fkrtl_kode // 100) != prov])
        d = _d(t0["tgl_datang"]) + timedelta(days=1)
        klaim = [form_dari(o, peserta_id=int(t0["peserta_id"]), tanggal_masuk=str(d), tanggal_pulang=str(d + timedelta(days=3)))]
        ket = "Peserta yang sedang dirawat inap di satu provinsi, sehari kemudian dirawat inap juga di RS provinsi lain."
    elif jenis == "upcoding":
        prof = ritl.groupby(["kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl", "tipe_fkrtl"], dropna=False).size().sort_values(ascending=False)
        for key in prof.index[:20]:
            if prof[key] < 6:
                break
            temps = ritl[(ritl.kabkota_fkrtl_kode == key[0]) & (ritl.kepemilikan_fkrtl == key[1]) & (ritl.jenis_fkrtl == key[2])]
            temps = temps.sample(frac=1, random_state=rng.randint(0, 10**6)).to_dict("records")
            out = []
            for t in temps * 2:
                up = str(t["inacbg_kode"]).rsplit("-", 1)[0] + "-III"
                if up == t["inacbg_kode"] or up not in eng.known_codes:
                    continue
                tarif = int((t.get("tarif_inacbg_rp") or t["biaya_tagih_rp"]) * 1.8)
                out.append(form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), inacbg_kode=up, tarif_inacbg_rp=tarif,
                                     biaya_tagih_rp=tarif + int((t["biaya_tagih_rp"] or 0) - (t.get("tarif_inacbg_rp") or 0))))
                if len(out) >= 10:
                    break
            if len(out) >= 8:
                klaim = out
                break
        ket = (f"{len(klaim)} klaim rawat inap di satu RS yang kodenya dinaikkan ke keparahan III dengan tarif 1,8 kali, seperti simulator "
               "menanam upcoding: bauran keparahan RS itu melonjak. Klaim terakhir yang dijelaskan.")
    elif jenis == "kelas_naik":
        import pandas as pd

        cur = eng.con.cursor()
        try:
            cur.register("baru_dilihat", pd.DataFrame({"peserta_id": _ints(recent) or [-1]}))
            ms = cur.execute("""SELECT peserta_id FROM anggota WHERE edisi = ? AND segmen LIKE 'PBI%' AND hak = 3 AND tahun_meninggal IS NULL
                                AND peserta_id IN (SELECT peserta_id FROM baru_dilihat) ORDER BY random() LIMIT 50""", [E.REPLAY_EDISI]).df().to_dict("records")
        finally:
            cur.close()
        t = rows(ritl)
        klaim = [form_dari(t, peserta_id=int(rng.choice(ms)["peserta_id"]) if ms else int(t["peserta_id"]), kelas_rawat=1, segmen="PBI APBN")]
        ket = "Peserta PBI dengan hak kelas 3 dirawat dan ditagihkan di kelas 1."
    elif jenis == "dx_sekunder":
        ref = eng.ref
        cand = ritl[ritl.inacbg_kode.map(lambda c: (ref.kode.get(c) or {}).get("n", 0) >= 200)]
        t = rows(cand if len(cand) else ritl)
        p99 = int((ref.kode.get(t["inacbg_kode"]) or {}).get("dx_sek_p99") or 6)
        n = min(p99 + 8, len(UMUM_SEKUNDER))
        klaim = [form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), diagnosis_sekunder=UMUM_SEKUNDER[:n])]
        ket = f"Jumlah diagnosis sekunder {n}, jauh di atas persentil 99 kodenya ({p99})."
    elif jenis == "topup_fiktif":
        ref = eng.ref
        cand = ritl[ritl.inacbg_kode.map(lambda c: (ref.kode.get(c) or {}).get("n", 0) >= 200 and (ref.topup.get((c, "sd_tarif_rp")) or {}).get("n", 0) <= 2)]
        t = rows(cand if len(cand) else ritl)
        klaim = [form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), topup_jenis="sd", topup_rp=4_500_000,
                           biaya_tagih_rp=int(t["biaya_tagih_rp"] or 0) + 4_500_000)]
        ket = "Top-up special drug Rp4,5 juta pada kode yang hampir tidak pernah mendapat top-up itu."
    elif jenis == "setelah_meninggal":
        t = rows(ritl)
        pid = _mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t))
        p = _d(t["tgl_pulang"])
        later = rows(rp[rp.tingkat_pelayanan == "RJTL"])
        klaim = [form_dari(t, peserta_id=pid, status_pulang="Meninggal"),
                 form_dari(later, peserta_id=pid, tanggal_masuk=str(p + timedelta(days=4)), tanggal_pulang=str(p + timedelta(days=4)))]
        ket = "Rawat inap yang berakhir dengan peserta meninggal, lalu klaim rawat jalan peserta yang sama empat hari kemudian."
    elif jenis == "topup_inflasi":
        ref = eng.ref
        SPEC = ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp")
        cand = rp[rp.inacbg_kode.map(lambda c: any((ref.topup.get((c, k)) or {}).get("n", 0) >= 20 for k in SPEC))]
        t = rows(cand if len(cand) else ritl)
        col = next((k for k in SPEC if (ref.topup.get((t["inacbg_kode"], k)) or {}).get("n", 0) >= 20), "sd_tarif_rp")
        amt = int(((ref.topup.get((t["inacbg_kode"], col)) or {}).get("p95") or 1_500_000) * 3)
        klaim = [form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), topup_jenis=col[:2], topup_rp=amt,
                           biaya_tagih_rp=int(t["biaya_tagih_rp"] or 0) + amt)]
        ket = f"Special CMG {col[:2]} Rp{amt:,} (3 kali persentil 95 kode ini).".replace(",", ".")
    elif jenis == "prosedur_fiktif":
        cand = rp[rp.inacbg_kode.astype(str).str[2].isin(["1", "3"]) & rp.prosedur.notna()]
        t = rows(cand)
        klaim = [form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), tindakan=[])]
        ket = "Kode INA-CBG kelompok prosedur, tetapi tidak ada tindakan yang tercatat."
    elif jenis == "kode_tidak_sesuai":
        ref = eng.ref
        for _ in range(80):
            t, o = rows(ritl), rows(ritl)
            code = o.get("inacbg_kode")
            if code and ref.rare_pair(t.get("dx_primer_icd3"), code) and code[:1] != str(t.get("inacbg_kode") or "")[:1]:
                d = _d(t["tgl_datang"])
                klaim = [form_dari(o, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(o), _rs_id(o)), diagnosis_utama=_icd(None, t["dx_primer_icd3"]),
                                   tanggal_masuk=str(d), tanggal_pulang=str(d + timedelta(days=int(o.get("los_hari") or 2))))]
                break
        ket = "Kode INA-CBG yang hampir tidak pernah dipakai untuk diagnosis utama ini."
    elif jenis == "los_bergeser":
        prof = ritl.groupby(["kabkota_fkrtl_kode", "kepemilikan_fkrtl", "jenis_fkrtl"], dropna=False).size().sort_values(ascending=False)
        key = prof.index[rng.randint(0, min(29, len(prof) - 1))]
        temps = ritl[(ritl.kabkota_fkrtl_kode == key[0]) & (ritl.kepemilikan_fkrtl == key[1]) & (ritl.jenis_fkrtl == key[2])].to_dict("records")
        rng.shuffle(temps)
        for n in range(min(12, max(6, len(temps)))):
            t = temps[n % len(temps)]
            los = max(4, int(t.get("los_hari") or 2) * 3)
            d = _d(t["tgl_datang"])
            klaim.append(form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), tanggal_pulang=str(d + timedelta(days=los))))
        ket = f"{len(klaim)} rawat inap di satu RS yang lama rawatnya dibuat tiga kali lipat (minimal 4 hari). Klaim terakhir yang dijelaskan."
    elif jenis == "kloning":
        t = rows(ritl[ritl.los_hari >= 3])
        topup = sum(int(t.get(k) or 0) for k in ("sa_tarif_rp", "sp_tarif_rp", "rr_tarif_rp", "si_tarif_rp", "sd_tarif_rp"))
        bill = int(t.get("tarif_inacbg_rp") or 0) + topup + 750_000
        for n in range(4):
            klaim.append(form_dari(t, peserta_id=_mirip(eng, int(t["peserta_id"]), rng, recent, _kelas(t), _rs_id(t)), biaya_tagih_rp=bill))
        ket = "Satu klaim rawat inap disalin ke empat peserta lain: RS, tanggal, kode, dan tagihan sama persis."
    elif jenis == "ring":
        by_prov: dict[str, list[dict]] = {}
        for r in rs_list[:300]:
            if r["klaim"] >= 20:
                by_prov.setdefault(r["provinsi"], []).append(r)
        prov = rng.choice([p for p, v in by_prov.items() if len(v) >= 3])
        hs = rng.sample(by_prov[prov], 3)
        rj = rp[rp.tingkat_pelayanan == "RJTL"]
        members = [int(x) for x in rp.peserta_id.drop_duplicates().sample(5, random_state=rng.randint(0, 10**6))]
        d0 = date(2024, 12, 22) + timedelta(days=rng.randint(0, 5))
        for j, m in enumerate(members):
            for k, h in enumerate(hs):
                prof = rp[(rp.kabkota_fkrtl_kode == h["kabkota_kode"]) & (rp.kepemilikan_fkrtl == h["kepemilikan"]) & (rp.jenis_fkrtl == h["jenis"])]
                t = rows(prof[prof.tingkat_pelayanan == "RJTL"] if (prof.tingkat_pelayanan == "RJTL").any() else prof)
                d = d0 + timedelta(days=k * 2 + j % 2)
                klaim.append(form_dari(t, peserta_id=m, rs_id=h["id"], tanggal_masuk=str(d), tanggal_pulang=str(d)))
        ket = f"Lima peserta yang sama berobat di tiga RS di {prov} dalam sekitar enam hari. Dinilai satu per satu; Model 1 dan network rule makin yakin seiring ring terbentuk."
    elif jenis == "rme_sesuai":
        t = rows(ritl[(ritl.status_pulang == "Sehat") & (ritl.jumlah_dx_sekunder <= 3)])
        klaim = [_dengan_rme(eng, _episode_baru(t, eng, rng, recent), "sesuai", rng)]
        ket = ("Rawat inap biasa dengan rekam medis SATUSEHAT yang konsisten: kunjungan, diagnosis, tindakan, tanda vital dan obat cocok dengan klaim. "
               "Rekam medis bisa dilihat dan diubah di bagian Rekam medis elektronik pada formulir.")
    elif jenis == "rme_kateter_fiktif":
        cand = ritl[ritl.prosedur.fillna("").map(lambda p: any(c in p for c in KATETER))]
        if not len(cand):
            raise ValueError("tidak ada klaim kateterisasi jantung di aliran replay untuk dijadikan templat")
        t = rows(cand)
        f = _episode_baru(t, eng, rng, recent, diagnosis_sekunder=["I10", "E78.5"] if int(t.get("jumlah_dx_sekunder") or 0) else [])
        klaim = [_dengan_rme(eng, f, "tindakan_fiktif", rng)]
        ket = ("Klaim kateterisasi jantung/PCI (permintaan BPJS): rekam medis SATUSEHAT pasien tidak memuat tindakan kateterisasi, tidak ada diagnosis jantung "
               "(pasien tercatat datang untuk keluhan ringan), tekanan darah, nadi dan saturasi oksigen normal, troponin dan EKG normal.")
    elif jenis == "rme_dx_tidak_didukung":
        cand = ritl[ritl.dx_primer_icd3.astype(str).str.match(r"^J1[2-8]") & (ritl.los_hari >= 3)]
        t = rows(cand if len(cand) else ritl[ritl.los_hari >= 3])
        code = str(t["inacbg_kode"])
        up = code.rsplit("-", 1)[0] + "-III"
        f = _episode_baru(t, eng, rng, recent, diagnosis_sekunder=["J96.0", "E87.1"], **({"inacbg_kode": up} if up in eng.known_codes else {}))
        klaim = [_dengan_rme(eng, f, "dx_tidak_didukung", rng)]
        ket = ("Diagnosis sekunder gagal napas (J96.0) dan hiponatremia (E87.1) ditagih (keparahan naik), tetapi rekam medis mencatat saturasi oksigen "
               "dan frekuensi napas normal di setiap pengukuran, dan natrium normal.")
    elif jenis == "rme_los":
        t = rows(ritl[ritl.los_hari >= 4])
        los = int(t.get("los_hari") or 4)
        f = _episode_baru(t, eng, rng, recent)
        klaim = [_dengan_rme(eng, f, "los", rng, kurang=max(3, los // 2))]
        ket = f"Klaim menagih {los} hari rawat inap; Encounter di rekam medis selesai {max(3, los // 2)} hari lebih awal."
    elif jenis == "rme_kunjungan_fiktif":
        t = rows(ritl[ritl.los_hari >= 2])
        klaim = [_dengan_rme(eng, _episode_baru(t, eng, rng, recent), "kunjungan_fiktif", rng)]
        ket = "Rawat inap ditagih, tetapi rekam medis pasien hanya memuat satu kunjungan rawat jalan beberapa minggu sebelumnya."
    else:
        raise ValueError(f"contoh '{jenis}' tidak dikenal")
    return {"jenis": jenis, "judul": JUDUL.get(jenis, jenis), "keterangan": ket, "klaim": klaim}
