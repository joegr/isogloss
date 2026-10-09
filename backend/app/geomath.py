"""Geodesy and barrier crossings, vectorised, with no database dependency.

Shared by the reference-field model (geo.py) and the audio field (field/),
so the two agree on what "effective distance" means.
"""

from __future__ import annotations

import numpy as np

EARTH_KM = 6371.0088


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
