# Isogloss

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
varieties, then every derived layer. Then open **http://localhost:8000**.

```bash
make reseed     # wipe the volume and rebuild the field from db/*.sql
make stats      # row counts across the field
make psql       # a shell on the field
make test       # offline DSP checks, no database needed
```

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

## Layout

```
db/       PostGIS schema, spatial functions, the reference field
backend/  FastAPI + numpy/scipy; the signal chain and the linear algebra
  app/static/   vanilla client, SVG GeoJSON renderer, no tiles or CDN
docs/     DIFFUSION.md — the design argument
```

Sources for the ideas are listed at the end of `docs/DIFFUSION.md`.
