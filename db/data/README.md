# db/data — external datasets

Files here are loaded by the numbered SQL scripts one level up. The PostGIS
entrypoint only executes top-level `*.sql`, so data files in this directory are
read (via `COPY`) but never run.

## `saa_speakers.csv` — Speech Accent Archive speakers

**Source.** Weinberger, S. *Speech Accent Archive*, George Mason University,
<https://accent.gmu.edu>. Speaker table exported from the archive as an Apple
Numbers spreadsheet (`speaker_information.numbers`, one sheet `speakers`, one
table), 3,031 speakers. Cite the archive when using it. The archive's own terms
govern reuse; check them before redistributing the recordings.

**What it is for.** Every speaker reads the same paragraph ("Please call
Stella…"), so differences between recordings are accent rather than content —
the elicitation design the audio field needs (docs/AUDIO_FIELD.md). The
birthplace puts each speaker on the map.

**Rebuild** after a new export:

```bash
pip install numbers-parser
cd backend && python -m app.datasets.saa /path/to/speaker_information.numbers
make migrate          # upsert into a running database
```

**Columns** are the archive's own names, in its order:

| column | meaning |
|---|---|
| `speakerid` | unique id, 1…3036 (gaps exist) |
| `speaker` | index within the native language — `english656` is speaker 656 of English |
| `native_language`, `alternative_native_language` | as recorded; `synthesized` marks 4 text-to-speech samples |
| `city`, `state_or_province`, `country` | **birthplace**, lower case, as recorded |
| `age`, `gender` | at recording |
| `onset_age` | age English learning began; 0 for native speakers |
| `english_residence`, `length_of_residence` | English-speaking countries lived in; years |
| `learning_style` | `academic`, `naturalistic`, or both |
| `speech_sample` | recording filename, `<language><n>.mp3` — the join key to the audio |
| `phonetic_transcription`, `map` | `.gif` names on the archive site; `notyet.gif` = not transcribed |
| `ethnologue_language_code` | ISO 639-3 |
| `notes` | free text; often the date the sample was added |

**Normalisation** — everything `app.datasets.saa.convert` changes, so any
value can be traced to its source cell:

* the literal text `NULL` and empty cells → empty (SQL `NULL`);
* whole-number floats → integers (`27.0` → `27`); other floats rounded to 4
  places, which only removes binary noise (`0.6000000000000001` → `0.6`);
* note cells that Numbers had parsed as dates → ISO dates (`2005-11-07`);
  notes Numbers left as text keep their original wording;
* carriage returns → newlines in `notes`; collapsed whitespace in other text
  (one birthplace read `guangdong province\r`);
* `learning_style`: two values on separate lines → `academic, naturalistic`;
  the typos `naturalisic` and `naturalisstic` → `naturalistic`;
* rows sorted by `speakerid`.

Nothing else is corrected: place names keep their spelling, and no row is
dropped.

## `saa_birthplaces.csv` — those birthplaces, geocoded

One row per distinct `(city, state_or_province, country)` — 1,627 — with a
point and a record of how it was found. Produced by
`backend/app/datasets/geocode.py` against GeoNames cities500 (CC BY 4.0, via
github.com/lmfmaier/cities-json) and the dr5hn country/state tables (ODbL 1.0).
Rebuild with `cd backend && python -m app.datasets.geocode` (fetches the
gazetteer into `~/.cache/isogloss/gazetteer` the first time).

`match` is the rung of the cascade that answered, most specific first:

| match | meaning | places | speakers |
|---|---|---:|---:|
| `city+state` | the city, inside the named state | 519 | 776 |
| `city` | exact name within the country (largest if several) | 847 | 1,905 |
| `city~` | close spelling, or the head of a longer name (Frankfurt → Frankfurt am Main) | 73 | 108 |
| `state` | state/province centroid | 92 | 121 |
| `country` | country centroid | 96 | 117 |

620 of the 658 native English speakers are placed at a city. The 4 synthesized
samples have no birthplace and no point. Treat `state` and `country` fixes as
coarse: they are a few hundred kilometres wide, and the audio field should
weight or drop them accordingly. Known limits: misspellings beyond the alias
tables fall back to a centroid rather than guess; a city typed with the wrong
state (`bangalore, kerala`) lands at the state's centroid.

## In the database

`db/08_speech_accent_archive.sql` loads both files; `db/09_speaker_records.sql`
adds what the map's speaker-dot module writes:

* `saa_speaker` — the CSV, one row per speaker; UI-created speakers share the
  table with `origin = 'ui'`, ids from 100001, and an optional map `pin`;
* `saa_birthplace` — one row per distinct birthplace, with `geog`, `source`,
  `match` and the gazetteer name it matched;
* `saa_entity` — named entities found in each speaker's free text;
* `saa_speaker_geo` — the join, plus `native_english`, the point (a pin wins
  over the geocode) and a recording count. For native English speakers the
  birthplace is dialect geography; for everyone else it locates the first
  language, which is a different axis of accent.
