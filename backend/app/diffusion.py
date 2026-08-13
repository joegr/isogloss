"""Forward simulation of a sound change spreading over the interaction graph.

Implements docs/DIFFUSION.md §4. One simulator; the four classical regimes are
parameter settings of it, which is the main argument that the parameterisation
is the right one:

    wave                α = 0            distance decay only, concentric rings
    contagion           α = 0, γ = 3.5   effectively contiguous spread
    hierarchical        α = 0.5, prestige ∝ log P     cascade down the ladder
    contra-hierarchical prestige negated              covert prestige, rural first

Adoption runs in the logit domain (Kroch's constant rate effect), and local
resistance can *grow* with outside contact, which is what lets the model produce
divergence — Martha's Vineyard, Ocracoke — rather than only convergence.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, asdict

import numpy as np

from . import db
from .geo import ALPHA, GAMMA

REGIMES = {
    "wave":                {"alpha": 0.0, "gamma": 2.0, "prestige": 0.0},
    "contagion":           {"alpha": 0.0, "gamma": 3.5, "prestige": 0.0},
    "hierarchical":        {"alpha": ALPHA, "gamma": GAMMA, "prestige": 0.6},
    "contra-hierarchical": {"alpha": ALPHA, "gamma": GAMMA, "prestige": -0.6},
}


@dataclass
class Params:
    regime: str = "hierarchical"
    origin: str = "london"
    steps: int = 24
    rate: float = 0.55          # s, the constant rate of the logit advance
    contact: float = 3.2        # λ, how strongly exposure drives adoption
    resistance: float = 0.9     # θ₀, baseline conservatism
    identity: float = 0.0       # ι, how much contact provokes counter-diffusion
    area: str = "gb-ie"
    key: str | None = None


def _graph(area: str, p: Params) -> tuple[list[dict], np.ndarray]:
    """Settlements in the study area and their interaction matrix.

    Rebuilt from `interaction_edge`, which already holds the barrier- and
    corridor-adjusted distance; only the gravity exponents change per regime.
    """
    rows = db.query("""
        SELECT s.id, s.name, s.population, ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat
        FROM settlement s
        JOIN study_area a ON a.id = %s
        WHERE ST_Intersects(ST_Expand(a.land, 0.6), s.geom)
        ORDER BY s.population DESC
    """, (area,))
    if not rows:
        raise ValueError(f"no settlements in study area {area!r}")

    idx = {r["id"]: i for i, r in enumerate(rows)}
    n = len(rows)
    pop = np.array([float(r["population"]) for r in rows])

    cfg = REGIMES[p.regime]
    W = np.zeros((n, n))
    for e in db.query("SELECT a_id, b_id, d_eff_km FROM interaction_edge"):
        i, j = idx.get(e["a_id"]), idx.get(e["b_id"])
        if i is None or j is None:
            continue
        d = max(float(e["d_eff_km"]), 5.0)
        w = (pop[i] ** cfg["alpha"]) * (pop[j] ** cfg["alpha"]) / d ** cfg["gamma"]
        W[i, j] = W[j, i] = w

    row = W.sum(axis=1, keepdims=True)
    return rows, W / np.maximum(row, 1e-12)


def simulate(p: Params) -> dict:
    rows, W = _graph(p.area, p)
    n = len(rows)
    idx = {r["id"]: i for i, r in enumerate(rows)}
    if p.origin not in idx:
        raise ValueError(f"origin {p.origin!r} is not in study area {p.area!r}")

    pop = np.array([float(r["population"]) for r in rows])
    logp = np.log(pop)
    prestige = REGIMES[p.regime]["prestige"] * (logp - logp.mean()) / max(logp.std(), 1e-6)

    x = np.full(n, 1e-4)
    x[idx[p.origin]] = 0.97
    z = np.log(x / (1 - x))
    theta = np.full(n, p.resistance)

    history = [x.copy()]
    for _ in range(p.steps):
        exposure = W @ x
        z = z + p.rate * (p.contact * exposure + prestige - theta)
        x = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
        if p.identity > 0:
            # Contact provokes local reassertion: the more the neighbourhood
            # diverges from you, the harder you dig in. ι = 0 is the special case.
            theta = theta + p.identity * np.maximum(exposure - x, 0.0)
        history.append(x.copy())

    run = db.one("""
        INSERT INTO diffusion_run (regime, key, origin, params)
        VALUES (%s, %s, %s, %s) RETURNING id
    """, (p.regime, p.key, p.origin, json.dumps(asdict(p))))
    run_id = run["id"]

    with db.conn() as c:
        with c.cursor() as cur:
            cur.executemany(
                "INSERT INTO diffusion_state (run_id, t, site_id, adoption) VALUES (%s,%s,%s,%s)",
                [(run_id, t, rows[i]["id"], float(state[i]))
                 for t, state in enumerate(history) for i in range(n)])
        c.execute("SELECT iso_write_fronts(%s, %s)", (run_id, p.area))

    share = [float((s * pop).sum() / pop.sum()) for s in history]
    return {
        "run_id": run_id,
        "regime": p.regime,
        "origin": p.origin,
        "area": p.area,
        "steps": p.steps,
        "share": share,
        # Adoption order is the diagnostic: under a wave it tracks distance from
        # the origin, under cascade it tracks population.
        "order": _adoption_order(rows, history),
    }


def _adoption_order(rows: list[dict], history: list[np.ndarray]) -> list[dict]:
    out = []
    for i, r in enumerate(rows):
        series = np.array([h[i] for h in history])
        crossed = np.nonzero(series >= 0.5)[0]
        out.append({
            "id": r["id"], "name": r["name"], "population": int(r["population"]),
            "t_adopted": int(crossed[0]) if crossed.size else None,
        })
    out.sort(key=lambda d: (d["t_adopted"] is None, d["t_adopted"] or 0, -d["population"]))
    return out


def correlations(result: dict) -> dict:
    """Does adoption time track distance, or population?

    This is the numeric signature that separates a wave from a cascade, and it
    is worth reporting because the map alone can be read either way.
    """
    rows = [r for r in result["order"] if r["t_adopted"] is not None]
    if len(rows) < 5:
        return {"n": len(rows)}
    t = np.array([r["t_adopted"] for r in rows], dtype=float)
    pop = np.log(np.array([r["population"] for r in rows], dtype=float))
    d = db.query("""
        SELECT b.id, ST_Distance(a.geog, b.geog) / 1000.0 AS km
        FROM settlement a, settlement b WHERE a.id = %s
    """, (result["origin"],))
    km = {r["id"]: float(r["km"]) for r in d}
    dist = np.array([km.get(r["id"], np.nan) for r in rows])
    ok = np.isfinite(dist)

    def corr(a, b):
        if len(a) < 3 or a.std() < 1e-9 or b.std() < 1e-9:
            return None
        return float(np.corrcoef(a, b)[0, 1])

    return {
        "n": len(rows),
        "t_vs_log_population": corr(t, pop),
        "t_vs_distance_km": corr(t[ok], dist[ok]),
    }
