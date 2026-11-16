"""The synthesizer of one edition: peserta -> FKRTL claim sequences -> referral visits -> FKTP visit sequences ->
non-capitation visits and procedures -> secondary diagnoses. Every level is a sequential CART chain (cart.Chain) fitted
on the real training split of that edition and sampled in the order of the source's foreign keys.
"""

from __future__ import annotations

import time
from typing import Callable

import numpy as np
import pandas as pd

from sgen import config, real
from sgen.cart import Chain, LocalStep, Step, as_numeric_if_possible


# ------------------------------------------------------------------------------------------------
# small helpers for step specs
# ------------------------------------------------------------------------------------------------


def first(d):
    return d["j"].to_numpy() == 1


def nxt(d):
    return d["j"].to_numpy() > 1


def zeros(*cols):
    return lambda d: pd.DataFrame({c: np.zeros(len(d)) for c in cols}, index=d.index)


def copy_from(**mapping):
    return lambda d: pd.DataFrame({t: d[s].to_numpy() for t, s in mapping.items()}, index=d.index)


def letter(col):
    return lambda d: d[col].astype(str).str[:1].where(d[col].notna().to_numpy() & (d[col].astype(str) != ""), "<NA>")


def prov(col):
    return lambda d: (pd.to_numeric(d[col], errors="coerce") // 100).fillna(-1).astype(int).astype(str)


def num_eq(d, col, v):
    return pd.to_numeric(d[col], errors="coerce").to_numpy() == v


def copy_where(cond, **mapping):
    """Copy columns (target=source) on the rows where cond(d) holds; the other rows are left as they are."""
    def f(d):
        m = np.asarray(cond(d), bool)
        for t, src in mapping.items():
            if t not in d.columns:
                d[t] = np.nan
            if m.any():
                d[t] = d[t].astype(object)
                d.loc[m, t] = d.loc[m, src].to_numpy()
                d[t] = as_numeric_if_possible(d[t])  # numbers stay numbers (an object column was read as text by the trees)
        return d
    return f


def missed(name):
    return lambda d: d[f"_miss_{name}"].to_numpy().astype(bool) if f"_miss_{name}" in d.columns else np.zeros(len(d), bool)


def kind_prov(kind_col, kab_col):
    """Proxy for a facility tuple: its type AND its province, so leaves are pure in both (a tree grown on the province alone
    mixed facility types across referral states: e.g. referrals drawn from a type that never refers)."""
    p = prov(kab_col)
    return lambda d: d[kind_col].astype(str) + "|" + p(d)


def keep(cols, have):
    return [c for c in cols if c in have]


def jitter_age(out, rng):
    sentinel = (pd.Timestamp("2024-12-31") - pd.Timestamp(config.BIRTH_SENTINEL)).days
    a = pd.to_numeric(out["age"], errors="coerce")
    j = rng.integers(-config.AGE_JITTER_DAYS, config.AGE_JITTER_DAYS + 1, len(out))
    out["age"] = np.where(a.to_numpy() == sentinel, a, np.maximum(a + j, 0))
    return out


def set_day(d):
    d["day"] = np.where(d["j"].to_numpy() == 1, pd.to_numeric(d["day"], errors="coerce"),
                        pd.to_numeric(d["p_day"], errors="coerce") + pd.to_numeric(d.get("gap"), errors="coerce"))
    return d


def ref_flags(d):
    """has_ref (this claim carries a referral) and any_ref (this peserta has had one up to and including this claim)."""
    d["has_ref"] = (pd.to_numeric(d["ref_state"]) > 0).astype(int)
    d["any_ref"] = np.maximum(pd.to_numeric(d.get("p_any_ref"), errors="coerce").fillna(0).to_numpy(), d["has_ref"].to_numpy()).astype(int)
    return d


def last_referral(d):
    """The referring facility of the peserta's latest referral, carried forward (a reused referral copies it)."""
    has = d["has_ref"].to_numpy() == 1
    for src, lag, out in (("FKL26", "p_lrkab", "lrkab"), ("FKL27", "p_lrmilik", "lrmilik"), ("FKL28", "p_lrjenis", "lrjenis"), ("FKL29", "p_lrtipe", "lrtipe")):
        prev = d[lag] if lag in d.columns else pd.Series(np.nan, index=d.index)
        d[out] = np.where(has, pd.to_numeric(d[src], errors="coerce"), pd.to_numeric(prev, errors="coerce"))
    return d


def _filled(s: pd.Series) -> np.ndarray:
    return (s.notna() & (s.astype(str) != "") & (s.astype(str) != "None")).to_numpy()


def sp_flag(d):
    sp = [c for c in ("FKL33", "FKL35", "FKL38", "FKL41", "FKL44") if c in d.columns]
    d["sp_any"] = np.column_stack([_filled(d[c]) for c in sp]).any(axis=1).astype(int) if sp else 0
    return d


def sp_pattern(sp):
    def f(d):
        out = pd.Series("", index=d.index)
        for c in sp:
            out = out + np.where(_filled(d[c]), "1", "0")
        return out
    return f


# ------------------------------------------------------------------------------------------------
# step specs
# ------------------------------------------------------------------------------------------------


def peserta_steps(have: set[str]) -> list:
    # age in days is drawn as it is (no jitter inside the chain: birth dates heap on a few days of the year, and the
    # segment follows that heaping; jittered ages fell into the wrong leaves and shifted segment 2 from 31 % to 20 %).
    # The released birth date is perturbed afterwards (edition._release_birthdates).
    s = [Step("PSTV05", ["PSTV05"], []), Step("age", ["age"], ["PSTV05"], "num")]
    ctx = ["PSTV05", "age"]
    for c in keep(["PSTV08", "PSTV04", "PSTV06", "PSTV07"], have):
        s.append(Step(c, [c], list(ctx)))
        ctx.append(c)
    loc = keep(["PSTV10", "PSTV11", "PSTV12", "PSTV14"], have)
    s.append(Step("loc", loc, list(ctx), proxy=prov("PSTV10"), rare=True))
    ctx += loc
    for c in keep(["PSTV16", "PSTV17", "PSTV18", "PSTV21", "PSTV22"], have):
        s.append(Step(c, [c], list(ctx)))
        ctx.append(c)
    if "PSTV15" in have:
        s.append(Step("PSTV15", ["PSTV15"], list(ctx), "num"))
    s.append(Step("n_fkrtl", ["n_fkrtl"], list(ctx), "num"))
    ctx.append("n_fkrtl")
    s.append(Step("has_ritl", ["has_ritl"], list(ctx), when=lambda d: pd.to_numeric(d["n_fkrtl"]).to_numpy() > 0, fill=zeros("has_ritl")))
    ctx.append("has_ritl")
    s.append(Step("main_letter", ["main_letter"], list(ctx)))
    ctx.append("main_letter")
    s.append(Step("n_fktp", ["n_fktp"], list(ctx), "num"))
    ctx.append("n_fktp")
    s.append(Step("n_nk", ["n_nk"], list(ctx), "num"))
    return s


P = ["PSTV05", "age", "PSTV08", "PSTV07", "PSTV10", "PSTV14", "n_fkrtl", "has_ritl", "main_letter"]
L = ["j", "rem", "p_day", "p_los", "p_tingkat", "p_kab", "p_tipe", "p_poli", "p_dx", "p_cbg", "p_has_ref", "p_any_ref"]
FKRTL_LAGS = {"p_day": "day", "p_los": "los", "p_tingkat": "FKL10", "p_kab": "FKL06", "p_milik": "FKL07", "p_jenis": "FKL08", "p_tipe": "FKL09",
              "p_poli": "FKL11", "p_dx": "FKL18", "p_dxa": "FKL18A", "p_cbg": "FKL19", "p_has_ref": "has_ref", "p_rkab": "FKL26",
              "p_rmilik": "FKL27", "p_rjenis": "FKL28", "p_rtipe": "FKL29", "p_any_ref": "any_ref",
              "p_lrkab": "lrkab", "p_lrmilik": "lrmilik", "p_lrjenis": "lrjenis", "p_lrtipe": "lrtipe"}


def fkrtl_steps(have: set[str]) -> list:
    prof = ["FKL06", "FKL07", "FKL08", "FKL09"]
    s = [Step("day0", ["day"], P, "num", when=first),
         Step("gap", ["gap"], P + L, "num", when=nxt),
         set_day,
         Step("FKL10", ["FKL10"], P + L + ["day", "gap"]),
         Step("same_prof", ["same_prof"], P + L + ["FKL10", "gap"], when=nxt, fill=zeros("same_prof")),
         copy_where(lambda d: nxt(d) & num_eq(d, "same_prof", 1), FKL06="p_kab", FKL07="p_milik", FKL08="p_jenis", FKL09="p_tipe"),
         Step("rs_home", ["rs_home"], P + ["PSTV11", "PSTV12", "FKL10", "p_kab", "j"], when=lambda d: first(d) | num_eq(d, "same_prof", 0),
              fill=zeros("rs_home")),
         LocalStep("rs_local", "PSTV14", "FKL06", ["FKL07", "FKL08", "FKL09"], ["FKL10"],
                   when=lambda d: (first(d) | num_eq(d, "same_prof", 0)) & num_eq(d, "rs_home", 1)),
         Step("prof", prof, P + ["PSTV11", "PSTV12", "FKL10", "p_kab", "p_tipe", "j"], proxy=kind_prov("FKL08", "FKL06"), rare=True,
              when=lambda d: (first(d) | num_eq(d, "same_prof", 0)) & (num_eq(d, "rs_home", 0) | missed("rs_local")(d))),
         Step("FKL11", ["FKL11"], P + L + ["FKL10"] + prof + ["same_prof", "gap"]),
         Step("FKL12", ["FKL12"], P + ["FKL10", "FKL09"]),
         Step("FKL13", ["FKL13"], P + ["FKL10", "FKL09", "FKL07", "FKL11"]),
         Step("los", ["los"], P + L + ["FKL10", "FKL09", "FKL11", "same_prof", "gap"], "num"),
         Step("FKL14", ["FKL14"], P + ["FKL10", "los", "FKL09", "FKL11"]),
         Step("same_dx", ["same_dx"], P + L + ["FKL10", "FKL11", "same_prof", "gap", "los"], when=nxt, fill=zeros("same_dx")),
         Step("pdx", ["FKL18", "FKL18A"], P + ["FKL10", "FKL11", "los", "FKL14", "FKL09", "p_dx", "j", "gap"], proxy=letter("FKL18"), rare=True,
              when=lambda d: first(d) | (pd.to_numeric(d["same_dx"]).to_numpy() == 0), fill=copy_from(FKL18="p_dx", FKL18A="p_dxa")),
         Step("adm_same", ["adm_same"], ["FKL10", "FKL11", "los", "FKL18", "age", "PSTV05"]),
         Step("adx", ["FKL16", "FKL16A"], ["FKL18", "FKL10", "FKL11", "los", "age", "PSTV05"], proxy=letter("FKL16"), rare=True,
              when=lambda d: pd.to_numeric(d["adm_same"]).to_numpy() == 0, fill=copy_from(FKL16="FKL18", FKL16A="FKL18A")),
         Step("FKL19", ["FKL19"], ["FKL18", "FKL16", "FKL10", "los", "age", "PSTV05", "FKL11", "FKL09", "FKL14", "FKL13", "p_cbg", "same_dx"],
              proxy=lambda d: d["FKL19"].astype(str).str[:3], rare=True),
         Step("FKL31", ["FKL31"], ["FKL06", "FKL09", "FKL07", "FKL08"])]
    sp = keep(["FKL33", "FKL35", "FKL38", "FKL41", "FKL44"], have)
    if sp:
        s.append(Step("sp", sp, ["FKL19", "FKL10", "los", "FKL09", "FKL11", "FKL06"], rare=True, proxy=sp_pattern(sp)))
    s.append(sp_flag)
    if "FKL30" in have:
        s.append(Step("FKL30", ["FKL30"], ["FKL19", "FKL18", "FKL10", "los", "FKL11", "FKL09"], rare=True,
                      proxy=lambda d: d["FKL30"].astype(str).str[:2].where(d["FKL30"].notna().to_numpy() & (d["FKL30"].astype(str) != ""), "<NA>")))
    s.append(Step("n_dx", ["n_dx"], ["FKL19", "FKL18", "los", "age", "FKL10", "FKL09", "FKL11"], "num"))
    if "FKP02" in have:
        s += [Step("ref_state", ["ref_state"], P + ["j", "p_has_ref", "p_any_ref", "gap", "same_prof", "FKL10", "FKL11", "FKL09", "FKL18"]),
              Step("days_ref", ["days_ref"], ["FKL10", "FKL11", "FKL09", "age", "FKL18", "j", "day"], "num",
                   when=lambda d: pd.to_numeric(d["ref_state"]).to_numpy() == 2)]
    else:
        s.append(lambda d: d.assign(ref_state=0, days_ref=np.nan))
    s.append(ref_flags)
    need_ruj = lambda d: ~num_eq(d, "ref_state", 1) | d["p_lrkab"].isna().to_numpy()  # noqa: E731
    s += [copy_where(lambda d: ~need_ruj(d), FKL26="p_lrkab", FKL27="p_lrmilik", FKL28="p_lrjenis", FKL29="p_lrtipe"),
          Step("ruj_home", ["ruj_home"], ["ref_state", "has_ref", "PSTV14", "PSTV10", "FKL06", "FKL09", "FKL10", "FKL11"], when=need_ruj, fill=zeros("ruj_home")),
          LocalStep("ruj_local", "PSTV14", "FKL26", ["FKL27", "FKL28", "FKL29"], ["has_ref", "FKL10"], when=lambda d: need_ruj(d) & num_eq(d, "ruj_home", 1)),
          Step("ruj", ["FKL26", "FKL27", "FKL28", "FKL29"], ["ref_state", "PSTV14", "PSTV10", "FKL06", "FKL09", "FKL10", "FKL11"], proxy=kind_prov("FKL28", "FKL26"),
               rare=True, when=lambda d: need_ruj(d) & (num_eq(d, "ruj_home", 0) | missed("ruj_local")(d))),
          last_referral,
          Step("resid_flag", ["resid_flag"], ["FKL09", "FKL07", "FKL08", "FKL19", "FKL10", "los", "FKL06", "FKL13", "sp_any"], balanced=True),
          Step("resid_ratio", ["resid_ratio"], ["FKL09", "FKL19", "los", "FKL10", "FKL07"], "num",
               when=lambda d: pd.to_numeric(d["resid_flag"]).to_numpy() == 1),
          Step("diff_flag", ["diff_flag"], ["FKL09", "FKL08", "FKL07", "FKL06", "FKL10", "los", "FKL19", "FKL18", "age", "FKL13", "PSTV07",
                                            "resid_flag", "n_dx", "FKL14", "FKL11", "PSTV08"], balanced=True),
          Step("diff_ratio", ["diff_ratio"], ["FKL09", "FKL10", "los", "FKL19", "FKL07"], "num",
               when=lambda d: pd.to_numeric(d["diff_flag"]).to_numpy() == 1)]
    if "FKL49" in have:
        s.append(Step("FKL49", ["FKL49"], ["FKL18", "FKL19", "day", "FKL10"]))
    return s


P2 = ["PSTV05", "age", "PSTV08", "PSTV07", "PSTV10", "PSTV11", "PSTV12", "PSTV14", "n_fktp", "n_fkrtl", "main_letter"]
L2 = ["j", "rem", "p_day", "p_kab", "p_tipe", "p_tingkat", "p_poli", "p_dx"]
FKTP_LAGS = {"p_day": "day", "p_kab": "FKP06", "p_milik": "FKP07", "p_jenis": "FKP08", "p_tipe": "FKP09", "p_tingkat": "FKP10", "p_poli": "FKP11",
             "p_dx": "FKP14", "p_dx15": "FKP15", "p_dx15a": "FKP15A"}


def fktp_tail(have, ctx_extra: list[str]) -> list:
    dx = keep(["FKP14", "FKP15", "FKP15A"], have)
    dest = keep(["FKP17", "FKP18", "FKP19", "FKP20", "FKP21"], have)
    s = [Step("FKP10", ["FKP10"], ctx_extra + ["FKP08", "FKP09"]),
         Step("FKP11", ["FKP11"], ctx_extra + ["FKP10", "FKP08", "FKP09"]),
         Step("FKP12", ["FKP12"], ctx_extra + ["FKP10", "FKP08"])]
    return s, dx, dest


def fktp_steps(have: set[str]) -> list:
    prof = ["FKP06", "FKP07", "FKP08", "FKP09"]
    s = [Step("day0", ["day"], P2, "num", when=first), Step("gap", ["gap"], P2 + L2, "num", when=nxt), set_day,
         Step("same_prof", ["same_prof"], P2 + L2 + ["gap"], when=nxt, fill=zeros("same_prof")),
         copy_where(lambda d: nxt(d) & num_eq(d, "same_prof", 1), FKP06="p_kab", FKP07="p_milik", FKP08="p_jenis", FKP09="p_tipe"),
         Step("ft_home", ["ft_home"], P2 + ["p_kab", "p_tipe", "j"], when=lambda d: first(d) | num_eq(d, "same_prof", 0), fill=zeros("ft_home")),
         LocalStep("ft_local", "PSTV14", "FKP06", ["FKP07", "FKP08", "FKP09"], ["PSTV11", "PSTV12"],
                   when=lambda d: (first(d) | num_eq(d, "same_prof", 0)) & num_eq(d, "ft_home", 1)),
         Step("prof", prof, P2 + ["p_kab", "p_tipe", "j"], proxy=kind_prov("FKP08", "FKP06"), rare=True,
              when=lambda d: (first(d) | num_eq(d, "same_prof", 0)) & (num_eq(d, "ft_home", 0) | missed("ft_local")(d)))]
    tail, dx, dest = fktp_tail(have, P2 + L2 + ["same_prof", "gap"])
    s += tail
    s += [Step("same_dx", ["same_dx"], P2 + L2 + ["FKP10", "FKP11", "same_prof", "gap"], when=nxt, fill=zeros("same_dx")),
          Step("dx", dx, P2 + L2 + ["FKP10", "FKP11", "FKP08", "same_prof", "gap"], proxy=letter("FKP14A"), rare=True,
               when=lambda d: first(d) | (pd.to_numeric(d["same_dx"]).to_numpy() == 0),
               fill=copy_from(**{k: v for k, v in {"FKP14": "p_dx", "FKP15": "p_dx15", "FKP15A": "p_dx15a"}.items() if k in dx})),
          Step("FKP13", ["FKP13"], ["FKP10", "FKP11", "FKP14", "FKP08", "age"]),
          Step("FKP22", ["FKP22"], P2 + ["FKP10", "FKP11", "j", "gap"]),
          Step("los", ["los"], ["FKP10", "FKP11", "FKP08", "FKP14", "age"], "num"),
          Step("dest", dest, ["FKP13", "FKP06", "FKP10", "FKP11", "FKP14", "PSTV14", "age"], proxy=kind_prov("FKP19", "FKP17"), rare=True)]
    if "FKP23" in have:
        s.append(Step("FKP23", ["FKP23"], ["FKP14", "day"]))
    return s


C = ["c_kab", "c_milik", "c_jenis", "c_tipe", "c_tingkat", "c_poli", "c_dx", "c_cbg", "days_ref"]
PR = ["PSTV05", "age", "PSTV08", "PSTV07", "PSTV10", "PSTV11", "PSTV12", "PSTV14"]


def refvisit_steps(have: set[str]) -> list:
    prof = ["FKP06", "FKP07", "FKP08", "FKP09"]
    s = [Step("ft_home", ["ft_home"], PR + C),
         LocalStep("ft_local", "PSTV14", "FKP06", ["FKP07", "FKP08", "FKP09"], ["PSTV11", "PSTV12"], when=lambda d: num_eq(d, "ft_home", 1)),
         Step("prof", prof, PR + C, proxy=kind_prov("FKP08", "FKP06"), rare=True,
              when=lambda d: num_eq(d, "ft_home", 0) | missed("ft_local")(d))]
    tail, dx, dest = fktp_tail(have, PR + C)
    s += tail
    s += [Step("dx", dx, PR + C + ["FKP10", "FKP11", "FKP08"], proxy=letter("FKP14A"), rare=True),
          Step("FKP13", ["FKP13"], ["FKP10", "FKP11", "FKP14", "FKP08", "age", "c_tipe"]),
          Step("FKP22", ["FKP22"], PR + C + ["FKP10", "FKP11"]),
          Step("los", ["los"], ["FKP10", "FKP11", "FKP08", "FKP14", "age"], "num"),
          Step("dest", dest, C + ["FKP13", "FKP06", "FKP10", "FKP11", "FKP14", "PSTV14"], proxy=kind_prov("FKP19", "FKP17"), rare=True)]
    if "FKP23" in have:
        s.append(Step("FKP23", ["FKP23"], ["FKP14", "c_dx"]))
    return s


P3 = ["PSTV05", "age", "PSTV08", "PSTV10", "PSTV14", "n_nk"]


def nk_band(d):
    """How often the peserta uses non-capitation services (1, 2, 3-5, 6+ visits): regular users go to other facility types."""
    n = pd.to_numeric(d["n_nk"], errors="coerce").fillna(0).to_numpy()
    d["nk_band"] = np.select([n <= 1, n <= 2, n <= 5], [1, 2, 3], 4)
    return d


def nkvisit_steps(have: set[str]) -> list:
    return [Step("day0", ["day"], P3, "num", when=first), Step("gap", ["gap"], P3 + ["j", "rem", "p_day"], "num", when=nxt), set_day,
            # non-capitation facilities stay with CART: local donors over-drew one facility type (5 procedures per visit)
            # and inflated the procedure rows by 28 %; this table is ~1 % of rows and its location feeds no referral analysis
            Step("prof", ["PNK07", "PNK08", "PNK09", "PNK10"], P3 + ["j"], proxy=kind_prov("PNK09", "PNK07"), rare=True),
            Step("PNK11", ["PNK11"], P3 + ["PNK09", "PNK10"]),
            Step("PNK12", ["PNK12"], P3 + ["PNK11", "PNK09"]),
            Step("dx", ["PNK14", "PNK15"], P3 + ["PNK11", "PNK09", "PNK10"], proxy=letter("PNK14"), rare=True),
            Step("n_tind", ["n_tind"], ["PNK11", "PNK09", "PNK10", "PNK14", "age"], "num"),
            Step("los", ["los"], ["PNK11", "PNK09", "PNK10", "PNK14", "n_tind"], "num")]


T = ["v_jenis", "v_tipe", "v_tingkat", "v_dx", "v_los", "PSTV05", "age", "n_tind", "k"]


def tindakan_steps(have: set[str]) -> list:
    s = [Step("PNK16", ["PNK16"], T + ["p_tind"]),
         Step("PNK17", ["PNK17"], ["PNK16", "v_tipe", "v_jenis", "v_tingkat"], "num"),
         Step("ratio18", ["ratio18"], ["PNK16", "PNK17", "v_tipe"], "num"),
         Step("d_tind", ["d_tind"], ["PNK16", "v_los", "k"], "num")]
    for c in keep(["PNK19", "PNK20"], have):
        s.append(Step(c, [c], ["PNK16", "v_dx", "age", "PSTV05"], "num"))
    if "PNK21" in have:
        s.append(Step("PNK21", ["PNK21"], ["v_dx"]))
    return s


def dxsek_steps() -> list:
    return [Step("FKL24", ["FKL24"], ["k", "n_dx", "FKL10", "FKL11", "FKL09", "FKL18", "FKL19", "FKL23", "los", "PSTV05", "age"], proxy=letter("FKL24"), rare=True)]


# ------------------------------------------------------------------------------------------------
# sequence generation
# ------------------------------------------------------------------------------------------------


def run_sequence(chain: Chain, base: pd.DataFrame, n_col: str, lags: dict[str, str], valid: Callable[[pd.DataFrame], np.ndarray],
                 rng: np.random.Generator, log, label: str) -> tuple[pd.DataFrame, dict]:
    """Children of each base row (index = pid), one position at a time: position j of every parent with n >= j is drawn
    together, conditioned on the parent and on its child j-1. A child that falls outside the edition's date window
    ends that parent's sequence."""
    active = base.loc[pd.to_numeric(base[n_col]).to_numpy() > 0]
    prev = None
    chunks, j, dropped, t0 = [], 0, 0, time.time()
    while len(active):
        j += 1
        ctx = active.copy()
        ctx["j"] = j
        ctx["rem"] = pd.to_numeric(ctx[n_col]).to_numpy() - j
        if prev is None:
            for lag in lags:
                ctx[lag] = np.nan
        else:
            p = prev.loc[ctx.index]
            for lag, src in lags.items():
                ctx[lag] = p[src].to_numpy() if src in p.columns else np.nan
        out = chain.sample(ctx.reset_index(), rng).set_index("pid")
        ok = np.asarray(valid(out), bool)
        good, bad = [out.loc[ok]], out.index[~ok]
        for _ in range(3):  # a child outside the date window is drawn again (other donors) before the sequence ends there
            if len(bad) == 0:
                break
            redo = chain.sample(ctx.loc[bad].reset_index(), rng).set_index("pid")
            ok2 = np.asarray(valid(redo), bool)
            good.append(redo.loc[ok2])
            bad = redo.index[~ok2]
        dropped += len(bad)
        out = pd.concat(good)
        chunks.append(out.reset_index())
        prev = out
        nxt_ids = out.index[pd.to_numeric(out[n_col]).to_numpy() > j]
        active = active.loc[nxt_ids]
        if j in (1, 5, 25) or j % 100 == 0:
            log(f"      {label} position {j}: {sum(len(c) for c in chunks):,} rows so far, {len(active):,} still going, {time.time() - t0:.0f} s")
    res = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame()
    info = {"rows": len(res), "positions": j, "ended_by_window": dropped, "secs": round(time.time() - t0, 1)}
    log(f"    {label}: {info}")
    return res, info


def window_check(origin, win: dict, day_col="day", los_col="los") -> Callable:
    o = pd.Timestamp(origin)
    max_in = (pd.Timestamp(win["max_in"]) - o).days
    min_out = (pd.Timestamp(win["min_out"]) - o).days
    max_out = (pd.Timestamp(win["max_out"]) - o).days

    def ok(d):
        day = pd.to_numeric(d[day_col], errors="coerce").to_numpy()
        los = pd.to_numeric(d[los_col], errors="coerce").fillna(0).to_numpy()
        return (day >= 0) & (day <= max_in) & (day + los >= min_out) & (day + los <= max_out)

    return ok
