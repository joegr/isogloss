-- Isogloss — speaker records: what the map's speaker-dot module writes.
--
-- Creating a dot cascades (backend/app/speakers.py): a saa_speaker row with
-- every field, the place it was pinned, the named entities found in its text,
-- and — once audio arrives — an audio node and recording at the same point.
-- Archive rows and UI rows share one table, told apart by `origin`.
-- Idempotent, like 07 and 08.

ALTER TABLE saa_speaker ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'archive';  -- archive | ui
ALTER TABLE saa_speaker ADD COLUMN IF NOT EXISTS pin geography(Point, 4326);  -- placed on the map; wins over the geocode
ALTER TABLE saa_speaker ADD COLUMN IF NOT EXISTS created timestamptz NOT NULL DEFAULT now();
ALTER TABLE saa_speaker ADD COLUMN IF NOT EXISTS ner_model text;              -- what last ran NER over this record
ALTER TABLE saa_speaker ADD COLUMN IF NOT EXISTS ner_at timestamptz;
-- Archive ids run to a few thousand; UI speakers start far above, so a future
-- archive export can never collide with a speaker someone created by hand.
CREATE SEQUENCE IF NOT EXISTS saa_speaker_ui_id START 100001;

-- Named entities found in a speaker's free-text fields. One row per mention,
-- with character offsets into the field so the UI can highlight it, and — for
-- places — the gazetteer point it was linked to.
CREATE TABLE IF NOT EXISTS saa_entity (
  id          serial PRIMARY KEY,
  speakerid   int NOT NULL REFERENCES saa_speaker(speakerid) ON DELETE CASCADE,
  field       text NOT NULL,             -- notes | english_residence | birthplace | …
  start_char  int NOT NULL,
  end_char    int NOT NULL,
  text        text NOT NULL,
  label       text NOT NULL,             -- LOC PER ORG MISC (spaCy) · DATE DURATION AGE (patterns)
  source      text NOT NULL,             -- spacy:<model> | gazetteer | pattern
  place       text,                      -- linked gazetteer name, for LOC
  match       text,                      -- how it was linked (geocode.py's ladder)
  geog        geography(Point, 4326)
);
CREATE INDEX IF NOT EXISTS saa_entity_speaker ON saa_entity (speakerid);
CREATE INDEX IF NOT EXISTS saa_entity_gg ON saa_entity USING GIST (geog);

-- Where a recording came from, and its content hash: attaching the same file
-- twice (re-dropping a folder of archive MP3s) is then a no-op, not a duplicate.
ALTER TABLE audio_recording ADD COLUMN IF NOT EXISTS source_file text;
ALTER TABLE audio_recording ADD COLUMN IF NOT EXISTS sha256 text;
CREATE UNIQUE INDEX IF NOT EXISTS audio_recording_node_sha ON audio_recording (node_id, sha256);

-- A speaker's recordings live on an audio node at the speaker's point.
ALTER TABLE audio_node ADD COLUMN IF NOT EXISTS speakerid int
  REFERENCES saa_speaker(speakerid) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS audio_node_speaker ON audio_node (speakerid);

-- -- the view the map and the audio field read ----------------------------------
--
-- Native English speakers are flagged rather than filtered. Their birthplace is
-- dialect geography; for everyone else it is the geography of the first
-- language, which shapes the English accent along a different axis (README:
-- "L2 accent is a different axis from dialect geography").

DROP VIEW IF EXISTS saa_speaker_geo;
CREATE VIEW saa_speaker_geo AS
SELECT s.*,
       s.native_language = 'english' AS native_english,
       b.query AS birthplace,
       COALESCE(s.pin, b.geog) AS geog,
       CASE WHEN s.pin IS NOT NULL THEN 'pin' ELSE b.match END AS geocode_match,
       CASE WHEN s.pin IS NOT NULL THEN 'map' ELSE b.source END AS geocode_source,
       b.matched_name, b.matched_admin1, b.country_code,
       (SELECT count(*) FROM audio_recording r JOIN audio_node n ON n.id = r.node_id
         WHERE n.speakerid = s.speakerid)::int AS recordings
FROM saa_speaker s
LEFT JOIN saa_birthplace b
  ON b.city = COALESCE(s.city, '')
 AND b.state_or_province = COALESCE(s.state_or_province, '')
 AND b.country = COALESCE(s.country, '');
