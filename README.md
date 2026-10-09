# Isogloss

**[Try the synthesiser →](https://joegr.github.io/isogloss/)** — an accent is
fourteen numbers; move a slider and hear what changes. Runs entirely in the tab.

Record speech. Get back the phones, the language, fourteen sociophonetic
measurements, and **where the accent is from — as a probability distribution
drawn on a map.**

The geography is not decoration. Accent similarity is not smooth in geographic
space, and the whole design turns on taking that seriously. The full argument is
in **[docs/DIFFUSION.md](docs/DIFFUSION.md)**; the short version is:

> The covariance you interpolate an accent field with should be the propagator
> of the diffusion that produced it — the heat kernel of a gravity/barrier
> interaction graph — not a distance kernel over lat/lon.

That one decision is why barriers, settlement hierarchy and migration links are
inherited by the interpolator instead of bolted onto it, and it is why the
output type is a `MULTIPOLYGON` rather than a coordinate pair.

---

## Run it

```bash
make up
```

PostGIS builds the whole field on first boot — schema, spatial functions, phone
inventory, twenty languages, the geographic substrate, a hundred reference
varieties, every derived layer, then the Speech Accent Archive's 3,031 speakers
with their geocoded birthplaces. Then open:

* **http://localhost:8080** — the speaker map (below);
* **http://localhost:8000** — the analyser: record, analyse, geolocate.

```bash
make reseed     # wipe the volume and rebuild the field from db/*.sql
make migrate    # add the audio-node and speaker tables to an existing volume
make ner        # run NER over every speaker record that has not had it
make stats      # row counts across the field
make psql       # a shell on the field
make test       # offline checks, no database needed
```

## The speaker map

One dot per speaker, at their birthplace, on the globe from
[Demogi](https://github.com/joegr/demogi). It opens with the
[Speech Accent Archive](https://accent.gmu.edu)'s 3,031 speakers — everyone
reading the same "Please call Stella" paragraph, which is the elicitation
design accent geography needs: what is said is fixed, so the differences are
how it is said.

**Creating a dot is a cascade**, in one transaction (`backend/app/speakers.py`):

1. **record** — a row with every field the archive has, from a form the API
   describes (`GET /api/speakers/schema`), so the form is the record;
2. **place** — the dropped pin, and the typed birthplace geocoded so it joins
   every other speaker born there;
3. **entities** — NER over the free text: spaCy's multilingual model (the one
   Demogi runs), patterns for dates, durations, age ranges and course codes,
   the residence list parsed as a list — and every place linked to the
   gazetteer and drawn on the globe next to the speaker;
4. **audio** — converted to 16 kHz mono WAV *in the browser* (so MP3 needs no
   ffmpeg server-side), stored byte for byte on an audio node at the speaker's
   point, and featurised. A whole folder of archive files attaches by name
   (`english656.mp3` → speaker 3034); sending a file twice is a no-op.

**Birthplaces** are geocoded against GeoNames (`backend/app/datasets/geocode.py`)
by a cascade — city in state, city, close spelling, state, country — with the
rung recorded for every place, because a city fix and a country centroid are
different evidence. 620 of the 658 native English speakers land on a city.
`db/data/README.md` has the provenance, the normalisation and the numbers.

## What happens to a recording

| stage | file | what it does |
|---|---|---|
| ingest | `backend/app/audio.py` | raw 16-bit PCM in, no codec between speaker and formant tracker |
| frames | `backend/app/dsp.py` | 25/10 ms; energy, ZCR, autocorrelation pitch, LPC formants, spectral moments, VAD, effective bandwidth |
| phones | `backend/app/phones.py` | VTLN, template emissions, Viterbi with duration and phonotactic costs |
| language | `backend/app/langid.py` | PRLM (Zissman 1996): phone string + rhythm + vowel-system size |
| accent | `backend/app/accent.py` | 14 measurements, each with a **reliability** |
| geography | `backend/app/geo.py` | GP over the graph heat kernel → posterior over the earth |
| geometry | `db/02_functions.sql` | credible regions, isoglosses, bundles, dialect regions, wavefronts |

The audio is decoded **twice** — once language-neutrally, then again under the
identified language's phonotactics. Phone identity and sociophonetics are
coupled (you cannot measure VOT without knowing which segments are voiceless
stops), so the second pass measurably improves what gets geolocated.

## The three views

**Analyse** — record or upload, and watch it come apart: language ranking, the
phone strip, every measurement with its reliability bar, and the posterior
drawn as 50/80/95% credible regions.

**The field** — the reference data as geometry. Thiessen cells over the sites,
isoglosses derived as the shared boundary between cells above and below a
threshold, Bloomfield's isogloss *bundles* counted rather than asserted,
dialect regions clustered in feature space and unioned in map space, and the
interaction graph itself.

**Diffusion** — one simulator, four regimes. Under `wave` the front expands as
a ring; under `hierarchical` it materialises around distant cities first and
only later joins up. The reported correlations (adoption time vs log
population, vs distance from origin) are the numeric signature of the
difference.

## Spatial SQL

Everything geometric is computed in the database, in plain readable SQL:

```sql
-- an isogloss is derived, never drawn
SELECT ST_Intersection(ST_Boundary(a), ST_Boundary(b))
FROM (SELECT ST_Union(cell) FILTER (WHERE yes)     AS a,
             ST_Union(cell) FILTER (WHERE NOT yes) AS b FROM side) p;
```

`ST_VoronoiPolygons` tessellates, `ST_Intersects` against a table of
`LINESTRING` barriers warps the metric, `ST_Union` + `ST_SimplifyPreserveTopology`
+ `ST_ChaikinSmoothing` turn posterior grid cells into credible-region polygons.
See `db/02_functions.sql` — every function is short enough to read in one
sitting, deliberately.

## What it cannot do

* **Fourteen acoustic numbers cannot localise you to a town.** Expect
  country/major-region resolution. The polygons are wide on purpose, and often
  multimodal across continents — a rhotic speaker with a fronted GOOSE really is
  consistent with Ireland *and* the American West.
* **The reference field is expert-approximated**, synthesised from the
  descriptive literature (Wells' lexical sets, the *Atlas of North American
  English*, the Survey of English Dialects, the rhythm-metric literature). It is
  not measured from a corpus. Replacing `db/05_seed_sites.sql` with real survey
  data changes nothing else.
* **The template recogniser is inspectable but weak.** You can see exactly why a
  frame was called [s] rather than [ʃ], which is the point; a trained model
  would be more accurate. `phones.Recognizer` is a Protocol so one can be
  dropped in without touching anything downstream.
* **L2 accent is a different axis from dialect geography.** The pipeline flags
  it rather than placing a Spanish-accented English speaker in Spain.
* **Narrowband audio destroys F3**, and with it rhoticity — the single most
  informative English feature. The pipeline measures the effective bandwidth and
  says so instead of guessing confidently.

## Producing the accents, not just recognising them

The accent vector is already a set of phonetic control parameters, so a formant
synthesiser can be driven by it directly — which means generation and
recognition share one representation. See **[docs/VOICE.md](docs/VOICE.md)**.

The payoff is a **round trip**: synthesise Cork from the reference field, feed
the audio back through the recogniser, and see where it geolocates. That turns
a hand-authored field from an assertion into something measurable.

```bash
python3 backend/tests/test_voice.py     # synthesise → measure → compare
```

Transcriptions are stored in Wells' lexical sets, never as sounds. `park` is
`p START k`, where START is *the class of park, car, hard* — so one
transcription renders in any accent, and the accent parameters fall out as
interpolations between classes:

```python
BATH = lerp(TRAP, PALM, trap_bath)              # the north/south English isogloss
LOT, THOUGHT = converge(LOT, THOUGHT, low_back_merge)
```

Each line is the generative statement of a measurement in `accent.py`. Building
this immediately paid for itself by exposing three real bugs in the analysis
path — including a normalisation error that capped voicing at 0.67 and so made
every `voicing > 0.6` test in the codebase unreachable.

It sounds like 1980s DECtalk, and that is the accepted cost: the point is
steerability, not realism. A neural voice would sound better and could not be
driven by "set `low_back_merge` to 0.9".

## Layout

```
db/       PostGIS schema, spatial functions, the reference field
  data/         the Speech Accent Archive speakers and their geocoded birthplaces
backend/  FastAPI + numpy/scipy; the signal chain and the linear algebra
  app/speakers.py  the speaker-dot cascade; app/ner.py its NER
  app/datasets/    archive import (saa.py) and birthplace geocoding (geocode.py)
  app/field/       the audio field: nodes holding raw audio, a graph-heat-kernel
                   GP over them in PyTorch (work in progress)
  app/voice/    the formant synthesiser and the round-trip harness
  app/static/   vanilla client, SVG GeoJSON renderer, no tiles or CDN
frontend/ the speaker map — Demogi's TypeScript/D3 globe (src/speakers/)
libs/phonemescape/  IPA segments and distinctive features (from joegr/ipaba)
web/      the static Pages site: the synthesiser ported to run in a browser
docs/     DIFFUSION.md — the design argument; VOICE.md — the synthesiser
```

`web/synth.js` is a port of the Python synthesiser, not a client for it, because
Pages is static. CI keeps them honest: the Python round-trip tests run on every
push, `web/presets.js` is generated from the SQL seed and CI fails if
regenerating it produces a diff, and `web/check_site.py` walks the module graph
and checks named imports against exports — a mistyped import path on a
build-step-free static site is a blank page, and nothing else would catch it.

Sources for the ideas are listed at the end of `docs/DIFFUSION.md`.
