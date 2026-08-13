-- Isogloss — build everything derived, and provide the one write path the
-- backend needs for clustering results.

-- Dialect regions are the only derived layer that cannot be computed in SQL
-- alone: the clustering happens in feature space, not map space. The backend
-- decides which sites group together; this turns that decision into geometry.
CREATE OR REPLACE FUNCTION iso_write_regions(p_area text, p_labels jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  DELETE FROM dialect_region WHERE area_id = p_area;

  INSERT INTO dialect_region (area_id, label, cluster, site_ids, geom)
  SELECT p_area,
         -- Name the region after its most populous member; dialectology names
         -- areas after cities for the same reason.
         (SELECT s2.label FROM accent_site s2
            LEFT JOIN settlement st ON st.id = s2.settlement_id
           WHERE s2.id = ANY(array_agg(a.site_id))
           ORDER BY COALESCE(st.population, 0) DESC LIMIT 1),
         a.cluster,
         array_agg(a.site_id),
         ST_Multi(ST_CollectionExtract(
           ST_ChaikinSmoothing(
             ST_SimplifyPreserveTopology(ST_Union(c.cell), 0.02), 2), 3))
  FROM (
    SELECT key AS site_id, (value #>> '{}')::int AS cluster
    FROM jsonb_each(p_labels)
  ) a
  JOIN site_cell c ON c.site_id = a.site_id AND c.area_id = p_area
  GROUP BY a.cluster;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

SELECT * FROM iso_refresh_all();
