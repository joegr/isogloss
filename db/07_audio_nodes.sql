-- Isogloss — the audio field: training nodes and the recordings they hold.
--
-- A node is a place; a recording is raw audio attached to it. The reference
-- field (accent_site) is hand-authored from the literature; this one is learned
-- from sound. Both live on the same geography — nodes pick up the population of
-- the nearest settlement, so the gravity model and the ancestry links apply to
-- them exactly as they do to reference sites.
--
-- The WAV is kept byte-for-byte. `features` is derived from it by
-- backend/app/field/featurize.py, tagged with `feature_version`, and can always
-- be rebuilt from `wav` when that recipe changes.

CREATE TABLE IF NOT EXISTS audio_node (
  id             text PRIMARY KEY,
  label          text NOT NULL,
  language       text REFERENCES language(code),
  population     bigint,                       -- NULL = take it from the settlement
  settlement_id  text REFERENCES settlement(id) ON DELETE SET NULL,
  created        timestamptz NOT NULL DEFAULT now(),
  geog           geography(Point, 4326) NOT NULL,
  geom           geometry(Point, 4326) GENERATED ALWAYS AS (geog::geometry) STORED
);
CREATE INDEX IF NOT EXISTS audio_node_gg ON audio_node USING GIST (geog);
CREATE INDEX IF NOT EXISTS audio_node_gx ON audio_node USING GIST (geom);

CREATE TABLE IF NOT EXISTS audio_recording (
  id               text PRIMARY KEY,
  node_id          text NOT NULL REFERENCES audio_node(id) ON DELETE CASCADE,
  speaker          text,
  duration_s       real NOT NULL,
  created          timestamptz NOT NULL DEFAULT now(),
  wav              bytea NOT NULL,
  features         float8[] NOT NULL,           -- NULL elements = not measurable
  phone_rates      float8[] NOT NULL,           -- share of speech frames per phone(ipa) in sonority order
  feature_version  text NOT NULL,
  phone_string     text
);
CREATE INDEX IF NOT EXISTS audio_recording_node ON audio_recording (node_id);
