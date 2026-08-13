-- Isogloss — spatial functions.
--
-- Deliberately plain SQL. Every one of these is short enough to read in one
-- sitting, because the argument in docs/DIFFUSION.md is only convincing if the
-- code that implements it is inspectable.

-- ---------------------------------------------------------------------------
-- Effective distance: geography warped by what actually impedes contact
-- ---------------------------------------------------------------------------

-- Summed resistance of every barrier crossed by the straight line a→b.
CREATE OR REPLACE FUNCTION iso_barrier_resistance(a geography, b geography)
RETURNS real LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(bar.resistance), 0)::real
  FROM barrier bar
  WHERE ST_Intersects(bar.geom, ST_MakeLine(a::geometry, b::geometry));
$$;

-- Fraction of the segment a→b that runs inside some travel corridor's buffer.
-- Degrees are fine here: it is a ratio of two lengths in the same units.
CREATE OR REPLACE FUNCTION iso_corridor_fraction(a geography, b geography)
RETURNS real LANGUAGE sql STABLE AS $$
  WITH seg AS (SELECT ST_MakeLine(a::geometry, b::geometry) AS g)
  SELECT LEAST(1.0, COALESCE(
      SUM(ST_Length(ST_Intersection(seg.g, ST_Buffer(c.geom, c.width_m / 111320.0))))
        / NULLIF(ST_Length(seg.g), 0), 0))::real
  FROM seg LEFT JOIN corridor c
    ON ST_Intersects(seg.g, ST_Buffer(c.geom, c.width_m / 111320.0));
$$;

-- The metric the whole model runs on. Barriers stretch it, corridors compress it.
CREATE OR REPLACE FUNCTION iso_effective_km(a geography, b geography)
RETURNS real LANGUAGE sql STABLE AS $$
  SELECT (
      ST_Distance(a, b) / 1000.0
      * (1.0 + iso_barrier_resistance(a, b))
      * (1.0 - 0.45 * iso_corridor_fraction(a, b))
  )::real;
$$;

-- Trudgill's gravity term. alpha weights population, gamma the distance decay.
CREATE OR REPLACE FUNCTION iso_gravity(pop_a bigint, pop_b bigint, d_eff_km real,
                                       alpha real DEFAULT 0.5, gamma real DEFAULT 2.0)
RETURNS real LANGUAGE sql IMMUTABLE AS $$
  SELECT (power(pop_a::numeric, alpha) * power(pop_b::numeric, alpha)
          / power(GREATEST(d_eff_km, 5.0)::numeric, gamma))::real;
$$;

-- ---------------------------------------------------------------------------
-- Build the interaction graph
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION iso_build_edges(alpha real DEFAULT 0.5,
                                           gamma real DEFAULT 2.0,
                                           max_km real DEFAULT 2500)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  TRUNCATE interaction_edge;

  INSERT INTO interaction_edge (a_id, b_id, d_geo_km, d_eff_km, barriers, corridor_f, weight, seg)
  SELECT a.id, b.id,
         (ST_Distance(a.geog, b.geog) / 1000.0)::real,
         d.eff,
         iso_barrier_resistance(a.geog, b.geog),
         iso_corridor_fraction(a.geog, b.geog),
         iso_gravity(a.population, b.population, d.eff, alpha, gamma)
           * COALESCE(anc.weight, 1.0),
         ST_MakeLine(a.geom, b.geom)
  FROM settlement a
  JOIN settlement b ON a.id < b.id
  CROSS JOIN LATERAL (SELECT iso_effective_km(a.geog, b.geog) AS eff) d
  LEFT JOIN ancestry anc
         ON (anc.parent_id = a.id AND anc.child_id = b.id)
         OR (anc.parent_id = b.id AND anc.child_id = a.id)
  -- Keep long edges only when ancestry justifies them: that is the wormhole term.
  WHERE ST_Distance(a.geog, b.geog) / 1000.0 <= max_km OR anc.weight IS NOT NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Thiessen tessellation — the map's base tiling
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION iso_refresh_cells()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0;
BEGIN
  DELETE FROM site_cell;

  INSERT INTO site_cell (site_id, area_id, cell)
  SELECT s.id, a.id,
         ST_Multi(ST_CollectionExtract(ST_Intersection(v.cell, a.land), 3))
  FROM study_area a
  -- Voronoi over just this area's sites, extended past the coastline so edge
  -- cells are clipped by the land polygon rather than by the hull of the points.
  CROSS JOIN LATERAL (
      SELECT (ST_Dump(ST_VoronoiPolygons(
                ST_Collect(p.geom),
                0.0,
                ST_Expand(ST_Envelope(a.land), 3.0)
             ))).geom AS cell
      FROM accent_site p
      WHERE ST_Intersects(p.geom, ST_Expand(ST_Envelope(a.land), 0.5))
  ) v
  JOIN accent_site s
    ON ST_Intersects(v.cell, s.geom)
   AND ST_Intersects(s.geom, ST_Expand(ST_Envelope(a.land), 0.5))
  WHERE NOT ST_IsEmpty(ST_Intersection(v.cell, a.land))
  ON CONFLICT (site_id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Isoglosses — derived, never drawn
-- ---------------------------------------------------------------------------

-- The shared boundary between "has the variant" territory and "hasn't".
CREATE OR REPLACE FUNCTION iso_isogloss(p_area text, p_key text, p_threshold real)
RETURNS geometry LANGUAGE sql STABLE AS $$
  WITH side AS (
    SELECT c.cell, f.value >= p_threshold AS yes
    FROM site_cell c
    JOIN site_feature f ON f.site_id = c.site_id AND f.key = p_key
    WHERE c.area_id = p_area
  ),
  parts AS (
    SELECT ST_Union(cell) FILTER (WHERE yes)     AS a,
           ST_Union(cell) FILTER (WHERE NOT yes) AS b
    FROM side
  )
  SELECT ST_Multi(ST_CollectionExtract(
           ST_Intersection(ST_Boundary(a), ST_Boundary(b)), 2))
  FROM parts
  WHERE a IS NOT NULL AND b IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION iso_refresh_isoglosses()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  DELETE FROM isogloss;

  INSERT INTO isogloss (area_id, key, threshold, geom, length_km)
  SELECT a.id, f.key, mid.t, g.geom,
         (ST_Length(g.geom::geography) / 1000.0)::real
  FROM study_area a
  CROSS JOIN accent_feature f
  -- Cut each feature at its own midpoint rather than a global 0.5.
  CROSS JOIN LATERAL (SELECT ((f.lo + f.hi) / 2.0)::real AS t) mid
  CROSS JOIN LATERAL (SELECT iso_isogloss(a.id, f.key, mid.t) AS geom) g
  WHERE g.geom IS NOT NULL AND NOT ST_IsEmpty(g.geom);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Bloomfield's bundles: buffer every isogloss, and count how many overlap each
-- patch of ground. The ridges of this scalar field are the dialect boundaries.
CREATE OR REPLACE FUNCTION iso_refresh_bundles(buffer_km real DEFAULT 35)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  DELETE FROM isogloss_bundle;

  INSERT INTO isogloss_bundle (area_id, weight, geom)
  SELECT area_id, cnt, ST_Multi(ST_UnaryUnion(ST_Collect(g)))
  FROM (
    SELECT p.area_id, p.geom AS g,
           (SELECT count(*) FROM isogloss i
             WHERE i.area_id = p.area_id
               AND ST_Intersects(ST_Buffer(i.geom::geography, buffer_km * 1000)::geometry,
                                 ST_PointOnSurface(p.geom))) AS cnt
    FROM (
      SELECT area_id, (ST_Dump(ST_Buffer(geom::geography, buffer_km * 1000)::geometry)).geom AS geom
      FROM isogloss
    ) p
  ) q
  WHERE cnt >= 2
  GROUP BY area_id, cnt;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- The readable interpolator
-- ---------------------------------------------------------------------------
-- The production surface is a graph-Laplacian GP in the backend (see app/geo.py).
-- This is its plain-SQL sibling: same idea, same effective metric, one query.
-- Useful for sanity-checking the Python and for ad-hoc map layers.

CREATE OR REPLACE FUNCTION iso_surface(p_key text, p_at geography,
                                       p_language text DEFAULT NULL,
                                       lambda_km real DEFAULT 180,
                                       p_power real DEFAULT 2.0)
RETURNS real LANGUAGE sql STABLE AS $$
  WITH near AS (
    SELECT s.id, f.value, iso_effective_km(p_at, s.geog) AS d
    FROM accent_site s
    JOIN site_feature f ON f.site_id = s.id AND f.key = p_key
    WHERE p_language IS NULL OR s.language = p_language
    -- index-accelerated candidate set first, exact re-rank after: the standard
    -- KNN pattern, and necessary because iso_effective_km is not indexable.
    ORDER BY s.geom <-> p_at::geometry
    LIMIT 24
  )
  SELECT (SUM(value * w) / NULLIF(SUM(w), 0))::real
  FROM (SELECT value, exp(-power((d / lambda_km)::numeric, p_power::numeric)) AS w FROM near) x;
$$;

-- ---------------------------------------------------------------------------
-- Turning a probability grid into credible-region polygons
-- ---------------------------------------------------------------------------
-- The backend computes the posterior on a grid and hands back the cells it wants
-- kept; the database is what turns those cells into smooth geometry. Cell
-- squares → union → simplify → Chaikin. Multimodal posteriors survive as
-- multiple rings, which is the whole reason the output type is a polygon.

CREATE OR REPLACE FUNCTION iso_region_from_cells(lons double precision[],
                                                 lats double precision[],
                                                 cell_deg double precision)
RETURNS geometry LANGUAGE sql IMMUTABLE AS $$
  SELECT ST_Multi(ST_CollectionExtract(
           ST_ChaikinSmoothing(
             ST_SimplifyPreserveTopology(
               ST_Union(ST_MakeEnvelope(lon - cell_deg / 2, lat - cell_deg / 2,
                                        lon + cell_deg / 2, lat + cell_deg / 2, 4326)),
               cell_deg / 3),
             2), 3))
  FROM unnest(lons, lats) AS g(lon, lat);
$$;

-- ---------------------------------------------------------------------------
-- Diffusion wavefronts
-- ---------------------------------------------------------------------------
-- The simulator (app/diffusion.py) writes per-settlement adoption; this turns
-- each timestep into geometry using the same Voronoi-boundary construction as
-- an isogloss. Animating the result is how cascade diffusion becomes visible:
-- the line does not sweep outward, it appears around cities and then joins up.

CREATE OR REPLACE FUNCTION iso_write_fronts(p_run int, p_area text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  DELETE FROM diffusion_front WHERE run_id = p_run;

  INSERT INTO diffusion_front (run_id, t, adopted, front, share)
  WITH area AS (SELECT land FROM study_area WHERE id = p_area),
  cells AS (
    SELECT s.id, s.population,
           ST_Intersection(v.cell, a.land) AS cell
    FROM area a
    CROSS JOIN LATERAL (
      SELECT (ST_Dump(ST_VoronoiPolygons(
                ST_Collect(p.geom), 0.0, ST_Expand(ST_Envelope(a.land), 3.0)))).geom AS cell
      FROM settlement p
      WHERE ST_Intersects(p.geom, ST_Expand(ST_Envelope(a.land), 0.5))
    ) v
    JOIN settlement s
      ON ST_Intersects(v.cell, s.geom)
     AND ST_Intersects(s.geom, ST_Expand(ST_Envelope(a.land), 0.5))
    WHERE NOT ST_IsEmpty(ST_Intersection(v.cell, a.land))
  ),
  grouped AS (
    SELECT d.t,
           ST_Union(c.cell) FILTER (WHERE d.adoption >= 0.5) AS yes,
           ST_Union(c.cell) FILTER (WHERE d.adoption <  0.5) AS no,
           SUM(d.adoption * c.population) / NULLIF(SUM(c.population), 0) AS share
    FROM diffusion_state d
    JOIN cells c ON c.id = d.site_id
    WHERE d.run_id = p_run
    GROUP BY d.t
  )
  SELECT p_run, t,
         CASE WHEN yes IS NULL THEN NULL
              ELSE ST_Multi(ST_CollectionExtract(ST_ChaikinSmoothing(yes, 1), 3)) END,
         CASE WHEN yes IS NULL OR no IS NULL THEN NULL
              ELSE ST_Multi(ST_CollectionExtract(
                     ST_Intersection(ST_Boundary(yes), ST_Boundary(no)), 2)) END,
         COALESCE(share, 0)::real
  FROM grouped;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Convenience: rebuild everything derived
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION iso_refresh_all()
RETURNS TABLE (step text, rows int) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT 'edges'::text,      iso_build_edges();
  RETURN QUERY SELECT 'cells'::text,      iso_refresh_cells();
  RETURN QUERY SELECT 'isoglosses'::text, iso_refresh_isoglosses();
  RETURN QUERY SELECT 'bundles'::text,    iso_refresh_bundles();
END;
$$;
