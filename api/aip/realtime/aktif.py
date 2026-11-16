"""Active learning: the engine asks people to label the claims it would learn most from, retrains on their labels, and
promotes a better model only through a gate — MONAI Label's loop (strategies → annotate → train → infer) in insurance.

The model ("model adaptif") predicts whether an event needs action (a person confirmed it, or for the simulation: it belongs
to a planted fraud scenario) from everything the engine knows about it: each signal's strength (rules, network, registry),
the event kind, the production model's risk, the bill, the hand-weighted score and its mitigation, and the self-supervised
embedding and anomaly of an FKRTL claim (ssl.py). It is a committee of five bootstrap LightGBM models: the mean is the
probability, the spread across members the epistemic uncertainty (MONAI's "Epistemic" strategy uses MC-dropout spread for
the same purpose).

Query strategies (which unlabelled events go to the review queue)
  acak        random (the baseline every active learner is measured against)
  entropi     the committee's mean probability closest to 0.5
  epistemik   the largest disagreement between committee members
  hibrida     0.45 entropy + 0.35 disagreement + 0.20 value (probability × log bill), then greedy k-center over the
              candidates so the batch covers different kinds of claims (diversity in feature + embedding space)
  cold start  before both classes are labelled: half the highest hand-weighted scores, half k-center diversity

Labels: the review queue (a person: perlu tindakan / wajar), a case decision (konfirmasi → 1 on its alerted events,
false positive → 0), and — in the simulation only — an oracle that reads the simulator's planted truth.

Gate: a challenger is promoted when both classes have >= 10 labels and its cross-validated AUPRC on the labels is at least
the hand-weighted score's on the same folds (minus 0.02). The champion runs in shadow mode (its probability recorded on
every event) until an admin switches it to active (the decision then comes from it).
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

from aip.realtime import modus as MO
from aip.realtime.store import data_dir

log = logging.getLogger("aip.realtime.al")

# The feature space is FROZEN at the 45 signals the stored models were trained on (the adaptive champion here, and the /testing
# models through testing/fitur.engine_cols, ML v7 included). A signal added to modus.SIGNALS later (the EMR cross-check RME_*,
# 2026-11-14) enters the rule score and the explanation, never the feature vector: appending it here would shift every column
# after it and silently break each model already trained. Extend this tuple only together with a retrain.
CODES = ["RAWAT_INAP_TUMPANG_TINDIH", "KARTU_BANYAK_FASKES", "KLAIM_GANDA_STREAM", "KLAIM_GANDA_RIWAYAT", "KLAIM_BERULANG_MIRIP",
         "PEMECAHAN_EPISODE", "EPISODE_HARI_SAMA", "READMISI_DX_SAMA", "CINCIN_FASKES", "KLONING_LINTAS_PESERTA", "LONJAKAN_KEPARAHAN",
         "LOS_FASKES_BERGESER", "RISIKO_ASOSIASI", "KLAIM_SETELAH_MENINGGAL", "MENINGGAL_TERCATAT", "TIDAK_SESUAI_PESERTA", "KARTU_KELUARGA",
         "PASANGAN_KODE_LANGKA", "KODE_PROSEDUR_TANPA_TINDAKAN", "DX_SEKUNDER_BERLEBIH", "KELAS_DI_ATAS_HAK", "TOPUP_TIDAK_LAZIM",
         "TOPUP_DI_ATAS_PEER", "OBAT_DIKURANGI", "OBAT_TIDAK_DISERAHKAN", "HASIL_PEMERIKSAAN_TIDAK_COCOK", "SKOR_ML",
         "ANOMALI_SSL",  # the self-supervised signal
         "TAGIHAN_MELEBIHI_TARIF", "LOS_DIPERPANJANG", "READMISI", "RUJUKAN_NON_SPESIALISTIK", "RUJUKAN_LONCAT_JENJANG", "RRNS_FKTP_NAIK",
         "RRNS_PUSKESMAS_NAIK", "KONSENTRASI_RUJUKAN", "KONTAK_SEMU", "KONTAK_RENDAH", "KUNJUNGAN_SETELAH_MENINGGAL", "NONKAP_GANDA",
         "NONKAP_FREKUENSI", "NONKAP_TIDAK_SESUAI_PESERTA", "NONKAP_TARIF", "NONKAP_TANGGAL", "NONKAP_LONJAKAN"]
KINDS = ["fkrtl", "fktp", "nonkap", "faskes"]
EMB = 16
NAMES = ([f"s:{c}" for c in CODES] + [f"jenis:{k}" for k in KINDS]
         + ["ml_log_risiko", "ml_kelipatan", "log_biaya", "skor_aturan", "skor_tanpa_mitigasi", "mitigasi_n", "ssl_log_err"] + [f"emb{i}" for i in range(EMB)])
STRATEGIES = {"acak": "Acak (pembanding)", "entropi": "Ketidakpastian (entropi)", "epistemik": "Ketidaksepakatan komite (epistemik)",
              "hibrida": "Hibrida: ketidakpastian + keragaman + nilai rupiah"}
SIM: dict[str, Any] = {"status": "belum", "progres": None, "hasil": None, "galat": None}


def _dir() -> Path:
    d = data_dir() / "al"
    d.mkdir(parents=True, exist_ok=True)
    return d


SSL_COLS = ["ssl_log_err"] + [f"emb{i}" for i in range(EMB)]


def vec(e: dict, versi: Optional[dict] = None) -> np.ndarray:
    """One event's features. versi: the SSL version per kind the model knows; an embedding from another version (another
    embedding space) is left out (NaN), never mixed in."""
    s = {x["kode"]: float(x.get("s") or 0) for x in e.get("sinyal") or []}
    ml = e.get("ml") or {}
    j = e.get("jenis", "fkrtl")
    ss = e.get("ssl") or {}
    if versi is not None and ss and ss.get("versi") != versi.get(j):
        ss = {}
    emb = ss.get("emb") or [np.nan] * EMB
    v = [s.get(c, 0.0) for c in CODES] + [1.0 if j == k else 0.0 for k in KINDS]
    v += [np.log10(ml["risiko_pct"] + 1e-4) if ml.get("risiko_pct") is not None else np.nan, ml.get("kelipatan") if ml.get("kelipatan") is not None else np.nan,
          np.log1p(e.get("biaya") or 0), e.get("skor_aturan", e.get("skor", 0)), e.get("skor_tanpa_mitigasi", 0),
          sum(len(x.get("mitigasi") or []) for x in e.get("sinyal") or []), np.log(ss["err"]) if ss.get("err") else np.nan]
    return np.array(v + list(emb), dtype=np.float32)


def matrix(evs: list[dict], versi: Optional[dict] = None) -> np.ndarray:
    return np.vstack([vec(e, versi) for e in evs]) if evs else np.zeros((0, len(NAMES)), np.float32)


def ssl_versions(models: dict) -> dict:
    return {k: m.versi for k, m in (models or {}).items()}


def refresh(evs: list[dict], models: dict) -> dict:
    """Events scored by another SSL version re-embedded by the current one from their raw inputs (`x`, same input spec), in
    memory; events without them, or of a kind with no SSL model now, lose their SSL features. Returns the counts."""
    stale: dict[str, list[dict]] = {}
    n = {"diperbarui": 0, "dibuang": 0}
    for e in evs:
        ss = e.get("ssl")
        if not ss:
            continue
        k = e.get("jenis", "fkrtl")
        m = (models or {}).get(k)
        if m is not None and ss.get("versi") == m.versi:
            continue
        if m is not None and ss.get("x") is not None and ss.get("spek") == m.spec.key():
            stale.setdefault(k, []).append(e)
        else:
            e["ssl"] = None
            n["dibuang"] += 1
    for k, es in stale.items():
        m = models[k]
        for i in range(0, len(es), 20_000):
            chunk = es[i:i + 20_000]
            for e, r in zip(chunk, m.score_events(m.from_x([e["ssl"]["x"] for e in chunk]))):
                e["ssl"] = r
            n["diperbarui"] += len(chunk)
    return n


def prior(X: np.ndarray) -> np.ndarray:
    """The rule score as the starting point of every model (log-odds): boosting then learns corrections to the rules
    (e.g. a signal that fires on normal claims) instead of learning fraud from zero with a few hundred labels."""
    s = np.clip(np.nan_to_num(X[:, NAMES.index("skor_aturan")], nan=0.0) / 100.0, 0.02, 0.98)
    return np.log(s / (1 - s))


class Komite:
    def __init__(self, models: list, meta: dict) -> None:
        self.models, self.meta = models, meta

    def predict(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Mean and spread of the committee's probability. No prior correction to the stream's prevalence: active learning
        picks events by their features, not by their label, so the labels are a covariate-shifted sample and P(y | x) is the
        same as in the stream. (An Elkan correction from the labels' ~50 % to the stream's ~2 % assumes class-based sampling;
        on the simulation it predicted 107 positives where 1,223 were observed. Uncorrected: 1,980, and close where p ≥ 0.2.)"""
        if not len(X):
            return np.zeros(0), np.zeros(0)
        base = prior(X)
        P = np.vstack([1 / (1 + np.exp(-(m.predict(X, raw_score=True) + base))) for m in self.models])
        return P.mean(axis=0), P.std(axis=0)


def fit(X: np.ndarray, y: np.ndarray, seed: int = 0, k: int = 5) -> Komite:
    import lightgbm as lgb

    rng = np.random.default_rng(seed)
    pos, neg = np.where(y == 1)[0], np.where(y == 0)[0]
    base = prior(X)
    models = []
    for i in range(k):
        # a bootstrap of each class (both classes in every member), anchored on the rule score
        idx = np.concatenate([rng.choice(pos, len(pos)), rng.choice(neg, len(neg))])
        m = lgb.LGBMClassifier(n_estimators=120, learning_rate=0.05, num_leaves=7, min_child_samples=8, subsample=0.85, subsample_freq=1,
                               colsample_bytree=0.6, reg_lambda=3.0, verbose=-1, random_state=seed * 10 + i)
        m.fit(X[idx], y[idx], init_score=base[idx])
        models.append(m)
    return Komite(models, {"n": int(len(y)), "pos": int(y.sum())})


def _d(v: float) -> str:
    """Two decimals with a decimal comma, as the UI writes numbers."""
    return f"{v:.2f}".replace(".", ",")


def _rank(v: np.ndarray) -> np.ndarray:
    return np.argsort(np.argsort(v)) / max(len(v) - 1, 1)


def _kcenter(Z: np.ndarray, base: np.ndarray, score: np.ndarray, n: int, w_div: float = 0.4) -> list[int]:
    """Greedy: each next pick maximises (1 − w) · score + w · distance to everything labelled or picked so far."""
    if not len(Z):
        return []
    d = np.full(len(Z), np.inf)
    if len(base):
        for i in range(0, len(base), 2000):
            b = base[i:i + 2000]
            d = np.minimum(d, ((Z[:, None, :] - b[None, :, :]) ** 2).sum(-1).min(axis=1) if len(Z) * len(b) < 4e7 else d)
    picked: list[int] = []
    for _ in range(min(n, len(Z))):
        dd = np.where(np.isinf(d), np.nanmax(np.where(np.isinf(d), 0, d)) + 1, d)
        dn = dd / (dd.max() + 1e-9)
        j = int(np.argmax((1 - w_div) * score + w_div * dn))
        if j in picked:
            j = int(next(i for i in np.argsort(-score) if i not in picked))
        picked.append(j)
        d = np.minimum(d, ((Z - Z[j]) ** 2).sum(-1))
        score = score.copy()
        score[j] = -1e9
    return picked


def _z(X: np.ndarray) -> np.ndarray:
    Z = np.nan_to_num(X, nan=0.0)
    return Z / (Z.std(axis=0) + 1e-6)


def query(strategy: str, kom: Optional[Komite], X: np.ndarray, n: int, rng: Any, Xlab: Optional[np.ndarray] = None) -> tuple[list[int], list[str]]:
    """Indices of the pool to label next, and why each was picked."""
    if not len(X):
        return [], []
    n = min(n, len(X))
    ia = NAMES.index("skor_aturan")
    if strategy == "acak":
        return list(rng.choice(len(X), n, replace=False)), ["acak"] * n
    if kom is None:
        # cold start: half the hand score's top, half diverse
        half = n // 2
        top = list(np.argsort(-X[:, ia])[:half])
        cand = rng.choice(len(X), min(len(X), 4000), replace=False)
        cand = np.array([c for c in cand if c not in set(top)])
        Z = _z(X[cand])
        div = [int(cand[i]) for i in _kcenter(Z, Z[:0], np.zeros(len(cand)), n - half, 1.0)]
        return top + div, ["skor aturan tertinggi (awal dingin)"] * len(top) + ["keragaman (awal dingin)"] * len(div)
    p, sd = kom.predict(X)
    ent = -(p * np.log(p + 1e-9) + (1 - p) * np.log(1 - p + 1e-9))
    if strategy == "entropi":
        idx = list(np.argsort(-ent)[:n])
        return idx, [f"ketidakpastian p={_d(p[i])}" for i in idx]
    if strategy == "epistemik":
        idx = list(np.argsort(-sd)[:n])
        return idx, [f"komite tidak sepakat (sd {_d(sd[i])})" for i in idx]
    ib = NAMES.index("log_biaya")
    score = 0.45 * _rank(ent) + 0.35 * _rank(sd) + 0.20 * _rank(p * X[:, ib])
    # ε-greedy: a fifth of the batch at random keeps the labels an unbiased picture of the stream (uncertainty sampling
    # alone over-samples the boundary of a heavily imbalanced pool)
    n_rand = max(1, n // 5)
    cand = np.argsort(-score)[: max(5 * (n - n_rand), 200)]
    Z = _z(np.vstack([X[cand], Xlab])) if Xlab is not None and len(Xlab) else _z(X[cand])
    Zc, Zl = Z[: len(cand)], Z[len(cand):]
    sc = score[cand]
    sc = (sc - sc.min()) / (sc.max() - sc.min() + 1e-9)
    pick = _kcenter(Zc, Zl, sc, n - n_rand)
    idx = [int(cand[i]) for i in pick]
    rest = np.setdiff1d(np.arange(len(X)), idx)
    rnd = [int(i) for i in rng.choice(rest, min(n_rand, len(rest)), replace=False)]
    why = []
    for i in idx:
        r = []
        if ent[i] > 0.5:
            r.append(f"tidak pasti (p={_d(p[i])})")
        if sd[i] > 0.15:
            r.append(f"komite tidak sepakat (sd {_d(sd[i])})")
        if p[i] > 0.5:
            r.append("bernilai tinggi")
        why.append(", ".join(r) or "berbeda dari klaim yang sudah dilabeli")
    return idx + rnd, why + ["acak (eksplorasi, ε = 20%)"] * len(rnd)


def auprc(y: np.ndarray, s: np.ndarray) -> Optional[float]:
    from sklearn.metrics import average_precision_score

    if y.sum() == 0 or y.sum() == len(y):
        return None
    return float(average_precision_score(y, s))


def cv(X: np.ndarray, y: np.ndarray, seed: int = 0) -> dict:
    """5-fold stratified CV AUPRC of the committee and of the hand-weighted score on the same folds."""
    from sklearn.model_selection import StratifiedKFold

    k = int(min(5, y.sum(), len(y) - y.sum()))
    if k < 2:
        return {"model": None, "aturan": None, "lipatan": 0}
    ia = NAMES.index("skor_aturan")
    pm, pa = np.zeros(len(y)), X[:, ia]
    for tr, te in StratifiedKFold(k, shuffle=True, random_state=seed).split(X, y):
        pm[te] = fit(X[tr], y[tr], seed).predict(X[te])[0]
    return {"model": auprc(y, pm), "aturan": auprc(y, pa), "lipatan": k}


# ------------------------------------------------------------------------------------------------
# the champion
# ------------------------------------------------------------------------------------------------


def registry() -> list[dict]:
    try:
        return json.loads((_dir() / "model.json").read_text("utf-8"))
    except (OSError, ValueError):
        return []


def _save_registry(rows: list[dict]) -> None:
    (_dir() / "model.json").write_text(json.dumps(rows[-30:], ensure_ascii=False), "utf-8")


def load_champion() -> Optional[Komite]:
    import joblib

    rows = [r for r in registry() if r.get("juara")]
    if not rows:
        return None
    r = rows[-1]
    f = _dir() / f"{r['versi']}.joblib"
    if not f.is_file():
        return None
    return Komite(joblib.load(f), r)


def importances(kom: Komite, top: int = 12) -> list[dict]:
    imp = np.mean([m.booster_.feature_importance("gain") for m in kom.models], axis=0)
    tot = imp.sum() or 1.0
    order = np.argsort(-imp)[:top]
    return [{"fitur": NAMES[i], "porsi": round(float(imp[i] / tot), 4)} for i in order if imp[i] > 0]


def train_champion(X: np.ndarray, y: np.ndarray, sumber: str, ssl_versi: Optional[dict] = None) -> dict:
    """A challenger from these labels; promoted through the gate. ssl_versi: the SSL model per kind whose embeddings X
    holds (the champion uses SSL features only from those versions)."""
    import joblib

    n_pos, n_neg = int(y.sum()), int(len(y) - y.sum())
    ev = cv(X, y)
    kom = fit(X, y, seed=7)
    gate = n_pos >= 10 and n_neg >= 10 and ev["model"] is not None and ev["aturan"] is not None and ev["model"] >= ev["aturan"] - 0.02
    versi = "al-" + time.strftime("%Y%m%d%H%M%S")
    joblib.dump(kom.models, _dir() / f"{versi}.joblib")
    row = {"versi": versi, "pada": time.strftime("%Y-%m-%dT%H:%M:%S"), "label": int(len(y)), "positif": n_pos, "negatif": n_neg, "sumber": sumber,
           "cv_auprc_model": ev["model"], "cv_auprc_aturan": ev["aturan"], "lipatan": ev["lipatan"], "juara": bool(gate),
           "prevalensi_label": round(n_pos / max(len(y), 1), 4), "ssl_versi": dict(ssl_versi or {}),
           "gerbang": ("lolos: AUPRC CV model ≥ skor aturan − 0,02, ≥ 10 label tiap kelas" if gate else
                       f"tidak lolos: {'kurang label (≥ 10 tiap kelas)' if min(n_pos, n_neg) < 10 else 'AUPRC CV model di bawah skor aturan'}"),
           "fitur_penting": importances(kom)}
    rows = registry()
    if gate:
        for r in rows:
            r["juara"] = False
    rows.append(row)
    _save_registry(rows)
    return row


# ------------------------------------------------------------------------------------------------
# the simulation: learning curves with an oracle (the simulator's planted truth)
# ------------------------------------------------------------------------------------------------


def beat_rules(curves: dict, base: float, margin: float = 0.01) -> dict:
    """How many labels each strategy needed to beat the hand-weighted score by `margin` AUPRC. Strictly: with the seed labels
    alone the committee equals the rules (they are its init_score), and a tie is not a win."""
    return {s: next((p["label"] for p in pts if p["auprc"] is not None and p["auprc"] > base + margin), None) for s, pts in curves.items()}


AMBANG = (0.15, 0.3, 0.5, 0.7, 0.85)
BINS = (0.0, 0.05, 0.2, 0.4, 0.6, 0.8, 1.0)


def _op(y: np.ndarray, alert: np.ndarray) -> dict:
    tp = int((alert & (y == 1)).sum())
    n = int(alert.sum())
    return {"alarm": n, "laju_alarm": round(n / max(len(y), 1), 4), "presisi": round(tp / n, 3) if n else None,
            "recall": round(tp / max(int(y.sum()), 1), 3), "tp": tp}


def operating_points(evs_t: list[dict], yt: np.ndarray, kom: Komite, Xt: np.ndarray) -> dict:
    """Decision-level comparison on the test events: the rules' own decisions (PERIKSA or TAHAN = an alert) versus the
    committee's probability at a few thresholds, plus calibration (expected vs observed positives, overall and by bin)."""
    rule = np.array([(e.get("keputusan_aturan") or e.get("keputusan")) in ("PERIKSA", "TAHAN") for e in evs_t])
    rule_tahan = np.array([(e.get("keputusan_aturan") or e.get("keputusan")) == "TAHAN" for e in evs_t])
    q = kom.predict(Xt)[0]
    bins = []
    for lo, hi in zip(BINS, BINS[1:]):
        m = (q >= lo) & ((q < hi) if hi < 1 else (q <= hi))
        if m.any():
            bins.append({"dari": lo, "sampai": hi, "n": int(m.sum()), "rata_p": round(float(q[m].mean()), 3), "teramati": round(float(yt[m].mean()), 3)})
    return {"aturan_periksa_atau_tahan": _op(yt, rule), "aturan_tahan": _op(yt, rule_tahan),
            "model": [{"ambang": a, **_op(yt, q >= a)} for a in AMBANG],
            "kalibrasi": {"positif_diharapkan": round(float(q.sum()), 1), "positif_teramati": int(yt.sum()), "bin": bins}}


def _curve(Xp: np.ndarray, yp: np.ndarray, Xt: np.ndarray, yt: np.ndarray, strat: str, seed: int, seed_idx: list[int], rounds: int,
           per_round: int, tag: str = "") -> tuple[list[dict], Any, list[int]]:
    """One strategy's learning curve: from the seed labels, `per_round` labels a round, AUPRC on the test events each round."""
    rng = np.random.default_rng(seed)
    lab = list(seed_idx)
    pts = []
    kom = None
    for r in range(rounds + 1):
        ly = yp[lab]
        kom = fit(Xp[lab], ly, seed=r) if 0 < ly.sum() < len(ly) else None
        score = auprc(yt, kom.predict(Xt)[0]) if kom else None
        pts.append({"label": len(lab), "positif": int(ly.sum()), "auprc": score})
        SIM["progres"] = {"strategi": strat + tag, "ronde": r, "dari": rounds, "auprc": score}
        if r == rounds:
            break
        mask = np.ones(len(Xp), bool)
        mask[lab] = False
        pool = np.where(mask)[0]
        pick, _ = query(strat, kom, Xp[pool], per_round, rng, Xp[lab])
        lab += [int(pool[i]) for i in pick]
    return pts, kom, lab


def ssl_evaluation(evs_t: list[dict], yt: np.ndarray, models: dict) -> dict:
    """The anomaly score alone against the planted truth, per kind, on the test events: AUPRC of the reconstruction error and
    the ANOMALI_SSL signal's firing rate (above the held-out p99.9) on normal and planted events."""
    jt = np.array([e.get("jenis", "fkrtl") for e in evs_t])
    err = np.array([((e.get("ssl") or {}).get("err") if (e.get("ssl") or {}).get("err") is not None else np.nan) for e in evs_t], float)
    out = {}
    for k, m in (models or {}).items():
        ok = (jt == k) & ~np.isnan(err)
        if not ok.any():
            out[k] = {"n": 0}
            continue
        yk, ek = yt[ok], err[ok]
        hi = m.meta["ambang"]["p999"]
        out[k] = {"n": int(ok.sum()), "positif": int(yk.sum()), "prevalensi": round(float(yk.mean()), 4), "auprc_galat": auprc(yk, ek),
                  "nyala_normal": round(float((ek[yk == 0] > hi).mean()), 5) if (yk == 0).any() else None,
                  "nyala_tanam": round(float((ek[yk == 1] > hi).mean()), 4) if (yk == 1).any() else None,
                  "cakupan": round(float(ok.sum() / max(int((jt == k).sum()), 1)), 4)}
    return out


def simulate(store: Any, strategies: list[str], rounds: int = 30, per_round: int = 25, seed_n: int = 20, say: Any = None,
             ssl_models: Optional[dict] = None) -> dict:
    """Pool = the first 70 % of the replayed events (by arrival), test = the last 30 %; the oracle labels an event 1 when it
    belongs to a planted scenario. Each strategy starts from the same random seed labels and labels `per_round` events a
    round; after each round its committee is scored on the test events (AUPRC), beside the hand-weighted score's. Then the
    best strategy again without the SSL features (two seeds each way): what self-supervision adds."""
    say = say or (lambda m: None)
    t0 = time.time()
    rows = store.rows("SELECT p.rec, k.skenario FROM kebenaran k JOIN peristiwa p ON p.id = k.peristiwa ORDER BY p.seq")
    evs = [json.loads(r[0]) for r in rows]
    y = np.array([0 if r[1] == "normal" else 1 for r in rows], dtype=int)
    del rows
    vers = ssl_versions(ssl_models or {})
    fresh = refresh(evs, ssl_models or {})
    X = matrix(evs, vers)
    cut = int(0.7 * len(X))
    Xp, yp, Xt, yt = X[:cut], y[:cut], X[cut:], y[cut:]
    ia = NAMES.index("skor_aturan")
    base = auprc(yt, Xt[:, ia])
    imr = NAMES.index("ml_log_risiko")
    ml_only = auprc(yt, np.nan_to_num(Xt[:, imr], nan=-9))
    say(f"{len(X):,} peristiwa: pool {cut:,} ({int(yp.sum())} positif), uji {len(Xt):,} ({int(yt.sum())} positif); AUPRC skor aturan {base:.3f}")
    curves: dict[str, list] = {}
    final: dict[str, Any] = {}
    seed_idx = list(np.random.default_rng(20261110).choice(cut, seed_n, replace=False))
    for si, strat in enumerate(strategies):
        pts, kom, lab = _curve(Xp, yp, Xt, yt, strat, 100 + si, seed_idx, rounds, per_round)
        curves[strat] = pts
        final[strat] = (kom, lab, 100 + si)
        say(f"{strat}: AUPRC {pts[-1]['auprc']} dengan {pts[-1]['label']} label ({pts[-1]['positif']} positif)")
    best = max(curves, key=lambda s: curves[s][-1]["auprc"] or 0)
    reach = beat_rules(curves, base)
    titik = operating_points(evs[cut:], yt, final[best][0], Xt)
    # ablation: the best strategy without the SSL features (embedding + reconstruction error), two seeds each way
    jt = np.array([e.get("jenis", "fkrtl") for e in evs[cut:]])
    cols = [NAMES.index(c) for c in SSL_COLS]
    Xn = X.copy()
    Xn[:, cols] = np.nan
    seed_b = 900 + final[best][2]
    runs = {"dengan": [(curves[best], final[best][0])], "tanpa": []}
    runs["dengan"].append(_curve(Xp, yp, Xt, yt, best, seed_b, seed_idx, rounds, per_round, " (seed 2)")[:2])
    for sd in (final[best][2], seed_b):
        runs["tanpa"].append(_curve(Xn[:cut], yp, Xn[cut:], yt, best, sd, seed_idx, rounds, per_round, " tanpa SSL")[:2])
    per = {}
    for k in ("fkrtl", "fktp", "nonkap"):
        mk = jt == k
        if not mk.any():
            continue
        row = {"n": int(mk.sum()), "positif": int(yt[mk].sum()), "aturan": auprc(yt[mk], Xt[mk, ia])}
        for way, Xw in (("dengan", Xt), ("tanpa", Xn[cut:])):
            vals = [auprc(yt[mk], kom.predict(Xw[mk])[0]) for _, kom in runs[way]]
            vals = [v for v in vals if v is not None]
            row[way] = round(float(np.mean(vals)), 4) if vals else None
        per[k] = row
    ablasi = {"strategi": best, "seed": 2,
              "dengan_ssl": round(float(np.mean([p[-1]["auprc"] or 0 for p, _ in runs["dengan"]])), 4),
              "tanpa_ssl": round(float(np.mean([p[-1]["auprc"] or 0 for p, _ in runs["tanpa"]])), 4),
              "per_seed": {w: [p[-1]["auprc"] for p, _ in r] for w, r in runs.items()},
              "kurva_tanpa_ssl": runs["tanpa"][0][0], "per_jenis": per}
    say(f"ablasi SSL ({best}): dengan {ablasi['dengan_ssl']}, tanpa {ablasi['tanpa_ssl']}")
    out = {"pada": time.strftime("%Y-%m-%dT%H:%M:%S"), "detik": round(time.time() - t0, 1), "peristiwa": int(len(X)), "pool": cut, "uji": int(len(Xt)),
           "positif_pool": int(yp.sum()), "positif_uji": int(yt.sum()), "prevalensi_uji": float(yt.mean()), "auprc_skor_aturan": base,
           "auprc_model_produksi_saja": ml_only, "kurva": curves, "strategi": {s: STRATEGIES[s] for s in strategies}, "ronde": rounds, "per_ronde": per_round,
           "label_awal": seed_n, "terbaik": best, "label_untuk_melampaui_aturan": reach, "titik_operasi": titik, "ablasi_ssl": ablasi,
           "ssl_evaluasi": ssl_evaluation(evs[cut:], yt, ssl_models or {}), "ssl_versi": vers, "ssl_diperbarui": fresh,
           "catatan": ("Label oracle = kebenaran skenario tanam simulator (bukan keputusan manusia). Pool = 70% peristiwa pertama, uji = 30% terakhir "
                       "(menurut urutan kedatangan). Kurva mengukur seberapa cepat model belajar dari label, bukan kinerja pada fraud nyata.")}
    (_dir() / "simulasi.json").write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    kom, lab, _ = final[best]
    out["_model"] = (kom, Xp[lab], yp[lab])
    return out


def simulate_async(store: Any, strategies: list[str], rounds: int, per_round: int, on_done: Any, ssl_models: Optional[dict] = None) -> None:
    if SIM["status"] == "berjalan":
        return
    SIM.update(status="berjalan", progres=None, galat=None)

    def run() -> None:
        try:
            res = simulate(store, strategies, rounds, per_round, say=log.info, ssl_models=ssl_models)
            model = res.pop("_model")
            SIM.update(status="selesai", hasil=res)
            on_done(res, model)
        except Exception as e:  # noqa: BLE001
            log.exception("al: simulate")
            SIM.update(status="gagal", galat=str(e)[:300])
    threading.Thread(target=run, daemon=True, name="realtime-al-sim").start()


def last_simulation() -> Optional[dict]:
    try:
        return json.loads((_dir() / "simulasi.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
