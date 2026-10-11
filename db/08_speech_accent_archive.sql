-- Isogloss — the Speech Accent Archive speaker table (Weinberger, GMU,
-- accent.gmu.edu): every speaker reads the same "Please call Stella" paragraph,
-- and records a birthplace.
--
-- The canonical copy is db/data/saa_speakers.csv, produced from the archive's
-- spreadsheet by backend/app/datasets/saa.py (normalisation: db/data/README.md).
-- This file is idempotent: re-running it upserts the CSV, so `make migrate`
-- refreshes an existing database and a fresh volume loads it on first boot.
--
-- Birthplaces are text until geocoded. Coordinates live in their own table,
-- keyed by the place rather than the speaker, so one geocode serves every
-- speaker born in Dallas — and a wrong one is fixed in one row.

CREATE TABLE IF NOT EXISTS saa_speaker (
  speakerid                    int PRIMARY KEY,
  speaker                      int NOT NULL,      -- index within native_language (english656)
  native_language              text NOT NULL,
  alternative_native_language  text,
  city                         text,              -- birthplace
  state_or_province            text,
  country                      text,
  age                          real,
  gender                       text,
  onset_age                    real,              -- age English learning began; 0 = native
  english_residence            text,              -- English-speaking countries lived in
  length_of_residence          real,              -- years
  learning_style               text,              -- academic | naturalistic
  speech_sample                text NOT NULL UNIQUE,  -- <language><n>.mp3
  phonetic_transcription       text,              -- .gif; notyet.gif = not transcribed
  map                          text,
  ethnologue_language_code     text,
  notes                        text
);
CREATE INDEX IF NOT EXISTS saa_speaker_lang ON saa_speaker (native_language);

-- One row per distinct birthplace. `query` is the 'city, state, country' string
-- a geocoder was given; `source` says which gazetteer answered and `match` how
-- (city+state, city, city~ close spelling, state centroid, country centroid —
-- backend/app/datasets/geocode.py), so coarse fixes can be told apart from good
-- ones and down-weighted. Coordinates come from db/data/saa_birthplaces.csv.
CREATE TABLE IF NOT EXISTS saa_birthplace (
  city               text NOT NULL DEFAULT '',
  state_or_province  text NOT NULL DEFAULT '',
  country            text NOT NULL DEFAULT '',
  query              text NOT NULL,
  geog               geography(Point, 4326),
  source             text,
  match              text,
  matched_name       text,
  matched_admin1     text,
  country_code       text,
  PRIMARY KEY (city, state_or_province, country)
);
ALTER TABLE saa_birthplace ADD COLUMN IF NOT EXISTS matched_name text;
ALTER TABLE saa_birthplace ADD COLUMN IF NOT EXISTS matched_admin1 text;
ALTER TABLE saa_birthplace ADD COLUMN IF NOT EXISTS country_code text;
CREATE INDEX IF NOT EXISTS saa_birthplace_gg ON saa_birthplace USING GIST (geog);

-- -- load ---------------------------------------------------------------------

BEGIN;
CREATE TEMP TABLE saa_load ON COMMIT DROP AS
  SELECT speakerid, speaker, native_language, alternative_native_language, city, state_or_province, country, age, gender, onset_age, english_residence, length_of_residence, learning_style, speech_sample, phonetic_transcription, map, ethnologue_language_code, notes FROM saa_speaker WITH NO DATA;
COPY saa_load FROM '/docker-entrypoint-initdb.d/data/saa_speakers.csv'
  WITH (FORMAT csv, HEADER true, NULL '');

INSERT INTO saa_speaker (speakerid, speaker, native_language, alternative_native_language, city, state_or_province, country, age, gender, onset_age, english_residence, length_of_residence, learning_style, speech_sample, phonetic_transcription, map, ethnologue_language_code, notes)
SELECT * FROM saa_load
ON CONFLICT (speakerid) DO UPDATE SET
  speaker = EXCLUDED.speaker, native_language = EXCLUDED.native_language,
  alternative_native_language = EXCLUDED.alternative_native_language,
  city = EXCLUDED.city, state_or_province = EXCLUDED.state_or_province,
  country = EXCLUDED.country, age = EXCLUDED.age, gender = EXCLUDED.gender,
  onset_age = EXCLUDED.onset_age, english_residence = EXCLUDED.english_residence,
  length_of_residence = EXCLUDED.length_of_residence,
  learning_style = EXCLUDED.learning_style, speech_sample = EXCLUDED.speech_sample,
  phonetic_transcription = EXCLUDED.phonetic_transcription, map = EXCLUDED.map,
  ethnologue_language_code = EXCLUDED.ethnologue_language_code, notes = EXCLUDED.notes;

CREATE TEMP TABLE saa_geo_load (
  city text, state_or_province text, country text, query text,
  lon float8, lat float8, source text, match text,
  matched_name text, matched_admin1 text, country_code text
) ON COMMIT DROP;
COPY saa_geo_load FROM '/docker-entrypoint-initdb.d/data/saa_birthplaces.csv'
  WITH (FORMAT csv, HEADER true, NULL '');

INSERT INTO saa_birthplace (city, state_or_province, country, query, geog, source, match,
                            matched_name, matched_admin1, country_code)
SELECT COALESCE(city, ''), COALESCE(state_or_province, ''), COALESCE(country, ''), query,
       CASE WHEN lon IS NOT NULL THEN ST_MakePoint(lon, lat)::geography END,
       source, match, matched_name, matched_admin1, country_code
FROM saa_geo_load
ON CONFLICT (city, state_or_province, country) DO UPDATE SET
  query = EXCLUDED.query, geog = EXCLUDED.geog, source = EXCLUDED.source,
  match = EXCLUDED.match, matched_name = EXCLUDED.matched_name,
  matched_admin1 = EXCLUDED.matched_admin1, country_code = EXCLUDED.country_code;

-- Any birthplace the geocode file has not seen still gets a row, so "what is
-- still missing" is a query rather than a guess.
INSERT INTO saa_birthplace (city, state_or_province, country, query)
SELECT DISTINCT COALESCE(city, ''), COALESCE(state_or_province, ''), COALESCE(country, ''),
       concat_ws(', ', city, state_or_province, country)
FROM saa_speaker
WHERE city IS NOT NULL OR country IS NOT NULL
ON CONFLICT DO NOTHING;
COMMIT;
