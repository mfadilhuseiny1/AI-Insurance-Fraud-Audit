"""Sequential CART synthesis with leaf-donor sampling.

Every variable is modelled conditionally on the variables synthesized before it (Rubin 1993; Raghunathan, Reiter & Rubin
2003). The conditional model is a classification or regression tree (CART, Reiter 2005; synthpop's "cart" method, Nowok,
Raab & Dibben 2016): the tree is grown on the real training rows, and a synthetic row takes the value of a randomly drawn
real row from the leaf it falls into (a Bayesian-bootstrap-like draw from the leaf's empirical distribution). So:

  * the joint distribution is approximated by a chain of conditionals, P(x1) P(x2|x1) ... P(xk|x1..xk-1);
  * non-linear relations and interactions are found by the tree, without a parametric form;
  * a value is only ever drawn from a pool of at least MIN_LEAF real records.

Extensions used here:
  * a Step can draw several columns at once (a "donor tuple": e.g. a facility's kab/kota, ownership, type and class), so
    the combinations that come out always exist in reality;
  * for a high-cardinality target the tree is grown on a coarser proxy (diagnosis -> its ICD-10 letter) and the fine value
    is drawn from the leaf's donors;
  * rare categories (fewer than RARE_K training records) are removed from the donor pool before fitting;
  * rare binary events can grow the tree with balanced class weights; donors are still drawn with the true weights, so
    the rate inside each leaf stays the empirical one;
  * sampling weights (when a table was subsampled) are carried into the tree and into the donor draw.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor


def _is_text(s: pd.Series) -> bool:
    return s.dtype == object or pd.api.types.is_string_dtype(s)


def _numeric_like(s: pd.Series) -> bool:
    """Numbers held in an object column (copied or drawn values) are numbers, not text."""
    nn = s.dropna()
    if nn.empty:
        return True
    return bool(pd.to_numeric(nn, errors="coerce").notna().mean() > 0.99)


def as_numeric_if_possible(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce") if _is_text(s) and _numeric_like(s) else s


class Encoder:
    """Predictors -> a float32 matrix. Numbers as they are; text as its rank in the sorted training vocabulary (ICD-10 and
    INA-CBG codes sort by chapter/group, so a split on the rank is a split on a clinical range); missing -> -1."""

    def __init__(self, cols: list[str]):
        self.cols = list(cols)
        self.vocab: dict[str, pd.Index] = {}

    def fit(self, df: pd.DataFrame) -> "Encoder":
        for c in self.cols:
            if _is_text(df[c]) and not _numeric_like(df[c]):
                self.vocab[c] = pd.Index(sorted(df[c].dropna().astype(str).unique()))
        return self

    def transform(self, df: pd.DataFrame) -> np.ndarray:
        out = np.empty((len(df), len(self.cols)), dtype=np.float32)
        for i, c in enumerate(self.cols):
            s = df[c]
            if c in self.vocab:
                out[:, i] = self.vocab[c].get_indexer(s.astype(str).where(s.notna(), None))
            elif _is_text(s):  # numbers held as objects (copied or drawn values); real text here encodes as missing
                out[:, i] = pd.to_numeric(s, errors="coerce").fillna(-1).to_numpy(np.float32)
            else:
                out[:, i] = pd.to_numeric(s, errors="coerce").fillna(-1).to_numpy(np.float32)
        return out


@dataclass
class Step:
    """One conditional model.

    target: the column (or columns: drawn together) to synthesize.
    preds:  the columns it is conditioned on (must already exist).
    kind:   "cat" grows a classification tree on `proxy(target)`, "num" a regression tree on the (single) numeric target.
    when:   rows this step applies to (others keep `fill(df)` or stay missing).
    proxy:  coarsening of the target for growing the tree (high-cardinality targets).
    rare:   column whose rare values are removed from the donor pool (defaults to the first target if rare=True).
    """

    name: str
    target: list[str]
    preds: list[str]
    kind: str = "cat"
    when: Optional[Callable[[pd.DataFrame], np.ndarray]] = None
    fill: Optional[Callable[[pd.DataFrame], pd.DataFrame]] = None
    proxy: Optional[Callable[[pd.DataFrame], pd.Series]] = None
    rare: bool | str = False
    balanced: bool = False
    post: Optional[Callable[[pd.DataFrame, np.random.Generator], pd.DataFrame]] = None
    min_leaf: int = 10


@dataclass
class FittedStep:
    step: Step
    enc: Optional[Encoder]
    tree: object
    donors: pd.DataFrame
    cumw: np.ndarray
    leaves: np.ndarray
    start: np.ndarray
    end: np.ndarray
    n_train: int
    n_leaves: int
    info: dict = field(default_factory=dict)


MAX_CLASSES = 64  # a classification tree's cost grows with its classes: the rest of a target's classes become "<other>"
FIT_ROWS = 200_000  # rows a single tree is grown on (a uniform subsample, weights kept); donors come from the same rows


def _key(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    k = df[cols[0]].astype(str)
    for c in cols[1:]:
        k = k + "\x1f" + df[c].astype(str)
    return k


def _fit_target(df: pd.DataFrame, step: Step) -> np.ndarray:
    if step.kind == "num":
        return pd.to_numeric(df[step.target[0]], errors="coerce").fillna(-1).to_numpy(np.float64)
    y = pd.Series(step.proxy(df) if step.proxy else df[step.target[0]], index=df.index)
    y = y.astype(str).where(y.notna().to_numpy(), "<NA>")
    top = y.value_counts().index[: MAX_CLASSES - 1]
    return y.where(y.isin(top), "<other>").to_numpy()


def fit_step(step: Step, train: pd.DataFrame, weights: Optional[np.ndarray], k_rare: int, seed: int) -> Optional[FittedStep]:
    mask = np.ones(len(train), bool) if step.when is None else np.asarray(step.when(train), bool)
    df = train.loc[mask]
    w = None if weights is None else np.asarray(weights)[mask]
    if step.rare:
        col = step.rare if isinstance(step.rare, str) else step.target[0]
        key = _key(df, step.target) if (step.rare is True and len(step.target) > 1) else df[col].astype(str)
        counts = key.map(key.value_counts())
        keep = (counts >= k_rare).to_numpy() | df[col].isna().to_numpy()
        df = df.loc[keep]
        w = None if w is None else w[keep]
    if len(df) == 0:
        return None
    if len(df) > FIT_ROWS:
        pick = np.sort(np.random.default_rng(seed).choice(len(df), FIT_ROWS, replace=False))
        df = df.iloc[pick]
        w = None if w is None else w[pick]
    donors = df[step.target].reset_index(drop=True)
    enc, tree = None, None
    if step.preds:
        y = _fit_target(df, step)
        if len(np.unique(y)) > 1 and len(df) >= 2 * step.min_leaf:
            enc = Encoder(step.preds).fit(df)
            X = enc.transform(df)
            if step.kind == "cat":
                tree = DecisionTreeClassifier(min_samples_leaf=step.min_leaf, random_state=seed,
                                              class_weight="balanced" if step.balanced else None)
            else:
                tree = DecisionTreeRegressor(min_samples_leaf=step.min_leaf, random_state=seed)
            tree.fit(X, y, sample_weight=w)
            leaf = tree.apply(X)
        else:
            leaf = np.zeros(len(df), np.int64)
    else:
        leaf = np.zeros(len(df), np.int64)
    order = np.argsort(leaf, kind="stable")
    leaf = leaf[order]
    donors = donors.iloc[order].reset_index(drop=True)
    ww = np.ones(len(df)) if w is None else np.asarray(w, float)[order]
    cumw = np.cumsum(ww)
    leaves, start = np.unique(leaf, return_index=True)
    end = np.r_[start[1:], len(leaf)]
    return FittedStep(step, enc, tree, donors, cumw, leaves, start, end, len(df), len(leaves))


def sample_step(fs: FittedStep, df: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """The step's target columns for the rows of df (all rows: callers subset by `when` first)."""
    m = len(df)
    if m == 0:
        return fs.donors.iloc[:0].copy()
    if fs.tree is not None:
        leaf = fs.tree.apply(fs.enc.transform(df))
        pos = np.searchsorted(fs.leaves, leaf)
    else:
        pos = np.zeros(m, np.int64)
    s, e = fs.start[pos], fs.end[pos]
    lo = np.where(s > 0, fs.cumw[np.maximum(s - 1, 0)], 0.0)
    hi = fs.cumw[e - 1]
    u = lo + rng.random(m) * (hi - lo)
    idx = np.clip(np.searchsorted(fs.cumw, u, side="right"), s, e - 1)
    out = fs.donors.iloc[idx].reset_index(drop=True)
    if fs.step.post is not None:
        out = fs.step.post(out, rng)
    return out


@dataclass
class LocalStep:
    """A facility placed in a given kab/kota: its kab/kota is set to `home` (e.g. the peserta's residence or registered FKTP
    kab/kota) and the rest of its tuple (ownership, type, class ...) is drawn from REAL records in that kab/kota with the
    same context (e.g. care level), backing off to the kab/kota alone. Rows with no pool are flagged `_miss_<name>` for a
    CART step to take. Pools hold only tuples seen at least RARE_K times (as everywhere)."""

    name: str
    home: str
    kab: str
    rest: list[str]
    ctx: list[str]
    when: Callable[[pd.DataFrame], np.ndarray]
    pools: dict = field(default_factory=dict)

    @staticmethod
    def _norm(s: pd.Series) -> pd.Series:
        v = pd.to_numeric(s, errors="coerce")
        return v.round().astype("Int64").astype(str) if v.notna().mean() > 0.5 else s.astype(str)

    def _keys(self, df: pd.DataFrame, home_col: str, ctx: list[str]) -> pd.Series:
        k = self._norm(df[home_col])
        for c in ctx:
            k = k + "|" + self._norm(df[c])
        return k

    def fit(self, train: pd.DataFrame, weights: Optional[np.ndarray], k_rare: int, seed: int) -> "LocalStep":
        d = train.loc[(self._norm(train[self.kab]) == self._norm(train[self.home])).to_numpy()]  # people using a facility in their own kab/kota
        tup = self._keys(d, self.kab, self.rest)
        d = d.loc[(tup.map(tup.value_counts()) >= k_rare).to_numpy()]
        for level, ctx in (("ctx", self.ctx), ("kab", [])):
            if level == "ctx" and not ctx:
                continue
            key = self._keys(d, self.kab, ctx).to_numpy()
            order = np.argsort(key, kind="stable")
            ks, start = np.unique(key[order], return_index=True)
            end = np.r_[start[1:], len(order)]
            self.pools[level] = (pd.Index(ks), start, end, d[self.rest].iloc[order].reset_index(drop=True))
        return self

    def sample(self, df: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
        mask = np.asarray(self.when(df), bool)
        miss = np.zeros(len(df), bool)
        for c in [self.kab] + self.rest:
            if c not in df.columns:
                df[c] = np.nan
        if mask.any():
            sub = df.loc[mask]
            todo = np.ones(len(sub), bool)
            vals = {c: np.full(len(sub), np.nan, dtype=object) for c in self.rest}
            for level, ctx in (("ctx", self.ctx), ("kab", [])):
                if level not in self.pools or not todo.any():
                    continue
                idx, start, end, donors = self.pools[level]
                pos = idx.get_indexer(self._keys(sub.loc[todo], self.home, ctx))
                hit = pos >= 0
                rows = np.flatnonzero(todo)[hit]
                s, e = start[pos[hit]], end[pos[hit]]
                pick = s + (rng.random(len(s)) * (e - s)).astype(np.int64)
                for c in self.rest:
                    vals[c][rows] = donors[c].to_numpy()[pick]
                todo[rows] = False
            for c in self.rest:
                df[c] = df[c].astype(object)
                df.loc[mask, c] = vals[c]
                df[c] = as_numeric_if_possible(df[c])
            df[self.kab] = df[self.kab].astype(object)
            df.loc[mask, self.kab] = sub[self.home].to_numpy()
            df[self.kab] = as_numeric_if_possible(df[self.kab])
            miss[np.flatnonzero(mask)[todo]] = True
        df[f"_miss_{self.name}"] = miss
        return df


class Chain:
    """An ordered list of Steps fitted on one training table and applied to a synthetic context table."""

    def __init__(self, steps: list[Step], k_rare: int, seed: int, log=print):
        self.steps = steps
        self.k_rare = k_rare
        self.seed = seed
        self.fitted: dict[str, Optional[FittedStep]] = {}
        self.log = log

    def fit(self, train: pd.DataFrame, weights: Optional[np.ndarray] = None) -> "Chain":
        train = train.copy()
        for i, st in enumerate(self.steps):
            if isinstance(st, LocalStep):
                st.fit(train, weights, self.k_rare, self.seed + i)
                train[f"_miss_{st.name}"] = False
                continue
            if not isinstance(st, Step):  # a derivation between steps: computed on the training rows the same way
                train = st(train)
                continue
            missing = [c for c in st.preds + st.target if c not in train.columns]
            if missing:
                raise KeyError(f"step {st.name}: training table lacks {missing}")
            t0 = time.time()
            self.fitted[st.name] = fit_step(st, train, weights, self.k_rare, self.seed + i)
            if time.time() - t0 > 10:
                f = self.fitted[st.name]
                self.log(f"      fit {st.name}: {time.time() - t0:.0f} s, {f.n_train if f else 0:,} rows, {f.n_leaves if f else 0:,} leaves")
        return self

    def sample(self, ctx: pd.DataFrame, rng: np.random.Generator, only: Optional[set[str]] = None) -> pd.DataFrame:
        df = ctx
        for st in self.steps:
            if isinstance(st, LocalStep):
                df = st.sample(df, rng)
                continue
            if not isinstance(st, Step):
                df = st(df)
                continue
            if only is not None and st.name not in only:
                continue
            fs = self.fitted.get(st.name)
            mask = np.ones(len(df), bool) if st.when is None else np.asarray(st.when(df), bool)
            for c in st.target:
                if c not in df.columns:
                    df[c] = pd.Series([None] * len(df), dtype=object if fs is None or _is_text(fs.donors[c]) else "float64", index=df.index)
            if st.fill is not None and (~mask).any():
                filled = st.fill(df.loc[~mask])
                for c in st.target:
                    df.loc[~mask, c] = filled[c].to_numpy()
            if fs is None or not mask.any():
                continue
            drawn = sample_step(fs, df.loc[mask], rng)
            for c in st.target:
                col = drawn[c]
                if df[c].dtype != col.dtype:
                    if _is_text(col) or _is_text(df[c]):
                        df[c] = df[c].astype(object)
                    elif pd.api.types.is_bool_dtype(col) or pd.api.types.is_bool_dtype(df[c]):
                        df[c] = df[c].astype(object)
                    else:
                        df[c] = df[c].astype("float64")
                df.loc[mask, c] = col.to_numpy()
        return df

    def summary(self) -> list[dict]:
        return [{"step": n, "rows": f.n_train if f else 0, "leaves": f.n_leaves if f else 0, "tree": bool(f and f.tree is not None)}
                for n, f in self.fitted.items()]
