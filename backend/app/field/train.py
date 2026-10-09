"""Training the audio field, and scoring it honestly.

The objective (docs/AUDIO_FIELD.md §6–7) is

    loss = −(1/(N·r)) log p(Z | graph)  +  λ · CE_geo

  * the first term is the exact GP marginal likelihood of every recording's
    whitened embedding. It fits the graph's hyperparameters (α, γ, t), the
    per-dimension signal and noise (s², ρ) and — because the embedding is
    whitened — rotates the encoder towards directions that are smooth on the
    graph;
  * CE_geo holds out a random fold of training nodes at every step, conditions
    the GP on the rest, and asks each held-out recording to pick its own node
    out of all candidates. It is the task itself, made differentiable.

Nodes, not recordings, are split into train and validation, so that a
validation speaker's location was never conditioned on. Validation drives
early stopping and produces the reported error; the final model then
conditions on every node.
"""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field

import numpy as np
import torch

from .graph import NodeGraph
from .model import DTYPE, GeoAudioField, Observations


@dataclass
class TrainConfig:
    rank: int = 6
    hidden: int = 0                  # 0 = linear encoder
    epochs: int = 300
    lr: float = 0.03
    weight_decay: float = 1e-3       # on the encoder only
    ce_weight: float = 1.0
    fold: float = 0.25               # share of training nodes held out per step
    val_share: float = 0.2
    patience: int = 60
    eval_every: int = 5
    bandwidth_km: float | None = None  # soft-label width for CE; default from node spacing
    seed: int = 0


@dataclass
class TrainReport:
    epochs_run: int
    best_epoch: int
    n_nodes: int
    n_recordings: int
    rank: int
    hyper: dict
    history: list[dict] = field(default_factory=list)
    validation: dict = field(default_factory=dict)


def _bandwidth(g: NodeGraph) -> float:
    d = g.geo_km + np.eye(g.n) * 1e9
    return float(max(50.0, 2.0 * np.median(d.min(axis=1))))


def soft_labels(g: NodeGraph, true_nodes: np.ndarray, cand: np.ndarray, h: float) -> torch.Tensor:
    """q(j | i) ∝ exp(−d(i, j)² / 2h²): a near miss is partly right (§7)."""
    d = g.geo_km[np.ix_(true_nodes, cand)]
    q = np.exp(-0.5 * (d / h) ** 2)
    return torch.as_tensor(q / q.sum(axis=1, keepdims=True), dtype=DTYPE)


def geo_scores(model: GeoAudioField, g: NodeGraph, Z: torch.Tensor, obs_node: np.ndarray,
               cond: np.ndarray, cand: np.ndarray, query_rec: np.ndarray
               ) -> torch.Tensor:
    """log P(candidate node | recording) for `query_rec`, with the GP
    conditioned on the recordings of nodes `cond` only. (Q, n_cand)"""
    in_cond = np.isin(obs_node, cond)
    remap = {int(k): i for i, k in enumerate(cond)}
    local = np.array([remap[int(k)] for k in obs_node[in_cond]])
    zbar, cnt, _ = model.node_stats(Z[torch.as_tensor(np.nonzero(in_cond)[0])], local, len(cond))

    both = np.concatenate([cond, np.setdiff1d(cand, cond)])
    Kall, _ = model.kernel(g, both)
    n = len(cond)
    A, alpha = model.condition(Kall[:n, :n], zbar, cnt)
    pos = {int(k): i for i, k in enumerate(both)}
    rows = torch.as_tensor([pos[int(k)] for k in cand])
    mu, var = model.predict_nodes(Kall[rows][:, :n], A, alpha)
    ll = model.loglik(Z[torch.as_tensor(query_rec)], mu, var)
    return torch.log_softmax(ll, dim=1)


def fit(g: NodeGraph, obs: Observations, cfg: TrainConfig = TrainConfig()
        ) -> tuple[GeoAudioField, TrainReport]:
    if g.n < 3:
        raise ValueError("need at least 3 nodes to train a field")
    rng = np.random.default_rng(cfg.seed)
    torch.manual_seed(cfg.seed)

    rank = max(1, min(cfg.rank, obs.X.shape[1], g.n - 1))
    model = GeoAudioField(obs.X.shape[1], rank=rank, hidden=cfg.hidden)
    model.standardise_from(obs.X)
    model.init_pca(obs.X)

    nodes = np.unique(obs.node)
    n_val = int(round(cfg.val_share * len(nodes))) if len(nodes) >= 10 else 0
    perm = rng.permutation(nodes)
    val_nodes, train_nodes = np.sort(perm[:n_val]), np.sort(perm[n_val:])
    tr_rec = np.nonzero(np.isin(obs.node, train_nodes))[0]
    va_rec = np.nonzero(np.isin(obs.node, val_nodes))[0]
    h = cfg.bandwidth_km or _bandwidth(g)

    enc_params = list(model.encoder.parameters())
    hyper_params = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    opt = torch.optim.Adam([
        {"params": enc_params, "weight_decay": cfg.weight_decay},
        {"params": hyper_params, "weight_decay": 0.0},
    ], lr=cfg.lr)

    remap = {int(k): i for i, k in enumerate(train_nodes)}
    tr_local = np.array([remap[int(k)] for k in obs.node[tr_rec]])
    gt = _subgraph(g, train_nodes)

    best, best_state, best_epoch, history = math.inf, None, 0, []
    for epoch in range(cfg.epochs):
        model.train()
        opt.zero_grad()
        E = model.encode(obs.X[tr_rec])
        mu, white = model.whitening(E)
        Z = (E - mu) @ white

        Kc, _ = model.kernel(gt)
        zbar, cnt, ss = model.node_stats(Z, tr_local, len(train_nodes))
        nll = -model.log_marginal(Kc, zbar, cnt, ss) / (len(tr_rec) * rank)

        ce = torch.zeros((), dtype=DTYPE)
        if cfg.ce_weight > 0 and len(train_nodes) >= 4:
            k = max(1, int(round(cfg.fold * len(train_nodes))))
            held = rng.choice(len(train_nodes), size=k, replace=False)
            cond = np.setdiff1d(np.arange(len(train_nodes)), held)
            q_rec = np.nonzero(np.isin(tr_local, held))[0]
            logp = geo_scores(model, gt, Z, tr_local, cond, np.arange(gt.n), q_rec)
            q = soft_labels(gt, tr_local[q_rec], np.arange(gt.n), h)
            ce = -(q * logp).sum(dim=1).mean()

        loss = nll + cfg.ce_weight * ce
        loss.backward()
        opt.step()
        with torch.no_grad():                       # keep the graph in a sane regime
            model.log_alpha.clamp_(math.log(0.02), math.log(2.0))
            model.log_gamma.clamp_(math.log(0.2), math.log(5.0))
            model.log_t.clamp_(math.log(1e-3), math.log(1e3))
            model.log_rho.clamp_(math.log(1e-3), math.log(1e3))

        if epoch % cfg.eval_every == 0 or epoch == cfg.epochs - 1:
            row = {"epoch": epoch, "nll": round(float(nll), 4), "ce": round(float(ce), 4)}
            if len(va_rec):
                with torch.no_grad():
                    model.z_mean.copy_(mu.detach())
                    model.z_white.copy_(white.detach())
                    v = evaluate(model, g, obs, train_nodes, va_rec, h)
                row.update({"val_ce": round(v["ce"], 4), "val_median_km": v["median_km"]})
                score = v["ce"]
            else:
                score = float(loss)
            history.append(row)
            if score < best - 1e-4:
                best, best_epoch = score, epoch
                best_state = copy.deepcopy(model.state_dict())
            elif epoch - best_epoch >= cfg.patience:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    freeze_whitening(model, obs.X)

    validation = {}
    if len(va_rec):
        with torch.no_grad():
            validation = evaluate(model, g, obs, train_nodes, va_rec, h, baselines=True)
        validation["nodes"] = int(len(val_nodes))
        validation["recordings"] = int(len(va_rec))

    report = TrainReport(
        epochs_run=history[-1]["epoch"] + 1 if history else 0, best_epoch=best_epoch,
        n_nodes=g.n, n_recordings=len(obs.X), rank=rank, hyper=hyperparameters(model),
        history=history, validation=validation)
    return model, report


def freeze_whitening(model: GeoAudioField, X: np.ndarray) -> None:
    """Fix the whitening on every recording, so inference uses one transform."""
    with torch.no_grad():
        mu, white = model.whitening(model.encode(X))
        model.z_mean.copy_(mu)
        model.z_white.copy_(white)


def hyperparameters(model: GeoAudioField) -> dict:
    with torch.no_grad():
        return {
            "alpha": round(float(model.alpha), 4),
            "gamma": round(float(model.gamma), 4),
            "t": round(float(model.t), 4),
            "s2": [round(float(v), 4) for v in model.s2],
            "rho": [round(float(v), 4) for v in model.rho],
            # Share of each dimension's variance that is geographic: s²/(s²+s²ρ).
            "geographic_share": [round(float(1 / (1 + v)), 3) for v in model.rho],
        }


def evaluate(model: GeoAudioField, g: NodeGraph, obs: Observations, cond_nodes: np.ndarray,
             query_rec: np.ndarray, h: float, baselines: bool = False) -> dict:
    """Held-out geolocation over candidate nodes: CE, and error in km of the
    posterior mode and of the posterior-mean location."""
    Z = model.embed(obs.X)
    cand = np.arange(g.n)
    logp = geo_scores(model, g, Z, obs.node, cond_nodes, cand, query_rec)
    true = obs.node[query_rec]
    q = soft_labels(g, true, cand, h)
    ce = float(-(q * logp).sum(dim=1).mean())

    p = logp.exp().numpy()
    mode = cand[p.argmax(axis=1)]
    err_mode = g.geo_km[true, mode]
    # Expected distance under the posterior: penalises confident wrong answers
    # and rewards honest spread, unlike the mode.
    exp_km = (p * g.geo_km[true][:, cand]).sum(axis=1)
    out = {
        "ce": ce,
        "median_km": round(float(np.median(err_mode)), 1),
        "mean_km": round(float(np.mean(err_mode)), 1),
        "expected_km": round(float(np.mean(exp_km)), 1),
        "top1_node": round(float(np.mean(mode == true)), 3),
        "within_bandwidth": round(float(np.mean(err_mode <= h)), 3),
        "bandwidth_km": round(h, 1),
    }
    if baselines:
        # What you would get knowing nothing about the audio: a uniformly random
        # training node, and the single best fixed guess (the geographic medoid).
        D = g.geo_km[np.ix_(true, cond_nodes)]
        medoid = cond_nodes[np.argmin(g.geo_km[np.ix_(cond_nodes, cond_nodes)].sum(axis=1))]
        out["baseline_random_km"] = round(float(np.median(D.mean(axis=1))), 1)
        out["baseline_medoid_km"] = round(float(np.median(g.geo_km[true, medoid])), 1)
    return out


def _subgraph(g: NodeGraph, idx: np.ndarray) -> NodeGraph:
    return NodeGraph(ids=[g.ids[i] for i in idx], lon=g.lon[idx], lat=g.lat[idx],
                     log_pop=g.log_pop[idx], log_d=g.log_d[np.ix_(idx, idx)],
                     log_link=g.log_link[np.ix_(idx, idx)],
                     geo_km=g.geo_km[np.ix_(idx, idx)], geography=g.geography)
