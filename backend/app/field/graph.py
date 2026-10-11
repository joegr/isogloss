"""The node graph's fixed geometry: everything about it that is not learned.

Effective distances (great-circle × barrier resistance), log populations and
ancestry links are computed once, in numpy, and handed to the torch model as
constants. The model learns how to *weight* them — the gravity exponents α
and γ and the diffusion time t — but the geography itself is data.

    log w_ij = α (log P_i + log P_j) − γ log d_eff(i,j) + log a_ij

docs/AUDIO_FIELD.md §3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from ..geomath import barrier_resistance, haversine_km

DEFAULT_POP = 50_000.0
MIN_KM = 5.0            # floor on node–node distance: co-located nodes are neighbours, not one point
ATTACH_MIN_KM = 8.0     # floor on query–node distance, as in geo.SpatialModel.attach
SETTLEMENT_RADIUS_KM = 30.0
PRIOR_BANDWIDTH_KM = 90.0


@dataclass
class Geography:
    """The substrate. Empty is valid: then the graph is pure distance decay."""
    barriers: np.ndarray = field(default_factory=lambda: np.zeros((0, 5)))      # x1 y1 x2 y2 resistance
    settlements: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))   # lon lat population
    links: list[tuple[str, str, float]] = field(default_factory=list)          # node a, node b, weight

    def effective_km(self, a_lon, a_lat, b_lon, b_lat) -> np.ndarray:
        d = haversine_km(a_lon, a_lat, b_lon, b_lat)
        return d * (1.0 + barrier_resistance(a_lon, a_lat, b_lon, b_lat, self.barriers))

    def population_at(self, lon: float, lat: float) -> float:
        """Population of the nearest settlement within 30 km, else a default.

        A node's population enters the gravity term the way a reference site's
        does: recordings from a city are better connected than recordings from a
        hamlet, which is what makes the graph hierarchical rather than a lattice.
        """
        if self.settlements.size == 0:
            return DEFAULT_POP
        d = haversine_km(lon, lat, self.settlements[:, 0], self.settlements[:, 1])
        i = int(np.argmin(d))
        return float(self.settlements[i, 2]) if d[i] <= SETTLEMENT_RADIUS_KM else DEFAULT_POP

    def log_prior(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        """log population density on the grid, or 0 when there are no settlements.

        Same occupancy prior as geo.SpatialModel: speakers come from where people
        are. Plus the cell-area term, because a 1° cell at 60°N is half the land
        of one at the equator."""
        area = np.log(np.maximum(np.cos(np.radians(lat)), 1e-6))
        if self.settlements.size == 0:
            return area
        acc = np.full(len(lon), 1e3)
        for slon, slat, pop in self.settlements:
            d = haversine_km(lon, lat, slon, slat)
            acc += pop * np.exp(-0.5 * (d / PRIOR_BANDWIDTH_KM) ** 2)
        return 0.30 * np.log(acc) + area


@dataclass
class NodeGraph:
    ids: list[str]
    lon: np.ndarray
    lat: np.ndarray
    log_pop: np.ndarray            # (n,)
    log_d: np.ndarray              # (n, n) log effective km, floored
    log_link: np.ndarray           # (n, n) log ancestry multiplier, 0 = none
    geo_km: np.ndarray             # (n, n) plain great-circle km, for scoring
    geography: Geography

    @classmethod
    def build(cls, ids: list[str], lon: np.ndarray, lat: np.ndarray,
              population: np.ndarray, geography: Geography) -> "NodeGraph":
        n = len(ids)
        d = np.zeros((n, n))
        g = np.zeros((n, n))
        for i in range(n):
            d[i] = geography.effective_km(np.full(n, lon[i]), np.full(n, lat[i]), lon, lat)
            g[i] = haversine_km(lon[i], lat[i], lon, lat)
        d = np.maximum((d + d.T) / 2, MIN_KM)

        link = np.zeros((n, n))
        index = {k: i for i, k in enumerate(ids)}
        for a, b, w in geography.links:
            i, j = index.get(a), index.get(b)
            if i is not None and j is not None and i != j and w > 0:
                link[i, j] = link[j, i] = math.log(w)

        return cls(ids=list(ids), lon=np.asarray(lon, float), lat=np.asarray(lat, float),
                   log_pop=np.log(np.maximum(np.asarray(population, float), 1.0)),
                   log_d=np.log(d), log_link=link, geo_km=g, geography=geography)

    @property
    def n(self) -> int:
        return len(self.ids)

    def query_log_d(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        """(G, n) log effective km from query points to every node."""
        out = np.zeros((len(lon), self.n))
        for j in range(self.n):
            out[:, j] = self.geography.effective_km(
                lon, lat, np.full(len(lon), self.lon[j]), np.full(len(lon), self.lat[j]))
        return np.log(np.maximum(out, ATTACH_MIN_KM))

    def grid(self, target_cells: int = 3000, pad_frac: float = 0.15,
             pad_min_deg: float = 1.0) -> tuple[np.ndarray, np.ndarray, float]:
        """A lon/lat lattice over the nodes' bounding box, padded.

        The field is only identified near data. Past the padding the posterior
        would be the prior, and printing the prior over an ocean is not a result.
        """
        x0, x1 = float(self.lon.min()), float(self.lon.max())
        y0, y1 = float(self.lat.min()), float(self.lat.max())
        px = max((x1 - x0) * pad_frac, pad_min_deg)
        py = max((y1 - y0) * pad_frac, pad_min_deg)
        x0, x1 = max(x0 - px, -180.0), min(x1 + px, 180.0)
        y0, y1 = max(y0 - py, -85.0), min(y1 + py, 85.0)
        step = max(math.sqrt((x1 - x0) * (y1 - y0) / max(target_cells, 1)), 0.05)
        gx = np.arange(x0, x1 + step / 2, step)
        gy = np.arange(y0, y1 + step / 2, step)
        mx, my = np.meshgrid(gx, gy)
        return mx.ravel(), my.ravel(), step
