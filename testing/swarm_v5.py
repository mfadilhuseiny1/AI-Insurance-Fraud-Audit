"""v5's claim dossiers for the multi-agent swarm (plan and rules: testing/kriteria_v5.json). Synthetic data only.

berkas() writes one claim's facts as compact text, from features only: categorical fields, percentiles against the NORMAL
training claims, the v4 mechanism features, graph history, the network count and the rule signals that fired. No model
score, no label, no scheme name. The swarm itself runs on Google ADK with Vertex AI (testing/swarm_v5_adk.py).

Rule engines -> swarm (2026-11-15; the user: "integrated with the electronic medical record … I don't know whether the rule engine
alone is enough (IoT verification and EMR), I think we need some integration of those rule engines with our AI Agent Swarm").
Two deterministic engines read evidence the ML model never sees (its 45 rule signals, aktif.CODES, stay frozen; nothing here is
a model feature): the medical-record check (api/aip/realtime/rme.py, RME_* signals with plain evidence and numbers, kept per claim
by testing/jalan_kc_tema.py as `rme_bukti`) and the IoT usage check (testing/iot_cabang.py periksa -> bukti.json: measured device
on-time, run length and mode against the billed hours). They meet the swarm in three places:
  1. routing   temuan_klaim() turns both into numbered findings R1..Rn with a strength k in [0, 1] (the engine's own strength after
               its mitigations: rme.py s x prod(1 - faktor); IoT: 1.0 when the device record is anchored before the claim, less
               otherwise). A finding >= KUAT_RUTE sends the claim to the swarm even when ML v7 let it pass (LOLOS); a VERIFIABLE
               finding (a document mismatch anyone can re-check: a billed procedure absent from a record that has clinical data,
               anchored device hours below the billed threshold, ...) >= KUAT_BUKTI opens the rule-evidence lane.
  2. dossier   bagian_aturan() adds "Temuan rekam medis (RME)" and "Bukti pemakaian alat (IoT)" to the dossier, de-identified (no
               patient, visit, device or hospital id; dates relative to admission, H0; no bare codes), each finding tagged with the
               specialist that owns it (koding: procedures / diagnoses / severity / indication vs the record; tagihan: device hours
               vs billed hours and the tariff effect, drugs / implants / ward class; episode: binding to another patient, visits
               missing or billed twice, LOS, split episodes, identity). Every agent still sees every fact (an IoT record that
               SUPPORTS the stay is a defence the coding specialist must not miss); ownership says who must weigh it.
  3. the gate  gerbang(): the ML lane is unchanged, f_ml = (p_judge + q(s)) / 2 >= tau (V5b), where q(s) is the share of normal
               claims scoring below s. For a claim with a verifiable finding the judge did not reject, the rule lane adds
               f_rule = (p_judge + k) / 2 on the same scale and the same tau, and f = max(f_ml, f_rule): rule evidence can add a claim
               to the queue, never take one out. Why k stands where q(s) stands: q(s) is "how unusual is this score among normal
               claims"; for a verifiable finding the same question has the engine's measured answer (rme-1 on the cardiac set: 0.16 %
               of normal claims raise any medical-record alert), so k is capped at K_MAKS = 0.99 and then lowered by the engine's own
               mitigations. With k <= 0.99 the queue needs p_judge >= 0.45: the judge keeps the veto, and a judge who rejects the
               finding (sikap "tolak") switches the rule lane off for that claim. Every decision records its lane and numbers."""
from __future__ import annotations

import hashlib
import re
from datetime import date

import numpy as np

# --------------------------------------------------------------------------------------------------- the dossier
PERSENTIL = [("klaim: biaya_tagih", "tagihan"), ("klaim: tarif_inacbg", "tarif INA-CBG"), ("klaim: tarif_tambahan", "top-up (tarif tambahan)"),
             ("klaim: rasio_tagih_tarif", "tagihan / (tarif + top-up)"), ("klaim: idx_tarif_kode", "tarif / median tarif kode"),
             ("klaim: los", "LOS"), ("klaim: idx_los", "LOS / median LOS kode"), ("klaim: dx_sekunder", "jumlah dx sekunder"),
             ("klaim: p_berat_dx", "peluang keparahan berat untuk diagnosis ini"), ("klaim: p_prosedur_dx", "peluang ada prosedur untuk diagnosis ini"),
             ("klaim: frek_kode", "frekuensi kode"), ("klaim: frek_dx", "frekuensi diagnosis"), ("klaim: kembar", "klaim kembar (peserta, tanggal, kode)"),
             ("klaim: kunjungan_peserta", "kunjungan peserta sebelumnya (semua RS)"), ("klaim: kunjungan_peserta_faskes", "kunjungan peserta sebelumnya ke RS ini"),
             ("klaim: hari_sejak_sebelumnya", "hari sejak klaim peserta sebelumnya"), ("klaim: f_jumlah_klaim", "RS: jumlah klaim"),
             ("klaim: f_pct_rawat_inap", "RS: % rawat inap"), ("klaim: f_pct_keparahan_berat", "RS: % keparahan berat"), ("klaim: f_idx_los", "RS: indeks LOS"),
             ("klaim: f_pct_prosedur_rj", "RS: % prosedur rawat jalan"), ("klaim: f_pct_tarif_tambahan", "RS: % klaim dengan top-up"),
             ("klaim: f_pct_kembar", "RS: % klaim kembar"), ("klaim: f_rata_dx_sekunder", "RS: rata-rata dx sekunder"), ("klaim: f_idx_tarif_kode", "RS: indeks tarif kode")]
KATEGORI = ["klaim: tingkat_pelayanan=", "klaim: inacbg_keparahan=", "klaim: inacbg_tipe_kasus=", "klaim: jenis_fkrtl=", "klaim: kelas_rawat="]
# rule signals that are scores, not findings, never go to the agents
BUKAN_TEMUAN = {"s:SKOR_ML"}
X4_LABEL = {"v4: domisili_fktp_jarak": "jarak domisili peserta ke wilayah FKTP", "v4: domisili_tinggal_jarak": "jarak tempat tinggal peserta ke RS",
            "v4: ganda_dekat": "klaim lain peserta yang sangat dekat (hari)", "v4: ganda_dekat_biaya_mirip": "klaim dekat dengan biaya mirip",
            "v4: peserta_hari_sama_rs_lain": "klaim peserta di RS lain pada hari yang sama", "v4: klon_mirip_3h": "klaim mirip (peserta lain, RS sama) dalam 3 hari",
            "v4: klon_mirip_14h": "klaim mirip (peserta lain, RS sama) dalam 14 hari", "v4: los_rasio_median_kode": "LOS / median kode",
            "v4: los_di_bawah_p10": "LOS di bawah p10 kode (1 = ya)", "v4: los_di_bawah_p25": "LOS di bawah p25 kode (1 = ya)",
            "v4: readmisi_setelah_rawat_pendek": "readmisi setelah rawat inap pendek (1 = ya)", "v4: readmisi_jeda_hari": "jeda readmisi (hari)",
            "v4: readmisi_rs_sama": "readmisi di RS sama (1 = ya)", "v4: readmisi_dx_sama": "readmisi diagnosis sama (1 = ya)",
            "v4: rs_los_rasio_drift": "RS: pergeseran LOS periode ini vs sebelumnya", "v4: rs_sev3_drift": "RS: pergeseran % keparahan III",
            "v4: rs_rawat_pendek_drift": "RS: pergeseran % rawat pendek", "v4: rs_n_rawat_inap_jendela": "RS: jumlah rawat inap di jendela",
            "v4: topup_rasio_median_kode": "top-up / median top-up kode", "v4: topup_kode_jarang": "top-up yang jarang untuk kode ini (1 = ya)",
            "v4: dx_sekunder_di_atas_p90": "dx sekunder di atas p90 kode (selisih)", "v4: biaya_rasio_median_kode": "biaya / median biaya kode"}


class Referensi:
    """Percentiles against the NORMAL training claims (labels of training data only), and the column maps."""

    def __init__(self, sys_names: list[str], X1_normal_latih: np.ndarray) -> None:
        self.nama = list(sys_names)
        self.ix = {n: i for i, n in enumerate(self.nama)}
        self.kol = [(self.ix[n], lbl, self.ix.get(n.replace("klaim: ", "klaim: na_"))) for n, lbl in PERSENTIL if n in self.ix]
        self.urut = {i: np.sort(X1_normal_latih[:, i].astype(np.float64)) for i, _, _ in self.kol}
        self.sinyal = [(i, n[2:]) for i, n in enumerate(self.nama) if n.startswith("s:") and n not in BUKAN_TEMUAN]
        self.kat = [[(i, n.split("=", 1)[1]) for i, n in enumerate(self.nama) if n.startswith(p)] for p in KATEGORI]

    def persentil(self, i: int, v: float) -> int:
        a = self.urut[i]
        lo, hi = np.searchsorted(a, v, "left"), np.searchsorted(a, v, "right")
        return int(round(100 * (lo + hi) / 2 / max(1, len(a))))


def berkas(R: Referensi, x1: np.ndarray, x4: np.ndarray, xr: np.ndarray, kode: str, deg: np.ndarray, x4_names: list[str]) -> str:
    """One claim's dossier as compact text (features only)."""
    kat = [max(g, key=lambda t: x1[t[0]])[1] for g in R.kat if g]
    baris = [f"INA-CBG {kode} · " + " · ".join(kat)]
    p = []
    for i, lbl, na in R.kol:
        if na is not None and x1[na] > 0:
            p.append(f"{lbl}: tidak ada")
        else:
            p.append(f"{lbl}: p{R.persentil(i, float(x1[i]))}")
    baris.append("persentil vs klaim normal — " + "; ".join(p))
    # -1 is "none" for the readmission gap and the rare top-up flag (no earlier stay, no top-up): left out, as zeros are
    m = [f"{X4_LABEL.get(n, n)}: {float(v):.3g}" for n, v in zip(x4_names, x4)
         if np.isfinite(v) and abs(float(v)) > 1e-9 and not (n in ("v4: readmisi_jeda_hari", "v4: topup_kode_jarang") and float(v) < 0)]
    baris.append("fitur mekanisme — " + ("; ".join(m) if m else "semua nol"))
    baris.append(f"riwayat graph — klaim peserta sebelumnya: {int(round(np.expm1(deg[0])))}; klaim sebelumnya di RS ini dengan kode sama: {int(round(np.expm1(deg[2])))}")
    baris.append(f"jaringan — peserta lain yang berbagi RS dalam ±3 hari: {int(round(np.expm1(xr[0])))}")
    s = [n for i, n in R.sinyal if x1[i] > 0]
    baris.append("rule yang menyala — " + (", ".join(s) if s else "tidak ada"))
    return "\n".join(baris)



# =================================================================================================== rule engines -> swarm
VERSI_BERKAS = "berkas-v5-3"  # + "Temuan rekam medis (RME)", + "Bukti pemakaian alat (IoT)", numbered rule findings R1..Rn
KUAT_RUTE = 0.5    # a finding this strong sends the claim to the swarm even when ML let it pass (penjelasan_cabang: < 0.5 = weak)
KUAT_BUKTI = 0.8   # a VERIFIABLE finding this strong opens the rule-evidence lane at the gate
K_MAKS = 0.99      # the lane's k is never above this: the queue still needs p_judge >= 2 * tau - K_MAKS (0.45 at tau 0.72)
# who weighs which medical-record finding (rme.py codes) and whether it is a document mismatch anyone can re-check (verifiable)
# or a clinical judgement (needs review: an indication that is absent, an admission whose measurements are all normal)
RME_TEMUAN = {
    "RME_TINDAKAN_TIDAK_TERCATAT": ("koding", True), "RME_DIAGNOSIS_TIDAK_TERCATAT": ("koding", True), "RME_DIAGNOSIS_TIDAK_DIDUKUNG": ("koding", True),
    "RME_JENIS_RAWAT_BERBEDA": ("koding", True), "RME_KLINIS_TIDAK_MENDUKUNG": ("koding", False), "RME_RAWAT_INAP_TANPA_INDIKASI": ("koding", False),
    "RME_OBAT_ALKES_TIDAK_TERCATAT": ("tagihan", True), "RME_KELAS_BERBEDA": ("tagihan", True),
    "RME_LOS_TIDAK_SESUAI": ("episode", True), "RME_EPISODE_DIPECAH": ("episode", True), "RME_KUNJUNGAN_TIDAK_ADA": ("episode", True),
    "RME_KUNJUNGAN_DIPAKAI_ULANG": ("episode", True), "RME_PASIEN_BERBEDA": ("episode", True),
}
# IoT checker rules (testing/iot_cabang.py): the owner; binding / tampering go to the episode & identity specialist
IOT_PEMILIK = {"binding_tumpang": "episode", "anchor_mismatch": "episode"}
NAMA_ALAT = {"ventilator": "ventilator", "monitor_icu": "monitor bed ICU", "hemodialisis": "mesin hemodialisis", "pompa_infus": "pompa infus"}
# the clamp's device states (a ventilator: jalan / siaga / mati); an older block's ventilator modes are read as those states
NAMA_MODE = {"jalan": "jalan", "siaga": "siaga", "idle": "siaga", "nyala": "menyala", "mati": "mati"}
MODE_LAMA = {"invasif": "jalan", "noninvasif": "jalan", "non_invasif": "jalan", "standby": "siaga"}


def _des(x: float, n: int = 1) -> str:
    s = f"{float(x):.{n}f}".rstrip("0").rstrip(".") if n else f"{float(x):.0f}"
    return s.replace(".", ",")


def _rp(v: float) -> str:
    return "Rp" + f"{int(round(float(v))):,}".replace(",", ".")


def _tgl(s: str) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def hari_relatif(s: str, d0: date | None) -> str:
    """A date as days from the claim's admission: H0, H+3, H-1 (no calendar date reaches the dossier)."""
    d = _tgl(s)
    if d is None or d0 is None:
        return "tanggal lain"
    n = (d - d0).days
    return "H0" if n == 0 else f"H{n:+d}"


_ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:T[\d:]+)?\b")
_KODE = re.compile(r"\s*\((?:\d{2}\.\d{1,2}|[A-Z]\d{2}(?:\.\d{1,4})?)\)")
_SATU_KODE = r"(?:[A-Z]\d{2}(?:\.\d{1,4})?|\d{2}\.\d{1,2})"
_DAFTAR_KODE = re.compile(rf"\b{_SATU_KODE}(?:,\s*{_SATU_KODE})*\b")


def potong(t: str, n: int) -> str:
    """The text cut to at most n characters at a word boundary, with an ellipsis when cut."""
    t = str(t or "")
    if len(t) <= n:
        return t
    ruang = t.rfind(" ", 0, n - 1)
    return (t[:ruang] if ruang > n // 2 else t[:n - 1]).rstrip(" ,;:(") + "…"


def bersihkan(t: str, d0: date | None) -> str:
    """The last de-identification pass on any line that reaches an agent: calendar dates -> days from admission, codes in brackets
    out, bare code lists -> their count, identifiers (claim / visit / device / member numbers, P-xxxx, KLM-xxxx) -> a plain word."""
    t = _ISO.sub(lambda m: hari_relatif(m.group(0), d0), t)
    t = re.sub(r"\bP-\d{3,}\b", "pasien lain", t)
    t = re.sub(r"\bKLM-[0-9A-F]{6,}\b", "klaim lain", t)
    t = re.sub(r"\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{8,}\b",  # SYN..., VNT-..., device / visit ids (an INA-CBG code stays)
               lambda m: m.group(0) if re.fullmatch(r"[A-Z]-\d{1,2}-\d{2}-(?:0|I{1,3}|IV)", m.group(0)) else "[id]", t)
    t = re.sub(r"\b\d{8,}\b", "[id]", t)
    t = _KODE.sub("", t)
    # a list of codes -> its count, a lone diagnosis code -> a word; a lone procedure code stays (it comes with its meaning: "96.72 (>= 96 jam)")
    t = _DAFTAR_KODE.sub(lambda m: f"{len(m.group(0).split(','))} kode" if "," in m.group(0) else ("kode diagnosis" if m.group(0)[0].isalpha() else m.group(0)), t)
    return " ".join(t.split())


def _rme_kalimat(kode: str, bukti: str, tingkat: str, inacbg: str, d0: date | None) -> str:
    """One medical-record finding in plain words with its numbers: penjelasan_cabang's sentence for the report (written for a
    reader without technical background), its dates turned into days from admission; the engine's own text when that fails."""
    teks = None
    try:
        import penjelasan_cabang as PC

        asli = PC.tgl, PC.tgl_r
        PC.tgl = lambda s: hari_relatif(s, d0)  # the sentence functions read these module names when called
        PC.tgl_r = lambda a, b=None: hari_relatif(a, d0) if not b or str(b)[:10] == str(a)[:10] else f"{hari_relatif(a, d0)} s.d. {hari_relatif(b, d0)}"
        try:
            teks = PC.RME_TEKS[kode](bukti, {"tingkat": tingkat, "kode": inacbg}, {})
        finally:
            PC.tgl, PC.tgl_r = asli
    except Exception:  # noqa: BLE001 - the evidence worded otherwise, or the module missing: the engine's own text below
        teks = None
    return potong(bersihkan(teks or bukti, d0), 320)


def _iot_baris(b: dict) -> tuple[str, float, bool, str] | None:
    """One claim's IoT usage evidence (iot_cabang bukti.json block) as one line with numbers only: (text, strength, verifiable,
    owner). None when the device record says nothing (no reading, gateway offline: counted in the claim's favour)."""
    hasil, aturan = b.get("hasil"), str(b.get("aturan") or "")
    d, t, tb, bk = b.get("ditagih") or {}, b.get("terukur") or {}, b.get("tarif") or {}, b.get("bukti") or {}
    if hasil == "tanpa_bukti" and aturan == "faskes_offline":
        return None
    pro = str(d.get("prosedur") or "")
    # the device of the billed service (a ventilated ICU stay binds a bed monitor too: the procedure decides which one is checked)
    jenis = ("ventilator" if pro.startswith(("96.7", "93.9")) else "monitor_icu" if pro == "ICU" else "hemodialisis" if pro == "39.95"
             else next((a.get("jenis") for a in b.get("alat") or [] if a.get("jenis")), None) or "alat")
    mj: dict[str, float] = {}
    for m, v in (t.get("mode_jam") or {}).items():
        m = MODE_LAMA.get(m, m) if jenis == "ventilator" else m
        mj[m] = mj.get(m, 0.0) + float(v or 0)
    pakai = {"ventilator": ("jalan",), "monitor_icu": ("nyala",), "hemodialisis": ("jalan",)}.get(jenis, tuple(mj))
    jam_pakai = sum(float(mj.get(m) or 0) for m in pakai)
    bag = [f"{NAMA_ALAT.get(jenis, jenis)}: ditagih {d.get('keterangan') or pro}"]
    if d.get("jam") is not None and float(d["jam"]) >= 0 and jenis != "monitor_icu":  # a negative billed hour is an input error: not shown
        bag.append(f"jam ditagih {_des(d['jam'])}")
    bag.append(f"jam dipakai ({'/'.join(NAMA_MODE.get(m, m) for m in pakai)}) {_des(jam_pakai)}")
    if t.get("jam_berturut_maks") is not None:
        bag.append(f"terpanjang tanpa putus {_des(t['jam_berturut_maks'])} jam")
    if t.get("hari") is not None:
        bag.append(f"hari terukur {t['hari']}")
    if mj:
        bag.append("jam " + " / ".join(f"{NAMA_MODE.get(m, m)} {_des(v)}" for m, v in mj.items() if m != "mati"))
    if b.get("ambang_jam"):
        bag.append(f"ambang {_des(b['ambang_jam'])} jam")
    if t.get("pembacaan_hilang"):
        bag.append(f"{t['pembacaan_hilang']} pembacaan hilang (dihitung menguntungkan klaim)")
    ikat = ("alat sedang terikat ke pasien lain pada jam yang sama" if aturan == "binding_tumpang"
            else "tidak bermasalah" if b.get("sesi") else "tidak ada sesi alat untuk pasien ini")
    bag.append(f"pengikatan alat-pasien: {ikat}")
    anchored = bool(bk.get("merkle_root")) and bool(bk.get("rantai_ok"))
    sebelum = bk.get("jangkar_sebelum_klaim") is not False
    if bk.get("merkle_root"):
        bag.append("jangkar bukti " + ("cocok" if bk.get("rantai_ok") else "TIDAK cocok (data alat diubah setelah dijangkarkan)")
                   + ("" if sebelum else ", dijangkarkan SETELAH klaim diajukan"))
    else:
        bag.append("tanpa jangkar bukti")
    if bk.get("gateway_offline_jam"):
        bag.append(f"gateway RS offline {bk['gateway_offline_jam']} jam")
    if hasil == "tidak_sesuai" and tb.get("selisih_rp"):
        bag.append(f"dampak tarif bila mengikuti alat: {_rp(tb.get('ditagih_rp') or 0)} -> {_rp(tb.get('seharusnya_rp') or 0)} (selisih {_rp(tb['selisih_rp'])})")
    vonis = {"sesuai": "SESUAI tagihan", "tidak_sesuai": "TIDAK SESUAI tagihan", "tanpa_bukti": "tidak dapat dinilai"}.get(hasil, str(hasil))
    if hasil != "sesuai":
        try:  # the checker's rule in its own words (a generic title per rule: no device, patient or hospital in it)
            from iot_cabang import JUDUL_ATURAN

            vonis += f" (aturan: {JUDUL_ATURAN[aturan]})" if aturan in JUDUL_ATURAN else ""
        except ImportError:
            pass
    teks = f"{'; '.join(bag)} -> {vonis}"
    if hasil != "tidak_sesuai" and aturan != "anchor_mismatch":
        return teks, 0.0, False, IOT_PEMILIK.get(aturan, "tagihan")
    if aturan == "anchor_mismatch":
        k, verif = 0.7, False  # the device record was altered: an integrity problem, not a measurement anyone can rely on
    elif anchored and sebelum:
        k, verif = 1.0, True   # measured, unaltered since it was anchored before the claim
    elif anchored:
        k, verif = 0.6, False  # anchored only after the claim was filed: the hospital must explain
    else:
        k, verif = 0.7, False  # no session at all while the gateway was online (no anchor to check)
    return teks, k, verif, IOT_PEMILIK.get(aturan, "tagihan")


def temuan_klaim(rme_bukti: dict | None, rme_ada: bool, iot: dict | None, tingkat: str, inacbg: str, tgl_masuk: str) -> dict:
    """A claim's rule findings for the swarm and the gate: {temuan: [{id, sumber, kode, pemilik, k, terverifikasi, teks}], rme_ada,
    iot_ada, k_rute (strongest finding), k_aturan (strongest VERIFIABLE finding >= KUAT_BUKTI, capped at K_MAKS; 0 = no lane)}."""
    d0 = _tgl(tgl_masuk)
    out: list[dict] = []
    for kode, s in sorted((rme_bukti or {}).items(), key=lambda kv: -float((kv[1] or {}).get("s") or 0)):
        if kode not in RME_TEMUAN or not isinstance(s, dict):
            continue
        k = float(s.get("s") if s.get("s") is not None else 1.0)
        for m in s.get("mitigasi") or []:
            k *= 1 - float((m.get("faktor") if isinstance(m, dict) else 0) or 0)
        pemilik, verif = RME_TEMUAN[kode]
        out.append({"sumber": "rme", "kode": kode, "pemilik": pemilik, "k": round(k, 3), "terverifikasi": bool(verif and k >= KUAT_BUKTI),
                    "teks": _rme_kalimat(kode, str(s.get("bukti") or ""), tingkat, inacbg, d0)
                    or f"{kode[4:].lower().replace('_', ' ')} (rincian bukti tidak tersimpan pada run ini)"})
    iot_info = None
    if iot:
        x = _iot_baris(iot)
        if x:
            teks, k, verif, pemilik = x
            iot_info = teks
            if k > 0:
                out.append({"sumber": "iot", "kode": f"IOT_{str(iot.get('aturan') or '').upper()}", "pemilik": pemilik, "k": k,
                            "terverifikasi": bool(verif and k >= KUAT_BUKTI), "teks": potong(bersihkan(teks, d0), 420)})
    out.sort(key=lambda t: (-t["terverifikasi"], -t["k"]))
    for n, t in enumerate(out, 1):
        t["id"] = f"R{n}"
    ver = [t["k"] for t in out if t["terverifikasi"]]
    return {"temuan": out, "rme_ada": bool(rme_ada), "iot_ada": iot_info is not None, "iot_teks": bersihkan(iot_info, d0) if iot_info else None,
            "k_rute": max((t["k"] for t in out), default=0.0), "k_aturan": round(min(K_MAKS, max(ver)), 3) if ver else 0.0}


def bagian_aturan(T: dict) -> str:
    """The dossier's rule-evidence sections (appended after berkas()): the medical record (always: a finding per line, "no mismatch"
    or "not available") and, when the hospital's devices report, the IoT usage evidence. Findings are numbered for the judge."""
    rme = [t for t in T["temuan"] if t["sumber"] == "rme"]
    iot = [t for t in T["temuan"] if t["sumber"] == "iot"]

    def baris(t: dict) -> str:
        return f"- [{t['id']} · {t['pemilik']} · kekuatan {_des(t['k'], 2)}{' · terverifikasi' if t['terverifikasi'] else ''}] {t['teks']}"

    if not T["rme_ada"]:
        out = ["Temuan rekam medis (RME) — rekam medis tidak tersedia untuk klaim ini (bukan temuan)"]
    elif not rme:
        out = ["Temuan rekam medis (RME) — rekam medis tersedia; tidak ada ketidaksesuaian dengan klaim"]
    else:
        out = ["Temuan rekam medis (RME) — rekam medis tersedia; ketidaksesuaian:"] + [baris(t) for t in rme]
    if T.get("iot_ada"):
        out.append("Bukti pemakaian alat (IoT) — waktu nyala, lama dan status alat (jalan / siaga / mati) yang diukur sensor clamp pada kabel daya, "
                   "tanpa membuka alat (bukan data klinis):")
        out += [baris(t) for t in iot] if iot else [f"- {T['iot_teks']}"]
    return "\n".join(out)


def tambah_aturan(teks: str, T: dict) -> str:
    """A dossier with its rule-evidence sections (an older copy of them replaced, so a rerun never stacks them)."""
    inti = teks.split("\nTemuan rekam medis (RME)", 1)[0]
    return f"{inti}\n{bagian_aturan(T)}"


# ----------------------------------------------------------------------------------------------------------- the gate
def gerbang(p_hakim: float | None, f_ml: float, k_aturan: float, ids_bukti: list[str], sikap: list[dict] | None, tau: float) -> dict:
    """One claim at the gate. ML lane f_ml as laporan_cabang computes it ((p + q(s)) / 2 for V5b). Rule-evidence lane when the claim
    has verifiable findings (ids_bukti, strength k_aturan) and the judge did not reject all of them: f_rule = (p + k) / 2.
    f = max(f_ml, f_rule); the lane that set f is recorded with the numbers and the judge's stance on each finding."""
    tolak = {str(x.get("id")) for x in sikap or [] if isinstance(x, dict) and x.get("sikap") == "tolak"}
    terima = {str(x.get("id")) for x in sikap or [] if isinstance(x, dict) and x.get("sikap") == "terima"}
    out = {"f_ml": round(float(f_ml), 4), "k_aturan": float(k_aturan), "tau": tau, "hakim_terima": sorted(terima & set(ids_bukti)),
           "hakim_tolak": sorted(tolak & set(ids_bukti)), "tidak_dinilai": sorted(set(ids_bukti) - tolak - terima)}
    if p_hakim is None or not ids_bukti or k_aturan <= 0:
        out.update(f=out["f_ml"], jalur="ml", f_aturan=None, alasan_jalur="tanpa temuan aturan terverifikasi" if not ids_bukti else "swarm belum membaca")
        return out
    if set(ids_bukti) <= tolak:
        out.update(f=out["f_ml"], jalur="ml", f_aturan=None, alasan_jalur="hakim menolak semua temuan aturan terverifikasi")
        return out
    fa = round((float(p_hakim) + float(k_aturan)) / 2, 4)
    jalur = "bukti_aturan" if fa > out["f_ml"] else "ml"
    out.update(f=max(out["f_ml"], fa), jalur=jalur, f_aturan=fa,
               alasan_jalur=f"(hakim {_des(p_hakim, 2)} + k {_des(k_aturan, 2)})/2 = {_des(fa, 3)}" + (" > jalur ML" if jalur == "bukti_aturan" else " <= jalur ML"))
    return out


def terapkan_gerbang(kunci: np.ndarray, f_ml: np.ndarray, p_hakim: np.ndarray, agen: dict, jalur: dict, tau: float) -> tuple[np.ndarray, dict]:
    """The gate over a set (laporan_cabang muat, the runner's gerbang_<set>.json): f for every claim and, for the claims with rule
    findings, the lane record. jalur = jalur_<set>.json["klaim"] ({kunci: {temuan, k_aturan, ...}})."""
    f = np.array(f_ml, dtype=float).copy()
    rek: dict[str, dict] = {}
    for i, k in enumerate(np.asarray(kunci).astype(str)):
        J = jalur.get(k)
        if not J:
            continue
        p = None if p_hakim[i] != p_hakim[i] else float(p_hakim[i])
        ids = [t["id"] for t in J.get("temuan") or [] if t.get("terverifikasi")]
        g = gerbang(p, float(f_ml[i]), float(J.get("k_aturan") or 0), ids, ((agen.get(k) or {}).get("hakim") or {}).get("aturan"), tau)
        f[i] = g["f"]
        rek[k] = g
    return f, rek


def kunci_teks(teks: str) -> str:
    """A dossier's fingerprint for the swarm cache key: a changed dossier is a new question."""
    return hashlib.md5(teks.encode("utf-8")).hexdigest()[:10]


if __name__ == "__main__":  # a self-check of the de-identification and the gate (no data needed)
    t = bersihkan("Klaim menagih rawat inap 6 hari (2025-01-01 s.d. 2025-01-07) memakai VNT-0012AB pasien P-1234; Diagnosis di rekam medis: I21.0, I10.",
                  date(2025, 1, 1))
    assert "2025" not in t and "VNT" not in t and "P-1234" not in t and "I21" not in t, t
    g = gerbang(0.6, 0.55, 0.99, ["R1"], [{"id": "R1", "sikap": "terima"}], 0.72)
    assert g["jalur"] == "bukti_aturan" and abs(g["f"] - 0.795) < 1e-9, g
    g = gerbang(0.6, 0.55, 0.99, ["R1"], [{"id": "R1", "sikap": "tolak"}], 0.72)
    assert g["jalur"] == "ml" and g["f"] == 0.55, g
    g = gerbang(0.3, 0.8, 0.99, ["R1"], None, 0.72)
    assert g["f"] == 0.8 and g["jalur"] == "ml", g  # the rule lane never lowers a claim
    print("swarm_v5 aturan: OK |", t)
