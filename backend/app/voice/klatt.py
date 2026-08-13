"""A Klatt-style cascade/parallel formant synthesiser.

Source–filter, rendered frame by frame:

    voicing pulses ──┐
                     ├─→ [F1..F5 cascade] ─→ ⊕ ─→ radiation ─→ out
    aspiration ──────┘                       │
    frication ─→ [burst resonator] ──────────┘

The tract filter is time-varying, which is the entire point — a diphthong *is* a
formant trajectory, and `diph_index` in the accent vector is the length of that
trajectory. Rather than run an IIR with per-sample coefficients (a Python loop
over every sample), coefficients are held constant within a 10 ms frame and
`lfilter` runs per frame with its state carried across the boundary. Same result
to the ear, roughly two orders of magnitude faster.

Quality is 1980s formant-synthesis quality and no amount of tuning changes that.
It is chosen because its parameters *are* the accent vector; see docs/VOICE.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.signal import lfilter, lfilter_zi

SR = 16000
HOP_S = 0.010
N_FORMANTS = 5

# Bandwidths track frequency loosely; higher formants are more damped.
DEFAULT_BW = (70.0, 95.0, 130.0, 200.0, 280.0)


@dataclass
class Track:
    """Per-frame synthesiser parameters. One row per 10 ms."""
    f0: np.ndarray            # Hz, 0 = unvoiced
    av: np.ndarray            # voicing amplitude 0..1
    ah: np.ndarray            # aspiration amplitude 0..1
    af: np.ndarray            # frication amplitude 0..1
    formants: np.ndarray      # (n, 5) Hz
    bandwidths: np.ndarray    # (n, 5) Hz
    fric_cf: np.ndarray       # Hz, centre of the frication resonator
    fric_bw: np.ndarray       # Hz
    nasal: np.ndarray         # 0..1 nasalisation
    jitter: float = 0.012
    shimmer: float = 0.05
    breathiness: float = 0.04
    seed: int = 0

    @property
    def n(self) -> int:
        return len(self.f0)

    @staticmethod
    def blank(n: int) -> "Track":
        return Track(
            f0=np.zeros(n), av=np.zeros(n), ah=np.zeros(n), af=np.zeros(n),
            formants=np.tile(np.array([500., 1500., 2500., 3400., 4500.]), (n, 1)),
            bandwidths=np.tile(np.array(DEFAULT_BW), (n, 1)),
            fric_cf=np.full(n, 4000.0), fric_bw=np.full(n, 1500.0),
            nasal=np.zeros(n),
        )


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


def _upsample(v: np.ndarray, hop_n: int, total: int) -> np.ndarray:
    """Frame-rate parameter → sample-rate, linearly interpolated."""
    idx = np.arange(total) / hop_n
    lo = np.clip(idx.astype(int), 0, len(v) - 1)
    hi = np.clip(lo + 1, 0, len(v) - 1)
    frac = idx - lo
    return v[lo] * (1 - frac) + v[hi] * frac


def glottal_source(track: Track, hop_n: int, total: int,
                   rng: np.random.Generator) -> np.ndarray:
    """Rosenberg pulses at the instantaneous F0, with jitter and shimmer.

    A pulse train of impulses would be spectrally flat and sound like a buzzer
    through a filter; the Rosenberg shape supplies the −12 dB/octave source tilt
    that makes the result read as a voice rather than a chord.
    """
    f0 = _upsample(track.f0, hop_n, total)
    av = _upsample(track.av, hop_n, total)
    out = np.zeros(total + 512)

    t = 0
    while t < total:
        f = f0[t]
        if f < 40 or av[t] <= 1e-3:
            t += hop_n // 4
            continue
        period = SR / f
        period *= 1.0 + track.jitter * rng.standard_normal()
        n = max(8, int(period))

        # Rosenberg: raised-cosine opening over 40% of the period, quarter-cosine
        # closing over 16%, closed for the rest.
        n_open = max(2, int(0.40 * n))
        n_close = max(2, int(0.16 * n))
        i1 = np.arange(n_open)
        i2 = np.arange(n_close)
        pulse = np.concatenate([
            0.5 * (1 - np.cos(math.pi * i1 / n_open)),
            np.cos(math.pi * i2 / (2 * n_close)),
        ])
        amp = av[t] * (1.0 + track.shimmer * rng.standard_normal())
        out[t : t + len(pulse)] += amp * pulse
        t += n

    src = out[:total]
    # NOTE: this returns glottal *flow*, not its derivative. The single
    # differentiation in the chain is the lip-radiation term in `render`.
    # Differentiating here as well tilts the spectrum by +12 dB/octave, which
    # strips the first formant of energy and makes every frame read as an
    # unvoiced transient to a recogniser. Exactly one differentiation.
    if track.breathiness > 0:
        src = src + track.breathiness * av * rng.standard_normal(total)
    return src


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def _resonator(freq: float, bw: float) -> tuple[np.ndarray, np.ndarray]:
    """Klatt digital resonator, normalised to unity gain at DC."""
    freq = float(np.clip(freq, 80.0, SR / 2 - 120.0))
    bw = float(np.clip(bw, 20.0, 1800.0))
    r = math.exp(-math.pi * bw / SR)
    theta = 2 * math.pi * freq / SR
    a1 = 2 * r * math.cos(theta)
    a2 = -(r * r)
    gain = 1.0 - a1 - a2
    return np.array([gain]), np.array([1.0, -a1, -a2])


def _antiresonator(freq: float, bw: float) -> tuple[np.ndarray, np.ndarray]:
    """Zero pair, for the nasal antiformant."""
    b, a = _resonator(freq, bw)
    # Swap numerator and denominator, renormalised.
    return a / a.sum(), np.array([1.0])


def _filter_track(x: np.ndarray, track: Track, hop_n: int,
                  index: int) -> np.ndarray:
    """Run formant `index` over the signal, re-coefficiented every frame."""
    out = np.empty_like(x)
    zi = np.zeros(2)
    for k in range(track.n):
        a, b = k * hop_n, min((k + 1) * hop_n, len(x))
        if a >= len(x):
            break
        num, den = _resonator(track.formants[k, index], track.bandwidths[k, index])
        seg, zi = lfilter(num, den, x[a:b], zi=zi)
        out[a:b] = seg
    return out


def _frication(track: Track, hop_n: int, total: int,
               rng: np.random.Generator) -> np.ndarray:
    """Noise through a wide resonator at the fricative's centre of gravity.

    Runs in parallel with the tract, not through it: the noise source for [s] is
    at the teeth, in front of most of the cavity that shapes vowels.
    """
    af = _upsample(track.af, hop_n, total)
    if af.max() <= 1e-4:
        return np.zeros(total)
    noise = rng.standard_normal(total) * af

    out = np.empty(total)
    zi = np.zeros(2)
    for k in range(track.n):
        a, b = k * hop_n, min((k + 1) * hop_n, total)
        if a >= total:
            break
        num, den = _resonator(track.fric_cf[k], track.fric_bw[k])
        seg, zi = lfilter(num, den, noise[a:b], zi=zi)
        out[a:b] = seg
    return out


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def render(track: Track) -> np.ndarray:
    """Parameter track → mono float32 waveform at 16 kHz."""
    hop_n = int(HOP_S * SR)
    total = max(hop_n, track.n * hop_n)
    rng = np.random.default_rng(track.seed)

    voiced = glottal_source(track, hop_n, total, rng)
    asp = _upsample(track.ah, hop_n, total) * rng.standard_normal(total) * 0.5
    source = voiced + asp

    x = source
    for i in range(N_FORMANTS):
        x = _filter_track(x, track, hop_n, i)

    # Nasalisation: a pole/zero pair that flattens and damps the low spectrum.
    nas = _upsample(track.nasal, hop_n, total)
    if nas.max() > 1e-3:
        zb, za = _antiresonator(1400.0, 300.0)
        pb, pa = _resonator(280.0, 300.0)
        nasal_path = lfilter(pb, pa, lfilter(zb, za, x))
        x = x * (1 - nas) + nasal_path * nas

    x = x + _frication(track, hop_n, total, rng) * 0.55

    # Radiation from the lips: a first difference, +6 dB/octave.
    x = np.diff(x, prepend=0.0)

    peak = float(np.max(np.abs(x)))
    if peak > 0:
        x = 0.85 * x / peak
    # 5 ms raised-cosine edges, so the file does not start with a click.
    edge = int(0.005 * SR)
    if len(x) > 2 * edge:
        ramp = 0.5 * (1 - np.cos(np.linspace(0, math.pi, edge)))
        x[:edge] *= ramp
        x[-edge:] *= ramp[::-1]
    return x.astype(np.float32)


def to_wav(x: np.ndarray, sr: int = SR) -> bytes:
    """16-bit PCM WAV bytes — the same format the analyser ingests."""
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    return (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
            + (1).to_bytes(2, "little") + sr.to_bytes(4, "little")
            + (sr * 2).to_bytes(4, "little") + (2).to_bytes(2, "little")
            + (16).to_bytes(2, "little") + b"data"
            + len(pcm).to_bytes(4, "little") + pcm)
