"""The audio field as a service: ingest, train, locate, production surfaces.

Shared by the HTTP API (main.py, PostGIS store) and the CLI (__main__.py,
directory store), so both run the same code.

There are two speeds of learning here, and keeping them apart matters:

  * **Conditioning** is instant. Ingest a recording at a node and the GP
    conditions on it at the next query — the field changes, nothing is
    retrained. This is ordinary GP regression: new data updates the posterior.
  * **Training** fits the encoder and the hyperparameters (α, γ, t, s², ρ).
    It is the slow part, and it only needs re-running when the nodes have
    changed enough that the *shape* of the field, not just its values, should
    move.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np
import torch

from ..geomath import haversine_km
from ..phones import Phone
from . import phonology
from .featurize import FEATURE_VERSION, Featurized, feature_names, featurize
from .graph import Geography, NodeGraph
from .model import DTYPE, GeoAudioField, Observations
from .store import Node, NodeStore
from .train import TrainConfig, TrainReport, fit, freeze_whitening, hyperparameters

LEVELS = (0.5, 0.8, 0.95)


@dataclass
class _Fitted:
    """Everything prediction needs, derived from a model + the current store."""
    graph: NodeGraph
    obs: Observations
    nodes: list[Node]
    Kc: torch.Tensor
    A: torch.Tensor
    alpha: torch.Tensor
    zbar: torch.Tensor
    cnt: torch.Tensor
    glon: np.ndarray
    glat: np.ndarray
    step: float
    log_prior: np.ndarray
    attach: tuple[torch.Tensor, torch.Tensor, torch.Tensor]
    mu: torch.Tensor           # (G, r) field mean on the grid
    var: torch.Tensor          # (G, r) predictive variance on the grid


class FieldService:
    def __init__(self, store: NodeStore, inventory: Callable[[], Sequence[Phone]],
                 geography: Callable[[], Geography] = Geography,
                 land_mask: Callable[[np.ndarray, np.ndarray], np.ndarray] | None = None):
        self.store = store
        self._inventory = inventory
        self._geography = geography
        self._land_mask = land_mask
        self.model: GeoAudioField | None = None
        self.report: TrainReport | None = None
        self._fitted: _Fitted | None = None

    @property
    def inventory(self) -> Sequence[Phone]:
        return self._inventory()

    # -- ingest ------------------------------------------------------------------

    def ingest(self, wav: bytes, *, node_id: str | None = None, lon: float | None = None,
               lat: float | None = None, label: str | None = None, language: str | None = None,
               speaker: str | None = None, population: float | None = None) -> dict:
        """Save raw audio at a node (existing, or created at lon/lat) and featurise it."""
        feat = featurize(wav, self.inventory)        # raises AudioError before anything is written
        if node_id:
            node = self.store.get_node(node_id)
            if node is None:
                raise KeyError(f"no node {node_id!r}")
        else:
            if lon is None or lat is None:
                raise ValueError("give either node_id or lon and lat")
            node = self.store.add_node(label or f"{lat:.3f}, {lon:.3f}", float(lon), float(lat),
                                       language=language, population=population)
        rec = self.store.add_recording(node.id, wav, feat, speaker=speaker)
        self._fitted = None                          # recondition on next use
        return {"node": asdict(node), "recording": rec.public(),
                "phone_string": feat.phone_string, "notes": feat.notes}

    def refeaturize(self) -> int:
        """Rebuild every vector from stored audio. Returns how many changed."""
        n = 0
        for r in self.store.recordings():
            if r.feature_version == FEATURE_VERSION:
                continue
            wav = self.store.audio(r.id)
            if wav:
                self.store.update_features(r.id, featurize(wav, self.inventory))
                n += 1
        self._fitted = None
        return n

    # -- dataset -------------------------------------------------------------------

    def dataset(self) -> tuple[NodeGraph, Observations, list[Node]]:
        recs = [r for r in self.store.recordings() if r.feature_version == FEATURE_VERSION]
        used = {r.node_id for r in recs}
        nodes = [n for n in self.store.nodes() if n.id in used]
        if not nodes:
            raise ValueError("no recordings yet — ingest audio at some nodes first")
        geo = self._geography()
        index = {n.id: i for i, n in enumerate(nodes)}
        pop = np.array([n.population if n.population else geo.population_at(n.lon, n.lat)
                        for n in nodes])
        g = NodeGraph.build([n.id for n in nodes], np.array([n.lon for n in nodes]),
                            np.array([n.lat for n in nodes]), pop, geo)
        obs = Observations(X=np.stack([r.features for r in recs]),
                           node=np.array([index[r.node_id] for r in recs]),
                           rates=np.stack([r.phone_rates for r in recs]))
        return g, obs, nodes

    # -- training ------------------------------------------------------------------

    def train(self, cfg: TrainConfig = TrainConfig()) -> TrainReport:
        g, obs, _ = self.dataset()
        self.model, self.report = fit(g, obs, cfg)
        self._fitted = None
        return self.report

    def _require(self) -> _Fitted:
        if self.model is None:
            raise ValueError("no trained field — POST /api/field/train first")
        if self._fitted is None:
            self._fitted = self._condition()
        return self._fitted

    @torch.no_grad()
    def _condition(self) -> _Fitted:
        m = self.model
        g, obs, nodes = self.dataset()
        if obs.X.shape[1] != m.n_in:
            raise ValueError("stored features do not match the trained model; retrain")
        freeze_whitening(m, obs.X)
        Z = m.embed(obs.X)
        Kc, lmax = m.kernel(g)
        zbar, cnt, _ = m.node_stats(Z, obs.node, g.n)
        A, alpha = m.condition(Kc, zbar, cnt)

        glon, glat, step = g.grid()
        if self._land_mask is not None:
            keep = self._land_mask(glon, glat)
            if keep.any():
                glon, glat = glon[keep], glat[keep]
        log_dq = g.query_log_d(glon, glat)
        att = m.attach(g, log_dq, lmax)
        mu, var = m.predict_points(Kc, A, alpha, *att)
        return _Fitted(graph=g, obs=obs, nodes=nodes, Kc=Kc, A=A, alpha=alpha, zbar=zbar,
                       cnt=cnt, glon=glon, glat=glat, step=step,
                       log_prior=g.geography.log_prior(glon, glat), attach=att,
                       mu=mu, var=var)

    # -- locate ----------------------------------------------------------------------

    @torch.no_grad()
    def locate(self, wav: bytes | None = None, feat: Featurized | None = None) -> dict:
        """Posterior over the map for where this audio was produced (§8)."""
        f = self._require()
        feat = feat or featurize(wav, self.inventory)
        y = self.model.embed(feat.vector[None, :])                     # (1, r)

        ll = self.model.loglik(y, f.mu, f.var)[0].numpy() + f.log_prior
        p = np.exp(ll - ll.max())
        p /= p.sum()

        order = np.argsort(-p)
        cum = np.cumsum(p[order])
        level = np.ones(len(p))
        for lv in sorted(LEVELS, reverse=True):
            level[order[: int(np.searchsorted(cum, lv)) + 1]] = lv

        best = int(order[0])
        mlon, mlat = _spherical_mean(f.glon, f.glat, p)
        spread = float(np.sqrt((p * haversine_km(f.glon, f.glat, mlon, mlat) ** 2).sum()))

        # Which training nodes does it sound like? Same likelihood, evaluated
        # at the nodes themselves (where the field is best determined).
        mu_n, var_n = self.model.predict_nodes(f.Kc, f.A, f.alpha)
        lln = self.model.loglik(y, mu_n, var_n)[0]
        pn = torch.softmax(lln, dim=0).numpy()
        top = np.argsort(-pn)[:8]

        keep = level <= 0.95
        return {
            "map": {"lon": float(f.glon[best]), "lat": float(f.glat[best])},
            "mean": {"lon": mlon, "lat": mlat},
            "spread_km": round(spread, 1),
            "cell_deg": f.step,
            "cells": {"lon": _r(f.glon[keep]), "lat": _r(f.glat[keep]),
                      "p": [float(v) for v in p[keep]], "level": level[keep].tolist()},
            "regions": {lv: (f.glon[level <= lv], f.glat[level <= lv]) for lv in LEVELS},
            "nodes": [{"id": f.nodes[i].id, "label": f.nodes[i].label,
                       "lon": f.nodes[i].lon, "lat": f.nodes[i].lat,
                       "probability": round(float(pn[i]), 4)} for i in top],
            "embedding": [round(float(v), 4) for v in y[0]],
            "phone_string": feat.phone_string,
            "notes": feat.notes,
        }

    # -- sound production surfaces ------------------------------------------------------

    @torch.no_grad()
    def production(self, target: str) -> dict:
        """P(a frame of speech is [target] | place), as a surface (§9).

        Per node, the share of speech frames the recogniser assigned to the
        target phone or natural class; logit-transformed; then the same graph
        kernel the trained model uses, with its own signal and noise fitted by
        marginal likelihood on a ρ grid."""
        f = self._require()
        symbols = [p.ipa for p in self.inventory]
        idx, label = phonology.target_indices(symbols, target)

        share = f.obs.rates[:, idx].sum(axis=1)
        y_rec = np.log(np.clip(share, 1e-3, None) / np.clip(1 - share, 1e-3, None))
        node_y = np.zeros(f.graph.n)
        np.add.at(node_y, f.obs.node, y_rec)
        node_y /= f.cnt.numpy()
        node_share = np.zeros(f.graph.n)
        np.add.at(node_share, f.obs.node, share)
        node_share /= f.cnt.numpy()

        Kc = f.Kc
        Dinv = torch.diag(1.0 / f.cnt)
        w = f.cnt / f.cnt.sum()
        y = torch.as_tensor(node_y, dtype=DTYPE)
        best = None
        for rho in np.logspace(-2, 2, 17):
            C = Kc + rho * Dinv + 1e-6 * torch.eye(len(y), dtype=DTYPE)
            Lc = torch.linalg.cholesky(C)
            one = torch.ones(len(y), 1, dtype=DTYPE)
            Ci1 = torch.cholesky_solve(one, Lc)
            m0 = float((Ci1[:, 0] @ y) / Ci1.sum())                       # GLS mean
            r = (y - m0)[:, None]
            quad = float((r * torch.cholesky_solve(r, Lc)).sum())
            s2 = max(quad / len(y), 1e-6)
            ll = -0.5 * len(y) * math.log(s2) - float(torch.log(torch.diagonal(Lc)).sum())
            if best is None or ll > best[0]:
                best = (ll, rho, m0, s2, Lc)
        _, rho, m0, s2, Lc = best

        nb, wq, c = f.attach
        Ainv = torch.cholesky_inverse(Lc)
        alpha = Ainv @ (y - m0)
        kg = c[:, None] * torch.einsum("gk,gkn->gn", wq, Kc[nb])
        mu = m0 + kg @ alpha
        B = Kc @ Ainv @ Kc
        q = (c ** 2) * torch.einsum("gk,gkl,gl->g", wq, B[nb[:, :, None], nb[:, None, :]], wq)
        sd = torch.sqrt(s2 * (1.0 - q).clamp(min=1e-6))

        sig = lambda v: 1.0 / (1.0 + np.exp(-v))  # noqa: E731
        mu_n = mu.numpy()
        sd_n = sd.numpy()
        return {
            "target": target, "label": label,
            "phones": [symbols[i] for i in idx],
            "cell_deg": f.step,
            "cells": {"lon": _r(f.glon), "lat": _r(f.glat),
                      "p": [round(float(v), 5) for v in sig(mu_n)],
                      "lo": [round(float(v), 5) for v in sig(mu_n - 1.645 * sd_n)],
                      "hi": [round(float(v), 5) for v in sig(mu_n + 1.645 * sd_n)]},
            "nodes": [{"id": n.id, "label": n.label, "lon": n.lon, "lat": n.lat,
                       "share": round(float(node_share[i]), 5),
                       "recordings": int(f.cnt[i])} for i, n in enumerate(f.nodes)],
            "fit": {"rho": round(float(rho), 4), "s2": round(s2, 4),
                    "geographic_share": round(1.0 / (1.0 + float(rho)), 3),
                    "baseline": round(float(sig(m0)), 5)},
        }

    # -- status & persistence ------------------------------------------------------------

    def status(self) -> dict:
        nodes = self.store.nodes()
        recs = self.store.recordings()
        out = {"nodes": len(nodes), "recordings": len(recs),
               "stale_recordings": sum(r.feature_version != FEATURE_VERSION for r in recs),
               "feature_version": FEATURE_VERSION, "feature_dims": len(feature_names()),
               "trained": self.model is not None}
        if self.model is not None:
            out["hyper"] = hyperparameters(self.model)
        if self.report is not None:
            out["report"] = asdict(self.report)
        return out

    def save(self, path: str | Path) -> None:
        if self.model is None:
            raise ValueError("nothing to save; train first")
        torch.save({"config": {"n_in": self.model.n_in, "rank": self.model.rank,
                               "hidden": self.model.hidden},
                    "state": self.model.state_dict(),
                    "report": asdict(self.report) if self.report else None,
                    "feature_version": FEATURE_VERSION}, str(path))

    def load(self, path: str | Path) -> bool:
        p = Path(path)
        if not p.exists():
            return False
        blob = torch.load(str(p), weights_only=False)
        if blob.get("feature_version") != FEATURE_VERSION:
            return False
        m = GeoAudioField(**blob["config"])
        m.load_state_dict(blob["state"])
        self.model = m
        rep = blob.get("report")
        self.report = TrainReport(**rep) if rep else None
        self._fitted = None
        return True


def _r(a: np.ndarray, nd: int = 4) -> list[float]:
    return [round(float(v), nd) for v in a]


def _spherical_mean(lon: np.ndarray, lat: np.ndarray, p: np.ndarray) -> tuple[float, float]:
    """Mean position on the sphere, so a posterior straddling ±180° is not
    averaged into the wrong hemisphere."""
    la, lo = np.radians(lat), np.radians(lon)
    x = (p * np.cos(la) * np.cos(lo)).sum()
    y = (p * np.cos(la) * np.sin(lo)).sum()
    z = (p * np.sin(la)).sum()
    return (float(np.degrees(math.atan2(y, x))),
            float(np.degrees(math.atan2(z, math.hypot(x, y)))))
