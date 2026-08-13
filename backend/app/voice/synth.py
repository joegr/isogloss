"""Phrase + accent vector → waveform.

Three stages:

  1. **Segmentation** — words become a flat list of vowel and consonant
     segments carrying their realised targets.
  2. **Timing** — durations from the rhythm metrics. `pct_v` and `delta_c` are
     hit by construction rather than approached: the vowel/consonant ratio is
     solved for directly, and the consonantal spread is rescaled to the target
     standard deviation. If the analyser then measures something else, the
     analyser and the synthesiser disagree, and that is worth knowing.
  3. **Track** — formant knots interpolated across time, plus the amplitude and
     F0 contours, handed to the Klatt renderer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import klatt, lexicon, realisation as rz
from .lexicon import Phrase, Word, is_set
from .realisation import Realisation, Voice

HOP_MS = klatt.HOP_S * 1000.0
LEAD_MS = 140.0
WORD_GAP_MS = 22.0
END_MS = 260.0


@dataclass
class Seg:
    kind: str                 # vowel | stop | nasal | fricative | approximant | affricate | pause
    token: str
    dur_ms: float
    onset: tuple[float, float, float] | None = None
    offset: tuple[float, float, float] | None = None
    voiced: bool = True
    stressed: bool = False
    fric_cf: float = 4000.0
    fric_bw: float = 1800.0
    burst_cf: float = 2000.0
    aspirated: bool = False
    nasal: float = 0.0
    word_i: int = 0


# ---------------------------------------------------------------------------
# 1. Segmentation
# ---------------------------------------------------------------------------


def segment(phrase: Phrase, real: Realisation) -> list[Seg]:
    segs: list[Seg] = [Seg("pause", "", LEAD_MS)]

    for wi, word in enumerate(phrase.words):
        tokens = rz.apply_variables(word.tokens, real, wi,
                                    is_final_word=wi == len(phrase.words) - 1)
        for ti, tok in enumerate(tokens):
            if is_set(tok):
                v = real.vowel(tok)
                segs.append(Seg(
                    kind="vowel", token=tok, dur_ms=v.dur_ms,
                    onset=(v.f1, v.f2, v.f3),
                    offset=v.off or (v.f1, v.f2, v.f3),
                    stressed=word.stress == 1, nasal=v.nasal, word_i=wi))
                continue

            if rz.drop_final_r(tok, real):
                continue
            c = real.consonant(tok)
            segs.append(Seg(
                kind=c.kind, token=tok, dur_ms=c.dur_ms,
                onset=c.locus, offset=c.locus, voiced=c.voiced,
                fric_cf=c.fric_cf, fric_bw=c.fric_bw, burst_cf=c.burst_cf,
                aspirated=c.aspirated,
                nasal=1.0 if c.kind == "nasal" else 0.0, word_i=wi))

        segs.append(Seg("pause", "", WORD_GAP_MS, word_i=wi))

    segs[-1] = Seg("pause", "", END_MS, word_i=len(phrase.words) - 1)
    return segs


# ---------------------------------------------------------------------------
# 2. Timing
# ---------------------------------------------------------------------------


def time_segments(segs: list[Seg], real: Realisation) -> list[Seg]:
    f = real.features

    # Stress contrast is what nPVI measures: alternating long and short vowels.
    contrast = float(np.clip((f["npvi_v"] - 20.0) / 60.0, 0.0, 1.0))
    for s in segs:
        if s.kind == "vowel":
            s.dur_ms *= (1.0 + 0.55 * contrast) if s.stressed else (1.0 - 0.45 * contrast)

    vowels = [s for s in segs if s.kind == "vowel"]
    cons = [s for s in segs if s.kind not in ("vowel", "pause")]
    if not vowels or not cons:
        return segs

    # ΔC first, then %V. The order matters: rescaling consonants changes the
    # consonantal total and so would break a %V already solved for, whereas %V
    # is achieved by scaling vowels only and leaves ΔC untouched.
    durs = np.array([s.dur_ms for s in cons], dtype=float)
    want = float(np.clip(f["delta_c"], 15.0, 95.0))
    # Iterate, because the 22 ms floor on a consonant clips the low tail and
    # pulls the achieved spread back below target on a single pass.
    for _ in range(6):
        cur = float(durs.std())
        if cur < 1e-6:
            break
        scale = float(np.clip(want / cur, 0.3, 3.5))
        if abs(scale - 1.0) < 0.01:
            break
        durs = np.maximum(22.0, durs.mean() + (durs - durs.mean()) * scale)
    for s, d in zip(cons, durs):
        s.dur_ms = float(d)

    target = float(np.clip(f["pct_v"] / 100.0, 0.25, 0.62))
    V = sum(s.dur_ms for s in vowels)
    C = sum(s.dur_ms for s in cons)
    k = (target * C) / max((1 - target) * V, 1e-6)
    for s in vowels:
        s.dur_ms *= k

    rate = max(0.5, real.voice.rate)
    for s in segs:
        if s.kind != "pause":
            s.dur_ms /= rate
    return segs


# ---------------------------------------------------------------------------
# 3. Track
# ---------------------------------------------------------------------------


def build_track(segs: list[Seg], real: Realisation, seed: int = 0) -> klatt.Track:
    f = real.features
    total_ms = sum(s.dur_ms for s in segs)
    n = max(4, int(round(total_ms / HOP_MS)))
    tr = klatt.Track.blank(n)
    tr.seed = seed

    knots: list[tuple[float, float, float, float]] = []   # frame, f1, f2, f3
    voiced_frames: list[int] = []
    stressed_frames: list[int] = []

    pos = 0.0
    for s in segs:
        a = int(round(pos / HOP_MS))
        b = min(n, max(a + 1, int(round((pos + s.dur_ms) / HOP_MS))))
        pos += s.dur_ms
        span = b - a
        if a >= n:
            break

        if s.kind == "pause":
            tr.av[a:b] = 0.0
            continue

        if s.kind == "vowel":
            tr.av[a:b] = 1.0
            tr.nasal[a:b] = s.nasal
            knots.append((a + 0.25 * span, *s.onset))
            knots.append((a + 0.78 * span, *s.offset))
            voiced_frames.extend(range(a, b))
            if s.stressed:
                stressed_frames.extend(range(a, b))

        elif s.kind == "nasal":
            tr.av[a:b] = 0.75
            tr.nasal[a:b] = 1.0
            knots.append((a + 0.5 * span, *s.onset))
            voiced_frames.extend(range(a, b))

        elif s.kind == "approximant":
            tr.av[a:b] = 0.92
            knots.append((a + 0.5 * span, *s.onset))
            voiced_frames.extend(range(a, b))

        elif s.kind == "fricative":
            if s.token == "h":
                # /h/ is aspiration through the tract, so it takes its formants
                # from whatever follows; no knot, let the interpolation carry it.
                tr.av[a:b] = 0.0
                tr.ah[a:b] = 0.85
            else:
                tr.av[a:b] = 0.30 if s.voiced else 0.0
                tr.af[a:b] = 0.85 if s.voiced else 1.0
                tr.fric_cf[a:b] = s.fric_cf
                tr.fric_bw[a:b] = s.fric_bw
                knots.append((a + 0.5 * span, *s.onset))
                if s.voiced:
                    voiced_frames.extend(range(a, b))

        elif s.kind in ("stop", "affricate"):
            knots.append((max(a - 1, 0) + 0.0, *s.onset))
            burst = max(1, int(round(18.0 / HOP_MS)))
            asp = int(round(max(0.0, f["vot_ms"] - 18.0) / HOP_MS)) if s.aspirated else 0

            close_end = max(a + 1, b - burst - asp)
            # Closure: silent, except for a voice bar in the voiced stops.
            tr.av[a:close_end] = 0.12 if s.voiced else 0.0
            if s.token == "ʔ":
                # A glottal stop is creak, not silence: voicing continues at a
                # collapsed rate rather than stopping.
                tr.av[a:close_end] = 0.30
                tr.f0[a:close_end] = -1.0        # marker, resolved in the F0 pass
                continue

            if s.kind == "affricate":
                tr.af[close_end:b] = 1.0
                tr.fric_cf[close_end:b] = s.fric_cf
                tr.fric_bw[close_end:b] = s.fric_bw
            else:
                bs, be = close_end, min(b, close_end + burst)
                tr.af[bs:be] = 0.9
                tr.fric_cf[bs:be] = s.burst_cf
                tr.fric_bw[bs:be] = 2200.0
                if asp:
                    tr.ah[be:b] = 0.7
            if s.voiced:
                voiced_frames.extend(range(a, close_end))

    _interpolate_formants(tr, knots, n)
    _f0_contour(tr, real, voiced_frames, stressed_frames, n)
    return tr


def _interpolate_formants(tr: klatt.Track, knots, n: int) -> None:
    if not knots:
        return
    knots = sorted(knots, key=lambda k: k[0])
    xs = np.array([k[0] for k in knots])
    grid = np.arange(n, dtype=float)
    for j in range(3):
        ys = np.array([k[j + 1] for k in knots])
        tr.formants[:, j] = np.interp(grid, xs, ys)
    # F4/F5 ride above F3 so the spectrum stays plausible as the tract moves.
    tr.formants[:, 3] = np.maximum(tr.formants[:, 2] + 750.0, 3200.0)
    tr.formants[:, 4] = np.maximum(tr.formants[:, 3] + 900.0, 4300.0)
    tr.bandwidths[:, 0] = 55.0 + 0.06 * tr.formants[:, 0]
    tr.bandwidths[:, 1] = 70.0 + 0.04 * tr.formants[:, 1]
    tr.bandwidths[:, 2] = 110.0 + 0.03 * tr.formants[:, 2]


def _f0_contour(tr: klatt.Track, real: Realisation,
                voiced: list[int], stressed: list[int], n: int) -> None:
    f = real.features
    base = real.voice.f0_base
    span_st = float(np.clip(f["f0_span"], 1.5, 16.0))

    creak = tr.f0 < 0                      # glottal-stop markers from build_track
    tr.f0[:] = 0.0

    if not voiced:
        return
    vmask = np.zeros(n, dtype=bool)
    vmask[np.array(voiced, dtype=int)] = True
    vmask |= creak

    # Declination: pitch drifts down across an utterance. Expressed in
    # semitones so the shape is invariant to the speaker's base frequency.
    t = np.linspace(0.0, 1.0, n)
    st = -0.35 * span_st * t

    # A rise-fall accent on each stressed stretch.
    if stressed:
        smask = np.zeros(n, dtype=bool)
        smask[np.array(stressed, dtype=int)] = True
        for a, b in _runs(smask):
            k = np.linspace(0, math.pi, max(b - a, 2))
            st[a:b] += 0.45 * span_st * np.sin(k)

    # Nuclear tone. A final rise is the Belfast/Cork pattern and the
    # Australasian/Californian one alike — accent.py measures them identically
    # and says so; here they are generated identically too.
    tail = max(1, int(0.18 * n))
    shape = np.linspace(0, 1, tail)
    if _phrase_final_rise(f):
        st[-tail:] += 0.75 * span_st * shape
    else:
        st[-tail:] -= 0.55 * span_st * shape

    tr.f0 = np.where(vmask, base * np.power(2.0, st / 12.0), 0.0)
    # Creak sits below modal voice, but only just: drop it far and the 5th
    # percentile of f0 collapses, which inflates the measured pitch span by
    # more than a whole octave and makes every glottalling accent look Irish.
    tr.f0[creak] *= 0.78
    tr.av[creak] = np.minimum(tr.av[creak], 0.30)


def _phrase_final_rise(f: dict[str, float]) -> bool:
    return f["final_rise"] >= 0.45


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    edges = np.nonzero(np.diff(mask.astype(int)))[0] + 1
    bounds = np.concatenate(([0], edges, [len(mask)]))
    return [(int(bounds[i]), int(bounds[i + 1]))
            for i in range(len(bounds) - 1) if mask[bounds[i]]]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


@dataclass
class Synthesis:
    wav: bytes
    samples: np.ndarray
    duration_s: float
    phrase_id: str
    notes: list[str]
    segments: list[dict] = field(default_factory=list)


def synthesise(phrase_id: str, features: dict[str, float],
               voice: str | Voice = "male", seed: int = 0) -> Synthesis:
    phrase = lexicon.get(phrase_id)
    real = rz.realise(features, voice)
    segs = time_segments(segment(phrase, real), real)
    track = build_track(segs, real, seed=seed)
    x = klatt.render(track)

    out, pos = [], 0.0
    for s in segs:
        if s.kind != "pause":
            out.append({"token": s.token, "kind": s.kind,
                        "start": round(pos / 1000.0, 3),
                        "dur_ms": round(s.dur_ms, 1)})
        pos += s.dur_ms

    return Synthesis(
        wav=klatt.to_wav(x), samples=x, duration_s=len(x) / klatt.SR,
        phrase_id=phrase_id, notes=real.notes, segments=out)
