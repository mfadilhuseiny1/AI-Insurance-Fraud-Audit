"""Explainable unsupervised anomaly detection for health insurance claims (after De Meulemeester et al., BMC Med
Inform Decis Mak 25:14, 2025), with a GAN detector added: LSA categorical embeddings, eight detectors, an ensemble
with top-k votes, and Shapley values summed back to the original features. numpy + scikit-learn at inference; the
autoencoder and the GAN are trained with PyTorch and kept as numpy weights."""


import numpy as np
import pandas as pd

CATEGORICAL = ["jenis_rawat", "disiplin", "kode_icd", "kode_prosedur", "kode_inacbg", "severity", "kelas_rawat", "hari", "jam_kategori",
               "dirujuk", "faskes_perujuk", "jenis_faskes"]
NUMERIC = ["tarif_rs", "tarif_inacbg", "selisih_tarif", "lama_rawat", "jumlah_obat", "jam_masuk"]
STATS = ["sum", "mean", "median", "std", "min", "max"]
LABELS = {"jenis_rawat": "Jenis rawat", "disiplin": "Disiplin / poli", "kode_icd": "Diagnosis (ICD-10)", "kode_prosedur": "Prosedur (ICD-9-CM)",
          "kode_inacbg": "Kode INA-CBG", "severity": "Tingkat keparahan", "kelas_rawat": "Kelas rawat", "hari": "Hari layanan",
          "jam_kategori": "Jam masuk", "dirujuk": "Dirujuk", "faskes_perujuk": "Faskes perujuk", "jenis_faskes": "Jenis faskes (lokasi)",
          "tarif_rs": "Tarif RS", "tarif_inacbg": "Tarif INA-CBG", "selisih_tarif": "Selisih tarif RS − INA-CBG", "lama_rawat": "Lama rawat",
          "jumlah_obat": "Jumlah obat", "jam_masuk": "Jam masuk (angka)", "jumlah_klaim": "Jumlah klaim"}


# ------------------------------------------------------------------------------------------------
# categorical embeddings (LSA): SVD of the binary category × claim co-occurrence matrix
# ------------------------------------------------------------------------------------------------

def lsa_embeddings(claims: pd.DataFrame, k: int = 3) -> dict:
    """{"var=value": k-vector}, l2-normalised: the category part of a rank-k SVD of the co-occurrence matrix."""
    from scipy.sparse import csr_matrix
    from sklearn.decomposition import TruncatedSVD

    keys, rows, cols = {}, [], []
    for v in CATEGORICAL:
        vals = claims[v].astype(str).to_numpy()
        for j, val in enumerate(vals):
            key = f"{v}={val}"
            i = keys.setdefault(key, len(keys))
            rows.append(i)
            cols.append(j)
    X = csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(keys), len(claims)))
    emb = TruncatedSVD(n_components=k, random_state=0).fit_transform(X)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-12
    return {key: emb[i].tolist() for key, i in keys.items()}


def embedded_features(claims: pd.DataFrame, emb: dict, k: int = 3) -> pd.DataFrame:
    """Per doctor, the mean embedding of each categorical variable (columns emb_<var>_<i>)."""
    out = {}
    for v in CATEGORICAL:
        vals = claims[v].astype(str)
        M = np.vstack([emb.get(f"{v}={x}", [0.0] * k) for x in vals])
        for i in range(k):
            out[f"emb_{v}_{i}"] = M[:, i]
    df = pd.DataFrame(out)
    df["id_dokter"] = claims["id_dokter"].to_numpy()
    return df.groupby("id_dokter").mean()


def onehot_features(claims: pd.DataFrame) -> pd.DataFrame:
    """Per doctor, the share of every category (the mean of one-hot columns): the paper's baseline."""
    parts = [pd.crosstab(claims["id_dokter"], claims[v].astype(str), normalize="index").add_prefix(f"oh_{v}=") for v in CATEGORICAL]
    return pd.concat(parts, axis=1).fillna(0.0)


def numeric_features(claims: pd.DataFrame) -> pd.DataFrame:
    """Per doctor: sum, mean, median, std, min, max of each numeric variable, and the claim count."""
    g = claims.groupby("id_dokter")
    parts = {f"{v}_{s}": getattr(g[v], s)() if s != "std" else g[v].std(ddof=0) for v in NUMERIC for s in STATS}
    df = pd.DataFrame(parts)
    df["jumlah_klaim"] = claims.groupby("id_dokter").size()
    return df


def group_of(col: str) -> str:
    """The original feature a column belongs to (embedding dimensions and statistics sum back to it)."""
    if col.startswith("emb_"):
        return col[4:].rsplit("_", 1)[0]
    if col.startswith("oh_"):
        return col[3:].split("=", 1)[0]
    if col == "jumlah_klaim":
        return col
    return col.rsplit("_", 1)[0]


# ------------------------------------------------------------------------------------------------
# detectors (fit on standardised features; higher score = more anomalous)
# ------------------------------------------------------------------------------------------------

def _mlp_forward(layers, x):
    for i, (W, b) in enumerate(layers):
        x = x @ W + b
        if i < len(layers) - 1:
            x = np.where(x > 0, x, 0.2 * x)
    return x


class Ensemble:
    NAMES = ["Isolation Forest", "One-class SVM", "LOF", "KNN", "ECOD", "HBOS", "Autoencoder", "GAN (BiGAN/EGBAD)"]

    def fit(self, X: np.ndarray, columns: list[str], seed: int = 0, epochs: int = 1500, log=None):
        from sklearn.ensemble import IsolationForest
        from sklearn.neighbors import LocalOutlierFactor, NearestNeighbors
        from sklearn.svm import OneClassSVM

        self.columns = list(columns)
        self.mu = X.mean(axis=0)
        self.sd = X.std(axis=0) + 1e-9
        Z = (X - self.mu) / self.sd
        self.median = np.median(Z, axis=0)
        self.iforest = IsolationForest(n_estimators=300, random_state=seed).fit(Z)
        self.ocsvm = OneClassSVM(nu=0.1, gamma="scale").fit(Z)
        self.lof = LocalOutlierFactor(n_neighbors=20, novelty=True).fit(Z)
        self.knn = NearestNeighbors(n_neighbors=10).fit(Z)
        self.Ztrain = Z
        self.sorted = np.sort(Z, axis=0)
        self.hist = [np.histogram(Z[:, j], bins=10) for j in range(Z.shape[1])]
        self.ae = self._train_ae(Z, seed, epochs, log)
        self.gan = self._train_bigan(Z, seed, epochs, log)
        raw = self.raw_scores(Z)
        # scores become percentiles of the training scores; a vote is a top-10 % score
        self.train_scores = {m: np.sort(raw[m]) for m in self.NAMES}
        return self

    def _train_ae(self, Z, seed, epochs, log):
        import torch

        torch.manual_seed(seed)
        d = Z.shape[1]
        # a narrow bottleneck and short training: the typical profile is learnt, not every doctor
        net = torch.nn.Sequential(torch.nn.Linear(d, 16), torch.nn.LeakyReLU(0.2), torch.nn.Linear(16, 3), torch.nn.LeakyReLU(0.2),
                                  torch.nn.Linear(3, 16), torch.nn.LeakyReLU(0.2), torch.nn.Linear(16, d))
        opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-3)
        x = torch.tensor(Z, dtype=torch.float32)
        for e in range(min(epochs, 500)):
            opt.zero_grad()
            loss = ((net(x) - x) ** 2).mean()
            loss.backward()
            opt.step()
            if log and e % 100 == 0:
                log("autoencoder/loss", float(loss), e)
        return [(m.weight.detach().numpy().T.copy(), m.bias.detach().numpy().copy()) for m in net if isinstance(m, torch.nn.Linear)]

    def _train_bigan(self, Z, seed, epochs, log):
        """BiGAN (Donahue et al.) scored as EGBAD (Zenati et al. 2018): a generator G(z), an encoder E(x) and a
        discriminator D(x, z) trained adversarially; anomaly = α·|x − G(E(x))| + (1 − α)·feature-matching loss."""
        import torch

        torch.manual_seed(seed)
        d = Z.shape[1]
        zd = 8
        L = torch.nn.Linear
        A = lambda: torch.nn.LeakyReLU(0.2)  # noqa: E731
        G = torch.nn.Sequential(L(zd, 64), A(), L(64, 64), A(), L(64, d))
        E = torch.nn.Sequential(L(d, 64), A(), L(64, 64), A(), L(64, zd))
        Df = torch.nn.Sequential(L(d + zd, 64), A(), L(64, 32), A())
        Dh = L(32, 1)
        opt_d = torch.optim.Adam(list(Df.parameters()) + list(Dh.parameters()), lr=2e-4, betas=(0.5, 0.999))
        opt_g = torch.optim.Adam(list(G.parameters()) + list(E.parameters()), lr=2e-4, betas=(0.5, 0.999))
        bce = torch.nn.BCEWithLogitsLoss()
        x_all = torch.tensor(Z, dtype=torch.float32)
        n = len(x_all)
        for e in range(epochs):
            idx = torch.randint(0, n, (min(64, n),))
            x = x_all[idx]
            z = torch.randn(len(x), zd)
            real = torch.cat([x, E(x)], 1)
            fake = torch.cat([G(z), z], 1)
            ones, zeros = torch.ones(len(x), 1), torch.zeros(len(x), 1)
            opt_d.zero_grad()
            ld = bce(Dh(Df(real.detach())), ones) + bce(Dh(Df(fake.detach())), zeros)
            ld.backward()
            opt_d.step()
            opt_g.zero_grad()
            # the generator and the encoder try to fool D (labels swapped), plus a light reconstruction term
            lg = bce(Dh(Df(torch.cat([x, E(x)], 1))), zeros) + bce(Dh(Df(torch.cat([G(z), z], 1))), ones) + 0.1 * ((G(E(x)) - x).abs().mean())
            lg.backward()
            opt_g.step()
            if log and e % 100 == 0:
                log("gan/loss_d", float(ld), e)
                log("gan/loss_g", float(lg), e)
        grab = lambda seq: [(m.weight.detach().numpy().T.copy(), m.bias.detach().numpy().copy()) for m in seq if isinstance(m, torch.nn.Linear)]  # noqa: E731
        return {"G": grab(G), "E": grab(E), "Df": grab(Df), "alpha": 0.9}

    def _gan_score(self, Z):
        g = self.gan
        z = _mlp_forward(g["E"], Z)
        rec = _mlp_forward(g["G"], z)
        # Df ends with an activation: apply it to the last layer too
        def feat(x, zz):
            h = np.hstack([x, zz])
            for W, b in g["Df"]:
                h = h @ W + b
                h = np.where(h > 0, h, 0.2 * h)
            return h
        fm = np.abs(feat(Z, z) - feat(rec, z)).sum(axis=1)
        return g["alpha"] * np.abs(Z - rec).sum(axis=1) + (1 - g["alpha"]) * fm

    def raw_scores(self, Z: np.ndarray) -> dict:
        n = len(Z)
        out = {}
        out["Isolation Forest"] = -self.iforest.score_samples(Z)
        out["One-class SVM"] = -self.ocsvm.score_samples(Z)
        out["LOF"] = -self.lof.score_samples(Z)
        dist, _ = self.knn.kneighbors(Z)
        out["KNN"] = dist.mean(axis=1)
        # ECOD: the more extreme tail of each feature's empirical CDF, summed as −log
        s = np.zeros(n)
        m = len(self.sorted)
        for j in range(Z.shape[1]):
            left = (np.searchsorted(self.sorted[:, j], Z[:, j], side="right") + 1) / (m + 2)
            right = (m - np.searchsorted(self.sorted[:, j], Z[:, j], side="left") + 1) / (m + 2)
            s += -np.log(np.minimum(left, right))
        out["ECOD"] = s
        h = np.zeros(n)
        for j, (cnt, edges) in enumerate(self.hist):
            b = np.clip(np.searchsorted(edges, Z[:, j], side="right") - 1, 0, len(cnt) - 1)
            outside = (Z[:, j] < edges[0]) | (Z[:, j] > edges[-1])
            dens = np.where(outside, 0.5, cnt[b]) / cnt.sum()
            h += -np.log(dens + 1e-6)
        out["HBOS"] = h
        out["Autoencoder"] = ((_mlp_forward(self.ae, Z) - Z) ** 2).mean(axis=1)
        out["GAN (BiGAN/EGBAD)"] = self._gan_score(Z)
        return out

    def percentiles(self, Z: np.ndarray) -> dict:
        raw = self.raw_scores(Z)
        return {m: np.searchsorted(self.train_scores[m], raw[m], side="right") / len(self.train_scores[m]) for m in self.NAMES}

    def score(self, X: np.ndarray) -> dict:
        Z = (X - self.mu) / self.sd
        p = self.percentiles(Z)
        ens = np.mean([p[m] for m in self.NAMES], axis=0)
        votes = np.sum([p[m] >= 0.9 for m in self.NAMES], axis=0)
        return {"per_model": p, "ensemble": ens, "votes": votes}

    def shapley(self, x: np.ndarray, permutations: int = 40, seed: int = 0) -> dict:
        """Shapley values of the ensemble score for one doctor, per original feature (its columns move together),
        by permutation sampling against the population median: they sum to score(x) − score(median)."""
        rng = np.random.default_rng(seed)
        z = (x - self.mu) / self.sd
        groups: dict[str, list[int]] = {}
        for j, c in enumerate(self.columns):
            groups.setdefault(group_of(c), []).append(j)
        names = list(groups)
        phi = np.zeros(len(names))
        # all coalitions of all permutations in one batch
        batch, marks = [], []
        for _ in range(permutations):
            order = rng.permutation(len(names))
            cur = self.median.copy()
            batch.append(cur.copy())
            for gi in order:
                cur[groups[names[gi]]] = z[groups[names[gi]]]
                batch.append(cur.copy())
                marks.append(gi)
        Zb = np.vstack(batch)
        p = self.percentiles(Zb)
        val = np.mean([p[m] for m in self.NAMES], axis=0)
        k = 0
        for t in range(permutations):
            base = t * (len(names) + 1)
            for step in range(len(names)):
                phi[marks[k]] += val[base + step + 1] - val[base + step]
                k += 1
        phi /= permutations
        return dict(sorted(zip(names, phi.tolist()), key=lambda kv: -kv[1]))


def auroc(scores: np.ndarray, labels: np.ndarray) -> float:
    from sklearn.metrics import roc_auc_score

    return float(roc_auc_score(labels, scores)) if 0 < labels.sum() < len(labels) else float("nan")
