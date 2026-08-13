"""Isogloss — HTTP surface.

Map layers are returned as GeoJSON assembled by PostGIS, because the geometry
*is* the model output: Voronoi cells, isoglosses, isogloss bundles, dialect
regions, diffusion wavefronts and posterior credible regions are all polygons
and lines that the database constructs.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import audio, catalog, config, db, diffusion, geo, pipeline

app = FastAPI(title="Isogloss", version=config.VERSION,
              description="Phoneme recognition, language ID, and accent geolocation "
                          "over a PostGIS accent field.")

STATIC = Path(__file__).parent / "static"

_model: geo.SpatialModel | None = None


def model() -> geo.SpatialModel:
    global _model
    if _model is None:
        _model = geo.SpatialModel.load()
    return _model


@app.exception_handler(audio.AudioError)
async def _audio_error(_: Request, exc: audio.AudioError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------------------------------------------------------------------------
# Health and catalogue
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    ok = db.healthy()
    return {"status": "ok" if ok else "degraded", "database": ok,
            "version": config.VERSION, "recognizer": config.RECOGNIZER}


@app.get("/api/meta")
def meta() -> dict:
    return {
        "features": [{
            "key": f.key, "label": f.label, "unit": f.unit, "lo": f.lo, "hi": f.hi,
            "nugget": f.nugget, "is_variant": f.is_variant, "description": f.description,
        } for f in model().features],
        "languages": [{
            "code": l.code, "name": l.name, "family": l.family,
            "rhythm": l.rhythm_class, "vowels": l.vowel_inventory,
            "sites": sum(1 for s in model().sites if s.language == l.code),
        } for l in catalog.languages()],
        "areas": db.query("""
            SELECT a.id, a.name,
                   ST_XMin(a.land) AS x0, ST_YMin(a.land) AS y0,
                   ST_XMax(a.land) AS x1, ST_YMax(a.land) AS y1,
                   (SELECT count(*) FROM site_cell c WHERE c.area_id = a.id) AS sites
            FROM study_area a ORDER BY a.name
        """),
        "phones": db.query("SELECT ipa, arpa, manner, place, voiced FROM phone ORDER BY ipa"),
        "settlements": db.query("""
            SELECT id, name, country, population FROM settlement ORDER BY population DESC
        """),
        "log_inferences": config.LOG_INFERENCES,
    }


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


@app.post("/api/analyse")
async def analyse(request: Request,
                  language: str | None = Query(None, description="Skip language ID")) -> dict:
    data = await request.body()
    if not data:
        raise HTTPException(400, "Empty request body; POST WAV bytes.")
    if len(data) > config.MAX_UPLOAD:
        raise HTTPException(413, f"Audio exceeds {config.MAX_UPLOAD} bytes.")
    try:
        return pipeline.analyse(data, model(), language_hint=language)
    except audio.AudioError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class LocateBody(BaseModel):
    """Geolocate a hand-specified accent vector, with no audio involved.

    This is the honest way to explore the model: you can ask "where does a
    rhotic, low-back-merged, monophthongal speaker come from?" and read the
    posterior directly, without the recogniser's error budget in the way.
    """
    language: str = "en"
    features: dict[str, float]
    reliability: dict[str, float] = Field(default_factory=dict)


@app.post("/api/locate")
def locate(body: LocateBody) -> dict:
    m = model()
    measured = {k: (v, body.reliability.get(k, 1.0)) for k, v in body.features.items()}
    try:
        loc = m.locate(body.language, measured)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    regions = {f"p{int(lv * 100)}": geo.region_geometry(lons, lats, loc["cell_deg"])
               for lv, (lons, lats) in loc["regions"].items()}
    return {
        "map": loc["map"], "mean": loc["mean"],
        "spread_km": round(loc["entropy_km2"], 1),
        "cell_deg": round(loc["cell_deg"], 4),
        "areas": loc["areas"], "regions": regions,
        "features_used": loc["features_used"],
        "nearest": m.nearest_varieties(body.language, measured),
    }


@app.get("/api/surface")
def surface(key: str, lon: float, lat: float, language: str | None = None) -> dict:
    """The plain-SQL interpolator, for comparison against the GP.

    Worth exposing: if the two disagree badly at a point, one of them is wrong,
    and it is usually a sign that the effective metric needs attention.
    """
    row = db.one("""
        SELECT iso_surface(%s, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography, %s) AS sql_value
    """, (key, lon, lat, language))
    m = model()
    ker = m.kernel(language or "en")
    import numpy as np
    mu, var = m.predict(np.array([lon]), np.array([lat]), ker)
    j = next((i for i, f in enumerate(m.features) if f.key == key), None)
    gp = None if j is None else m.features[j].denormalise(float(mu[0, j]))
    return {"key": key, "lon": lon, "lat": lat,
            "sql_idw": row["sql_value"] if row else None,
            "gp_mean": gp, "gp_sd": float(var[0] ** 0.5)}


# ---------------------------------------------------------------------------
# Map layers
# ---------------------------------------------------------------------------


@app.get("/api/map/land")
def land(area: str | None = None) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(land) AS geometry, id, name
        FROM study_area WHERE %s IS NULL OR id = %s
    """, (area, area))


@app.get("/api/map/sites")
def sites(language: str | None = None) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(s.geom) AS geometry, s.id, s.label, s.language,
               s.country, s.confidence, st.population
        FROM accent_site s LEFT JOIN settlement st ON st.id = s.settlement_id
        WHERE %s IS NULL OR s.language = %s
        ORDER BY s.id
    """, (language, language))


@app.get("/api/map/cells")
def cells(area: str) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(c.cell) AS geometry, c.site_id, s.label, s.language
        FROM site_cell c JOIN accent_site s ON s.id = c.site_id
        WHERE c.area_id = %s
    """, (area,))


@app.get("/api/map/regions")
def regions(area: str) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(geom) AS geometry, id, label, cluster,
               array_length(site_ids, 1) AS members
        FROM dialect_region WHERE area_id = %s ORDER BY cluster
    """, (area,))


@app.get("/api/map/isoglosses")
def isoglosses(area: str, key: str | None = None) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(i.geom) AS geometry, i.key, f.label, i.threshold,
               round(i.length_km::numeric, 1) AS length_km
        FROM isogloss i JOIN accent_feature f ON f.key = i.key
        WHERE i.area_id = %s AND (%s IS NULL OR i.key = %s)
        ORDER BY i.length_km DESC
    """, (area, key, key))


@app.get("/api/map/bundles")
def bundles(area: str) -> dict:
    """Isogloss bundle density — Bloomfield's definition of a dialect boundary,
    computed rather than asserted."""
    return db.geojson("""
        SELECT ST_AsGeoJSON(geom) AS geometry, weight
        FROM isogloss_bundle WHERE area_id = %s ORDER BY weight
    """, (area,))


@app.get("/api/map/barriers")
def barriers() -> dict:
    return db.geojson("SELECT ST_AsGeoJSON(geom) AS geometry, name, kind, resistance FROM barrier")


@app.get("/api/map/corridors")
def corridors() -> dict:
    return db.geojson("SELECT ST_AsGeoJSON(geom) AS geometry, name, kind, assist FROM corridor")


@app.get("/api/map/edges")
def edges(area: str | None = None, limit: int = Query(220, le=2000)) -> dict:
    """The interaction graph itself. Looking at it is the quickest way to see
    that this is not a distance model: the London–Sydney edge is there."""
    return db.geojson("""
        SELECT ST_AsGeoJSON(e.seg) AS geometry, e.a_id, e.b_id,
               round(e.d_geo_km::numeric, 0) AS d_geo_km,
               round(e.d_eff_km::numeric, 0) AS d_eff_km,
               round(e.barriers::numeric, 2) AS barriers,
               round(e.corridor_f::numeric, 2) AS corridor_f
        FROM interaction_edge e
        WHERE %s IS NULL OR EXISTS (
            SELECT 1 FROM study_area a
            WHERE a.id = %s AND ST_Intersects(ST_Expand(a.land, 0.6), e.seg))
        ORDER BY e.weight DESC
        LIMIT %s
    """, (area, area, limit))


# ---------------------------------------------------------------------------
# Dialectometry and diffusion
# ---------------------------------------------------------------------------


@app.post("/api/regions/rebuild")
def rebuild_regions(area: str = Query(...), language: str = "en",
                    k: int = Query(6, ge=2, le=12)) -> dict:
    labels = model().cluster_regions(language, area, k)
    if not labels:
        raise HTTPException(422, f"no cells for area {area!r}")
    import json
    row = db.one("SELECT iso_write_regions(%s, %s::jsonb) AS n", (area, json.dumps(labels)))
    return {"area": area, "clusters": k, "regions": row["n"] if row else 0,
            "assignments": labels}


@app.post("/api/derive/refresh")
def refresh() -> dict:
    """Rebuild every derived layer: edges, Voronoi cells, isoglosses, bundles."""
    rows = db.query("SELECT * FROM iso_refresh_all()")
    model()._cache.clear()
    return {"steps": rows}


@app.post("/api/diffusion/run")
def run_diffusion(params: diffusion.Params = Body(...)) -> dict:
    if params.regime not in diffusion.REGIMES:
        raise HTTPException(422, f"regime must be one of {sorted(diffusion.REGIMES)}")
    try:
        result = diffusion.simulate(params)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    result["signature"] = diffusion.correlations(result)
    return result


@app.get("/api/diffusion/{run_id}/fronts")
def fronts(run_id: int) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(COALESCE(adopted, ST_GeomFromText('MULTIPOLYGON EMPTY', 4326))) AS geometry,
               t, round(share::numeric, 4) AS share
        FROM diffusion_front WHERE run_id = %s ORDER BY t
    """, (run_id,))


@app.get("/api/diffusion/{run_id}/front-lines")
def front_lines(run_id: int) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(front) AS geometry, t, round(share::numeric, 4) AS share
        FROM diffusion_front WHERE run_id = %s AND front IS NOT NULL ORDER BY t
    """, (run_id,))


@app.get("/api/diffusion/regimes")
def regimes() -> dict:
    return {"regimes": diffusion.REGIMES,
            "defaults": diffusion.Params().__dict__}


# ---------------------------------------------------------------------------
# Static UI
# ---------------------------------------------------------------------------

if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")
