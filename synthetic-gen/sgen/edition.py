"""One edition, end to end: fit every chain on the real training split, sample the synthetic tables, derive the
deterministic columns, assign new identifiers and links."""

from __future__ import annotations

import time
import zlib

import numpy as np
import pandas as pd

from sgen import config, maps, real, synth
from sgen.cart import Chain

REF_DAY = pd.Timestamp("2024-12-31")


class IdBank:
    """New identifiers that cannot be a real one: integers drawn outside the real id set (and never twice), text ids
    `SYN` + 13 base-36 characters from a bijective mix of a counter (unique by construction; no real id starts with SYN).
    Each edition has its own slot (an integer range and a counter range), so editions can run in parallel processes."""

    SLOT_WIDTH = 300_000_000

    def __init__(self, con, rng: np.random.Generator, slot: int = 0):
        self.rng = rng
        self.lo = 10_000_000 + slot * self.SLOT_WIDTH
        self.hi = self.lo + self.SLOT_WIDTH
        real_ints = [con.execute(f"SELECT DISTINCT {c} FROM kepesertaan WHERE {c} IS NOT NULL").df()[c].to_numpy(np.int64) for c in ("PSTV01", "PSTV02", "PSTV01_A")]
        self.real = np.unique(np.concatenate(real_ints))
        self.used = np.array([], np.int64)
        clash = sum(con.execute(f"SELECT count(*) FROM {t} WHERE {c} LIKE 'SYN%'").fetchone()[0]
                    for t, c in [("fkrtl", "FKL02"), ("fkrtl", "FKP02"), ("fktpkapitasi", "FKP02"), ("nonkapitasi", "PNK02")])
        if clash:
            raise RuntimeError("a real visit id starts with SYN: choose another prefix")
        self.counter = slot * 10_000_000_000_000

    def save(self, path) -> None:
        np.savez(path, used=self.used, counter=np.array([self.counter], np.int64))

    def load(self, path) -> None:
        z = np.load(path)
        self.used = z["used"]
        self.counter = int(z["counter"][0])

    def ints(self, n: int) -> np.ndarray:
        out = np.array([], np.int64)
        while len(out) < n:
            c = self.rng.integers(self.lo, self.hi, size=int((n - len(out)) * 1.3) + 16, dtype=np.int64)
            c = np.unique(c)
            c = c[~np.isin(c, self.real) & ~np.isin(c, self.used) & ~np.isin(c, out)]
            out = np.r_[out, self.rng.permutation(c)[: n - len(out)]]
        self.used = np.r_[self.used, out]
        return out

    def texts(self, n: int) -> np.ndarray:
        c = np.arange(self.counter, self.counter + n, dtype=np.uint64)
        self.counter += n
        with np.errstate(over="ignore"):
            x = c * np.uint64(0x9E3779B97F4A7C15) + np.uint64(0x632BE59BD9B4E019)  # odd multiplier mod 2^64: a bijection
        idx = np.empty((n, 13), np.uint8)
        for i in range(13):
            idx[:, 12 - i] = (x % np.uint64(36)).astype(np.uint8)
            x = x // np.uint64(36)
        alphabet = np.frombuffer(b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", np.uint8)
        body = np.ascontiguousarray(alphabet[idx]).view("S13").ravel().astype(str)
        return np.char.add("SYN", body)


def _num(s):
    return pd.to_numeric(s, errors="coerce")


def _families(p: pd.DataFrame, sizes: np.ndarray, ids: IdBank, rng: np.random.Generator) -> np.ndarray:
    """PSTV02: peserta grouped into families of the real size distribution, within the same kab/kota, segment and class."""
    order = p.assign(_r=rng.random(len(p))).sort_values(["PSTV10", "PSTV08", "PSTV07", "_r"]).index.to_numpy() if {"PSTV10", "PSTV08", "PSTV07"} <= set(p.columns) else rng.permutation(len(p))
    ends = np.cumsum(rng.choice(sizes, size=len(p)))
    f = int(np.searchsorted(ends, len(p), side="left")) + 1
    fam_of = np.empty(len(p), np.int64)
    fam_of[order] = np.searchsorted(ends, np.arange(len(p)), side="right")
    fam_ids = ids.ints(f)
    return fam_ids[fam_of]


UNIQUE_KEY = ["PSTV03", "PSTV05", "PSTV10", "PSTV08"]  # birth date, sex, kab/kota of residence, segment


def _keys(df: pd.DataFrame) -> pd.MultiIndex:
    cols = [pd.to_datetime(df["PSTV03"]).dt.normalize()] + [_num(df[c]).fillna(-1).astype("int64") for c in UNIQUE_KEY[1:]]
    return pd.MultiIndex.from_arrays(cols)


def _release_birthdates(con, edisi: str, p: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Smoothing of the released birth date (synthpop-style): moved by up to AGE_JITTER_DAYS either way, EXCEPT dates on a
    heaped day of the year (a day carrying more than 3x the average share in the real data, e.g. placeholder dates),
    which thousands share and which carry meaning (they track the segment). The modelling age (p["age"]) is unchanged."""
    days = con.execute(f"""SELECT month(PSTV03) m, day(PSTV03) d, count(*) n FROM kepesertaan WHERE edisi = $e AND {real.NOT_HOLDOUT} GROUP BY 1, 2""",
                       {"e": edisi}).df()
    heaped = set(zip(days.loc[days["n"] > 3 * days["n"].mean(), "m"], days.loc[days["n"] > 3 * days["n"].mean(), "d"]))
    b = pd.to_datetime(p["PSTV03"])
    on_heap = np.array([(m, d) in heaped for m, d in zip(b.dt.month, b.dt.day)])
    sentinel = (b.dt.normalize() == pd.Timestamp(config.BIRTH_SENTINEL)).to_numpy()
    move = ~on_heap & ~sentinel
    shift = rng.integers(-config.AGE_JITTER_DAYS, config.AGE_JITTER_DAYS + 1, int(move.sum()))
    p.loc[move, "PSTV03"] = b[move] + pd.to_timedelta(shift, unit="D")
    p["PSTV03"] = pd.to_datetime(p["PSTV03"]).clip(upper=REF_DAY)
    return {"heaped_days": len(heaped), "moved": int(move.sum()), "kept_on_heaped_day": int(on_heap.sum())}


def _protect_uniques(con, edisi: str, p: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Replicated uniques (synthpop's sdc(rm.replicated.uniques), Raab et al.): a synthetic peserta whose birth date, sex,
    kab/kota and segment equal those of a person who is UNIQUE on that key in the real training data gets its birth date
    moved (31-120 days, either way) until it no longer does. The placeholder birth date is left alone."""
    if not set(UNIQUE_KEY) <= set(p.columns):
        return {"skipped": True}
    real_u = con.execute(f"""SELECT PSTV03::DATE AS PSTV03, PSTV05, PSTV10, PSTV08 FROM kepesertaan WHERE edisi = $e AND {real.NOT_HOLDOUT}
                             GROUP BY ALL HAVING count(*) = 1""", {"e": edisi}).df()
    ref = _keys(real_u)
    sentinel = pd.Timestamp(config.BIRTH_SENTINEL)
    first = None
    for _ in range(8):
        hit = _keys(p).isin(ref) & (pd.to_datetime(p["PSTV03"]).dt.normalize() != sentinel).to_numpy()
        first = int(hit.sum()) if first is None else first
        if not hit.any():
            break
        shift = rng.integers(31, 121, hit.sum()) * rng.choice([-1, 1], hit.sum())
        p.loc[hit, "PSTV03"] = pd.to_datetime(p.loc[hit, "PSTV03"]) + pd.to_timedelta(shift, unit="D")
    p["PSTV03"] = pd.to_datetime(p["PSTV03"]).clip(upper=REF_DAY)
    left =int((_keys(p).isin(ref) & (pd.to_datetime(p["PSTV03"]).dt.normalize() != sentinel).to_numpy()).sum())
    return {"matched_a_real_unique": first, "still_matching_after_moves": left}


def synth_edition(con, edisi: str, ids: IdBank, tariffs: dict, rng: np.random.Generator, log=print, kia_ibu_ids: np.ndarray | None = None,
                  mother_share: float = 0.0) -> tuple[dict[str, pd.DataFrame], dict]:
    t_start = time.time()
    info: dict = {"edisi": edisi}
    have = {t: set(real.columns(con, t, edisi)) for t in config.TABLES}
    win = real.windows(con, edisi)
    n_real = real.counts(con, edisi)
    info["real_rows"] = n_real
    m = maps.edition_maps(con, edisi)
    ritl = real.ritl_code(con)
    seed = config.SEED + zlib.crc32(edisi.encode()) % 10_000

    # ---------------------------------------------------------------- peserta
    t0 = time.time()
    tr = real.peserta_frame(con, edisi, ritl, rng)
    ch = Chain(synth.peserta_steps(have["kepesertaan"]), config.RARE_K, seed, log).fit(tr)
    info["chains"] = {"peserta": ch.summary()}
    p = ch.sample(pd.DataFrame(index=pd.RangeIndex(n_real["kepesertaan"])), rng)
    p.index.name = "pid"
    sizes = real.family_sizes(con, edisi)
    del tr
    p["PSTV01"] = ids.ints(len(p))
    p["PSTV02"] = _families(p, sizes, ids, rng)
    p["PSTV03"] = REF_DAY - pd.to_timedelta(_num(p["age"]).round(), unit="D")
    info["birthdates_moved"] = _release_birthdates(con, edisi, p, rng)
    info["replicated_uniques"] = _protect_uniques(con, edisi, p, rng)
    for c in ("PSTV09", "PSTV09_NEW", "PSTV13", "PSTV13_NEW"):
        if c in have["kepesertaan"]:
            p[c] = m[c](p)
    if edisi == "kia_anak" and "PSTV01_A" in have["kepesertaan"]:
        link = rng.random(len(p)) < mother_share
        mothers = np.full(len(p), -1, np.int64)
        if kia_ibu_ids is not None and len(kia_ibu_ids):
            mothers[link] = rng.choice(kia_ibu_ids, size=int(link.sum()))
        fresh = ~link | (mothers < 0)
        mothers[fresh] = ids.ints(int(fresh.sum()))
        p["PSTV01_A"] = mothers
    log(f"  peserta {len(p):,} rows, {time.time() - t0:.0f} s")

    feats = ["PSTV05", "age", "PSTV08", "PSTV07", "PSTV10", "PSTV11", "PSTV12", "PSTV14", "n_fkrtl", "has_ritl", "main_letter", "n_fktp", "n_nk"]
    base = p[[c for c in feats if c in p.columns]].copy()
    for c in ("PSTV08", "PSTV07", "PSTV11", "PSTV12", "PSTV14"):
        if c not in base.columns:
            base[c] = np.nan
    for c in ("n_fkrtl", "n_fktp", "n_nk"):
        base[c] = _num(base[c]).fillna(0).round().astype(int)

    # ---------------------------------------------------------------- FKRTL claims
    t0 = time.time()
    o_fk = win["fkrtl"]["origin"]
    tr, w = real.fkrtl_frame(con, edisi, ritl, o_fk, rng)
    ch = Chain(synth.fkrtl_steps(have["fkrtl"]), config.RARE_K, seed + 1, log).fit(tr, w)
    info["chains"]["fkrtl"] = ch.summary()
    del tr, w
    cl, info["fkrtl_seq"] = synth.run_sequence(ch, base, "n_fkrtl", synth.FKRTL_LAGS, synth.window_check(o_fk, win["fkrtl"]), rng, log, "fkrtl")
    cl = cl.sort_values(["pid", "j"]).reset_index(drop=True)
    cl["FKL03"] = pd.Timestamp(o_fk) + pd.to_timedelta(_num(cl["day"]).round(), unit="D")
    cl["FKL04"] = cl["FKL03"] + pd.to_timedelta(_num(cl["los"]).fillna(0).round(), unit="D")
    for c in ("FKL05", "FKL05_NEW", "FKL25", "FKL25_NEW", "FKL15A"):
        if c in have["fkrtl"]:
            cl[c] = m[c](cl)
    for c in ("FKL15", "FKL17A"):
        cl[c] = m[c](cl)
    cl["FKL17"] = m["FKL17"](cl)
    for c in ("FKL19A", "FKL20", "FKL21", "FKL22", "FKL23", "FKL36", "FKL39", "FKL42", "FKL45"):
        if c in have["fkrtl"]:
            cl[c] = m[c](cl)
    cl["thn"] = cl["FKL04"].dt.year
    cl["FKL32"] = _num(tariffs["FKL32"](cl)).fillna(0).round()
    topup = np.zeros(len(cl))
    for code, tar in [("FKL33", "FKL34"), ("FKL35", "FKL37"), ("FKL38", "FKL40"), ("FKL41", "FKL43"), ("FKL44", "FKL46")]:
        if tar in have["fkrtl"]:
            if code not in cl.columns:
                cl[code] = None
            cl[tar] = _num(tariffs[tar](cl)).fillna(0).round()
            topup += cl[tar].to_numpy()
    base_cost = cl["FKL32"].to_numpy() + topup
    rr = np.where(_num(cl["resid_flag"]).to_numpy() == 1, _num(cl["resid_ratio"]).fillna(1).to_numpy(), 1.0)
    cl["FKL47"] = np.maximum(np.round(base_cost * rr), 1)
    dr = np.where(_num(cl["diff_flag"]).to_numpy() == 1, np.clip(_num(cl["diff_ratio"]).fillna(1).to_numpy(), 0, 0.9999), 1.0)
    cl["FKL48"] = np.where(dr < 1, np.floor(cl["FKL47"].to_numpy() * dr), cl["FKL47"].to_numpy())
    log(f"  fkrtl {len(cl):,} rows, {time.time() - t0:.0f} s")

    # referrals: state 2 opens a new referral (and a referral visit at the FKTP); state 1 reuses the peserta's latest
    # referral (one referral serves several visits, not always consecutive ones); a reuse with none before opens one
    state = _num(cl["ref_state"]).fillna(0).to_numpy().astype(int)
    pid = cl["pid"].to_numpy()
    rs_kab = _num(cl["FKL06"]).fillna(-1).to_numpy().astype(np.int64)
    ref_of = np.full(len(cl), -1, np.int64)
    nref, by_kab, last_pid = 0, {}, None
    for i in range(len(cl)):  # a referral is for one hospital: it is reused only by a claim in the same kab/kota
        if pid[i] != last_pid:
            by_kab, last_pid = {}, pid[i]
        if state[i] == 2 or (state[i] == 1 and rs_kab[i] not in by_kab):
            ref_of[i] = by_kab[rs_kab[i]] = nref
            nref += 1
        elif state[i] == 1:
            ref_of[i] = by_kab[rs_kab[i]]
    cl["ref_of"] = ref_of
    new_ref = (ref_of >= 0) & ~pd.Series(ref_of).duplicated().to_numpy()

    # ---------------------------------------------------------------- referral FKTP visits
    t0 = time.time()
    o_ft = win["fktpkapitasi"]["origin"]
    rv = pd.DataFrame()
    if nref:
        tr = real.refvisit_frame(con, edisi)
        ch = Chain(synth.refvisit_steps(have["fktpkapitasi"]), config.RARE_K, seed + 2, log).fit(tr)
        info["chains"]["refvisit"] = ch.summary()
        del tr
        src = cl.loc[new_ref]
        ctx = pd.DataFrame({"c_kab": src["FKL06"].to_numpy(), "c_milik": src["FKL07"].to_numpy(), "c_jenis": src["FKL08"].to_numpy(),
                            "c_tipe": src["FKL09"].to_numpy(), "c_tingkat": src["FKL10"].to_numpy(), "c_poli": src["FKL11"].to_numpy(),
                            "c_dx": src["FKL18"].to_numpy(), "c_cbg": src["FKL19"].to_numpy(), "days_ref": _num(src["days_ref"]).fillna(1).to_numpy(),
                            "pid": src["pid"].to_numpy(), "ref_of": src["ref_of"].to_numpy(), "claim_in": src["FKL03"].to_numpy()})
        ctx = ctx.join(base[["PSTV05", "age", "PSTV08", "PSTV07", "PSTV10", "PSTV11", "PSTV12", "PSTV14"]], on="pid")
        rv = ch.sample(ctx, rng)
        d = pd.to_datetime(rv["claim_in"]) - pd.to_timedelta(_num(rv["days_ref"]).clip(lower=0).round(), unit="D")
        lo, hi = pd.Timestamp(o_ft), pd.Timestamp(win["fktpkapitasi"]["max_in"])
        info["refvisit_dates_clipped"] = int(((d < lo) | (d > hi)).sum())
        rv["FKP03"] = d.clip(lower=lo, upper=hi)
        rv["FKP04"] = rv["FKP03"] + pd.to_timedelta(_num(rv["los"]).fillna(0).clip(lower=0).round(), unit="D")
        log(f"  referral visits {len(rv):,} rows, {time.time() - t0:.0f} s")

    # ---------------------------------------------------------------- FKTP visits (no claim refers to them)
    t0 = time.time()
    tr, w = real.fktp_frame(con, edisi, o_ft, rng)
    ch = Chain(synth.fktp_steps(have["fktpkapitasi"]), config.RARE_K, seed + 3, log).fit(tr, w)
    info["chains"]["fktp"] = ch.summary()
    del tr, w
    fv, info["fktp_seq"] = synth.run_sequence(ch, base, "n_fktp", synth.FKTP_LAGS, synth.window_check(o_ft, win["fktpkapitasi"]), rng, log, "fktp")
    fv["FKP03"] = pd.Timestamp(o_ft) + pd.to_timedelta(_num(fv["day"]).round(), unit="D")
    fv["FKP04"] = fv["FKP03"] + pd.to_timedelta(_num(fv["los"]).fillna(0).clip(lower=0).round(), unit="D")
    fv["ref_of"] = -1
    ft = pd.concat([fv, rv], ignore_index=True) if len(rv) else fv
    for c in ("FKP05", "FKP05_NEW", "FKP16", "FKP16_NEW", "FKP14A"):
        if c in have["fktpkapitasi"]:
            ft[c] = m[c](ft)
    ft = ft.sort_values(["pid", "FKP03"]).reset_index(drop=True)
    ft["FKP02"] = ids.texts(len(ft))
    log(f"  fktp {len(ft):,} rows ({len(rv):,} referral visits), {time.time() - t0:.0f} s")

    cl["FKL02"] = ids.texts(len(cl))
    if "FKP02" in have["fkrtl"]:
        ref_id = pd.Series(ft.loc[ft["ref_of"] >= 0, "FKP02"].to_numpy(), index=ft.loc[ft["ref_of"] >= 0, "ref_of"].to_numpy())
        cl["FKP02"] = np.where(cl["ref_of"].to_numpy() >= 0, ref_id.reindex(cl["ref_of"].to_numpy()).to_numpy(), "")

    # ---------------------------------------------------------------- non-capitation visits and procedures
    t0 = time.time()
    nk = pd.DataFrame()
    if n_real["nonkapitasi"] and have["nonkapitasi"]:
        o_nk = win["nonkapitasi"]["origin"]
        v_tr, r_tr = real.nonkap_frames(con, edisi, o_nk)
        chv = Chain(synth.nkvisit_steps(have["nonkapitasi"]), config.RARE_K, seed + 4, log).fit(v_tr)
        cht = Chain(synth.tindakan_steps(have["nonkapitasi"]), config.RARE_K, seed + 5, log).fit(r_tr)
        info["chains"]["nonkap_visit"], info["chains"]["nonkap_tindakan"] = chv.summary(), cht.summary()
        del v_tr, r_tr
        nv, info["nonkap_seq"] = synth.run_sequence(chv, base, "n_nk", {"p_day": "day"}, synth.window_check(o_nk, win["nonkapitasi"]), rng, log, "nonkap")
        nv["PNK02"] = ids.texts(len(nv))
        nv["n_tind"] = _num(nv["n_tind"]).fillna(1).clip(lower=1).round().astype(int)
        rows, prev = [], None
        for k in range(1, int(nv["n_tind"].max()) + 1):
            v = nv.loc[nv["n_tind"] >= k]
            ctx = pd.DataFrame({"PNK02": v["PNK02"].to_numpy(), "v_jenis": v["PNK09"].to_numpy(), "v_tipe": v["PNK10"].to_numpy(), "v_tingkat": v["PNK11"].to_numpy(),
                                "v_dx": v["PNK14"].to_numpy(), "v_los": v["los"].to_numpy(), "PSTV05": v["PSTV05"].to_numpy(), "age": v["age"].to_numpy(),
                                "n_tind": v["n_tind"].to_numpy(), "k": k})
            ctx["p_tind"] = prev.reindex(ctx["PNK02"]).to_numpy() if prev is not None else None
            r = cht.sample(ctx, rng)
            prev = pd.Series(r["PNK16"].to_numpy(), index=r["PNK02"].to_numpy())
            rows.append(r)
        tind = pd.concat(rows, ignore_index=True)
        nk = tind.merge(nv.drop(columns=[c for c in ("PSTV05", "age", "n_tind") if c in nv.columns]), on="PNK02", how="left")
        nk["PNK03"] = pd.Timestamp(o_nk) + pd.to_timedelta(_num(nk["day"]).round(), unit="D")
        nk["PNK05"] = nk["PNK03"] + pd.to_timedelta(_num(nk["los"]).fillna(0).clip(lower=0).round(), unit="D")
        dt = pd.to_timedelta(_num(nk["d_tind"]).fillna(0).clip(lower=0).round(), unit="D")
        nk["PNK04"] = np.minimum(nk["PNK03"] + dt, nk["PNK05"])
        nk["PNK17"] = _num(nk["PNK17"]).round()
        nk["PNK18"] = np.minimum(np.round(nk["PNK17"] * _num(nk["ratio18"]).fillna(1)), nk["PNK17"])
        for c in ("PNK06", "PNK06_NEW", "PNK13A"):
            if c in have["nonkapitasi"]:
                nk[c] = m[c](nk)
        nk["PNK13"] = m["PNK13"](nk)
        log(f"  nonkapitasi {len(nk):,} rows ({len(nv):,} visits), {time.time() - t0:.0f} s")

    # ---------------------------------------------------------------- secondary diagnoses
    t0 = time.time()
    tr = real.dxsek_frame(con, edisi, rng)
    ch = Chain(synth.dxsek_steps(), config.RARE_K, seed + 6, log).fit(tr)
    info["chains"]["dxsek"] = ch.summary()
    del tr
    ndx = _num(cl["n_dx"]).fillna(0).clip(lower=0).round().astype(int).to_numpy()
    rep = np.repeat(np.arange(len(cl)), ndx)
    k = np.arange(len(rep)) - np.repeat(np.cumsum(ndx) - ndx, ndx) + 1
    los = (cl["FKL04"] - cl["FKL03"]).dt.days.to_numpy()
    ctx = pd.DataFrame({"row": rep, "k": k, "n_dx": ndx[rep], "FKL10": cl["FKL10"].to_numpy()[rep], "FKL11": cl["FKL11"].to_numpy()[rep],
                        "FKL09": cl["FKL09"].to_numpy()[rep], "FKL18": cl["FKL18"].to_numpy()[rep], "FKL19": cl["FKL19"].to_numpy()[rep],
                        "FKL23": cl["FKL23"].to_numpy()[rep] if "FKL23" in cl.columns else np.nan, "los": los[rep],
                        "PSTV05": base["PSTV05"].to_numpy()[cl["pid"].to_numpy()[rep]], "age": base["age"].to_numpy()[cl["pid"].to_numpy()[rep]]})
    dx = ch.sample(ctx, rng)
    for _ in range(6):  # (claim, code) is unique in the source: redraw repeats
        dup = dx.duplicated(["row", "FKL24"]).to_numpy()
        if not dup.any():
            break
        dx.loc[dup, "FKL24"] = ch.sample(dx.loc[dup].drop(columns=["FKL24"]).reset_index(drop=True), rng)["FKL24"].to_numpy()
    dup = dx.duplicated(["row", "FKL24"]).to_numpy()
    info["dxsek_dropped_repeats"] = int(dup.sum())
    dx = dx.loc[~dup].reset_index(drop=True)
    dx["FKL02"] = cl["FKL02"].to_numpy()[dx["row"].to_numpy()]
    dx["FKL24A"] = m["FKL24A"](dx)
    dx["FKL24B"] = m["FKL24B"](dx)
    if "FKL49" in have["diagnosissekunder"] and "FKL49" in cl.columns:
        dx["FKL49"] = cl["FKL49"].to_numpy()[dx["row"].to_numpy()]
    log(f"  diagnosissekunder {len(dx):,} rows, {time.time() - t0:.0f} s")

    # ---------------------------------------------------------------- peserta columns on every child table
    pcols = ["PSTV01", "PSTV02"] + [c for c in ("PSTV15", "PSTV01_A") if c in p.columns]
    cl = cl.join(p[pcols], on="pid")
    ft = ft.join(p[pcols], on="pid")
    if len(nk):
        nk = nk.join(p[pcols], on="pid")
    info["synthetic_rows"] = {"kepesertaan": len(p), "fkrtl": len(cl), "fktpkapitasi": len(ft), "nonkapitasi": len(nk), "diagnosissekunder": len(dx)}
    info["secs"] = round(time.time() - t_start)
    log(f"  {edisi} done in {info['secs']} s: {info['synthetic_rows']}")
    return {"kepesertaan": p.reset_index(drop=True), "fkrtl": cl, "fktpkapitasi": ft, "nonkapitasi": nk, "diagnosissekunder": dx}, info
