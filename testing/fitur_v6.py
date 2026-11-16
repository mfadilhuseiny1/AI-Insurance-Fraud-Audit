"""X6: network features in the style of entity-network analytics (ML v6, testing/kriteria_ml_v6.json). No labels: the only
"suspicion" propagated is the rule engine's own score of earlier claims.

Causal at day level: a claim on day d sees the claims of days [d-30, d) (and its member's visits up to d). Per day the
hospital-hospital graph is projected from shared members (sparse M^T M), then:
  rs_pasangan_n30          hospitals sharing at least one member with this one
  rs_pasangan_maks_jaccard30  the strongest partner, shared members / union of members
  rs_pagerank30            PageRank in the weighted hospital graph (x number of active hospitals: 1 = average)
  komunitas_ukuran         hospitals in this one's community (connected components of edges with >= 2 shared members)
  komunitas_skor_rule      mean rule score of the community's claims
  rs_skor_rule30           mean rule score of this hospital's claims
  tetangga_rs_skor_rule    partners' mean rule score, weighted by shared members (one-step propagation)
  peserta_lintas_komunitas7  communities the member used in 7 days (with this claim's)
  motif_bolak_balik14      the member went A -> B -> back to A (this hospital) within 14 days
  rs_peserta_baru7         share of this hospital's last-7-day members it did not see in the 23 days before
  rs_resiprokal_maks       strongest two-way member flow between this hospital and one partner
Synthetic data only."""
from __future__ import annotations

from datetime import date

import numpy as np
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import connected_components

NAMES = ["v6: rs_pasangan_n30", "v6: rs_pasangan_maks_jaccard30", "v6: rs_pagerank30", "v6: komunitas_ukuran", "v6: komunitas_skor_rule",
         "v6: rs_skor_rule30", "v6: tetangga_rs_skor_rule", "v6: peserta_lintas_komunitas7", "v6: motif_bolak_balik14", "v6: rs_peserta_baru7",
         "v6: rs_resiprokal_maks"]
D0 = date(2024, 1, 1)


def _hari(a) -> np.ndarray:
    return np.array([(date.fromisoformat(str(s)[:10]) - D0).days for s in a], dtype=np.int32)


def _pagerank(H: csr_matrix, aktif: np.ndarray, it: int = 30, d: float = 0.85) -> np.ndarray:
    n = H.shape[0]
    deg = np.asarray(H.sum(1)).ravel()
    inv = np.divide(1.0, deg, out=np.zeros_like(deg, dtype=float), where=deg > 0)
    P = csr_matrix(H.multiply(inv[:, None]))  # row-stochastic over partners
    m = aktif.sum()
    if m == 0:
        return np.zeros(n)
    r = np.where(aktif, 1.0 / m, 0.0)
    for _ in range(it):
        dang = r[deg == 0].sum()
        r = (1 - d) / m * aktif + d * (P.T @ r + dang / m * aktif)
    return r * m


class Fitur6:
    def __init__(self, stream: dict) -> None:
        self.S = {k: np.asarray(v) for k, v in stream.items()}
        self.X_stream = self._jalan(None, self.S)

    def blok(self, arr: dict) -> np.ndarray:
        return self._jalan(self.S, {k: np.asarray(v) for k, v in arr.items()})

    def _jalan(self, hist: dict | None, arr: dict) -> np.ndarray:
        nb = len(arr["peserta"])
        if hist is None:
            P, F, T, R, is_b = arr["peserta"].astype(str), arr["faskes"].astype(str), arr["tgl"], arr["skor"].astype(float), np.ones(nb, bool)
        else:
            P = np.concatenate([hist["peserta"].astype(str), arr["peserta"].astype(str)])
            F = np.concatenate([hist["faskes"].astype(str), arr["faskes"].astype(str)])
            T = np.concatenate([hist["tgl"], arr["tgl"]])
            R = np.concatenate([hist["skor"].astype(float), arr["skor"].astype(float)])
            is_b = np.r_[np.zeros(len(hist["peserta"]), bool), np.ones(nb, bool)]
        days = _hari(T)
        _, im = np.unique(P, return_inverse=True)
        _, ih = np.unique(F, return_inverse=True)
        nm, nh = im.max() + 1, ih.max() + 1
        out = np.full((nb, len(NAMES)), np.nan, np.float32)
        b_rows = np.flatnonzero(is_b)
        pos_b = np.empty(len(P), dtype=np.int64)
        pos_b[b_rows] = np.arange(nb)
        # member visit lists (all rows), sorted by day, for the member-level features
        order = np.lexsort((days, im))
        vis: dict[int, list[tuple[int, int]]] = {}
        for i in order:
            vis.setdefault(int(im[i]), []).append((int(days[i]), int(ih[i])))
        for d in np.unique(days[b_rows]):
            w = np.flatnonzero((days >= d - 30) & (days < d))
            today = b_rows[days[b_rows] == d]
            if len(w) == 0:
                out[pos_b[today]] = [0, 0, 0, 1, np.nan, np.nan, np.nan, 1, 0, np.nan, 0]
                continue
            pairs = np.unique(np.stack([im[w], ih[w]], 1), axis=0)
            M = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(nm, nh))
            H = (M.T @ M).tocsr()
            n_i = H.diagonal().astype(float)
            H.setdiag(0); H.eliminate_zeros()
            co = H.tocoo()
            deg = np.bincount(co.row, minlength=nh)
            jac = co.data / np.maximum(1e-9, n_i[co.row] + n_i[co.col] - co.data)
            maxjac = np.zeros(nh); np.maximum.at(maxjac, co.row, jac)
            aktif = n_i > 0
            pr = _pagerank(H, aktif)
            strong = csr_matrix((np.ones(int((co.data >= 2).sum())), (co.row[co.data >= 2], co.col[co.data >= 2])), shape=(nh, nh))
            _, comp = connected_components(strong, directed=False)
            csize = np.bincount(comp, minlength=comp.max() + 1)
            rs_sum = np.bincount(ih[w], weights=R[w], minlength=nh); rs_n = np.bincount(ih[w], minlength=nh)
            rs_mean = np.divide(rs_sum, rs_n, out=np.full(nh, np.nan), where=rs_n > 0)
            c_sum = np.bincount(comp[ih[w]], weights=R[w], minlength=csize.size); c_n = np.bincount(comp[ih[w]], minlength=csize.size)
            c_mean = np.divide(c_sum, c_n, out=np.full(csize.size, np.nan), where=c_n > 0)
            wsum = np.asarray(H.sum(1)).ravel()
            nb_mean = np.divide(H @ np.nan_to_num(rs_mean), wsum, out=np.full(nh, np.nan), where=wsum > 0)
            # two-way flows: consecutive visits of a member to different hospitals within the window
            ws = w[np.lexsort((days[w], im[w]))]
            same = im[ws[1:]] == im[ws[:-1]]
            diff = ih[ws[1:]] != ih[ws[:-1]]
            k = same & diff
            if k.any():
                Tm = coo_matrix((np.ones(int(k.sum())), (ih[ws[:-1]][k], ih[ws[1:]][k])), shape=(nh, nh)).tocsr()
                rec = Tm.minimum(Tm.T).tocoo()
                recmax = np.zeros(nh); np.maximum.at(recmax, rec.row, rec.data)
            else:
                recmax = np.zeros(nh)
            # new members in the last 7 days
            w7 = w[days[w] >= d - 7]; wo = w[days[w] < d - 7]
            old = set(zip(im[wo].tolist(), ih[wo].tolist()))
            new_n = np.zeros(nh); tot_n = np.zeros(nh)
            for mm, hh in set(zip(im[w7].tolist(), ih[w7].tolist())):
                tot_n[hh] += 1
                new_n[hh] += (mm, hh) not in old
            baru = np.divide(new_n, tot_n, out=np.full(nh, np.nan), where=tot_n > 0)
            for i in today:
                h, m = int(ih[i]), int(im[i])
                hv = [(dd, hh) for dd, hh in vis.get(m, []) if dd < d]
                c7 = {int(comp[hh]) for dd, hh in hv if dd >= d - 7} | {int(comp[h])}
                seq = [hh for dd, hh in hv if dd >= d - 14]
                motif = 0.0
                if h in seq:
                    after = seq[len(seq) - 1 - seq[::-1].index(h) + 1:] if seq[::-1].index(h) > 0 else []
                    motif = float(any(x != h for x in after))
                out[pos_b[i]] = [deg[h], maxjac[h], pr[h], csize[comp[h]], c_mean[comp[h]], rs_mean[h], nb_mean[h], len(c7), motif, baru[h], recmax[h]]
        return out
