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
-- (exact city+state, city+country, country centroid…), so coarse fixes can be
-- told apart from good ones and down-weighted.
CREATE TABLE IF NOT EXISTS saa_birthplace (
  city               text NOT NULL DEFAULT '',
  state_or_province  text NOT NULL DEFAULT '',
  country            text NOT NULL DEFAULT '',
  query              text NOT NULL,
  geog               geography(Point, 4326),
  source             text,
  match              text,
  PRIMARY KEY (city, state_or_province, country)
);
CREATE INDEX IF NOT EXISTS saa_birthplace_gg ON saa_birthplace USING GIST (geog);

-- -- load ---------------------------------------------------------------------

BEGIN;
CREATE TEMP TABLE saa_load (LIKE saa_speaker) ON COMMIT DROP;
COPY saa_load FROM '/docker-entrypoint-initdb.d/data/saa_speakers.csv'
  WITH (FORMAT csv, HEADER true, NULL '');

INSERT INTO saa_speaker SELECT * FROM saa_load
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

-- Every birthplace gets a row, geocoded or not, so "what is still missing" is
-- a query rather than a guess.
INSERT INTO saa_birthplace (city, state_or_province, country, query)
SELECT DISTINCT COALESCE(city, ''), COALESCE(state_or_province, ''), COALESCE(country, ''),
       concat_ws(', ', city, state_or_province, country)
FROM saa_speaker
WHERE city IS NOT NULL OR country IS NOT NULL
ON CONFLICT DO NOTHING;
COMMIT;

-- -- the view the audio field reads ---------------------------------------------
--
-- Native English speakers are flagged rather than filtered. Their birthplace is
-- dialect geography; for everyone else it is the geography of the first
-- language, which shapes the English accent along a different axis (README:
-- "L2 accent is a different axis from dialect geography").

CREATE OR REPLACE VIEW saa_speaker_geo AS
SELECT s.*,
       s.native_language = 'english' AS native_english,
       b.query AS birthplace,
       b.geog, b.source AS geocode_source, b.match AS geocode_match
FROM saa_speaker s
LEFT JOIN saa_birthplace b
  ON b.city = COALESCE(s.city, '')
 AND b.state_or_province = COALESCE(s.state_or_province, '')
 AND b.country = COALESCE(s.country, '');
