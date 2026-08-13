-- Isogloss — schema.
--
-- Two spatial types are used deliberately and never interchangeably:
--   geography(...,4326)  for anything measured  (ST_Distance in metres, great circles)
--   geometry(...,4326)   for anything constructed (Voronoi, unions, boundaries, buffers)
-- Sites carry both; `geog` is the truth, `geom` is the cast kept for constructive ops.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- 1. Phonetic inventory (language-independent)
-- ---------------------------------------------------------------------------

-- A universal phone set. Acoustic targets are the templates the recogniser scores
-- frames against: formants for sonorants, spectral moments for obstruents.
CREATE TABLE phone (
  ipa            text PRIMARY KEY,
  arpa           text,                       -- ASCII handle, for the UI
  manner         text NOT NULL,              -- vowel|approximant|nasal|fricative|affricate|stop|silence
  place          text,                       -- bilabial|alveolar|velar|...
  voiced         boolean NOT NULL DEFAULT true,
  f1_hz          real, f2_hz real, f3_hz real,   -- sonorant targets (adult male reference)
  centroid_hz    real,                       -- obstruent spectral centre of gravity
  flatness       real,                       -- noise-likeness 0..1, on the scale
                                             -- produced by dsp.spectral_flatness
                                             -- (0 modal voice, ~.5 fricative, 1 noise)
  typical_ms     real NOT NULL DEFAULT 80,
  sonority       smallint NOT NULL DEFAULT 0 -- 0 stop … 7 open vowel
);

CREATE TABLE language (
  code             text PRIMARY KEY,          -- BCP-47-ish
  name             text NOT NULL,
  family           text,
  rhythm_class     text,                      -- stress|syllable|mora
  npvi_v_mean      real,                      -- expected vocalic nPVI
  npvi_v_sd        real DEFAULT 8,
  pct_v_mean       real,                      -- expected % vocalic
  pct_v_sd         real DEFAULT 4,
  delta_c_mean     real,                      -- expected consonantal interval SD (ms)
  delta_c_sd       real DEFAULT 12,
  vowel_inventory  smallint,                  -- monophthong count
  -- Syllable structure, compressed into two numbers. These carry most of the
  -- phonotactic signal that a full bigram table would: how strongly a consonant
  -- must be followed by a vowel (Japanese ~0.9, Polish ~0.35), and how tolerant
  -- the language is of clusters.
  cv_strictness    real NOT NULL DEFAULT 0.6,
  cluster_tol      real NOT NULL DEFAULT 0.5,
  speakers_m       real,                      -- millions, used as a weak prior
  notes            text
);

-- Which phones a language actually uses, and how often. Absence is informative:
-- a confident /θ/ almost rules out Spanish outside Castile.
CREATE TABLE language_phone (
  language  text REFERENCES language(code) ON DELETE CASCADE,
  ipa       text REFERENCES phone(ipa)      ON DELETE CASCADE,
  freq      real NOT NULL,                   -- unigram probability
  PRIMARY KEY (language, ipa)
);

-- Phonotactics. This is the LM half of PPRLM language identification:
-- recognise a phone string with one universal recogniser, then score it under
-- each language's bigram model.
CREATE TABLE language_bigram (
  language  text REFERENCES language(code) ON DELETE CASCADE,
  prev      text NOT NULL,                   -- ipa or '^' for utterance start
  next      text NOT NULL,                   -- ipa or '$' for utterance end
  logp      real NOT NULL,
  PRIMARY KEY (language, prev, next)
);

-- ---------------------------------------------------------------------------
-- 2. Geography — the substrate diffusion runs on
-- ---------------------------------------------------------------------------

-- Coarse land polygons. Used to clip Voronoi cells so dialect regions stop at
-- the coast instead of sprawling into the Atlantic.
CREATE TABLE study_area (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  land   geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX study_area_gix ON study_area USING GIST (land);

-- Things diffusion does not cross easily. `resistance` multiplies effective
-- distance; 1.0 roughly doubles it, 3.0 makes a range nearly opaque.
CREATE TABLE barrier (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL,                 -- mountain|water|political|forest
  resistance  real NOT NULL DEFAULT 1.0,
  geom        geometry(LineString, 4326) NOT NULL
);
CREATE INDEX barrier_gix ON barrier USING GIST (geom);

-- Things diffusion follows. Travel corridors make spread anisotropic without
-- needing a directional covariance tensor.
CREATE TABLE corridor (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL,                 -- river|road|rail|sea-route
  assist      real NOT NULL DEFAULT 0.5,     -- fractional distance discount when followed
  width_m     real NOT NULL DEFAULT 30000,
  geom        geometry(LineString, 4326) NOT NULL
);
CREATE INDEX corridor_gix ON corridor USING GIST (geom);

CREATE TABLE settlement (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  country     text NOT NULL,
  population  bigint NOT NULL,
  geog        geography(Point, 4326) NOT NULL,
  geom        geometry(Point, 4326) GENERATED ALWAYS AS (geog::geometry) STORED
);
CREATE INDEX settlement_gg ON settlement USING GIST (geog);
CREATE INDEX settlement_gx ON settlement USING GIST (geom);

-- The wormholes of §3: colonial / migration links that make two places
-- linguistically adjacent despite being geographically remote.
CREATE TABLE ancestry (
  parent_id  text REFERENCES settlement(id) ON DELETE CASCADE,
  child_id   text REFERENCES settlement(id) ON DELETE CASCADE,
  weight     real NOT NULL DEFAULT 4.0,      -- multiplies interaction weight
  note       text,
  PRIMARY KEY (parent_id, child_id)
);

-- ---------------------------------------------------------------------------
-- 3. The accent field
-- ---------------------------------------------------------------------------

-- The measurable dimensions. `lo`/`hi` define the scale the DSP reports on, so
-- reference values and measured values are commensurate by construction.
CREATE TABLE accent_feature (
  key          text PRIMARY KEY,
  label        text NOT NULL,
  unit         text,
  lo           real NOT NULL,
  hi           real NOT NULL,
  nugget       real NOT NULL DEFAULT 0.15,   -- τ²: idiolectal + measurement noise, in
                                             -- units of the normalised [0,1] scale
  is_variant   boolean NOT NULL DEFAULT false, -- true = binary-ish, eligible for isoglosses
  description  text
);

-- Reference varieties. The empirical anchors of the field μ.
CREATE TABLE accent_site (
  id            text PRIMARY KEY,
  label         text NOT NULL,
  language      text NOT NULL REFERENCES language(code),
  country       text NOT NULL,
  settlement_id text REFERENCES settlement(id),
  confidence    real NOT NULL DEFAULT 0.7,   -- how well attested this variety is
  geog          geography(Point, 4326) NOT NULL,
  geom          geometry(Point, 4326) GENERATED ALWAYS AS (geog::geometry) STORED,
  notes         text
);
CREATE INDEX accent_site_gg ON accent_site USING GIST (geog);
CREATE INDEX accent_site_gx ON accent_site USING GIST (geom);
CREATE INDEX accent_site_lang ON accent_site (language);

CREATE TABLE site_feature (
  site_id  text REFERENCES accent_site(id) ON DELETE CASCADE,
  key      text REFERENCES accent_feature(key) ON DELETE CASCADE,
  value    real NOT NULL,                    -- in the feature's native units
  PRIMARY KEY (site_id, key)
);

-- ---------------------------------------------------------------------------
-- 4. Derived geometry (populated by 06_derive.sql / refresh_derived())
-- ---------------------------------------------------------------------------

-- Thiessen tessellation: every site owns the territory closest to it, clipped
-- to land. This is the dialectologist's own construction, mechanised.
CREATE TABLE site_cell (
  site_id  text PRIMARY KEY REFERENCES accent_site(id) ON DELETE CASCADE,
  area_id  text REFERENCES study_area(id),
  cell     geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX site_cell_gix ON site_cell USING GIST (cell);

-- An isogloss is *derived*: the shared boundary between the union of cells
-- above a threshold and the union of cells below it.
CREATE TABLE isogloss (
  id         serial PRIMARY KEY,
  area_id    text REFERENCES study_area(id),
  key        text REFERENCES accent_feature(key),
  threshold  real NOT NULL,
  geom       geometry(MultiLineString, 4326) NOT NULL,
  length_km  real
);
CREATE INDEX isogloss_gix ON isogloss USING GIST (geom);

-- Bloomfield: a dialect boundary is where many isoglosses run together.
-- `weight` is how many isogloss buffers overlap this patch.
CREATE TABLE isogloss_bundle (
  id       serial PRIMARY KEY,
  area_id  text REFERENCES study_area(id),
  weight   int NOT NULL,
  geom     geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX isogloss_bundle_gix ON isogloss_bundle USING GIST (geom);

-- Emergent, not hand-drawn: clusters in feature space, unioned in map space.
CREATE TABLE dialect_region (
  id        serial PRIMARY KEY,
  area_id   text REFERENCES study_area(id),
  label     text NOT NULL,
  cluster   int NOT NULL,
  site_ids  text[] NOT NULL,
  geom      geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX dialect_region_gix ON dialect_region USING GIST (geom);

-- The interaction graph, materialised with drawable edges.
CREATE TABLE interaction_edge (
  a_id       text REFERENCES settlement(id) ON DELETE CASCADE,
  b_id       text REFERENCES settlement(id) ON DELETE CASCADE,
  d_geo_km   real NOT NULL,
  d_eff_km   real NOT NULL,   -- barrier- and corridor-adjusted
  barriers   real NOT NULL,   -- summed resistance crossed
  corridor_f real NOT NULL,   -- fraction of the segment inside a corridor buffer
  weight     real NOT NULL,   -- gravity × barriers × corridors × ancestry
  seg        geometry(LineString, 4326) NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX interaction_edge_gix ON interaction_edge USING GIST (seg);

-- ---------------------------------------------------------------------------
-- 5. Diffusion simulation
-- ---------------------------------------------------------------------------

CREATE TABLE diffusion_run (
  id       serial PRIMARY KEY,
  created  timestamptz NOT NULL DEFAULT now(),
  regime   text NOT NULL,      -- wave|contagion|hierarchical|contra-hierarchical
  key      text,               -- the feature being simulated, if any
  origin   text REFERENCES settlement(id),
  params   jsonb NOT NULL
);

CREATE TABLE diffusion_state (
  run_id     int REFERENCES diffusion_run(id) ON DELETE CASCADE,
  t          int NOT NULL,
  site_id    text REFERENCES settlement(id) ON DELETE CASCADE,
  adoption   real NOT NULL,
  PRIMARY KEY (run_id, t, site_id)
);

-- The wavefront at each timestep, as geometry. Animating these is how cascade
-- diffusion becomes visible: the line appears around cities, then joins up.
CREATE TABLE diffusion_front (
  run_id   int REFERENCES diffusion_run(id) ON DELETE CASCADE,
  t        int NOT NULL,
  adopted  geometry(MultiPolygon, 4326),
  front    geometry(MultiLineString, 4326),
  share    real NOT NULL,      -- population-weighted adoption
  PRIMARY KEY (run_id, t)
);

-- ---------------------------------------------------------------------------
-- 6. Inference log — every geolocation keeps its posterior as geometry
-- ---------------------------------------------------------------------------

CREATE TABLE inference (
  id           serial PRIMARY KEY,
  created      timestamptz NOT NULL DEFAULT now(),
  language     text REFERENCES language(code),
  lang_conf    real,
  features     jsonb NOT NULL,     -- {key: {value, reliability}}
  map_point    geometry(Point, 4326),
  mean_point   geometry(Point, 4326),
  region50     geometry(MultiPolygon, 4326),
  region80     geometry(MultiPolygon, 4326),
  region95     geometry(MultiPolygon, 4326),
  nearest      jsonb,               -- ranked reference varieties
  duration_s   real
);
CREATE INDEX inference_gix ON inference USING GIST (region95);
