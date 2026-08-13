"""The spatial model: effective distance, the diffusion kernel, geolocation.

This file is the implementation of docs/DIFFUSION.md §3–§7. In particular §5:
the covariance used to interpolate the accent field is the propagator of the
diffusion that produced it — the regularised Laplacian kernel of the
gravity/barrier interaction graph, not a distance kernel over lat/lon.

The database owns the geometry (Voronoi cells, isoglosses, credible-region
polygons). This file owns the linear algebra.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import numpy as np

from . import db

EARTH_KM = 6371.0088
ALPHA = 0.5        # gravity: population exponent
GAMMA = 2.0        # gravity: distance exponent
SIGMA2 = 0.8       # regularised-Laplacian diffusion time
TAU2 = 0.05        # kernel-level nugget
DEFAULT_POP = 50_000.0
PRIOR_WEIGHT = 0.30
PRIOR_BANDWIDTH_KM = 90.0


# ---------------------------------------------------------------------------
# Geodesy and barriers, vectorised
# ---------------------------------------------------------------------------


def haversine_km(lon1, lat1, lon2, lat2) -> np.ndarray:
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def _orient(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def barrier_resistance(a_lon, a_lat, b_lon, b_lat,
                       segments: np.ndarray) -> np.ndarray:
    """Summed resistance of barriers crossed, for every (a, b) pair.

    `segments` is (m, 5): x1, y1, x2, y2, resistance. Pairs are broadcast
    against segments with the standard four-orientation test — the same
    predicate ST_Intersects uses, so the SQL and the Python agree.
    """
    a_lon = np.asarray(a_lon)[:, None]
    a_lat = np.asarray(a_lat)[:, None]
    b_lon = np.asarray(b_lon)[:, None]
    b_lat = np.asarray(b_lat)[:, None]
    if segments.size == 0:
        return np.zeros(a_lon.shape[0])

    x1, y1, x2, y2, res = (segments[:, i][None, :] for i in range(5))

    d1 = _orient(a_lon, a_lat, b_lon, b_lat, x1, y1)
    d2 = _orient(a_lon, a_lat, b_lon, b_lat, x2, y2)
    d3 = _orient(x1, y1, x2, y2, a_lon, a_lat)
    d4 = _orient(x1, y1, x2, y2, b_lon, b_lat)
    crosses = ((d1 > 0) != (d2 > 0)) & ((d3 > 0) != (d4 > 0))
    return (crosses * res).sum(axis=1)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


@dataclass
class Site:
    id: str
    label: str
    language: str
    country: str
    lon: float
    lat: float
    population: float
    confidence: float


@dataclass
class Feature:
    key: str
    label: str
    unit: str | None
    lo: float
    hi: float
    nugget: float
    is_variant: bool
    description: str

    def normalise(self, v: float) -> float:
        return float((v - self.lo) / (self.hi - self.lo))

    def denormalise(self, v: float) -> float:
        return float(self.lo + v * (self.hi - self.lo))


@dataclass
class SpatialModel:
    sites: list[Site]
    features: list[Feature]
    values: np.ndarray                     # (n_sites, n_features) normalised, NaN = absent
    barriers: np.ndarray                   # (m, 5)
    settlements: np.ndarray                # (p, 3) lon, lat, population
    areas: dict[str, tuple[float, float, float, float]] = field(default_factory=dict)
    _cache: dict = field(default_factory=dict, repr=False)

    # -- construction ------------------------------------------------------

    @classmethod
    def load(cls) -> "SpatialModel":
        rows = db.query("""
            SELECT s.id, s.label, s.language, s.country,
                   ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat,
                   COALESCE(st.population, %s) AS population, s.confidence
            FROM accent_site s
            LEFT JOIN settlement st ON st.id = s.settlement_id
            ORDER BY s.id
        """, (DEFAULT_POP,))
        sites = [Site(r["id"], r["label"], r["language"], r["country"],
                      r["lon"], r["lat"], float(r["population"]), r["confidence"])
                 for r in rows]

        frows = db.query("SELECT * FROM accent_feature ORDER BY key")
        features = [Feature(r["key"], r["label"], r["unit"], r["lo"], r["hi"],
                            r["nugget"], r["is_variant"], r["description"]) for r in frows]

        idx_s = {s.id: i for i, s in enumerate(sites)}
        idx_f = {f.key: j for j, f in enumerate(features)}
        values = np.full((len(sites), len(features)), np.nan)
        for r in db.query("SELECT site_id, key, value FROM site_feature"):
            i, j = idx_s.get(r["site_id"]), idx_f.get(r["key"])
            if i is not None and j is not None:
                values[i, j] = features[j].normalise(r["value"])

        barriers = _load_barrier_segments()

        srows = db.query("SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, population FROM settlement")
        settlements = np.array([[r["lon"], r["lat"], float(r["population"])] for r in srows]) \
            if srows else np.zeros((0, 3))

        arows = db.query("""
            SELECT id, ST_XMin(land) AS x0, ST_YMin(land) AS y0,
                   ST_XMax(land) AS x1, ST_YMax(land) AS y1
            FROM study_area
        """)
        areas = {r["id"]: (r["x0"], r["y0"], r["x1"], r["y1"]) for r in arows}

        return cls(sites=sites, features=features, values=values, barriers=barriers,
                   settlements=settlements, areas=areas)

    # -- effective distance ------------------------------------------------

    def effective_km(self, a_lon, a_lat, b_lon, b_lat) -> np.ndarray:
        d = haversine_km(a_lon, a_lat, b_lon, b_lat)
        r = barrier_resistance(a_lon, a_lat, b_lon, b_lat, self.barriers)
        return d * (1.0 + r)

    # -- the diffusion kernel ----------------------------------------------

    def kernel(self, language: str) -> dict:
        """K = (I + σ²L)⁻¹ over the sites of one language, plus the inverse of
        (K + τ²I) that prediction needs. Cached: it depends only on geography."""
        if language in self._cache:
            return self._cache[language]

        idx = [i for i, s in enumerate(self.sites) if s.language == language]
        if not idx:
            raise ValueError(f"no reference sites for language {language!r}")

        sub = [self.sites[i] for i in idx]
        lon = np.array([s.lon for s in sub])
        lat = np.array([s.lat for s in sub])
        pop = np.array([s.population for s in sub])

        n = len(sub)
        d = np.zeros((n, n))
        for i in range(n):
            d[i] = self.effective_km(np.full(n, lon[i]), np.full(n, lat[i]), lon, lat)
        d = np.maximum((d + d.T) / 2, 5.0)

        # Ancestry: sites whose settlements are joined by a migration link are
        # adjacent in the graph however far apart they are on the map.
        W = (pop[:, None] ** ALPHA) * (pop[None, :] ** ALPHA) / d**GAMMA
        for a, b, w in self._ancestry_pairs({s.id: k for k, s in enumerate(sub)}):
            W[a, b] *= w
            W[b, a] *= w
        np.fill_diagonal(W, 0.0)
        W = W / max(W.max(), 1e-12)

        L = np.diag(W.sum(axis=1)) - W
        K = np.linalg.inv(np.eye(n) + SIGMA2 * L)
        A = np.linalg.inv(K + TAU2 * np.eye(n))

        out = {"idx": np.array(idx), "sites": sub, "lon": lon, "lat": lat,
               "pop": pop, "W": W, "K": K, "A": A,
               "V": self.values[idx]}
        self._cache[language] = out
        return out

    def _ancestry_pairs(self, site_index: dict[str, int]) -> list[tuple[int, int, float]]:
        rows = db.query("""
            SELECT sa.id AS a, sb.id AS b, an.weight
            FROM ancestry an
            JOIN accent_site sa ON sa.settlement_id = an.parent_id
            JOIN accent_site sb ON sb.settlement_id = an.child_id
        """)
        out = []
        for r in rows:
            a, b = site_index.get(r["a"]), site_index.get(r["b"])
            if a is not None and b is not None and a != b:
                out.append((a, b, float(r["weight"])))
        return out

    def attach(self, lon: np.ndarray, lat: np.ndarray, ker: dict) -> np.ndarray:
        """Row-normalised gravity weights from query points onto the graph.

        Only the site's population enters — the query point's own settlement
        size is exactly what we do not know. Corridors do not appear here and do
        not need to: the query's covariance with distant sites is mediated by K,
        which was built with them.
        """
        n_q, n_s = len(lon), len(ker["lon"])
        w = np.zeros((n_q, n_s))
        for i in range(n_s):
            d = self.effective_km(lon, lat, np.full(n_q, ker["lon"][i]),
                                  np.full(n_q, ker["lat"][i]))
            w[:, i] = (ker["pop"][i] ** ALPHA) / np.maximum(d, 8.0) ** GAMMA
        return w / np.maximum(w.sum(axis=1, keepdims=True), 1e-12)

    def predict(self, lon: np.ndarray, lat: np.ndarray,
                ker: dict) -> tuple[np.ndarray, np.ndarray]:
        """GP posterior mean and variance of every feature at every query point."""
        w = self.attach(lon, lat, ker)
        kq = w @ ker["K"]                     # Nyström extension of the kernel

        V = np.nan_to_num(ker["V"], nan=0.0)
        present = np.isfinite(ker["V"]).astype(float)

        A = ker["A"]
        num = kq @ (A @ (V * present))
        den = kq @ (A @ present)
        # Where a feature is absent at most nearby sites, den collapses and the
        # mean is undefined; the variance below inflates correspondingly.
        mu = num / np.where(np.abs(den) < 1e-6, np.nan, den)

        var = np.maximum(1.0 - np.einsum("ij,jk,ik->i", kq, A, kq), 1e-4)
        return mu, var

    # -- geolocation -------------------------------------------------------

    def areas_for(self, language: str) -> list[str]:
        rows = db.query("""
            SELECT DISTINCT a.id
            FROM study_area a JOIN accent_site s ON ST_Intersects(a.land, ST_Expand(s.geom, 1.0))
            WHERE s.language = %s
        """, (language,))
        return [r["id"] for r in rows] or list(self.areas)

    def _grid(self, area_ids: list[str], target_cells: int = 5000):
        """A lon/lat grid over every relevant study area, at a shared step.

        Running one grid across several areas is what lets the posterior be
        multimodal across continents — a rhotic speaker with a fronted GOOSE is
        genuinely consistent with Ireland and with the American West, and the
        answer should say so rather than pick.
        """
        boxes = [self.areas[a] for a in area_ids if a in self.areas]
        if not boxes:
            boxes = list(self.areas.values())
        span = sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in boxes)
        step = max(math.sqrt(span / max(target_cells, 1)), 0.08)

        lons, lats = [], []
        for x0, y0, x1, y1 in boxes:
            gx = np.arange(x0, x1 + step, step)
            gy = np.arange(y0, y1 + step, step)
            mx, my = np.meshgrid(gx, gy)
            lons.append(mx.ravel())
            lats.append(my.ravel())
        return np.concatenate(lons), np.concatenate(lats), step

    def _population_prior(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        """log population density. Speakers come from where people are — the
        gravity model's third appearance, now as an occupancy prior."""
        if self.settlements.size == 0:
            return np.zeros(len(lon))
        acc = np.full(len(lon), 1e3)
        for slon, slat, pop in self.settlements:
            d = haversine_km(lon, lat, slon, slat)
            acc += pop * np.exp(-0.5 * (d / PRIOR_BANDWIDTH_KM) ** 2)
        return np.log(acc)

    def locate(self, language: str, measured: dict[str, tuple[float, float]],
               area_ids: list[str] | None = None) -> dict:
        """measured: key -> (value in native units, reliability 0..1)."""
        ker = self.kernel(language)
        areas = area_ids or self.areas_for(language)
        lon, lat, step = self._grid(areas)

        # Land mask: the posterior should not put mass in the North Atlantic.
        on_land = _land_mask(lon, lat, areas)
        lon, lat = lon[on_land], lat[on_land]
        if len(lon) == 0:
            raise ValueError("empty study grid")

        mu, var = self.predict(lon, lat, ker)

        fidx = {f.key: j for j, f in enumerate(self.features)}
        ll = np.zeros(len(lon))
        used = []
        for key, (value, rel) in measured.items():
            j = fidx.get(key)
            if j is None or rel <= 0.02 or not np.isfinite(value):
                continue
            f = self.features[j]
            v = np.clip(f.normalise(value), -0.5, 1.5)
            m = mu[:, j]
            ok = np.isfinite(m)
            if ok.sum() < len(m) * 0.5:
                continue
            s2 = var + f.nugget
            term = -0.5 * (v - np.nan_to_num(m, nan=v)) ** 2 / s2 - 0.5 * np.log(s2)
            ll += rel * np.where(ok, term, 0.0)
            used.append({"key": key, "value": value, "reliability": round(rel, 3),
                         "unit": f.unit, "label": f.label})

        if not used:
            raise ValueError("no feature was measured reliably enough to locate")

        ll += PRIOR_WEIGHT * self._population_prior(lon, lat)
        ll += np.log(np.maximum(np.cos(np.radians(lat)), 1e-6))   # cell area on a sphere

        p = np.exp(ll - ll.max())
        p /= p.sum()

        order = np.argsort(-p)
        cum = np.cumsum(p[order])
        regions = {}
        for level in (0.5, 0.8, 0.95):
            keep = order[: max(1, int(np.searchsorted(cum, level) + 1))]
            regions[level] = (lon[keep], lat[keep])

        best = int(order[0])
        mean_lon = float((p * lon).sum())
        mean_lat = float((p * lat).sum())

        return {
            "map": {"lon": float(lon[best]), "lat": float(lat[best])},
            "mean": {"lon": mean_lon, "lat": mean_lat},
            "regions": regions,
            "cell_deg": step,
            "grid": {"lon": lon, "lat": lat, "p": p},
            "features_used": used,
            "areas": areas,
            "entropy_km2": float(_dispersion_km(lon, lat, p, mean_lon, mean_lat)),
        }

    def nearest_varieties(self, language: str, measured: dict[str, tuple[float, float]],
                          k: int = 6) -> list[dict]:
        """Rank reference varieties by reliability-weighted feature distance."""
        ker = self.kernel(language)
        fidx = {f.key: j for j, f in enumerate(self.features)}
        V = ker["V"]

        num = np.zeros(len(ker["sites"]))
        den = np.zeros(len(ker["sites"]))
        for key, (value, rel) in measured.items():
            j = fidx.get(key)
            if j is None or rel <= 0.02 or not np.isfinite(value):
                continue
            col = V[:, j]
            ok = np.isfinite(col)
            v = self.features[j].normalise(value)
            num[ok] += rel * (col[ok] - v) ** 2
            den[ok] += rel
        dist = np.sqrt(num / np.maximum(den, 1e-9))
        dist[den <= 0] = np.inf

        order = np.argsort(dist)[:k]
        return [{
            "id": ker["sites"][i].id,
            "label": ker["sites"][i].label,
            "country": ker["sites"][i].country,
            "lon": float(ker["lon"][i]),
            "lat": float(ker["lat"][i]),
            "distance": float(dist[i]),
            "similarity": float(math.exp(-3.0 * dist[i])),
        } for i in order if np.isfinite(dist[i])]

    # -- dialectometry -----------------------------------------------------

    def cluster_regions(self, language: str, area_id: str, k: int = 6) -> dict[str, int]:
        """k-medoids in feature space, restricted to one study area.

        Goebl-style dialectometry: the groupings come out of the measurements,
        and iso_write_regions turns them into polygons by unioning Voronoi cells.
        """
        ker = self.kernel(language)
        rows = db.query("SELECT site_id FROM site_cell WHERE area_id = %s", (area_id,))
        allowed = {r["site_id"] for r in rows}
        pick = [i for i, s in enumerate(ker["sites"]) if s.id in allowed]
        if len(pick) <= k:
            return {ker["sites"][i].id: n for n, i in enumerate(pick)}

        V = ker["V"][pick]
        present = np.isfinite(V)
        Vz = np.nan_to_num(V)

        n = len(pick)
        D = np.zeros((n, n))
        for i in range(n):
            shared = present[i] & present
            diff = (Vz[i] - Vz) ** 2 * shared
            D[i] = np.sqrt(diff.sum(axis=1) / np.maximum(shared.sum(axis=1), 1))

        # k-medoids, seeded farthest-point so the result is deterministic.
        med = [int(np.argmax(D.sum(axis=1)))]
        while len(med) < k:
            med.append(int(np.argmax(D[med].min(axis=0))))
        for _ in range(40):
            lab = np.argmin(D[med], axis=0)
            new = []
            for j in range(k):
                members = np.nonzero(lab == j)[0]
                new.append(int(members[np.argmin(D[np.ix_(members, members)].sum(axis=1))])
                           if members.size else med[j])
            if new == med:
                break
            med = new
        lab = np.argmin(D[med], axis=0)
        return {ker["sites"][pick[i]].id: int(lab[i]) for i in range(n)}


# ---------------------------------------------------------------------------
# Helpers that lean on PostGIS
# ---------------------------------------------------------------------------


def _load_barrier_segments() -> np.ndarray:
    rows = db.query("SELECT resistance, ST_AsGeoJSON(geom) AS g FROM barrier")
    segs = []
    for r in rows:
        coords = json.loads(r["g"])["coordinates"]
        for (x1, y1), (x2, y2) in zip(coords[:-1], coords[1:]):
            segs.append([x1, y1, x2, y2, float(r["resistance"])])
    return np.array(segs) if segs else np.zeros((0, 5))


_LAND_CACHE: dict[str, object] = {}


def _land_mask(lon: np.ndarray, lat: np.ndarray, area_ids: list[str]) -> np.ndarray:
    """Which grid points are on land, decided by PostGIS in one round trip."""
    key = ",".join(sorted(area_ids))
    rows = db.query("""
        WITH land AS (
          SELECT ST_Union(land) AS g FROM study_area WHERE id = ANY(%s)
        )
        SELECT ST_Intersects(land.g, ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)) AS ok
        FROM land, unnest(%s::float8[], %s::float8[]) AS p(lon, lat)
    """, (area_ids, list(map(float, lon)), list(map(float, lat))))
    _LAND_CACHE[key] = True
    return np.array([bool(r["ok"]) for r in rows])


def _dispersion_km(lon, lat, p, mlon, mlat) -> float:
    """Posterior spread as an equivalent circle radius, in km. One number the
    UI can show that does not pretend the answer is a point."""
    d = haversine_km(lon, lat, mlon, mlat)
    return float(np.sqrt((p * d**2).sum()))


def region_geometry(lons: np.ndarray, lats: np.ndarray, cell_deg: float) -> str:
    """Cells → smoothed MULTIPOLYGON, built in PostGIS."""
    row = db.one("""
        SELECT ST_AsGeoJSON(iso_region_from_cells(%s::float8[], %s::float8[], %s)) AS g
    """, (list(map(float, lons)), list(map(float, lats)), float(cell_deg)))
    return row["g"] if row else None
