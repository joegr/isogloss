"""Postgres/PostGIS access.

A single synchronous connection pool. The queries are short and the dataset is
small; the interesting work is in the SQL functions, not in the plumbing.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

DSN = os.environ.get(
    "ISOGLOSS_DSN",
    "postgresql://isogloss:isogloss@localhost:5432/isogloss",
)

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(DSN, min_size=1, max_size=8, open=True,
                               kwargs={"row_factory": dict_row})
        _pool.wait(timeout=30)
    return _pool


@contextmanager
def conn() -> Connection:
    with pool().connection() as c:
        yield c


def query(sql: str, params: tuple | dict | None = None) -> list[dict]:
    with conn() as c:
        return c.execute(sql, params).fetchall()


def one(sql: str, params: tuple | dict | None = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple | dict | None = None) -> None:
    with conn() as c:
        c.execute(sql, params)


def geojson(sql: str, params: tuple | dict | None = None) -> dict:
    """Run a query whose first column is a geometry and the rest are properties,
    and return a FeatureCollection. Keeps GeoJSON assembly in the database,
    where ST_AsGeoJSON already knows how to do it."""
    features = []
    for row in query(sql, params):
        items = list(row.items())
        geom = items[0][1]
        props = {k: v for k, v in items[1:]}
        if geom is None:
            continue
        features.append({
            "type": "Feature",
            "geometry": json.loads(geom) if isinstance(geom, str) else geom,
            "properties": props,
        })
    return {"type": "FeatureCollection", "features": features}


def healthy() -> bool:
    try:
        return bool(one("SELECT 1 AS ok"))
    except Exception:
        return False
