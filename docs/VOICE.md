# Voice generation: producing the accents

## Why this belongs in this repo

The accent vector is already a set of phonetic control parameters — formant
targets, durations, VOT, pitch span, variant rates. A formant synthesiser
consumes exactly those parameters. So recognition and generation can share **one
representation**, and that buys something no separate TTS could:

> **Round-trip evaluation.** Synthesise Cork from `site_feature`, feed the audio
> back through the recogniser, and see where it geolocates. If it lands in
> Munster, the loop is consistent. If it lands in Ohio, either the reference
> value, the realisation rule, or the measurement is wrong — and the harness
> says which feature drifted.

That converts a hand-authored reference field from an assertion into something
measurable. It is the single most valuable thing the suite provides, and it is
the reason to build a *controllable* synthesiser rather than a good-sounding one.

## What it is

A **Klatt-style cascade/parallel formant synthesiser** in numpy. Deliberately
not neural:

* neural TTS needs training data per accent, which is the thing we do not have;
* a neural voice is not steerable by "set `low_back_merge` to 0.9", which
  destroys the shared-representation property that makes the round trip possible;
* a formant synthesiser's parameters *are* the accent vector, so the mapping is
  a table rather than a model.

The cost is honest and should be stated up front: **it sounds like 1980s DECtalk.**
Intelligible-ish, clearly synthetic, nobody will mistake it for a person. What it
does reproduce faithfully is exactly what this project measures — vowel quality
and dispersion, diphthong trajectories, rhoticity, VOT, glottalling, TH variants,
rhythm and pitch span. Those differences are plainly audible between varieties.

## Modules

| file | role |
|---|---|
| `voice/lexicon.py` | Phrase inventory. Vowels are tagged by **Wells lexical set**, never by phone. |
| `voice/realisation.py` | Accent vector → realisation table. The inverse of `accent.py`. |
| `voice/prosody.py` | Durations from the rhythm metrics; F0 contour from span and final-rise. |
| `voice/klatt.py` | The synthesiser: glottal source, noise sources, time-varying resonator cascade. |
| `voice/synth.py` | Orchestration: phrase + accent → WAV bytes. |
| `voice/evaluate.py` | The round-trip harness. |

### Lexical sets are the whole trick

A transcription is stored once, with vowels as **set names** rather than sounds:

```
park  →  p  START  k
bath  →  b  BATH   θ
```

`START` is not a sound; it is "the vowel class that *park, car, hard* belong to".
Every accent realises that class differently, and some accents merge classes that
others keep apart. This is precisely what Wells' sets were invented for, and it
means one transcription renders in any accent without re-transcription.

It also makes the accent parameters fall out as *interpolations between sets*:

```python
BATH = lerp(TRAP, PALM, trap_bath)          # the north/south English isogloss
LOT, THOUGHT = converge(LOT, THOUGHT, low_back_merge)
GOOSE.f2 = 900 + 1000 * goose_f2
```

Each line is the generative statement of a measurement in `accent.py`. That
symmetry is the design.

## Interfaces

```
GET  /api/voice/phrases                    the inventory, with what each probes
POST /api/voice/synthesise                 {site|lonlat|features, phrase, voice} → WAV
POST /api/voice/morph                      interpolate between two varieties, N steps
POST /api/voice/roundtrip                  synthesise → analyse → geolocate → report
```

`/api/voice/synthesise` accepts an accent vector from three sources, and the
middle one is the interesting one: **any point on the map**. The GP field is
queried at that coordinate, and you hear the model's prediction for a place that
has no reference recording. Clicking around a map and listening to the field is
the most direct way to tell whether the interpolation is sane.

## Explicitly out of scope

* Neural or concatenative TTS, for the reasons above.
* General-purpose grapheme-to-phoneme. The inventory is hand-transcribed; a rule
  fallback for unknown words would be worse than refusing.
* Languages other than English. The lexical-set machinery is English-specific,
  and inventing a "lexical set" system for twenty languages is a different project.
* Voice cloning or speaker identity of any kind. The synthesiser has a vocal tract
  length and a pitch range, and nothing else that identifies a person.
