"""Self-supervised pretraining on unlabelled claims and visits (the MONAI recipe — pretrain on what is plentiful,
unlabelled data — in insurance: millions of claims, almost none of them investigated).

A masked autoencoder for tabular records, after VIME (Yoon et al., NeurIPS 2020, "VIME: Extending the Success of Self- and
Semi-supervised Learning to Tabular Domain"): each record is corrupted — a random 30 % of its FIELDS replaced by the same
fields of other records — and the network learns to (1) reconstruct the original values and (2) say which fields were
replaced. No label is used. What it learns:

  embedding     16 numbers per record: where it sits among all records (similar records lie close); the active learner
                uses it for diversity and as features
  anomaly       the reconstruction error of the clean record, against the error of HELD-OUT records (p99, p99.9): a record
                the network cannot explain is unlike the bulk — the ANOMALI_SSL signal, with the fields that explain it

One model per event kind, each on its own inputs (`SPECS`):

  fkrtl    hospital claims: the production model's point-in-time features (money and counts on a log scale, ratios to the
           code's norms, the member's and the facility's history, the facility profile)
  fktp     primary-care visits: level, kind, poli, discharge, referral (non-specialist diagnosis, destination class, outside
           the kab/kota), the card holder (age, sex, segment, visiting the unit it is registered at), the diagnosis's
           frequency and how usual it is with this poli, sex, age band, facility kind and with a referral (pointwise mutual
           information), the facility's own history (visits per day, contact-only share, referral rates)
  nonkap   non-capitation claims: procedure group, the amount against the procedure's median, the procedure number, days
           between visit and procedure, the card holder, the procedure's frequency and how usual it is with this sex, age
           band, diagnosis and facility kind, the facility's daily volume

Field-wise corruption: a numeric value and its missing flag, or a category's whole one-hot block, are swapped together
(swapping single one-hot columns made impossible records: two categories at once, or none).

Versions: each scored event keeps the model version, the spec key and its raw inputs (`x`), so a retrained model re-embeds
old events (aktif.refresh) instead of mixing two embedding spaces; an adaptive model trained on another SSL version gets no
SSL features until it is retrained. Pretraining reads records BEFORE the replay window only.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

from aip.realtime.store import data_dir

log = logging.getLogger("aip.realtime.ssl")

EMB = 16
MASK_P = 0.3
HOLDOUT = 0.1
KINDS = ("fkrtl", "fktp", "nonkap")
STATE: dict[str, Any] = {"status": "belum", "progres": None, "galat": None}


@dataclass
class Spec:
    kind: str
    log: list[str]  # numeric, log1p-scaled
    raw: list[str]  # numeric, as is (clipped ±50)
    cats: dict[str, list[str]]  # one-hot; any other value = all zeros ("lainnya")
    keys: list[str] = field(default_factory=list)  # string keys kept for the frequency features (beside the categories)
    singles: list[str] = field(default_factory=list)  # key → f_<key>: log10 share among the training records
    pairs: list[tuple[str, str]] = field(default_factory=list)  # (a, b) → pmi_<a>_<b>: smoothed pointwise mutual information
    upper: bool = True  # categories compared upper-case
    label: dict[str, str] = field(default_factory=dict)
    money: tuple = ()

    @property
    def derived(self) -> list[str]:
        return [f"f_{s}" for s in self.singles] + [f"pmi_{a}_{b}" for a, b in self.pairs]

    @property
    def num(self) -> list[str]:
        return [*self.log, *self.raw, *self.derived]

    @property
    def base_cols(self) -> list[str]:
        """What an event keeps as `x`: the inputs before the frequency features (those come from the model's tables)."""
        return [*self.keys, *self.cats, *self.log, *self.raw]

    def key(self) -> str:
        return hashlib.md5(json.dumps([self.base_cols, self.cats, self.singles, self.pairs]).encode()).hexdigest()[:10]


FKRTL = Spec(
    kind="fkrtl",
    log=["biaya_tagih", "tarif_inacbg", "tarif_tambahan", "frek_kode", "frek_dx", "kunjungan_peserta", "kunjungan_peserta_faskes", "kembar",
         "hari_sejak_sebelumnya", "f_jumlah_klaim", "los"],
    raw=["rasio_tagih_tarif", "idx_los", "idx_tarif_kode", "p_berat_dx", "p_prosedur_dx", "dx_sekunder", "ada_prosedur", "f_pct_rawat_inap",
         "f_pct_keparahan_berat", "f_idx_los", "f_pct_prosedur_rj", "f_pct_tarif_tambahan", "f_pct_kembar", "f_rata_dx_sekunder", "f_idx_tarif_kode"],
    cats={"tingkat_pelayanan": ["RITL", "RJTL"],
          "inacbg_keparahan": ["Rawat Jalan", "Ringan (rawat inap keparahan 1)", "Sedang (rawat inap keparahan 2)", "Berat (rawat inap keparahan 3)"],
          "inacbg_tipe_kasus": ["Rawat Jalan Bukan Prosedur", "Prosedur Signifikan Rawat Jalan", "Rawat Inap Bukan Prosedur", "Prosedur Rawat Inap",
                                "Rawat Inap Kebidanan", "Prosedur Besar Rawat Jalan", "Rawat Inap Neonatal"],
          "jenis_fkrtl": ["Rumah sakit", "Klinik Utama"], "kelas_rawat": ["Kelas 1", "Kelas 2", "Kelas 3"]},
    upper=False,
    money=("biaya_tagih", "tarif_inacbg", "tarif_tambahan"),
    label={"biaya_tagih": "biaya ditagih", "tarif_inacbg": "tarif INA-CBG", "tarif_tambahan": "tarif tambahan (top-up)",
           "frek_kode": "klaim nasional dengan kode ini", "frek_dx": "klaim nasional dengan diagnosis ini", "kunjungan_peserta": "kunjungan peserta (termasuk ini)",
           "kunjungan_peserta_faskes": "kunjungan peserta ke faskes ini", "kembar": "klaim kembar (peserta, faskes, tanggal, kode sama)",
           "hari_sejak_sebelumnya": "hari sejak kunjungan sebelumnya", "f_jumlah_klaim": "volume klaim faskes", "los": "lama rawat (hari)",
           "rasio_tagih_tarif": "rasio tagihan terhadap tarif", "idx_los": "lama rawat terhadap median kode", "idx_tarif_kode": "tarif terhadap median kode",
           "p_berat_dx": "porsi keparahan berat untuk diagnosis", "p_prosedur_dx": "porsi prosedur untuk diagnosis", "dx_sekunder": "jumlah diagnosis sekunder",
           "ada_prosedur": "ada prosedur", "f_pct_rawat_inap": "porsi rawat inap faskes", "f_pct_keparahan_berat": "porsi keparahan berat faskes",
           "f_idx_los": "indeks lama rawat faskes", "f_pct_prosedur_rj": "porsi prosedur rawat jalan faskes", "f_pct_tarif_tambahan": "porsi klaim ber-top-up faskes",
           "f_pct_kembar": "porsi klaim kembar faskes", "f_rata_dx_sekunder": "rata-rata diagnosis sekunder faskes", "f_idx_tarif_kode": "indeks tarif faskes",
           "tingkat_pelayanan": "tingkat pelayanan", "inacbg_keparahan": "keparahan INA-CBG", "inacbg_tipe_kasus": "tipe kasus INA-CBG",
           "jenis_fkrtl": "jenis FKRTL", "kelas_rawat": "kelas rawat"})

POLI = ["POLI UMUM", "KONSELING", "HOME-VISIT", "POLI KIA", "KUNJUNGAN ONLINE", "TANPA POLI", "POLI GIGI & MULUT", "POLI LANSIA", "LABORATORIUM", "UGD",
        "POLI KB", "POLI PERSALINAN"]
MILIK = ["PEMERINTAH", "SWASTA", "BUMN", "TNI/POLRI"]
SEGMEN = ["PPU", "PBI APBN", "PBPU", "PBI APBD", "BUKAN PEKERJA"]
FKTP = Spec(
    kind="fktp",
    log=["ranap_hari", "fas_per_hari", "fas_rujukan_per_hari"],
    raw=["usia", "unit_sama", "rujuk_nonspes", "rujuk_kelas", "rujuk_luar_kab", "akhir_pekan", "fas_kontak_semu", "fas_rrns"],
    cats={"tingkat_pelayanan": ["RJTP", "PROMOTIF", "RITP"], "jenis_kunjungan": ["KUNJUNGAN SAKIT", "KUNJUNGAN SEHAT"],
          "status_pulang": ["BEROBAT JALAN", "KUNJUNGAN SEHAT", "RUJUK LANJUT", "SEMBUH"], "jenis_fktp": ["PUSKESMAS", "KLINIK PRATAMA", "DOKTER UMUM", "LABORATORIUM"],
          "milik": MILIK, "poli": POLI, "jk": ["L", "P"], "segmen": SEGMEN},
    keys=["dx", "umur", "rujuk"],
    singles=["dx"], pairs=[("poli", "dx"), ("jk", "dx"), ("umur", "dx"), ("jenis_fktp", "dx"), ("rujuk", "dx")],
    label={"ranap_hari": "lama rawat inap FKTP (hari)", "fas_per_hari": "kunjungan per hari FKTP ini (riwayat)",
           "fas_rujukan_per_hari": "rujukan per hari FKTP ini (riwayat)", "usia": "usia peserta", "unit_sama": "berobat di FKTP tempat terdaftar",
           "rujuk_nonspes": "rujukan diagnosis non-spesialistik", "rujuk_kelas": "kelas tujuan rujukan", "rujuk_luar_kab": "rujukan ke luar kab/kota",
           "akhir_pekan": "kunjungan akhir pekan", "fas_kontak_semu": "porsi kontak online/home-visit FKTP ini (riwayat)",
           "fas_rrns": "porsi rujukan non-spesialistik FKTP ini (riwayat)", "f_dx": "kelaziman diagnosis", "pmi_poli_dx": "kecocokan poli dengan diagnosis",
           "pmi_jk_dx": "kecocokan jenis kelamin dengan diagnosis", "pmi_umur_dx": "kecocokan usia dengan diagnosis",
           "pmi_jenis_fktp_dx": "kecocokan jenis FKTP dengan diagnosis", "pmi_rujuk_dx": "kelaziman merujuk diagnosis ini",
           "tingkat_pelayanan": "tingkat pelayanan", "jenis_kunjungan": "jenis kunjungan", "status_pulang": "status pulang", "jenis_fktp": "jenis FKTP",
           "milik": "kepemilikan", "poli": "poli", "jk": "jenis kelamin", "segmen": "segmen peserta"})
KELOMPOK = ["SKRINING_DM", "LAB_KRONIS", "RAWAT_INAP", "ANC", "PNC", "PERSALINAN", "KB", "AMBULANS", "PAPSMEAR", "GIGI", "PRA_RUJUKAN", "LAIN"]
NONKAP = Spec(
    kind="nonkap",
    log=["biaya", "tindakan_ke", "fas_per_hari"],
    raw=["usia", "rasio_median", "hari_tindakan", "luar_kunjungan", "akhir_pekan"],
    cats={"kelompok": KELOMPOK, "jenis_faskes": ["LABORATORIUM", "PUSKESMAS", "KLINIK PRATAMA", "JEJARING", "DOKTER UMUM"], "milik": MILIK,
          "tingkat_layanan": ["PROMOTIF", "RJTP", "RITP"], "jk": ["L", "P"], "segmen": SEGMEN},
    keys=["tindakan", "dx", "umur"],
    singles=["tindakan"], pairs=[("jk", "tindakan"), ("umur", "tindakan"), ("dx", "tindakan"), ("jenis_faskes", "tindakan")],
    money=("biaya",),
    label={"biaya": "biaya ditagih", "tindakan_ke": "urutan tindakan", "fas_per_hari": "klaim nonkapitasi per hari faskes ini (riwayat)",
           "usia": "usia peserta", "rasio_median": "biaya terhadap median tindakan", "hari_tindakan": "hari dari kunjungan ke tindakan",
           "luar_kunjungan": "tanggal tindakan di luar kunjungan", "akhir_pekan": "tindakan akhir pekan", "f_tindakan": "kelaziman tindakan",
           "pmi_jk_tindakan": "kecocokan jenis kelamin dengan tindakan", "pmi_umur_tindakan": "kecocokan usia dengan tindakan",
           "pmi_dx_tindakan": "kecocokan diagnosis dengan tindakan", "pmi_jenis_faskes_tindakan": "kecocokan jenis faskes dengan tindakan",
           "kelompok": "kelompok tindakan", "jenis_faskes": "jenis faskes", "milik": "kepemilikan", "tingkat_layanan": "tingkat layanan",
           "jk": "jenis kelamin", "segmen": "segmen peserta"})
SPECS = {"fkrtl": FKRTL, "fktp": FKTP, "nonkap": NONKAP}
NAMA = {"fkrtl": "klaim FKRTL", "fktp": "kunjungan FKTP", "nonkap": "klaim nonkapitasi"}


def _dir() -> Path:
    d = data_dir() / "al"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ------------------------------------------------------------------------------------------------
# inputs: from source rows (visit/claim + card holder + facility history) to `base`, then the frequency features
# ------------------------------------------------------------------------------------------------
def _milik(s: Any) -> str:
    s = str(s or "").upper()
    return ("PEMERINTAH" if s.startswith("PEM") else "SWASTA" if s.startswith("SWASTA") else "BUMN" if s.startswith("BUMN")
            else "TNI/POLRI" if s.startswith(("TNI", "POLRI")) else "LAIN")


def _band(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, float)
    out = np.where(a < 5, "0-4", np.where(a < 15, "5-14", np.where(a < 45, "15-44", np.where(a < 65, "45-64", "65+"))))
    return np.where(np.isnan(a), "?", out)


def kelompok(t: Any) -> str:
    from aip.realtime.fktp import CHRONIC

    t = str(t or "")
    if "Skrining DM" in t:
        return "SKRINING_DM"
    if any(c in t for c in CHRONIC) or "PRB/Prolanis" in t:
        return "LAB_KRONIS"
    if "Rawat Inap" in t:
        return "RAWAT_INAP"
    if "ANC" in t:
        return "ANC"
    if "PNC" in t or "Nifas" in t:
        return "PNC"
    if "Persalinan" in t:
        return "PERSALINAN"
    if "KB" in t:
        return "KB"
    if "Ambulans" in t or "Evakuasi" in t:
        return "AMBULANS"
    if "Papsmear" in t or "IVA" in t:
        return "PAPSMEAR"
    if "Gigi" in t:
        return "GIGI"
    if "rujukan" in t.lower():
        return "PRA_RUJUKAN"
    return "LAIN"


def _dates(s: Any) -> Any:
    import pandas as pd

    return pd.to_datetime(s, errors="coerce")


def _age(born: Any, at: Any) -> np.ndarray:
    return ((_dates(at) - _dates(born)).dt.days / 365.25).to_numpy(float)


def _c(v: Any) -> Any:
    """None for a missing value of any kind (None, NaN, NaT)."""
    if v is None:
        return None
    try:
        return None if v != v else v
    except (TypeError, ValueError):
        return v


def _fas(keys: list[tuple], table: dict, fields: list[str], tingkat: str) -> dict[str, np.ndarray]:
    """The facility's own history (referensi) per row, profiles hashed once."""
    from aip.realtime.referensi import profile

    memo: dict[tuple, dict] = {}
    rows = []
    for k in keys:
        k = tuple(_c(v) for v in k)
        if k not in memo:
            try:
                memo[k] = table.get(profile(tingkat, *k)) or {}
            except (TypeError, ValueError):
                memo[k] = {}
        rows.append(memo[k])
    out = {}
    for f in fields:
        out[f] = np.array([np.nan if (r.get(f) is None) else float(r[f]) for r in rows], float)
    return out


def base_fktp(df: Any, R: Any) -> Any:
    """FKTP visits (FktpIn fields + the card holder's jk, tgl_lahir, unit_terdaftar, segmen) → the spec's base columns."""
    import pandas as pd

    from aip.realtime.graf import rank_of
    from aip.realtime.modus import NON_SPESIALISTIK
    from aip.realtime.referensi import unit

    n = len(df)
    col = lambda c: df[c] if c in df else pd.Series([None] * n)  # noqa: E731
    d = _dates(col("tgl_datang"))
    status = col("status_pulang").fillna("").astype(str).str.upper().str.strip()
    dx = col("dx_icd3").fillna("?").astype(str).str.upper().str.strip()
    rujuk = (status == "RUJUK LANJUT").to_numpy()
    usia = _age(col("tgl_lahir"), d)
    kab, own, kind, tipe = col("kabkota_fktp_kode"), col("kepemilikan_fktp"), col("jenis_fktp"), col("tipe_fktp")
    units = [unit(_c(k), _c(o), _c(j)) for k, o, j in zip(kab, own, kind)]
    reg = col("unit_terdaftar")
    unit_sama = np.array([np.nan if (r is None or r != r) else float(u == r) for u, r in zip(units, reg)], float)
    fas = _fas(list(zip(kab, own, kind, tipe)), R.fktp if R is not None else {}, ["per_hari", "rujukan_per_hari", "kontak_semu", "rrns"], "FKTP")
    kab_r = pd.to_numeric(col("kabkota_rujukan_kode"), errors="coerce").to_numpy(float)
    poli = col("poli").fillna("").astype(str).str.upper().str.strip().replace("", "TANPA POLI")
    out = pd.DataFrame({
        "dx": dx, "umur": _band(usia), "rujuk": np.where(rujuk, "1", "0"),
        "tingkat_pelayanan": col("tingkat_pelayanan"), "jenis_kunjungan": col("jenis_kunjungan"), "status_pulang": status, "jenis_fktp": kind,
        "milik": [_milik(o) for o in own], "poli": poli, "jk": col("jk"), "segmen": col("segmen"),
        "ranap_hari": (_dates(col("tgl_pulang")) - d).dt.days.to_numpy(float), "fas_per_hari": fas["per_hari"], "fas_rujukan_per_hari": fas["rujukan_per_hari"],
        "usia": usia, "unit_sama": unit_sama, "rujuk_nonspes": (rujuk & dx.isin(NON_SPESIALISTIK).to_numpy()).astype(float),
        "rujuk_kelas": np.where(rujuk, [float(rank_of(t)) if isinstance(t, str) else 0.0 for t in col("tipe_faskes_rujukan")], 0.0),
        "rujuk_luar_kab": (rujuk & ~np.isnan(kab_r) & (kab_r != pd.to_numeric(kab, errors="coerce").to_numpy(float))).astype(float),
        "akhir_pekan": (d.dt.dayofweek >= 5).to_numpy(float), "fas_kontak_semu": fas["kontak_semu"], "fas_rrns": fas["rrns"]})
    return out[FKTP.base_cols]


def base_nonkap(df: Any, R: Any) -> Any:
    """Non-capitation claims (NonkapIn fields + the card holder's jk, tgl_lahir, segmen) → the spec's base columns."""
    import pandas as pd

    n = len(df)
    col = lambda c: df[c] if c in df else pd.Series([None] * n)  # noqa: E731
    dk, dt = _dates(col("tgl_kunjungan")), _dates(col("tgl_tindakan"))
    dp = _dates(col("tgl_pulang"))
    d = dt.fillna(dk)
    t = col("tindakan").fillna("").astype(str)
    biaya = pd.to_numeric(col("biaya_tagih_rp"), errors="coerce").to_numpy(float)
    norms = R.nonkap_tindakan if R is not None else {}
    med = np.array([(norms.get(x) or {}).get("median") or np.nan for x in t], float)
    usia = _age(col("tgl_lahir"), d)
    own, kind = col("kepemilikan_faskes"), col("jenis_faskes")
    fas = _fas(list(zip(col("kabkota_faskes_kode"), own, kind, col("tipe_faskes"))), {k: {"per_hari": v} for k, v in (R.nonkap_fac if R is not None else {}).items()},
               ["per_hari"], "NONKAPITASI")
    luar = ((dt < dk) | (dt > dp)).fillna(False).to_numpy(float)
    out = pd.DataFrame({
        "tindakan": t.str.upper().str.strip(), "dx": col("dx_icd3").fillna("?").astype(str).str.upper().str.strip(), "umur": _band(usia),
        "kelompok": [kelompok(x) for x in t], "jenis_faskes": kind, "milik": [_milik(o) for o in own], "tingkat_layanan": col("tingkat_layanan"),
        "jk": col("jk"), "segmen": col("segmen"),
        "biaya": biaya, "tindakan_ke": pd.to_numeric(col("tindakan_ke"), errors="coerce").to_numpy(float), "fas_per_hari": fas["per_hari"],
        "usia": usia, "rasio_median": np.where(med > 0, biaya / np.where(med > 0, med, 1), np.nan), "hari_tindakan": (dt - dk).dt.days.to_numpy(float),
        "luar_kunjungan": luar, "akhir_pekan": (d.dt.dayofweek >= 5).to_numpy(float)})
    return out[NONKAP.base_cols]


def _keys(s: Any) -> Any:
    return s.fillna("?").astype(str).str.upper().str.strip()


def fit_tables(spec: Spec, base: Any) -> dict:
    """Counts of the keys and key pairs among the training records (for f_* and pmi_*)."""
    cols = sorted({*spec.singles, *[a for a, _ in spec.pairs], *[b for _, b in spec.pairs]})
    tabs: dict[str, Any] = {"N": int(len(base)), "m": {}, "p": {}}
    for c in cols:
        tabs["m"][c] = {str(k): int(v) for k, v in _keys(base[c]).value_counts().items()}
    for a, b in spec.pairs:
        tabs["p"][f"{a}|{b}"] = {str(k): int(v) for k, v in (_keys(base[a]) + "||" + _keys(base[b])).value_counts().items()}
    return tabs


def derive(spec: Spec, base: Any, tabs: Optional[dict]) -> Any:
    """base + the frequency features from the model's tables."""
    if not spec.derived:
        return base
    out = base.copy()
    N = float(tabs["N"])
    for s in spec.singles:
        n = _keys(base[s]).map(tabs["m"][s]).fillna(0).to_numpy(float)
        out[f"f_{s}"] = np.log10((n + 1) / (N + 1))
    for a, b in spec.pairs:
        ka, kb = _keys(base[a]), _keys(base[b])
        na = ka.map(tabs["m"][a]).fillna(0).to_numpy(float)
        nb = kb.map(tabs["m"][b]).fillna(0).to_numpy(float)
        nab = (ka + "||" + kb).map(tabs["p"][f"{a}|{b}"]).fillna(0).to_numpy(float)
        out[f"pmi_{a}_{b}"] = np.clip(np.log((nab + 1) * (N + 1) / ((na + 1) * (nb + 1))), -10, 10)
    return out


class Prep:
    """The feature transform of one spec, fitted on the pretraining records and kept with the model."""

    def __init__(self, spec: Spec, med: dict, iqr: dict) -> None:
        self.spec, self.med, self.iqr = spec, med, iqr
        num = spec.num
        self.names = [*num, *[f"na_{c}" for c in num], *[f"{k}={v}" for k, vs in spec.cats.items() for v in vs]]
        # fields: a numeric value with its missing flag, or a category's one-hot block (corrupted and explained together)
        self.fields: list[tuple[str, list[int]]] = [(c, [i, len(num) + i]) for i, c in enumerate(num)]
        j = 2 * len(num)
        for k, vs in spec.cats.items():
            self.fields.append((k, list(range(j, j + len(vs)))))
            j += len(vs)
        self.group = np.zeros(len(self.names), int)
        for g, (_, dims) in enumerate(self.fields):
            self.group[dims] = g

    def raw(self, df: Any) -> np.ndarray:
        import pandas as pd

        cols = []
        for c in self.spec.log:
            v = pd.to_numeric(df[c], errors="coerce").to_numpy(float) if c in df else np.full(len(df), np.nan)
            cols.append(np.log1p(np.clip(v, 0, None)))
        for c in [*self.spec.raw, *self.spec.derived]:
            v = pd.to_numeric(df[c], errors="coerce").to_numpy(float) if c in df else np.full(len(df), np.nan)
            cols.append(np.clip(v, -50, 50))
        return np.vstack(cols).T if cols else np.zeros((len(df), 0))

    @classmethod
    def fit(cls, spec: Spec, df: Any) -> "Prep":
        x = cls(spec, {}, {}).raw(df)
        med = np.nanmedian(x, axis=0)
        q75, q25 = np.nanpercentile(x, 75, axis=0), np.nanpercentile(x, 25, axis=0)
        # a floor under the scale: a feature that is almost constant (kembar is 1 on nearly every claim) must not turn a
        # one-step change into an extreme value
        iqr = np.maximum(q75 - q25, np.maximum(np.nanstd(x, axis=0), 0.1))
        num = spec.num
        return cls(spec, {n: float(m) for n, m in zip(num, np.nan_to_num(med))}, {n: float(i) for n, i in zip(num, np.nan_to_num(iqr, nan=1.0))})

    def cat(self, df: Any, k: str) -> np.ndarray:
        if k not in df:
            return np.array([""] * len(df))
        s = df[k].fillna("").astype(str)
        return (s.str.upper().str.strip() if self.spec.upper else s).to_numpy()

    def transform(self, df: Any) -> np.ndarray:
        x = self.raw(df)
        num = self.spec.num
        med = np.array([self.med[n] for n in num])
        iqr = np.array([self.iqr[n] for n in num])
        na = np.isnan(x)
        z = np.clip(np.where(na, 0.0, (x - med) / iqr), -8, 8)
        oh = []
        for k, vs in self.spec.cats.items():
            col = self.cat(df, k)
            for v in vs:
                oh.append((col == (v.upper() if self.spec.upper else v)).astype(float))
        parts = [z, na.astype(float)] + ([np.vstack(oh).T] if oh else [])
        return np.hstack(parts).astype(np.float32)

    def inverse(self, c: str, zval: float) -> float:
        """A scaled value back in the feature's units (for explanations)."""
        v = zval * self.iqr[c] + self.med[c]
        return float(np.expm1(v)) if c in self.spec.log else float(v)


def _net(d: int) -> Any:
    import torch.nn as nn

    class VIME(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.enc = nn.Sequential(nn.Linear(d, 128), nn.GELU(), nn.Linear(128, 64), nn.GELU(), nn.Linear(64, EMB))
            self.dec = nn.Sequential(nn.Linear(EMB, 64), nn.GELU(), nn.Linear(64, 128), nn.GELU(), nn.Linear(128, d))
            self.mask = nn.Sequential(nn.Linear(EMB, 64), nn.GELU(), nn.Linear(64, d))

        def forward(self, x: Any) -> tuple:
            h = self.enc(x)
            return h, self.dec(h), self.mask(h)

    return VIME()


def _fmt(spec: Spec, c: str, v: Optional[float]) -> str:
    if v is None or v != v:
        return "tidak tercatat"
    if c in spec.money:
        a = abs(v)
        if a >= 1e9:
            return f"Rp{v / 1e9:.2f} miliar".replace(".", ",")
        if a >= 1e6:
            return f"Rp{v / 1e6:.1f} juta".replace(".", ",")
        return f"Rp{v:,.0f}".replace(",", ".")
    if c.startswith("pmi_"):
        r = math.exp(v)
        return f"{r:.2f}× dari kebetulan".replace(".", ",") if r < 10 else f"{r:.0f}× dari kebetulan"
    if c.startswith("f_") and c[2:] in spec.singles:
        return f"1 dari {10 ** (-v):,.0f}".replace(",", ".")
    if c in ("unit_sama", "rujuk_nonspes", "rujuk_luar_kab", "akhir_pekan", "luar_kunjungan", "ada_prosedur"):
        return "ya" if v >= 0.5 else "tidak"
    if abs(v) >= 100:
        return f"{v:,.0f}".replace(",", ".")
    return f"{v:.2f}".replace(".", ",")


def _jv(v: Any) -> Any:
    v = _c(v)
    if v is None:
        return None
    if isinstance(v, (bool, np.bool_)):
        return float(v)
    if isinstance(v, (int, float, np.integer, np.floating)):
        return float(v)
    return str(v)


class Model:
    def __init__(self, spec: Spec, prep: Prep, tabs: Optional[dict], net: Any, meta: dict) -> None:
        self.spec, self.prep, self.tabs, self.net, self.meta = spec, prep, tabs, net, meta

    @property
    def versi(self) -> str:
        return self.meta["versi"]

    def score_base(self, base: Any) -> tuple[np.ndarray, np.ndarray, Any, np.ndarray, np.ndarray]:
        """(reconstruction error, embedding, frame, transformed input, reconstruction) per row, on the clean input."""
        import torch

        fr = derive(self.spec, base.reindex(columns=self.spec.base_cols), self.tabs)
        z = self.prep.transform(fr)
        with torch.no_grad():
            h, rec, _ = self.net(torch.from_numpy(z))
            rec = rec.numpy()
        err = ((rec - z) ** 2).mean(axis=1)
        return err, h.numpy(), fr, z, rec

    def signal(self, err: float) -> Optional[float]:
        """The anomaly signal's strength, or None below the held-out records' p99.9."""
        hi = self.meta["ambang"]["p999"]
        if err <= hi:
            return None
        return float(min(1.0, 0.5 + 0.5 * np.log(err / hi)))

    def explain(self, fr_row: dict, z: np.ndarray, rec: np.ndarray, top: int = 3) -> list[dict]:
        """The fields the network could not reconstruct, largest first: what the record has vs what records like it have."""
        se = (rec - z) ** 2
        tot = float(se.sum()) or 1.0
        rows = []
        for name, dims in self.prep.fields:
            share = float(se[dims].sum()) / tot
            if share < 0.1:
                continue
            if name in self.spec.cats:
                vs = self.spec.cats[name]
                blk = z[dims]
                have = vs[int(np.argmax(blk))] if blk.max() > 0.5 else "lainnya"
                want = vs[int(np.argmax(rec[dims]))]
                rows.append({"fitur": name, "label": self.spec.label.get(name, name), "nilai": have, "pola": want, "porsi": round(share, 3)})
            else:
                v = fr_row.get(name)
                v = None if v is None or (isinstance(v, float) and v != v) else float(v)
                exp = self.prep.inverse(name, float(rec[dims[0]]))
                rows.append({"fitur": name, "label": self.spec.label.get(name, name), "nilai": _fmt(self.spec, name, v), "pola": _fmt(self.spec, name, exp),
                             "arah": None if v is None else ("lebih tinggi" if v > exp else "lebih rendah"), "porsi": round(share, 3)})
        rows.sort(key=lambda r: -r["porsi"])
        return rows[:top]

    def x_of(self, base: Any) -> list[list]:
        """The raw inputs an event keeps (JSON: NaN → null, booleans → 0/1)."""
        return [[_jv(v) for v in row] for row in base.reindex(columns=self.spec.base_cols).itertuples(index=False)]

    def from_x(self, xs: list[list]) -> Any:
        import pandas as pd

        return pd.DataFrame(xs, columns=self.spec.base_cols)

    def record(self, err: float, emb: np.ndarray, x: list, alasan: Optional[list] = None) -> dict:
        """What an event stores of this model's view of it: error, how unusual on the held-out scale (biasa < p99 ≤
        tidak_lazim < p99.9 ≤ anomali), embedding, raw inputs, and the explanation."""
        a = self.meta["ambang"]
        err = float(err)
        out = {"versi": self.versi, "spek": self.spec.key(), "err": round(err, 5),
               "tingkat": "anomali" if err > a["p999"] else "tidak_lazim" if err > a["p99"] else "biasa",
               "skala": [round(a["p50"], 5), round(a["p99"], 5), round(a["p999"], 5)],
               "emb": [round(float(v), 3) for v in emb], "x": x}
        if alasan:
            out["alasan"] = alasan
        return out

    def score_events(self, base: Any) -> list[dict]:
        """One stored record per row: error, embedding, raw inputs, and the explanation when the error is above p99."""
        err, emb, fr, z, rec = self.score_base(base)
        xs = self.x_of(base)
        p99 = self.meta["ambang"]["p99"]
        recs = fr.to_dict("records")
        return [self.record(err[i], emb[i], xs[i], self.explain(recs[i], z[i], rec[i]) if err[i] > p99 else None) for i in range(len(err))]


# ------------------------------------------------------------------------------------------------
# training
# ------------------------------------------------------------------------------------------------
def fit(spec: Spec, base: Any, before: str, epochs: int = 5, say: Any = None, sumber: str = "") -> dict:
    """Pretrain one kind's model on `base` (records before `before`). No label is read."""
    import torch

    say = say or (lambda m: None)
    t0 = time.time()
    torch.manual_seed(20261110)
    rng = np.random.default_rng(20261110)
    tabs = fit_tables(spec, base) if spec.derived else None
    fr = derive(spec, base, tabs)
    prep = Prep.fit(spec, fr)
    xall = prep.transform(fr)
    perm = rng.permutation(len(xall))
    n_val = max(int(HOLDOUT * len(xall)), 1)
    xv, xt = torch.from_numpy(xall[perm[:n_val]]), torch.from_numpy(xall[perm[n_val:]])
    n, d = xt.shape
    G = len(prep.fields)
    gidx = torch.from_numpy(prep.group)
    net = _net(d)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-5)
    bce = torch.nn.BCEWithLogitsLoss()
    hist, val = [], []
    for ep in range(epochs):
        net.train()
        order = torch.randperm(n)
        tot = cnt = 0.0
        for i in range(0, n, 1024):
            xb = xt[order[i:i + 1024]]
            b = len(xb)
            mg = (torch.rand(b, G) < MASK_P).float()  # which fields are replaced
            m = mg[:, gidx]
            src = torch.randint(0, b, (b, G))[:, gidx]  # each replaced field from another record (the whole field)
            shuffled = torch.gather(xb, 0, src)
            xc = xb * (1 - m) + shuffled * m
            h, rec, mlog = net(xc)
            loss = ((rec - xb) ** 2).mean() + 0.5 * bce(mlog, m)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.detach()) * b
            cnt += b
        hist.append(round(tot / cnt, 5))
        net.eval()
        with torch.no_grad():
            _, rv, _ = net(xv)
            val.append(round(float(((rv - xv) ** 2).mean()), 5))
        STATE["progres"] = {"jenis": spec.kind, "epoch": ep + 1, "dari": epochs, "loss": hist[-1]}
        say(f"ssl {spec.kind} epoch {ep + 1}/{epochs}: loss {hist[-1]}, galat held-out {val[-1]}")
    net.eval()
    with torch.no_grad():
        _, rv, _ = net(xv)
        err_v = ((rv - xv) ** 2).mean(dim=1).numpy()
        errs = []
        for i in range(0, n, 8192):
            _, r2, _ = net(xt[i:i + 8192])
            errs.append(((r2 - xt[i:i + 8192]) ** 2).mean(dim=1).numpy())
    err_t = np.concatenate(errs)
    meta = {"versi": f"ssl-{spec.kind}-" + time.strftime("%Y%m%d%H%M%S"), "jenis": spec.kind, "pada": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "klaim": int(len(xall)), "latih": int(n), "held_out": int(n_val), "fitur": int(d), "medan": G, "nama_fitur": prep.names, "epoch": epochs,
            "loss": hist, "galat_held_out": val, "embedding": EMB, "mask_p": MASK_P, "korupsi": "per medan (nilai + penanda hilang, atau satu blok kategori)",
            "sebelum": before, "sumber": sumber, "spek": spec.key(),
            # thresholds from records the network did not fit (in-sample errors are lower: p99.9 would be too tight)
            "ambang": {"p50": float(np.percentile(err_v, 50)), "p99": float(np.percentile(err_v, 99)), "p999": float(np.percentile(err_v, 99.9))},
            "ambang_dalam_sampel": {"p99": float(np.percentile(err_t, 99)), "p999": float(np.percentile(err_t, 99.9))},
            "detik": round(time.time() - t0, 1), "metode": "masked autoencoder tabular (VIME): rekonstruksi + estimasi mask, tanpa label"}
    out = _dir()
    torch.save(net.state_dict(), out / f"ssl-{spec.kind}.pt")
    (out / f"ssl-{spec.kind}.json").write_text(json.dumps({**meta, "prep": {"med": prep.med, "iqr": prep.iqr}, "tabel": tabs}, ensure_ascii=False), "utf-8")
    return meta


def load_base(kind: str, src: dict, before: str, R: Any, sample: int = 400_000) -> tuple[Any, str]:
    """The pretraining records of one kind (before the window), as base columns; and where they came from."""
    import duckdb

    from aip.realtime.referensi import anggota_sql

    con = duckdb.connect()
    try:
        if kind == "fkrtl":
            cols = sorted({*FKRTL.log, *FKRTL.raw, *FKRTL.cats})
            df = con.execute(f"""SELECT {', '.join(cols)} FROM read_parquet('{src['fitur']}') WHERE tgl_datang < DATE '{before}'
                                 USING SAMPLE {int(sample)} ROWS (reservoir, 7)""").df()
            return df.reindex(columns=FKRTL.base_cols), "tabel fitur ML (titik waktu)"
        reg = anggota_sql(src["peserta"])
        if kind == "fktp":
            df = con.execute(f"""WITH v AS (SELECT edisi, peserta_id, tgl_datang, tgl_pulang, kabkota_fktp_kode, kepemilikan_fktp, jenis_fktp, tipe_fktp,
                                        tingkat_pelayanan, poli, jenis_kunjungan, status_pulang, dx_icd3, kabkota_rujukan_kode, tipe_faskes_rujukan
                                   FROM read_parquet('{src['fktp']}') WHERE tgl_datang < DATE '{before}' USING SAMPLE {int(sample)} ROWS (reservoir, 7))
                                 SELECT v.*, a.jk, a.tgl_lahir, a.unit_terdaftar, a.segmen FROM v LEFT JOIN ({reg}) a USING (edisi, peserta_id)""").df()
            return base_fktp(df, R), "silver kunjungan_fktp + registri peserta + riwayat FKTP"
        df = con.execute(f"""WITH n AS (SELECT edisi, peserta_id, tgl_kunjungan, tgl_tindakan, tgl_pulang, kabkota_faskes_kode, kepemilikan_faskes, jenis_faskes,
                                    tipe_faskes, tingkat_layanan, dx_icd3, tindakan, tindakan_ke, biaya_tagih_rp
                               FROM read_parquet('{src['nonkap']}') WHERE tgl_kunjungan < DATE '{before}' USING SAMPLE {int(sample)} ROWS (reservoir, 7))
                             SELECT n.*, a.jk, a.tgl_lahir, a.segmen FROM n LEFT JOIN ({reg}) a USING (edisi, peserta_id)""").df()
        return base_nonkap(df, R), "silver tindakan_nonkapitasi + registri peserta + riwayat faskes"
    finally:
        con.close()


def _read(kind: str) -> Optional[dict]:
    f = _dir() / f"ssl-{kind}.json"
    if f.is_file() and (_dir() / f"ssl-{kind}.pt").is_file():
        return json.loads(f.read_text("utf-8"))
    return None


def load(kind: str) -> Optional[Model]:
    import torch

    meta = _read(kind)
    if meta is None:
        return None
    spec = SPECS[kind]
    if meta.get("spek") != spec.key():
        log.warning("ssl %s: model for another input spec (%s, now %s): retrain", kind, meta.get("spek"), spec.key())
        return None
    prep = Prep(spec, meta["prep"]["med"], meta["prep"]["iqr"])
    net = _net(meta["fitur"])
    net.load_state_dict(torch.load(_dir() / f"ssl-{kind}.pt", weights_only=True))
    net.eval()
    return Model(spec, prep, meta.get("tabel"), net, {k: v for k, v in meta.items() if k not in ("prep", "tabel")})


def load_all() -> dict[str, Model]:
    out = {}
    for k in KINDS:
        try:
            m = load(k)
        except Exception:  # noqa: BLE001 - a broken file leaves that kind without SSL
            log.exception("ssl: load %s", k)
            m = None
        if m is not None:
            out[k] = m
    return out


def train_async(kinds: list[str], src: dict, before: str, R: Any, done: Callable[[str, Optional[Model]], None]) -> None:
    """Pretraining of the given kinds, one after another, in a thread; `done(kind, model)` after each."""
    if STATE["status"] == "berjalan":
        return
    STATE.update(status="berjalan", progres=None, galat=None, hasil={})

    def run() -> None:
        try:
            for k in kinds:
                STATE["progres"] = {"jenis": k, "epoch": 0, "dari": 5, "loss": None}
                base, sumber = load_base(k, src, before, R)
                log.info("ssl %s: %d records for pretraining", k, len(base))
                meta = fit(SPECS[k], base, before, say=log.info, sumber=sumber)
                STATE["hasil"][k] = meta["versi"]
                done(k, load(k))
            STATE.update(status="selesai")
        except Exception as e:  # noqa: BLE001
            log.exception("ssl: train")
            STATE.update(status="gagal", galat=str(e)[:300])
    threading.Thread(target=run, daemon=True, name="realtime-ssl").start()


# ------------------------------------------------------------------------------------------------
# drift: the stream's share of records above the held-out thresholds
# ------------------------------------------------------------------------------------------------
def drift(n: int, k99: int, k999: int) -> dict:
    """The stream against the held-out expectation (1 % above p99, 0.1 % above p99.9): exact binomial tails."""
    from scipy.stats import binom

    out = {"n": n, "di_atas_p99": k99, "di_atas_p999": k999, "porsi_p99": k99 / n if n else None, "porsi_p999": k999 / n if n else None}
    if n >= 500:
        p = float(binom.sf(k99 - 1, n, 0.01))
        out["p_binomial"] = p
        out["status"] = "drift" if (p < 1e-4 and k99 / n > 0.015) else "stabil"
    else:
        out["status"] = "terlalu sedikit data"
    return out
