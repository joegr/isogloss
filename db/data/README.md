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

**In the database** (`db/08_speech_accent_archive.sql`):

* `saa_speaker` — the CSV, one row per speaker;
* `saa_birthplace` — one row per distinct birthplace (1,627), with `geog`,
  `source` and `match` empty until a geocoder fills them;
* `saa_speaker_geo` — the join, plus `native_english`. For native English
  speakers the birthplace is dialect geography; for everyone else it locates
  the first language, which is a different axis of accent.
