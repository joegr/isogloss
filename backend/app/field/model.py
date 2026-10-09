"""The audio field: a Gaussian process on the node graph, in PyTorch.

Every equation here is derived in docs/AUDIO_FIELD.md; section numbers refer
to it. In one paragraph:

Each training node i sits at a place and holds recordings. A recording's
acoustic vector x (featurize.py) is encoded to z = Wᵀ(x − x̄)/s ∈ R^r and
whitened. Each embedding dimension is modelled as a GP over geography whose
covariance is the *heat kernel of the node graph* — the propagator of the
diffusion that is assumed to have spread the accent (§4–5):

    L = D − W,    K = (I + t L)⁻¹,    K̃ = diag(K)^-½ K diag(K)^-½
    z_ik = f(node i) + ε_ik,    f ~ GP(0, s² K̃),    ε ~ N(0, s² ρ)

Training maximises the exact marginal likelihood of all recordings (§6) plus a
held-out geolocation cross-entropy (§7) with respect to the encoder W, the
gravity exponents α and γ, the diffusion time t and the per-dimension s², ρ.
Inference inverts the GP with Bayes' rule on a lattice (§8):

    log P(x | z*) = Σ_r log N(z*_r; μ_r(x), σ²_r(x) + s²_r ρ_r) + log prior(x)
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import torch
from torch import nn

from .graph import NodeGraph

LOG2PI = math.log(2 * math.pi)
DTYPE = torch.float64            # the kernel is an inverse of a Laplacian; float32 is not enough
TOP_K = 16                       # query→node attachment: neighbours kept per grid cell
JITTER = 1e-6


def _t(x, dtype=DTYPE) -> torch.Tensor:
    return torch.as_tensor(np.asarray(x), dtype=dtype)


@dataclass
class Observations:
    """Recordings grouped by node. Built by service.py from a store."""
    X: np.ndarray            # (N, D) acoustic vectors, NaN where unmeasured
    node: np.ndarray         # (N,) node index into the graph
    rates: np.ndarray        # (N, P) phone production rates


class GeoAudioField(nn.Module):
    def __init__(self, n_in: int, rank: int = 6, hidden: int = 0):
        super().__init__()
        self.n_in, self.rank, self.hidden = n_in, rank, hidden
        self.register_buffer("x_mean", torch.zeros(n_in, dtype=DTYPE))
        self.register_buffer("x_scale", torch.ones(n_in, dtype=DTYPE))
        if hidden:
            self.encoder = nn.Sequential(nn.Linear(n_in, hidden), nn.GELU(),
                                         nn.Linear(hidden, rank)).to(DTYPE)
        else:
            self.encoder = nn.Linear(n_in, rank, bias=False).to(DTYPE)
        # Whitening, frozen from the training recordings once training ends.
        self.register_buffer("z_mean", torch.zeros(rank, dtype=DTYPE))
        self.register_buffer("z_white", torch.eye(rank, dtype=DTYPE))

        # Gravity and diffusion. Initialised at the reference model's values
        # (geo.py: α = 0.5, γ = 2, t = σ² = 0.8) so training starts from the
        # hand-tuned field and moves only as far as the data asks.
        self.log_alpha = nn.Parameter(torch.tensor(math.log(0.5), dtype=DTYPE))
        self.log_gamma = nn.Parameter(torch.tensor(math.log(2.0), dtype=DTYPE))
        self.log_t = nn.Parameter(torch.tensor(math.log(0.8), dtype=DTYPE))
        self.log_s2 = nn.Parameter(torch.zeros(rank, dtype=DTYPE))
        self.log_rho = nn.Parameter(torch.zeros(rank, dtype=DTYPE))

    # -- hyperparameters, named -----------------------------------------------

    @property
    def alpha(self) -> torch.Tensor:
        return self.log_alpha.exp()

    @property
    def gamma(self) -> torch.Tensor:
        return self.log_gamma.exp()

    @property
    def t(self) -> torch.Tensor:
        return self.log_t.exp()

    @property
    def s2(self) -> torch.Tensor:
        return self.log_s2.exp()

    @property
    def rho(self) -> torch.Tensor:
        return self.log_rho.exp()

    # -- §2 the encoder -------------------------------------------------------

    def standardise_from(self, X: np.ndarray) -> None:
        mean = np.nanmean(np.where(np.isfinite(X), X, np.nan), axis=0)
        sd = np.nanstd(np.where(np.isfinite(X), X, np.nan), axis=0)
        mean = np.where(np.isfinite(mean), mean, 0.0)
        sd = np.where(np.isfinite(sd) & (sd > 1e-9), sd, 1.0)
        self.x_mean.copy_(_t(mean))
        self.x_scale.copy_(_t(sd))

    def init_pca(self, X: np.ndarray) -> None:
        """Start the linear encoder at the leading principal directions.

        Not essential, but it means epoch 0 is already a sensible embedding and
        training only has to rotate it towards the geographic directions."""
        if self.hidden:
            return
        Xs = self._standard(X).numpy()
        _, _, vt = np.linalg.svd(Xs - Xs.mean(axis=0), full_matrices=False)
        k = min(self.rank, vt.shape[0])
        w = np.zeros((self.rank, self.n_in))
        w[:k] = vt[:k]
        with torch.no_grad():
            self.encoder.weight.copy_(_t(w))

    def _standard(self, X) -> torch.Tensor:
        Xs = (_t(X) - self.x_mean) / self.x_scale
        return torch.nan_to_num(Xs, nan=0.0)     # unmeasured = the training mean

    def encode(self, X) -> torch.Tensor:
        """Raw encoder output, before whitening. (N, r)"""
        return self.encoder(self._standard(X))

    @staticmethod
    def whitening(E: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Mean and matrix that give E unit covariance across recordings.

        This is what stops the marginal likelihood being maximised by shrinking
        the embedding towards zero: with total variance pinned at I, the only
        way to raise the likelihood is to put variance where the graph says it
        is smooth (§6.3)."""
        mu = E.mean(dim=0)
        C = (E - mu).T @ (E - mu) / max(len(E) - 1, 1)
        C = C + 1e-4 * torch.eye(C.shape[0], dtype=E.dtype)
        Lc = torch.linalg.cholesky(C)
        white = torch.linalg.inv(Lc).T            # (E-mu) @ white has covariance I
        return mu, white

    def embed(self, X) -> torch.Tensor:
        """Whitened embedding with the frozen training statistics. (N, r)"""
        return (self.encode(X) - self.z_mean) @ self.z_white

    # -- §3–5 the graph and its heat kernel -------------------------------------

    def kernel(self, g: NodeGraph, idx: np.ndarray | None = None
               ) -> tuple[torch.Tensor, torch.Tensor]:
        """K̃ = unit-diagonal (I + tL)⁻¹ over nodes `idx`, and the log of the
        weight normaliser (needed to attach query points in the same units)."""
        sel = np.arange(g.n) if idx is None else np.asarray(idx)
        log_pop = _t(g.log_pop[sel])
        log_d = _t(g.log_d[np.ix_(sel, sel)])
        log_link = _t(g.log_link[np.ix_(sel, sel)])
        n = len(sel)

        logW = self.alpha * (log_pop[:, None] + log_pop[None, :]) - self.gamma * log_d + log_link
        eye = torch.eye(n, dtype=DTYPE, device=logW.device).bool()
        logW = logW.masked_fill(eye, -math.inf)
        lmax = logW.max() if n > 1 else torch.tensor(0.0, dtype=DTYPE)
        W = torch.exp(logW - lmax)                       # strongest edge = 1
        L = torch.diag(W.sum(dim=1)) - W
        M = torch.eye(n, dtype=DTYPE) + self.t * L
        K = torch.cholesky_inverse(torch.linalg.cholesky(M))
        dk = torch.sqrt(torch.diagonal(K))
        return K / (dk[:, None] * dk[None, :]), lmax

    def attach(self, g: NodeGraph, log_dq: np.ndarray, lmax: torch.Tensor,
               idx: np.ndarray | None = None) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Off-graph points (§5.3). Returns top-k neighbour indices, their
        normalised weights ŵ, and the coupling c = t·s/(1 + t·s) ∈ [0, 1).

        The query is treated as a new node of median population joined to the
        graph by gravity edges w_gj. The cross-covariance with the graph is
        k_g = c · ŵᵀ K̃ — a gravity-weighted average of graph columns, damped
        by how strongly the point is connected at all. Far from every node
        c → 0 and the field reverts to its prior; deep inside the graph c → 1
        and this is exactly the row-normalised Nyström extension geo.py uses.
        """
        sel = np.arange(g.n) if idx is None else np.asarray(idx)
        log_pop = _t(g.log_pop[sel])
        lp_med = torch.median(_t(g.log_pop))
        logw = (self.alpha * (lp_med + log_pop)[None, :]
                - self.gamma * _t(log_dq[:, sel]) - lmax)
        k = min(TOP_K, len(sel))
        top, nb = torch.topk(logw, k, dim=1)
        w = torch.exp(top)
        s = torch.exp(torch.logsumexp(logw, dim=1))           # total connection strength
        c = self.t * s / (1.0 + self.t * s)
        return nb, w / w.sum(dim=1, keepdim=True), c

    # -- §6 the marginal likelihood ---------------------------------------------

    @staticmethod
    def node_stats(Z: torch.Tensor, node: np.ndarray, n_nodes: int
                   ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Per-node mean, count and within-node scatter of the embeddings."""
        idx = torch.as_tensor(node, dtype=torch.long)
        cnt = torch.zeros(n_nodes, dtype=DTYPE).index_add_(0, idx, torch.ones(len(idx), dtype=DTYPE))
        sums = torch.zeros(n_nodes, Z.shape[1], dtype=DTYPE).index_add_(0, idx, Z)
        mean = sums / cnt.clamp(min=1)[:, None]
        ss = torch.zeros(n_nodes, Z.shape[1], dtype=DTYPE).index_add_(0, idx, (Z - mean[idx]) ** 2)
        return mean, cnt, ss

    def log_marginal(self, Kc: torch.Tensor, zbar: torch.Tensor, cnt: torch.Tensor,
                     ss: torch.Tensor) -> torch.Tensor:
        """log p(all recordings) under the model, exactly (§6.1–6.2).

        Node means carry the field: z̄_i ~ N(0, s²(K̃ + ρ diag(1/m))). The
        scatter of recordings around their node mean depends only on the
        noise, and contributes the second term. Summed over embedding dims."""
        n, r = zbar.shape
        s2, rho = self.s2, self.rho
        C = s2[:, None, None] * (Kc[None] + rho[:, None, None] * torch.diag(1.0 / cnt)[None])
        C = C + JITTER * torch.eye(n, dtype=DTYPE)[None]
        Lc = torch.linalg.cholesky(C)                                  # (r, n, n)
        z = zbar.T.unsqueeze(-1)                                       # (r, n, 1)
        a = torch.cholesky_solve(z, Lc)
        quad = (z * a).sum(dim=(1, 2))
        logdet = 2 * torch.log(torch.diagonal(Lc, dim1=1, dim2=2)).sum(dim=1)
        between = -0.5 * (quad + logdet + n * LOG2PI)

        dof = (cnt - 1).clamp(min=0).sum()
        v = s2 * rho
        within = -0.5 * (dof * (LOG2PI + torch.log(v)) + ss.sum(dim=0) / v)
        return (between + within).sum()

    # -- §7–8 prediction --------------------------------------------------------

    def condition(self, Kc: torch.Tensor, zbar: torch.Tensor, cnt: torch.Tensor
                  ) -> tuple[torch.Tensor, torch.Tensor]:
        """Per dimension: A_r = (K̃ + ρ_r diag(1/m))⁻¹, and α_r = A_r z̄_r."""
        n = Kc.shape[0]
        C = Kc[None] + self.rho[:, None, None] * torch.diag(1.0 / cnt)[None]
        C = C + JITTER * torch.eye(n, dtype=DTYPE)[None]
        A = torch.cholesky_inverse(torch.linalg.cholesky(C))           # (r, n, n)
        alpha = (A @ zbar.T.unsqueeze(-1)).squeeze(-1)                 # (r, n)
        return A, alpha

    def predict_nodes(self, Kc_cand_cond: torch.Tensor, A: torch.Tensor, alpha: torch.Tensor
                      ) -> tuple[torch.Tensor, torch.Tensor]:
        """Mean and *predictive* variance of a new recording at graph nodes.
        Kc_cand_cond: (n_cand, n_cond). Returns (n_cand, r) each."""
        mu = Kc_cand_cond @ alpha.T
        q = torch.einsum("cn,rnm,cm->cr", Kc_cand_cond, A, Kc_cand_cond)
        var = self.s2 * (1.0 - q).clamp(min=1e-6) + self.s2 * self.rho
        return mu, var

    def predict_points(self, Kc: torch.Tensor, A: torch.Tensor, alpha: torch.Tensor,
                       nb: torch.Tensor, w: torch.Tensor, c: torch.Tensor
                       ) -> tuple[torch.Tensor, torch.Tensor]:
        """Mean and predictive variance at off-graph points (§5.3, §8)."""
        kg = c[:, None] * torch.einsum("gk,gkn->gn", w, Kc[nb])       # (G, n)
        mu = kg @ alpha.T                                              # (G, r)
        B = Kc[None] @ A @ Kc[None]                                    # (r, n, n)
        Bs = B[:, nb[:, :, None], nb[:, None, :]]                      # (r, G, k, k)
        q = (c ** 2)[None, :] * torch.einsum("gk,rgkl,gl->rg", w, Bs, w)
        var = self.s2[:, None] * (1.0 - q).clamp(min=1e-6) + (self.s2 * self.rho)[:, None]
        return mu, var.T

    @staticmethod
    def loglik(y: torch.Tensor, mu: torch.Tensor, var: torch.Tensor) -> torch.Tensor:
        """log N(y; μ, var), summed over dims. y (Q, r), mu/var (C, r) → (Q, C)."""
        d = y[:, None, :] - mu[None, :, :]
        return -0.5 * ((d ** 2) / var[None] + torch.log(var)[None] + LOG2PI).sum(dim=-1)
