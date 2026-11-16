"""Models of the v4 graph / deep-learning variants (testing/varian_graf_dl.py): GraphSAGE and R-GCN on the causal claim graph,
an MLP and a small FT-Transformer on tabular features. CUDA when available (GRAF_DEVICE overrides), else CPU; full-batch for
the GNNs, mini-batch for the tabular nets. Trained weights are saved on CPU (simpan_model) and load on a CPU-only machine.
Early stopping only on a split of the TRAINING rows; the epoch count it picks is then used to refit on every training row.
Synthetic data only."""
from __future__ import annotations

import copy
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

POS_WEIGHT = 5.0
AUX_W = 0.3  # weight of the auxiliary scheme head (multi-task: fraud yes/no + which scheme)
DEV = torch.device(os.environ.get("GRAF_DEVICE") or ("cuda:0" if torch.cuda.is_available() else "cpu"))


def operator_ke_dev(A: torch.Tensor) -> torch.Tensor:
    """The sparse layer-2 operator on DEV. On CUDA, CSR is kept when sparse.mm with a gradient works on this build, else COO."""
    if DEV.type == "cpu":
        return A
    try:
        t = torch.sparse_csr_tensor(torch.tensor([0, 1, 2]), torch.tensor([1, 0]), torch.tensor([1.0, 1.0]), size=(2, 2)).to(DEV)
        h = torch.ones(2, 3, device=DEV, requires_grad=True)
        torch.sparse.mm(t, h).sum().backward()
        return A.to(DEV)
    except (RuntimeError, NotImplementedError):
        return A.to_sparse_coo().coalesce().to(DEV)


def simpan_model(model: nn.Module, path, meta: dict) -> None:
    """Weights on CPU + what is needed to rebuild the net; torch.load(path, map_location='cpu') on any machine."""
    torch.save({"state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()}, "meta": meta}, path)


def kriteria_es(y: np.ndarray, s: np.ndarray) -> float:
    """Early-stopping criterion on the training split: mean of AUPRC and recall at FPR 1 %."""
    from sklearn.metrics import average_precision_score

    if y.sum() == 0 or (y == 0).sum() == 0:
        return 0.0
    sn = np.sort(s[y == 0])[::-1]
    t = sn[int(np.floor(0.01 * len(sn)))]
    return 0.5 * float(average_precision_score(y, s)) + 0.5 * float((s[y == 1] > t).mean())


# ---------------------------------------------------------------- GNN

class GNN(nn.Module):
    """Two message-passing layers. Layer 1 is linear in [x, A_1 x, ..., A_R x] (the means A_r x are precomputed: no gradient
    flows through the graph there); layer 2 aggregates the layer-1 states h1 of the neighbours. R = 1 (homogeneous mean over
    the union of the relations) is GraphSAGE-mean; R = 4 (one weight matrix per relation, mean per relation) is R-GCN.
    The heads read [h1, h2] (jumping knowledge)."""

    def __init__(self, f_in: int, h: int, R: int, n_cls: int, drop: float = 0.2) -> None:
        super().__init__()
        self.R = R
        self.l1 = nn.Linear(f_in * (1 + R), h)
        self.n1 = nn.LayerNorm(h)
        self.l2s = nn.Linear(h, h)
        self.l2r = nn.Linear(h * R, h, bias=False)
        self.n2 = nn.LayerNorm(h)
        self.drop = nn.Dropout(drop)
        self.head = nn.Sequential(nn.Linear(2 * h, h), nn.ReLU(), nn.Dropout(drop), nn.Linear(h, 1))
        self.aux = nn.Linear(2 * h, n_cls)

    def forward(self, Z1: torch.Tensor, A: torch.Tensor):
        N = Z1.shape[0]
        h1 = self.drop(F.relu(self.n1(self.l1(Z1))))
        m = torch.sparse.mm(A, h1).view(self.R, N, -1).permute(1, 0, 2).reshape(N, -1)
        h2 = self.drop(F.relu(self.n2(self.l2s(h1) + self.l2r(m))))
        z = torch.cat([h1, h2], 1)
        return self.head(z).squeeze(-1), self.aux(z)


def latih_gnn(Z1: np.ndarray, A: torch.Tensor, R: int, y: np.ndarray, cls: np.ndarray, n_cls: int, fit: np.ndarray,
              es: np.ndarray | None, seed: int, epochs: int | None = None, max_ep: int = 300, patience: int = 40,
              h: int = 64, lr: float = 5e-3, log=None) -> tuple[GNN, int, dict]:
    """Full-batch training. With `es` (a mask of held-out TRAINING nodes): early stopping, returns the best epoch.
    With `epochs`: a fixed number of steps (the refit / the out-of-fold models)."""
    torch.manual_seed(seed); np.random.seed(seed)
    Zt = torch.from_numpy(np.ascontiguousarray(Z1, dtype=np.float32)).to(DEV)
    yt = torch.from_numpy(y.astype(np.float32)).to(DEV); ct = torch.from_numpy(cls.astype(np.int64)).to(DEV)
    idx = torch.from_numpy(np.where(fit)[0]).to(DEV)
    A = A if A.device == DEV else operator_ke_dev(A)
    model = GNN(Z1.shape[1] // (1 + R), h, R, n_cls).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    pw = torch.tensor(POS_WEIGHT, device=DEV)
    best = (-1.0, 0, None)
    hist = []
    n_ep = epochs if epochs is not None else max_ep
    t0 = time.time()
    for ep in range(1, n_ep + 1):
        model.train(); opt.zero_grad()
        o, a = model(Zt, A)
        loss = F.binary_cross_entropy_with_logits(o[idx], yt[idx], pos_weight=pw) + AUX_W * F.cross_entropy(a[idx], ct[idx])
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if epochs is None and ep % 5 == 0:
            model.eval()
            with torch.no_grad():
                s = model(Zt, A)[0].cpu().numpy()
            k = kriteria_es(y[es], s[es])
            hist.append((ep, round(loss.item(), 4), round(k, 4)))
            if k > best[0]:
                best = (k, ep, copy.deepcopy(model.state_dict()))
            elif ep - best[1] >= patience:
                break
            if log and ep % 25 == 0:
                log(f"    ep {ep} loss {loss.item():.4f} es {k:.4f} (best {best[0]:.4f} @ {best[1]}) {time.time() - t0:.0f}s")
    if epochs is None:
        model.load_state_dict(best[2])
        return model, best[1], {"riwayat": hist, "es_terbaik": round(best[0], 4), "detik": round(time.time() - t0, 1)}
    return model, n_ep, {"detik": round(time.time() - t0, 1)}


@torch.no_grad()
def prediksi_gnn(model: GNN, Z1: np.ndarray, A: torch.Tensor) -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    dev = next(model.parameters()).device
    A = A if A.device == dev else (operator_ke_dev(A) if dev == DEV else A.to(dev))
    o, a = model(torch.from_numpy(np.ascontiguousarray(Z1, dtype=np.float32)).to(dev), A)
    return o.cpu().numpy(), torch.softmax(a, 1).cpu().numpy()


# ---------------------------------------------------------------- tabular nets

class MLP(nn.Module):
    def __init__(self, f_in: int, drop: float = 0.2) -> None:
        super().__init__()
        self.net = nn.Sequential(nn.Linear(f_in, 512), nn.BatchNorm1d(512), nn.ReLU(), nn.Dropout(drop),
                                 nn.Linear(512, 256), nn.BatchNorm1d(256), nn.ReLU(), nn.Dropout(drop), nn.Linear(256, 1))

    def forward(self, x):
        return self.net(x).squeeze(-1)


class FTTransformer(nn.Module):
    """A small FT-Transformer with grouped tokens: one token per scalar feature (`skalar` columns) and one token per block of
    columns (`blok`: the four neighbour-mean blocks, each a linear map of its 124 columns), plus [CLS]. Pre-norm blocks."""

    def __init__(self, skalar: list[int], blok: list[list[int]], d: int = 32, n_layer: int = 2, n_head: int = 4, drop: float = 0.1) -> None:
        super().__init__()
        # index buffers (not saved: rebuilt from skalar/blok) so they follow the module to its device
        self.register_buffer("skalar", torch.tensor(skalar, dtype=torch.long), persistent=False)
        for i, b in enumerate(blok):
            self.register_buffer(f"blok{i}", torch.tensor(b, dtype=torch.long), persistent=False)
        self.n_blok = len(blok)
        n = len(skalar)
        self.w = nn.Parameter(torch.randn(n, d) * 0.1)
        self.b = nn.Parameter(torch.zeros(n, d))
        self.proj = nn.ModuleList([nn.Linear(len(b), d) for b in blok])
        self.cls = nn.Parameter(torch.randn(1, 1, d) * 0.1)
        layer = nn.TransformerEncoderLayer(d, n_head, dim_feedforward=2 * d, dropout=drop, batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, n_layer, enable_nested_tensor=False)
        self.out = nn.Sequential(nn.LayerNorm(d), nn.ReLU(), nn.Linear(d, 1))

    def forward(self, x):
        tok = x[:, self.skalar].unsqueeze(-1) * self.w + self.b
        bl = torch.stack([p(x[:, getattr(self, f"blok{i}")]) for i, p in enumerate(self.proj)], 1)
        z = torch.cat([self.cls.expand(len(x), -1, -1), tok, bl], 1)
        return self.out(self.enc(z)[:, 0]).squeeze(-1)


def latih_tabel(buat, X: np.ndarray, y: np.ndarray, fit: np.ndarray, es: np.ndarray | None, seed: int, epochs: int | None = None,
                max_ep: int = 40, patience: int = 6, batch: int = 512, lr: float = 1e-3, frac_normal: float = 1.0,
                log=None) -> tuple[nn.Module, int, dict]:
    """Mini-batch training of a tabular net. `frac_normal` < 1 samples that share of the normal rows afresh every epoch (all
    fraud rows are kept): a speed-up for the transformer. Early stopping as latih_gnn (evaluated each epoch)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    Xt = torch.from_numpy(np.ascontiguousarray(X, dtype=np.float32)).to(DEV)
    yt = torch.from_numpy(y.astype(np.float32)).to(DEV)
    model = buat().to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-5)
    pw = torch.tensor(POS_WEIGHT, device=DEV)
    rows = np.where(fit)[0]
    pos, neg = rows[y[rows] == 1], rows[y[rows] == 0]
    best = (-1.0, 0, None)
    hist = []
    n_ep = epochs if epochs is not None else max_ep
    t0 = time.time()
    for ep in range(1, n_ep + 1):
        model.train()
        take = neg if frac_normal >= 1 else rng.choice(neg, int(frac_normal * len(neg)), replace=False)
        order = rng.permutation(np.concatenate([pos, take]))
        for a in range(0, len(order), batch):
            b = torch.from_numpy(order[a:a + batch]).to(DEV)
            if len(b) < 2:
                continue
            opt.zero_grad()
            loss = F.binary_cross_entropy_with_logits(model(Xt[b]), yt[b], pos_weight=pw)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
        if epochs is None:
            s = prediksi_tabel(model, X[es])
            k = kriteria_es(y[es], s)
            hist.append((ep, round(k, 4)))
            if k > best[0]:
                best = (k, ep, copy.deepcopy(model.state_dict()))
            elif ep - best[1] >= patience:
                break
            if log:
                log(f"    ep {ep} es {k:.4f} (best {best[0]:.4f} @ {best[1]}) {time.time() - t0:.0f}s")
    if epochs is None:
        model.load_state_dict(best[2])
        return model, best[1], {"riwayat": hist, "es_terbaik": round(best[0], 4), "detik": round(time.time() - t0, 1)}
    return model, n_ep, {"detik": round(time.time() - t0, 1)}


@torch.no_grad()
def prediksi_tabel(model: nn.Module, X: np.ndarray, batch: int = 4096) -> np.ndarray:
    model.eval()
    dev = next(model.parameters()).device
    out = [model(torch.from_numpy(np.ascontiguousarray(X[a:a + batch], dtype=np.float32)).to(dev)).cpu().numpy()
           for a in range(0, len(X), batch)]
    return np.concatenate(out) if out else np.zeros(0, np.float32)
